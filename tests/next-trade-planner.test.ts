import assert from 'node:assert/strict'
import { planNextTrade, type NextTradeDecision } from '../src/nextTradePlanner.ts'
import type { Asset } from '../src/mockData.ts'
import type { Policy, Rule } from '../src/rules.ts'

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
