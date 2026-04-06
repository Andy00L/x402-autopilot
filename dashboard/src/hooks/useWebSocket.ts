import { useReducer, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Event types from the wire (BigInt fields are serialized as strings)
// Mirrors src/types.ts DashboardEvent but with string amounts.
// ---------------------------------------------------------------------------

export interface WsEvent {
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// State + Reducer — single source of truth for all WS-related state
// ---------------------------------------------------------------------------

interface WsState {
  events: WsEvent[];
  connected: boolean;
}

type WsAction =
  | { type: "CONNECTED" }
  | { type: "DISCONNECTED" }
  | { type: "EVENT_RECEIVED"; event: WsEvent };

const MAX_EVENTS = 200;

function wsReducer(state: WsState, action: WsAction): WsState {
  switch (action.type) {
    case "CONNECTED":
      return { ...state, connected: true };
    case "DISCONNECTED":
      return { ...state, connected: false };
    case "EVENT_RECEIVED": {
      const next = [action.event, ...state.events];
      return {
        ...state,
        events: next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next,
      };
    }
  }
}

const INITIAL_STATE: WsState = { events: [], connected: false };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * WebSocket hook with auto-reconnect and exponential backoff.
 *
 * Backoff sequence: 1s, 2s, 4s, 8s, 16s, 30s (capped).
 * Per CLAUDE.md edge case #12.
 */
export function useWebSocket(url: string): WsState {
  const [state, dispatch] = useReducer(wsReducer, INITIAL_STATE);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(MIN_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Single effect for the entire WebSocket lifecycle.
  // Depends only on `url` — if the URL changes, reconnect to the new one.
  useEffect(() => {
    let mounted = true;

    function scheduleReconnect(): void {
      if (!mounted) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      reconnectTimerRef.current = setTimeout(connect, delay);
    }

    function connect(): void {
      if (!mounted) return;
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!mounted) return;
          dispatch({ type: "CONNECTED" });
          backoffRef.current = MIN_BACKOFF_MS;
        };

        ws.onclose = () => {
          if (!mounted) return;
          dispatch({ type: "DISCONNECTED" });
          scheduleReconnect();
        };

        ws.onerror = () => {
          // onclose fires after onerror — reconnect handled there
        };

        ws.onmessage = (msg) => {
          if (!mounted) return;
          try {
            const parsed: unknown = JSON.parse(String(msg.data));
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "event" in parsed &&
              "data" in parsed
            ) {
              dispatch({
                type: "EVENT_RECEIVED",
                event: parsed as WsEvent,
              });
            }
          } catch {
            // Ignore non-JSON messages
          }
        };
      } catch {
        scheduleReconnect();
      }
    }

    connect();

    return () => {
      mounted = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
      }
    };
  }, [url]);

  return state;
}
