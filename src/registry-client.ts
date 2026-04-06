import {
  Contract, TransactionBuilder, BASE_FEE,
  rpc, nativeToScVal, scValToNative, Address,
} from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { config, keypair, maskKey } from "./config.js";
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
// Soroban write helper (build, prepare, sign, send, poll)
// ---------------------------------------------------------------------------

async function invokeContract(
  functionName: string,
  args: xdr.ScVal[],
): Promise<string> {
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

  let prepared;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (err) {
    throw new SorobanError(
      functionName,
      `prepareTransaction failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  prepared.sign(keypair);

  let sendResult;
  try {
    sendResult = await server.sendTransaction(prepared);
  } catch (err) {
    throw new NetworkError(
      "soroban_rpc",
      `sendTransaction(${functionName}) failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  if (sendResult.status === "ERROR") {
    throw new SorobanError(
      functionName,
      `TX rejected: ${sendResult.errorResult?.toXDR("base64") ?? "unknown"}`,
    );
  }

  const MAX_POLLS = 15;
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(1_000);
    let getResult;
    try {
      getResult = await server.getTransaction(sendResult.hash);
    } catch {
      continue;
    }
    if (getResult.status === "NOT_FOUND") continue;
    if (getResult.status === "SUCCESS") return sendResult.hash;
    throw new SorobanError(functionName, `TX failed: ${getResult.status}`);
  }

  throw new SorobanError(functionName, `TX confirmation timeout (hash: ${sendResult.hash})`);
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
 * Get a single service by ID.
 */
export async function getService(serviceId: number): Promise<ServiceInfo> {
  const result = await simulateContract("get_service", [
    nativeToScVal(serviceId, { type: "u32" }),
  ]);
  return toServiceInfo(result as Record<string, unknown>);
}

/**
 * Report quality for a service. Fire-and-forget pattern.
 * Never throws — errors are silently logged.
 */
export function reportQuality(serviceId: number, success: boolean): void {
  invokeContract("report_quality", [
    new Address(config.stellarPublicKey).toScVal(),
    nativeToScVal(serviceId, { type: "u32" }),
    nativeToScVal(success),
  ]).catch(() => {
    // Fire-and-forget: quality report failure is non-critical
  });
}

/**
 * Send heartbeat for a service. Only takes service_id;
 * the contract reads the owner from stored ServiceInfo.
 */
export async function heartbeat(serviceId: number): Promise<void> {
  await invokeContract("heartbeat", [
    nativeToScVal(serviceId, { type: "u32" }),
  ]);
}

/**
 * Deregister a service. Removes from temporary + CapIndex, refunds deposit.
 */
export async function deregister(serviceId: number): Promise<void> {
  await invokeContract("deregister_service", [
    nativeToScVal(serviceId, { type: "u32" }),
  ]);
}
