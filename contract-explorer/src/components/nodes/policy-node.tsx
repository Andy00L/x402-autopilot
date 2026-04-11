/**
 * PolicyNode. On-chain wallet-policy card with a daily budget gauge and
 * key limits. Shows "RPC offline" with a greyed-out card when the backing
 * store reports the simulate call failed.
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { formatUsdc, pctOf, truncateAddress } from "@/lib/utils";
import type { PolicyNode } from "./node-types";
import { Progress } from "@/components/ui/progress";

export function PolicyNodeView({ data }: NodeProps<PolicyNode>) {
  const daily = data.config?.dailyLimit ?? 0n;
  const pct = daily > 0n ? pctOf(data.today.total, daily) : 0;
  const rate = data.config?.rateLimit ?? 0;

  return (
    <div
      className={`relative min-w-[170px] rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 shadow-sm transition-shadow duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:shadow-md ${
        data.offline ? "opacity-60" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />

      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-slate-900">
        <div className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[8px] font-bold text-blue-600">
          P
        </div>
        wallet-policy
      </div>
      <a
        href={`https://stellar.expert/explorer/testnet/account/${data.ownerAddress}`}
        target="_blank"
        rel="noopener noreferrer"
        className="mb-1.5 block num font-mono text-[9px] text-slate-400 hover:text-blue-600 hover:underline transition-colors"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {truncateAddress(data.ownerAddress, 4, 4)}
      </a>

      {data.offline ? (
        <div className="rounded-md bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
          No policy · RPC offline
        </div>
      ) : data.config === null ? (
        <div className="rounded-md bg-slate-50 px-2 py-1 text-[10px] text-slate-500">
          No policy configured
        </div>
      ) : (
        <>
          <Progress
            value={pct}
            className="mb-1 h-2 bg-slate-200"
            indicatorClassName="bg-blue-500"
          />
          <KV
            k="daily"
            v={`${formatUsdc(data.today.total, { compact: true })}/${formatUsdc(daily, { compact: true })}`}
          />
          <KV
            k="per-tx"
            v={formatUsdc(data.config.perTxLimit, { compact: true })}
          />
          <KV k="rate" v={`${rate}/min`} />
        </>
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-0.5 text-[10px]">
      <span className="text-slate-500">{k}</span>
      <span className="num font-mono font-medium text-slate-700">{v}</span>
    </div>
  );
}
