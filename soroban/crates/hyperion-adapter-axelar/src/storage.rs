use hyperion_core::HyperionError;
use soroban_sdk::{contracttype, Address, BytesN, Env, String};

use crate::types::{ChainLink, Config, DestinationCapability};

pub const BUMP_THRESHOLD: u32 = 17_280;
pub const BUMP_TO: u32 = 518_400;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    /// Hyperion's chain name to the whole lane, for the outbound leg.
    Link(String),
    /// Axelar's chain name back to Hyperion's, for the inbound leg. Two keys rather than one
    /// scan, because a contract cannot iterate storage and both directions are on a hot path.
    Source(String),
    /// Local asset to the Axelar token id that carries it.
    TokenId(Address),
    /// And back again.
    ///
    /// This doubles as the inbound allowlist. ITS will happily deliver any token id it knows
    /// about; an unmapped one is refused here, which is the correct behaviour on the day Axelar
    /// registers a token nobody on this side has looked at yet.
    Token(BytesN<32>),
    /// Admitted destination capability for `(chain, token_id)`.
    Capability(String, BytesN<32>),
    /// Whether outbound dispatches require an explicit capability record on every lane.
    StrictCapabilities,
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

pub fn link(env: &Env, chain: &String) -> Option<ChainLink> {
    let key = DataKey::Link(chain.clone());
    let found: Option<ChainLink> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

pub fn chain_of(env: &Env, axelar_chain: &String) -> Option<String> {
    let key = DataKey::Source(axelar_chain.clone());
    let found: Option<String> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

pub fn set_link(env: &Env, link: &ChainLink) {
    env.storage()
        .persistent()
        .set(&DataKey::Link(link.chain.clone()), link);
    env.storage()
        .persistent()
        .set(&DataKey::Source(link.axelar_chain.clone()), &link.chain);
}

pub fn token_id(env: &Env, token: &Address) -> Option<BytesN<32>> {
    let key = DataKey::TokenId(token.clone());
    let found: Option<BytesN<32>> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

pub fn token_of(env: &Env, token_id: &BytesN<32>) -> Option<Address> {
    let key = DataKey::Token(token_id.clone());
    let found: Option<Address> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

pub fn set_token(env: &Env, token: &Address, token_id: &BytesN<32>) {
    env.storage()
        .persistent()
        .set(&DataKey::TokenId(token.clone()), token_id);
    env.storage()
        .persistent()
        .set(&DataKey::Token(token_id.clone()), token);
}

/// Top a lane's lifetime back up without changing it.
///
/// Soroban archives storage nobody reads, and a lane that stays quiet for a month is exactly the
/// lane somebody will try to use on the day it has expired. The read paths above bump as they go,
/// so this only matters for a lane with no traffic at all, which is why it is permissionless.
pub fn touch_link(env: &Env, chain: &String) {
    let key = DataKey::Link(chain.clone());
    let Some(found) = env.storage().persistent().get::<_, ChainLink>(&key) else {
        return;
    };
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    let source = DataKey::Source(found.axelar_chain);
    if env.storage().persistent().has(&source) {
        env.storage()
            .persistent()
            .extend_ttl(&source, BUMP_THRESHOLD, BUMP_TO);
    }
}

pub fn capability(
    env: &Env,
    chain: &String,
    token_id: &BytesN<32>,
) -> Option<DestinationCapability> {
    let key = DataKey::Capability(chain.clone(), token_id.clone());
    let found: Option<DestinationCapability> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

pub fn set_capability(env: &Env, cap: &DestinationCapability) {
    let key = DataKey::Capability(cap.chain.clone(), cap.token_id.clone());
    env.storage().persistent().set(&key, cap);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn strict_capabilities(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::StrictCapabilities)
        .unwrap_or(false)
}

pub fn set_strict_capabilities(env: &Env, required: bool) {
    env.storage()
        .instance()
        .set(&DataKey::StrictCapabilities, &required);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}
