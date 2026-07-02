# PayGuard Agent

ZK-enforced AI agent payment policy layer on Stellar.

PayGuard Agent lets a user define private payment rules for an AI agent, register only the policy hash on Stellar, and require proof-backed policy enforcement before funds can move. The product is built for the Stellar Hacks: Real-World ZK track and is structured as a clean-room project, independent from earlier prototypes.

## What Works Now

- React/Vite landing page and dashboard based on the supplied PayGuard HTML designs.
- Freighter wallet connection and Stellar testnet RPC health checks.
- Server-side OpenAI payment-intent endpoint, with a deterministic local fallback when `OPENAI_API_KEY` is not set.
- Proof job API that can run a real RISC Zero prover through `PAYGUARD_REAL_PROVER_CMD`.
- Soroban gatekeeper contract plus a Stellar-compatible attestation verifier for RISC Zero receipts.
- `temp/` is ignored so prototype HTML files do not go to GitHub.

## Architecture

```text
apps/web        React dashboard, wallet connect, policy builder, agent console
services/api    OpenAI intent API and proof job lifecycle
packages/protocol shared policy hashing, USDC math, validation and evaluation
contracts/payguard_gatekeeper Soroban vault + proof-gated decision execution
contracts/payguard_attestation_verifier RISC Zero receipt attestation gate for Stellar testnet
zk/risc0        RISC Zero guest + host prover workspace
```

## Quick Start

```powershell
npm install
npm run build
npm run dev:api
npm run dev:web
```

Open the web app at `http://localhost:5173`.

## Environment

Copy `.env.example` to `.env` and fill:

```text
OPENAI_API_KEY=...
VITE_PAYGUARD_CONTRACT_ID=...
VITE_PAYGUARD_VERIFIER_CONTRACT_ID=...
VITE_PAYGUARD_TOKEN_CONTRACT_ID=...
PAYGUARD_RISC0_IMAGE_ID=...
PAYGUARD_REAL_PROVER_CMD=scripts/prove-risc0.sh
```

Without `OPENAI_API_KEY`, the backend uses a deterministic local payment-intent fallback for demo flow. Without `PAYGUARD_REAL_PROVER_CMD`, proof jobs fall back to the deterministic development evaluator.

## ZK Boundary

RISC Zero receipts are generated and verified by `zk/risc0/host`. On Stellar testnet today, PayGuard uses the attestation pattern from the ZK skill guidance: the receipt is verified off-chain, then an authorized attester signs the verifier contract call that gates the Soroban state transition. When native BN254 verification is available on the target Stellar network, `payguard_attestation_verifier` can be replaced by a direct Groth16 verifier without changing the gatekeeper payment flow.

Run the prover from your WSL shell after installing `rzup`:

```bash
source /root/.bashrc
PAYGUARD_REAL_PROVER_CMD=scripts/prove-risc0.sh npm run dev:api
```

## License

MIT. Copyright (c) 2026 Nikhil Raikwar.
