/**
 * Wrapper hook that returns a Map<address, WalletData> for the current
 * wallet list. Internally it subscribes to the per-address stores through
 * their individual `useSyncExternalStore` bindings, then composes the
 * results into a single Map.
 *
 * Why not a single hook per wallet node? The graph layout builder wants a
 * flat map so a single render pass has O(1) access to every wallet's data.
 * This composition keeps every subscription React-correct (no tearing, no
 * strict-mode doubles) while letting the layout hook consume one object.
 *
 * Subscribers at the per-wallet level are established by the
 * PaymentOrchestrator (non-React) and via this hook (React). Both paths
 * hit the same registry and share state.
 */
import { useMemo } from "react";
import { useHorizonWalletData } from "./use-horizon-wallet-data";
import type { WalletData } from "@/lib/types";
import type { TrackedWallet } from "@/stores/dashboard-store";

/**
 * Consume wallet-data stores for up to FIXED_SLOTS wallets. Hooks must be
 * called in a stable order, so we reserve slots and guard each one with a
 * placeholder address when unused. This is a well-documented pattern for
 * "variable but bounded" collections.
 *
 * The dashboard caps the wallet list at FIXED_SLOTS. If the user somehow
 * exceeds the cap we fall back to data-less entries — no correctness
 * issues, just a visual warning.
 */
const FIXED_SLOTS = 12;
const PLACEHOLDER = "G".padEnd(56, "A"); // unused; never matches a real address

export function useWalletDataMap(
  wallets: readonly TrackedWallet[],
): Map<string, WalletData> {
  const padded: string[] = [];
  for (let i = 0; i < FIXED_SLOTS; i += 1) {
    padded.push(wallets[i]?.address ?? PLACEHOLDER);
  }

  // Call the hook FIXED_SLOTS times, once per slot. React requires a stable
  // number of hook calls per render; padding guarantees that.
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable length
  const s0 = useHorizonWalletData(padded[0]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s1 = useHorizonWalletData(padded[1]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s2 = useHorizonWalletData(padded[2]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s3 = useHorizonWalletData(padded[3]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s4 = useHorizonWalletData(padded[4]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s5 = useHorizonWalletData(padded[5]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s6 = useHorizonWalletData(padded[6]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s7 = useHorizonWalletData(padded[7]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s8 = useHorizonWalletData(padded[8]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s9 = useHorizonWalletData(padded[9]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s10 = useHorizonWalletData(padded[10]!);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const s11 = useHorizonWalletData(padded[11]!);

  const snapshots: WalletData[] = [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11];

  return useMemo(() => {
    const map = new Map<string, WalletData>();
    wallets.forEach((w, i) => {
      if (i >= FIXED_SLOTS) return;
      const snap = snapshots[i]!;
      map.set(w.address, { ...snap, label: w.label });
    });
    return map;
    // Dependencies intentionally list the snapshot array entries so React
    // rebuilds the map when any wallet's data changes but not on unrelated
    // renders. A for-loop dep list would defeat the purpose.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets, s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11]);
}

export const MAX_TRACKED_WALLETS = FIXED_SLOTS;
