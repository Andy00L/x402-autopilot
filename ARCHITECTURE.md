# Architecture

## System overview

x402 Autopilot is an autonomous payment engine for AI agents on Stellar. Claude (or any MCP-enabled agent) connects via stdio, discovers paid APIs through a 3-tier pipeline (Bazaar, on-chain trust registry, xlm402.com), pays with USDC micropayments, and tracks spending against an on-chain Soroban policy contract. Three of the four built-in data sources are themselves agents: they earn money from incoming requests and spend their own USDC to buy raw data from other agents before responding. A CLI dashboard manages the local process tree. A web dashboard (contract-explorer) renders a React Flow network graph with animated payment flows.

## Component diagram

```mermaid
flowchart TD
    subgraph Interface
        CC["Claude Desktop / OpenClaw"]
        CLI["scripts/cli-dashboard.ts<br/>ANSI terminal, 472 lines"]
        DASH["contract-explorer<br/>:5180 React Flow"]
    end

    subgraph MCP["mcp-server (621 lines)"]
        MCPS["index.ts<br/>6 tools, stdio transport"]
    end

    subgraph Core["Core engine (12 modules, 1967 lines)"]
        AP["autopay.ts (333)<br/>orchestrator"]
        SEC["security.ts (107)<br/>SSRF + price parser"]
        MX["mutex.ts (41)<br/>sequential lock"]
        PD["protocol-detector.ts (201)<br/>HEAD probe"]
        PC["policy-client.ts (316)<br/>Soroban RPC writer"]
        RC["registry-client.ts (120)<br/>Soroban RPC reader"]
        BT["budget-tracker.ts (88)<br/>BigInt cache"]
        DC["discovery.ts (231)<br/>3-tier pipeline"]
        EB["event-bus.ts (65)<br/>WebSocket broadcast"]
        WS["ws-server.ts (197)<br/>:8080, polls Soroban"]
        CFG["config.ts (132)<br/>env + x402/mppx clients"]
        TY["types.ts (136)<br/>6 error classes"]
    end

    subgraph Sources["data-sources (5 files, 2413 lines)"]
        W["weather-api.ts (215)<br/>Crypto Price Oracle :4001<br/>x402 $0.001"]
        N["news-api.ts (502)<br/>News + Briefing :4002<br/>x402 $0.001 / $0.003"]
        S["stellar-data-api.ts (620)<br/>Stellar Data + Market :4003<br/>MPP $0.002 / x402 $0.005"]
        AN["analyst-api.ts (544)<br/>Analyst :4004<br/>x402 $0.005"]
        SH["shared.ts (532)<br/>x402 server, registration, heartbeat"]
    end

    subgraph External["External services"]
        XL["xlm402.com<br/>testnet endpoints"]
        BAZ["x402 Bazaar CDP"]
        OZ["OZ Facilitator<br/>x402/testnet"]
        HZ["Horizon REST"]
    end

    subgraph Stellar["Stellar Testnet"]
        WP["wallet-policy<br/>8 fn, 353 lines"]
        TR["trust-registry<br/>8 fn, 426 lines"]
        USDC["USDC SAC"]
    end

    CC -->|stdio| MCPS
    MCPS --> AP
    AP --> SEC
    AP --> MX
    AP --> PD
    AP --> PC
    AP --> BT
    AP --> DC
    PC --> WP
    DC --> RC
    RC --> TR
    DC --> BAZ
    DC --> XL
    AP --> W
    AP --> N
    AP --> S
    AP --> AN
    AP --> XL
    N --> W
    S --> W
    S --> N
    AN --> W
    AN --> N
    W -->|SAC transfer| USDC
    N -->|SAC transfer| USDC
    S -->|SAC transfer| USDC
    AN -->|SAC transfer| USDC
    TR -->|SAC transfer| USDC
    SH --> TR
    W --> SH
    N --> SH
    S --> SH
    AN --> SH
    WS -->|polls every 5s| WP
    CLI -->|WebSocket| WS
    DASH -->|WebSocket| WS
    DASH -->|polls 15s| WP
    DASH -->|polls 15s| TR
    DASH -->|polls 20s| HZ
    MCPS -->|relays spend:ok| WS
    AP --> OZ
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
    participant MCP as mcp-server
    participant AP as autopay.ts
    participant SEC as security.ts
    participant MX as mutex.ts
    participant PD as protocol-detector.ts
    participant PC as policy-client.ts
    participant API as Crypto Price Oracle :4001
    participant FAC as OZ Facilitator
    participant WP as wallet-policy

    Agent->>MCP: autopilot_pay_and_fetch(url)
    MCP->>AP: autopilotFetch(url, {method, body})
    AP->>SEC: validateUrl(url)
    SEC-->>AP: ok
    AP->>MX: acquire(30000)
    MX-->>AP: lease
    AP->>PD: detect(url)
    PD->>API: HEAD /prices
    API-->>PD: 402 + payment-required (base64 JSON)
    PD->>PD: parseX402V2Header
    PD-->>AP: { protocol: "x402", priceRaw: "10000", recipient: "G..." }

    AP->>SEC: parsePriceStroops("10000")
    SEC-->>AP: 10000n
    AP->>AP: budgetTracker.checkLocal(10000n)
    AP->>PC: checkPolicy(10000n, recipient)
    PC->>WP: simulateTransaction(check_policy)
    WP-->>PC: { allowed: true, reason: "ok", remaining: 4990000n }
    PC-->>AP: allowed

    AP->>API: x402Fetch(url) via @x402/fetch
    Note over AP,FAC: SDK negotiates payment, signs SAC transfer<br/>via createEd25519Signer, settles via OZ facilitator
    API-->>AP: 200 + JSON body

    AP->>AP: response.text() (read once)
    AP->>AP: try JSON.parse, fallback to text
    AP->>PC: recordSpend(nonce, 10000n, recipient, txHash)
    Note over PC,WP: Retry 3x with 1s/2s/4s backoff<br/>on Soroban RPC failure
    PC->>WP: invokeContract(record_spend)
    WP-->>PC: SUCCESS hash
    AP->>AP: budgetTracker.recordLocal(10000n)
    AP->>AP: eventBus.emit("spend:ok")
    AP->>MX: release()
    AP-->>MCP: { data, costStroops, protocol, txHash }
    MCP-->>Agent: data + structuredContent (cost, budget, tx_hash)
```

## Payment flow: MPP charge

```mermaid
sequenceDiagram
    participant AP as autopay.ts
    participant PD as protocol-detector.ts
    participant MPP as mppFetch (mppx SDK)
    participant API as Stellar Data :4003
    participant RPC as Soroban RPC

    AP->>PD: detect(url)
    PD->>API: HEAD /stellar-stats
    API-->>PD: 402 + WWW-Authenticate Payment ...
    PD->>PD: extractMppPrice / extractMppRecipient
    PD-->>AP: { protocol: "mpp", priceRaw: "20000" }

    AP->>AP: parsePriceStroops + budget + checkPolicy
    AP->>MPP: mppFetch(url, init)
    MPP->>API: GET /stellar-stats
    API-->>MPP: 402 + challenge (request param, base64url JSON)
    MPP->>MPP: build credential, sign SAC transfer
    MPP->>RPC: prepareTransaction + sendTransaction
    RPC-->>MPP: TX confirmed
    MPP->>API: GET + Authorization: Payment <credential>
    API-->>MPP: 200 + JSON body + receipt
    MPP-->>AP: Response

    AP->>AP: read body, recordSpend, emit event
```

## Payment flow: agent-to-agent

The Analyst agent has its own keypair (`ANALYST_PRIVATE_KEY`/`ANALYST_PUBLIC_KEY`). It earns USDC from `/analyze` calls and spends USDC to buy raw data from the Crypto Price Oracle and the News service. Same code pattern is used in News Intelligence (buys prices) and Market Intelligence (buys prices and news).

```mermaid
sequenceDiagram
    participant Claude as Claude Desktop
    participant MCP as mcp-server
    participant AP as autopay.ts
    participant AN as Analyst :4004
    participant W as Crypto Prices :4001
    participant N as News :4002
    participant LLM as claude -p / Anthropic API

    Claude->>MCP: autopilot_pay_and_fetch(http://localhost:4004/analyze, POST, {query})
    MCP->>AP: autopilotFetch
    AP->>AP: policy check + mutex
    AP->>AN: x402 payment $0.005 (main wallet -> analyst wallet)
    Note over AP,AN: Real testnet USDC transfer #1

    AN->>AN: extractPreProvided(body) or extractQuery(body)
    AN->>W: agentFetch /prices?assets=stellar,bitcoin,ethereum
    Note over AN,W: Real testnet USDC transfer #2 ($0.001)<br/>Analyst wallet pays Crypto Prices wallet
    W-->>AN: { assets, source, timestamp }

    AN->>N: agentFetch /news
    Note over AN,N: Real testnet USDC transfer #3 ($0.001)<br/>Analyst wallet pays News wallet
    N-->>AN: { headlines, topic, timestamp }

    AN->>LLM: prompt with prices + news + query
    LLM-->>AN: analysis text

    AN-->>AP: { analysis, mode: "fetched", economics: {...} }
    Note over AN,AP: economics: earned 50000 stroops,<br/>spent 20000 + 10000 LLM,<br/>profit 20000 stroops
    AP->>AP: recordSpend, emit spend:ok
    AP-->>MCP: data + cost
    MCP-->>Claude: analysis (in content) + budget (in structuredContent)
```

When the caller passes pre-fetched data in `body.data.stories`, `body.stories`, or `body.data`, the analyst skips the paid sub-purchases and goes straight to the LLM. This keeps the round-trip under Claude Desktop's 60-second MCP tool cap.

## Discovery pipeline

Three tiers, deduplicated by URL (registry first), cached for 2 minutes per capability key.

```mermaid
flowchart LR
    D["discoverServices(capability, minScore, limit)"] --> CACHE{"cache hit?"}
    CACHE -->|yes| RET["return cached"]
    CACHE -->|no| T1["Tier 1: Bazaar CDP<br/>HTTPFacilitatorClient"]
    CACHE -->|no| T2["Tier 2: Trust Registry<br/>list_services Soroban simulate"]
    CACHE -->|no| T3["Tier 3: xlm402.com<br/>/api/catalog HTTPS"]
    T1 --> M["mergeAndSort<br/>dedupe by URL<br/>filter minScore<br/>sort score desc"]
    T2 --> M
    T3 --> M
    M --> SAVE["cache 2 min"]
    SAVE --> RET
```

| Tier | Source | Latency | Default trust score | Failure handling |
|------|--------|---------|---------------------|------------------|
| 1 | x402 Bazaar CDP via OZ facilitator | ~500ms HTTP | 70 | Try/catch, return [] |
| 2 | Soroban Trust Registry simulate | 2-3s | On-chain (default 70) | Try/catch, return [] |
| 3 | xlm402.com `/api/catalog` | 1-2s | 70 | Try/catch, return [] |

If any tier fails, the others still produce results. `invalidateService(url)` clears a single failing URL from every cached capability list, so the next discover call will not return it again until the cache repopulates from the live tiers.

## Trust registry storage layout

The trust-registry uses three Soroban storage tiers. Auto-expiry replaces the manual stale-checking pattern from earlier versions.

```mermaid
flowchart TD
    I["Instance storage<br/>Admin (Address)<br/>UsdcAddr (Address)<br/>NextId (u32)<br/>Fixed size, never grows"]
    T["Temporary storage<br/>Service(id) -> ServiceInfo<br/>Initial TTL 60 ledgers (~5 min)<br/>Heartbeat extends to 180 (~15 min)<br/>Auto-deletes on TTL 0"]
    P["Persistent storage<br/>CapIndex(capability) -> Vec<u32><br/>Deposit(id) -> DepositRecord<br/>QualityReport(reporter, id) -> u32"]

    I -->|"register increments NextId"| T
    T -->|"heartbeat extends TTL"| T
    T -->|"on TTL 0, auto-removed"| P
    P -->|"heartbeat cleans dead IDs from CapIndex"| P
```

| Storage | Key | Value | TTL |
|---------|-----|-------|-----|
| instance | `Admin` | `Address` | extended on init to 100,000 |
| instance | `UsdcAddr` | `Address` | extended on init to 100,000 |
| instance | `NextId` | `u32` | 100,000 |
| temporary | `Service(id)` | `ServiceInfo` | 60 (register) or 180 (heartbeat) ledgers |
| persistent | `CapIndex(capability)` | `Vec<u32>` | extended to 100,000 on every write |
| persistent | `Deposit(id)` | `DepositRecord{owner, amount}` | extended to 100,000 |
| temporary | `QualityReport(reporter, id)` | `u32` (day_key) | 17,280 ledgers (~24 h) |

**Why temporary storage for services.** When a service crashes without calling `deregister_service`, its TTL counts down. At 0 the entry vanishes. The next live heartbeat in the same capability scans `CapIndex` and writes back only the live IDs, removing the dead entry from the index. No background cleanup process is needed. The deposit record sits in persistent storage until either `deregister_service` (graceful) or `reclaim_deposit` (after expiry) refunds it.

**Registration re-entry.** `data-sources/src/shared.ts:resolveServiceId` calls `simulateListServices` before `register_service`. If the URL is already in the live set with the same owner, it reuses the existing service ID and resumes heartbeat instead of paying another deposit and panicking on the duplicate-URL check.

## Wallet policy state machine

```mermaid
stateDiagram-v2
    [*] --> Initialized: initialize(owner, daily, per_tx, rate)

    state "check_policy (read)" as PC {
        [*] --> CheckPerTx
        CheckPerTx --> CheckTimeWindow: amount <= per_tx_lim
        CheckPerTx --> Denied_OverPerTx: amount > per_tx_lim
        CheckTimeWindow --> CheckDaily: now within window
        CheckTimeWindow --> Denied_OutsideWindow: before/after window
        CheckDaily --> CheckRate: total + amount <= daily_lim
        CheckDaily --> Denied_OverDaily: would exceed daily
        CheckRate --> CheckAllowlist: minute_count < rate_limit
        CheckRate --> Denied_RateLimited: minute_count >= rate_limit
        CheckAllowlist --> Allowed: empty allowlist OR contains recipient
        CheckAllowlist --> Denied_BadRecv: not in allowlist
    }

    Initialized --> PC
    Allowed --> RecordSpend: record_spend(nonce, amount, recipient, txHash)
    Denied_OverPerTx --> RecordDenied
    Denied_OutsideWindow --> RecordDenied
    Denied_OverDaily --> RecordDenied
    Denied_RateLimited --> RecordDenied
    Denied_BadRecv --> RecordDenied
    RecordSpend --> Initialized
    RecordDenied --> Initialized
```

`check_policy` returns one of seven `reason` symbols: `ok`, `over_per_tx`, `before_window`, `after_window`, `over_daily`, `rate_limited`, `bad_recv`. The TypeScript client surfaces these as `PolicyDeniedError.reason`. The MCP server reports them as a soft failure (no `isError` flag) so Claude can relay the reason without treating the tool as broken.

## Wallet policy contract

`contracts/wallet-policy/src/lib.rs` (353 lines, 8 public functions, all amounts in i128 stroops).

| Function | Type | Purpose | Auth |
|----------|------|---------|------|
| `initialize(owner, daily_limit, per_tx_limit, rate_limit)` | write | One-time setup, sets owner and policy | none (panics if reinitialized) |
| `check_policy(amount, recipient) -> PolicyRes` | read | Run all 5 checks, return `{allowed, reason, remaining}` | none |
| `record_spend(nonce, amount, recipient, tx_hash)` | write | Update day spend, emit event, panic on duplicate nonce | owner |
| `record_denied(amount, reason)` | write | Increment denied counter, emit event | owner |
| `update_policy(daily, per_tx, rate, time_start, time_end)` | write | Replace policy struct | owner |
| `set_allowlist(addresses)` | write | Replace allowlist (empty = allow all) | owner |
| `get_today_spending() -> SpendRec` | read | Today's `{total, count, last_min, min_count}` | none |
| `get_lifetime_stats() -> (i128, u64, u64)` | read | `(total_spent, tx_count, denied_count)` | none |

**Storage keys** (`DataKey` enum):

- `instance`: `Policy`, `Owner`, `Allowlist`, `DeniedCnt`
- `persistent`: `Spend(day_key)`, `Nonce(symbol)`, `TotalSpent`, `TxCount`

The `day_key` is `env.ledger().timestamp() / 86400`, so a new UTC day starts a fresh `SpendRec`. The `min_count` field tracks the rate-limit window: a request is rejected if `current_min == record.last_min && record.min_count >= policy.rate_limit`.

## Trust registry contract

`contracts/trust-registry/src/lib.rs` (426 lines, 8 public functions).

| Function | Type | Purpose | Auth |
|----------|------|---------|------|
| `initialize(admin, usdc_addr)` | write | Set admin + USDC SAC + NextId=0 | admin |
| `register_service(owner, url, name, capability, price, protocol) -> u32` | write | Collect $0.01 deposit, store in temporary, append to CapIndex | owner |
| `heartbeat(service_id)` | write | Extend TTL to 180 ledgers, clean dead CapIndex entries | service owner |
| `deregister_service(service_id)` | write | Remove from temp + CapIndex, refund deposit | service owner |
| `list_services(capability, min_score, limit) -> Vec<ServiceInfo>` | read | Scan CapIndex by capability, filter, limit | none |
| `get_service(service_id) -> ServiceInfo` | read | Direct lookup from temporary | none |
| `report_quality(reporter, service_id, success)` | write | Max 1 per reporter per service per day, recompute score | reporter |
| `reclaim_deposit(service_id, owner)` | write | Refund deposit after TTL expiry, only original owner | owner |

`DEPOSIT_AMOUNT` is hardcoded to `100_000` stroops ($0.01 USDC). Trust score defaults to 70; after the first quality report it becomes `(successful * 100) / total`.

## CLI dashboard

`scripts/cli-dashboard.ts` (472 lines, zero new dependencies). Replaces `concurrently` as the process manager for `npm run dev`. Pure ANSI escape codes for rendering.

**Process management**

- Spawns 6 children: `engine` (ws-server), `crypto`, `news`, `market`, `analyst`, `vite` (contract-explorer dev server)
- Every child uses `detached: true` so it becomes a process group leader
- On shutdown, `process.kill(-pid, "SIGTERM")` kills the entire group (catches grandchildren)
- `killPorts()` on startup runs `fuser -k` against ports 8080, 4001-4004, 5180-5182 to free anything left over from a crashed previous session
- Does **not** spawn the MCP server (Claude Desktop launches it via stdio on demand)

**Terminal rendering**

- Uses the alternative screen buffer (`\x1b[?1049h` / `\x1b[?1049l`)
- `process.stdout.write` with `\x1b[H` (cursor home) and `\x1b[2K` (clear line) per row, no flicker
- Hidden cursor during rendering, restored on exit including the `uncaughtException` handler

**Live data**

- WebSocket client to `ws://localhost:8080`, reconnects every 3 seconds on failure
- Listens for `budget:updated` and `spend:ok` events broadcast by the ws-server
- Heartbeat lines from each child's stdout update `lastHB` (silent, only counter shown)

**Logging**

- Each child's stdout/stderr writes to `logs/YYYY-MM-DD_HH-mm-ss.log`
- ANSI codes stripped from `parseOutput` (so URL detection still works), but the raw line is preserved in the log

## Web dashboard (contract-explorer)

`contract-explorer/` (48 TS/TSX files, 7001 lines, separate `package.json` outside the npm workspace). Standalone React Flow network graph that visualizes wallets, services, and contracts in real time.

```mermaid
flowchart TD
    subgraph "Data sources"
        SR["Soroban RPC<br/>15s poll"]
        HZ["Horizon REST<br/>20s poll"]
        WSS["ws-server :8080<br/>real-time"]
    end

    subgraph "Zustand stores (10)"
        SS["soroban-store (363)<br/>policy + registry state"]
        HWS["horizon-wallet-data-store (470)<br/>balances + history"]
        HPS["horizon-payment-store (333)<br/>USDC payments"]
        WBS["ws-budget-store (147)<br/>WebSocket client"]
        DS["dashboard-store (157)<br/>feed + pulses"]
        LES["live-edge-store (139)<br/>bullet animations"]
        NPS["node-positions-store (117)"]
        BS["browser-stores (132)<br/>localStorage"]
        ES["external-store (62)"]
        PO["payment-orchestrator (1027)<br/>cross-store reactions"]
    end

    subgraph "React layer"
        APP["app.tsx (66)"]
        NG["network-graph.tsx (277)"]
        AF["activity-feed.tsx (93)"]
        HD["header.tsx (228)"]
        Nodes["WalletNode / ServiceNode<br/>PolicyNode / RegistryNode"]
        Edges["BulletEdge (154)<br/>OwnershipEdge (61)"]
    end

    SR --> SS
    HZ --> HWS
    HZ --> HPS
    WSS --> WBS
    SS --> PO
    HWS --> PO
    HPS --> PO
    WBS --> PO
    PO -->|feed rows, pulses| DS
    PO -->|bullet animations| LES
    DS --> AF
    LES --> Edges
    SS --> NG
    HWS --> NG
    NG --> Nodes
    NG --> Edges
    APP --> NG
    APP --> AF
    APP --> HD
```

**Data flow.** Every external data source enters through a Zustand store. The PaymentOrchestrator (1027 lines) initializes once at module load (`src/app.tsx`) and subscribes to all data stores. When a Horizon payment lands or a Soroban spend event arrives, the orchestrator fires a glow pulse on the relevant wallet node, queues a bullet animation on the matching edge, and appends a row to the activity feed. No React component subscribes to external data directly. `useSyncExternalStore`-backed hooks bridge stores to the render tree.

**Configuration overrides via URL params:**

| Param | Default | Purpose |
|-------|---------|---------|
| `policy` | `CDZSYMEBO7EB3SA2DE3APMRH3MUCZIVE2RWFGSYMPHVQRJYCYT4EO6RG` | wallet-policy contract ID |
| `registry` | `CBL2TCD7GLHLPLH4GXQO5L6DR3XACQ7WS3S3FHI2L2F7JO2WZCZTEDSP` | trust-registry contract ID |
| `rpc` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |

The wallet list is persisted to `localStorage` under `x402-autopilot.wallets.v1`. Add wallets via the header input field; the address bar URL is the only other source of truth.

`SEED_CAPABILITIES` in `contract-explorer/src/lib/constants.ts:38` is the list of capabilities the dashboard polls on every refresh: `crypto_prices`, `news`, `briefing`, `blockchain`, `market_intelligence`, `analysis`. New capabilities discovered via `register` events in the last 17,280 ledgers (~24 h) are merged in automatically without code changes.

See [contract-explorer/README.md](contract-explorer/README.md) for the full directory layout.

## File breakdown

```
contracts/
  wallet-policy/src/lib.rs          353 lines, 8 pub fn
  trust-registry/src/lib.rs         426 lines, 8 pub fn

src/                                1967 lines total
  autopay.ts                        333  payment orchestrator
  policy-client.ts                  316  Soroban writer for wallet-policy
  discovery.ts                      231  3-tier discovery pipeline
  protocol-detector.ts              201  HEAD probe + 402 header parsing
  ws-server.ts                      197  WebSocket server, 5s Soroban poll, MCP relay
  types.ts                          136  6 error classes + interfaces
  config.ts                         132  env validation, x402 + mppx clients
  registry-client.ts                120  Soroban reader for trust-registry
  security.ts                       107  SSRF prevention + parsePriceStroops
  budget-tracker.ts                  88  BigInt local cache
  event-bus.ts                       65  WebSocket broadcast + bigint serializer
  mutex.ts                           41  sequential payment lock

data-sources/src/                   2413 lines total
  stellar-data-api.ts               620  MPP stellar-stats + x402 market-report + monitor
  analyst-api.ts                    544  x402 analyze, agent-to-agent + LLM
  shared.ts                         532  x402 server, registration, heartbeat
  news-api.ts                       502  x402 news + briefing + LLM
  weather-api.ts                    215  x402 prices, CoinGecko upstream

mcp-server/src/
  index.ts                          621  6 tools, stdio transport, ws relay

contract-explorer/src/              7001 lines total, 48 files
  stores/  (10 files)              2947  Zustand stores
    payment-orchestrator.ts        1027   cross-store wiring
    horizon-wallet-data-store.ts    470
    soroban-store.ts                363
    horizon-payment-store.ts        333
    dashboard-store.ts              157
    ws-budget-store.ts              147
    live-edge-store.ts              139
    browser-stores.ts               132
    node-positions-store.ts         117
    external-store.ts                62
  hooks/   (9 files)                860
    use-graph-layout.ts             592
    use-wallet-data-map.ts           86
    use-connection-status.ts         61
    use-browser-state.ts             50
    use-node-positions.ts            17
    use-horizon-payments.ts          17
    use-horizon-wallet-data.ts       14
    use-soroban.ts                   12
    use-live-edges.ts                11
  components/ (12 + 9 ui files)    2090
    network-graph.tsx               277
    header.tsx                      228
    feed-event.tsx                  158
    activity-feed.tsx                93
    dashboard-layout.tsx             88
    nodes/wallet-node.tsx           209
    nodes/service-node.tsx          175
    nodes/registry-node.tsx         115
    nodes/policy-node.tsx            79
    nodes/node-types.ts              18
    edges/bullet-edge.tsx           154
    edges/ownership-edge.tsx         61
    ui/ (9 shadcn components)       435
  lib/ (5 files)                   1024
    soroban-rpc.ts                  481
    types.ts                        261
    utils.ts                        106
    constants.ts                     99
    horizon.ts                       77
  app.tsx + main.tsx + vite-env.d    80

scripts/                            1584 TS lines + 2 bash files
  setup-service-wallets.ts          534  generate, fund, trustline, USDC, allowlist
  cli-dashboard.ts                  472  ANSI terminal dashboard
  ensure-service-wallets.ts         149  predev fast-path
  seed-registry.ts                  121  manual capability registration
  run-demo.ts                       118  full demo flow
  setup-testnet.ts                  104  fund main wallet, add USDC trustline
  health-report.ts                   86  CLI health probe
  deploy-wallet-policy.sh                 build + deploy + initialize
  deploy-trust-registry.sh                build + deploy + initialize
```

## Security model

| Threat | Mitigation | Location |
|--------|-----------|----------|
| SSRF via URL | Block file://, private IPs (10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 0.0.0.0), localhost unless `ALLOW_HTTP=true` | `src/security.ts:38` |
| Overspend via prompt injection | On-chain `check_policy` enforces per-tx, daily, rate, and allowlist limits | `contracts/wallet-policy/src/lib.rs:99` |
| Concurrent budget race | 30s async mutex, one payment in flight at a time | `src/mutex.ts` |
| Soroban RPC down | Fail-closed: `checkPolicy` returns `{allowed:false, reason:"rpc_unavailable"}` | `src/policy-client.ts:202` |
| Replay attack | Nonce stored on-chain, contract panics on duplicate | `contracts/wallet-policy/src/lib.rs:197` |
| Registry spam | $0.01 USDC deposit collected via SAC transfer | `contracts/trust-registry/src/lib.rs:97` |
| Fake quality reports | Max 1 report per reporter per service per day, key includes day_key | `contracts/trust-registry/src/lib.rs:346` |
| Secret exposure in errors | `maskKey()` for Stellar keys, `Bearer ***` for API keys, regex strip in `mcp-server/src/index.ts:fail` | `src/config.ts:29`, `mcp-server/src/index.ts:138` |
| Response body consumed twice | Single `.text()` then `JSON.parse` separately | `src/autopay.ts:138` |
| HEAD 200 but GET 402 | `classifyFreeAs402` re-detects from response and falls through to payment | `src/autopay.ts:283` |
| Leftover ports on restart | `killPorts()` runs `fuser -k` on ports 4001-4004, 5180-5182, 8080 | `scripts/cli-dashboard.ts:97` |
| Float precision in money | BigInt stroops everywhere, `parsePriceStroops` is the only place `parseFloat` is allowed and is bounded by `Number.MAX_SAFE_INTEGER` | `src/security.ts:89` |

## Dashboard events

Events broadcast over WebSocket from `ws-server.ts`. BigInt fields are serialized to strings (the JSON replacer handles this).

| Event | Source | Payload |
|-------|--------|---------|
| `budget:updated` | ws-server polling (every 5s) and on connect | `spentToday`, `remaining`, `dailyLimit`, `txCount`, `deniedCount`, `lifetimeSpent` |
| `spend:ok` | ws-server polling delta + MCP relay | `url`, `amount`, `protocol`, `txHash`, `recipient`, `timestamp` |

The MCP server connects as a WebSocket client to the ws-server (`ws://localhost:8080`) with exponential backoff (1s up to 10s) and forwards `spend:ok` events from the autopay engine the moment they fire. This bypasses the 5-second polling window so the dashboard can render bullet animations the instant the payment lands instead of waiting for the next Soroban poll cycle.

The core engine's `event-bus.ts` defines a wider event union (`spend:api_error`, `spend:failed`, `denied`, `discovery:updated`, `health:checked`, `registry:stale`) but the wire protocol only emits `budget:updated` and `spend:ok` from the ws-server today.

## Design decisions

**BigInt everywhere for money.** JavaScript Numbers lose integer precision above 2^53. USDC has 7 decimals, so $1.00 = 10,000,000 stroops, well below 2^53, but products and sums quickly overflow without BigInt. `parsePriceStroops` is the only place `parseFloat` is allowed and it has explicit bounds checks. JSON.stringify cannot serialize BigInt natively, so every WebSocket emit uses a replacer function (`(_k, v) => typeof v === "bigint" ? v.toString() : v`).

**Fail-closed on RPC failure.** `checkPolicy` returns `{allowed:false, reason:"rpc_unavailable"}` if the Soroban RPC is unreachable. There is no "log and continue" fallback. If the on-chain enforcement layer cannot be queried, no payment goes out.

**Mutex for sequential payments.** Two concurrent calls into `autopilotFetch` could both pass the policy check before either records its spend, then both spend. The 30-second lease in `src/mutex.ts` serializes them. Tradeoff: payments queue up, latency adds linearly under load. The MCP server itself is single-client (Claude Desktop), so this is rarely an issue in practice.

**Separate fetch wrappers for x402 and MPP.** `@x402/fetch` wraps `globalThis.fetch`. `mppx` also wants to wrap `fetch`. To avoid the polyfill collision, `Mppx.create({ polyfill: false })` returns a scoped `mppFetch` and the protocol detector decides which wrapper to call.

**2-minute discovery cache.** Querying Soroban for every `discover` call would cost 2-3 seconds per request. The cache trades freshness for latency. On payment failure, `invalidateService(url)` removes a single failing URL from every cached capability list so the next discover will not return it.

**Temporary storage for service entries.** The trust-registry stores `ServiceInfo` in Soroban temporary storage with TTL extended by heartbeat. When a service crashes, its entry vanishes on TTL expiry instead of accumulating forever. Living services clean dead IDs out of the persistent `CapIndex` during their next heartbeat. This eliminates the instance-storage DoS that earlier registry versions were vulnerable to.

**Analyst as a real wallet.** The analyst has its own keypair, its own x402 client (`createEd25519Signer(ANALYST_SECRET, ...)`), and signs its sub-purchases with its own key. The dashboard shows ownership edges from each agent's wallet to its service node so the topology is visible at a glance. A bug where every service registered under the main wallet would collapse all ownership edges onto a single node and make the network look broken.

**`claude -p` headless before Anthropic API.** The three agent endpoints (analyst, news_intelligence, market_intelligence) prefer `claude -p` because it uses the local OAuth subscription, no API key needed. They fall back to `ANTHROPIC_API_KEY` if `claude -p` fails. They fall back again to a raw merged data response if neither LLM path is available, with `llm_mode: "raw_data_fallback"` flagged in the response. The subprocess uses explicit `proc.stdin.write(prompt); proc.stdin.end()` to avoid the stdin-hang bug fixed in Claude Code 2.1.80+.

**CLI dashboard over `concurrently`.** The fixed-layout ANSI display gives a single source of truth for service status, budget, and last transaction. Process groups with negative-PID kill ensure `Ctrl+C` cleans up grandchildren too. Port cleanup on startup handles interrupted previous sessions. The dashboard never spawns the MCP server; that is Claude Desktop's job.

**Registration re-entry on restart.** If a service restarts within its TTL window (5-15 minutes depending on heartbeat history), `shared.ts:resolveServiceId` lists existing registrations and reuses the previous service ID instead of paying another deposit and panicking on the duplicate-URL check. Operationally this means a `npm run dev` restart costs nothing and resumes within seconds.

**Contract-explorer as a separate app.** The web dashboard lives in `contract-explorer/` with its own `package.json`, not part of the npm workspace. It reads Soroban contract state via `simulate` (read-only) and Horizon REST directly. The only backend dependency is the optional ws-server WebSocket for real-time spend events. This means it can point at any deployment's contracts via URL params without needing the core engine running.
