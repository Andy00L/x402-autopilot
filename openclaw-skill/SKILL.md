---
name: x402-autopilot
description: Autonomous agent payments on Stellar. Discover, pay for, and consume API services using x402 or MPP micropayments with on-chain spending policy and trust registry.
homepage: https://github.com/Andy00L/x402-autopilot
metadata:
  openclaw:
    emoji: "💸"
    os: ["darwin", "linux", "win32"]
requires:
  env:
    - STELLAR_PRIVATE_KEY
    - STELLAR_PUBLIC_KEY
    - WALLET_POLICY_CONTRACT_ID
    - OZ_API_KEY
  bins:
    - npx
  primaryEnv: STELLAR_PRIVATE_KEY
---

# x402 Autopilot

Give your OpenClaw agent a real crypto wallet. It can autonomously discover, pay for, and consume API services using USDC micropayments on Stellar testnet.

## When to use this skill

- The user asks for crypto prices, market data, or financial news
- The user wants to pay for an API or piece of data
- The user wants to check the agent's spending budget or transaction history
- The user wants to discover available paid services
- The user wants a market intelligence report or LLM-driven analysis built on paid data sources

## Available tools

This skill provides 6 MCP tools, defined in `mcp-server/src/index.ts`.

### autopilot_pay_and_fetch

Pay for and fetch data from an x402 or MPP endpoint. Supports `GET` (default) and `POST` / `PUT` / `PATCH` / `DELETE` with a JSON `body`. Protocol is auto-detected via HEAD probe.

**Input:** `{ url: string, method?: string, body?: object }`
**Returns:** the unwrapped data in `content`, plus payment metadata in `structuredContent`: `{ cost_stroops, protocol, tx_hash, url, budget }`.

### autopilot_research

Discover services by capability, then call `autopilot_pay_and_fetch` against each URL until budget is exhausted. Stops on `PolicyDeniedError`. Continues past per-URL fetch errors.

**Input:** `{ query?: string, urls?: string[] }`
Provide either a `query` (used as the capability name) or an explicit `urls` array.
**Returns:** array of fetched payloads in `content`, plus `{ results, errors, total_cost_stroops, budget }` in `structuredContent`.

### autopilot_check_budget

Sync from Soroban and return today's spend, remaining budget, daily limit, and lifetime stats.

**Input:** none
**Returns:** `{ spent_today, remaining, daily_limit, lifetime: { total_spent, tx_count, denied_count } }`

### autopilot_discover

Run the 3-tier discovery pipeline (Bazaar + on-chain trust registry + xlm402.com catalog) and return services sorted by trust score.

**Input:** `{ capability: string, limit?: number }`
**Returns:** array of `{ service_id, name, url, capability, price_stroops, protocol, score }`, plus metadata `{ services, total, capability, source }`.

### autopilot_set_policy

Update the on-chain spending policy. Owner authorization is required (the engine signs with the configured `STELLAR_PRIVATE_KEY`). Omitted fields fall back to current values from the contract.

**Input:** `{ daily_limit_stroops?: string, per_tx_limit_stroops?: string, rate_limit?: number }`
**Returns:** `{ tx_hash, policy: { daily_limit_stroops, per_tx_limit_stroops, rate_limit } }`

### autopilot_registry_status

Read the on-chain capability set via `list_capabilities` (the v3 trust-registry's `CapName(u32)` index), then aggregate `list_services` for each capability and return the union. Falls back to a hardcoded 6-entry list (`crypto_prices`, `news`, `briefing`, `blockchain`, `market_intelligence`, `analysis`) if the registry RPC returns an empty list or fails. New capabilities registered against the contract appear automatically without code changes.

**Input:** none
**Returns:** `{ total, alive, services }`

## Architecture

The skill connects to a network of autonomous agents on Stellar testnet (when `npm run dev` is running locally) plus any external services on the trust-registry or xlm402.com.

| Service file | Endpoint | Port | Protocol | Price | Capability |
|--------------|----------|------|----------|-------|------------|
| `weather-api.ts` (Crypto Price Oracle) | `GET /prices` | 4001 | x402 | $0.001 | `crypto_prices` |
| `news-api.ts` (News) | `GET /news` | 4002 | x402 | $0.001 | `news` |
| `news-api.ts` (News Intelligence) | `POST /briefing` | 4002 | x402 | $0.003 | `briefing` |
| `stellar-data-api.ts` (Stellar Data) | `GET /stellar-stats` | 4003 | MPP | $0.002 | `blockchain` |
| `stellar-data-api.ts` (Market Intelligence) | `POST /market-report` | 4003 | x402 | $0.005 | `market_intelligence` |
| `analyst-api.ts` (Analyst) | `POST /analyze` | 4004 | x402 | $0.005 | `analysis` |

Three of the agents (News Intelligence, Market Intelligence, Analyst) buy data from other agents on the same network before answering. The Analyst pays $0.001 each to Crypto Prices and News, runs an LLM call (`claude -p` headless or Anthropic API), and returns the analysis for $0.005. Profit and loss are reported in every response under `economics`.

## On-chain contracts

- **wallet-policy** (Soroban): enforces daily limit, per-tx cap, rate limit (per minute), recipient allowlist, and time window. All amounts in i128 stroops (1 USDC = 10,000,000 stroops). 8 public functions in `contracts/wallet-policy/src/lib.rs`.
- **trust-registry v3** (Soroban): TTL-based service directory with $0.01 USDC anti-spam deposit, quality score tracking, crash-recovery deposit reclaim, and a paginated `CapName(u32)` capability index for on-chain discovery. 10 public functions in `contracts/trust-registry/src/lib.rs`, including `list_capabilities(start, limit)` and `get_capability_count()`.

Both contracts are deployable to Stellar testnet via the scripts in `scripts/`.

## Setup

1. Clone the repo: `git clone https://github.com/Andy00L/stelos`
2. Follow the setup steps in [the main README](../README.md#quick-start-developer-setup)
3. Start the agent network: `npm run dev` (predev hook auto-provisions service wallets)
4. Configure the MCP server in your OpenClaw instance (see `mcp.json` next to this file)

## Example prompts

- "What's the current price of XLM?"
- "Give me a market intelligence report on Stellar"
- "Check my spending budget"
- "Discover services with capability blockchain"
- "Research everything about Bitcoin: prices, news, and analysis"
