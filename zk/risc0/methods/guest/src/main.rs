use risc0_zkvm::guest::env;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
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

#[derive(Deserialize)]
struct Intent {
    recipient: String,
    amount: String,
    asset: String,
    category: String,
    memo: String,
    #[allow(dead_code)]
    rationale: String,
    #[serde(rename = "riskLevel")]
    #[allow(dead_code)]
    risk_level: String,
}

#[derive(Deserialize)]
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

#[derive(Serialize)]
struct Journal {
    approved: bool,
    violation: u32,
    #[serde(rename = "policyHash")]
    policy_hash: String,
    #[serde(rename = "intentDigest")]
    intent_digest: String,
    #[serde(rename = "journalDigest")]
    journal_digest: String,
}

fn main() {
    let input: ProverInput = env::read();
    let decision = decide(&input);
    env::commit(&decision);
}

fn decide(input: &ProverInput) -> Journal {
    let policy_hash = sha256_hex(&canonical_policy(&input.policy));
    let intent_digest = sha256_hex(&canonical_intent(&input.intent));
    let amount = parse_usdc(&input.intent.amount);
    let max = parse_usdc(&input.policy.max_per_payment);
    let daily = parse_usdc(&input.policy.daily_limit);
    let spent = parse_usdc(&input.spent_today);
    let vault = parse_usdc(&input.vault_balance);

    let violation = if amount > max {
        1
    } else if spent.saturating_add(amount) > daily {
        2
    } else if !input.policy.allowlist.iter().any(|x| x == &input.intent.recipient) {
        3
    } else if input.proof_date.as_str() > input.policy.expiry.as_str() {
        4
    } else if amount > vault {
        5
    } else {
        0
    };
    let approved = violation == 0;
    let spent_after = if approved { spent + amount } else { spent };
    let vault_after = if approved { vault - amount } else { vault };
    let journal_preimage = format!(
        "{{\"policyHash\":\"{}\",\"intentDigest\":\"{}\",\"amount\":\"{}\",\"spentBefore\":\"{}\",\"spentAfter\":\"{}\",\"vaultBefore\":\"{}\",\"vaultAfter\":\"{}\",\"approved\":{},\"violation\":{}}}",
        policy_hash, intent_digest, amount, spent, spent_after, vault, vault_after, approved, violation
    );
    Journal {
        approved,
        violation,
        policy_hash,
        intent_digest,
        journal_digest: sha256_hex(&journal_preimage),
    }
}

fn canonical_policy(policy: &Policy) -> String {
    let mut allowlist = policy.allowlist.clone();
    allowlist.sort();
    allowlist.dedup();
    format!(
        "{{\"name\":\"{}\",\"maxPerPayment\":\"{}\",\"dailyLimit\":\"{}\",\"allowlist\":[{}],\"expiry\":\"{}\",\"salt\":\"{}\"}}",
        policy.name.trim(),
        parse_usdc(&policy.max_per_payment),
        parse_usdc(&policy.daily_limit),
        allowlist.iter().map(|x| format!("\"{}\"", x.trim())).collect::<Vec<_>>().join(","),
        policy.expiry,
        policy.salt
    )
}

fn canonical_intent(intent: &Intent) -> String {
    format!(
        "{{\"recipient\":\"{}\",\"amount\":\"{}\",\"asset\":\"{}\",\"category\":\"{}\",\"memo\":\"{}\"}}",
        intent.recipient.trim(),
        parse_usdc(&intent.amount),
        intent.asset,
        intent.category,
        intent.memo.trim()
    )
}

fn parse_usdc(value: &str) -> u128 {
    let cleaned = value.trim().replace(['$', ',', ' '], "");
    let mut parts = cleaned.split('.');
    let whole = parts.next().unwrap_or("0").parse::<u128>().unwrap_or(0);
    let frac = parts.next().unwrap_or("");
    let frac = format!("{:0<7}", &frac[..frac.len().min(7)]);
    whole * 10_000_000 + frac.parse::<u128>().unwrap_or(0)
}

fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex_lower(&digest)
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
