# Rokai Specification

## Product goal

Rokai is an AI portfolio policy agent for Binance Agent OS.

**Tagline:** AI that follows your rules, not the market hype.

Users state what must remain true in plain English. Rokai parses the request, checks current holdings, proposes the smallest compliant action, asks for approval, and verifies the result.

## MVP scope

Included:

- Minimum stablecoin allocation.
- Protected assets: never sell.
- Maximum asset exposure.
- Binance Agent OS/MCP for real balances, live market data, permissions, Spot/Convert execution, and an Agentic sub-account.
- Mock Mode first; guarded Live Mode later.

Excluded: chat UI, complex dashboards, Futures, Margin, DeFi, x402, smart contracts, and 24/7 monitoring.

## User flow

1. User opens the one-page command center.
2. User enters a rule, for example: “Keep at least 40% in USDC, never sell BTC, and don’t let any altcoin exceed 20%.”
3. Rokai parses the text with Gemini free tier only and displays the structured rules for review.
4. Rokai loads mock or Binance portfolio data and calculates compliance deterministically.
5. Rokai shows satisfied/violated rules and Rokai’s Plan: proposed conversions or sells, amounts, reasons, and constraints.
6. User explicitly approves the plan.
7. In Mock Mode, Rokai simulates execution. In Live Mode, it uses permitted Binance Agent OS/MCP Spot/Convert actions.
8. Rokai shows execution progress, refreshes balances, and verifies the post-action rules.

## UX

One page, dark, minimal, anime-inspired, calm and high-contrast.

- **Header:** Rokai; “Powered by Binance Agent OS”; Mock/Live mode indicator; Connect Binance.
- **Hero:** “What must stay true?”; natural-language input; “Check My Portfolio” button; examples such as “Keep 30% in USDC”, “Never sell BTC”, and “No asset above 20%”.
- **Portfolio snapshot:** total value, asset/value/allocation table, data source, last updated time.
- **Rule results:** clear satisfied/violated cards showing current value and target.
- **Rokai’s Plan:** proposed action, amount, source/target asset, rationale, estimated result, and warnings.
- **Approval:** explicit “Approve Plan” action; no execution by merely checking rules.
- **Progress and verification:** pending/running/completed/failed states, final balances, and rule status after execution.

## Architecture

```text
UI (one page)
  -> application state + API routes
  -> Rule Parser (Gemini adapter, parsing only)
  -> Portfolio Adapter (mock | Binance Agent OS/MCP)
  -> Deterministic Rule Engine
  -> Deterministic Planner
  -> Execution Adapter (mock | Binance Spot/Convert via Agent OS/MCP)
  -> Verification (fresh portfolio + Rule Engine)
```

Recommended stack: Next.js/React, TypeScript, Tailwind CSS, and the existing Binance Agent OS/MCP integration. Use a small schema validator only if already available or clearly useful. Keep provider-specific calls out of UI components.

## Rule schema

```ts
type Policy = {
  rules: Rule[];
  sourceText: string;
};

type Rule =
  | { kind: "min_stablecoin"; asset: string; minPct: number }
  | { kind: "protected_asset"; asset: string }
  | { kind: "max_asset_exposure"; asset: string | "altcoins"; maxPct: number };
```

Parsing must normalize symbols, percentages, and synonyms, return confidence/errors, and leave ambiguous text unexecutable. Display the parsed policy before planning.

## Deterministic calculations

- Use one valuation timestamp and one price snapshot per check.
- `portfolioValue = sum(asset quantity × reference price)`.
- `allocationPct = asset value / portfolioValue × 100`.
- Stablecoin rule passes when the named stablecoin allocation is at least `minPct`.
- Protected-asset rule passes when no plan sells that asset.
- Maximum-exposure rule passes when the relevant asset or altcoin allocation is at most `maxPct`.
- Planning must respect protected assets, available balances, exchange filters, minimum notional/quantity, fees, and configurable slippage tolerance.
- If a compliant plan cannot be calculated safely, show “Unable to plan safely” and do not execute.

The planner should prefer the fewest Spot/Convert actions needed to restore the rules. All amounts and assumptions must be visible before approval.

## Mock and Live modes

**Mock Mode** is the default and must work without Binance credentials. Use deterministic fixture balances, realistic symbols, and real/public prices when available; otherwise show the fixture price timestamp. Simulated fills update the local portfolio so verification is meaningful.

**Live Mode** is opt-in. Require Binance connection, visible mode labeling, permission checks, fresh balances/prices, an explicit approval for the exact plan, and a final confirmation immediately before account-changing calls. Use the Agentic sub-account when configured. Never expose secrets to the browser or infer permission to trade.

## Edge cases and safety

Handle visibly: empty or zero-value portfolios, missing/stale prices, unknown symbols, unsupported rule language, duplicate rules, percentages outside 0–100, insufficient balance, exchange filters, fees/slippage, protected assets blocking a plan, partial fills, rejected orders, timeouts, expired approval, revoked permissions, and failed post-execution refresh.

Fail closed: parsing uncertainty, stale data, missing permissions, or any mismatch between the approved plan and the execution request means no live action. Make retries idempotent and show the user what did and did not complete.

## Acceptance criteria

- A judge can understand the product and current mode within five seconds.
- The natural-language example produces the three structured MVP rules.
- Mock Mode checks rules, identifies violations, creates an explainable plan, simulates approval/execution, and verifies compliance.
- Calculations and trade sizing are deterministic and testable without Gemini or Binance.
- Live integration is isolated, permission-aware, approval-gated, and never the default.
- The page has clear loading, empty, error, and success states and works without a chat interface.

## Phased implementation plan

1. **Foundation:** app shell, dark visual system, mode state, mock portfolio, fixture prices.
2. **Policy:** Gemini parsing adapter, schema, parsing fixtures, rule review UI.
3. **Evaluation:** deterministic rule engine, violations, tests, portfolio snapshot.
4. **Planning:** deterministic compliant plan, estimates, warnings, approval UI.
5. **Binance:** Agent OS/MCP read adapters, permissions, live data, Agentic sub-account configuration.
6. **Execution:** mock simulation, then explicitly enabled Spot/Convert live path and verification.
7. **Demo hardening:** polish, error handling, build/deploy verification, and the 30-second demo checklist.
