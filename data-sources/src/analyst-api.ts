import express from "express";
import { spawn } from "child_process";
import { paymentMiddleware } from "@x402/express";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactStellarScheme, createEd25519Signer } from "@x402/stellar";
import { createStellarX402Server, selfRegister, env } from "./shared.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(env("PORT_ANALYST_API", "4004"));
const ANALYST_WALLET = env("ANALYST_PUBLIC_KEY");
const ANALYST_SECRET = env("ANALYST_PRIVATE_KEY");
const PRICE = "$0.005";

// ---------------------------------------------------------------------------
// Analyst x402 client — for SPENDING on crypto prices + news data.
// Uses the analyst's OWN keypair, not the main agent keypair.
// Follows the exact pattern from src/config.ts.
// ---------------------------------------------------------------------------

const analystSigner = createEd25519Signer(
  ANALYST_SECRET,
  "stellar:testnet" as `${string}:${string}`,
);
const analystX402 = new x402Client();
analystX402.register("stellar:*", new ExactStellarScheme(analystSigner));

const analystFetch: typeof globalThis.fetch = wrapFetchWithPayment(
  globalThis.fetch,
  analystX402,
);

// ---------------------------------------------------------------------------
// LLM call — priority: claude -p (OAuth) → Anthropic API → raw data fallback.
//
// `claude -p` is preferred because it uses the user's Claude subscription
// via OAuth, requiring no API key. We do NOT pass --bare (which would
// disable OAuth and force ANTHROPIC_API_KEY auth). We use spawn with
// explicit stdin.write()+stdin.end() to avoid the subprocess-stdin-hang
// bug fixed in Claude Code 2.1.80+.
// ---------------------------------------------------------------------------

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_MAX_TOKENS = 1024;
const ANTHROPIC_TIMEOUT_MS = 30_000;
const CLAUDE_P_TIMEOUT_MS = 55_000; // stay under Claude Desktop's 60s MCP tool cap
const ANALYST_MODEL =
  process.env.ANALYST_CLAUDE_MODEL || "claude-sonnet-4-6";

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
      ["-p", "--model", ANALYST_MODEL, "--output-format", "text"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: CLAUDE_P_TIMEOUT_MS,
        // Inherit env (including PATH and OAuth keychain access).
        // Do NOT inject ANTHROPIC_API_KEY — let OAuth handle auth.
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

    // Write prompt and close stdin so claude -p knows input is done.
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
    // Sanitize: never echo the api key into errors (CLAUDE.md Rule 4)
    throw new Error(
      `Anthropic API error ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as AnthropicResponse;
  const blocks = data.content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return "No analysis generated";
  }
  const textBlock = blocks.find(
    (b): b is AnthropicContentBlock =>
      typeof b === "object" && b !== null && b.type === "text",
  );
  return typeof textBlock?.text === "string" && textBlock.text.length > 0
    ? textBlock.text
    : "No analysis generated";
}

async function callLLM(prompt: string): Promise<string> {
  // Priority 1: claude -p (OAuth subscription, no API key needed)
  if (llmMode === "claude-p") {
    try {
      return await callClaudeHeadless(prompt);
    } catch (err) {
      console.warn(
        `[analyst] claude -p failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Priority 2: direct Anthropic API
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await callAnthropicAPI(prompt);
    } catch (err) {
      console.warn(
        `[analyst] anthropic API failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new Error("LLM_UNAVAILABLE");
}

async function detectLLMMode(): Promise<LLMMode> {
  try {
    const out = await callClaudeHeadless('Respond with exactly: ok');
    if (out.toLowerCase().includes("ok")) return "claude-p";
  } catch {
    // fall through
  }
  if (process.env.ANTHROPIC_API_KEY) return "api";
  return "none";
}

// ---------------------------------------------------------------------------
// Express app + x402 paywall (EARNING side)
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.use(
  paymentMiddleware(
    {
      "/analyze": {
        accepts: {
          scheme: "exact",
          price: PRICE,
          network: "stellar:testnet",
          payTo: ANALYST_WALLET,
        },
        description: "AI-powered analysis using live data from paid APIs",
        mimeType: "application/json",
      },
    },
    createStellarX402Server(),
  ),
);

// ---------------------------------------------------------------------------
// POST /analyze — two modes:
//
//   1. PRE-PROVIDED: caller already fetched the data (Claude-via-MCP pattern).
//      The analyst skips the paid crypto-prices/news fetches and sends the
//      data straight to the LLM. Stays under Claude Desktop's 60s MCP tool cap.
//
//   2. FETCHED: caller only sent a query/task. The analyst spends its own
//      USDC on crypto prices + news via x402, then reasons over them.
//
// The x402 paywall wraps both paths — the analyst charges $0.005 for the
// analysis service regardless of whether the data was supplied.
// ---------------------------------------------------------------------------

const MAX_STORIES = 20;
const MAX_RAW_DATA_CHARS = 8000;

interface AnalysisRequestBody {
  query?: unknown;
  task?: unknown;
  data?: unknown;
  stories?: unknown;
}

interface PreProvidedPayload {
  serialized: string;
  itemCount: number;
  originalCount: number;
  source: "data.stories" | "stories" | "data";
}

function extractPreProvided(body: AnalysisRequestBody): PreProvidedPayload | null {
  const dataObj =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : null;

  // 1) body.data.stories — the shape Claude's MCP bridge actually sends
  const dataStories = dataObj?.stories;
  if (Array.isArray(dataStories) && dataStories.length > 0) {
    const limited = dataStories.slice(0, MAX_STORIES);
    return {
      serialized: JSON.stringify(limited, null, 2),
      itemCount: limited.length,
      originalCount: dataStories.length,
      source: "data.stories",
    };
  }

  // 2) body.stories at top level — simpler variant some clients use
  if (Array.isArray(body.stories) && body.stories.length > 0) {
    const limited = body.stories.slice(0, MAX_STORIES);
    return {
      serialized: JSON.stringify(limited, null, 2),
      itemCount: limited.length,
      originalCount: body.stories.length,
      source: "stories",
    };
  }

  // 3) body.data is a non-empty object without `stories` — serialize it whole
  if (dataObj && Object.keys(dataObj).length > 0) {
    return {
      serialized: JSON.stringify(dataObj, null, 2).slice(0, MAX_RAW_DATA_CHARS),
      itemCount: 1,
      originalCount: 1,
      source: "data",
    };
  }

  return null;
}

function extractQuery(body: AnalysisRequestBody): string | null {
  if (typeof body.query === "string" && body.query.trim()) return body.query.trim();
  if (typeof body.task === "string" && body.task.trim()) return body.task.trim();
  return null;
}

app.post("/analyze", async (req, res) => {
  const startTime = Date.now();
  const body = (req.body ?? {}) as AnalysisRequestBody;
  const earned = 50_000; // $0.005 from caller
  const llmCostEstimate = 10_000; // ~$0.001 estimated

  // Client disconnect detection. The close event fires on every request
  // (including normal completion), so we use res.writableFinished to
  // distinguish "client gave up" from "we just finished responding".
  // Express #6334: on POST with express.json(), close can fire immediately
  // after body parsing if the client already disconnected — the flag
  // catches this. req.socket.destroyed is the final safety net before
  // res.json() to avoid writing to a dead socket.
  let clientDisconnected = false;
  req.on("close", () => {
    if (!res.writableFinished) {
      clientDisconnected = true;
      console.warn(
        `[analyst] Client disconnected during processing (${Date.now() - startTime}ms)`,
      );
    }
  });

  try {
    const preProvided = extractPreProvided(body);

    // -----------------------------------------------------------------------
    // MODE 1: Pre-provided data — LLM only, no paid fetches
    // -----------------------------------------------------------------------
    if (preProvided) {
      if (preProvided.originalCount > preProvided.itemCount) {
        console.log(
          `[analyst] Truncated to ${preProvided.itemCount} stories (received ${preProvided.originalCount})`,
        );
      }
      console.log(
        `[analyst] Using pre-provided data (${preProvided.itemCount} items from ${preProvided.source}, skipping fetch)`,
      );

      const task = extractQuery(body) || "Analyze the following data";
      const prompt = `${task}

DATA:
${preProvided.serialized}

Provide a concise 2-3 paragraph analysis that identifies key themes, notable patterns, and actionable insights. Reference specific items by title where relevant.`;

      let analysis: string;
      try {
        analysis = await callLLM(prompt);
      } catch (llmErr) {
        console.error(
          `[analyst] LLM failed: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`,
        );
        analysis = `LLM unavailable. Raw data follows:\n\n${preProvided.serialized.slice(0, 2000)}`;
      }

      if (clientDisconnected || req.socket.destroyed) {
        console.warn(
          `[analyst] Client gone after LLM completed (${Date.now() - startTime}ms, pre-provided). Analysis discarded.`,
        );
        return;
      }

      const llmAvailable = llmMode !== "none" && !analysis.startsWith("LLM unavailable.");
      console.log(
        `[analyst] Analysis complete in ${Date.now() - startTime}ms (pre-provided, ${preProvided.itemCount} stories)`,
      );
      res.json({
        analysis,
        query: task,
        mode: "pre-provided",
        stories_count: preProvided.itemCount,
        sources: { provided: true },
        economics: {
          earned_stroops: earned,
          spent_on_data_stroops: 0,
          spent_on_llm_stroops: llmCostEstimate,
          profit_stroops: earned - llmCostEstimate,
        },
        processing_time_ms: Date.now() - startTime,
        agent: "analyst",
        llm_mode: llmAvailable
          ? llmMode
          : "raw_data_fallback",
      });
      return;
    }

    // -----------------------------------------------------------------------
    // MODE 2: Query-only — fetch crypto prices + news via x402
    // -----------------------------------------------------------------------
    const query = extractQuery(body);
    if (!query) {
      res.status(400).json({
        error: "missing_input",
        message:
          "Provide one of: 'query' (string), 'task' (string), or 'data.stories' (array)",
      });
      return;
    }

    console.log(`[analyst] Fetching crypto prices + news for: "${query}"`);

    const pricesPort = env("PORT_WEATHER_API", "4001");
    const newsPort = env("PORT_NEWS_API", "4002");
    const pricesUrl =
      `http://localhost:${pricesPort}/prices` +
      "?assets=stellar,bitcoin,ethereum";

    const [pricesRes, newsRes] = await Promise.allSettled([
      analystFetch(pricesUrl, {
        signal: AbortSignal.timeout(15_000),
      }),
      analystFetch(`http://localhost:${newsPort}/news`, {
        signal: AbortSignal.timeout(15_000),
      }),
    ]);

    let pricesText = "Crypto prices unavailable";
    let newsText = "News data unavailable";
    let spentOnPricesStroops = 0;
    let spentOnNewsStroops = 0;

    if (pricesRes.status === "fulfilled") {
      pricesText = await pricesRes.value.text();
      spentOnPricesStroops = 10_000; // $0.001
    }
    if (newsRes.status === "fulfilled") {
      newsText = await newsRes.value.text();
      spentOnNewsStroops = 10_000; // $0.001
    }

    const prompt = `You are a data analyst agent. Based on the following real-time data, provide a brief analysis for: "${query}"

CRYPTO PRICES:
${pricesText.slice(0, 2000)}

NEWS DATA:
${newsText.slice(0, 2000)}

Provide a concise 2-3 paragraph analysis connecting relevant data points to the query. Be specific about the data you reference.`;

    let analysis: string;
    try {
      analysis = await callLLM(prompt);
    } catch (llmErr) {
      console.error(
        `[analyst] LLM failed: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`,
      );
      analysis = `LLM unavailable. Raw data follows:\n\nPrices: ${pricesText.slice(0, 500)}\n\nNews: ${newsText.slice(0, 500)}`;
    }

    if (clientDisconnected || req.socket.destroyed) {
      console.warn(
        `[analyst] Client gone after LLM completed (${Date.now() - startTime}ms, fetched). Analysis discarded.`,
      );
      return;
    }

    const dataSpentStroops = spentOnPricesStroops + spentOnNewsStroops;
    const llmAvailable = llmMode !== "none" && !analysis.startsWith("LLM unavailable.");
    console.log(
      `[analyst] Analysis complete in ${Date.now() - startTime}ms (fetched, query: "${query.slice(0, 40)}")`,
    );
    res.json({
      analysis,
      query,
      mode: "fetched",
      sources: {
        crypto_prices: pricesRes.status === "fulfilled",
        news: newsRes.status === "fulfilled",
      },
      economics: {
        earned_stroops: earned,
        spent_on_prices_stroops: spentOnPricesStroops,
        spent_on_news_stroops: spentOnNewsStroops,
        spent_on_llm_stroops: llmCostEstimate,
        profit_stroops: earned - dataSpentStroops - llmCostEstimate,
      },
      processing_time_ms: Date.now() - startTime,
      agent: "analyst",
      llm_mode: llmAvailable ? llmMode : "raw_data_fallback",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[analyst] Analysis failed:", msg);
    if (clientDisconnected || req.socket.destroyed) {
      console.warn(
        `[analyst] Client gone; skipping error response (${Date.now() - startTime}ms)`,
      );
      return;
    }
    res.status(500).json({ error: "analysis_failed", message: msg });
  }
});

// ---------------------------------------------------------------------------
// Health check — free, no paywall
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "analyst",
    protocol: "x402",
    port: PORT,
    llm_mode: llmMode === "none" ? "raw_data_fallback" : llmMode,
    llm_model:
      llmMode === "api"
        ? ANTHROPIC_MODEL
        : llmMode === "claude-p"
          ? ANALYST_MODEL
          : "n/a",
    wallet: ANALYST_WALLET,
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, async () => {
  console.log(`[Analyst API] :${PORT} (x402)`);
  console.log(`[analyst] Wallet: ${ANALYST_WALLET}`);

  llmMode = await detectLLMMode();
  if (llmMode === "claude-p") {
    console.log(`[analyst] LLM mode: claude-p (${ANALYST_MODEL}, OAuth)`);
  } else if (llmMode === "api") {
    console.log(`[analyst] LLM mode: api (${ANTHROPIC_MODEL})`);
  } else {
    console.warn("[analyst] ⚠ No LLM available. Analysis will return raw data only.");
    console.warn("[analyst]   Fix: install Claude Code (https://claude.ai/install.sh)");
    console.warn("[analyst]   Or:  set ANTHROPIC_API_KEY in .env");
  }

  // Register the analyst under its OWN wallet. The analyst already
  // has a dedicated keypair (ANALYST_PRIVATE_KEY) used for the x402
  // client signer above; it's also the correct owner for the trust
  // registry entry so the dashboard connects the analyst service node
  // to the analyst wallet node.
  selfRegister({
    name: "analyst",
    url: `http://localhost:${PORT}`,
    capability: "analysis",
    priceStroops: 50_000n, // $0.005
    protocol: "x402",
    secretKey: ANALYST_SECRET,
  }).catch(() => {});
});
