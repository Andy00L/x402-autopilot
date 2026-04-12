import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { config } from "./config.js";
import { budgetTracker } from "./budget-tracker.js";
import * as policyClient from "./policy-client.js";

// ---------------------------------------------------------------------------
// WebSocket server for the dashboard.
//
// The MCP server and WS server are separate processes. The MCP process relays
// eventBus events (spend:ok with recipient) to this server via a WebSocket
// client connection. This server rebroadcasts them to dashboard clients for
// instant bullet animations. The 5-second Soroban poll remains as a backup
// for budget:updated events and spend detection when the MCP relay is offline.
//
// Bind address
// ------------
// Default is 127.0.0.1. The relay accepts arbitrary `_relay: true` payloads
// from any connected client and rebroadcasts them as if they came from the
// trusted MCP process. Binding to 0.0.0.0 would let any host on the network
// inject fake spend:ok events into every dashboard. Set WS_BIND_ADDR=0.0.0.0
// only when the engine runs on a trusted network and the operator
// understands the trust model.
// ---------------------------------------------------------------------------

const port = config.wsPort;
const bindHost = process.env.WS_BIND_ADDR ?? "127.0.0.1";
const wss = new WebSocketServer({ port, host: bindHost });

// Track which connected sockets came from a loopback peer. Only loopback
// peers are allowed to relay events. Even with the bind-host default of
// 127.0.0.1 this is defence in depth — if an operator opts into 0.0.0.0
// for dashboard reach, the relay still requires localhost.
const loopbackPeers = new WeakSet<WebSocket>();

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  // Strip IPv6 zone id if present
  const a = addr.replace(/%.*$/, "").toLowerCase();
  if (a === "127.0.0.1" || a === "::1") return true;
  // IPv4-mapped IPv6 loopback
  if (a === "::ffff:127.0.0.1") return true;
  return false;
}

// BigInt-safe JSON serializer
function toJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, (_k: string, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

// ---------------------------------------------------------------------------
// On client connect: send current budget immediately
// ---------------------------------------------------------------------------

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  // Tag the connection with a loopback flag at handshake time. The relay
  // handler below will reject any _relay payload from a non-loopback peer.
  if (isLoopbackAddress(req.socket.remoteAddress)) {
    loopbackPeers.add(ws);
  }

  sendBudgetToClient(ws).catch(() => {});

  // Handle relayed events from the MCP process. The MCP process connects as
  // a WebSocket client and sends messages with { _relay: true, event, data }.
  // We rebroadcast them to all OTHER clients (the dashboard browsers).
  //
  // Origin gate: only accept relay payloads from loopback peers. A remote
  // attacker who reaches this port (e.g. operator opted into WS_BIND_ADDR=
  // 0.0.0.0) cannot inject fake spend:ok events even if they connect.
  ws.on("message", (raw) => {
    if (!loopbackPeers.has(ws)) return;
    try {
      const msg = JSON.parse(String(raw)) as {
        _relay?: boolean;
        event?: string;
        data?: Record<string, unknown>;
      };
      if (!msg._relay || !msg.event) return;
      const out = toJson({
        event: msg.event,
        data: msg.data ?? {},
        timestamp: new Date().toISOString(),
      });
      for (const client of wss.clients) {
        if (client === ws || client.readyState !== WebSocket.OPEN) continue;
        try {
          client.send(out);
        } catch {
          // The socket may have closed between the readyState check and
          // the send. Skip it; the next emit cycle will see it gone.
        }
      }
    } catch {
      // Malformed message from relay. Ignore.
    }
  });
});

async function sendBudgetToClient(ws: WebSocket): Promise<void> {
  try {
    await budgetTracker.syncFromSoroban();
  } catch {
    // RPC down, send cached/zero data
  }

  const budget = budgetTracker.getBudget();
  let lifetimeSpent = 0n;
  try {
    const lifetime = await policyClient.getLifetimeStats();
    lifetimeSpent = lifetime.lifetimeSpent ?? 0n;
  } catch {
    // RPC down
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(toJson({
      event: "budget:updated",
      data: {
        spentToday: budget.spentToday,
        remaining: budget.remaining,
        dailyLimit: budget.dailyLimit,
        txCount: budget.txCount,
        deniedCount: budget.deniedCount,
        lifetimeSpent,
      },
      timestamp: new Date().toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// Poll Soroban every 5 seconds, broadcast only on change
// ---------------------------------------------------------------------------

let prevSpentToday = 0n;
let prevTxCount = 0;
let syncing = false;

async function pollAndBroadcast(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    await budgetTracker.syncFromSoroban();
  } catch {
    return; // RPC down, skip this cycle
  } finally {
    syncing = false;
  }

  const budget = budgetTracker.getBudget();

  // Only broadcast if something changed
  if (budget.spentToday === prevSpentToday && budget.txCount === prevTxCount) {
    return;
  }

  // Compute delta for spend event
  const costDelta = budget.spentToday - prevSpentToday;
  const countDelta = budget.txCount - prevTxCount;

  prevSpentToday = budget.spentToday;
  prevTxCount = budget.txCount;

  // Skip if no clients connected
  if (wss.clients.size === 0) return;

  // Broadcast budget update
  const budgetMsg = toJson({
    event: "budget:updated",
    data: {
      spentToday: budget.spentToday,
      remaining: budget.remaining,
      dailyLimit: budget.dailyLimit,
      txCount: budget.txCount,
      deniedCount: budget.deniedCount,
    },
    timestamp: new Date().toISOString(),
  });

  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    try {
      client.send(budgetMsg);
    } catch {
      // Socket transitioned to closing between the readyState check
      // and the send. Skip it; the next poll cycle will see it gone.
    }
  }

  // If new transactions detected, broadcast a spend event
  if (countDelta > 0 && costDelta > 0n) {
    const spendMsg = toJson({
      event: "spend:ok",
      data: {
        url: "(on-chain)",
        amount: costDelta,
        protocol: "unknown",
        txHash: `poll_${Date.now()}`,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });

    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(spendMsg);
      } catch {
        // See above.
      }
    }
  }
}

const pollInterval = setInterval(() => {
  pollAndBroadcast().catch(() => {});
}, 5_000);

// ---------------------------------------------------------------------------
// Initial sync + startup
// ---------------------------------------------------------------------------

budgetTracker.syncFromSoroban().then(() => {
  const budget = budgetTracker.getBudget();
  prevSpentToday = budget.spentToday;
  prevTxCount = budget.txCount;
}).catch(() => {});

console.log(`[WS Server] :${port}`);

// ---------------------------------------------------------------------------
// Cleanup on exit
// ---------------------------------------------------------------------------

function shutdown(): void {
  clearInterval(pollInterval);
  wss.close(() => process.exit(0));
  // Force exit after 2s if close hangs
  setTimeout(() => process.exit(0), 2_000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
