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
//
// Defensive cap on the encoded length: Node's default HTTP header size
// limit is 16 KB total, but a single response header CAN approach that.
// A 16 KB base64 blob decodes to ~12 KB of JSON, which JSON.parse can
// chew through quickly enough but a hostile server could still craft a
// nested object/array bomb that costs disproportionate CPU. We therefore
// reject anything over MAX_PAYMENT_HEADER_LENGTH outright.
// ---------------------------------------------------------------------------

const MAX_PAYMENT_HEADER_LENGTH = 8192; // 8 KB encoded base64

function parseX402V2Header(base64: string): { price?: string; payTo?: string } {
  if (base64.length === 0 || base64.length > MAX_PAYMENT_HEADER_LENGTH) return {};
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

function decodeMppRequestParam(wwwAuth: string): Record<string, unknown> | null {
  const requestMatch = /request="([^"]+)"/.exec(wwwAuth);
  if (!requestMatch) return null;
  const encoded = requestMatch[1]!;
  // Same defensive cap as parseX402V2Header. The MPP request param is
  // base64url-encoded JSON; an unbounded blob in a 402 header is a CPU
  // burn vector even though Node's HTTP header size limit caps it.
  if (encoded.length === 0 || encoded.length > MAX_PAYMENT_HEADER_LENGTH) return null;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf-8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractMppPrice(wwwAuth: string): string | undefined {
  const obj = decodeMppRequestParam(wwwAuth);
  if (obj && typeof obj.amount === "string") return obj.amount;
  // Fallback: try amount="..." directly in the header
  const match = /amount="([^"]+)"/.exec(wwwAuth);
  return match?.[1];
}

function extractMppRecipient(wwwAuth: string): string | undefined {
  const obj = decodeMppRequestParam(wwwAuth);
  if (obj && typeof obj.recipient === "string") return obj.recipient;
  // Fallback: try address="..." directly in the header
  const addrMatch = /address="([^"]+)"/.exec(wwwAuth);
  return addrMatch?.[1];
}
