/**
 * Crypto Price Oracle (x402) — port 4001
 *
 * Pure data seller. Pulls real-time prices from CoinGecko's free public
 * API and sells the result behind an x402 paywall. This is the base
 * layer of the agent network: every other agent that reasons over
 * market data buys from here.
 *
 * The file is still called `weather-api.ts` on disk so that
 * `data-sources/package.json` (concurrently script + dev:weather) and
 * the service-wallet env vars (WEATHER_API_WALLET / WEATHER_API_SECRET)
 * keep working without a rename cascade. Only the content is new.
 */
import express from "express";
import { paymentMiddleware } from "@x402/express";
import {
  assertDistinctServiceWallet,
  createStellarX402Server,
  env,
  selfRegister,
} from "./shared.js";

const PORT = Number(env("PORT_WEATHER_API", "4001"));
const WALLET = env("WEATHER_API_WALLET");
assertDistinctServiceWallet("Crypto Price Oracle", "WEATHER_API_WALLET");
const app = express();

// ---------------------------------------------------------------------------
// x402 paywall — charges $0.001 per request on Stellar testnet
// ---------------------------------------------------------------------------

app.use(
  paymentMiddleware(
    {
      "/prices": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "stellar:testnet",
          payTo: WALLET,
        },
        description: "Real-time cryptocurrency prices",
        mimeType: "application/json",
      },
    },
    createStellarX402Server(),
  ),
);

// ---------------------------------------------------------------------------
// CoinGecko upstream
// ---------------------------------------------------------------------------

const COINGECKO_TIMEOUT_MS = 5_000;
/** Only assets that already appear in the demo prompts and in the
 *  analyst's default query. Extend as needed — each must be a valid
 *  CoinGecko id. */
const DEFAULT_ASSETS = "stellar";
/** Guard the `?assets=` query param against injection into the upstream
 *  URL. CoinGecko ids are lowercase alphanumeric + hyphen only (e.g.
 *  `bitcoin-cash`, `usd-coin`). */
const ASSET_ID_RE = /^[a-z0-9-]+$/;

/** Shape of CoinGecko's `/simple/price` response for the fields we pull. */
interface CoinGeckoPriceRow {
  usd?: number;
  usd_24h_change?: number;
  usd_24h_vol?: number;
  usd_market_cap?: number;
}
type CoinGeckoPriceResponse = Record<string, CoinGeckoPriceRow>;

interface NormalisedAsset {
  price_usd: string;
  change_24h_pct: string;
  volume_24h_usd: string;
  market_cap_usd: string;
}

/** Deterministic demo data used when CoinGecko is unreachable or times
 *  out. Keeps the rest of the agent network usable offline without
 *  pretending to be real — the `source: "demo-fallback"` tag lets any
 *  downstream caller see that the numbers are synthetic. */
const FALLBACK_ASSETS: Record<string, NormalisedAsset> = {
  stellar: {
    price_usd: "0.1543",
    change_24h_pct: "-0.77",
    volume_24h_usd: "9787860",
    market_cap_usd: "4890000000",
  },
  bitcoin: {
    price_usd: "84500.00",
    change_24h_pct: "1.2",
    volume_24h_usd: "23000000000",
    market_cap_usd: "1670000000000",
  },
  ethereum: {
    price_usd: "3320.00",
    change_24h_pct: "0.4",
    volume_24h_usd: "12400000000",
    market_cap_usd: "400000000000",
  },
};

function parseAssets(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [DEFAULT_ASSETS];
  }
  const ids = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.length <= 32 && ASSET_ID_RE.test(s));
  return ids.length > 0 ? ids : [DEFAULT_ASSETS];
}

function normaliseRow(row: CoinGeckoPriceRow | undefined): NormalisedAsset {
  return {
    price_usd: row?.usd !== undefined ? row.usd.toString() : "0",
    change_24h_pct:
      row?.usd_24h_change !== undefined ? row.usd_24h_change.toFixed(2) : "0",
    volume_24h_usd:
      row?.usd_24h_vol !== undefined ? Math.round(row.usd_24h_vol).toString() : "0",
    market_cap_usd:
      row?.usd_market_cap !== undefined
        ? Math.round(row.usd_market_cap).toString()
        : "0",
  };
}

function fallbackFor(ids: string[]): Record<string, NormalisedAsset> {
  const out: Record<string, NormalisedAsset> = {};
  for (const id of ids) {
    out[id] = FALLBACK_ASSETS[id] ?? {
      price_usd: "0",
      change_24h_pct: "0",
      volume_24h_usd: "0",
      market_cap_usd: "0",
    };
  }
  return out;
}

async function fetchCoinGecko(
  ids: string[],
): Promise<{ source: "coingecko" | "demo-fallback"; assets: Record<string, NormalisedAsset> }> {
  const url =
    "https://api.coingecko.com/api/v3/simple/price" +
    `?ids=${encodeURIComponent(ids.join(","))}` +
    "&vs_currencies=usd" +
    "&include_24hr_change=true" +
    "&include_24hr_vol=true" +
    "&include_market_cap=true";

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(COINGECKO_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`CoinGecko HTTP ${res.status}`);
    }
    const raw = (await res.json()) as CoinGeckoPriceResponse;
    const out: Record<string, NormalisedAsset> = {};
    for (const id of ids) {
      out[id] = normaliseRow(raw[id]);
    }
    return { source: "coingecko", assets: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[crypto_prices] CoinGecko fetch failed: ${msg}. Using fallback.`);
    return { source: "demo-fallback", assets: fallbackFor(ids) };
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/prices", async (req, res) => {
  const ids = parseAssets(req.query.assets);
  const result = await fetchCoinGecko(ids);
  res.json({
    assets: result.assets,
    source: result.source,
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "crypto_prices",
    protocol: "x402",
    port: PORT,
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[Crypto Price Oracle] :${PORT} (x402)`);

  // Register under the service's OWN wallet so the dashboard shows the
  // ownership edge from the crypto wallet node to the crypto service node.
  selfRegister({
    name: "crypto_prices",
    url: `http://localhost:${PORT}`,
    capability: "crypto_prices",
    priceStroops: 10_000n, // $0.001
    protocol: "x402",
    secretKey: process.env.WEATHER_API_SECRET,
  }).catch(() => {});
});
