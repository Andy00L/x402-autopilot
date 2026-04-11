/**
 * TypeScript shapes that mirror the Soroban contract structs in
 *   contracts/wallet-policy/src/lib.rs
 *   contracts/trust-registry/src/lib.rs
 *
 * Field names are normalised to JS conventions (camelCase) but every value
 * preserves on-chain precision: i128 → bigint, u32/u64 → number/bigint as
 * appropriate.  No floats anywhere — that's a hard rule from CLAUDE.md.
 */

// ─── wallet-policy ──────────────────────────────────────────────────────────

/** Mirrors `Policy` struct (instance storage key DataKey::Policy). */
export interface PolicyConfig {
  dailyLimit: bigint;        // i128 — daily ceiling, stroops
  perTxLimit: bigint;        // i128 — single-tx ceiling, stroops
  rateLimit: number;         // u32  — max tx per minute (0 = unlimited)
  timeStart: bigint;         // u64  — UNIX seconds (0 = no lower bound)
  timeEnd: bigint;           // u64  — UNIX seconds (0 = no upper bound)
}

/** Mirrors `SpendRec` returned by get_today_spending. */
export interface TodaySpend {
  total: bigint;             // i128 — total stroops spent today
  count: bigint;             // u64  — number of recorded spends today
  lastMin: bigint;           // u64  — last minute bucket used (timestamp/60)
  minCount: number;          // u32  — count in current minute
}

/** Returned by get_lifetime_stats — Soroban returns a (i128, u64, u64) tuple. */
export interface LifetimeStats {
  totalSpent: bigint;        // i128 — sum of all successful spends
  txCount: bigint;           // u64  — count of all successful spends
  deniedCount: bigint;       // u64  — count of denied attempts
}

/** All wallet-policy state combined for the UI. */
export interface PolicyState {
  contractId: string;
  owner: string | null;       // null if instance storage was unreadable
  allowlist: string[] | null; // null if not exposed; [] = open
  config: PolicyConfig | null;
  today: TodaySpend;
  lifetime: LifetimeStats;
}

// ─── trust-registry ─────────────────────────────────────────────────────────

/** Mirrors `ServiceInfo` struct exactly. */
export interface ServiceInfo {
  id: number;                 // u32
  owner: string;              // Address (G…)
  url: string;                // String
  name: string;               // Symbol
  capability: string;         // Symbol
  price: bigint;              // i128 — stroops
  protocol: string;           // Symbol — "x402" | "mpp" | …
  score: number;              // u32 — 0..100
  totalReports: number;       // u32
  successfulReports: number;  // u32
}

/** Capability + the live services indexed under it. */
export interface CapabilityBucket {
  capability: string;
  services: ServiceInfo[];
}

export interface RegistryState {
  contractId: string;
  nextId: number | null;     // null if instance storage unreadable
  buckets: CapabilityBucket[];
  /** Flat, deduped list of all services across every bucket. */
  services: ServiceInfo[];
  totalServices: number;
}

// ─── events ─────────────────────────────────────────────────────────────────

export type EventKind =
  | "spend_ok"
  | "spend_denied"
  | "register"
  | "deregister"
  | "reclaim"
  | "unknown";

export interface ContractEvent {
  /** Stable across polls — `${ledger}-${pagingToken}`. */
  id: string;
  kind: EventKind;
  contract: "wallet-policy" | "trust-registry";
  contractId: string;
  ledger: number;
  /** ISO timestamp from `ledgerClosedAt`, or empty string if missing. */
  timestamp: string;
  /** Decoded payload — shape depends on `kind`. */
  data: Record<string, unknown>;
  /** Raw symbol topic strings, useful for debugging. */
  topics: string[];
  /** Real Stellar transaction hash from the Soroban RPC event metadata.
   *  64-character lowercase hex. NOT the contract-emitted `data.txHash`
   *  which may contain a `local_` fallback. */
  txHash?: string;
}

// ─── ledger info ────────────────────────────────────────────────────────────

export interface LedgerInfo {
  sequence: number;
  closedAt: string;
}

// ─── Horizon payment stream ─────────────────────────────────────────────────

/** Subset of the Horizon `/payments` object we actually use. */
export interface HorizonPayment {
  id: string;
  pagingToken: string;
  type: "payment" | "path_payment_strict_receive" | "path_payment_strict_send" | string;
  from: string;
  to: string;
  /** String decimal — Horizon returns "0.0050000", never parse as float for money. */
  amount: string;
  assetType: "native" | "credit_alphanum4" | "credit_alphanum12" | string;
  assetCode?: string;
  assetIssuer?: string;
  createdAt: string;
  transactionHash: string;
}

// ─── Wallet data (Horizon REST) ─────────────────────────────────────────────

export interface WalletCounterparties {
  /** Unique counterparty addresses this wallet has sent USDC to. Collected
   *  from Horizon `/payments` history; capped implicitly by the history
   *  fetcher's page limit. */
  sentTo: readonly string[];
  /** Unique counterparty addresses that have sent USDC to this wallet. */
  receivedFrom: readonly string[];
}

export interface WalletData {
  address: string;
  label: string;
  /** Null while loading or if the account does not exist on the network. */
  usdcBalance: bigint | null;
  /** "not_found" ⇒ account doesn't exist.  "offline" ⇒ Horizon unreachable. */
  status: "loading" | "ok" | "not_found" | "offline";
  /** Lifetime totals computed from /payments history (paged, capped). */
  totals: {
    revenueStroops: bigint;
    expensesStroops: bigint;
    txCount: number;
  };
  /** Unique counterparties (sent-to + received-from). Used by the graph
   *  builder to wire historical wallet → service edges when any address
   *  matches a known service owner. */
  counterparties: WalletCounterparties;
}

// ─── Graph layout (React Flow) ──────────────────────────────────────────────

export type NodeKind = "wallet" | "service" | "policy" | "registry";

/**
 * Node data shapes. React Flow's `Node<TData, TType>` constrains `TData` to
 * `Record<string, unknown>`. Interfaces don't inherit index signatures from
 * an extends clause, so each data shape is a type alias intersected with
 * `Record<string, unknown>` — a well-known workaround that keeps the named
 * field types while satisfying the generic constraint.
 */
export type WalletNodeData = Record<string, unknown> & {
  address: string;
  label: string;
  /** Initial glyph for the circle icon (M / A / …). */
  initial: string;
  colorClass: "neutral" | "success";
  usdcBalance: bigint | null;
  spentStroops: bigint;
  deniedCount: bigint;
  txCount: bigint;
  revenueStroops: bigint;
  expensesStroops: bigint;
  /** True when this wallet owns at least one registered service. Used to
   *  flip the stat grid between "Spent/Balance/TX/Denied" and
   *  "Revenue/Expenses/Profit/Margin". */
  isSeller: boolean;
  /** Glow flash pulse, incremented on every payment to/from this wallet. */
  pulseKey: number;
  /** "loading" before first fetch, "not_found" on 404, "offline" on
   *  transport failure, "ok" otherwise. */
  status: WalletData["status"];
};

export type ServiceNodeData = Record<string, unknown> & {
  serviceId: number;
  ownerAddress: string;
  name: string;
  url: string;
  protocol: string;
  priceStroops: bigint;
  /** Ledger when the service was last heartbeated. Used for the ♥ countdown. */
  lastHeartbeatLedger: number;
  /** Current latest ledger from Soroban, driven by the events poller. */
  latestLedger: number;
  colorDot: "green" | "blue" | "amber" | "gold" | "red";
  /** Incremented on every payment to this service's owner wallet. */
  pulseKey: number;
};

export type PolicyNodeData = Record<string, unknown> & {
  ownerAddress: string;
  config: PolicyConfig | null;
  today: TodaySpend;
  lifetime: LifetimeStats;
  offline: boolean;
};

export type RegistryNodeData = Record<string, unknown> & {
  contractId: string;
  nextId: number | null;
  services: ServiceInfo[];
  /** Latest Soroban ledger. Used to compute TTL bars per service. */
  latestLedger: number;
  offline: boolean;
};

// ─── Activity feed ──────────────────────────────────────────────────────────

export type FeedEventKind =
  | "spend"        // wallet → wallet USDC transfer seen on Horizon
  | "sub-buy"      // analyst wallet paying its own sub-service (gold-coloured)
  | "heartbeat"
  | "register"
  | "deregister"
  | "denied"
  | "reclaim";

export interface FeedEvent {
  /** Stable id so React reconciles rows without re-mount flashing. */
  id: string;
  kind: FeedEventKind;
  /** Wallclock time when we observed the event locally. */
  observedAt: number;
  /** Free-form label ("Main → News", "weather") — the row's main title. */
  title: string;
  /** Optional monospace subtitle (tx hash, sub-label). */
  subtitle?: string;
  /** Amount in stroops, rendered as USDC if present. */
  amountStroops?: bigint;
  /** Badge text shown on the right of the row (e.g. "spend", "hb"). */
  badge: string;
  /** Hint about the accent colour to use.  Dashboard-store agnostic. */
  accent: "success" | "gold" | "warning" | "info" | "danger";
  /** Whether the row should render the animated bar fill below its content. */
  animatedBar: boolean;
  /** Transaction hash for linking to stellar.expert. Available for
   *  spend and sub-buy events from both Horizon and Soroban paths. */
  txHash?: string;
}
