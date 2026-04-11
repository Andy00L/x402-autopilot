/**
 * BulletEdge. Renders a smooth-step base line plus a travelling bullet.
 *
 * Routing
 *   Uses A* pathfinding (via @jalez/react-flow-smart-edge) so the line
 *   routes around every other node in the graph instead of passing
 *   behind unrelated cards. The same path string is used for BOTH the
 *   visible base line AND the bullet's <animateMotion>, so the bullet
 *   always flies along what the user sees. If pathfinding fails (nodes
 *   overlap or no route), falls back to a smooth-step curve.
 *
 * Lifecycle (driven by BulletEdgeData from the graph builder)
 * -----------------------------------------------------------
 *   active=true    base line at full opacity + bullet circles with
 *                  one-shot <animateMotion> (1.2 s, fill=freeze)
 *   active=false   base line transitions to opacity 0 over 0.8 s via
 *                  CSS stroke-opacity transition. Bullet unmounts.
 *   (removed)      entire edge is removed from the graph by the live-edge
 *                  store at t=2.8 s. Nothing renders.
 *
 * bulletSeq
 *   Monotonic counter bumped on every rapid-repeat payment on the same
 *   route. Used as the React key on the bullet <g> so React unmounts the
 *   old bullets and mounts fresh ones, re-arming animateMotion.
 *
 * Reduced motion
 *   Bullet is not rendered (CSS can't suppress SMIL). Base line appears
 *   and disappears instantly (transition: none).
 */
import {
  BaseEdge,
  getSmoothStepPath,
  useNodes,
  type EdgeProps,
} from "@xyflow/react";
import {
  getSmartEdge,
  svgDrawSmoothLinePath,
  pathfindingAStarDiagonal,
} from "@jalez/react-flow-smart-edge";
import { useReducedMotion } from "@/hooks/use-browser-state";

export interface BulletEdgeData extends Record<string, unknown> {
  /** Stroke colour in hex. Green for payments, gold for sub-purchases. */
  color?: string;
  /** True while the edge is in its 2 s bright window. */
  active?: boolean;
  /** Monotonic counter used as React key to restart animateMotion. */
  bulletSeq?: number;
}

const DEFAULT_COLOR = "#10b981"; // emerald-500

export function BulletEdge(props: EdgeProps) {
  const reduced = useReducedMotion();
  const nodes = useNodes();

  // Prefer A* smart routing around other nodes. Falls back to a
  // standard smooth-step curve if pathfinding can't find a route.
  const smartResult = getSmartEdge({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    nodes,
    options: {
      drawEdge: svgDrawSmoothLinePath,
      generatePath: pathfindingAStarDiagonal,
      nodePadding: 10,
    },
  });

  let edgePath: string;
  if (smartResult !== null) {
    edgePath = smartResult.svgPathString;
  } else {
    const [fallbackPath] = getSmoothStepPath({
      sourceX: props.sourceX,
      sourceY: props.sourceY,
      sourcePosition: props.sourcePosition,
      targetX: props.targetX,
      targetY: props.targetY,
      targetPosition: props.targetPosition,
      borderRadius: 14,
    });
    edgePath = fallbackPath;
  }

  const data = props.data as BulletEdgeData | undefined;
  const color = data?.color ?? DEFAULT_COLOR;
  const active = Boolean(data?.active);
  const bulletSeq = data?.bulletSeq ?? 0;
  const zeroLength =
    props.sourceX === props.targetX && props.sourceY === props.targetY;

  return (
    <>
      {/* Base line. Stays mounted through active → fading so the CSS
       * transition can animate stroke-opacity from 0.9 → 0. */}
      <BaseEdge
        id={props.id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: active ? 2 : 1.2,
          strokeOpacity: active ? 0.9 : 0,
          fill: "none",
          transition: reduced
            ? "none"
            : "stroke-opacity 0.8s ease-out, stroke-width 0.3s ease-out",
        }}
      />

      {/* Bullet: only during the active phase, hidden under reduced-motion.
       * Both circles share the exact same path string as the base line so
       * the bullet always flies along what the user sees. */}
      {active && !zeroLength && !reduced ? (
        <g key={`bullet-${bulletSeq}`} pointerEvents="none">
          {/* Outer glow trail */}
          <circle r={8} fill={color} opacity={0.18}>
            <animateMotion
              dur="1.2s"
              repeatCount="1"
              fill="freeze"
              path={edgePath}
              calcMode="spline"
              keySplines="0.42 0 0.58 1.0"
            />
          </circle>
          {/* Bright core — drop-shadow kept tight (4px) so the glow
           * reads as a subtle halo on the white canvas instead of the
           * dramatic bloom the dark-mode version used. */}
          <circle
            r={4}
            fill={color}
            opacity={0.95}
            style={{ filter: `drop-shadow(0 0 4px ${color})` }}
          >
            <animateMotion
              dur="1.2s"
              repeatCount="1"
              fill="freeze"
              path={edgePath}
              calcMode="spline"
              keySplines="0.42 0 0.58 1.0"
            />
          </circle>
        </g>
      ) : null}
    </>
  );
}
