import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { eventBus } from "./event-bus.js";
import { budgetTracker } from "./budget-tracker.js";

/**
 * Standalone WebSocket server for the dashboard.
 * Attaches to the singleton eventBus so all events are broadcast to connected clients.
 */
const port = config.wsPort;
const wss = new WebSocketServer({ port });

eventBus.attachWss(wss);

// Sync budget on startup (non-blocking)
budgetTracker.syncFromSoroban().catch(() => {});

console.log(`[WS Server] :${port}`);
