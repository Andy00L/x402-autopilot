# x402 Autopilot

Autonomous agent wallet for paid APIs on Stellar. Discovers, pays for, and fetches data from x402 and MPP endpoints with on-chain spending limits enforced by a Soroban policy contract.

## Tools

### autopilot_pay_and_fetch

Pay for and fetch data from an x402 or MPP endpoint. Protocol is auto-detected via HEAD probe. Supports `GET` (default) and `POST` / `PUT` / `PATCH` / `DELETE` with a JSON body.

**Input:** `{ url: string, method?: string, body?: object }`
**Output:** unwrapped data in `content`, plus `{ cost_stroops, protocol, tx_hash, url, budget }` in `structuredContent`.

### autopilot_research

Discover services by capability (the `query` argument is used as the capability name) or fetch from explicit URLs. Stops on `PolicyDeniedError`, continues past per-URL fetch errors.

**Input:** `{ query?: string, urls?: string[] }`
**Output:** array of fetched payloads, plus `{ results, errors, total_cost_stroops, budget }`.

### autopilot_check_budget

Sync from the wallet-policy Soroban contract and return the current budget.

**Input:** none
**Output:** `{ spent_today, remaining, daily_limit, lifetime: { total_spent, tx_count, denied_count } }`

### autopilot_discover

Run the 3-tier discovery pipeline (Bazaar + on-chain trust registry + xlm402.com catalog) and return services sorted by trust score descending.

**Input:** `{ capability: string, limit?: number }` (capability is required, limit defaults to 10)
**Output:** array of `{ service_id, name, url, capability, price_stroops, protocol, score }`.

### autopilot_set_policy

Update the on-chain spending policy. Owner authorization required (the engine signs with `STELLAR_PRIVATE_KEY`). Omitted fields fall back to current values.

**Input:** `{ daily_limit_stroops?: string, per_tx_limit_stroops?: string, rate_limit?: number }`
**Output:** `{ tx_hash, policy: { daily_limit_stroops, per_tx_limit_stroops, rate_limit } }`

### autopilot_registry_status

Read the on-chain capability set via `list_capabilities` (the v3 trust-registry's `CapName(u32)` index), then aggregate `list_services` for each capability and return the union. Falls back to a hardcoded 6-entry list if the registry RPC is down. New capabilities registered against the contract appear automatically.

**Input:** none
**Output:** `{ total, alive, services }`

## Configuration

Required environment variables: `STELLAR_PRIVATE_KEY`, `STELLAR_PUBLIC_KEY`, `WALLET_POLICY_CONTRACT_ID`, `TRUST_REGISTRY_CONTRACT_ID`, `USDC_SAC_CONTRACT_ID`, `OZ_API_KEY`. See `.env.example` in the repo root for the full list with defaults.

## Tags

x402, MPP, Stellar, Soroban, Claude, Agents, AI, OpenClaw, Crypto
