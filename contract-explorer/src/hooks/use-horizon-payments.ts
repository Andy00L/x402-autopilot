/**
 * Per-address Horizon payment stream subscription. Returns the current
 * snapshot (payments + connection status). The store is managed by a
 * module-level registry so multiple components for the same address share
 * a single EventSource.
 */
import { useSyncExternalStore } from "react";
import {
  getHorizonPaymentStore,
  type HorizonPaymentSnapshot,
} from "@/stores/horizon-payment-store";
import { DEFAULTS } from "@/lib/constants";

export function useHorizonPayments(address: string): HorizonPaymentSnapshot {
  const store = getHorizonPaymentStore(address, DEFAULTS.HORIZON_URL);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
