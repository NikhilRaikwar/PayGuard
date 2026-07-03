#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/zk/risc0"

source "${HOME}/.bashrc" >/dev/null 2>&1 || true

echo "PayGuard prover starting in $(pwd)" >&2
echo "PAYGUARD_REPO_ROOT=${PAYGUARD_REPO_ROOT:-$ROOT}" >&2

if [ "${PAYGUARD_SKIP_RZUP_INSTALL:-false}" != "true" ] && command -v rzup >/dev/null 2>&1; then
  rzup install risc0-groth16 >/dev/null
fi

if [ -x target/release/payguard-risc0-prover ]; then
  echo "Using prebuilt prover binary: target/release/payguard-risc0-prover" >&2
  exec target/release/payguard-risc0-prover
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found and prebuilt prover binary is missing." >&2
  exit 127
fi

echo "Prebuilt prover binary missing; building/running with cargo." >&2
cargo run --release -p payguard-risc0-prover
