import { validateUrl } from "./security.js";
import { NetworkError } from "./types.js";
import type { DetectResult, Protocol } from "./types.js";

/**
 * Detect the payment protocol for a URL via HEAD probe.
 *
 * - Status 402 + x402 payment headers → "x402"
 * - Status 402 + WWW-Authenticate: Payment → "mpp"
 * - Status 200 or other → "free"
 *
 * HEAD with 5s timeout. Retries once on timeout.
 */
export async function detect(url: string): Promise<DetectResult> {
  validateUrl(url);

  let lastError: Error | undefined;

  // Retry once on timeout (per CLAUDE.md edge case #7)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
        redirect: "follow",
      });

      return classifyResponse(response);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Only retry on timeout, not other errors
      if (lastError.name !== "TimeoutError" && lastError.name !== "AbortError") {
        throw new NetworkError("protocol_detector", `HEAD ${url}: ${lastError.message}`);
      }

      // First timeout → retry
      if (attempt === 0) continue;
    }
  }

  throw new NetworkError(
    "protocol_detector",
    `HEAD ${url}: timeout after 2 attempts`,
  );
}

function classifyResponse(response: Response): DetectResult {
  const headers = response.headers;

  if (response.status === 402) {
    // --- x402 v2: PAYMENT-REQUIRED header (base64 JSON) ---
    const paymentRequired = headers.get("payment-required");
    if (paymentRequired) {
      const { price, payTo } = parseX402V2Header(paymentRequired);
      return {
        protocol: "x402",
        headers,
        priceRaw: price,
        recipient: payTo,
      };
    }

    // --- x402 v1 / legacy: X-Payment or X-Payment-Required headers ---
    const legacyHeader = headers.get("x-payment") || headers.get("x-payment-required");
    if (legacyHeader) {
      return {
        protocol: "x402",
        headers,
        priceRaw: extractLegacyX402Price(legacyHeader),
        recipient: extractLegacyX402Recipient(legacyHeader),
      };
    }

    // --- MPP: WWW-Authenticate: Payment header ---
    const wwwAuth = headers.get("www-authenticate") ?? "";
    if (wwwAuth.toLowerCase().startsWith("payment")) {
      return {
        protocol: "mpp",
        headers,
        priceRaw: extractMppPrice(wwwAuth),
        recipient: extractMppRecipient(wwwAuth),
      };
    }

    // 402 but unrecognized protocol — treat as x402 fallback
    return { protocol: "x402" as Protocol, headers };
  }

  // Non-402 response — free endpoint
  return { protocol: "free" as Protocol, headers };
}

// ---------------------------------------------------------------------------
// x402 v2: PAYMENT-REQUIRED header (base64-encoded JSON)
//
// Decoded structure:
// {
//   "x402Version": 2,
//   "accepts": [{
//     "scheme": "exact",
//     "amount": "10000",        ← stroops as string
//     "payTo": "G...",
//     "network": "stellar:testnet",
//     "asset": "CBIELTK6..."
//   }]
// }
// ---------------------------------------------------------------------------

function parseX402V2Header(base64: string): { price?: string; payTo?: string } {
  try {
    const json = Buffer.from(base64, "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(json);

    if (typeof parsed !== "object" || parsed === null) return {};
    const obj = parsed as Record<string, unknown>;

    const accepts = obj.accepts;
    if (!Array.isArray(accepts) || accepts.length === 0) return {};

    const first = accepts[0] as Record<string, unknown>;
    const amount = typeof first.amount === "string" ? first.amount : undefined;
    const payTo = typeof first.payTo === "string" ? first.payTo : undefined;

    return { price: amount, payTo };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// x402 v1 / legacy header parsing
// ---------------------------------------------------------------------------

function extractLegacyX402Price(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" && parsed !== null &&
      "price" in parsed && typeof (parsed as Record<string, unknown>).price === "string"
    ) {
      return (parsed as Record<string, string>).price;
    }
  } catch { /* not JSON */ }
  return undefined;
}

function extractLegacyX402Recipient(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" && parsed !== null &&
      "payTo" in parsed && typeof (parsed as Record<string, unknown>).payTo === "string"
    ) {
      return (parsed as Record<string, string>).payTo;
    }
  } catch { /* not JSON */ }
  return undefined;
}

// ---------------------------------------------------------------------------
// MPP header parsing
// ---------------------------------------------------------------------------

function extractMppPrice(wwwAuth: string): string | undefined {
  // Amount is inside the base64url-encoded "request" parameter
  const requestMatch = /request="([^"]+)"/.exec(wwwAuth);
  if (requestMatch) {
    try {
      const json = Buffer.from(requestMatch[1], "base64url").toString("utf-8");
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.amount === "string") return obj.amount;
      }
    } catch { /* ignore decode failure */ }
  }
  // Fallback: try amount="..." directly in the header
  const match = /amount="([^"]+)"/.exec(wwwAuth);
  return match?.[1];
}

function extractMppRecipient(wwwAuth: string): string | undefined {
  // MPP uses 'recipient' in the base64url request param, but also may
  // have 'address' directly. Check the decoded request param first.
  const requestMatch = /request="([^"]+)"/.exec(wwwAuth);
  if (requestMatch) {
    try {
      const json = Buffer.from(requestMatch[1], "base64url").toString("utf-8");
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.recipient === "string") return obj.recipient;
      }
    } catch { /* ignore decode failure */ }
  }

  // Fallback: try address="..." directly in the header
  const addrMatch = /address="([^"]+)"/.exec(wwwAuth);
  return addrMatch?.[1];
}
