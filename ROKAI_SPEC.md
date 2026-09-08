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

Binance currently rejects arbitrary custom OAuth clients with error `3346001`. Direct custom OAuth is not a supported Rokai product path; the website must not imply otherwise. The website remains read-only, while the supported-host execution wiring runs only inside the authenticated host and remains behind an explicit default-off gate. One real funded execution is documented below; no later live execution is claimed after the sizing correction.

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
7. The supported-host execution path accepts one `approve`, `approve plan`, or exact `APPROVE <planId>` approval per trade, resolves bare approval only to the one valid active plan, returns one deterministic final order payload to the authenticated host transport, and allows a maximum of three actual `spot.newOrder` attempts per run. The funded demo is limited to one write.
8. After every verified trade, Rokai rereads the account and prices, invalidates the old plan, and creates a fresh next-trade plan and approval when rules remain.
9. With `ROKAI_LIVE_EXECUTION=false` (the default), no state-changing tool is reachable; the current demo remains read-only.

## UX

The website is a calm, premium, light landing page that explains the agent-first product without pretending to be the execution interface. It shows the tagline, five supported rules, the READ → INTERPRET → EVALUATE → PLAN → APPROVE → EXECUTE → VERIFY workflow, the supported-host architecture, and a concise policy-check example.

The actual workflow and safety gates live in `SKILL.md`. The website has no direct Binance login, Live Mode controls, or execution interface. The skill has one verified real-execution proof point, documented below, while the public page itself remains read-only.

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

Phase 4 is implemented through the trusted `createRokaiHostMediatedSession()` entry point in `server/rokaiHostMediated.ts`. It is parameterless: the Codex host owns the authenticated Binance Agent OS/MCP session and passes only the exact raw results of `spot.getAccount`, `spot.tickerPrice`, and `spot.exchangeInfo`. Rokai validates those reads, invokes `planNextTrade` internally, creates the plan and exact order internally, and returns a frozen, exact `spot.newOrder` payload only after `approve`, `approve plan`, or `APPROVE <planId>` resolves to the single active plan and fresh preflight passes. The host is only the sanctioned transport: it may send that returned payload verbatim once, read `spot.getOrder`, and pass the order/account/price rereads back to `verifyFilled`. The boundary accepts no caller-supplied balances, prices, exchange filters, planner decisions, timestamps, thresholds, executor, credentials, or arbitrary order authority. The older `createRokaiExecutionSession(...)` route remains a separate standalone HTTP/OAuth compatibility path and is not used for the Codex hackathon demo.

The allowlist used by the existing standalone adapter contains exactly five Binance tools: `spot.exchangeInfo`, `spot.getAccount`, `spot.tickerPrice`, `spot.newOrder`, and `spot.getOrder`. The sequential state machine is `READING → PLANNING → AWAITING_APPROVAL → SUBMITTING → VERIFYING → COMPLETE | MANUAL_REVIEW`; it owns one active plan at a time. One exact approval authorizes one exact `MARKET` payload. `ROKAI_LIVE_EXECUTION=false` is the default and remains a server-side gate; the host-mediated contract does not call or inject an executor. The funded demo permits one host write, while the general run store permits at most three actual write attempts. Unknown tools and all transfers, withdrawals, Futures, Margin, staking, and other writes are rejected.

The live Binance Spot compatibility path accepts an account's recognized trading-group capability (for example `TRD_GRP_068`) when the selected symbol's `permissionSets` independently corroborate Spot eligibility; a literal `SPOT` string is not required in the account permission list. An empty symbol `permissions` array is therefore accepted only when the permission-set/account intersection proves eligibility, and unsupported account or symbol permission evidence still fails closed. If Binance reports unusable zero-valued `MARKET_LOT_SIZE` fields, the adapter uses the applicable non-zero `LOT_SIZE` constraints; usable market-lot constraints still take precedence. The current payload does not expose a deterministic Agentic identity marker, so Rokai reports that limitation while retaining the sanctioned Agent OS/MCP endpoint and explicit Spot/account/trading checks.

### Ready Mode

The canonical runtime also supports `npm run rokai -- --ready`. This starts one persistent, local stdin/stdout JSON-lines process, reports the effective `ROKAI_LIVE_EXECUTION` value, loads the deterministic modules once, and remains available for multiple policy runs. It does not read balances or create a plan at startup. The host confirms MCP availability by successfully supplying the required authenticated `spot.getAccount`, `spot.tickerPrice`, and `spot.exchangeInfo` results to a `start` request; the runtime cannot inspect the host's MCP connection directly.

Ready Mode caches only per-symbol exchange metadata (`status`, permissions, permission sets, and filters) for 45 seconds. Account balances, free amounts, ticker prices, approval state, and order status are always supplied or reread for the current operation. The same process owns the in-memory `PolicyRunStore` from plan creation through approval, host submission, and verification. Timing fields report runtime startup, metadata-cache status, planning, approval/preflight, and verification; external MCP network latency remains host-side.

After a future `FILLED` response, Rokai rereads the account and required prices, correlates the exact order identity and FULL-response quantities/fills, reconciles source/target/BNB commissions, calculates actual average fill price from executed and cumulative quote quantities, checks source/target and protected-asset deltas, recalculates the complete original policy, and only then marks the step successful. Zero-balance policy targets may be absent from `omitZeroBalances` data and are evaluated as zero; source balances remain strict. If rules remain and the score improves before the three-write limit, the old plan is invalidated and a new plan ID requires fresh approval. Ordinary bounded price movement does not itself create a duplicate; only a prior actual semantic write or loop/no-progress rule does. Uncertain, partial, mismatched, stale, excessive-slippage, unpriced, or non-improving outcomes stop in `MANUAL_REVIEW`; there is no automatic write retry. If an account payload exposes an Agentic identity marker, it must be valid; if no such marker is provided, Rokai reports that limitation and relies on explicit Spot/account/trading checks rather than guessing.

### Planned tiny funded demo

The planned demo starts with a Binance Agentic Spot account containing `10 USDT` and `0 BNB`, then applies:

> Keep at least 55% in BNB, keep at least 40% in USDT, never sell BNB, no altcoin above 60%, and always keep at least 4 USDT.

The expected first decision is one direct `BNBUSDT` `MARKET BUY`. Rokai shows the exact plan ID, waits for `approve` (or `approve plan` / explicit `APPROVE <planId>`), makes no write while the gate is false, and—only in a separately authorized enabled run—submits that one order before verifying and recalculating all five rules. The exact quantity and result depend on live Binance filters, fees, price, and slippage; the demo does not promise a fixed BNB amount. After a verified fill, any remaining issue requires a fresh read, fresh plan, and fresh approval.

### Verified first funded execution

The first real Agentic Spot execution used approximately `12 USDT` and `0 BNB` and was completed through the supported host:

- `BNBUSDT` · `BUY` · `MARKET` · `FILLED`
- Binance order ID: `12562278904`
- Client order ID: `r-aea1b8c08785478987c825e9ee5a0112`
- Executed quantity: `0.00800000 BNB`
- Cumulative quote: `6.02376000 USDT`
- Average fill price: `752.97000000`
- Commission: `0.00000600 BNB`
- Final balances: `5.97624000 USDT`, `0.00799400 BNB`
- Final BNB allocation: `50.17%`

The result was `4/5` rules satisfied: BNB ≥ 55% was not satisfied; USDT ≥ 40%, never sell BNB, no altcoin above 60%, and USDT ≥ 4 all passed. Rokai entered `MANUAL_REVIEW`. Exactly one Binance write occurred, with no retry and no second trade. This confirms that Rokai verifies the resulting portfolio rather than treating a filled order as automatic policy success.

The fill exposed a Binance lot-size quantization edge case. The follow-up sizing correction now models the final executable base quantity after `LOT_SIZE` / `MARKET_LOT_SIZE` constraints, recalculates quote spend, received quantity, fee/slippage effects, and post-trade allocations from that quantized amount, and permits rounding up only when reserve, filter, and configured sizing bounds allow it. No later live execution is claimed after this correction.

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

**Supported-host skill mode** is the product path. The host owns the supported Binance Agent OS/MCP connection and authorization. `SKILL.md` requests Agentic Spot balances, required prices, and symbol exchange information, then passes the exact reads through `createRokaiHostMediatedSession()` and the existing deterministic engine. The host-mediated execution contract is separately gated and disabled by default. No Binance credentials are stored by Rokai.

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
9. **Phase 4 — Supported-host execution wiring:** connect the deterministic execution layer to the allowlisted Spot tools, state store, approval binding, gate, verification, and sequential replanning. Live execution remains disabled by default; one verified funded execution is documented as proof of the guarded path.
10. **Demo hardening:** polish, error handling, build/deploy verification, and the supported-host demo checklist.

## Vercel deployment

The Vite frontend builds to `dist`. The deployed website is a public landing page at `/`. The existing Vercel Functions under `api/` remain server-side implementation adapters but are not exposed as the product workflow because Binance rejects arbitrary custom OAuth clients. `vercel.json` may retain SPA deep-link rewrites for compatibility without making those routes part of the public product.

Vercel Functions are stateless between invocations. The Binance OAuth state and tokens are stored in an encrypted, httpOnly, Secure cookie sealed with the server-only `ROKAI_SESSION_SECRET`; no plaintext token or OAuth state is available to frontend JavaScript. This is intentionally a single-project, no-database hackathon approach. Sessions are invalidated when the secret changes, and a future multi-instance production deployment should use a managed encrypted session store if cookie size or centralized revocation becomes a requirement.
