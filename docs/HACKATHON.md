# PayGuard Agent Hackathon Notes

## Submission Fit

PayGuard Agent satisfies the Real-World ZK requirement by making ZK the authorization boundary for AI-agent payments:

- The private policy is never stored on-chain.
- Stellar stores the policy hash and proof-backed state.
- `execute_decision` calls the RISC Zero Groth16 verifier before it can update nonce, spend, vault balance, or transfer tokens.
- The deployed gatekeeper rejects the wrong image ID, journal digest, proof bytes, policy, nonce, or executor context.

## Demo Flow

1. Connect Freighter on Stellar testnet.
2. Create a policy with max payment, daily limit, allowlist, and expiry.
3. Ask the agent to pay an allowed vendor.
4. Generate a policy decision proof job.
5. Show approved result and proof digest.
6. Ask the agent to pay an unknown vendor or over-limit amount.
7. Show verified denial and no funds moved.

## Real-Proof Work

The API exposes the exact proof job boundary and can run the real prover. The live testnet path is:

- RISC Zero guest evaluates private policy rules.
- Host prover produces a Groth16 receipt and locally verifies it.
- The API returns the verifier-compatible seal, image ID, and journal digest.
- The dashboard submits `execute_decision(policy_id, executor, seal, journal)` through the connected wallet.
- The gatekeeper calls the deployed Groth16 verifier contract before any state transition.

Live testnet contracts:

- Gatekeeper: `CDKNJSCK3DUCBJBTEFIYCGNZINAEKFBR24WNUVHCLCPUZJEBHDGLQCUK`
- RISC Zero Groth16 verifier: `CAHYIV4H2AWIXW5OQZO5EK4VOKLROLNGMB3AGJBR46XC63JKB3VM5CO5`
- Image ID: `b0c26f9bf9a887389b8004d1f105529641b10140ad42ed0cbfb6fcb7ee51e461`
