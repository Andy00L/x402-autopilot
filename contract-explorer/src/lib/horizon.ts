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
 * Normalise a raw EventSource payload (from /accounts/{addr}/operations)
 * into our local HorizonPayment shape.
 *
 * Returns either:
 *   - one HorizonPayment for a classic `type === "payment"` operation, or
 *   - one HorizonPayment per USDC `transfer` entry inside the
 *     `asset_balance_changes` array of an `invoke_host_function` op
 *     (Soroban SAC transfers), or
 *   - an empty array if the operation has nothing relevant
 *
 * Returning an array keeps the call site in `horizon-payment-store.ts`
 * uniform: a single Soroban op with two USDC transfers (e.g. an analyst
 * paying two upstream services in one tx) yields two distinct HorizonPayment
 * records, each with its own `from`/`to`/`amount`. Callers must still check
 * the asset code before acting on each result.
 */
export function normalisePayment(raw: unknown): HorizonPayment[] {
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const opId = String(r.id ?? "");
  const pagingToken = String(r.paging_token ?? "");
  const createdAt = String(r.created_at ?? "");
  const txHash = String(r.transaction_hash ?? "");
  const opType = typeof r.type === "string" ? r.type : "";

  // Classic payment operation
  if (opType === "payment" && typeof r.amount === "string") {
    return [{
      id: opId,
      pagingToken,
      type: opType,
      from: String(r.from ?? r.source_account ?? ""),
      to: String(r.to ?? ""),
      amount: String(r.amount),
      assetType: String(r.asset_type ?? ""),
      assetCode:
        typeof r.asset_code === "string" ? (r.asset_code as string) : undefined,
      assetIssuer:
        typeof r.asset_issuer === "string" ? (r.asset_issuer as string) : undefined,
      createdAt,
      transactionHash: txHash,
    }];
  }

  // Soroban host-function operation: walk asset_balance_changes for USDC
  // SAC transfers and emit one HorizonPayment per transfer.
  if (opType === "invoke_host_function" && Array.isArray(r.asset_balance_changes)) {
    const out: HorizonPayment[] = [];
    const changes = r.asset_balance_changes as Array<Record<string, unknown>>;
    for (let i = 0; i < changes.length; i += 1) {
      const c = changes[i]!;
      if (c.type !== "transfer") continue;
      if (typeof c.amount !== "string") continue;
      out.push({
        // The op id alone collides with itself when one op has multiple
        // changes; suffix with the change index so dedupe-by-id works.
        id: `${opId}:${i}`,
        pagingToken,
        type: "payment", // synthesised: downstream code only cares about the shape
        from: String(c.from ?? ""),
        to: String(c.to ?? ""),
        amount: String(c.amount),
        assetType: String(c.asset_type ?? ""),
        assetCode:
          typeof c.asset_code === "string" ? (c.asset_code as string) : undefined,
        assetIssuer:
          typeof c.asset_issuer === "string" ? (c.asset_issuer as string) : undefined,
        createdAt,
        transactionHash: txHash,
      });
    }
    return out;
  }

  return [];
}
