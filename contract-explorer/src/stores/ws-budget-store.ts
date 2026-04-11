/**
 * WebSocket connection to the backend engine's ws-server (port 8080).
 *
 * Responsibilities
 * ----------------
 *   - Receive real-time `spend:ok` events from the autopay engine and
 *     forward them to the payment orchestrator so a bullet animation
 *     fires within 1-2 seconds (instead of the 15-second Soroban poll).
 *   - Receive `budget:updated` events to keep the budget gauge current.
 *
 * Lifecycle
 *   Singleton. `start()` is called once at app boot (from app.tsx or the
 *   orchestrator). The WebSocket auto-reconnects with exponential backoff
 *   (1 s, 2 s, 4 s, cap 10 s). `stop()` tears down the connection.
 *
 * Deduplication
 *   The payment orchestrator's `handleWebSocketSpend` handles dedup with
 *   the Soroban poller path. This store is a thin message relay.
 */
import { paymentOrchestrator } from "./payment-orchestrator";
import { getSorobanStore } from "./soroban-store";

const WS_URL = "ws://localhost:8080";
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;

/** Shape of a parsed WebSocket message from the backend. */
interface WsMessage {
  event?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

class WsBudgetStore {
  private ws: WebSocket | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    // Delay first connect: the ws-server takes a moment to start.
    this.reconnectTimer = setTimeout(() => this.connect(), 3_000);
  }

  stop(): void {
    this.started = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect(): void {
    if (!this.started) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;

      ws.onopen = () => {
        this.backoffMs = INITIAL_BACKOFF_MS;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as WsMessage;
          this.handleMessage(msg);
        } catch {
          // Malformed JSON. Ignore.
        }
      };

      ws.onclose = () => {
        this.ws = null;
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        // onerror is always followed by onclose. Just ensure state is clean.
        try {
          ws.close();
        } catch {
          // Already closed.
        }
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.started) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private handleMessage(msg: WsMessage): void {
    if (!msg.event || !msg.data) return;

    if (msg.event === "spend:ok") {
      const recipient = String(msg.data.recipient ?? "");
      const amount = String(msg.data.amount ?? "0");
      const txHash = typeof msg.data.txHash === "string"
        ? String(msg.data.txHash)
        : undefined;
      const url = typeof msg.data.url === "string"
        ? String(msg.data.url)
        : undefined;

      if (recipient && recipient.startsWith("G") && recipient.length === 56) {
        paymentOrchestrator.handleWebSocketSpend({
          recipient,
          amount,
          txHash,
          url,
        });
      } else {
        // The ws-server detects new spends via aggregate polling and
        // broadcasts spend:ok without per-transaction recipient data.
        // Trigger an immediate Soroban re-poll so the event pipeline
        // picks up the actual contract event (which has the recipient)
        // and fires the bullet via the orchestrator's onContractEvents.
        getSorobanStore().refresh();
      }
    }

    // budget:updated is informational for the CLI dashboard. The React
    // dashboard reads budget from the Soroban store instead. Ignoring
    // it here is safe.
  }
}

export const wsBudgetStore = new WsBudgetStore();
