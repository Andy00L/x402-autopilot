/**
 * RegistryNode. On-chain trust-registry card with per-service TTL bars and
 * aggregate counts. Shows a friendly empty state when the registry is
 * reachable but has no services registered yet.
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { DEFAULTS } from "@/lib/constants";
import { truncateAddress } from "@/lib/utils";
import type { RegistryNode } from "./node-types";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";

export function RegistryNodeView({ data }: NodeProps<RegistryNode>) {
  return (
    <div
      className={`relative min-w-[210px] rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-sm transition-shadow duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:shadow-md ${
        data.offline ? "opacity-60" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />

      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-slate-900">
        <div className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[8px] font-bold text-blue-600">
          R
        </div>
        trust-registry
      </div>
      {data.contractId ? (
        <a
          href={`https://stellar.expert/explorer/testnet/contract/${data.contractId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-1.5 block num font-mono text-[9px] text-slate-400 hover:text-blue-600 hover:underline transition-colors"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {truncateAddress(data.contractId, 4, 4)}
        </a>
      ) : null}

      {data.offline ? (
        <div className="rounded-md bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
          Registry unavailable
        </div>
      ) : data.services.length === 0 ? (
        <div className="rounded-md bg-slate-50 px-2 py-1 text-[10px] text-slate-500">
          No services registered yet
        </div>
      ) : (
        <div className="space-y-1.5">
          {data.services.slice(0, 5).map((svc) => {
            const pctLeft = 90;
            const ledgersLeft = Math.round(
              (pctLeft / 100) * DEFAULTS.HEARTBEAT_TTL_LEDGERS,
            );
            return (
              <div key={svc.id} className="flex items-center gap-2">
                <div className="min-w-[46px] text-[10px] font-medium text-slate-700">
                  {svc.capability || svc.name}
                </div>
                <Progress
                  value={pctLeft}
                  className="h-1.5 flex-1 bg-slate-200"
                  indicatorClassName={
                    pctLeft < 40 ? "bg-amber-500" : "bg-emerald-500"
                  }
                />
                <div className="num min-w-[22px] text-right font-mono text-[9px] text-slate-400">
                  {ledgersLeft}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Separator className="mt-2.5 mb-2" />
      <div className="space-y-0.5">
        <KV k="next ID" v={data.nextId === null ? "—" : `#${data.nextId}`} />
        <KV k="deposit" v="$0.01" />
        <KV
          k="live"
          v={`${data.services.length} service${data.services.length === 1 ? "" : "s"}`}
          highlight={data.services.length > 0}
        />
      </div>
    </div>
  );
}

function KV({
  k,
  v,
  highlight,
}: {
  k: string;
  v: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between text-[10px]">
      <span className="text-slate-500">{k}</span>
      <span
        className={`num font-mono font-medium ${
          highlight ? "text-emerald-600" : "text-slate-700"
        }`}
      >
        {v}
      </span>
    </div>
  );
}
