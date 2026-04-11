/**
 * Default config — every value can be overridden via URL search params:
 *   ?policy=C...&registry=C...&rpc=https://...
 *
 * Contract IDs taken from /home/drew/stelos/.env (the live testnet
 * deployment).  Anyone may point this dashboard at their own contracts.
 */
export const DEFAULTS = {
  SOROBAN_RPC: "https://soroban-testnet.stellar.org",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",

  WALLET_POLICY_ID: "CDZSYMEBO7EB3SA2DE3APMRH3MUCZIVE2RWFGSYMPHVQRJYCYT4EO6RG",
  TRUST_REGISTRY_ID: "CAIXHQCJQPJ6AVC4YRRV7RCFCLXIE2SZWLQ4XJUTFKZZQRGGOCTDCSBQ",

  /**
   * Seed capabilities polled on every Soroban refresh.  This is NOT a
   * closed list — `useSorobanState` merges these with any capabilities
   * discovered from `register` events seen in the last
   * `EVENT_LOOKBACK_LEDGERS` window, so brand-new capability symbols
   * (e.g. "translation", "weather-pro") appear automatically without
   * code changes.
   *
   * The reason a seed list still matters: services that were registered
   * MORE than `EVENT_LOOKBACK_LEDGERS` ago and have only been
   * heartbeating since leave no `register` event inside the lookback
   * window, so the dynamic discovery never picks them up.  Anything
   * stable enough to be relied on by the demo therefore goes here.
   *
   * Mirrors the agent network in `data-sources/`:
   *   crypto_prices       (weather-api.ts → Crypto Price Oracle)
   *   news                (news-api.ts → raw headlines)
   *   briefing            (news-api.ts → News Intelligence Agent)
   *   blockchain          (stellar-data-api.ts → raw stellar data)
   *   market_intelligence (stellar-data-api.ts → Market Intelligence Agent)
   *   analysis            (analyst-api.ts)
   */
  SEED_CAPABILITIES: [
    "crypto_prices",
    "news",
    "briefing",
    "blockchain",
    "market_intelligence",
    "analysis",
  ] as readonly string[],

  /** Soroban RPC polling interval (read-only simulates). */
  POLL_INTERVAL_MS: 15_000,

  /** Horizon wallet balance / history polling interval (REST, not stream). */
  WALLET_POLL_INTERVAL_MS: 20_000,

  /** Max ledgers to look back when fetching events.  ~6s/ledger × 17280 ≈ 24h */
  EVENT_LOOKBACK_LEDGERS: 17_280,

  /** TTL ledgers from the trust-registry contract.  Heartbeat extends to 180. */
  REGISTER_TTL_LEDGERS: 60,
  HEARTBEAT_TTL_LEDGERS: 180,

  /** Anti-spam deposit amount in stroops ($0.01 USDC). */
  REGISTRY_DEPOSIT_STROOPS: 100_000n,

  /** Feed cap — keeps the DOM small even under heavy load. */
  FEED_MAX_EVENTS: 200,
} as const;

/**
 * 1 USDC = 10_000_000 stroops on Stellar (7 decimals).
 * Required to keep money math in BigInt — never parseFloat for ledger values.
 */
export const STROOPS_PER_USDC = 10_000_000n;

/** Default wallets shown on first load.  Users can add more via the header input. */
export const DEFAULT_WALLETS: ReadonlyArray<{ address: string; label: string }> = [
  {
    address: "GCAIC4R2R7FNPSQSQHCM7CTOOQBVKARF27XGN54HKMVSMBUBGOS7SX6B",
    label: "Main wallet",
  },
  {
    address: "GCMS7T2EDDQDT4K6O675GG56VKHZBPZCG3JFYR6IDGOLE45BDAAOTTCU",
    label: "Analyst agent",
  },
];

export const USDC_ASSET = {
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
} as const;

/** localStorage key used to persist the wallet list across page refreshes. */
export const WALLETS_STORAGE_KEY = "x402-autopilot.wallets.v1";

/** Relative time thresholds used by formatTimeAgo in utils.ts — kept here for reuse. */
export const TIME = {
  NOW_MS: 3_000,
  MINUTE_S: 60,
  HOUR_S: 3_600,
  DAY_S: 86_400,
} as const;
