//! Storage keys and the reads and writes that go with them.

use hyperion_core::HyperionError;
use soroban_sdk::{contracttype, Address, BytesN, Env, String};

use crate::types::{AssetLink, ChainLane, Config, OutboundRecord, PendingValidator, ValidatorEpoch};

/// Extend when there is less than a day of life left, and extend to thirty days.
pub const BUMP_THRESHOLD: u32 = 17_280;
pub const BUMP_TO: u32 = 518_400;
pub const VALIDATOR_ROTATION_DELAY: u64 = 3_600;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    /// Hyperion's chain name to Allbridge's chain id.
    Lane(String),
    /// Allbridge's chain id back to Hyperion's chain name.
    Chain(u32),
    /// A local asset plus a lane to the token it becomes at the far end.
    Asset(Address, u32),
    /// The validator public key that signs incoming messages from Allbridge Core.
    Validator,
    /// Inbound message digests that have already been delivered to prevent replays.
    Processed(BytesN<32>),
    ValidatorEpoch,
    PendingValidator,
    EmergencyDisabled,
    Outbound(u64),
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

pub fn lane(env: &Env, chain: &String) -> Option<ChainLane> {
    let key = DataKey::Lane(chain.clone());
    let found: Option<ChainLane> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

/// The Hyperion name for an Allbridge chain id, which is what a status record wants to carry.
pub fn chain_of(env: &Env, allbridge_chain_id: u32) -> Option<String> {
    env.storage()
        .persistent()
        .get(&DataKey::Chain(allbridge_chain_id))
}

/// Write a lane only when it is new or byte for byte the same.
///
/// Re-running a deploy script is harmless; repointing a live lane is not. A lane change has to be
/// an explicit migration decision, not the side effect of somebody re-validating an old mapping.
pub fn set_lane(env: &Env, lane: &ChainLane) -> Result<(), HyperionError> {
    if let Some(current) = self::lane(env, &lane.chain) {
        if current != *lane {
            return Err(HyperionError::AlreadyConfigured);
        }
        return Ok(());
    }
    if let Some(other) = chain_of(env, lane.allbridge_chain_id) {
        if other != lane.chain {
            return Err(HyperionError::AlreadyConfigured);
        }
    }

    let by_name = DataKey::Lane(lane.chain.clone());
    let by_id = DataKey::Chain(lane.allbridge_chain_id);
    env.storage().persistent().set(&by_name, lane);
    env.storage().persistent().set(&by_id, &lane.chain);
    env.storage()
        .persistent()
        .extend_ttl(&by_name, BUMP_THRESHOLD, BUMP_TO);
    env.storage()
        .persistent()
        .extend_ttl(&by_id, BUMP_THRESHOLD, BUMP_TO);
    Ok(())
}

pub fn asset(env: &Env, token: &Address, allbridge_chain_id: u32) -> Option<AssetLink> {
    let key = DataKey::Asset(token.clone(), allbridge_chain_id);
    let found: Option<AssetLink> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

/// Write an asset link only when it is new or byte for byte the same.
///
/// An identical re-link is how an operator revalidates an unchanged mapping. A different receive
/// token on the same lane is a migration: it would change where every later transfer pays out,
/// so it is refused here rather than written as though nothing happened.
pub fn set_asset(env: &Env, link: &AssetLink) -> Result<(), HyperionError> {
    if let Some(current) = self::asset(env, &link.token, link.allbridge_chain_id) {
        if current != *link {
            return Err(HyperionError::AlreadyConfigured);
        }
        return Ok(());
    }

    let key = DataKey::Asset(link.token.clone(), link.allbridge_chain_id);
    env.storage().persistent().set(&key, link);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    Ok(())
}

/// Push a lane's expiry out without changing it. No-op when there is no such lane.
pub fn touch_lane(env: &Env, chain: &String) -> u32 {
    let key = DataKey::Lane(chain.clone());
    let Some(lane) = env.storage().persistent().get::<_, ChainLane>(&key) else {
        return 0;
    };
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    let mut touched = 1u32;
    let chain_key = DataKey::Chain(lane.allbridge_chain_id);
    if env.storage().persistent().has(&chain_key) {
        env.storage()
            .persistent()
            .extend_ttl(&chain_key, BUMP_THRESHOLD, BUMP_TO);
        touched += 1;
    }
    touched
}

pub fn touch_chain_id(env: &Env, allbridge_chain_id: u32) -> bool {
    let key = DataKey::Chain(allbridge_chain_id);
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        true
    } else {
        false
    }
}

pub fn touch_asset(env: &Env, token: &Address, allbridge_chain_id: u32) -> bool {
    let key = DataKey::Asset(token.clone(), allbridge_chain_id);
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        true
    } else {
        false
    }
}

pub fn touch_processed(env: &Env, message_id: &BytesN<32>) -> bool {
    let key = DataKey::Processed(message_id.clone());
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        true
    } else {
        false
    }
}

pub fn validator(env: &Env) -> Option<BytesN<32>> {
    env.storage().instance().get(&DataKey::Validator)
}

pub fn set_validator(env: &Env, val: &BytesN<32>) {
    env.storage().instance().set(&DataKey::Validator, val);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn validator_epoch(env: &Env) -> Option<ValidatorEpoch> {
    env.storage().instance().get(&DataKey::ValidatorEpoch)
}

pub fn set_validator_epoch(env: &Env, value: &ValidatorEpoch) {
    env.storage().instance().set(&DataKey::ValidatorEpoch, value);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn pending_validator(env: &Env) -> Option<PendingValidator> {
    env.storage().instance().get(&DataKey::PendingValidator)
}

pub fn set_pending_validator(env: &Env, value: &PendingValidator) {
    env.storage().instance().set(&DataKey::PendingValidator, value);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn clear_pending_validator(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingValidator);
}

pub fn emergency_disabled(env: &Env) -> bool {
    env.storage().instance().get(&DataKey::EmergencyDisabled).unwrap_or(false)
}

pub fn set_emergency_disabled(env: &Env, value: bool) {
    env.storage().instance().set(&DataKey::EmergencyDisabled, &value);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn outbound(env: &Env, nonce: u64) -> Option<OutboundRecord> {
    env.storage().persistent().get(&DataKey::Outbound(nonce))
}

pub fn set_outbound(env: &Env, record: &OutboundRecord) {
    let key = DataKey::Outbound(record.nonce);
    env.storage().persistent().set(&key, record);
    env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn is_processed(env: &Env, message_id: &BytesN<32>) -> bool {
    let key = DataKey::Processed(message_id.clone());
    let found = env.storage().persistent().has(&key);
    if found {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    found
}

pub fn mark_processed(env: &Env, message_id: &BytesN<32>) {
    let key = DataKey::Processed(message_id.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}
