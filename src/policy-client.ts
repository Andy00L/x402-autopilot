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

  // Soroban returns a "restore" branch when one of the contract's
  // persistent storage entries has aged out and the simulator can no
  // longer read it without an explicit RestoreFootprint operation.
  // Surface this distinctly so the caller can see "your contract data
  // expired" instead of a generic "simulation failed".
  if (rpc.Api.isSimulationRestore(simResult)) {
    throw new SorobanError(
      functionName,
      "state_restore_required: contract storage entries have expired and need a RestoreFootprint operation before the call will succeed",
    );
  }

  if (!rpc.Api.isSimulationSuccess(simResult)) {
    throw new SorobanError(functionName, "simulation returned unexpected status");
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

  // Compute the TX hash from the signed envelope BEFORE sending. The hash
  // is deterministic from the signed content, so this matches whatever
  // hash the network will use. Embedding it in every error message lets
  // invokeWithRetry recover the prior attempt's hash on a "duplicate"
  // panic in a subsequent attempt — the duplicate is proof that the prior
  // attempt actually landed on-chain, and the recovered hash is its
  // confirmation receipt. Without this, retry-after-network-blip would
  // double-record spends with a fresh nonce in the autopay catch path.
  const txHashHex = prepared.hash().toString("hex");

  let sendResult;
  try {
    sendResult = await server.sendTransaction(prepared);
  } catch (err) {
    throw new NetworkError(
      "soroban_rpc",
      `sendTransaction(${functionName}) failed: ${err instanceof Error ? err.message : "unknown"} (hash: ${txHashHex})`,
    );
  }

  if (sendResult.status === "ERROR") {
    throw new SorobanError(
      functionName,
      `TX rejected: ${sendResult.errorResult?.toXDR("base64") ?? "unknown error"} (hash: ${txHashHex})`,
    );
  }

  if (sendResult.status === "DUPLICATE") {
    throw new SorobanError(
      functionName,
      `TX duplicate — possible nonce reuse (hash: ${txHashHex})`,
    );
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
      `TX failed on-chain with status: ${getResult.status} (hash: ${txHashHex})`,
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
//
// Idempotency recovery
// --------------------
// Soroban writes are idempotent at the contract level via nonce dedup,
// but the JSON-RPC submission path is not: the network may swallow the
// ack while the TX still lands. Without compensation, the next retry
// resubmits with the same nonce, the contract panics "duplicate", and
// the caller's catch path resorts to a fresh nonce — double-recording
// the same spend.
//
// The fix: every error from invokeContract carries the deterministic
// `(hash: <hex>)` of the signed envelope. We capture it as `pendingHash`.
// On a subsequent attempt that fails with "duplicate", we KNOW the
// previous attempt landed (the contract has the nonce it would only
// have if our prior submission committed), so we return `pendingHash`
// as the success result and let the caller continue the happy path.
// ---------------------------------------------------------------------------

const HASH_RE = /hash:\s*([a-f0-9]{64})/i;

async function invokeWithRetry(
  functionName: string,
  args: xdr.ScVal[],
  maxRetries = 3,
): Promise<string> {
  let lastError: Error | undefined;
  let pendingHash: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await invokeContract(functionName, args);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;

      // Snapshot the hash from this attempt's error so a follow-up attempt
      // can interpret a "duplicate" panic as confirmation of this one.
      const hashMatch = HASH_RE.exec(msg);
      if (hashMatch) {
        pendingHash = hashMatch[1];
      }

      // Duplicate nonce. Two cases:
      //   - First attempt: the caller passed a nonce that was already
      //     recorded in a previous session. Hard logic error, surface it.
      //   - Retry attempt: a prior attempt's TX actually landed (network
      //     blip swallowed the ack). pendingHash holds that prior hash;
      //     return it as success so the caller's happy path runs once.
      if (msg.includes("duplicate")) {
        if (pendingHash !== undefined) {
          return pendingHash;
        }
        throw lastError;
      }

      // Don't retry on hard rejections or policy denials.
      if (msg.includes("denied") || msg.includes("rejected")) {
        throw lastError;
      }

      if (attempt < maxRetries - 1) {
        await sleep(1_000 * Math.pow(2, attempt)); // 1s, 2s, 4s
      }
    }
  }

  // All retries exhausted. Before surrendering to the caller, give the
  // network one last chance to confirm the FIRST attempt's TX. The most
  // common path here is "first attempt timed out polling, every retry
  // ran into a separate network blip". If the first TX landed
  // asynchronously, getTransaction will see it now and we can return
  // pendingHash as success — the alternative is the caller (autopay
  // catch) issues a fresh-nonce recordSpend and double-counts the spend.
  if (pendingHash !== undefined) {
    try {
      const result = await server.getTransaction(pendingHash);
      if (result.status === "SUCCESS") {
        return pendingHash;
      }
    } catch {
      // Final check itself failed — there's nothing left to do.
      // Fall through to throwing the captured error.
    }
  }

  throw lastError ?? new Error(`${functionName} failed without error`);
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
