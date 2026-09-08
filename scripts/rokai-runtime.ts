import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createRokaiRuntimeController, runRokaiRuntime } from '../server/rokaiRuntime.js'

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function usage() {
  process.stdout.write('Usage: npm run rokai -- --input-file <path> | --input-json <json> | --stdin\n')
  process.stdout.write('Persistent host session: npm run rokai -- --interactive\n')
  process.stdout.write('Ready Mode: npm run rokai -- --ready\n')
}

function argumentValue(args: string[], name: string) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function readOneShotInput(args: string[]) {
  const json = argumentValue(args, '--input-json')
  if (json !== undefined) return json
  const file = argumentValue(args, '--input-file')
  if (file !== undefined) return await readFile(file, { encoding: 'utf8' })
  if (args.includes('--stdin') || args.length === 0) {
    const chunks: string[] = []
    for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return chunks.join('')
  }
  return null
}

async function runPersistent(announceReady = false) {
  const controller = createRokaiRuntimeController()
  if (announceReady) output(controller.handle({ op: 'ready' }))
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      output(controller.handle(JSON.parse(line)))
    } catch (error) {
      output({ ok: false, runtime: 'rokai', operation: 'error', error: error instanceof Error ? error.message : 'Invalid runtime JSON.' })
    }
  }
}

const args = process.argv.slice(2)
if (args.includes('--help')) {
  usage()
} else if (args.includes('--interactive')) {
  await runPersistent()
} else if (args.includes('--ready')) {
  await runPersistent(true)
} else {
  try {
    const raw = await readOneShotInput(args)
    if (raw === null) {
      usage()
      process.exitCode = 1
    } else {
      const response = runRokaiRuntime(JSON.parse(await raw))
      output(response)
      if (!response.ok) process.exitCode = 1
    }
  } catch (error) {
    output({ ok: false, runtime: 'rokai', operation: 'error', error: error instanceof Error ? error.message : 'Invalid runtime input.' })
    process.exitCode = 1
  }
}
