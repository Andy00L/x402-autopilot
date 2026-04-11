/**
 * OwnershipEdge — a thin dashed gray line for the static "wallet owns this
 * service / wallet owns this policy" structural links.
 *
 * Uses A* pathfinding to route around intermediate nodes so the line never
 * crosses through an unrelated card. Falls back to a smooth-step curve when
 * pathfinding can't find a route.
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

export function OwnershipEdge(props: EdgeProps) {
  const nodes = useNodes();

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

  // If pathfinding fails (nodes overlap or no route), fall back to
  // a standard smooth-step curve.
  if (smartResult === null) {
    const [fallbackPath] = getSmoothStepPath({
      sourceX: props.sourceX,
      sourceY: props.sourceY,
      sourcePosition: props.sourcePosition,
      targetX: props.targetX,
      targetY: props.targetY,
      targetPosition: props.targetPosition,
      borderRadius: 14,
    });
    return <BaseEdge id={props.id} path={fallbackPath} className="edge-ownership" />;
  }

  return (
    <BaseEdge
      id={props.id}
      path={smartResult.svgPathString}
      className="edge-ownership"
    />
  );
}
