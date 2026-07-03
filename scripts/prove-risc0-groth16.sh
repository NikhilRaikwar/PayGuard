#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/zk/risc0"

source "${HOME}/.bashrc" >/dev/null 2>&1 || true

if [ "${PAYGUARD_SKIP_RZUP_INSTALL:-false}" != "true" ] && command -v rzup >/dev/null 2>&1; then
  rzup install risc0-groth16 >/dev/null
fi

if [ -x target/release/payguard-risc0-prover ]; then
  exec target/release/payguard-risc0-prover
fi

cargo run --release -p payguard-risc0-prover
