import type { Asset } from './mockData'

export type Rule =
  | { kind: 'min_stablecoin'; asset: string; minPct: number }
  | { kind: 'protected_asset'; asset: string }
  | { kind: 'max_asset_exposure'; asset: string | 'altcoins'; maxPct: number }

export type Policy = { rules: Rule[]; sourceText: string }

export type ValuedAsset = Asset & { valueUsd: number; allocationPct: number }

export type RuleResult = {
  rule: Rule
  passed: boolean
  currentPct: number | null
  targetPct: number
  detail: string
}

export type PlanAction = {
  source: string
  target: string
  amountUsd: number
  sourceQuantity: number
  rationale: string
}

export type Plan = {
  actions: PlanAction[]
  warnings: string[]
  estimatedResults: string[]
  safe: boolean
}

export function valuePortfolio(assets: Asset[]): { totalUsd: number; assets: ValuedAsset[] } {
  const valued = assets.map((asset) => ({
    ...asset,
    valueUsd: asset.quantity * asset.priceUsd,
    allocationPct: 0,
  }))
  const totalUsd = valued.reduce((sum, asset) => sum + asset.valueUsd, 0)
  return {
    totalUsd,
    assets: valued.map((asset) => ({
      ...asset,
      allocationPct: totalUsd > 0 ? (asset.valueUsd / totalUsd) * 100 : 0,
    })),
  }
}

function findAsset(assets: ValuedAsset[], symbol: string) {
  return assets.find((asset) => asset.symbol === symbol.toUpperCase())
}

export function evaluateRules(assets: Asset[], policy: Policy): RuleResult[] {
  const { totalUsd, assets: valued } = valuePortfolio(assets)
  return policy.rules.map((rule) => {
    if (rule.kind === 'min_stablecoin') {
      const asset = findAsset(valued, rule.asset)
      const currentPct = asset?.allocationPct ?? 0
      return {
        rule,
        passed: currentPct >= rule.minPct,
        currentPct,
        targetPct: rule.minPct,
        detail: asset
          ? `${rule.asset} is ${currentPct.toFixed(1)}% of the portfolio`
          : `${rule.asset} is not present in this portfolio`,
      }
    }

    if (rule.kind === 'protected_asset') {
      const asset = findAsset(valued, rule.asset)
      return {
        rule,
        passed: true,
        currentPct: asset?.allocationPct ?? 0,
        targetPct: 0,
        detail: `${rule.asset} is protected from selling`,
      }
    }

    const matching = rule.asset === 'altcoins'
      ? valued.filter((asset) => asset.kind === 'altcoin')
      : [findAsset(valued, rule.asset)].filter((asset): asset is ValuedAsset => Boolean(asset))
    const largest = matching.reduce<ValuedAsset | undefined>(
      (current, asset) => (!current || asset.allocationPct > current.allocationPct ? asset : current),
      undefined,
    )
    const currentPct = largest?.allocationPct ?? 0
    return {
      rule,
      passed: matching.every((asset) => asset.allocationPct <= rule.maxPct),
      currentPct,
      targetPct: rule.maxPct,
      detail: largest
        ? `${largest.symbol} is the largest match at ${currentPct.toFixed(1)}%`
        : 'No matching assets in this portfolio',
    }
  })
}

export function buildPlan(assets: Asset[], policy: Policy): Plan {
  const { totalUsd, assets: valued } = valuePortfolio(assets)
  const protectedSymbols = new Set(
    policy.rules.filter((rule) => rule.kind === 'protected_asset').map((rule) => rule.asset),
  )
  const minStablecoin = policy.rules.find((rule) => rule.kind === 'min_stablecoin')
  const maxAltcoin = policy.rules.find(
    (rule) => rule.kind === 'max_asset_exposure' && rule.asset === 'altcoins',
  )
  const actions: PlanAction[] = []
  const warnings: string[] = []

  if (!totalUsd || !minStablecoin) {
    return { actions, warnings: ['A portfolio value and stablecoin target are required.'], estimatedResults: [], safe: false }
  }

  const stable = findAsset(valued, minStablecoin.asset)
  const targetStableValue = (minStablecoin.minPct / 100) * totalUsd
  let neededStable = Math.max(0, targetStableValue - (stable?.valueUsd ?? 0))
  const sellers = valued
    .filter((asset) => asset.symbol !== minStablecoin.asset && !protectedSymbols.has(asset.symbol))
    .sort((a, b) => b.valueUsd - a.valueUsd)

  if (neededStable > 0) {
    for (const seller of sellers) {
      if (neededStable <= 0) break
      const amountUsd = Math.min(neededStable, seller.valueUsd)
      if (amountUsd >= 10) {
        actions.push({
          source: seller.symbol,
          target: minStablecoin.asset,
          amountUsd,
          sourceQuantity: amountUsd / seller.priceUsd,
          rationale: `Raise ${minStablecoin.asset} to at least ${minStablecoin.minPct}% while preserving protected assets.`,
        })
        neededStable -= amountUsd
      }
    }
  }

  if (maxAltcoin) {
    const maxValue = (maxAltcoin.maxPct / 100) * totalUsd
    for (const asset of valued.filter((item) => item.kind === 'altcoin' && item.valueUsd > maxValue)) {
      if (protectedSymbols.has(asset.symbol)) continue
      const amountUsd = asset.valueUsd - maxValue
      const alreadySelling = actions.find((action) => action.source === asset.symbol)
      if (!alreadySelling && amountUsd >= 10) {
        actions.push({
          source: asset.symbol,
          target: minStablecoin.asset,
          amountUsd,
          sourceQuantity: amountUsd / asset.priceUsd,
          rationale: `Trim ${asset.symbol} to the ${maxAltcoin.maxPct}% altcoin exposure limit.`,
        })
      }
    }
  }

  if (neededStable > 1) warnings.push('Available unprotected balances cannot fully fund the stablecoin target.')
  if (actions.some((action) => action.amountUsd < 10)) warnings.push('An exchange minimum notional may block a small conversion.')
  const estimatedStable = (stable?.valueUsd ?? 0) + actions.filter((action) => action.target === minStablecoin.asset).reduce((sum, action) => sum + action.amountUsd, 0)
  const estimatedStablePct = totalUsd ? (estimatedStable / totalUsd) * 100 : 0

  return {
    actions,
    warnings,
    estimatedResults: [
      `${minStablecoin.asset} estimated allocation: ${estimatedStablePct.toFixed(1)}%`,
      maxAltcoin ? `Protected assets preserved: ${[...protectedSymbols].join(', ') || 'none'}` : 'Protected assets are never sold',
      'Simulation uses fixture prices and zero additional slippage.',
    ],
    safe: warnings.length === 0,
  }
}

export function applyPlan(assets: Asset[], plan: Plan): Asset[] {
  return assets.map((asset) => {
    const outgoing = plan.actions.filter((action) => action.source === asset.symbol).reduce((sum, action) => sum + action.sourceQuantity, 0)
    const incoming = plan.actions.filter((action) => action.target === asset.symbol).reduce((sum, action) => sum + action.amountUsd / asset.priceUsd, 0)
    return { ...asset, quantity: Math.max(0, asset.quantity - outgoing + incoming) }
  })
}

export function parseDemoPolicy(text: string): { policy: Policy | null; error?: string } {
  const normalized = text.toUpperCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim()
  const stableMatch = normalized.match(/(?:AT LEAST|MINIMUM OF|MINIMUM)\s+(\d+(?:\.\d+)?)%\s+IN\s+([A-Z0-9]+)/)
  const protectedMatch = normalized.match(/NEVER SELL\s+([A-Z0-9]+)/)
  const maxMatch = normalized.match(/(?:ANY\s+)?ALTCOIN(?:S)?\s+(?:EXCEED|ABOVE|OVER)\s+(\d+(?:\.\d+)?)%/)
  const anyAssetMatch = normalized.match(/NO\s+ASSET(?:S)?\s+(?:EXCEED|ABOVE|OVER)\s+(\d+(?:\.\d+)?)%/)
  const rules: Rule[] = []
  if (stableMatch) rules.push({ kind: 'min_stablecoin', minPct: Number(stableMatch[1]), asset: stableMatch[2] })
  if (protectedMatch) rules.push({ kind: 'protected_asset', asset: protectedMatch[1] })
  if (maxMatch) rules.push({ kind: 'max_asset_exposure', asset: 'altcoins', maxPct: Number(maxMatch[1]) })
  if (anyAssetMatch) rules.push({ kind: 'max_asset_exposure', asset: 'altcoins', maxPct: Number(anyAssetMatch[1]) })
  if (rules.length === 0) return { policy: null, error: 'Try the demo sentence or one of the examples below.' }
  if (rules.some((rule) => 'minPct' in rule && (rule.minPct < 0 || rule.minPct > 100) || 'maxPct' in rule && (rule.maxPct < 0 || rule.maxPct > 100))) {
    return { policy: null, error: 'Percentages must be between 0% and 100%.' }
  }
  return { policy: { rules, sourceText: text } }
}
