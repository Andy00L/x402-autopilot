/**
 * Module-level singleton that wires the independent stores together and
 * produces the cross-cutting reactions the dashboard needs when a payment
 * lands or a contract event appears.
 *
 * Responsibilities
 * ----------------
 * 1. Keep a HorizonPaymentStore per tracked wallet, subscribing to
 *    `onPayment` so that payments trigger feed rows, wallet pulses,
 *    and transient live edges in the graph.
 * 2. Keep a HorizonWalletDataStore per tracked wallet and make sure the
 *    in-memory totals advance immediately on live payments (so the
 *    node stats don't lag 20 s behind the stream).
 * 3. Subscribe to the SorobanStore's event channel and translate fresh
 *    contract events into feed rows.
 * 4. Add / remove stores when the user adds or removes wallets.
 * 5. Force-reconnect live streams when the tab becomes visible again
 *    or the network comes back online.
 *
 * All of this lives OUTSIDE React. React components read the resulting
 * state from the underlying stores via `useSyncExternalStore`.
 */
import type { TrackedWallet } from "./dashboard-store";
import { useDashboardStore } from "./dashboard-store";
import { liveEdgeStore } from "./live-edge-store";
import {
  getHorizonPaymentStore,
  listHorizonPaymentStores,
} from "./horizon-payment-store";
import {
  getHorizonWalletDataStore,
  type HorizonWalletDataStore,
} from "./horizon-wallet-data-store";
import { getSorobanStore } from "./soroban-store";
import { DEFAULTS } from "@/lib/constants";
import { amountToStroops } from "@/lib/horizon";
import { formatUsdc, truncateAddress } from "@/lib/utils";
import type {
  ContractEvent,
  FeedEvent,
  HorizonPayment,
  ServiceInfo,
} from "@/lib/types";

/** Shape of a single balance change inside an invoke_host_function op. */
interface AssetBalanceChange {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  type?: string; // "transfer" | "mint" | "burn" | "clawback"
  from?: string;
  to?: string;
  amount?: string;
}

class PaymentOrchestrator {
  private paymentUnsubs = new Map<string, () => void>();
  private walletDataStores = new Map<string, HorizonWalletDataStore>();
  private walletDataUnsubs = new Map<string, () => void>();
  private sorobanUnsub: (() => void) | null = null;
  private dashboardUnsub: (() => void) | null = null;
  private walletSet = new Set<string>();
  private walletLabels = new Map<string, string>();
  private servicesByOwner = new Map<string, ServiceInfo[]>();
  /** Reverse index `recipientAddress → ServiceInfo[]`. Populated from two
   *  sources so it covers every registration state the trust-registry can
   *  be in (main-owned / service-owned / mixed):
   *    1. Every `svc.owner` entry is mirrored in here by
   *       `updateServicesByOwner` so the healthy steady state (the service
   *       self-registered under its own wallet) resolves on the first
   *       Soroban poll.
   *    2. Observed payment destinations — when `onLivePayment` or
   *       `onAnalystOperation` resolves a bullet to a `service:<id>`
   *       node, the recipient address is cached here so later events
   *       whose recipient matches the payTo can resolve against the
   *       same service even if the on-chain `owner` field points at a
   *       different wallet (e.g. a stale seed-registry entry). */
  private servicesByPayTo = new Map<string, ServiceInfo[]>();
  /** Cross-wallet payment dedup: both sides deliver the same event. */
  private seenPaymentIds = new Set<string>();
  /** Cross-poll contract event dedup for the feed. The Soroban store has
   *  its own dedup but clears its `seenIds` at 5000 — ours is feed-scoped. */
  private seenEventIds = new Set<string>();
  /** Dedup for the analyst operations stream. Prevents the same SAC
   *  transfer from firing two bullets if the stream replays on reconnect. */
  private seenAnalystOpIds = new Set<string>();
  /** Dedup across WebSocket + Soroban-poller paths. Keyed on
   *  `recipient:amountBucket` where bucket = Math.floor(now / 5000) to
   *  tolerate a few seconds of clock skew between the two sources. */
  private seenSpendKeys = new Set<string>();
  /** Addresses auto-added to the tracked wallet list by
   *  `resolveTargetNode` after every normal lookup failed. Session-only
   *  guard that prevents repeated `addWallet` store calls for the same
   *  unknown recipient when multiple events (WebSocket + Soroban +
   *  analyst ops) fire for the same payment. On page refresh the wallet
   *  persists via localStorage, so the next session finds it in
   *  `walletSet` directly and the auto-track path is never reached. */
  private autoTrackedRecipients = new Set<string>();
  /** EventSource for the analyst's Horizon /operations stream. Captures
   *  invoke_host_function ops that include USDC SAC transfers (which the
   *  /payments endpoint does not show). */
  private analystOpsStream: EventSource | null = null;
  private analystOpsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    // React to wallet list changes (add / remove) — the Zustand store is the
    // source of truth.
    this.dashboardUnsub = useDashboardStore.subscribe((state, prev) => {
      if (state.wallets !== prev.wallets) {
        this.syncWallets(state.wallets);
      }
    });
    this.syncWallets(useDashboardStore.getState().wallets);

    // React to Soroban service discoveries.
    const soroban = getSorobanStore();
    const sorobanStateSub = soroban.subscribe(() => {
      const snap = soroban.getSnapshot();
      this.updateServicesByOwner(snap.registry?.services ?? []);
    });
    const sorobanEventSub = soroban.onEvents((events) => {
      this.onContractEvents(events);
    });
    this.sorobanUnsub = () => {
      sorobanStateSub();
      sorobanEventSub();
    };

    // Seed the services-by-owner map from whatever is already in memory.
    this.updateServicesByOwner(soroban.getSnapshot().registry?.services ?? []);

    // Start the analyst operations stream for sub-purchase bullets.
    this.startAnalystOpsStream();

    // Browser lifecycle: reconnect streams when visibility / online flip.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibility);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleOnline);
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.dashboardUnsub?.();
    this.dashboardUnsub = null;
    this.sorobanUnsub?.();
    this.sorobanUnsub = null;
    for (const unsub of this.paymentUnsubs.values()) unsub();
    this.paymentUnsubs.clear();
    for (const unsub of this.walletDataUnsubs.values()) unsub();
    this.walletDataUnsubs.clear();
    this.walletDataStores.clear();
    this.walletSet.clear();
    this.walletLabels.clear();
    this.servicesByOwner.clear();
    this.servicesByPayTo.clear();
    this.autoTrackedRecipients.clear();
    this.stopAnalystOpsStream();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibility);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
    }
  }

  private syncWallets(wallets: TrackedWallet[]): void {
    const nextSet = new Set(wallets.map((w) => w.address));
    this.walletLabels.clear();
    for (const w of wallets) this.walletLabels.set(w.address, w.label);

    // Remove stores for wallets that were deleted.
    for (const address of [...this.walletSet]) {
      if (nextSet.has(address)) continue;
      const unsub = this.paymentUnsubs.get(address);
      unsub?.();
      this.paymentUnsubs.delete(address);
      const dataUnsub = this.walletDataUnsubs.get(address);
      dataUnsub?.();
      this.walletDataUnsubs.delete(address);
      this.walletDataStores.delete(address);
      this.walletSet.delete(address);
    }

    // Add stores for new wallets. The stores are refcounted so subscribing
    // here alone is enough to keep them alive — when React components
    // unmount they don't tear the store down because we hold a subscription.
    for (const wallet of wallets) {
      if (this.walletSet.has(wallet.address)) continue;
      const paymentStore = getHorizonPaymentStore(
        wallet.address,
        DEFAULTS.HORIZON_URL,
      );
      // Dummy React-free subscription so the store starts polling.
      const unsub1 = paymentStore.subscribe(() => {});
      const unsub2 = paymentStore.onPayment((addr, payment) => {
        this.onLivePayment(addr, payment);
      });
      this.paymentUnsubs.set(wallet.address, () => {
        unsub1();
        unsub2();
      });

      const dataStore = getHorizonWalletDataStore(
        wallet.address,
        DEFAULTS.HORIZON_URL,
      );
      const dataUnsub = dataStore.subscribe(() => {});
      this.walletDataUnsubs.set(wallet.address, dataUnsub);
      this.walletDataStores.set(wallet.address, dataStore);

      this.walletSet.add(wallet.address);
    }
  }

  private updateServicesByOwner(services: readonly ServiceInfo[]): void {
    const nextByOwner = new Map<string, ServiceInfo[]>();
    for (const svc of services) {
      const arr = nextByOwner.get(svc.owner) ?? [];
      arr.push(svc);
      nextByOwner.set(svc.owner, arr);
    }
    this.servicesByOwner = nextByOwner;

    // Mirror the owner→services mapping into the payTo reverse index so the
    // healthy steady state (service self-registered under its own wallet)
    // resolves immediately, without waiting for a live payment to teach the
    // index. Previously-learned payTo→service associations are preserved —
    // they remain valid even if the registry's `owner` field is stale (e.g.
    // an old seed-registry entry still owned by the main wallet). The owner
    // mirror just adds a second, equally valid route into the same entries.
    for (const svc of services) {
      const existing = this.servicesByPayTo.get(svc.owner);
      if (!existing) {
        this.servicesByPayTo.set(svc.owner, [svc]);
        continue;
      }
      if (!existing.some((s) => s.id === svc.id)) {
        existing.push(svc);
      }
    }
  }

  /**
   * Remember that payments to `address` should target `service`. Called by
   * `onLivePayment` and `onAnalystOperation` after they resolve a bullet to
   * a specific service node, so that later spend_ok events whose recipient
   * matches `address` can fast-path the same service even if the
   * trust-registry's `owner` field disagrees (as happens whenever an old
   * seed-registry.ts entry is still alive on the chain).
   *
   * Also opportunistically labels the wallet — if the wallet is currently
   * showing the default truncated address, replace it with the formatted
   * service name so the dashboard's wallet card stops saying
   * "Wallet GB2K…BD3E" and starts saying "Crypto Prices".
   */
  private rememberPayToService(address: string, service: ServiceInfo): void {
    if (!address || address.length !== 56 || !address.startsWith("G")) return;
    const existing = this.servicesByPayTo.get(address);
    if (!existing) {
      this.servicesByPayTo.set(address, [service]);
    } else if (!existing.some((s) => s.id === service.id)) {
      existing.push(service);
    }
    this.relabelIfDefault(address, formatServiceName(service.name));
  }

  /**
   * Replace the dashboard-store label for `address` with `nextLabel`, but
   * ONLY if the current label still matches the default truncated pattern
   * (`Wallet ABCD…WXYZ`). This protects user-customised labels — the
   * orchestrator's auto-relabel never overwrites a name the user typed
   * themselves via the header rename flow.
   *
   * Persistence is handled by the dashboard store's existing
   * `renameWallet` action, which writes to localStorage on every update.
   */
  private relabelIfDefault(address: string, nextLabel: string): void {
    if (!nextLabel || !address) return;
    const wallets = useDashboardStore.getState().wallets;
    const current = wallets.find((w) => w.address === address);
    if (!current) return;
    if (current.label === nextLabel) return;
    if (!isDefaultWalletLabel(current.label, address)) return;
    useDashboardStore.getState().renameWallet(address, nextLabel);
  }

  /**
   * Resolve a recipient address to a graph node id, trying every lookup
   * path we know about. Returns null only when the recipient is not a
   * valid Stellar public key or is the main wallet itself.
   *
   * Order (cheapest-first, broadest-match-last):
   *   1. servicesByOwner  — keyed on the Soroban registry's `owner` field
   *   2. servicesByPayTo  — the learned reverse index, populated from
   *                         both `updateServicesByOwner` and observed
   *                         payment destinations
   *   3. full scan of the live Soroban snapshot by `owner` — the cold
   *      path for the very first event that arrives before the cache
   *      has been hydrated; also writes through so future lookups hit #1
   *   4. walletSet        — if the recipient is a tracked wallet, route
   *                         the bullet to the wallet node directly
   *   5. auto-track       — if the recipient is still unknown but is a
   *                         valid G-address, add it to the dashboard
   *                         store's tracked wallet list and return the
   *                         new wallet node id. Zustand v5 `set` is
   *                         synchronous, and the orchestrator's own
   *                         dashboard-store subscription runs
   *                         `syncWallets` inside that notify pass, so
   *                         by the time we return, `walletSet` already
   *                         contains the new address and Horizon
   *                         polling has started for it. React 19
   *                         batches the resulting `wallets` update and
   *                         the subsequent `liveEdgeStore.add` into a
   *                         single render, so the bullet fires to the
   *                         newly-appearing wallet node in the same
   *                         frame.
   *
   * Returning the resolved ServiceInfo (when there is one) lets callers
   * on the Horizon / analyst-ops paths pulse the right service node and
   * teach `servicesByPayTo` about the recipient address.
   */
  private resolveTargetNode(recipient: string): {
    targetNodeId: string;
    service: ServiceInfo | null;
  } | null {
    let services = this.servicesByOwner.get(recipient);
    if (!services || services.length === 0) {
      services = this.servicesByPayTo.get(recipient);
    }
    if (!services || services.length === 0) {
      const snap = getSorobanStore().getSnapshot();
      const fallback = (snap.registry?.services ?? []).filter(
        (s) => s.owner === recipient,
      );
      if (fallback.length > 0) {
        services = fallback;
        this.servicesByOwner.set(recipient, fallback);
      }
    }

    const first = services?.[0];
    if (first !== undefined) {
      return { targetNodeId: `service:${first.id}`, service: first };
    }
    if (this.walletSet.has(recipient)) {
      return { targetNodeId: `wallet:${recipient}`, service: null };
    }

    // ── Auto-track fallback ──────────────────────────────────────────
    // All normal lookups failed. Before giving up, add the recipient to
    // the dashboard store's tracked wallet list so the graph gains a
    // node for it on the very next render. Guarded against invalid
    // addresses, the main wallet, and repeated calls within the same
    // session.
    if (
      recipient.length !== 56 ||
      !recipient.startsWith("G") ||
      !/^[A-Z2-7]+$/.test(recipient)
    ) {
      return null;
    }
    const mainAddress = useDashboardStore.getState().wallets[0]?.address;
    if (recipient === mainAddress) return null;
    if (this.autoTrackedRecipients.has(recipient)) {
      // A prior event in the same session already auto-tracked this
      // recipient but `walletSet.has(recipient)` returned false above,
      // which would be a bug — the dashboard-store subscription should
      // have synced walletSet on the original addWallet call. Guard
      // anyway so a stale state can't trigger a storm of addWallet
      // calls, and still return a valid target so the bullet fires.
      return { targetNodeId: `wallet:${recipient}`, service: null };
    }

    const result = useDashboardStore.getState().addWallet(recipient);
    if (!result.ok) {
      // The only way this can fail for a syntactically valid G-address
      // is `already tracked`, which would mean our walletSet fell out
      // of sync with the store. Bail out cleanly so emitBulletCore's
      // caller path still runs and the feed row pushes.
      return null;
    }

    // `addWallet` called `set({ wallets: next })` which Zustand v5
    // notifies synchronously — including the orchestrator's
    // `this.dashboardUnsub` handler, which runs `syncWallets` and adds
    // the recipient to `this.walletSet`. The explicit adds below are
    // idempotent defence-in-depth so a future refactor of that
    // subscription path can't silently break this flow.
    this.walletSet.add(recipient);
    this.autoTrackedRecipients.add(recipient);

    console.info(
      "[bullet] auto-tracked recipient",
      recipient.slice(0, 8),
      "as wallet node",
    );

    return { targetNodeId: `wallet:${recipient}`, service: null };
  }

  private onLivePayment(observer: string, payment: HorizonPayment): void {
    // Cross-wallet dedup. If both from and to are tracked, two streams will
    // deliver the same event.
    if (this.seenPaymentIds.has(payment.id)) return;
    this.seenPaymentIds.add(payment.id);
    if (this.seenPaymentIds.size > 1_000) {
      // Bound the set — ids older than ~30 min are no longer at risk of
      // arriving via a second stream.
      const arr = [...this.seenPaymentIds];
      this.seenPaymentIds = new Set(arr.slice(-500));
    }

    // Update per-wallet totals immediately so nodes don't wait 20 s for the
    // next REST refresh.
    const fromStore = this.walletDataStores.get(payment.from);
    const toStore = this.walletDataStores.get(payment.to);
    fromStore?.applyLivePayment(payment);
    if (toStore && toStore !== fromStore) toStore.applyLivePayment(payment);

    const fromIsTracked = this.walletSet.has(payment.from);
    const toIsTracked = this.walletSet.has(payment.to);
    if (!fromIsTracked && !toIsTracked) return;

    // Observer canonicalisation: handle from the receiver if tracked,
    // otherwise from the sender. Belt-and-brace even though the dedup set
    // above already covers this.
    if (toIsTracked && observer !== payment.to) return;
    if (!toIsTracked && observer !== payment.from) return;

    const stroops = amountToStroops(payment.amount);
    const fromIsSeller = this.servicesByOwner.has(payment.from);
    const subPurchase =
      fromIsTracked && toIsTracked && fromIsSeller && payment.from !== payment.to;

    // Resolve the target node through the shared lookup chain so any
    // Horizon native-USDC payment benefits from the same reverse-index
    // fallbacks the WebSocket / Soroban paths use. If the sender isn't a
    // tracked wallet there is no source graph node, so we skip the
    // bullet entirely (the feed row still pushes below).
    const resolved = this.resolveTargetNode(payment.to);
    const sourceNodeId = `wallet:${payment.from}`;

    if (
      fromIsTracked &&
      resolved !== null &&
      payment.from !== payment.to
    ) {
      liveEdgeStore.add({
        sourceNodeId,
        targetNodeId: resolved.targetNodeId,
        subPurchase,
      });
      // Teach the reverse index: this recipient address is known to
      // receive payments that should target this service. Later WS /
      // Soroban events with the same recipient can skip straight to the
      // same node even if the registry's `owner` field is stale.
      if (resolved.service) {
        this.rememberPayToService(payment.to, resolved.service);
      }
    }

    const dashboard = useDashboardStore.getState();
    if (fromIsTracked) dashboard.pulseWallet(payment.from);
    if (toIsTracked) dashboard.pulseWallet(payment.to);
    if (resolved?.service) {
      dashboard.pulseService(resolved.service.owner);
    }

    const fromLabel = this.labelFor(payment.from);
    const toLabel = resolved?.service?.name ?? this.labelFor(payment.to);

    const feedEvent: FeedEvent = {
      id: `pay:${payment.id}`,
      kind: subPurchase ? "sub-buy" : "spend",
      observedAt: Date.now(),
      title: `${fromLabel} → ${toLabel}`,
      subtitle: payment.transactionHash
        ? truncateAddress(payment.transactionHash, 6, 4)
        : undefined,
      amountStroops: stroops,
      badge: subPurchase ? "sub-buy" : "spend",
      accent: subPurchase ? "gold" : "success",
      animatedBar: true,
      txHash:
        payment.transactionHash && /^[a-f0-9]{64}$/i.test(payment.transactionHash)
          ? payment.transactionHash
          : undefined,
    };
    dashboard.pushFeed(feedEvent);
  }

  private onContractEvents(events: ContractEvent[]): void {
    const dashboard = useDashboardStore.getState();
    for (const ev of events) {
      if (this.seenEventIds.has(ev.id)) continue;
      this.seenEventIds.add(ev.id);
      const fe = contractEventToFeed(ev);
      if (fe) dashboard.pushFeed(fe);

      // ── Bullet edge from spend_ok ─────────────────────────────────
      //
      // x402 payments are SAC (Stellar Asset Contract) transfers, which
      // are Soroban contract invocations, not Horizon "payment"
      // operations. The Horizon EventSource on /payments never fires
      // for them. The ONLY path that sees these payments is the Soroban
      // event poller (getEvents), which is what feeds us here.
      //
      // Extract the recipient address from the spend_ok event data and
      // map it to a graph node via resolveTargetNode (tries
      // servicesByOwner, servicesByPayTo, the live Soroban snapshot,
      // and finally the tracked walletSet).
      if (ev.kind === "spend_ok" && ev.contract === "wallet-policy") {
        const recipient = String(ev.data.recipient ?? "");
        const amount = String(ev.data.amount ?? "0");
        if (recipient && recipient.startsWith("G") && recipient.length === 56) {
          const key = this.spendDedup(recipient, amount);
          // Dedup: if the WebSocket path already handled this, skip.
          // Crucially the dedup key is only set AFTER emitBulletCore
          // succeeds — otherwise a failed WebSocket attempt would
          // poison the key and block this retry, even though by now
          // the reverse index may have been hydrated.
          if (!this.seenSpendKeys.has(key)) {
            if (this.emitBulletCore(recipient)) {
              this.seenSpendKeys.add(key);
              this.trimSeenSpendKeys();
            }
          }
        }
      }
    }
    if (this.seenEventIds.size > 2_000) {
      const arr = [...this.seenEventIds];
      this.seenEventIds = new Set(arr.slice(-1_000));
    }
  }

  /**
   * Called by the WS budget store when a `spend:ok` WebSocket message
   * arrives from the backend. Fires a bullet edge IMMEDIATELY (sub-second
   * latency) and pushes a feed event. The Soroban poller may find the
   * same event ~15 s later; the dedup key prevents a second bullet/feed.
   *
   * The dedup key is only added to `seenSpendKeys` if emitBulletCore
   * actually resolved a target and queued a bullet. Otherwise the
   * Soroban poller path gets a fresh retry when it sees the same event
   * later — by then the reverse index may have been hydrated by an
   * intervening Horizon / analyst-ops payment, so the retry can succeed
   * even if this first attempt couldn't resolve the recipient.
   */
  handleWebSocketSpend(data: {
    recipient: string;
    amount: string;
    txHash?: string;
    url?: string;
  }): void {
    const { recipient, amount, txHash, url } = data;
    if (!recipient || !recipient.startsWith("G") || recipient.length !== 56) return;

    const key = this.spendDedup(recipient, amount);
    if (this.seenSpendKeys.has(key)) return;

    // Attempt the bullet FIRST so we know whether the dedup key should
    // be set. A failed attempt does not mark the event as handled.
    if (this.emitBulletCore(recipient)) {
      this.seenSpendKeys.add(key);
      this.trimSeenSpendKeys();
    }

    // Feed row is pushed regardless of whether the bullet fired — the
    // feed works off-graph and doesn't need a resolved node id.
    const wallets = useDashboardStore.getState().wallets;
    const mainAddress = wallets[0]?.address ?? "";
    const mainLabel = this.labelFor(mainAddress);
    const recipientServices =
      this.servicesByOwner.get(recipient) ??
      this.servicesByPayTo.get(recipient) ??
      [];

    // Opportunistically rename the recipient wallet so the dashboard
    // stops showing "Wallet GB2K…BD3E" once we know what it actually
    // is. Service-name match wins; URL hostname (xlm402.com etc.) is
    // the second-best signal for external recipients.
    const firstService = recipientServices[0];
    if (firstService) {
      this.relabelIfDefault(recipient, formatServiceName(firstService.name));
    } else {
      const urlHint = labelFromUrl(url);
      if (urlHint) this.relabelIfDefault(recipient, urlHint);
    }

    const toLabel = firstService?.name
      ? formatServiceName(firstService.name)
      : this.labelFor(recipient);
    const stroops = BigInt(amount || "0");
    const validHash =
      txHash && /^[a-f0-9]{64}$/i.test(txHash) ? txHash : undefined;

    const dashboard = useDashboardStore.getState();
    dashboard.pushFeed({
      id: `ws-spend:${Date.now()}:${recipient.slice(-6)}`,
      kind: "spend",
      observedAt: Date.now(),
      title: `${mainLabel} → ${toLabel}`,
      subtitle: url ? shortenUrl(url) : undefined,
      amountStroops: stroops,
      badge: "spend",
      accent: "success",
      animatedBar: true,
      txHash: validHash,
    });
  }

  private spendDedup(recipient: string, amount: string): string {
    const bucket = Math.floor(Date.now() / 5_000);
    return `${recipient}:${amount}:${bucket}`;
  }

  private trimSeenSpendKeys(): void {
    if (this.seenSpendKeys.size > 200) {
      const arr = [...this.seenSpendKeys];
      this.seenSpendKeys = new Set(arr.slice(-100));
    }
  }

  /**
   * Shared bullet + pulse + balance-refresh logic used by both the
   * WebSocket path and the Soroban poller path.
   *
   * Returns `true` when a bullet was queued on the live-edge store, `false`
   * when the target couldn't be resolved. Callers use the return value to
   * gate dedup-key insertion: a failed attempt must NOT poison the
   * `seenSpendKeys` set, otherwise the other event source (Soroban poller
   * behind WebSocket, or vice versa) won't get a fresh retry later when
   * the reverse index might have been hydrated by an observed payment.
   */
  private emitBulletCore(recipient: string): boolean {
    // Source is the wallet-policy owner (first tracked wallet by
    // convention, since the policy contract requires owner auth).
    const wallets = useDashboardStore.getState().wallets;
    const mainAddress = wallets[0]?.address;
    if (!mainAddress) return false;

    // Self-payment guard. Counts as "successfully handled" so the caller
    // doesn't pointlessly retry on every subsequent source for the same
    // self-payment; the dedup key should still be set.
    if (recipient === mainAddress) return true;

    const resolved = this.resolveTargetNode(recipient);
    if (!resolved) {
      // Reaching here means the recipient was invalid (bad format) or
      // the auto-track fallback bailed out for an internal reason
      // (already-tracked race with the dashboard store). Normal
      // unknown-recipient events are saved by the auto-track path and
      // never fall through to this warn.
      console.warn(
        "[bullet] no target node for recipient",
        recipient.slice(0, 8),
        "| servicesByOwner:",
        this.servicesByOwner.size,
        "| servicesByPayTo:",
        this.servicesByPayTo.size,
        "| walletSet size:",
        this.walletSet.size,
      );
      return false;
    }

    const sourceNodeId = `wallet:${mainAddress}`;
    const fromIsSeller = this.servicesByOwner.has(mainAddress);
    const subPurchase = fromIsSeller && recipient !== mainAddress;

    liveEdgeStore.add({
      sourceNodeId,
      targetNodeId: resolved.targetNodeId,
      subPurchase,
    });

    // Pulse the source and target nodes so they glow briefly.
    const dashboard = useDashboardStore.getState();
    dashboard.pulseWallet(mainAddress);
    if (this.walletSet.has(recipient)) {
      dashboard.pulseWallet(recipient);
    }
    if (resolved.service) {
      dashboard.pulseService(resolved.service.owner);
    }

    // Trigger immediate Horizon re-fetch for both sender and recipient
    // so PnL stats update within seconds. The pollNow method is
    // debounced (1 s) so rapid payments don't hammer Horizon.
    this.walletDataStores.get(mainAddress)?.pollNow();
    this.walletDataStores.get(recipient)?.pollNow();

    return true;
  }

  // ─── Analyst operations stream ───────────────────────────────────────
  //
  // The analyst uses its own x402 client (ANALYST_PRIVATE_KEY), so its
  // payments are SAC transfers that don't go through the main wallet's
  // wallet-policy contract. No `spend_ok` event fires for them. We stream
  // the analyst's Horizon /operations endpoint to catch
  // `invoke_host_function` ops with USDC `asset_balance_changes`.

  private startAnalystOpsStream(): void {
    const wallets = useDashboardStore.getState().wallets;
    const analystAddress = wallets[1]?.address;
    if (!analystAddress) return;

    const connectOps = (): void => {
      if (this.analystOpsStream) {
        this.analystOpsStream.close();
        this.analystOpsStream = null;
      }
      const url =
        `${DEFAULTS.HORIZON_URL}/accounts/${analystAddress}/operations` +
        `?cursor=now&include_failed=false&limit=10`;
      const es = new EventSource(url);
      this.analystOpsStream = es;

      es.onmessage = (msg) => {
        try {
          const op = JSON.parse(msg.data) as Record<string, unknown>;
          this.onAnalystOperation(analystAddress, op);
        } catch {
          // ignore malformed
        }
      };

      es.onerror = () => {
        // Only reconnect manually if the browser gave up (readyState CLOSED).
        // readyState CONNECTING means the browser is retrying itself.
        if (es.readyState === 2 /* CLOSED */) {
          es.close();
          this.analystOpsStream = null;
          this.analystOpsReconnectTimer = setTimeout(connectOps, 5_000);
        }
      };
    };

    // Delay first connect to let the ws-server and services start.
    this.analystOpsReconnectTimer = setTimeout(connectOps, 4_000);
  }

  private stopAnalystOpsStream(): void {
    if (this.analystOpsStream) {
      this.analystOpsStream.close();
      this.analystOpsStream = null;
    }
    if (this.analystOpsReconnectTimer) {
      clearTimeout(this.analystOpsReconnectTimer);
      this.analystOpsReconnectTimer = null;
    }
  }

  /**
   * Called for every Horizon operation on the analyst wallet. We only
   * care about `invoke_host_function` ops with `asset_balance_changes`
   * that show an outgoing USDC transfer from the analyst address.
   */
  private onAnalystOperation(
    analystAddress: string,
    op: Record<string, unknown>,
  ): void {
    if (op.type !== "invoke_host_function") return;

    const opId = String(op.id ?? op.paging_token ?? "");
    if (!opId || this.seenAnalystOpIds.has(opId)) return;
    this.seenAnalystOpIds.add(opId);
    if (this.seenAnalystOpIds.size > 500) {
      const arr = [...this.seenAnalystOpIds];
      this.seenAnalystOpIds = new Set(arr.slice(-250));
    }

    const changes = op.asset_balance_changes;
    if (!Array.isArray(changes)) return;

    for (const raw of changes) {
      const change = raw as AssetBalanceChange;
      if (change.type !== "transfer") continue;
      if (change.asset_code !== "USDC") continue;
      if (change.from !== analystAddress) continue;

      const recipient = change.to;
      if (!recipient || recipient.length !== 56 || !recipient.startsWith("G")) {
        continue;
      }

      // Resolve the analyst's sub-purchase target through the shared
      // lookup chain so it benefits from the same reverse-index and
      // walletSet fallbacks used by the main-wallet bullet path.
      const resolved = this.resolveTargetNode(recipient);
      if (!resolved) continue;

      const sourceNodeId = `wallet:${analystAddress}`;

      liveEdgeStore.add({
        sourceNodeId,
        targetNodeId: resolved.targetNodeId,
        subPurchase: true,
      });

      // Teach the reverse index so later spend_ok events with this same
      // recipient address resolve to the same service node without
      // having to wait for another analyst op.
      if (resolved.service) {
        this.rememberPayToService(recipient, resolved.service);
      }

      // Pulse nodes.
      const dashboard = useDashboardStore.getState();
      dashboard.pulseWallet(analystAddress);
      if (resolved.service) {
        dashboard.pulseService(resolved.service.owner);
      }

      // Feed row for the sub-purchase.
      const toLabel = resolved.service?.name ?? truncateAddress(recipient, 4, 4);
      const amount = change.amount ?? "0";
      const stroops = amountToStroops(amount);
      dashboard.pushFeed({
        id: `sub-buy:${opId}:${recipient.slice(-6)}`,
        kind: "sub-buy",
        observedAt: Date.now(),
        title: `${this.labelFor(analystAddress)} → ${toLabel}`,
        amountStroops: stroops,
        badge: "sub-buy",
        accent: "gold",
        animatedBar: true,
      });

      // Re-fetch analyst balance.
      this.walletDataStores.get(analystAddress)?.pollNow();
      this.walletDataStores.get(recipient)?.pollNow();
    }
  }

  private labelFor(address: string): string {
    return this.walletLabels.get(address) ?? truncateAddress(address, 4, 4);
  }

  private handleVisibility = (): void => {
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;
    // Tab came back. Reconnect any stream whose EventSource died while
    // hidden. The store is idempotent: if it's already open, forceReconnect
    // is a no-op-ish that resets the backoff.
    for (const store of listHorizonPaymentStores()) {
      const snap = store.getSnapshot();
      if (snap.status === "closed") store.forceReconnect();
    }
    // Restart the analyst ops stream if it died while the tab was hidden.
    if (!this.analystOpsStream || this.analystOpsStream.readyState === 2) {
      this.stopAnalystOpsStream();
      this.startAnalystOpsStream();
    }
  };

  private handleOnline = (): void => {
    for (const store of listHorizonPaymentStores()) {
      store.forceReconnect();
    }
    // Restart analyst ops stream.
    this.stopAnalystOpsStream();
    this.startAnalystOpsStream();
    // Kick a Soroban refresh too in case the last poll failed while offline.
    getSorobanStore().refresh();
  };
}

function contractEventToFeed(ev: ContractEvent): FeedEvent | null {
  const observedAt = ev.timestamp
    ? new Date(ev.timestamp).getTime() || Date.now()
    : Date.now();
  switch (ev.kind) {
    case "register":
      return {
        id: `reg:${ev.id}`,
        kind: "register",
        observedAt,
        title: `${String(ev.data.capability ?? "service")} registered`,
        subtitle: `ID:${String(ev.data.id ?? "?")}`,
        badge: "reg",
        accent: "info",
        animatedBar: false,
        txHash: ev.txHash,
      };
    case "deregister":
      return {
        id: `dereg:${ev.id}`,
        kind: "deregister",
        observedAt,
        title: `${String(ev.data.capability ?? "service")} deregistered`,
        subtitle: `ID:${String(ev.data.id ?? "?")}`,
        badge: "dereg",
        accent: "warning",
        animatedBar: false,
        txHash: ev.txHash,
      };
    case "reclaim":
      return {
        id: `rec:${ev.id}`,
        kind: "reclaim",
        observedAt,
        title: "deposit reclaimed",
        subtitle: `ID:${String(ev.data.id ?? "?")}`,
        amountStroops:
          typeof ev.data.amount === "bigint" ? (ev.data.amount as bigint) : 0n,
        badge: "reclaim",
        accent: "info",
        animatedBar: false,
        txHash: ev.txHash,
      };
    case "spend_denied":
      return {
        id: `deny:${ev.id}`,
        kind: "denied",
        observedAt,
        title: `DENIED ${String(ev.data.reason ?? "policy")}`,
        amountStroops:
          typeof ev.data.amount === "bigint" ? (ev.data.amount as bigint) : 0n,
        badge: "policy",
        accent: "danger",
        animatedBar: false,
        txHash: ev.txHash,
      };
    case "spend_ok": {
      const amount =
        typeof ev.data.amount === "bigint" ? (ev.data.amount as bigint) : 0n;
      const recipient = String(ev.data.recipient ?? "");
      return {
        id: `chain-spend:${ev.id}`,
        kind: "spend",
        observedAt,
        title: `chain spend → ${truncateAddress(recipient, 4, 4)}`,
        subtitle: formatUsdc(amount, { compact: true }),
        amountStroops: amount,
        badge: "on-chain",
        accent: "success",
        animatedBar: true,
        // Use the REAL tx hash from Soroban RPC event metadata, not the
        // contract-emitted data.txHash which may contain a "local_"
        // fallback from the autopay engine.
        txHash: ev.txHash,
      };
    }
    default:
      return null;
  }
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const port = u.port ? `:${u.port}` : "";
    return `${port}${u.pathname}`.slice(0, 28);
  } catch {
    return url.slice(0, 28);
  }
}

/**
 * Format a trust-registry service name (snake_case symbol) for display.
 * Mirrors the helper of the same name in `use-graph-layout.ts` so the
 * orchestrator and the layout hook produce the same labels.
 *   "crypto_prices"        → "Crypto Prices"
 *   "news_intelligence"    → "News Intelligence"
 *   "market_intelligence"  → "Market Intelligence"
 */
function formatServiceName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * True when `label` is the dashboard store's auto-generated default for
 * `address`. Used by `relabelIfDefault` so we never overwrite a user's
 * own custom rename. The default is computed exactly the same way as
 * `dashboard-store.ts:defaultLabelFor` to keep the round-trip stable.
 */
function isDefaultWalletLabel(label: string, address: string): boolean {
  return label === `Wallet ${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Derive a meaningful wallet label from a payment URL when we have no
 * service-name match.
 *
 * For external addresses (e.g. xlm402.com's wallet), the URL hostname is
 * the most recognisable identifier the user has — far more useful than
 * the truncated G-address fallback. Returns null for localhost URLs (we
 * have no name to give them) and for malformed URLs.
 */
function labelFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname || u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return null;
    }
    return u.hostname;
  } catch {
    return null;
  }
}

// ─── singleton ──────────────────────────────────────────────────────────────

let started = false;
export const paymentOrchestrator = new PaymentOrchestrator();

/** Call once at app boot. Safe to call multiple times — subsequent calls
 *  are no-ops. Strict mode double-mount is handled by the `started` guard. */
export function startPaymentOrchestrator(): void {
  if (started) return;
  started = true;
  paymentOrchestrator.start();
}
