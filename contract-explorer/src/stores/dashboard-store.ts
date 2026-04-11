/**
 * Dashboard-wide persistent + session state that is NOT fetched from any
 * external system:
 *
 *   - Tracked wallet list (persisted to localStorage)
 *   - Feed (capped rolling list of observed events)
 *   - Per-wallet / per-service pulse keys for glow animations
 *
 * Built on top of Zustand v5, which is backed by `useSyncExternalStore`
 * internally, so selector-based hooks inherit the same tearing-free
 * concurrent semantics as the other stores in this folder.
 *
 * Transient payment edges have moved to `live-edge-store.ts` so they can
 * manage their own expiry timers without a React-driven reap interval.
 */
import { create } from "zustand";
import { DEFAULT_WALLETS, DEFAULTS, WALLETS_STORAGE_KEY } from "@/lib/constants";
import type { FeedEvent } from "@/lib/types";

export interface TrackedWallet {
  address: string;
  label: string;
}

interface DashboardState {
  wallets: TrackedWallet[];
  feed: FeedEvent[];
  /** Map of address → pulse key (monotonic counter). */
  walletPulses: Record<string, number>;
  /** Map of service owner address → pulse key, for the owned service sub-nodes. */
  servicePulses: Record<string, number>;

  addWallet: (address: string, label?: string) => { ok: boolean; reason?: string };
  removeWallet: (address: string) => void;
  renameWallet: (address: string, label: string) => void;
  pushFeed: (event: FeedEvent) => void;
  clearFeed: () => void;
  pulseWallet: (address: string) => void;
  pulseService: (serviceOwner: string) => void;
}

// ─── persistence helpers (plain localStorage, no zustand/persist dep) ──────

function loadWallets(): TrackedWallet[] {
  if (typeof window === "undefined") return [...DEFAULT_WALLETS];
  try {
    const raw = window.localStorage.getItem(WALLETS_STORAGE_KEY);
    if (!raw) return [...DEFAULT_WALLETS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_WALLETS];
    const clean: TrackedWallet[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).address === "string" &&
        typeof (entry as Record<string, unknown>).label === "string"
      ) {
        clean.push(entry as TrackedWallet);
      }
    }
    return clean.length > 0 ? clean : [...DEFAULT_WALLETS];
  } catch {
    return [...DEFAULT_WALLETS];
  }
}

function saveWallets(wallets: TrackedWallet[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(wallets));
  } catch {
    // Quota exceeded, private mode, etc. — ignore silently.
  }
}

/** Stellar public keys: 56 chars, start with G, base32 alphabet. */
export function validateStellarAddress(address: string): { ok: boolean; reason?: string } {
  if (!address) return { ok: false, reason: "empty" };
  const trimmed = address.trim();
  if (trimmed.length !== 56) return { ok: false, reason: "must be 56 chars" };
  if (!trimmed.startsWith("G")) return { ok: false, reason: "must start with G" };
  if (!/^[A-Z2-7]+$/.test(trimmed)) return { ok: false, reason: "invalid base32" };
  return { ok: true };
}

/** Short default label derived from the address tail. */
function defaultLabelFor(address: string): string {
  return `Wallet ${address.slice(0, 4)}…${address.slice(-4)}`;
}

// ─── store ──────────────────────────────────────────────────────────────────

export const useDashboardStore = create<DashboardState>((set, get) => ({
  wallets: loadWallets(),
  feed: [],
  walletPulses: {},
  servicePulses: {},

  addWallet: (addressRaw, label) => {
    const address = addressRaw.trim();
    const v = validateStellarAddress(address);
    if (!v.ok) return { ok: false, reason: v.reason };
    if (get().wallets.some((w) => w.address === address)) {
      return { ok: false, reason: "already tracked" };
    }
    const next: TrackedWallet[] = [
      ...get().wallets,
      { address, label: label?.trim() || defaultLabelFor(address) },
    ];
    set({ wallets: next });
    saveWallets(next);
    return { ok: true };
  },

  removeWallet: (address) => {
    const next = get().wallets.filter((w) => w.address !== address);
    set({ wallets: next });
    saveWallets(next);
  },

  renameWallet: (address, label) => {
    const next = get().wallets.map((w) =>
      w.address === address ? { ...w, label } : w,
    );
    set({ wallets: next });
    saveWallets(next);
  },

  pushFeed: (event) => {
    const feed = get().feed;
    if (feed.length > 0 && feed[0]!.id === event.id) return;
    if (feed.some((e) => e.id === event.id)) return;
    const next = [event, ...feed].slice(0, DEFAULTS.FEED_MAX_EVENTS);
    set({ feed: next });
  },

  clearFeed: () => set({ feed: [] }),

  pulseWallet: (address) => {
    set((s) => ({
      walletPulses: {
        ...s.walletPulses,
        [address]: (s.walletPulses[address] ?? 0) + 1,
      },
    }));
  },

  pulseService: (serviceOwner) => {
    set((s) => ({
      servicePulses: {
        ...s.servicePulses,
        [serviceOwner]: (s.servicePulses[serviceOwner] ?? 0) + 1,
      },
    }));
  },
}));
