import assert from 'node:assert/strict'
import { normalizeStructuredPolicy } from '../src/policyParser.ts'
import { applyPlan, buildPlan, evaluateRules, parseDemoPolicy } from '../src/rules.ts'
import { cloneMockAssets } from '../src/mockData.ts'
import { detectExpectedRuleTypes, missingRuleTypes, parseWithGemini } from '../server/geminiPolicyApi.ts'

function rulesFor(value: unknown) {
  const result = normalizeStructuredPolicy(value, 'fixture')
  assert.ok(result.policy, result.error)
  return result.policy.rules
}

assert.deepEqual(rulesFor({ minStablecoinPercent: 40, minStablecoinAsset: 'USDC' }), [
  { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
])

assert.deepEqual(rulesFor({ protectedAssets: ['btc'] }), [
  { kind: 'protected_asset', asset: 'BTC' },
])

assert.deepEqual(rulesFor({ maxAssetPercent: 20 }), [
  { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 20 },
])

assert.deepEqual(rulesFor({ minStablecoinAmount: { asset: 'USDC', minAmount: 1000 } }), [
  { kind: 'min_stablecoin_amount', asset: 'USDC', minAmount: 1000 },
])

assert.deepEqual(rulesFor({ minAssetAllocation: { asset: 'BTC', minPct: 20 } }), [
  { kind: 'min_asset_allocation', asset: 'BTC', minPct: 20 },
])

const combinedStructured = {
  minStablecoinPercent: 40,
  minStablecoinAsset: 'USDC',
  minStablecoinAmount: { asset: 'USDC', minAmount: 1000 },
  protectedAssets: ['BTC'],
  minAssetAllocation: { asset: 'BTC', minPct: 20 },
  maxAssetPercent: 20,
}
const combinedText = 'Keep at least 40% in USDC, always keep 1,000 USDC, never sell BTC, keep BTC above 20%, and no altcoin above 20%.'
assert.deepEqual(rulesFor(combinedStructured), [
  { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
  { kind: 'min_stablecoin_amount', asset: 'USDC', minAmount: 1000 },
  { kind: 'min_asset_allocation', asset: 'BTC', minPct: 20 },
  { kind: 'protected_asset', asset: 'BTC' },
  { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 20 },
])
assert.deepEqual(detectExpectedRuleTypes(combinedText), ['minStablecoinPercent', 'protectedAssets', 'maxAssetPercent', 'minStablecoinAmount', 'minAssetAllocation'])
assert.deepEqual(missingRuleTypes(combinedText, { minStablecoinPercent: 40, minStablecoinAsset: 'USDC' }), ['protectedAssets', 'maxAssetPercent', 'minStablecoinAmount', 'minAssetAllocation'])

const minimumAmount = parseDemoPolicy('Always keep at least 1,000 USDC.').policy
assert.deepEqual(minimumAmount?.rules, [{ kind: 'min_stablecoin_amount', asset: 'USDC', minAmount: 1000 }])

const minimumAllocation = parseDemoPolicy('Keep at least 20% in BTC.').policy
assert.deepEqual(minimumAllocation?.rules, [{ kind: 'min_asset_allocation', asset: 'BTC', minPct: 20 }])

const combinedFallback = parseDemoPolicy('Keep at least 40% in USDC, always keep 1,000 USDC, never sell BTC, keep BTC above 20%, and no altcoin above 20%.').policy
assert.deepEqual(combinedFallback?.rules, combinedStructuredToRules())

assert.ok(parseDemoPolicy('Keep at least 40% in USDC.').policy)
assert.ok(parseDemoPolicy('Never sell BTC.').policy)
assert.ok(parseDemoPolicy('No altcoin above 20%.').policy)
assert.ok(parseDemoPolicy("Keep 40% in USDC, never sell BTC, and no altcoin above 20%.").policy)
assert.equal(parseDemoPolicy('Buy more ETH whenever the market dips.').policy, null)
assert.equal(parseDemoPolicy('Always keep at least 1,000 BTC.').policy, null)

const originalFetch = globalThis.fetch
const geminiResponse = (structured: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
let retryCalls = 0
globalThis.fetch = async () => {
  retryCalls += 1
  return geminiResponse(retryCalls === 1 ? { minStablecoinPercent: 40, minStablecoinAsset: 'USDC' } : combinedStructured)
}
const retriedPolicy = await parseWithGemini(combinedText, 'test-key', 'test-model')
assert.equal(retryCalls, 2)
assert.deepEqual(retriedPolicy, combinedStructured)

let failedRetryCalls = 0
globalThis.fetch = async () => {
  failedRetryCalls += 1
  return geminiResponse({ minStablecoinPercent: 40, minStablecoinAsset: 'USDC' })
}
await assert.rejects(() => parseWithGemini(combinedText, 'test-key', 'test-model'), /incomplete policy after retry/)
assert.equal(failedRetryCalls, 2)
globalThis.fetch = originalFetch

const mockAssets = cloneMockAssets()
const amountResult = evaluateRules(mockAssets, minimumAmount!)
assert.equal(amountResult[0].passed, false)
assert.equal(amountResult[0].currentAmountUsd, 820)

const allocationResult = evaluateRules(mockAssets, minimumAllocation!)
assert.equal(allocationResult[0].passed, false)
assert.equal(allocationResult[0].currentPct?.toFixed(1), '14.6')

const combinedPlan = buildPlan(mockAssets, normalizeStructuredPolicy(combinedStructured, 'fixture').policy!)
assert.equal(combinedPlan.safe, true)
assert.ok(combinedPlan.actions.some((action) => action.target === 'BTC'))
assert.ok(combinedPlan.actions.some((action) => action.target === 'USDC'))
assert.ok(evaluateRules(applyPlan(mockAssets, combinedPlan), normalizeStructuredPolicy(combinedStructured, 'fixture').policy!).every((result) => result.passed))

for (const invalid of [
  { minStablecoinPercent: 101 },
  { maxAssetPercent: -1 },
  { minStablecoinAmount: { asset: 'BTC', minAmount: 1000 } },
  { minStablecoinAmount: { asset: 'USDC', minAmount: -1 } },
  { minAssetAllocation: { asset: 'BTC', minPct: 101 } },
  { minAssetAllocation: { asset: 'BTC' } },
  { protectedAssets: ['BTC/USD'] },
  { unsupportedRule: 20 },
  { ambiguous: true, reason: 'Conflicting constraints.' },
  {},
]) {
  assert.equal(normalizeStructuredPolicy(invalid, 'fixture').policy, null)
}

console.log('policy parser fixtures passed')

function combinedStructuredToRules() {
  return [
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
    { kind: 'min_stablecoin_amount', asset: 'USDC', minAmount: 1000 },
    { kind: 'min_asset_allocation', asset: 'BTC', minPct: 20 },
    { kind: 'protected_asset', asset: 'BTC' },
    { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 20 },
  ]
}
