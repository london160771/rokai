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

Rokai reads the live Agentic Spot account, detects the BNB allocation violation, and proposes one `BNBUSDT` `MARKET BUY`. It shows the exact `planId`, then waits for the preferred simple approval:

```text
approve
```

`approve plan` and `APPROVE <planId>` remain available for explicit/manual approval.

When live execution is explicitly enabled on the supported host, Rokai returns one exact approved order payload for the host to send, verifies the order, rereads balances, and recalculates all five rules. The actual quantity and result depend on live Binance filters, fees, price, and slippage; no fixed BNB amount is promised.

## Verified first execution

Rokai has completed one real Agentic Spot execution through the supported host. The order was:

- `BNBUSDT` · `BUY` · `MARKET` · `FILLED`
- Binance order ID: `12562278904`
- Client order ID: `r-aea1b8c08785478987c825e9ee5a0112`
- Executed quantity: `0.00800000 BNB`
- Cumulative quote: `6.02376000 USDT`
- Average fill price: `752.97000000`
- Commission: `0.00000600 BNB`

After the reread, the account held `5.97624000 USDT` and `0.00799400 BNB`; BNB was `50.17%` of the portfolio. Four of five rules were satisfied: BNB ≥ 55% was not satisfied, while the USDT reserve, BNB protection, altcoin maximum, and USDT minimum passed. Rokai correctly entered `MANUAL_REVIEW`.

Exactly one Binance write occurred, with no retry and no automatic follow-up trade. This is a proof of honest verification—not a claim of five-of-five success. Rokai does not treat an executed order as success by itself; it verifies the resulting portfolio against the original policy and stops safely when the target is not actually reached.

The real fill exposed a Binance lot-size quantization edge case. Rokai was subsequently updated to reason about the final executable base quantity, apply `LOT_SIZE` / `MARKET_LOT_SIZE` constraints before approval, model fee and slippage effects, recalculate the post-trade state from the quantized quantity, and round up only when reserve, filter, and sizing constraints permit. No later live execution is claimed after that sizing update.

## Agent OS architecture

```text
User
  → Rokai Skill
  → Supported Agent OS Host (such as Codex)
  → Binance Agent OS / MCP
  → Agentic Account
```

The supported flow is `Codex authenticated Binance MCP → Rokai skill → deterministic policy/planning/safety → human approval → Codex sanctioned Binance tool call → Rokai verification`. Rokai is designed to run as an Agent OS skill inside a supported host. The website in this repository is a public landing page and visual explainer; it is not the execution interface and does not directly authenticate to Binance.

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

Rokai reads the Agentic Spot account, interprets only the five supported policy rules, evaluates them with deterministic calculations, and proposes exactly one safest next trade. A next trade may improve the rules without satisfying every rule in one action. Every trade requires a fresh approval. The host-mediated contract then rereads fresh state and returns one exact Spot payload for the authenticated host transport to send verbatim. The funded demo permits one write; the general run state permits up to three actual `spot.newOrder` attempts per run, with a fresh reread and replan after every verified improving trade. The Rokai boundary owns the fresh balances, prices, exchange filters, planner decision, timestamps, thresholds, and order payload; callers cannot replace them, and no executor or credential is accepted. The public website remains read-only; the one verified funded execution and its `MANUAL_REVIEW` result are documented above.

## Requirements

- Codex or another supported Binance Agent OS host
- Binance Agent OS / MCP connection
- Rokai skill
- Binance Agentic account

## What happens next

```text
Analyze all rules → Propose 1 trade → Approve → Execute → Verify → Replan if needed
```

Every step remains visible. The public website is informational only and never changes Binance state. Inside a supported host, `createRokaiHostMediatedSession()` owns the deterministic plan and execution authority: it accepts exact fresh read results, resolves `approve` or `approve plan` to the single active plan (or accepts explicit `APPROVE <planId>`), then returns the exact final payload for one host-mediated `spot.newOrder` call and subsequent verification. With `ROKAI_LIVE_EXECUTION=false` (the default), the host must not make that write.

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
- Binance Agentic Spot payloads may express account capability as a recognized trading group such as `TRD_GRP_068`. Rokai accepts that only when the selected symbol's `permissionSets` corroborate Spot eligibility; an empty symbol `permissions` array alone is never enough. If `MARKET_LOT_SIZE` is present but its quantity fields are zero/unusable, Rokai uses valid `LOT_SIZE` constraints instead.
- Spot is the MVP boundary; Futures, Margin, DeFi, x402, smart contracts, and monitoring are out of scope.

## How to run Rokai in Codex

1. Open this repository in a supported Agent OS host such as Codex.
2. Connect Binance MCP through the host using Binance’s official instructions: <https://developers.binance.com/en/docs/agent-native/mcp-server/agentic>.
3. Load the root [`SKILL.md`](./SKILL.md).
4. Start with a read-only request such as: “Run a Rokai policy check for: Keep at least 40% in USDC, never sell BTC, and no altcoin above 20%.”
5. Review the rule results and plan. For a read-only walkthrough, stop at the approval gate. In the supported-host contract, Codex supplies only the exact results of `spot.getAccount`, `spot.tickerPrice`, and `spot.exchangeInfo`; Rokai creates the plan and final order payload internally. After a separately authorized approval, Codex may send only that returned payload once, then supply `spot.getOrder` and fresh rereads for Rokai verification.

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

The current website is explanatory only. The skill, deterministic execution-safety layer, and host-mediated boundary contain the sequential guarded workflow, while live execution remains disabled by default (`ROKAI_LIVE_EXECUTION=false`). One real funded execution is documented above; no later live execution is claimed after the quantized-sizing update. The former `createRokaiExecutionSession(...)` browser/OAuth route is a separate standalone compatibility path and is not used for the hackathon demo. Any later live test requires the supported host's authenticated MCP session, exact host read results, explicit approval, one returned payload sent once, strict `spot.newOrder` gating, and post-action verification.

## Demo status

Phase 1, Phase 2, Phase 2.5, the parsing reliability pass, Phase 3 live-read adapters, and Phase 3.5 direct MCP connectivity are implemented in the repository. Phase 4 supported-host wiring is implemented behind the default-off gate: `createRokaiHostMediatedSession()` accepts only host-provided fresh reads, one approval binds one deterministic Spot order payload, the funded demo permits one write, the general run supports at most three actual writes with fresh sequential replanning, and live execution remains disabled by default. One real funded execution is verified and documented above; it correctly ended in `MANUAL_REVIEW` after Binance quantity quantization left BNB below target. No later live execution is claimed after the sizing update. This agent-first restructure makes `SKILL.md` the product’s central workflow and keeps the website as a transparent public explainer.

## Development checks

```bash
npm test
npm run build
npm run typecheck
```
