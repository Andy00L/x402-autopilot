/**
 * Transient bullet edges drawn on top of the React Flow graph.
 *
 * Lifecycle (fixed timings)
 *   t = 0         phase='active', fresh bulletSeq, bullet animation fires
 *   t = 2000ms    phase='fading', bullet unmounts, base line starts a
 *                 CSS transition from opacity 1 → 0 over 800ms
 *   t = 2800ms    edge removed from the store entirely
 *
 * Route-keyed dedup
 *   Multiple payments on the same (source → target) route share a single
 *   store entry. A new payment on an existing route clears the current
 *   fade + expire timers, bumps `bulletSeq` so the React key on the
 *   bullet <g> changes (forcing animateMotion to restart), and resets
 *   phase='active'. This gives the "timer resets on rapid repeat"
 *   behaviour required by the prompt, without stacking N edge instances
 *   for N rapid payments.
 *
 * Reduced motion
 *   The BulletEdge component reads `prefers-reduced-motion` on its own
 *   and collapses the fade transition to instant. The store's timing is
 *   unchanged — we just don't animate the opacity.
 *
 * The snapshot is an immutable array; consumers read it via
 * `useSyncExternalStore` and feed it to the graph layout builder.
 */
import { ExternalStore } from "./external-store";

export type LiveEdgePhase = "active" | "fading";

export interface LiveEdge {
  /** Route-based stable id: `live:<source>→<target>`. */
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  /** Gold bullet for analyst → service sub-purchases, green otherwise. */
  subPurchase: boolean;
  phase: LiveEdgePhase;
  /** Monotonic counter that bumps on every refresh. Used as the React
   *  key on the bullet element so a rapid repeat unmounts the old group
   *  and mounts a fresh one — re-arming animateMotion from scratch. */
  bulletSeq: number;
}

/** Total active window where the bullet animates + base line is bright. */
export const LIVE_EDGE_ACTIVE_MS = 2_000;
/** CSS transition duration of the fade-out on the base line. */
export const LIVE_EDGE_FADE_MS = 800;
/** Total lifetime. After this the edge is removed from the graph. */
export const LIVE_EDGE_TOTAL_MS = LIVE_EDGE_ACTIVE_MS + LIVE_EDGE_FADE_MS;

interface LiveEdgeTimers {
  fade: ReturnType<typeof setTimeout>;
  expire: ReturnType<typeof setTimeout>;
}

class LiveEdgeStore extends ExternalStore<readonly LiveEdge[]> {
  private edges = new Map<string, LiveEdge>();
  private snapshot: readonly LiveEdge[] = [];
  private timers = new Map<string, LiveEdgeTimers>();

  getSnapshot = (): readonly LiveEdge[] => this.snapshot;

  /** Add or refresh an edge for this route. Returns the stable id of the
   *  route entry so callers can correlate if they need to. */
  add(params: {
    sourceNodeId: string;
    targetNodeId: string;
    subPurchase: boolean;
  }): string {
    const id = `live:${params.sourceNodeId}→${params.targetNodeId}`;

    const existingTimers = this.timers.get(id);
    if (existingTimers) {
      clearTimeout(existingTimers.fade);
      clearTimeout(existingTimers.expire);
    }

    const previous = this.edges.get(id);
    const nextSeq = (previous?.bulletSeq ?? 0) + 1;

    const entry: LiveEdge = {
      id,
      sourceNodeId: params.sourceNodeId,
      targetNodeId: params.targetNodeId,
      subPurchase: params.subPurchase,
      phase: "active",
      bulletSeq: nextSeq,
    };
    this.edges.set(id, entry);
    this.rebuild();

    const fade = setTimeout(() => {
      const current = this.edges.get(id);
      if (!current) return;
      this.edges.set(id, { ...current, phase: "fading" });
      this.rebuild();
    }, LIVE_EDGE_ACTIVE_MS);

    const expire = setTimeout(() => {
      this.edges.delete(id);
      this.timers.delete(id);
      this.rebuild();
    }, LIVE_EDGE_TOTAL_MS);

    this.timers.set(id, { fade, expire });
    return id;
  }

  /** Drop an edge immediately (e.g. if the wallet that owned it was
   *  removed from the tracked set). */
  remove(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer.fade);
      clearTimeout(timer.expire);
      this.timers.delete(id);
    }
    if (this.edges.delete(id)) this.rebuild();
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer.fade);
      clearTimeout(timer.expire);
    }
    this.timers.clear();
    this.edges.clear();
    this.snapshot = [];
    this.notify();
  }

  private rebuild(): void {
    this.snapshot = [...this.edges.values()];
    this.notify();
  }
}

export const liveEdgeStore = new LiveEdgeStore();
