# PayGuard ZK Layer

`zk/risc0` contains the real RISC Zero path:

- `methods/guest`: policy evaluation inside the zkVM.
- `host`: reads proof input JSON from stdin, proves the guest, verifies the receipt locally, and writes API JSON to stdout.
- `scripts/prove-risc0.sh`: command used by `PAYGUARD_REAL_PROVER_CMD`.

The private witness is the policy rule set: per-payment limit, daily budget, allowlist, expiry, and salt. The public journal contains the approval flag, violation code, policy hash, intent digest, and journal digest.

## WSL Build

From the WSL shell where `rzup install` was run:

```bash
cd "/mnt/d/Nikhil Work/STELLAR HACKATHON/PayGuard"
source /root/.bashrc
cd zk/risc0
cargo run --release -p payguard-risc0-prover < prover-input.example.json
```

For the API:

```bash
PAYGUARD_REAL_PROVER_CMD=scripts/prove-risc0.sh npm run dev:api
```

## Stellar Testnet Pattern

RISC Zero receipts are verified off-chain by the host today. The Soroban-compatible verifier is `contracts/payguard_attestation_verifier`: it requires the configured attester to authorize the verifier call and emits the image ID plus journal digest. The gatekeeper contract still validates the public journal semantics before updating balances or transferring tokens.
