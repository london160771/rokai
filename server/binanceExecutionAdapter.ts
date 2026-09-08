import {
  assertOrderSafeToSubmit,
  buildSpotOrderArguments,
  buildExecutableOrder,
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
import { calculateViolationScore, planNextTrade } from '../src/nextTradePlanner.js'
import type { Asset } from '../src/mockData.js'
import {
  createRokaiAgentOsMcpConnection,
  normalizeLivePortfolio,
  normalizeSpotBalances,
  normalizeSpotPrices,
  type BinanceAgentOsHttpContext,
  type LivePortfolio,
  type McpToolExecutor,
} from './binanceAgentOsApi.js'
import { payloadHash, PolicyRunStore, type ActivePlan, type PolicyRunState } from './policyRunState.js'
import type { Policy } from '../src/rules.js'

export const supportedBinanceExecutionTools = [
  'spot.exchangeInfo',
  'spot.getAccount',
  'spot.tickerPrice',
  'spot.newOrder',
  'spot.getOrder',
] as const

export type SupportedBinanceExecutionTool = typeof supportedBinanceExecutionTools[number]

type BinanceExecutionAdapter = {
  readonly liveExecutionEnabled: boolean
  exchangeInfo: (symbol: string) => Promise<unknown>
  getAccount: () => Promise<unknown>
  tickerPrice: (symbols: string[]) => Promise<unknown>
  getOrder: (args: Record<string, unknown>) => Promise<unknown>
}

export type ExecutionReadSnapshot = {
  account: unknown
  portfolio: LivePortfolio
  market: ExchangeSymbolInfo
  currentPrice: { symbol: string; price: number; timestamp: string }
  exchangeInfoTimestamp: number
}

export type RokaiRunStartResult = {
  state: PolicyRunState
  plan?: ActivePlan | null
  portfolio?: LivePortfolio
  empty?: boolean
  error?: string
}

export type ApprovedRunExecutionResult = {
  state: PolicyRunState
  receipt?: ExecutionReceipt
  verification?: PostTradeVerification
  nextPlan?: ActivePlan | null
  error?: string
  beforeAssets?: Asset[]
  afterAssets?: Asset[]
}

export type RokaiExecutionSession = {
  startRun: (policy: Policy, settlementAsset: string) => Promise<RokaiRunStartResult>
  approveAndExecute: (runId: string, approvalText: string) => Promise<ApprovedRunExecutionResult>
  getRun: (runId: string) => PolicyRunState
  getActivePlan: (runId: string) => ActivePlan | null
  close: () => Promise<void>
}

const toolSet = new Set<string>(supportedBinanceExecutionTools)
const stablecoinSymbols = new Set(['USDC', 'USDT', 'BUSD', 'FDUSD', 'DAI', 'USDE'])
const adapterExecutors = new WeakMap<BinanceExecutionAdapter, McpToolExecutor>()

function nowMilliseconds() {
  const result = Date.now()
  if (!Number.isFinite(result)) throw new Error('Execution time is invalid.')
  return result
}

function normalizeAsset(value: string, label: string) {
  const asset = value.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]{1,11}$/.test(asset)) throw new Error(`${label} is malformed.`)
  return asset
}

export function isRokaiLiveExecutionEnabled() {
  return process.env.ROKAI_LIVE_EXECUTION?.trim().toLowerCase() === 'true'
}

function createAdapterFromSanctionedExecutor(source: McpToolExecutor): BinanceExecutionAdapter {
  const invoke: McpToolExecutor = async (toolName, args) => {
    if (!toolSet.has(toolName)) throw new Error('Rokai does not permit this Binance tool.')
    if (toolName === 'spot.newOrder' && !isRokaiLiveExecutionEnabled()) throw new Error('Rokai live execution is disabled. No order was sent.')
    return source(toolName, args)
  }
  const adapter: BinanceExecutionAdapter = {
    get liveExecutionEnabled() { return isRokaiLiveExecutionEnabled() },
    exchangeInfo: (symbol) => invoke('spot.exchangeInfo', { symbol }),
    getAccount: () => invoke('spot.getAccount', { omitZeroBalances: true }),
    tickerPrice: (symbols) => invoke('spot.tickerPrice', { symbols: JSON.stringify(symbols) }),
    getOrder: (args) => invoke('spot.getOrder', args),
  }
  adapterExecutors.set(adapter, invoke)
  return adapter
}

function internalExecutor(adapter: BinanceExecutionAdapter) {
  const executor = adapterExecutors.get(adapter)
  if (!executor) throw new Error('The Binance execution adapter is not trusted by Rokai.')
  return executor
}

function pairSymbolForAction(action: { source: string; target: string }, settlementAsset: string) {
  const source = normalizeAsset(action.source, 'Source asset')
  const target = normalizeAsset(action.target, 'Target asset')
  const settlement = normalizeAsset(settlementAsset, 'Settlement asset')
  if (source === target || (source !== settlement && target !== settlement)) throw new Error('Only a direct pair aligned to the named settlement asset is supported.')
  if (target === settlement) return `${source}${settlement}`
  if (source === settlement) return `${target}${settlement}`
  throw new Error('The action is not aligned to the named settlement asset.')
}

type PlanningSnapshot = {
  account: unknown
  portfolio: LivePortfolio
  referencePricesUsd: Record<string, number>
}

async function readFreshPlanningSnapshot(adapter: BinanceExecutionAdapter, policy: Policy, settlementAsset: string): Promise<PlanningSnapshot> {
  const settlement = normalizeAsset(settlementAsset, 'Settlement asset')
  const account = await adapter.getAccount()
  validateSpotAccountForExecution(account)
  const balances = normalizeSpotBalances(account)
  const asOf = nowMilliseconds()
  if (!balances.length) return { account, portfolio: { assets: [], source: 'binance-agent-os', asOf: new Date(asOf).toISOString(), empty: true }, referencePricesUsd: {} }
  const balancePriceSymbols = balances.filter((balance) => !stablecoinSymbols.has(balance.symbol)).map((balance) => `${balance.symbol}USDT`)
  const missingMinimumTargets = policy.rules
    .filter((rule): rule is Extract<Policy['rules'][number], { kind: 'min_asset_allocation' }> => rule.kind === 'min_asset_allocation')
    .map((rule) => rule.asset)
    .filter((asset) => !balances.some((balance) => balance.symbol === asset) && !stablecoinSymbols.has(asset))
    .map((asset) => `${asset}${settlement}`)
  const symbols = [...new Set([...balancePriceSymbols, ...missingMinimumTargets])]
  const pricePayload = symbols.length ? await adapter.tickerPrice(symbols) : { prices: [] }
  const prices = normalizeSpotPrices(pricePayload)
  const portfolio = normalizeLivePortfolio(account, pricePayload, new Date(nowMilliseconds()).toISOString())
  const referencePricesUsd: Record<string, number> = {}
  for (const targetSymbol of missingMinimumTargets) {
    const asset = targetSymbol.slice(0, -settlement.length)
    const value = prices.get(targetSymbol) ?? prices.get(`${asset}USDT`)
    if (value !== undefined) referencePricesUsd[asset] = value
  }
  return { account, portfolio, referencePricesUsd }
}

async function readFreshExecutionSnapshot(adapter: BinanceExecutionAdapter, symbol: string): Promise<ExecutionReadSnapshot> {
  const exchangePayload = await adapter.exchangeInfo(symbol)
  const market = normalizeExchangeSymbolInfo(exchangePayload, symbol)
  const exchangeInfoTimestamp = nowMilliseconds()
  const account = await adapter.getAccount()
  validateSpotAccountForExecution(account, market)
  const balances = normalizeSpotBalances(account)
  if (!balances.length) throw new Error('The Agentic Spot account has no non-zero balances.')
  const valuationSymbols = balances.filter((balance) => !stablecoinSymbols.has(balance.symbol)).map((balance) => `${balance.symbol}USDT`)
  const symbols = [...new Set([...valuationSymbols, market.symbol])]
  const pricePayload = symbols.length ? await adapter.tickerPrice(symbols) : { prices: [] }
  const portfolio = normalizeLivePortfolio(account, pricePayload, new Date(nowMilliseconds()).toISOString())
  const prices = normalizeSpotPrices(pricePayload)
  const pairPrice = prices.get(market.symbol)
  if (pairPrice === undefined) throw new Error(`No fresh price was returned for ${market.symbol}.`)
  return {
    account,
    portfolio,
    market,
    currentPrice: { symbol: market.symbol, price: pairPrice, timestamp: new Date(nowMilliseconds()).toISOString() },
    exchangeInfoTimestamp,
  }
}

export function executionSnapshotHash(snapshot: Pick<ExecutionReadSnapshot, 'portfolio' | 'market'>) {
  return payloadHash({
    assets: snapshot.portfolio.assets.map((asset) => ({ symbol: asset.symbol, quantity: asset.quantity, free: asset.free, locked: asset.locked })),
    market: snapshot.market,
  }).hash
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : 'The Binance execution path stopped safely because required data was unavailable or unclear.'
}

function stateAfterFailure(store: PolicyRunStore, runId: string) {
  const current = store.getRun(runId)
  if (current.status === 'SUBMITTING' || current.status === 'VERIFYING') return store.markManualReview(runId)
  return current
}

async function createFreshPlan(adapter: BinanceExecutionAdapter, store: PolicyRunStore, runId: string, settlementAsset: string) {
  const run = store.getRun(runId)
  const planning = await readFreshPlanningSnapshot(adapter, run.originalPolicy, settlementAsset)
  if (planning.portfolio.empty) return { empty: true as const, snapshot: planning, plan: null, decision: null }
  const decision = planNextTrade(planning.portfolio.assets, run.originalPolicy, { runId, settlementAsset, referencePricesUsd: planning.referencePricesUsd })
  const protectedAssets = run.originalPolicy.rules.filter((rule) => rule.kind === 'protected_asset').map((rule) => rule.asset)
  if (decision.status !== 'READY') {
    const plan = store.createPlan(runId, { decision, snapshotHash: payloadHash(planning.portfolio.assets).hash, protectedAssets })
    return { empty: false as const, snapshot: planning, plan, decision }
  }
  const symbol = pairSymbolForAction(decision.nextTrade, settlementAsset)
  const exchangePayload = await adapter.exchangeInfo(symbol)
  const market = normalizeExchangeSymbolInfo(exchangePayload, symbol)
  const exchangeInfoTimestamp = nowMilliseconds()
  const pricePayload = await adapter.tickerPrice([market.symbol])
  const prices = normalizeSpotPrices(pricePayload)
  const price = prices.get(market.symbol)
  if (price === undefined) throw new Error(`No fresh price was returned for ${market.symbol}.`)
  const snapshot: ExecutionReadSnapshot = {
    account: planning.account,
    portfolio: planning.portfolio,
    market,
    currentPrice: { symbol: market.symbol, price, timestamp: new Date(nowMilliseconds()).toISOString() },
    exchangeInfoTimestamp,
  }
  const step = store.getRun(runId).currentStep + 1
  const protectedSet = run.originalPolicy.rules.filter((rule) => rule.kind === 'protected_asset').map((rule) => rule.asset)
  let order: ExecutableOrder | undefined
  const plan = store.replan(runId, {
    decision,
    snapshotHash: executionSnapshotHash(snapshot),
    protectedAssets: protectedSet,
    executableIntentFactory: (planId) => {
      order = buildExecutableOrder(decision.nextTrade, snapshot.portfolio.assets, [snapshot.market], snapshot.currentPrice, protectedSet, {
        settlementAsset,
        planId,
        runId,
        step,
      })
      return order
    },
  })
  if (!plan || !order) throw new Error('The executable plan could not be constructed safely.')
  return { empty: false as const, snapshot: planning, plan, order, decision }
}

function storedOrder(plan: ActivePlan, runId: string, currentStep: number): ExecutableOrder {
  let order: unknown
  try { order = JSON.parse(plan.serializedExecutableIntent) as unknown } catch { throw new Error('The stored executable intent is malformed.') }
  if (!order || typeof order !== 'object' || Array.isArray(order)) throw new Error('The stored executable intent is malformed.')
  const value = order as ExecutableOrder
  if (value.runId !== runId || value.planId !== plan.planId || value.step !== currentStep || payloadHash(value).hash !== plan.payloadHash || payloadHash(value).serialized !== plan.serializedExecutableIntent) throw new Error('The stored executable intent no longer matches the active plan.')
  return value
}

function trustedBinding(store: PolicyRunStore, runId: string) {
  const run = store.getRun(runId)
  const plan = store.getActivePlan(runId)
  if (run.status !== 'SUBMITTING' || !plan || plan.status !== 'SUBMITTING' || run.activePlanId !== plan.planId) throw new Error('The run is not authorized to submit an order.')
  const order = storedOrder(plan, runId, run.currentStep)
  const binding = { planId: plan.planId, serializedPayload: plan.serializedExecutableIntent, expiresAt: new Date(plan.expiresAt).toISOString(), approved: true, consumed: false }
  return { run, plan, order, binding }
}

function knownSubmissionError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (/insufficient|not enough balance/i.test(message)) return 'Binance rejected the order because available funds were insufficient.'
  if (/permission|not authorized|unauthorized/i.test(message)) return 'Binance rejected the order because Spot permission was unavailable.'
  return 'The order result is unknown. Do not retry automatically.'
}

async function submitTrustedOrder(adapter: BinanceExecutionAdapter, store: PolicyRunStore, runId: string, order: ExecutableOrder): Promise<ExecutionReceipt> {
  const plan = store.getActivePlan(runId)
  if (!plan) throw new Error('The active plan is no longer available.')
  store.claimSubmission(runId, plan.planId, payloadHash(order).hash)
  const executor = internalExecutor(adapter)
  let initial: ExecutionReceipt
  try {
    initial = parseOrderResponse(await executor('spot.newOrder', buildSpotOrderArguments(order)), order.clientOrderId)
  } catch (error) {
    try {
      const resolved = parseOrderResponse(await executor('spot.getOrder', { symbol: order.symbol, origClientOrderId: order.clientOrderId }), order.clientOrderId)
      const identityError = validateOrderResponseIdentity(resolved, order)
      if (!identityError && resolved.status === 'FILLED') return resolved
      store.markManualReview(runId)
      return { ...resolved, status: identityError ? 'UNKNOWN' : resolved.status, error: identityError ?? resolved.error ?? knownSubmissionError(error) }
    } catch {
      store.markManualReview(runId)
      return { status: 'UNKNOWN', clientOrderId: order.clientOrderId, error: knownSubmissionError(error) }
    }
  }
  const initialIdentityError = validateOrderResponseIdentity(initial, order)
  if (initialIdentityError || initial.status === 'UNKNOWN' || initial.status === 'REJECTED') {
    store.markManualReview(runId)
    return { ...initial, status: initial.status === 'REJECTED' ? 'REJECTED' : 'UNKNOWN', error: initialIdentityError ?? initial.error ?? 'The order submission was not confirmed.' }
  }
  if (!initial.orderId && !initial.clientOrderId) {
    store.markManualReview(runId)
    return { ...initial, status: 'UNKNOWN', error: 'The order response could not be correlated for read-only status lookup.' }
  }
  try {
    const statusArgs = { symbol: order.symbol, ...(initial.orderId ? { orderId: initial.orderId } : { origClientOrderId: order.clientOrderId }) }
    const refreshed = parseOrderResponse(await executor('spot.getOrder', statusArgs), order.clientOrderId, initial.orderId)
    const receipt = {
      ...initial,
      ...refreshed,
      clientOrderId: refreshed.clientOrderId ?? initial.clientOrderId,
      orderId: refreshed.orderId ?? initial.orderId,
      commissions: refreshed.commissions ?? initial.commissions,
    }
    const identityError = validateOrderResponseIdentity(receipt, order)
    if (identityError || receipt.status !== 'FILLED') {
      store.markManualReview(runId)
      return { ...receipt, status: identityError ? 'UNKNOWN' : receipt.status, error: identityError ?? `Order status is ${receipt.status}; only FILLED is successful.` }
    }
    return receipt
  } catch {
    store.markManualReview(runId)
    return { ...initial, status: 'UNKNOWN', error: 'The order status is unknown. Do not retry automatically.' }
  }
}

async function executeActivePlan(adapter: BinanceExecutionAdapter, store: PolicyRunStore, runId: string, settlementAsset: string): Promise<ApprovedRunExecutionResult> {
  if (!isRokaiLiveExecutionEnabled()) return { state: store.markManualReview(runId), error: 'Rokai live execution is disabled. No order was sent.' }
  let bound: ReturnType<typeof trustedBinding>
  try { bound = trustedBinding(store, runId) } catch (error) { return { state: stateAfterFailure(store, runId), error: safeError(error) } }
  let beforeSnapshot: ExecutionReadSnapshot
  try {
    beforeSnapshot = await readFreshExecutionSnapshot(adapter, bound.order.symbol)
    if (executionSnapshotHash(beforeSnapshot) !== bound.plan.snapshotHash) {
      store.noteAccountRefresh(runId)
      return { state: store.getRun(runId), error: 'Fresh account state changed. The approved plan was invalidated and must be replanned.' }
    }
    assertOrderSafeToSubmit(bound.order, bound.binding, { assets: beforeSnapshot.portfolio.assets, account: beforeSnapshot.account, market: beforeSnapshot.market, currentPrice: beforeSnapshot.currentPrice, exchangeInfoTimestamp: beforeSnapshot.exchangeInfoTimestamp, policy: bound.run.originalPolicy, protectedAssets: bound.plan.protectedAssets })
  } catch (error) {
    return { state: stateAfterFailure(store, runId), error: safeError(error) }
  }
  let receipt: ExecutionReceipt
  try { receipt = await submitTrustedOrder(adapter, store, runId, bound.order) } catch (error) { return { state: stateAfterFailure(store, runId), error: safeError(error) } }
  if (receipt.status !== 'FILLED') return { state: store.getRun(runId), receipt, beforeAssets: beforeSnapshot.portfolio.assets, error: receipt.error }
  let afterSnapshot: ExecutionReadSnapshot
  try { afterSnapshot = await readFreshExecutionSnapshot(adapter, bound.order.symbol) } catch (error) { return { state: stateAfterFailure(store, runId), receipt, beforeAssets: beforeSnapshot.portfolio.assets, error: safeError(error) } }
  const run = store.getRun(runId)
  const verification = verifyExecutedOrder(bound.order, receipt, beforeSnapshot.portfolio.assets, afterSnapshot.portfolio.assets, run.originalPolicy)
  try {
    store.beginVerification(runId, bound.plan.planId)
    if (!verification.tradeVerified) return { state: store.markManualReview(runId), receipt, verification, beforeAssets: beforeSnapshot.portfolio.assets, afterAssets: afterSnapshot.portfolio.assets, error: verification.reason }
    const state = store.recordVerification(runId, bound.plan.planId, { violationScoreBefore: calculateViolationScore(beforeSnapshot.portfolio.assets, run.originalPolicy), violationScoreAfter: calculateViolationScore(afterSnapshot.portfolio.assets, run.originalPolicy), complete: verification.policySatisfied })
    if (state.status !== 'READING') return { state, receipt, verification, beforeAssets: beforeSnapshot.portfolio.assets, afterAssets: afterSnapshot.portfolio.assets, error: verification.policySatisfied ? undefined : 'The run requires manual review.' }
    const next = await createFreshPlan(adapter, store, runId, settlementAsset)
    return { state: store.getRun(runId), receipt, verification, nextPlan: next.plan, beforeAssets: beforeSnapshot.portfolio.assets, afterAssets: afterSnapshot.portfolio.assets }
  } catch (error) {
    return { state: stateAfterFailure(store, runId), receipt, verification, beforeAssets: beforeSnapshot.portfolio.assets, afterAssets: afterSnapshot.portfolio.assets, error: safeError(error) }
  }
}

function createSession(adapter: BinanceExecutionAdapter, close: () => Promise<void>): RokaiExecutionSession {
  const store = new PolicyRunStore()
  const runSettlements = new Map<string, string>()
  return {
    async startRun(policy, settlementAsset) {
      const run = store.createRun(policy)
      runSettlements.set(run.runId, normalizeAsset(settlementAsset, 'Settlement asset'))
      try {
        const fresh = await createFreshPlan(adapter, store, run.runId, settlementAsset)
        return { state: store.getRun(run.runId), plan: fresh.plan, portfolio: fresh.snapshot.portfolio, empty: fresh.empty }
      } catch (error) {
        return { state: store.markManualReview(run.runId), error: safeError(error) }
      }
    },
    async approveAndExecute(runId, approvalText) {
      const settlementAsset = runSettlements.get(runId)
      if (!settlementAsset) throw new Error('The Rokai policy run does not exist in this session.')
      store.approve(runId, approvalText)
      return executeActivePlan(adapter, store, runId, settlementAsset)
    },
    getRun: (runId) => store.getRun(runId),
    getActivePlan: (runId) => store.getActivePlan(runId),
    close,
  }
}

/** Standalone HTTP/OAuth compatibility entry point; the hackathon demo uses the host-mediated session instead. */
export async function createRokaiExecutionSession(options: BinanceAgentOsHttpContext): Promise<RokaiExecutionSession> {
  const connection = await createRokaiAgentOsMcpConnection(options)
  return createSession(createAdapterFromSanctionedExecutor(connection.executor), connection.close)
}

/** Test-only factory for the legacy adapter. The supported-host path does not accept an injected executor. */
export function createMockRokaiExecutionSessionForTests(source: McpToolExecutor): RokaiExecutionSession {
  return createSession(createAdapterFromSanctionedExecutor(source), async () => undefined)
}
