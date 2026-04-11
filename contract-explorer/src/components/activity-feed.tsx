/**
 * Live activity feed (right pane).
 *
 *   - Filter tabs: All / Spends / Registry (shadcn Tabs)
 *   - Scrollable list with FeedEventRow children (shadcn ScrollArea)
 *   - Auto-scroll to top when new events arrive, BUT only if the user is
 *     already near the top. If they scrolled down to read older rows we
 *     leave them alone.
 *
 * The scroll effect is the one remaining useEffect in the component tree:
 * it reads the scroll container and writes its scrollTop, which has no
 * React equivalent. It does NOT subscribe to anything external, so it
 * meets the "useEffect for DOM-only" carve-out in the audit spec.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FeedEventRow } from "./feed-event";
import type { FeedEvent } from "@/lib/types";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";

type Filter = "all" | "spends" | "registry";

interface ActivityFeedProps {
  events: readonly FeedEvent[];
}

const STICKY_TOP_PX = 50;

export function ActivityFeed({ events }: ActivityFeedProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevTopIdRef = useRef<string | null>(null);

  const filtered = useMemo(() => {
    if (filter === "all") return events;
    if (filter === "spends") {
      return events.filter(
        (e) => e.kind === "spend" || e.kind === "sub-buy" || e.kind === "denied",
      );
    }
    return events.filter(
      (e) =>
        e.kind === "register" ||
        e.kind === "deregister" ||
        e.kind === "heartbeat" ||
        e.kind === "reclaim",
    );
  }, [events, filter]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const topId = filtered[0]?.id ?? null;
    if (topId === prevTopIdRef.current) return;
    prevTopIdRef.current = topId;
    if (container.scrollTop <= STICKY_TOP_PX) {
      container.scrollTop = 0;
    }
  }, [filtered]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
        <span className="text-[12px] font-semibold tracking-tight text-slate-900">
          Live activity
        </span>
        <Tabs
          value={filter}
          onValueChange={(v) => setFilter(v as Filter)}
        >
          <TabsList className="h-7">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="spends">Spends</TabsTrigger>
            <TabsTrigger value="registry">Registry</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <ScrollArea className="flex-1 bg-slate-50">
        <div ref={scrollRef}>
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-[11px] text-slate-400">
              No events yet. Waiting for payments, heartbeats, and registrations.
            </div>
          ) : (
            filtered.map((e, i) => (
              <FeedEventRow key={e.id} event={e} index={i} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
