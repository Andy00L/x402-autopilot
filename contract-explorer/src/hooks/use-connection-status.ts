/**
 * Returns an aggregate connection status across every tracked wallet's
 * Horizon payment stream. Used by the header LIVE indicator.
 *
 *   - "open"       at least one stream is OPEN and none are actively
 *                  reconnecting (happy path).
 *   - "connecting" at least one stream is still establishing or waiting
 *                  on a scheduled reconnect.
 *   - "closed"     every stream is closed with no pending reconnect, or
 *                  there are no tracked wallets.
 */
import { useMemo, useSyncExternalStore } from "react";
import {
  getHorizonPaymentStore,
  type ConnectionStatus,
} from "@/stores/horizon-payment-store";
import { DEFAULTS } from "@/lib/constants";
import type { TrackedWallet } from "@/stores/dashboard-store";

export function useConnectionStatus(
  wallets: readonly TrackedWallet[],
): ConnectionStatus {
  // Stable key from the wallet set. Label changes do not trigger a
  // re-subscribe; only address churn does.
  const key = wallets.map((w) => w.address).join("|");

  // Build the subscribe/getSnapshot pair once per unique wallet set. React's
  // useSyncExternalStore re-subscribes if the subscribe function identity
  // changes, so a fresh closure per render would cause redundant work
  // without being incorrect. Memoising keeps it cheap.
  const pair = useMemo(() => {
    const addresses = wallets.map((w) => w.address);
    return {
      subscribe: (listener: () => void): (() => void) => {
        const unsubs = addresses.map((addr) =>
          getHorizonPaymentStore(addr, DEFAULTS.HORIZON_URL).subscribe(listener),
        );
        return () => {
          for (const u of unsubs) u();
        };
      },
      getSnapshot: (): ConnectionStatus => {
        if (addresses.length === 0) return "closed";
        let anyOpen = false;
        let anyConnecting = false;
        for (const addr of addresses) {
          const store = getHorizonPaymentStore(addr, DEFAULTS.HORIZON_URL);
          const s = store.getSnapshot().status;
          if (s === "open") anyOpen = true;
          else if (s === "connecting") anyConnecting = true;
        }
        if (anyConnecting && !anyOpen) return "connecting";
        if (anyOpen) return "open";
        return "closed";
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable via `key`
  }, [key]);

  return useSyncExternalStore(pair.subscribe, pair.getSnapshot);
}
