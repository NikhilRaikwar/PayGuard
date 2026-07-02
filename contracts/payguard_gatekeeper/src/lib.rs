#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env, IntoVal, Symbol, Val, Vec,
};

const DAY_SECONDS: u64 = 86_400;
const TTL_THRESHOLD: u32 = 17_280;
const TTL_EXTEND_TO: u32 = 535_680;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyState {
    pub owner: Address,
    pub token: Address,
    pub policy_hash: BytesN<32>,
    pub active: bool,
    pub vault_balance: i128,
    pub spent_day: u64,
    pub spent: i128,
    pub nonce: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyStats {
    pub approved: u64,
    pub denied: u64,
    pub total_paid: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecisionJournal {
    pub network_hash: BytesN<32>,
    pub gatekeeper: Address,
    pub policy_id: BytesN<32>,
    pub policy_hash: BytesN<32>,
    pub token: Address,
    pub executor: Address,
    pub recipient: Address,
    pub amount: i128,
    pub day_index: u64,
    pub spent_before: i128,
    pub spent_after: i128,
    pub vault_before: i128,
    pub vault_after: i128,
    pub nonce: u64,
    pub proof_timestamp: u64,
    pub approved: bool,
    pub violation: u32,
    pub intent_digest: BytesN<32>,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Verifier,
    ImageId,
    NetworkHash,
    Policy(BytesN<32>),
    Executor(BytesN<32>, Address),
    Stats(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PayGuardError {
    PolicyNotFound = 1,
    PolicyInactive = 2,
    UnauthorizedExecutor = 3,
    InvalidAmount = 4,
    InsufficientVault = 5,
    DomainMismatch = 6,
    PolicyMismatch = 7,
    TokenMismatch = 8,
    ExecutorMismatch = 9,
    NonceMismatch = 10,
    DayMismatch = 11,
    StateMismatch = 12,
    InvalidDecision = 13,
    ArithmeticOverflow = 14,
}

#[contract]
pub struct PayGuardGatekeeper;

#[contractimpl]
impl PayGuardGatekeeper {
    pub fn __constructor(
        env: Env,
        verifier: Address,
        image_id: BytesN<32>,
        network_hash: BytesN<32>,
    ) {
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::ImageId, &image_id);
        env.storage().instance().set(&DataKey::NetworkHash, &network_hash);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    pub fn register_policy(
        env: Env,
        owner: Address,
        executor: Address,
        token: Address,
        policy_hash: BytesN<32>,
        salt: BytesN<32>,
    ) -> BytesN<32> {
        owner.require_auth();
        let mut preimage = Bytes::new(&env);
        preimage.append(&policy_hash.clone().into());
        preimage.append(&salt.into());
        let policy_id = env.crypto().sha256(&preimage).to_bytes();
        let state = PolicyState {
            owner: owner.clone(),
            token: token.clone(),
            policy_hash: policy_hash.clone(),
            active: true,
            vault_balance: 0,
            spent_day: env.ledger().timestamp() / DAY_SECONDS,
            spent: 0,
            nonce: 0,
        };
        env.storage().persistent().set(&DataKey::Policy(policy_id.clone()), &state);
        env.storage().persistent().set(&DataKey::Executor(policy_id.clone(), executor.clone()), &true);
        env.storage().persistent().set(
            &DataKey::Stats(policy_id.clone()),
            &PolicyStats { approved: 0, denied: 0, total_paid: 0 },
        );
        extend(&env, &policy_id, &executor);
        env.events().publish((symbol_short!("policy"), policy_id.clone()), (owner, executor, token, policy_hash));
        policy_id
    }

    pub fn set_executor(env: Env, policy_id: BytesN<32>, executor: Address, enabled: bool) -> Result<(), PayGuardError> {
        let state = load_policy(&env, &policy_id)?;
        state.owner.require_auth();
        env.storage().persistent().set(&DataKey::Executor(policy_id.clone(), executor.clone()), &enabled);
        extend(&env, &policy_id, &executor);
        env.events().publish((symbol_short!("executor"), policy_id), (executor, enabled));
        Ok(())
    }

    pub fn fund_policy(env: Env, policy_id: BytesN<32>, from: Address, amount: i128) -> Result<(), PayGuardError> {
        if amount <= 0 { return Err(PayGuardError::InvalidAmount); }
        let mut state = load_policy(&env, &policy_id)?;
        state.owner.require_auth();
        from.require_auth();
        token::Client::new(&env, &state.token).transfer(&from, &env.current_contract_address(), &amount);
        state.vault_balance = state.vault_balance.checked_add(amount).ok_or(PayGuardError::ArithmeticOverflow)?;
        store_policy(&env, &policy_id, &state);
        env.events().publish((symbol_short!("funded"), policy_id), (from, amount, state.vault_balance));
        Ok(())
    }

    pub fn execute_decision(
        env: Env,
        policy_id: BytesN<32>,
        executor: Address,
        seal: Bytes,
        journal: DecisionJournal,
    ) -> Result<(), PayGuardError> {
        executor.require_auth();
        let mut state = load_policy(&env, &policy_id)?;
        if !state.active { return Err(PayGuardError::PolicyInactive); }
        let enabled: bool = env.storage().persistent().get(&DataKey::Executor(policy_id.clone(), executor.clone())).unwrap_or(false);
        if !enabled { return Err(PayGuardError::UnauthorizedExecutor); }
        validate(&env, &policy_id, &executor, &state, &journal)?;

        let digest = journal_digest(&env, &journal);
        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).unwrap();
        let image_id: BytesN<32> = env.storage().instance().get(&DataKey::ImageId).unwrap();
        verify_risc0(&env, verifier, seal, image_id, digest.clone());

        let mut stats: PolicyStats = env.storage().persistent().get(&DataKey::Stats(policy_id.clone())).unwrap();
        state.nonce = state.nonce.checked_add(1).ok_or(PayGuardError::ArithmeticOverflow)?;
        state.spent_day = journal.day_index;
        state.spent = journal.spent_after;
        state.vault_balance = journal.vault_after;
        if journal.approved {
            stats.approved = stats.approved.checked_add(1).ok_or(PayGuardError::ArithmeticOverflow)?;
            stats.total_paid = stats.total_paid.checked_add(journal.amount).ok_or(PayGuardError::ArithmeticOverflow)?;
            token::Client::new(&env, &state.token).transfer(&env.current_contract_address(), &journal.recipient, &journal.amount);
            env.events().publish((symbol_short!("approved"), policy_id.clone()), (journal.recipient, journal.amount, journal.nonce, digest));
        } else {
            stats.denied = stats.denied.checked_add(1).ok_or(PayGuardError::ArithmeticOverflow)?;
            env.events().publish((symbol_short!("denied"), policy_id.clone()), (journal.recipient, journal.amount, journal.violation, digest));
        }
        store_policy(&env, &policy_id, &state);
        env.storage().persistent().set(&DataKey::Stats(policy_id), &stats);
        Ok(())
    }

    pub fn set_policy_active(env: Env, policy_id: BytesN<32>, active: bool) -> Result<(), PayGuardError> {
        let mut state = load_policy(&env, &policy_id)?;
        state.owner.require_auth();
        state.active = active;
        store_policy(&env, &policy_id, &state);
        env.events().publish((symbol_short!("status"), policy_id), active);
        Ok(())
    }

    pub fn withdraw(env: Env, policy_id: BytesN<32>, destination: Address, amount: i128) -> Result<(), PayGuardError> {
        if amount <= 0 { return Err(PayGuardError::InvalidAmount); }
        let mut state = load_policy(&env, &policy_id)?;
        state.owner.require_auth();
        if amount > state.vault_balance { return Err(PayGuardError::InsufficientVault); }
        state.vault_balance = state.vault_balance.checked_sub(amount).ok_or(PayGuardError::ArithmeticOverflow)?;
        store_policy(&env, &policy_id, &state);
        token::Client::new(&env, &state.token).transfer(&env.current_contract_address(), &destination, &amount);
        env.events().publish((symbol_short!("withdraw"), policy_id), (destination, amount, state.vault_balance));
        Ok(())
    }

    pub fn get_policy(env: Env, policy_id: BytesN<32>) -> Result<PolicyState, PayGuardError> {
        load_policy(&env, &policy_id)
    }

    pub fn get_stats(env: Env, policy_id: BytesN<32>) -> Result<PolicyStats, PayGuardError> {
        env.storage().persistent().get(&DataKey::Stats(policy_id)).ok_or(PayGuardError::PolicyNotFound)
    }
}

fn verify_risc0(env: &Env, verifier: Address, seal: Bytes, image_id: BytesN<32>, journal_digest: BytesN<32>) {
    let args: Vec<Val> = (seal, image_id, journal_digest).into_val(env);
    env.invoke_contract::<()>(&verifier, &Symbol::new(env, "verify"), args);
}

fn validate(env: &Env, policy_id: &BytesN<32>, executor: &Address, state: &PolicyState, journal: &DecisionJournal) -> Result<(), PayGuardError> {
    let network_hash: BytesN<32> = env.storage().instance().get(&DataKey::NetworkHash).unwrap();
    if journal.network_hash != network_hash || journal.gatekeeper != env.current_contract_address() { return Err(PayGuardError::DomainMismatch); }
    if &journal.policy_id != policy_id || journal.policy_hash != state.policy_hash { return Err(PayGuardError::PolicyMismatch); }
    if journal.token != state.token { return Err(PayGuardError::TokenMismatch); }
    if &journal.executor != executor { return Err(PayGuardError::ExecutorMismatch); }
    if journal.nonce != state.nonce { return Err(PayGuardError::NonceMismatch); }
    if journal.amount <= 0 { return Err(PayGuardError::InvalidAmount); }
    let current_day = env.ledger().timestamp() / DAY_SECONDS;
    if journal.day_index != current_day { return Err(PayGuardError::DayMismatch); }
    let expected_spent = if state.spent_day == current_day { state.spent } else { 0 };
    if journal.spent_before != expected_spent || journal.vault_before != state.vault_balance { return Err(PayGuardError::StateMismatch); }
    if journal.approved {
        if journal.violation != 0
            || journal.spent_after != expected_spent.checked_add(journal.amount).ok_or(PayGuardError::ArithmeticOverflow)?
            || journal.vault_after != state.vault_balance.checked_sub(journal.amount).ok_or(PayGuardError::InsufficientVault)?
        {
            return Err(PayGuardError::InvalidDecision);
        }
    } else if journal.violation == 0 || journal.spent_after != expected_spent || journal.vault_after != state.vault_balance {
        return Err(PayGuardError::InvalidDecision);
    }
    Ok(())
}

fn journal_digest(env: &Env, journal: &DecisionJournal) -> BytesN<32> {
    let mut bytes = Bytes::new(env);
    bytes.append(&journal.network_hash.clone().into());
    bytes.append(&journal.policy_id.clone().into());
    bytes.append(&journal.policy_hash.clone().into());
    bytes.append(&Bytes::from_array(env, &journal.amount.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &journal.day_index.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &journal.spent_before.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &journal.spent_after.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &journal.vault_before.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &journal.vault_after.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &journal.nonce.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &journal.proof_timestamp.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &[journal.approved as u8]));
    bytes.append(&Bytes::from_array(env, &journal.violation.to_be_bytes()));
    bytes.append(&journal.intent_digest.clone().into());
    env.crypto().sha256(&bytes).to_bytes()
}

fn load_policy(env: &Env, policy_id: &BytesN<32>) -> Result<PolicyState, PayGuardError> {
    env.storage().persistent().get(&DataKey::Policy(policy_id.clone())).ok_or(PayGuardError::PolicyNotFound)
}

fn store_policy(env: &Env, policy_id: &BytesN<32>, state: &PolicyState) {
    let key = DataKey::Policy(policy_id.clone());
    env.storage().persistent().set(&key, state);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    env.storage().persistent().extend_ttl(&DataKey::Stats(policy_id.clone()), TTL_THRESHOLD, TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn extend(env: &Env, policy_id: &BytesN<32>, executor: &Address) {
    env.storage().persistent().extend_ttl(&DataKey::Policy(policy_id.clone()), TTL_THRESHOLD, TTL_EXTEND_TO);
    env.storage().persistent().extend_ttl(&DataKey::Executor(policy_id.clone(), executor.clone()), TTL_THRESHOLD, TTL_EXTEND_TO);
    env.storage().persistent().extend_ttl(&DataKey::Stats(policy_id.clone()), TTL_THRESHOLD, TTL_EXTEND_TO);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}
