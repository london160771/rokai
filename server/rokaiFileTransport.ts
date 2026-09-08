import { randomBytes, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type RokaiFileRequestHandler = (request: unknown) => unknown | Promise<unknown>

export type RokaiFileTransportInfo = Readonly<{
  mode: 'local-file'
  requestDirectory: string
  capability: string
  requestSuffix: '.request.json'
  responseSuffix: '.response.json'
}>

export type RokaiFileTransport = Readonly<{
  info: RokaiFileTransportInfo
  wait: () => Promise<void>
  close: () => Promise<void>
}>

export type RokaiFileRequestReceipt = Readonly<{
  requestId: string
  requestPath: string
  responsePath: string
}>

const requestPattern = /^([A-Za-z0-9_-]{8,64})\.request\.json$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestIdFromFile(fileName: string) {
  const match = requestPattern.exec(fileName)
  return match?.[1]
}

function errorResponse(error: string) {
  return { ok: false, runtime: 'rokai', operation: 'error', error }
}

async function writeResponse(directory: string, requestId: string, value: unknown) {
  const responsePath = join(directory, `${requestId}.response.json`)
  const temporaryPath = join(directory, `.${requestId}.${randomUUID()}.tmp`)
  const serialized = JSON.stringify(value) ?? JSON.stringify(errorResponse('The Rokai runtime returned an invalid response.'))
  await writeFile(temporaryPath, serialized, { encoding: 'utf8' })
  await rename(temporaryPath, responsePath)
}

/**
 * Submit one structured runtime request through an already-running Ready
 * Mode instance. The caller supplies only the per-process capability reported
 * at startup; all request IDs and filenames are generated here.
 */
export async function writeRokaiFileRequest(requestDirectory: string, capability: string, request: unknown): Promise<RokaiFileRequestReceipt> {
  if (!requestDirectory.trim() || !capability.trim()) throw new Error('A Ready Mode request directory and capability are required.')
  if (!isRecord(request) || typeof request.op !== 'string') throw new Error('The Rokai request file must contain one structured runtime operation.')
  const requestId = randomUUID()
  const requestPath = join(requestDirectory, `${requestId}.request.json`)
  const temporaryPath = join(requestDirectory, `.${requestId}.${randomUUID()}.tmp`)
  const envelope = { capability, requestId, request }
  await writeFile(temporaryPath, JSON.stringify(envelope), { encoding: 'utf8' })
  await rename(temporaryPath, requestPath)
  return { requestId, requestPath, responsePath: join(requestDirectory, `${requestId}.response.json`) }
}

/**
 * A local-only, capability-bound request inbox for Ready Mode. It uses files
 * created in a runtime-owned temporary directory, not stdin, a named pipe, or
 * a network listener. Callers must atomically place a structured envelope in
 * the reported directory; responses are written beside the consumed request.
 */
export async function createRokaiFileTransport(handler: RokaiFileRequestHandler): Promise<RokaiFileTransport> {
  const requestDirectory = await mkdtemp(join(tmpdir(), 'rokai-ready-'))
  const capability = randomBytes(32).toString('hex')
  const queued = new Set<string>()
  const seen = new Set<string>()
  const inFlight = new Set<Promise<void>>()
  let closing = false
  let closePromise: Promise<void> | undefined
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })

  const consume = async (fileName: string) => {
    const requestId = requestIdFromFile(fileName)
    if (!requestId || closing || queued.has(fileName) || seen.has(requestId)) return
    queued.add(fileName)
    seen.add(requestId)
    const requestPath = join(requestDirectory, fileName)
    try {
      // A writer may rename the completed file while the filesystem watcher
      // is still delivering the event. The short debounce avoids partial reads
      // without adding a meaningful policy or execution delay.
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      let response: unknown
      try {
        const parsed: unknown = JSON.parse(await readFile(requestPath, { encoding: 'utf8' }))
        if (!isRecord(parsed) || parsed.capability !== capability || parsed.requestId !== requestId) {
          response = errorResponse('The Rokai file request capability or request ID is invalid.')
        } else if (!isRecord(parsed.request) || typeof parsed.request.op !== 'string') {
          response = errorResponse('The Rokai file request must contain one structured runtime operation.')
        } else {
          try {
            response = await handler(parsed.request)
          } catch (error) {
            response = errorResponse(error instanceof Error ? error.message : 'The Rokai runtime could not process the request.')
          }
        }
      } catch (error) {
        response = errorResponse(error instanceof Error ? error.message : 'The Rokai file request is not valid JSON.')
      }
      await writeResponse(requestDirectory, requestId, response)
      await unlink(requestPath).catch(() => undefined)
    } finally {
      queued.delete(fileName)
    }
  }

  const watcher: FSWatcher = watch(requestDirectory, (_eventType, fileName) => {
    const name = fileName?.toString()
    if (!name) return
    const operation = consume(name)
    inFlight.add(operation)
    void operation.then(() => inFlight.delete(operation), () => inFlight.delete(operation))
  })

  const close = async () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      closing = true
      watcher.close()
      await Promise.all([...inFlight])
      resolveClosed()
      await rm(requestDirectory, { recursive: true, force: true })
    })()
    return closePromise
  }

  return {
    info: {
      mode: 'local-file',
      requestDirectory,
      capability,
      requestSuffix: '.request.json',
      responseSuffix: '.response.json',
    },
    wait: () => closed,
    close,
  }
}
