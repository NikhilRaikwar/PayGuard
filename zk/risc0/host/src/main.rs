use anyhow::{Context, Result};
use payguard_risc0_methods::{PAYGUARD_RISC0_GUEST_ELF, PAYGUARD_RISC0_GUEST_ID};
use risc0_ethereum_contracts::encode_seal;
use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts, sha::Digestible};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Read};

#[derive(Deserialize, Serialize)]
struct Policy {
    name: String,
    #[serde(rename = "maxPerPayment")]
    max_per_payment: String,
    #[serde(rename = "dailyLimit")]
    daily_limit: String,
    allowlist: Vec<String>,
    expiry: String,
    salt: String,
}

#[derive(Deserialize, Serialize)]
struct Intent {
    recipient: String,
    amount: String,
    asset: String,
    category: String,
    memo: String,
    rationale: String,
    #[serde(rename = "riskLevel")]
    risk_level: String,
}

#[derive(Deserialize, Serialize)]
struct ProverInput {
    policy: Policy,
    intent: Intent,
    #[serde(rename = "spentToday")]
    spent_today: String,
    #[serde(rename = "vaultBalance")]
    vault_balance: String,
    #[serde(rename = "proofDate")]
    proof_date: String,
    #[serde(rename = "executionContext")]
    execution_context: ExecutionContext,
}

#[derive(Deserialize, Serialize)]
struct ExecutionContext {
    #[serde(rename = "networkHash")]
    network_hash: String,
    #[serde(rename = "policyId")]
    policy_id: String,
    #[serde(rename = "policyHash")]
    policy_hash: String,
    amount: String,
    #[serde(rename = "dayIndex")]
    day_index: String,
    #[serde(rename = "spentBefore")]
    spent_before: String,
    #[serde(rename = "spentAfter")]
    spent_after: String,
    #[serde(rename = "vaultBefore")]
    vault_before: String,
    #[serde(rename = "vaultAfter")]
    vault_after: String,
    nonce: String,
    #[serde(rename = "proofTimestamp")]
    proof_timestamp: String,
    approved: bool,
    violation: u32,
    #[serde(rename = "intentDigest")]
    intent_digest: String,
}

#[derive(Serialize)]
struct ApiOutput {
    approved: bool,
    violation: u32,
    #[serde(rename = "policyHash")]
    policy_hash: String,
    #[serde(rename = "intentDigest")]
    intent_digest: String,
    #[serde(rename = "journalDigest")]
    journal_digest: String,
    #[serde(rename = "contractJournalDigest")]
    contract_journal_digest: String,
    #[serde(rename = "receiptJournalDigest")]
    receipt_journal_digest: String,
    #[serde(rename = "claimDigest")]
    claim_digest: String,
    #[serde(rename = "imageId")]
    image_id: String,
    #[serde(rename = "sealHex")]
    seal_hex: String,
    #[serde(rename = "receiptJournalHex")]
    receipt_journal_hex: String,
    #[serde(rename = "receiptVerified")]
    receipt_verified: bool,
    mode: &'static str,
}

fn main() -> Result<()> {
    let mut stdin = String::new();
    io::stdin().read_to_string(&mut stdin)?;
    let input: ProverInput = serde_json::from_str(&stdin).context("invalid prover input JSON")?;

    let env = ExecutorEnv::builder()
        .write(&input)
        .context("failed to write prover input")?
        .build()
        .context("failed to build executor env")?;
    let receipt = default_prover()
        .prove_with_opts(env, PAYGUARD_RISC0_GUEST_ELF, &ProverOpts::groth16())
        .context("failed to prove PayGuard policy method")?
        .receipt;
    receipt
        .verify(PAYGUARD_RISC0_GUEST_ID)
        .context("RISC Zero receipt verification failed")?;
    let journal_bytes = receipt.journal.bytes.clone();
    if journal_bytes.len() != 32 {
        anyhow::bail!("PayGuard guest journal must be the 32-byte contract journal digest");
    }
    let seal = encode_seal(&receipt).context("failed to encode Groth16 seal")?;
    let contract_journal_digest = hex::encode(&journal_bytes);
    let receipt_journal_digest = hex::encode(Sha256::digest(&journal_bytes));
    let claim_digest = hex::encode(receipt.claim().unwrap().digest());
    let out = ApiOutput {
        approved: input.execution_context.approved,
        violation: input.execution_context.violation,
        policy_hash: clean_hex(&input.execution_context.policy_hash),
        intent_digest: clean_hex(&input.execution_context.intent_digest),
        journal_digest: receipt_journal_digest.clone(),
        contract_journal_digest,
        receipt_journal_digest,
        claim_digest,
        image_id: hex::encode(bytemuck_words(PAYGUARD_RISC0_GUEST_ID)),
        seal_hex: hex::encode(seal),
        receipt_journal_hex: hex::encode(journal_bytes),
        receipt_verified: true,
        mode: "risc0-groth16-local",
    };
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}

fn clean_hex(value: &str) -> String {
    value.strip_prefix("0x").unwrap_or(value).to_ascii_lowercase()
}

fn bytemuck_words(words: [u32; 8]) -> [u8; 32] {
    let mut out = [0_u8; 32];
    for (index, word) in words.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}
