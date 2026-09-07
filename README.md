# Rokai

**AI that follows your rules, not the market hype.**

Rokai is a portfolio policy skill for Binance Agent OS. A user states what must remain true in plain English. Rokai reads the authorized Agentic Spot portfolio, checks the policy with deterministic math, proposes the smallest corrective action, asks for explicit approval, and verifies the result.

## Why Rokai is different

Trading agents chase signals. Research agents explain markets. Rokai is a policy layer: it turns user intent into visible constraints and keeps every proposed action tied to those constraints.

Gemini interprets language only. Rokai code owns balances, allocations, violation detection, trade sizing, and verification.

## A 30-second example

User: “Keep at least 40% in USDC, never sell BTC, and don’t let any altcoin exceed 20%.”

```text
ROKAI POLICY CHECK

✓ BTC Protection
✕ USDC Reserve — Current 24%, Required ≥ 40%
✕ SOL Exposure — Current 31%, Maximum 20%

PROPOSED ACTION
Sell $800 SOL → USDC

Expected result:
USDC 40.1% ✓
SOL 19.9% ✓
BTC untouched ✓

1 action satisfies all active rules.
Approve this action?
```

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

Rokai reads the Agentic Spot account, interprets only the five supported policy rules, evaluates them with deterministic calculations, proposes the smallest reasonable fix, and asks for explicit approval. Execution can happen only after approval and only when a future execution phase is enabled; the current demo is read-only.

## Requirements

- Codex or another supported Binance Agent OS host
- Binance Agent OS / MCP connection
- Rokai skill
- Binance Agentic account

## What happens next

```text
User Policy → Rokai → Binance Agent OS → Portfolio Check → Proposed Action → User Approval → Execution → Verification
```

Every step remains visible. The current demo stops before execution and never changes Binance state.

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
- The current demo is read-only. It does not place trades, convert, transfer, or withdraw funds.
- Spot is the MVP boundary; Futures, Margin, DeFi, x402, smart contracts, and monitoring are out of scope.

## How to run Rokai in Codex

1. Open this repository in a supported Agent OS host such as Codex.
2. Connect Binance MCP through the host using Binance’s official instructions: <https://developers.binance.com/en/docs/agent-native/mcp-server/agentic>.
3. Load the root [`SKILL.md`](./SKILL.md).
4. Start with a read-only request such as: “Run a Rokai policy check for: Keep at least 40% in USDC, never sell BTC, and no altcoin above 20%.”
5. Review the rule results and plan. Do not request a real trade during the current demo phase.

## Web landing page

The public explainer can be run locally with:

```bash
npm install
npm run dev
```

It intentionally contains no Connect Binance button, Live Mode control, direct OAuth flow, or simulated execution sequence.

## Current limitations

Binance currently rejects arbitrary custom OAuth clients with error `3346001`. Direct custom OAuth is therefore not presented as a working Rokai product path. Rokai uses the supported-host architecture instead of impersonating or bypassing a supported client.

The current website is explanatory only. Real execution has not started, and a funded-account test has not been performed. A future execution phase requires explicit approval, a supported host connection, strict Spot-only tool gating, and post-action verification.

## Demo status

Phase 1, Phase 2, Phase 2.5, the parsing reliability pass, Phase 3 live-read adapters, and Phase 3.5 direct MCP connectivity are implemented in the repository. This agent-first restructure makes `SKILL.md` the product’s central workflow and keeps the website as a transparent public explainer. No Phase 4 work has begun.

## Development checks

```bash
npm test
npm run build
npm run typecheck
```
