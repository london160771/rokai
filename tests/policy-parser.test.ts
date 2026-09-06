import assert from 'node:assert/strict'
import { normalizeStructuredPolicy } from '../src/policyParser.ts'
import { parseDemoPolicy } from '../src/rules.ts'

function rulesFor(text: string) {
  const result = normalizeStructuredPolicy(text, 'fixture')
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

assert.deepEqual(rulesFor({ minStablecoinPercent: 40, minStablecoinAsset: 'USDC', protectedAssets: ['BTC'], maxAssetPercent: 20 }), [
  { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
  { kind: 'protected_asset', asset: 'BTC' },
  { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 20 },
])

assert.ok(parseDemoPolicy('Keep at least 40% in USDC.') .policy)
assert.ok(parseDemoPolicy('Never sell BTC.').policy)
assert.ok(parseDemoPolicy('No altcoin above 20%.').policy)
assert.ok(parseDemoPolicy("Keep 40% in USDC, never sell BTC, and no altcoin above 20%.").policy)
assert.equal(parseDemoPolicy('Buy more ETH whenever the market dips.').policy, null)

for (const invalid of [
  { minStablecoinPercent: 101 },
  { maxAssetPercent: -1 },
  { protectedAssets: ['BTC/USD'] },
  { unsupportedRule: 20 },
  { ambiguous: true, reason: 'Conflicting constraints.' },
  {},
]) {
  assert.equal(normalizeStructuredPolicy(invalid, 'fixture').policy, null)
}

console.log('policy parser fixtures passed')
