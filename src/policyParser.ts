import type { Policy, Rule } from './rules.ts'

export type StructuredPolicy = {
  minStablecoinPercent?: number
  minStablecoinAsset?: string
  protectedAssets?: string[]
  maxAssetPercent?: number
  ambiguous?: boolean
  reason?: string
}

export type PolicyParseResult = {
  policy: Policy | null
  source: 'gemini' | 'none'
  error?: string
}

type NormalizedPolicy = {
  policy: Policy | null
  structured?: StructuredPolicy
  error?: string
}

const allowedFields = new Set([
  'minStablecoinPercent',
  'minStablecoinAsset',
  'protectedAssets',
  'maxAssetPercent',
  'ambiguous',
  'reason',
])

const symbolPattern = /^[A-Z][A-Z0-9]{1,11}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

function normalizeSymbol(value: unknown) {
  if (typeof value !== 'string') return null
  const symbol = value.trim().toUpperCase()
  return symbolPattern.test(symbol) ? symbol : null
}

export function normalizeStructuredPolicy(value: unknown, sourceText: string): NormalizedPolicy {
  if (!isRecord(value)) return { policy: null, error: 'Gemini returned an invalid policy object.' }

  if (Object.keys(value).some((key) => !allowedFields.has(key))) {
    return { policy: null, error: 'Gemini returned an unsupported rule type.' }
  }

  if (value.ambiguous === true) {
    return { policy: null, error: typeof value.reason === 'string' && value.reason.trim() ? value.reason : 'That policy is ambiguous. State a clear minimum, protection, or maximum rule.' }
  }

  if (value.ambiguous !== undefined && typeof value.ambiguous !== 'boolean') {
    return { policy: null, error: 'Gemini returned an invalid ambiguity flag.' }
  }

  if (value.reason !== undefined && typeof value.reason !== 'string') {
    return { policy: null, error: 'Gemini returned an invalid policy explanation.' }
  }

  const hasMinPercent = value.minStablecoinPercent !== undefined
  const hasMinAsset = value.minStablecoinAsset !== undefined
  if (hasMinPercent && !validPercent(value.minStablecoinPercent)) {
    return { policy: null, error: 'Stablecoin percentages must be between 0% and 100%.' }
  }
  if (hasMinAsset && !normalizeSymbol(value.minStablecoinAsset)) {
    return { policy: null, error: 'Gemini returned a malformed stablecoin symbol.' }
  }
  if (hasMinAsset && !hasMinPercent) {
    return { policy: null, error: 'Gemini returned a stablecoin without a minimum percentage.' }
  }

  let protectedAssets: string[] = []
  if (value.protectedAssets !== undefined) {
    if (!Array.isArray(value.protectedAssets) || value.protectedAssets.some((asset) => !normalizeSymbol(asset))) {
      return { policy: null, error: 'Gemini returned a malformed protected asset symbol.' }
    }
    protectedAssets = [...new Set(value.protectedAssets.map((asset) => normalizeSymbol(asset)!))]
  }

  const hasMaxPercent = value.maxAssetPercent !== undefined
  if (hasMaxPercent && !validPercent(value.maxAssetPercent)) {
    return { policy: null, error: 'Maximum exposure percentages must be between 0% and 100%.' }
  }

  const rules: Rule[] = []
  const minStablecoinAsset = hasMinAsset ? normalizeSymbol(value.minStablecoinAsset)! : 'USDC'
  if (hasMinPercent) rules.push({ kind: 'min_stablecoin', asset: minStablecoinAsset, minPct: value.minStablecoinPercent as number })
  protectedAssets.forEach((asset) => rules.push({ kind: 'protected_asset', asset }))
  if (hasMaxPercent) rules.push({ kind: 'max_asset_exposure', asset: 'altcoins', maxPct: value.maxAssetPercent as number })

  if (!rules.length) return { policy: null, error: 'No supported rules were found. Try a minimum stablecoin, protected asset, or maximum exposure rule.' }

  const structured: StructuredPolicy = {}
  if (hasMinPercent) {
    structured.minStablecoinPercent = value.minStablecoinPercent as number
    structured.minStablecoinAsset = minStablecoinAsset
  }
  if (protectedAssets.length) structured.protectedAssets = protectedAssets
  if (hasMaxPercent) structured.maxAssetPercent = value.maxAssetPercent as number

  return { policy: { rules, sourceText }, structured }
}

export async function requestPolicyParse(sourceText: string): Promise<PolicyParseResult> {
  try {
    const response = await fetch('/api/parse-policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sourceText }),
    })
    const payload = await response.json() as { structured?: unknown; error?: string }
    if (!response.ok) return { policy: null, source: 'none', error: payload.error ?? 'Gemini could not parse that policy.' }

    const normalized = normalizeStructuredPolicy(payload.structured, sourceText)
    return normalized.policy
      ? { policy: normalized.policy, source: 'gemini' }
      : { policy: null, source: 'none', error: normalized.error }
  } catch {
    return { policy: null, source: 'none', error: 'Gemini is unavailable right now. Check the server and try again.' }
  }
}
