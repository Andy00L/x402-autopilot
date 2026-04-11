import { config } from "./config.js";
import { SecurityError } from "./types.js";

// ---------------------------------------------------------------------------
// SSRF prevention — CLAUDE.md Rule 10
// ---------------------------------------------------------------------------

const PRIVATE_PREFIXES = ["10.", "127.", "0.", "169.254.", "192.168."];

/** Check if hostname is a private/reserved IP address. */
function isPrivateIP(hostname: string): boolean {
  // Direct matches
  if (hostname === "0.0.0.0" || hostname === "[::]" || hostname === "[::1]") {
    return true;
  }

  // IPv4 simple prefix check
  for (const prefix of PRIVATE_PREFIXES) {
    if (hostname.startsWith(prefix)) return true;
  }

  // 172.16.0.0/12 — 172.16.x.x through 172.31.x.x
  if (hostname.startsWith("172.")) {
    const parts = hostname.split(".");
    if (parts.length >= 2) {
      const second = Number(parts[1]);
      if (second >= 16 && second <= 31) return true;
    }
  }

  return false;
}

/**
 * Validate a URL before making external requests.
 * Throws SecurityError on violation. Per CLAUDE.md Rule 10.
 */
export function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SecurityError("INVALID_URL");
  }

  // Protocol check
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new SecurityError("INVALID_PROTOCOL");
  }

  // HTTP only allowed in dev mode
  if (parsed.protocol === "http:" && !config.allowHttp) {
    throw new SecurityError("HTTP_NOT_ALLOWED");
  }

  const hostname = parsed.hostname;

  // Localhost check
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") {
    if (!config.allowHttp) {
      throw new SecurityError("SSRF_BLOCKED");
    }
  }

  // Private IP check
  if (isPrivateIP(hostname) && !config.allowHttp) {
    throw new SecurityError("SSRF_BLOCKED");
  }
}

// ---------------------------------------------------------------------------
// Price parsing — CLAUDE.md Rule 2
// parseFloat is used ONLY here, immediately converted to BigInt.
// ---------------------------------------------------------------------------

/**
 * Parse a price string into BigInt stroops.
 * "$0.001" → 10000n, "10000" → 10000n
 *
 * This is the ONLY place parseFloat is allowed per CLAUDE.md Rule 2.
 *
 * Defensive bounds:
 *   - Negative, NaN, and Infinity are rejected.
 *   - Dollar amounts so large that `dollars * 10_000_000` exceeds
 *     `Number.MAX_SAFE_INTEGER` are rejected.  Above that point JavaScript
 *     numbers lose integer precision and `BigInt(...)` either throws or
 *     silently builds a wrong value — neither is acceptable for money math.
 */
export function parsePriceStroops(priceString: string): bigint {
  if (priceString.startsWith("$")) {
    const dollars = parseFloat(priceString.slice(1));
    if (!Number.isFinite(dollars) || dollars < 0) {
      throw new SecurityError("INVALID_PRICE");
    }
    const stroopsFloat = dollars * 10_000_000;
    if (stroopsFloat > Number.MAX_SAFE_INTEGER) {
      throw new SecurityError("INVALID_PRICE");
    }
    return BigInt(Math.round(stroopsFloat));
  }
  const raw = priceString.trim();
  if (!/^\d+$/.test(raw)) {
    throw new SecurityError("INVALID_PRICE");
  }
  return BigInt(raw);
}

