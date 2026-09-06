# Rokai Demo Checklist

## Exact 30-second demo

Use Mock Mode unless live execution has been explicitly approved and rehearsed.

1. **0–5s — Frame the product:** Show “Rokai” and “Powered by Binance Agent OS”; point out Mock Mode.
2. **5–10s — State the policy:** Enter: “Keep at least 40% in USDC, never sell BTC, and don’t let any altcoin exceed 20%.”
3. **10–15s — Check:** Click “Check My Portfolio”; show the compact portfolio snapshot and the three parsed rules.
4. **15–21s — Explain:** Show violated USDC/exposure rules, satisfied BTC protection, and Rokai’s Plan with amounts and rationale.
5. **21–25s — Approve:** Click “Approve Plan” and make clear that approval is required before execution.
6. **25–30s — Verify:** Show execution progress, updated balances, and the final compliant/satisfied state.

## Pre-demo setup

- App builds and starts from a clean run.
- Mock Mode is selected and visibly labeled.
- Fixture portfolio has an obvious violation: USDC below 40% and one altcoin above 20%; BTC is protected.
- Fixture prices and timestamp are stable or the price fallback is ready.
- Gemini parsing fixture/cached response is available for the exact demo sentence.
- Mock execution updates balances and verification returns the expected result.
- Browser is sized to show the full one-page flow without scrolling surprises.
- No real API keys, real account identifiers, or sensitive balances are visible.

## Fallback behavior

If Gemini, price data, Binance Agent OS/MCP, or the network is unavailable:

- Stay in Mock Mode.
- Use the deterministic parser fixture and clearly label the data as mock/fallback.
- Continue through rule results, plan, approval, simulated execution, and verification.
- Never present simulated execution as a real Binance trade.

If a live demo is attempted, stop on stale data, missing permissions, an unexpected plan, or any execution error; return to Mock Mode.

## Success criteria

- The audience understands the tagline and the Binance Agent OS connection.
- Natural language becomes visible, reviewable structured rules.
- Rule calculations are understandable and deterministic.
- The proposed plan is explainable and respects “never sell BTC”.
- Approval is explicit; execution is not automatic.
- The final state verifies the policy rather than merely claiming success.
- The complete flow fits in 30 seconds and works without a chat UI.

## Final submission readiness

- [ ] `AGENTS.md`, `ROKAI_SPEC.md`, and this checklist are included.
- [ ] Mock-first flow is stable without credentials.
- [ ] Rule engine tests cover all three MVP rules and key edge cases.
- [ ] Gemini is used only for parsing and has a safe fallback.
- [ ] Binance Agent OS/MCP integration is isolated behind adapters.
- [ ] Live mode is opt-in, permission-aware, approval-gated, and disabled by default.
- [ ] No Futures, Margin, DeFi, x402, smart contracts, monitoring, or complex dashboard slipped into the MVP.
- [ ] Loading, empty, stale-data, rejected-action, partial-fill, and verification-failure states are present.
- [ ] Typecheck, lint, tests, and production build pass.
- [ ] Demo script has been rehearsed once from a clean start.
- [ ] Deployment URL and backup local demo are ready.
