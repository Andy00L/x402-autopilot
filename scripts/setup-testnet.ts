import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset } from "@stellar/stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

const FRIENDBOT_URL = "https://friendbot.stellar.org";
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const USDC_ISSUER = process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function maskKey(key: string): string {
  if (key.length < 8) return "***";
  return `${key.slice(0, 1)}...${key.slice(-4)}`;
}

async function main(): Promise<void> {
  console.log("=== x402 Autopilot - Testnet Setup ===\n");

  // --- Get or generate keypair ---
  let keypair: Keypair;
  if (process.env.STELLAR_PRIVATE_KEY) {
    keypair = Keypair.fromSecret(process.env.STELLAR_PRIVATE_KEY);
    console.log(`Using existing wallet: ${maskKey(keypair.publicKey())}`);
  } else {
    keypair = Keypair.random();
    console.log("Generated new keypair.");
    console.log(`  Public:  ${keypair.publicKey()}`);
    console.log(`  Secret:  ${keypair.secret()}`);
    console.log("  (Save this secret to STELLAR_PRIVATE_KEY in .env)\n");
  }

  const publicKey = keypair.publicKey();

  // --- Fund via Friendbot ---
  console.log("\n--- Funding via Friendbot ---");
  try {
    const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.ok) {
      console.log("Funded successfully.");
    } else if (text.includes("createAccountAlreadyExist") || res.status === 400) {
      console.log("Account already funded (OK).");
    } else {
      console.error(`Friendbot error (${res.status}): ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`Friendbot failed: ${err instanceof Error ? err.message : "timeout"}`);
  }

  // --- Add USDC trustline ---
  console.log("\n--- Adding USDC trustline ---");
  const horizon = new Horizon.Server(HORIZON_URL);
  try {
    const account = await horizon.loadAccount(publicKey);
    const hasTrustline = account.balances.some(
      (b) =>
        "asset_issuer" in b &&
        b.asset_issuer === USDC_ISSUER &&
        b.asset_code === "USDC",
    );

    if (hasTrustline) {
      console.log("USDC trustline already exists (OK).");
    } else {
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.changeTrust({
            asset: new Asset("USDC", USDC_ISSUER),
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(keypair);
      await horizon.submitTransaction(tx);
      console.log("USDC trustline added.");
    }
  } catch (err) {
    console.error(`Trustline error: ${err instanceof Error ? err.message : "unknown"}`);
  }

  // --- Output for .env ---
  console.log("\n=== Setup Complete ===");
  console.log("\nAdd these to your .env file:\n");
  console.log(`STELLAR_PUBLIC_KEY=${publicKey}`);
  if (!process.env.STELLAR_PRIVATE_KEY) {
    console.log(`STELLAR_PRIVATE_KEY=${keypair.secret()}`);
  }
  console.log(`USDC_ISSUER=${USDC_ISSUER}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Get USDC from the testnet faucet: https://xlm402.com");
  console.log("  2. Deploy contracts: npm run deploy:wallet-policy");
  console.log("  3. Deploy contracts: npm run deploy:trust-registry");
}

main().catch((err) => {
  console.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
