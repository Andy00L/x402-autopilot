import { autopilotFetch } from "../src/autopay.js";
import { discoverServices } from "../src/discovery.js";
import { budgetTracker } from "../src/budget-tracker.js";
import type { AutopilotResult } from "../src/types.js";

const WEATHER_URL = `http://localhost:${process.env.PORT_WEATHER_API ?? "4001"}/weather`;
const NEWS_URL = `http://localhost:${process.env.PORT_NEWS_API ?? "4002"}/news`;
const STELLAR_URL = `http://localhost:${process.env.PORT_STELLAR_DATA_API ?? "4003"}/stellar-stats`;

function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => typeof val === "bigint" ? val.toString() : val, 2);
}

function formatUsd(stroops: bigint): string {
  const usd = Number(stroops) / 10_000_000;
  return `$${usd.toFixed(4)}`;
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     x402 Autopilot Demo              ║");
  console.log("╚══════════════════════════════════════╝\n");

  // Sync budget
  await budgetTracker.syncFromSoroban();
  const startBudget = budgetTracker.getBudget();
  console.log(`Starting budget: ${formatUsd(startBudget.remaining)} remaining\n`);

  let totalCost = 0n;
  let callCount = 0;
  const protocols = new Set<string>();

  // --- Step 1: Discover services ---
  console.log("--- Step 1: Discover Services ---");
  try {
    const services = await discoverServices();
    console.log(`Found ${services.length} services:`);
    for (const s of services) {
      console.log(`  ${s.name} | ${s.url} | ${s.protocol} | score: ${s.score}`);
    }
  } catch (err) {
    console.log(`  Discovery failed (non-fatal): ${err instanceof Error ? err.message : "error"}`);
  }

  // --- Step 2: Fetch weather (x402) ---
  console.log("\n--- Step 2: Fetch Weather (x402) ---");
  try {
    const result: AutopilotResult = await autopilotFetch(WEATHER_URL);
    console.log(`  Protocol: ${result.protocol}`);
    console.log(`  Cost: ${formatUsd(result.costStroops)}`);
    console.log(`  Data: ${toJson(result.data)}`);
    totalCost += result.costStroops;
    callCount++;
    protocols.add(result.protocol);
  } catch (err) {
    console.error(`  Failed: ${err instanceof Error ? err.message : "error"}`);
  }

  // --- Step 3: Fetch news (x402) ---
  console.log("\n--- Step 3: Fetch News (x402) ---");
  try {
    const result = await autopilotFetch(NEWS_URL);
    console.log(`  Protocol: ${result.protocol}`);
    console.log(`  Cost: ${formatUsd(result.costStroops)}`);
    console.log(`  Headlines: ${Array.isArray(result.data) ? (result.data as unknown[]).length : "?"} items`);
    totalCost += result.costStroops;
    callCount++;
    protocols.add(result.protocol);
  } catch (err) {
    console.error(`  Failed: ${err instanceof Error ? err.message : "error"}`);
  }

  // --- Step 4: Fetch stellar data (MPP) ---
  console.log("\n--- Step 4: Fetch Stellar Data (MPP charge) ---");
  try {
    const result = await autopilotFetch(STELLAR_URL);
    console.log(`  Protocol: ${result.protocol}`);
    console.log(`  Cost: ${formatUsd(result.costStroops)}`);
    console.log(`  Data: ${toJson(result.data)}`);
    totalCost += result.costStroops;
    callCount++;
    protocols.add(result.protocol);
  } catch (err) {
    console.error(`  Failed: ${err instanceof Error ? err.message : "error"}`);
  }

  // --- Step 5: Check budget ---
  console.log("\n--- Step 5: Budget Check ---");
  const endBudget = budgetTracker.getBudget();
  console.log(`  Spent today: ${formatUsd(endBudget.spentToday)}`);
  console.log(`  Remaining:   ${formatUsd(endBudget.remaining)}`);

  // --- Step 6: Test denial ---
  console.log("\n--- Step 6: Simulate Attack (non-allowlisted URL) ---");
  try {
    await autopilotFetch("https://evil.example.com/drain");
    console.log("  WARNING: Should have been denied!");
  } catch (err) {
    console.log(`  DENIED: ${err instanceof Error ? err.name : "Error"}`);
    console.log(`  Reason: ${err instanceof Error ? err.message : "unknown"}`);
    console.log("  Funds intact.");
  }

  // --- Summary ---
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║           Demo Summary               ║");
  console.log("╠══════════════════════════════════════╣");
  console.log(`║  Calls made:    ${callCount}`);
  console.log(`║  Protocols:     ${Array.from(protocols).join(", ") || "none"}`);
  console.log(`║  Total cost:    ${formatUsd(totalCost)}`);
  console.log(`║  Budget left:   ${formatUsd(endBudget.remaining)}`);
  console.log("╚══════════════════════════════════════╝");
}

main().catch((err) => {
  console.error(`Demo failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
