/**
 * Small external stores that wrap browser APIs. Each exposes a
 * `useSyncExternalStore`-shaped pair of `subscribe` + `getSnapshot` so the
 * dashboard can read browser state (reduced motion, visibility, online,
 * global tick) without any useEffect subscription code in components.
 */

// ─── prefers-reduced-motion ────────────────────────────────────────────────

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  // Older Safari versions only implement the deprecated addListener API.
  // Cover both so the dashboard doesn't degrade in those browsers.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", callback);
    return () => mql.removeEventListener("change", callback);
  }
  mql.addListener(callback);
  return () => mql.removeListener(callback);
}

function getReducedMotionSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getServerReducedMotionSnapshot(): boolean {
  return false;
}

export const reducedMotionStore = {
  subscribe: subscribeReducedMotion,
  getSnapshot: getReducedMotionSnapshot,
  getServerSnapshot: getServerReducedMotionSnapshot,
};

// ─── document.visibilityState ──────────────────────────────────────────────

function subscribeVisibility(callback: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

function getVisibilitySnapshot(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible";
}

function getServerVisibilitySnapshot(): boolean {
  return true;
}

export const visibilityStore = {
  subscribe: subscribeVisibility,
  getSnapshot: getVisibilitySnapshot,
  getServerSnapshot: getServerVisibilitySnapshot,
};

// ─── navigator.onLine ──────────────────────────────────────────────────────

function subscribeOnline(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getOnlineSnapshot(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

function getServerOnlineSnapshot(): boolean {
  return true;
}

export const onlineStore = {
  subscribe: subscribeOnline,
  getSnapshot: getOnlineSnapshot,
  getServerSnapshot: getServerOnlineSnapshot,
};

// ─── global 10 s tick (relative-time labels) ───────────────────────────────

/**
 * A single shared ticker drives every "relative time" label in the feed.
 * Without it, each row would mount its own interval and the dashboard would
 * burn renders even when no data changes. The ticker only runs while at
 * least one subscriber is listening — avoids a zombie timer when the feed
 * is unmounted.
 */
class TickStore {
  private tick = 0;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  getSnapshot = (): number => this.tick;

  getServerSnapshot = (): number => 0;

  private start(): void {
    if (this.timerId !== null) return;
    this.timerId = setInterval(() => {
      this.tick = (this.tick + 1) & 0x7fffffff;
      for (const l of this.listeners) l();
    }, 10_000);
  }

  private stop(): void {
    if (this.timerId === null) return;
    clearInterval(this.timerId);
    this.timerId = null;
  }
}

export const tickStore = new TickStore();
