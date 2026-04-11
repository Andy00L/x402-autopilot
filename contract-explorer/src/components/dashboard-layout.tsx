/**
 * DashboardLayout. Horizontal panel group that owns the graph / feed split.
 *
 *   - Left panel: the React Flow network graph
 *   - Right panel: the activity feed
 *
 * Panel sizes are persisted via `autoSaveId` (react-resizable-panels handles
 * the localStorage read/write internally). The feed panel is collapsible and
 * exposes an imperative handle so the "show feed" floating button can
 * re-expand it when the user has dragged it to 0%.
 *
 * Keep this component independent of the rest of the dashboard — it takes
 * slots rather than rendering NetworkGraph / ActivityFeed itself so the
 * data flow in app.tsx stays in one place.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";

interface DashboardLayoutProps {
  graph: ReactNode;
  feed: ReactNode;
}

export function DashboardLayout({ graph, feed }: DashboardLayoutProps) {
  const feedRef = useRef<ImperativePanelHandle>(null);
  const [feedCollapsed, setFeedCollapsed] = useState(false);

  const handleExpandFeed = useCallback(() => {
    feedRef.current?.expand();
  }, []);

  return (
    <div className="relative h-full overflow-hidden">
      <PanelGroup
        direction="horizontal"
        autoSaveId="x402-dashboard-layout.v1"
        className="h-full"
      >
        <Panel
          id="graph-panel"
          order={1}
          defaultSize={65}
          minSize={35}
          className="h-full"
        >
          {graph}
        </Panel>

        <PanelResizeHandle className="group relative flex w-[6px] cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-blue-100 data-[resize-handle-state=drag]:bg-blue-200">
          {/* Thin visible line in the default state, brighter while dragging. */}
          <div className="h-10 w-px rounded-full bg-slate-200 transition-colors group-hover:bg-blue-400 group-data-[resize-handle-state=drag]:bg-blue-500" />
        </PanelResizeHandle>

        <Panel
          id="feed-panel"
          order={2}
          ref={feedRef}
          defaultSize={35}
          minSize={18}
          collapsible
          collapsedSize={0}
          onCollapse={() => setFeedCollapsed(true)}
          onExpand={() => setFeedCollapsed(false)}
          className="h-full border-l border-slate-200"
        >
          {feed}
        </Panel>
      </PanelGroup>

      {feedCollapsed ? (
        <button
          type="button"
          onClick={handleExpandFeed}
          className="absolute right-0 top-3 flex h-8 items-center gap-1 rounded-l-md border border-r-0 border-slate-200 bg-white/95 px-2 text-[10px] font-medium text-slate-500 shadow-sm backdrop-blur transition-colors hover:bg-white hover:text-slate-900"
          aria-label="Show activity feed"
        >
          <span aria-hidden="true">‹</span>
          Show feed
        </button>
      ) : null}
    </div>
  );
}
