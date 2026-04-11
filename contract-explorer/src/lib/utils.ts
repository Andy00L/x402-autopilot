import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { STROOPS_PER_USDC } from "./constants";

/**
 * shadcn's canonical `cn` helper: `clsx` for conditional class composition,
 * `twMerge` on top so conflicting Tailwind utilities (e.g. `px-2` vs
 * `px-4`) resolve to the last one in source order instead of both sticking
 * to the element.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ─── Money formatting (BigInt safe) ─────────────────────────────────────────

/**
 * Format stroops as a USDC string.  Always 7-decimal precise.
 *   formatUsdc(10_000n)      → "$0.001000"
 *   formatUsdc(5_000_000n)   → "$0.50"
 *   formatUsdc(12_500_000n)  → "$1.25"
 */
export function formatUsdc(stroops: bigint, opts?: { compact?: boolean }): string {
  if (stroops === 0n) return "$0.00";
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_USDC;
  const frac = abs % STROOPS_PER_USDC;
  const fracStr = frac.toString().padStart(7, "0");

  // Trim trailing zeros, leave a sensible minimum
  let trimmed = fracStr.replace(/0+$/, "");
  if (opts?.compact) {
    if (trimmed.length === 0) trimmed = "00";
    else if (trimmed.length === 1) trimmed += "0";
    if (trimmed.length > 4) trimmed = trimmed.slice(0, 4);
  } else {
    if (trimmed.length < 2) trimmed = trimmed.padEnd(2, "0");
  }
  const sign = negative ? "-" : "";
  return `${sign}$${whole.toLocaleString("en-US")}.${trimmed}`;
}

/** Raw stroops with thousands separators: 12_500_000n → "12,500,000". */
export function formatStroops(stroops: bigint): string {
  return stroops.toLocaleString("en-US");
}

/** Format a count integer with thousands separators. */
export function formatCount(n: number | bigint | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return BigInt(n).toLocaleString("en-US");
}

// ─── Address formatting ─────────────────────────────────────────────────────

/** Truncate a Stellar address: G…ABCD or C…WXYZ. */
export function truncateAddress(addr: string, head = 4, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

// ─── Time formatting ────────────────────────────────────────────────────────

/** "2s ago", "14m ago", "1h ago", "3d ago" — clamps for stale data. */
export function formatTimeAgo(iso: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 0) return "now";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

/** "14:32:08" — local 24-hour time. */
export function formatClock(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return "—";
  }
}

// ─── Misc ───────────────────────────────────────────────────────────────────

/** Safe divide bigint → percentage 0..100, never NaN. */
export function pctOf(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  // Multiply first to keep precision in BigInt land.
  const scaled = (numerator * 10000n) / denominator;
  const pct = Number(scaled) / 100;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}
