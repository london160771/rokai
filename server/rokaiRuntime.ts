import { randomUUID } from 'node:crypto'
import { parseDemoPolicy, valuePortfolio, type Policy } from '../src/rules.js'
import {
  createRokaiHostMediatedSession,
  type HostFreshBinanceReads,
  type HostOrderVerificationReads,
  type HostOrderSubmission,
  type HostPlanResult,
  type HostPreparedOrderResult,
  type HostVerificationResult,
  type RokaiHostMediatedSession,
} from './rokaiHostMediated.js'

type RuntimeStartRequest = {
  op: 'start'
  policyText: string
  settlementAsset: string
  reads: HostFreshBinanceReads
}

type RuntimeReplanRequest = {
  op: 'replan'
  runId: string
  settlementAsset: string
  reads: HostFreshBinanceReads
}

type RuntimeApproveRequest = {
  op: 'approve'
  runId: string
  approval: string
  reads: HostFreshBinanceReads
}

type RuntimeVerifyRequest = {
  op: 'verify'
  submissionId: string
  reads: HostOrderVerificationReads
}

export type RokaiRuntimeRequest = RuntimeStartRequest | RuntimeReplanRequest | RuntimeApproveRequest | RuntimeVerifyRequest

export type RokaiRuntimeResponse = {
  ok: boolean
  runtime: 'rokai'
  operation: RokaiRuntimeRequest['op'] | 'error'
  error?: string
  authoritativePlan?: boolean
  state?: Record<string, unknown>
  portfolio?: Record<string, unknown> | null
  policy?: Policy
  ruleResults?: unknown[]
  expectedRuleResults?: unknown[]
  plan?: Record<string, unknown> | null
  submission?: Record<string, unknown>
  verification?: Record<string, unknown>
}

type RuntimeSession = {
  session: RokaiHostMediatedSession
  submissions: Map<string, HostOrderSubmission>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : 'Rokai runtime could not process the request.'
}

function errorResponse(operation: RokaiRuntimeResponse['operation'], error: string): RokaiRuntimeResponse {
  return { ok: false, runtime: 'rokai', operation, error }
}

function freshReads(value: unknown): HostFreshBinanceReads | null {
  if (!isRecord(value) || !('account' in value) || !('prices' in value) || !('exchangeInfo' in value)) return null
  return {
    account: value.account,
    prices: value.prices,
    exchangeInfo: value.exchangeInfo,
  }
}

function verificationReads(value: unknown): HostOrderVerificationReads | null {
  if (!isRecord(value) || !('order' in value) || !('account' in value) || !('prices' in value)) return null
  return {
    order: value.order,
    account: value.account,
    prices: value.prices,
  }
}

function parsePolicy(text: unknown): { policy?: Policy; error?: string } {
  if (typeof text !== 'string' || !text.trim()) return { error: 'The exact natural-language policy text is required.' }
  const parsed = parseDemoPolicy(text)
  return parsed.policy ? { policy: parsed.policy } : { error: parsed.error ?? 'Rokai could not parse the policy safely.' }
}

function publicState(result: { state: HostPlanResult['state'] | HostPreparedOrderResult['state'] | HostVerificationResult['state'] }) {
  return {
    runId: result.state.runId,
    status: result.state.status,
    currentStep: result.state.currentStep,
    maxTrades: result.state.maxTrades,
    activePlanId: result.state.activePlanId,
    tradeCount: result.state.tradeCount,
  }
}

function publicPortfolio(result: HostPlanResult): Record<string, unknown> | null {
  if (!result.portfolio) return null
  const valued = valuePortfolio(result.portfolio.assets)
  return {
    source: result.portfolio.source,
    asOf: result.portfolio.asOf,
    empty: result.portfolio.empty,
    totalUsd: valued.totalUsd,
    assets: valued.assets.map((asset) => ({
      symbol: asset.symbol,
      quantity: asset.quantity,
      free: asset.free,
      locked: asset.locked,
      priceUsd: asset.priceUsd,
      valueUsd: asset.valueUsd,
      allocationPct: asset.allocationPct,
    })),
  }
}

function parseStoredOrder(plan: NonNullable<HostPlanResult['plan']>): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(plan.serializedExecutableIntent)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function publicPlan(result: HostPlanResult): { plan: Record<string, unknown> | null; authoritativePlan: boolean } {
  const decision = result.decision
  const plan = result.plan
  if (!plan) return { plan: null, authoritativePlan: false }
  const order = decision?.status === 'READY' && result.preflight === 'PASS' ? parseStoredOrder(plan) : null
  const authoritativePlan = Boolean(order && decision?.status === 'READY' && result.preflight === 'PASS')
  return {
    authoritativePlan,
    plan: {
      planId: plan.planId,
      status: plan.status,
      preflight: result.preflight,
      expiresAt: new Date(plan.expiresAt).toISOString(),
      payloadHash: plan.payloadHash,
      action: order,
    },
  }
}

function planResponse(result: HostPlanResult, policy?: Policy, operation: 'start' | 'replan' = 'start'): RokaiRuntimeResponse {
  const plan = publicPlan(result)
  const decision = result.decision
  return {
    ok: result.preflight !== 'FAILED',
    runtime: 'rokai',
    operation,
    ...(result.error ? { error: result.error } : {}),
    authoritativePlan: plan.authoritativePlan,
    state: publicState(result),
    portfolio: publicPortfolio(result),
    ...(policy ? { policy } : {}),
    ruleResults: decision?.ruleResults ?? [],
    expectedRuleResults: decision?.status === 'READY' ? decision.expectedRuleResults : [],
    plan: plan.plan,
  }
}

export function createRokaiRuntimeController() {
  const sessions = new Map<string, RuntimeSession>()

  const start = (request: RuntimeStartRequest): RokaiRuntimeResponse => {
    const parsed = parsePolicy(request.policyText)
    if (!parsed.policy) return errorResponse('start', parsed.error ?? 'The policy is not supported.')
    const reads = freshReads(request.reads)
    if (!reads) return errorResponse('start', 'The runtime requires the exact account, price, and exchange-info reads from the supported host.')
    try {
      const session = createRokaiHostMediatedSession()
      const result = session.startRun(parsed.policy, request.settlementAsset, reads)
      sessions.set(result.state.runId, { session, submissions: new Map() })
      return planResponse(result, parsed.policy, 'start')
    } catch (error) {
      return errorResponse('start', safeError(error))
    }
  }

  const replan = (request: RuntimeReplanRequest): RokaiRuntimeResponse => {
    const runtimeSession = sessions.get(request.runId)
    if (!runtimeSession) return errorResponse('replan', 'The Rokai runtime session is unavailable; start a fresh run.')
    const reads = freshReads(request.reads)
    if (!reads) return errorResponse('replan', 'The runtime requires the exact account, price, and exchange-info reads from the supported host.')
    try {
      const result = runtimeSession.session.replan(request.runId, request.settlementAsset, reads)
      return planResponse(result, runtimeSession.session.getRun(request.runId).originalPolicy, 'replan')
    } catch (error) {
      return errorResponse('replan', safeError(error))
    }
  }

  const approve = (request: RuntimeApproveRequest): RokaiRuntimeResponse => {
    const runtimeSession = sessions.get(request.runId)
    if (!runtimeSession) return errorResponse('approve', 'The Rokai runtime session is unavailable; the plan cannot be approved.')
    const reads = freshReads(request.reads)
    if (!reads) return errorResponse('approve', 'The runtime requires fresh account, price, and exchange-info reads before approval.')
    try {
      const result = runtimeSession.session.approveAndPrepare(request.runId, request.approval, reads)
      const response: RokaiRuntimeResponse = {
        ok: Boolean(result.submission),
        runtime: 'rokai',
        operation: 'approve',
        ...(result.error ? { error: result.error } : {}),
        state: publicState(result),
      }
      if (result.submission) {
        const submissionId = randomUUID()
        runtimeSession.submissions.set(submissionId, result.submission)
        response.submission = {
          submissionId,
          runId: result.submission.runId,
          planId: result.submission.planId,
          step: result.submission.step,
          payloadHash: result.submission.payloadHash,
          payload: result.submission.payload,
        }
      }
      if (result.nextPlan) response.plan = { planId: result.nextPlan.planId, status: result.nextPlan.status, preflight: 'PASS' }
      return response
    } catch (error) {
      return errorResponse('approve', safeError(error))
    }
  }

  const verify = (request: RuntimeVerifyRequest): RokaiRuntimeResponse => {
    for (const runtimeSession of sessions.values()) {
      const submission = runtimeSession.submissions.get(request.submissionId)
      if (!submission) continue
      const reads = verificationReads(request.reads)
      if (!reads) return errorResponse('verify', 'The runtime requires the order, account, and price rereads for verification.')
      try {
        const result = runtimeSession.session.verifyFilled(submission, reads)
        runtimeSession.submissions.delete(request.submissionId)
        return {
          ok: Boolean(result.verification?.verified && result.state.status === 'COMPLETE'),
          runtime: 'rokai',
          operation: 'verify',
          ...(result.error ? { error: result.error } : {}),
          state: publicState(result),
          verification: result.verification as unknown as Record<string, unknown> | undefined,
        }
      } catch (error) {
        return errorResponse('verify', safeError(error))
      }
    }
    return errorResponse('verify', 'The submission authority is unavailable, already consumed, or belongs to a restarted runtime.')
  }

  const handle = (request: unknown): RokaiRuntimeResponse => {
    if (!isRecord(request) || typeof request.op !== 'string') return errorResponse('error', 'A runtime operation is required.')
    if (request.op === 'start') return start(request as unknown as RuntimeStartRequest)
    if (request.op === 'replan') return replan(request as unknown as RuntimeReplanRequest)
    if (request.op === 'approve') return approve(request as unknown as RuntimeApproveRequest)
    if (request.op === 'verify') return verify(request as unknown as RuntimeVerifyRequest)
    return errorResponse('error', 'Unsupported Rokai runtime operation.')
  }

  return { handle }
}

export function runRokaiRuntime(input: unknown): RokaiRuntimeResponse {
  if (!isRecord(input)) return errorResponse('start', 'The runtime input must be a JSON object.')
  return createRokaiRuntimeController().handle({ ...input, op: 'start' })
}
