/**
 * React hook bindings for the browser stores. Each is a one-line wrapper
 * around `useSyncExternalStore` so components never touch subscribe /
 * getSnapshot directly.
 */
import { useSyncExternalStore } from "react";
import {
  onlineStore,
  reducedMotionStore,
  tickStore,
  visibilityStore,
} from "@/stores/browser-stores";

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    reducedMotionStore.subscribe,
    reducedMotionStore.getSnapshot,
    reducedMotionStore.getServerSnapshot,
  );
}

export function useIsTabVisible(): boolean {
  return useSyncExternalStore(
    visibilityStore.subscribe,
    visibilityStore.getSnapshot,
    visibilityStore.getServerSnapshot,
  );
}

export function useIsOnline(): boolean {
  return useSyncExternalStore(
    onlineStore.subscribe,
    onlineStore.getSnapshot,
    onlineStore.getServerSnapshot,
  );
}

/**
 * Returns a counter that ticks every 10 seconds. Components that call this
 * hook will re-render at that cadence, which is what we want for relative
 * time labels in the feed. The return value is only used as a dependency
 * signal — the caller does not need to read the number.
 */
export function useTick(): number {
  return useSyncExternalStore(
    tickStore.subscribe,
    tickStore.getSnapshot,
    tickStore.getServerSnapshot,
  );
}
