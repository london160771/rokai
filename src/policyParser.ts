import type { Policy, Rule } from './rules.js'

export type StructuredPolicy = {
  minStablecoinPercent?: number
  minStablecoinAsset?: string
  minStablecoinAmount?: { asset: string; minAmount: number }
  minAssetAllocation?: { asset: string; minPct: number }
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
  'minStablecoinAmount',
  'minAssetAllocation',
  'protectedAssets',
  'maxAssetPercent',
  'ambiguous',
  'reason',
])

const symbolPattern = /^[A-Z][A-Z0-9]{1,11}$/
const stablecoinSymbols = new Set(['USDC', 'USDT', 'BUSD', 'FDUSD', 'DAI', 'USDE'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

function validAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
}

function normalizeSymbol(value: unknown) {
  if (typeof value !== 'string') return null
  const symbol = value.trim().toUpperCase()
  return symbolPattern.test(symbol) ? symbol : null
}

type ApiJsonResult<T> =
  | { ok: true; payload: T }
  | { ok: false; error: string }

export async function readApiJson<T>(response: Response, fallback: string): Promise<ApiJsonResult<T>> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''

  if (!response.ok) {
    if (response.status >= 500 || !contentType.includes('json')) return { ok: false, error: fallback }
    try {
      const body = await response.json() as unknown
      if (isRecord(body) && typeof body.error === 'string' && body.error.trim()) {
        return { ok: false, error: body.error }
      }
    } catch {
      // A non-JSON or truncated error body should never leak a parser exception to the UI.
    }
    return { ok: false, error: fallback }
  }

  if (!contentType.includes('json')) {
    return { ok: false, error: 'Rokai received an invalid server response. Please try again.' }
  }

  try {
    return { ok: true, payload: await response.json() as T }
  } catch {
    return { ok: false, error: 'Rokai received an invalid server response. Please try again.' }
  }
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

  let minStablecoinAmount: { asset: string; minAmount: number } | undefined
  if (value.minStablecoinAmount !== undefined) {
    if (!isRecord(value.minStablecoinAmount) || Object.keys(value.minStablecoinAmount).some((key) => !['asset', 'minAmount'].includes(key))) {
      return { policy: null, error: 'Gemini returned an invalid stablecoin amount rule.' }
    }
    const asset = normalizeSymbol(value.minStablecoinAmount.asset)
    if (!asset || !stablecoinSymbols.has(asset)) {
      return { policy: null, error: 'Gemini returned a malformed stablecoin amount asset.' }
    }
    if (!validAmount(value.minStablecoinAmount.minAmount)) {
      return { policy: null, error: 'Stablecoin minimum amounts must be non-negative and finite.' }
    }
    minStablecoinAmount = { asset, minAmount: value.minStablecoinAmount.minAmount }
  }

  let minAssetAllocation: { asset: string; minPct: number } | undefined
  if (value.minAssetAllocation !== undefined) {
    if (!isRecord(value.minAssetAllocation) || Object.keys(value.minAssetAllocation).some((key) => !['asset', 'minPct'].includes(key))) {
      return { policy: null, error: 'Gemini returned an invalid minimum allocation rule.' }
    }
    const asset = normalizeSymbol(value.minAssetAllocation.asset)
    if (!asset) return { policy: null, error: 'Gemini returned a malformed minimum allocation asset.' }
    if (!validPercent(value.minAssetAllocation.minPct)) {
      return { policy: null, error: 'Minimum allocation percentages must be between 0% and 100%.' }
    }
    minAssetAllocation = { asset, minPct: value.minAssetAllocation.minPct }
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
  if (minStablecoinAmount) rules.push({ kind: 'min_stablecoin_amount', ...minStablecoinAmount })
  if (minAssetAllocation) rules.push({ kind: 'min_asset_allocation', ...minAssetAllocation })
  protectedAssets.forEach((asset) => rules.push({ kind: 'protected_asset', asset }))
  if (hasMaxPercent) rules.push({ kind: 'max_asset_exposure', asset: 'altcoins', maxPct: value.maxAssetPercent as number })

  if (!rules.length) return { policy: null, error: 'No supported rules were found. Try a minimum stablecoin, protected asset, or maximum exposure rule.' }

  const structured: StructuredPolicy = {}
  if (hasMinPercent) {
    structured.minStablecoinPercent = value.minStablecoinPercent as number
    structured.minStablecoinAsset = minStablecoinAsset
  }
  if (minStablecoinAmount) structured.minStablecoinAmount = minStablecoinAmount
  if (minAssetAllocation) structured.minAssetAllocation = minAssetAllocation
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
    const result = await readApiJson<{ structured?: unknown }>(response, 'Gemini could not parse that policy.')
    if (result.ok === false) return { policy: null, source: 'none', error: result.error }

    const normalized = normalizeStructuredPolicy(result.payload.structured, sourceText)
    return normalized.policy
      ? { policy: normalized.policy, source: 'gemini' }
      : { policy: null, source: 'none', error: normalized.error }
  } catch {
    return { policy: null, source: 'none', error: 'Gemini is unavailable right now. Check the server and try again.' }
  }
}
