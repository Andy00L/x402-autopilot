import {
  Contract, TransactionBuilder, BASE_FEE,
  rpc, nativeToScVal, scValToNative, Address,
} from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { config, keypair, maskKey } from "./config.js";
import { SorobanError, NetworkError } from "./types.js";
import type { PolicyCheckResult, SpendRecord, BudgetInfo } from "./types.js";

// ---------------------------------------------------------------------------
// RPC server — 10s timeout for all calls
// ---------------------------------------------------------------------------

const server = new rpc.Server(config.sorobanRpcUrl, {
  allowHttp: config.allowHttp,
  timeout: 10_000,
});

const contractId = config.walletPolicyContractId;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Soroban read helper (simulateTransaction — no gas, no submission)
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
      `getAccount failed for wallet ${maskKey(config.stellarPublicKey)}: ${err instanceof Error ? err.message : "unknown"}`,
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

  // Check for simulation error
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
// Soroban write helper (submit + poll with retries)
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
      `getAccount failed for wallet ${maskKey(config.stellarPublicKey)}: ${err instanceof Error ? err.message : "unknown"}`,
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
      `TX rejected: ${sendResult.errorResult?.toXDR("base64") ?? "unknown error"}`,
    );
  }

  if (sendResult.status === "DUPLICATE") {
    throw new SorobanError(functionName, "TX duplicate — possible nonce reuse");
  }

  // Poll for confirmation (up to 15s)
  const MAX_POLLS = 15;
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(1_000);
    let getResult;
    try {
      getResult = await server.getTransaction(sendResult.hash);
    } catch {
      continue; // Transient RPC error during polling — retry
    }

    if (getResult.status === "NOT_FOUND") continue;
    if (getResult.status === "SUCCESS") return sendResult.hash;

    throw new SorobanError(
      functionName,
      `TX failed on-chain with status: ${getResult.status}`,
    );
  }

  throw new SorobanError(
    functionName,
    `TX confirmation timeout after ${MAX_POLLS}s (hash: ${sendResult.hash})`,
  );
}

// ---------------------------------------------------------------------------
// Retry wrapper for write operations
// Exponential backoff: 1s, 2s, 4s — per CLAUDE.md Rule 6
// ---------------------------------------------------------------------------

async function invokeWithRetry(
  functionName: string,
  args: xdr.ScVal[],
  maxRetries = 3,
): Promise<string> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await invokeContract(functionName, args);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry on duplicate nonce — it's a logic error
      if (lastError.message.includes("duplicate")) throw lastError;
      // Don't retry on policy denial
      if (lastError.message.includes("denied") || lastError.message.includes("rejected")) {
        throw lastError;
      }
      if (attempt < maxRetries - 1) {
        await sleep(1_000 * Math.pow(2, attempt)); // 1s, 2s, 4s
      }
    }
  }
  throw lastError!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * READ-ONLY: Check spending policy on-chain.
 * On RPC failure: returns { allowed: false, reason: "rpc_unavailable" } — FAIL CLOSED.
 */
export async function checkPolicy(
  amount: bigint,
  recipient: string,
): Promise<PolicyCheckResult> {
  try {
    const result = await simulateContract("check_policy", [
      nativeToScVal(amount, { type: "i128" }),
      new Address(recipient).toScVal(),
    ]);

    // Result is a Soroban struct → JS object
    const obj = result as Record<string, unknown>;
    const spentToday = typeof obj.remaining === "bigint"
      ? config.defaultDailyLimit - (obj.remaining as bigint)
      : 0n;

    return {
      allowed: Boolean(obj.allowed),
      reason: String(obj.reason ?? "unknown"),
      remainingDaily: typeof obj.remaining === "bigint" ? obj.remaining as bigint : 0n,
      spentToday,
    };
  } catch (err) {
    // FAIL CLOSED — CLAUDE.md Rule 9
    return {
      allowed: false,
      reason: "rpc_unavailable",
      remainingDaily: 0n,
      spentToday: 0n,
    };
  }
}

/**
 * WRITE: Record a successful spend. Retry 3x with exponential backoff.
 */
export async function recordSpend(
  nonce: string,
  amount: bigint,
  recipient: string,
  txHash: string,
): Promise<void> {
  await invokeWithRetry("record_spend", [
    nativeToScVal(nonce, { type: "symbol" }),
    nativeToScVal(amount, { type: "i128" }),
    new Address(recipient).toScVal(),
    nativeToScVal(txHash, { type: "symbol" }),
  ]);
}

/**
 * WRITE: Record a denied payment attempt.
 */
export async function recordDenied(
  amount: bigint,
  reason: string,
): Promise<void> {
  await invokeWithRetry("record_denied", [
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(reason, { type: "symbol" }),
  ]);
}

/**
 * WRITE: Update spending policy on-chain. Returns TX hash.
 */
export async function updatePolicy(
  dailyLimit: bigint,
  perTxLimit: bigint,
  rateLimit: number,
  timeStart: bigint,
  timeEnd: bigint,
): Promise<string> {
  return invokeWithRetry("update_policy", [
    nativeToScVal(dailyLimit, { type: "i128" }),
    nativeToScVal(perTxLimit, { type: "i128" }),
    nativeToScVal(rateLimit, { type: "u32" }),
    nativeToScVal(timeStart, { type: "u64" }),
    nativeToScVal(timeEnd, { type: "u64" }),
  ]);
}

/**
 * READ-ONLY: Get today's spending record.
 */
export async function getTodaySpending(): Promise<SpendRecord> {
  const result = await simulateContract("get_today_spending", []);
  const obj = result as Record<string, unknown>;

  return {
    dayKey: BigInt(Math.floor(Date.now() / 1000 / 86400)),
    totalSpent: typeof obj.total === "bigint" ? obj.total : 0n,
    txCount: Number(obj.count ?? 0),
  };
}

/**
 * READ-ONLY: Get lifetime statistics.
 */
export async function getLifetimeStats(): Promise<BudgetInfo> {
  const result = await simulateContract("get_lifetime_stats", []);

  // Returns a tuple: [i128, u64, u64] → [bigint, bigint, bigint]
  const arr = result as [bigint, bigint, bigint];
  const today = await getTodaySpending();

  return {
    spentToday: today.totalSpent,
    remaining: config.defaultDailyLimit - today.totalSpent,
    dailyLimit: config.defaultDailyLimit,
    txCount: Number(arr[1] ?? 0),
    deniedCount: Number(arr[2] ?? 0),
    lifetimeSpent: typeof arr[0] === "bigint" ? arr[0] : 0n,
  };
}
