import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { autopilotFetch } from "../../src/autopay.js";
import { discoverServices } from "../../src/discovery.js";
import { budgetTracker } from "../../src/budget-tracker.js";
import * as policyClient from "../../src/policy-client.js";
import * as registryClient from "../../src/registry-client.js";
import { PolicyDeniedError } from "../../src/types.js";
import { config } from "../../src/config.js";
import type { AutopilotResult, ServiceInfo, BudgetInfo } from "../../src/types.js";

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

// ---------------------------------------------------------------------------
// Response helpers — consistent shape for every tool
// ---------------------------------------------------------------------------

function ok(data: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: toJson(data) }] };
}

function fail(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const error = err instanceof Error ? err : new Error(String(err));
  // Sanitize: never include secrets in error output (CLAUDE.md Rule 4)
  const message = error.message
    .replace(/S[A-Z0-9]{55}/g, "S***") // mask Stellar secret keys
    .replace(/Bearer\s+\S+/g, "Bearer ***"); // mask API keys

  return {
    content: [
      {
        type: "text",
        text: toJson({ error: error.name, message }),
      },
    ],
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
        "Pay for and fetch data from an x402 or MPP endpoint. Protocol is detected automatically. Spending is enforced by on-chain policy.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "URL of the paid endpoint" },
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
) {
  try {
    const url = String(args.url ?? "");
    if (!url) return fail(new Error("Missing required parameter: url"));

    const result: AutopilotResult = await autopilotFetch(url);
    const budget = budgetTracker.getBudget();

    return ok({
      data: result.data,
      cost_stroops: result.costStroops,
      protocol: result.protocol,
      tx_hash: result.txHash ?? null,
      budget: budgetSnapshot(budget),
    });
  } catch (err) {
    if (err instanceof PolicyDeniedError) {
      const budget = budgetTracker.getBudget();
      return {
        content: [{
          type: "text" as const,
          text: toJson({
            error: "PolicyDeniedError",
            reason: err.reason,
            budget: budgetSnapshot(budget),
          }),
        }],
        isError: true as const,
      };
    }
    return fail(err);
  }
}

async function handleResearch(
  args: Record<string, unknown>,
) {
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
    return ok({
      results,
      errors,
      total_cost_stroops: totalCost,
      budget: budgetSnapshot(budget),
    });
  } catch (err) {
    return fail(err);
  }
}

async function handleCheckBudget() {
  try {
    // Sync from chain for fresh data
    await budgetTracker.syncFromSoroban();
    const budget = budgetTracker.getBudget();
    const lifetime = await policyClient.getLifetimeStats();

    return ok({
      spent_today: budget.spentToday,
      remaining: budget.remaining,
      daily_limit: budget.dailyLimit,
      lifetime: {
        total_spent: lifetime.lifetimeSpent ?? 0n,
        tx_count: lifetime.txCount,
        denied_count: lifetime.deniedCount,
      },
    });
  } catch (err) {
    return fail(err);
  }
}

async function handleDiscover(
  args: Record<string, unknown>,
) {
  try {
    const capability =
      typeof args.capability === "string" ? args.capability : "weather";
    const limit =
      typeof args.limit === "number" ? args.limit : 10;

    const services = await discoverServices(capability, 0, limit);

    return ok({
      services: services.map(serializeService),
      total: services.length,
      source: "bazaar+registry",
    });
  } catch (err) {
    return fail(err);
  }
}

async function handleSetPolicy(
  args: Record<string, unknown>,
) {
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

    return ok({
      tx_hash: txHash,
      policy: {
        daily_limit_stroops: effectiveDaily,
        per_tx_limit_stroops: effectivePerTx,
        rate_limit: effectiveRate,
      },
    });
  } catch (err) {
    return fail(err);
  }
}

async function handleRegistryStatus() {
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
    return ok({
      total: allServices.length,
      alive: allServices.length,
      services: allServices.map(serializeService),
    });
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
