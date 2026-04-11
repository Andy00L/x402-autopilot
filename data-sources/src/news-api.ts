/**
 * News Intelligence Agent (x402) — port 4002
 *
 * Two endpoints on the same app behind the same x402 paywall:
 *
 *   GET /news      — $0.001. Raw headlines. Unchanged, backwards
 *                    compatible with the original news-api.ts. Other
 *                    agents (analyst, market intelligence) buy this.
 *
 *   POST /briefing — $0.003. The intelligence layer. The agent spends
 *                    its own USDC on crypto prices (from the port-4001
 *                    oracle), merges in its own headlines, and reasons
 *                    over both with `claude -p` to produce a contextual
 *                    market-aware news briefing.
 *
 * The x402 client, the Claude subprocess pattern, and the economics
 * reporting all follow analyst-api.ts verbatim — see the notes on each
 * section below.
 */
import express from "express";
import { spawn } from "child_process";
import { paymentMiddleware } from "@x402/express";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactStellarScheme, createEd25519Signer } from "@x402/stellar";
import {
  assertDistinctServiceWallet,
  createStellarX402Server,
  env,
  selfRegister,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(env("PORT_NEWS_API", "4002"));
const WALLET = env("NEWS_API_WALLET");
const SECRET = env("NEWS_API_SECRET");
assertDistinctServiceWallet("News Intelligence Agent", "NEWS_API_WALLET");

const PRICE_NEWS = "$0.001";
const PRICE_BRIEFING = "$0.003";
const EARNED_BRIEFING_STROOPS = 30_000; // $0.003
const PRICES_SUBPURCHASE_STROOPS = 10_000; // $0.001
const LLM_COST_ESTIMATE_STROOPS = 5_000; // ~$0.0005

// ---------------------------------------------------------------------------
// Built-in news payload — the exact data served behind the paywalled
// /news endpoint. Exported as a constant so /briefing can reference it
// without doing a self-fetch (which would pay ourselves for data we
// already have in memory).
// ---------------------------------------------------------------------------

interface Headline {
  title: string;
  summary: string;
  source: string;
}

const HEADLINES: readonly Headline[] = [
  {
    title: "Stellar Network Hits 8M Accounts",
    summary:
      "The Stellar network crossed 8 million funded accounts as USDC adoption accelerates.",
    source: "Stellar Daily",
  },
  {
    title: "x402 Protocol Gains Traction",
    summary:
      "Machine-to-machine payments via x402 are seeing 300% month-over-month growth.",
    source: "Crypto Payments Weekly",
  },
  {
    title: "Soroban Smart Contracts Go Mainnet",
    summary:
      "Stellar's Soroban platform officially launches on mainnet with 200+ deployed contracts.",
    source: "DeFi Pulse",
  },
];

// ---------------------------------------------------------------------------
// x402 CLIENT — for SPENDING on crypto prices. Uses the news agent's
// OWN keypair so the sub-purchase shows up on the dashboard as a spend
// from the news service wallet, not the main wallet. Matches the
// analyst-api.ts pattern 1:1.
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
// Identical shape to analyst-api.ts:callLLM / callClaudeHeadless /
// callAnthropicAPI / detectLLMMode, configured with a per-agent model
// env var so each agent can run a different model if the operator wants.
// ---------------------------------------------------------------------------

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_MAX_TOKENS = 1024;
const ANTHROPIC_TIMEOUT_MS = 30_000;
const CLAUDE_P_TIMEOUT_MS = 55_000; // under Claude Desktop's 60 s MCP cap
const NEWS_MODEL = process.env.NEWS_CLAUDE_MODEL || "claude-sonnet-4-6";

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
      ["-p", "--model", NEWS_MODEL, "--output-format", "text"],
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
    return "No briefing generated";
  }
  const textBlock = blocks.find(
    (b): b is AnthropicContentBlock =>
      typeof b === "object" && b !== null && b.type === "text",
  );
  return typeof textBlock?.text === "string" && textBlock.text.length > 0
    ? textBlock.text
    : "No briefing generated";
}

async function callLLM(prompt: string): Promise<string> {
  if (llmMode === "claude-p") {
    try {
      return await callClaudeHeadless(prompt);
    } catch (err) {
      console.warn(
        `[news_intelligence] claude -p failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await callAnthropicAPI(prompt);
    } catch (err) {
      console.warn(
        `[news_intelligence] anthropic API failed: ${err instanceof Error ? err.message : String(err)}`,
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
// Express app + x402 paywall (EARNING side). Both /news and /briefing
// live under the same app.use(paymentMiddleware(...)) — the middleware
// enforces payments only on configured paths, so /health still passes
// through without a paywall.
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.use(
  paymentMiddleware(
    {
      "/news": {
        accepts: {
          scheme: "exact",
          price: PRICE_NEWS,
          network: "stellar:testnet",
          payTo: WALLET,
        },
        description: "Raw technology news headlines",
        mimeType: "application/json",
      },
      "/briefing": {
        accepts: {
          scheme: "exact",
          price: PRICE_BRIEFING,
          network: "stellar:testnet",
          payTo: WALLET,
        },
        description:
          "AI-enriched news briefing with crypto market context",
        mimeType: "application/json",
      },
    },
    createStellarX402Server(),
  ),
);

// ---------------------------------------------------------------------------
// GET /news — unchanged from the original news-api.ts. Raw headlines
// served to any paying caller. This is the data source other agents
// (analyst, market intelligence) consume.
// ---------------------------------------------------------------------------

app.get("/news", (_req, res) => {
  res.json({
    headlines: HEADLINES,
    topic: "technology",
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /briefing — intelligence endpoint. Spends on /prices, merges in
// the built-in headlines, asks Claude to reason over both.
// ---------------------------------------------------------------------------

interface BriefingRequestBody {
  topic?: unknown;
}

function extractTopic(body: BriefingRequestBody): string {
  if (typeof body.topic === "string" && body.topic.trim()) {
    return body.topic.trim();
  }
  return "How are global events affecting crypto markets?";
}

app.post("/briefing", async (req, res) => {
  const startTime = Date.now();
  const body = (req.body ?? {}) as BriefingRequestBody;
  const topic = extractTopic(body);

  // Client-disconnect detection — same pattern as analyst-api.ts.
  let clientDisconnected = false;
  req.on("close", () => {
    if (!res.writableFinished) {
      clientDisconnected = true;
      console.warn(
        `[news_intelligence] Client disconnected during processing (${Date.now() - startTime}ms)`,
      );
    }
  });

  try {
    console.log(`[news_intelligence] Building briefing for: "${topic.slice(0, 60)}"`);

    // Sub-purchase: crypto prices via x402 (port 4001).
    const pricesPort = env("PORT_WEATHER_API", "4001");
    const pricesUrl =
      `http://localhost:${pricesPort}/prices` +
      "?assets=stellar,bitcoin,ethereum";

    let pricesText = "Crypto prices unavailable";
    let pricesAvailable = false;
    let spentOnPricesStroops = 0;

    try {
      const pricesRes = await agentFetch(pricesUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      if (pricesRes.ok) {
        pricesText = await pricesRes.text();
        pricesAvailable = true;
        spentOnPricesStroops = PRICES_SUBPURCHASE_STROOPS;
      } else {
        console.warn(
          `[news_intelligence] /prices returned ${pricesRes.status}`,
        );
      }
    } catch (err) {
      console.warn(
        `[news_intelligence] /prices fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const headlinesJson = JSON.stringify(HEADLINES, null, 2);

    const prompt = `You are a news intelligence agent. You were paid to produce a contextual briefing.

CURRENT CRYPTO PRICES:
${pricesText.slice(0, 2000)}

CURRENT HEADLINES:
${headlinesJson}

USER TOPIC: ${topic}

Produce a concise briefing that:
1. Identifies which headlines could affect crypto markets
2. Correlates current price movements with news events
3. Highlights risks and opportunities
4. Stays factual. Do not speculate beyond what the data supports.`;

    let briefing: string;
    let llmAvailable = false;
    try {
      briefing = await callLLM(prompt);
      llmAvailable = llmMode !== "none";
    } catch (llmErr) {
      console.error(
        `[news_intelligence] LLM failed: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`,
      );
      briefing =
        `LLM unavailable. Raw data follows:\n\n` +
        `Prices: ${pricesText.slice(0, 500)}\n\n` +
        `Headlines: ${headlinesJson.slice(0, 500)}`;
    }

    if (clientDisconnected || req.socket.destroyed) {
      console.warn(
        `[news_intelligence] Client gone after LLM completed (${Date.now() - startTime}ms). Briefing discarded.`,
      );
      return;
    }

    const spentOnLlm = llmAvailable ? LLM_COST_ESTIMATE_STROOPS : 0;
    const profit = EARNED_BRIEFING_STROOPS - spentOnPricesStroops - spentOnLlm;

    console.log(
      `[news_intelligence] Briefing complete in ${Date.now() - startTime}ms (prices=${pricesAvailable}, llm=${llmAvailable ? llmMode : "raw_data_fallback"})`,
    );

    res.json({
      briefing,
      topic,
      sources: {
        crypto_prices: pricesAvailable,
        news: true,
      },
      economics: {
        earned_stroops: EARNED_BRIEFING_STROOPS,
        spent_on_prices_stroops: spentOnPricesStroops,
        spent_on_llm_stroops: spentOnLlm,
        profit_stroops: profit,
      },
      processing_time_ms: Date.now() - startTime,
      agent: "news_intelligence",
      llm_mode: llmAvailable ? llmMode : "raw_data_fallback",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[news_intelligence] Briefing failed:", msg);
    if (clientDisconnected || req.socket.destroyed) {
      console.warn(
        `[news_intelligence] Client gone; skipping error response (${Date.now() - startTime}ms)`,
      );
      return;
    }
    res.status(500).json({ error: "briefing_failed", message: msg });
  }
});

// ---------------------------------------------------------------------------
// Health check — free, no paywall
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "news_intelligence",
    protocol: "x402",
    port: PORT,
    llm_mode: llmMode === "none" ? "raw_data_fallback" : llmMode,
    llm_model:
      llmMode === "api"
        ? ANTHROPIC_MODEL
        : llmMode === "claude-p"
          ? NEWS_MODEL
          : "n/a",
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, async () => {
  console.log(`[News Intelligence] :${PORT} (x402)`);

  llmMode = await detectLLMMode();
  if (llmMode === "claude-p") {
    console.log(`[news_intelligence] LLM mode: claude-p (${NEWS_MODEL}, OAuth)`);
  } else if (llmMode === "api") {
    console.log(`[news_intelligence] LLM mode: api (${ANTHROPIC_MODEL})`);
  } else {
    console.warn(
      "[news_intelligence] ⚠ No LLM available. /briefing will return raw merged data only.",
    );
    console.warn(
      "[news_intelligence]   Fix: install Claude Code (https://claude.ai/install.sh)",
    );
    console.warn("[news_intelligence]   Or:  set ANTHROPIC_API_KEY in .env");
  }

  // Register twice: once for raw headlines ("news") and once for the
  // enriched briefing ("briefing"). The trust-registry dedupes URLs
  // PER CAPABILITY (contracts/trust-registry/src/lib.rs:113), so the
  // same URL under two different capabilities is allowed.
  selfRegister({
    name: "news",
    url: `http://localhost:${PORT}`,
    capability: "news",
    priceStroops: 10_000n, // $0.001
    protocol: "x402",
    secretKey: process.env.NEWS_API_SECRET,
  }).catch(() => {});

  selfRegister({
    name: "news_intelligence",
    url: `http://localhost:${PORT}`,
    capability: "briefing",
    priceStroops: 30_000n, // $0.003
    protocol: "x402",
    secretKey: process.env.NEWS_API_SECRET,
  }).catch(() => {});
});
