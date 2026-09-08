# Rokai Demo Checklist

## Exact 30-second demo

Use a supported Agent OS host such as Codex. The website is only the public explainer.

1. **0–5s — Frame the product:** Show the Rokai landing page and tagline: “AI that follows your rules, not the market hype.”
2. **5–10s — Explain the distinction:** Rokai runs as a skill inside a supported Agent OS host; the website does not directly connect to Binance.
3. **10–16s — State the policy:** In the host, enter: “Keep at least 40% in USDC, never sell BTC, and don’t let any altcoin exceed 20%.”
4. **16–22s — Evaluate:** Show Agentic Spot balances, required prices, the three parsed rules, and deterministic satisfied/attention results.
5. **22–27s — Explain:** Show Rokai’s one safest next trade and the expected before → after allocation, with BTC untouched.
6. **27–30s — Safety boundary:** Show the explicit approval request and state that the current demo is read-only; do not execute a real trade.

## Pre-demo setup

- `SKILL.md` is loaded in the supported host.
- Binance MCP is connected through the host's official integration.
- The account scope is read-only and points to the Agentic Spot account.
- The host can read `spot.getAccount`, required `spot.tickerPrice`, and selected-symbol `spot.exchangeInfo` data.
- The host-mediated contract is `createRokaiHostMediatedSession()`. Pass its exact fresh read results to Rokai; do not use the standalone browser/OAuth route for the hackathon demo.
- If the account payload exposes an Agentic identity/context marker, it is valid; if no deterministic marker is exposed, note that limitation and use the strongest available Spot/account/trading checks.
- If the account exposes a recognized trading group such as `TRD_GRP_068`, confirm the selected symbol's `permissionSets` corroborate Spot eligibility. An empty symbol `permissions` array is not sufficient by itself. If `MARKET_LOT_SIZE` fields are zero/unusable, confirm valid `LOT_SIZE` constraints are used.
- No real order, conversion, transfer, or withdrawal is requested. Keep `ROKAI_LIVE_EXECUTION=false` for the demo.
- No tokens, API keys, account identifiers, or sensitive balances are shown in the public website.
- The public landing page is available and clearly says it is an explainer.
- If Binance access is unavailable, use the deterministic mock fixtures in the repository and label them as mock; never present them as live.
- For repeated host runs, start `npm run rokai -- --ready` once from the canonical checkout. Keep that process alive between plan creation, approval, and verification; do not restart it while an approval is pending.
- Confirm the Ready Mode response reports `runtimeLoaded: true` and the effective `ROKAI_LIVE_EXECUTION` value. It reports the required host read tools as `awaiting-host-read`; a successful policy start proves the authenticated host reads were supplied. No account balances are prewarmed or cached.

## Verified first funded execution

The first separately authorized real Agentic Spot test used approximately `12 USDT` and `0 BNB` and completed exactly one write:

- `BNBUSDT` `BUY` `MARKET` — Binance status `FILLED`
- Order ID `12562278904`; client order ID `r-aea1b8c08785478987c825e9ee5a0112`
- Executed `0.00800000 BNB`; cumulative quote `6.02376000 USDT`
- Average fill `752.97000000`; commission `0.00000600 BNB`
- Final balances: `5.97624000 USDT` and `0.00799400 BNB`
- Final BNB allocation: `50.17%`
- Policy outcome: `4/5` rules satisfied; BNB ≥ 55% remained unsatisfied and Rokai entered `MANUAL_REVIEW`
- Exactly one Binance write, zero retries, and zero automatic follow-up trades

This is not a five-of-five success claim. The order filled, Rokai reread the account, detected the lot-size quantization shortfall, and stopped safely rather than claiming the policy was restored.

## Follow-up funded test (not run after the sizing fix)

The checklist below is retained for any separately authorized future test. No additional live execution is claimed after the quantized-sizing update.

### Pre-demo

- Fund the Binance Agentic Spot account with `10 USDT` and no BNB.
- Verify the live `BNBUSDT` `NOTIONAL` / minimum quantity and other exchange filters before attempting the demo.
- Set `ROKAI_LIVE_EXECUTION=false` initially.
- Confirm Rokai reads the expected `10 USDT` Spot balance through the supported host.
- Run the policy read-only first:
  “Keep at least 55% in BNB, keep at least 40% in USDT, never sell BNB, no altcoin above 60%, and always keep at least 4 USDT.”
- Confirm the deterministic evaluation identifies the BNB allocation violation and creates one `BNBUSDT` `MARKET BUY` plan.

### Live test — one trade only

- Enable `ROKAI_LIVE_EXECUTION=true` only after the read-only check and final safety approval.
- Start a fresh policy run and show the exact plan ID, symbol, side, order mode, and expected effect.
- Prefer the simple approval `approve` (or `approve plan`) when exactly one valid active plan is displayed; `APPROVE <planId>` remains available for explicit/manual approval.
- Execute exactly one approved `BNBUSDT` Spot trade.
- Verify the exact order identity and `FILLED` status; do not retry an uncertain submission.
- Reread Spot balances and required prices through the supported host.
- Recalculate all five rules and show the verified result, including any remaining issue.
- Stop after this one real execution, whether the verified policy result is complete or `MANUAL_REVIEW`. Do not approve or perform extra trades unless separately approved later.

The actual order quantity and result depend on live Binance filters, fees, price, and slippage. A fixed BNB amount or guaranteed post-trade percentage must not be promised.

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
- The current read-only demo stops before any host write because `ROKAI_LIVE_EXECUTION=false`; state clearly that no order was sent. The host must never invent or edit the returned order payload.
- Never claim rules were restored without a fresh post-action reread and recalculation.
- After the verified fill above, the sizing logic was updated to apply final `LOT_SIZE` / `MARKET_LOT_SIZE` quantization before approval, model fees and slippage, recalculate the expected post-trade state from the executable quantity, and round up only when reserve, filter, and sizing constraints permit.

## Phase 4 structural execution checks

The deterministic supported-host wiring is implemented, but live writes remain disabled by default. Before any new separately approved funded test, verify:

- The only exposed execution tools are `spot.exchangeInfo`, `spot.getAccount`, `spot.tickerPrice`, `spot.newOrder`, and `spot.getOrder`.
- A run has one active plan and accepts `approve`, `approve plan`, or `APPROVE <planId>` case-insensitively; bare approval resolves internally to that one valid active plan. An atomic store-owned claim authorizes one exact order, and each run allows at most three actual `spot.newOrder` attempts.
- A two-step mock run rereads state, creates a fresh plan ID, and requires a new approval after the first verified trade.
- The default-off server gate cannot be overridden by caller input, and approval/time/payload provenance is validated by the run store.
- The run stops safely for stale data, changed payloads, insufficient free balance, non-trading symbols, partial fills, uncertain order responses, protected-asset decreases, no progress, or three submissions.
- Targets omitted by `omitZeroBalances` are valid zero-value destinations; source assets still need a present, sufficient free balance. FULL-response source/target/BNB commissions and actual average fill price are checked before verification can succeed.
- A $10 portfolio cannot safely satisfy the two-step reserve-plus-BTC fixture when the live symbol minimum notional is $10; use approximately $50 or more for that filter-aware demo, subject to live filters and prices. The verified BNBUSDT example started with approximately $12, and its final BNB allocation correctly remained below target after quantization.
- `createRokaiHostMediatedSession()` accepts only the host's exact fresh account, price, and exchange-info results. It calls the deterministic planner internally, returns one exact order payload only after `approve`, `approve plan`, or `APPROVE <planId>` and fresh preflight, and exposes no executor or raw submission API. Codex may send only that returned payload to `spot.newOrder`, once, then pass `spot.getOrder` and fresh rereads to verification. No host caller can supply a fabricated balance, price, exchange filter, planner decision, timestamp, threshold, executor, credential, or order authority.
- With `ROKAI_LIVE_EXECUTION=false`, `spot.newOrder` is never called.
- Ready Mode may reuse a valid exchange-info cache entry for 45 seconds, but every policy and approval path requires current account and price reads. Review the returned `timings` fields; MCP request latency is measured by the host, not the local runtime.

## Binance limitation

Binance currently rejects arbitrary custom OAuth clients with error `3346001`. Direct custom OAuth is not part of the Rokai website flow. Use the supported-host architecture and do not impersonate another client or bypass Binance restrictions.

## Success criteria

- A judge understands Rokai's purpose and architecture within five seconds.
- The difference between the landing page and the Agent OS skill is clear.
- Natural language becomes visible, reviewable rules.
- Calculations and the plan are deterministic and explainable.
- Approval is explicit; the public landing-page demo performs no real trade, while any host-mediated funded test remains separately authorized and fully verified.
- The five rule types remain within scope.
