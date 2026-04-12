import { WebSocketServer, WebSocket } from "ws";
import type { DashboardEvent } from "./types.js";

type EventName = DashboardEvent["event"];
type EventCallback = (data: Record<string, unknown>) => void;

/**
 * In-process event bus with WebSocket broadcast to dashboard clients.
 * Handles BigInt serialization automatically (converts to string on the wire).
 */
export class EventBus {
  private listeners = new Map<string, Set<EventCallback>>();
  private clients = new Set<WebSocket>();

  /** Attach a WebSocket server to broadcast events to dashboard. */
  attachWss(wss: WebSocketServer): void {
    wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
    });
  }

  /** Emit an event to local listeners and broadcast to WebSocket clients. */
  emit(event: EventName, data: Record<string, unknown>): void {
    // Local listeners
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) {
        try { cb(data); } catch { /* listener error must not crash emitter */ }
      }
    }

    // WebSocket broadcast — BigInt → string for JSON safety
    const message = JSON.stringify(
      { event, data, timestamp: new Date().toISOString() },
      (_key: string, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
    );

    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(message);
      } catch {
        // The socket may transition to closing between the readyState
        // check and the actual send (especially under load). Don't let
        // a single broken peer interrupt delivery to the rest of the
        // client set, and don't propagate the error to event emitters.
      }
    }
  }

  /** Subscribe to an event. */
  on(event: EventName, callback: EventCallback): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  /** Unsubscribe from an event. */
  off(event: EventName, callback: EventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }
}

/** Singleton event bus instance. */
export const eventBus = new EventBus();
