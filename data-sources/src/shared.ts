import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { x402ResourceServer } from "@x402/express";
import {
  Contract, TransactionBuilder, BASE_FEE,
  rpc, nativeToScVal, scValToNative, Address, Keypair,
} from "@stellar/stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

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
// Trust Registry self-registration (optional, fire-and-forget)
//
// Calls register_service on the Soroban trust-registry contract.
// Requires STELLAR_PRIVATE_KEY and TRUST_REGISTRY_CONTRACT_ID.
// If either is missing, registration is silently skipped.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RegistrationResult {
  serviceId: number;
  stopHeartbeat: () => void;
}

export async function selfRegister(opts: {
  name: string;
  url: string;
  capabilities: string[];
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
          nativeToScVal(opts.url, { type: "symbol" }),
          nativeToScVal(opts.name, { type: "symbol" }),
          nativeToScVal(opts.capabilities, { type: "symbol" }), // Vec<Symbol>
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

  // --- Heartbeat interval ---
  const sid = serviceId;
  const intervalId = setInterval(() => {
    sendHeartbeat(server, contract, keypair, passphrase, sid)
      .catch(() => { /* heartbeat failure is non-critical */ });
  }, HEARTBEAT_INTERVAL_MS);

  return {
    serviceId: sid,
    stopHeartbeat: () => clearInterval(intervalId),
  };
}

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
        new Address(keypair.publicKey()).toScVal(),
        nativeToScVal(serviceId, { type: "u32" }),
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(keypair);
  await server.sendTransaction(prepared);
}
