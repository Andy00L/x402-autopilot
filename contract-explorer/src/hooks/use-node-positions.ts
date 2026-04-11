/**
 * Subscribe to the persisted per-node position overrides. Returns the same
 * `NodePositions` snapshot reference until a drag-end commit mutates the
 * store, at which point React is notified and the layout hook re-runs.
 */
import { useSyncExternalStore } from "react";
import {
  nodePositionsStore,
  type NodePositions,
} from "@/stores/node-positions-store";

export function useNodePositions(): NodePositions {
  return useSyncExternalStore(
    nodePositionsStore.subscribe,
    nodePositionsStore.getSnapshot,
  );
}
