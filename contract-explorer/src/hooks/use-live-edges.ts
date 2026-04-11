/**
 * Read the current list of transient payment edges from the live-edge store.
 * Each edge lives for LIVE_EDGE_MS before its own timer removes it; the
 * store handles the lifecycle so this hook is a one-liner.
 */
import { useSyncExternalStore } from "react";
import { liveEdgeStore, type LiveEdge } from "@/stores/live-edge-store";

export function useLiveEdges(): readonly LiveEdge[] {
  return useSyncExternalStore(liveEdgeStore.subscribe, liveEdgeStore.getSnapshot);
}
