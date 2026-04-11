import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { x402ResourceServer } from "@x402/express";
import {
  Contract, TransactionBuilder, BASE_FEE,
  rpc, nativeToScVal, scValToNative, Address, Keypair,
} from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Load .env from the project root regardless of CWD.
// When run via npm workspace (npm run dev --workspace=data-sources),
// CWD is data-sources/, not the project root.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../../.env") });

// ---------------------------------------------------------------------------
// Env helpers — no secrets in error messages
// ---------------------------------------------------------------------------

export function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}. See .env.example.`);
}

/**
 * Validate that a service's `payTo` wallet is actually distinct from the
 * main agent wallet. Called by each x402 / MPP server at startup.
 *
 * The check is a WARNING, not a throw. Services still start with whatever
 * is in .env — we'd rather run with a slightly broken config than block
 * the user over a local-only concern. The warning fires loudly in the
 * startup log so a mis-provisioned service is obvious.
 *
 * Under normal conditions (`npm run dev` ran the predev hook that invoked
 * `ensure-service-wallets.ts`), this never triggers.
 */
export function assertDistinctServiceWallet(
  serviceName: string,
  walletEnvVar: string,
): void {
  const walletAddress = process.env[walletEnvVar];
  const mainWallet = process.env.STELLAR_PUBLIC_KEY;

  if (!walletAddress) {
    // env() above already threw with a clear message; this is only for
    // the belt-and-braces case where a caller resolved the value through
    // some other path.
    console.warn(
      `[${serviceName}] ${walletEnvVar} not set. Payments cannot be routed. ` +
        `Run \`npm run dev\` (auto-configures wallets) or \`npm run setup:service-wallets\`.`,
    );
    return;
  }

  if (mainWallet && walletAddress === mainWallet) {
    console.warn(
      `[${serviceName}] WARNING: ${walletEnvVar} equals STELLAR_PUBLIC_KEY. ` +
        `Payments will be self-transfers and invisible on the dashboard. ` +
        `Run: npm run setup:service-wallets`,
    );
  }
}

// ---------------------------------------------------------------------------
// x402 Resource Server — used by every x402-paywalled service in this
// workspace (Crypto Price Oracle, News, News Intelligence, Market
// Intelligence, Analyst). Each service mounts its own paymentMiddleware
// against the resource server returned here.
// ---------------------------------------------------------------------------

export function createStellarX402Server(): x402ResourceServer {
  const facilitatorClient = new HTTPFacilitatorClient({
    url: env("OZ_FACILITATOR_URL", "https://x402.org/facilitator"),
    createAuthHeaders: async () => {
      const apiKey = env("OZ_API_KEY");
      const headers = { Authorization: `Bearer ${apiKey}` };
      return { verify: headers, settle: headers, supported: headers };
    },
  });

  return new x402ResourceServer(facilitatorClient)
    .register("stellar:testnet", new ExactStellarScheme());
}

// ---------------------------------------------------------------------------
// Trust Registry self-registration with heartbeat + graceful shutdown
//
// Calls register_service on the Soroban trust-registry contract with the
// SERVICE's own keypair as both the transaction source and the `owner`
// argument. The contract uses `owner.require_auth()` on register, heartbeat
// and deregister — source account authorization means the tx signature
// alone is enough, no auth entry wrangling.
//
// Why the service must sign its own registration
//   Every registered service is stored with an on-chain `owner` field. The
//   dashboard reads that field to wire ownership edges between wallet nodes
//   and service nodes. If the service registered with the main wallet as
//   owner (the old behaviour), every edge would collapse onto the main
//   wallet node and the per-service wallet cards would look orphaned.
//
// Required env vars
//   TRUST_REGISTRY_CONTRACT_ID — must be set; else we skip registration
//   opts.secretKey             — the calling service's own S… secret;
//                                if absent we skip and log a warning so
//                                the service still runs behind its paywall
//                                but won't be discoverable.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1_000; // 4 minutes
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RegistrationResult {
  serviceId: number;
  stopHeartbeat: () => void;
}

export interface SelfRegisterOptions {
  name: string;
  url: string;
  capability: string;
  priceStroops: bigint;
  protocol: string;
  /** The service's own Stellar secret key. Used as both the transaction
   *  source and the `owner` argument to register_service, so the service
   *  becomes the on-chain owner of its own registration. */
  secretKey: string | undefined;
}

export async function selfRegister(
  opts: SelfRegisterOptions,
): Promise<RegistrationResult | null> {
  const contractId = process.env.TRUST_REGISTRY_CONTRACT_ID;
  const rpcUrl = env("SOROBAN_RPC_URL", "https://soroban-testnet.stellar.org");
  const passphrase = env("NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");

  if (!contractId) {
    console.log(
      `[${opts.name}] Skipping trust registry (TRUST_REGISTRY_CONTRACT_ID not set)`,
    );
    return null;
  }

  if (!opts.secretKey || !opts.secretKey.startsWith("S") || opts.secretKey.length !== 56) {
    console.warn(
      `[${opts.name}] Service secret key not set — skipping trust registry. ` +
        `Service will run behind its paywall but won't be discoverable. ` +
        `Run: npm run setup:service-wallets`,
    );
    return null;
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(opts.secretKey);
  } catch {
    console.warn(
      `[${opts.name}] Service secret key is malformed — skipping trust registry.`,
    );
    return null;
  }

  const server = new rpc.Server(rpcUrl, { timeout: 15_000 });
  const contract = new Contract(contractId);
  const publicKey = keypair.publicKey();

  // Log the owner up front so an operator watching the startup logs can
  // confirm the service is registering under its OWN wallet, not the
  // main agent wallet. Truncated G… form keeps the line scannable.
  const mainPublic = process.env.STELLAR_PUBLIC_KEY ?? "";
  const ownerTag = mainPublic && publicKey === mainPublic ? " (MAIN WALLET — MISCONFIGURED)" : "";
  console.log(
    `[${opts.name}] Trust registry owner = ${publicKey.slice(0, 6)}…${publicKey.slice(-4)}${ownerTag}`,
  );

  // --- Resolve service ID: check existing, then register if needed ---
  const serviceId = await resolveServiceId(server, contract, keypair, passphrase, publicKey, opts);
  if (serviceId === null) {
    console.warn(`[${opts.name}] Running without trust registry (not discoverable)`);
    return null;
  }

  // --- Heartbeat interval (4 minutes) ---
  const sid = serviceId;
  const intervalId = setInterval(() => {
    sendHeartbeat(server, contract, keypair, passphrase, sid)
      .then(() => console.log(`[${opts.name}] heartbeat sent`))
      .catch(() => { /* heartbeat failure is non-critical */ });
  }, HEARTBEAT_INTERVAL_MS);

  // --- Graceful shutdown: deregister on SIGTERM/SIGINT ---
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${opts.name}] ${signal} received, deregistering...`);
    clearInterval(intervalId);
    try {
      await sendDeregister(server, contract, keypair, passphrase, sid);
      console.log(`[${opts.name}] Deregistered from trust registry`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(`[${opts.name}] Deregister failed: ${msg}`);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return {
    serviceId: sid,
    stopHeartbeat: () => clearInterval(intervalId),
  };
}

// ---------------------------------------------------------------------------
// Resolve service ID: list first, register only if not found
// Handles restarts where the previous registration is still alive (TTL > 0)
// ---------------------------------------------------------------------------

async function resolveServiceId(
  server: rpc.Server,
  contract: Contract,
  keypair: Keypair,
  passphrase: string,
  publicKey: string,
  opts: { name: string; url: string; capability: string; priceStroops: bigint; protocol: string },
): Promise<number | null> {
  // Step 1: Check if already registered (handles restart within TTL window)
  try {
    const existing = await simulateListServices(server, contract, publicKey, passphrase, opts.capability);
    const match = existing.find((s) => s.url === opts.url);
    if (match) {
      console.log(`[${opts.name}] Already registered (serviceId=${match.id}), resuming heartbeat`);
      return match.id;
    }
  } catch {
    // listServices RPC failed, try registering anyway
  }

  // Step 2: Register (no existing entry found, or list failed)
  try {
    const serviceId = await sendRegister(server, contract, keypair, passphrase, publicKey, opts);
    console.log(`[${opts.name}] Registered in trust registry (serviceId=${serviceId})`);
    return serviceId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${opts.name}] Registration failed: ${msg}`);

    // Step 3: Retry list (race condition: registered between our list and register)
    try {
      const retry = await simulateListServices(server, contract, publicKey, passphrase, opts.capability);
      const match = retry.find((s) => s.url === opts.url);
      if (match) {
        console.log(`[${opts.name}] Found existing registration (serviceId=${match.id})`);
        return match.id;
      }
    } catch {
      // Give up
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Simulate list_services (read-only, no TX needed)
// ---------------------------------------------------------------------------

interface RawServiceInfo {
  id: number;
  url: string;
}

async function simulateListServices(
  server: rpc.Server,
  contract: Contract,
  publicKey: string,
  passphrase: string,
  capability: string,
): Promise<RawServiceInfo[]> {
  const account = await server.getAccount(publicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      contract.call(
        "list_services",
        nativeToScVal(capability, { type: "symbol" }),
        nativeToScVal(0, { type: "u32" }),
        nativeToScVal(50, { type: "u32" }),
      ),
    )
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simResult)) return [];
  if (!rpc.Api.isSimulationSuccess(simResult)) return [];

  const retval = simResult.result?.retval;
  if (!retval) return [];

  const parsed = scValToNative(retval);
  if (!Array.isArray(parsed)) return [];

  return parsed.map((s: Record<string, unknown>) => ({
    id: Number(s.id ?? 0),
    url: String(s.url ?? ""),
  }));
}

// ---------------------------------------------------------------------------
// Send register_service transaction (with retry + extended polling)
//
// Why this is more elaborate than a single send-and-poll:
//
//   • Soroban testnet is intermittently slow.  A single 15s polling window
//     could miss confirmation of a TX that lands at second 16, leaving the
//     service un-discoverable.  We extend each attempt to 30 polls.
//
//   • A stale sequence number causes sendTransaction to fail with a cryptic
//     "txBadSeq".  We refetch the account on every attempt so each retry
//     gets a fresh sequence.
//
//   • Transient RPC failures (502, timeout) deserve a retry, not a hard
//     give-up.  Three attempts with 5s / 10s / 15s backoff cover the
//     common testnet hiccups without blocking startup forever.
//
//   • Distinct error messages per failure mode (CLAUDE.md Rule 7):
//       - "prepare failed: …"     → simulation or preflight rejected
//       - "send rejected: …"      → core rejected the signed TX
//       - "TX failed: <STATUS>"   → on-chain status was not SUCCESS
//       - "confirmation timeout"  → polling window exhausted
//     Each is actionable for the operator.
// ---------------------------------------------------------------------------

const REGISTER_MAX_ATTEMPTS = 3;
const REGISTER_POLL_ATTEMPTS = 30;       // 30 × 1s = 30s per attempt
const REGISTER_POLL_INTERVAL_MS = 1_000;
const REGISTER_BACKOFF_BASE_MS = 5_000;  // 5s, 10s, 15s

async function sendRegisterOnce(
  server: rpc.Server,
  contract: Contract,
  keypair: Keypair,
  passphrase: string,
  publicKey: string,
  opts: { url: string; name: string; capability: string; priceStroops: bigint; protocol: string },
): Promise<number> {
  // Always fetch a fresh sequence number — stale sequences are the most
  // common source of "txBadSeq" rejections on a busy testnet.
  const account = await server.getAccount(publicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      contract.call(
        "register_service",
        new Address(publicKey).toScVal(),
        nativeToScVal(opts.url),
        nativeToScVal(opts.name, { type: "symbol" }),
        nativeToScVal(opts.capability, { type: "symbol" }),
        nativeToScVal(opts.priceStroops, { type: "i128" }),
        nativeToScVal(opts.protocol, { type: "symbol" }),
      ),
    )
    .setTimeout(60) // generous time-bounds: TX has 60s to land before expiring
    .build();

  let prepared;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (err) {
    throw new Error(
      `prepare failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  prepared.sign(keypair);

  let sendResult;
  try {
    sendResult = await server.sendTransaction(prepared);
  } catch (err) {
    throw new Error(
      `sendTransaction failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  if (sendResult.status === "ERROR") {
    throw new Error(
      `send rejected: ${sendResult.errorResult?.toXDR("base64") ?? "unknown"}`,
    );
  }
  if (sendResult.status === "DUPLICATE") {
    throw new Error("send rejected: DUPLICATE — possible nonce reuse");
  }

  // Poll for confirmation. We treat transient getTransaction errors as
  // "still polling" until we hit the attempt cap.
  for (let i = 0; i < REGISTER_POLL_ATTEMPTS; i++) {
    await sleep(REGISTER_POLL_INTERVAL_MS);
    let result;
    try {
      result = await server.getTransaction(sendResult.hash);
    } catch {
      continue; // RPC blip — keep polling
    }
    if (result.status === "NOT_FOUND") continue;
    if (result.status === "SUCCESS") {
      return result.returnValue ? Number(scValToNative(result.returnValue)) : 0;
    }
    throw new Error(`TX failed: ${result.status}`);
  }

  throw new Error(`confirmation timeout after ${REGISTER_POLL_ATTEMPTS}s (hash: ${sendResult.hash})`);
}

async function sendRegister(
  server: rpc.Server,
  contract: Contract,
  keypair: Keypair,
  passphrase: string,
  publicKey: string,
  opts: { url: string; name: string; capability: string; priceStroops: bigint; protocol: string },
): Promise<number> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= REGISTER_MAX_ATTEMPTS; attempt++) {
    try {
      return await sendRegisterOnce(
        server,
        contract,
        keypair,
        passphrase,
        publicKey,
        opts,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;

      // Permanent failures — don't burn retry budget on these.
      if (
        msg.includes("DUPLICATE") ||
        msg.includes("already registered") ||
        msg.includes("denied")
      ) {
        throw lastError;
      }

      if (attempt < REGISTER_MAX_ATTEMPTS) {
        const backoff = attempt * REGISTER_BACKOFF_BASE_MS; // 5s, 10s, 15s
        console.warn(
          `[${opts.name}] Registration attempt ${attempt}/${REGISTER_MAX_ATTEMPTS} ` +
            `failed (${msg.slice(0, 120)}). Retrying in ${backoff / 1000}s…`,
        );
        await sleep(backoff);
      }
    }
  }
  throw lastError ?? new Error("Registration failed without a captured error");
}

// ---------------------------------------------------------------------------
// Heartbeat — extends service TTL on-chain
// v2: only passes service_id (owner read from stored ServiceInfo)
// ---------------------------------------------------------------------------

async function sendHeartbeat(
  server: rpc.Server,
  contract: Contract,
  keypair: Keypair,
  passphrase: string,
  serviceId: number,
): Promise<void> {
  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      contract.call(
        "heartbeat",
        nativeToScVal(serviceId, { type: "u32" }),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(keypair);
  await server.sendTransaction(prepared);
}

// ---------------------------------------------------------------------------
// Deregister — removes service from registry, refunds deposit
// ---------------------------------------------------------------------------

async function sendDeregister(
  server: rpc.Server,
  contract: Contract,
  keypair: Keypair,
  passphrase: string,
  serviceId: number,
): Promise<void> {
  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      contract.call(
        "deregister_service",
        nativeToScVal(serviceId, { type: "u32" }),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(keypair);
  await server.sendTransaction(prepared);
}
