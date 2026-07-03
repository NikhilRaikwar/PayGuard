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
    #[serde(rename = "executionContext")]
    execution_context: ExecutionContext,
}

#[derive(Deserialize)]
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

#[derive(Serialize, Deserialize)]
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
    assert_eq!(decision.policy_hash, clean_hex(&input.execution_context.policy_hash));
    assert_eq!(decision.intent_digest, clean_hex(&input.execution_context.intent_digest));
    assert_eq!(decision.approved, input.execution_context.approved);
    assert_eq!(decision.violation, input.execution_context.violation);
    let contract_digest = contract_journal_digest(&input.execution_context);
    assert_eq!(decision.journal_digest, hex_lower(&contract_digest));
    env::commit_slice(&contract_digest);
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
    assert_eq!(parse_i128(&input.execution_context.amount), amount as i128);
    assert_eq!(parse_i128(&input.execution_context.spent_before), spent as i128);
    assert_eq!(parse_i128(&input.execution_context.spent_after), spent_after as i128);
    assert_eq!(parse_i128(&input.execution_context.vault_before), vault as i128);
    assert_eq!(parse_i128(&input.execution_context.vault_after), vault_after as i128);
    Journal {
        approved,
        violation,
        policy_hash,
        intent_digest,
        journal_digest: hex_lower(&contract_journal_digest(&input.execution_context)),
    }
}

fn contract_journal_digest(ctx: &ExecutionContext) -> [u8; 32] {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&hex_32(&ctx.network_hash));
    bytes.extend_from_slice(&hex_32(&ctx.policy_id));
    bytes.extend_from_slice(&hex_32(&ctx.policy_hash));
    bytes.extend_from_slice(&parse_i128(&ctx.amount).to_be_bytes());
    bytes.extend_from_slice(&parse_u64(&ctx.day_index).to_be_bytes());
    bytes.extend_from_slice(&parse_i128(&ctx.spent_before).to_be_bytes());
    bytes.extend_from_slice(&parse_i128(&ctx.spent_after).to_be_bytes());
    bytes.extend_from_slice(&parse_i128(&ctx.vault_before).to_be_bytes());
    bytes.extend_from_slice(&parse_i128(&ctx.vault_after).to_be_bytes());
    bytes.extend_from_slice(&parse_u64(&ctx.nonce).to_be_bytes());
    bytes.extend_from_slice(&parse_u64(&ctx.proof_timestamp).to_be_bytes());
    bytes.push(ctx.approved as u8);
    bytes.extend_from_slice(&ctx.violation.to_be_bytes());
    bytes.extend_from_slice(&hex_32(&ctx.intent_digest));
    Sha256::digest(&bytes).into()
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

fn parse_i128(value: &str) -> i128 {
    value.parse::<i128>().unwrap_or(0)
}

fn parse_u64(value: &str) -> u64 {
    value.parse::<u64>().unwrap_or(0)
}

fn clean_hex(value: &str) -> String {
    value.strip_prefix("0x").unwrap_or(value).to_ascii_lowercase()
}

fn hex_32(value: &str) -> [u8; 32] {
    let clean = clean_hex(value);
    assert_eq!(clean.len(), 64);
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
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
