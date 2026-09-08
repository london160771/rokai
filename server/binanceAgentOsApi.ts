import type { Asset } from '../src/mockData.js'
import type { Plugin, ViteDevServer } from 'vite'
import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { auth, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

export const officialBinanceMcpUrl = 'https://agent.binance.com/mcp/agentic'
const sessionCookieName = 'rokai_binance_session'
const clientMetadataPath = '/api/binance/client-metadata.json'
const authCallbackPath = '/api/binance/auth/callback'

const stablecoinSymbols = new Set(['USDC', 'USDT', 'BUSD', 'FDUSD', 'DAI', 'USDE'])
const coreSymbols = new Set(['BTC', 'BNB'])
const assetNames: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  BNB: 'BNB',
  USDC: 'USD Coin',
  USDT: 'Tether USD',
  BUSD: 'Binance USD',
  FDUSD: 'First Digital USD',
  DAI: 'Dai',
  USDE: 'USDe',
}

export type McpToolExecutor = (toolName: string, args: Record<string, unknown>) => Promise<unknown>

type BinanceSession = {
  tokens?: OAuthTokens
  clientInformation?: OAuthClientInformationMixed
  codeVerifier?: string
  state?: string
  discoveryState?: OAuthDiscoveryState
}

const sessions = new Map<string, BinanceSession>()

export type LivePortfolio = {
  assets: Asset[]
  source: 'binance-agent-os'
  asOf: string
  empty: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapMcpPayload(payload: unknown): unknown {
  if (isRecord(payload) && Array.isArray(payload.content)) {
    const text = payload.content.find((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
    if (isRecord(text) && typeof text.text === 'string') {
      try { return JSON.parse(text.text) as unknown } catch { return text.text }
    }
  }
  if (isRecord(payload) && 'structuredContent' in payload) return payload.structuredContent
  if (isRecord(payload) && 'result' in payload) return unwrapMcpPayload(payload.result)
  return payload
}

function numeric(value: unknown, label: string) {
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(result) || result < 0) throw new Error(`Binance returned an invalid ${label}.`)
  return result
}

export type LiveBalance = { symbol: string; free: number; locked: number; quantity: number }

export function normalizeSpotBalances(payload: unknown): LiveBalance[] {
  const value = unwrapMcpPayload(payload)
  const balances = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.balances)
      ? value.balances
      : null
  if (!balances) throw new Error('Binance returned a malformed Spot account response.')
  return balances.map((entry) => {
    if (!isRecord(entry) || typeof entry.asset !== 'string') throw new Error('Binance returned a malformed Spot balance.')
    const symbol = entry.asset.trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9]{1,11}$/.test(symbol)) throw new Error('Binance returned a malformed asset symbol.')
    const locked = entry.locked !== undefined ? numeric(entry.locked, `${symbol} locked balance`) : 0
    const total = entry.quantity === undefined ? undefined : numeric(entry.quantity, `${symbol} balance`)
    if (total !== undefined && locked > total + 1e-12) throw new Error(`Binance returned an invalid ${symbol} balance.`)
    const free = entry.free !== undefined ? numeric(entry.free, `${symbol} free balance`) : total === undefined ? 0 : total - locked
    if (!Number.isFinite(free + locked)) throw new Error(`Binance returned an invalid ${symbol} balance.`)
    return { symbol, free, locked, quantity: free + locked }
  }).filter((balance) => balance.quantity > 0)
}

export function normalizeSpotPrices(payload: unknown): Map<string, number> {
  const value = unwrapMcpPayload(payload)
  const prices = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.prices)
      ? value.prices
      : isRecord(value) && typeof value.symbol === 'string'
        ? [value]
        : []
  const result = new Map<string, number>()
  prices.forEach((entry) => {
    if (!isRecord(entry) || typeof entry.symbol !== 'string') throw new Error('Binance returned a malformed price response.')
    result.set(entry.symbol.trim().toUpperCase(), numeric(entry.price, `${entry.symbol} price`))
  })
  return result
}

export function normalizeLivePortfolio(balancePayload: unknown, pricePayload: unknown, asOf = new Date().toISOString()): LivePortfolio {
  const balances = normalizeSpotBalances(balancePayload)
  if (!balances.length) return { assets: [], source: 'binance-agent-os', asOf, empty: true }

  const prices = normalizeSpotPrices(pricePayload)
  const missing = balances
    .filter((balance) => !stablecoinSymbols.has(balance.symbol) && !prices.has(`${balance.symbol}USDT`))
    .map((balance) => balance.symbol)
  if (missing.length) throw new Error(`No live USDT price was returned for: ${missing.join(', ')}.`)

  const assets = balances.map((balance) => ({
    symbol: balance.symbol,
    name: assetNames[balance.symbol] ?? balance.symbol,
    quantity: balance.quantity,
    free: balance.free,
    locked: balance.locked,
    priceUsd: stablecoinSymbols.has(balance.symbol) ? 1 : prices.get(`${balance.symbol}USDT`)!,
    change24h: 0,
    kind: stablecoinSymbols.has(balance.symbol) ? 'stablecoin' : coreSymbols.has(balance.symbol) ? 'core' : 'altcoin',
  } satisfies Asset))
  return { assets, source: 'binance-agent-os', asOf, empty: false }
}

export async function fetchLivePortfolio(executor: McpToolExecutor, now = new Date().toISOString()): Promise<LivePortfolio> {
  const account = await executor('spot.getAccount', { omitZeroBalances: true })
  const balances = normalizeSpotBalances(account)
  if (!balances.length) return { assets: [], source: 'binance-agent-os', asOf: now, empty: true }

  const nonStableSymbols = balances.filter((balance) => !stablecoinSymbols.has(balance.symbol)).map((balance) => `${balance.symbol}USDT`)
  const prices = await executor('spot.tickerPrice', { symbols: JSON.stringify(nonStableSymbols) })
  return normalizeLivePortfolio(account, prices, now)
}

function parseCookies(header: string | undefined) {
  const cookies = new Map<string, string>()
  for (const part of header?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=')
    if (key && value.length) cookies.set(key, decodeURIComponent(value.join('=')))
  }
  return cookies
}

function getSession(request: { headers: { cookie?: string } }, response: { setHeader: (name: string, value: string) => void }) {
  const existingId = parseCookies(request.headers.cookie).get(sessionCookieName)
  const sessionId = existingId && sessions.has(existingId) ? existingId : randomBytes(32).toString('hex')
  if (!sessions.has(sessionId)) sessions.set(sessionId, {})
  if (sessionId !== existingId) {
    response.setHeader('Set-Cookie', `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`)
  }
  return sessions.get(sessionId)!
}

function requirePublicUrl(value: string | undefined) {
  if (!value) throw new Error('OAuth is not configured. Set ROKAI_PUBLIC_URL to the public HTTPS URL of this Rokai server.')
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('OAuth requires ROKAI_PUBLIC_URL to use HTTPS.')
  return url.toString().replace(/\/$/, '')
}

function createOAuthProvider(session: BinanceSession, options: { publicUrl?: string; clientMetadataUrl?: string; redirectUrl?: string }, captureAuthorizationUrl?: (url: string) => void): OAuthClientProvider {
  const publicUrl = requirePublicUrl(options.publicUrl)
  const metadataUrl = options.clientMetadataUrl ?? `${publicUrl}${clientMetadataPath}`
  const redirectUrl = options.redirectUrl ?? `${publicUrl}${authCallbackPath}`
  const clientMetadata = {
    client_id: metadataUrl,
    client_name: 'Rokai',
    client_uri: publicUrl,
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
  return {
    redirectUrl,
    clientMetadataUrl: metadataUrl,
    get clientMetadata() { return clientMetadata },
    clientInformation: () => session.clientInformation,
    saveClientInformation: (information) => { session.clientInformation = information },
    tokens: () => session.tokens,
    saveTokens: (tokens) => { session.tokens = tokens },
    state: () => {
      session.state = randomBytes(24).toString('hex')
      return session.state
    },
    saveCodeVerifier: (codeVerifier) => { session.codeVerifier = codeVerifier },
    codeVerifier: () => {
      if (!session.codeVerifier) throw new Error('Binance OAuth PKCE state is missing or expired.')
      return session.codeVerifier
    },
    saveDiscoveryState: (state) => { session.discoveryState = state },
    discoveryState: () => session.discoveryState,
    redirectToAuthorization: (url) => { captureAuthorizationUrl?.(url.toString()) },
    invalidateCredentials: (scope) => {
      if (scope === 'all' || scope === 'tokens') session.tokens = undefined
      if (scope === 'all' || scope === 'client') session.clientInformation = undefined
      if (scope === 'all' || scope === 'verifier') session.codeVerifier = undefined
      if (scope === 'all' || scope === 'discovery') session.discoveryState = undefined
    },
  }
}

async function createMcpToolExecutor(options: { mcpUrl: string; session: BinanceSession; publicUrl?: string; clientMetadataUrl?: string; redirectUrl?: string; allowSpotExecution?: boolean }): Promise<{ executor: McpToolExecutor; close: () => Promise<void> }> {
  if (!options.session.tokens) throw new UnauthorizedError('Binance authorization is required.')
  const provider = createOAuthProvider(options.session, options)
  const transport = new StreamableHTTPClientTransport(new URL(options.mcpUrl), { authProvider: provider })
  const client = new Client({ name: 'rokai', version: '0.1.0' })
  await client.connect(transport)
  const liveWriteEnabled = options.allowSpotExecution === true && process.env.ROKAI_LIVE_EXECUTION?.trim().toLowerCase() === 'true'
  const allowedTools = new Set(liveWriteEnabled
    ? ['spot.getAccount', 'spot.tickerPrice', 'spot.exchangeInfo', 'spot.newOrder', 'spot.getOrder']
    : ['spot.getAccount', 'spot.tickerPrice'])
  return {
    executor: async (toolName, args) => {
      if (!allowedTools.has(toolName)) throw new Error('Rokai does not permit this Binance tool.')
      return client.callTool({ name: toolName, arguments: args })
    },
    close: () => client.close(),
  }
}

export type BinanceAgentOsHttpContext = {
  request: { headers: { cookie?: string } }
  response: { setHeader: (name: string, value: string) => void }
  publicUrl?: string
  clientMetadataUrl?: string
  redirectUrl?: string
}

/**
 * Standalone HTTP/OAuth compatibility path. The supported Codex hackathon
 * runtime does not use this function; it passes host-owned MCP read results to
 * createRokaiHostMediatedSession instead.
 */
export async function createRokaiAgentOsMcpConnection(options: BinanceAgentOsHttpContext) {
  const session = getSession(options.request, options.response)
  return createMcpToolExecutor({
    mcpUrl: officialBinanceMcpUrl,
    session,
    publicUrl: options.publicUrl,
    clientMetadataUrl: options.clientMetadataUrl,
    redirectUrl: options.redirectUrl,
    allowSpotExecution: true,
  })
}

export function binanceAgentOsApi(options: { mcpUrl?: string; publicUrl?: string; clientMetadataUrl?: string; redirectUrl?: string }): Plugin {
  const mcpUrl = options.mcpUrl || officialBinanceMcpUrl
  const registerApiRoutes = (server: Pick<ViteDevServer, 'middlewares'>) => {
      server.middlewares.use('/api/binance/client-metadata.json', (request, response) => {
        if (request.method !== 'GET') {
          response.statusCode = 405
          response.end('Only GET is supported.')
          return
        }
        try {
          const publicUrl = requirePublicUrl(options.publicUrl)
          const metadataUrl = options.clientMetadataUrl ?? `${publicUrl}${clientMetadataPath}`
          const redirectUrl = options.redirectUrl ?? `${publicUrl}${authCallbackPath}`
          response.statusCode = 200
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(JSON.stringify({
            client_id: metadataUrl,
            client_name: 'Rokai',
            client_uri: publicUrl,
            redirect_uris: [redirectUrl],
            grant_types: ['authorization_code'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          }))
        } catch (error) {
          response.statusCode = 503
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'OAuth is not configured.' }))
        }
      })

      server.middlewares.use('/api/binance/auth/start', async (request, response) => {
        const send = (status: number, body: Record<string, unknown>) => {
          response.statusCode = status
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(JSON.stringify(body))
        }
        if (request.method !== 'GET') {
          send(405, { error: 'Only GET is supported.' })
          return
        }
        const session = getSession(request, response)
        let authorizationUrl: string | undefined
        try {
          const provider = createOAuthProvider(session, options, (url) => { authorizationUrl = url })
          const result = await auth(provider, { serverUrl: mcpUrl })
          if (result !== 'REDIRECT' || !authorizationUrl) throw new Error('Binance OAuth did not return an authorization URL.')
          send(200, { authorizationUrl })
        } catch (error) {
          send(502, { error: error instanceof Error ? error.message : 'Binance authorization could not be started.' })
        }
      })

      server.middlewares.use('/api/binance/auth/callback', async (request, response) => {
        const query = new URL(request.url ?? '/', 'http://rokai.local').searchParams
        const session = getSession(request, response)
        if (request.method !== 'GET') {
          response.statusCode = 405
          response.end('Only GET is supported.')
          return
        }
        if (query.get('error')) {
          response.statusCode = 400
          response.end(`Binance authorization was not completed: ${query.get('error')}`)
          return
        }
        const code = query.get('code')
        const state = query.get('state')
        if (!code || !state || state !== session.state) {
          response.statusCode = 400
          response.end('Binance authorization returned an invalid state.')
          return
        }
        try {
          const provider = createOAuthProvider(session, options)
          const result = await auth(provider, { serverUrl: mcpUrl, authorizationCode: code })
          if (result !== 'AUTHORIZED') throw new Error('Binance authorization did not complete.')
          session.codeVerifier = undefined
          session.state = undefined
          response.statusCode = 302
          response.setHeader('Location', '/?binance=connected')
          response.end()
        } catch (error) {
          response.statusCode = 502
          response.end(`Binance authorization failed safely: ${error instanceof Error ? error.message : 'unknown error'}`)
        }
      })

      server.middlewares.use('/api/binance/auth/status', (request, response) => {
        const session = getSession(request, response)
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({ connected: Boolean(session.tokens) }))
      })

      server.middlewares.use('/api/live-portfolio', async (request, response) => {
        const send = (status: number, body: Record<string, unknown>) => {
          response.statusCode = status
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(JSON.stringify(body))
        }
        if (request.method !== 'GET') {
          send(405, { error: 'Only GET is supported.' })
          return
        }
        const session = getSession(request, response)
        if (!session.tokens) {
          send(401, { error: 'Binance authorization is required before Live Mode can read the Agentic Spot account.', authorizationRequired: true })
          return
        }
        let connection: { executor: McpToolExecutor; close: () => Promise<void> } | undefined
        try {
          connection = await createMcpToolExecutor({ mcpUrl, session, publicUrl: options.publicUrl, clientMetadataUrl: options.clientMetadataUrl, redirectUrl: options.redirectUrl })
          const portfolio = await fetchLivePortfolio(connection.executor)
          send(200, portfolio)
        } catch (error) {
          if (error instanceof UnauthorizedError) {
            session.tokens = undefined
            send(401, { error: 'Binance authorization has expired. Reconnect to continue.', authorizationRequired: true })
          } else {
            send(502, { error: error instanceof Error ? error.message : 'Binance Agent OS data could not be loaded safely.' })
          }
        } finally {
          await connection?.close()
        }
      })
  }
  return {
    name: 'rokai-binance-agent-os-api',
    configureServer: registerApiRoutes,
    configurePreviewServer: registerApiRoutes,
  }
}
