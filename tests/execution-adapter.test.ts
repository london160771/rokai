import assert from 'node:assert/strict'
import { createMockRokaiExecutionSessionForTests, createRokaiExecutionSession, supportedBinanceExecutionTools } from '../server/binanceExecutionAdapter.ts'
import type { ExchangeSymbolInfo } from '../src/execution.ts'
import type { Policy } from '../src/rules.ts'

const now = Date.parse('2026-09-07T12:00:00.000Z')
const originalDateNow = Date.now
Date.now = () => now
const originalLiveExecution = process.env.ROKAI_LIVE_EXECUTION
process.env.ROKAI_LIVE_EXECUTION = 'true'

const policy: Policy = {
  sourceText: 'Keep USDC and BTC funded without selling BTC.',
  rules: [
    { kind: 'min_stablecoin', asset: 'USDC', minPct: 40 },
    { kind: 'min_stablecoin_amount', asset: 'USDC', minAmount: 4 },
    { kind: 'protected_asset', asset: 'BTC' },
    { kind: 'min_asset_allocation', asset: 'BTC', minPct: 20 },
    { kind: 'max_asset_exposure', asset: 'altcoins', maxPct: 60 },
  ],
}

const markets: Record<string, ExchangeSymbolInfo> = {
  SOLUSDC: {
    symbol: 'SOLUSDC', baseAsset: 'SOL', quoteAsset: 'USDC', status: 'TRADING', isSpotTradingAllowed: true, permissions: ['SPOT'], baseAssetPrecision: 8, quoteAssetPrecision: 2, quoteOrderQtyMarketAllowed: true,
    filters: [{ filterType: 'MARKET_LOT_SIZE', minQty: 0.001, maxQty: 1000, stepSize: 0.001 }, { filterType: 'MIN_NOTIONAL', minNotional: 10, applyToMarket: true }],
  },
  BTCUSDC: {
    symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC', status: 'TRADING', isSpotTradingAllowed: true, permissions: ['SPOT'], baseAssetPrecision: 8, quoteAssetPrecision: 2, quoteOrderQtyMarketAllowed: true,
    filters: [{ filterType: 'MARKET_LOT_SIZE', minQty: 0.0001, maxQty: 1000, stepSize: 0.0001 }, { filterType: 'MIN_NOTIONAL', minNotional: 10, applyToMarket: true }],
  },
}

function makeMockSource(options: { initialBtc?: number; protectedDeltaAfterFirst?: number } = {}) {
  let stage = 0
  let firstSell = 0
  let secondBuy = 0
  let lastOrder: Record<string, unknown> | undefined
  let lastOrderId = 99
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const source = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args })
    if (tool === 'spot.exchangeInfo') return { symbols: [markets[String(args.symbol)]] }
    if (tool === 'spot.getAccount') {
      const btc = (options.initialBtc ?? 0) + secondBuy * 0.999 - (stage >= 1 ? options.protectedDeltaAfterFirst ?? 0 : 0) - (secondBuy > 0 ? 0.001 : 0)
      return {
        accountType: 'SPOT', canTrade: true, permissions: ['SPOT'],
        balances: [
          { asset: 'SOL', free: 50 - firstSell, locked: 0 },
          { asset: 'USDC', free: firstSell * 0.999 - (firstSell > 0 ? 0.001 : 0) - secondBuy, locked: 0 },
          { asset: 'BTC', free: btc, locked: 0 },
        ].filter((balance) => balance.free > 0),
      }
    }
    if (tool === 'spot.tickerPrice') {
      const symbols = JSON.parse(String(args.symbols)) as string[]
      return { prices: symbols.map((symbol) => ({ symbol, price: '1' })) }
    }
    if (tool === 'spot.newOrder') {
      lastOrder = args
      const isSell = args.side === 'SELL'
      const quantity = Number(args.quantity ?? 0)
      const quoteOrderQty = Number(args.quoteOrderQty ?? 0)
      if (args.symbol === 'SOLUSDC') firstSell = quantity
      if (args.symbol === 'BTCUSDC') secondBuy = quoteOrderQty
      lastOrderId += 1
      stage += 1
      return { status: 'NEW', symbol: args.symbol, side: args.side, type: args.type, orderId: lastOrderId, clientOrderId: args.newClientOrderId, origQty: isSell ? String(quantity) : '0', origQuoteOrderQty: isSell ? '0' : String(quoteOrderQty), executedQty: '0', cummulativeQuoteQty: '0', fills: [{ commissionAsset: isSell ? 'USDC' : 'BTC', commission: '0.001' }] }
    }
    if (tool === 'spot.getOrder') {
      assert.ok(lastOrder)
      const isSell = lastOrder?.side === 'SELL'
      const sourceAmount = Number(isSell ? lastOrder?.quantity : lastOrder?.quoteOrderQty)
      const executedQty = isSell ? sourceAmount : sourceAmount * 0.999
      const quoteAmount = isSell ? sourceAmount * 0.999 : sourceAmount
      return { status: 'FILLED', symbol: lastOrder?.symbol, side: lastOrder?.side, type: lastOrder?.type, orderId: lastOrderId, clientOrderId: lastOrder?.newClientOrderId, origQty: isSell ? String(sourceAmount) : '0', origQuoteOrderQty: isSell ? '0' : String(sourceAmount), executedQty: String(executedQty), cummulativeQuoteQty: String(quoteAmount) }
    }
    throw new Error(`Unexpected tool ${tool}`)
  }
  return { source, calls }
}

const mock = makeMockSource()
const session = createMockRokaiExecutionSessionForTests(mock.source)
const first = await session.startRun(policy, 'USDC')
assert.equal(first.empty, false)
assert.ok(first.plan)
assert.equal(first.plan?.decision.status, 'READY')
assert.equal(first.plan?.decision.status === 'READY' ? first.plan.decision.nextTrade.source : '', 'SOL')
assert.equal(first.plan?.decision.status === 'READY' ? first.plan.decision.nextTrade.target : '', 'USDC')
assert.equal(mock.calls.some((call) => call.tool === 'spot.getAccount'), true)
assert.equal(mock.calls.some((call) => call.tool === 'spot.exchangeInfo'), true)
assert.equal(mock.calls.some((call) => call.tool === 'spot.tickerPrice'), true)

const firstResult = await session.approveAndExecute(first.state.runId, `APPROVE ${first.plan!.planId}`)
assert.equal(firstResult.receipt?.status, 'FILLED')
assert.equal(firstResult.verification?.tradeVerified, true)
assert.equal(firstResult.verification?.policySatisfied, false)
assert.equal(firstResult.state.status, 'AWAITING_APPROVAL')
assert.ok(firstResult.nextPlan)
assert.notEqual(firstResult.nextPlan?.planId, first.plan?.planId)
assert.equal(firstResult.nextPlan?.decision.status, 'READY')
assert.equal(firstResult.nextPlan?.decision.status === 'READY' ? firstResult.nextPlan.decision.nextTrade.source : '', 'USDC')
assert.equal(firstResult.nextPlan?.decision.status === 'READY' ? firstResult.nextPlan.decision.nextTrade.target : '', 'BTC')
const firstOrder = JSON.parse(first.plan!.serializedExecutableIntent) as Record<string, unknown>
const secondOrder = JSON.parse(firstResult.nextPlan!.serializedExecutableIntent) as Record<string, unknown>
assert.ok(Number(firstOrder.quantity ?? firstOrder.quoteOrderQty) >= 10, 'the first order must satisfy the realistic $10 minimum notional')
assert.ok(Number(secondOrder.quantity ?? secondOrder.quoteOrderQty) >= 10, 'the second order must satisfy the realistic $10 minimum notional')

const secondResult = await session.approveAndExecute(first.state.runId, `APPROVE ${firstResult.nextPlan!.planId}`)
assert.equal(secondResult.receipt?.status, 'FILLED')
assert.equal(secondResult.verification?.tradeVerified, true)
assert.equal(secondResult.verification?.policySatisfied, true)
assert.equal(secondResult.state.status, 'COMPLETE')
assert.equal(mock.calls.filter((call) => call.tool === 'spot.newOrder').length, 2)
assert.ok(mock.calls.every((call) => (supportedBinanceExecutionTools as readonly string[]).includes(call.tool)))

const gateMock = makeMockSource()
const gateSession = createMockRokaiExecutionSessionForTests(gateMock.source)
process.env.ROKAI_LIVE_EXECUTION = 'false'
const gated = await gateSession.startRun(policy, 'USDC')
assert.ok(gated.plan)
gateMock.calls.length = 0
const gatedResult = await gateSession.approveAndExecute(gated.state.runId, `APPROVE ${gated.plan!.planId}`)
assert.equal(gatedResult.error, 'Rokai live execution is disabled. No order was sent.')
assert.equal(gateMock.calls.length, 0)

const protectedMock = makeMockSource({ initialBtc: 5, protectedDeltaAfterFirst: 0.01 })
process.env.ROKAI_LIVE_EXECUTION = 'true'
const protectedSession = createMockRokaiExecutionSessionForTests(protectedMock.source)
const protectedStart = await protectedSession.startRun(policy, 'USDC')
assert.ok(protectedStart.plan)
const protectedResult = await protectedSession.approveAndExecute(protectedStart.state.runId, `APPROVE ${protectedStart.plan!.planId}`)
assert.equal(protectedResult.receipt?.status, 'FILLED')
assert.equal(protectedResult.verification?.tradeVerified, false)
assert.equal(protectedResult.state.status, 'MANUAL_REVIEW')

// The production constructor accepts only HTTP context; it creates the
// sanctioned official MCP connection internally rather than accepting a source.
assert.equal(createRokaiExecutionSession.length, 1)

if (originalLiveExecution === undefined) delete process.env.ROKAI_LIVE_EXECUTION
else process.env.ROKAI_LIVE_EXECUTION = originalLiveExecution
Date.now = originalDateNow

console.log('execution adapter fixtures passed')
