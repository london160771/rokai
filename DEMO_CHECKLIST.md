# Rokai Demo Checklist

## Exact 30-second demo

Use a supported Agent OS host such as Codex. The website is only the public explainer.

1. **0–5s — Frame the product:** Show the Rokai landing page and tagline: “AI that follows your rules, not the market hype.”
2. **5–10s — Explain the distinction:** Rokai runs as a skill inside a supported Agent OS host; the website does not directly connect to Binance.
3. **10–16s — State the policy:** In the host, enter: “Keep at least 40% in USDC, never sell BTC, and don’t let any altcoin exceed 20%.”
4. **16–22s — Evaluate:** Show Agentic Spot balances, required prices, the three parsed rules, and deterministic satisfied/attention results.
5. **22–27s — Explain:** Show Rokai’s smallest proposed action and the expected before → after allocation, with BTC untouched.
6. **27–30s — Safety boundary:** Show the explicit approval request and state that the current demo is read-only; do not execute a real trade.

## Pre-demo setup

- `SKILL.md` is loaded in the supported host.
- Binance MCP is connected through the host's official integration.
- The account scope is read-only and points to the Agentic Spot account.
- The host can read `spot.getAccount` and required `spot.tickerPrice` data.
- No real order, conversion, transfer, or withdrawal is requested.
- No tokens, API keys, account identifiers, or sensitive balances are shown in the public website.
- The public landing page is available and clearly says it is an explainer.
- If Binance access is unavailable, use the deterministic mock fixtures in the repository and label them as mock; never present them as live.

## Supported MVP policy rules

1. Minimum stablecoin allocation: “Keep at least 40% in USDC.”
2. Protected assets: “Never sell BTC.”
3. Maximum asset exposure: “No altcoin above 20%.”
4. Minimum fixed stablecoin amount: “Always keep at least 1,000 USDC.”
5. Minimum asset allocation: “Keep at least 20% in BTC.”

## Agent-first safety checks

- Gemini interprets policy language only.
- Rokai calculates portfolio values, allocations, violations, and plans deterministically.
- Missing balances, stale prices, unpriced assets, unsupported rules, or ambiguous input stop the flow safely.
- Protected assets are never selected for sale.
- The exact proposed action must be displayed before approval.
- The current demo stops after approval with “Execution is not enabled in the current demo.”
- Never claim rules were restored without a fresh post-action reread and recalculation.

## Binance limitation

Binance currently rejects arbitrary custom OAuth clients with error `3346001`. Direct custom OAuth is not part of the Rokai website flow. Use the supported-host architecture and do not impersonate another client or bypass Binance restrictions.

## Success criteria

- A judge understands Rokai's purpose and architecture within five seconds.
- The difference between the landing page and the Agent OS skill is clear.
- Natural language becomes visible, reviewable rules.
- Calculations and the plan are deterministic and explainable.
- Approval is explicit and no real trade is performed.
- The five rule types remain within scope.
