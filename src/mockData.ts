export type Asset = {
  symbol: string
  name: string
  quantity: number
  priceUsd: number
  change24h: number
  kind: 'stablecoin' | 'core' | 'altcoin'
}

export const DEMO_POLICY_TEXT =
  "Keep at least 40% in USDC, never sell BTC, and don’t let any altcoin exceed 20%."

export const mockAssets: Asset[] = [
  { symbol: 'USDC', name: 'USD Coin', quantity: 820, priceUsd: 1, change24h: 0.01, kind: 'stablecoin' },
  { symbol: 'BTC', name: 'Bitcoin', quantity: 0.0068, priceUsd: 67_500, change24h: 1.82, kind: 'core' },
  { symbol: 'ETH', name: 'Ethereum', quantity: 0.24, priceUsd: 3_480, change24h: -0.54, kind: 'altcoin' },
  { symbol: 'SOL', name: 'Solana', quantity: 5.8, priceUsd: 151, change24h: 3.21, kind: 'altcoin' },
  { symbol: 'BNB', name: 'BNB', quantity: 0.26, priceUsd: 598, change24h: -1.12, kind: 'altcoin' },
]

export const fixtureTimestamp = 'Sep 05, 2026 · 09:42 UTC'

export function cloneMockAssets() {
  return mockAssets.map((asset) => ({ ...asset }))
}
