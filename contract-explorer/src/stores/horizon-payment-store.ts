/**
 * Per-address Horizon payments stream.
 *
 * What this does
 * --------------
 * One EventSource per Stellar address, consumed by React via
 * `useSyncExternalStore`. The store owns the lifecycle of the connection
 * (including reconnection) so React components never touch the raw
 * EventSource, never see stale state, and never double-connect in strict
 * mode.
 *
 * Reconnection behaviour
 * ----------------------
 * Per the HTML spec (§9.2.4 Processing model), when a server responds with
 * an HTTP error or the connection fails in a way the browser can't recover
 * from, the `EventSource.readyState` transitions to `CLOSED` (value 2) and
 * the browser does NOT retry. We detect this in `onerror` and schedule a
 * manual reconnect with exponential backoff (1s, 2s, 4s, 8s, 16s, 30s cap).
 *
 * Cursor handling
 * ---------------
 * The first connection opens with `cursor=now` so we only see live events.
 * Every subsequent message updates `lastPagingToken`; on reconnect we open
 * with that cursor so nothing is missed during the outage window.
 *
 * Tab visibility
 * --------------
 * Chrome and Firefox throttle (and eventually kill) EventSources on hidden
 * tabs. On `visibilitychange → visible` we check `readyState` and reconnect
 * immediately if the connection died. The backoff is reset so the user
 * gets instant feedback after switching back.
 *
 * Deduplication
 * -------------
 * When both sides of a payment are tracked wallets, the same payment will
 * arrive on two different EventSources (one for each account). The store
 * is address-scoped so it does NOT dedupe across wallets — callers (the
 * PaymentOrchestrator) handle cross-wallet dedup by payment id.
 */
import { amountToStroops, normalisePayment } from "@/lib/horizon";
import type { HorizonPayment } from "@/lib/types";
import { ExternalStore } from "./external-store";

/** Matches the HTML spec values. */
const EVENT_SOURCE_CONNECTING = 0;
const EVENT_SOURCE_CLOSED = 2;

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface HorizonPaymentSnapshot {
  /** Latest payment ids, newest first. Capped at `MAX_PAYMENTS`. */
  payments: readonly HorizonPayment[];
  /** Tracks EventSource.readyState so the header LIVE dot can colour. */
  status: ConnectionStatus;
  /** Non-null when manual reconnect is scheduled. Used for "Reconnecting…". */
  reconnectAt: number | null;
}

const MAX_PAYMENTS = 200;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** Keep a closed store alive briefly so React strict mode's mount-unmount
 *  dance doesn't thrash the EventSource. */
const DESTROY_DELAY_MS = 200;

/**
 * Payment-received callback. The store carries the latest payments in its
 * snapshot, but cross-store reactions (pulses, feed, live edges) are easier
 * to express through a direct side-channel than by diffing snapshots inside
 * an orchestrator render loop.
 */
export type PaymentListener = (
  address: string,
  payment: HorizonPayment,
) => void;

/**
 * An EventSource connection for one address. Holds its own state; callers
 * read it through useSyncExternalStore.
 */
export class HorizonPaymentStore extends ExternalStore<HorizonPaymentSnapshot> {
  readonly address: string;
  private readonly horizonUrl: string;
  private es: EventSource | null = null;
  private state: HorizonPaymentSnapshot = {
    payments: [],
    status: "connecting",
    reconnectAt: null,
  };
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCursor: string = "now";
  private started = false;
  private paymentListeners = new Set<PaymentListener>();

  constructor(address: string, horizonUrl: string) {
    super();
    this.address = address;
    this.horizonUrl = horizonUrl;
  }

  getSnapshot = (): HorizonPaymentSnapshot => this.state;

  /**
   * Register a callback fired for every new (deduped) USDC payment touching
   * this address. Useful for reactions that don't translate cleanly into
   * diffs from getSnapshot (glow pulses, feed inserts, live edges).
   */
  onPayment(listener: PaymentListener): () => void {
    this.paymentListeners.add(listener);
    return () => {
      this.paymentListeners.delete(listener);
    };
  }

  /** Force a reconnect. Used by the orchestrator on online/visibility events. */
  forceReconnect(): void {
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.closeCurrentConnection();
    this.connect();
  }

  protected override onSubscriberAdded(): void {
    // Strict mode unmounts and immediately remounts — cancel any pending
    // destroy so we keep the existing EventSource alive across the bounce.
    if (this.destroyTimer !== null) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
    if (!this.started) {
      this.started = true;
      this.connect();
    }
  }

  protected override onSubscriberRemoved(): void {
    if (this.subscriberCount() > 0) return;
    if (this.destroyTimer !== null) return;
    this.destroyTimer = setTimeout(() => {
      this.destroyTimer = null;
      this.teardown();
      // Signal the registry that this store is gone. The registry is the
      // authority on "does this address still have a store" so it handles
      // the actual Map.delete.
      const onGone = this.onGoneCallback;
      if (onGone) onGone(this.address);
    }, DESTROY_DELAY_MS);
  }

  private onGoneCallback: ((address: string) => void) | null = null;
  /** @internal */
  setOnGone(cb: (address: string) => void): void {
    this.onGoneCallback = cb;
  }

  private connect(): void {
    // Skip placeholder and obviously invalid addresses. The hook
    // use-wallet-data-map pads unused slots with a GAAAA… placeholder;
    // opening an EventSource on it would fire endless 400 errors.
    if (
      this.address.length !== 56 ||
      !this.address.startsWith("G") ||
      /^G(.)\1{54}$/.test(this.address)
    ) {
      this.setState({ status: "closed", reconnectAt: null });
      return;
    }

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setState({ status: "connecting", reconnectAt: null });

    const url = `${this.horizonUrl}/accounts/${this.address}/payments?cursor=${this.lastCursor}`;
    const es = new EventSource(url);
    this.es = es;

    es.onopen = () => {
      // First message will re-affirm this, but flipping immediately gives the
      // LIVE dot a quick green pulse as soon as the socket opens.
      this.setState({ status: "open", reconnectAt: null });
    };

    es.onmessage = (event) => {
      // Horizon starts every stream with a keepalive `"hello"` payload that
      // isn't valid JSON for our payment shape. Skip silently.
      if (event.data === '"hello"' || event.data === "hello") return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        // Malformed payload from Horizon. Keep the stream open.
        return;
      }

      const payment = normalisePayment(parsed);
      if (!payment) return;
      if (!isUsdcByCode(payment)) return;

      // Track the cursor so reconnects resume from the last seen event.
      if (payment.pagingToken) this.lastCursor = payment.pagingToken;

      // Successful message: the connection is definitely OPEN. Any pending
      // backoff from a previous failure should reset for next error.
      this.backoffMs = INITIAL_BACKOFF_MS;

      // Prepend and cap. Dedupe by id because a reconnect can replay the
      // last-seen event.
      const payments = this.state.payments;
      if (payments.some((p) => p.id === payment.id)) return;
      const next = [payment, ...payments].slice(0, MAX_PAYMENTS);
      this.setState({
        payments: next,
        status: "open",
        reconnectAt: null,
      });

      for (const listener of this.paymentListeners) {
        listener(this.address, payment);
      }
    };

    es.onerror = () => {
      // readyState tells us whether the browser is still trying:
      //   0 = CONNECTING (browser's own backoff) → leave it alone
      //   1 = OPEN       (shouldn't see errors in this state) → leave it
      //   2 = CLOSED     (browser gave up) → manual reconnect is required
      if (!this.es) return;
      if (this.es.readyState === EVENT_SOURCE_CONNECTING) {
        // The browser is still trying. Flip the indicator but don't
        // intervene yet.
        this.setState({ status: "connecting", reconnectAt: null });
        return;
      }
      if (this.es.readyState === EVENT_SOURCE_CLOSED) {
        this.closeCurrentConnection();
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    const at = Date.now() + delay;
    this.setState({ status: "closed", reconnectAt: at });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private closeCurrentConnection(): void {
    if (this.es) {
      this.es.onopen = null;
      this.es.onmessage = null;
      this.es.onerror = null;
      this.es.close();
      this.es = null;
    }
  }

  private teardown(): void {
    this.closeCurrentConnection();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.paymentListeners.clear();
    this.started = false;
    this.setState({ status: "closed", reconnectAt: null });
  }

  private setState(partial: Partial<HorizonPaymentSnapshot>): void {
    const next: HorizonPaymentSnapshot = { ...this.state, ...partial };
    // Reference equality check so we don't notify for a redundant update.
    if (
      next.payments === this.state.payments &&
      next.status === this.state.status &&
      next.reconnectAt === this.state.reconnectAt
    ) {
      return;
    }
    this.state = next;
    this.notify();
  }
}

/**
 * Filter by asset code only (not issuer). A wallet may use any USDC-branded
 * trustline; we care about the ticker, not who printed it. This is also what
 * the audit spec explicitly requires.
 *
 * `amountToStroops` is only used to parse the amount once the code matches,
 * so its presence here is defensive: skip anything that is not a USDC ledger
 * entry even if normalisePayment accepted it.
 */
function isUsdcByCode(payment: HorizonPayment): boolean {
  if (payment.assetType === "native") return false;
  if (payment.assetCode !== "USDC") return false;
  // amountToStroops is pure — the call is an integrity gate: if the amount
  // string is garbled, we want to drop the event here rather than push
  // zero-value noise down to the feed. Any value (including 0) means parse
  // succeeded.
  amountToStroops(payment.amount);
  return true;
}

// ─── singleton registry ─────────────────────────────────────────────────────

const registry = new Map<string, HorizonPaymentStore>();

export function getHorizonPaymentStore(
  address: string,
  horizonUrl: string,
): HorizonPaymentStore {
  let store = registry.get(address);
  if (!store) {
    store = new HorizonPaymentStore(address, horizonUrl);
    store.setOnGone((addr) => registry.delete(addr));
    registry.set(address, store);
  }
  return store;
}

/** For tests + the orchestrator. Returns a snapshot of the current live set. */
export function listHorizonPaymentStores(): HorizonPaymentStore[] {
  return [...registry.values()];
}
