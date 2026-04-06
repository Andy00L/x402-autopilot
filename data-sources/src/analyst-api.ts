import express from "express";
import { paymentMiddleware } from "@x402/express";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactStellarScheme, createEd25519Signer } from "@x402/stellar";
import { createStellarX402Server, selfRegister, env } from "./shared.js";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(env("PORT_ANALYST_API", "4004"));
const ANALYST_WALLET = env("ANALYST_PUBLIC_KEY");
const ANALYST_SECRET = env("ANALYST_PRIVATE_KEY");
const PRICE = "$0.005";

// ---------------------------------------------------------------------------
// Analyst x402 client — for SPENDING on weather + news data
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
// LLM call — dual mode: Anthropic API or Claude Code headless
// ---------------------------------------------------------------------------

const HAS_API_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

async function callAnthropicAPI(prompt: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const content = data.content;
  if (!Array.isArray(content)) return "No analysis generated";
  const textBlock = content.find(
    (b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text",
  ) as Record<string, unknown> | undefined;
  return typeof textBlock?.text === "string" ? textBlock.text : "No analysis generated";
}

async function callClaudeHeadless(prompt: string): Promise<string> {
  const tmpFile = join(tmpdir(), `analyst-prompt-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt, "utf-8");
  try {
    const { stdout } = await execAsync(
      `cat "${tmpFile}" | claude -p --output-format text --bare`,
      { timeout: 60_000 },
    );
    return stdout.trim() || "No analysis generated";
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

async function callLLM(prompt: string): Promise<string> {
  if (HAS_API_KEY) return callAnthropicAPI(prompt);
  return callClaudeHeadless(prompt);
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
// POST /analyze — the core agent logic
// 1. SPEND money to buy raw data (weather + news)
// 2. REASON with LLM
// 3. RETURN analysis with cost breakdown
// ---------------------------------------------------------------------------

app.post("/analyze", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query : "general analysis";
  const startTime = Date.now();

  try {
    // Step 1: SPEND money to acquire raw data via x402 (analyst's own wallet)
    const weatherPort = env("PORT_WEATHER_API", "4001");
    const newsPort = env("PORT_NEWS_API", "4002");

    const [weatherRes, newsRes] = await Promise.allSettled([
      analystFetch(`http://localhost:${weatherPort}/weather`, {
        signal: AbortSignal.timeout(15_000),
      }),
      analystFetch(`http://localhost:${newsPort}/news`, {
        signal: AbortSignal.timeout(15_000),
      }),
    ]);

    let weatherText = "Weather data unavailable";
    let newsText = "News data unavailable";
    let dataSpentStroops = 0;

    if (weatherRes.status === "fulfilled") {
      weatherText = await weatherRes.value.text();
      dataSpentStroops += 10_000; // $0.001
    }
    if (newsRes.status === "fulfilled") {
      newsText = await newsRes.value.text();
      dataSpentStroops += 10_000; // $0.001
    }

    // Step 2: REASON with LLM
    const prompt = `You are a data analyst agent. Based on the following real-time data, provide a brief analysis for: "${query}"

WEATHER DATA:
${weatherText.slice(0, 2000)}

NEWS DATA:
${newsText.slice(0, 2000)}

Provide a concise 2-3 paragraph analysis connecting relevant data points to the query. Be specific about the data you reference.`;

    const analysis = await callLLM(prompt);
    const llmCostEstimate = 10_000; // ~$0.001 estimated

    // Step 3: Return analysis with economics breakdown
    const earned = 50_000; // $0.005 from caller
    res.json({
      analysis,
      query,
      sources: {
        weather: weatherRes.status === "fulfilled",
        news: newsRes.status === "fulfilled",
      },
      economics: {
        earned_stroops: earned,
        spent_on_data_stroops: dataSpentStroops,
        spent_on_llm_stroops: llmCostEstimate,
        profit_stroops: earned - dataSpentStroops - llmCostEstimate,
      },
      processing_time_ms: Date.now() - startTime,
      agent: "analyst",
      llm_mode: HAS_API_KEY ? "anthropic_api" : "claude_headless",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[analyst] Analysis failed:", msg);
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
    llm_mode: HAS_API_KEY ? "anthropic_api" : "claude_headless",
    wallet: ANALYST_WALLET,
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[Analyst API] :${PORT} (x402)`);
  console.log(`[analyst] LLM mode: ${HAS_API_KEY ? "Anthropic API" : "Claude Code headless (claude -p)"}`);
  console.log(`[analyst] Wallet: ${ANALYST_WALLET}`);

  selfRegister({
    name: "analyst",
    url: `http://localhost:${PORT}`,
    capability: "analysis",
    priceStroops: 50_000n, // $0.005
    protocol: "x402",
  }).catch(() => {});
});
