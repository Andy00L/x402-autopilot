/**
 * Typed React Flow Node aliases shared by the layout hook and the custom
 * node components. Declaring them here keeps the layout builder honest
 * (no `as unknown as Record<string, unknown>` casts) and lets each node
 * component read `NodeProps<WalletNode>` to type its `data` prop.
 */
import type { Node } from "@xyflow/react";
import type {
  PolicyNodeData,
  RegistryNodeData,
  ServiceNodeData,
  WalletNodeData,
} from "@/lib/types";

export type WalletNode = Node<WalletNodeData, "wallet">;
export type ServiceNode = Node<ServiceNodeData, "service">;
export type PolicyNode = Node<PolicyNodeData, "policy">;
export type RegistryNode = Node<RegistryNodeData, "registry">;
