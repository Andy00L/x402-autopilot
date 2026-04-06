import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

// Load .env from project root regardless of CWD.
// When run via npm workspace, CWD may be a subdirectory.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../.env") });

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}. See .env.example.`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** Mask a Stellar key for safe logging: "G...{last4}" */
export function maskKey(key: string): string {
  if (key.length < 8) return "***";
  return `${key.slice(0, 1)}...${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Load & validate
// ---------------------------------------------------------------------------

const stellarPrivateKey = requireEnv("STELLAR_PRIVATE_KEY");
const stellarPublicKey = requireEnv("STELLAR_PUBLIC_KEY");

// Derive keypair — do NOT export the raw secret string
export const keypair = Keypair.fromSecret(stellarPrivateKey);

if (keypair.publicKey() !== stellarPublicKey) {
  throw new Error(
    `STELLAR_PUBLIC_KEY mismatch: env=${maskKey(stellarPublicKey)}, ` +
    `derived=${maskKey(keypair.publicKey())}. Check your .env file.`,
  );
}

// ---------------------------------------------------------------------------
// Frozen config object — private key is NOT included
// ---------------------------------------------------------------------------

export const config = Object.freeze({
  // Stellar identity
  stellarPublicKey,
  stellarNetwork: optionalEnv("STELLAR_NETWORK", "stellar:testnet"),

  // Soroban contracts
  walletPolicyContractId: requireEnv("WALLET_POLICY_CONTRACT_ID"),
  trustRegistryContractId: requireEnv("TRUST_REGISTRY_CONTRACT_ID"),

  // RPC
  sorobanRpcUrl: optionalEnv("SOROBAN_RPC_URL", "https://soroban-testnet.stellar.org"),
  horizonUrl: optionalEnv("HORIZON_URL", "https://horizon-testnet.stellar.org"),
  networkPassphrase: optionalEnv("NETWORK_PASSPHRASE", "Test SDF Network ; September 2015"),

  // USDC
  usdcIssuer: optionalEnv("USDC_ISSUER", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
  usdcSacContractId: requireEnv("USDC_SAC_CONTRACT_ID"),

  // x402 Facilitator
  ozFacilitatorUrl: optionalEnv("OZ_FACILITATOR_URL", "https://channels.openzeppelin.com/x402/testnet"),
  ozApiKey: requireEnv("OZ_API_KEY"),

  // Policy defaults (stroops)
  defaultDailyLimit: BigInt(optionalEnv("DEFAULT_DAILY_LIMIT", "5000000")),
  defaultPerTxLimit: BigInt(optionalEnv("DEFAULT_PER_TX_LIMIT", "100000")),
  defaultRateLimit: Number(optionalEnv("DEFAULT_RATE_LIMIT", "20")),

  // Local dev
  allowHttp: optionalEnv("ALLOW_HTTP", "false") === "true",

  // Ports
  wsPort: Number(optionalEnv("WS_PORT", "8080")),
  mcpServerPort: Number(optionalEnv("MCP_SERVER_PORT", "3000")),
});

// ---------------------------------------------------------------------------
// x402 client — created once at startup per CLAUDE.md
// ---------------------------------------------------------------------------

import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactStellarScheme, createEd25519Signer } from "@x402/stellar";

const stellarSigner = createEd25519Signer(
  stellarPrivateKey,
  config.stellarNetwork as `${string}:${string}`,
);
const x402 = new x402Client();
x402.register("stellar:*", new ExactStellarScheme(stellarSigner));

/**
 * Fetch wrapper that automatically handles x402 payment negotiation.
 * Pass this instead of raw `fetch` when calling x402-protected endpoints.
 */
export const x402Fetch: typeof globalThis.fetch = wrapFetchWithPayment(
  globalThis.fetch,
  x402,
);

// ---------------------------------------------------------------------------
// MPP client — scoped fetch, does NOT polyfill globalThis.fetch
// ---------------------------------------------------------------------------

import { Mppx } from "mppx/client";
import { stellar as stellarCharge } from "@stellar/mpp/charge/client";

const mppxClient = Mppx.create({
  polyfill: false,
  methods: [
    stellarCharge.charge({ keypair }),
  ],
});

/**
 * Fetch wrapper that automatically handles MPP charge payment.
 * The mppx SDK handles the full 402 challenge-response-credential cycle.
 */
export const mppFetch: typeof globalThis.fetch = mppxClient.fetch;
