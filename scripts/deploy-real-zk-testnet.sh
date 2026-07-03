#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SOURCE="${STELLAR_SOURCE:-payguard-deployer}"
NETWORK="${STELLAR_NETWORK:-testnet}"
NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
IMAGE_ID="${PAYGUARD_RISC0_IMAGE_ID:?Set PAYGUARD_RISC0_IMAGE_ID to the 32-byte RISC Zero image ID hex.}"

if ! command -v stellar >/dev/null 2>&1; then
  echo "stellar CLI is required. Install it in WSL with: cargo install stellar-cli --locked" >&2
  exit 1
fi

NETWORK_HASH="$(
  python3 - "$NETWORK_PASSPHRASE" <<'PY'
import hashlib, sys
print(hashlib.sha256(sys.argv[1].encode()).hexdigest())
PY
)"

echo "Building contracts..."
stellar contract build

VERIFIER_WASM="target/wasm32v1-none/release/payguard_risc0_verifier.wasm"
GATEKEEPER_WASM="target/wasm32v1-none/release/payguard_gatekeeper.wasm"

echo "Deploying RISC Zero Groth16 verifier..."
VERIFIER_ID="$(
  stellar contract deploy \
    --wasm "$VERIFIER_WASM" \
    --source "$SOURCE" \
    --network "$NETWORK"
)"

echo "Deploying PayGuard gatekeeper..."
GATEKEEPER_ID="$(
  stellar contract deploy \
    --wasm "$GATEKEEPER_WASM" \
    --source "$SOURCE" \
    --network "$NETWORK" \
    -- \
    --verifier "$VERIFIER_ID" \
    --image_id "$IMAGE_ID" \
    --network_hash "$NETWORK_HASH"
)"

cat <<EOF
Real-ZK testnet deployment complete.

PAYGUARD_VERIFIER_CONTRACT_ID=$VERIFIER_ID
PAYGUARD_CONTRACT_ID=$GATEKEEPER_ID
PAYGUARD_RISC0_IMAGE_ID=$IMAGE_ID
PAYGUARD_VERIFIER_MODE=risc0-groth16-onchain
STELLAR_NETWORK_HASH=$NETWORK_HASH

VITE_PAYGUARD_VERIFIER_CONTRACT_ID=$VERIFIER_ID
VITE_PAYGUARD_CONTRACT_ID=$GATEKEEPER_ID
VITE_PAYGUARD_RISC0_IMAGE_ID=$IMAGE_ID
EOF
