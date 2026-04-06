import express from "express";
import { paymentMiddleware } from "@x402/express";
import { createStellarX402Server, selfRegister, env } from "./shared.js";

const PORT = Number(env("PORT_NEWS_API", "4002"));
const WALLET = env("NEWS_API_WALLET");
const app = express();

// ---------------------------------------------------------------------------
// x402 paywall — charges $0.001 per request on Stellar testnet
// ---------------------------------------------------------------------------

app.use(
  paymentMiddleware(
    {
      "/news": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "stellar:testnet",
          payTo: WALLET,
        },
        description: "Technology news headlines",
        mimeType: "application/json",
      },
    },
    createStellarX402Server(),
  ),
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/news", (_req, res) => {
  res.json({
    headlines: [
      {
        title: "Stellar Network Hits 8M Accounts",
        summary: "The Stellar network crossed 8 million funded accounts as USDC adoption accelerates.",
        source: "Stellar Daily",
      },
      {
        title: "x402 Protocol Gains Traction",
        summary: "Machine-to-machine payments via x402 are seeing 300% month-over-month growth.",
        source: "Crypto Payments Weekly",
      },
      {
        title: "Soroban Smart Contracts Go Mainnet",
        summary: "Stellar's Soroban platform officially launches on mainnet with 200+ deployed contracts.",
        source: "DeFi Pulse",
      },
    ],
    topic: "technology",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "news",
    protocol: "x402",
    port: PORT,
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[News API] :${PORT} (x402)`);

  selfRegister({
    name: "news",
    url: `http://localhost:${PORT}`,
    capabilities: ["news"],
    priceStroops: 10_000n, // $0.001
    protocol: "x402",
  }).catch(() => {});
});
