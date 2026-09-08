import assert from 'node:assert/strict'
import { createRokaiRuntimeController, runRokaiRuntime } from '../server/rokaiRuntime.ts'

const policyText = 'Keep at least 90% in USDT, keep BNB below 10%, never sell USDT, and always keep at least 10 USDT.'
const reads = {
  account: {
    accountType: 'SPOT',
    canTrade: true,
    permissions: ['TRD_GRP_068'],
    balances: [
      { asset: 'USDT', free: '5.97624', locked: '0' },
      { asset: 'BNB', free: '0.007994', locked: '0' },
    ],
  },
  prices: { symbol: 'BNBUSDT', price: '751.23' },
  exchangeInfo: {
    symbols: [{
      symbol: 'BNBUSDT',
      baseAsset: 'BNB',
      quoteAsset: 'USDT',
      status: 'TRADING',
      isSpotTradingAllowed: true,
      permissions: [],
      permissionSets: [['SPOT', 'TRD_GRP_068']],
      quoteOrderQtyMarketAllowed: true,
      baseAssetPrecision: 8,
      quoteAssetPrecision: 8,
      filters: [
        { filterType: 'MARKET_LOT_SIZE', minQty: '0', maxQty: '0', stepSize: '0' },
        { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '900000', stepSize: '0.001' },
        { filterType: 'NOTIONAL', minNotional: '5', applyMinToMarket: true },
      ],
    }],
  },
}

const oneShot = runRokaiRuntime({ policyText, settlementAsset: 'USDT', reads })
assert.equal(oneShot.ok, true)
assert.equal(oneShot.authoritativePlan, true)
assert.equal(oneShot.plan?.planId !== undefined, true)
assert.equal((oneShot.plan?.action as { symbol: string }).symbol, 'BNBUSDT')
assert.equal((oneShot.plan?.action as { side: string }).side, 'SELL')
assert.equal((oneShot.plan?.action as { type: string }).type, 'MARKET')
assert.equal((oneShot.plan?.action as { quantity: number }).quantity, 0.007)
assert.equal((oneShot.plan?.action as { quoteOrderQty?: number }).quoteOrderQty, undefined)
assert.equal((oneShot.plan?.preflight as string), 'PASS')

const controller = createRokaiRuntimeController()
const ready = controller.handle({ op: 'ready' })
assert.equal(ready.ok, true)
assert.equal(ready.ready, true)
assert.equal(ready.runtimeLoaded, true)
assert.equal((ready.hostMcp as { mode: string }).mode, 'codex-mediated')
assert.deepEqual((ready.hostMcp as { requiredReadTools: string[] }).requiredReadTools, ['spot.getAccount', 'spot.tickerPrice', 'spot.exchangeInfo'])

const started = controller.handle({ op: 'start', policyText, settlementAsset: 'USDT', reads })
assert.equal(started.ok, true)
assert.equal(started.authoritativePlan, true)
assert.equal(started.plan?.planId !== undefined, true)

const warmPolicy = controller.handle({
  op: 'start',
  policyText,
  settlementAsset: 'USDT',
  reads: { account: reads.account, prices: reads.prices },
})
assert.equal(warmPolicy.ok, true)
assert.equal(warmPolicy.authoritativePlan, true)
assert.equal(warmPolicy.timings?.exchangeInfoCache, 'hit')
assert.equal((warmPolicy.timings?.metadataTtlMs as number), 45_000)

const wrappedController = createRokaiRuntimeController()
const wrappedStart = wrappedController.handle({
  op: 'start',
  policyText,
  settlementAsset: 'USDT',
  reads: { account: reads.account, prices: reads.prices, exchangeInfo: { content: [{ type: 'text', text: JSON.stringify(reads.exchangeInfo) }] } },
})
assert.equal(wrappedStart.ok, true)
const wrappedWarm = wrappedController.handle({
  op: 'start',
  policyText,
  settlementAsset: 'USDT',
  reads: { account: reads.account, prices: reads.prices },
})
assert.equal(wrappedWarm.ok, true)
assert.equal(wrappedWarm.timings?.exchangeInfoCache, 'hit')

const missingFreshAccount = controller.handle({
  op: 'start',
  policyText,
  settlementAsset: 'USDT',
  reads: { account: reads.account },
})
assert.equal(missingFreshAccount.ok, false)
assert.match(missingFreshAccount.error ?? '', /account and price/i)

const originalDateNow = Date.now
const cacheExpiryNow = originalDateNow() + 45_001
Date.now = () => cacheExpiryNow
try {
  const expiredMetadata = controller.handle({
    op: 'start',
    policyText,
    settlementAsset: 'USDT',
    reads: { account: reads.account, prices: reads.prices },
  })
  assert.equal(expiredMetadata.ok, false)
  assert.match(expiredMetadata.error ?? '', /exchange-info/i)
} finally {
  Date.now = originalDateNow
}

const unsupportedOperation = controller.handle({ op: 'arbitrary-command' })
assert.equal(unsupportedOperation.ok, false)
assert.match(unsupportedOperation.error ?? '', /unsupported/i)

const stopped = runRokaiRuntime({
  policyText: 'Buy something when the market looks good.',
  settlementAsset: 'USDT',
  reads,
})
assert.equal(stopped.ok, false)
assert.match(stopped.error ?? '', /try the demo|parse|supported/i)

console.log('Rokai runtime fixtures passed')
