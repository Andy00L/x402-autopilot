/**
 * App shell. All external data comes through `useSyncExternalStore`-backed
 * hooks; there are zero useEffect subscriptions in this component or any of
 * its children that consume external data.
 *
 * Cross-store reactions (glow pulses, feed rows, live edges) are handled by
 * the PaymentOrchestrator, which runs outside React and wires the stores
 * together once at module load.
 */
import { NetworkGraph } from "@/components/network-graph";
import { ActivityFeed } from "@/components/activity-feed";
import { Header } from "@/components/header";
import { DashboardLayout } from "@/components/dashboard-layout";
import { useDashboardStore } from "@/stores/dashboard-store";
import { useSoroban } from "@/hooks/use-soroban";
import { useLiveEdges } from "@/hooks/use-live-edges";
import { useWalletDataMap } from "@/hooks/use-wallet-data-map";
import { useConnectionStatus } from "@/hooks/use-connection-status";
import { useGraphLayout } from "@/hooks/use-graph-layout";
import { useNodePositions } from "@/hooks/use-node-positions";
import { startPaymentOrchestrator } from "@/stores/payment-orchestrator";
import { wsBudgetStore } from "@/stores/ws-budget-store";

// Start the orchestrator exactly once at module load. The helper is
// idempotent so React strict mode's double-import can't double-init.
startPaymentOrchestrator();
// Connect to the backend WebSocket so spend:ok events fire bullets
// immediately instead of waiting for the 15-second Soroban poll.
wsBudgetStore.start();

export function App() {
  const wallets = useDashboardStore((s) => s.wallets);
  const feed = useDashboardStore((s) => s.feed);
  const walletPulses = useDashboardStore((s) => s.walletPulses);
  const servicePulses = useDashboardStore((s) => s.servicePulses);

  const soroban = useSoroban();
  const liveEdges = useLiveEdges();
  const walletData = useWalletDataMap(wallets);
  const connectionStatus = useConnectionStatus(wallets);
  const nodePositions = useNodePositions();

  const { nodes, edges } = useGraphLayout({
    wallets,
    walletData,
    policy: soroban.policy,
    policyOffline: soroban.policyOffline,
    registry: soroban.registry,
    registryOffline: soroban.registryOffline,
    latestLedger: soroban.latestLedger,
    walletPulses,
    servicePulses,
    liveEdges,
    nodePositions,
  });

  return (
    <div className="grid h-dvh max-h-dvh grid-rows-[40px_1fr] overflow-hidden bg-slate-50 text-slate-900">
      <Header connectionStatus={connectionStatus} />
      <DashboardLayout
        graph={<NetworkGraph nodes={nodes} edges={edges} />}
        feed={<ActivityFeed events={feed} />}
      />
    </div>
  );
}
