import assert from 'node:assert/strict'
import { planNextTrade, type NextTradeDecision } from '../src/nextTradePlanner.ts'
import type { Asset } from '../src/mockData.ts'
import { evaluateRules, type Policy, type Rule } from '../src/rules.ts'
import type { ExchangeSymbolInfo } from '../src/execution.ts'

function asset(symbol: string, quantity: number, kind: Asset['kind'], options: Partial<Asset> = {}): Asset {
  return {
    symbol,
    name: symbol,
    quantity,
    free: options.free ?? quantity,
    locked: options.locked ?? 0,
    priceUsd: options.priceUsd ?? 1,
    change24h: 0,
    kind,
  }
}

function policy(...rules: Rule[]): Policy {
  return { rules, sourceText: 'test policy' }
}

function ready(decision: NextTradeDecision) {
  assert.equal(decision.status, 'READY')
  if (decision.status !== 'READY') throw new Error('Expected a READY decision')
  return decision
}

const bnbMarket: ExchangeSymbolInfo = {
  symbol: 'BNBUSDT',
  baseAsset: 'BNB',
  quoteAsset: 'USDT',
  status: 'TRADING',
  isSpotTradingAllowed: true,
  permissions: ['SPOT'],
  quoteOrderQtyMarketAllowed: true,
  baseAssetPrecision: 8,
  quoteAssetPrecision: 8,
  filters: [
    { filterType: 'MARKET_LOT_SIZE', minQty: 0, maxQty: 0, stepSize: 0 },
    { filterType: 'LOT_SIZE', minQty: 0.001, maxQty: 900_000, stepSize: 0.001 },
    { filterType: 'NOTIONAL', minNotional: 5, applyMinToMarket: true },
  ],
}

const fundedPolicy = policy(
  { kind: 'min_asset_allocation', asset: 'BNB', minPct: 55 },
  { kind: 'min_stablecoin', asset: 'USDT', minPct: 40 },
  { kind: 'protected_asset', asset: 'BNB' },
  { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 60 },
  { kind: 'min_stablecoin_amount', asset: 'USDT', minAmount: 4 },
)

const funded55 = ready(planNextTrade(
  [asset('USDT', 12, 'stablecoin')],
  fundedPolicy,
  { runId: 'funded-55-quantized-fixture', settlementAsset: 'USDT', referencePricesUsd: { BNB: 754 }, market: bnbMarket },
))
assert.equal(funded55.nextTrade.source, 'USDT')
assert.equal(funded55.nextTrade.target, 'BNB')
assert.equal(funded55.nextTrade.sourceQuantity, 6.792786)
assert.match(funded55.nextTrade.rationale, /final executable BUY quantity 0\.009 BNB/i)
assert.equal(funded55.expectedRuleResults.find((result) => result.rule.kind === 'min_asset_allocation')?.passed, true)

const funded50Policy = policy(
  { kind: 'min_asset_allocation', asset: 'BNB', minPct: 50 },
  { kind: 'min_stablecoin', asset: 'USDT', minPct: 40 },
  { kind: 'protected_asset', asset: 'BNB' },
  { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 60 },
  { kind: 'min_stablecoin_amount', asset: 'USDT', minAmount: 4 },
)
const funded50 = ready(planNextTrade(
  [asset('USDT', 12, 'stablecoin')],
  funded50Policy,
  { runId: 'funded-50-quantized-fixture', settlementAsset: 'USDT', referencePricesUsd: { BNB: 754 }, market: bnbMarket },
))
assert.equal(funded50.nextTrade.sourceQuantity, 6.06)
assert.match(funded50.nextTrade.rationale, /final executable BUY quantity 0\.008 BNB/i)
assert.equal(funded50.expectedRuleResults.find((result) => result.rule.kind === 'min_asset_allocation')?.passed, true)

const resetPolicy = policy(
  { kind: 'min_stablecoin', asset: 'USDT', minPct: 90 },
  { kind: 'max_asset_exposure', asset: 'BNB', maxPct: 10 },
  { kind: 'protected_asset', asset: 'USDT' },
  { kind: 'min_stablecoin_amount', asset: 'USDT', minAmount: 10 },
)

for (const price of [743, 755]) {
  const reset = ready(planNextTrade(
    [asset('USDT', 5.97624, 'stablecoin'), asset('BNB', 0.007994, 'core', { priceUsd: price })],
    resetPolicy,
    { runId: `reset-sell-${price}`, settlementAsset: 'USDT', market: bnbMarket },
  ))
  assert.equal(reset.nextTrade.source, 'BNB')
  assert.equal(reset.nextTrade.target, 'USDT')
  assert.equal(reset.nextTrade.sourceQuantity, 0.007, 'SELL sizing uses the next valid lot after flooring')
  assert.ok(reset.nextTrade.amountUsd >= 5, 'final quantized SELL meets minimum notional')
  assert.match(reset.nextTrade.rationale, /final executable SELL quantity 0\.007 BNB/i)
  assert.equal(reset.violationScoreExpected, 0, 'expected score uses the final executable quantity')
  assert.ok(reset.expectedRuleResults.every((result) => result.passed))
}

const resetStepUp = ready(planNextTrade(
  [asset('USDT', 5.97624, 'stablecoin'), asset('BNB', 0.007994, 'core', { priceUsd: 743.82 })],
  resetPolicy,
  { runId: 'reset-step-up', settlementAsset: 'USDT', market: bnbMarket },
))
assert.ok(0.006 * 743.82 < 5, 'the floored .006 BNB candidate is below minimum notional')
assert.ok(0.007 * 743.82 >= 5, 'the next .001 BNB step satisfies minimum notional')
assert.equal(resetStepUp.nextTrade.sourceQuantity, 0.007)

const insufficientNextStep = planNextTrade(
  [asset('USDT', 5.97624, 'stablecoin'), asset('BNB', 0.007994, 'core', { priceUsd: 743.82 })],
  resetPolicy,
  {
    runId: 'reset-next-step-too-large',
    settlementAsset: 'USDT',
    market: {
      ...bnbMarket,
      filters: bnbMarket.filters?.map((filter) => filter.filterType === 'NOTIONAL' ? { ...filter, minNotional: 5.3 } : filter),
    },
  },
)
assert.equal(insufficientNextStep.status, 'STOP')
assert.ok(insufficientNextStep.status === 'STOP' && insufficientNextStep.candidatesConsidered.some((candidate) => /FREE balance/i.test(candidate.rejectionReason ?? '')))

const protectedReset = planNextTrade(
  [asset('USDT', 5.97624, 'stablecoin'), asset('BNB', 0.007994, 'core', { priceUsd: 743.82 })],
  policy(...resetPolicy.rules, { kind: 'protected_asset', asset: 'BNB' }),
  { runId: 'reset-protected-bnb', settlementAsset: 'USDT', market: bnbMarket },
)
assert.equal(protectedReset.status, 'STOP')
assert.ok(protectedReset.status === 'STOP' && protectedReset.candidatesConsidered.some((candidate) => /protected/i.test(candidate.rejectionReason ?? '')))

const observedAfterFill = evaluateRules([
  asset('USDT', 5.97624, 'stablecoin'),
  asset('BNB', 0.007994, 'core', { priceUsd: 752.97 }),
], fundedPolicy)
assert.equal(observedAfterFill.find((result) => result.rule.kind === 'min_asset_allocation')?.passed, false)
const observed50AfterFill = evaluateRules([
  asset('USDT', 5.97624, 'stablecoin'),
  asset('BNB', 0.007994, 'core', { priceUsd: 752.97 }),
], funded50Policy)
assert.equal(observed50AfterFill.find((result) => result.rule.kind === 'min_asset_allocation')?.passed, true)

const allSatisfied = planNextTrade(
  [asset('USDC', 60, 'stablecoin'), asset('BTC', 40, 'core')],
  policy(
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
    { kind: 'protected_asset', asset: 'BTC' },
    { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 60 },
  ),
  { now: 1_000, runId: 'complete-fixture' },
)
assert.equal(allSatisfied.status, 'COMPLETE')

const oneRule = ready(planNextTrade(
  [asset('USDC', 20, 'stablecoin'), asset('SOL', 80, 'altcoin')],
  policy({ kind: 'min_stablecoin', asset: 'USDC', minPct: 40 }),
  { now: 1_000, runId: 'one-rule-fixture' },
))
assert.equal(oneRule.nextTrade.source, 'SOL')
assert.equal(oneRule.nextTrade.target, 'USDC')
assert.ok(oneRule.nextTrade.amountUsd > 20)
assert.ok(oneRule.violationScoreExpected < oneRule.violationScoreBefore)
assert.equal(oneRule.expectedRuleResults[0].passed, true)

const twoStep = ready(planNextTrade(
  [asset('SOL', 10, 'altcoin'), asset('USDC', 0, 'stablecoin'), asset('BTC', 0, 'core', { priceUsd: 1 })],
  policy(
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
    { kind: 'min_stablecoin_amount', asset: 'USDC', minAmount: 4 },
    { kind: 'min_asset_allocation', asset: 'BTC', minPct: 20 },
    { kind: 'protected_asset', asset: 'BTC' },
    { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 60 },
  ),
  { now: 1_000, runId: 'lookahead-fixture' },
))
assert.equal(twoStep.nextTrade.source, 'SOL')
assert.equal(twoStep.nextTrade.target, 'USDC')
assert.ok(twoStep.nextTrade.amountUsd > 6.5, 'first step reserves settlement funding for BTC')
assert.match(twoStep.nextTrade.rationale, /settlement funding/i)
assert.equal(twoStep.expectedRuleResults.find((result) => result.rule.kind === 'min_asset_allocation')?.passed, false)
assert.ok(twoStep.violationScoreExpected < twoStep.violationScoreBefore)

const zeroTarget = ready(planNextTrade(
  [asset('SOL', 10, 'altcoin')],
  policy(
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
    { kind: 'min_asset_allocation', asset: 'BTC', minPct: 20 },
    { kind: 'protected_asset', asset: 'BTC' },
  ),
  { runId: 'zero-target-fixture', settlementAsset: 'USDC' },
))
assert.equal(zeroTarget.nextTrade.source, 'SOL')
assert.equal(zeroTarget.nextTrade.target, 'USDC')
assert.ok(zeroTarget.nextTrade.amountUsd > 0)

const specificMaximum = ready(planNextTrade(
  [asset('SOL', 80, 'altcoin'), asset('USDC', 20, 'stablecoin')],
  policy({ kind: 'max_asset_exposure', asset: 'SOL', maxPct: 60 }),
  { now: 1_000, runId: 'specific-max-fixture' },
))
assert.equal(specificMaximum.nextTrade.source, 'SOL')
assert.equal(specificMaximum.nextTrade.target, 'USDC')
assert.equal(specificMaximum.expectedRuleResults[0].passed, true)

const fixedMinimum = ready(planNextTrade(
  [asset('USDC', 0, 'stablecoin'), asset('SOL', 2_000, 'altcoin')],
  policy({ kind: 'min_stablecoin_amount', asset: 'USDC', minAmount: 1_000 }),
  { now: 1_000, runId: 'fixed-minimum-fixture' },
))
assert.equal(fixedMinimum.nextTrade.source, 'SOL')
assert.equal(fixedMinimum.nextTrade.target, 'USDC')
assert.ok(fixedMinimum.nextTrade.amountUsd > 1_000)
assert.equal(fixedMinimum.expectedRuleResults[0].passed, true)

const protectedSource = planNextTrade(
  [asset('BTC', 10, 'core'), asset('USDC', 0, 'stablecoin')],
  policy(
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
    { kind: 'protected_asset', asset: 'BTC' },
  ),
)
assert.equal(protectedSource.status, 'STOP')
assert.ok(protectedSource.status === 'STOP' && protectedSource.candidatesConsidered.some((candidate) => /protected/i.test(candidate.rejectionReason ?? '')))
assert.ok(protectedSource.status === 'STOP' && !protectedSource.candidatesConsidered.some((candidate) => candidate.accepted))

const lockedSource = planNextTrade(
  [asset('SOL', 10, 'altcoin', { free: 0, locked: 10 }), asset('USDC', 0, 'stablecoin')],
  policy({ kind: 'min_stablecoin', asset: 'USDC', minPct: 40 }),
)
assert.equal(lockedSource.status, 'STOP')
assert.ok(lockedSource.status === 'STOP' && lockedSource.candidatesConsidered.some((candidate) => candidate.source === 'SOL' && /FREE/i.test(candidate.rejectionReason ?? '')))

const satisfiedRuleBreak = planNextTrade(
  [asset('USDC', 40, 'stablecoin'), asset('BTC', 0, 'core'), asset('SOL', 60, 'altcoin', { free: 0, locked: 60 })],
  policy(
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
    { kind: 'min_asset_allocation', asset: 'BTC', minPct: 20 },
  ),
)
assert.equal(satisfiedRuleBreak.status, 'STOP')
assert.ok(satisfiedRuleBreak.status === 'STOP' && satisfiedRuleBreak.candidatesConsidered.some((candidate) => /satisfied hard rule/i.test(candidate.rejectionReason ?? '')))

const duplicatePolicy = planNextTrade(
  [asset('USDC', 0, 'stablecoin'), asset('SOL', 100, 'altcoin')],
  policy(
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
  ),
)
assert.equal(duplicatePolicy.status, 'STOP')
assert.match(duplicatePolicy.status === 'STOP' ? duplicatePolicy.reason : '', /duplicate/i)

const unsupportedPolicy = planNextTrade(
  [asset('USDC', 0, 'stablecoin'), asset('SOL', 100, 'altcoin')],
  { rules: [{ kind: 'futures_exposure', asset: 'BTC', maxPct: 20 } as never], sourceText: 'unsupported' },
)
assert.equal(unsupportedPolicy.status, 'STOP')
assert.match(unsupportedPolicy.status === 'STOP' ? unsupportedPolicy.reason : '', /unsupported|malformed/i)

const oneTradeOnly = ready(planNextTrade(
  [asset('USDC', 0, 'stablecoin'), asset('SOL', 100, 'altcoin'), asset('BNB', 100, 'altcoin')],
  policy({ kind: 'min_stablecoin', asset: 'USDC', minPct: 40 }),
  { now: 1_000, runId: 'one-trade-only-fixture' },
))
assert.ok(['SOL', 'BNB'].includes(oneTradeOnly.nextTrade.source))
assert.equal(oneTradeOnly.status, 'READY')
assert.equal(oneTradeOnly.step, 1)

console.log('next-trade planner fixtures passed')
