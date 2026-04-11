/**
 * ensure-service-wallets.ts
 *
 * Thin wrapper around `setup-service-wallets.ts` that runs automatically
 * before `npm run dev` via the `predev` npm hook. Its job is to make
 * service wallet setup a one-command experience: on first start, generate
 * three distinct wallets + trustlines + USDC balances; on every subsequent
 * start, notice they're already configured and exit in well under a second.
 *
 * Fast path (<1 s)
 *   All three `_WALLET` env vars present, each a well-formed G… address,
 *   each distinct from the main wallet, each paired with a `_SECRET` env
 *   var. No network calls, no subprocess.
 *
 * Slow path
 *   Spawns `npx tsx scripts/setup-service-wallets.ts` as a child process
 *   and inherits stdio so the user sees the full setup output. The full
 *   setup handles Friendbot funding, trustlines, USDC transfers, .env
 *   rewriting, and the wallet-policy allowlist update.
 *
 * Failure mode (deliberate)
 *   This script NEVER exits with a non-zero code. If setup fails, we log
 *   a clear warning and return 0 so the predev hook doesn't block the
 *   dev server from starting. The user can keep working with whatever
 *   wallets they already have in .env, and re-run `npm run
 *   setup:service-wallets` manually later.
 *
 * Why a separate wrapper, not just re-using setup-service-wallets.ts
 * ------------------------------------------------------------------
 *   The existing script is idempotent but still takes ~5-15s per run
 *   because it hits Horizon for every wallet. The wrapper short-circuits
 *   the common case (already set up) so that `npm run dev` feels instant
 *   after the first time.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const ENV_PATH = resolve(PROJECT_ROOT, ".env");
dotenv.config({ path: ENV_PATH });

const SERVICE_ENV_VARS = [
  { publicKey: "WEATHER_API_WALLET", secretKey: "WEATHER_API_SECRET" },
  { publicKey: "NEWS_API_WALLET", secretKey: "NEWS_API_SECRET" },
  { publicKey: "STELLAR_DATA_API_WALLET", secretKey: "STELLAR_DATA_API_SECRET" },
] as const;

function isWellFormedPublicKey(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length === 56 &&
    value.startsWith("G") &&
    /^[A-Z2-7]+$/.test(value)
  );
}

function isWellFormedSecretKey(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length === 56 &&
    value.startsWith("S") &&
    /^[A-Z2-7]+$/.test(value)
  );
}

function main(): number {
  // Edge case: first time user has not filled in the main wallet yet.
  // Without STELLAR_PRIVATE_KEY the setup script can't fund anything,
  // so we skip gracefully and let the services start with whatever is in
  // .env. They will log their own "missing env var" errors which point
  // the user at .env.example.
  const mainSecret = process.env.STELLAR_PRIVATE_KEY;
  if (!mainSecret || !mainSecret.startsWith("S")) {
    console.log(
      "[service-wallets] STELLAR_PRIVATE_KEY not configured yet. Skipping service wallet setup.",
    );
    console.log(
      "[service-wallets] Fill in STELLAR_PRIVATE_KEY in .env, then re-run `npm run dev`.",
    );
    return 0;
  }

  const mainPublic = process.env.STELLAR_PUBLIC_KEY ?? "";

  // Fast path: every service wallet is configured with a distinct public
  // key AND a matching secret key.
  const allConfigured = SERVICE_ENV_VARS.every(({ publicKey, secretKey }) => {
    const pub = process.env[publicKey];
    const sec = process.env[secretKey];
    if (!isWellFormedPublicKey(pub)) return false;
    if (!isWellFormedSecretKey(sec)) return false;
    if (mainPublic && pub === mainPublic) return false;
    return true;
  });

  // Fast path: also make sure the three service public keys are distinct
  // from each other. Two wallets pointing at the same address would both
  // record payments as receipts to the same party and still break the
  // dashboard's "distinct nodes" rendering.
  const pubs = SERVICE_ENV_VARS.map(({ publicKey }) => process.env[publicKey] ?? "");
  const distinct = new Set(pubs).size === pubs.length;

  if (allConfigured && distinct) {
    console.log("[service-wallets] All service wallets configured. Skipping setup.");
    return 0;
  }

  console.log("[service-wallets] Service wallets need setup.");
  console.log("[service-wallets] Running full setup (Friendbot + trustline + USDC transfer)…");

  const result = spawnSync(
    "npx",
    ["tsx", resolve(PROJECT_ROOT, "scripts/setup-service-wallets.ts")],
    {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.error) {
    console.warn(
      `[service-wallets] Setup process failed to spawn: ${result.error.message}`,
    );
    console.warn(
      "[service-wallets] Services will start, but payments may be self-transfers.",
    );
    return 0;
  }

  if (result.status !== 0) {
    console.warn(
      `[service-wallets] Setup exited with status ${result.status}. Services will start anyway.`,
    );
    console.warn(
      "[service-wallets] Re-run `npm run setup:service-wallets` to retry once the underlying issue is fixed.",
    );
    return 0;
  }

  console.log("[service-wallets] Setup complete.");
  return 0;
}

process.exit(main());
