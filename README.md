# Rokai

**AI that follows your rules, not the market hype.**

Rokai is a portfolio policy skill for Binance Agent OS. A user states what must remain true in plain English. Rokai reads the authorized Agentic Spot portfolio, checks the policy with deterministic math, proposes one safest next trade at a time, asks for explicit approval, and verifies the result.

## Why Rokai is different

Trading agents chase signals. Research agents explain markets. Rokai is a policy layer: it turns user intent into visible constraints and keeps every proposed action tied to those constraints.

Gemini interprets language only. Rokai code owns balances, allocations, violation detection, trade sizing, and verification.

## A 30-second example

Planned demo starting portfolio:

```text
10 USDT
0 BNB
```

Policy: “Keep at least 55% in BNB, keep at least 40% in USDT, never sell BNB, no altcoin above 60%, and always keep at least 4 USDT.”

Rokai reads the live Agentic Spot account, detects the BNB allocation violation, and proposes one `BNBUSDT` `MARKET BUY`. It shows the exact `planId`, waits for:

```text
APPROVE <planId>
```

When live execution is explicitly enabled on the supported host, Rokai executes only that approved trade, verifies the order, rereads balances, and recalculates all five rules. The actual quantity and result depend on live Binance filters, fees, price, and slippage; no fixed BNB amount is promised.

## Agent OS architecture

```text
User
  → Rokai Skill
  → Supported Agent OS Host (such as Codex)
  → Binance Agent OS / MCP
  → Agentic Account
```

Rokai is designed to run as an Agent OS skill inside a supported host. The website in this repository is a public landing page and visual explainer; it is not the execution interface and does not directly authenticate to Binance.

## How to use Rokai

### 1. Install or clone

```bash
git clone https://github.com/london160771/rokai.git
cd rokai
npm install
```

### 2. Register the Codex skill

Register the repository's `SKILL.md` in your Codex skills directory. For example, a Windows installation may use:

```text
C:\Users\<user>\.codex\skills\rokai
```

The reusable skill is then available by name:

```text
$rokai
```

### 3. Connect the supported host

Connect Binance Agent OS / MCP inside Codex or another supported host using Binance's official instructions: <https://developers.binance.com/en/docs/agent-native/mcp-server/agentic>.

### 4. Invoke Rokai and state a policy

Use either the skill invocation or a natural-language request:

```text
Use Rokai. Keep at least 40% in USDC, never sell BTC, and don’t let any altcoin exceed 20%.
```

### 5. Review the result

Rokai reads the Agentic Spot account, interprets only the five supported policy rules, evaluates them with deterministic calculations, and proposes exactly one safest next trade. A next trade may improve the rules without satisfying every rule in one action. Every trade requires a fresh exact approval. The supported-host wiring then permits one exact Spot action per approval through one atomic store-owned write claim, up to three actual `spot.newOrder` attempts per run, with a fresh reread and replan after every verified improving trade. The trusted adapter owns the fresh balances, prices, exchange filters, planner decision, timestamps, thresholds, executor, and order payload; callers cannot replace them. The public website and this validation remain read-only, and no real funded-account test has been performed.

## Requirements

- Codex or another supported Binance Agent OS host
- Binance Agent OS / MCP connection
- Rokai skill
- Binance Agentic account

## What happens next

```text
Analyze all rules → Propose 1 trade → Approve → Execute → Verify → Replan if needed
```

Every step remains visible. The public website is informational only and never changes Binance state. Inside a supported host, execution requires the exact `APPROVE <planId>` for one displayed Spot action and fresh post-action verification. With `ROKAI_LIVE_EXECUTION=false` (the default), the adapter fails closed before `spot.newOrder`.

## Supported rules

1. Minimum stablecoin allocation — “Keep at least 40% in USDC.”
2. Protected assets — “Never sell BTC.”
3. Maximum asset exposure — “No altcoin above 20%.”
4. Minimum fixed stablecoin amount — “Always keep at least 1,000 USDC.”
5. Minimum asset allocation — “Keep at least 20% in BTC.”

## Safety model

- Binance Agent OS/MCP supplies Agentic Spot balances and required market prices.
- Rokai reads only the data it needs and fails closed on missing or unpriced assets.
- Calculations and planning are deterministic; Gemini never sizes trades.
- Protected assets cannot be selected as sellers.
- Approval is required before any state-changing action.
- There is no automatic write retry; uncertain, stale, partial, duplicate, or non-improving outcomes stop safely.
- The public demo is read-only. The skill's execution phase permits only one explicitly approved Spot order at a time, up to three per run, then rereads and verifies the account before replanning; it never converts, transfers, or withdraws funds.
- The supported-host adapter allowlist is limited to `spot.exchangeInfo`, `spot.getAccount`, `spot.tickerPrice`, `spot.newOrder`, and `spot.getOrder`; live writes remain disabled by default. If Binance exposes an Agentic identity marker, it must validate; if it does not, Rokai reports that limitation and applies the strongest available Spot/account/trading checks.
- An asset omitted by `omitZeroBalances` is treated as a zero-value target only when the policy names it as a destination or minimum-allocation target; the source must be present with sufficient free balance. FULL-response commissions are reconciled in the source, target, or third fee asset, and protected fee assets cannot decrease. Actual average fill price is calculated from executed quantity and cumulative quote quantity and must remain within the fixed MVP deviation limit.
- The account adapter requires explicit Spot/trading permission fields. Binance does not currently expose a deterministic Agentic marker in every payload, so Rokai reports that limitation rather than claiming stronger account identity than the payload proves.
- Spot is the MVP boundary; Futures, Margin, DeFi, x402, smart contracts, and monitoring are out of scope.

## How to run Rokai in Codex

1. Open this repository in a supported Agent OS host such as Codex.
2. Connect Binance MCP through the host using Binance’s official instructions: <https://developers.binance.com/en/docs/agent-native/mcp-server/agentic>.
3. Load the root [`SKILL.md`](./SKILL.md).
4. Start with a read-only request such as: “Run a Rokai policy check for: Keep at least 40% in USDC, never sell BTC, and no altcoin above 20%.”
5. Review the rule results and plan. For structural validation, stop at the approval gate; no real trade is part of the current demo.

For the actual filter-aware demo, a single order must meet Binance's live minimum notional and quantity filters. With the test exchange filters used here (`MIN_NOTIONAL` $10), a $10 portfolio cannot safely fund the two-step reserve-plus-BTC example after buffers and fees; plan for approximately $50 or more, subject to the live symbol filters and prices. Never weaken exchange filters to fit a demo amount.

## Web landing page

The public explainer can be run locally with:

```bash
npm install
npm run dev
```

It intentionally contains no Connect Binance button, Live Mode control, direct OAuth flow, or simulated execution sequence.

## Current limitations

Binance currently rejects arbitrary custom OAuth clients with error `3346001`. Direct custom OAuth is therefore not presented as a working Rokai product path. Rokai uses the supported-host architecture instead of impersonating or bypassing a supported client.

The current website is explanatory only. The skill, deterministic execution-safety layer, and supported-host adapter now contain the sequential guarded execution workflow, but live execution remains disabled by default (`ROKAI_LIVE_EXECUTION=false`) and a funded-account test has not been performed. Any later live test requires explicit approval, one atomic write claim for the exact plan, a supported host connection, strict `spot.newOrder` gating, and post-action verification.

## Demo status

Phase 1, Phase 2, Phase 2.5, the parsing reliability pass, Phase 3 live-read adapters, and Phase 3.5 direct MCP connectivity are implemented in the repository. Phase 4 supported-host execution wiring is implemented behind a review gate: one exact approval binds one deterministic Spot order, one atomic claim permits one actual write attempt, the run supports at most three actual writes with fresh sequential replanning, and live execution remains disabled by default. No funded-account test has been performed. This agent-first restructure makes `SKILL.md` the product’s central workflow and keeps the website as a transparent public explainer.

## Development checks

```bash
npm test
npm run build
npm run typecheck
```
