/**
 * Per-address Horizon REST poller. Fetches the account balance once and the
 * last 600 USDC payments (3 pages of 200) to seed revenue / expenses totals,
 * then refreshes every POLL_INTERVAL_MS.
 *
 * Read via `useSyncExternalStore`. Like the payment store, the registry is
 * keyed by address so adding a new wallet starts a fresh poller while
 * existing wallets reuse their state.
 *
 * Key differences from the prior implementation
 * ---------------------------------------------
 * - USDC issuer is not hardcoded: we filter by `asset_code === "USDC"` only.
 * - Account-not-found (HTTP 404) is a first-class state, not a thrown error.
 * - History pagination follows `_links.next.href` for up to 3 pages so the
 *   totals are complete enough for a real dashboard without unbounded fetch.
 * - Start/stop is keyed to subscriber count so pollers don't run for
 *   unmounted components.
 */
import { DEFAULTS } from "@/lib/constants";
import { amountToStroops } from "@/lib/horizon";
import type { WalletCounterparties, WalletData } from "@/lib/types";
import { ExternalStore } from "./external-store";

const MAX_HISTORY_PAGES = 3;
const PAGE_LIMIT = 200;
const DESTROY_DELAY_MS = 200;

const EMPTY_TOTALS: WalletData["totals"] = {
  revenueStroops: 0n,
  expensesStroops: 0n,
  txCount: 0,
};

const EMPTY_COUNTERPARTIES: WalletCounterparties = Object.freeze({
  sentTo: Object.freeze([]) as readonly string[],
  receivedFrom: Object.freeze([]) as readonly string[],
});

/**
 * Reject addresses that should never be sent to Horizon's /accounts
 * endpoint. This catches:
 *   - The GAAAA… placeholder used by use-wallet-data-map for unused
 *     hook slots (valid base32 but invalid checksum → Horizon 400)
 *   - Contract addresses (C…) which live in Soroban, not Horizon
 *   - Empty/undefined/wrong-length strings
 */
function isValidStellarPublicKey(addr: string): boolean {
  if (addr.length !== 56) return false;
  if (!addr.startsWith("G")) return false;
  // The placeholder is "G" + 55 "A"s. Reject any string that is entirely
  // one repeated character after the leading G.
  if (/^G(.)\1{54}$/.test(addr)) return false;
  return true;
}

export class HorizonWalletDataStore extends ExternalStore<WalletData> {
  readonly address: string;
  private readonly horizonUrl: string;
  private state: WalletData;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private destroyTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private inflightController: AbortController | null = null;
  private onGoneCallback: ((address: string) => void) | null = null;
  /** Debounce guard for pollNow: prevents firing more than once per second. */
  private lastPollNowMs = 0;

  constructor(address: string, horizonUrl: string) {
    super();
    this.address = address;
    this.horizonUrl = horizonUrl;
    this.state = {
      address,
      label: "",
      usdcBalance: null,
      status: "loading",
      totals: EMPTY_TOTALS,
      counterparties: EMPTY_COUNTERPARTIES,
    };
  }

  getSnapshot = (): WalletData => this.state;

  /** @internal */
  setOnGone(cb: (address: string) => void): void {
    this.onGoneCallback = cb;
  }

  /** Apply a new payment observed on the live stream. Updates the in-memory
   *  totals immediately so the wallet node shows the change before the next
   *  REST refresh lands. */
  applyLivePayment(payment: {
    from: string;
    to: string;
    amount: string;
    assetCode?: string;
    assetType?: string;
  }): void {
    if (payment.assetType === "native") return;
    if (payment.assetCode !== "USDC") return;
    const stroops = amountToStroops(payment.amount);
    let revenue = this.state.totals.revenueStroops;
    let expenses = this.state.totals.expensesStroops;
    let count = this.state.totals.txCount;
    let balance = this.state.usdcBalance;
    if (payment.to === this.address) {
      revenue += stroops;
      if (balance !== null) balance += stroops;
    }
    if (payment.from === this.address) {
      expenses += stroops;
      if (balance !== null) balance -= stroops;
    }
    if (payment.from !== this.address && payment.to !== this.address) return;
    count += 1;

    // Fold the new counterparty into the lists so the graph layout learns
    // about the relationship immediately, without waiting for the next
    // REST refresh. Dedupe by address.
    let counterparties = this.state.counterparties;
    if (payment.from === this.address && payment.to && payment.to !== this.address) {
      if (!counterparties.sentTo.includes(payment.to)) {
        counterparties = {
          sentTo: [...counterparties.sentTo, payment.to],
          receivedFrom: counterparties.receivedFrom,
        };
      }
    }
    if (payment.to === this.address && payment.from && payment.from !== this.address) {
      if (!counterparties.receivedFrom.includes(payment.from)) {
        counterparties = {
          sentTo: counterparties.sentTo,
          receivedFrom: [...counterparties.receivedFrom, payment.from],
        };
      }
    }

    this.setState({
      usdcBalance: balance,
      totals: {
        revenueStroops: revenue,
        expensesStroops: expenses,
        txCount: count,
      },
      counterparties,
    });
  }

  /**
   * Trigger an immediate re-fetch of balance + payment history from
   * Horizon. Debounced: if called again within 1 second of the previous
   * invocation, the second call is silently skipped.
   *
   * Use this after a `spend_ok` Soroban event so the wallet node's
   * Revenue / Expenses / Balance update within a few seconds of the
   * payment landing on-chain, instead of waiting for the next 20-second
   * scheduled poll.
   */
  pollNow(): void {
    const now = Date.now();
    if (now - this.lastPollNowMs < 1_000) return;
    this.lastPollNowMs = now;
    void this.poll();
  }

  protected override onSubscriberAdded(): void {
    if (this.destroyTimer !== null) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
    if (!this.started) {
      this.started = true;
      void this.poll();
      this.intervalId = setInterval(
        () => void this.poll(),
        DEFAULTS.WALLET_POLL_INTERVAL_MS,
      );
    }
  }

  protected override onSubscriberRemoved(): void {
    if (this.subscriberCount() > 0) return;
    if (this.destroyTimer !== null) return;
    this.destroyTimer = setTimeout(() => {
      this.destroyTimer = null;
      this.teardown();
      const cb = this.onGoneCallback;
      if (cb) cb(this.address);
    }, DESTROY_DELAY_MS);
  }

  private async poll(): Promise<void> {
    // Skip placeholder and obviously invalid addresses. The hook
    // use-wallet-data-map pads unused slots with a GAAAA… placeholder
    // that Horizon rejects with 400 (bad checksum). Contract addresses
    // (C…) also have no Horizon account. Catching both here avoids a
    // log of 400 errors and wasted network round-trips.
    if (!isValidStellarPublicKey(this.address)) return;

    // Cancel any previous in-flight poll so overlapping calls don't stomp
    // each other. AbortController is supported everywhere fetch is.
    if (this.inflightController) this.inflightController.abort();
    const controller = new AbortController();
    this.inflightController = controller;

    try {
      const balanceResult = await fetchUsdcBalance(
        this.horizonUrl,
        this.address,
        controller.signal,
      );
      if (balanceResult.kind === "not_found") {
        this.setState({
          usdcBalance: null,
          status: "not_found",
          totals: EMPTY_TOTALS,
          counterparties: EMPTY_COUNTERPARTIES,
        });
        return;
      }
      if (balanceResult.kind === "offline") {
        this.setState({ status: "offline" });
        return;
      }

      // Balance fetched. Now grab history in parallel but only once per poll.
      const history = await fetchAccountHistory(
        this.horizonUrl,
        this.address,
        controller.signal,
      ).catch(() => ({
        totals: this.state.totals,
        counterparties: this.state.counterparties,
      }));

      this.setState({
        usdcBalance: balanceResult.stroops,
        status: "ok",
        totals: history.totals,
        counterparties: history.counterparties,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      this.setState({ status: "offline" });
    } finally {
      if (this.inflightController === controller) {
        this.inflightController = null;
      }
    }
  }

  private teardown(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.inflightController) {
      this.inflightController.abort();
      this.inflightController = null;
    }
    this.started = false;
  }

  private setState(partial: Partial<WalletData>): void {
    const next: WalletData = { ...this.state, ...partial };
    if (shallowEqualWalletData(this.state, next)) return;
    this.state = next;
    this.notify();
  }
}

function shallowEqualWalletData(a: WalletData, b: WalletData): boolean {
  if (
    a.address !== b.address ||
    a.label !== b.label ||
    a.usdcBalance !== b.usdcBalance ||
    a.status !== b.status ||
    a.totals.revenueStroops !== b.totals.revenueStroops ||
    a.totals.expensesStroops !== b.totals.expensesStroops ||
    a.totals.txCount !== b.totals.txCount
  ) {
    return false;
  }
  // Counterparties: reference equality is fine because setState only
  // swaps the object when we add a new address.
  return (
    a.counterparties === b.counterparties ||
    (a.counterparties.sentTo === b.counterparties.sentTo &&
      a.counterparties.receivedFrom === b.counterparties.receivedFrom)
  );
}

// ─── fetch helpers (no issuer filter, 404 handled as state) ────────────────

type BalanceResult =
  | { kind: "ok"; stroops: bigint | null }
  | { kind: "not_found" }
  | { kind: "offline" };

interface HorizonBalance {
  balance: string;
  asset_type: string;
  asset_code?: string;
}

interface HorizonAccountResponse {
  balances?: HorizonBalance[];
}

async function fetchUsdcBalance(
  horizonUrl: string,
  address: string,
  signal: AbortSignal,
): Promise<BalanceResult> {
  let res: Response;
  try {
    res = await fetch(`${horizonUrl}/accounts/${address}`, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { kind: "offline" };
  }
  if (res.status === 404) return { kind: "not_found" };
  // 400 = bad address checksum; treat identically to 404 so we don't
  // show a misleading "offline" status on an address the network simply
  // doesn't recognise. This is a belt-and-braces guard behind the
  // isValidStellarPublicKey check in poll().
  if (res.status === 400) return { kind: "not_found" };
  if (!res.ok) return { kind: "offline" };

  let body: HorizonAccountResponse;
  try {
    body = (await res.json()) as HorizonAccountResponse;
  } catch {
    return { kind: "offline" };
  }

  for (const bal of body.balances ?? []) {
    // Filter by code only. The prompt is explicit: issuer is not a stable
    // filter because different testnet deployments mint different USDCs and
    // production uses yet another issuer.
    if (bal.asset_type === "native") continue;
    if (bal.asset_code !== "USDC") continue;
    return { kind: "ok", stroops: amountToStroops(bal.balance) };
  }
  // No trustline found. Treat as zero, not null, so the UI shows "$0" rather
  // than an em-dash that implies loading.
  return { kind: "ok", stroops: 0n };
}

interface HorizonPaymentsResponse {
  _embedded?: {
    records: Array<{
      id: string;
      paging_token: string;
      type: string;
      from?: string;
      to?: string;
      source_account?: string;
      amount?: string;
      source_amount?: string;
      asset_type?: string;
      asset_code?: string;
      created_at: string;
    }>;
  };
  _links?: {
    next?: { href: string };
  };
}

interface AccountHistory {
  totals: WalletData["totals"];
  counterparties: WalletCounterparties;
}

async function fetchAccountHistory(
  horizonUrl: string,
  address: string,
  signal: AbortSignal,
): Promise<AccountHistory> {
  let url =
    `${horizonUrl}/accounts/${address}/payments` +
    `?order=desc&limit=${PAGE_LIMIT}`;

  let revenue = 0n;
  let expenses = 0n;
  let count = 0;
  const sentTo = new Set<string>();
  const receivedFrom = new Set<string>();

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      break;
    }
    if (res.status === 404) {
      return { totals: EMPTY_TOTALS, counterparties: EMPTY_COUNTERPARTIES };
    }
    if (!res.ok) break;

    let body: HorizonPaymentsResponse;
    try {
      body = (await res.json()) as HorizonPaymentsResponse;
    } catch {
      break;
    }
    const records = body._embedded?.records ?? [];

    for (const r of records) {
      if (r.asset_type === "native") continue;
      if (r.asset_code !== "USDC") continue;
      // path_payment_strict_send puts the sender amount in `source_amount`
      // and the receiver amount in `amount`. Use the side-appropriate value
      // so revenue and expenses both reflect actual ledger entries.
      const outgoing = r.from === address;
      const incoming = r.to === address;
      if (!outgoing && !incoming) continue;
      const amountStr =
        outgoing && r.type === "path_payment_strict_send"
          ? r.source_amount ?? r.amount ?? "0"
          : r.amount ?? "0";
      const stroops = amountToStroops(amountStr);
      if (incoming) {
        revenue += stroops;
        if (r.from && r.from !== address) receivedFrom.add(r.from);
      }
      if (outgoing) {
        expenses += stroops;
        if (r.to && r.to !== address) sentTo.add(r.to);
      }
      count += 1;
    }

    const next = body._links?.next?.href;
    if (!next || records.length === 0) break;
    url = next;
  }

  return {
    totals: { revenueStroops: revenue, expensesStroops: expenses, txCount: count },
    counterparties: {
      sentTo: [...sentTo],
      receivedFrom: [...receivedFrom],
    },
  };
}

// ─── registry ──────────────────────────────────────────────────────────────

const registry = new Map<string, HorizonWalletDataStore>();

export function getHorizonWalletDataStore(
  address: string,
  horizonUrl: string,
): HorizonWalletDataStore {
  let store = registry.get(address);
  if (!store) {
    store = new HorizonWalletDataStore(address, horizonUrl);
    store.setOnGone((addr) => registry.delete(addr));
    registry.set(address, store);
  }
  return store;
}

export function listHorizonWalletDataStores(): HorizonWalletDataStore[] {
  return [...registry.values()];
}
