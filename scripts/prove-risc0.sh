#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/zk/risc0"

source "${HOME}/.bashrc" >/dev/null 2>&1 || true
cargo run --release -p payguard-risc0-prover

