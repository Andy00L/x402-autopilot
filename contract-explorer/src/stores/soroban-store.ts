/**
 * Singleton Soroban contract poller. Reads wallet-policy + trust-registry
 * every POLL_INTERVAL_MS via `simulateTransaction`, which is free and
 * read-only.
 *
 * Audit fixes over the previous hook
 * ----------------------------------
 * 1. `getLatestLedger` is called exactly once per poll and the resulting
 *    sequence number drives BOTH the TTL countdowns AND the
 *    `startLedger` fed to `fetchEvents`.
 * 2. `startLedger` starts at `latest - EVENT_LOOKBACK_LEDGERS` so a fresh
 *    dashboard catches the last ~24h of activity. After the first poll
 *    it advances to `latest` so subsequent polls only fetch fresh events.
 * 3. Events are deduped by id across polls so the feed doesn't replay
 *    the same `register` event every 15 seconds. `seenIds` is cleared
 *    when it crosses 5000 entries.
 * 4. Policy and registry failures are isolated — a broken registry
 *    simulate does not nuke the policy slice, and vice versa.
 * 5. Unknown contract event topics are filtered out (logged once) so an
 *    upgraded contract with a new event type doesn't crash the poller.
 * 6. No polling happens when there are zero React subscribers.
 */
import {
  fetchEvents,
  fetchPolicyState,
  fetchRegistryNextId,
  getLatestLedger,
  listCapabilities,
  listServices,
} from "@/lib/soroban-rpc";
import { DEFAULTS } from "@/lib/constants";
import type {
  CapabilityBucket,
  ContractEvent,
  PolicyState,
  RegistryState,
  ServiceInfo,
} from "@/lib/types";
import { ExternalStore } from "./external-store";

export interface SorobanSnapshot {
  policy: PolicyState | null;
  policyOffline: boolean;
  registry: RegistryState;
  registryOffline: boolean;
  latestLedger: number;
  /** The most recent full-window event page. Used by the orchestrator to
   *  push new rows into the feed via id diffing. */
  events: readonly ContractEvent[];
  /** True before the first successful poll completes. */
  loading: boolean;
  /** Last poll error from any source; display-only. */
  error: string | null;
}

const EMPTY_REGISTRY: RegistryState = {
  contractId: "",
  nextId: null,
  buckets: [],
  services: [],
  totalServices: 0,
};

const INITIAL_SNAPSHOT: SorobanSnapshot = {
  policy: null,
  policyOffline: false,
  registry: EMPTY_REGISTRY,
  registryOffline: false,
  latestLedger: 0,
  events: [],
  loading: true,
  error: null,
};

/** Contract event topics we know how to render in the feed. Anything outside
 *  this list is logged once and dropped. */
const KNOWN_EVENT_KINDS = new Set([
  "spend_ok",
  "spend_denied",
  "register",
  "deregister",
  "reclaim",
]);

/** Don't spam the console when an upgraded contract emits new topics. */
const warnedUnknownTopics = new Set<string>();

/**
 * Direct payment-observer side channel. New contract events are announced
 * through this so the orchestrator can push them to the feed without
 * diffing `snapshot.events` on every render.
 */
export type EventListener = (events: ContractEvent[]) => void;

export class SorobanStore extends ExternalStore<SorobanSnapshot> {
  private state: SorobanSnapshot = INITIAL_SNAPSHOT;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private inflightController: AbortController | null = null;
  private started = false;
  /** Hybrid capability discovery. Three sources, all merged into the same
   *  Set:
   *    1. SEED_CAPABILITIES (constants.ts)  — bootstrap before the first
   *       successful RPC call so the dashboard renders something instantly.
   *    2. list_capabilities()               — authoritative on-chain index,
   *       polled every cycle (Phase 5 of the v3 upgrade).
   *    3. `register` event topics           — covers the brief window
   *       between a service registering and the next list_capabilities
   *       poll, and survives RPC outages on the list_capabilities path.
   *  Once a capability is in the set it stays there for the lifetime of
   *  the store. */
  private capabilities: Set<string> = new Set(DEFAULTS.SEED_CAPABILITIES);
  /** The next poll's `startLedger`. Null before the first successful
   *  `getLatestLedger`. */
  private startLedger: number | null = null;
  private seenEventIds = new Set<string>();
  private eventListeners = new Set<EventListener>();

  private readonly rpcUrl: string;
  private readonly policyContractId: string;
  private readonly registryContractId: string;

  constructor(
    rpcUrl: string,
    policyContractId: string,
    registryContractId: string,
  ) {
    super();
    this.rpcUrl = rpcUrl;
    this.policyContractId = policyContractId;
    this.registryContractId = registryContractId;
    this.state = {
      ...INITIAL_SNAPSHOT,
      registry: { ...EMPTY_REGISTRY, contractId: registryContractId },
    };
  }

  getSnapshot = (): SorobanSnapshot => this.state;

  onEvents(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Force a poll. Used after the user changes config or clicks refresh. */
  refresh(): void {
    void this.poll();
  }

  protected override onSubscriberAdded(): void {
    if (this.started) return;
    this.started = true;
    void this.poll();
    this.timerId = setInterval(
      () => void this.poll(),
      DEFAULTS.POLL_INTERVAL_MS,
    );
  }

  protected override onSubscriberRemoved(): void {
    if (this.subscriberCount() > 0) return;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.inflightController) {
      this.inflightController.abort();
      this.inflightController = null;
    }
    this.started = false;
  }

  private async poll(): Promise<void> {
    if (this.inflightController) this.inflightController.abort();
    const controller = new AbortController();
    this.inflightController = controller;

    // Step 1: get the latest ledger. Everything downstream depends on it.
    let latestLedger = this.state.latestLedger;
    try {
      const info = await getLatestLedger(this.rpcUrl);
      latestLedger = info.sequence;
      if (this.startLedger === null) {
        this.startLedger = Math.max(
          1,
          latestLedger - DEFAULTS.EVENT_LOOKBACK_LEDGERS,
        );
      }
    } catch {
      // RPC down. Don't clear state; degrade loudly via the offline flag
      // below once we detect policy and registry also failed.
    }

    // Step 1b: fetch the on-chain capability list. Merges into the
    // existing capability set so anything previously seen (via SEED or
    // events) is preserved. listCapabilities returns [] on RPC failure,
    // in which case we fall back to whatever this.capabilities already
    // holds (SEED on first poll, accumulated capabilities afterwards).
    try {
      const onChain = await listCapabilities(
        this.rpcUrl,
        DEFAULTS.NETWORK_PASSPHRASE,
        this.registryContractId,
        0,
        100,
      );
      for (const cap of onChain) {
        if (cap.length > 0) this.capabilities.add(cap);
      }
    } catch {
      // Registry RPC blip — keep the existing capability set.
    }

    // Step 2: run policy, registry, nextId, events in parallel. Each has
    // its own error capture so one failure doesn't knock out the rest.
    const policyPromise = fetchPolicyState(
      this.rpcUrl,
      DEFAULTS.NETWORK_PASSPHRASE,
      this.policyContractId,
    ).then(
      (v): { ok: true; value: PolicyState } => ({ ok: true, value: v }),
      (err: unknown): { ok: false; error: string } => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    const nextIdPromise = fetchRegistryNextId(
      this.rpcUrl,
      this.registryContractId,
    ).catch((): number | null => null);

    const capabilityList = [...this.capabilities];
    const bucketsPromise: Promise<{
      ok: boolean;
      buckets: CapabilityBucket[];
    }> = Promise.all(
      capabilityList.map(async (capability) => {
        try {
          const services = await listServices(
            this.rpcUrl,
            DEFAULTS.NETWORK_PASSPHRASE,
            this.registryContractId,
            capability,
            50,
          );
          return { capability, services };
        } catch {
          return { capability, services: [] as ServiceInfo[] };
        }
      }),
    ).then((buckets) => ({ ok: true, buckets }));

    const startLedgerForEvents = this.startLedger;
    const eventsPromise: Promise<ContractEvent[]> =
      startLedgerForEvents === null
        ? Promise.resolve([])
        : fetchEvents(
            this.rpcUrl,
            startLedgerForEvents,
            this.policyContractId,
            this.registryContractId,
          )
            .then((r) => r.events)
            .catch(() => [] as ContractEvent[]);

    const [policyResult, nextId, bucketsResult, events] = await Promise.all([
      policyPromise,
      nextIdPromise,
      bucketsPromise,
      eventsPromise,
    ]);

    if (controller.signal.aborted) return;

    // Step 3: rebuild the flattened service list (deduped by id).
    const byId = new Map<number, ServiceInfo>();
    for (const bucket of bucketsResult.buckets) {
      for (const svc of bucket.services) {
        if (!byId.has(svc.id)) byId.set(svc.id, svc);
      }
    }
    const flatServices = [...byId.values()];

    // Step 4: merge freshly registered capabilities so next poll picks
    // them up.
    for (const ev of events) {
      if (ev.kind !== "register") continue;
      const cap = ev.data.capability;
      if (typeof cap === "string" && cap.length > 0) this.capabilities.add(cap);
    }

    // Step 5: filter unknown event kinds (log once, drop).
    const recognisedEvents: ContractEvent[] = [];
    for (const ev of events) {
      if (!KNOWN_EVENT_KINDS.has(ev.kind)) {
        const tag = `${ev.kind}:${ev.topics.join("/")}`;
        if (!warnedUnknownTopics.has(tag)) {
          warnedUnknownTopics.add(tag);
          console.warn("[soroban] unknown event kind", tag);
        }
        continue;
      }
      recognisedEvents.push(ev);
    }

    // Step 6: dedupe across polls.
    const freshEvents: ContractEvent[] = [];
    for (const ev of recognisedEvents) {
      if (this.seenEventIds.has(ev.id)) continue;
      this.seenEventIds.add(ev.id);
      freshEvents.push(ev);
    }
    if (this.seenEventIds.size > 5_000) {
      // The buffer is stale by then — older events are no longer relevant
      // for dedup because the lookback window has advanced past them.
      this.seenEventIds.clear();
    }

    // Step 7: assemble the new registry state.
    const registry: RegistryState = {
      contractId: this.registryContractId,
      nextId,
      buckets: bucketsResult.buckets,
      services: flatServices,
      totalServices: flatServices.length,
    };

    const policy = policyResult.ok ? policyResult.value : null;
    const policyOffline = !policyResult.ok;
    const registryOffline = bucketsResult.buckets.length === 0
      ? this.state.registryOffline
      : false;

    // Step 8: advance startLedger so the next poll only fetches new events.
    if (latestLedger > 0) this.startLedger = latestLedger;

    // Step 9: commit.
    const nextState: SorobanSnapshot = {
      policy: policy ?? this.state.policy,
      policyOffline,
      registry,
      registryOffline,
      latestLedger,
      events: recognisedEvents,
      loading: false,
      error: policyResult.ok ? null : policyResult.error,
    };
    this.setState(nextState);

    // Step 10: publish fresh events to side-channel listeners.
    if (freshEvents.length > 0) {
      for (const listener of this.eventListeners) {
        listener(freshEvents);
      }
    }
  }

  private setState(next: SorobanSnapshot): void {
    if (shallowEqualSnapshot(this.state, next)) return;
    this.state = next;
    this.notify();
  }
}

function shallowEqualSnapshot(a: SorobanSnapshot, b: SorobanSnapshot): boolean {
  return (
    a.policy === b.policy &&
    a.policyOffline === b.policyOffline &&
    a.registry === b.registry &&
    a.registryOffline === b.registryOffline &&
    a.latestLedger === b.latestLedger &&
    a.events === b.events &&
    a.loading === b.loading &&
    a.error === b.error
  );
}

// ─── singleton ──────────────────────────────────────────────────────────────

let singleton: SorobanStore | null = null;

export function getSorobanStore(): SorobanStore {
  if (singleton) return singleton;
  singleton = new SorobanStore(
    DEFAULTS.SOROBAN_RPC,
    DEFAULTS.WALLET_POLICY_ID,
    DEFAULTS.TRUST_REGISTRY_ID,
  );
  return singleton;
}
