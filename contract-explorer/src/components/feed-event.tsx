/**
 * Single row in the activity feed.
 *
 * Layout
 *   [time] [icon] [title .. amount] [badge]
 *   [----------- bar-fill -----------]   (only for kinds with animatedBar)
 *   [optional mono subtitle]
 *
 * Relative time
 *   The label ("now", "3s", "4m") is computed during render from the row's
 *   absolute timestamp plus a counter from the global tick store. One hook
 *   call drives every feed row — much cheaper than per-row intervals.
 *
 * Reduced motion
 *   When `prefers-reduced-motion: reduce` is set the entrance animation
 *   delay is dropped to 0 so the row appears instantly. The global CSS
 *   rule kills the animation itself.
 */
import type { FeedEvent } from "@/lib/types";
import { formatUsdc } from "@/lib/utils";
import { useReducedMotion, useTick } from "@/hooks/use-browser-state";

interface FeedEventRowProps {
  event: FeedEvent;
  index: number;
}

const ICON_CLASS: Record<
  FeedEvent["accent"],
  { wrap: string; badge: string; bar: string }
> = {
  success: {
    wrap: "bg-emerald-100 text-emerald-600",
    badge: "bg-slate-100 text-slate-500",
    bar: "bg-emerald-500",
  },
  gold: {
    wrap: "bg-amber-100 text-amber-600",
    badge: "bg-amber-100 text-amber-700",
    bar: "bg-amber-500",
  },
  warning: {
    wrap: "bg-amber-100 text-amber-600",
    badge: "bg-slate-100 text-slate-500",
    bar: "bg-amber-500",
  },
  info: {
    wrap: "bg-blue-100 text-blue-600",
    badge: "bg-slate-100 text-slate-500",
    bar: "bg-blue-500",
  },
  danger: {
    wrap: "bg-rose-100 text-rose-500",
    badge: "bg-rose-100 text-rose-600",
    bar: "bg-rose-500",
  },
};

const KIND_GLYPH: Record<FeedEvent["kind"], string> = {
  spend: "$",
  "sub-buy": "$",
  heartbeat: "♥",
  register: "+",
  deregister: "−",
  reclaim: "⟲",
  denied: "✕",
};

function relativeTime(observedAt: number): string {
  const delta = Math.max(0, Date.now() - observedAt);
  if (delta < 3_000) return "now";
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function FeedEventRow({ event, index }: FeedEventRowProps) {
  // Subscribe to the tick so the row re-renders every 10 s. We don't read
  // the tick value; calling the hook is what creates the dependency.
  useTick();
  const reduced = useReducedMotion();
  const cls = ICON_CLASS[event.accent];
  const relTs = relativeTime(event.observedAt);
  const amount =
    event.amountStroops !== undefined
      ? formatUsdc(event.amountStroops, { compact: true })
      : null;

  // Stagger fresh rows by 60 ms each so bursts look like a cascade instead
  // of a flash. Reduced motion drops to 0.
  const delayMs = reduced ? 0 : Math.min(index, 6) * 60;

  return (
    <div
      className="feed-event border-b border-slate-100 px-3 py-2.5 transition-colors hover:bg-slate-100"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${cls.wrap}`}
          aria-hidden="true"
        >
          {KIND_GLYPH[event.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate text-[12px] text-slate-900">
              <span className="font-medium">{event.title}</span>
              {amount ? (
                <span className="num ml-1.5 font-mono text-emerald-600">
                  {amount}
                </span>
              ) : null}
            </span>
            <span className="flex items-center gap-1">
              <span className="num font-mono text-[9px] text-slate-400">
                {relTs}
              </span>
              {event.txHash ? (
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${event.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-slate-400 hover:text-blue-600 transition-colors"
                  title="View on Stellar Explorer"
                >
                  ↗
                </a>
              ) : null}
            </span>
          </div>
          {event.subtitle ? (
            <div className="num mt-0.5 font-mono text-[9px] text-slate-500">
              {event.subtitle}
            </div>
          ) : null}
          {event.animatedBar ? (
            <div className="mt-1.5 h-[3px] max-w-[200px] overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full rounded-full feed-bar-fill ${cls.bar}`}
                style={{ animationDelay: `${delayMs + 80}ms` }}
              />
            </div>
          ) : null}
        </div>
        <span
          className={`inline-block flex-shrink-0 rounded-md px-1.5 py-[2px] text-[8px] font-medium uppercase tracking-wider ${cls.badge}`}
        >
          {event.badge}
        </span>
      </div>
    </div>
  );
}
