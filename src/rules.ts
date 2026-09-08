import type { Asset } from './mockData.js'
import { planNextTrade } from './nextTradePlanner.js'

export type Rule =
  | { kind: 'min_stablecoin'; asset: string; minPct: number }
  | { kind: 'min_stablecoin_amount'; asset: string; minAmount: number }
  | { kind: 'min_asset_allocation'; asset: string; minPct: number }
  | { kind: 'protected_asset'; asset: string }
  | { kind: 'max_asset_exposure'; asset: string | 'altcoins'; maxPct: number }

export type Policy = { rules: Rule[]; sourceText: string }

export type ValuedAsset = Asset & { valueUsd: number; allocationPct: number }

export type RuleResult = {
  rule: Rule
  passed: boolean
  currentPct: number | null
  targetPct: number
  currentAmountUsd?: number
  targetAmountUsd?: number
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

const stablecoinSymbols = new Set(['USDC', 'USDT', 'BUSD', 'FDUSD', 'DAI', 'USDE'])
const planningBufferPct = 0.5
const planningBufferUsd = 1

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

    if (rule.kind === 'min_stablecoin_amount') {
      const asset = findAsset(valued, rule.asset)
      const currentAmountUsd = asset?.valueUsd ?? 0
      return {
        rule,
        passed: currentAmountUsd >= rule.minAmount,
        currentPct: asset?.allocationPct ?? 0,
        targetPct: 0,
        currentAmountUsd,
        targetAmountUsd: rule.minAmount,
        detail: asset
          ? `${rule.asset} balance is $${currentAmountUsd.toFixed(2)}`
          : `${rule.asset} is not present in this portfolio`,
      }
    }

    if (rule.kind === 'min_asset_allocation') {
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

/**
 * Retained for compatibility with the original preview fixtures. New callers
 * should use buildPlan, which now returns the single next-trade projection.
 */
export function buildMultiActionPlan(assets: Asset[], policy: Policy): Plan {
  const { totalUsd, assets: valued } = valuePortfolio(assets)
  const protectedSymbols = new Set(
    policy.rules.filter((rule) => rule.kind === 'protected_asset').map((rule) => rule.asset.toUpperCase()),
  )
  const minStablecoin = policy.rules.find((rule) => rule.kind === 'min_stablecoin')
  const minStablecoinAmount = policy.rules.find((rule) => rule.kind === 'min_stablecoin_amount')
  const minAllocations = policy.rules.filter((rule) => rule.kind === 'min_asset_allocation')
  const maxExposureRules = policy.rules.filter(
    (rule): rule is Extract<Rule, { kind: 'max_asset_exposure' }> => rule.kind === 'max_asset_exposure',
  )
  const actions: PlanAction[] = []
  const warnings: string[] = []

  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return { actions, warnings: ['A portfolio value is required.'], estimatedResults: [], safe: false }
  if (assets.some((asset) => !Number.isFinite(asset.quantity) || asset.quantity < 0 || !Number.isFinite(asset.priceUsd) || asset.priceUsd <= 0)) {
    return { actions, warnings: ['Every asset requires a finite non-negative balance and a valid price.'], estimatedResults: [], safe: false }
  }

  const stableSymbols = [minStablecoin?.asset, minStablecoinAmount?.asset].filter((symbol): symbol is string => Boolean(symbol))
  const stableAsset = stableSymbols[0]
  if (new Set(stableSymbols).size > 1) warnings.push('Stablecoin rules name different assets and need separate planning.')

  let working = assets.map((asset) => ({ ...asset }))
  const addConversion = (sourceSymbol: string, targetSymbol: string, requestedAmount: number, rationale: string) => {
    const current = valuePortfolio(working)
    const source = findAsset(current.assets, sourceSymbol)
    const target = findAsset(current.assets, targetSymbol)
    if (!source || !target) return 0
    const amountUsd = Math.min(requestedAmount, source.valueUsd)
    if (amountUsd < 10) return 0
    const action: PlanAction = {
      source: source.symbol,
      target: target.symbol,
      amountUsd,
      sourceQuantity: amountUsd / source.priceUsd,
      rationale,
    }
    actions.push(action)
    working = applyPlan(working, { actions: [action], warnings: [], estimatedResults: [], safe: true })
    return amountUsd
  }

  for (const rule of minAllocations) {
    const current = valuePortfolio(working)
    const target = findAsset(current.assets, rule.asset)
    if (!target) {
      warnings.push(`${rule.asset} is not present, so its minimum allocation cannot be planned safely.`)
      continue
    }
    const bufferedTarget = ((rule.minPct + planningBufferPct) / 100) * totalUsd
    const needed = Math.max(0, bufferedTarget - target.valueUsd)
    if (!needed) continue
    const sellers = current.assets
      .filter((asset) => asset.symbol !== target.symbol && !protectedSymbols.has(asset.symbol))
      .sort((a, b) => b.valueUsd - a.valueUsd)
    let remaining = needed
    for (const seller of sellers) {
      if (remaining <= 0) break
      remaining -= addConversion(seller.symbol, target.symbol, remaining, `Raise ${target.symbol} to at least ${rule.minPct}% while preserving protected assets.`)
    }
    if (remaining > 1) warnings.push(`Available unprotected balances cannot fully fund the ${rule.asset} allocation target.`)
  }

  if (maxExposureRules.length) {
    if (!stableAsset) {
      warnings.push('A stablecoin target is required to safely trim maximum asset exposure.')
    } else {
      for (const maxExposure of maxExposureRules) {
        const currentAssets = valuePortfolio(working).assets
        const matching = maxExposure.asset === 'altcoins'
          ? currentAssets.filter((item) => item.kind === 'altcoin')
          : [findAsset(currentAssets, maxExposure.asset)].filter((asset): asset is ValuedAsset => Boolean(asset))
        const maxValue = (Math.max(0, maxExposure.maxPct - planningBufferPct) / 100) * totalUsd
        for (const asset of matching.filter((item) => item.valueUsd > maxValue)) {
          if (protectedSymbols.has(asset.symbol)) {
            warnings.push(`${asset.symbol} is protected but exceeds the maximum asset exposure.`)
            continue
          }
          const amountUsd = asset.valueUsd - maxValue
          const moved = addConversion(asset.symbol, stableAsset, amountUsd, `Trim ${asset.symbol} to below the ${maxExposure.maxPct}% exposure limit.`)
          if (moved < amountUsd - 1) warnings.push(`Available ${asset.symbol} balance cannot fully satisfy its exposure limit.`)
        }
      }
    }
  }

  if (minStablecoin || minStablecoinAmount) {
    if (!stableAsset) {
      warnings.push('A stablecoin asset is required for the stablecoin target.')
    } else {
      const stableTarget = Math.max(
        minStablecoin ? ((minStablecoin.minPct + planningBufferPct) / 100) * totalUsd : 0,
        minStablecoinAmount ? minStablecoinAmount.minAmount + planningBufferUsd : 0,
      )
      const current = valuePortfolio(working)
      const stable = findAsset(current.assets, stableAsset)
      let remaining = Math.max(0, stableTarget - (stable?.valueUsd ?? 0))
      const minAllocationSymbols = new Set(minAllocations.map((rule) => rule.asset))
      const sellers = current.assets
        .filter((asset) => asset.symbol !== stableAsset && !protectedSymbols.has(asset.symbol) && !minAllocationSymbols.has(asset.symbol))
        .sort((a, b) => b.valueUsd - a.valueUsd)
      for (const seller of sellers) {
        if (remaining <= 0) break
        remaining -= addConversion(seller.symbol, stableAsset, remaining, `Raise ${stableAsset} to its minimum target while preserving protected allocations.`)
      }
      if (remaining > 1) warnings.push('Available unprotected balances cannot fully fund the stablecoin target.')
    }
  }

  if (actions.some((action) => action.amountUsd < 10)) warnings.push('An exchange minimum notional may block a small conversion.')
  const finalAssets = valuePortfolio(working)
  const finalResults = evaluateRules(working, policy)
  const estimatedStable = stableAsset ? findAsset(finalAssets.assets, stableAsset) : undefined
  const estimatedStablePct = totalUsd && estimatedStable ? (estimatedStable.valueUsd / totalUsd) * 100 : 0
  if (actions.length === 0) warnings.push('No executable action was produced.')
  if (actions.length > 1) warnings.push('This plan requires multiple actions and cannot be approved as one executable order.')
  if (actions.some((action) => protectedSymbols.has(action.source.toUpperCase()))) warnings.push('The plan attempts to sell a protected asset.')
  if (finalResults.some((result) => !result.passed)) warnings.push('The simulated post-state does not satisfy every active rule.')

  return {
    actions,
    warnings,
    estimatedResults: [
      ...(stableAsset ? [`${stableAsset} estimated allocation: ${estimatedStablePct.toFixed(1)}%`] : []),
      ...(minStablecoinAmount && estimatedStable ? [`${stableAsset} estimated balance: $${estimatedStable.valueUsd.toFixed(2)}`] : []),
      ...minAllocations.map((rule) => `${rule.asset} minimum allocation: ${rule.minPct}%`),
      ...(maxExposureRules.length ? [`Protected assets preserved: ${[...protectedSymbols].join(', ') || 'none'}`] : ['Protected assets are never sold']),
      'Simulation includes deterministic safety buffers for policy boundaries.',
    ],
    safe: actions.length === 1 && warnings.length === 0 && finalResults.every((result) => result.passed),
  }
}

/**
 * Compatibility shape for older consumers. The authoritative planner is
 * planNextTrade and this function deliberately exposes at most one action.
 */
export function buildPlan(assets: Asset[], policy: Policy): Plan {
  const decision = planNextTrade(assets, policy)
  if (decision.status === 'COMPLETE') {
    return {
      actions: [],
      warnings: [],
      estimatedResults: ['All active rules are already satisfied.'],
      safe: false,
    }
  }
  if (decision.status === 'STOP') {
    return {
      actions: [],
      warnings: [decision.reason],
      estimatedResults: [],
      safe: false,
    }
  }

  const allExpectedRulesPass = decision.expectedRuleResults.every((result) => result.passed)
  return {
    actions: [decision.nextTrade],
    warnings: allExpectedRulesPass ? [] : ['This is the safest next trade; unresolved rules require a later planning step.'],
    estimatedResults: decision.expectedRuleResults.map((result) => result.detail),
    safe: allExpectedRulesPass,
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
  const allocationMatches = [...normalized.matchAll(/(?:KEEP|MAINTAIN)\s+(?:AT LEAST|MINIMUM(?: OF)?)\s+(\d+(?:\.\d+)?)%\s+IN\s+([A-Z][A-Z0-9]{1,11})/g)]
  const aboveAllocationMatches = [...normalized.matchAll(/KEEP\s+([A-Z][A-Z0-9]{1,11})\s+(?:ABOVE|OVER)\s+(\d+(?:\.\d+)?)%/g)]
  const amountMatches = [...normalized.matchAll(/(?:ALWAYS\s+)?KEEP\s+(?:(?:AT LEAST|A\s+MINIMUM\s+OF|MINIMUM(?: OF)?)\s+)?\$?([\d,]+(?:\.\d+)?)\s+([A-Z][A-Z0-9]{1,11})/g)]
  const protectedMatches = [...normalized.matchAll(/(?:NEVER|DO NOT)\s+SELL\s+([A-Z][A-Z0-9]{1,11})/g)]
  const maxMatches = [...normalized.matchAll(/(?:ANY\s+)?ALTCOIN(?:S)?\s+(?:EXCEED|ABOVE|OVER)\s+(\d+(?:\.\d+)?)%/g)]
  const specificMaxMatches = [...normalized.matchAll(/NO\s+(?!ALTCOINS?\b|ASSETS?\b)([A-Z][A-Z0-9]{1,11})\s+(?:EXCEED|ABOVE|OVER)\s+(\d+(?:\.\d+)?)%/g)]
  const ambiguousMaxMatches = [...normalized.matchAll(/NO\s+ASSETS?\s+(?:EXCEED|ABOVE|OVER)\s+(\d+(?:\.\d+)?)%/g)]
  const rules: Rule[] = []
  allocationMatches.forEach((match) => {
    const minPct = Number(match[1])
    const asset = match[2]
    rules.push(stablecoinSymbols.has(asset)
      ? { kind: 'min_stablecoin', minPct, asset }
      : { kind: 'min_asset_allocation', minPct, asset })
  })
  amountMatches.forEach((match) => rules.push({ kind: 'min_stablecoin_amount', minAmount: Number(match[1].replace(/,/g, '')), asset: match[2] }))
  aboveAllocationMatches.forEach((match) => rules.push({ kind: 'min_asset_allocation', asset: match[1], minPct: Number(match[2]) }))
  protectedMatches.forEach((match) => rules.push({ kind: 'protected_asset', asset: match[1] }))
  maxMatches.forEach((match) => rules.push({ kind: 'max_asset_exposure', asset: 'altcoins', maxPct: Number(match[1]) }))
  specificMaxMatches.forEach((match) => rules.push({ kind: 'max_asset_exposure', asset: match[1], maxPct: Number(match[2]) }))
  if (ambiguousMaxMatches.length) return { policy: null, error: 'Maximum exposure rules must specify altcoins or a named asset.' }
  if (rules.length === 0) return { policy: null, error: 'Try the demo sentence or one of the examples below.' }
  if (rules.some((rule) => rule.kind === 'min_stablecoin_amount' && !stablecoinSymbols.has(rule.asset))) {
    return { policy: null, error: 'Fixed minimum amount rules must name a supported stablecoin.' }
  }
  if (rules.some((rule) => ('minPct' in rule && (rule.minPct < 0 || rule.minPct > 100)) || ('maxPct' in rule && (rule.maxPct < 0 || rule.maxPct > 100)) || ('minAmount' in rule && (rule.minAmount < 0 || rule.minAmount > 1_000_000_000)))) {
    return { policy: null, error: 'Percentages must be between 0% and 100%, and fixed amounts must be non-negative.' }
  }
  return { policy: { rules, sourceText: text } }
}
