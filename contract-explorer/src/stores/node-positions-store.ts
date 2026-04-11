/**
 * Per-node position overrides, persisted to localStorage.
 *
 * The layout hook computes deterministic default positions for every node
 * on the canvas. When the user drags a node the NetworkGraph component
 * commits the new coordinates to this store; the layout hook reads the
 * store on the next render and substitutes the override for the default.
 *
 * Store, not Zustand module state, because useGraphLayout wants a stable
 * snapshot reference for its useMemo dependency list and the built-in
 * ExternalStore base class already delivers that via useSyncExternalStore.
 */
import { ExternalStore } from "./external-store";

export interface NodePosition {
  x: number;
  y: number;
}

export type NodePositions = Readonly<Record<string, NodePosition>>;

const STORAGE_KEY = "x402-autopilot.node-positions.v1";

function loadPositions(): Record<string, NodePosition> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, NodePosition> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        val &&
        typeof val === "object" &&
        typeof (val as { x?: unknown }).x === "number" &&
        typeof (val as { y?: unknown }).y === "number"
      ) {
        out[key] = {
          x: (val as NodePosition).x,
          y: (val as NodePosition).y,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function savePositions(positions: Record<string, NodePosition>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Quota exceeded, private mode, etc. — ignore silently. The store
    // stays valid in memory so the current session still benefits.
  }
}

function clearPositions(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

const EMPTY: NodePositions = Object.freeze({});

class NodePositionsStore extends ExternalStore<NodePositions> {
  private positions: NodePositions;
  /** Monotonic counter that bumps on every reset() call. Components can
   *  subscribe to it via `subscribeResets` to re-fire fitView after the
   *  user clicks "Reset layout". */
  private resetCount = 0;
  private resetListeners = new Set<() => void>();

  constructor() {
    super();
    const initial = loadPositions();
    this.positions = Object.keys(initial).length > 0 ? initial : EMPTY;
  }

  getSnapshot = (): NodePositions => this.positions;

  /** Replace many positions in one commit. Fires exactly one notify. */
  setMany(updates: Record<string, NodePosition>): void {
    if (Object.keys(updates).length === 0) return;
    const next: Record<string, NodePosition> = { ...this.positions, ...updates };
    this.positions = next;
    savePositions(next);
    this.notify();
  }

  /** Clear all saved overrides and notify. Also bumps the reset counter
   *  so subscribers can trigger a fitView after the layout rebuilds. */
  reset(): void {
    if (Object.keys(this.positions).length === 0) return;
    this.positions = EMPTY;
    clearPositions();
    this.resetCount += 1;
    this.notify();
    for (const listener of this.resetListeners) listener();
  }

  /** Subscribe to reset events. Fires once per reset() call. */
  subscribeResets(listener: () => void): () => void {
    this.resetListeners.add(listener);
    return () => {
      this.resetListeners.delete(listener);
    };
  }
}

export const nodePositionsStore = new NodePositionsStore();
