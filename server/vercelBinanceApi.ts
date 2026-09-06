import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { fetchLivePortfolio, type McpToolExecutor } from './binanceAgentOsApi.js'

const officialBinanceMcpUrl = 'https://agent.binance.com/mcp/agentic'
const sessionCookieName = 'rokai_binance_session'
const clientMetadataPath = '/api/binance/client-metadata.json'
const authCallbackPath = '/api/binance/auth/callback'
const sessionMaxAge = 60 * 60 * 24 * 30

type SessionData = {
  tokens?: OAuthTokens
  codeVerifier?: string
  state?: string
  stateIssuedAt?: number
}

type BinanceConfig = {
  mcpUrl: string
  publicUrl?: string
  clientMetadataUrl?: string
  redirectUrl?: string
}

function config(): BinanceConfig {
  return {
    mcpUrl: process.env.BINANCE_AGENT_OS_MCP_URL || officialBinanceMcpUrl,
    publicUrl: process.env.ROKAI_PUBLIC_URL,
    clientMetadataUrl: process.env.BINANCE_OAUTH_CLIENT_METADATA_URL,
    redirectUrl: process.env.BINANCE_OAUTH_REDIRECT_URL,
  }
}

function sessionKey() {
  const secret = process.env.ROKAI_SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error('Session storage is not configured. Set ROKAI_SESSION_SECRET to a random value of at least 32 characters.')
  return createHash('sha256').update(secret).digest()
}

function hasSessionSecret() {
  const secret = process.env.ROKAI_SESSION_SECRET
  return Boolean(secret && secret.length >= 32)
}

function encode(value: Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

function decode(value: string) {
  return Buffer.from(value, 'base64url')
}

function seal(session: SessionData) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()])
  return `${encode(iv)}.${encode(encrypted)}.${encode(cipher.getAuthTag())}`
}

function unseal(value: string | undefined): SessionData {
  if (!value) return {}
  try {
    const [ivValue, encryptedValue, tagValue] = value.split('.')
    if (!ivValue || !encryptedValue || !tagValue) return {}
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(), decode(ivValue))
    decipher.setAuthTag(decode(tagValue))
    const plaintext = Buffer.concat([decipher.update(decode(encryptedValue)), decipher.final()]).toString('utf8')
    const parsed = JSON.parse(plaintext) as unknown
    return parsed && typeof parsed === 'object' ? parsed as SessionData : {}
  } catch {
    return {}
  }
}

function cookieValue(request: Request) {
  const cookie = request.headers.get('cookie') ?? ''
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${sessionCookieName}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : undefined
}

function requirePublicUrl(value: string | undefined) {
  if (!value) throw new Error('OAuth is not configured. Set ROKAI_PUBLIC_URL to the deployed HTTPS URL of this Rokai project.')
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('OAuth requires ROKAI_PUBLIC_URL to use HTTPS.')
  return url.toString().replace(/\/$/, '')
}

function oauthSettings(options: BinanceConfig) {
  const publicUrl = requirePublicUrl(options.publicUrl)
  const metadataUrl = options.clientMetadataUrl ?? `${publicUrl}${clientMetadataPath}`
  const redirectUrl = options.redirectUrl ?? `${publicUrl}${authCallbackPath}`
  return { publicUrl, metadataUrl, redirectUrl }
}

function createProvider(session: SessionData, options: BinanceConfig, captureAuthorizationUrl?: (url: string) => void): OAuthClientProvider {
  const { publicUrl, metadataUrl, redirectUrl } = oauthSettings(options)
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
    clientInformation: () => ({ client_id: metadataUrl }),
    tokens: () => session.tokens,
    saveTokens: (tokens) => { session.tokens = tokens },
    state: () => {
      session.state = randomBytes(24).toString('hex')
      session.stateIssuedAt = Date.now()
      return session.state
    },
    saveCodeVerifier: (codeVerifier) => { session.codeVerifier = codeVerifier },
    codeVerifier: () => {
      if (!session.codeVerifier) throw new Error('Binance OAuth PKCE state is missing or expired.')
      return session.codeVerifier
    },
    redirectToAuthorization: (url) => { captureAuthorizationUrl?.(url.toString()) },
    invalidateCredentials: (scope) => {
      if (scope === 'all' || scope === 'tokens') session.tokens = undefined
      if (scope === 'all' || scope === 'verifier') session.codeVerifier = undefined
      if (scope === 'all') session.state = undefined
    },
  }
}

function readSession(request: Request) {
  return unseal(cookieValue(request))
}

function response(body: BodyInit | null, status: number, session?: SessionData, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers)
  if (session) {
    responseHeaders.set('Set-Cookie', `${sessionCookieName}=${encodeURIComponent(seal(session))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionMaxAge}`)
  }
  return new Response(body, { status, headers: responseHeaders })
}

function json(body: Record<string, unknown>, status: number, session?: SessionData) {
  return response(JSON.stringify(body), status, session, { 'Content-Type': 'application/json; charset=utf-8' })
}

async function createMcpExecutor(options: BinanceConfig, session: SessionData): Promise<{ executor: McpToolExecutor; close: () => Promise<void> }> {
  if (!session.tokens) throw new UnauthorizedError('Binance authorization is required.')
  const provider = createProvider(session, options)
  const transport = new StreamableHTTPClientTransport(new URL(options.mcpUrl), { authProvider: provider })
  const client = new Client({ name: 'rokai', version: '0.1.0' })
  await client.connect(transport)
  return {
    executor: async (toolName, args) => {
      if (toolName !== 'spot.getAccount' && toolName !== 'spot.tickerPrice') throw new Error('Rokai only permits read-only Binance Spot tools.')
      return client.callTool({ name: toolName, arguments: args })
    },
    close: () => client.close(),
  }
}

export async function handleVercelBinanceApi(route: 'metadata' | 'auth-start' | 'auth-callback' | 'auth-status' | 'live-portfolio', request: Request): Promise<Response> {
  const options = config()
  if (route === 'metadata') {
    if (request.method !== 'GET') return json({ error: 'Only GET is supported.' }, 405)
    try {
      const { publicUrl, metadataUrl, redirectUrl } = oauthSettings(options)
      return json({ client_id: metadataUrl, client_name: 'Rokai', client_uri: publicUrl, redirect_uris: [redirectUrl], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }, 200)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'OAuth is not configured.' }, 503)
    }
  }

  if (!hasSessionSecret()) return json({ error: 'Session storage is not configured. Set ROKAI_SESSION_SECRET on the server.' }, 503)

  const session = readSession(request)
  if (route === 'auth-status') return json({ connected: Boolean(session.tokens) }, 200, session)
  if (request.method !== 'GET') return json({ error: 'Only GET is supported.' }, 405, session)

  if (route === 'auth-start') {
    let authorizationUrl: string | undefined
    try {
      const provider = createProvider(session, options, (url) => { authorizationUrl = url })
      const result = await auth(provider, { serverUrl: options.mcpUrl })
      if (result !== 'REDIRECT' || !authorizationUrl) throw new Error('Binance OAuth did not return an authorization URL.')
      return json({ authorizationUrl }, 200, session)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Binance authorization could not be started.' }, 502, session)
    }
  }

  if (route === 'auth-callback') {
    const url = new URL(request.url)
    const error = url.searchParams.get('error')
    if (error) return response(`Binance authorization was not completed: ${error}`, 400, session)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const stateIsFresh = session.stateIssuedAt !== undefined && Date.now() - session.stateIssuedAt < 10 * 60 * 1000
    if (!code || !state || state !== session.state || !stateIsFresh) return response('Binance authorization returned an invalid or expired state.', 400, session)
    try {
      const provider = createProvider(session, options)
      const result = await auth(provider, { serverUrl: options.mcpUrl, authorizationCode: code })
      if (result !== 'AUTHORIZED') throw new Error('Binance authorization did not complete.')
      session.codeVerifier = undefined
      session.state = undefined
      session.stateIssuedAt = undefined
      const location = new URL('/', requirePublicUrl(options.publicUrl))
      location.searchParams.set('binance', 'connected')
      return response(null, 302, session, { Location: location.toString() })
    } catch (callbackError) {
      return response(`Binance authorization failed safely: ${callbackError instanceof Error ? callbackError.message : 'unknown error'}`, 502, session)
    }
  }

  if (route === 'live-portfolio') {
    if (!session.tokens) return json({ error: 'Binance authorization is required before Live Mode can read the Agentic Spot account.', authorizationRequired: true }, 401, session)
    let connection: { executor: McpToolExecutor; close: () => Promise<void> } | undefined
    try {
      connection = await createMcpExecutor(options, session)
      return json(await fetchLivePortfolio(connection.executor), 200, session)
    } catch (liveError) {
      if (liveError instanceof UnauthorizedError) {
        session.tokens = undefined
        return json({ error: 'Binance authorization has expired. Reconnect to continue.', authorizationRequired: true }, 401, session)
      }
      return json({ error: liveError instanceof Error ? liveError.message : 'Binance Agent OS data could not be loaded safely.' }, 502, session)
    } finally {
      await connection?.close()
    }
  }

  return json({ error: 'Unknown Binance API route.' }, 404, session)
}
