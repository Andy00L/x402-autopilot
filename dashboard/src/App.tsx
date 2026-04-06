import { useMemo } from "react";
import { useWebSocket, type WsEvent } from "./hooks/useWebSocket.js";

// ---------------------------------------------------------------------------
// Config — WebSocket URL from Vite env or default
// ---------------------------------------------------------------------------

const WS_URL = (
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_WS_URL
) || "ws://localhost:8080";

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
  bg: "#0a0a12",
  panel: "#111120",
  border: "#1e1e30",
  text: "#e0e0f0",
  muted: "#8b8b9e",
  dim: "#4a4a5c",
  green: "#22c55e",
  red: "#ef4444",
  amber: "#f59e0b",
  purple: "#6366f1",
  pink: "#d4537e",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatStroops(s: unknown): string {
  const n = Number(s ?? 0);
  if (n === 0) return "$0.00";
  const usd = n / 10_000_000;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatStroopsRaw(s: unknown): string {
  return String(s ?? "0");
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len) + "..." : s;
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return ts;
  }
}

// ---------------------------------------------------------------------------
// Styled primitives
// ---------------------------------------------------------------------------

const panel = (extra?: React.CSSProperties): React.CSSProperties => ({
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: 16,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  ...extra,
});

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        background: color + "22",
        color,
        textTransform: "uppercase",
      }}
    >
      {text}
    </span>
  );
}

function StatusDot({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 6px ${color}88`,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const { events, connected } = useWebSocket(WS_URL);

  // Classify events by type
  const txEvents = useMemo(
    () => events.filter((e) => e.event.startsWith("spend:")),
    [events],
  );
  const deniedEvents = useMemo(
    () => events.filter((e) => e.event === "denied"),
    [events],
  );
  const healthEvents = useMemo(
    () => events.filter((e) => e.event === "health:checked" || e.event === "registry:stale"),
    [events],
  );
  const budgetEvent = useMemo(
    () => events.find((e) => e.event === "budget:updated"),
    [events],
  );
  const discoveryEvent = useMemo(
    () => events.find((e) => e.event === "discovery:updated"),
    [events],
  );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 16 }}>
      {/* ---- HEADER ---- */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
          padding: "12px 16px",
          ...panel(),
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: C.purple }}>
            x402 AUTOPILOT
          </span>
          <Badge text="testnet" color={C.amber} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {budgetEvent && (
            <span style={{ color: C.muted, fontSize: 12 }}>
              Remaining:{" "}
              <span style={{ color: C.green }}>
                {formatStroops(budgetEvent.data.remaining)}
              </span>
            </span>
          )}
          <div
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
          >
            <StatusDot color={connected ? C.green : C.red} />
            <span style={{ color: connected ? C.green : C.red }}>
              {connected ? "connected" : "disconnected"}
            </span>
          </div>
        </div>
      </header>

      {/* ---- 2x2 GRID ---- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <BudgetPanel data={budgetEvent?.data} />
        <TransactionLog events={txEvents} />
        <ServiceRegistry
          services={
            (discoveryEvent?.data.services as unknown[] | undefined) ?? []
          }
        />
        <HealthMonitor events={healthEvents} />
      </div>

      {/* ---- DENIED PANEL (conditional) ---- */}
      {deniedEvents.length > 0 && <DeniedPanel events={deniedEvents} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel 1 — Budget
// ---------------------------------------------------------------------------

function BudgetPanel({ data }: { data?: Record<string, unknown> }) {
  const spent = Number(data?.spentToday ?? 0);
  const limit = Number(data?.dailyLimit ?? 5_000_000);
  const pct = limit > 0 ? Math.min((spent / limit) * 100, 100) : 0;

  return (
    <div style={panel()}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>BUDGET</div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 28, fontWeight: 700, color: C.text }}>
          {formatStroops(data?.spentToday)}
        </span>
        <span style={{ fontSize: 14, color: C.muted }}>
          / {formatStroops(data?.dailyLimit)}
        </span>
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 6,
          background: C.border,
          borderRadius: 3,
          marginBottom: 16,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: pct > 80 ? C.red : pct > 50 ? C.amber : C.green,
            borderRadius: 3,
            transition: "width 0.3s",
          }}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 8,
          fontSize: 11,
        }}
      >
        <Stat label="Remaining" value={formatStroops(data?.remaining)} />
        <Stat label="Stroops spent" value={formatStroopsRaw(data?.spentToday)} />
        <Stat label="Daily limit" value={formatStroopsRaw(data?.dailyLimit)} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: C.dim, fontSize: 10, marginBottom: 2 }}>{label}</div>
      <div style={{ color: C.text }}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel 2 — Transaction Log
// ---------------------------------------------------------------------------

function TransactionLog({ events }: { events: WsEvent[] }) {
  return (
    <div style={panel({ maxHeight: 320 })}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
        TRANSACTIONS
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {events.length === 0 && (
          <div style={{ color: C.dim, fontSize: 12 }}>No transactions yet</div>
        )}
        {events.map((e, i) => (
          <TxRow key={i} event={e} />
        ))}
      </div>
    </div>
  );
}

function TxRow({ event }: { event: WsEvent }) {
  const d = event.data;
  const isOk = event.event === "spend:ok";
  const isFailed = event.event === "spend:failed";
  const statusColor = isOk ? C.green : C.red;
  const statusText = isOk ? "OK" : isFailed ? "FAIL" : "ERR";
  const proto = String(d.protocol ?? "");

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 0",
        borderBottom: `1px solid ${C.border}`,
        fontSize: 11,
      }}
    >
      <span style={{ color: C.dim, minWidth: 56 }}>
        {fmtTime(String(d.timestamp ?? event.timestamp))}
      </span>
      <Badge text={statusText} color={statusColor} />
      {d.amount != null ? (
        <span style={{ color: C.text, minWidth: 60 }}>
          {formatStroops(d.amount)}
        </span>
      ) : null}
      <span style={{ color: C.muted, flex: 1 }}>
        {truncate(String(d.url ?? ""), 30)}
      </span>
      {proto ? (
        <Badge
          text={proto}
          color={proto === "mpp" ? C.pink : C.amber}
        />
      ) : null}
      {d.txHash != null ? (
        <span style={{ color: C.dim, fontSize: 10 }}>
          {truncate(String(d.txHash), 12)}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel 3 — Service Registry
// ---------------------------------------------------------------------------

function ServiceRegistry({ services }: { services: unknown[] }) {
  return (
    <div style={panel({ maxHeight: 320 })}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
        SERVICE REGISTRY
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {services.length === 0 && (
          <div style={{ color: C.dim, fontSize: 12 }}>
            No services discovered
          </div>
        )}
        {services.map((s, i) => {
          const svc = s as Record<string, unknown>;
          const score = Number(svc.score ?? 0);
          const status = String(svc.status ?? "unknown");
          const statusColor =
            status === "active"
              ? C.green
              : status === "stale"
                ? C.amber
                : C.red;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
                borderBottom: `1px solid ${C.border}`,
                fontSize: 11,
              }}
            >
              <StatusDot color={statusColor} />
              <span style={{ color: C.text, minWidth: 80 }}>
                {String(svc.name ?? "—")}
              </span>
              <span style={{ color: C.muted, flex: 1 }}>
                {truncate(String(svc.url ?? ""), 28)}
              </span>
              <Badge
                text={String(svc.protocol ?? "")}
                color={
                  String(svc.protocol ?? "") === "mpp" ? C.pink : C.amber
                }
              />
              <span style={{ color: C.muted, minWidth: 50 }}>
                {formatStroops(svc.price_stroops)}
              </span>
              {/* Trust score bar */}
              <div
                style={{
                  width: 40,
                  height: 4,
                  background: C.border,
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${score}%`,
                    background:
                      score >= 80 ? C.green : score >= 50 ? C.amber : C.red,
                    borderRadius: 2,
                  }}
                />
              </div>
              <span style={{ color: C.muted, fontSize: 10, minWidth: 24 }}>
                {score}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel 4 — Health Monitor
// ---------------------------------------------------------------------------

function HealthMonitor({ events }: { events: WsEvent[] }) {
  // Deduplicate by serviceId — keep most recent per service
  const latest = useMemo(() => {
    const map = new Map<number, WsEvent>();
    for (const e of events) {
      const id = Number(e.data.serviceId ?? 0);
      if (!map.has(id)) map.set(id, e);
    }
    return Array.from(map.values());
  }, [events]);

  return (
    <div style={panel({ maxHeight: 320 })}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
        HEALTH MONITOR
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {latest.length === 0 && (
          <div style={{ color: C.dim, fontSize: 12 }}>No health data yet</div>
        )}
        {latest.map((e, i) => {
          const d = e.data;
          const isStale = e.event === "registry:stale";
          const status = isStale ? "stale" : String(d.status ?? "unknown");
          const latency = isStale ? 0 : Number(d.latencyMs ?? 0);
          const label = isStale
            ? String(d.name ?? `Service #${d.serviceId ?? "?"}`)
            : `Service #${String(d.serviceId ?? "?")}`;
          const color =
            status === "healthy"
              ? C.green
              : status === "stale" || status === "timeout"
                ? C.amber
                : C.red;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 0",
                borderBottom: `1px solid ${C.border}`,
                fontSize: 11,
              }}
            >
              <StatusDot color={color} />
              <span style={{ color: C.text, minWidth: 80 }}>{label}</span>
              <span style={{ color, minWidth: 60 }}>{status}</span>
              {latency > 0 ? (
                <span style={{ color: C.muted }}>{latency}ms</span>
              ) : null}
              <span style={{ color: C.dim, marginLeft: "auto", fontSize: 10 }}>
                {fmtTime(String(d.timestamp ?? e.timestamp))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel 5 — Denied / Attacks
// ---------------------------------------------------------------------------

function DeniedPanel({ events }: { events: WsEvent[] }) {
  return (
    <div
      style={{
        ...panel(),
        background: "#1a0a0a",
        border: `1px solid ${C.red}33`,
        maxHeight: 240,
      }}
    >
      <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>
        DENIED REQUESTS
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {events.map((e, i) => {
          const d = e.data;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
                borderBottom: `1px solid ${C.red}22`,
                fontSize: 11,
              }}
            >
              <span style={{ color: C.dim, minWidth: 56 }}>
                {fmtTime(String(d.timestamp ?? e.timestamp))}
              </span>
              <Badge text="DENIED" color={C.red} />
              <span style={{ color: C.red, minWidth: 80 }}>
                {String(d.reason ?? "unknown")}
              </span>
              {d.amount != null ? (
                <span style={{ color: C.muted }}>
                  {formatStroops(d.amount)}
                </span>
              ) : null}
              <span style={{ color: C.muted, flex: 1 }}>
                {truncate(String(d.url ?? ""), 40)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
