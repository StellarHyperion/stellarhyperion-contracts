use hyperion_core::HyperionError;
use soroban_sdk::{contracttype, Address, BytesN, Env, String};

use crate::types::FinalityPolicy;
use crate::types::{
    Config, HistoricalMessengerWindow, HistoricalTokenMessengerWindow, MessengerRotation,
    PeerMessengerRotation,
};

pub const BUMP_THRESHOLD: u32 = 17_280;
pub const BUMP_TO: u32 = 518_400;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    /// Chain name to Circle domain, for the outbound leg.
    Domain(String),
    /// Circle domain back to chain name, for the inbound leg. Two keys rather than one scan,
    /// because a contract cannot iterate storage and both directions are on a hot path.
    Chain(u32),
    /// Per destination, who is allowed to broadcast the message over there.
    Caller(u32),
    /// Per source domain, the explicitly configured remote CCTP peer that may emit messages.
    RemoteSender(u32),
    /// `(source domain, the remote token that was burned)` to the local asset Circle mints.
    ///
    /// This doubles as the inbound allowlist. An unmapped pair is refused, which is the correct
    /// behaviour on the day Circle adds a token pair nobody here has looked at yet.
    Asset(u32, BytesN<32>),
    /// Emergency disable flag for a domain.
    Disabled(u32),
    /// Active remote peer messenger for a domain.
    PeerMessenger(u32),
    /// Pending remote peer rotation for a domain.
    PendingPeerRotation(u32),
    /// Historical remote peer messenger overlap window for a domain.
    OldPeerMessenger(u32),
    /// Pending local TokenMessenger rotation.
    PendingMessengerRotation,
    /// Historical local TokenMessenger overlap window.
    OldTokenMessenger,
    /// Finality selection for the outbound lane; missing entries default to finalized.
    Finality(u32),
}

pub fn config(env: &Env) -> Result<Config, HyperionError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(HyperionError::NotInitialized)
}

pub fn set_config(env: &Env, cfg: &Config) {
    env.storage().instance().set(&DataKey::Config, cfg);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Config)
}

pub fn domain_of(env: &Env, chain: &String) -> Option<u32> {
    let key = DataKey::Domain(chain.clone());
    let found: Option<u32> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

pub fn chain_of(env: &Env, domain: u32) -> Option<String> {
    let key = DataKey::Chain(domain);
    let found: Option<String> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

pub fn destination_caller(env: &Env, domain: u32) -> BytesN<32> {
    env.storage()
        .persistent()
        .get(&DataKey::Caller(domain))
        .unwrap_or_else(|| BytesN::from_array(env, &[0u8; 32]))
}

pub fn finality_policy(env: &Env, domain: u32) -> FinalityPolicy {
    let key = DataKey::Finality(domain);
    if let Some(policy) = env.storage().persistent().get(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        policy
    } else {
        FinalityPolicy::Finalized
    }
}

pub fn set_finality_policy(env: &Env, domain: u32, policy: &FinalityPolicy) {
    let key = DataKey::Finality(domain);
    env.storage().persistent().set(&key, policy);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn set_link(env: &Env, chain: &String, domain: u32, caller: &BytesN<32>) {
    let domain_key = DataKey::Domain(chain.clone());
    let chain_key = DataKey::Chain(domain);
    let caller_key = DataKey::Caller(domain);
    env.storage().persistent().set(&domain_key, &domain);
    env.storage().persistent().set(&chain_key, chain);
    env.storage().persistent().set(&caller_key, caller);
    env.storage()
        .persistent()
        .extend_ttl(&domain_key, BUMP_THRESHOLD, BUMP_TO);
    env.storage()
        .persistent()
        .extend_ttl(&chain_key, BUMP_THRESHOLD, BUMP_TO);
    env.storage()
        .persistent()
        .extend_ttl(&caller_key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn remote_sender(env: &Env, domain: u32) -> Option<BytesN<32>> {
    let key = DataKey::RemoteSender(domain);
    let found: Option<BytesN<32>> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

pub fn set_remote_sender(env: &Env, domain: u32, remote_sender: &BytesN<32>) {
    let key = DataKey::RemoteSender(domain);
    env.storage().persistent().set(&key, remote_sender);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn asset(env: &Env, domain: u32, burn_token: &BytesN<32>) -> Option<Address> {
    let key = DataKey::Asset(domain, burn_token.clone());
    let found: Option<Address> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

pub fn set_asset(env: &Env, domain: u32, burn_token: &BytesN<32>, local: &Address) {
    let key = DataKey::Asset(domain, burn_token.clone());
    env.storage().persistent().set(&key, local);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

// ------------------------------------------------------------------------------------------
// Emergency disable controls
// ------------------------------------------------------------------------------------------

pub fn is_domain_disabled(env: &Env, domain: u32) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Disabled(domain))
        .unwrap_or(false)
}

pub fn set_domain_disabled(env: &Env, domain: u32, disabled: bool) {
    if disabled {
        env.storage()
            .instance()
            .set(&DataKey::Disabled(domain), &true);
    } else {
        env.storage().instance().remove(&DataKey::Disabled(domain));
    }
}

// ------------------------------------------------------------------------------------------
// Remote peer messenger
// ------------------------------------------------------------------------------------------

pub fn peer_messenger(env: &Env, domain: u32) -> Option<BytesN<32>> {
    env.storage()
        .instance()
        .get(&DataKey::PeerMessenger(domain))
}

pub fn set_peer_messenger(env: &Env, domain: u32, messenger: &BytesN<32>) {
    env.storage()
        .instance()
        .set(&DataKey::PeerMessenger(domain), messenger);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn pending_peer_rotation(env: &Env, domain: u32) -> Option<PeerMessengerRotation> {
    env.storage()
        .instance()
        .get(&DataKey::PendingPeerRotation(domain))
}

pub fn set_pending_peer_rotation(env: &Env, domain: u32, rotation: &PeerMessengerRotation) {
    env.storage()
        .instance()
        .set(&DataKey::PendingPeerRotation(domain), rotation);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn clear_pending_peer_rotation(env: &Env, domain: u32) {
    env.storage()
        .instance()
        .remove(&DataKey::PendingPeerRotation(domain));
}

pub fn old_peer_messenger(env: &Env, domain: u32) -> Option<HistoricalMessengerWindow> {
    env.storage()
        .instance()
        .get(&DataKey::OldPeerMessenger(domain))
}

pub fn set_old_peer_messenger(
    env: &Env,
    domain: u32,
    old_messenger: &BytesN<32>,
    valid_until: u64,
) {
    env.storage().instance().set(
        &DataKey::OldPeerMessenger(domain),
        &HistoricalMessengerWindow {
            old_messenger: old_messenger.clone(),
            valid_until,
        },
    );
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

// ------------------------------------------------------------------------------------------
// Local TokenMessenger rotation
// ------------------------------------------------------------------------------------------

pub fn pending_messenger_rotation(env: &Env) -> Option<MessengerRotation> {
    env.storage()
        .instance()
        .get(&DataKey::PendingMessengerRotation)
}

pub fn set_pending_messenger_rotation(env: &Env, rotation: &MessengerRotation) {
    env.storage()
        .instance()
        .set(&DataKey::PendingMessengerRotation, rotation);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn clear_pending_messenger_rotation(env: &Env) {
    env.storage()
        .instance()
        .remove(&DataKey::PendingMessengerRotation);
}

pub fn old_token_messenger(env: &Env) -> Option<HistoricalTokenMessengerWindow> {
    env.storage().instance().get(&DataKey::OldTokenMessenger)
}

pub fn set_old_token_messenger(env: &Env, addr: &Address, valid_until: u64) {
    env.storage().instance().set(
        &DataKey::OldTokenMessenger,
        &HistoricalTokenMessengerWindow {
            old_messenger: addr.clone(),
            valid_until,
        },
    );
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

// ------------------------------------------------------------------------------------------
// Storage maintenance & keep-alive
// ------------------------------------------------------------------------------------------

fn touch_key(env: &Env, key: &DataKey) -> bool {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
        true
    } else {
        false
    }
}

pub fn touch_link(env: &Env, domain: u32) -> u32 {
    let mut touched = 0u32;
    let chain_key = DataKey::Chain(domain);
    if let Some(chain) = env.storage().persistent().get::<_, String>(&chain_key) {
        env.storage()
            .persistent()
            .extend_ttl(&chain_key, BUMP_THRESHOLD, BUMP_TO);
        touched += 1;
        if touch_key(env, &DataKey::Domain(chain)) {
            touched += 1;
        }
    }
    if touch_key(env, &DataKey::Caller(domain)) {
        touched += 1;
    }
    if touch_key(env, &DataKey::Finality(domain)) {
        touched += 1;
    }
    touched
}

pub fn touch_link_by_chain(env: &Env, chain: &String) -> u32 {
    let domain_key = DataKey::Domain(chain.clone());
    let Some(domain) = env.storage().persistent().get::<_, u32>(&domain_key) else {
        return 0;
    };
    env.storage()
        .persistent()
        .extend_ttl(&domain_key, BUMP_THRESHOLD, BUMP_TO);
    let mut touched = 1u32;
    if touch_key(env, &DataKey::Chain(domain)) {
        touched += 1;
    }
    if touch_key(env, &DataKey::Caller(domain)) {
        touched += 1;
    }
    if touch_key(env, &DataKey::Finality(domain)) {
        touched += 1;
    }
    touched
}

pub fn touch_asset(env: &Env, domain: u32, burn_token: &BytesN<32>) -> bool {
    touch_key(env, &DataKey::Asset(domain, burn_token.clone()))
}
