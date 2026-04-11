/**
 * Singleton Soroban snapshot subscription. Returns policy + registry +
 * events + latest ledger. The store starts polling on first subscription
 * and stops when the last React subscriber unmounts.
 */
import { useSyncExternalStore } from "react";
import { getSorobanStore, type SorobanSnapshot } from "@/stores/soroban-store";

export function useSoroban(): SorobanSnapshot {
  const store = getSorobanStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
