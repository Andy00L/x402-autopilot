/**
 * Per-address Horizon REST poller subscription. Returns the WalletData
 * snapshot from the backing store. The store lazy-starts on first
 * subscription and lazy-stops when the last subscriber leaves.
 */
import { useSyncExternalStore } from "react";
import { getHorizonWalletDataStore } from "@/stores/horizon-wallet-data-store";
import type { WalletData } from "@/lib/types";
import { DEFAULTS } from "@/lib/constants";

export function useHorizonWalletData(address: string): WalletData {
  const store = getHorizonWalletDataStore(address, DEFAULTS.HORIZON_URL);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
