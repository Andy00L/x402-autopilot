/**
 * Base class for external stores consumed via `useSyncExternalStore`.
 *
 * Contract:
 *   - `subscribe(listener)` registers a callback. React will call it once per
 *     component that depends on this store. Returns an unsubscribe function.
 *   - `getSnapshot()` returns a stable reference. The same object must come
 *     back every call until the store notifies. React uses reference equality
 *     to decide whether to re-render, so mutating the returned value in place
 *     is a correctness bug (components won't see the change).
 *   - `notify()` is called by subclasses after mutating internal state. It
 *     loops over listeners. It does NOT call React directly — React is what
 *     owns the scheduling via the returned subscribe callback.
 *
 * Subclasses are responsible for:
 *   - Mutating internal state through a single method that produces a new
 *     snapshot object and then calls `notify()`.
 *   - Cleaning up external resources (timers, EventSources, listeners) in a
 *     `destroy()` method. The base class does not enforce this because some
 *     stores are module-level singletons that never destroy.
 */
export abstract class ExternalStore<Snapshot> {
  private listeners = new Set<() => void>();

  /**
   * React passes us a callback. We add it to a set and return the cleanup.
   * This must be an arrow property (not a method) so the caller can pass
   * `store.subscribe` directly to `useSyncExternalStore` without binding.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.onSubscriberAdded();
    return () => {
      this.listeners.delete(listener);
      this.onSubscriberRemoved();
    };
  };

  /**
   * Must return the same reference if nothing has changed since the last
   * call. Subclasses cache their state object and swap references on
   * update.
   */
  abstract getSnapshot: () => Snapshot;

  protected notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Number of active React subscribers. Used by stores that need to know
   *  when they have zero consumers and should release resources. */
  protected subscriberCount(): number {
    return this.listeners.size;
  }

  /** Hooks for subclasses that want to lazy-start / lazy-stop based on
   *  subscriber count. Default implementations are no-ops. */
  protected onSubscriberAdded(): void {}
  protected onSubscriberRemoved(): void {}
}
