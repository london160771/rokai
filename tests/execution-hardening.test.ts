import assert from 'node:assert/strict'
import * as execution from '../src/execution.ts'
import { createMockRokaiExecutionSessionForTests, type SupportedBinanceExecutionTool } from '../server/binanceExecutionAdapter.ts'
import type { ExchangeSymbolInfo } from '../src/execution.ts'
import type { Policy } from '../src/rules.ts'

const now = Date.parse('2026-09-07T12:00:00.000Z')
const originalDateNow = Date.now
Date.now = () => now
const originalLiveExecution = process.env.ROKAI_LIVE_EXECUTION
process.env.ROKAI_LIVE_EXECUTION = 'true'

const policy: Policy = { sourceText: 'Keep at least 40% in USDC.', rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 40 }] }
const market: ExchangeSymbolInfo = {
  symbol: 'SOLUSDC', baseAsset: 'SOL', quoteAsset: 'USDC', status: 'TRADING', isSpotTradingAllowed: true, permissions: ['SPOT'], baseAssetPrecision: 8, quoteAssetPrecision: 2, quoteOrderQtyMarketAllowed: true,
  filters: [{ filterType: 'MARKET_LOT_SIZE', minQty: 0.001, maxQty: 100, stepSize: 0.001 }, { filterType: 'MIN_NOTIONAL', minNotional: 10, applyToMarket: true }],
}

function makeSource() {
  let sold = 0
  let lastOrder: Record<string, unknown> | undefined
  let orderId = 500
  let writes = 0
  const calls: string[] = []
  const source = async (tool: string, args: Record<string, unknown>) => {
    calls.push(tool)
    if (tool === 'spot.exchangeInfo') return { symbols: [market] }
    if (tool === 'spot.getAccount') return { accountType: 'SPOT', canTrade: true, permissions: ['SPOT'], balances: [{ asset: 'SOL', free: 100 - sold, locked: 0 }, ...(sold ? [{ asset: 'USDC', free: sold * 0.999 - 0.001, locked: 0 }] : [])] }
    if (tool === 'spot.tickerPrice') return { prices: (JSON.parse(String(args.symbols)) as string[]).map((symbol) => ({ symbol, price: '1' })) }
    if (tool === 'spot.newOrder') {
      writes += 1
      lastOrder = args
      sold = Number(args.quantity)
      orderId += 1
      return { status: 'NEW', symbol: 'SOLUSDC', side: 'SELL', type: 'MARKET', orderId, clientOrderId: args.newClientOrderId, origQty: String(args.quantity), origQuoteOrderQty: '0', executedQty: '0', cummulativeQuoteQty: '0' }
    }
    if (tool === 'spot.getOrder') return { status: 'FILLED', symbol: lastOrder?.symbol, side: lastOrder?.side, type: lastOrder?.type, orderId, clientOrderId: lastOrder?.newClientOrderId, origQty: String(lastOrder?.quantity), origQuoteOrderQty: '0', executedQty: String(lastOrder?.quantity), cummulativeQuoteQty: String(Number(lastOrder?.quantity) * 0.999), fills: [{ commissionAsset: 'USDC', commission: '0.001' }] }
    throw new Error(`Unexpected tool ${tool}`)
  }
  return { source, calls, get writes() { return writes } }
}

assert.equal('submitApprovedRunOrder' in execution, false)
assert.equal('submitApprovedOrder' in execution, false)
assert.equal('createExecutablePlanForRun' in execution, false)

const concurrentMock = makeSource()
const concurrentSession = createMockRokaiExecutionSessionForTests(concurrentMock.source)
assert.deepEqual(Object.keys(concurrentSession).sort(), ['approveAndExecute', 'close', 'getActivePlan', 'getRun', 'startRun'])
const concurrentStart = await concurrentSession.startRun(policy, 'USDC')
assert.ok(concurrentStart.plan)
const concurrentResults = await Promise.allSettled([
  concurrentSession.approveAndExecute(concurrentStart.state.runId, `APPROVE ${concurrentStart.plan!.planId}`),
  concurrentSession.approveAndExecute(concurrentStart.state.runId, `APPROVE ${concurrentStart.plan!.planId}`),
])
assert.equal(concurrentMock.writes, 1)
assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1)
assert.equal(concurrentResults.filter((result) => result.status === 'rejected').length, 1)

const disabledMock = makeSource()
const disabledSession = createMockRokaiExecutionSessionForTests(disabledMock.source)
process.env.ROKAI_LIVE_EXECUTION = 'false'
const disabledStart = await disabledSession.startRun(policy, 'USDC')
assert.ok(disabledStart.plan)
disabledMock.calls.length = 0
const disabledResult = await disabledSession.approveAndExecute(disabledStart.state.runId, `APPROVE ${disabledStart.plan!.planId}`)
assert.equal(disabledResult.error, 'Rokai live execution is disabled. No order was sent.')
assert.equal(disabledMock.writes, 0)
assert.deepEqual(disabledMock.calls, [])

const allowedTools: SupportedBinanceExecutionTool[] = ['spot.exchangeInfo', 'spot.getAccount', 'spot.tickerPrice', 'spot.newOrder', 'spot.getOrder']
assert.deepEqual(allowedTools, ['spot.exchangeInfo', 'spot.getAccount', 'spot.tickerPrice', 'spot.newOrder', 'spot.getOrder'])

if (originalLiveExecution === undefined) delete process.env.ROKAI_LIVE_EXECUTION
else process.env.ROKAI_LIVE_EXECUTION = originalLiveExecution
Date.now = originalDateNow

console.log('execution hardening fixtures passed')
