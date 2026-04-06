import { config, x402Fetch, mppFetch } from "./config.js";
import { validateUrl, parsePriceStroops } from "./security.js";
import { AsyncMutex } from "./mutex.js";
import { eventBus } from "./event-bus.js";
import { budgetTracker } from "./budget-tracker.js";
import * as policyClient from "./policy-client.js";
import * as registryClient from "./registry-client.js";
import { detect } from "./protocol-detector.js";
import { invalidateService } from "./discovery.js";
import {
  PolicyDeniedError, PaymentError,
} from "./types.js";
import type { AutopilotResult, Protocol } from "./types.js";

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
 * 17. Report quality (fire-and-forget)
 * 18. Return result
 */
export async function autopilotFetch(url: string): Promise<AutopilotResult> {
  // Step 1: SSRF validation
  validateUrl(url);

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
    if (protocol === "free") {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = text; }
      return { data, costStroops: 0n, protocol: "free" };
    }

    // Step 5: Parse price — BigInt immediately (CLAUDE.md Rule 2)
    const rawPrice = detection.priceRaw;
    if (!rawPrice) {
      throw new PaymentError(protocol, "no price found in payment headers");
    }
    priceStroops = parsePriceStroops(rawPrice);
    recipient = detection.recipient;

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
      response = await executeX402(url);
    } else {
      response = await executeMpp(url);
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
      timestamp: new Date().toISOString(),
    });

    // Step 17: Report quality — fire-and-forget
    if (recipient) {
      registryClient.reportQuality(0, true); // serviceId resolved by registry
    }

    // Step 18: Return result
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

      // Report bad quality
      registryClient.reportQuality(0, false);
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

async function executeX402(url: string): Promise<Response> {
  try {
    const response = await x402Fetch(url, {
      signal: AbortSignal.timeout(10_000),
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

async function executeMpp(url: string): Promise<Response> {
  try {
    // mppFetch handles: initial GET -> 402 challenge -> build credential
    // -> sign SAC transfer -> retry with Authorization header -> 200 + data
    // Timeout is generous because MPP involves on-chain TX confirmation.
    const response = await mppFetch(url, {
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
