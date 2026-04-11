/**
 * Builds the React Flow node + edge arrays from:
 *   - Tracked wallets (from the dashboard store)
 *   - Wallet data (from Horizon: balance + totals + counterparties)
 *   - Soroban state (policy + registry + latest ledger)
 *   - Live pulse keys (from the dashboard store)
 *   - Transient live bullet edges (from the live-edge store)
 *   - Persisted node position overrides (from the node-positions store)
 *
 * Layout
 * ------
 * Radial tree centred on the trust-registry. There are four tiers:
 *
 *   • Registry        anchored at the canvas centre
 *   • Policy          to the left of the registry, same y level
 *   • Wallet ring     evenly spread along an arc above the centre, with
 *                     the main wallet at the top of the arc and the
 *                     others fanning out left and right
 *   • Service ring    each service hangs directly below its owner wallet,
 *                     with sibling services laid out symmetrically around
 *                     the owner's centre
 *   • Detached        services whose owner is not a tracked wallet
 *                     anchor below the registry as a "floating" tier so
 *                     they remain visible without overlapping the tree
 *
 * Wallet arc radius scales with wallet count so adding a fifth or sixth
 * wallet keeps the cards from piling up.
 *
 * Edges
 * -----
 * Payment edges are exclusively driven by the live-edge store. They carry
 * `active` and `bulletSeq` into the BulletEdge component. There are no
 * "historical" faint-line edges any more — payments are purely an event
 * signal that appears, animates, fades, and disappears.
 *
 * When the user has dragged a node, its saved override from the positions
 * store replaces the default radial slot. Other nodes are unaffected.
 */
import { useMemo } from "react";
import type { Edge } from "@xyflow/react";
import type {
  PolicyNodeData,
  PolicyState,
  RegistryNodeData,
  RegistryState,
  ServiceInfo,
  ServiceNodeData,
  WalletData,
  WalletNodeData,
} from "@/lib/types";
import type { LiveEdge } from "@/stores/live-edge-store";
import type { TrackedWallet } from "@/stores/dashboard-store";
import type { NodePositions } from "@/stores/node-positions-store";
import type {
  PolicyNode,
  RegistryNode,
  ServiceNode,
  WalletNode,
} from "@/components/nodes/node-types";
import type { BulletEdgeData } from "@/components/edges/bullet-edge";

// ─── radial-tree layout constants ────────────────────────────────────────────
//
// All node sizes are conservative estimates of the rendered card. They
// drive how slots are centred on x; React Flow re-measures the actual
// DOM box on first render so a slightly off estimate just shifts the
// initial nudge — drag overrides win regardless.

const LAYOUT = {
  /** Canvas anchor — registry centre. CENTER_Y is intentionally low so
   *  the wallet ring + service ring both fit ABOVE the registry without
   *  vertically overlapping its bounding box. */
  CENTER_X: 700,
  CENTER_Y: 600,

  /** Approximate rendered card sizes. */
  WALLET_W: 220,
  WALLET_H: 140,
  SERVICE_W: 180,
  SERVICE_H: 110,
  POLICY_W: 200,
  POLICY_H: 160,
  REGISTRY_W: 240,
  REGISTRY_H: 200,

  /** Policy sits this far to the LEFT of the registry centre. */
  POLICY_OFFSET_X: -380,

  /** Vertical drop from a wallet's top to its first service's top. */
  SERVICE_OFFSET_Y: 190,

  /** Horizontal spacing between sibling services that share an owner. */
  SERVICE_SPACING_X: 200,

  /** Wallet arc — sweeps from upper-left (-135°) to upper-right (-45°),
   *  a 90° fan above the registry. Tighter than a full semicircle so
   *  side wallets stay high enough that their hanging services land
   *  cleanly above the registry's vertical band rather than alongside it. */
  ARC_START: -Math.PI * (3 / 4),
  ARC_END: -Math.PI / 4,

  /** Detached services tier sits this far BELOW the registry. */
  DETACHED_OFFSET_Y: 220,
  DETACHED_SPACING_X: 200,
} as const;

/** Radius from the registry centre to each wallet, scaled by wallet count
 *  so the arc keeps the cards from overlapping when many wallets are
 *  tracked. The minimum is wide enough that 3 wallets read as a clear
 *  arc rather than three points on a flat line. */
function walletArcRadius(walletCount: number): number {
  return Math.max(440, 200 + walletCount * 80);
}

// ─── colours used by the bullet edge ────────────────────────────────────────
//
// Tuned for the white canvas: emerald-500 reads as "money moving" and
// amber-500 is a recognisable sub-purchase tint. Both are the same hex
// values used by the premium light palette everywhere else
// (network-graph Legend, activity feed, header LIVE dot).

const COLOR_PAYMENT = "#10b981";       // emerald-500
const COLOR_SUB_PURCHASE = "#f59e0b";  // amber-500

// ─── helpers ────────────────────────────────────────────────────────────────

function serviceDotFor(
  protocol: string,
  capability: string,
): ServiceNodeData["colorDot"] {
  const p = protocol.toLowerCase();
  const c = capability.toLowerCase();
  if (c === "analysis" || c === "analyst") return "gold";
  if (c === "weather") return "green";
  if (c === "news") return "blue";
  if (p === "mpp") return "amber";
  if (c === "blockchain" || c === "stellar") return "amber";
  return "green";
}

function initialFor(label: string): string {
  const word = label.trim().split(/\s+/)[0] ?? "";
  return (word[0] ?? "?").toUpperCase();
}

/**
 * Format a trust-registry service name (snake_case symbol) for display.
 *   "crypto_prices"        -> "Crypto Prices"
 *   "news_intelligence"    -> "News Intelligence"
 *   "market_intelligence"  -> "Market Intelligence"
 */
function formatServiceName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** True when `label` looks like the dashboard store's auto-generated
 *  default for `address` (matches `defaultLabelFor` in dashboard-store.ts).
 *  The orchestrator updates user-visible labels in-store as soon as it
 *  learns a meaningful name, so the layout hook can simply trust
 *  `wallet.label` whenever it has already been replaced with anything
 *  other than this default pattern. */
function isDefaultWalletLabel(label: string, address: string): boolean {
  return label === `Wallet ${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Resolve a human-readable label for a tracked wallet.
 *
 * The dashboard store is the source of truth for wallet names — the
 * payment orchestrator updates `wallet.label` in-store as soon as it
 * learns a meaningful name (service-name match, URL hostname, etc.),
 * and the user can rename any wallet via the header chips. So this
 * function's first job is to **trust `wallet.label`** whenever it
 * isn't the auto-generated truncated default.
 *
 *   wallets[0]                 → keeps its label ("Main wallet")
 *   wallets[1]                 → keeps its label ("Analyst agent")
 *   custom or orchestrator-set → keeps wallet.label (already meaningful)
 *   default truncated label    → fall through to the registry-derived
 *                                 service-name path so the dashboard
 *                                 still shows something sensible during
 *                                 the brief window before the
 *                                 orchestrator's first relabel fires
 *
 * The registry-derived fallback joins multiple service names with
 * " / " so a wallet that runs both the raw and the enriched news
 * endpoints reads as "News / News Intelligence".
 */
function resolveWalletLabel(
  wallet: TrackedWallet,
  walletIndex: number,
  ownedServices: readonly ServiceInfo[],
): string {
  if (walletIndex === 0 || walletIndex === 1) return wallet.label;
  if (!isDefaultWalletLabel(wallet.label, wallet.address)) return wallet.label;
  if (ownedServices.length === 0) return wallet.label;
  const names = ownedServices.map((s) => formatServiceName(s.name));
  // Dedup while preserving order — a wallet may self-register the same
  // symbolic name twice (once per capability) and we only want it shown
  // once in the label.
  const unique = [...new Set(names)];
  return unique.join(" / ");
}

/**
 * Top-left position of the i-th wallet on the radial arc.
 *
 * Single-wallet case is hard-coded to straight up (-π/2) so the lone
 * wallet sits directly above the registry instead of at one end of the
 * default arc. For two or more wallets the angle is linearly
 * interpolated from `ARC_START` to `ARC_END`, putting an even fan above
 * the centre.
 */
function walletArcPosition(
  index: number,
  walletCount: number,
): { x: number; y: number } {
  const radius = walletArcRadius(walletCount);
  const angle =
    walletCount === 1
      ? -Math.PI / 2
      : LAYOUT.ARC_START +
        (LAYOUT.ARC_END - LAYOUT.ARC_START) * (index / (walletCount - 1));

  return {
    x: LAYOUT.CENTER_X + radius * Math.cos(angle) - LAYOUT.WALLET_W / 2,
    y: LAYOUT.CENTER_Y + radius * Math.sin(angle) - LAYOUT.WALLET_H / 2,
  };
}

/**
 * Slot positions for `count` sibling services that hang directly below
 * a wallet whose top-left corner is at `ownerPos`. Siblings are spread
 * symmetrically around the wallet's horizontal centre with a fixed gap.
 */
function serviceSlotsBelow(
  ownerPos: { x: number; y: number },
  count: number,
): Array<{ x: number; y: number }> {
  if (count === 0) return [];
  const ownerCenterX = ownerPos.x + LAYOUT.WALLET_W / 2;
  const baseY = ownerPos.y + LAYOUT.SERVICE_OFFSET_Y;
  const positions: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const offsetX = (i - (count - 1) / 2) * LAYOUT.SERVICE_SPACING_X;
    positions.push({
      x: ownerCenterX - LAYOUT.SERVICE_W / 2 + offsetX,
      y: baseY,
    });
  }
  return positions;
}

// ─── main ──────────────────────────────────────────────────────────────────

export type GraphNode = WalletNode | ServiceNode | PolicyNode | RegistryNode;

export interface GraphInput {
  wallets: readonly TrackedWallet[];
  walletData: Map<string, WalletData>;
  policy: PolicyState | null;
  policyOffline: boolean;
  registry: RegistryState | null;
  registryOffline: boolean;
  latestLedger: number;
  walletPulses: Record<string, number>;
  servicePulses: Record<string, number>;
  liveEdges: readonly LiveEdge[];
  nodePositions: NodePositions;
}

export interface GraphOutput {
  nodes: GraphNode[];
  edges: Edge[];
}

export function useGraphLayout(input: GraphInput): GraphOutput {
  return useMemo(() => buildGraph(input), [
    input.wallets,
    input.walletData,
    input.policy,
    input.policyOffline,
    input.registry,
    input.registryOffline,
    input.latestLedger,
    input.walletPulses,
    input.servicePulses,
    input.liveEdges,
    input.nodePositions,
  ]);
}

function buildGraph(input: GraphInput): GraphOutput {
  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];

  const {
    wallets,
    walletData,
    policy,
    policyOffline,
    registry,
    registryOffline,
    latestLedger,
    walletPulses,
    servicePulses,
    liveEdges,
    nodePositions,
  } = input;

  if (wallets.length === 0) return { nodes, edges };

  // Pre-group services by owner so we know which wallets host which sellers.
  const servicesByOwner = new Map<string, ServiceInfo[]>();
  for (const svc of registry?.services ?? []) {
    const arr = servicesByOwner.get(svc.owner) ?? [];
    arr.push(svc);
    servicesByOwner.set(svc.owner, arr);
  }

  // Pick a saved position override if the user has dragged this node,
  // otherwise fall back to the deterministic grid slot.
  const positioned = (id: string, x: number, y: number): { x: number; y: number } => {
    const saved = nodePositions[id];
    if (saved) return { x: saved.x, y: saved.y };
    return { x, y };
  };

  // Policy card is anchored to whichever wallet owns it. If the on-chain
  // Owner field is not one of our tracked wallets, fall back to the first
  // tracked wallet so the ownership edge still has something to connect to.
  const policyOwner = policy?.owner ?? null;
  const policyAnchorIndex = Math.max(
    0,
    wallets.findIndex((w) => w.address === policyOwner),
  );

  // Wallet positions are computed once up-front so the service ring can
  // hang each service slot directly below its owner.
  const walletDefaultPositions = new Map<string, { x: number; y: number }>();
  wallets.forEach((wallet, walletIndex) => {
    walletDefaultPositions.set(
      wallet.address,
      walletArcPosition(walletIndex, wallets.length),
    );
  });

  // ─── Wallet ring: arc above the registry ─────────────────────────────
  wallets.forEach((wallet, walletIndex) => {
    const data = walletData.get(wallet.address);
    const ownedServices = servicesByOwner.get(wallet.address) ?? [];
    const isSeller = ownedServices.length > 0;
    // Role-aware label: main + analyst keep their user-facing labels,
    // every other wallet that owns a trust-registry service is named
    // after the service(s) it runs.
    const displayLabel = resolveWalletLabel(wallet, walletIndex, ownedServices);

    const walletNodeData: WalletNodeData = {
      address: wallet.address,
      label: displayLabel,
      // Initial drives the tiny role dot (blue for "M"ain, purple for
      // "A"nalyst, gray otherwise — see walletDotColor in wallet-node.tsx).
      // Derive it from the display label so service wallets get their
      // service's first letter, while main + analyst keep their "M"/"A"
      // colors because their display label is unchanged for indices 0/1.
      initial: initialFor(displayLabel),
      colorClass: isSeller ? "success" : "neutral",
      usdcBalance: data?.usdcBalance ?? null,
      spentStroops:
        policyAnchorIndex === walletIndex && policy ? policy.today.total : 0n,
      deniedCount:
        policyAnchorIndex === walletIndex && policy
          ? policy.lifetime.deniedCount
          : 0n,
      txCount:
        policyAnchorIndex === walletIndex && policy
          ? policy.lifetime.txCount
          : BigInt(data?.totals.txCount ?? 0),
      revenueStroops: data?.totals.revenueStroops ?? 0n,
      expensesStroops: data?.totals.expensesStroops ?? 0n,
      isSeller,
      pulseKey: walletPulses[wallet.address] ?? 0,
      status: data?.status ?? "loading",
    };

    const walletNodeId = `wallet:${wallet.address}`;
    const slot = walletDefaultPositions.get(wallet.address)!;
    nodes.push({
      id: walletNodeId,
      type: "wallet",
      position: positioned(walletNodeId, slot.x, slot.y),
      data: walletNodeData,
      draggable: true,
    });
  });

  // ─── Service ring: each service hangs directly below its owner ──────
  //
  // Matching is `service.owner === wallet.address`. This is correct
  // when the trust-registry holds the service's OWN wallet as the
  // owner (the steady state after `selfRegister` writes a fresh
  // entry). It silently fails when a stale `seed-registry.ts` row
  // still owns the URL — `selfRegister` reuses the existing service
  // ID by URL but does NOT rewrite `owner`, so all such services pile
  // up under the main wallet (or, if no tracked wallet matches, fall
  // through to the detached strip below the registry).
  //
  // The PaymentOrchestrator works around this on the bullet path by
  // maintaining a learned `servicesByPayTo` reverse index — but the
  // layout hook intentionally has no access to the orchestrator's
  // private state (no cross-store coupling). The recovery path for
  // operators is to wait for the stale temporary-storage entry to
  // expire (5 min TTL) and let `selfRegister` re-write with the
  // service's own keypair, OR re-run `npm run setup:service-wallets`
  // to provision fresh wallets.
  wallets.forEach((wallet) => {
    const ownedServices = servicesByOwner.get(wallet.address) ?? [];
    if (ownedServices.length === 0) return;

    const ownerSlot = walletDefaultPositions.get(wallet.address)!;
    const slots = serviceSlotsBelow(ownerSlot, ownedServices.length);
    const walletNodeId = `wallet:${wallet.address}`;

    ownedServices.forEach((svc, svcIndex) => {
      const slot = slots[svcIndex]!;
      const sData: ServiceNodeData = {
        serviceId: svc.id,
        ownerAddress: svc.owner,
        name: svc.name,
        url: svc.url,
        protocol: svc.protocol,
        priceStroops: svc.price,
        lastHeartbeatLedger: latestLedger,
        latestLedger,
        colorDot: serviceDotFor(svc.protocol, svc.capability),
        pulseKey: servicePulses[svc.owner] ?? 0,
      };

      const serviceNodeId = `service:${svc.id}`;
      nodes.push({
        id: serviceNodeId,
        type: "service",
        position: positioned(serviceNodeId, slot.x, slot.y),
        data: sData,
        draggable: true,
      });

      edges.push({
        id: `own:${wallet.address}:${svc.id}`,
        source: walletNodeId,
        target: serviceNodeId,
        type: "ownership",
      });
    });
  });

  // ─── Contracts: registry at centre, policy to its left ──────────────
  const registryDefaultX = LAYOUT.CENTER_X - LAYOUT.REGISTRY_W / 2;
  const registryDefaultY = LAYOUT.CENTER_Y - LAYOUT.REGISTRY_H / 2;
  const policyDefaultX =
    LAYOUT.CENTER_X + LAYOUT.POLICY_OFFSET_X - LAYOUT.POLICY_W / 2;
  const policyDefaultY = LAYOUT.CENTER_Y - LAYOUT.POLICY_H / 2;

  if (wallets[policyAnchorIndex]) {
    const anchor = wallets[policyAnchorIndex]!;
    const pData: PolicyNodeData = {
      ownerAddress: anchor.address,
      config: policy?.config ?? null,
      today: policy?.today ?? {
        total: 0n,
        count: 0n,
        lastMin: 0n,
        minCount: 0,
      },
      lifetime: policy?.lifetime ?? {
        totalSpent: 0n,
        txCount: 0n,
        deniedCount: 0n,
      },
      offline: policyOffline,
    };
    nodes.push({
      id: "policy",
      type: "policy",
      position: positioned("policy", policyDefaultX, policyDefaultY),
      data: pData,
      draggable: true,
    });

    edges.push({
      id: `own:${anchor.address}:policy`,
      source: `wallet:${anchor.address}`,
      target: "policy",
      type: "ownership",
    });
  }

  const rData: RegistryNodeData = {
    contractId: registry?.contractId ?? "",
    nextId: registry?.nextId ?? null,
    services: registry?.services ?? [],
    latestLedger,
    offline: registryOffline,
  };
  nodes.push({
    id: "registry",
    type: "registry",
    position: positioned("registry", registryDefaultX, registryDefaultY),
    data: rData,
    draggable: true,
  });

  // ─── Detached services (owner not among tracked wallets) ───────────
  // Anchored as a horizontal strip below the registry so they don't
  // collide with the wallet arc above. Cards are spread symmetrically
  // around the canvas centre.
  const trackedAddresses = new Set(wallets.map((w) => w.address));
  const detached: ServiceInfo[] = [];
  for (const svc of registry?.services ?? []) {
    if (!trackedAddresses.has(svc.owner)) detached.push(svc);
  }
  if (detached.length > 0) {
    const detachedRowY =
      registryDefaultY + LAYOUT.REGISTRY_H + LAYOUT.DETACHED_OFFSET_Y;
    detached.forEach((svc, idx) => {
      const serviceNodeId = `service:${svc.id}`;
      if (nodes.some((n) => n.id === serviceNodeId)) return;
      const offsetX =
        (idx - (detached.length - 1) / 2) * LAYOUT.DETACHED_SPACING_X;
      const sData: ServiceNodeData = {
        serviceId: svc.id,
        ownerAddress: svc.owner,
        name: svc.name,
        url: svc.url,
        protocol: svc.protocol,
        priceStroops: svc.price,
        lastHeartbeatLedger: latestLedger,
        latestLedger,
        colorDot: serviceDotFor(svc.protocol, svc.capability),
        pulseKey: servicePulses[svc.owner] ?? 0,
      };
      nodes.push({
        id: serviceNodeId,
        type: "service",
        position: positioned(
          serviceNodeId,
          LAYOUT.CENTER_X - LAYOUT.SERVICE_W / 2 + offsetX,
          detachedRowY,
        ),
        data: sData,
        draggable: true,
      });
    });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));

  // ─── Transient live bullet edges ─────────────────────────────────────
  // Payment edges are EVENT-DRIVEN. They appear on payment, animate for
  // 2 s, fade for 0.8 s via CSS transition on the base line, and are
  // removed from the graph entirely. No historical "has-paid-this"
  // lines.
  for (const live of liveEdges) {
    if (!nodeIds.has(live.sourceNodeId) || !nodeIds.has(live.targetNodeId)) {
      console.warn(
        "[bullet] dropped edge:",
        live.sourceNodeId, "→", live.targetNodeId,
        "| source exists:", nodeIds.has(live.sourceNodeId),
        "| target exists:", nodeIds.has(live.targetNodeId),
      );
      continue;
    }
    const color = live.subPurchase ? COLOR_SUB_PURCHASE : COLOR_PAYMENT;
    const data: BulletEdgeData = {
      color,
      active: live.phase === "active",
      bulletSeq: live.bulletSeq,
    };
    edges.push({
      id: `pay:${live.id}:${live.bulletSeq}`,
      source: live.sourceNodeId,
      target: live.targetNodeId,
      type: "bullet",
      data,
      zIndex: 10,
    });
  }

  return { nodes, edges };
}
