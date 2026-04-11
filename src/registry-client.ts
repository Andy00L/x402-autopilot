import {
  Contract, TransactionBuilder, BASE_FEE,
  rpc, nativeToScVal, scValToNative,
} from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { config, maskKey } from "./config.js";
import { SorobanError, NetworkError } from "./types.js";
import type { ServiceInfo } from "./types.js";

// ---------------------------------------------------------------------------
// RPC server — 10s timeout
// ---------------------------------------------------------------------------

const server = new rpc.Server(config.sorobanRpcUrl, {
  allowHttp: config.allowHttp,
  timeout: 10_000,
});

const contractId = config.trustRegistryContractId;

// ---------------------------------------------------------------------------
// Soroban read helper (simulate only — free, fast)
// ---------------------------------------------------------------------------

async function simulateContract(
  functionName: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  let account;
  try {
    account = await server.getAccount(config.stellarPublicKey);
  } catch (err) {
    throw new NetworkError(
      "soroban_rpc",
      `getAccount failed for ${maskKey(config.stellarPublicKey)}: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(functionName, ...args))
    .setTimeout(30)
    .build();

  let simResult;
  try {
    simResult = await server.simulateTransaction(tx);
  } catch (err) {
    throw new NetworkError(
      "soroban_rpc",
      `simulateTransaction(${functionName}) failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  if (rpc.Api.isSimulationError(simResult)) {
    throw new SorobanError(functionName, simResult.error);
  }

  if (!rpc.Api.isSimulationSuccess(simResult)) {
    throw new SorobanError(functionName, "simulation requires state restore");
  }

  const retval = simResult.result?.retval;
  if (!retval) {
    throw new SorobanError(functionName, "no return value from simulation");
  }

  return scValToNative(retval);
}

// ---------------------------------------------------------------------------
// Convert raw Soroban ServiceInfo to our TypeScript ServiceInfo
// ---------------------------------------------------------------------------

function toServiceInfo(raw: Record<string, unknown>): ServiceInfo {
  return {
    serviceId: Number(raw.id ?? 0),
    name: String(raw.name ?? ""),
    url: String(raw.url ?? ""),
    capability: String(raw.capability ?? ""),
    priceStroops: typeof raw.price === "bigint" ? raw.price : BigInt(String(raw.price ?? "0")),
    protocol: String(raw.protocol ?? ""),
    score: Number(raw.score ?? 70),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List services filtered by capability, minimum trust score, and limit.
 * Uses simulate (read-only in TS). Heartbeat handles CapIndex cleanup.
 *
 * NOTE: an earlier iteration also exported getService / heartbeat /
 * deregister / reportQuality write helpers, but every actual write path
 * lives in data-sources/src/shared.ts (services manage their own
 * registration lifecycle there) and the autopay flow no longer reports
 * quality (it had no way to resolve a recipient address to a service id,
 * so the calls were silently failing on a hardcoded id 0).  The unused
 * write helpers were removed to keep this file a small read-only client.
 */
export async function listServices(
  capability: string,
  minScore: number = 0,
  limit: number = 10,
): Promise<ServiceInfo[]> {
  const result = await simulateContract("list_services", [
    nativeToScVal(capability, { type: "symbol" }),
    nativeToScVal(minScore, { type: "u32" }),
    nativeToScVal(limit, { type: "u32" }),
  ]);

  if (!Array.isArray(result)) return [];
  return (result as Record<string, unknown>[]).map(toServiceInfo);
}

/**
 * List the capability names registered on this contract, paginated.
 *
 * `start` is the 0-based index, `limit` caps the page size. The contract
 * tracks capabilities in a CapName(u32) persistent index seeded by
 * register_service the first time a new capability symbol is used. The
 * default page (start=0, limit=100) covers any registry that has fewer
 * than 100 distinct capabilities — call again with start=100, 200, …
 * for larger registries until the returned array is shorter than `limit`.
 *
 * On RPC failure or contract panic, returns an empty array. The caller
 * should fall back to a hardcoded seed list when this happens so the UI
 * still has something to render.
 */
export async function listCapabilities(
  start: number = 0,
  limit: number = 100,
): Promise<string[]> {
  try {
    const result = await simulateContract("list_capabilities", [
      nativeToScVal(start, { type: "u32" }),
      nativeToScVal(limit, { type: "u32" }),
    ]);
    if (!Array.isArray(result)) return [];
    return (result as unknown[]).map((s) => String(s));
  } catch {
    return [];
  }
}
