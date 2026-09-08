import { randomUUID } from 'node:crypto'
import type { Asset } from './mockData.js'
import { calculateViolationScore } from './nextTradePlanner.js'
import { evaluateRules, type PlanAction, type Policy, type RuleResult, valuePortfolio } from './rules.js'

export type SpotSide = 'BUY' | 'SELL'
export type SpotOrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | 'UNKNOWN'

export type PriceSnapshot = {
  symbol: string
  price: number
  timestamp: string
}

export type ExchangeFilter = {
  filterType: string
  minQty?: number
  maxQty?: number
  stepSize?: number
  minNotional?: number
  maxNotional?: number
  applyToMarket?: boolean
  applyMinToMarket?: boolean
  applyMaxToMarket?: boolean
}

export type ExchangeSymbolInfo = {
  symbol: string
  baseAsset: string
  quoteAsset: string
  status?: string
  isSpotTradingAllowed?: boolean
  permissions?: string[]
  permissionSets?: string[][]
  filters?: ExchangeFilter[]
  baseAssetPrecision?: number
  quoteAssetPrecision?: number
  quoteOrderQtyMarketAllowed?: boolean
}

export type ExecutableOrder = {
  runId?: string
  planId: string
  step?: number
  clientOrderId: string
  symbol: string
  baseAsset: string
  quoteAsset: string
  side: SpotSide
  type: 'MARKET'
  quantity?: number
  quoteOrderQty?: number
  sourceAsset: string
  targetAsset: string
  expectedSourceDebit: number
  expectedTargetCredit: number
  priceSnapshot: number
  priceTimestamp: string
  expiresAt: string
}

export type ApprovalBinding = {
  planId: string
  serializedPayload: string
  expiresAt: string
  approved: boolean
  consumed: boolean
  approvedAt?: string
}

export type ExecutionReceipt = {
  status: SpotOrderStatus
  orderId?: string
  clientOrderId?: string
  symbol?: string
  side?: SpotSide
  type?: 'MARKET'
  quantityMode?: 'quantity' | 'quoteOrderQty'
  origQty?: number
  origQuoteOrderQty?: number
  executedQty?: number
  cumulativeQuoteQty?: number
  commissions?: Array<{ asset: string; amount: number }>
  error?: string
}

export type PostTradeVerification = {
  verified: boolean
  tradeVerified: boolean
  policySatisfied: boolean
  status: SpotOrderStatus
  before: ReturnType<typeof valuePortfolio>
  after: ReturnType<typeof valuePortfolio>
  results: RuleResult[]
  executedQty?: number
  cumulativeQuoteQty?: number
  actualAverageFillPrice?: number
  actualPriceDeviationBps?: number
  reason?: string
}

export type ExecutionSafetyOptions = {
  settlementAsset?: string
  planId?: string
  runId?: string
  step?: number
}

export type SubmissionContext = {
  assets: Asset[]
  protectedAssets?: string[]
  currentPrice: PriceSnapshot
  account?: unknown
  policy?: Policy
  market?: ExchangeSymbolInfo
  exchangeInfoTimestamp?: Date | number | string
}

export type SpotMcpExecutor = (toolName: string, args: Record<string, unknown>) => Promise<unknown>

export const ROKAI_APPROVAL_TTL_MS = 5 * 60_000

const executionSafetyConfig = Object.freeze({
  approvalTtlMs: ROKAI_APPROVAL_TTL_MS,
  maxPriceAgeMs: 15_000,
  maxPriceDeviationBps: 50,
  feeRate: 0.001,
  slippageBps: 10,
})
const supportedStatuses = new Set<SpotOrderStatus>(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'])
const supportedSettlementAssets = new Set(['USDC', 'USDT', 'BUSD', 'FDUSD', 'DAI', 'USDE'])

if (!Number.isFinite(executionSafetyConfig.approvalTtlMs) || executionSafetyConfig.approvalTtlMs <= 0
  || !Number.isFinite(executionSafetyConfig.maxPriceAgeMs) || executionSafetyConfig.maxPriceAgeMs <= 0
  || !Number.isFinite(executionSafetyConfig.maxPriceDeviationBps) || executionSafetyConfig.maxPriceDeviationBps < 0
  || !Number.isFinite(executionSafetyConfig.feeRate) || executionSafetyConfig.feeRate < 0 || executionSafetyConfig.feeRate >= 1
  || !Number.isFinite(executionSafetyConfig.slippageBps) || executionSafetyConfig.slippageBps < 0 || executionSafetyConfig.slippageBps >= 10_000) {
  throw new Error('Rokai execution safety configuration is invalid.')
}

export class ExecutionSafetyError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ExecutionSafetyError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numeric(value: unknown, label: string, allowZero = true) {
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(result) || result < 0 || (!allowZero && result === 0)) {
    throw new ExecutionSafetyError('INVALID_INPUT', `${label} must be a finite positive number.`)
  }
  return result
}

function optionalNumeric(value: unknown, label: string) {
  if (value === undefined || value === null) return undefined
  return numeric(value, label)
}

function nowMilliseconds() {
  const result = Date.now()
  if (!Number.isFinite(result)) throw new ExecutionSafetyError('INVALID_TIME', 'Execution time is invalid.')
  return result
}

function timestampMilliseconds(value: string, label: string) {
  const result = Date.parse(value)
  if (!Number.isFinite(result)) throw new ExecutionSafetyError('INVALID_TIMESTAMP', `${label} is invalid.`)
  return result
}

function timestampValue(value: Date | number | string, label: string) {
  if (value instanceof Date) return timestampMilliseconds(value.toISOString(), label)
  if (typeof value === 'string') return timestampMilliseconds(value, label)
  if (!Number.isFinite(value)) throw new ExecutionSafetyError('INVALID_TIMESTAMP', `${label} is invalid.`)
  return value
}

function normalizeSymbol(value: string, label: string) {
  const symbol = value.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]{1,11}$/.test(symbol)) throw new ExecutionSafetyError('INVALID_SYMBOL', `${label} is malformed.`)
  return symbol
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function serializeExecutableOrder(order: ExecutableOrder) {
  return canonicalize(order)
}

function decimalParts(value: number): { integer: bigint; scale: number } {
  const text = value.toString().toLowerCase()
  const [coefficient, exponentText] = text.split('e')
  const exponent = exponentText ? Number(exponentText) : 0
  const [whole, fraction = ''] = coefficient.split('.')
  const digits = `${whole.replace('-', '')}${fraction}`.replace(/^0+(?=\d)/, '') || '0'
  const scale = Math.max(0, fraction.length - exponent)
  const integer = BigInt(digits) * (exponent > fraction.length ? 10n ** BigInt(exponent - fraction.length) : 1n)
  return { integer: coefficient.startsWith('-') ? -integer : integer, scale }
}

function quantizeDown(value: number, stepSize?: number, precision?: number) {
  const valueParts = decimalParts(value)
  const stepParts = stepSize !== undefined ? decimalParts(stepSize) : undefined
  const scale = Math.max(valueParts.scale, stepParts?.scale ?? 0, precision ?? 0)
  const scaleFactor = (sourceScale: number) => 10n ** BigInt(scale - sourceScale)
  const valueInteger = valueParts.integer * scaleFactor(valueParts.scale)
  const stepInteger = stepParts ? stepParts.integer * scaleFactor(stepParts.scale) : 10n ** BigInt(scale - (precision ?? scale))
  if (stepInteger <= 0n) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'The exchange step size is invalid.')
  let quantized = (valueInteger / stepInteger) * stepInteger
  if (precision !== undefined) {
    const precisionFactor = 10n ** BigInt(scale - precision)
    quantized = (quantized / precisionFactor) * precisionFactor
  }
  return Number(quantized) / (10 ** scale)
}

function unwrapMcpPayload(payload: unknown): unknown {
  if (isRecord(payload) && Array.isArray(payload.content)) {
    const text = payload.content.find((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
    if (isRecord(text) && typeof text.text === 'string') {
      try { return JSON.parse(text.text) as unknown } catch { return text.text }
    }
  }
  if (isRecord(payload) && 'structuredContent' in payload) return payload.structuredContent
  if (isRecord(payload) && 'result' in payload) return unwrapMcpPayload(payload.result)
  return payload
}

function parseFilter(value: unknown): ExchangeFilter {
  if (!isRecord(value) || typeof value.filterType !== 'string') throw new ExecutionSafetyError('INVALID_EXCHANGE_INFO', 'Binance returned a malformed exchange filter.')
  const filter: ExchangeFilter = { filterType: value.filterType.toUpperCase() }
  for (const key of ['minQty', 'maxQty', 'stepSize', 'minNotional', 'maxNotional'] as const) {
    const parsed = optionalNumeric(value[key], `${value.filterType}.${key}`)
    if (parsed !== undefined) filter[key] = parsed
  }
  for (const key of ['applyToMarket', 'applyMinToMarket', 'applyMaxToMarket'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new ExecutionSafetyError('INVALID_EXCHANGE_INFO', `${value.filterType}.${key} is invalid.`)
      filter[key] = value[key]
    }
  }
  return filter
}

function isRecognizedTradingGroup(permission: string) {
  const match = /^TRD_GRP_(\d{3})$/.exec(permission)
  if (!match) return false
  const group = Number(match[1])
  return (group >= 2 && group <= 25) || (group >= 49 && group <= 258)
}

function normalizePermissions(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((permission) => typeof permission !== 'string')) {
    throw new ExecutionSafetyError('INVALID_ACCOUNT', `${label} are malformed or missing.`)
  }
  return [...new Set((value as string[]).map((permission) => permission.toUpperCase()))]
}

function marketHasSpotPermission(market: ExchangeSymbolInfo, accountPermissions?: string[]) {
  const marketPermissions = new Set((market.permissions ?? []).map((permission) => permission.toUpperCase()))
  if (accountPermissions === undefined) {
    if (marketPermissions.has('SPOT')) return true
    const permissionSets = market.permissionSets ?? []
    return permissionSets.length > 0 && permissionSets.every((permissionSet) => permissionSet.includes('SPOT'))
  }
  const account = new Set(accountPermissions.map((permission) => permission.toUpperCase()))
  if (marketPermissions.has('SPOT') && account.has('SPOT')) return true
  const permissionSets = market.permissionSets ?? []
  return permissionSets.length > 0 && permissionSets.every((permissionSet) => permissionSet.some((permission) => account.has(permission)))
}

export function normalizeExchangeSymbolInfo(payload: unknown, requestedSymbol?: string): ExchangeSymbolInfo {
  const value = unwrapMcpPayload(payload)
  const symbols = isRecord(value) && Array.isArray(value.symbols) ? value.symbols : Array.isArray(value) ? value : [value]
  const requested = requestedSymbol ? normalizeSymbol(requestedSymbol, 'Requested symbol') : undefined
  const matches = symbols.filter((entry) => isRecord(entry) && typeof entry.symbol === 'string' && (!requested || entry.symbol.toUpperCase() === requested))
  if (matches.length !== 1) throw new ExecutionSafetyError(matches.length ? 'AMBIGUOUS_MARKET' : 'MARKET_NOT_FOUND', matches.length ? 'More than one exchange market matched the asset pair.' : 'The requested Spot market does not exist.')
  const entry = matches[0]
  if (typeof entry.baseAsset !== 'string' || typeof entry.quoteAsset !== 'string') throw new ExecutionSafetyError('INVALID_EXCHANGE_INFO', 'Binance returned an exchange market without base and quote assets.')
  const result: ExchangeSymbolInfo = {
    symbol: normalizeSymbol(entry.symbol as string, 'Exchange symbol'),
    baseAsset: normalizeSymbol(entry.baseAsset, 'Base asset'),
    quoteAsset: normalizeSymbol(entry.quoteAsset, 'Quote asset'),
  }
  if (entry.status !== undefined) {
    if (typeof entry.status !== 'string') throw new ExecutionSafetyError('INVALID_EXCHANGE_INFO', 'Exchange market status is invalid.')
    result.status = entry.status.toUpperCase()
  }
  for (const key of ['isSpotTradingAllowed', 'quoteOrderQtyMarketAllowed'] as const) {
    if (entry[key] !== undefined) {
      if (typeof entry[key] !== 'boolean') throw new ExecutionSafetyError('INVALID_EXCHANGE_INFO', `${key} is invalid.`)
      result[key] = entry[key]
    }
  }
  if (entry.permissions !== undefined) {
    const permissions = entry.permissions
    if (!Array.isArray(permissions) || permissions.some((permission: unknown) => typeof permission !== 'string')) throw new ExecutionSafetyError('INVALID_EXCHANGE_INFO', 'Exchange market permissions are invalid.')
    result.permissions = (permissions as string[]).map((permission) => permission.toUpperCase())
  }
  if (entry.permissionSets !== undefined) {
    if (!Array.isArray(entry.permissionSets) || entry.permissionSets.length === 0 || entry.permissionSets.some((permissionSet: unknown) => !Array.isArray(permissionSet) || permissionSet.length === 0 || permissionSet.some((permission: unknown) => typeof permission !== 'string'))) {
      throw new ExecutionSafetyError('INVALID_EXCHANGE_INFO', 'Exchange market permission sets are invalid.')
    }
    result.permissionSets = (entry.permissionSets as unknown[][]).map((permissionSet) => (permissionSet as string[]).map((permission) => permission.toUpperCase()))
  }
  if (entry.filters !== undefined) {
    if (!Array.isArray(entry.filters)) throw new ExecutionSafetyError('INVALID_EXCHANGE_INFO', 'Exchange filters are invalid.')
    result.filters = entry.filters.map(parseFilter)
  }
  for (const key of ['baseAssetPrecision', 'quoteAssetPrecision'] as const) {
    const parsed = optionalNumeric(entry[key], key)
    if (parsed !== undefined) result[key] = Math.floor(parsed)
  }
  return result
}

export async function fetchExchangeSymbolInfo(executor: SpotMcpExecutor, symbol: string) {
  return normalizeExchangeSymbolInfo(await executor('spot.exchangeInfo', { symbol: normalizeSymbol(symbol, 'Requested symbol') }), symbol)
}

function resolveMarket(source: string, target: string, markets: ExchangeSymbolInfo[]) {
  const sourceSymbol = normalizeSymbol(source, 'Source asset')
  const targetSymbol = normalizeSymbol(target, 'Target asset')
  const matches = markets.filter((market) => {
    const base = normalizeSymbol(market.baseAsset, 'Base asset')
    const quote = normalizeSymbol(market.quoteAsset, 'Quote asset')
    return (base === sourceSymbol && quote === targetSymbol) || (base === targetSymbol && quote === sourceSymbol)
  })
  if (matches.length !== 1) throw new ExecutionSafetyError(matches.length ? 'AMBIGUOUS_MARKET' : 'MARKET_NOT_FOUND', matches.length ? 'More than one Spot market can route this asset pair.' : `No Spot market maps ${sourceSymbol} to ${targetSymbol}.`)
  return matches[0]
}

function validateMarket(market: ExchangeSymbolInfo, accountPermissions?: string[]) {
  if (market.status !== 'TRADING') throw new ExecutionSafetyError('MARKET_UNAVAILABLE', `Spot market ${market.symbol} is not trading.`)
  if (market.isSpotTradingAllowed !== true) throw new ExecutionSafetyError('MARKET_UNAVAILABLE', `Spot trading is not explicitly allowed for ${market.symbol}.`)
  if (!marketHasSpotPermission(market, accountPermissions)) throw new ExecutionSafetyError('MARKET_UNAVAILABLE', `${market.symbol} does not expose verifiable Spot permission for this account.`)
}

function balanceFree(asset: Asset) {
  const quantity = numeric(asset.quantity, `${asset.symbol} balance`)
  const locked = asset.locked === undefined ? 0 : numeric(asset.locked, `${asset.symbol} locked balance`)
  const free = asset.free === undefined ? quantity - locked : numeric(asset.free, `${asset.symbol} free balance`)
  if (locked > quantity + 1e-12 || free + locked > quantity + 1e-12) throw new ExecutionSafetyError('INVALID_BALANCE', `${asset.symbol} free and locked balances exceed total balance.`)
  return free
}

export function getFreeBalance(asset: Asset) {
  return balanceFree(asset)
}

function findAsset(assets: Asset[], symbol: string) {
  return assets.find((asset) => asset.symbol.toUpperCase() === symbol.toUpperCase())
}

function marketConstraints(market: ExchangeSymbolInfo) {
  const filters = market.filters ?? []
  const isUsableLotFilter = (filter: ExchangeFilter | undefined) => Boolean(filter
    && filter.minQty !== undefined && filter.maxQty !== undefined && filter.stepSize !== undefined
    && filter.minQty > 0 && filter.maxQty > 0 && filter.stepSize > 0)
  const marketLot = filters.find((filter) => filter.filterType === 'MARKET_LOT_SIZE')
  const lot = isUsableLotFilter(marketLot) ? marketLot : filters.find((filter) => filter.filterType === 'LOT_SIZE' && isUsableLotFilter(filter))
  const notionalFilters = filters.filter((filter) => filter.filterType === 'NOTIONAL' || filter.filterType === 'MIN_NOTIONAL')
  if (!lot || lot.minQty === undefined || lot.maxQty === undefined || lot.stepSize === undefined || lot.minQty <= 0 || lot.maxQty <= 0 || lot.stepSize <= 0) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'Required Spot quantity filters are missing or invalid.')
  const applicableNotionalFilters = notionalFilters.filter((filter) => filter.applyToMarket !== false && filter.applyMinToMarket !== false)
  if (!applicableNotionalFilters.length || applicableNotionalFilters.some((filter) => filter.minNotional === undefined)) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'Required Spot notional filters are missing or invalid.')
  const minNotional = Math.max(...applicableNotionalFilters.map((filter) => filter.minNotional ?? 0), 0)
  const maxNotionalValues = notionalFilters.filter((filter) => filter.applyToMarket !== false && filter.applyMaxToMarket !== false).map((filter) => filter.maxNotional).filter((value): value is number => value !== undefined)
  return {
    minQty: lot?.minQty,
    maxQty: lot?.maxQty,
    stepSize: lot?.stepSize,
    minNotional,
    maxNotional: maxNotionalValues.length ? Math.min(...maxNotionalValues) : undefined,
  }
}

function validateMarketForOrder(order: ExecutableOrder, market: ExchangeSymbolInfo, accountPermissions?: string[]) {
  validateMarket(market, accountPermissions)
  if (normalizeSymbol(market.symbol, 'Exchange symbol') !== order.symbol || normalizeSymbol(market.baseAsset, 'Base asset') !== order.baseAsset || normalizeSymbol(market.quoteAsset, 'Quote asset') !== order.quoteAsset) {
    throw new ExecutionSafetyError('MARKET_MISMATCH', 'Fresh exchange information does not match the approved order.')
  }
  const constraints = marketConstraints(market)
  if (order.side === 'BUY' && market.quoteOrderQtyMarketAllowed !== true) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'This Spot market does not explicitly allow quote-sized market orders.')
  return constraints
}

function validateOrderAmount(amount: number, free: number, label: string) {
  if (!Number.isFinite(amount) || amount <= 0) throw new ExecutionSafetyError('INVALID_ORDER', `${label} is not positive after exchange quantization.`)
  if (amount > free + 1e-12) throw new ExecutionSafetyError('INSUFFICIENT_FUNDS', `Available free ${label} is insufficient for the approved order.`)
}

export function buildExecutableOrder(
  action: PlanAction,
  assets: Asset[],
  markets: ExchangeSymbolInfo[],
  price: PriceSnapshot,
  protectedAssets: string[] = [],
  options: ExecutionSafetyOptions = {},
): ExecutableOrder {
  const nowMs = nowMilliseconds()
  const approvalTtlMs = executionSafetyConfig.approvalTtlMs
  const feeRate = executionSafetyConfig.feeRate
  const slippageBps = executionSafetyConfig.slippageBps
  const sourceAsset = normalizeSymbol(action.source, 'Source asset')
  const targetAsset = normalizeSymbol(action.target, 'Target asset')
  if (sourceAsset === targetAsset) throw new ExecutionSafetyError('INVALID_ORDER', 'Source and target assets must differ.')
  numeric(action.amountUsd, 'Planned value', false)
  const plannedSourceQuantity = numeric(action.sourceQuantity, 'Planned source quantity', false)
  const settlementAsset = normalizeSymbol(options.settlementAsset ?? '', 'Settlement asset')
  if (!supportedSettlementAssets.has(settlementAsset)) throw new ExecutionSafetyError('UNSUPPORTED_SCOPE', 'An explicitly named supported settlement stablecoin is required.')
  if ((sourceAsset !== settlementAsset && targetAsset !== settlementAsset) || (sourceAsset === settlementAsset && targetAsset === settlementAsset)) {
    throw new ExecutionSafetyError('UNSUPPORTED_SCOPE', 'Only a direct pair aligned to the named settlement stablecoin is supported.')
  }
  const source = findAsset(assets, sourceAsset)
  if (!source) throw new ExecutionSafetyError('MISSING_BALANCE', `No balance was read for ${sourceAsset}.`)
  if (!Number.isFinite(source.priceUsd) || source.priceUsd <= 0) throw new ExecutionSafetyError('MISSING_PRICE', `No valid USD price was read for ${sourceAsset}.`)
  const market = resolveMarket(sourceAsset, targetAsset, markets)
  validateMarket(market)
  const marketSymbol = normalizeSymbol(market.symbol, 'Market symbol')
  const marketQuoteAsset = normalizeSymbol(market.quoteAsset, 'Quote asset')
  if (marketQuoteAsset !== settlementAsset) throw new ExecutionSafetyError('UNSUPPORTED_SCOPE', 'The Spot market quote must be the explicitly named settlement stablecoin.')
  const priceSymbol = normalizeSymbol(price.symbol, 'Price symbol')
  if (priceSymbol !== marketSymbol) throw new ExecutionSafetyError('PRICE_MISMATCH', 'The price snapshot does not match the resolved Spot market.')
  const priceMs = timestampMilliseconds(price.timestamp, 'Price timestamp')
  if (priceMs > nowMs || nowMs - priceMs > executionSafetyConfig.maxPriceAgeMs) throw new ExecutionSafetyError('STALE_PRICE', 'The Spot price snapshot is stale or from the future.')
  const marketPrice = numeric(price.price, 'Market price', false)
  const filters = marketConstraints(market)
  const precision = market.baseAssetPrecision
  const quotePrecision = market.quoteAssetPrecision
  const protectedSet = new Set(protectedAssets.map((asset) => normalizeSymbol(asset, 'Protected asset')))
  if (protectedSet.has(sourceAsset)) throw new ExecutionSafetyError('PROTECTED_ASSET', `${sourceAsset} is protected and cannot be debited.`)
  const factor = (1 - feeRate) * (1 - (slippageBps / 10_000))
  const free = balanceFree(source)
  let side: SpotSide
  let quantity: number | undefined
  let quoteOrderQty: number | undefined
  let expectedSourceDebit: number
  let expectedTargetCredit: number

  if (market.baseAsset.toUpperCase() === sourceAsset && market.quoteAsset.toUpperCase() === targetAsset) {
    side = 'SELL'
    const rawQuantity = plannedSourceQuantity
    quantity = quantizeDown(rawQuantity, filters.stepSize, precision)
    validateOrderAmount(quantity, free, `${sourceAsset} quantity`)
    if (filters.minQty !== undefined && quantity < filters.minQty) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'The order is below Binance minimum quantity.')
    if (filters.maxQty !== undefined && quantity > filters.maxQty) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'The order exceeds Binance maximum quantity.')
    const notional = quantity * marketPrice
    if (notional < filters.minNotional) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'The order is below Binance minimum notional.')
    if (filters.maxNotional !== undefined && notional > filters.maxNotional) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'The order exceeds Binance maximum notional.')
    expectedSourceDebit = quantity
    expectedTargetCredit = notional * factor
  } else if (market.baseAsset.toUpperCase() === targetAsset && market.quoteAsset.toUpperCase() === sourceAsset) {
    side = 'BUY'
    if (market.quoteOrderQtyMarketAllowed !== true) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'This Spot market does not explicitly allow quote-sized market orders.')
    if (quotePrecision === undefined) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'Quote precision is required for a quote-sized market order.')
    const rawQuoteOrderQty = plannedSourceQuantity
    quoteOrderQty = quantizeDown(rawQuoteOrderQty, undefined, quotePrecision)
    validateOrderAmount(quoteOrderQty, free, `${sourceAsset} quote amount`)
    // Binance executes a quote-sized BUY in base units, then applies the
    // symbol's lot step. Model that final executable quantity, not the raw
    // quote/price estimate, so policy projections match the order Binance can
    // actually fill.
    const estimatedQuantity = quantizeDown(quoteOrderQty / marketPrice, filters.stepSize, precision)
    if (!Number.isFinite(estimatedQuantity) || estimatedQuantity <= 0) throw new ExecutionSafetyError('INVALID_ORDER', `${targetAsset} quantity is not positive after exchange quantization.`)
    if (filters.minQty !== undefined && estimatedQuantity < filters.minQty) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'The order is below Binance minimum quantity.')
    if (filters.maxQty !== undefined && estimatedQuantity > filters.maxQty) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'The order exceeds Binance maximum quantity.')
    if (quoteOrderQty < filters.minNotional) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'The order is below Binance minimum notional.')
    if (filters.maxNotional !== undefined && quoteOrderQty > filters.maxNotional) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'The order exceeds Binance maximum notional.')
    expectedSourceDebit = quoteOrderQty
    expectedTargetCredit = estimatedQuantity * factor
  } else {
    throw new ExecutionSafetyError('AMBIGUOUS_MARKET', 'The market orientation does not map the source and target assets unambiguously.')
  }

  const planId = options.planId ?? `rokai-${randomUUID()}`
  if (!planId.trim()) throw new ExecutionSafetyError('INVALID_ORDER', 'A plan ID is required.')
  const clientOrderId = `r-${randomUUID().replace(/-/g, '')}`
  return {
    ...(options.runId ? { runId: options.runId } : {}),
    planId,
    ...(options.step !== undefined ? { step: options.step } : {}),
    clientOrderId,
    symbol: marketSymbol,
    baseAsset: normalizeSymbol(market.baseAsset, 'Base asset'),
    quoteAsset: normalizeSymbol(market.quoteAsset, 'Quote asset'),
    side,
    type: 'MARKET',
    ...(quantity !== undefined ? { quantity } : { quoteOrderQty }),
    sourceAsset,
    targetAsset,
    expectedSourceDebit,
    expectedTargetCredit,
    priceSnapshot: marketPrice,
    priceTimestamp: new Date(priceMs).toISOString(),
    expiresAt: new Date(nowMs + approvalTtlMs).toISOString(),
  }
}

export function createApprovalBinding(order: ExecutableOrder): ApprovalBinding {
  return {
    planId: order.planId,
    serializedPayload: serializeExecutableOrder(order),
    expiresAt: order.expiresAt,
    approved: false,
    consumed: false,
  }
}

function assertApprovalMatches(binding: ApprovalBinding, order: ExecutableOrder, nowMs: number) {
  if (binding.consumed) throw new ExecutionSafetyError('DUPLICATE_APPROVAL', 'This approval has already been consumed.')
  if (binding.planId !== order.planId || binding.serializedPayload !== serializeExecutableOrder(order)) throw new ExecutionSafetyError('PAYLOAD_CHANGED', 'The approved order no longer matches the displayed order.')
  const expiry = timestampMilliseconds(binding.expiresAt, 'Approval expiry')
  if (nowMs >= expiry) throw new ExecutionSafetyError('STALE_APPROVAL', 'The approval has expired and must be replanned.')
}

export function isExplicitApproval(value: string, planId?: string) {
  return typeof planId === 'string' && value.trim() === `APPROVE ${planId}`
}

export function approveOrder(binding: ApprovalBinding, order: ExecutableOrder, confirmation: string, now?: Date | number) {
  const nowMs = nowMilliseconds()
  assertApprovalMatches(binding, order, nowMs)
  if (binding.approved) throw new ExecutionSafetyError('DUPLICATE_APPROVAL', 'This order has already been approved.')
  if (!isExplicitApproval(confirmation, binding.planId)) throw new ExecutionSafetyError('EXPLICIT_APPROVAL_REQUIRED', `Approval must exactly match APPROVE ${binding.planId}.`)
  return { ...binding, approved: true, approvedAt: new Date(nowMs).toISOString() }
}

function consumeApproval(binding: ApprovalBinding, order: ExecutableOrder, nowMs: number) {
  assertApprovalMatches(binding, order, nowMs)
  if (!binding.approved) throw new ExecutionSafetyError('EXPLICIT_APPROVAL_REQUIRED', 'The exact order has not been explicitly approved.')
  binding.consumed = true
  return binding
}

export function validateSpotAccountForExecution(payload: unknown, market?: ExchangeSymbolInfo) {
  const value = unwrapMcpPayload(payload)
  if (!isRecord(value)) throw new ExecutionSafetyError('INVALID_ACCOUNT', 'Binance returned an invalid Spot account response.')
  if (typeof value.accountType !== 'string' || value.accountType.toUpperCase() !== 'SPOT') throw new ExecutionSafetyError('ACCOUNT_SCOPE', 'Only a Spot account may be used for Rokai execution.')
  if (value.canTrade !== true) throw new ExecutionSafetyError('PERMISSION_DENIED', 'Binance Spot trading permission is not enabled.')
  if (value.tradeAllowed !== undefined && value.tradeAllowed !== true) throw new ExecutionSafetyError('PERMISSION_DENIED', 'Binance Spot trade permission is not enabled.')
  if (value.spotTradingAllowed !== undefined && value.spotTradingAllowed !== true) throw new ExecutionSafetyError('PERMISSION_DENIED', 'Binance Spot trading is not allowed.')
  const permissions = value.permissions === undefined ? [] : normalizePermissions(value.permissions, 'Binance account permissions')
  const metadataPermissions = ['tradingGroup', 'tradingGroupId', 'accountTradingGroup']
    .flatMap((key) => typeof value[key] === 'string' ? [value[key]!.toUpperCase()] : [])
  const accountPermissions = [...new Set([...permissions, ...metadataPermissions])]
  const hasDirectSpotPermission = accountPermissions.includes('SPOT')
  const hasRecognizedTradingGroup = accountPermissions.some(isRecognizedTradingGroup)
  if (!hasDirectSpotPermission && !hasRecognizedTradingGroup) throw new ExecutionSafetyError('PERMISSION_DENIED', 'Binance account does not expose verifiable Spot trading capability.')
  if (market && !marketHasSpotPermission(market, accountPermissions)) throw new ExecutionSafetyError('PERMISSION_DENIED', `${market.symbol} does not expose Spot permission for the authorized account.`)
  let agenticMarker: boolean | undefined
  for (const key of ['isAgentic', 'agentic'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new ExecutionSafetyError('ACCOUNT_SCOPE', 'The Agentic account marker is malformed.')
      agenticMarker = value[key]
    }
  }
  if (value.accountContext !== undefined) {
    const context = value.accountContext
    if (!isRecord(context)) throw new ExecutionSafetyError('ACCOUNT_SCOPE', 'The Agentic account context is malformed.')
    if (context.isAgentic !== true && context.agentic !== true) throw new ExecutionSafetyError('ACCOUNT_SCOPE', 'The account context is not explicitly Agentic.')
    agenticMarker = true
  }
  if (agenticMarker === false) throw new ExecutionSafetyError('ACCOUNT_SCOPE', 'The account is not the expected Agentic Spot account.')
  return {
    agenticIdentity: agenticMarker === true ? 'explicit' as const : 'unavailable' as const,
    accountPermissions,
    spotPermission: hasDirectSpotPermission ? 'SPOT' as const : 'TRADING_GROUP' as const,
  }
}

function assertFreshPrice(order: ExecutableOrder, currentPrice: PriceSnapshot, nowMs: number, maxPriceAgeMs: number, maxDeviationBps: number) {
  if (normalizeSymbol(currentPrice.symbol, 'Current price symbol') !== order.symbol) throw new ExecutionSafetyError('PRICE_MISMATCH', 'The preflight price does not match the approved market.')
  const currentPriceMs = timestampMilliseconds(currentPrice.timestamp, 'Current price timestamp')
  if (currentPriceMs > nowMs || nowMs - currentPriceMs > maxPriceAgeMs) throw new ExecutionSafetyError('STALE_PRICE', 'The preflight Spot price is stale or from the future.')
  const price = numeric(currentPrice.price, 'Current price', false)
  const deviationBps = Math.abs(price - order.priceSnapshot) / order.priceSnapshot * 10_000
  if (deviationBps > maxDeviationBps) throw new ExecutionSafetyError('PRICE_MOVED', 'The Spot price moved beyond the approved safety threshold; replan is required.')
}

export function assertOrderSafeToSubmit(order: ExecutableOrder, binding: ApprovalBinding, context: SubmissionContext) {
  const nowMs = nowMilliseconds()
  assertApprovalMatches(binding, order, nowMs)
  if (!binding.approved) throw new ExecutionSafetyError('EXPLICIT_APPROVAL_REQUIRED', 'The exact order has not been explicitly approved.')
  if (order.type !== 'MARKET' || (order.quantity === undefined && order.quoteOrderQty === undefined) || (order.quantity !== undefined && order.quoteOrderQty !== undefined)) throw new ExecutionSafetyError('INVALID_ORDER', 'The executable order is not an exact Spot market order.')
  assertFreshPrice(order, context.currentPrice, nowMs, executionSafetyConfig.maxPriceAgeMs, executionSafetyConfig.maxPriceDeviationBps)
  if (context.account === undefined) throw new ExecutionSafetyError('INVALID_ACCOUNT', 'A fresh Spot account response is required before submission.')
  if (context.market === undefined || context.exchangeInfoTimestamp === undefined) throw new ExecutionSafetyError('EXCHANGE_FILTER', 'Fresh Spot exchange information is required before submission.')
  const accountValidation = validateSpotAccountForExecution(context.account, context.market)
  validateMarketForOrder(order, context.market, accountValidation.accountPermissions)
  const exchangeInfoMs = timestampValue(context.exchangeInfoTimestamp, 'Exchange information timestamp')
  const maxDataAgeMs = executionSafetyConfig.maxPriceAgeMs
  if (exchangeInfoMs > nowMs || nowMs - exchangeInfoMs > maxDataAgeMs) throw new ExecutionSafetyError('STALE_EXCHANGE_INFO', 'Spot exchange information is stale or from the future.')
  const protectedSet = new Set((context.protectedAssets ?? []).map((asset) => normalizeSymbol(asset, 'Protected asset')))
  if (protectedSet.has(order.sourceAsset)) throw new ExecutionSafetyError('PROTECTED_ASSET', `${order.sourceAsset} is protected and cannot be debited.`)
  const source = findAsset(context.assets, order.sourceAsset)
  if (!source) throw new ExecutionSafetyError('MISSING_BALANCE', `No current balance was read for ${order.sourceAsset}.`)
  if (order.expectedSourceDebit > balanceFree(source) + 1e-12) throw new ExecutionSafetyError('INSUFFICIENT_FUNDS', `Available free ${order.sourceAsset} balance is insufficient for the approved order.`)
  if (context.policy) {
    const expectedAssets = simulateOrder(order, context.assets)
    const beforeResults = evaluateRules(context.assets, context.policy)
    const expectedResults = evaluateRules(expectedAssets, context.policy)
    if (beforeResults.some((result, index) => result.passed && !expectedResults[index].passed)) throw new ExecutionSafetyError('POLICY_SAFETY', 'The exact order would break a currently satisfied policy rule.')
    if (calculateViolationScore(expectedAssets, context.policy) >= calculateViolationScore(context.assets, context.policy) - 1e-9) throw new ExecutionSafetyError('POLICY_SAFETY', 'The exact order does not improve the deterministic violation score.')
  }
  return true
}

function simulateOrder(order: ExecutableOrder, assets: Asset[]): Asset[] {
  const source = findAsset(assets, order.sourceAsset)
  const existingTarget = findAsset(assets, order.targetAsset)
  if (!source) throw new ExecutionSafetyError('MISSING_BALANCE', `No current balance was read for ${order.sourceAsset}.`)
  const target = existingTarget ?? {
    symbol: order.targetAsset,
    name: order.targetAsset,
    quantity: 0,
    free: 0,
    locked: 0,
    priceUsd: order.side === 'SELL' ? 1 : order.priceSnapshot,
    change24h: 0,
    kind: order.side === 'SELL' ? 'stablecoin' : 'core',
  } satisfies Asset
  if (source.symbol === target.symbol) throw new ExecutionSafetyError('INVALID_ORDER', 'Order source and target assets must differ.')
  const targetUnits = order.side === 'SELL' ? order.expectedTargetCredit / target.priceUsd : order.expectedTargetCredit
  if (!Number.isFinite(targetUnits) || targetUnits <= 0) throw new ExecutionSafetyError('INVALID_ORDER', 'Expected target credit is invalid.')
  const updatedAssets = assets.map((asset) => {
    if (asset.symbol.toUpperCase() === order.sourceAsset) return { ...asset, quantity: asset.quantity - order.expectedSourceDebit, free: balanceFree(asset) - order.expectedSourceDebit }
    if (asset.symbol.toUpperCase() === order.targetAsset) return { ...asset, quantity: asset.quantity + targetUnits, free: balanceFree(asset) + targetUnits }
    return { ...asset }
  })
  if (!existingTarget) updatedAssets.push({ ...target, quantity: targetUnits, free: targetUnits })
  return updatedAssets
}

function orderArguments(order: ExecutableOrder) {
  return {
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    ...(order.quantity !== undefined ? { quantity: order.quantity } : { quoteOrderQty: order.quoteOrderQty }),
    newClientOrderId: order.clientOrderId,
    newOrderRespType: 'FULL',
  }
}

export function buildSpotOrderArguments(order: ExecutableOrder) {
  return orderArguments(order)
}

function knownStatus(value: unknown): SpotOrderStatus {
  if (typeof value !== 'string') return 'UNKNOWN'
  const status = value.toUpperCase() as SpotOrderStatus
  return supportedStatuses.has(status) ? status : 'UNKNOWN'
}

function knownOrderId(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim()
  return undefined
}

export function parseOrderResponse(payload: unknown, expectedClientOrderId?: string, expectedOrderId?: string): ExecutionReceipt {
  const value = unwrapMcpPayload(payload)
  if (!isRecord(value)) return { status: 'UNKNOWN', error: 'Binance returned an unclear order response.' }
  const status = knownStatus(value.status)
  const orderId = knownOrderId(value.orderId)
  const clientOrderId = typeof value.clientOrderId === 'string' ? value.clientOrderId : typeof value.origClientOrderId === 'string' ? value.origClientOrderId : undefined
  const symbol = typeof value.symbol === 'string' ? value.symbol.toUpperCase() : undefined
  const side = value.side === 'BUY' || value.side === 'SELL' ? value.side : undefined
  const type = value.type === 'MARKET' ? value.type : undefined
  if (expectedClientOrderId && clientOrderId !== expectedClientOrderId) return { status: 'UNKNOWN', orderId, clientOrderId, symbol, side, type, error: clientOrderId ? 'Binance returned an order for a different client order ID.' : 'Binance returned no matching client order ID.' }
  if (expectedOrderId && orderId !== expectedOrderId) return { status: 'UNKNOWN', orderId, clientOrderId, symbol, side, type, error: 'Binance returned an unrelated order ID.' }
  if (expectedOrderId && !orderId) return { status: 'UNKNOWN', clientOrderId, symbol, side, type, error: 'Binance returned no matching order ID.' }
  let origQty: number | undefined
  let origQuoteOrderQty: number | undefined
  let executedQty: number | undefined
  let cumulativeQuoteQty: number | undefined
  try {
    origQty = optionalNumeric(value.origQty, 'origQty')
    origQuoteOrderQty = optionalNumeric(value.origQuoteOrderQty, 'origQuoteOrderQty')
    executedQty = optionalNumeric(value.executedQty, 'executedQty')
    const cumulativeValue = value.cummulativeQuoteQty ?? value.cumulativeQuoteQty
    cumulativeQuoteQty = cumulativeValue === undefined || Number(cumulativeValue) < 0 ? undefined : optionalNumeric(cumulativeValue, 'cumulativeQuoteQty')
  } catch {
    return { status: 'UNKNOWN', orderId, clientOrderId, symbol, side, type, error: 'Binance returned unclear order quantities.' }
  }
  const quantityMode = origQuoteOrderQty !== undefined && origQuoteOrderQty > 0 ? 'quoteOrderQty' : origQty !== undefined && origQty > 0 ? 'quantity' : undefined
  let commissions: Array<{ asset: string; amount: number }> | undefined
  if (value.fills !== undefined) {
    if (!Array.isArray(value.fills)) return { status: 'UNKNOWN', orderId, clientOrderId, symbol, side, type, error: 'Binance returned malformed fills.' }
    commissions = []
    for (const fill of value.fills) {
      if (!isRecord(fill) || typeof fill.commissionAsset !== 'string') return { status: 'UNKNOWN', orderId, clientOrderId, symbol, side, type, error: 'Binance returned malformed commission data.' }
      try {
        commissions.push({ asset: normalizeSymbol(fill.commissionAsset, 'Commission asset'), amount: numeric(fill.commission, 'Commission amount') })
      } catch {
        return { status: 'UNKNOWN', orderId, clientOrderId, symbol, side, type, error: 'Binance returned malformed commission data.' }
      }
    }
  }
  if (status === 'UNKNOWN') return { status, orderId, clientOrderId, symbol, side, type, quantityMode, origQty, origQuoteOrderQty, executedQty, cumulativeQuoteQty, commissions, error: 'Binance returned an unknown order status.' }
  if (status !== 'REJECTED' && !orderId && !clientOrderId) return { status: 'UNKNOWN', symbol, side, type, quantityMode, origQty, origQuoteOrderQty, executedQty, cumulativeQuoteQty, commissions, error: 'Binance returned no order identifier.' }
  return { status, orderId, clientOrderId, symbol, side, type, quantityMode, origQty, origQuoteOrderQty, executedQty, cumulativeQuoteQty, commissions }
}

export function validateOrderResponseIdentity(receipt: ExecutionReceipt, order: ExecutableOrder): string | undefined {
  if (receipt.symbol !== undefined) {
    try {
      if (normalizeSymbol(receipt.symbol, 'Order response symbol') !== order.symbol) return 'Binance returned a different order symbol.'
    } catch {
      return 'Binance returned a malformed order symbol.'
    }
  }
  if (receipt.side !== undefined && receipt.side !== order.side) return 'Binance returned a different order side.'
  if (receipt.type !== undefined && receipt.type !== order.type) return 'Binance returned a different order type.'
  if (!receipt.clientOrderId) return 'Binance returned no matching client order ID.'
  if (receipt.clientOrderId !== order.clientOrderId) return 'Binance returned a different client order ID.'
  const expectedMode = order.quantity !== undefined ? 'quantity' : 'quoteOrderQty'
  if (receipt.quantityMode !== expectedMode) return 'Binance returned a different quantity mode.'
  if (expectedMode === 'quantity') {
    if (receipt.origQty === undefined) return 'Binance omitted the original base quantity needed for correlation.'
    if (Math.abs(receipt.origQty - (order.quantity ?? 0)) > Math.max(1e-12, (order.quantity ?? 0) * 1e-8)) return 'Binance returned a different original base quantity.'
  } else {
    if (receipt.origQuoteOrderQty === undefined) return 'Binance omitted the original quote quantity needed for correlation.'
    if (Math.abs(receipt.origQuoteOrderQty - (order.quoteOrderQty ?? 0)) > Math.max(1e-8, (order.quoteOrderQty ?? 0) * 1e-8)) return 'Binance returned a different original quote quantity.'
  }
  if (!receipt.orderId && !receipt.clientOrderId) return 'Binance returned no usable order correlation.'
  if (receipt.status === 'FILLED' && (!receipt.symbol || !receipt.side || !receipt.type)) return 'The filled order response omitted required identity fields.'
  return undefined
}

export function verifyExecutedOrder(order: ExecutableOrder, receipt: ExecutionReceipt, beforeAssets: Asset[], afterAssets: Asset[], policy: Policy): PostTradeVerification {
  const before = valuePortfolio(beforeAssets)
  const after = valuePortfolio(afterAssets)
  const results = evaluateRules(afterAssets, policy)
  const hasActualFill = receipt.executedQty !== undefined && receipt.cumulativeQuoteQty !== undefined && receipt.executedQty > 0 && receipt.cumulativeQuoteQty > 0
  const actualAverageFillPrice = hasActualFill ? receipt.cumulativeQuoteQty! / receipt.executedQty! : undefined
  const actualPriceDeviationBps = actualAverageFillPrice !== undefined
    ? Math.abs(actualAverageFillPrice - order.priceSnapshot) / order.priceSnapshot * 10_000
    : undefined
  const priceWithinApproval = actualPriceDeviationBps !== undefined && Number.isFinite(actualPriceDeviationBps) && actualPriceDeviationBps <= executionSafetyConfig.maxPriceDeviationBps
  const actualSourceDebit = order.side === 'SELL' ? receipt.executedQty : receipt.cumulativeQuoteQty
  const approvedSourceLimit = order.side === 'SELL' ? order.quantity : order.quoteOrderQty
  const fillTolerance = approvedSourceLimit === undefined ? 0 : Math.max(1e-12, approvedSourceLimit * 1e-8)
  const fillWithinApproval = actualSourceDebit !== undefined && approvedSourceLimit !== undefined
    && actualSourceDebit <= approvedSourceLimit + fillTolerance
    && actualSourceDebit >= approvedSourceLimit - fillTolerance
  const rulesSatisfied = results.every((result) => result.passed)
  const identityError = validateOrderResponseIdentity(receipt, order)
  const sourceBefore = findAsset(beforeAssets, order.sourceAsset)
  const sourceAfter = findAsset(afterAssets, order.sourceAsset)
  const targetBefore = findAsset(beforeAssets, order.targetAsset)
  const targetAfter = findAsset(afterAssets, order.targetAsset)
  const sourceDecrease = sourceBefore ? sourceBefore.quantity - (sourceAfter?.quantity ?? 0) : 0
  const targetIncrease = targetAfter ? targetAfter.quantity - (targetBefore?.quantity ?? 0) : 0
  const grossTargetIncrease = order.side === 'SELL'
    ? receipt.cumulativeQuoteQty !== undefined && targetAfter ? receipt.cumulativeQuoteQty / targetAfter.priceUsd : 0
    : receipt.executedQty ?? 0
  const commissions = receipt.commissions
  const commissionAmount = (asset: string) => commissions?.filter((commission) => commission.asset === asset).reduce((sum, commission) => sum + commission.amount, 0) ?? 0
  const sourceCommission = commissionAmount(order.sourceAsset)
  const targetCommission = commissionAmount(order.targetAsset)
  const feeDeltasSane = commissions !== undefined && commissions.every((commission) => {
    if (commission.amount < 0 || !Number.isFinite(commission.amount)) return false
    if (commission.asset === order.sourceAsset || commission.asset === order.targetAsset) return true
    const beforeFeeAsset = findAsset(beforeAssets, commission.asset)
    const afterFeeAsset = findAsset(afterAssets, commission.asset)
    return Boolean(beforeFeeAsset && afterFeeAsset && beforeFeeAsset.quantity - afterFeeAsset.quantity + 1e-12 >= commission.amount)
  })
  const balanceDeltasSane = Boolean(
    sourceBefore
      && sourceAfter
      && targetAfter
      && sourceDecrease > 0
      && targetIncrease > 0
      && sourceDecrease + 1e-12 >= (actualSourceDebit ?? Number.POSITIVE_INFINITY) + sourceCommission
      && targetIncrease + 1e-12 >= grossTargetIncrease - targetCommission,
  )
  const protectedDeltaSafe = policy.rules
    .filter((rule) => rule.kind === 'protected_asset')
    .every((rule) => {
      const beforeProtected = findAsset(beforeAssets, rule.asset)
      const afterProtected = findAsset(afterAssets, rule.asset)
      return !beforeProtected || (afterProtected !== undefined && afterProtected.quantity + 1e-12 >= beforeProtected.quantity)
    })
  const progressImproved = calculateViolationScore(afterAssets, policy) < calculateViolationScore(beforeAssets, policy) - 1e-9
  const tradeVerified = receipt.status === 'FILLED' && !identityError && hasActualFill && priceWithinApproval && fillWithinApproval && balanceDeltasSane && feeDeltasSane && protectedDeltaSafe && progressImproved
  let reason: string | undefined
  if (identityError) reason = identityError
  else if (receipt.status !== 'FILLED') reason = `Order status is ${receipt.status}; a fully verified fill is required.`
  else if (!hasActualFill) reason = 'The live order response did not include complete executed quantity and quote totals.'
  else if (!priceWithinApproval) reason = `The actual average fill price deviated beyond the ${executionSafetyConfig.maxPriceDeviationBps} bps safety limit.`
  else if (!fillWithinApproval) reason = 'The live fill exceeds the exact approved order.'
  else if (!balanceDeltasSane) reason = 'The fresh account balances do not confirm the approved source debit and target credit.'
  else if (!feeDeltasSane) reason = 'The live fee asset or commission could not be reconciled safely.'
  else if (!protectedDeltaSafe) reason = 'A protected asset changed during the trade.'
  else if (!progressImproved) reason = 'The verified trade did not improve the deterministic violation score.'
  else if (!rulesSatisfied) reason = 'The live portfolio still violates one or more active rules.'
  return {
    verified: tradeVerified,
    tradeVerified,
    policySatisfied: rulesSatisfied,
    status: receipt.status,
    before,
    after,
    results,
    executedQty: receipt.executedQty,
    cumulativeQuoteQty: receipt.cumulativeQuoteQty,
    actualAverageFillPrice,
    actualPriceDeviationBps,
    reason,
  }
}
