import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { autopilotFetch } from "../../src/autopay.js";
import { discoverServices } from "../../src/discovery.js";
import { budgetTracker } from "../../src/budget-tracker.js";
import * as policyClient from "../../src/policy-client.js";
import * as registryClient from "../../src/registry-client.js";
import { PolicyDeniedError } from "../../src/types.js";
import { config } from "../../src/config.js";
import { eventBus } from "../../src/event-bus.js";
import type { AutopilotResult, ServiceInfo, BudgetInfo } from "../../src/types.js";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// BigInt-safe JSON serializer
// JSON.stringify throws on BigInt — convert to string first.
// ---------------------------------------------------------------------------

function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

// Recursively convert BigInts to strings in any value.  Used to build
// `structuredContent` payloads, which the MCP SDK serializes via JSON and
// will throw on raw BigInt.
function bigintsToStrings(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigintsToStrings);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = bigintsToStrings(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Response helpers — Claude Desktop-friendly tool result shape
//
// Lessons learned (the original "weather tool not responding" bug):
//
//   1. Wrapping the actual API payload inside `{ data, cost_stroops, ... }`
//      and JSON-stringifying the whole thing forced Claude to dig the data
//      out of a metadata envelope.  When the inner data was the natural
//      "answer" to the user's question (e.g. weather), Claude often gave up
//      and fell back to a built-in tool.  We now put the unwrapped payload
//      directly in the `content` text and keep metadata only in
//      `structuredContent`, which Claude can read for cost / tx info but
//      won't confuse with the answer.
//
//   2. `isError: true` makes Claude Desktop treat the result as a failed
//      tool call, which triggers a fallback.  Use it ONLY for genuine tool
//      failures (uncaught exceptions, missing args).  Normal-flow signals
//      like a policy denial are reported with `isError` UNSET so Claude can
//      relay the reason to the user without abandoning the tool.
//
//   3. Every tool result MUST be MCP-safe: BigInt is not JSON-serializable,
//      so both `content` text and `structuredContent` are scrubbed via
//      `bigintsToStrings` / `toJson` before leaving this file.
// ---------------------------------------------------------------------------

// We use the SDK's own CallToolResult type so the request handler return
// signature matches setRequestHandler's expectations exactly.
type ToolResult = CallToolResult;

/**
 * Successful tool result.
 *
 * @param payload - the unwrapped data the user actually asked for.  Strings
 *   are passed through verbatim; objects/arrays are JSON-pretty-printed.
 * @param meta - optional metadata (cost, tx hash, budget, …) that goes into
 *   `structuredContent` so Claude can access it without seeing it in the
 *   conversational reply.
 */
function ok(payload: unknown, meta?: Record<string, unknown>): ToolResult {
  const text =
    typeof payload === "string"
      ? payload
      : toJson(payload);

  const result: ToolResult = {
    content: [{ type: "text", text }],
  };

  if (meta !== undefined) {
    result.structuredContent = bigintsToStrings(meta) as Record<string, unknown>;
  }

  return result;
}

/**
 * Soft failure: a normal-flow error condition (policy denied, no service
 * found, etc.) that the tool wants to communicate to the user without
 * making Claude Desktop think the tool itself is broken.
 *
 * Returns a regular content block — `isError` is intentionally unset.
 */
function softFail(
  reason: string,
  detail: string,
  meta?: Record<string, unknown>,
): ToolResult {
  const text = `${reason}: ${detail}`;
  const result: ToolResult = {
    content: [{ type: "text", text }],
  };
  if (meta !== undefined) {
    result.structuredContent = bigintsToStrings({
      error: reason,
      message: detail,
      ...meta,
    }) as Record<string, unknown>;
  }
  return result;
}

/**
 * Hard failure: an unexpected exception bubbled out of the tool body.
 * Sets `isError: true` so the MCP client treats it as a tool failure.
 * Sanitises any Stellar secret keys or bearer tokens before returning.
 */
function fail(err: unknown): ToolResult {
  const error = err instanceof Error ? err : new Error(String(err));
  // Sanitize: never include secrets in error output (CLAUDE.md Rule 4)
  const message = error.message
    .replace(/S[A-Z0-9]{55}/g, "S***") // mask Stellar secret keys
    .replace(/Bearer\s+\S+/g, "Bearer ***"); // mask API keys

  return {
    content: [
      {
        type: "text",
        text: `${error.name}: ${message}`,
      },
    ],
    structuredContent: { error: error.name, message },
    isError: true,
  };
}

function budgetSnapshot(info: BudgetInfo): Record<string, unknown> {
  return {
    spent_today: info.spentToday,
    remaining: info.remaining,
    daily_limit: info.dailyLimit,
    tx_count: info.txCount,
    denied_count: info.deniedCount,
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "x402-autopilot", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tool definitions — EXACT schemas from CLAUDE.md
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "autopilot_pay_and_fetch",
      description:
        "Pay for and fetch data from an x402 or MPP endpoint. Supports GET (default) and POST with JSON body. Protocol is detected automatically.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "URL of the paid endpoint" },
          method: {
            type: "string",
            description: "HTTP method. Default GET.",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          },
          body: {
            type: "object",
            description: "Request body for POST/PUT/PATCH. Sent as JSON.",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "autopilot_research",
      description:
        "Research a topic using paid APIs. Auto-discovers services by capability, selects best by trust score, fetches from multiple sources. Falls back to next service on failure.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "What to research (e.g. 'stellar network stats')",
          },
          urls: {
            type: "array",
            items: { type: "string" },
            description:
              "Specific URLs to fetch (optional, overrides auto-discover)",
          },
        },
      },
    },
    {
      name: "autopilot_check_budget",
      description:
        "Check current spending status. Reads from on-chain Soroban contract (source of truth).",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "autopilot_discover",
      description:
        "Discover available paid APIs. Queries x402 Bazaar + Soroban Trust Registry. Returns sorted by trust score.",
      inputSchema: {
        type: "object" as const,
        properties: {
          capability: {
            type: "string",
            description:
              "Filter by capability: weather, news, blockchain, analysis. Required.",
          },
          limit: {
            type: "number",
            description: "Max results to return. Default 10.",
          },
        },
        required: ["capability"],
      },
    },
    {
      name: "autopilot_set_policy",
      description:
        "Update spending policy on-chain. Owner authorization required.",
      inputSchema: {
        type: "object" as const,
        properties: {
          daily_limit_stroops: {
            type: "string",
            description: "Max stroops per day (e.g. '500000' for $0.05)",
          },
          per_tx_limit_stroops: {
            type: "string",
            description: "Max stroops per transaction",
          },
          rate_limit: {
            type: "number",
            description: "Max requests per minute",
          },
        },
      },
    },
    {
      name: "autopilot_registry_status",
      description:
        "Overview of the service registry. Shows total/healthy/stale/dead counts and alerts.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  switch (name) {
    case "autopilot_pay_and_fetch":
      return handlePayAndFetch(a);
    case "autopilot_research":
      return handleResearch(a);
    case "autopilot_check_budget":
      return handleCheckBudget();
    case "autopilot_discover":
      return handleDiscover(a);
    case "autopilot_set_policy":
      return handleSetPolicy(a);
    case "autopilot_registry_status":
      return handleRegistryStatus();
    default:
      return fail(new Error(`Unknown tool: ${name}`));
  }
});

// ---------------------------------------------------------------------------
// Tool handlers — each wrapped in try/catch, never crashes the server
// ---------------------------------------------------------------------------

async function handlePayAndFetch(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const url = String(args.url ?? "");
    if (!url) return fail(new Error("Missing required parameter: url"));

    const method = typeof args.method === "string" ? args.method : undefined;
    const body = args.body;
    const result: AutopilotResult = await autopilotFetch(url, { method, body });
    const budget = budgetTracker.getBudget();

    // The unwrapped data is the conversational answer; payment metadata
    // travels in structuredContent so Claude can read it without seeing it
    // jumbled into the user-facing reply.  This is the fix for the
    // "weather tool not responding correctly" bug.
    return ok(result.data, {
      cost_stroops: result.costStroops,
      protocol: result.protocol,
      tx_hash: result.txHash ?? null,
      url,
      budget: budgetSnapshot(budget),
    });
  } catch (err) {
    if (err instanceof PolicyDeniedError) {
      // Policy denial is a normal operating condition.  Returning a soft
      // failure (no isError flag) lets Claude relay the reason without
      // treating the tool as broken.
      const budget = budgetTracker.getBudget();
      return softFail(
        "PolicyDeniedError",
        `Spending policy denied this request: ${err.reason}`,
        { reason: err.reason, budget: budgetSnapshot(budget) },
      );
    }
    return fail(err);
  }
}

async function handleResearch(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    let urls: string[];

    if (Array.isArray(args.urls) && args.urls.length > 0) {
      // Explicit URLs provided
      urls = (args.urls as unknown[]).map(String);
    } else if (typeof args.query === "string" && args.query) {
      // Discover services by capability (query used as capability name)
      const services = await discoverServices(args.query, 0, 10);
      urls = services.map((s: ServiceInfo) => s.url);
    } else {
      return fail(new Error("Provide either 'query' or 'urls'"));
    }

    const results: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];
    let totalCost = 0n;

    for (const url of urls) {
      try {
        const result = await autopilotFetch(url);
        results.push({
          url,
          data: result.data,
          cost_stroops: result.costStroops,
          protocol: result.protocol,
          tx_hash: result.txHash ?? null,
        });
        totalCost += result.costStroops;
      } catch (err) {
        if (err instanceof PolicyDeniedError) {
          // Budget exhausted — stop, return what we have
          errors.push({
            url,
            error: "PolicyDeniedError",
            reason: err.reason,
          });
          break;
        }
        // Other error — record and try next URL (fallback)
        errors.push({
          url,
          error: err instanceof Error ? err.name : "Error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const budget = budgetTracker.getBudget();
    // Text content: the array of fetched payloads (the answer).  Metadata
    // (per-source costs, errors, budget) lives in structuredContent.
    return ok(
      results.map((r) => r.data),
      {
        results,
        errors,
        total_cost_stroops: totalCost,
        budget: budgetSnapshot(budget),
      },
    );
  } catch (err) {
    return fail(err);
  }
}

async function handleCheckBudget(): Promise<ToolResult> {
  try {
    // Sync from chain for fresh data
    await budgetTracker.syncFromSoroban();
    const budget = budgetTracker.getBudget();
    const lifetime = await policyClient.getLifetimeStats();

    const payload = {
      spent_today: budget.spentToday,
      remaining: budget.remaining,
      daily_limit: budget.dailyLimit,
      lifetime: {
        total_spent: lifetime.lifetimeSpent ?? 0n,
        tx_count: lifetime.txCount,
        denied_count: lifetime.deniedCount,
      },
    };
    return ok(payload, payload);
  } catch (err) {
    return fail(err);
  }
}

async function handleDiscover(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const capability =
      typeof args.capability === "string" ? args.capability : "weather";
    const limit =
      typeof args.limit === "number" ? args.limit : 10;

    const services = await discoverServices(capability, 0, limit);
    const serialized = services.map(serializeService);

    return ok(serialized, {
      services: serialized,
      total: services.length,
      capability,
      source: "bazaar+registry+xlm402",
    });
  } catch (err) {
    return fail(err);
  }
}

async function handleSetPolicy(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const dailyLimit =
      typeof args.daily_limit_stroops === "string"
        ? BigInt(args.daily_limit_stroops)
        : undefined;
    const perTxLimit =
      typeof args.per_tx_limit_stroops === "string"
        ? BigInt(args.per_tx_limit_stroops)
        : undefined;
    const rateLimit =
      typeof args.rate_limit === "number" ? args.rate_limit : undefined;

    // Fetch current budget to get defaults for omitted fields
    const currentBudget = budgetTracker.getBudget();

    const effectiveDaily = dailyLimit ?? currentBudget.dailyLimit;
    const effectivePerTx = perTxLimit ?? config.defaultPerTxLimit;
    const effectiveRate = rateLimit ?? config.defaultRateLimit;

    const txHash = await policyClient.updatePolicy(
      effectiveDaily,
      effectivePerTx,
      effectiveRate,
      0n, // time_start: 0 = no restriction
      0n, // time_end: 0 = no restriction
    );

    const payload = {
      tx_hash: txHash,
      policy: {
        daily_limit_stroops: effectiveDaily,
        per_tx_limit_stroops: effectivePerTx,
        rate_limit: effectiveRate,
      },
    };
    return ok(payload, payload);
  } catch (err) {
    return fail(err);
  }
}

async function handleRegistryStatus(): Promise<ToolResult> {
  try {
    // v2: services are per-capability. Query known capabilities.
    const KNOWN_CAPS = ["weather", "news", "blockchain", "analysis"];
    const allServices: ServiceInfo[] = [];

    for (const cap of KNOWN_CAPS) {
      try {
        const services = await registryClient.listServices(cap, 0, 50);
        allServices.push(...services);
      } catch {
        // This capability might have no index yet
      }
    }

    // In v2, all returned services are alive (temporary storage ensures this)
    const serialized = allServices.map(serializeService);
    return ok(
      {
        total: allServices.length,
        alive: allServices.length,
        services: serialized,
      },
      {
        total: allServices.length,
        alive: allServices.length,
        services: serialized,
      },
    );
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// ServiceInfo serializer — BigInt fields converted to string
// ---------------------------------------------------------------------------

function serializeService(s: ServiceInfo): Record<string, unknown> {
  return {
    service_id: s.serviceId,
    name: s.name,
    url: s.url,
    capability: s.capability,
    price_stroops: s.priceStroops,
    protocol: s.protocol,
    score: s.score,
  };
}

// ---------------------------------------------------------------------------
// Startup — sync budget then listen on stdio
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Attempt initial budget sync (non-blocking — continues even if RPC is down)
  await budgetTracker.syncFromSoroban();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Relay eventBus events to the ws-server for instant dashboard bullets.
//
// The ws-server (port 8080) and this MCP server are separate processes.
// We connect as a WebSocket client and forward spend:ok events so the
// dashboard receives them within milliseconds instead of waiting for the
// ws-server's 5-second Soroban poll cycle.
// ---------------------------------------------------------------------------

const WS_RELAY_URL = `ws://localhost:${config.wsPort}`;
let relayWs: WebSocket | null = null;
let relayBackoff = 1_000;

function connectRelay(): void {
  try {
    const ws = new WebSocket(WS_RELAY_URL);
    ws.on("open", () => {
      relayWs = ws;
      relayBackoff = 1_000;
    });
    ws.on("close", () => {
      relayWs = null;
      relayBackoff = Math.min(relayBackoff * 2, 10_000);
      setTimeout(connectRelay, relayBackoff);
    });
    ws.on("error", () => {
      // onclose will fire next — let it handle reconnect.
    });
  } catch {
    setTimeout(connectRelay, relayBackoff);
  }
}

// Delay first connect: ws-server may not be up yet.
setTimeout(connectRelay, 2_000);

// Forward spend:ok events from the autopay engine to the ws-server.
eventBus.on("spend:ok", (data) => {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify(
      { _relay: true, event: "spend:ok", data },
      (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    ));
  }
});
