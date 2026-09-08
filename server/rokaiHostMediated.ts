import {
  assertOrderSafeToSubmit,
  buildExecutableOrder,
  buildSpotOrderArguments,
  normalizeExchangeSymbolInfo,
  parseOrderResponse,
  validateOrderResponseIdentity,
  validateSpotAccountForExecution,
  verifyExecutedOrder,
  type ExecutableOrder,
  type ExecutionReceipt,
  type ExchangeSymbolInfo,
  type PostTradeVerification,
} from '../src/execution.js'
import { calculateViolationScore, planNextTrade, type NextTradeDecision } from '../src/nextTradePlanner.js'
import type { Asset } from '../src/mockData.js'
import type { Policy } from '../src/rules.js'
import { normalizeLivePortfolio, normalizeSpotBalances, normalizeSpotPrices, type LivePortfolio } from './binanceAgentOsApi.js'
import { payloadHash, PolicyRunStateError, PolicyRunStore, type ActivePlan, type PolicyRunState } from './policyRunState.js'

/**
 * The Codex host is the authenticated Binance transport. This contract accepts
 * only the raw results of the three required read tools. It deliberately has
 * no executor, token, cookie, order, timestamp, or threshold input.
 */
export type HostFreshBinanceReads = Readonly<{
  account: unknown
  prices: unknown
  exchangeInfo: unknown
}>

export type HostOrderVerificationReads = Readonly<{
  order: unknown
  account: unknown
  prices: unknown
}>

export type HostOrderSubmission = Readonly<{
  runId: string
  planId: string
  step: number
  payloadHash: string
  payload: Readonly<Record<string, unknown>>
}>

export type HostPlanResult = {
  state: PolicyRunState
  plan: ActivePlan | null
  decision?: NextTradeDecision | null
  portfolio?: LivePortfolio
  preflight: 'PASS' | 'NOT_REQUIRED' | 'FAILED'
  error?: string
}

export type HostPreparedOrderResult = {
  state: PolicyRunState
  submission?: HostOrderSubmission
  nextPlan?: ActivePlan | null
  error?: string
}

export type HostVerificationResult = {
  state: PolicyRunState
  receipt?: ExecutionReceipt
  verification?: PostTradeVerification
  error?: string
}

export type RokaiHostMediatedSession = {
  startRun: (policy: Policy, settlementAsset: string, reads: HostFreshBinanceReads) => HostPlanResult
  replan: (runId: string, settlementAsset: string, reads: HostFreshBinanceReads) => HostPlanResult
  approveAndPrepare: (runId: string, approvalText: string, reads: HostFreshBinanceReads) => HostPreparedOrderResult
  verifyFilled: (submission: HostOrderSubmission, reads: HostOrderVerificationReads) => HostVerificationResult
  getRun: (runId: string) => PolicyRunState
  getActivePlan: (runId: string) => ActivePlan | null
}

const fundedDemoWriteLimit = 1
const stablecoinSymbols = new Set(['USDC', 'USDT', 'BUSD', 'FDUSD', 'DAI', 'USDE'])

function isHostLiveExecutionEnabled() {
  return process.env.ROKAI_LIVE_EXECUTION?.trim().toLowerCase() === 'true'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : 'The supported Binance host did not provide usable data.'
}

function normalizeAsset(value: string, label: string) {
  const asset = value.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]{1,11}$/.test(asset)) throw new Error(`${label} is malformed.`)
  return asset
}

function rejectCallerAuthority(reads: unknown, allowOrder = false) {
  if (!isRecord(reads)) throw new Error('The supported host must provide a structured read result.')
  const forbidden = ['executor', 'token', 'authToken', 'credentials', 'cookie', 'authorization', 'timestamp', 'now', 'thresholds', 'order']
  if (forbidden.some((key) => key in reads && !(allowOrder && key === 'order'))) throw new Error('Host reads cannot include caller-controlled authority or credentials.')
}

function finiteNowIso() {
  const now = Date.now()
  if (!Number.isFinite(now)) throw new Error('The trusted execution clock is unavailable.')
  return new Date(now).toISOString()
}

function pairSymbolForAction(action: { source: string; target: string }, settlementAsset: string) {
  const source = normalizeAsset(action.source, 'Source asset')
  const target = normalizeAsset(action.target, 'Target asset')
  const settlement = normalizeAsset(settlementAsset, 'Settlement asset')
  if (source === target || (source !== settlement && target !== settlement)) throw new Error('Only a direct pair aligned to the named settlement asset is supported.')
  return target === settlement ? `${source}${settlement}` : `${target}${settlement}`
}

function snapshotHash(portfolio: LivePortfolio, market: ExchangeSymbolInfo) {
  return payloadHash({
    assets: portfolio.assets.map((asset) => ({ symbol: asset.symbol, quantity: asset.quantity, free: asset.free, locked: asset.locked })),
    market,
  }).hash
}

function referencePricesForMissingTargets(policy: Policy, settlementAsset: string, balances: ReturnType<typeof normalizeSpotBalances>, prices: Map<string, number>) {
  const settlement = normalizeAsset(settlementAsset, 'Settlement asset')
  const references: Record<string, number> = {}
  const present = new Set(balances.map((balance) => balance.symbol))
  for (const rule of policy.rules) {
    if (rule.kind !== 'min_asset_allocation' || present.has(rule.asset) || stablecoinSymbols.has(rule.asset)) continue
    const pair = `${rule.asset}${settlement}`
    const price = prices.get(pair) ?? prices.get(`${rule.asset}USDT`)
    if (price !== undefined) references[rule.asset] = price
  }
  return references
}

function readPlanningState(policy: Policy, settlementAsset: string, reads: Pick<HostFreshBinanceReads, 'account' | 'prices'>, allowOrder = false): {
  account: unknown
  portfolio: LivePortfolio
  prices: Map<string, number>
  referencePricesUsd: Record<string, number>
} {
  rejectCallerAuthority(reads, allowOrder)
  validateSpotAccountForExecution(reads.account)
  const balances = normalizeSpotBalances(reads.account)
  const prices = normalizeSpotPrices(reads.prices)
  const portfolio = normalizeLivePortfolio(reads.account, reads.prices, finiteNowIso())
  return {
    account: reads.account,
    portfolio,
    prices,
    referencePricesUsd: referencePricesForMissingTargets(policy, settlementAsset, balances, prices),
  }
}

function readMarket(reads: HostFreshBinanceReads, symbol: string) {
  rejectCallerAuthority(reads)
  const market = normalizeExchangeSymbolInfo(reads.exchangeInfo, symbol)
  const prices = normalizeSpotPrices(reads.prices)
  const price = prices.get(market.symbol)
  if (price === undefined) throw new Error(`No fresh price was returned for ${market.symbol}.`)
  return {
    market,
    price: { symbol: market.symbol, price, timestamp: finiteNowIso() },
    exchangeInfoTimestamp: Date.now(),
  }
}

function storedOrder(plan: ActivePlan, run: PolicyRunState): ExecutableOrder {
  let value: unknown
  try { value = JSON.parse(plan.serializedExecutableIntent) } catch { throw new Error('The stored executable intent is malformed.') }
  if (!isRecord(value) || value.runId !== run.runId || value.planId !== plan.planId || value.step !== run.currentStep || payloadHash(value).hash !== plan.payloadHash || payloadHash(value).serialized !== plan.serializedExecutableIntent) {
    throw new Error('The stored executable intent no longer matches the active plan.')
  }
  return value as unknown as ExecutableOrder
}

function internalApprovedBinding(plan: ActivePlan) {
  return {
    planId: plan.planId,
    serializedPayload: plan.serializedExecutableIntent,
    expiresAt: new Date(plan.expiresAt).toISOString(),
    approved: true,
    consumed: false,
  }
}

function preflightStoredPlan(run: PolicyRunState, plan: ActivePlan, reads: HostFreshBinanceReads) {
  const order = storedOrder(plan, run)
  const planning = readPlanningState(run.originalPolicy, order.quoteAsset, reads)
  const marketState = readMarket(reads, order.symbol)
  const currentSnapshot = snapshotHash(planning.portfolio, marketState.market)
  if (currentSnapshot !== plan.snapshotHash) throw new Error('Fresh account or market state changed; the approved plan must be invalidated and replanned.')
  assertOrderSafeToSubmit(order, internalApprovedBinding(plan), {
    assets: planning.portfolio.assets,
    account: planning.account,
    market: marketState.market,
    currentPrice: marketState.price,
    exchangeInfoTimestamp: marketState.exchangeInfoTimestamp,
    policy: run.originalPolicy,
    protectedAssets: plan.protectedAssets,
  })
  return { order, planning, marketState }
}

function planFromFreshState(store: PolicyRunStore, runId: string, settlementAsset: string, reads: HostFreshBinanceReads): HostPlanResult {
  const run = store.getRun(runId)
  const settlement = normalizeAsset(settlementAsset, 'Settlement asset')
  const planning = readPlanningState(run.originalPolicy, settlement, reads)
  if (planning.portfolio.empty) return { state: run, plan: null, decision: null, portfolio: planning.portfolio, preflight: 'NOT_REQUIRED' }

  const initialDecision = planNextTrade(planning.portfolio.assets, run.originalPolicy, {
    runId,
    settlementAsset: settlement,
    referencePricesUsd: planning.referencePricesUsd,
  })
  const protectedAssets = run.originalPolicy.rules.filter((rule) => rule.kind === 'protected_asset').map((rule) => rule.asset)
  if (initialDecision.status !== 'READY') {
    const plan = store.createPlan(runId, { decision: initialDecision, snapshotHash: payloadHash(planning.portfolio.assets).hash, protectedAssets })
    return { state: store.getRun(runId), plan, decision: initialDecision, portfolio: planning.portfolio, preflight: 'NOT_REQUIRED' }
  }

  let symbol = pairSymbolForAction(initialDecision.nextTrade, settlement)
  let marketState = readMarket(reads, symbol)

  // The executable BUY amount depends on the fresh symbol filters. Re-run the
  // deterministic planner with that exact market snapshot so the stored plan
  // models Binance's final lot-size-quantized base quantity.
  let executableDecision = planNextTrade(planning.portfolio.assets, run.originalPolicy, {
    runId,
    settlementAsset: settlement,
    referencePricesUsd: planning.referencePricesUsd,
    market: marketState.market,
  })
  if (executableDecision.status === 'READY') {
    const executableSymbol = pairSymbolForAction(executableDecision.nextTrade, settlement)
    if (executableSymbol !== symbol) {
      symbol = executableSymbol
      marketState = readMarket(reads, symbol)
      executableDecision = planNextTrade(planning.portfolio.assets, run.originalPolicy, {
        runId,
        settlementAsset: settlement,
        referencePricesUsd: planning.referencePricesUsd,
        market: marketState.market,
      })
    }
  }
  if (executableDecision.status !== 'READY') {
    const plan = store.createPlan(runId, { decision: executableDecision, snapshotHash: payloadHash(planning.portfolio.assets).hash, protectedAssets })
    return { state: store.getRun(runId), plan, decision: executableDecision, portfolio: planning.portfolio, preflight: 'NOT_REQUIRED' }
  }

  const decision = executableDecision
  const snapshot = snapshotHash(planning.portfolio, marketState.market)
  let order: ExecutableOrder | undefined
  const plan = store.replan(runId, {
    decision,
    snapshotHash: snapshot,
    protectedAssets,
    executableIntentFactory: (planId) => {
      order = buildExecutableOrder(decision.nextTrade, planning.portfolio.assets, [marketState.market], marketState.price, protectedAssets, {
        settlementAsset: settlement,
        planId,
        runId,
        step: run.currentStep + 1,
      })
      return order
    },
  })
  if (!plan || !order) throw new Error('The trusted planner did not produce an executable order.')
  try {
    preflightStoredPlan(store.getRun(runId), plan, reads)
  } catch (error) {
    store.noteAccountRefresh(runId)
    return { state: store.getRun(runId), plan: null, decision, portfolio: planning.portfolio, preflight: 'FAILED', error: safeError(error) }
  }
  return { state: store.getRun(runId), plan, decision, portfolio: planning.portfolio, preflight: 'PASS' }
}

export function createRokaiHostMediatedSession(): RokaiHostMediatedSession {
  if (arguments.length !== 0) throw new Error('The supported-host session accepts no injected executor, credentials, or caller authority.')
  const store = new PolicyRunStore()
  const issued = new WeakMap<object, { order: ExecutableOrder; plan: ActivePlan; beforeAssets: Asset[]; runId: string; used: boolean }>()
  const runSettlements = new Map<string, string>()
  const submissionIssued = new Set<string>()

  const session: RokaiHostMediatedSession = {
    startRun(policy, settlementAsset, reads) {
      const run = store.createRun(policy)
      const settlement = normalizeAsset(settlementAsset, 'Settlement asset')
      runSettlements.set(run.runId, settlement)
      try {
        return planFromFreshState(store, run.runId, settlement, reads)
      } catch (error) {
        return { state: store.markManualReview(run.runId), plan: null, preflight: 'FAILED', error: safeError(error) }
      }
    },
    replan(runId, settlementAsset, reads) {
      const settlement = runSettlements.get(runId) ?? normalizeAsset(settlementAsset, 'Settlement asset')
      runSettlements.set(runId, settlement)
      try {
        const current = store.getRun(runId)
        if (current.activePlanId) store.noteAccountRefresh(runId)
        return planFromFreshState(store, runId, settlement, reads)
      } catch (error) {
        return { state: store.markManualReview(runId), plan: null, preflight: 'FAILED', error: safeError(error) }
      }
    },
    approveAndPrepare(runId, approvalText, reads) {
      if (submissionIssued.has(runId)) return { state: store.markManualReview(runId), error: 'This funded-demo run has already issued its one submission authority.' }
      if (!isHostLiveExecutionEnabled()) return { state: store.getRun(runId), error: 'Rokai live execution is disabled. No order payload was released to the host.' }
      try {
        store.approve(runId, approvalText)
        const run = store.getRun(runId)
        const plan = store.getActivePlan(runId)
        if (!plan) throw new Error('The approved plan is no longer active.')
        const fresh = preflightStoredPlan(run, plan, reads)
        const payload = Object.freeze({ ...buildSpotOrderArguments(fresh.order) })
        const ticket: HostOrderSubmission = Object.freeze({
          runId,
          planId: plan.planId,
          step: run.currentStep,
          payloadHash: payloadHash(payload).hash,
          payload,
        })
        issued.set(ticket as object, { order: fresh.order, plan, beforeAssets: fresh.planning.portfolio.assets, runId, used: false })
        submissionIssued.add(runId)
        return { state: store.getRun(runId), submission: ticket }
      } catch (error) {
        const message = safeError(error)
        const current = store.getRun(runId)
        if (current.status === 'SUBMITTING') {
          store.noteAccountRefresh(runId)
          try {
            const settlement = runSettlements.get(runId)
            if (!settlement) throw new Error('The named settlement asset is no longer available.')
            const replacement = planFromFreshState(store, runId, settlement, reads)
            return { state: replacement.state, nextPlan: replacement.plan, error: `${message} The previous approval was invalidated; review the fresh plan.` }
          } catch (replanError) {
            return { state: store.markManualReview(runId), error: `${message} ${safeError(replanError)}` }
          }
        }
        return { state: current, error: message }
      }
    },
    verifyFilled(submission, reads) {
      const authority = issued.get(submission as object)
      if (!authority || authority.used) return { state: store.markManualReview(submission.runId), error: 'The host submission authority is missing, cloned, or already consumed.' }
      authority.used = true
      let run: PolicyRunState
      try {
        run = store.getRun(authority.runId)
        if (run.runId !== submission.runId || run.activePlanId !== authority.plan.planId || run.status !== 'SUBMITTING') throw new Error('The run is no longer authorized to verify this submission.')
        if (submission.payloadHash !== payloadHash(buildSpotOrderArguments(authority.order)).hash) throw new Error('The submission payload was changed.')
        rejectCallerAuthority(reads, true)
        const receipt = parseOrderResponse(reads.order, authority.order.clientOrderId)
        const identityError = validateOrderResponseIdentity(receipt, authority.order)
        if (identityError || !receipt.orderId) {
          store.claimSubmission(authority.runId, authority.plan.planId, authority.plan.payloadHash)
          store.beginVerification(authority.runId, authority.plan.planId)
          return { state: store.markManualReview(authority.runId), receipt: { ...receipt, status: 'UNKNOWN', error: identityError ?? 'A correlated Binance order ID is required for verification.' }, error: identityError ?? 'A correlated Binance order ID is required for verification.' }
        }
        const afterPlanning = readPlanningState(run.originalPolicy, authority.order.quoteAsset, reads, true)
        const verification = verifyExecutedOrder(authority.order, receipt, authority.beforeAssets, afterPlanning.portfolio.assets, run.originalPolicy)
        store.claimSubmission(authority.runId, authority.plan.planId, authority.plan.payloadHash)
        store.beginVerification(authority.runId, authority.plan.planId)
        if (!verification.tradeVerified) return { state: store.markManualReview(authority.runId), receipt, verification, error: verification.reason }
        const state = store.recordVerification(authority.runId, authority.plan.planId, {
          violationScoreBefore: calculateViolationScore(authority.beforeAssets, run.originalPolicy),
          violationScoreAfter: calculateViolationScore(afterPlanning.portfolio.assets, run.originalPolicy),
          complete: verification.policySatisfied,
        })
        if (state.status !== 'COMPLETE' || store.getRun(authority.runId).tradeCount > fundedDemoWriteLimit) {
          return { state: store.markManualReview(authority.runId), receipt, verification, error: 'The funded demo permits one verified write and stops before any continuation.' }
        }
        return { state, receipt, verification }
      } catch (error) {
        try {
          run = store.getRun(authority.runId)
          if (run.status === 'SUBMITTING') store.claimSubmission(authority.runId, authority.plan.planId, authority.plan.payloadHash)
          if (store.getRun(authority.runId).status === 'SUBMITTING') store.markManualReview(authority.runId)
          return { state: store.getRun(authority.runId), error: safeError(error) }
        } catch {
          return { state: store.markManualReview(authority.runId), error: safeError(error) }
        }
      }
    },
    getRun: (runId) => store.getRun(runId),
    getActivePlan: (runId) => store.getActivePlan(runId),
  }
  return session
}

/**
 * The older createRokaiExecutionSession(...) path remains a standalone HTTP
 * OAuth compatibility adapter. It is not used by the Codex hackathon demo.
 */
export const standaloneRokaiExecutionNote = 'Standalone browser OAuth is separate from the supported-host session.'
