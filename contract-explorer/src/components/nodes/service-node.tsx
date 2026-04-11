/**
 * ServiceNode. One card per registered service.
 *
 * Heartbeat countdown (heart M:SS)
 *   Computed during render from the latest Soroban ledger plus the
 *   store's internal 10 s tick. No per-node setInterval, no useState.
 *
 * Heartbeat ping rings
 *   Three SVG circles expand outward from the heart indicator. The
 *   CSS keyframe `heartbeat-ring-expand` animates the `r` attribute.
 *   Staggered animation-delay gives three continuous waves.
 *
 *   Under `prefers-reduced-motion: reduce` the rings are hidden and
 *   the heart text colour alternates slowly instead.
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { DEFAULTS } from "@/lib/constants";
import { formatUsdc } from "@/lib/utils";
import type { ServiceNode } from "./node-types";
import { useReducedMotion, useTick } from "@/hooks/use-browser-state";
import { Badge } from "@/components/ui/badge";

const LEDGER_SECONDS = 6;
/** Maximum heartbeat TTL in seconds — used to compute the percentage
 *  remaining for the top-edge accent colour. */
const MAX_TTL_SECONDS = DEFAULTS.HEARTBEAT_TTL_LEDGERS * LEDGER_SECONDS;

function computeRemainingSeconds(
  lastHeartbeatLedger: number,
  latestLedger: number,
  ticksElapsed: number,
): number {
  if (!lastHeartbeatLedger || !latestLedger) return 0;
  const ledgersLeft =
    DEFAULTS.HEARTBEAT_TTL_LEDGERS - (latestLedger - lastHeartbeatLedger);
  if (ledgersLeft <= 0) return 0;
  const base = ledgersLeft * LEDGER_SECONDS;
  const adjusted = base - ticksElapsed * 10;
  return adjusted > 0 ? adjusted : 0;
}

/** Status colour for the heart indicator at the bottom of each card.
 *  This replaces the previous top-edge accent stripe (per the
 *  Impeccable side-stripe ban) and gives the heart icon — already a
 *  natural "vital" symbol — a real signalling job:
 *
 *   ≥ 40%   emerald-500   service heartbeat is fresh
 *   10–40%  amber-500     fading; will need a heartbeat soon
 *   < 10%   rose-500      expired or near expiry
 *   == 0    slate-400     dead, not serving
 */
function heartStatusClass(remainingSeconds: number): string {
  if (remainingSeconds <= 0) return "text-slate-400";
  const pct = remainingSeconds / MAX_TTL_SECONDS;
  if (pct >= 0.4) return "text-emerald-500";
  if (pct >= 0.1) return "text-amber-500";
  return "text-rose-500";
}

function formatMmSs(totalSeconds: number): string {
  if (totalSeconds <= 0) return "\u2014";
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ServiceNodeView({ data }: NodeProps<ServiceNode>) {
  const reduced = useReducedMotion();
  const tick = useTick();
  const ticksElapsed = reduced ? 0 : tick % 6;
  const remaining = computeRemainingSeconds(
    data.lastHeartbeatLedger,
    data.latestLedger,
    ticksElapsed,
  );
  const isAlive = remaining > 0;

  const shortUrl = shortenUrl(data.url);

  // Heart colour encodes the heartbeat health. Reduced motion gets a
  // slightly lower contrast variant on alternate ticks so the icon
  // still feels "alive" without the SVG ring animation.
  const heartBaseClass = heartStatusClass(remaining);
  const heartClass =
    reduced && isAlive && tick % 2 === 0
      ? `${heartBaseClass} opacity-70`
      : heartBaseClass;

  const protocolDotColor =
    data.protocol.toLowerCase() === "mpp" ? "#f59e0b" : "#10b981";

  return (
    <div
      className={`relative rounded-lg border border-slate-200 bg-white px-3.5 py-3 text-[11px] shadow-sm min-w-[150px] transition-shadow duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:shadow-md ${
        isAlive ? "" : "opacity-60"
      }`}
    >
      {data.pulseKey > 0 && !reduced ? (
        <div
          key={`pulse-${data.pulseKey}`}
          className={`pointer-events-none absolute inset-0 rounded-xl ${
            data.colorDot === "gold" ? "node-glow-gold" : "node-glow-success"
          }`}
        />
      ) : null}

      {/* Heartbeat ping rings. Fire ONCE per payment (keyed on pulseKey
       * so React remounts the SVG and restarts the CSS animation). The
       * animation uses `forwards` fill so the rings stay invisible after
       * expanding, and React unmounts them on the next pulseKey bump. */}
      {isAlive && data.pulseKey > 0 && !reduced ? (
        <svg
          key={`hb-ring-${data.pulseKey}`}
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          aria-hidden="true"
          preserveAspectRatio="xMidYMid meet"
        >
          <HeartbeatRing delay="0s" />
          <HeartbeatRing delay="0.7s" />
          <HeartbeatRing delay="1.4s" />
        </svg>
      ) : null}

      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <Handle type="target" position={Position.Left} className="!opacity-0" />

      <div className="flex items-center gap-1.5 text-[12px] font-medium">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: protocolDotColor }}
        />
        <span className="text-slate-900">{data.name}</span>
      </div>
      <div className="num font-mono text-[9px] text-slate-400 mt-0.5">
        {shortUrl}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <Badge variant="secondary">{data.protocol}</Badge>
        <Badge variant="outline">{formatUsdc(data.priceStroops, { compact: true })}</Badge>
      </div>
      <div className={`mt-1.5 num font-mono text-[10px] ${heartClass}`}>
        ♥ {formatMmSs(remaining)}
      </div>
    </div>
  );
}

function HeartbeatRing({ delay }: { delay: string }) {
  return (
    <circle
      cx="50%"
      cy="100%"
      r="6"
      fill="none"
      stroke="#f59e0b"
      strokeWidth="1.5"
      opacity="0"
      className="heartbeat-ring"
      style={{ animationDelay: delay }}
    />
  );
}

function shortenUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const port = u.port ? `:${u.port}` : "";
    return `${port}${u.pathname}`.slice(0, 24);
  } catch {
    return url.slice(0, 24);
  }
}
