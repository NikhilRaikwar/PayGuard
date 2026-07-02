#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env};

const TTL_THRESHOLD: u32 = 17_280;
const TTL_EXTEND_TO: u32 = 535_680;

#[contracttype]
enum DataKey {
    Admin,
    Attester,
}

#[contract]
pub struct PayGuardAttestationVerifier;

#[contractimpl]
impl PayGuardAttestationVerifier {
    pub fn __constructor(env: Env, admin: Address, attester: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Attester, &attester);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    pub fn set_attester(env: Env, attester: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Attester, &attester);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        env.events().publish((symbol_short!("attester"),), attester);
    }

    pub fn verify(env: Env, seal: Bytes, image_id: BytesN<32>, journal_digest: BytesN<32>) {
        let attester: Address = env.storage().instance().get(&DataKey::Attester).unwrap();
        attester.require_auth();
        if seal.is_empty() {
            panic!("missing RISC Zero receipt seal");
        }
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        env.events().publish((symbol_short!("verified"), attester), (image_id, journal_digest));
    }

    pub fn attester(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Attester).unwrap()
    }
}

