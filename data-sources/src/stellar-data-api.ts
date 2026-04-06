import express from "express";
import { Mppx } from "mppx/express";
import { stellar, Store } from "@stellar/mpp/charge/server";
import { USDC_SAC_TESTNET } from "@stellar/mpp";
import { selfRegister, env } from "./shared.js";

const PORT = Number(env("PORT_STELLAR_DATA_API", "4003"));
const RECIPIENT = env("STELLAR_DATA_API_WALLET");

const app = express();

// ---------------------------------------------------------------------------
// MPP charge middleware — charges $0.002 (20,000 stroops) per request
//
// Flow:
//   1. Client GET /stellar-stats → 402 + WWW-Authenticate: Payment ...
//   2. Client signs SAC transfer TX, retries with Authorization: Payment <xdr>
//   3. Server verifies, broadcasts, returns 200 + Payment-Receipt header
// ---------------------------------------------------------------------------

const mppx = Mppx.create({
  secretKey: env("MPP_SECRET_KEY", "x402-autopilot-demo-secret"),
  methods: [
    stellar.charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      network: "stellar:testnet",
      store: Store.memory(),
    }),
  ],
});

app.get(
  "/stellar-stats",
  mppx.charge({ amount: "0.002", description: "Stellar network statistics" }),
  (_req, res) => {
    res.json({
      accounts: 8_200_000,
      daily_transactions: 1_400_000,
      tvl_usd: 45_000_000,
      usdc_volume_24h: 12_500_000,
      source: "x402-autopilot-demo",
      timestamp: new Date().toISOString(),
    });
  },
);

// ---------------------------------------------------------------------------
// Health check — free, no paywall
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "stellar-data",
    protocol: "mpp",
    port: PORT,
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[Stellar Data API] :${PORT} (MPP charge)`);

  selfRegister({
    name: "stellar-data",
    url: `http://localhost:${PORT}`,
    capabilities: ["blockchain-data"],
    priceStroops: 20_000n, // $0.002
    protocol: "mpp",
  }).catch(() => {});
});
