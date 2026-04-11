/**
 * NetworkGraph. Wraps React Flow, registers custom node + edge types, and
 * hands it the derived graph from the layout hook. Light mode — React
 * Flow's internal primitives resolve against the project's slate-based
 * palette, with a dotted slate-300 background on a slate-50 canvas.
 *
 * Controlled node state
 *   React Flow is a controlled component here: we own the `nodes` list and
 *   are responsible for reflecting every change (position, selection) back
 *   into props via `applyNodeChanges`. The layout hook computes canonical
 *   nodes from the stores; we mirror them into local state so drags can
 *   update positions in real time. Drag-end positions commit to the
 *   persisted `nodePositionsStore`, which feeds back through the layout
 *   hook on the next render.
 *
 *   To avoid a live drag getting reset by an unrelated store update (for
 *   example a wallet balance poll landing mid-drag), the sync effect skips
 *   while `isDraggingRef.current` is true and picks up the latest props
 *   the moment the drag ends.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeChange,
} from "@xyflow/react";

import { WalletNodeView } from "./nodes/wallet-node";
import { ServiceNodeView } from "./nodes/service-node";
import { PolicyNodeView } from "./nodes/policy-node";
import { RegistryNodeView } from "./nodes/registry-node";
import { BulletEdge } from "./edges/bullet-edge";
import { OwnershipEdge } from "./edges/ownership-edge";
import type { GraphNode } from "@/hooks/use-graph-layout";
import { nodePositionsStore } from "@/stores/node-positions-store";

const nodeTypes = {
  wallet: WalletNodeView,
  service: ServiceNodeView,
  policy: PolicyNodeView,
  registry: RegistryNodeView,
};

const edgeTypes = {
  bullet: BulletEdge,
  ownership: OwnershipEdge,
};

interface NetworkGraphProps {
  nodes: GraphNode[];
  edges: Edge[];
}

export function NetworkGraph({ nodes, edges }: NetworkGraphProps) {
  return (
    <ReactFlowProvider>
      <NetworkGraphInner nodes={nodes} edges={edges} />
    </ReactFlowProvider>
  );
}

function NetworkGraphInner({ nodes: inputNodes, edges }: NetworkGraphProps) {
  const [nodes, setNodes] = useState<GraphNode[]>(inputNodes);
  const isDraggingRef = useRef(false);
  const latestPropNodesRef = useRef<GraphNode[]>(inputNodes);
  const hasAutoFitRef = useRef(false);
  const { fitView } = useReactFlow();

  // Reconcile local state whenever the layout hook produces new nodes.
  // Skipped while the user is actively dragging so the in-progress drag
  // position isn't clobbered by an unrelated store update.
  useEffect(() => {
    latestPropNodesRef.current = inputNodes;
    if (isDraggingRef.current) return;
    setNodes(inputNodes);
  }, [inputNodes]);

  // One-shot auto-fit: fire fitView the first time the layout actually
  // contains a service node. Until then we've only got wallets + contracts,
  // which wouldn't include the full radial arc. Subsequent data updates
  // do NOT refit because that would fight the user's drag / pan state.
  useEffect(() => {
    if (hasAutoFitRef.current) return;
    if (inputNodes.some((n) => n.type === "service")) {
      hasAutoFitRef.current = true;
      // The microtask delay lets React Flow mount the service nodes before
      // we ask it to compute bounds.
      Promise.resolve().then(() => {
        fitView({ padding: 0.15, duration: 600 });
      });
    }
  }, [inputNodes, fitView]);

  // Refit when the user clicks "Reset layout". The store emits a reset
  // event which we translate into a fitView call after React has had a
  // chance to reflow the nodes to their default radial slots.
  useEffect(() => {
    const unsubscribe = nodePositionsStore.subscribeResets(() => {
      // Microtask delay again: React Flow needs the new node positions in
      // its internal store before fitView computes bounds.
      Promise.resolve().then(() => {
        fitView({ padding: 0.15, duration: 600 });
      });
    });
    return unsubscribe;
  }, [fitView]);

  const onNodesChange = useCallback(
    (changes: NodeChange<GraphNode>[]) => {
      // Track drag state from the change stream. A position change with
      // `dragging === true` means we're mid-drag; `dragging === false`
      // means the user released the pointer on this tick.
      let dragEnded = false;
      for (const c of changes) {
        if (c.type !== "position") continue;
        if (c.dragging === true) {
          isDraggingRef.current = true;
        } else if (c.dragging === false) {
          isDraggingRef.current = false;
          dragEnded = true;
        }
      }

      setNodes((current) => applyNodeChanges(changes, current));

      if (dragEnded) {
        const updates: Record<string, { x: number; y: number }> = {};
        for (const c of changes) {
          if (c.type !== "position") continue;
          if (c.dragging !== false) continue;
          if (c.position) {
            updates[c.id] = { x: c.position.x, y: c.position.y };
          }
        }
        if (Object.keys(updates).length > 0) {
          nodePositionsStore.setMany(updates);
        }
        // The drag is finished; if the layout hook produced a new node
        // list while we were holding the pointer, adopt it now so balance
        // updates and freshly arrived service cards appear without
        // waiting for the next unrelated re-render.
        if (latestPropNodesRef.current !== inputNodes) {
          setNodes(latestPropNodesRef.current);
        }
      }
    },
    [inputNodes],
  );

  return (
    <div className="network-graph relative h-full w-full overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode="light"
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.1, minZoom: 0.4 }}
        minZoom={0.25}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        panOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        nodesDraggable
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          color="#94a3b8"
          gap={20}
          size={2}
        />
      </ReactFlow>
      <Legend />
    </div>
  );
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-4 rounded-lg border border-slate-200 bg-white/90 px-3 py-1.5 text-[10px] text-slate-500 shadow-sm backdrop-blur">
      <LegendBullet color="#10b981" label="payment" />
      <LegendBullet color="#f59e0b" label="sub-purchase" />
      <LegendPulse color="#f59e0b" label="heartbeat" />
      <LegendLine stroke="#cbd5e1" width={1} dash="4 3" label="ownership" />
    </div>
  );
}

function LegendBullet({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="26" height="6" aria-hidden="true">
        <line
          x1="1"
          y1="3"
          x2="25"
          y2="3"
          stroke={color}
          strokeWidth="1"
          strokeOpacity="0.25"
        />
        <circle cx="18" cy="3" r="2.2" fill={color} />
      </svg>
      {label}
    </span>
  );
}

function LegendPulse({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="14" height="14" aria-hidden="true" className="overflow-visible">
        <circle cx="7" cy="7" r="2" fill={color} />
        <circle
          cx="7"
          cy="7"
          r="4"
          fill="none"
          stroke={color}
          strokeWidth="0.6"
          opacity="0.55"
        />
        <circle
          cx="7"
          cy="7"
          r="6"
          fill="none"
          stroke={color}
          strokeWidth="0.4"
          opacity="0.3"
        />
      </svg>
      {label}
    </span>
  );
}

function LegendLine({
  stroke,
  width,
  dash,
  label,
}: {
  stroke: string;
  width: number;
  dash: string;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="22" height="4" aria-hidden="true">
        <line
          x1="1"
          y1="2"
          x2="21"
          y2="2"
          stroke={stroke}
          strokeWidth={width}
          strokeLinecap="round"
          strokeDasharray={dash}
        />
      </svg>
      {label}
    </span>
  );
}
