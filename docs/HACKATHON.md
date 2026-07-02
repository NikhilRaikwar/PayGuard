# PayGuard Agent Hackathon Notes

## Submission Fit

PayGuard Agent satisfies the Real-World ZK requirement by making ZK the authorization boundary for AI-agent payments:

- The private policy is never stored on-chain.
- Stellar stores the policy hash and proof-backed state.
- `execute_decision` calls the configured verifier before it can update nonce, spend, vault balance, or transfer tokens.

## Demo Flow

1. Connect Freighter on Stellar testnet.
2. Create a policy with max payment, daily limit, allowlist, and expiry.
3. Ask the agent to pay an allowed vendor.
4. Generate a policy decision proof job.
5. Show approved result and proof digest.
6. Ask the agent to pay an unknown vendor or over-limit amount.
7. Show verified denial and no funds moved.

## Real-Proof Work

The API exposes the exact proof job boundary and can run the real prover:

- Set `PAYGUARD_REAL_PROVER_CMD=scripts/prove-risc0.sh`.
- The RISC Zero host proves the zkVM policy method and verifies the receipt locally.
- Deploy `payguard_attestation_verifier` with the API/attester wallet.
- Deploy `payguard_gatekeeper` with the verifier address and RISC Zero image ID.
- Submit `execute_decision(policy_id, executor, seal, journal)` on testnet.

This follows the Stellar-compatible attestation pattern until native BN254 verification is available on the target network. The verifier contract boundary is isolated so a direct Groth16 verifier can replace the attestation verifier later.
