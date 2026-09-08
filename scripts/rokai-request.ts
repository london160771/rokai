import { readFile } from 'node:fs/promises'
import { writeRokaiFileRequest } from '../server/rokaiFileTransport.js'

function usage() {
  process.stdout.write('Usage: npm run --silent rokai:request -- --runtime-directory <path> --capability <value> <request-file>\n')
}

function argumentValue(args: string[], name: string) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function waitForResponse(path: string) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, { encoding: 'utf8' }))
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error('Timed out waiting for the active Rokai Ready Mode response.')
}

const args = process.argv.slice(2)
if (args.includes('--help')) {
  usage()
} else {
  try {
    const requestFile = args[args.length - 1]
    const requestDirectory = argumentValue(args, '--runtime-directory')
    const capability = argumentValue(args, '--capability')
    if (!requestFile || requestFile.startsWith('--') || !requestDirectory || !capability) {
      usage()
      throw new Error('A request file, Ready Mode request directory, and Ready Mode capability are required.')
    }
    const request = JSON.parse(await readFile(requestFile, { encoding: 'utf8' }))
    const receipt = await writeRokaiFileRequest(requestDirectory, capability, request)
    const response = await waitForResponse(receipt.responsePath)
    process.stdout.write(`${JSON.stringify(response)}\n`)
    if (response && typeof response === 'object' && 'ok' in response && response.ok === false) process.exitCode = 1
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, runtime: 'rokai', operation: 'error', error: error instanceof Error ? error.message : 'The Rokai request could not be submitted.' }) + '\n')
    process.exitCode = 1
  }
}
