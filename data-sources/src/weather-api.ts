import express from "express";
import { paymentMiddleware } from "@x402/express";
import { createStellarX402Server, selfRegister, env } from "./shared.js";

const PORT = Number(env("PORT_WEATHER_API", "4001"));
const WALLET = env("WEATHER_API_WALLET");
const app = express();

// ---------------------------------------------------------------------------
// x402 paywall — charges $0.001 per request on Stellar testnet
// ---------------------------------------------------------------------------

app.use(
  paymentMiddleware(
    {
      "/weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "stellar:testnet",
          payTo: WALLET,
        },
        description: "Current weather data",
        mimeType: "application/json",
      },
    },
    createStellarX402Server(),
  ),
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/weather", (_req, res) => {
  res.json({
    temperature: 22,
    conditions: "sunny",
    humidity: 45,
    wind: "12 km/h NW",
    source: "x402-autopilot-demo",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "weather",
    protocol: "x402",
    port: PORT,
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[Weather API] :${PORT} (x402)`);

  // Self-register in trust registry (optional, non-blocking)
  selfRegister({
    name: "weather",
    url: `http://localhost:${PORT}`,
    capabilities: ["weather"],
    priceStroops: 10_000n, // $0.001
    protocol: "x402",
  }).catch(() => {});
});
