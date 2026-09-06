import assert from 'node:assert/strict'
import { fetchLivePortfolio, normalizeLivePortfolio } from '../server/binanceAgentOsApi.ts'
import { evaluateRules } from '../src/rules.ts'

const account = {
  accountType: 'SPOT',
  balances: [
    { asset: 'USDC', free: '500', locked: '10' },
    { asset: 'BTC', free: '0.01', locked: '0' },
    { asset: 'ETH', free: '1', locked: '0.25' },
    { asset: 'DUST', free: '0', locked: '0' },
  ],
}
const prices = [
  { symbol: 'BTCUSDT', price: '70000' },
  { symbol: 'ETHUSDT', price: '3000' },
]

const normalized = normalizeLivePortfolio(account, prices, '2026-09-06T12:00:00.000Z')
assert.equal(normalized.source, 'binance-agent-os')
assert.equal(normalized.empty, false)
assert.equal(normalized.assets.length, 3)
assert.deepEqual(normalized.assets.map((asset) => [asset.symbol, asset.quantity, asset.priceUsd]), [
  ['USDC', 510, 1],
  ['BTC', 0.01, 70000],
  ['ETH', 1.25, 3000],
])
const total = normalized.assets.reduce((sum, asset) => sum + asset.quantity * asset.priceUsd, 0)
assert.equal(total, 4960)
assert.equal((normalized.assets[1].quantity * normalized.assets[1].priceUsd / total * 100).toFixed(1), '14.1')

const calls: string[] = []
const fetched = await fetchLivePortfolio(async (toolName) => {
  calls.push(toolName)
  return toolName === 'spot.getAccount' ? account : prices
}, '2026-09-06T12:00:00.000Z')
assert.deepEqual(calls, ['spot.getAccount', 'spot.tickerPrice'])
assert.deepEqual(fetched.assets, normalized.assets)

const emptyCalls: string[] = []
const empty = await fetchLivePortfolio(async (toolName) => {
  emptyCalls.push(toolName)
  return { balances: [{ asset: 'USDC', free: '0', locked: '0' }] }
}, '2026-09-06T12:00:00.000Z')
assert.equal(empty.empty, true)
assert.deepEqual(empty.assets, [])
assert.deepEqual(emptyCalls, ['spot.getAccount'])

assert.throws(
  () => normalizeLivePortfolio(account, [{ symbol: 'BTCUSDT', price: '70000' }], 'now'),
  /No live USDT price was returned for: ETH/,
)

const policy = {
  sourceText: 'live fixture',
  rules: [
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
    { kind: 'min_stablecoin_amount', asset: 'USDC', minAmount: 1000 },
    { kind: 'min_asset_allocation', asset: 'BTC', minPct: 50 },
    { kind: 'protected_asset', asset: 'BTC' },
    { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 20 },
  ],
} as const
const results = evaluateRules(normalized.assets, policy)
assert.equal(results.length, 5)
assert.deepEqual(results.map((result) => result.passed), [false, false, false, true, false])

console.log('live data adapter fixtures passed')
