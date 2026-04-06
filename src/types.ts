// ---------------------------------------------------------------------------
// Error types — each is DISTINCT per CLAUDE.md Rule 7
// ---------------------------------------------------------------------------

export class SecurityError extends Error {
  override readonly name = "SecurityError";
  constructor(public readonly code: string) {
    super(`Security violation: ${code}`);
  }
}

export class PolicyDeniedError extends Error {
  override readonly name = "PolicyDeniedError";
  constructor(public readonly reason: string, public readonly budget?: BudgetInfo) {
    super(`Policy denied: ${reason}`);
  }
}

export class SorobanError extends Error {
  override readonly name = "SorobanError";
  constructor(public readonly operation: string, public readonly detail: string) {
    super(`Soroban ${operation}: ${detail}`);
  }
}

export class NetworkError extends Error {
  override readonly name = "NetworkError";
  constructor(public readonly service: string, public readonly cause: string) {
    super(`Network error [${service}]: ${cause}`);
  }
}

export class PaymentError extends Error {
  override readonly name = "PaymentError";
  constructor(public readonly protocol: Protocol, public readonly detail: string) {
    super(`Payment error [${protocol}]: ${detail}`);
  }
}

export class MutexTimeoutError extends Error {
  override readonly name = "MutexTimeoutError";
  constructor() {
    super("Payment mutex acquisition timed out");
  }
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

export type Protocol = "x402" | "mpp" | "free";

// ---------------------------------------------------------------------------
// Policy check result (mirrors Soroban PolicyRes)
// ---------------------------------------------------------------------------

export interface PolicyCheckResult {
  allowed: boolean;
  reason: string;
  remainingDaily: bigint;
  spentToday: bigint;
}

// ---------------------------------------------------------------------------
// Autopilot result
// ---------------------------------------------------------------------------

export interface AutopilotResult {
  data: unknown;
  costStroops: bigint;
  protocol: Protocol;
  txHash?: string;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface BudgetInfo {
  spentToday: bigint;
  remaining: bigint;
  dailyLimit: bigint;
  txCount: number;
  deniedCount: number;
  lifetimeSpent?: bigint;
}

// ---------------------------------------------------------------------------
// Service info (mirrors Soroban SvcInfo after JS conversion)
// ---------------------------------------------------------------------------

export interface ServiceInfo {
  serviceId: number;
  name: string;
  url: string;
  capability: string;
  priceStroops: bigint;
  protocol: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Spend record (mirrors Soroban SpendRec after JS conversion)
// ---------------------------------------------------------------------------

export interface SpendRecord {
  dayKey: bigint;
  totalSpent: bigint;
  txCount: number;
}

// ---------------------------------------------------------------------------
// Protocol detection result
// ---------------------------------------------------------------------------

export interface DetectResult {
  protocol: Protocol;
  headers: Headers;
  recipient?: string;
  priceRaw?: string;
}

// ---------------------------------------------------------------------------
// Health status
// ---------------------------------------------------------------------------

export interface HealthStatus {
  serviceId: number;
  status: "healthy" | "unhealthy" | "timeout";
  latencyMs: number;
  lastChecked: string;
}

// ---------------------------------------------------------------------------
// Dashboard events — discriminated union
// BigInt fields are serialized to string on the wire (see event-bus.ts)
// ---------------------------------------------------------------------------

export type DashboardEvent =
  | { event: "spend:ok"; data: { url: string; amount: bigint; protocol: Protocol; txHash: string; timestamp: string } }
  | { event: "spend:api_error"; data: { url: string; amount: bigint; protocol: Protocol; txHash: string; error: string; timestamp: string } }
  | { event: "spend:failed"; data: { url: string; error: string; timestamp: string } }
  | { event: "denied"; data: { url: string; amount: bigint; reason: string; timestamp: string } }
  | { event: "discovery:updated"; data: { services: ServiceInfo[] } }
  | { event: "health:checked"; data: { serviceId: number; status: string; latencyMs: number; timestamp: string } }
  | { event: "budget:updated"; data: { spentToday: bigint; remaining: bigint; dailyLimit: bigint } }
  | { event: "registry:stale"; data: { serviceId: number; name: string; lastHeartbeat: number } };
