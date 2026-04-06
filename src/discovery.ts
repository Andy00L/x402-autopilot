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
// Bazaar client (Tier 1)
// ---------------------------------------------------------------------------

const facilitatorClient = new HTTPFacilitatorClient({
  url: config.ozFacilitatorUrl,
  createAuthHeaders: async () => {
    const h = { Authorization: `Bearer ${config.ozApiKey}` };
    return { verify: h, settle: h, supported: h };
  },
});

// ---------------------------------------------------------------------------
// xlm402.com catalog (Tier 3) — external x402 services on Stellar
// ---------------------------------------------------------------------------

const XLM402_CATALOG_URL = "https://xlm402.com/api/catalog";
const XLM402_BASE_URL = "https://xlm402.com";

/** Map xlm402 service IDs to our capability names. */
function mapXlm402Capability(service: string): string {
  const mapping: Record<string, string> = {
    weather: "weather",
    news: "news",
    crypto: "blockchain",
    scrape: "scraping",
    collect: "scraping",
    chat: "chat",
    image: "image",
  };
  return mapping[service] ?? service;
}

interface Xlm402CacheEntry {
  services: ServiceInfo[];
  timestamp: number;
}

let xlm402Cache: Xlm402CacheEntry | null = null;

async function fetchXlm402Catalog(capability?: string): Promise<ServiceInfo[]> {
  // Check cache
  if (xlm402Cache && Date.now() - xlm402Cache.timestamp < TTL_MS) {
    const cached = xlm402Cache.services;
    return capability ? cached.filter((s) => s.capability === capability) : cached;
  }

  try {
    const response = await fetch(XLM402_CATALOG_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];

    const text = await response.text();
    let catalog: Record<string, unknown>;
    try {
      catalog = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return [];
    }

    const endpoints = catalog.endpoints;
    if (!Array.isArray(endpoints)) return [];

    const services: ServiceInfo[] = [];
    for (const ep of endpoints) {
      if (typeof ep !== "object" || ep === null) continue;
      const entry = ep as Record<string, unknown>;

      // Only testnet endpoints
      if (entry.network !== "testnet") continue;

      // Parse price safely
      const priceUsd = parseFloat(String(entry.price_usd ?? "0"));
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

      const path = String(entry.path ?? "");
      if (!path) continue;

      services.push({
        serviceId: -1, // Not in on-chain registry
        name: `xlm402:${String(entry.id ?? entry.service ?? "")}`,
        url: `${XLM402_BASE_URL}${path}`,
        capability: mapXlm402Capability(String(entry.service ?? "")),
        priceStroops: BigInt(Math.round(priceUsd * 10_000_000)),
        protocol: "x402",
        score: 70, // Default for unverified external services
      });
    }

    xlm402Cache = { services, timestamp: Date.now() };
    return capability ? services.filter((s) => s.capability === capability) : services;
  } catch {
    // xlm402.com down — degrade gracefully, tiers 1 and 2 still work
    return [];
  }
}

// ---------------------------------------------------------------------------
// 3-tier discovery: Bazaar → Trust Registry → xlm402.com → merge
// ---------------------------------------------------------------------------

/**
 * Discover available paid-API services.
 * Tier 1: x402 Bazaar (centralized index)
 * Tier 2: Soroban Trust Registry (on-chain, filtered by capability)
 * Tier 3: xlm402.com catalog (external x402 services on Stellar testnet)
 * Merge: deduplicate by URL (registry wins), sort by trust score descending
 *
 * Returns cached results if within TTL.
 */
export async function discoverServices(
  capability: string = "weather",
  minScore: number = 0,
  limit: number = 10,
): Promise<ServiceInfo[]> {
  const key = capability;
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
    // Bazaar down — continue with other tiers
  }

  // --- Tier 2: Trust Registry (Soroban) — filtered by capability + limit ---
  let registryServices: ServiceInfo[] = [];
  try {
    registryServices = await registryClient.listServices(capability, minScore, limit);
  } catch {
    // Registry RPC down — continue with other tiers
  }

  // --- Tier 3: xlm402.com catalog (external services) ---
  let xlm402Services: ServiceInfo[] = [];
  try {
    xlm402Services = await fetchXlm402Catalog(capability);
  } catch {
    // xlm402.com down — degrade gracefully
  }

  // --- Merge: registry first (has on-chain trust score), then bazaar, then xlm402 ---
  const merged = mergeAndSort(
    [...registryServices, ...bazaarServices, ...xlm402Services],
    minScore,
  );
  cache.set(key, { services: merged, timestamp: Date.now() });
  return merged;
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

function toBazaarServiceInfo(item: Record<string, unknown>): ServiceInfo {
  return {
    serviceId: -1,
    name: String(item.name ?? ""),
    url: String(item.url ?? ""),
    capability: "",
    priceStroops: 0n,
    protocol: "x402",
    score: 70,
  };
}

function mergeAndSort(
  services: ServiceInfo[],
  minScore: number,
): ServiceInfo[] {
  // Deduplicate by URL — first occurrence wins (registry before xlm402)
  const byUrl = new Map<string, ServiceInfo>();
  for (const svc of services) {
    if (!byUrl.has(svc.url)) {
      byUrl.set(svc.url, svc);
    }
  }

  // Filter by min score and sort by score descending
  return Array.from(byUrl.values())
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
