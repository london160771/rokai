import type { Asset } from './mockData.js'
import {
  evaluateRules,
  valuePortfolio,
  type Policy,
  type Rule,
  type RuleResult,
} from './rules.js'
import type { ExchangeFilter, ExchangeSymbolInfo } from './execution.js'

export type CandidateAction = {
  source: string
  target: string
  amountUsd: number
  sourceQuantity: number
  rationale: string
}

export type CandidateSummary = CandidateAction & {
  scoreBefore: number
  scoreAfter: number
  improves: boolean
  accepted: boolean
  rejectionReason?: string
}

export type NextTradeDecision =
  | {
      status: 'COMPLETE'
      ruleResults: RuleResult[]
    }
  | {
      status: 'STOP'
      reason: string
      ruleResults: RuleResult[]
      candidatesConsidered: CandidateSummary[]
    }
  | {
      status: 'READY'
      runId: string
      step: 1
      ruleResults: RuleResult[]
      candidatesConsidered: CandidateSummary[]
      nextTrade: CandidateAction
      expectedRuleResults: RuleResult[]
      violationScoreBefore: number
      violationScoreExpected: number
    }

export type NextTradePlannerOptions = {
  runId?: string
  settlementAsset?: string
  referencePricesUsd?: Record<string, number>
  market?: ExchangeSymbolInfo
}

type NormalizedInput = {
  assets: Asset[]
  policy: Policy
}

type Need = {
  target: string
  amountUsd: number
  rationale: string
  priority: number
}

type CandidateEvaluation = {
  action: CandidateAction
  summary: CandidateSummary
  expectedAssets: Asset[]
  expectedRuleResults: RuleResult[]
  rulesImproved: number
  priority: number
}

const symbolPattern = /^[A-Z][A-Z0-9]{1,11}$/
const stablecoinSymbols = new Set(['USDC', 'USDT', 'BUSD', 'FDUSD', 'DAI', 'USDE'])
const epsilon = 1e-9
const planningSafetyConfig = Object.freeze({ bufferPct: 0.5, bufferUsd: 1 })
const executionSafetyConfig = Object.freeze({ feeRate: 0.001, slippageBps: 10, maxRoundUpPct: 10 })
let plannerSequence = 0
const plannerDecisions = new WeakSet<object>()

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value
  seen.add(value as object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  Object.freeze(value)
  return value
}

function plannerDecision<T extends NextTradeDecision>(decision: T): T {
  const frozen = deepFreeze(decision)
  plannerDecisions.add(frozen as object)
  return frozen
}

export function isPlannerDecision(value: unknown): value is NextTradeDecision {
  return Boolean(value && typeof value === 'object' && plannerDecisions.has(value as object))
}

function normalizeSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const symbol = value.trim().toUpperCase()
  return symbolPattern.test(symbol) ? symbol : null
}

function normalizeRule(rule: unknown): Rule | null {
  if (!rule || typeof rule !== 'object') return null
  const raw = rule as Record<string, unknown>
  const kind = raw.kind

  if (kind === 'min_stablecoin' || kind === 'min_asset_allocation') {
    const asset = normalizeSymbol(raw.asset)
    const minPct = raw.minPct
    if (!asset || typeof minPct !== 'number' || !Number.isFinite(minPct) || minPct < 0 || minPct > 100) return null
    if (kind === 'min_stablecoin' && !stablecoinSymbols.has(asset)) return null
    return { kind, asset, minPct }
  }

  if (kind === 'min_stablecoin_amount') {
    const asset = normalizeSymbol(raw.asset)
    const minAmount = raw.minAmount
    if (!asset || !stablecoinSymbols.has(asset) || typeof minAmount !== 'number' || !Number.isFinite(minAmount) || minAmount < 0) return null
    return { kind, asset, minAmount }
  }

  if (kind === 'protected_asset') {
    const asset = normalizeSymbol(raw.asset)
    return asset ? { kind, asset } : null
  }

  if (kind === 'max_asset_exposure') {
    const rawAsset = typeof raw.asset === 'string' ? raw.asset.trim() : ''
    const asset = rawAsset.toLowerCase() === 'altcoins' ? 'altcoins' : normalizeSymbol(raw.asset)
    const maxPct = raw.maxPct
    if (!asset || typeof maxPct !== 'number' || !Number.isFinite(maxPct) || maxPct < 0 || maxPct > 100) return null
    return { kind, asset, maxPct }
  }

  return null
}

function normalizeInput(assets: Asset[], policy: Policy): { value?: NormalizedInput; error?: string } {
  if (!Array.isArray(assets)) return { error: 'A portfolio is required.' }
  const normalizedAssets: Asset[] = []
  const seenAssets = new Set<string>()

  for (const rawAsset of assets) {
    if (!rawAsset || typeof rawAsset !== 'object') return { error: 'Portfolio data is malformed.' }
    const asset = rawAsset as Asset
    const symbol = normalizeSymbol(asset.symbol)
    if (!symbol || seenAssets.has(symbol)) return { error: 'Portfolio symbols must be valid and unique.' }
    if (!Number.isFinite(asset.quantity) || asset.quantity < 0 || !Number.isFinite(asset.priceUsd) || asset.priceUsd <= 0) {
      return { error: 'Every asset requires a finite non-negative balance and a valid price.' }
    }
    if (asset.free !== undefined && (!Number.isFinite(asset.free) || asset.free < 0)) return { error: `${symbol} has an invalid free balance.` }
    if (asset.locked !== undefined && (!Number.isFinite(asset.locked) || asset.locked < 0)) return { error: `${symbol} has an invalid locked balance.` }
    const locked = asset.locked ?? 0
    const free = asset.free ?? Math.max(0, asset.quantity - locked)
    if (free + locked > asset.quantity + 1e-8) return { error: `${symbol} free and locked balances exceed its total balance.` }
    seenAssets.add(symbol)
    normalizedAssets.push({ ...asset, symbol, free, locked })
  }

  if (!policy || !Array.isArray(policy.rules) || policy.rules.length === 0) return { error: 'At least one supported policy rule is required.' }
  const normalizedRules: Rule[] = []
  for (const rawRule of policy.rules) {
    const normalizedRule = normalizeRule(rawRule)
    if (!normalizedRule) return { error: 'The policy contains an unsupported or malformed rule.' }
    normalizedRules.push(normalizedRule)
  }

  const normalizedPolicy: Policy = {
    rules: normalizedRules,
    sourceText: typeof policy.sourceText === 'string' ? policy.sourceText : '',
  }
  const conflict = findPolicyConflict(normalizedPolicy)
  return conflict ? { error: conflict } : { value: { assets: normalizedAssets, policy: normalizedPolicy } }
}

function ruleThreshold(rule: Rule): number | null {
  if ('minPct' in rule) return rule.minPct
  if ('maxPct' in rule) return rule.maxPct
  if ('minAmount' in rule) return rule.minAmount
  return null
}

function findPolicyConflict(policy: Policy): string | undefined {
  const exactRules = new Set<string>()
  const thresholdRules = new Map<string, number>()
  const stableTargets = new Set<string>()

  for (const rule of policy.rules) {
    const threshold = ruleThreshold(rule)
    const key = `${rule.kind}:${'asset' in rule ? rule.asset : ''}:${threshold ?? ''}`
    if (exactRules.has(key)) return 'Duplicate policy rules are not safe to plan.'
    exactRules.add(key)

    if (rule.kind === 'min_stablecoin' || rule.kind === 'min_stablecoin_amount') stableTargets.add(rule.asset)
    if (rule.kind !== 'protected_asset') {
      const thresholdKey = `${rule.kind}:${'asset' in rule ? rule.asset : ''}`
      const previous = thresholdRules.get(thresholdKey)
      if (previous !== undefined && previous !== threshold) return 'Conflicting thresholds for the same policy rule are not safe to plan.'
      thresholdRules.set(thresholdKey, threshold ?? 0)
    }
  }

  if (stableTargets.size > 1) return 'Stablecoin rules name different target assets, so the next trade is ambiguous.'

  const minimums = policy.rules.filter(
    (rule): rule is Extract<Rule, { kind: 'min_asset_allocation' | 'min_stablecoin' }> =>
      rule.kind === 'min_asset_allocation' || rule.kind === 'min_stablecoin',
  )
  const maximums = policy.rules.filter(
    (rule): rule is Extract<Rule, { kind: 'max_asset_exposure' }> => rule.kind === 'max_asset_exposure' && rule.asset !== 'altcoins',
  )
  for (const minimum of minimums) {
    const maximum = maximums.find((rule) => rule.asset === minimum.asset)
    if (maximum && minimum.minPct > maximum.maxPct) return `${minimum.asset} has incompatible minimum and maximum allocations.`
  }

  return undefined
}

function freeBalance(asset: Asset): number {
  return asset.free ?? Math.max(0, asset.quantity - (asset.locked ?? 0))
}

function findAsset(assets: Asset[], symbol: string): Asset | undefined {
  return assets.find((asset) => asset.symbol === symbol)
}

function protectedSymbols(policy: Policy): Set<string> {
  return new Set(
    policy.rules.filter((rule) => rule.kind === 'protected_asset').map((rule) => rule.asset.toUpperCase()),
  )
}

function stableTargetSymbol(assets: Asset[], policy: Policy): string | null {
  const declared = [...new Set(
    policy.rules
      .filter((rule): rule is Extract<Rule, { kind: 'min_stablecoin' | 'min_stablecoin_amount' }> =>
        rule.kind === 'min_stablecoin' || rule.kind === 'min_stablecoin_amount',
      )
      .map((rule) => rule.asset),
  )]
  if (declared.length === 1) return declared[0]
  if (declared.length > 1) return null
  const existing = assets.filter((asset) => asset.kind === 'stablecoin' || stablecoinSymbols.has(asset.symbol)).map((asset) => asset.symbol)
  return existing.length === 1 ? existing[0] : null
}

function matchingAssets<T extends Asset>(assets: T[], rule: Extract<Rule, { kind: 'max_asset_exposure' }>): T[] {
  return rule.asset === 'altcoins' ? assets.filter((asset) => asset.kind === 'altcoin') : assets.filter((asset) => asset.symbol === rule.asset)
}

function scoreRule(assets: Asset[], rule: Rule): number {
  const { totalUsd, assets: valued } = valuePortfolio(assets)
  if (rule.kind === 'protected_asset' || totalUsd <= 0) return 0

  const asset = valued.find((item) => item.symbol === rule.asset)
  if (rule.kind === 'min_stablecoin' || rule.kind === 'min_asset_allocation') {
    return Math.max(0, rule.minPct - (asset?.allocationPct ?? 0)) / 100
  }
  if (rule.kind === 'min_stablecoin_amount') {
    return Math.max(0, rule.minAmount - (asset?.valueUsd ?? 0)) / Math.max(1, rule.minAmount)
  }

  return matchingAssets(valued, rule).reduce(
    (sum, item) => sum + Math.max(0, item.allocationPct - rule.maxPct) / 100,
    0,
  )
}

export function calculateViolationScore(assets: Asset[], policy: Policy): number {
  return policy.rules.reduce((sum, rule) => sum + scoreRule(assets, rule), 0)
}

function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function makeRunId(assets: Asset[], policy: Policy, now: number, requested?: string): string {
  if (requested) return requested
  plannerSequence += 1
  const serialized = JSON.stringify({
    assets: assets.map((asset) => ({ symbol: asset.symbol, quantity: asset.quantity, free: asset.free, locked: asset.locked, priceUsd: asset.priceUsd })),
    rules: policy.rules,
  })
  return `rokai-plan-${hashText(serialized)}-${now.toString(36)}-${plannerSequence.toString(36)}`
}

function applyCandidate(
  assets: Asset[],
  action: CandidateAction,
  targetPriceUsd: number,
  projection: { sourceDebit?: number; targetCredit?: number } = {},
): Asset[] {
  const targetExists = assets.some((asset) => asset.symbol === action.target)
  const sourceDebit = projection.sourceDebit ?? action.sourceQuantity
  const targetCredit = projection.targetCredit ?? action.amountUsd / targetPriceUsd
  const nextAssets = assets.map((asset) => {
    if (asset.symbol === action.source) {
      return {
        ...asset,
        quantity: asset.quantity - sourceDebit,
        free: freeBalance(asset) - sourceDebit,
      }
    }
    if (asset.symbol === action.target) {
      return {
        ...asset,
        quantity: asset.quantity + targetCredit,
        free: freeBalance(asset) + targetCredit,
      }
    }
    return { ...asset }
  })
  if (!targetExists) {
    nextAssets.push({
      symbol: action.target,
      name: action.target,
      quantity: targetCredit,
      free: targetCredit,
      locked: 0,
      priceUsd: targetPriceUsd,
      change24h: 0,
      kind: stablecoinSymbols.has(action.target) ? 'stablecoin' : 'core',
    })
  }
  return nextAssets
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase()
  const [coefficient, exponentText] = text.split('e')
  const exponent = exponentText ? Number(exponentText) : 0
  const fractionLength = coefficient.split('.')[1]?.length ?? 0
  return Math.max(0, fractionLength - exponent)
}

function quantizeDownForMarket(value: number, stepSize?: number, precision?: number): number | null {
  if (!Number.isFinite(value) || value < 0 || (stepSize !== undefined && (!Number.isFinite(stepSize) || stepSize <= 0))) return null
  // Use exchange precision/step precision as the integer scale. Including all
  // binary floating-point digits from `value` can create an unsafe 10^16+ scale
  // for ordinary values such as 6.0600000000000005.
  const scale = Math.max(stepSize === undefined ? 0 : decimalPlaces(stepSize), precision ?? 0)
  const factor = 10 ** scale
  const valueInteger = Math.floor(value * factor + 1e-8)
  const stepInteger = stepSize === undefined ? 1 : Math.round(stepSize * factor)
  if (!Number.isSafeInteger(valueInteger) || !Number.isSafeInteger(stepInteger) || stepInteger <= 0) return null
  const quantizedInteger = Math.floor(valueInteger / stepInteger) * stepInteger
  const quantized = quantizedInteger / factor
  return Number(quantized.toFixed(precision ?? scale))
}

function quantizeUpForPrecision(value: number, precision: number): number | null {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(precision) || precision < 0 || precision > 18) return null
  const factor = 10 ** precision
  if (!Number.isSafeInteger(Math.round(value * factor))) return null
  return Number((Math.ceil(value * factor - 1e-8) / factor).toFixed(precision))
}

function usableBuyLotFilter(market: ExchangeSymbolInfo) {
  const isUsable = (filter: ExchangeFilter | undefined) => Boolean(
    filter
      && filter.minQty !== undefined && filter.maxQty !== undefined && filter.stepSize !== undefined
      && filter.minQty > 0 && filter.maxQty > 0 && filter.stepSize > 0,
  )
  const marketLot = market.filters?.find((filter) => filter.filterType === 'MARKET_LOT_SIZE')
  if (isUsable(marketLot)) return marketLot
  return market.filters?.find((filter) => filter.filterType === 'LOT_SIZE' && isUsable(filter))
}

function usableSellLotFilter(market: ExchangeSymbolInfo) {
  return usableBuyLotFilter(market)
}

function marketNotionalBounds(market: ExchangeSymbolInfo) {
  const applicable = (market.filters ?? []).filter((filter) =>
    (filter.filterType === 'NOTIONAL' || filter.filterType === 'MIN_NOTIONAL')
      && filter.applyToMarket !== false
      && filter.applyMinToMarket !== false,
  )
  return {
    min: applicable.map((filter) => filter.minNotional).filter((value): value is number => value !== undefined).reduce((min, value) => Math.max(min, value), 0),
    max: applicable.map((filter) => filter.maxNotional).filter((value): value is number => value !== undefined).reduce((max, value) => Math.min(max, value), Number.POSITIVE_INFINITY),
  }
}

function hasUnresolvedMinimumForTarget(results: RuleResult[], target: string): boolean {
  return results.some((result) => !result.passed
    && ('asset' in result.rule && result.rule.asset === target)
    && (result.rule.kind === 'min_stablecoin' || result.rule.kind === 'min_stablecoin_amount' || result.rule.kind === 'min_asset_allocation'))
}

function projectBuyCandidate(
  assets: Asset[],
  policy: Policy,
  results: RuleResult[],
  action: CandidateAction,
  targetPriceUsd: number,
  market: ExchangeSymbolInfo,
): { action: CandidateAction; sourceDebit: number; targetCredit: number; expectedAssets: Asset[] } | { rejectionReason: string } | null {
  const source = findAsset(assets, action.source)
  const baseAsset = market.baseAsset.trim().toUpperCase()
  const quoteAsset = market.quoteAsset.trim().toUpperCase()
  if (baseAsset !== action.target || quoteAsset !== action.source) return null
  if (market.quoteOrderQtyMarketAllowed !== true) return { rejectionReason: 'The Spot market does not allow quote-sized market BUY orders.' }
  const lot = usableBuyLotFilter(market)
  const quotePrecision = market.quoteAssetPrecision
  if (!lot || quotePrecision === undefined || lot.minQty === undefined || lot.maxQty === undefined || lot.stepSize === undefined) {
    return { rejectionReason: 'Fresh Spot quantity and quote precision filters are required to size the BUY safely.' }
  }
  const notional = marketNotionalBounds(market)
  const sourceFreeValue = source ? freeBalance(source) * source.priceUsd : 0
  const adversePrice = targetPriceUsd * (1 + executionSafetyConfig.slippageBps / 10_000)
  const initialQuote = quantizeDownForMarket(action.sourceQuantity, undefined, quotePrecision)
  if (initialQuote === null || initialQuote <= 0) return { rejectionReason: 'The intended quote amount cannot be represented at the market precision.' }

  const evaluate = (quantity: number, quoteOrderQty: number) => {
    const targetCredit = quantity
      * (1 - executionSafetyConfig.feeRate)
      * (1 - (executionSafetyConfig.slippageBps / 10_000))
    const projectedAction: CandidateAction = {
      ...action,
      amountUsd: quoteOrderQty,
      sourceQuantity: quoteOrderQty,
      rationale: `${action.rationale}; final executable BUY quantity ${quantity} ${action.target} after exchange quantization`,
    }
    const expectedAssets = applyCandidate(assets, projectedAction, targetPriceUsd, { sourceDebit: quoteOrderQty, targetCredit })
    return { action: projectedAction, sourceDebit: quoteOrderQty, targetCredit, expectedAssets }
  }

  const floorQuantity = quantizeDownForMarket(initialQuote / adversePrice, lot.stepSize, market.baseAssetPrecision)
  if (floorQuantity === null || floorQuantity <= 0) return { rejectionReason: 'The intended BUY amount floors to zero at the exchange step size.' }

  let selected = evaluate(floorQuantity, initialQuote)
  let selectedResults = evaluateRules(selected.expectedAssets, policy)
  const floorSatisfiesTarget = !hasUnresolvedMinimumForTarget(selectedResults, action.target)
  const floorValid = floorQuantity >= lot.minQty
    && floorQuantity <= lot.maxQty
    && initialQuote >= notional.min
    && initialQuote <= notional.max
    && floorSatisfiesTarget

  if (!floorValid) {
    let quantity = floorQuantity >= lot.minQty ? floorQuantity + lot.stepSize : lot.minQty
    let rounded: ReturnType<typeof evaluate> | undefined
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const alignedQuantity = quantizeDownForMarket(quantity, lot.stepSize, market.baseAssetPrecision)
      if (alignedQuantity === null || alignedQuantity <= 0) return { rejectionReason: 'The next valid BUY quantity cannot be represented safely.' }
      const requiredQuote = quantizeUpForPrecision(alignedQuantity * adversePrice, quotePrecision)
      if (requiredQuote === null) return { rejectionReason: 'The next valid BUY quote amount cannot be represented safely.' }
      const actualQuantity = quantizeDownForMarket(requiredQuote / adversePrice, lot.stepSize, market.baseAssetPrecision)
      if (actualQuantity === null || actualQuantity < alignedQuantity) {
        quantity = alignedQuantity + lot.stepSize
        continue
      }
      if (requiredQuote > initialQuote * (1 + executionSafetyConfig.maxRoundUpPct / 100) + 1e-8) return { rejectionReason: 'The exchange step requires a quote increase beyond Rokai’s fixed sizing bound.' }
      if (requiredQuote > sourceFreeValue + 1e-8) return { rejectionReason: 'The next valid BUY quantity exceeds the source FREE balance.' }
      if (actualQuantity < lot.minQty || actualQuantity > lot.maxQty || requiredQuote < notional.min || requiredQuote > notional.max) return { rejectionReason: 'The next valid BUY quantity fails a required Spot exchange filter.' }
      rounded = evaluate(actualQuantity, requiredQuote)
      selectedResults = evaluateRules(rounded.expectedAssets, policy)
      if (hasUnresolvedMinimumForTarget(selectedResults, action.target)) {
        quantity = actualQuantity + lot.stepSize
        continue
      }
      selected = rounded
      break
    }
    if (!rounded || hasUnresolvedMinimumForTarget(selectedResults, action.target)) return { rejectionReason: 'Exchange quantization leaves the target minimum unsatisfied within safe spend limits.' }
  }

  return selected
}

function projectSellCandidate(
  assets: Asset[],
  policy: Policy,
  action: CandidateAction,
  targetPriceUsd: number,
  market: ExchangeSymbolInfo,
): { action: CandidateAction; sourceDebit: number; targetCredit: number; expectedAssets: Asset[] } | { rejectionReason: string } | null {
  const source = findAsset(assets, action.source)
  const baseAsset = market.baseAsset.trim().toUpperCase()
  const quoteAsset = market.quoteAsset.trim().toUpperCase()
  if (baseAsset !== action.source || quoteAsset !== action.target) return null

  const lot = usableSellLotFilter(market)
  if (!lot || lot.minQty === undefined || lot.maxQty === undefined || lot.stepSize === undefined) {
    return { rejectionReason: 'Fresh Spot quantity filters are required to size the SELL safely.' }
  }
  if (!source || !Number.isFinite(action.sourceQuantity) || action.sourceQuantity <= 0) {
    return { rejectionReason: 'The intended SELL quantity is not executable.' }
  }

  const free = freeBalance(source)
  if (action.sourceQuantity > free + epsilon) {
    return { rejectionReason: 'The intended SELL quantity exceeds the source FREE balance.' }
  }
  const notionalBounds = marketNotionalBounds(market)
  const factor = (1 - executionSafetyConfig.feeRate) * (1 - (executionSafetyConfig.slippageBps / 10_000))
  const evaluate = (quantity: number) => {
    const grossNotional = quantity * source.priceUsd
    const targetCredit = (grossNotional * factor) / targetPriceUsd
    const projectedAction: CandidateAction = {
      ...action,
      amountUsd: grossNotional,
      sourceQuantity: quantity,
      rationale: `${action.rationale}; final executable SELL quantity ${quantity} ${action.source} after exchange quantization`,
    }
    const expectedAssets = applyCandidate(assets, projectedAction, targetPriceUsd, { sourceDebit: quantity, targetCredit })
    return {
      action: projectedAction,
      sourceDebit: quantity,
      targetCredit,
      expectedAssets,
      expectedRuleResults: evaluateRules(expectedAssets, policy),
      grossNotional,
    }
  }

  const intended = evaluate(action.sourceQuantity)
  const intendedPasses = intended.expectedRuleResults.map((result) => result.passed)
  const preservesPlannedPasses = (candidate: ReturnType<typeof evaluate>) => candidate.expectedRuleResults.every(
    (result, index) => !intendedPasses[index] || result.passed,
  )
  const isExchangeValid = (candidate: ReturnType<typeof evaluate>) => candidate.sourceDebit >= lot.minQty!
    && candidate.sourceDebit <= lot.maxQty!
    && candidate.sourceDebit <= free + epsilon
    && candidate.grossNotional >= notionalBounds.min
    && candidate.grossNotional <= notionalBounds.max
  const isValid = (candidate: ReturnType<typeof evaluate>) => isExchangeValid(candidate)
    && preservesPlannedPasses(candidate)

  const floorQuantity = quantizeDownForMarket(action.sourceQuantity, lot.stepSize, market.baseAssetPrecision)
  if (floorQuantity === null || floorQuantity <= 0) return { rejectionReason: 'The intended SELL amount floors to zero at the exchange step size.' }

  let selected = evaluate(floorQuantity)
  if (!isValid(selected)) {
    let quantity = floorQuantity >= lot.minQty ? floorQuantity + lot.stepSize : lot.minQty
    let rounded: ReturnType<typeof evaluate> | undefined
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const alignedQuantity = quantizeDownForMarket(quantity, lot.stepSize, market.baseAssetPrecision)
      if (alignedQuantity === null || alignedQuantity <= 0) return { rejectionReason: 'The next valid SELL quantity cannot be represented safely.' }
      if (alignedQuantity > free + epsilon) return { rejectionReason: 'The next valid SELL quantity exceeds the source FREE balance.' }
      if (alignedQuantity > action.sourceQuantity * (1 + executionSafetyConfig.maxRoundUpPct / 100) + epsilon) {
        return { rejectionReason: 'The exchange step requires a SELL increase beyond Rokai’s fixed sizing bound.' }
      }

      const candidate = evaluate(alignedQuantity)
      if (isValid(candidate)) {
        rounded = candidate
        break
      }
      quantity = alignedQuantity + lot.stepSize
    }
    if (!rounded) {
      if (floorQuantity * source.priceUsd < notionalBounds.min) {
        return { rejectionReason: 'The final quantized SELL quantity is below Binance minimum notional and no safe next step is available.' }
      }
      return { rejectionReason: 'Exchange quantization would lose a planned policy improvement within safe SELL limits.' }
    }
    selected = rounded
  }

  return selected
}

function targetPrice(assets: Asset[], target: string, options: NextTradePlannerOptions): number | null {
  const existing = findAsset(assets, target)
  if (existing) return existing.priceUsd
  if (stablecoinSymbols.has(target)) return 1
  const configured = options.referencePricesUsd?.[target]
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : null
}

function hasFundingSource(assets: Asset[], target: string, protectedSet: Set<string>): boolean {
  return assets.some((asset) => asset.symbol !== target && !protectedSet.has(asset.symbol) && freeBalance(asset) * asset.priceUsd > epsilon)
}

function keepsFeasiblePath(assets: Asset[], policy: Policy, stableTarget: string | null): boolean {
  const protectedSet = protectedSymbols(policy)
  const results = evaluateRules(assets, policy)

  for (const result of results) {
    if (result.passed) continue
    const rule = result.rule
    if (rule.kind === 'min_stablecoin' || rule.kind === 'min_stablecoin_amount') {
      if (!stableTarget || !findAsset(assets, rule.asset) || !hasFundingSource(assets, rule.asset, protectedSet)) return false
    }
    if (rule.kind === 'min_asset_allocation') {
      if (!hasFundingSource(assets, rule.asset, protectedSet)) return false
    }
    if (rule.kind === 'max_asset_exposure') {
      if (!stableTarget || !findAsset(assets, stableTarget)) return false
      const violating = matchingAssets(assets, rule).filter((asset) => {
        const total = valuePortfolio(assets).totalUsd
        return total > 0 && (asset.quantity * asset.priceUsd / total) * 100 > rule.maxPct + epsilon
      })
      if (violating.some((asset) => protectedSet.has(asset.symbol) || freeBalance(asset) <= epsilon)) return false
    }
  }
  return true
}

function targetNeed(
  assets: Asset[],
  policy: Policy,
  target: string,
  totalUsd: number,
  planningBufferPct: number,
  planningBufferUsd: number,
): { amountUsd: number; rationale: string } {
  const targetAsset = findAsset(assets, target)
  const currentValue = targetAsset ? targetAsset.quantity * targetAsset.priceUsd : 0
  let amountUsd = 0
  const reasons: string[] = []

  for (const rule of policy.rules) {
    if (rule.asset !== target) continue
    if (rule.kind === 'min_stablecoin' || rule.kind === 'min_asset_allocation') {
      const requiredValue = ((rule.minPct + planningBufferPct) / 100) * totalUsd
      const needed = Math.max(0, requiredValue - currentValue)
      if (needed > amountUsd) amountUsd = needed
      if (needed > 0) reasons.push(`raise ${target} beyond ${rule.minPct}%`)
    }
    if (rule.kind === 'min_stablecoin_amount') {
      const needed = Math.max(0, rule.minAmount + planningBufferUsd - currentValue)
      if (needed > amountUsd) amountUsd = needed
      if (needed > 0) reasons.push(`keep more than ${rule.minAmount} ${target}`)
    }
  }

  return { amountUsd, rationale: reasons.join(' and ') || `fund ${target}` }
}

function buildNeeds(
  assets: Asset[],
  policy: Policy,
  results: RuleResult[],
  totalUsd: number,
  planningBufferPct: number,
  planningBufferUsd: number,
): { needs: Need[]; error?: string } {
  const stableTarget = stableTargetSymbol(assets, policy)
  const needMap = new Map<string, Need>()
  const addNeed = (target: string, amountUsd: number, rationale: string, priority: number) => {
    if (!Number.isFinite(amountUsd) || amountUsd <= epsilon) return
    const previous = needMap.get(target)
    if (!previous) {
      needMap.set(target, { target, amountUsd, rationale, priority })
      return
    }
    needMap.set(target, {
      target,
      amountUsd: Math.max(previous.amountUsd, amountUsd),
      rationale: `${previous.rationale}; ${rationale}`,
      priority: Math.max(previous.priority, priority),
    })
  }

  if (policy.rules.some((rule) => rule.kind === 'max_asset_exposure') && results.some((result) => !result.passed && result.rule.kind === 'max_asset_exposure') && !stableTarget) {
    return { needs: [], error: 'A unique stablecoin destination is required to reduce asset exposure safely.' }
  }

  let stableFundingForMinimums = 0
  for (const result of results) {
    if (result.passed) continue
    if (result.rule.kind === 'min_asset_allocation' && result.rule.asset !== stableTarget) {
      const targetAsset = findAsset(assets, result.rule.asset)
      const requiredValue = ((result.rule.minPct + planningBufferPct) / 100) * totalUsd
      stableFundingForMinimums += Math.max(0, requiredValue - (targetAsset?.quantity ?? 0) * (targetAsset?.priceUsd ?? 0))
    }
  }

  if (stableTarget) {
    const stableNeed = targetNeed(assets, policy, stableTarget, totalUsd, planningBufferPct, planningBufferUsd)
    if (stableFundingForMinimums > 0) {
      stableNeed.amountUsd += stableFundingForMinimums
      stableNeed.rationale = `${stableNeed.rationale}; reserve settlement funding for unresolved minimum allocations`
    }
    addNeed(stableTarget, stableNeed.amountUsd, stableNeed.rationale, 3)
  }

  for (const result of results) {
    if (result.passed) continue
    const rule = result.rule
    if (rule.kind === 'min_asset_allocation') {
      const need = targetNeed(assets, policy, rule.asset, totalUsd, planningBufferPct, planningBufferUsd)
      addNeed(rule.asset, need.amountUsd, need.rationale, 3)
    }
    if (rule.kind === 'max_asset_exposure') {
      if (!stableTarget) continue
      const maxValue = ((Math.max(0, rule.maxPct - planningBufferPct)) / 100) * totalUsd
      for (const asset of matchingAssets(assets, rule)) {
        const amountToTrim = Math.max(0, asset.quantity * asset.priceUsd - maxValue)
        if (amountToTrim <= epsilon) continue
        const stableNeed = targetNeed(assets, policy, stableTarget, totalUsd, planningBufferPct, planningBufferUsd)
        addNeed(
          stableTarget,
          Math.max(amountToTrim, stableNeed.amountUsd + stableFundingForMinimums),
          `trim ${asset.symbol} below ${rule.maxPct}%`,
          2,
        )
      }
    }
  }

  return { needs: [...needMap.values()].sort((a, b) => b.priority - a.priority || a.target.localeCompare(b.target)) }
}

function candidateSort(a: CandidateEvaluation, b: CandidateEvaluation): number {
  return a.summary.scoreAfter - b.summary.scoreAfter
    || b.summary.scoreBefore - b.summary.scoreAfter - (a.summary.scoreBefore - a.summary.scoreAfter)
    || b.rulesImproved - a.rulesImproved
    || a.summary.amountUsd - b.summary.amountUsd
    || a.summary.source.localeCompare(b.summary.source)
    || a.summary.target.localeCompare(b.summary.target)
}

export function planNextTrade(
  inputAssets: Asset[],
  inputPolicy: Policy,
  options: NextTradePlannerOptions = {},
): NextTradeDecision {
  const normalized = normalizeInput(inputAssets, inputPolicy)
  if (normalized.error || !normalized.value) {
    return plannerDecision({ status: 'STOP', reason: normalized.error ?? 'Unable to normalize portfolio policy.', ruleResults: [], candidatesConsidered: [] })
  }

  const { assets, policy } = normalized.value
  const results = evaluateRules(assets, policy)
  if (results.every((result) => result.passed)) return plannerDecision({ status: 'COMPLETE', ruleResults: results })

  const totalUsd = valuePortfolio(assets).totalUsd
  if (!Number.isFinite(totalUsd) || totalUsd <= epsilon) {
    return plannerDecision({ status: 'STOP', reason: 'A non-zero portfolio is required to plan a safe next trade.', ruleResults: results, candidatesConsidered: [] })
  }

  const planningBufferPct = planningSafetyConfig.bufferPct
  const planningBufferUsd = planningSafetyConfig.bufferUsd
  const needsResult = buildNeeds(assets, policy, results, totalUsd, planningBufferPct, planningBufferUsd)
  if (needsResult.error) return plannerDecision({ status: 'STOP', reason: needsResult.error, ruleResults: results, candidatesConsidered: [] })
  if (needsResult.needs.length === 0) return plannerDecision({ status: 'STOP', reason: 'No useful corrective target was found.', ruleResults: results, candidatesConsidered: [] })

  const beforeScore = calculateViolationScore(assets, policy)
  const protectedSet = protectedSymbols(policy)
  const stableTarget = stableTargetSymbol(assets, policy)
  const candidates: CandidateEvaluation[] = []
  const summaries: CandidateSummary[] = []
  const seenCandidates = new Set<string>()
  const settlementAsset = options.settlementAsset?.trim().toUpperCase()

  for (const need of needsResult.needs) {
    const targetPriceUsd = targetPrice(assets, need.target, options)
    for (const source of assets) {
      if (source.symbol === need.target) continue
      const requestedAmount = need.amountUsd
      const sourceFreeValue = freeBalance(source) * source.priceUsd
      const baseAction: CandidateAction = {
        source: source.symbol,
        target: need.target,
        amountUsd: Math.min(requestedAmount, sourceFreeValue),
        sourceQuantity: sourceFreeValue > epsilon ? Math.min(requestedAmount, sourceFreeValue) / source.priceUsd : 0,
        rationale: need.rationale,
      }
      const key = `${baseAction.source}|${baseAction.target}|${baseAction.amountUsd.toFixed(8)}`
      if (seenCandidates.has(key)) continue
      seenCandidates.add(key)

      if (settlementAsset && source.symbol !== settlementAsset && need.target !== settlementAsset) {
        summaries.push({ ...baseAction, scoreBefore: beforeScore, scoreAfter: beforeScore, improves: false, accepted: false, rejectionReason: 'The candidate is not a direct pair aligned to the settlement asset.' })
        continue
      }

      if (targetPriceUsd === null) {
        summaries.push({ ...baseAction, scoreBefore: beforeScore, scoreAfter: beforeScore, improves: false, accepted: false, rejectionReason: `No live price is available for target ${need.target}.` })
        continue
      }
      if (protectedSet.has(source.symbol)) {
        summaries.push({ ...baseAction, scoreBefore: beforeScore, scoreAfter: beforeScore, improves: false, accepted: false, rejectionReason: 'The source asset is protected and cannot be sold.' })
        continue
      }
      if (sourceFreeValue <= epsilon) {
        summaries.push({ ...baseAction, scoreBefore: beforeScore, scoreAfter: beforeScore, improves: false, accepted: false, rejectionReason: 'The source has no sufficient FREE balance.' })
        continue
      }
      if (baseAction.amountUsd <= epsilon || !Number.isFinite(baseAction.sourceQuantity)) {
        summaries.push({ ...baseAction, scoreBefore: beforeScore, scoreAfter: beforeScore, improves: false, accepted: false, rejectionReason: 'The candidate amount is not executable.' })
        continue
      }

      let action = baseAction
      let projection: { sourceDebit: number; targetCredit: number } | undefined
      if (options.market) {
        const marketBase = options.market.baseAsset.trim().toUpperCase()
        const marketQuote = options.market.quoteAsset.trim().toUpperCase()
        const projected = marketBase === baseAction.target && marketQuote === baseAction.source
          ? projectBuyCandidate(assets, policy, results, baseAction, targetPriceUsd, options.market)
          : marketBase === baseAction.source && marketQuote === baseAction.target
            ? projectSellCandidate(assets, policy, baseAction, targetPriceUsd, options.market)
            : null
        if (projected && 'rejectionReason' in projected) {
          summaries.push({
            ...baseAction,
            scoreBefore: beforeScore,
            scoreAfter: beforeScore,
            improves: false,
            accepted: false,
            rejectionReason: projected.rejectionReason,
          })
          continue
        }
        if (projected) {
          action = projected.action
          projection = { sourceDebit: projected.sourceDebit, targetCredit: projected.targetCredit }
        }
      }

      const expectedAssets = applyCandidate(assets, action, targetPriceUsd, projection)
      const expectedResults = evaluateRules(expectedAssets, policy)
      const afterScore = calculateViolationScore(expectedAssets, policy)
      const breaksSatisfiedHardRule = results.some((result, index) => result.passed && !expectedResults[index].passed)
      const improves = afterScore < beforeScore - epsilon
      const feasible = keepsFeasiblePath(expectedAssets, policy, stableTarget)
      const rulesImproved = results.reduce((count, result, index) => count + (!result.passed && expectedResults[index].passed ? 1 : 0), 0)
      let rejectionReason: string | undefined
      if (breaksSatisfiedHardRule) rejectionReason = 'The candidate would break a currently satisfied hard rule.'
      else if (!improves) rejectionReason = 'The candidate does not improve the aggregate violation score.'
      else if (!feasible) rejectionReason = 'The candidate would leave no feasible path for an unresolved rule.'

      const summary: CandidateSummary = {
        ...action,
        scoreBefore: beforeScore,
        scoreAfter: afterScore,
        improves,
        accepted: !rejectionReason,
        ...(rejectionReason ? { rejectionReason } : {}),
      }
      summaries.push(summary)
      if (!rejectionReason) candidates.push({ action, summary, expectedAssets, expectedRuleResults: expectedResults, rulesImproved, priority: need.priority })
    }
  }

  if (candidates.length === 0) {
    return plannerDecision({ status: 'STOP', reason: 'No safe improving next trade is available.', ruleResults: results, candidatesConsidered: summaries })
  }

  candidates.sort(candidateSort)
  const selected = candidates[0]
  return plannerDecision({
    status: 'READY',
    runId: makeRunId(assets, policy, Date.now(), options.runId),
    step: 1,
    ruleResults: results,
    candidatesConsidered: summaries,
    nextTrade: selected.action,
    expectedRuleResults: selected.expectedRuleResults,
    violationScoreBefore: selected.summary.scoreBefore,
    violationScoreExpected: selected.summary.scoreAfter,
  })
}

export const buildNextTradeDecision = planNextTrade
