import { config, x402Fetch, mppFetch } from "./config.js";
import { validateUrl, parsePriceStroops } from "./security.js";
import { AsyncMutex } from "./mutex.js";
import { eventBus } from "./event-bus.js";
import { budgetTracker } from "./budget-tracker.js";
import * as policyClient from "./policy-client.js";
import { detect } from "./protocol-detector.js";
import { invalidateService } from "./discovery.js";
import {
  PolicyDeniedError, PaymentError,
} from "./types.js";
import type { AutopilotResult, DetectResult, Protocol } from "./types.js";

// ---------------------------------------------------------------------------
// Payment mutex — sequential payments per CLAUDE.md Rule 8
// ---------------------------------------------------------------------------

const mutex = new AsyncMutex();

// ---------------------------------------------------------------------------
// Main function — exact flow from CLAUDE.md (steps 1–18 + catch + finally)
// ---------------------------------------------------------------------------

/**
 * Autonomous pay-and-fetch: detect protocol, check policy, pay, fetch data.
 *
 * 1. Validate URL (SSRF protection)
 * 2. Acquire mutex (sequential payments)
 * 3. Detect protocol (HEAD probe)
 * 4. If free → normal fetch
 * 5. Parse price to BigInt stroops
 * 6. Fast local budget check
 * 7. On-chain policy check (fail-closed)
 * 8. If denied → record + throw
 * 9. Execute payment + fetch
 * 10-11. Read body ONCE, safe JSON parse
 * 12-14. Record spend on-chain
 * 15-16. Update local budget + emit event
 * 17. Return result
 */
export interface FetchOptions {
  method?: string;
  body?: unknown;
}

export async function autopilotFetch(
  url: string,
  options?: FetchOptions,
): Promise<AutopilotResult> {
  // Step 1: SSRF validation
  validateUrl(url);

  // Build RequestInit from options (method defaults to GET, no body on GET)
  const method = (options?.method ?? "GET").toUpperCase();
  const fetchInit: RequestInit = { method };
  if (options?.body !== undefined && method !== "GET") {
    fetchInit.body = JSON.stringify(options.body);
    fetchInit.headers = { "Content-Type": "application/json" };
  }

  // Step 2: Sequential payment execution
  await mutex.acquire(30_000);

  let txHash: string | undefined;
  let protocol: Protocol = "free";
  let priceStroops = 0n;
  let recipient: string | undefined;

  try {
    // Step 3: Detect payment protocol via HEAD probe
    const detection = await detect(url);
    protocol = detection.protocol;

    // Step 4: Free endpoint — no payment needed
    // Some servers (e.g. xlm402.com) return 200 on HEAD but 402 on GET.
    // If the GET returns 402, re-detect from the response and fall through to payment.
    if (protocol === "free") {
      const freeResponse = await fetch(url, { ...fetchInit, signal: AbortSignal.timeout(60_000) });
      if (freeResponse.status !== 402) {
        const text = await freeResponse.text();
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = text; }
        return { data, costStroops: 0n, protocol: "free" };
      }
      // 402 on GET — re-classify using the response headers
      const reclassified = classifyFreeAs402(freeResponse);
      protocol = reclassified.protocol;
      if (reclassified.priceRaw) {
        priceStroops = parsePriceStroops(reclassified.priceRaw);
      }
      recipient = reclassified.recipient;
      // Fall through to payment flow (steps 5+)
    }

    // Step 5: Parse price — BigInt immediately (CLAUDE.md Rule 2)
    // Skip if already parsed from a 402-on-GET reclassification (step 4 fallback)
    if (priceStroops === 0n) {
      const rawPrice = detection.priceRaw;
      if (!rawPrice) {
        throw new PaymentError(protocol, "no price found in payment headers");
      }
      priceStroops = parsePriceStroops(rawPrice);
      recipient = detection.recipient;
    }

    // Step 6: Fast local budget check
    if (!budgetTracker.checkLocal(priceStroops)) {
      throw new PolicyDeniedError("over_daily_local", budgetTracker.getBudget());
    }

    // Step 7: On-chain policy check — FAIL CLOSED (Rule 9)
    const policyResult = await policyClient.checkPolicy(
      priceStroops,
      recipient ?? config.stellarPublicKey,
    );

    // Step 8: Policy denied
    if (!policyResult.allowed) {
      await policyClient.recordDenied(priceStroops, policyResult.reason).catch(() => {});
      eventBus.emit("denied", {
        url,
        amount: priceStroops,
        reason: policyResult.reason,
        timestamp: new Date().toISOString(),
      });
      throw new PolicyDeniedError(policyResult.reason, budgetTracker.getBudget());
    }

    // Step 9: Execute payment + fetch
    let response: Response;
    if (protocol === "x402") {
      response = await executeX402(url, fetchInit);
    } else {
      response = await executeMpp(url, fetchInit);
    }

    // Step 10: Read body ONCE (CLAUDE.md Rule 3)
    const text = await response.text();

    // Step 11: Safe JSON parse — no throw on parse failure
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }

    // Step 12-13: Extract TX hash (truncate to 32 chars for Soroban Symbol)
    const rawHash = extractTxHash(response) ?? `local_${Date.now()}`;
    txHash = rawHash.slice(0, 32);
    const nonce = `n${Date.now().toString(36)}_${txHash.slice(0, 16)}`.slice(0, 32);

    // Step 14: Record spend on-chain (retry 3x)
    await policyClient.recordSpend(
      nonce,
      priceStroops,
      recipient ?? config.stellarPublicKey,
      txHash,
    );

    // Step 15: Update local budget cache
    budgetTracker.recordLocal(priceStroops);

    // Step 16: Emit success event
    eventBus.emit("spend:ok", {
      url,
      amount: priceStroops,
      protocol,
      txHash,
      recipient: recipient ?? config.stellarPublicKey,
      timestamp: new Date().toISOString(),
    });

    // (No on-chain quality report here.  An earlier version called
    // registryClient.reportQuality(0, true) — but it had no way to
    // resolve the recipient address back to a service ID, so it was
    // hardcoded to id 0 and silently failed every time.  Removed to
    // avoid wasting an RPC call on a guaranteed-failing TX.  Quality
    // reporting is best done through autopilot_research-style flows
    // where the caller already knows the service ID.)

    // Step 17: Return result
    return { data, costStroops: priceStroops, protocol, txHash };

  } catch (err) {
    // ---------------------------------------------------------------------------
    // CATCH: handle payment-settled-but-API-error vs payment-not-settled
    // ---------------------------------------------------------------------------

    if (txHash && priceStroops > 0n) {
      // Payment was settled but something went wrong after — money is gone, MUST record
      try {
        const nonce = `e${Date.now().toString(36)}_${txHash.slice(0, 16)}`.slice(0, 32);
        await policyClient.recordSpend(
          nonce,
          priceStroops,
          recipient ?? config.stellarPublicKey,
          txHash,
        );
        budgetTracker.recordLocal(priceStroops);
      } catch {
        // Last resort: local record only
        budgetTracker.recordLocal(priceStroops);
      }

      eventBus.emit("spend:api_error", {
        url,
        amount: priceStroops,
        protocol,
        txHash,
        error: err instanceof Error ? err.message : "unknown",
        timestamp: new Date().toISOString(),
      });
    } else {
      // Payment was NOT settled — no money lost
      eventBus.emit("spend:failed", {
        url,
        error: err instanceof Error ? err.message : "unknown",
        timestamp: new Date().toISOString(),
      });

      // (Same reasoning as the success path: no quality report here
      // because we cannot resolve a recipient back to a service ID.
      // Drop the URL from the discovery cache so the next discover()
      // doesn't return it again immediately.)
      invalidateService(url);
    }

    throw err;

  } finally {
    // ALWAYS release the mutex
    mutex.release();
  }
}

// ---------------------------------------------------------------------------
// x402 payment execution
// ---------------------------------------------------------------------------

async function executeX402(url: string, init: RequestInit): Promise<Response> {
  try {
    // 60s matches executeMpp and the Claude Desktop MCP tool cap.
    // Paid endpoints that run an LLM (e.g. analyst) need 13–20s total,
    // so 10s was racing against the analyst's claude -p subprocess.
    const response = await x402Fetch(url, {
      ...init,
      signal: AbortSignal.timeout(60_000),
    });
    return response;
  } catch (err) {
    throw new PaymentError(
      "x402",
      `fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// MPP charge execution via mppx SDK client
// The SDK handles the full 402 challenge-response-credential cycle.
// ---------------------------------------------------------------------------

async function executeMpp(url: string, init: RequestInit): Promise<Response> {
  try {
    // mppFetch handles: initial request -> 402 challenge -> build credential
    // -> sign SAC transfer -> retry with Authorization header -> 200 + data
    // Timeout is generous because MPP involves on-chain TX confirmation.
    const response = await mppFetch(url, {
      ...init,
      signal: AbortSignal.timeout(60_000),
    });
    return response;
  } catch (err) {
    throw new PaymentError(
      "mpp",
      `charge failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Re-classify a response that came back 402 on GET after HEAD returned 200.
// Parses the x402 v2 payment-required header from the 402 response.
// ---------------------------------------------------------------------------

function classifyFreeAs402(response: Response): DetectResult {
  const headers = response.headers;

  // x402 v2: payment-required header (base64 JSON)
  const paymentRequired = headers.get("payment-required");
  if (paymentRequired) {
    try {
      const json = Buffer.from(paymentRequired, "base64").toString("utf-8");
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const accepts = parsed.accepts;
      if (Array.isArray(accepts) && accepts.length > 0) {
        const first = accepts[0] as Record<string, unknown>;
        return {
          protocol: "x402",
          headers,
          priceRaw: typeof first.amount === "string" ? first.amount : undefined,
          recipient: typeof first.payTo === "string" ? first.payTo : undefined,
        };
      }
    } catch { /* fall through */ }
  }

  // x402 v1 / legacy
  const legacyHeader = headers.get("x-payment") || headers.get("x-payment-required");
  if (legacyHeader) {
    return { protocol: "x402", headers };
  }

  // MPP
  const wwwAuth = headers.get("www-authenticate") ?? "";
  if (wwwAuth.toLowerCase().startsWith("payment")) {
    return { protocol: "mpp", headers };
  }

  // Unrecognized 402 — assume x402
  return { protocol: "x402", headers };
}

// ---------------------------------------------------------------------------
// TX hash extraction from response headers
// ---------------------------------------------------------------------------

function extractTxHash(response: Response): string | undefined {
  // x402 returns tx hash in various headers
  return (
    response.headers.get("x-payment-tx-hash") ??
    response.headers.get("x-transaction-hash") ??
    response.headers.get("x-tx-hash") ??
    undefined
  );
}
