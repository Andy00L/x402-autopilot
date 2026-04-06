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

  // --- Register ---
  let serviceId: number | undefined;
  try {
    const account = await server.getAccount(publicKey);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(
        contract.call(
          "register_service",
          new Address(publicKey).toScVal(),
          nativeToScVal(opts.url),                       // String (URLs contain :/.)
          nativeToScVal(opts.name, { type: "symbol" }),
          nativeToScVal(opts.capability, { type: "symbol" }), // Single Symbol
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
      console.error(`[${opts.name}] Registration TX rejected`);
      return null;
    }

    // Poll for confirmation (15s max)
    for (let i = 0; i < 15; i++) {
      await sleep(1_000);
      try {
        const result = await server.getTransaction(sendResult.hash);
        if (result.status === "NOT_FOUND") continue;
        if (result.status === "SUCCESS") {
          serviceId = result.returnValue
            ? Number(scValToNative(result.returnValue))
            : 0;
          break;
        }
        console.error(`[${opts.name}] Registration TX failed: ${result.status}`);
        return null;
      } catch {
        continue; // transient RPC error during polling
      }
    }

    if (serviceId === undefined) {
      console.error(`[${opts.name}] Registration TX confirmation timeout`);
      return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error(`[${opts.name}] Registration failed: ${msg}`);
    return null;
  }

  console.log(`[${opts.name}] Registered in trust registry (serviceId=${serviceId})`);

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
