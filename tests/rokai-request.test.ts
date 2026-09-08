import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const loader = './tests/ts-extensionless-loader.mjs'
const runtime = spawn(process.execPath, ['--experimental-strip-types', '--experimental-loader', loader, 'scripts/rokai-runtime.ts', '--ready'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
})

const readyLine = new Promise<string>((resolve, reject) => {
  const lines = createInterface({ input: runtime.stdout!, crlfDelay: Infinity })
  const timer = setTimeout(() => reject(new Error('Timed out waiting for Ready Mode startup.')), 20_000)
  lines.on('line', (line) => {
    if (!line.trim().startsWith('{')) return
    clearTimeout(timer)
    lines.close()
    resolve(line)
  })
  runtime.once('error', reject)
})

let inputDirectory: string | undefined
try {
  const ready = JSON.parse(await readyLine) as { ok: boolean; transport?: { requestDirectory: string; capability: string } }
  assert.equal(ready.ok, true)
  assert.ok(ready.transport?.requestDirectory)
  assert.ok(ready.transport?.capability)

  inputDirectory = await mkdtemp(join(tmpdir(), 'rokai-request-input-'))
  const inputPath = join(inputDirectory, 'start.json')
  await writeFile(inputPath, JSON.stringify({ op: 'ready' }), { encoding: 'utf8' })
  const helper = spawn(process.execPath, ['--experimental-strip-types', '--experimental-loader', loader, 'scripts/rokai-request.ts', '--runtime-directory', ready.transport!.requestDirectory, '--capability', ready.transport!.capability, inputPath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const helperOutputStream = helper.stdout
  if (!helperOutputStream) throw new Error('The request helper did not expose stdout.')
  const outputChunks: Buffer[] = []
  helperOutputStream.on('data', (chunk) => outputChunks.push(Buffer.from(chunk)))
  const [exitCode] = await once(helper, 'close') as [number | null]
  const helperOutput = await readFile(inputPath, { encoding: 'utf8' }).catch(() => '')
  assert.equal(exitCode, 0, helperOutput)
  // The helper's stdout is intentionally consumed from the process stream,
  // while the large request itself stayed in the input file.
  const response = JSON.parse(Buffer.concat(outputChunks).toString('utf8')) as { ok: boolean; operation: string }
  assert.equal(response.ok, true)
  assert.equal(response.operation, 'ready')
} finally {
  if (runtime.exitCode === null && !runtime.killed) {
    runtime.kill()
    await once(runtime, 'close').catch(() => undefined)
  }
  if (inputDirectory) await rm(inputDirectory, { recursive: true, force: true })
}

console.log('Rokai request helper fixtures passed')
