use anyhow::{Context, Result};
use payguard_risc0_methods::{PAYGUARD_RISC0_GUEST_ELF, PAYGUARD_RISC0_GUEST_ID};
use risc0_zkvm::{default_prover, ExecutorEnv};
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
}

#[derive(Deserialize, Serialize)]
struct GuestJournal {
    approved: bool,
    violation: u32,
    #[serde(rename = "policyHash")]
    policy_hash: String,
    #[serde(rename = "intentDigest")]
    intent_digest: String,
    #[serde(rename = "journalDigest")]
    journal_digest: String,
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
        .prove(env, PAYGUARD_RISC0_GUEST_ELF)
        .context("failed to prove PayGuard policy method")?
        .receipt;
    receipt
        .verify(PAYGUARD_RISC0_GUEST_ID)
        .context("RISC Zero receipt verification failed")?;
    let journal: GuestJournal = receipt.journal.decode().context("failed to decode receipt journal")?;
    let journal_bytes = receipt.journal.bytes.clone();
    let seal_hex = hex::encode(Sha256::digest(&journal_bytes));
    let out = ApiOutput {
        approved: journal.approved,
        violation: journal.violation,
        policy_hash: journal.policy_hash,
        intent_digest: journal.intent_digest,
        journal_digest: journal.journal_digest,
        image_id: hex::encode(bytemuck_words(PAYGUARD_RISC0_GUEST_ID)),
        seal_hex,
        receipt_journal_hex: hex::encode(journal_bytes),
        receipt_verified: true,
        mode: "risc0-local-receipt",
    };
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}

fn bytemuck_words(words: [u32; 8]) -> [u8; 32] {
    let mut out = [0_u8; 32];
    for (index, word) in words.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}
