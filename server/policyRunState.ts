import { createHash, randomUUID } from 'node:crypto'
import type { Policy, RuleResult } from '../src/rules.js'
import { isPlannerDecision, type NextTradeDecision } from '../src/nextTradePlanner.js'

export const MAX_TRADES_PER_RUN = 3

export type PolicyRunStatus =
  | 'READING'
  | 'PLANNING'
  | 'AWAITING_APPROVAL'
  | 'SUBMITTING'
  | 'VERIFYING'
  | 'COMPLETE'
  | 'MANUAL_REVIEW'

export type ActivePlanStatus = 'PENDING' | 'SUBMITTING' | 'CONSUMED' | 'INVALIDATED'

export type PolicyRunState = {
  runId: string
  originalPolicy: Policy
  policyHash: string
  currentStep: number
  maxTrades: 3
  status: PolicyRunStatus
  activePlanId: string | null
  historyPlanIds: string[]
  submittedPayloadHashes: string[]
  tradeCount: number
  createdAt: number
  updatedAt: number
  proposedPayloadHashes: string[]
  intentFingerprints: string[]
  clientOrderIds: string[]
  lastViolationScore?: number
}

export type ActivePlan = {
  planId: string
  runId: string
  decision: NextTradeDecision
  snapshotHash: string
  serializedExecutableIntent: string
  payloadHash: string
  intentFingerprint: string
  protectedAssets: string[]
  createdAt: number
  expiresAt: number
  status: ActivePlanStatus
  writeClaimed: boolean
  policyHash: string
  plannerResultHash: string
  violationScoreBefore: number
  violationScoreExpected: number
}

export type CreatePlanInput = {
  decision: NextTradeDecision
  snapshotHash: string
  executableIntent?: unknown
  executableIntentFactory?: (planId: string) => unknown
  protectedAssets: string[]
}

export type VerificationInput = {
  violationScoreBefore: number
  violationScoreAfter: number
  complete: boolean
}

export type ApprovalContext = {
  executableIntent?: unknown
  policy?: Policy
}

export class PolicyRunStateError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PolicyRunStateError'
    this.code = code
  }
}

type StoredRun = {
  state: PolicyRunState
  activePlan: ActivePlan | null
  allPlanIds: Set<string>
}

const defaultPlanTtlMs = 60_000
const scoreEpsilon = 1e-9
const symbolPattern = /^[A-Z][A-Z0-9]{1,11}$/

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

function serialize(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value))
  return canonical === undefined ? 'undefined' : canonical
}

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : serialize(value)).digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function timestamp(_ignoredCallerTime?: number): number {
  const value = Date.now()
  if (!Number.isFinite(value)) throw new PolicyRunStateError('INVALID_TIME', 'A finite timestamp is required.')
  return value
}

function requireRun(runs: Map<string, StoredRun>, runId: string): StoredRun {
  const run = runs.get(runId)
  if (!run) throw new PolicyRunStateError('UNKNOWN_RUN', 'The policy run does not exist or has expired.')
  return run
}

function requireActivePlan(run: StoredRun, planId?: string): ActivePlan {
  if (!run.activePlan || !run.state.activePlanId) throw new PolicyRunStateError('NO_ACTIVE_PLAN', 'The run has no active plan.')
  if (planId && run.state.activePlanId !== planId) throw new PolicyRunStateError('WRONG_PLAN', 'The plan ID does not match the active plan.')
  return run.activePlan
}

function normalizedProtectedAssets(assets: string[]): string[] {
  if (!Array.isArray(assets)) throw new PolicyRunStateError('INVALID_PROTECTED_ASSETS', 'A protected asset set is required.')
  const normalized = assets.map((asset) => typeof asset === 'string' ? asset.trim().toUpperCase() : '')
  if (normalized.some((asset) => !symbolPattern.test(asset))) throw new PolicyRunStateError('INVALID_PROTECTED_ASSETS', 'Protected assets must use valid symbols.')
  return [...new Set(normalized)].sort()
}

function policyProtectedAssets(policy: Policy): string[] {
  return normalizedProtectedAssets(policy.rules.filter((rule) => rule.kind === 'protected_asset').map((rule) => rule.asset))
}

function assertSnapshotHash(value: string): void {
  if (typeof value !== 'string' || value.length < 8) throw new PolicyRunStateError('INVALID_SNAPSHOT', 'A valid portfolio snapshot hash is required.')
}

function assertReadyDecision(decision: NextTradeDecision): asserts decision is Extract<NextTradeDecision, { status: 'READY' }> {
  if (!isPlannerDecision(decision)) throw new PolicyRunStateError('UNTRUSTED_DECISION', 'Only a decision produced by the deterministic planner can create an execution plan.')
  if (decision.status !== 'READY') throw new PolicyRunStateError('NO_READY_PLAN', 'Only a READY next-trade decision can create an approval plan.')
  const action = decision.nextTrade
  if (!action || typeof action.source !== 'string' || typeof action.target !== 'string' || !symbolPattern.test(action.source.toUpperCase()) || !symbolPattern.test(action.target.toUpperCase()) || action.source.toUpperCase() === action.target.toUpperCase() || !Number.isFinite(action.amountUsd) || action.amountUsd <= 0 || !Number.isFinite(action.sourceQuantity) || action.sourceQuantity <= 0) {
    throw new PolicyRunStateError('INVALID_DECISION', 'The next-trade decision does not contain a valid single action.')
  }
  if (!Number.isFinite(decision.violationScoreBefore) || !Number.isFinite(decision.violationScoreExpected) || decision.violationScoreExpected >= decision.violationScoreBefore - scoreEpsilon) {
    throw new PolicyRunStateError('NO_PROGRESS', 'The next-trade decision does not demonstrate measurable improvement.')
  }
}

function clientOrderId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const candidate = raw.newClientOrderId ?? raw.clientOrderId
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

function semanticAmount(value: unknown): string {
  const amount = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(amount) || amount <= 0) throw new PolicyRunStateError('INVALID_PAYLOAD', 'The executable amount must be a finite positive number.')
  return (Math.round(amount * 100_000_000) / 100_000_000).toFixed(8)
}

function semanticIntentFingerprint(decision: Extract<NextTradeDecision, { status: 'READY' }>, executableIntent: unknown): string {
  if (!executableIntent || typeof executableIntent !== 'object' || Array.isArray(executableIntent)) throw new PolicyRunStateError('INVALID_PAYLOAD', 'The executable intent must be an object.')
  const intent = executableIntent as Record<string, unknown>
  if (typeof intent.symbol !== 'string' || !symbolPattern.test(intent.symbol.trim().toUpperCase()) || typeof intent.side !== 'string' || !['BUY', 'SELL'].includes(intent.side.trim().toUpperCase()) || intent.type !== 'MARKET') throw new PolicyRunStateError('INVALID_PAYLOAD', 'The executable intent must identify a valid Spot market, side, and type.')
  const mode = intent.quantity !== undefined ? 'quantity' : intent.quoteOrderQty !== undefined ? 'quoteOrderQty' : null
  if (!mode) throw new PolicyRunStateError('INVALID_PAYLOAD', 'The executable intent must identify one quantity mode.')
  return hash({
    source: decision.nextTrade.source.trim().toUpperCase(),
    target: decision.nextTrade.target.trim().toUpperCase(),
    symbol: intent.symbol.trim().toUpperCase(),
    side: intent.side.trim().toUpperCase(),
    mode,
    amount: semanticAmount(intent[mode]),
  })
}

export function policyHash(policy: Policy): string {
  return hash(policy)
}

export function payloadHash(executableIntent: unknown): { serialized: string; hash: string } {
  const serialized = serialize(executableIntent)
  return { serialized, hash: hash(serialized) }
}

export class PolicyRunStore {
  #runs = new Map<string, StoredRun>()

  createRun(originalPolicy: Policy, now?: number): PolicyRunState {
    const createdAt = timestamp(now)
    const runId = randomUUID()
    const state: PolicyRunState = {
      runId,
      originalPolicy: clone(originalPolicy),
      policyHash: policyHash(originalPolicy),
      currentStep: 0,
      maxTrades: MAX_TRADES_PER_RUN,
      status: 'READING',
      activePlanId: null,
      historyPlanIds: [],
      submittedPayloadHashes: [],
      tradeCount: 0,
      createdAt,
      updatedAt: createdAt,
      proposedPayloadHashes: [],
      intentFingerprints: [],
      clientOrderIds: [],
    }
    this.#runs.set(runId, { state, activePlan: null, allPlanIds: new Set([runId]) })
    return clone(state)
  }

  getRun(runId: string): PolicyRunState {
    return clone(requireRun(this.#runs, runId).state)
  }

  getActivePlan(runId: string): ActivePlan | null {
    const plan = requireRun(this.#runs, runId).activePlan
    return plan ? clone(plan) : null
  }

  beginPlanning(runId: string, now?: number): PolicyRunState {
    const run = requireRun(this.#runs, runId)
    if (!['READING', 'PLANNING'].includes(run.state.status)) {
      throw new PolicyRunStateError('INVALID_STATE', `Cannot begin planning from ${run.state.status}.`)
    }
    run.state.status = 'PLANNING'
    run.state.updatedAt = timestamp(now)
    return clone(run.state)
  }

  createPlan(runId: string, input: CreatePlanInput, now?: number): ActivePlan | null {
    const run = requireRun(this.#runs, runId)
    const createdAt = timestamp(now)
    if (run.state.tradeCount >= run.state.maxTrades) {
      run.state.status = 'MANUAL_REVIEW'
      run.state.updatedAt = createdAt
      throw new PolicyRunStateError('MAX_TRADES', 'The run has reached its maximum of three trades.')
    }
    if (!['READING', 'PLANNING', 'AWAITING_APPROVAL'].includes(run.state.status)) {
      throw new PolicyRunStateError('INVALID_STATE', `Cannot create a plan from ${run.state.status}.`)
    }
    if (!isPlannerDecision(input.decision)) throw new PolicyRunStateError('UNTRUSTED_DECISION', 'Only a decision produced by the deterministic planner can create an execution plan.')

    if (run.activePlan) this.invalidateActivePlan(run, 'A new planner decision replaced the previous plan.', createdAt, 'PLANNING')

    if (input.decision.status === 'COMPLETE') {
      run.state.status = 'COMPLETE'
      run.state.updatedAt = createdAt
      return null
    }
    if (input.decision.status === 'STOP') {
      run.state.status = 'MANUAL_REVIEW'
      run.state.updatedAt = createdAt
      return null
    }

    assertReadyDecision(input.decision)
    assertSnapshotHash(input.snapshotHash)
    let planId = randomUUID()
    while (run.allPlanIds.has(planId)) planId = randomUUID()
    run.allPlanIds.add(planId)
    const executableIntent = input.executableIntentFactory ? input.executableIntentFactory(planId) : input.executableIntent
    if (executableIntent === undefined) throw new PolicyRunStateError('INVALID_PAYLOAD', 'An executable intent is required.')
    const intent = payloadHash(executableIntent)
    const fingerprint = semanticIntentFingerprint(input.decision, executableIntent)
    const orderId = clientOrderId(executableIntent)
    if (run.state.submittedPayloadHashes.includes(intent.hash) || run.state.intentFingerprints.includes(fingerprint) || (orderId !== undefined && run.state.clientOrderIds.includes(orderId))) {
      run.state.status = 'MANUAL_REVIEW'
      run.state.updatedAt = createdAt
      throw new PolicyRunStateError('DUPLICATE_INTENT', 'The same order intent was already proposed in this run.')
    }

    const protectedAssets = normalizedProtectedAssets(input.protectedAssets)
    const expectedProtectedAssets = policyProtectedAssets(run.state.originalPolicy)
    if (protectedAssets.join('|') !== expectedProtectedAssets.join('|')) throw new PolicyRunStateError('PROTECTED_ASSETS', 'The plan protected-asset set does not match the immutable policy.')
    const plan: ActivePlan = {
      planId,
      runId,
      decision: clone(input.decision),
      snapshotHash: input.snapshotHash,
      serializedExecutableIntent: intent.serialized,
      payloadHash: intent.hash,
      intentFingerprint: fingerprint,
      protectedAssets,
      createdAt,
      expiresAt: createdAt + defaultPlanTtlMs,
      status: 'PENDING',
      writeClaimed: false,
      policyHash: run.state.policyHash,
      plannerResultHash: hash(input.decision),
      violationScoreBefore: input.decision.violationScoreBefore,
      violationScoreExpected: input.decision.violationScoreExpected,
    }
    run.activePlan = plan
    run.state.activePlanId = planId
    run.state.currentStep += 1
    run.state.proposedPayloadHashes.push(intent.hash)
    run.state.status = 'AWAITING_APPROVAL'
    run.state.updatedAt = createdAt
    return clone(plan)
  }

  approve(runId: string, approvalText: string, now?: number, context: ApprovalContext = {}): PolicyRunState {
    const run = requireRun(this.#runs, runId)
    const currentTime = timestamp(now)
    const plan = requireActivePlan(run)
    if (approvalText !== `APPROVE ${plan.planId}`) throw new PolicyRunStateError('INVALID_APPROVAL', `Approval must exactly match APPROVE ${plan.planId}.`)
    if (run.state.activePlanId !== plan.planId) throw new PolicyRunStateError('STALE_PLAN', 'The plan is no longer active.')
    if (plan.status !== 'PENDING') throw new PolicyRunStateError('PLAN_NOT_PENDING', 'The plan has already been submitted, consumed, or invalidated.')
    if (currentTime >= plan.expiresAt) {
      this.invalidateActivePlan(run, 'The approval plan expired.', currentTime, 'PLANNING')
      throw new PolicyRunStateError('EXPIRED_PLAN', 'The approval plan has expired and must be replanned.')
    }
    if (run.state.policyHash !== policyHash(run.state.originalPolicy)) {
      this.invalidateActivePlan(run, 'The original policy changed.', currentTime, 'MANUAL_REVIEW')
      throw new PolicyRunStateError('POLICY_CHANGED', 'The original policy no longer matches its stored hash.')
    }
    const storedDecision = plan.decision
    if (storedDecision.status !== 'READY' || plan.policyHash !== run.state.policyHash || hash(storedDecision) !== plan.plannerResultHash || plan.violationScoreBefore !== storedDecision.violationScoreBefore || plan.violationScoreExpected !== storedDecision.violationScoreExpected || plan.protectedAssets.join('|') !== policyProtectedAssets(run.state.originalPolicy).join('|')) {
      this.invalidateActivePlan(run, 'The planner provenance changed.', currentTime, 'MANUAL_REVIEW')
      throw new PolicyRunStateError('PLANNER_PROVENANCE', 'The plan no longer matches its deterministic planner result.')
    }
    const storedPayload = payloadHash(JSON.parse(plan.serializedExecutableIntent))
    if (storedPayload.hash !== plan.payloadHash) {
      this.invalidateActivePlan(run, 'The stored executable payload changed.', currentTime, 'MANUAL_REVIEW')
      throw new PolicyRunStateError('PAYLOAD_CHANGED', 'The stored executable payload no longer matches its approval hash.')
    }
    if (context.executableIntent !== undefined && payloadHash(context.executableIntent).hash !== plan.payloadHash) {
      this.invalidateActivePlan(run, 'The approval payload changed.', currentTime, 'MANUAL_REVIEW')
      throw new PolicyRunStateError('PAYLOAD_CHANGED', 'The approval payload does not match the displayed executable intent.')
    }
    if (context.policy !== undefined && policyHash(context.policy) !== run.state.policyHash) {
      this.invalidateActivePlan(run, 'The approval policy changed.', currentTime, 'MANUAL_REVIEW')
      throw new PolicyRunStateError('POLICY_CHANGED', 'The approval policy does not match the original policy.')
    }
    if (run.state.submittedPayloadHashes.includes(plan.payloadHash)) {
      throw new PolicyRunStateError('DUPLICATE_APPROVAL', 'This executable payload has already been submitted.')
    }
    if (run.state.tradeCount >= run.state.maxTrades) {
      run.state.status = 'MANUAL_REVIEW'
      run.state.updatedAt = currentTime
      throw new PolicyRunStateError('MAX_TRADES', 'The run has reached its maximum of three trades.')
    }

    plan.status = 'SUBMITTING'
    run.state.status = 'SUBMITTING'
    run.state.updatedAt = currentTime
    return clone(run.state)
  }

  claimSubmission(runId: string, planId: string, approvedPayloadHash: string, now?: number): PolicyRunState {
    const run = requireRun(this.#runs, runId)
    const currentTime = timestamp(now)
    const plan = requireActivePlan(run, planId)
    if (run.state.status !== 'SUBMITTING' || plan.status !== 'SUBMITTING' || run.state.activePlanId !== planId) throw new PolicyRunStateError('INVALID_STATE', 'The plan is not in a writable submission state.')
    if (plan.writeClaimed) throw new PolicyRunStateError('DUPLICATE_SUBMISSION', 'This plan already has a single-use write claim.')
    if (approvedPayloadHash !== plan.payloadHash) throw new PolicyRunStateError('PAYLOAD_CHANGED', 'The submission payload does not match the approved plan.')
    if (currentTime >= plan.expiresAt) {
      this.invalidateActivePlan(run, 'The approval plan expired before submission.', currentTime, 'MANUAL_REVIEW')
      throw new PolicyRunStateError('EXPIRED_PLAN', 'The approval plan expired before submission.')
    }
    if (run.state.tradeCount >= run.state.maxTrades) {
      run.state.status = 'MANUAL_REVIEW'
      run.state.updatedAt = currentTime
      throw new PolicyRunStateError('MAX_TRADES', 'The run has reached its maximum of three write attempts.')
    }
    plan.writeClaimed = true
    run.state.tradeCount += 1
    run.state.submittedPayloadHashes.push(plan.payloadHash)
    run.state.intentFingerprints.push(plan.intentFingerprint)
    const submittedOrderId = clientOrderId(JSON.parse(plan.serializedExecutableIntent))
    if (submittedOrderId) run.state.clientOrderIds.push(submittedOrderId)
    run.state.updatedAt = currentTime
    return clone(run.state)
  }

  markManualReview(runId: string, now?: number): PolicyRunState {
    const run = requireRun(this.#runs, runId)
    const currentTime = timestamp(now)
    this.invalidateActivePlan(run, 'The execution path requires manual review.', currentTime, 'MANUAL_REVIEW')
    run.state.updatedAt = currentTime
    return clone(run.state)
  }

  beginVerification(runId: string, planId: string, now?: number): PolicyRunState {
    const run = requireRun(this.#runs, runId)
    const plan = requireActivePlan(run, planId)
    if (plan.status !== 'SUBMITTING' || !plan.writeClaimed || run.state.status !== 'SUBMITTING') throw new PolicyRunStateError('INVALID_STATE', 'Only a claimed submitted plan can enter verification.')
    plan.status = 'SUBMITTING'
    run.state.status = 'VERIFYING'
    run.state.updatedAt = timestamp(now)
    return clone(run.state)
  }

  recordVerification(runId: string, planId: string, result: VerificationInput, now?: number): PolicyRunState {
    const run = requireRun(this.#runs, runId)
    const plan = requireActivePlan(run, planId)
    const currentTime = timestamp(now)
    if (plan.status !== 'SUBMITTING' || run.state.status !== 'VERIFYING') throw new PolicyRunStateError('INVALID_STATE', 'The plan is not awaiting verification.')
    if (!Number.isFinite(result.violationScoreBefore) || !Number.isFinite(result.violationScoreAfter)) {
      plan.status = 'CONSUMED'
      run.state.status = 'MANUAL_REVIEW'
      run.state.activePlanId = null
      run.state.historyPlanIds.push(plan.planId)
      run.activePlan = null
      run.state.updatedAt = currentTime
      throw new PolicyRunStateError('INVALID_VERIFICATION', 'Verification scores must be finite.')
    }

    const improved = result.violationScoreAfter < result.violationScoreBefore - scoreEpsilon
    plan.status = 'CONSUMED'
    run.state.activePlanId = null
    run.state.historyPlanIds.push(plan.planId)
    run.activePlan = null
    run.state.lastViolationScore = result.violationScoreAfter
    run.state.updatedAt = currentTime

    if (!improved) {
      run.state.status = 'MANUAL_REVIEW'
    } else if (result.complete) {
      run.state.status = 'COMPLETE'
    } else if (run.state.tradeCount >= run.state.maxTrades) {
      run.state.status = 'MANUAL_REVIEW'
    } else {
      run.state.status = 'READING'
    }
    return clone(run.state)
  }

  replan(runId: string, input: CreatePlanInput, now?: number): ActivePlan | null {
    const run = requireRun(this.#runs, runId)
    if (run.state.status !== 'READING' && run.state.status !== 'PLANNING') {
      throw new PolicyRunStateError('INVALID_STATE', 'A fresh read is required before replanning.')
    }
    this.beginPlanning(runId, now)
    return this.createPlan(runId, input, now)
  }

  noteAccountRefresh(runId: string, now?: number): PolicyRunState {
    return this.invalidateRunPlan(runId, 'The account state was refreshed.', now, 'READING')
  }

  notePriceRefresh(runId: string, now?: number): PolicyRunState {
    return this.invalidateRunPlan(runId, 'The market price snapshot was refreshed.', now, 'READING')
  }

  notePolicyChange(runId: string, nextPolicy: Policy, now?: number): PolicyRunState {
    const run = requireRun(this.#runs, runId)
    const currentTime = timestamp(now)
    if (policyHash(nextPolicy) !== run.state.policyHash) {
      this.invalidateActivePlan(run, 'The policy changed; the original run policy is immutable.', currentTime, 'MANUAL_REVIEW')
      run.state.status = 'MANUAL_REVIEW'
      run.state.updatedAt = currentTime
    }
    return clone(run.state)
  }

  restartRun(runId: string, now?: number): PolicyRunState {
    const run = requireRun(this.#runs, runId)
    const currentTime = timestamp(now)
    this.invalidateActivePlan(run, 'The run was restarted; pending approvals are invalid.', currentTime, 'MANUAL_REVIEW')
    run.state.status = 'MANUAL_REVIEW'
    run.state.updatedAt = currentTime
    return clone(run.state)
  }

  private invalidateRunPlan(runId: string, reason: string, now: number | undefined, nextStatus: PolicyRunStatus): PolicyRunState {
    const run = requireRun(this.#runs, runId)
    const currentTime = timestamp(now)
    this.invalidateActivePlan(run, reason, currentTime, nextStatus)
    run.state.updatedAt = currentTime
    return clone(run.state)
  }

  private invalidateActivePlan(run: StoredRun, _reason: string, now: number, nextStatus: PolicyRunStatus): void {
    if (run.activePlan) {
      run.activePlan.status = 'INVALIDATED'
      if (!run.state.historyPlanIds.includes(run.activePlan.planId)) run.state.historyPlanIds.push(run.activePlan.planId)
      run.activePlan = null
      run.state.activePlanId = null
    }
    run.state.status = nextStatus
    run.state.updatedAt = now
  }
}
