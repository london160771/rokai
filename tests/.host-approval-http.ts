import { createServer } from 'node:http'
import { parseDemoPolicy } from '../src/rules.js'
import { createRokaiHostMediatedSession, type HostFreshBinanceReads } from '../server/rokaiHostMediated.js'

const policyText = 'Keep at least 55% in BNB, keep at least 40% in USDT, never sell BNB, no altcoin above 60%, and always keep at least 4 USDT.'
const policy = parseDemoPolicy(policyText).policy
if (!policy) throw new Error('The funded-demo policy fixture did not parse.')

const session = createRokaiHostMediatedSession()
let runId: string | undefined

function response(res: import('node:http').ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function body(req: import('node:http').IncomingMessage) {
  let value = ''
  for await (const chunk of req) value += chunk
  return JSON.parse(value) as Record<string, unknown>
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      response(res, 200, {
        alive: true,
        runId: runId ?? null,
        liveExecutionEnabled: process.env.ROKAI_LIVE_EXECUTION?.trim().toLowerCase() === 'true',
      })
      return
    }
    if (req.method === 'POST' && req.url === '/start') {
      const input = await body(req)
      const reads = input.reads as HostFreshBinanceReads | undefined
      if (!reads) throw new Error('Fresh host reads are required.')
      const result = session.startRun(policy, 'USDT', reads)
      runId = result.state.runId
      const plan = result.plan
      const order = plan ? JSON.parse(plan.serializedExecutableIntent) as Record<string, unknown> : null
      response(res, 200, {
        kind: 'PLAN',
        runId,
        planId: plan?.planId ?? null,
        symbol: order?.symbol ?? null,
        side: order?.side ?? null,
        type: order?.type ?? null,
        quoteOrderQty: order?.quoteOrderQty ?? null,
        preflight: result.preflight,
        status: result.state.status,
        error: result.error ?? null,
      })
      return
    }
    if (req.method === 'POST' && req.url === '/approve') {
      if (!runId) throw new Error('No authoritative run has been started.')
      const input = await body(req)
      const reads = input.reads as HostFreshBinanceReads | undefined
      const approvalText = typeof input.approvalText === 'string' ? input.approvalText : ''
      if (!reads) throw new Error('Fresh host reads are required.')
      response(res, 200, { kind: 'APPROVAL_RESULT', result: session.approveAndPrepare(runId, approvalText, reads) })
      return
    }
    response(res, 404, { error: 'Not found.' })
  } catch (error) {
    response(res, 400, { error: error instanceof Error ? error.message : 'Host-mediated runner stopped safely.' })
  }
})

server.listen(53421, '127.0.0.1')
