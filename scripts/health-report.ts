import { discoverServices } from "../src/discovery.js";
import type { ServiceInfo } from "../src/types.js";

async function main(): Promise<void> {
  console.log("=== Service Health Report ===\n");

  let services: ServiceInfo[];
  try {
    services = await discoverServices();
  } catch {
    console.log("Could not load services from registry. Trying defaults...");
    services = [];
  }

  if (services.length === 0) {
    // Fall back to known local services
    const ports = [
      { name: "weather", url: `http://localhost:${process.env.PORT_WEATHER_API ?? "4001"}/health` },
      { name: "news", url: `http://localhost:${process.env.PORT_NEWS_API ?? "4002"}/health` },
      { name: "stellar-data", url: `http://localhost:${process.env.PORT_STELLAR_DATA_API ?? "4003"}/health` },
    ];
    for (const p of ports) {
      services.push({
        serviceId: -1,
        name: p.name,
        url: p.url,
        capabilities: [],
        priceStroops: 0n,
        protocol: "unknown",
        score: 0,
        status: "unknown",
        lastHeartbeat: 0,
      });
    }
  }

  // Header
  console.log(
    padR("Name", 16) +
    padR("URL", 36) +
    padR("Score", 8) +
    padR("Status", 12) +
    "Latency",
  );
  console.log("-".repeat(80));

  for (const svc of services) {
    const probeUrl = svc.url.includes("/health") ? svc.url : svc.url.replace(/\/?$/, "/health");
    const start = Date.now();
    let status = "unknown";
    let latency = "-";

    try {
      const res = await fetch(probeUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      const ms = Date.now() - start;
      latency = `${ms}ms`;
      status = res.ok ? "healthy" : `http:${res.status}`;
    } catch (err) {
      const ms = Date.now() - start;
      latency = `${ms}ms`;
      const isTimeout = err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      status = isTimeout ? "timeout" : "down";
    }

    console.log(
      padR(svc.name, 16) +
      padR(svc.url.slice(0, 34), 36) +
      padR(String(svc.score), 8) +
      padR(status, 12) +
      latency,
    );
  }

  console.log("");
}

function padR(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

main().catch((err) => {
  console.error(`Health report failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
