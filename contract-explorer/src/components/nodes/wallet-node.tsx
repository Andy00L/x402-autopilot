/**
 * WalletNode. One card per tracked wallet. Every wallet (buyer, seller,
 * service wallet, analyst) shows the same four stats:
 *
 *   Revenue   total USDC received (from Horizon history)
 *   Expenses  total USDC sent     (from Horizon history)
 *   Profit    revenue - expenses
 *   Margin    profit / revenue * 100 (or "N/A" if revenue is zero)
 *
 * Below the stats, a secondary row shows Balance, TX count, and (for the
 * policy-anchored wallet) the denied count.
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { formatUsdc, truncateAddress } from "@/lib/utils";
import type { WalletNode } from "./node-types";
import type { WalletNodeData } from "@/lib/types";
import { useReducedMotion } from "@/hooks/use-browser-state";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Role-coloured tint for the initial badge. M = blue, A = purple,
 *  anything else = slate. The badge IS the role indicator — there is
 *  intentionally no side-stripe accent on the card body, both because
 *  Impeccable bans border-left/right > 1px on cards and because the
 *  badge already does this job at the size where the user actually
 *  reads it. */
function roleBadgeClass(initial: string): string {
  if (initial === "M") return "bg-blue-100 text-blue-700";
  if (initial === "A") return "bg-purple-100 text-purple-700";
  return "bg-slate-100 text-slate-600";
}

/** Tiny dot anchored to the initial badge — picks up the same role
 *  hue at slightly higher chroma so the badge reads as "alive". */
function walletDotColor(initial: string): string {
  if (initial === "M") return "#2563eb"; // blue-600
  if (initial === "A") return "#9333ea"; // purple-600
  return "#94a3b8";                       // slate-400
}

export function WalletNodeView({ data }: NodeProps<WalletNode>) {
  const reduced = useReducedMotion();
  const isNotFound = data.status === "not_found";

  return (
    <div
      className={`relative min-w-[200px] rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm transition-shadow duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:shadow-md ${
        isNotFound ? "opacity-55" : ""
      }`}
    >
      {data.pulseKey > 0 && !reduced ? (
        <div
          key={`pulse-${data.pulseKey}`}
          className="pointer-events-none absolute inset-0 rounded-xl node-glow-success"
        />
      ) : null}

      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <Handle type="source" position={Position.Left} className="!opacity-0" />
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="target" position={Position.Bottom} id="b-in" className="!opacity-0" />
      <Handle type="target" position={Position.Left} id="l-in" className="!opacity-0" />
      <Handle type="target" position={Position.Right} id="r-in" className="!opacity-0" />

      {/* Header: role badge + name + address */}
      <div className="flex items-center gap-2.5">
        <div className="relative">
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-semibold ${roleBadgeClass(data.initial)}`}
          >
            {data.initial}
          </div>
          {/* Role dot: tiny coloured circle at bottom-right of the icon */}
          <span
            className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white"
            style={{ backgroundColor: walletDotColor(data.initial) }}
          />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-tight text-slate-900 truncate">
            {data.label}
          </div>
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={`https://stellar.expert/explorer/testnet/account/${data.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="num font-mono text-[10px] text-slate-400 hover:text-blue-600 hover:underline transition-colors"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {truncateAddress(data.address, 5, 4)}
                </a>
              </TooltipTrigger>
              <TooltipContent>{data.address}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Body: status alert or stats grid */}
      {data.status === "not_found" ? (
        <div className="mt-2.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] text-slate-500">
          Not found on testnet
        </div>
      ) : data.status === "offline" ? (
        <div className="mt-2.5 rounded-md bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
          Horizon offline
        </div>
      ) : (
        <StatsGrid d={data} />
      )}
    </div>
  );
}

/**
 * Uniform 2x2 stats grid shown for EVERY wallet regardless of role.
 * Revenue and expenses come from Horizon lifetime totals; profit and
 * margin are derived. Balance, TX, and denied are secondary line items.
 */
function StatsGrid({ d }: { d: WalletNodeData }) {
  const profit = d.revenueStroops - d.expensesStroops;
  const margin =
    d.revenueStroops > 0n
      ? Number((profit * 100n) / d.revenueStroops)
      : null;
  const profitTone: StatTone = profit >= 0n ? "success" : "danger";

  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <Stat
          label="Revenue"
          value={formatUsdc(d.revenueStroops, { compact: true })}
          tone="success"
        />
        <Stat
          label="Expenses"
          value={formatUsdc(d.expensesStroops, { compact: true })}
          tone="danger"
        />
        <Stat
          label="Profit"
          value={formatUsdc(profit, { compact: true })}
          tone={profitTone}
        />
        <Stat
          label="Margin"
          value={margin !== null ? `${margin}%` : "N/A"}
          tone={margin !== null ? profitTone : "default"}
        />
      </div>

      {/* Secondary info row */}
      <div className="mt-2 flex items-center gap-2 border-t border-slate-100 pt-1.5">
        <Badge variant="outline">
          {d.usdcBalance !== null
            ? formatUsdc(d.usdcBalance, { compact: true })
            : "—"}
        </Badge>
        <Badge variant="secondary">
          {d.txCount.toString()} tx
        </Badge>
        {d.deniedCount > 0n ? (
          <Badge variant="destructive">
            {d.deniedCount.toString()} denied
          </Badge>
        ) : null}
      </div>
    </>
  );
}

type StatTone = "default" | "success" | "danger";
function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: StatTone;
}) {
  const color =
    tone === "success"
      ? "text-emerald-600"
      : tone === "danger"
      ? "text-rose-500"
      : "text-slate-700";
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[9px] font-medium uppercase tracking-wider text-slate-400">
        {label}
      </div>
      <div className={`num font-mono text-[15px] font-semibold leading-none ${color}`}>
        {value}
      </div>
    </div>
  );
}
