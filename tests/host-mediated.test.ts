import assert from 'node:assert/strict'
import { parseDemoPolicy } from '../src/rules.js'
import { createRokaiHostMediatedSession, type HostFreshBinanceReads } from '../server/rokaiHostMediated.js'

const policyText = 'Keep at least 55% in BNB, keep at least 40% in USDT, never sell BNB, no altcoin above 60%, and always keep at least 4 USDT.'
const parsed = parseDemoPolicy(policyText)
if (!parsed.policy) throw new Error(parsed.error ?? 'Demo policy fixture did not parse.')

const account = (usdt: string, bnb?: string) => ({
  accountType: 'SPOT',
  canTrade: true,
  permissions: ['TRD_GRP_068'],
  balances: [
    { asset: 'USDT', free: usdt, locked: '0' },
    ...(bnb ? [{ asset: 'BNB', free: bnb, locked: '0' }] : []),
  ],
})

const exchangeInfo = {
  symbols: [{
    symbol: 'BNBUSDT',
    baseAsset: 'BNB',
    quoteAsset: 'USDT',
    status: 'TRADING',
    isSpotTradingAllowed: true,
    permissions: [],
    permissionSets: [['TRD_GRP_068', 'SPOT']],
    quoteOrderQtyMarketAllowed: true,
    baseAssetPrecision: 8,
    quoteAssetPrecision: 2,
    filters: [
      { filterType: 'MARKET_LOT_SIZE', minQty: '0', maxQty: '0', stepSize: '0' },
      { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '900000', stepSize: '0.001' },
      { filterType: 'NOTIONAL', minNotional: '5', applyMinToMarket: true, applyMaxToMarket: false },
    ],
  }],
}

const reads = (usdt = '12'): HostFreshBinanceReads => ({
  account: account(usdt),
  prices: { symbol: 'BNBUSDT', price: '750' },
  exchangeInfo,
})

function start() {
  const session = createRokaiHostMediatedSession()
  const result = session.startRun(parsed.policy!, 'USDT', reads())
  assert.equal(result.preflight, 'PASS')
  assert.ok(result.plan)
  assert.equal(result.plan?.decision.status, 'READY')
  assert.equal(result.plan?.serializedExecutableIntent.includes('BNBUSDT'), true)
  return { session, result, runId: result.state.runId, planId: result.plan!.planId }
}

const originalLiveGate = process.env.ROKAI_LIVE_EXECUTION
delete process.env.ROKAI_LIVE_EXECUTION
{
  const { session, runId, planId } = start()
  const blocked = (session.approveAndPrepare as unknown as (...args: unknown[]) => ReturnType<typeof session.approveAndPrepare>)(runId, `APPROVE ${planId}`, reads(), { liveExecutionEnabled: true, executor: async () => undefined })
  assert.equal(blocked.submission, undefined)
  assert.match(blocked.error ?? '', /disabled/i)
  assert.equal(blocked.state.status, 'AWAITING_APPROVAL')
}
process.env.ROKAI_LIVE_EXECUTION = 'true'

{
  const { session, result, runId, planId } = start()
  const prepared = session.approveAndPrepare(runId, 'approve', reads())
  assert.ok(prepared.submission)
  assert.equal(prepared.submission?.payload.symbol, 'BNBUSDT')
  assert.equal(prepared.submission?.payload.side, 'BUY')
  assert.equal(prepared.submission?.payload.type, 'MARKET')
  assert.equal(prepared.submission?.payload.quoteOrderQty, 6.76)
  assert.equal('executor' in prepared.submission!, false)

  const duplicate = session.approveAndPrepare(runId, `APPROVE ${planId}`, reads())
  assert.match(duplicate.error ?? '', /one submission authority/)
  assert.equal(duplicate.state.status, 'MANUAL_REVIEW')
  assert.equal(result.plan?.planId, planId)
}

{
  const { session, runId, planId } = start()
  const prepared = session.approveAndPrepare(runId, `approve plan`, reads())
  assert.ok(prepared.submission)
  assert.equal(prepared.submission?.planId, planId)
}

{
  const { session, runId, planId } = start()
  const changed = session.approveAndPrepare(runId, 'approve', reads('11.99'))
  assert.match(changed.error ?? '', /changed|replanned/i)
  assert.equal(changed.submission, undefined)
  assert.ok(changed.nextPlan)
  assert.notEqual(changed.nextPlan?.planId, planId)
  assert.equal(changed.state.status, 'AWAITING_APPROVAL')
}

{
  const session = createRokaiHostMediatedSession()
  const failed = session.startRun(parsed.policy!, 'USDT', { account: {}, prices: {}, exchangeInfo: {} })
  assert.equal(failed.plan, null)
  assert.equal(failed.state.status, 'MANUAL_REVIEW')
  assert.match(failed.error ?? '', /Spot|account|permission/i)
}

{
  assert.throws(
    () => (createRokaiHostMediatedSession as unknown as (value: unknown) => unknown)({ executor: async () => undefined }),
    /no injected executor/i,
  )
  const session = createRokaiHostMediatedSession()
  assert.equal('submitOrder' in session, false)
  assert.equal('executor' in session, false)
}

{
  const { session, runId, planId } = start()
  const prepared = session.approveAndPrepare(runId, `APPROVE ${planId}`, reads())
  assert.ok(prepared.submission)
  const plan = session.getActivePlan(runId)
  assert.ok(plan)
  const order = JSON.parse(plan!.serializedExecutableIntent) as { clientOrderId: string; quoteOrderQty: number; priceSnapshot: number }
  // The quote-sized BUY is finally executed in the exchange's 0.001 BNB lot
  // step. The receipt must model that actual executable quantity.
  const grossBnb = 0.009
  const commission = 0.000001
  const receipt = {
    orderId: '12345678901234567890',
    clientOrderId: order.clientOrderId,
    symbol: 'BNBUSDT',
    side: 'BUY',
    type: 'MARKET',
    status: 'FILLED',
    origQty: '0',
    origQuoteOrderQty: String(order.quoteOrderQty),
    executedQty: String(grossBnb),
    cummulativeQuoteQty: String(order.quoteOrderQty),
    fills: [{ commission: String(commission), commissionAsset: 'BNB' }],
  }
  const verification = session.verifyFilled(prepared.submission!, {
    order: receipt,
    account: account('5.24', String(grossBnb - commission)),
    prices: { symbol: 'BNBUSDT', price: '750' },
  })
  assert.equal(verification.verification?.tradeVerified, true)
  assert.equal(verification.verification?.policySatisfied, true)
  assert.equal(verification.state.status, 'COMPLETE')

  const replay = session.verifyFilled(prepared.submission!, { order: receipt, account: account('5.24', String(grossBnb - commission)), prices: { symbol: 'BNBUSDT', price: '750' } })
  assert.equal(replay.state.status, 'MANUAL_REVIEW')
}

{
  const { session, runId, planId } = start()
  const prepared = session.approveAndPrepare(runId, `APPROVE ${planId}`, reads())
  assert.ok(prepared.submission)
  const uncertain = session.verifyFilled(prepared.submission!, { order: { status: 'UNKNOWN' }, account: account('12'), prices: { symbol: 'BNBUSDT', price: '750' } })
  assert.equal(uncertain.state.status, 'MANUAL_REVIEW')
  assert.equal(uncertain.receipt?.status, 'UNKNOWN')
}

if (originalLiveGate === undefined) delete process.env.ROKAI_LIVE_EXECUTION
else process.env.ROKAI_LIVE_EXECUTION = originalLiveGate

console.log('host-mediated Rokai fixtures passed')
