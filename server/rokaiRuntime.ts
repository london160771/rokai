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
  reads: RuntimeFreshReadInput
}

type RuntimeReplanRequest = {
  op: 'replan'
  runId: string
  settlementAsset: string
  reads: RuntimeFreshReadInput
}

type RuntimeApproveRequest = {
  op: 'approve'
  runId: string
  approval: string
  reads: RuntimeFreshReadInput
}

type RuntimeVerifyRequest = {
  op: 'verify'
  submissionId: string
  reads: HostOrderVerificationReads
}

type RuntimeReadyRequest = {
  op: 'ready'
}

type RuntimeFreshReadInput = {
  account: unknown
  prices: unknown
  exchangeInfo?: unknown
}

export type RokaiRuntimeRequest = RuntimeStartRequest | RuntimeReplanRequest | RuntimeApproveRequest | RuntimeVerifyRequest | RuntimeReadyRequest

export type RokaiRuntimeResponse = {
  ok: boolean
  runtime: 'rokai'
  operation: RokaiRuntimeRequest['op'] | 'error'
  error?: string
  ready?: boolean
  runtimeLoaded?: boolean
  liveExecutionEnabled?: boolean
  hostMcp?: Record<string, unknown>
  metadataCache?: Record<string, unknown>
  timings?: Record<string, number | string>
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

const READY_MODE_METADATA_TTL_MS = 45_000
const REQUIRED_HOST_READ_TOOLS = ['spot.getAccount', 'spot.tickerPrice', 'spot.exchangeInfo'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : 'Rokai runtime could not process the request.'
}

function errorResponse(operation: RokaiRuntimeResponse['operation'], error: string): RokaiRuntimeResponse {
  return { ok: false, runtime: 'rokai', operation, error }
}

function wallClockMilliseconds() {
  const value = Date.now()
  if (!Number.isFinite(value)) throw new Error('The Rokai runtime clock is unavailable.')
  return value
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint()) / 1_000_000
}

function elapsedMilliseconds(start: number) {
  return Math.max(0, Math.round((monotonicMilliseconds() - start) * 100) / 100)
}

function exchangeInfoEntries(value: unknown, seen = new Set<object>()): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => exchangeInfoEntries(entry, seen))
  if (!isRecord(value)) return []
  if (seen.has(value)) return []
  seen.add(value)
  if (typeof value.symbol === 'string' && typeof value.baseAsset === 'string' && typeof value.quoteAsset === 'string') return [value]
  if (value.type === 'text' && typeof value.text === 'string') {
    try { return exchangeInfoEntries(JSON.parse(value.text), seen) } catch { return [] }
  }
  const entries: Record<string, unknown>[] = []
  for (const key of ['symbols', 'result', 'data', 'structuredContent', 'content']) {
    if (key in value) entries.push(...exchangeInfoEntries(value[key], seen))
  }
  return entries
}

type CachedExchangeInfo = {
  entry: Record<string, unknown>
  cachedAt: number
  expiresAt: number
}

class ExchangeInfoCache {
  #entries = new Map<string, CachedExchangeInfo>()

  put(value: unknown) {
    const cachedAt = wallClockMilliseconds()
    for (const entry of exchangeInfoEntries(value)) {
      const symbol = typeof entry.symbol === 'string' ? entry.symbol.trim().toUpperCase() : ''
      if (!symbol) continue
      this.#entries.set(symbol, { entry, cachedAt, expiresAt: cachedAt + READY_MODE_METADATA_TTL_MS })
    }
  }

  payload(): { value?: unknown; status: 'hit' | 'miss' } {
    const now = wallClockMilliseconds()
    const entries: Record<string, unknown>[] = []
    for (const [symbol, cached] of this.#entries) {
      if (now >= cached.expiresAt) {
        this.#entries.delete(symbol)
        continue
      }
      entries.push(cached.entry)
    }
    return entries.length ? { value: { symbols: entries }, status: 'hit' } : { status: 'miss' }
  }

  summary() {
    const now = wallClockMilliseconds()
    let activeEntries = 0
    for (const [symbol, cached] of this.#entries) {
      if (now >= cached.expiresAt) this.#entries.delete(symbol)
      else activeEntries += 1
    }
    return { ttlMs: READY_MODE_METADATA_TTL_MS, activeSymbols: activeEntries }
  }
}

function freshReads(value: unknown, cache: ExchangeInfoCache): { reads: HostFreshBinanceReads; exchangeInfoCache: 'provided' | 'hit' } | null {
  if (!isRecord(value) || !('account' in value) || !('prices' in value)) return null
  if (value.exchangeInfo !== undefined && value.exchangeInfo !== null) {
    cache.put(value.exchangeInfo)
    return {
      reads: { account: value.account, prices: value.prices, exchangeInfo: value.exchangeInfo },
      exchangeInfoCache: 'provided',
    }
  }
  const cached = cache.payload()
  if (cached.status === 'miss') return null
  return {
    reads: { account: value.account, prices: value.prices, exchangeInfo: cached.value },
    exchangeInfoCache: 'hit',
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

function planResponse(result: HostPlanResult, policy?: Policy, operation: 'start' | 'replan' = 'start', timings: Record<string, number | string> = {}): RokaiRuntimeResponse {
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
    timings,
  }
}

export function createRokaiRuntimeController() {
  const runtimeStartedAt = monotonicMilliseconds()
  const sessions = new Map<string, RuntimeSession>()
  const exchangeInfoCache = new ExchangeInfoCache()

  const ready = (): RokaiRuntimeResponse => ({
    ok: true,
    runtime: 'rokai',
    operation: 'ready',
    ready: true,
    runtimeLoaded: true,
    liveExecutionEnabled: process.env.ROKAI_LIVE_EXECUTION?.trim().toLowerCase() === 'true',
    hostMcp: {
      mode: 'codex-mediated',
      requiredReadTools: [...REQUIRED_HOST_READ_TOOLS],
      availability: 'awaiting-host-read',
      note: 'The runtime cannot inspect the host MCP connection directly. A successful start/replan proves exact authenticated reads arrived from the host.',
    },
    metadataCache: exchangeInfoCache.summary(),
    timings: {
      startupMs: elapsedMilliseconds(runtimeStartedAt),
      readyResponseMs: elapsedMilliseconds(runtimeStartedAt),
    },
  })

  const start = (request: RuntimeStartRequest): RokaiRuntimeResponse => {
    const operationStartedAt = monotonicMilliseconds()
    const parsed = parsePolicy(request.policyText)
    if (!parsed.policy) return errorResponse('start', parsed.error ?? 'The policy is not supported.')
    const resolved = freshReads(request.reads, exchangeInfoCache)
    if (!resolved) return errorResponse('start', 'The runtime requires fresh account and price reads plus exchange-info from the host or a still-valid Ready Mode metadata cache.')
    try {
      const session = createRokaiHostMediatedSession()
      const result = session.startRun(parsed.policy, request.settlementAsset, resolved.reads)
      sessions.set(result.state.runId, { session, submissions: new Map() })
      return planResponse(result, parsed.policy, 'start', {
        operationMs: elapsedMilliseconds(operationStartedAt),
        planningMs: elapsedMilliseconds(operationStartedAt),
        exchangeInfoCache: resolved.exchangeInfoCache,
        metadataTtlMs: READY_MODE_METADATA_TTL_MS,
        mcpReads: 'host-supplied; network latency is outside the runtime',
      })
    } catch (error) {
      return errorResponse('start', safeError(error))
    }
  }

  const replan = (request: RuntimeReplanRequest): RokaiRuntimeResponse => {
    const operationStartedAt = monotonicMilliseconds()
    const runtimeSession = sessions.get(request.runId)
    if (!runtimeSession) return errorResponse('replan', 'The Rokai runtime session is unavailable; start a fresh run.')
    const resolved = freshReads(request.reads, exchangeInfoCache)
    if (!resolved) return errorResponse('replan', 'The runtime requires fresh account and price reads plus exchange-info from the host or a still-valid Ready Mode metadata cache.')
    try {
      const result = runtimeSession.session.replan(request.runId, request.settlementAsset, resolved.reads)
      return planResponse(result, runtimeSession.session.getRun(request.runId).originalPolicy, 'replan', {
        operationMs: elapsedMilliseconds(operationStartedAt),
        planningMs: elapsedMilliseconds(operationStartedAt),
        exchangeInfoCache: resolved.exchangeInfoCache,
        metadataTtlMs: READY_MODE_METADATA_TTL_MS,
        mcpReads: 'host-supplied; network latency is outside the runtime',
      })
    } catch (error) {
      return errorResponse('replan', safeError(error))
    }
  }

  const approve = (request: RuntimeApproveRequest): RokaiRuntimeResponse => {
    const operationStartedAt = monotonicMilliseconds()
    const runtimeSession = sessions.get(request.runId)
    if (!runtimeSession) return errorResponse('approve', 'The Rokai runtime session is unavailable; the plan cannot be approved.')
    const resolved = freshReads(request.reads, exchangeInfoCache)
    if (!resolved) return errorResponse('approve', 'The runtime requires fresh account and price reads plus exchange-info from the host or a still-valid Ready Mode metadata cache before approval.')
    try {
      const result = runtimeSession.session.approveAndPrepare(request.runId, request.approval, resolved.reads)
      const response: RokaiRuntimeResponse = {
        ok: Boolean(result.submission),
        runtime: 'rokai',
        operation: 'approve',
        ...(result.error ? { error: result.error } : {}),
        state: publicState(result),
        timings: {
          operationMs: elapsedMilliseconds(operationStartedAt),
          approvalAndFreshPreflightMs: elapsedMilliseconds(operationStartedAt),
          exchangeInfoCache: resolved.exchangeInfoCache,
          metadataTtlMs: READY_MODE_METADATA_TTL_MS,
          mcpReads: 'host-supplied; network latency is outside the runtime',
        },
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
    const operationStartedAt = monotonicMilliseconds()
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
          timings: {
            operationMs: elapsedMilliseconds(operationStartedAt),
            verificationMs: elapsedMilliseconds(operationStartedAt),
            mcpReads: 'host-supplied; network latency is outside the runtime',
          },
        }
      } catch (error) {
        return errorResponse('verify', safeError(error))
      }
    }
    return errorResponse('verify', 'The submission authority is unavailable, already consumed, or belongs to a restarted runtime.')
  }

  const handle = (request: unknown): RokaiRuntimeResponse => {
    if (!isRecord(request) || typeof request.op !== 'string') return errorResponse('error', 'A runtime operation is required.')
    if (request.op === 'ready') return ready()
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
