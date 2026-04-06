#!/usr/bin/env bash
set -euo pipefail

# Deploy the trust-registry Soroban contract to Stellar testnet.
# Usage: bash scripts/deploy-trust-registry.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONTRACT_DIR="$PROJECT_DIR/contracts/trust-registry"

# Load .env if present
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

: "${STELLAR_PUBLIC_KEY:?Set STELLAR_PUBLIC_KEY in .env}"
: "${STELLAR_PRIVATE_KEY:?Set STELLAR_PRIVATE_KEY in .env}"
: "${USDC_SAC_CONTRACT_ID:?Set USDC_SAC_CONTRACT_ID in .env}"
: "${SOROBAN_RPC_URL:=https://soroban-testnet.stellar.org}"
: "${NETWORK_PASSPHRASE:=Test SDF Network ; September 2015}"

echo "=== Building trust-registry contract ==="
cd "$CONTRACT_DIR"
stellar contract build

WASM_PATH="$CONTRACT_DIR/target/wasm32v1-none/release/trust_registry.wasm"
if [ ! -f "$WASM_PATH" ]; then
  # Fallback for older Stellar CLI versions
  WASM_PATH="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/trust_registry.wasm"
fi
if [ ! -f "$WASM_PATH" ]; then
  echo "ERROR: WASM not found. Checked wasm32v1-none and wasm32-unknown-unknown targets."
  exit 1
fi
echo "Built: $WASM_PATH"

echo ""
echo "=== Deploying to testnet ==="
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM_PATH" \
  --source "$STELLAR_PRIVATE_KEY" \
  --rpc-url "$SOROBAN_RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE")

echo "Deployed: $CONTRACT_ID"

echo ""
echo "=== Initializing contract ==="
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$STELLAR_PRIVATE_KEY" \
  --rpc-url "$SOROBAN_RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- \
  initialize \
  --admin "$STELLAR_PUBLIC_KEY" \
  --usdc_addr "$USDC_SAC_CONTRACT_ID"

echo ""
echo "=== Done ==="
echo "TRUST_REGISTRY_CONTRACT_ID=$CONTRACT_ID"
echo ""
echo "Add to your .env:"
echo "  TRUST_REGISTRY_CONTRACT_ID=$CONTRACT_ID"
