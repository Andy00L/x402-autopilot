import { HTTPFacilitatorClient } from "@x402/core/http";
import { withBazaar } from "@x402/extensions";
import { config } from "./config.js";
import * as registryClient from "./registry-client.js";
import type { ServiceInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Cache with 2-minute TTL
// ---------------------------------------------------------------------------

interface CacheEntry {
  services: ServiceInfo[];
  timestamp: number;
}

const TTL_MS = 2 * 60 * 1_000; // 2 minutes
const cache = new Map<string, CacheEntry>();

function cacheKey(capability: string | undefined): string {
  return capability ?? "__all__";
}

function getCached(key: string): ServiceInfo[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.services;
}

/** Invalidate a specific service from all caches (e.g. on payment failure). */
export function invalidateService(url: string): void {
  for (const [key, entry] of cache) {
    const filtered = entry.services.filter((s) => s.url !== url);
    if (filtered.length !== entry.services.length) {
      cache.set(key, { services: filtered, timestamp: entry.timestamp });
    }
  }
}

// ---------------------------------------------------------------------------
// Bazaar client
// ---------------------------------------------------------------------------

const facilitatorClient = new HTTPFacilitatorClient({
  url: config.ozFacilitatorUrl,
  createAuthHeaders: async () => {
    const h = { Authorization: `Bearer ${config.ozApiKey}` };
    return { verify: h, settle: h, supported: h };
  },
});

// ---------------------------------------------------------------------------
// 3-tier discovery: Bazaar → Trust Registry → Cache merge
// ---------------------------------------------------------------------------

/**
 * Discover available paid-API services.
 * Tier 1: x402 Bazaar (centralized index)
 * Tier 2: Soroban Trust Registry (on-chain)
 * Tier 3: Merge, deduplicate, sort by trust score descending
 *
 * Returns cached results if within TTL.
 */
export async function discoverServices(
  capability?: string,
  minScore?: number,
): Promise<ServiceInfo[]> {
  const key = cacheKey(capability);
  const cached = getCached(key);
  if (cached) return cached;

  // --- Tier 1: Bazaar ---
  let bazaarServices: ServiceInfo[] = [];
  try {
    const bazaarClient = withBazaar(facilitatorClient);
    const response = await bazaarClient.extensions.discovery.listResources({
      type: "http",
    });

    bazaarServices = (response.items ?? []).map(
      (item) => toBazaarServiceInfo(item as unknown as Record<string, unknown>),
    );
  } catch {
    // Bazaar down — continue with registry only
  }

  // --- Tier 2: Trust Registry (Soroban) ---
  let registryServices: ServiceInfo[] = [];
  try {
    registryServices = await registryClient.listServices(capability, minScore ?? 0);
  } catch {
    // Registry RPC down — use bazaar results with default scores
  }

  // --- Tier 3: Merge ---
  const merged = mergeAndSort(bazaarServices, registryServices, minScore ?? 0);
  cache.set(key, { services: merged, timestamp: Date.now() });
  return merged;
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

function toBazaarServiceInfo(item: Record<string, unknown>): ServiceInfo {
  return {
    serviceId: -1, // Not in registry
    name: String(item.name ?? ""),
    url: String(item.url ?? ""),
    capabilities: [],
    priceStroops: 0n,
    protocol: "x402",
    score: 70, // Default score for unverified Bazaar services
    status: "unverified",
    lastHeartbeat: 0,
  };
}

function mergeAndSort(
  bazaar: ServiceInfo[],
  registry: ServiceInfo[],
  minScore: number,
): ServiceInfo[] {
  // Index registry services by URL for dedup
  const byUrl = new Map<string, ServiceInfo>();
  for (const svc of registry) {
    byUrl.set(svc.url, svc);
  }

  // Add bazaar services not already in registry
  for (const svc of bazaar) {
    if (!byUrl.has(svc.url)) {
      byUrl.set(svc.url, svc);
    }
  }

  // Filter by min score and sort by score descending
  return Array.from(byUrl.values())
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
