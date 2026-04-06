# CLAUDE.md — x402 Autopilot v3

## What this project is

A smart agent wallet for Stellar. Claude Code (or any MCP-enabled agent) can autonomously discover x402/MPP paid APIs, pay for them with USDC on Stellar testnet, and receive data. All spending is enforced by an on-chain Soroban policy contract. A second Soroban contract provides an on-chain service registry with trust scoring, heartbeat monitoring, and anti-spam deposits. The system supports both the x402 protocol (Coinbase) and MPP charge protocol (Stripe) with automatic detection.

## What this project is NOT

This is NOT a marketplace listing page. NOT a yield optimizer. NOT a token swap interface. It is an autonomous payment engine with on-chain guardrails.

---

## Build order (strict)

Each phase depends on the previous one. Do not skip ahead.

```
Phase 1: Scaffolding (package.json, tsconfig, .env.example, .gitignore, Cargo.toml files)
Phase 2: Soroban contracts (wallet-policy, trust-registry) — must compile with `stellar contract build`
Phase 3: Core TypeScript engine (config, types, security, mutex, event-bus, budget-tracker, policy-client, registry-client, protocol-detector, discovery, autopay)
Phase 4: Data sources (3 Express servers: weather x402, news x402, stellar-data MPP)
Phase 5: MCP server (6 tools wrapping the core engine)
Phase 6: Dashboard (React + Vite + WebSocket)
Phase 7: Scripts (setup-testnet, deploy, seed-registry, run-demo)
Phase 8: Documentation (README.md, ARCHITECTURE.md, skill/SKILL.md)
```

---

## Verified dependency versions

### TypeScript (package.json)

```json
{
  "dependencies": {
    "@x402/fetch": "latest",
    "@x402/core": "latest",
    "@x402/stellar": "latest",
    "@x402/express": "latest",
    "@x402/extensions": "latest",
    "@stellar/stellar-sdk": "^14.5.0",
    "@stellar/mpp": "latest",
    "mppx": "latest",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.21.0",
    "ws": "^8.18.0",
    "dotenv": "^16.4.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "concurrently": "^8.2.0"
  }
}
```

### Rust (Cargo.toml for both contracts)

```toml
[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true
```

---

## Verified import paths (use EXACTLY these)

### x402 Client (buyer)

```typescript
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactStellarScheme, createEd25519Signer } from "@x402/stellar";
```

### x402 Server (seller)

```typescript
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
```

### x402 Bazaar (discovery)

```typescript
import { HTTPFacilitatorClient } from "@x402/core/http";
import { withBazaar } from "@x402/extensions";
```

### Stellar SDK

```typescript
import {
  Keypair, Networks, TransactionBuilder, Contract,
  SorobanRpc, Address, nativeToScVal, BASE_FEE, xdr,
  Operation, Asset
} from "@stellar/stellar-sdk";
```

### MCP SDK

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
```

### Soroban contract (Rust)

```rust
#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, token,
    Address, Env, Symbol, Vec, Map, symbol_short,
};
```

---

## Network configuration

```
Testnet RPC:         https://soroban-testnet.stellar.org
Testnet Horizon:     https://horizon-testnet.stellar.org
Testnet Passphrase:  Test SDF Network ; September 2015
Friendbot:           https://friendbot.stellar.org?addr={PUBLIC_KEY}

OZ x402 Facilitator: https://channels.openzeppelin.com/x402/testnet
OZ API key gen:      https://channels.openzeppelin.com/testnet/gen

Coinbase Facilitator: https://x402.org/facilitator  (also supports stellar:testnet)

USDC issuer testnet: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
USDC testnet faucet: https://xlm402.com
```

---

## Code rules (NEVER violate)

### Money

```
RULE 1: ALL monetary amounts are BigInt in TypeScript, i128 in Rust.
        1 USDC = 10_000_000 stroops (7 decimals).
        NEVER use parseFloat, Number, or any floating point for money.
        Conversion to "$0.001" display format happens ONLY in UI rendering functions.

RULE 2: When parsing price from x402/MPP headers, convert to BigInt immediately.
        const priceStroops = BigInt(Math.round(parseFloat(priceString) * 10_000_000));
        This is the ONLY place parseFloat is allowed, and it is immediately converted.
```

### HTTP responses

```
RULE 3: Read response body ONCE.
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); }
        catch { data = text; }
        NEVER do response.json() in try and response.text() in catch.
        "Body already consumed" is a showstopper bug.
```

### Secrets

```
RULE 4: NEVER log, console.log, or include in error messages:
        - process.env.STELLAR_PRIVATE_KEY
        - process.env.OZ_API_KEY
        - Any string starting with "S" that is 56 chars (Stellar secret)
        In error messages, use: "wallet: G...{last4}" not the full key.
```

### Types

```
RULE 5: NEVER use `any` in TypeScript.
        Define proper types for everything.
        Use `unknown` + type narrowing if the type is truly unknown.
```

### Error handling

```
RULE 6: Every external call (HTTP, Soroban RPC, facilitator) must have:
        - A timeout (5s for probes, 10s for payments, 15s for Soroban writes)
        - A try/catch with a DISTINCT error message per failure mode
        - Retry logic where specified (max 3x with exponential backoff: 1s, 2s, 4s)

RULE 7: Different failures produce different errors.
        "Facilitator timeout" !== "RPC unavailable" !== "Policy denied" !== "Rate limited"
        The caller (MCP tool) must be able to distinguish and act differently.
```

### Concurrency

```
RULE 8: Payments are SEQUENTIAL. Use the async mutex in mutex.ts.
        Acquire before check_policy. Release after record_spend.
        This prevents two concurrent payments from both passing policy check
        and spending more than the daily limit.
```

### Fail-closed

```
RULE 9: If Soroban RPC is unreachable during check_policy, the payment is DENIED.
        NEVER fall back to "allow without policy check."
        NEVER log "non-fatal" and continue.
        Return: { allowed: false, reason: "rpc_unavailable" }
```

### URL validation

```
RULE 10: Before any HTTP request to an external URL:
         - Must be https:// (unless ALLOW_HTTP=true for local dev)
         - Must NOT be file://, data://, ftp://, javascript:
         - Must NOT resolve to private IP ranges:
           10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
           127.0.0.0/8, 169.254.0.0/16, 0.0.0.0
         - Must NOT be localhost (unless ALLOW_HTTP=true)
         Throw SecurityError("SSRF_BLOCKED") on violation.
```

---

## File structure

```
x402-autopilot/
├── CLAUDE.md                          # This file
├── README.md                          # Hackathon submission
├── ARCHITECTURE.md                    # Technical deep-dive
├── package.json                       # Root workspace + scripts
├── tsconfig.json
├── .env.example
├── .gitignore
│
├── contracts/
│   ├── wallet-policy/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs                 # 8 functions: initialize, check_policy, record_spend, record_denied, update_policy, set_allowlist, get_today_spending, get_lifetime_stats
│   └── trust-registry/
│       ├── Cargo.toml
│       └── src/lib.rs                 # 8 functions: initialize, register_service, deregister_service, heartbeat, report_quality, list_services, get_service, check_stale
│
├── src/
│   ├── config.ts                      # All env vars with validation (crash early if missing)
│   ├── types.ts                       # PolicyCheckResult, ServiceInfo, SpendRecord, AutopilotResult, etc.
│   ├── security.ts                    # validateUrl(), RateLimiter class, parsePriceStroops()
│   ├── mutex.ts                       # AsyncMutex class with timeout
│   ├── event-bus.ts                   # EventBus + WebSocket broadcast
│   ├── budget-tracker.ts              # BigInt local cache + sync from Soroban
│   ├── policy-client.ts               # checkPolicy(), recordSpend(), recordDenied(), updatePolicy() via Soroban RPC
│   ├── registry-client.ts             # registerService(), reportQuality(), listServices(), heartbeat() via Soroban RPC
│   ├── protocol-detector.ts           # detectProtocol(url): "x402" | "mpp" | "free" via HEAD probe
│   ├── discovery.ts                   # 3-tier: Bazaar + Trust Registry + cache. mergeAndSort(), invalidateService()
│   ├── health-checker.ts              # Periodic HEAD probes (5min interval). Emits events.
│   └── autopay.ts                     # autopilotFetch(url): the main function. Orchestrates all of the above.
│
├── mcp-server/
│   ├── package.json
│   └── src/index.ts                   # 6 tools: autopilot_pay_and_fetch, autopilot_research, autopilot_check_budget, autopilot_discover, autopilot_set_policy, autopilot_registry_status
│
├── data-sources/
│   ├── package.json
│   └── src/
│       ├── shared.ts                  # createFacilitatorClient(), createX402Server() helpers
│       ├── weather-api.ts             # x402, port 4001, $0.001
│       ├── news-api.ts                # x402, port 4002, $0.001
│       └── stellar-data-api.ts        # MPP charge, port 4003, $0.002
│
├── dashboard/
│   ├── package.json
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                    # 5 panels: budget, tx log, registry, health, denied
│       └── hooks/useWebSocket.ts      # Auto-reconnect with backoff
│
├── skill/
│   └── SKILL.md                       # OpenClaw skill definition
│
└── scripts/
    ├── setup-testnet.ts               # Fund accounts, add USDC trustline
    ├── deploy-wallet-policy.sh        # Build + deploy + initialize
    ├── deploy-trust-registry.sh       # Build + deploy + initialize
    ├── seed-registry.ts               # Register 3 demo services with deposits
    ├── run-demo.ts                    # Full demo flow
    └── health-report.ts               # CLI health check
```

---

## Soroban contract 1: wallet-policy

### Purpose
On-chain spending limits. Source of truth for the budget.

### Storage layout
- `instance`: WalletPolicy (daily_limit, per_tx_limit, rate_limit, time_window), owner Address, allowlist Vec<Address>, denied_count u64
- `persistent`: SpendRecord per day_key (u64), nonce Map<Symbol, bool>, lifetime totals

### Functions

```rust
fn initialize(env, owner: Address, daily_limit: i128, per_tx_limit: i128, rate_limit: u32)
fn check_policy(env, amount: i128, recipient: Address) -> PolicyCheckResult
fn record_spend(env, nonce: Symbol, amount: i128, recipient: Address, tx_hash: Symbol)
fn record_denied(env, amount: i128, reason: Symbol)
fn update_policy(env, daily_limit: i128, per_tx_limit: i128, rate_limit: u32, time_start: u64, time_end: u64)
fn set_allowlist(env, addresses: Vec<Address>)
fn get_today_spending(env) -> SpendRecord
fn get_lifetime_stats(env) -> (i128, u64, u64)  // (total_spent, tx_count, denied_count)
```

### Key implementation details

- `check_policy` is a READ function. It does NOT modify state. It returns allowed/denied + reason.
- `record_spend` requires `env.current_contract_address()` or admin auth. It panics on duplicate nonce.
- Day key: `env.ledger().timestamp() / 86400`. Rate minute: `env.ledger().timestamp() / 60`.
- Allowlist empty = all recipients allowed. Non-empty = strict whitelist.
- All amounts in i128 (stroops). No floating point anywhere.
- Events: `env.events().publish((symbol_short!("spend"), symbol_short!("ok")), (amount, recipient, tx_hash))`.

---

## Soroban contract 2: trust-registry

### Purpose
On-chain directory of x402/MPP services. Trust scoring via quality reports. Heartbeat for liveness. Anti-spam deposit.

### Storage layout
- `instance`: admin Address, next_service_id u32
- `persistent`: ServiceInfo per service_id, report tracking Map<(Address, u32, u64), bool>

### Functions

```rust
fn initialize(env, admin: Address)
fn register_service(env, owner: Address, url: Symbol, name: Symbol, capabilities: Vec<Symbol>, price_stroops: i128, protocol: Symbol) -> u32
fn deregister_service(env, owner: Address, service_id: u32)
fn heartbeat(env, owner: Address, service_id: u32)
fn report_quality(env, reporter: Address, service_id: u32, success: bool)
fn list_services(env, capability: Symbol, min_score: u32) -> Vec<ServiceInfo>
fn get_service(env, service_id: u32) -> ServiceInfo
fn check_stale(env, service_id: u32)
```

### Key implementation details

- Deposit: 100_000 stroops ($0.01 USDC). Transferred via `token::Client::new(&env, &usdc_sac).transfer(&owner, &contract, &100_000i128)`.
- Deregister refunds: `token::Client::new(&env, &usdc_sac).transfer(&contract, &owner, &deposit)`.
- Heartbeat: `service.last_heartbeat = env.ledger().sequence()`. Must be called every ~720 ledgers (~1h).
- check_stale: if `current_ledger - last_heartbeat > 720`, set status = "stale". If > 7200, set status = "removed", forfeit deposit to admin.
- report_quality: max 1 report per (reporter, service_id, day_key). Key: `(reporter, service_id, timestamp/86400)`.
- Trust score: `success_reports * 100 / total_reports`. If total_reports == 0, default score = 70.
- Symbol limit: 32 chars max. URLs must be short for hackathon. For production use `String` type instead.

---

## Core engine patterns

### autopay.ts — main function

```
autopilotFetch(url: string): Promise<AutopilotResult>

1. security.validateUrl(url)
2. mutex.acquire(timeout: 30_000)
3. protocol = await protocolDetector.detect(url)   // HEAD, 5s timeout
4. if (protocol === "free") return normalFetch(url)
5. priceStroops = security.parsePriceStroops(headers)  // BigInt
6. budgetTracker.checkLocal(priceStroops)           // fast, in-memory
7. policyResult = await policyClient.checkPolicy(priceStroops, recipient)  // Soroban RPC, 10s timeout
8. if (!policyResult.allowed) {
     await policyClient.recordDenied(priceStroops, policyResult.reason)
     eventBus.emit("denied", { url, amount: priceStroops, reason: policyResult.reason })
     throw new PolicyDeniedError(policyResult.reason)
   }
9. if (protocol === "x402") response = await x402Fetch(url)
   if (protocol === "mpp") response = await mppChargeFetch(url)
10. text = await response.text()            // READ ONCE
11. data = safeJsonParse(text)              // try/catch, no throw on parse fail
12. txHash = extractTxHash(response)
13. nonce = createNonce(txHash)
14. await policyClient.recordSpend(nonce, priceStroops, recipient, txHash)  // retry 3x
15. budgetTracker.recordLocal(priceStroops)
16. eventBus.emit("spend:ok", { url, amount: priceStroops, protocol, txHash })
17. registryClient.reportQuality(serviceId, true).catch(() => {})  // async, fire-and-forget
18. return { data, costStroops: priceStroops, protocol, txHash }

CATCH:
  if payment was settled (txHash exists) but API returned error:
    policyClient.recordSpend(...)   // money is gone, must record
    eventBus.emit("spend:api_error", ...)
  if payment was NOT settled:
    eventBus.emit("spend:failed", ...)
    registryClient.reportQuality(serviceId, false).catch(() => {})
  throw error
FINALLY:
  mutex.release()
```

### x402 client setup

```typescript
// In config.ts — created ONCE at startup
const stellarSigner = createEd25519Signer(
  config.stellarPrivateKey,
  config.stellarNetwork  // "stellar:testnet"
);

const x402 = new x402Client();
x402.register("stellar:*", new ExactStellarScheme(stellarSigner));

export const x402Fetch = wrapFetchWithPayment(fetch, x402);
```

### MPP charge client

```typescript
// MPP charge does not use a facilitator. The server broadcasts.
// Client builds SAC transfer tx, signs, sends XDR to server.
// Implementation follows the draft-stellar-charge-00 spec.
// Use @stellar/mpp SDK's createCharge / sendCharge functions.
// If the SDK is too new and functions differ, fallback to manual:
//   1. Build SAC transfer() invocation
//   2. Simulate with rpc.prepareTransaction()
//   3. Sign with Keypair
//   4. Send signed XDR in Authorization: Payment header
//   5. Server validates, broadcasts, returns receipt
```

### Soroban RPC interaction pattern

```typescript
// EVERY Soroban call follows this pattern:
async function invokeSoroban(functionName: string, args: xdr.ScVal[]): Promise<string> {
  const contract = new Contract(contractId);
  const account = await rpc.getAccount(publicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call(functionName, ...args))
    .setTimeout(30)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);

  const sendResult = await rpc.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    throw new SorobanError(`TX send failed: ${sendResult.errorResult}`);
  }

  // Poll for confirmation
  let getResult;
  const maxPolls = 15;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(1000);
    getResult = await rpc.getTransaction(sendResult.hash);
    if (getResult.status !== "NOT_FOUND") break;
  }

  if (!getResult || getResult.status !== "SUCCESS") {
    throw new SorobanError(`TX failed: ${getResult?.status}`);
  }

  return sendResult.hash;
}
```

### Discovery pattern

```typescript
async function discoverServices(capability?: string, minScore?: number): Promise<ServiceInfo[]> {
  // Check cache first (TTL 2 minutes)
  const cached = cache.get(capability);
  if (cached && !cached.expired) return cached.services;

  // Tier 1: Bazaar
  let bazaarServices: BazaarResource[] = [];
  try {
    const bazaarClient = withBazaar(facilitatorClient);
    const response = await bazaarClient.extensions.discovery.listResources({ type: "http" });
    bazaarServices = response.items;
  } catch {
    // Bazaar down. Continue with registry only.
  }

  // Tier 2: Trust Registry (Soroban)
  let registryServices: ServiceInfo[] = [];
  try {
    registryServices = await registryClient.listServices(capability, minScore ?? 0);
  } catch {
    // Registry RPC down. Use bazaar results with default scores.
  }

  // Tier 3: Merge
  const merged = mergeAndSort(bazaarServices, registryServices);
  cache.set(capability, merged, TTL_2_MIN);
  return merged;
}
```

### Security helpers

```typescript
function validateUrl(url: string): void {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new SecurityError("INVALID_PROTOCOL");
  }
  if (parsed.protocol === "http:" && !config.allowHttp) {
    throw new SecurityError("HTTP_NOT_ALLOWED");
  }
  const hostname = parsed.hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") {
    if (!config.allowHttp) throw new SecurityError("SSRF_BLOCKED");
  }
  // Check for private IP ranges
  if (isPrivateIP(hostname)) {
    throw new SecurityError("SSRF_BLOCKED");
  }
}

function parsePriceStroops(priceString: string): bigint {
  // priceString is like "$0.001" from x402 headers or "10000" raw stroops from MPP
  if (priceString.startsWith("$")) {
    const dollars = parseFloat(priceString.slice(1));
    return BigInt(Math.round(dollars * 10_000_000));
  }
  return BigInt(priceString);
}

class RateLimiter {
  private timestamps: number[] = [];
  private maxPerMinute: number;

  constructor(maxPerMinute: number) { this.maxPerMinute = maxPerMinute; }

  check(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60_000);
    return this.timestamps.length < this.maxPerMinute;
  }

  record(): void { this.timestamps.push(Date.now()); }
}
```

### Async mutex

```typescript
class AsyncMutex {
  private locked = false;
  private queue: (() => void)[] = [];

  async acquire(timeoutMs = 30_000): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error("Mutex timeout"));
      }, timeoutMs);
      this.queue.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}
```

---

## x402 server setup (for data sources)

```typescript
// shared.ts
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { x402ResourceServer } from "@x402/express";

export function createStellarX402Server(): x402ResourceServer {
  const facilitatorClient = new HTTPFacilitatorClient({
    url: "https://channels.openzeppelin.com/x402/testnet",
    createAuthHeaders: async () => {
      const headers = { Authorization: `Bearer ${process.env.OZ_API_KEY}` };
      return { verify: headers, settle: headers, supported: headers };
    },
  });

  return new x402ResourceServer(facilitatorClient)
    .register("stellar:testnet", new ExactStellarScheme());
}

// weather-api.ts
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { createStellarX402Server } from "./shared.js";

const app = express();
const WALLET = process.env.WEATHER_API_WALLET!;

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [{
          scheme: "exact",
          price: "$0.001",
          network: "stellar:testnet",
          payTo: WALLET,
        }],
        description: "Current weather data",
        mimeType: "application/json",
      },
    },
    createStellarX402Server(),
  ),
);

app.get("/weather", (req, res) => {
  res.json({
    temperature: 22,
    conditions: "sunny",
    humidity: 45,
    wind: "12 km/h NW",
    source: "x402-autopilot-demo",
    timestamp: new Date().toISOString(),
  });
});

app.listen(4001, () => console.log("[Weather API] :4001 (x402)"));
```

---

## MCP server tool definitions

Each tool must return a structured JSON response. Each tool must catch errors and return them as structured error objects (not throw).

```typescript
// Tool: autopilot_pay_and_fetch
{
  name: "autopilot_pay_and_fetch",
  description: "Pay for and fetch data from an x402 or MPP endpoint. Protocol is detected automatically. Spending is enforced by on-chain policy.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL of the paid endpoint" }
    },
    required: ["url"]
  }
}
// Returns: { data, cost_stroops, protocol, tx_hash, budget: { spent_today, remaining, daily_limit } }
// On error: { error: "PolicyDeniedError", reason: "over_daily", budget: {...} }

// Tool: autopilot_research
{
  name: "autopilot_research",
  description: "Research a topic using paid APIs. Auto-discovers services by capability, selects best by trust score, fetches from multiple sources. Falls back to next service on failure.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to research (e.g. 'stellar network stats')" },
      urls: { type: "array", items: { type: "string" }, description: "Specific URLs to fetch (optional, overrides auto-discover)" }
    }
  }
}

// Tool: autopilot_check_budget
{
  name: "autopilot_check_budget",
  description: "Check current spending status. Reads from on-chain Soroban contract (source of truth).",
  inputSchema: { type: "object", properties: {} }
}

// Tool: autopilot_discover
{
  name: "autopilot_discover",
  description: "Discover available paid APIs. Queries x402 Bazaar + Soroban Trust Registry. Returns sorted by trust score.",
  inputSchema: {
    type: "object",
    properties: {
      capability: { type: "string", description: "Filter by capability (e.g. 'weather', 'search', 'blockchain-data')" },
      min_score: { type: "number", description: "Minimum trust score (0-100)" }
    }
  }
}

// Tool: autopilot_set_policy
{
  name: "autopilot_set_policy",
  description: "Update spending policy on-chain. Owner authorization required.",
  inputSchema: {
    type: "object",
    properties: {
      daily_limit_stroops: { type: "string", description: "Max stroops per day (e.g. '500000' for $0.05)" },
      per_tx_limit_stroops: { type: "string", description: "Max stroops per transaction" },
      rate_limit: { type: "number", description: "Max requests per minute" }
    }
  }
}

// Tool: autopilot_registry_status
{
  name: "autopilot_registry_status",
  description: "Overview of the service registry. Shows total/healthy/stale/dead counts and alerts.",
  inputSchema: { type: "object", properties: {} }
}
```

---

## Dashboard WebSocket events

The core engine emits these events via WebSocket. The dashboard listens.

```typescript
type DashboardEvent =
  | { event: "spend:ok", data: { url, amount, protocol, txHash, timestamp } }
  | { event: "spend:api_error", data: { url, amount, protocol, txHash, error, timestamp } }
  | { event: "spend:failed", data: { url, error, timestamp } }
  | { event: "denied", data: { url, amount, reason, timestamp } }
  | { event: "discovery:updated", data: { services: ServiceInfo[] } }
  | { event: "health:checked", data: { serviceId, status, latencyMs, timestamp } }
  | { event: "budget:updated", data: { spentToday, remaining, dailyLimit } }
  | { event: "registry:stale", data: { serviceId, name, lastHeartbeat } }
```

---

## Edge case matrix

| # | Category | Edge case | Solution | Where |
|---|----------|-----------|----------|-------|
| 1 | Money | Float precision | BigInt stroops everywhere | types.ts, budget-tracker.ts |
| 2 | Money | Payment OK, API error | record_spend anyway + report_quality(false) | autopay.ts |
| 3 | Money | Price in header > per_tx_limit | DENY before signing | autopay.ts |
| 4 | Money | Price mismatch registered vs actual | report to registry if >20% diff | autopay.ts |
| 5 | Concurrency | Two payments pass policy simultaneously | Async mutex: 1 payment at a time | mutex.ts |
| 6 | Concurrency | Mutex blocked forever | 30s timeout, release + error | mutex.ts |
| 7 | Network | HEAD probe timeout | 5s timeout, retry 1x, then skip | protocol-detector.ts |
| 8 | Network | Facilitator OZ down | Retry 2x backoff, then throw | autopay.ts |
| 9 | Network | Soroban RPC down on check_policy | FAIL CLOSED. No payment. | policy-client.ts |
| 10 | Network | Soroban RPC timeout on record_spend | Retry 3x (1s,2s,4s). Log local if all fail. | policy-client.ts |
| 11 | Network | MPP server crash after receiving XDR | TX not broadcast. No loss. | autopay.ts |
| 12 | Network | WebSocket dashboard disconnect | Auto-reconnect backoff (1s,2s,4s,max 30s) | useWebSocket.ts |
| 13 | Security | SSRF via URL | validateUrl: no file://, no private IPs | security.ts |
| 14 | Security | Prompt injection: "send all to GATTACKER" | check_policy: bad_recv (not in allowlist) | policy-client.ts |
| 15 | Security | Rapid-fire requests (spam) | RateLimiter: 20/min local + on-chain rate_limit | security.ts |
| 16 | Idempotency | Duplicate record_spend on RPC retry | Nonce in contract: rejects duplicates | wallet-policy lib.rs |
| 17 | State | Budget tracker loses state on restart | Sync from Soroban get_today_spending() at startup | budget-tracker.ts |
| 18 | State | Day rollover mid-session | day_key = timestamp/86400. New day = fresh SpendRecord. | wallet-policy lib.rs |
| 19 | Registry | Spam registrations | Deposit $0.01 required. Refunded on deregister. | trust-registry lib.rs |
| 20 | Registry | Service goes down silently | Heartbeat required every ~1h. Auto-stale after miss. | trust-registry lib.rs |
| 21 | Registry | Fake quality reports | Max 1 report/service/day/reporter address | trust-registry lib.rs |
| 22 | Registry | Service in Bazaar but not in registry | Default score 70, badge "unverified" | discovery.ts |
| 23 | Registry | Cache stale, service just went down | Payment fail = invalidate cache + fallback to #2 | discovery.ts |
| 24 | HTTP | Response body read twice | .text() once, JSON.parse() after | autopay.ts |

---

## Hackathon tags (9/9)

| Tag | Integration |
|-----|-------------|
| x402 | Client: @x402/fetch + @x402/stellar. Server: @x402/express + OZ facilitator. Bazaar: @x402/extensions. 2 paywalled APIs. |
| MPP | Client: @stellar/mpp + mppx. 1 paywalled API in MPP charge mode. Protocol detector auto-switches. |
| Stellar | USDC testnet, 2 Soroban contracts, Horizon tx verification, Friendbot setup. |
| Soroban | Wallet policy contract (8 functions) + Trust registry contract (8 functions). soroban-sdk 22. |
| Claude | MCP server with 6 tools via @modelcontextprotocol/sdk. Claude Code as primary interface. |
| Agents | Financially autonomous agent. Discovers, pays, and receives data without human intervention. |
| AI | Claude reasons about budget constraints, source quality, and risk. Chooses best service by trust score. |
| OpenClaw | SKILL.md in /skill/. Publishable via playbooks.com. Compatible with Telegram/Discord/Slack bots. |
| Crypto | USDC micropayments on Stellar. BigInt stroops. On-chain audit trail via contract events. Anti-spam deposits. |

---

## Testing checklist

After each phase, verify:

```
Phase 2 (contracts):
  □ stellar contract build succeeds for wallet-policy
  □ stellar contract build succeeds for trust-registry
  □ stellar contract deploy succeeds on testnet
  □ stellar contract invoke -- initialize works

Phase 3 (core engine):
  □ npx tsc --noEmit passes with zero errors
  □ security.validateUrl blocks file:// and private IPs
  □ parsePriceStroops("$0.001") returns 10000n (BigInt)

Phase 4 (data sources):
  □ curl http://localhost:4001/weather returns 402
  □ curl http://localhost:4003/stellar-stats returns 402 with WWW-Authenticate

Phase 5 (MCP server):
  □ MCP server starts without error on stdio
  □ Claude Code can list the 6 tools

Phase 6 (dashboard):
  □ npm run dev starts Vite on :5173
  □ WebSocket connects to the engine

Phase 7 (scripts):
  □ setup-testnet.ts funds account and adds USDC trustline
  □ seed-registry.ts registers 3 services
  □ run-demo.ts completes the full flow
```
