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

// ---------------------------------------------------------------------------
// x402 Resource Server — used by weather-api and news-api
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
// Calls register_service on the Soroban trust-registry contract.
// Checks for existing registration first (handles restarts without errors).
// Sets up heartbeat interval (4 min) and SIGTERM/SIGINT handlers.
// Requires STELLAR_PRIVATE_KEY and TRUST_REGISTRY_CONTRACT_ID.
// If either is missing, registration is silently skipped.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1_000; // 4 minutes
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RegistrationResult {
  serviceId: number;
  stopHeartbeat: () => void;
}

export async function selfRegister(opts: {
  name: string;
  url: string;
  capability: string;
  priceStroops: bigint;
  protocol: string;
}): Promise<RegistrationResult | null> {
  const contractId = process.env.TRUST_REGISTRY_CONTRACT_ID;
  const privateKey = process.env.STELLAR_PRIVATE_KEY;
  const rpcUrl = env("SOROBAN_RPC_URL", "https://soroban-testnet.stellar.org");
  const passphrase = env("NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");

  if (!contractId || !privateKey) {
    console.log(`[${opts.name}] Skipping trust registry (TRUST_REGISTRY_CONTRACT_ID or key not set)`);
    return null;
  }

  const keypair = Keypair.fromSecret(privateKey);
  const server = new rpc.Server(rpcUrl, { timeout: 15_000 });
  const contract = new Contract(contractId);
  const publicKey = keypair.publicKey();

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
// Send register_service transaction
// ---------------------------------------------------------------------------

async function sendRegister(
  server: rpc.Server,
  contract: Contract,
  keypair: Keypair,
  passphrase: string,
  publicKey: string,
  opts: { url: string; name: string; capability: string; priceStroops: bigint; protocol: string },
): Promise<number> {
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
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(keypair);

  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    throw new Error("TX rejected");
  }

  // Poll for confirmation (15s max)
  for (let i = 0; i < 15; i++) {
    await sleep(1_000);
    try {
      const result = await server.getTransaction(sendResult.hash);
      if (result.status === "NOT_FOUND") continue;
      if (result.status === "SUCCESS") {
        return result.returnValue ? Number(scValToNative(result.returnValue)) : 0;
      }
      throw new Error(`TX failed: ${result.status}`);
    } catch (e) {
      if (i < 14 && e instanceof Error && !e.message.startsWith("TX failed")) continue;
      throw e;
    }
  }

  throw new Error("TX confirmation timeout");
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
