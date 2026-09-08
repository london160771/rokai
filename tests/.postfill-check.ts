import assert from 'node:assert/strict'
import { parseDemoPolicy } from '../src/rules.ts'
import {
  parseOrderResponse,
  validateOrderResponseIdentity,
  verifyExecutedOrder,
  type ExecutableOrder,
} from '../src/execution.ts'
import { normalizeLivePortfolio } from '../server/binanceAgentOsApi.ts'

const policyText = 'Keep at least 55% in BNB, keep at least 40% in USDT, never sell BNB, no altcoin above 60%, and always keep at least 4 USDT.'
const policy = parseDemoPolicy(policyText).policy
assert.ok(policy)

const beforeAccount = {
  accountType: 'SPOT', canTrade: true, permissions: ['TRD_GRP_068'],
  balances: [{ asset: 'USDT', free: '12.00000000', locked: '0.00000000' }],
}
const afterAccount = {
  accountType: 'SPOT', canTrade: true, permissions: ['TRD_GRP_068'],
  balances: [
    { asset: 'USDT', free: '5.97624000', locked: '0.00000000' },
    { asset: 'BNB', free: '0.00799400', locked: '0.00000000' },
  ],
}
const beforeAssets = normalizeLivePortfolio(beforeAccount, { symbol: 'BNBUSDT', price: '753.58000000' }) .assets
const afterAssets = normalizeLivePortfolio(afterAccount, { symbol: 'BNBUSDT', price: '752.84000000' }) .assets
const order: ExecutableOrder = {
  runId: '47685446-24d2-4e21-a6c7-fb2da3eba788',
  planId: 'fc436088-75a2-4ffa-86d6-227c52b4dd56',
  step: 1,
  clientOrderId: 'r-aea1b8c08785478987c825e9ee5a0112',
  symbol: 'BNBUSDT',
  baseAsset: 'BNB',
  quoteAsset: 'USDT',
  side: 'BUY',
  type: 'MARKET',
  quoteOrderQty: 6.66,
  sourceAsset: 'USDT',
  targetAsset: 'BNB',
  expectedSourceDebit: 6.66,
  expectedTargetCredit: 0.0088,
  priceSnapshot: 753.58,
  priceTimestamp: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
}
const fullOrderResponse = {
  symbol: 'BNBUSDT', orderId: 12562278904, clientOrderId: order.clientOrderId,
  origQty: '0.00800000', executedQty: '0.00800000', origQuoteOrderQty: '6.66000000',
  cummulativeQuoteQty: '6.02376000', status: 'FILLED', type: 'MARKET', side: 'BUY',
  fills: [{ price: '752.97000000', qty: '0.00800000', commission: '0.00000600', commissionAsset: 'BNB' }],
}
const receipt = parseOrderResponse(fullOrderResponse, order.clientOrderId, '12562278904')
const identityError = validateOrderResponseIdentity(receipt, order)
const verification = verifyExecutedOrder(order, receipt, beforeAssets, afterAssets, policy)
assert.equal(identityError, undefined)
console.log(JSON.stringify({
  identityError,
  receipt,
  policySatisfied: verification.policySatisfied,
  tradeVerified: verification.tradeVerified,
  actualAverageFillPrice: verification.actualAverageFillPrice,
  actualPriceDeviationBps: verification.actualPriceDeviationBps,
  ruleResults: verification.results,
  reason: verification.reason,
  before: verification.before,
  after: verification.after,
}))
