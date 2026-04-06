#!/usr/bin/env bash
set -euo pipefail

# Deploy the wallet-policy Soroban contract to Stellar testnet.
# Usage: bash scripts/deploy-wallet-policy.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONTRACT_DIR="$PROJECT_DIR/contracts/wallet-policy"

# Load .env if present
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

: "${STELLAR_PUBLIC_KEY:?Set STELLAR_PUBLIC_KEY in .env}"
: "${STELLAR_PRIVATE_KEY:?Set STELLAR_PRIVATE_KEY in .env}"
: "${SOROBAN_RPC_URL:=https://soroban-testnet.stellar.org}"
: "${NETWORK_PASSPHRASE:=Test SDF Network ; September 2015}"

# Default policy: $0.50/day, $0.01/tx, 20 req/min
: "${DEFAULT_DAILY_LIMIT:=5000000}"
: "${DEFAULT_PER_TX_LIMIT:=100000}"
: "${DEFAULT_RATE_LIMIT:=20}"

echo "=== Building wallet-policy contract ==="
cd "$CONTRACT_DIR"
stellar contract build

WASM_PATH="$CONTRACT_DIR/target/wasm32v1-none/release/wallet_policy.wasm"
if [ ! -f "$WASM_PATH" ]; then
  # Fallback for older Stellar CLI versions
  WASM_PATH="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/wallet_policy.wasm"
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
  --owner "$STELLAR_PUBLIC_KEY" \
  --daily_limit "$DEFAULT_DAILY_LIMIT" \
  --per_tx_limit "$DEFAULT_PER_TX_LIMIT" \
  --rate_limit "$DEFAULT_RATE_LIMIT"

echo ""
echo "=== Done ==="
echo "WALLET_POLICY_CONTRACT_ID=$CONTRACT_ID"
echo ""
echo "Add to your .env:"
echo "  WALLET_POLICY_CONTRACT_ID=$CONTRACT_ID"
