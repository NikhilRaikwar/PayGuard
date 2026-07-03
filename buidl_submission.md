# 🛡️ PayGuard Agent — ZK-Enforced AI Agent Payments on Stellar

> AI agents can propose payments. PayGuard makes them prove policy compliance before funds can move.

PayGuard Agent is a privacy-preserving payment control layer for AI agents on Stellar. Users define private spending rules, register only a policy hash on-chain, and require a RISC Zero Groth16 proof before a Soroban gatekeeper contract can approve a payment or record a denial.

## 🎯 What We Built

PayGuard turns AI-agent payments into a proof-gated workflow:

1. A user connects a Stellar testnet wallet.
2. The user creates private payment rules: max amount, daily budget, allowed recipients, expiry, and salt.
3. An AI agent converts a natural-language request into a structured payment intent.
4. RISC Zero proves the policy decision without exposing the private policy.
5. A Soroban gatekeeper calls the deployed RISC Zero Groth16 verifier.
6. If the proof is valid, the contract approves the payment or records a verified denial.
7. If the proof is wrong or missing, no state change happens.

## 🌟 Why It Matters

AI agents are starting to control payment flows, but most systems still rely on server-side trust. PayGuard replaces that trust with a verifiable ZK boundary.

For a DAO, startup, or ops team, this means an AI agent can help with routine payments while private rules stay private and enforcement happens on Stellar.

## 🔐 Why This Is Real ZK

ZK is not a demo badge in PayGuard. It is the authorization gate.

- Private policy values are not posted on-chain.
- The RISC Zero guest evaluates the payment against those private values.
- The public journal binds the policy, payment, nonce, network, executor, and result.
- The Soroban gatekeeper calls the RISC Zero Groth16 verifier before updating payment state.
- Wrong proof, wrong image ID, wrong journal digest, wrong nonce, or wrong executor means no payment execution.

## ✅ Real-World ZK Track Fit

PayGuard directly targets the Stellar Hacks: Real-World ZK challenge. It turns Stellar's ZK primitives into a finished agentic payments product.

The proof is the line between “the agent suggested this payment” and “the payment is allowed to execute.”

## 🔄 Product Flow

**Step 1 — Create policy**

The user defines private payment rules:

- Maximum payment amount
- Daily spending limit
- Recipient allowlist
- Policy expiry
- Private salt

Only the policy hash is registered on Stellar.

**Step 2 — Ask the agent**

The user types a request like:

```text
Pay Vendor A 30 USDC for API usage.
```

The backend parses this into a structured payment intent.

**Step 3 — Generate proof**

The RISC Zero guest evaluates the private policy against the payment intent and commits the PayGuard gatekeeper journal digest.

**Step 4 — Submit to Stellar**

The dashboard submits the proof payload through the connected wallet.

**Step 5 — Enforce on-chain**

The gatekeeper calls the RISC Zero Groth16 verifier contract. Only after successful verification can the gatekeeper update nonce, spend, vault balance, approval status, or denial status.

## 🧪 What Judges Can Verify

- The gatekeeper contract is live on Stellar testnet.
- The RISC Zero Groth16 verifier contract is live on Stellar testnet.
- The gatekeeper contract calls the verifier before state changes.
- The RISC Zero guest contains the private policy evaluation logic.
- The API has a real prover boundary and proof-job lifecycle.
- The UI submits proof-bound execution through the wallet.

## ⛓️ Stellar Testnet Deployment

**PayGuard Gatekeeper**

```text
CDKNJSCK3DUCBJBTEFIYCGNZINAEKFBR24WNUVHCLCPUZJEBHDGLQCUK
```

View:

```text
https://stellar.expert/explorer/testnet/contract/CDKNJSCK3DUCBJBTEFIYCGNZINAEKFBR24WNUVHCLCPUZJEBHDGLQCUK
```

**RISC Zero Groth16 Verifier**

```text
CAHYIV4H2AWIXW5OQZO5EK4VOKLROLNGMB3AGJBR46XC63JKB3VM5CO5
```

View:

```text
https://stellar.expert/explorer/testnet/contract/CAHYIV4H2AWIXW5OQZO5EK4VOKLROLNGMB3AGJBR46XC63JKB3VM5CO5
```

**Gatekeeper deploy transaction**

```text
4d01e0f970feddea871e0e296f481e42b0f732679c71ef4888aab2aa60bfe32c
```

**Verifier deploy transaction**

```text
2dbb911ec30bc4d7e6a611ea91b4e5d325af46a6558f6efda2910a356df3e57d
```

**RISC Zero image ID**

```text
b0c26f9bf9a887389b8004d1f105529641b10140ad42ed0cbfb6fcb7ee51e461
```

**Groth16 selector**

```text
73c457ba
```

## 🌐 Live Backend

The PayGuard API is deployed as a Hugging Face Docker Space:

```text
https://huggingface.co/spaces/NikhilRaikwar/payguard-api
```

Health:

```text
https://nikhilraikwar-payguard-api.hf.space/v1/health
```

Config:

```text
https://nikhilraikwar-payguard-api.hf.space/v1/config
```

## 🔒 Privacy Boundary

Private:

- Max payment amount
- Daily spend limit
- Recipient allowlist
- Policy expiry
- Policy salt
- Full private policy witness

Public:

- Policy hash
- Contract IDs
- RISC Zero image ID
- Proof seal
- Journal digest
- Approved or denied decision event

## 🧱 Tech Stack

- Stellar testnet
- Soroban smart contracts in Rust
- RISC Zero zkVM
- Groth16 proof verification
- Nethermind-style Stellar RISC Zero verifier pattern
- React, Vite, TypeScript
- Node.js and Express
- Hugging Face Spaces Docker backend
- Freighter and Stellar Wallets Kit
- OpenAI intent parsing

## 📁 Code Pointers

- `contracts/payguard_gatekeeper/src/lib.rs` — proof-gated payment execution
- `contracts/payguard_risc0_verifier/src/lib.rs` — RISC Zero Groth16 verifier contract
- `zk/risc0/methods/guest/src/main.rs` — private policy evaluation in the zkVM
- `zk/risc0/host/src/main.rs` — Groth16 proof payload generation
- `services/api/src/server.ts` — OpenAI intent API and proof-job lifecycle
- `apps/web/src/App.tsx` — dashboard, wallet flow, and proof submission

## 🏁 Final Judge Takeaway

PayGuard is a finished Real-World ZK product for agentic payments on Stellar. It keeps policy rules private, proves compliance with RISC Zero, verifies the proof through a Soroban verifier contract, and uses that proof as the condition for payment execution.

No valid proof means no payment.
