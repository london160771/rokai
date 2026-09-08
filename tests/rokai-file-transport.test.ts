import assert from 'node:assert/strict'
import { access, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRokaiFileTransport, writeRokaiFileRequest } from '../server/rokaiFileTransport.js'

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, { encoding: 'utf8' })
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

const seen: unknown[] = []
const transport = await createRokaiFileTransport(async (request) => {
  seen.push(request)
  return { ok: true, receivedBytes: JSON.stringify(request).length }
})

try {
  assert.equal(transport.info.mode, 'local-file')
  assert.equal(transport.info.requestSuffix, '.request.json')
  assert.equal(transport.info.responseSuffix, '.response.json')

  const largeRequest = { op: 'start', policyText: 'x'.repeat(5_000), reads: { exchangeInfo: 'cached-metadata' } }
  const receipt = await writeRokaiFileRequest(transport.info.requestDirectory, transport.info.capability, largeRequest)
  assert.equal(receipt.requestId.length > 0, true)
  assert.match(receipt.requestPath, /\.request\.json$/)

  const response = JSON.parse(await waitForFile(receipt.responsePath)) as { ok: boolean; receivedBytes: number }
  assert.equal(response.ok, true)
  assert.ok(response.receivedBytes > 5_000)
  assert.deepEqual(seen, [largeRequest])
  await assert.rejects(() => access(receipt.requestPath))

  const unauthorizedId = randomUUID()
  const unauthorizedRequestFile = join(transport.info.requestDirectory, `${unauthorizedId}.request.json`)
  const unauthorizedResponseFile = join(transport.info.requestDirectory, `${unauthorizedId}.response.json`)
  const unauthorizedTemporaryFile = join(transport.info.requestDirectory, `.${unauthorizedId}.tmp`)
  await writeFile(unauthorizedTemporaryFile, JSON.stringify({ capability: 'not-the-runtime-capability', requestId: unauthorizedId, request: { op: 'start' } }), { encoding: 'utf8' })
  await rename(unauthorizedTemporaryFile, unauthorizedRequestFile)
  const unauthorized = JSON.parse(await waitForFile(unauthorizedResponseFile)) as { ok: boolean; error: string }
  assert.equal(unauthorized.ok, false)
  assert.match(unauthorized.error, /capability|request ID/i)
  assert.equal(seen.length, 1)
} finally {
  await transport.close()
}

console.log('Rokai file transport fixtures passed')
