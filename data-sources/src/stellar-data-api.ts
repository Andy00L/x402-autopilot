/**
 * Market Intelligence Agent (MPP + x402) — port 4003
 *
 * Two endpoints on the same app, each with its own paywall stack so
 * the old MPP flow and the new x402 flow can coexist:
 *
 *   GET  /stellar-stats   — $0.002, MPP charge protocol. Unchanged,
 *                           route-level mppx.charge middleware. Raw
 *                           Stellar network data. Other agents (the
 *                           market report path below, the analyst)
 *                           can read this if they want the raw feed.
 *
 *   POST /market-report   — $0.005, x402. The intelligence layer. The
 *                           agent spends its own USDC on crypto prices
 *                           (port 4001) and raw news (port 4002), then
 *                           merges them with its own Stellar network
 *                           data and asks Claude to produce a full
 *                           market report.
 *
 * Coexistence: the x402 paymentMiddleware is app-level but keyed only
 * on "/market-report", so requests to "/stellar-stats" pass through it
 * untouched and hit the route-level mppx.charge on the matching
 * app.get handler. This is the same pass-through behaviour used by
 * /health in news-api.ts and analyst-api.ts.
 */
import express from "express";
import { spawn } from "child_process";
import { paymentMiddleware } from "@x402/express";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactStellarScheme, createEd25519Signer } from "@x402/stellar";
import { Mppx } from "mppx/express";
import { stellar, Store } from "@stellar/mpp/charge/server";
import { USDC_SAC_TESTNET } from "@stellar/mpp";
import {
  assertDistinctServiceWallet,
  createStellarX402Server,
  env,
  selfRegister,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(env("PORT_STELLAR_DATA_API", "4003"));
const RECIPIENT = env("STELLAR_DATA_API_WALLET");
const SECRET = env("STELLAR_DATA_API_SECRET");
assertDistinctServiceWallet("Market Intelligence Agent", "STELLAR_DATA_API_WALLET");

const PRICE_MARKET_REPORT = "$0.005";
const EARNED_REPORT_STROOPS = 50_000; // $0.005
const PRICES_SUBPURCHASE_STROOPS = 10_000; // $0.001
const NEWS_SUBPURCHASE_STROOPS = 10_000; // $0.001
const LLM_COST_ESTIMATE_STROOPS = 10_000; // ~$0.001

// ---------------------------------------------------------------------------
// Built-in Stellar network data — the exact payload served behind the
// MPP paywall on /stellar-stats. Shared with /market-report so that
// path doesn't need to pay itself for data it already has in memory.
// ---------------------------------------------------------------------------

const STELLAR_NETWORK_DATA = {
  accounts: 8_200_000,
  daily_transactions: 1_400_000,
  tvl_usd: 45_000_000,
  usdc_volume_24h: 12_500_000,
  source: "x402-autopilot-demo",
} as const;

// ---------------------------------------------------------------------------
// x402 CLIENT — for SPENDING on crypto prices + raw news. Uses the
// agent's OWN keypair so sub-purchases show up on the dashboard as
// spends from the market wallet. Follows analyst-api.ts exactly.
// ---------------------------------------------------------------------------

const agentSigner = createEd25519Signer(
  SECRET,
  "stellar:testnet" as `${string}:${string}`,
);
const agentX402 = new x402Client();
agentX402.register("stellar:*", new ExactStellarScheme(agentSigner));

const agentFetch: typeof globalThis.fetch = wrapFetchWithPayment(
  globalThis.fetch,
  agentX402,
);

// ---------------------------------------------------------------------------
// LLM call — claude -p first, Anthropic API fallback, raw-data fallback.
// Same shape as analyst-api.ts / news-api.ts, with a per-agent model
// env var.
// ---------------------------------------------------------------------------

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_MAX_TOKENS = 1024;
const ANTHROPIC_TIMEOUT_MS = 30_000;
const CLAUDE_P_TIMEOUT_MS = 55_000; // under Claude Desktop's 60 s MCP cap
const MARKET_MODEL = process.env.MARKET_CLAUDE_MODEL || "claude-sonnet-4-6";

type LLMMode = "claude-p" | "api" | "none";
let llmMode: LLMMode = "none";

interface AnthropicContentBlock {
  type?: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
}

function callClaudeHeadless(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", "--model", MARKET_MODEL, "--output-format", "text"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: CLAUDE_P_TIMEOUT_MS,
      },
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`claude -p spawn failed: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            `claude -p exited ${code}: ${stderr.slice(0, 200) || "no stderr"}`,
          ),
        );
      }
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

async function callAnthropicAPI(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Anthropic API error ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as AnthropicResponse;
  const blocks = data.content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return "No report generated";
  }
  const textBlock = blocks.find(
    (b): b is AnthropicContentBlock =>
      typeof b === "object" && b !== null && b.type === "text",
  );
  return typeof textBlock?.text === "string" && textBlock.text.length > 0
    ? textBlock.text
    : "No report generated";
}

async function callLLM(prompt: string): Promise<string> {
  if (llmMode === "claude-p") {
    try {
      return await callClaudeHeadless(prompt);
    } catch (err) {
      console.warn(
        `[market_intelligence] claude -p failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await callAnthropicAPI(prompt);
    } catch (err) {
      console.warn(
        `[market_intelligence] anthropic API failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new Error("LLM_UNAVAILABLE");
}

async function detectLLMMode(): Promise<LLMMode> {
  try {
    const out = await callClaudeHeadless("Respond with exactly: ok");
    if (out.toLowerCase().includes("ok")) return "claude-p";
  } catch {
    /* fall through */
  }
  if (process.env.ANTHROPIC_API_KEY) return "api";
  return "none";
}

// ---------------------------------------------------------------------------
// Autonomous market monitoring
//
// Every MONITOR_INTERVAL_MS the market agent independently buys fresh
// crypto prices from the price oracle (:4001). This serves two purposes:
//
//   1. Keeps a warm cache so /market-report callers don't always pay the
//      crypto-prices sub-purchase cost on every request. The cache is
//      considered fresh for `CACHE_MAX_AGE_MS` and is then refilled
//      either by the next monitor tick or by the next /market-report
//      handler that misses it.
//
//   2. Creates visible autonomous agent activity on the dashboard — the
//      bullet animation fires from the market agent's wallet to the
//      crypto-prices wallet without any human in the loop. The dashboard
//      feels alive even when no one is making MCP requests.
//
// The monitor never throws — failures are logged and the next tick
// retries. The setInterval is left to the process exit (the CLI
// dashboard kills the process group on shutdown).
// ---------------------------------------------------------------------------

const MONITOR_INTERVAL_MS = 90_000; // 90 s between background refreshes
const MONITOR_WARMUP_MS = 30_000;   // wait this long after start before the first refresh
const CACHE_MAX_AGE_MS = 120_000;   // /market-report uses cache if it's younger than this

interface PricesCache {
  text: string;
  fetchedAt: number;
}
let cachedPrices: PricesCache | null = null;

function isPricesCacheFresh(): boolean {
  return cachedPrices !== null && Date.now() - cachedPrices.fetchedAt < CACHE_MAX_AGE_MS;
}

async function monitorPrices(): Promise<void> {
  const pricesPort = env("PORT_WEATHER_API", "4001");
  const pricesUrl =
    `http://localhost:${pricesPort}/prices` +
    "?assets=stellar,bitcoin,ethereum";
  try {
    const res = await agentFetch(pricesUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(
        `[market_intelligence] Background price refresh: HTTP ${res.status}`,
      );
      return;
    }
    cachedPrices = { text: await res.text(), fetchedAt: Date.now() };
    console.log("[market_intelligence] Background price refresh complete");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[market_intelligence] Background price refresh failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ── x402 paywall for /market-report only ────────────────────────────────
// Enforces payment ONLY on /market-report. Requests to other paths
// (/stellar-stats, /health) pass through unchanged and hit their own
// per-route middleware. Same pattern used by news-api.ts and
// analyst-api.ts for /health.
app.use(
  paymentMiddleware(
    {
      "/market-report": {
        accepts: {
          scheme: "exact",
          price: PRICE_MARKET_REPORT,
          network: "stellar:testnet",
          payTo: RECIPIENT,
        },
        description:
          "AI-powered market intelligence report combining prices, news, and Stellar network data",
        mimeType: "application/json",
      },
    },
    createStellarX402Server(),
  ),
);

// ── MPP paywall for /stellar-stats (unchanged) ──────────────────────────
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
      ...STELLAR_NETWORK_DATA,
      timestamp: new Date().toISOString(),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /market-report — the intelligence endpoint. Spends on /prices
// and /news, merges with built-in Stellar data, asks Claude to reason
// over all three.
// ---------------------------------------------------------------------------

interface MarketReportRequestBody {
  query?: unknown;
}

function extractQuery(body: MarketReportRequestBody): string {
  if (typeof body.query === "string" && body.query.trim()) {
    return body.query.trim();
  }
  return "Full market intelligence report on Stellar XLM";
}

app.post("/market-report", async (req, res) => {
  const startTime = Date.now();
  const body = (req.body ?? {}) as MarketReportRequestBody;
  const query = extractQuery(body);

  // Client-disconnect detection — same pattern as analyst-api.ts.
  let clientDisconnected = false;
  req.on("close", () => {
    if (!res.writableFinished) {
      clientDisconnected = true;
      console.warn(
        `[market_intelligence] Client disconnected during processing (${Date.now() - startTime}ms)`,
      );
    }
  });

  try {
    console.log(`[market_intelligence] Building report for: "${query.slice(0, 60)}"`);

    const newsPort = env("PORT_NEWS_API", "4002");
    const newsUrl = `http://localhost:${newsPort}/news`;

    let pricesText = "Crypto prices unavailable";
    let newsText = "News data unavailable";
    let spentOnPricesStroops = 0;
    let spentOnNewsStroops = 0;
    let pricesAvailable = false;
    let newsAvailable = false;
    let pricesFromCache = false;

    // Background monitor keeps a warm cache so the typical /market-report
    // request hits memory instead of paying for fresh prices on every
    // call. We only buy from :4001 when the cache is stale or missing.
    if (isPricesCacheFresh() && cachedPrices) {
      pricesText = cachedPrices.text;
      pricesAvailable = true;
      pricesFromCache = true;
      const ageS = Math.round((Date.now() - cachedPrices.fetchedAt) / 1000);
      console.log(
        `[market_intelligence] Using cached prices (age ${ageS}s, no x402 spend)`,
      );
    }

    // Fire the news fetch (always paid) and — only if the cache missed
    // — the prices fetch in parallel.
    const pricesPort = env("PORT_WEATHER_API", "4001");
    const pricesUrl =
      `http://localhost:${pricesPort}/prices` +
      "?assets=stellar,bitcoin,ethereum";
    const inflight: Array<Promise<unknown>> = [
      agentFetch(newsUrl, { signal: AbortSignal.timeout(15_000) })
        .then(async (res) => {
          if (res.ok) {
            newsText = await res.text();
            newsAvailable = true;
            spentOnNewsStroops = NEWS_SUBPURCHASE_STROOPS;
          }
        })
        .catch((err: unknown) => {
          console.warn(
            `[market_intelligence] /news fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }),
    ];
    if (!pricesFromCache) {
      inflight.push(
        agentFetch(pricesUrl, { signal: AbortSignal.timeout(15_000) })
          .then(async (res) => {
            if (res.ok) {
              pricesText = await res.text();
              pricesAvailable = true;
              spentOnPricesStroops = PRICES_SUBPURCHASE_STROOPS;
              // Backfill the cache so subsequent requests within the
              // window also hit memory.
              cachedPrices = { text: pricesText, fetchedAt: Date.now() };
            }
          })
          .catch((err: unknown) => {
            console.warn(
              `[market_intelligence] /prices fetch failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
      );
    }
    await Promise.all(inflight);

    const stellarJson = JSON.stringify(STELLAR_NETWORK_DATA, null, 2);

    const prompt = `You are a market intelligence agent. You were paid to produce a market report.

CRYPTO PRICES:
${pricesText.slice(0, 2000)}

NEWS HEADLINES:
${newsText.slice(0, 2000)}

STELLAR NETWORK DATA:
${stellarJson}

USER QUERY: ${query}

Produce a market intelligence report that:
1. Analyzes XLM price action in context of broader crypto market
2. Correlates headline events with price movements
3. Assesses Stellar network health and on-chain activity
4. Provides risk assessment and market sentiment
5. Stays factual. Clearly separate observations from interpretations.`;

    let report: string;
    let llmAvailable = false;
    try {
      report = await callLLM(prompt);
      llmAvailable = llmMode !== "none";
    } catch (llmErr) {
      console.error(
        `[market_intelligence] LLM failed: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`,
      );
      report =
        `LLM unavailable. Raw data follows:\n\n` +
        `Prices: ${pricesText.slice(0, 500)}\n\n` +
        `News: ${newsText.slice(0, 500)}\n\n` +
        `Stellar: ${stellarJson.slice(0, 500)}`;
    }

    if (clientDisconnected || req.socket.destroyed) {
      console.warn(
        `[market_intelligence] Client gone after LLM completed (${Date.now() - startTime}ms). Report discarded.`,
      );
      return;
    }

    const spentOnLlm = llmAvailable ? LLM_COST_ESTIMATE_STROOPS : 0;
    const profit =
      EARNED_REPORT_STROOPS -
      spentOnPricesStroops -
      spentOnNewsStroops -
      spentOnLlm;

    console.log(
      `[market_intelligence] Report complete in ${Date.now() - startTime}ms (prices=${pricesAvailable}, news=${newsAvailable}, llm=${llmAvailable ? llmMode : "raw_data_fallback"})`,
    );

    res.json({
      report,
      query,
      sources: {
        crypto_prices: pricesAvailable,
        news: newsAvailable,
        stellar_network: true,
      },
      economics: {
        earned_stroops: EARNED_REPORT_STROOPS,
        spent_on_prices_stroops: spentOnPricesStroops,
        spent_on_news_stroops: spentOnNewsStroops,
        spent_on_llm_stroops: spentOnLlm,
        profit_stroops: profit,
      },
      processing_time_ms: Date.now() - startTime,
      agent: "market_intelligence",
      llm_mode: llmAvailable ? llmMode : "raw_data_fallback",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[market_intelligence] Report failed:", msg);
    if (clientDisconnected || req.socket.destroyed) {
      console.warn(
        `[market_intelligence] Client gone; skipping error response (${Date.now() - startTime}ms)`,
      );
      return;
    }
    res.status(500).json({ error: "market_report_failed", message: msg });
  }
});

// ---------------------------------------------------------------------------
// Health check — free, no paywall
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "market_intelligence",
    protocol: "mpp+x402",
    port: PORT,
    llm_mode: llmMode === "none" ? "raw_data_fallback" : llmMode,
    llm_model:
      llmMode === "api"
        ? ANTHROPIC_MODEL
        : llmMode === "claude-p"
          ? MARKET_MODEL
          : "n/a",
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, async () => {
  console.log(`[Market Intelligence] :${PORT} (MPP + x402)`);

  llmMode = await detectLLMMode();
  if (llmMode === "claude-p") {
    console.log(
      `[market_intelligence] LLM mode: claude-p (${MARKET_MODEL}, OAuth)`,
    );
  } else if (llmMode === "api") {
    console.log(`[market_intelligence] LLM mode: api (${ANTHROPIC_MODEL})`);
  } else {
    console.warn(
      "[market_intelligence] ⚠ No LLM available. /market-report will return raw merged data only.",
    );
    console.warn(
      "[market_intelligence]   Fix: install Claude Code (https://claude.ai/install.sh)",
    );
    console.warn(
      "[market_intelligence]   Or:  set ANTHROPIC_API_KEY in .env",
    );
  }

  // Register twice: once for raw stellar data ("blockchain") and once
  // for the enriched report ("market-intelligence"). The trust-registry
  // dedupes URLs per capability, so the same URL under two different
  // capabilities is allowed (contracts/trust-registry/src/lib.rs:113).
  selfRegister({
    name: "stellar_data",
    url: `http://localhost:${PORT}/stellar-stats`,
    capability: "blockchain",
    priceStroops: 20_000n, // $0.002
    protocol: "mpp",
    secretKey: process.env.STELLAR_DATA_API_SECRET,
  }).catch(() => {});

  selfRegister({
    name: "market_intelligence",
    url: `http://localhost:${PORT}/market-report`,
    capability: "market_intelligence",
    priceStroops: 50_000n, // $0.005
    protocol: "x402",
    secretKey: process.env.STELLAR_DATA_API_SECRET,
  }).catch(() => {});

  // Kick off the autonomous price monitor after a short warm-up so the
  // price oracle has time to register and the agent's wallet has time
  // to load any pending USDC. The first refresh runs immediately at
  // the warm-up boundary; subsequent refreshes are spaced by
  // MONITOR_INTERVAL_MS. Errors are logged inside monitorPrices(); we
  // never let them escape into this callback.
  setTimeout(() => {
    void monitorPrices();
    setInterval(() => {
      void monitorPrices();
    }, MONITOR_INTERVAL_MS);
    console.log(
      `[market_intelligence] Autonomous price monitoring started (every ${MONITOR_INTERVAL_MS / 1000}s)`,
    );
  }, MONITOR_WARMUP_MS);
});
