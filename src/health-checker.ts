import { eventBus } from "./event-bus.js";
import { validateUrl } from "./security.js";
import type { ServiceInfo, HealthStatus } from "./types.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Periodic health checker for registered services.
 * Sends HEAD probes every 5 minutes and emits events.
 */
export class HealthChecker {
  private services: ServiceInfo[] = [];
  private statuses = new Map<number, HealthStatus>();
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** Update the list of services to monitor. */
  setServices(services: ServiceInfo[]): void {
    this.services = services;
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.checkAll().catch(() => { /* swallow — individual failures are emitted */ });
    }, CHECK_INTERVAL_MS);

    // Run first check immediately
    this.checkAll().catch(() => {});
  }

  /** Stop periodic health checks. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Get all current health statuses. */
  getStatuses(): Map<number, HealthStatus> {
    return this.statuses;
  }

  /** Check all registered services. */
  private async checkAll(): Promise<void> {
    const checks = this.services.map((svc) => this.checkOne(svc));
    await Promise.allSettled(checks);
  }

  /** Check a single service via HEAD probe. */
  private async checkOne(service: ServiceInfo): Promise<void> {
    const start = Date.now();
    let status: HealthStatus;

    try {
      // Validate URL before probing (SSRF protection — CLAUDE.md Rule 10)
      validateUrl(service.url);

      const response = await fetch(service.url, {
        method: "HEAD",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: "follow",
      });

      const latencyMs = Date.now() - start;
      // 402 is expected for paid APIs — it means the service is alive
      const isHealthy = response.status === 200 || response.status === 402;

      status = {
        serviceId: service.serviceId,
        status: isHealthy ? "healthy" : "unhealthy",
        latencyMs,
        lastChecked: new Date().toISOString(),
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const isTimeout = err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");

      status = {
        serviceId: service.serviceId,
        status: isTimeout ? "timeout" : "unhealthy",
        latencyMs,
        lastChecked: new Date().toISOString(),
      };
    }

    this.statuses.set(service.serviceId, status);

    eventBus.emit("health:checked", {
      serviceId: service.serviceId,
      status: status.status,
      latencyMs: status.latencyMs,
      timestamp: status.lastChecked,
    });

    // Emit stale alert if service is unhealthy
    if (status.status !== "healthy") {
      eventBus.emit("registry:stale", {
        serviceId: service.serviceId,
        name: service.name,
        lastHeartbeat: service.lastHeartbeat,
      });
    }
  }
}

/** Singleton health checker. */
export const healthChecker = new HealthChecker();
