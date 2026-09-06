# AGENTS.md

## Mission

Build Rokai, an AI portfolio policy agent for the Binance Agent OS hackathon.

Tagline: **AI that follows your rules, not the market hype.**

Rokai turns natural-language portfolio rules into a reviewable policy, checks a portfolio deterministically, proposes trades, and executes only after explicit user approval.

## Working rules

- Work phase-by-phase in the order defined in `ROKAI_SPEC.md`.
- Stop after each phase and report what changed, what was verified, and any decision needed for review.
- Preserve the MVP scope. Do not add chat, a complex dashboard, Futures, Margin, DeFi, x402, smart contracts, or 24/7 monitoring.
- Prefer the smallest understandable implementation and minimal dependencies.
- Keep Gemini limited to natural-language rule parsing. Never use an LLM for balances, percentages, trade sizing, safety checks, or execution decisions.
- Keep integrations behind small adapters so mock data and Binance Agent OS/MCP data use the same UI and rule engine.
- Keep secrets server-side; never commit credentials, API keys, or real account data.
- Default to Mock Mode. Live Mode must be visibly labeled and gated.
- Never perform real trading, conversion, transfer, permission changes, or other account-changing actions unless the user explicitly asks for that action in the current task and the UI has an explicit approval step.
- Do not silently broaden a requested change. Ask before changing architecture, scope, or live-trading behavior.

## Required implementation sequence

1. Build the one-page dark command-center UI with mock balances and real/public prices where available.
2. Add deterministic parsing fixtures and the three MVP rule types.
3. Add rule results and a deterministic action-plan preview.
4. Add Binance Agent OS/MCP adapters for real balances, market data, permissions, Spot/Convert, and the Agentic sub-account.
5. Add guarded live execution and post-execution verification only after the mock flow is stable and explicitly reviewed.
6. Polish the demo path, error states, accessibility, and submission materials.

## Definition of done for every phase

- The smallest happy path works.
- Relevant failure states are handled visibly.
- Mock Mode remains usable without credentials.
- No unrelated files or features were changed.
- The project passes its available typecheck, lint, build, and focused tests.
- The phase is paused for review before the next phase begins.

## UX guardrails

Rokai should feel like a calm anime-inspired command center, not a trading terminal. Keep the primary action obvious, copy concise, and every proposed action explainable. Show the source of portfolio data and the current mode at all times.
