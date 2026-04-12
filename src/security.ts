import { config } from "./config.js";
import { SecurityError } from "./types.js";

// ---------------------------------------------------------------------------
// SSRF prevention — CLAUDE.md Rule 10
//
// What this catches:
//   - Non-HTTP(S) schemes (file://, javascript:, data:, ftp://, etc.)
//   - Localhost via "localhost", 127/8, 0.0.0.0
//   - Exotic IPv4 encodings (octal 0177.0.0.1, decimal 2130706433,
//     hex 0x7f000001, partial 127.1) — Node's URL parser already
//     normalises these to 127.0.0.1, so the localhost check matches
//   - IPv4 RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
//   - IPv4 link-local 169.254/16
//   - IPv6 loopback ([::1]) and unspecified ([::])
//   - IPv6 link-local fe80::/10
//   - IPv6 unique-local fc00::/7 (fc.. and fd..)
//   - IPv6 multicast ff00::/8
//   - IPv6-mapped IPv4 [::ffff:127.0.0.1] / [::ffff:10.0.0.1] / etc
//     (these route to the IPv4 address; Node normalises them to
//      hex form like [::ffff:7f00:1], which we re-decode and re-check)
//
// Known limitation:
//   - DNS rebinding via wildcard services like 127.0.0.1.nip.io is NOT
//     caught. Doing so would require a DNS pre-resolution step here.
//     The host resolves to 127.0.0.1 only at fetch time.
// ---------------------------------------------------------------------------

const PRIVATE_PREFIXES = ["10.", "127.", "0.", "169.254.", "192.168."];

/** Decode `[::ffff:7f00:1]` style IPv6-mapped IPv4 to a dotted-quad. */
function ipv6MappedToIpv4(hostname: string): string | null {
  // Strip surrounding brackets that Node leaves on for IPv6 hostnames.
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
  const inner = hostname.slice(1, -1).toLowerCase();

  // Form 1: ::ffff:a.b.c.d (rare; Node normalises away)
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(inner);
  if (dotted) return dotted[1]!;

  // Form 2: ::ffff:HHHH:HHHH (Node's canonical form for ::ffff:a.b.c.d)
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    const a = (high >> 8) & 0xff;
    const b = high & 0xff;
    const c = (low >> 8) & 0xff;
    const d = low & 0xff;
    return `${a}.${b}.${c}.${d}`;
  }

  return null;
}

/** Check if a dotted-quad IPv4 string is a private/reserved address. */
function isPrivateIPv4(addr: string): boolean {
  if (addr === "0.0.0.0" || addr === "127.0.0.1") return true;
  for (const prefix of PRIVATE_PREFIXES) {
    if (addr.startsWith(prefix)) return true;
  }
  // 172.16.0.0/12 — 172.16.x.x through 172.31.x.x
  if (addr.startsWith("172.")) {
    const parts = addr.split(".");
    if (parts.length >= 2) {
      const second = Number(parts[1]);
      if (second >= 16 && second <= 31) return true;
    }
  }
  return false;
}

/** Check if hostname is a private/reserved IP address. */
function isPrivateIP(hostname: string): boolean {
  // ─── IPv4 path ─────────────────────────────────────────────────────────
  if (isPrivateIPv4(hostname)) return true;

  // ─── IPv6 path ─────────────────────────────────────────────────────────
  // Node's URL parser keeps the brackets on `URL.hostname` for IPv6 inputs.
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const inner = hostname.slice(1, -1).toLowerCase();

  // Loopback and unspecified.
  if (inner === "::1" || inner === "::") return true;

  // IPv6 link-local: fe80::/10 — first 10 bits are 1111 1110 10
  // In practice every link-local address starts with "fe8", "fe9", "fea", "feb".
  if (
    inner.startsWith("fe8") ||
    inner.startsWith("fe9") ||
    inner.startsWith("fea") ||
    inner.startsWith("feb")
  ) {
    return true;
  }

  // IPv6 unique local: fc00::/7 — every address starts with "fc" or "fd".
  if (inner.startsWith("fc") || inner.startsWith("fd")) return true;

  // IPv6 multicast: ff00::/8 — every multicast address starts with "ff".
  if (inner.startsWith("ff")) return true;

  // IPv4-mapped IPv6: ::ffff:a.b.c.d. The mapped IPv4 routes through the
  // host's IPv4 stack, so localhost / RFC1918 are reachable via this form.
  // Node normalises ::ffff:127.0.0.1 to ::ffff:7f00:1, so we have to
  // re-decode and re-check the embedded IPv4.
  const mapped = ipv6MappedToIpv4(hostname);
  if (mapped !== null && isPrivateIPv4(mapped)) return true;

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

  // Localhost / loopback explicit checks (covers DNS name + canonicalised
  // IPv4 forms; isPrivateIP handles the IPv6 loopback below).
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") {
    if (!config.allowHttp) {
      throw new SecurityError("SSRF_BLOCKED");
    }
  }

  // Private IP check (IPv4 ranges + IPv6 ranges + IPv4-mapped IPv6).
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
 *   - Input length capped at MAX_PRICE_STRING_LENGTH so a hostile 402
 *     header with a multi-megabyte digit string can't burn CPU on regex
 *     scanning or BigInt construction.
 *   - Negative, NaN, and Infinity are rejected.
 *   - Dollar amounts so large that `dollars * 10_000_000` exceeds
 *     `Number.MAX_SAFE_INTEGER` are rejected.  Above that point JavaScript
 *     numbers lose integer precision and `BigInt(...)` either throws or
 *     silently builds a wrong value (neither is acceptable for money).
 */
const MAX_PRICE_STRING_LENGTH = 64;

export function parsePriceStroops(priceString: string): bigint {
  if (priceString.length === 0 || priceString.length > MAX_PRICE_STRING_LENGTH) {
    throw new SecurityError("INVALID_PRICE");
  }
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

