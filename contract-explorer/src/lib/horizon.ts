/**
 * Horizon helpers that are NOT tied to a specific store.
 *
 *   - `amountToStroops`   safe BigInt parse of Horizon's fixed-decimal amount
 *                         strings. Never uses `parseFloat` — that would lose
 *                         precision at the 7th decimal.
 *   - `normalisePayment`  flattens Horizon's snake_case payment payload into
 *                         our camelCase `HorizonPayment` shape.
 *
 * REST polling (balance + history) lives in
 * `stores/horizon-wallet-data-store.ts`. EventSource management lives in
 * `stores/horizon-payment-store.ts`. Those stores previously re-imported
 * helpers from this file; they now carry their own fetch code so there is
 * exactly one implementation per concern.
 */
import { STROOPS_PER_USDC } from "./constants";
import type { HorizonPayment } from "./types";

/**
 * Parse a Horizon amount string ("0.0050000") to stroops without losing
 * precision.
 *
 *   "0.0050000"    → 50_000n
 *   "12.3456789"   → 123_456_789n
 *   "0"            → 0n
 *
 * Horizon returns fixed-decimal strings. parseFloat would introduce binary
 * rounding at the 7th decimal; BigInt + string manipulation is exact.
 */
export function amountToStroops(amount: string): bigint {
  if (!amount || amount === "0") return 0n;
  const negative = amount.startsWith("-");
  const trimmed = negative ? amount.slice(1) : amount;
  const dot = trimmed.indexOf(".");
  let whole: string;
  let frac: string;
  if (dot === -1) {
    whole = trimmed;
    frac = "0000000";
  } else {
    whole = trimmed.slice(0, dot);
    frac = trimmed.slice(dot + 1).padEnd(7, "0").slice(0, 7);
  }
  // Strict digit check: garbage returns 0 rather than triggering a BigInt
  // exception further up the call chain.
  if (!/^\d+$/.test(whole) || !/^\d+$/.test(frac)) return 0n;
  const sign = negative ? -1n : 1n;
  return sign * (BigInt(whole) * STROOPS_PER_USDC + BigInt(frac));
}

/**
 * Normalise a raw EventSource payload into our local HorizonPayment shape.
 * Returns null if the payload is not a "payment" type or the amount is
 * missing / malformed. Callers must additionally check the asset_code
 * before acting on the result (see `HorizonPaymentStore.isUsdcByCode`).
 */
export function normalisePayment(raw: unknown): HorizonPayment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "payment") return null;
  if (typeof r.amount !== "string") return null;
  return {
    id: String(r.id ?? ""),
    pagingToken: String(r.paging_token ?? ""),
    type: String(r.type),
    from: String(r.from ?? r.source_account ?? ""),
    to: String(r.to ?? ""),
    amount: String(r.amount),
    assetType: String(r.asset_type ?? ""),
    assetCode:
      typeof r.asset_code === "string" ? (r.asset_code as string) : undefined,
    assetIssuer:
      typeof r.asset_issuer === "string" ? (r.asset_issuer as string) : undefined,
    createdAt: String(r.created_at ?? ""),
    transactionHash: String(r.transaction_hash ?? ""),
  };
}
