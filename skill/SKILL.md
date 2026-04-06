# x402 Autopilot

Autonomous agent wallet for paid APIs on Stellar. Discovers, pays for, and fetches data from x402 and MPP endpoints with on-chain spending limits.

## Tools

### autopilot_pay_and_fetch
Pay for and fetch data from an x402 or MPP endpoint. Protocol is detected automatically. Spending is enforced by on-chain Soroban policy contract.

**Input:** `url` (string) - URL of the paid endpoint
**Output:** `{ data, cost_stroops, protocol, tx_hash, budget }`

### autopilot_research
Research a topic using paid APIs. Auto-discovers services by capability, selects best by trust score, fetches from multiple sources.

**Input:** `query` (string), `urls` (string[], optional)
**Output:** Array of results from multiple sources

### autopilot_check_budget
Check current spending status from on-chain Soroban contract.

**Output:** `{ spent_today, remaining, daily_limit, tx_count, denied_count }`

### autopilot_discover
Discover available paid APIs via x402 Bazaar + Soroban Trust Registry. Returns sorted by trust score.

**Input:** `capability` (string, optional), `min_score` (number, optional)
**Output:** Array of ServiceInfo

### autopilot_set_policy
Update spending policy on-chain. Owner authorization required.

**Input:** `daily_limit_stroops` (string), `per_tx_limit_stroops` (string), `rate_limit` (number)

### autopilot_registry_status
Overview of the service registry with total/healthy/stale/dead counts and alerts.

**Output:** `{ total, healthy, stale, dead, alerts }`

## Configuration

Requires environment variables: `STELLAR_PRIVATE_KEY`, `WALLET_POLICY_CONTRACT_ID`, `TRUST_REGISTRY_CONTRACT_ID`, `OZ_API_KEY`. See `.env.example` for full list.

## Tags
x402, MPP, Stellar, Soroban, Claude, Agents, AI, OpenClaw, Crypto
