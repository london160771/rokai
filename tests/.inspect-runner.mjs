import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

const orderPayload = {
  symbol: 'BNBUSDT',
  side: 'BUY',
  type: 'MARKET',
  quoteOrderQty: 6.66,
  newClientOrderId: 'r-aea1b8c08785478987c825e9ee5a0112',
  newOrderRespType: 'FULL',
}
const orderResponse = {
  symbol: 'BNBUSDT', orderId: 12562278904, clientOrderId: 'r-aea1b8c08785478987c825e9ee5a0112',
  origQty: '0.00800000', executedQty: '0.00800000', origQuoteOrderQty: '6.66000000',
  cummulativeQuoteQty: '6.02376000', status: 'FILLED', type: 'MARKET', side: 'BUY',
  fills: [{ price: '752.97000000', qty: '0.00800000', commission: '0.00000600', commissionAsset: 'BNB' }],
}
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

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let value = ''
      res.on('data', (chunk) => { value += chunk })
      res.on('end', () => resolve(JSON.parse(value)))
    }).on('error', reject)
  })
}

class InspectorSocket {
  constructor(url) {
    const parsed = new URL(url)
    this.path = parsed.pathname
    this.socket = net.connect(Number(parsed.port), parsed.hostname)
    this.buffer = Buffer.alloc(0)
    this.messages = new Map()
    this.events = []
    this.nextId = 1
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.socket.once('error', (error) => this.rejectReady(error))
    this.socket.once('connect', () => {
      const key = crypto.randomBytes(16).toString('base64')
      this.socket.write(`GET ${this.path} HTTP/1.1\r\nHost: 127.0.0.1:9229\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    this.socket.on('data', (chunk) => this.onData(chunk))
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.handshaken) {
      const marker = this.buffer.indexOf('\r\n\r\n')
      if (marker < 0) return
      this.buffer = this.buffer.subarray(marker + 4)
      this.handshaken = true
      this.resolveReady()
    }
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const longLength = this.buffer.readBigUInt64BE(2)
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Inspector frame is too large.')
        length = Number(longLength)
        offset = 10
      }
      if (this.buffer.length < offset + length) return
      const payload = this.buffer.subarray(offset, offset + length)
      this.buffer = this.buffer.subarray(offset + length)
      const opcode = first & 0x0f
      if (opcode === 0x8) { this.socket.end(); return }
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue }
      if (opcode !== 0x1) continue
      const message = JSON.parse(payload.toString())
      if (message.id !== undefined) {
        const pending = this.messages.get(message.id)
        if (pending) {
          this.messages.delete(message.id)
          if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
          else pending.resolve(message.result)
        }
      } else this.events.push(message)
    }
  }

  sendFrame(opcode, payload) {
    const body = Buffer.from(payload)
    const mask = crypto.randomBytes(4)
    let header
    if (body.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | body.length])
    } else if (body.length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(body.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(body.length), 2)
    }
    const masked = Buffer.from(body)
    for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  async command(method, params = {}) {
    await this.ready
    const id = this.nextId++
    const result = new Promise((resolve, reject) => this.messages.set(id, { resolve, reject }))
    this.sendFrame(0x1, JSON.stringify({ id, method, params }))
    return result
  }

  async waitForPaused() {
    while (true) {
      const index = this.events.findIndex((event) => event.method === 'Debugger.paused')
      if (index >= 0) return this.events.splice(index, 1)[0]
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

const targets = await getJson('http://127.0.0.1:9229/json/list')
const inspector = new InspectorSocket(targets[0].webSocketDebuggerUrl)
await inspector.command('Runtime.enable')
await inspector.command('Debugger.enable')

const breakpoint = await inspector.command('Debugger.setBreakpointByUrl', {
  url: 'file:///C:/Users/uk/OneDrive/Desktop/Rokai/tests/.host-approval-http.ts',
  lineNumber: 25,
  columnNumber: 0,
})
const pendingHealth = getJson('http://127.0.0.1:53421/health')
const paused = await inspector.waitForPaused()
const frame = paused.params.callFrames[0].callFrameId
const state = await inspector.command('Debugger.evaluateOnCallFrame', { callFrameId: frame, expression: 'JSON.stringify(session.markManualReview(runId))', returnByValue: true })
await inspector.command('Debugger.resume')
await inspector.command('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId })
await pendingHealth
console.log(JSON.stringify(state.result?.result?.value ?? state))
inspector.socket.end()
