import assert from 'node:assert/strict'
import {
  assertOrderSafeToSubmit,
  buildExecutableOrder,
  buildSpotOrderArguments,
  createApprovalBinding,
  fetchExchangeSymbolInfo,
  getFreeBalance,
  normalizeExchangeSymbolInfo,
  parseOrderResponse,
  validateSpotAccountForExecution,
  verifyExecutedOrder,
  type ExchangeSymbolInfo,
  type ExecutionReceipt,
  type PriceSnapshot,
} from '../src/execution.ts'
import { buildPlan, evaluateRules, type Policy } from '../src/rules.ts'
import { cloneMockAssets, type Asset } from '../src/mockData.ts'

const now = Date.parse('2026-09-07T12:00:00.000Z')
const originalDateNow = Date.now
Date.now = () => now
const price: PriceSnapshot = { symbol: 'BTCUSDC', price: 70_000, timestamp: new Date(now).toISOString() }
const market: ExchangeSymbolInfo = {
  symbol: 'BTCUSDC',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  status: 'TRADING',
  isSpotTradingAllowed: true,
  permissions: ['SPOT'],
  baseAssetPrecision: 8,
  quoteAssetPrecision: 2,
  quoteOrderQtyMarketAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty: 0.0001, maxQty: 10, stepSize: 0.001 },
    { filterType: 'MIN_NOTIONAL', minNotional: 10, applyToMarket: true },
  ],
}
const assets: Asset[] = [
  { symbol: 'BTC', name: 'Bitcoin', quantity: 0.02, free: 0.01, locked: 0.01, priceUsd: 70_000, change24h: 0, kind: 'core' },
  { symbol: 'USDC', name: 'USD Coin', quantity: 1_000, free: 1_000, locked: 0, priceUsd: 1, change24h: 0, kind: 'stablecoin' },
]

const sellAction = { source: 'BTC', target: 'USDC', amountUsd: 700, sourceQuantity: 0.01, rationale: 'fixture' }
const buyAction = { source: 'USDC', target: 'BTC', amountUsd: 700, sourceQuantity: 700, rationale: 'fixture' }

const sellOrder = buildExecutableOrder(sellAction, assets, [market], price, [], { now, settlementAsset: 'USDC' })
assert.equal(sellOrder.side, 'SELL')
assert.equal(sellOrder.symbol, 'BTCUSDC')
assert.equal(sellOrder.baseAsset, 'BTC')
assert.equal(sellOrder.quoteAsset, 'USDC')
assert.equal(sellOrder.quantity, 0.01)
assert.equal(sellOrder.quoteOrderQty, undefined)
assert.equal(sellOrder.expectedSourceDebit, 0.01)
assert.ok(sellOrder.expectedTargetCredit < 700)
assert.equal(sellOrder.type, 'MARKET')
assert.equal(sellOrder.priceSnapshot, 70_000)
assert.equal(sellOrder.priceTimestamp, price.timestamp)
assert.equal(Date.parse(sellOrder.expiresAt), now + 60_000)
assert.match(sellOrder.planId, /^rokai-/)

const buyOrder = buildExecutableOrder(buyAction, assets, [market], price, [], { now, settlementAsset: 'USDC' })
assert.equal(buyOrder.side, 'BUY')
assert.equal(buyOrder.quoteOrderQty, 700)
assert.equal(buyOrder.quantity, undefined)
assert.equal(buyOrder.expectedSourceDebit, 700)
assert.ok((buyOrder.expectedTargetCredit ?? 0) < 0.01)
assert.deepEqual(buildSpotOrderArguments(buyOrder), {
  symbol: 'BTCUSDC',
  side: 'BUY',
  type: 'MARKET',
  quoteOrderQty: 700,
  newClientOrderId: buyOrder.clientOrderId,
  newOrderRespType: 'FULL',
})

assert.equal(getFreeBalance(assets[0]), 0.01)
assert.equal(getFreeBalance({ ...assets[0], free: undefined }), 0.01)
assert.throws(() => buildExecutableOrder({ ...sellAction, sourceQuantity: 0.02 }, assets, [market], price, [], { now, settlementAsset: 'USDC' }), /insufficient/i)
assert.throws(() => buildExecutableOrder(sellAction, assets, [market], price, ['BTC'], { now, settlementAsset: 'USDC' }), /protected/i)
const minNotionalMarket = { ...market, filters: [{ filterType: 'LOT_SIZE', minQty: 0.0001, maxQty: 10, stepSize: 0.0001 }, { filterType: 'MIN_NOTIONAL', minNotional: 10, applyToMarket: true }] }
assert.throws(() => buildExecutableOrder({ ...sellAction, sourceQuantity: 0.0001 }, assets, [minNotionalMarket], price, [], { now, settlementAsset: 'USDC' }), /minimum notional/i)
assert.throws(() => buildExecutableOrder(sellAction, assets, [market], { ...price, timestamp: new Date(now - 16_000).toISOString() }, [], { now, settlementAsset: 'USDC' }), /stale/i)
assert.throws(() => buildExecutableOrder(sellAction, assets, [market], { ...price, timestamp: new Date(now - 16_000).toISOString() }, [], { now: now - 86_400_000, maxPriceAgeMs: Number.POSITIVE_INFINITY, settlementAsset: 'USDC' }), /stale/i)
assert.equal(buildExecutableOrder(sellAction, assets, [market], price, [], { now: now - 86_400_000, maxPriceAgeMs: -1, maxPriceDeviationBps: Number.NaN, settlementAsset: 'USDC' }).quantity, 0.01)
assert.equal(buildExecutableOrder({ ...sellAction, amountUsd: 700.77 }, assets, [market], price, [], { now, settlementAsset: 'USDC' }).quantity, 0.01)
assert.throws(() => normalizeExchangeSymbolInfo({ symbols: [market, market] }, 'BTCUSDC'), /more than one/i)
assert.throws(() => normalizeExchangeSymbolInfo({ ...market, status: 'HALT' }, 'BTCUSDC') && buildExecutableOrder(sellAction, assets, [{ ...market, status: 'HALT' }], price, [], { now, settlementAsset: 'USDC' }), /not trading/i)

const rawExchangeInfo = normalizeExchangeSymbolInfo({ symbols: [{ ...market, filters: market.filters?.map((filter) => ({ ...filter, minQty: filter.minQty?.toString(), stepSize: filter.stepSize?.toString() })) }] }, 'BTCUSDC')
assert.equal(rawExchangeInfo.filters?.[0].stepSize, 0.001)
assert.equal(validateSpotAccountForExecution({ accountType: 'SPOT', canTrade: true, permissions: ['SPOT'] }).agenticIdentity, 'unavailable')
assert.equal(validateSpotAccountForExecution({ accountType: 'SPOT', canTrade: true, permissions: ['SPOT'], isAgentic: true }).agenticIdentity, 'explicit')
assert.throws(() => validateSpotAccountForExecution({ accountType: 'SPOT', canTrade: true, permissions: ['SPOT'], isAgentic: false }), /Agentic/i)
assert.throws(() => validateSpotAccountForExecution({ canTrade: true, permissions: ['SPOT'] }), /Spot account/i)
const protectedFeeBinding = createApprovalBinding(sellOrder)
protectedFeeBinding.approved = true
assert.throws(() => assertOrderSafeToSubmit(sellOrder, protectedFeeBinding, {
  assets,
  protectedAssets: ['BNB'],
  currentPrice: price,
  account: { accountType: 'SPOT', canTrade: true, permissions: ['SPOT'] },
  market,
  exchangeInfoTimestamp: now,
}), /BNB|fee/i)
const exchangeCalls: string[] = []
const fetchedExchangeInfo = await fetchExchangeSymbolInfo(async (toolName) => {
  exchangeCalls.push(toolName)
  return { symbols: [market] }
}, 'BTCUSDC')
assert.equal(fetchedExchangeInfo.symbol, 'BTCUSDC')
assert.deepEqual(exchangeCalls, ['spot.exchangeInfo'])

const satisfiedAssets: Asset[] = [
  { symbol: 'USDC', name: 'USD Coin', quantity: 500, priceUsd: 1, change24h: 0, kind: 'stablecoin' },
  { symbol: 'SOL', name: 'Solana', quantity: 5, priceUsd: 100, change24h: 0, kind: 'altcoin' },
]
const specificMaxPolicy: Policy = { sourceText: 'fixture', rules: [
  { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
  { kind: 'max_asset_exposure', asset: 'SOL', maxPct: 20 },
] }
const specificMaxPlan = buildPlan(satisfiedAssets, specificMaxPolicy)
assert.equal(specificMaxPlan.actions.length, 1)
assert.equal(specificMaxPlan.actions[0].source, 'SOL')
assert.equal(specificMaxPlan.safe, true)
assert.ok(evaluateRules((() => {
  const result = satisfiedAssets.map((asset) => ({ ...asset }))
  result[0].quantity += specificMaxPlan.actions[0].amountUsd
  result[1].quantity -= specificMaxPlan.actions[0].sourceQuantity
  return result
})(), specificMaxPolicy).every((item) => item.passed))

const noActionPlan = buildPlan(satisfiedAssets, { sourceText: 'fixture', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 40 }] })
assert.equal(noActionPlan.actions.length, 0)
assert.equal(noActionPlan.safe, false)
const multiActionPlan = buildPlan(cloneMockAssets(), {
  sourceText: 'fixture',
  rules: [
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
    { kind: 'min_asset_allocation', asset: 'BTC', minPct: 20 },
    { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 20 },
  ],
})
assert.equal(multiActionPlan.actions.length, 1)
assert.equal(multiActionPlan.safe, false)

const partialReceipt = parseOrderResponse({ status: 'PARTIALLY_FILLED', symbol: 'BTCUSDC', side: 'SELL', type: 'MARKET', orderId: 7, clientOrderId: sellOrder.clientOrderId, origQty: '0.01', origQuoteOrderQty: '0', executedQty: '0.005', cummulativeQuoteQty: '349.65' }, sellOrder.clientOrderId)
assert.equal(partialReceipt.status, 'PARTIALLY_FILLED')
const largeOrderId = '900719925474099312345'
const fullReceiptWithCommission = parseOrderResponse({
  status: 'FILLED',
  symbol: 'BTCUSDC',
  side: 'SELL',
  type: 'MARKET',
  orderId: largeOrderId,
  clientOrderId: sellOrder.clientOrderId,
  origQty: '0.01',
  origQuoteOrderQty: '0',
  executedQty: '0.01',
  cummulativeQuoteQty: '699.3',
  fills: [{ commission: '0.00001', commissionAsset: 'BTC' }],
}, sellOrder.clientOrderId, largeOrderId)
assert.equal(fullReceiptWithCommission.status, 'FILLED')
assert.equal(fullReceiptWithCommission.orderId, largeOrderId)
assert.deepEqual(fullReceiptWithCommission.commissions, [{ asset: 'BTC', amount: 0.00001 }])
assert.equal(parseOrderResponse({ status: 'CANCELED', orderId: 7, clientOrderId: sellOrder.clientOrderId }, sellOrder.clientOrderId).status, 'CANCELED')
assert.equal(parseOrderResponse({ status: 'EXPIRED', orderId: 7, clientOrderId: sellOrder.clientOrderId }, sellOrder.clientOrderId).status, 'EXPIRED')
assert.equal(parseOrderResponse({ status: 'REJECTED', orderId: 7, clientOrderId: sellOrder.clientOrderId }, sellOrder.clientOrderId).status, 'REJECTED')
assert.equal(parseOrderResponse({ status: 'NEW', orderId: 7, clientOrderId: 'other' }, sellOrder.clientOrderId).status, 'UNKNOWN')

const afterAssets: Asset[] = [
  { symbol: 'BTC', name: 'Bitcoin', quantity: 0.01, free: 0.01, locked: 0, priceUsd: 70_000, change24h: 0, kind: 'core' },
  { symbol: 'USDC', name: 'USD Coin', quantity: 1_700, free: 1_700, locked: 0, priceUsd: 1, change24h: 0, kind: 'stablecoin' },
]
const verificationReceipt: ExecutionReceipt = { status: 'FILLED', orderId: '42', clientOrderId: sellOrder.clientOrderId, symbol: 'BTCUSDC', side: 'SELL', type: 'MARKET', quantityMode: 'quantity', origQty: 0.01, origQuoteOrderQty: 0, executedQty: 0.01, cumulativeQuoteQty: 699.3, commissions: [] }
const verification = verifyExecutedOrder(sellOrder, verificationReceipt, assets, afterAssets, { sourceText: 'fixture', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 50 }] })
assert.equal(verification.verified, true)
assert.equal(verification.results[0].passed, true)
assert.equal(verification.actualAverageFillPrice, 69_930)
assert.equal(verification.actualPriceDeviationBps, 10)
const sourceFeeVerification = verifyExecutedOrder(
  sellOrder,
  { ...verificationReceipt, commissions: [{ asset: 'BTC', amount: 0.00001 }] },
  assets,
  [{ ...afterAssets[0], quantity: 0.00999, free: 0.00999 }, afterAssets[1]],
  { sourceText: 'fixture', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 50 }] },
)
assert.equal(sourceFeeVerification.tradeVerified, true)
const targetFeeVerification = verifyExecutedOrder(
  sellOrder,
  { ...verificationReceipt, commissions: [{ asset: 'USDC', amount: 0.01 }] },
  assets,
  [afterAssets[0], { ...afterAssets[1], quantity: 1_699.29, free: 1_699.29 }],
  { sourceText: 'fixture', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 50 }] },
)
assert.equal(targetFeeVerification.tradeVerified, true)
const thirdAssetFeeVerification = verifyExecutedOrder(
  sellOrder,
  { ...verificationReceipt, commissions: [{ asset: 'BNB', amount: 0.001 }] },
  [...assets, { symbol: 'BNB', name: 'BNB', quantity: 1, free: 1, locked: 0, priceUsd: 1, change24h: 0, kind: 'core' }],
  [...afterAssets, { symbol: 'BNB', name: 'BNB', quantity: 0.999, free: 0.999, locked: 0, priceUsd: 1, change24h: 0, kind: 'core' }],
  { sourceText: 'fixture', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 50 }] },
)
assert.equal(thirdAssetFeeVerification.tradeVerified, true)
const protectedFeeVerification = verifyExecutedOrder(
  sellOrder,
  { ...verificationReceipt, commissions: [{ asset: 'BNB', amount: 0.001 }] },
  [...assets, { symbol: 'BNB', name: 'BNB', quantity: 1, free: 1, locked: 0, priceUsd: 1, change24h: 0, kind: 'core' }],
  [...afterAssets, { symbol: 'BNB', name: 'BNB', quantity: 0.999, free: 0.999, locked: 0, priceUsd: 1, change24h: 0, kind: 'core' }],
  { sourceText: 'fixture', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 50 }, { kind: 'protected_asset', asset: 'BNB' }] },
)
assert.equal(protectedFeeVerification.tradeVerified, false)
assert.match(protectedFeeVerification.reason ?? '', /protected|changed/i)
const underfilledReceipt: ExecutionReceipt = {
  ...fullReceiptWithCommission,
  executedQty: 0.005,
  cumulativeQuoteQty: 349.65,
}
const underfilledVerification = verifyExecutedOrder(sellOrder, underfilledReceipt, assets, afterAssets, { sourceText: 'fixture', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 50 }] })
assert.equal(underfilledVerification.verified, false)
assert.match(underfilledVerification.reason ?? '', /does not match approved|exceeds/i)
const excessiveSlippage = verifyExecutedOrder(sellOrder, { status: 'FILLED', orderId: '42', clientOrderId: sellOrder.clientOrderId, symbol: 'BTCUSDC', side: 'SELL', type: 'MARKET', quantityMode: 'quantity', origQty: 0.01, origQuoteOrderQty: 0, executedQty: 0.01, cumulativeQuoteQty: 693, commissions: [] }, assets, afterAssets, { sourceText: 'fixture', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 50 }] })
assert.equal(excessiveSlippage.verified, false)
assert.match(excessiveSlippage.reason ?? '', /deviated|safety limit/i)
const zeroQuote = verifyExecutedOrder(sellOrder, { status: 'FILLED', orderId: '42', clientOrderId: sellOrder.clientOrderId, symbol: 'BTCUSDC', side: 'SELL', type: 'MARKET', quantityMode: 'quantity', origQty: 0.01, origQuoteOrderQty: 0, executedQty: 0.01, cumulativeQuoteQty: 0, commissions: [] }, assets, afterAssets, { sourceText: 'fixture', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 50 }] })
assert.equal(zeroQuote.verified, false)
assert.match(zeroQuote.reason ?? '', /complete executed quantity|quote totals/i)
const partialVerification = verifyExecutedOrder(sellOrder, partialReceipt, assets, afterAssets, { sourceText: 'fixture', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 50 }] })
assert.equal(partialVerification.verified, false)
assert.match(partialVerification.reason ?? '', /PARTIALLY_FILLED/)

console.log('execution safety fixtures passed')
Date.now = originalDateNow
