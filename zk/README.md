# PayGuard ZK Layer

`zk/risc0` contains the real RISC Zero path:

- `methods/guest`: policy evaluation inside the zkVM.
- `host`: reads proof input JSON from stdin, proves the guest with Groth16, verifies the receipt locally, and writes API JSON to stdout.
- `scripts/prove-risc0-groth16.sh`: command used by `PAYGUARD_REAL_PROVER_CMD`.

The private witness is the policy rule set: per-payment limit, daily budget, allowlist, expiry, and salt. The public RISC Zero journal is exactly 32 bytes: the PayGuard gatekeeper decision digest. The gatekeeper independently recomputes that digest from the submitted Soroban journal before calling the on-chain verifier.

## Runtime Boundary

The proof service must run in a Linux environment with the RISC Zero Groth16 toolchain installed. The browser and Vercel frontend do not run the prover; they call the API, receive proof payloads, and submit wallet-signed Soroban transactions.

## Stellar Testnet Pattern

RISC Zero receipts are verified on-chain by `contracts/payguard_risc0_verifier`, a Nethermind-style Groth16 verifier using Stellar BN254 host functions. The gatekeeper contract treats this verifier as the required authorization boundary for payment execution.
