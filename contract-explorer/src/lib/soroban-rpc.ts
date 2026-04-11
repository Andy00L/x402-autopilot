/**
 * Read-only Soroban RPC client.  Mirrors the simulate-only pattern from
 *   /home/drew/stelos/src/policy-client.ts
 *
 * Everything here is `simulateTransaction` (no signing, no submission), plus
 * `getLedgerEntries` (raw storage reads) and `getEvents` (event history).
 * No private keys are ever loaded.
 *
 * Why we read instance storage directly:
 *   The wallet-policy contract does NOT expose a `get_policy` view function,
 *   but the dashboard needs `per_tx_lim`, `rate_limit`, `time_start/end`,
 *   `owner`, and the allowlist.  These all live in instance storage under
 *   typed `DataKey` enum keys, so we fetch the contract instance entry and
 *   walk its `storage` map.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  ContractEvent,
  EventKind,
  LedgerInfo,
  LifetimeStats,
  PolicyConfig,
  PolicyState,
  ServiceInfo,
  TodaySpend,
} from "./types";

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Build a fresh server per call so users can swap RPC URLs without rebuilds.
 * RPC clients are cheap (no persistent connections under the hood).
 */
function makeServer(rpcUrl: string): rpc.Server {
  return new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
}

/**
 * A well-formed Stellar public key used as the source for read-only sims.
 * Soroban RPC's `simulateTransaction` only validates the source's format —
 * not its on-chain existence — when no transaction is submitted.  Using a
 * locally-constructed Account with a real-looking key avoids the
 * `getAccount` round-trip on every poll.  No private key is ever loaded.
 */
const SIMULATION_SOURCE =
  "GCAIC4R2R7FNPSQSQHCM7CTOOQBVKARF27XGN54HKMVSMBUBGOS7SX6B";

function phantomSource(): Account {
  return new Account(SIMULATION_SOURCE, "0");
}

/**
 * Run a contract function in simulate-only mode and return the decoded result.
 * Throws on simulation error — callers may catch and degrade gracefully.
 */
async function simulateRead<T = unknown>(
  rpcUrl: string,
  passphrase: string,
  contractId: string,
  functionName: string,
  args: xdr.ScVal[],
): Promise<T> {
  const server = makeServer(rpcUrl);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(phantomSource(), {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(contract.call(functionName, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate(${functionName}): ${sim.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`simulate(${functionName}): unexpected status`);
  }
  const retval = sim.result?.retval;
  if (!retval) throw new Error(`simulate(${functionName}): no retval`);
  return scValToNative(retval) as T;
}

// ─── instance storage walker ────────────────────────────────────────────────

/**
 * Fetch the contract instance ledger entry and return its instance storage
 * as a list of {key, val} ScVal pairs.  This is where
 * `env.storage().instance().set(...)` lives in Soroban — including the
 * wallet-policy `Policy` struct, owner, allowlist, and the trust-registry
 * `NextId` counter.
 */
async function readInstanceStorage(
  rpcUrl: string,
  contractId: string,
): Promise<Array<{ key: xdr.ScVal; val: xdr.ScVal }>> {
  const server = makeServer(rpcUrl);
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const result = await server.getLedgerEntries(ledgerKey);
  if (result.entries.length === 0) {
    throw new Error("contract instance entry not found");
  }
  const data = result.entries[0]!.val.contractData();
  const value = data.val();
  if (value.switch().name !== "scvContractInstance") {
    throw new Error("expected contract instance value");
  }
  const instance = value.instance();
  const storage = instance.storage();
  if (!storage) return [];
  return storage.map((entry) => ({ key: entry.key(), val: entry.val() }));
}

/**
 * Match a Vec(Symbol) DataKey variant.  In Soroban, an enum variant with no
 * payload (e.g. `DataKey::Policy`) serialises as `ScVec([ScSymbol("Policy")])`.
 */
function matchSymbolKey(key: xdr.ScVal, symbolName: string): boolean {
  if (key.switch().name !== "scvVec") return false;
  const vec = key.vec();
  if (!vec || vec.length !== 1) return false;
  const head = vec[0]!;
  if (head.switch().name !== "scvSymbol") return false;
  return head.sym().toString() === symbolName;
}

// ─── public API ─────────────────────────────────────────────────────────────

export async function getLatestLedger(rpcUrl: string): Promise<LedgerInfo> {
  const server = makeServer(rpcUrl);
  const info = await server.getLatestLedger();
  return {
    sequence: info.sequence,
    closedAt: new Date().toISOString(),
  };
}

export async function fetchPolicyState(
  rpcUrl: string,
  passphrase: string,
  contractId: string,
): Promise<PolicyState> {
  // ─ Public read functions (cheap, always available) ───────────────────────
  const todayP = simulateRead<Record<string, unknown>>(
    rpcUrl,
    passphrase,
    contractId,
    "get_today_spending",
    [],
  );
  const lifetimeP = simulateRead<[bigint, bigint, bigint]>(
    rpcUrl,
    passphrase,
    contractId,
    "get_lifetime_stats",
    [],
  );

  // ─ Instance storage walk for full policy + owner + allowlist ─────────────
  const instanceP = readInstanceStorage(rpcUrl, contractId).catch(
    () => null as Awaited<ReturnType<typeof readInstanceStorage>> | null,
  );

  const [todayRaw, lifetimeRaw, instance] = await Promise.all([
    todayP,
    lifetimeP,
    instanceP,
  ]);

  const today: TodaySpend = {
    total: bigintOrZero(todayRaw.total),
    count: bigintOrZero(todayRaw.count),
    lastMin: bigintOrZero(todayRaw.last_min),
    minCount: Number(todayRaw.min_count ?? 0),
  };

  const lifetime: LifetimeStats = {
    totalSpent: bigintOrZero(lifetimeRaw[0]),
    txCount: bigintOrZero(lifetimeRaw[1]),
    deniedCount: bigintOrZero(lifetimeRaw[2]),
  };

  let config: PolicyConfig | null = null;
  let owner: string | null = null;
  let allowlist: string[] | null = null;

  if (instance) {
    for (const { key, val } of instance) {
      if (matchSymbolKey(key, "Policy")) {
        const obj = scValToNative(val) as Record<string, unknown>;
        config = {
          dailyLimit: bigintOrZero(obj.daily_lim),
          perTxLimit: bigintOrZero(obj.per_tx_lim),
          rateLimit: Number(obj.rate_limit ?? 0),
          timeStart: bigintOrZero(obj.time_start),
          timeEnd: bigintOrZero(obj.time_end),
        };
      } else if (matchSymbolKey(key, "Owner")) {
        owner = String(scValToNative(val));
      } else if (matchSymbolKey(key, "Allowlist")) {
        const decoded = scValToNative(val);
        if (Array.isArray(decoded)) allowlist = decoded.map(String);
      }
    }
  }

  return {
    contractId,
    owner,
    allowlist,
    config,
    today,
    lifetime,
  };
}

export async function listServices(
  rpcUrl: string,
  passphrase: string,
  contractId: string,
  capability: string,
  limit = 50,
): Promise<ServiceInfo[]> {
  try {
    const result = await simulateRead<Array<Record<string, unknown>>>(
      rpcUrl,
      passphrase,
      contractId,
      "list_services",
      [
        nativeToScVal(capability, { type: "symbol" }),
        nativeToScVal(0, { type: "u32" }),
        nativeToScVal(limit, { type: "u32" }),
      ],
    );
    if (!Array.isArray(result)) return [];
    return result.map(toServiceInfo);
  } catch {
    return [];
  }
}

function toServiceInfo(raw: Record<string, unknown>): ServiceInfo {
  return {
    id: Number(raw.id ?? 0),
    owner: String(raw.owner ?? ""),
    url: String(raw.url ?? ""),
    name: String(raw.name ?? ""),
    capability: String(raw.capability ?? ""),
    price: bigintOrZero(raw.price),
    protocol: String(raw.protocol ?? ""),
    score: Number(raw.score ?? 70),
    totalReports: Number(raw.total_reports ?? 0),
    successfulReports: Number(raw.successful_reports ?? 0),
  };
}

/**
 * Read the trust-registry's NextId counter from instance storage.
 * Returns null if instance storage is unreadable.
 */
export async function fetchRegistryNextId(
  rpcUrl: string,
  contractId: string,
): Promise<number | null> {
  try {
    const entries = await readInstanceStorage(rpcUrl, contractId);
    for (const { key, val } of entries) {
      if (matchSymbolKey(key, "NextId")) {
        return Number(scValToNative(val));
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── events ─────────────────────────────────────────────────────────────────

interface RawSorobanEvent {
  id?: string;
  pagingToken?: string;
  ledger?: number | string;
  ledgerClosedAt?: string;
  contractId?: { toString(): string } | string;
  topic?: xdr.ScVal[];
  value?: xdr.ScVal | unknown;
  /** Real Stellar transaction hash from the RPC response metadata.
   *  64-character lowercase hex. Available on all events returned by
   *  `getEvents` (see `BaseEventResponse.txHash` in the Stellar SDK). */
  txHash?: string;
}

/**
 * Fetch events emitted by either contract since `startLedger` (inclusive).
 * Decodes the topic vector to identify the event kind.
 *
 * Topic conventions (verified against the Rust source):
 *
 *   wallet-policy:
 *     [Symbol("spend"), Symbol("ok")]      data = (amount, recipient, tx_hash)
 *     [Symbol("spend"), Symbol("denied")]  data = (amount, reason)
 *
 *   trust-registry:
 *     [Symbol("register"), Symbol(cap)]    data = id
 *     [Symbol("deregister"), Symbol(cap)]  data = service_id
 *     [Symbol("reclaim")]                  data = (service_id, owner, amount)
 */
export async function fetchEvents(
  rpcUrl: string,
  startLedger: number,
  policyContractId: string,
  registryContractId: string,
): Promise<{ events: ContractEvent[]; latestLedger: number }> {
  const server = makeServer(rpcUrl);

  const filters = [
    {
      type: "contract" as const,
      contractIds: [policyContractId, registryContractId],
    },
  ];

  let response;
  try {
    response = await server.getEvents({ startLedger, filters, limit: 100 });
  } catch {
    // Soroban RPC sometimes rejects ranges that are too large.
    // Fall back to a tight recent window.
    const latest = await server.getLatestLedger();
    const recent = Math.max(latest.sequence - 1000, 0);
    response = await server.getEvents({
      startLedger: recent,
      filters,
      limit: 100,
    });
  }

  const events: ContractEvent[] = response.events.map((raw: RawSorobanEvent) => {
    const topics = (raw.topic ?? []).map((t) => {
      try {
        const decoded = scValToNative(t);
        return typeof decoded === "string" ? decoded : String(decoded);
      } catch {
        return "?";
      }
    });

    let value: unknown = null;
    try {
      const v = raw.value;
      if (v && typeof v === "object" && "switch" in v) {
        value = scValToNative(v as xdr.ScVal);
      } else {
        value = v;
      }
    } catch {
      value = null;
    }

    const contractIdStr =
      typeof raw.contractId === "string"
        ? raw.contractId
        : raw.contractId?.toString() ?? "";

    const contract: "wallet-policy" | "trust-registry" =
      contractIdStr === registryContractId
        ? "trust-registry"
        : "wallet-policy";

    const kind = classifyEventKind(topics);
    const data = decodeEventData(kind, value, topics);
    // Stable id for React reconciliation: the SDK guarantees pagingToken or id
    // on real events, but fall back to a deterministic content key (never
    // Math.random — that re-keys the row on every poll and remounts it).
    const stableTail =
      raw.pagingToken ??
      raw.id ??
      `${kind}-${topics.join(":")}`;
    const id = `${raw.ledger}-${stableTail}`;
    const closedAt = raw.ledgerClosedAt ?? "";

    return {
      id,
      kind,
      contract,
      contractId: contractIdStr,
      ledger: Number(raw.ledger ?? 0),
      timestamp: closedAt,
      data,
      topics,
      txHash: typeof raw.txHash === "string" && /^[a-f0-9]{64}$/i.test(raw.txHash)
        ? raw.txHash
        : undefined,
    };
  });

  return {
    events,
    latestLedger: response.latestLedger,
  };
}

function classifyEventKind(topics: string[]): EventKind {
  const head = topics[0];
  const second = topics[1];
  if (head === "spend") {
    if (second === "ok") return "spend_ok";
    if (second === "denied") return "spend_denied";
  }
  if (head === "register") return "register";
  if (head === "deregister") return "deregister";
  if (head === "reclaim") return "reclaim";
  return "unknown";
}

function decodeEventData(
  kind: EventKind,
  value: unknown,
  topics: string[],
): Record<string, unknown> {
  switch (kind) {
    case "spend_ok": {
      // (amount, recipient, tx_hash)
      const arr = Array.isArray(value) ? value : [];
      return {
        amount: bigintOrZero(arr[0]),
        recipient: String(arr[1] ?? ""),
        txHash: String(arr[2] ?? ""),
      };
    }
    case "spend_denied": {
      // (amount, reason)
      const arr = Array.isArray(value) ? value : [];
      return {
        amount: bigintOrZero(arr[0]),
        reason: String(arr[1] ?? "unknown"),
      };
    }
    case "register":
      return { capability: topics[1] ?? "?", id: Number(value ?? 0) };
    case "deregister":
      return { capability: topics[1] ?? "?", id: Number(value ?? 0) };
    case "reclaim": {
      const arr = Array.isArray(value) ? value : [];
      return {
        id: Number(arr[0] ?? 0),
        owner: String(arr[1] ?? ""),
        amount: bigintOrZero(arr[2]),
      };
    }
    default:
      return { raw: value };
  }
}

function bigintOrZero(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}
