# Architecture

## System overview

x402 Autopilot is an autonomous payment engine for AI agents on Stellar. Claude connects via MCP, discovers paid APIs through a 3-tier pipeline (Bazaar, on-chain trust registry, xlm402.com), pays with USDC micropayments, and tracks spending against on-chain Soroban policy contracts. An analyst agent demonstrates agent-to-agent payments by earning money from the main agent and spending money to buy data from other services. A CLI dashboard manages all processes and shows live status.

## Component diagram

```mermaid
flowchart TD
    subgraph Interface
        CC["Claude Desktop"]
        CLI["CLI Dashboard<br/>ANSI terminal"]
        DASH["Web Dashboard<br/>:5173 React"]
    end

    subgraph MCP["MCP Server - 464 lines"]
        MCPS["index.ts<br/>6 tools, stdio transport"]
    end

    subgraph Core["Core Engine - 13 modules, 2174 lines"]
        AP["autopay.ts<br/>326 lines"]
        SEC["security.ts<br/>SSRF, rate limit"]
        PD["protocol-detector.ts<br/>HEAD probe"]
        PC["policy-client.ts<br/>Soroban RPC"]
        RC["registry-client.ts<br/>Soroban RPC"]
        BT["budget-tracker.ts<br/>BigInt cache"]
        DC["discovery.ts<br/>3-tier pipeline"]
        EB["event-bus.ts<br/>WebSocket broadcast"]
        MX["mutex.ts<br/>sequential lock"]
        WS["ws-server.ts<br/>polls Soroban"]
    end

    subgraph Sources["Data Sources - 5 files, 857 lines"]
        W["Weather :4001<br/>x402 $0.001"]
        N["News :4002<br/>x402 $0.001"]
        S["Stellar Data :4003<br/>MPP $0.002"]
        AN["Analyst :4004<br/>x402 $0.005"]
    end

    subgraph External["External Services"]
        XL["xlm402.com<br/>21 testnet endpoints"]
    end

    subgraph Stellar["Stellar Testnet"]
        WP["wallet-policy<br/>8 functions"]
        TR["trust-registry<br/>8 functions"]
        FAC["OZ Facilitator"]
    end

    CC -->|stdio| MCPS
    MCPS --> AP
    AP --> SEC
    AP --> PD
    AP --> PC
    AP --> BT
    AP --> DC
    AP --> MX
    PC --> WP
    RC --> TR
    DC --> FAC
    DC --> RC
    DC --> XL
    AP --> W
    AP --> N
    AP --> S
    AP --> AN
    AP --> XL
    AN --> W
    AN --> N
    AN --> LLM["Claude LLM"]
    WS -->|polls| WP
    CLI -->|WebSocket| WS
    DASH -->|WebSocket| WS
    CLI -->|spawns| W
    CLI -->|spawns| N
    CLI -->|spawns| S
    CLI -->|spawns| AN
    CLI -->|spawns| WS
    CLI -->|spawns| DASH
```

## Payment flow: x402

```mermaid
sequenceDiagram
    participant Agent as Claude Desktop
    participant MCP as MCP Server
    participant AP as autopay.ts
    participant PD as Protocol Detector
    participant PC as Policy Client
    participant API as Weather API :4001
    participant FAC as OZ Facilitator
    participant WP as Wallet Policy

    Agent->>MCP: autopilot_pay_and_fetch(url)
    MCP->>AP: autopilotFetch(url)
    AP->>AP: validateUrl - SSRF check
    AP->>AP: mutex.acquire
    AP->>PD: detect(url)
    PD->>API: HEAD /weather
    API-->>PD: 402 + PAYMENT-REQUIRED base64
    PD->>PD: parseX402V2Header
    PD-->>AP: protocol x402, price 10000, payTo G...

    AP->>AP: parsePriceStroops = 10000n
    AP->>AP: budgetTracker.checkLocal
    AP->>PC: checkPolicy(10000n, recipient)
    PC->>WP: simulateTransaction
    WP-->>PC: allowed, remaining 4990000n
    PC-->>AP: allowed

    AP->>API: x402Fetch via @x402/fetch
    Note over AP,FAC: SDK handles payment via facilitator
    API-->>AP: 200 + weather data

    AP->>AP: response.text - read ONCE
    AP->>PC: recordSpend(nonce, 10000n, recipient, txHash)
    PC->>WP: invokeContract
    AP->>AP: budgetTracker.recordLocal
    AP->>AP: eventBus.emit spend ok
    AP->>AP: mutex.release
    AP-->>MCP: data + cost + protocol
    MCP-->>Agent: JSON result + budget
```

## Payment flow: MPP charge

```mermaid
sequenceDiagram
    participant AP as autopay.ts
    participant PD as Protocol Detector
    participant MPP as mppFetch
    participant API as Stellar Data :4003
    participant RPC as Soroban RPC

    AP->>PD: detect(url)
    PD->>API: HEAD /stellar-stats
    API-->>PD: 402 + WWW-Authenticate Payment
    PD-->>AP: protocol mpp, price 20000

    AP->>AP: policy check + budget check

    AP->>MPP: mppFetch(url)
    MPP->>API: GET /stellar-stats
    API-->>MPP: 402 + challenge
    MPP->>MPP: Build credential with signed SAC transfer
    MPP->>RPC: Prepare + broadcast transaction
    RPC-->>MPP: TX confirmed
    MPP->>API: GET + Authorization Payment credential
    API-->>MPP: 200 + stellar data + receipt
    MPP-->>AP: Response 200

    AP->>AP: recordSpend, emit event
```

## Payment flow: agent-to-agent

The analyst agent earns money from the main agent and spends money to buy data from other services. Three wallets, four transactions.

```mermaid
sequenceDiagram
    participant Claude as Claude Desktop
    participant MCP as MCP Server
    participant AP as autopay.ts
    participant AN as Analyst :4004
    participant W as Weather :4001
    participant N as News :4002
    participant LLM as Claude LLM

    Claude->>MCP: autopilot_pay_and_fetch /analyze
    MCP->>AP: autopilotFetch localhost:4004/analyze
    AP->>AP: Policy check + budget check
    AP->>AN: x402 payment $0.005
    Note over AP,AN: Main agent wallet pays analyst wallet

    AN->>W: x402 payment $0.001
    Note over AN,W: Analyst wallet pays weather wallet
    W-->>AN: Weather data

    AN->>N: x402 payment $0.001
    Note over AN,N: Analyst wallet pays news wallet
    N-->>AN: News data

    AN->>LLM: Analyze weather + news data
    LLM-->>AN: Analysis text

    AN-->>AP: Analysis + economics breakdown
    Note over AN,AP: Earned $0.005, spent $0.002, profit $0.003
    AP-->>MCP: Result + cost
    MCP-->>Claude: Display to user
```

## Discovery pipeline

Three tiers, deduplicated by URL (registry wins), cached for 2 minutes.

```mermaid
flowchart LR
    D["discoverServices<br/>capability, minScore, limit"] --> T1["Tier 1: Bazaar CDP"]
    D --> T2["Tier 2: Trust Registry<br/>Soroban on-chain"]
    D --> T3["Tier 3: xlm402.com<br/>21 testnet endpoints"]
    T1 --> M["Merge + Dedup<br/>by URL"]
    T2 --> M
    T3 --> M
    M --> S["Filter by minScore<br/>Sort by trust score"]
    S --> C["Cache 2 min"]
    C --> R["Return"]
```

| Tier | Source | Speed | Trust |
|------|--------|-------|-------|
| 1 | x402 Bazaar CDP | Fast HTTP | Default 70 |
| 2 | Soroban Trust Registry | 2-3s simulate | On-chain score |
| 3 | xlm402.com catalog | 1-2s HTTPS | Default 70 |

If any tier is down, the others still work. Discovery degrades but does not fail.

## Trust registry v2 architecture

Services are stored in temporary storage with TTL-based expiry. No manual stale checking needed.

```mermaid
flowchart TD
    I["Instance Storage<br/>Admin + UsdcAddr + NextId<br/>~40 bytes, never grows"]
    T["Temporary Storage<br/>Service per id<br/>auto-expire on TTL 0"]
    P["Persistent Storage<br/>CapIndex per capability<br/>DepositRecord per id"]

    I -->|"register increments NextId"| T
    T -->|"heartbeat extends TTL to 180 ledgers"| T
    T -->|"expire triggers cleanup"| P
    P -->|"heartbeat cleans dead IDs"| P
```

**Storage layout:**
- **Instance:** Admin (Address), UsdcAddr (Address), NextId (u32). Fixed size, never grows.
- **Temporary:** Service(id) maps to ServiceInfo. Auto-expires when TTL reaches 0. Heartbeat extends to 180 ledgers (~15 min).
- **Persistent:** CapIndex(capability) maps to Vec of service IDs. DepositRecord(id) stores owner + amount for refund.

**Registration re-entry:** On restart, shared.ts calls `listServices` before `register_service`. If the previous registration is still alive (TTL > 0), the existing service ID is reused and heartbeat resumes. This avoids the "duplicate URL" panic from the contract.

**Cleanup flows:**
- Graceful shutdown: service calls deregister, removed immediately, deposit refunded.
- Crash: no deregister. TTL counts down. At TTL 0, Soroban deletes the entry. Next heartbeat from a live service in the same capability cleans the dead ID from CapIndex. Deposit reclaimable by owner via reclaim_deposit.

## Wallet policy contract

On-chain source of truth for spending limits. All amounts are i128 (stroops).

```mermaid
stateDiagram-v2
    [*] --> Initialized: initialize

    state "Policy Check" as PC {
        [*] --> CheckPerTx: amount under per_tx_limit
        CheckPerTx --> CheckDaily: yes
        CheckPerTx --> Denied: over_per_tx
        CheckDaily --> CheckRate: spent + amount under daily_limit
        CheckDaily --> Denied: over_daily
        CheckRate --> CheckAllowlist: minute_count under rate_limit
        CheckRate --> Denied: rate_limited
        CheckAllowlist --> Allowed: recipient in allowlist
        CheckAllowlist --> Denied: bad_recv
    }

    Initialized --> PC: check_policy
    Allowed --> RecordSpend: record_spend with nonce
    Denied --> RecordDenied: record_denied
```

**8 functions:**

| Function | Type | Purpose |
|----------|------|---------|
| `initialize` | write | Set owner, daily/per-tx/rate limits |
| `check_policy` | read | Check all limits, return allowed/denied + remaining |
| `record_spend` | write | Record confirmed spend, nonce dedup |
| `record_denied` | write | Increment denied count, emit event |
| `update_policy` | write | Change limits (owner auth) |
| `set_allowlist` | write | Set recipient whitelist (owner auth) |
| `get_today_spending` | read | Current day spend record |
| `get_lifetime_stats` | read | Total spent, tx count, denied count |

## Trust registry contract

**8 functions:**

| Function | Type | Purpose |
|----------|------|---------|
| `initialize` | write | Set admin, USDC SAC address, NextId = 0 |
| `register_service` | write | Collect deposit, assign ID, store in temporary, add to CapIndex |
| `heartbeat` | write | Extend TTL to 180 ledgers, clean dead entries from CapIndex |
| `deregister_service` | write | Remove from temporary + CapIndex, refund deposit |
| `list_services` | read | Scan CapIndex by capability, filter by score, limit results |
| `get_service` | read | Direct lookup by ID from temporary storage |
| `report_quality` | write | Success/fail report, max 1 per reporter per service per day |
| `reclaim_deposit` | write | Reclaim deposit after service TTL expires (crash recovery) |

## CLI dashboard

The CLI dashboard (`scripts/cli-dashboard.ts`, 468 lines) replaces `concurrently` as the process manager. It uses pure ANSI escape codes for rendering (no TUI library dependencies).

**Process management:**
- Spawns 6 processes: ws-server, weather, news, stellar-data, analyst, vite dashboard
- Each child spawned with `detached: true` (process group leader)
- On shutdown, kills entire process groups with `process.kill(-pid, "SIGTERM")`
- On startup, frees ports 4001-4004, 5173-5175, 8080 with `fuser -k`
- Does NOT spawn MCP server (it uses stdio transport for Claude Desktop)

**Terminal rendering:**
- Alternative screen buffer (`\x1b[?1049h` / `\x1b[?1049l`)
- Cursor home + line overwrite each second (no flicker)
- Hidden cursor during render, restored on exit (including crash via uncaughtException)

**Live data:**
- WebSocket client connects to ws-server :8080 for budget events
- Parses `budget:updated` and `spend:ok` events from ws-server's Soroban polling
- Heartbeat timestamps updated from child stdout parsing

**Logging:**
- All child stdout/stderr written to `logs/YYYY-MM-DD_HH-mm-ss.log`
- ANSI codes stripped before parsing, preserved in log file
- Heartbeat lines logged but not printed to terminal (only counter updates)

## File breakdown

```
contracts/
  wallet-policy/src/lib.rs          353 lines, 8 pub fn
  trust-registry/src/lib.rs         426 lines, 8 pub fn

src/                                2174 lines total
  autopay.ts                        326 lines  orchestrator
  policy-client.ts                  316 lines  Soroban RPC for wallet-policy
  discovery.ts                      231 lines  3-tier discovery pipeline
  registry-client.ts                230 lines  Soroban RPC for trust-registry
  protocol-detector.ts              201 lines  HEAD probe, x402 v2 + MPP parsing
  ws-server.ts                      170 lines  WebSocket + Soroban polling
  types.ts                          147 lines  6 error classes, 9 types
  config.ts                         132 lines  env validation, x402 + mppx clients
  security.ts                       117 lines  SSRF prevention, rate limiter
  health-checker.ts                 110 lines  periodic probes
  budget-tracker.ts                  88 lines  BigInt local cache
  event-bus.ts                       65 lines  WebSocket broadcast
  mutex.ts                           41 lines  sequential payment lock

data-sources/src/                   857 lines total
  shared.ts                         346 lines  x402 server, registration, heartbeat
  analyst-api.ts                    284 lines  agent-to-agent
  news-api.ts                        82 lines  x402 paywall
  stellar-data-api.ts                75 lines  MPP paywall
  weather-api.ts                     70 lines  x402 paywall

mcp-server/src/
  index.ts                          464 lines  6 tools, stdio transport

dashboard/src/                      693 lines total
  App.tsx                           543 lines  5 panels, dark theme
  hooks/useWebSocket.ts             140 lines  auto-reconnect, backoff
  main.tsx                            9 lines  React root

scripts/                            897 lines total
  cli-dashboard.ts                  468 lines  ANSI terminal dashboard
  seed-registry.ts                  121 lines  register demo services
  run-demo.ts                       118 lines  full demo flow
  setup-testnet.ts                  104 lines  fund wallet, add USDC trustline
  health-report.ts                   86 lines  CLI health check table
```

## Security model

| Threat | Mitigation | Location |
|--------|-----------|----------|
| SSRF via URL | Block file://, private IPs, localhost unless ALLOW_HTTP | security.ts |
| Overspend via prompt injection | On-chain policy check, allowlist enforcement | wallet-policy |
| Concurrent budget race | Async mutex, one payment at a time | mutex.ts |
| RPC downtime bypass | Fail-closed: RPC unreachable = deny | policy-client.ts |
| Replay attack | Nonce stored on-chain, duplicates rejected | wallet-policy |
| Registry spam | $0.01 USDC deposit required | trust-registry |
| Fake quality reports | Max 1 per reporter per service per day | trust-registry |
| Secret exposure | Private key never exported or logged, masked in errors | config.ts |
| Response body consumed twice | .text() once, JSON.parse separately | autopay.ts |
| HEAD 200 but GET 402 | Re-classify response, fall through to payment | autopay.ts |
| Leftover ports on restart | killPorts frees all service ports on startup | cli-dashboard.ts |

## Dashboard events

Events broadcast via WebSocket from ws-server. BigInt fields serialized to strings.

| Event | Source | Content |
|-------|--------|---------|
| `budget:updated` | ws-server polling | spentToday, remaining, dailyLimit, txCount |
| `spend:ok` | ws-server polling | url, amount, protocol, txHash |

The ws-server polls the wallet-policy Soroban contract every 5 seconds. When spentToday or txCount changes, it broadcasts to all connected WebSocket clients (web dashboard and CLI dashboard).

## Design decisions

**BigInt everywhere for money.** JavaScript Number loses precision above 2^53. USDC has 7 decimal places. 1 USDC = 10,000,000 stroops. BigInt prevents rounding errors. Tradeoff: BigInt is not JSON-serializable, so every JSON.stringify needs a replacer function.

**Fail-closed on RPC failure.** If Soroban RPC is down, checkPolicy returns denied. Allowing payments without policy check would defeat on-chain enforcement.

**Mutex for sequential payments.** Two concurrent autopilotFetch calls could both pass the budget check and overspend. The mutex ensures one-at-a-time. Tradeoff: payments queue up and latency increases linearly.

**Separate fetch wrappers.** x402 SDK wraps globalThis.fetch. mppx SDK also wants to wrap fetch. To prevent conflicts, `Mppx.create({ polyfill: false })` creates a scoped mppFetch. The protocol detector decides which wrapper to use.

**2-minute discovery cache.** Querying Soroban for every discover call takes 2-3 seconds. The cache balances freshness with latency. On payment failure, the specific service is invalidated immediately.

**Temporary storage for services.** Services auto-expire when TTL reaches 0. No manual stale checking. Living services clean dead entries from the capability index during heartbeat. This prevents the instance storage DoS vector (Veridise, Palta Labs).

**Analyst as a real agent.** The analyst has its own wallet, its own x402 client, and makes autonomous economic decisions (which data to buy, how much to spend). The economics breakdown (earned, spent, profit) is visible in every response.

**CLI dashboard over concurrently.** The ANSI dashboard provides a fixed-layout view of all services instead of scrolling log output. Process groups with negative PID kill ensure clean shutdown. Port cleanup on startup handles interrupted previous sessions.

**Registration re-entry.** shared.ts calls listServices before register_service. If the URL is already registered (TTL still alive from a previous session), the existing service ID is reused. This prevents the "duplicate URL" contract panic on restart.
