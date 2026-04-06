import {
  Contract, TransactionBuilder, BASE_FEE,
  rpc, nativeToScVal, scValToNative, Address, Keypair,
} from "@stellar/stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SERVICES = [
  {
    name: "weather",
    url: `http://localhost:${process.env.PORT_WEATHER_API ?? "4001"}`,
    capabilities: ["weather"],
    priceStroops: 10_000n,
    protocol: "x402",
  },
  {
    name: "news",
    url: `http://localhost:${process.env.PORT_NEWS_API ?? "4002"}`,
    capabilities: ["news"],
    priceStroops: 10_000n,
    protocol: "x402",
  },
  {
    name: "stellar-data",
    url: `http://localhost:${process.env.PORT_STELLAR_DATA_API ?? "4003"}`,
    capabilities: ["blockchain-data"],
    priceStroops: 20_000n,
    protocol: "mpp",
  },
];

async function main(): Promise<void> {
  console.log("=== Seeding Trust Registry ===\n");

  const privateKey = process.env.STELLAR_PRIVATE_KEY;
  const contractId = process.env.TRUST_REGISTRY_CONTRACT_ID;

  if (!privateKey || !contractId) {
    console.error("Missing STELLAR_PRIVATE_KEY or TRUST_REGISTRY_CONTRACT_ID in .env");
    process.exit(1);
  }

  const keypair = Keypair.fromSecret(privateKey);
  const server = new rpc.Server(RPC_URL, { timeout: 15_000 });
  const contract = new Contract(contractId);

  for (const svc of SERVICES) {
    console.log(`Registering: ${svc.name} (${svc.protocol})`);
    try {
      const account = await server.getAccount(keypair.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: PASSPHRASE,
      })
        .addOperation(
          contract.call(
            "register_service",
            new Address(keypair.publicKey()).toScVal(),
            nativeToScVal(svc.url, { type: "symbol" }),
            nativeToScVal(svc.name, { type: "symbol" }),
            nativeToScVal(svc.capabilities, { type: "symbol" }),
            nativeToScVal(svc.priceStroops, { type: "i128" }),
            nativeToScVal(svc.protocol, { type: "symbol" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await server.prepareTransaction(tx);
      prepared.sign(keypair);
      const sendResult = await server.sendTransaction(prepared);

      if (sendResult.status === "ERROR") {
        console.error(`  TX rejected for ${svc.name}`);
        continue;
      }

      // Poll for confirmation
      let serviceId: number | undefined;
      for (let i = 0; i < 15; i++) {
        await sleep(1_000);
        try {
          const result = await server.getTransaction(sendResult.hash);
          if (result.status === "NOT_FOUND") continue;
          if (result.status === "SUCCESS") {
            serviceId = result.returnValue ? Number(scValToNative(result.returnValue)) : 0;
            break;
          }
          console.error(`  TX failed for ${svc.name}: ${result.status}`);
          break;
        } catch { continue; }
      }

      if (serviceId !== undefined) {
        console.log(`  Registered: serviceId=${serviceId}`);
      } else {
        console.error(`  Confirmation timeout for ${svc.name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      if (msg.includes("already") || msg.includes("duplicate")) {
        console.log(`  Already registered (OK)`);
      } else {
        console.error(`  Failed: ${msg}`);
      }
    }
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error(`Seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
