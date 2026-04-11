/**
 * setup-service-wallets.ts
 *
 * Generates individual Stellar testnet wallets for the three demo services
 * (weather, news, stellar-data) so that payments to each service are real,
 * distinct transfers visible on the dashboard, not self-sends.
 *
 * Steps (idempotent — safe to re-run):
 *   1. For each service: generate a keypair, or reuse one already in .env.
 *   2. Fund each via Friendbot (skip if the account already exists).
 *   3. Add the USDC trustline (skip if already present).
 *   4. Send $0.10 USDC from the main wallet to each (skip if already funded).
 *   5. Rewrite .env with the new public + secret keys.
 *   6. Read the wallet-policy allowlist from contract instance storage,
 *      merge in the new wallets, and call set_allowlist. Empty allowlist
 *      means "allow all" — we leave it alone in that case.
 *
 * Design notes:
 *   - BASE_FEE, Horizon patterns, and the USDC issuer match scripts/setup-testnet.ts.
 *   - Instance-storage walk for the allowlist mirrors contract-explorer/src/lib/soroban-rpc.ts.
 *   - Contract invocation pattern (prepare → sign → send → poll) mirrors scripts/seed-registry.ts.
 *   - Secret keys are never logged — only public keys and the masked "G...xxxx" form.
 */

import {
  Keypair,
  Horizon,
  Networks,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Contract,
  rpc,
  xdr,
  Address,
  scValToNative,
} from "@stellar/stellar-sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV_PATH = resolve(__dirname, "../.env");
dotenv.config({ path: ENV_PATH });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const USDC_ISSUER =
  process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);
const FUND_AMOUNT = "0.10"; // $0.10 USDC per service wallet
const MIN_MAIN_BALANCE = 0.30; // 3 × $0.10

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function maskKey(key: string): string {
  if (key.length < 8) return "***";
  return `${key.slice(0, 1)}...${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Service wallet spec
// ---------------------------------------------------------------------------

interface ServiceWalletSpec {
  name: string;
  envPublicKey: string;
  envSecretKey: string;
  keypair: Keypair;
  isNew: boolean;
}

function getOrCreateKeypair(
  envPublicVar: string,
  envSecretVar: string,
): { keypair: Keypair; isNew: boolean } {
  const existingSecret = process.env[envSecretVar];
  if (
    existingSecret &&
    existingSecret.startsWith("S") &&
    existingSecret.length === 56
  ) {
    try {
      return { keypair: Keypair.fromSecret(existingSecret), isNew: false };
    } catch {
      // Secret present but malformed — fall through and generate a new one.
    }
  }
  return { keypair: Keypair.random(), isNew: true };
}

// ---------------------------------------------------------------------------
// Friendbot
// ---------------------------------------------------------------------------

async function fundWithFriendbot(publicKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`, {
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(
      `Friendbot request failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  if (res.ok) {
    console.log(`  Funded with 10,000 XLM via Friendbot`);
    return;
  }

  // Friendbot returns 400 if the account already exists — that's fine.
  const body = await res.text();
  if (
    body.includes("createAccountAlreadyExist") ||
    body.includes("op_already_exists") ||
    body.includes("already funded")
  ) {
    console.log(`  Already funded (account exists)`);
    return;
  }

  throw new Error(`Friendbot failed: ${res.status} ${body.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// USDC trustline
// ---------------------------------------------------------------------------

async function addUsdcTrustline(
  horizon: Horizon.Server,
  keypair: Keypair,
): Promise<void> {
  const account = await horizon.loadAccount(keypair.publicKey());
  const hasTrustline = account.balances.some(
    (b) =>
      "asset_code" in b &&
      b.asset_code === "USDC" &&
      "asset_issuer" in b &&
      b.asset_issuer === USDC_ISSUER,
  );
  if (hasTrustline) {
    console.log(`  USDC trustline already exists`);
    return;
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  await horizon.submitTransaction(tx);
  console.log(`  USDC trustline added`);
}

// ---------------------------------------------------------------------------
// USDC helpers
// ---------------------------------------------------------------------------

async function getUsdcBalance(
  horizon: Horizon.Server,
  publicKey: string,
): Promise<number> {
  try {
    const account = await horizon.loadAccount(publicKey);
    const b = account.balances.find(
      (x) =>
        "asset_code" in x &&
        x.asset_code === "USDC" &&
        "asset_issuer" in x &&
        x.asset_issuer === USDC_ISSUER,
    );
    return b ? parseFloat(b.balance) : 0;
  } catch {
    return 0;
  }
}

async function sendUsdc(
  horizon: Horizon.Server,
  sender: Keypair,
  recipientPublicKey: string,
  amount: string,
): Promise<void> {
  const current = await getUsdcBalance(horizon, recipientPublicKey);
  if (current >= parseFloat(amount)) {
    console.log(`  Already has $${current.toFixed(4)} USDC, skipping transfer`);
    return;
  }

  const senderAccount = await horizon.loadAccount(sender.publicKey());
  const tx = new TransactionBuilder(senderAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: recipientPublicKey,
        asset: USDC,
        amount,
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(sender);
  await horizon.submitTransaction(tx);
  console.log(`  Sent $${amount} USDC from main wallet`);
}

// ---------------------------------------------------------------------------
// .env file update
// ---------------------------------------------------------------------------

function upsertEnvVar(content: string, key: string, value: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped}=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    return content.replace(regex, line);
  }
  const prefix = content.endsWith("\n") ? "" : "\n";
  return content + prefix + line + "\n";
}

function updateEnvFile(wallets: ServiceWalletSpec[]): void {
  let content = readFileSync(ENV_PATH, "utf-8");
  for (const w of wallets) {
    content = upsertEnvVar(content, w.envPublicKey, w.keypair.publicKey());
    content = upsertEnvVar(content, w.envSecretKey, w.keypair.secret());
  }
  writeFileSync(ENV_PATH, content);
  console.log(`.env updated at ${ENV_PATH}`);
}

// ---------------------------------------------------------------------------
// Wallet-policy allowlist: read from instance storage, merge, write
// ---------------------------------------------------------------------------

/**
 * Read the wallet-policy contract's instance storage via raw ledger-entry
 * access, then extract the Vec<Address> stored under DataKey::Allowlist.
 *
 * Returns:
 *   - string[] — the current allowlist (may be empty)
 *   - null     — the contract instance or storage entry is unreadable
 *
 * Soroban represents a payload-less enum variant (DataKey::Allowlist) as
 * ScVec([ScSymbol("Allowlist")]), so we match that key shape exactly.
 */
async function readAllowlist(
  server: rpc.Server,
  contractId: string,
): Promise<string[] | null> {
  let entries;
  try {
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const result = await server.getLedgerEntries(ledgerKey);
    if (result.entries.length === 0) return null;
    const data = result.entries[0]!.val.contractData();
    const value = data.val();
    if (value.switch().name !== "scvContractInstance") return null;
    const storage = value.instance().storage();
    if (!storage) return [];
    entries = storage.map((e) => ({ key: e.key(), val: e.val() }));
  } catch (err) {
    console.warn(
      `  (could not read allowlist: ${err instanceof Error ? err.message : "unknown"})`,
    );
    return null;
  }

  for (const { key, val } of entries) {
    if (key.switch().name !== "scvVec") continue;
    const vec = key.vec();
    if (!vec || vec.length !== 1) continue;
    const head = vec[0]!;
    if (head.switch().name !== "scvSymbol") continue;
    if (head.sym().toString() !== "Allowlist") continue;

    const decoded = scValToNative(val);
    if (!Array.isArray(decoded)) return [];
    return decoded.map(String);
  }
  return [];
}

/**
 * Call wallet-policy::set_allowlist(addresses). Requires main-wallet auth
 * (the contract owner). Poll for confirmation for up to 30 seconds.
 */
async function writeAllowlist(
  server: rpc.Server,
  contractId: string,
  owner: Keypair,
  addresses: string[],
): Promise<void> {
  const contract = new Contract(contractId);
  const account = await server.getAccount(owner.publicKey());

  const vecScVal = xdr.ScVal.scvVec(
    addresses.map((a) => new Address(a).toScVal()),
  );

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call("set_allowlist", vecScVal))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(owner);

  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    throw new Error(
      `set_allowlist rejected: ${sendResult.errorResult?.toXDR("base64") ?? "unknown"}`,
    );
  }
  if (sendResult.status === "DUPLICATE") {
    throw new Error("set_allowlist: DUPLICATE — nonce reuse");
  }

  for (let i = 0; i < 30; i++) {
    await sleep(1_000);
    let result;
    try {
      result = await server.getTransaction(sendResult.hash);
    } catch {
      continue;
    }
    if (result.status === "NOT_FOUND") continue;
    if (result.status === "SUCCESS") {
      console.log(`  set_allowlist confirmed (tx: ${sendResult.hash.slice(0, 12)}…)`);
      return;
    }
    throw new Error(`set_allowlist failed on-chain: ${result.status}`);
  }
  throw new Error(
    `set_allowlist confirmation timeout (hash: ${sendResult.hash})`,
  );
}

/**
 * Read the current allowlist, add the new service wallets if missing,
 * and (only if something actually changed) call set_allowlist. An empty
 * allowlist means "allow all" in the wallet-policy contract — we leave
 * that alone so we don't accidentally lock out existing recipients that
 * the user never explicitly whitelisted (analyst, xlm402 services, etc).
 */
async function updateAllowlist(
  mainKeypair: Keypair,
  servicePublicKeys: string[],
): Promise<void> {
  const contractId = process.env.WALLET_POLICY_CONTRACT_ID;
  if (!contractId) {
    console.warn(
      "  WALLET_POLICY_CONTRACT_ID not set — skipping allowlist update",
    );
    printManualAllowlistInstructions(servicePublicKeys);
    return;
  }

  const server = new rpc.Server(RPC_URL, { timeout: 15_000 });
  const current = await readAllowlist(server, contractId);

  if (current === null) {
    console.warn("  Could not read current allowlist from contract storage");
    printManualAllowlistInstructions(servicePublicKeys);
    return;
  }

  if (current.length === 0) {
    console.log(
      "  Current allowlist is empty (allow-all). Leaving unchanged — the",
    );
    console.log(
      "  new wallets are already allowed. Set explicit entries with autopilot_set_policy if desired.",
    );
    return;
  }

  console.log(`  Current allowlist has ${current.length} entries:`);
  for (const addr of current) console.log(`    - ${maskKey(addr)}`);

  const merged = Array.from(new Set([...current, ...servicePublicKeys]));
  const addedCount = merged.length - current.length;
  if (addedCount === 0) {
    console.log("  All new service wallets are already in the allowlist");
    return;
  }

  console.log(`  Adding ${addedCount} new wallet(s), calling set_allowlist…`);
  try {
    await writeAllowlist(server, contractId, mainKeypair, merged);
    console.log(`  Allowlist updated: ${merged.length} total entries`);
  } catch (err) {
    console.error(
      `  set_allowlist failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
    printManualAllowlistInstructions(servicePublicKeys);
  }
}

function printManualAllowlistInstructions(servicePublicKeys: string[]): void {
  console.log("\n  Manual step — add these addresses to the allowlist:");
  for (const pk of servicePublicKeys) console.log(`    ${pk}`);
  console.log(
    "  Use: autopilot_set_policy (MCP) or a scripted set_allowlist call.",
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Setting up individual service wallets ===\n");

  // --- Verify main wallet ---
  const mainSecret = process.env.STELLAR_PRIVATE_KEY;
  if (!mainSecret) {
    console.error("STELLAR_PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  const mainKeypair = Keypair.fromSecret(mainSecret);
  console.log(`Main wallet: ${maskKey(mainKeypair.publicKey())}`);

  const horizon = new Horizon.Server(HORIZON_URL);

  const mainBalance = await getUsdcBalance(horizon, mainKeypair.publicKey());
  console.log(`Main wallet USDC balance: $${mainBalance.toFixed(4)}`);
  if (mainBalance < MIN_MAIN_BALANCE) {
    console.error(
      `\nInsufficient USDC. Need at least $${MIN_MAIN_BALANCE.toFixed(2)} to fund 3 service wallets.`,
    );
    console.error(
      `Get testnet USDC: https://faucet.circle.com (select Stellar)`,
    );
    process.exit(1);
  }

  // --- Build service wallet specs ---
  const specs: Array<Omit<ServiceWalletSpec, "keypair" | "isNew">> = [
    { name: "weather",      envPublicKey: "WEATHER_API_WALLET",      envSecretKey: "WEATHER_API_SECRET" },
    { name: "news",         envPublicKey: "NEWS_API_WALLET",         envSecretKey: "NEWS_API_SECRET" },
    { name: "stellar-data", envPublicKey: "STELLAR_DATA_API_WALLET", envSecretKey: "STELLAR_DATA_API_SECRET" },
  ];

  const wallets: ServiceWalletSpec[] = specs.map((s) => {
    const { keypair, isNew } = getOrCreateKeypair(s.envPublicKey, s.envSecretKey);
    return { ...s, keypair, isNew };
  });

  // --- Detect wallets that currently point at the main wallet (self-pay
  //     configuration). Those need fresh keypairs even if the _WALLET env
  //     var is set, because no _SECRET exists yet.
  for (const w of wallets) {
    if (!w.isNew) continue;
    const existingPublic = process.env[w.envPublicKey];
    if (existingPublic && existingPublic === mainKeypair.publicKey()) {
      console.log(
        `  ${w.name}: ${w.envPublicKey} currently points to main wallet — replacing with a new keypair`,
      );
    }
  }

  // --- Per-wallet setup ---
  for (const w of wallets) {
    console.log(`\n--- ${w.name} ---`);
    console.log(`  Address: ${w.keypair.publicKey()}`);
    console.log(`  ${w.isNew ? "NEW keypair (generated)" : "Reusing existing keypair from .env"}`);

    try {
      await fundWithFriendbot(w.keypair.publicKey());
      await addUsdcTrustline(horizon, w.keypair);
      await sendUsdc(horizon, mainKeypair, w.keypair.publicKey(), FUND_AMOUNT);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(`  Setup failed for ${w.name}: ${msg}`);
      process.exit(1);
    }
  }

  // --- Update .env ---
  console.log("");
  updateEnvFile(wallets);

  // --- Update allowlist ---
  console.log("\n--- Wallet-policy allowlist ---");
  await updateAllowlist(
    mainKeypair,
    wallets.map((w) => w.keypair.publicKey()),
  );

  // --- Summary ---
  console.log("\n=== Done ===");
  console.log("Restart services to pick up the new wallets: npm run dev:all\n");
  console.log("Service wallet public keys:");
  for (const w of wallets) {
    console.log(`  ${w.name.padEnd(14)} ${w.keypair.publicKey()}`);
  }
  console.log(
    "\nView on Horizon: https://horizon-testnet.stellar.org/accounts/<address>",
  );
}

main().catch((err) => {
  console.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
