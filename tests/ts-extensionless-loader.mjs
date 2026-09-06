import { access } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (/^(?:\.\/|\.\.\/)/.test(specifier)) {
    const candidateSpecifier = specifier.endsWith('.js')
      ? `${specifier.slice(0, -3)}.ts`
      : !/[.][cm]?[jt]sx?(?:[?#].*)?$/.test(specifier)
        ? `${specifier}.ts`
        : null
    if (!candidateSpecifier) return nextResolve(specifier, context)

    const candidate = new URL(candidateSpecifier, context.parentURL)
    try {
      await access(fileURLToPath(candidate))
      return nextResolve(pathToFileURL(fileURLToPath(candidate)).href, context)
    } catch {
      // Let Node report the original resolution error when no TypeScript file exists.
    }
  }
  return nextResolve(specifier, context)
}
