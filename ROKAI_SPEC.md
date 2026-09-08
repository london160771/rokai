# Rokai Specification

## Product goal

Rokai is an AI portfolio policy agent for Binance Agent OS.

**Tagline:** AI that follows your rules, not the market hype.

Users state what must remain true in plain English. Rokai parses the request, checks current holdings, proposes one safest next trade at a time, asks for approval, and verifies the result.

## Current agent-first architecture

Rokai's product implementation is the root `SKILL.md`, designed to run inside a supported Binance Agent OS host such as Codex. The website is a public landing page and visual explainer only. It does not directly authenticate to Binance, expose Live Mode controls, or present a simulated execution flow.

The supported runtime path is:

```text
User -> Rokai Skill -> Supported Agent OS Host -> Binance Agent OS / MCP -> Agentic Account
```

Binance currently rejects arbitrary custom OAuth clients with error `3346001`. Direct custom OAuth is not a supported Rokai product path; the website must not imply otherwise. The current website demo remains read-only, while the supported-host execution wiring is implemented behind an explicit default-off gate. Any funded test remains separately authorized.

## MVP scope

Included:

- Minimum stablecoin allocation.
- Minimum fixed stablecoin amount.
- Minimum asset allocation.
- Protected assets: never sell.
- Maximum asset exposure.
- Binance Agent OS/MCP for real balances and live market data through the supported-host skill path, with an Agentic sub-account.
- A public landing page that explains the skill architecture; it does not authenticate or control Binance directly.
- Guarded sequential Spot execution wiring is implemented behind `ROKAI_LIVE_EXECUTION=false`; enabling it remains a separately approved safety decision.

Excluded: chat UI, complex dashboards, Futures, Margin, DeFi, x402, smart contracts, and 24/7 monitoring.

## User flow

The website is a public visual explainer. The actual product flow runs inside a supported Agent OS host according to `SKILL.md`:

1. User loads the Rokai skill in a supported host such as Codex.
2. User states a policy in plain English.
3. Rokai interprets the text into the five supported rules and displays them for review.
4. Rokai reads Agentic Spot data and calculates compliance deterministically.
5. Rokai shows satisfied/violated rules and the smallest explainable plan.
6. User explicitly approves the displayed plan.
7. The supported-host execution path accepts one exact `APPROVE <planId>` per trade, atomically claims one write for that plan, and allows a maximum of three actual `spot.newOrder` attempts per run.
8. After every verified trade, Rokai rereads the account and prices, invalidates the old plan, and creates a fresh next-trade plan and approval when rules remain.
9. With `ROKAI_LIVE_EXECUTION=false` (the default), no state-changing tool is reachable; the current demo remains read-only.

## UX

The website is a calm, premium, light landing page that explains the agent-first product without pretending to be the execution interface. It shows the tagline, five supported rules, the READ → INTERPRET → EVALUATE → PLAN → APPROVE → EXECUTE → VERIFY workflow, the supported-host architecture, and a concise policy-check example.

The actual workflow and safety gates live in `SKILL.md`. The current demo has no direct Binance login, Live Mode controls, or real execution.

## Architecture

```text
Public website (landing page / explainer)
Supported Agent OS Host
  -> Rokai Skill (`SKILL.md`)
  -> Rule Parser (Gemini adapter, parsing only)
  -> Portfolio Adapter (mock fixtures | Binance Agent OS/MCP)
  -> Deterministic Rule Engine
  -> Deterministic Planner
  -> Guarded Spot execution wiring (disabled by default)
  -> Verification (fresh portfolio + Rule Engine)
```

Recommended stack: Vite/React, TypeScript, and the existing Binance Agent OS/MCP adapters. Use a small schema validator only if already available or clearly useful. Keep provider-specific calls out of UI components. The central agent behavior is specified in `SKILL.md`.

### Phase 3 live-data boundary

Phase 3 is read-only. The server-side Binance Agent OS/MCP adapter may call only `spot.getAccount` for the Agentic Spot account and `spot.tickerPrice` for the required `ASSETUSDT` pairs. It normalizes those responses into the existing `Asset` shape before the deterministic rule engine runs. No Futures, Margin, order, convert, transfer, or account-mutating tool is available through this adapter.

### Phase 4 supported-host execution boundary

Phase 4 wiring connects the deterministic execution layer to the single trusted `createRokaiExecutionSession(...)` server/host entry point. Its allowlist contains exactly five tools: `spot.exchangeInfo`, `spot.getAccount`, `spot.tickerPrice`, `spot.newOrder`, and `spot.getOrder`. The sequential state machine is `READING → PLANNING → AWAITING_APPROVAL → SUBMITTING → VERIFYING → COMPLETE | MANUAL_REVIEW`; it owns one active plan at a time. The trusted adapter receives only policy, settlement, run, and exact approval inputs. It reads fresh account, prices, and exchange info, invokes `planNextTrade` internally, creates the plan and exact order internally, and accepts no caller-supplied balances, prices, exchange filters, planner decisions, timestamps, thresholds, executor, or arbitrary order authority. It performs fresh exchange/account/price preflight and submits at most one exact `MARKET` order per exact approval through an atomic store-owned write claim. Approval count is not write count; a run permits at most three actual `spot.newOrder` attempts. `spot.newOrder` is gated only by the server environment variable `ROKAI_LIVE_EXECUTION`, which defaults to `false`, so the repository's structural tests cannot perform a write. Unknown tools and all transfers, withdrawals, Futures, Margin, staking, and other writes are rejected.

After a future `FILLED` response, Rokai rereads the account and required prices, correlates the exact order identity and FULL-response quantities/fills, reconciles source/target/BNB commissions, calculates actual average fill price from executed and cumulative quote quantities, checks source/target and protected-asset deltas, recalculates the complete original policy, and only then marks the step successful. Zero-balance policy targets may be absent from `omitZeroBalances` data and are evaluated as zero; source balances remain strict. If rules remain and the score improves before the three-write limit, the old plan is invalidated and a new plan ID requires fresh approval. Ordinary bounded price movement does not itself create a duplicate; only a prior actual semantic write or loop/no-progress rule does. Uncertain, partial, mismatched, stale, excessive-slippage, unpriced, or non-improving outcomes stop in `MANUAL_REVIEW`; there is no automatic write retry. If an account payload exposes an Agentic identity marker, it must be valid; if no such marker is provided, Rokai reports that limitation and relies on explicit Spot/account/trading checks rather than guessing.

### Planned tiny funded demo

The planned demo starts with a Binance Agentic Spot account containing `10 USDT` and `0 BNB`, then applies:

> Keep at least 55% in BNB, keep at least 40% in USDT, never sell BNB, no altcoin above 60%, and always keep at least 4 USDT.

The expected first decision is one direct `BNBUSDT` `MARKET BUY`. Rokai shows the exact plan ID, waits for `APPROVE <planId>`, makes no write while the gate is false, and—only in a separately authorized enabled run—submits that one order before verifying and recalculating all five rules. The exact quantity and result depend on live Binance filters, fees, price, and slippage; the demo does not promise a fixed BNB amount. After a verified fill, any remaining issue requires a fresh read, fresh plan, and fresh approval.

## Rule schema

```ts
type Policy = {
  rules: Rule[];
  sourceText: string;
};

type Rule =
  | { kind: "min_stablecoin"; asset: string; minPct: number }
  | { kind: "min_stablecoin_amount"; asset: string; minAmount: number }
  | { kind: "min_asset_allocation"; asset: string; minPct: number }
  | { kind: "protected_asset"; asset: string }
  | { kind: "max_asset_exposure"; asset: string | "altcoins"; maxPct: number };
```

Parsing must normalize symbols, percentages, and synonyms, return confidence/errors, and leave ambiguous text unexecutable. Display the parsed policy before planning.

## Deterministic calculations

- Use one valuation timestamp and one price snapshot per check.
- `portfolioValue = sum(asset quantity × reference price)`.
- `allocationPct = asset value / portfolioValue × 100`.
- Stablecoin rule passes when the named stablecoin allocation is at least `minPct`.
- Fixed stablecoin amount rule passes when the named stablecoin value is at least `minAmount`.
- Minimum asset allocation rule passes when the named asset allocation is at least `minPct`.
- Protected-asset rule passes when no plan sells that asset.
- Maximum-exposure rule passes when the relevant asset or altcoin allocation is at most `maxPct`.
- Planning must return exactly one safest next trade when possible; one trade may improve the violation score without satisfying all rules, and the next step is always a fresh replan. It must respect protected assets, free (not locked) source balances, zero-value target assets, exchange filters, minimum notional/quantity, fees, and the fixed MVP slippage tolerance.
- If a compliant plan cannot be calculated safely, show “Unable to plan safely” and do not execute.

The planner should prefer the fewest supported Spot actions needed to restore the rules. All amounts and assumptions must be visible before approval.

## Skill and data modes

**Supported-host skill mode** is the product path. The host owns the supported Binance Agent OS/MCP connection and authorization. `SKILL.md` requests Agentic Spot balances and required market prices, then passes them through the existing deterministic engine; the supported-host execution adapter is separately gated and disabled by default.

**Mock fixtures** remain available to test the deterministic parser, rule engine, and planner without account access. They must be labeled as mock and never presented as live Binance data.

The former direct website Live Mode/OAuth flow is not a supported Rokai product path. Binance currently rejects arbitrary custom OAuth clients with error `3346001`, so the landing page does not expose Connect Binance, Live Mode, or simulated execution controls. The server-side read and execution adapters remain isolated from the website and are used only through the supported-host path; the execution adapter is disabled by default.

## Edge cases and safety

Handle visibly: empty or zero-value portfolios, missing/stale prices, unknown symbols, unsupported rule language, duplicate rules, percentages outside 0–100, insufficient balance, exchange filters, fees/slippage, protected assets blocking a plan, partial fills, rejected orders, timeouts, expired approval, revoked permissions, and failed post-execution refresh.

Fail closed: parsing uncertainty, stale data, missing permissions, or any mismatch between the approved plan and the execution request means no live action. Make retries idempotent and show the user what did and did not complete.

## Acceptance criteria

- A judge can understand the product and current mode within five seconds.
- The natural-language example and the supported fixtures produce the five structured MVP rules.
- The Rokai skill checks rules, identifies violations, and creates an explainable plan using supported-host data or clearly labeled fixtures.
- Calculations and trade sizing are deterministic and testable without Gemini or Binance.
- Live integration is isolated behind one trusted adapter, permission-aware, approval-gated, and never the default. The adapter constructs the order from a fresh internally planned snapshot and cannot be given an arbitrary executor or order by its caller.
- The public page clearly explains the workflow and works without a chat interface; operational loading, empty, error, and success states belong to the supported-host skill runtime.

## Phased implementation plan

1. **Foundation:** app shell, premium visual system, deterministic mock portfolio, and fixture prices.
2. **Policy:** Gemini parsing adapter, schema, parsing fixtures, rule review UI.
3. **Phase 2.5 — Rule coverage:** add minimum fixed stablecoin amount and minimum asset allocation parsing, validation, deterministic evaluation, planning, and display. Phase 3 starts only after this phase is reviewed and approved.
4. **Evaluation:** deterministic rule engine, violations, tests, portfolio snapshot.
5. **Planning:** deterministic compliant plan, estimates, warnings, approval UI.
6. **Binance:** Agent OS/MCP read adapters, permissions, live data, Agentic sub-account configuration.
7. **Phase 3.5 — Direct MCP connectivity:** connect the server-side adapter directly to Binance's official MCP endpoint with OAuth/PKCE; keep the integration read-only and server-side.
8. **Agent-first restructure:** make `SKILL.md` the central product workflow and reduce the website to a transparent public landing page. No direct custom OAuth or real execution is presented.
9. **Phase 4 — Supported-host execution wiring:** connect the deterministic execution layer to the allowlisted Spot tools, state store, approval binding, gate, verification, and sequential replanning. Live execution remains disabled by default pending final safety review.
10. **Demo hardening:** polish, error handling, build/deploy verification, and the supported-host demo checklist.

## Vercel deployment

The Vite frontend builds to `dist`. The deployed website is a public landing page at `/`. The existing Vercel Functions under `api/` remain server-side implementation adapters but are not exposed as the product workflow because Binance rejects arbitrary custom OAuth clients. `vercel.json` may retain SPA deep-link rewrites for compatibility without making those routes part of the public product.

Vercel Functions are stateless between invocations. The Binance OAuth state and tokens are stored in an encrypted, httpOnly, Secure cookie sealed with the server-only `ROKAI_SESSION_SECRET`; no plaintext token or OAuth state is available to frontend JavaScript. This is intentionally a single-project, no-database hackathon approach. Sessions are invalidated when the secret changes, and a future multi-instance production deployment should use a managed encrypted session store if cookie size or centralized revocation becomes a requirement.
