# Architecture

## System overview

```mermaid
graph TD
    subgraph "Interface Layer"
        CC[Claude Code / MCP Client]
        DASH[React Dashboard :5173]
    end

    subgraph "MCP Server (464 lines)"
        MCP[mcp-server/src/index.ts<br>6 tools, stdio transport]
    end

    subgraph "Core Engine (src/, 1831 lines)"
        AP[autopay.ts<br>Orchestrator, 250 lines]
        SEC[security.ts<br>URL validation, SSRF, rate limit]
        PD[protocol-detector.ts<br>HEAD probe, x402 v2 header parsing]
        PC[policy-client.ts<br>Soroban RPC for wallet-policy]
        RC[registry-client.ts<br>Soroban RPC for trust-registry]
        BT[budget-tracker.ts<br>BigInt local cache]
        DC[discovery.ts<br>Bazaar + Registry + 2min cache]
        EB[event-bus.ts<br>WebSocket broadcast]
        MX[mutex.ts<br>Sequential payment lock]
        HC[health-checker.ts<br>Periodic HEAD probes]
        CFG[config.ts<br>Env validation, x402 + mppx clients]
        TY[types.ts<br>6 error classes, 9 type definitions]
    end

    subgraph "Data Sources"
        W[Weather API :4001<br>x402, $0.001]
        N[News API :4002<br>x402, $0.001]
        S[Stellar Data :4003<br>MPP charge, $0.002]
    end

    subgraph "Stellar Testnet"
        WP[wallet-policy<br>Soroban contract, 8 fn]
        TR[trust-registry<br>Soroban contract, 8 fn]
        FAC[OZ Facilitator]
        SRPC[Soroban RPC]
    end

    CC -->|stdio| MCP
    MCP --> AP
    AP --> SEC
    AP --> PD
    AP --> PC
    AP --> BT
    AP --> DC
    AP --> MX
    PC --> SRPC
    RC --> SRPC
    PD --> W
    PD --> N
    PD --> S
    DC --> FAC
    DC --> RC
    AP -->|WebSocket| EB
    EB --> DASH
    HC --> W
    HC --> N
    HC --> S
```

## Directory structure

```
x402-autopilot/
  CLAUDE.md                     Build specification
  README.md                     Hackathon submission
  ARCHITECTURE.md               This file
  package.json                  Root workspace + scripts
  tsconfig.json                 Strict, ES2022, NodeNext

  contracts/
    wallet-policy/
      Cargo.toml                soroban-sdk 22.0.0
      src/lib.rs                8 pub fn, 353 lines
    trust-registry/
      Cargo.toml                soroban-sdk 22.0.0
      src/lib.rs                8 pub fn, 351 lines

  src/                          12 modules, 1831 lines total
    types.ts                    6 error classes, 9 type definitions (149 lines)
    config.ts                   Env validation, keypair, x402 + mppx clients (126 lines)
    security.ts                 validateUrl, parsePriceStroops, RateLimiter (117 lines)
    mutex.ts                    AsyncMutex with 30s timeout (41 lines)
    event-bus.ts                EventBus + WebSocket broadcast (65 lines)
    budget-tracker.ts           BigInt local cache, sync from Soroban (88 lines)
    policy-client.ts            checkPolicy, recordSpend, updatePolicy (316 lines)
    registry-client.ts          listServices, reportQuality, heartbeat (223 lines)
    protocol-detector.ts        HEAD probe, x402 v2 + MPP header parsing (201 lines)
    discovery.ts                Bazaar + Registry + 2min cache (144 lines)
    health-checker.ts           5-minute interval HEAD probes (111 lines)
    autopay.ts                  Main orchestrator (250 lines)

  mcp-server/src/
    index.ts                    6 tools, Server + StdioServerTransport (464 lines)

  data-sources/src/
    shared.ts                   x402 server factory, self-registration helper
    weather-api.ts              Express + paymentMiddleware, port 4001
    news-api.ts                 Express + paymentMiddleware, port 4002
    stellar-data-api.ts         Express + mppx/express, port 4003

  dashboard/src/
    main.tsx                    React root
    App.tsx                     5 panels, dark theme (543 lines)
    hooks/useWebSocket.ts       useReducer, auto-reconnect, backoff (140 lines)

  scripts/
    setup-testnet.ts            Fund wallet, add USDC trustline
    deploy-wallet-policy.sh     Build + deploy + initialize
    deploy-trust-registry.sh    Build + deploy + initialize
    seed-registry.ts            Register 3 demo services
    run-demo.ts                 Full demo flow (recordable)
    health-report.ts            CLI health check table

  skill/
    SKILL.md                    OpenClaw skill definition
```

Total: 26 TypeScript/TSX files, 2 Rust contract files, 2 shell scripts.

## Payment flow (x402)

```mermaid
sequenceDiagram
    participant Agent as Claude Code
    participant MCP as MCP Server
    participant AP as autopay.ts
    participant PD as Protocol Detector
    participant PC as Policy Client
    participant API as Weather API :4001
    participant FAC as OZ Facilitator
    participant WP as Wallet Policy Contract

    Agent->>MCP: autopilot_pay_and_fetch(url)
    MCP->>AP: autopilotFetch(url)
    AP->>AP: validateUrl (SSRF check)
    AP->>AP: mutex.acquire()
    AP->>PD: detect(url)
    PD->>API: HEAD /weather
    API-->>PD: 402 + PAYMENT-REQUIRED (base64 JSON)
    PD->>PD: parseX402V2Header (decode base64)
    PD-->>AP: { protocol: "x402", price: "10000", payTo: "G..." }

    AP->>AP: parsePriceStroops("10000") = 10000n
    AP->>AP: budgetTracker.checkLocal(10000n)
    AP->>PC: checkPolicy(10000n, recipient)
    PC->>WP: simulateTransaction(check_policy)
    WP-->>PC: { allowed: true, remaining: 4990000n }
    PC-->>AP: allowed

    AP->>API: x402Fetch(url) via @x402/fetch
    Note over AP,FAC: x402 SDK handles payment negotiation via OZ facilitator
    API-->>AP: 200 + weather data

    AP->>AP: response.text() (read ONCE)
    AP->>AP: nonce = truncate to 32 chars
    AP->>PC: recordSpend(nonce, 10000n, recipient, txHash)
    PC->>WP: invokeContract(record_spend)
    WP-->>PC: confirmed

    AP->>AP: budgetTracker.recordLocal(10000n)
    AP->>AP: eventBus.emit("spend:ok")
    AP->>AP: mutex.release()
    AP-->>MCP: { data, cost: 10000n, protocol: "x402" }
    MCP-->>Agent: JSON result + budget
```

## Payment flow (MPP charge)

The MPP path uses the mppx SDK client. `Mppx.create({ polyfill: false })` returns a scoped `.fetch()` that handles the full 402 challenge-response-credential cycle without polyfilling globalThis.fetch. This coexists cleanly with the x402 fetch wrapper.

```mermaid
sequenceDiagram
    participant AP as autopay.ts
    participant PD as Protocol Detector
    participant MPP as mppFetch (mppx SDK)
    participant API as Stellar Data :4003
    participant RPC as Soroban RPC

    AP->>PD: detect(url)
    PD->>API: HEAD /stellar-stats
    API-->>PD: 402 + WWW-Authenticate: Payment
    PD->>PD: decode base64url request param
    PD-->>AP: { protocol: "mpp", price: "20000", recipient: "G..." }

    AP->>AP: policy check + budget check (same as x402)

    AP->>MPP: mppFetch(url)
    Note over MPP,API: SDK handles internally:
    MPP->>API: GET /stellar-stats
    API-->>MPP: 402 + challenge
    MPP->>MPP: Build credential (signed SAC transfer XDR)
    MPP->>RPC: Prepare + broadcast transaction
    RPC-->>MPP: TX confirmed
    MPP->>API: GET /stellar-stats + Authorization: Payment (credential)
    API-->>MPP: 200 + stellar data + Payment-Receipt
    MPP-->>AP: Response (200)

    AP->>AP: response.text(), recordSpend, emit event
```

## Wallet policy contract

On-chain source of truth for spending limits. All money amounts are i128 (stroops).

```mermaid
stateDiagram-v2
    [*] --> Initialized: initialize(owner, limits)

    state "Policy Check" as PC {
        [*] --> CheckPerTx: amount <= per_tx_limit?
        CheckPerTx --> CheckDaily: yes
        CheckPerTx --> Denied: no (over_per_tx)
        CheckDaily --> CheckRate: spent + amount <= daily_limit?
        CheckDaily --> Denied: no (over_daily)
        CheckRate --> CheckAllowlist: minute_count < rate_limit?
        CheckRate --> Denied: no (rate_limited)
        CheckAllowlist --> Allowed: recipient in allowlist?
        CheckAllowlist --> Denied: no (bad_recv)
    }

    Initialized --> PC: check_policy(amount, recipient)
    Allowed --> RecordSpend: record_spend(nonce, amount, recipient, tx_hash)
    Denied --> RecordDenied: record_denied(amount, reason)
```

**8 functions:**

| Function | Type | Purpose |
|----------|------|---------|
| `initialize` | write | Set owner, daily/per-tx/rate limits |
| `check_policy` | read | Check all limits, return allowed/denied + remaining |
| `record_spend` | write | Record confirmed spend, nonce dedup (Symbol max 32 chars) |
| `record_denied` | write | Increment denied count, emit event |
| `update_policy` | write | Change limits (owner auth) |
| `set_allowlist` | write | Set recipient whitelist (owner auth) |
| `get_today_spending` | read | Current day spend record (day_key = timestamp/86400) |
| `get_lifetime_stats` | read | Total spent, tx count, denied count |

Storage: instance (policy, owner, allowlist) + persistent (spend records, nonces, lifetime).

## Trust registry contract

On-chain directory of paid API services with anti-spam deposits and trust scoring.

**8 functions:**

| Function | Type | Purpose |
|----------|------|---------|
| `initialize` | write | Set admin, USDC SAC address |
| `register_service` | write | Register + deposit 100,000 stroops ($0.01) |
| `deregister_service` | write | Remove + refund deposit |
| `heartbeat` | write | Prove service is alive (every ~720 ledgers) |
| `report_quality` | write | Success/fail report (max 1/reporter/service/day) |
| `list_services` | read | Filter by capability + min trust score |
| `get_service` | read | Get single service info |
| `check_stale` | write | Permissionless. >720 ledgers = stale, >7200 = removed |

Trust score: `successes * 100 / total_reports`. Default 70 for new services.

## Discovery pipeline

```mermaid
flowchart TD
    START[discoverServices capability, minScore] --> CACHE{Cache hit?<br>TTL 2 min}
    CACHE -->|yes| RETURN[Return cached]
    CACHE -->|no| BAZAAR[Tier 1: x402 Bazaar<br>HTTP to OZ facilitator]
    BAZAAR -->|success| REG
    BAZAAR -->|fail| REG
    REG[Tier 2: Trust Registry<br>Soroban list_services] --> COMBINE
    COMBINE[Tier 3: Merge + Deduplicate<br>by URL, registry wins]
    COMBINE --> SCORE[Filter by minScore<br>Sort by trust score desc]
    SCORE --> STORE[Cache for 2 min]
    STORE --> RETURN

    style BAZAAR fill:#6366f1,color:#fff
    style REG fill:#22c55e,color:#fff
```

Bazaar services not in the registry get default score 70 and "unverified" badge. On payment failure, the specific service is invalidated from cache.

## Security model

| Threat | Mitigation | Location |
|--------|-----------|----------|
| SSRF via URL | Block file://, private IPs, localhost (unless ALLOW_HTTP) | security.ts |
| Overspend via prompt injection | On-chain policy check, allowlist enforcement | wallet-policy contract |
| Concurrent budget race | Async mutex, one payment at a time | mutex.ts |
| RPC downtime bypass | Fail-closed: RPC unreachable = payment denied | policy-client.ts |
| Replay attack | Nonce stored on-chain, duplicates rejected | wallet-policy contract |
| Nonce overflow | Truncated to 32 chars (Soroban Symbol limit) | autopay.ts |
| Registry spam | $0.01 USDC deposit, forfeited if service goes stale | trust-registry contract |
| Fake quality reports | Max 1 report per (reporter, service, day) | trust-registry contract |
| Secret exposure | Private key never exported/logged, masked in errors | config.ts, error paths |
| Response body consumed twice | .text() once, JSON.parse separately | autopay.ts |

## Dashboard events

The core engine emits events via WebSocket. The dashboard receives them as JSON with BigInt fields serialized to strings.

| Event | Source | Dashboard panel |
|-------|--------|----------------|
| `spend:ok` | autopay.ts | Transaction log (green OK badge) |
| `spend:api_error` | autopay.ts | Transaction log (red ERR badge) |
| `spend:failed` | autopay.ts | Transaction log (red FAIL badge) |
| `denied` | autopay.ts | Denied panel (red background) |
| `discovery:updated` | discovery.ts | Service registry table |
| `health:checked` | health-checker.ts | Health monitor |
| `budget:updated` | budget-tracker.ts | Budget panel + header |
| `registry:stale` | health-checker.ts | Health monitor (amber) |

## Design decisions

**BigInt everywhere for money.** JavaScript Number loses precision above 2^53. USDC has 7 decimal places. 1 USDC = 10,000,000 stroops. BigInt prevents rounding errors. The tradeoff: BigInt is not JSON-serializable, so every JSON.stringify needs a replacer function.

**Fail-closed on RPC failure.** If the Soroban RPC is down, `checkPolicy` returns `{ allowed: false, reason: "rpc_unavailable" }`. Allowing payments without policy check would defeat on-chain enforcement.

**Mutex for sequential payments.** Two concurrent autopilotFetch calls could both pass the budget check and overspend. The mutex ensures one-at-a-time. The tradeoff: payments queue up and total latency increases linearly.

**Separate fetch wrappers for x402 and MPP.** The x402 SDK (`@x402/fetch`) wraps globalThis.fetch. The mppx SDK also wants to wrap fetch. To prevent conflicts, `Mppx.create({ polyfill: false })` creates a scoped `mppFetch` that handles MPP payments without touching the global. The protocol detector decides which wrapper to use.

**2-minute cache for discovery.** Querying Soroban for every discover call is expensive (2-3 seconds). The cache balances freshness with latency. On payment failure, the specific service is invalidated immediately.

**Nonce truncated to 32 chars.** Soroban Symbols are limited to 32 characters. The nonce format is `n{base36_timestamp}_{txHash_prefix}` sliced to 32 chars. This provides uniqueness without exceeding the contract's storage key limit.
