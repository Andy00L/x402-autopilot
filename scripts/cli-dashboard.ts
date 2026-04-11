/**
 * Terminal dashboard for x402 Autopilot.
 * Replaces noisy concurrently output with a clean, updating display.
 * Zero NEW dependencies. Uses Node.js built-ins + ws (already installed).
 *
 * Spawns: ws-server, crypto prices, news agent, market agent, analyst,
 * vite dashboard. Does NOT spawn: MCP server (started by Claude Desktop
 * via stdio). All child output goes to a timestamped log file in logs/.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------

const CSI = "\x1b[";

const A = {
  enterAlt:  `${CSI}?1049h`,
  exitAlt:   `${CSI}?1049l`,
  clear:     `${CSI}2J`,
  home:      `${CSI}H`,
  clearLine: `${CSI}2K`,
  hideCur:   `${CSI}?25l`,
  showCur:   `${CSI}?25h`,
  reset:     `${CSI}0m`,
  bold:      `${CSI}1m`,
  dim:       `${CSI}2m`,
  red:       `${CSI}31m`,
  green:     `${CSI}32m`,
  yellow:    `${CSI}33m`,
  cyan:      `${CSI}36m`,
  white:     `${CSI}37m`,
  gray:      `${CSI}90m`,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface SvcState {
  name: string;
  label: string;
  port: number;
  protocol: string;
  price: string;
  status: "starting" | "online" | "offline" | "error";
  lastHB: number;
}

interface TxInfo { service: string; cost: number; time: number }

const services: SvcState[] = [
  { name: "engine",  label: "WS Server",    port: 8080, protocol: "ws",       price: "",        status: "starting", lastHB: 0 },
  { name: "crypto",  label: "Crypto Prices",port: 4001, protocol: "x402",     price: "$0.001",  status: "starting", lastHB: 0 },
  { name: "news",    label: "News Agent",   port: 4002, protocol: "x402",     price: "$0.001",  status: "starting", lastHB: 0 },
  { name: "market",  label: "Market Agent", port: 4003, protocol: "mpp+x402", price: "$0.002",  status: "starting", lastHB: 0 },
  { name: "analyst", label: "Analyst",      port: 4004, protocol: "x402",     price: "$0.005",  status: "starting", lastHB: 0 },
  { name: "vite",    label: "Dashboard",    port: 5180, protocol: "http",     price: "",        status: "starting", lastHB: 0 },
];

let budget = { spent: 0, limit: 5_000_000, txCount: 0 };
let lastTx: TxInfo | null = null;
let logPath = "";
let dashboardUrl = "http://localhost:5180";
let wsConnected = false;
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function pad2(n: number): string { return n.toString().padStart(2, "0"); }

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

mkdirSync("logs", { recursive: true });
logPath = join("logs", `${fmtDate(new Date())}.log`);
const logStream: WriteStream = createWriteStream(logPath, { flags: "a" });

function log(tag: string, line: string): void {
  logStream.write(`[${pad2(new Date().getHours())}:${pad2(new Date().getMinutes())}:${pad2(new Date().getSeconds())}][${tag}] ${line}\n`);
}

// ---------------------------------------------------------------------------
// FIX 1: Kill leftover processes on ports before spawning
// ---------------------------------------------------------------------------

const PORTS = [8080, 4001, 4002, 4003, 4004, 5180, 5181, 5182];

function killPorts(): void {
  for (const port of PORTS) {
    try {
      execSync(`fuser -k ${port}/tcp 2>/dev/null`, { stdio: "ignore" });
    } catch { /* nothing on that port */ }
  }
  // Give OS time to release port bindings
  try { execSync("sleep 1", { stdio: "ignore" }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Output parsing (updates state, never prints to terminal)
// ---------------------------------------------------------------------------

function findSvc(name: string): SvcState | undefined {
  return services.find(s => s.name === name);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function parseOutput(name: string, rawLine: string): void {
  const svc = findSvc(name);
  if (!svc) return;
  const line = stripAnsi(rawLine);

  // Online detection
  if (
    line.includes(`:${svc.port}`) ||
    line.includes("listening") ||
    (name === "vite" && (line.includes("Local:") || line.includes("ready in"))) ||
    (name === "engine" && line.includes("WebSocket"))
  ) {
    svc.status = "online";
  }

  // Extract Vite's actual URL (may use alternate port if 5173 is taken)
  if (name === "vite" && line.includes("Local:")) {
    const urlMatch = line.match(/http:\/\/localhost:\d+/);
    if (urlMatch) dashboardUrl = urlMatch[0];
  }

  // Heartbeat (silent, just update timestamp)
  if (line.toLowerCase().includes("heartbeat")) {
    svc.lastHB = Date.now();
  }

  // Registration success
  if (line.includes("serviceId=") || line.includes("Already registered")) {
    svc.status = "online";
  }

  // Errors
  if (line.includes("EADDRINUSE") || line.includes("FATAL")) {
    svc.status = "error";
  }
}

// ---------------------------------------------------------------------------
// FIX 2: Process spawning with detached process groups
// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];
const root = process.cwd();

function spawnSvc(name: string, cmd: string, args: string[], cwd?: string): void {
  const proc = spawn(cmd, args, {
    cwd: cwd ?? root,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,  // Process group leader for clean kill
  });

  children.push(proc);
  const svc = findSvc(name);

  proc.stdout?.on("data", (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      log(name, trimmed);
      parseOutput(name, trimmed);
    }
  });

  proc.stderr?.on("data", (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      log(`${name}:err`, trimmed);
      parseOutput(name, trimmed);
    }
  });

  proc.on("exit", (code) => {
    log(name, `exited with code ${code}`);
    if (svc) svc.status = code === 0 ? "offline" : "error";
  });

  // Unref so the dashboard can exit without waiting for children
  proc.unref();

  if (svc) {
    log(name, `spawned (pid=${proc.pid})`);
  }
}

// ---------------------------------------------------------------------------
// FIX 3: WebSocket client for budget events from ws-server
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectWebSocket(): void {
  function connect(): void {
    try {
      const socket = new WebSocket("ws://localhost:8080");

      socket.on("open", () => {
        ws = socket;
        wsConnected = true;
        log("dashboard", "WebSocket connected to ws-server :8080");
      });

      socket.on("message", (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          handleWsEvent(msg);
        } catch { /* ignore malformed */ }
      });

      socket.on("close", () => {
        ws = null;
        wsConnected = false;
        wsReconnectTimer = setTimeout(connect, 3_000);
      });

      socket.on("error", () => {
        // WS server not up yet, retry silently
        socket.close();
      });
    } catch {
      wsReconnectTimer = setTimeout(connect, 3_000);
    }
  }

  // Delay first connect (ws-server needs time to start)
  wsReconnectTimer = setTimeout(connect, 3_000);
}

function handleWsEvent(msg: Record<string, unknown>): void {
  const event = msg.event as string | undefined;
  const data = msg.data as Record<string, unknown> | undefined;
  if (!event || !data) return;

  // budget:updated from ws-server polling (fields are BigInt serialized as strings)
  if (event === "budget:updated") {
    const spent = Number(data.spentToday ?? 0);
    const limit = Number(data.dailyLimit ?? budget.limit);
    const txCount = Number(data.txCount ?? budget.txCount);
    budget.spent = spent;
    budget.limit = limit;
    budget.txCount = txCount;
  }

  // spend:ok from ws-server (amount is BigInt serialized as string)
  if (event === "spend:ok") {
    const cost = Number(data.amount ?? 0);
    if (cost > 0) {
      const urlStr = String(data.url ?? "unknown");
      // Extract service name from URL
      let svcName = "unknown";
      if (urlStr.includes("4001") || urlStr.includes("prices")) svcName = "crypto";
      else if (urlStr.includes("4002") || urlStr.includes("news") || urlStr.includes("briefing")) svcName = "news";
      else if (urlStr.includes("4003") || urlStr.includes("stellar") || urlStr.includes("market-report")) svcName = "market";
      else if (urlStr.includes("4004") || urlStr.includes("analyst")) svcName = "analyst";
      else if (urlStr.includes("xlm402")) svcName = "xlm402.com";
      else svcName = urlStr.slice(0, 30);

      lastTx = { service: svcName, cost, time: Date.now() };
    }
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function fmtTime(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtUptime(): string {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
}

function fmtAgo(ts: number): string {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function fmtStroops(n: number): string {
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)} USDC`;
  if (n >= 1000) return `${(n / 10_000_000).toFixed(4)} USDC`;
  return `${n} stroops`;
}

function statusDot(s: SvcState["status"]): string {
  if (s === "online")   return `${A.green}\u25CF${A.reset}`;
  if (s === "error")    return `${A.red}\u25CF${A.reset}`;
  if (s === "starting") return `${A.yellow}\u25CF${A.reset}`;
  return `${A.gray}\u25CB${A.reset}`;
}

function progressBar(pct: number, w: number): string {
  const filled = Math.round((pct / 100) * w);
  const empty = w - filled;
  const color = pct > 80 ? A.red : pct > 50 ? A.yellow : A.green;
  return `${color}${"█".repeat(filled)}${A.gray}${"░".repeat(empty)}${A.reset}`;
}

function ln(text: string): string {
  return `${A.clearLine}${text}${A.reset}\n`;
}

function render(): void {
  const w = Math.min(process.stdout.columns || 80, 72);
  const sep = `${A.gray}${"─".repeat(w)}${A.reset}`;

  let o = A.home;

  o += ln("");
  o += ln(`  ${A.cyan}${A.bold}x402 Autopilot${A.reset}    ${A.gray}${fmtTime()}  uptime ${fmtUptime()}`);
  o += ln(sep);

  // Services
  o += ln(`  ${A.bold}SERVICES${A.reset}`);
  for (const svc of services) {
    const dot = statusDot(svc.status);
    const hb = svc.lastHB ? `  ${A.gray}\u2665 ${fmtAgo(svc.lastHB)}` : "";

    // Special rendering for WS Server and Dashboard
    if (svc.name === "engine") {
      const wsStatus = wsConnected
        ? `${A.green}connected${A.reset}`
        : `${A.yellow}connecting...${A.reset}`;
      o += ln(`  ${dot} ${A.white}${svc.label.padEnd(14)} ${A.gray}:${svc.port}  ${wsStatus}`);
    } else if (svc.name === "vite") {
      o += ln(`  ${dot} ${A.white}${svc.label.padEnd(14)} ${A.cyan}${dashboardUrl}${A.reset}`);
    } else {
      const proto = svc.protocol ? `${A.gray}${svc.protocol.padEnd(5)}` : "     ";
      const price = svc.price ? `${A.gray}${svc.price.padEnd(8)}` : "        ";
      o += ln(`  ${dot} ${A.white}${svc.label.padEnd(14)} ${A.gray}:${svc.port}  ${proto} ${price}${hb}`);
    }
  }
  o += ln(sep);

  // MCP
  o += ln(`  ${A.cyan}MCP Server${A.reset}       ${A.dim}configured (started by Claude Desktop)${A.reset}`);
  o += ln(sep);

  // Budget
  const pct = budget.limit > 0 ? Math.round((budget.spent / budget.limit) * 100) : 0;
  o += ln(`  ${A.bold}BUDGET${A.reset}  ${progressBar(Math.min(pct, 100), 20)}  ${fmtStroops(budget.spent)} / ${fmtStroops(budget.limit)}`);
  o += ln(`  ${A.gray}Transactions: ${budget.txCount}    ${pct}% used${A.reset}`);
  o += ln(sep);

  // Last TX
  if (lastTx) {
    o += ln(`  ${A.bold}LAST TX${A.reset}  ${A.yellow}${lastTx.service}${A.reset}  ${fmtStroops(lastTx.cost)}  ${A.gray}${fmtAgo(lastTx.time)}${A.reset}`);
  } else {
    o += ln(`  ${A.bold}LAST TX${A.reset}  ${A.gray}none yet${A.reset}`);
  }
  o += ln(sep);

  // Footer
  o += ln(`  ${A.gray}Logs: ${logPath}${A.reset}`);
  o += ln(`  ${A.dim}Press q or Ctrl+C to quit${A.reset}`);

  // Clear leftover lines from previous render (handles terminal resize)
  for (let i = 0; i < 4; i++) o += `${A.clearLine}\n`;

  process.stdout.write(o);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let shuttingDown = false;
let renderTimer: ReturnType<typeof setInterval> | null = null;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  // Stop rendering
  if (renderTimer) clearInterval(renderTimer);

  // Close WebSocket
  if (ws) try { ws.close(); } catch { /* ignore */ }
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);

  // FIX 2: Kill entire process groups (negative PID)
  for (const child of children) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already dead */ }
    }
  }

  // Fallback: kill by port in case process groups didn't work
  killPorts();

  // Close log
  logStream.end();

  // Restore terminal
  process.stdout.write(A.showCur + A.exitAlt);
  process.exit(0);
}

function main(): void {
  // FIX 1: Kill leftover processes from previous run
  killPorts();

  // Enter alternative screen
  process.stdout.write(A.enterAlt + A.hideCur + A.clear);

  // Spawn processes. Service names match the `services` array above so
  // `findSvc(name)` can update status for each stream. Filenames on disk
  // are kept as `weather-api.ts` / `stellar-data-api.ts` so
  // data-sources/package.json scripts continue to work; only the
  // CLI-visible names and the content of those files have changed.
  spawnSvc("engine",  "npx", ["tsx", "src/ws-server.ts"]);
  spawnSvc("crypto",  "npx", ["tsx", "data-sources/src/weather-api.ts"]);
  spawnSvc("news",    "npx", ["tsx", "data-sources/src/news-api.ts"]);
  spawnSvc("market",  "npx", ["tsx", "data-sources/src/stellar-data-api.ts"]);
  spawnSvc("analyst", "npx", ["tsx", "data-sources/src/analyst-api.ts"]);
  spawnSvc("vite",    "npm", ["run", "dev", "--silent"], "contract-explorer");

  // FIX 3: Connect to ws-server for live budget events
  connectWebSocket();

  // Render loop (every second)
  renderTimer = setInterval(render, 1000);
  render(); // First render immediately

  // Keyboard input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      if (key === "q" || key === "\x03") shutdown();
    });
  }

  // Signal handlers
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Always restore terminal on crash
process.on("uncaughtException", (err) => {
  process.stdout.write(A.showCur + A.exitAlt);
  console.error("Uncaught exception:", err);
  process.exit(1);
});

main();
