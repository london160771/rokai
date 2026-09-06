import { access } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (/^(?:\.\/|\.\.\/)/.test(specifier) && !/[.][cm]?[jt]sx?(?:[?#].*)?$/.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL)
    try {
      await access(fileURLToPath(candidate))
      return nextResolve(pathToFileURL(fileURLToPath(candidate)).href, context)
    } catch {
      // Let Node report the original resolution error when no TypeScript file exists.
    }
  }
  return nextResolve(specifier, context)
}
