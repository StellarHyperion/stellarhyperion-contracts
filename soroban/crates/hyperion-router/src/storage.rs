use hyperion_core::{FlowWindow, HyperionError, RouteKind};
use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::types::{
    ClaimProvenance, Config, MigrationStatus, PendingClaim, QueuedAction, RouteConfig, TokenConfig,
    TransferRecord, LEGACY_SCHEMA_VERSION,
};

/// Ledgers of headroom below which the router tops a key's lifetime back up.
///
/// Soroban storage archives if nobody touches it, which is a difference from EVM storage that
/// bites long-lived bookkeeping in particular. Flow-limit counters and pending-claim records
/// are exactly the entries that sit untouched for weeks and then matter enormously, so every
/// read path bumps them and there is a permissionless keeper entrypoint for the rest.
pub const BUMP_THRESHOLD: u32 = 17_280; // about a day
pub const BUMP_TO: u32 = 518_400; // about thirty days

pub const REPLAY_BUMP_THRESHOLD: u32 = 518_400;
pub const REPLAY_BUMP_TO: u32 = 3_110_400; // about 180 days, clamped to the network maximum

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Config,
    LiabilityTracking,
    OutNonce,
    /// Contract the router hands outbound funds to for a given rail.
    Adapter(RouteKind),
    /// The only address allowed to call `bridge_in` for a given rail.
    RailReceiver(RouteKind),
    RouteEnabled(RouteKind),
    RouteConfig(RouteKind),
    Token(Address),
    /// Per-route ceiling, overriding the token-wide one when present.
    RouteFlowLimit(Address, RouteKind),
    Flow(Address, RouteKind),
    /// Per-destination ceiling within a token and route.
    DestinationFlowLimit(Address, RouteKind, soroban_sdk::String),
    DestinationFlow(Address, RouteKind, soroban_sdk::String),
    Transfer(u64),
    /// Replay guard. Presence means this message has already been acted on.
    ///
    /// Keyed on the rail's own message identifier at its full width rather than on a sequence
    /// number we made up. CCTP v2 numbers its messages with thirty two bytes and Axelar with a
    /// string, and squeezing either of those into a u64 means two different messages can land on
    /// the same key. That collision would not let anyone mint twice, because the rail's own
    /// verifier refuses the second one first, but it would permanently refuse a delivery whose
    /// funds have already been burned on the far side, which is its own kind of loss.
    Processed(RouteKind, BytesN<32>),
    Claim(u64),
    ClaimSeq,
    Queued(u64),
    QueueSeq,
    /// Explicit storage schema version for upgrades and migrations (#46).
    SchemaVersion,
    /// Action lifecycle audit metadata (#44).
    ResolvedAction(u64),
    MigrationState,
    // Versioned payout diagnostics use a separate persistent sidecar.
    ClaimFailure(u64),
    ClaimProvenance(u64),
    ClaimLiability(Address),
    ClaimSettledAt(u64),
    ClaimArchiveWord(u64),
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

pub fn liability_tracking(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::LiabilityTracking)
        .unwrap_or(false)
}

pub fn set_liability_tracking(env: &Env) {
    env.storage()
        .instance()
        .set(&DataKey::LiabilityTracking, &true);
}

pub fn claim_liability(env: &Env, token: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::ClaimLiability(token.clone()))
        .unwrap_or(0)
}

pub fn increase_claim_liability(
    env: &Env,
    token: &Address,
    amount: i128,
) -> Result<(), HyperionError> {
    let current = claim_liability(env, token);
    let next = current
        .checked_add(amount)
        .ok_or(HyperionError::InvalidAmount)?;
    env.storage()
        .instance()
        .set(&DataKey::ClaimLiability(token.clone()), &next);
    Ok(())
}

pub fn decrease_claim_liability(
    env: &Env,
    token: &Address,
    amount: i128,
) -> Result<(), HyperionError> {
    let current = claim_liability(env, token);
    let next = current
        .checked_sub(amount)
        .filter(|next| *next >= 0)
        .ok_or(HyperionError::InvalidAmount)?;
    env.storage()
        .instance()
        .set(&DataKey::ClaimLiability(token.clone()), &next);
    Ok(())
}

// The three monotonic sequences retain their distinct keys and checked increment behavior.
#[inline(never)]
fn next_counter(env: &Env, key: &DataKey) -> u64 {
    let next = read_counter(env, key) + 1;
    env.storage().instance().set(key, &next);
    next
}

#[inline(never)]
fn read_counter(env: &Env, key: &DataKey) -> u64 {
    env.storage().instance().get(key).unwrap_or(0u64)
}

pub fn next_out_nonce(env: &Env) -> u64 {
    next_counter(env, &DataKey::OutNonce)
}

pub fn out_nonce(env: &Env) -> u64 {
    read_counter(env, &DataKey::OutNonce)
}

pub fn adapter(env: &Env, route: RouteKind) -> Result<Address, HyperionError> {
    env.storage()
        .instance()
        .get(&DataKey::Adapter(route))
        .ok_or(HyperionError::AdapterNotSet)
}

pub fn set_adapter(env: &Env, route: RouteKind, addr: &Address) {
    env.storage().instance().set(&DataKey::Adapter(route), addr);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn rail_receiver(env: &Env, route: RouteKind) -> Result<Address, HyperionError> {
    env.storage()
        .instance()
        .get(&DataKey::RailReceiver(route))
        .ok_or(HyperionError::AdapterNotSet)
}

pub fn set_rail_receiver(env: &Env, route: RouteKind, addr: &Address) {
    env.storage()
        .instance()
        .set(&DataKey::RailReceiver(route), addr);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

/// Routes are off until somebody turns them on. A rail that has an adapter deployed but has
/// not been reviewed for a given deployment should not be reachable by accident.
pub fn route_enabled(env: &Env, route: RouteKind) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::RouteEnabled(route))
        .unwrap_or(false)
}

pub fn set_route_enabled(env: &Env, route: RouteKind, enabled: bool) {
    env.storage()
        .instance()
        .set(&DataKey::RouteEnabled(route), &enabled);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn route_config(env: &Env, route: RouteKind) -> Option<RouteConfig> {
    let key = DataKey::RouteConfig(route);
    let cfg = env.storage().persistent().get(&key);
    if cfg.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    cfg
}

pub fn set_route_config(env: &Env, route: RouteKind, cfg: &RouteConfig) {
    let key = DataKey::RouteConfig(route);
    env.storage().persistent().set(&key, cfg);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn token_config(env: &Env, token: &Address) -> Result<TokenConfig, HyperionError> {
    let key = DataKey::Token(token.clone());
    let cfg: TokenConfig = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(HyperionError::TokenNotRegistered)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    Ok(cfg)
}

pub fn token_config_opt(env: &Env, token: &Address) -> Option<TokenConfig> {
    env.storage()
        .persistent()
        .get(&DataKey::Token(token.clone()))
}

pub fn set_token_config(env: &Env, token: &Address, cfg: &TokenConfig) {
    let key = DataKey::Token(token.clone());
    env.storage().persistent().set(&key, cfg);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn route_flow_limit(env: &Env, token: &Address, route: RouteKind) -> Option<i128> {
    let key = DataKey::RouteFlowLimit(token.clone(), route);
    let limit = env.storage().persistent().get(&key);
    if limit.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    limit
}

pub fn set_route_flow_limit(env: &Env, token: &Address, route: RouteKind, limit: i128) {
    let key = DataKey::RouteFlowLimit(token.clone(), route);
    env.storage().persistent().set(&key, &limit);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

/// The ceiling that actually applies to a token on a route: the per-route override when one is
/// configured, otherwise the token-wide limit.
pub fn effective_flow_limit(
    env: &Env,
    token: &Address,
    route: RouteKind,
) -> Result<i128, HyperionError> {
    match route_flow_limit(env, token, route) {
        Some(limit) => Ok(limit),
        None => Ok(token_config(env, token)?.flow_limit),
    }
}

pub fn flow_window(env: &Env, token: &Address, route: RouteKind) -> FlowWindow {
    let key = DataKey::Flow(token.clone(), route);
    let window = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(FlowWindow::empty);
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    window
}

pub fn set_flow_window(env: &Env, token: &Address, route: RouteKind, window: &FlowWindow) {
    let key = DataKey::Flow(token.clone(), route);
    env.storage().persistent().set(&key, window);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn destination_flow_limit(
    env: &Env,
    token: &Address,
    route: RouteKind,
    chain: &soroban_sdk::String,
) -> Option<i128> {
    let key = DataKey::DestinationFlowLimit(token.clone(), route, chain.clone());
    let limit = env.storage().persistent().get(&key);
    if limit.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    limit
}

pub fn set_destination_flow_limit(
    env: &Env,
    token: &Address,
    route: RouteKind,
    chain: &soroban_sdk::String,
    limit: i128,
) {
    let key = DataKey::DestinationFlowLimit(token.clone(), route, chain.clone());
    env.storage().persistent().set(&key, &limit);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn effective_destination_flow_limit(
    env: &Env,
    token: &Address,
    route: RouteKind,
    chain: &soroban_sdk::String,
) -> Result<i128, HyperionError> {
    let route_limit = effective_flow_limit(env, token, route)?;
    match destination_flow_limit(env, token, route, chain) {
        Some(dest_limit) => {
            // A destination limit cannot bypass existing token-route limits
            Ok(route_limit.min(dest_limit))
        }
        None => Ok(route_limit),
    }
}

pub fn destination_flow_window(
    env: &Env,
    token: &Address,
    route: RouteKind,
    chain: &soroban_sdk::String,
) -> FlowWindow {
    let key = DataKey::DestinationFlow(token.clone(), route, chain.clone());
    let window = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(FlowWindow::empty);
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    window
}

pub fn set_destination_flow_window(
    env: &Env,
    token: &Address,
    route: RouteKind,
    chain: &soroban_sdk::String,
    window: &FlowWindow,
) {
    let key = DataKey::DestinationFlow(token.clone(), route, chain.clone());
    env.storage().persistent().set(&key, window);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn transfer(env: &Env, nonce: u64) -> Option<TransferRecord> {
    let key = DataKey::Transfer(nonce);
    let record = env.storage().persistent().get(&key);
    if record.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    record
}

pub fn set_transfer(env: &Env, record: &TransferRecord) {
    let key = DataKey::Transfer(record.nonce);
    env.storage().persistent().set(&key, record);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

/// Whether a given inbound message has already been acted on.
///
/// Persistent rather than temporary on purpose. A temporary entry that archives is a replay
/// window, and a replay window on a bridge is a mint-twice bug.
pub fn is_processed(env: &Env, route: RouteKind, message_id: &BytesN<32>) -> bool {
    touch_replay(env, route, message_id)
}

pub fn mark_processed(env: &Env, route: RouteKind, message_id: &BytesN<32>) {
    let key = DataKey::Processed(route, message_id.clone());
    env.storage().persistent().set(&key, &true);
    extend_replay_ttl(env, &key);
    crate::events::replay_recorded(env, route, message_id);
}

fn extend_replay_ttl(env: &Env, key: &DataKey) {
    let target = REPLAY_BUMP_TO.min(env.storage().max_ttl());
    env.storage()
        .persistent()
        .extend_ttl(key, REPLAY_BUMP_THRESHOLD.min(target), target);
}

pub fn touch_replay(env: &Env, route: RouteKind, message_id: &BytesN<32>) -> bool {
    let key = DataKey::Processed(route, message_id.clone());
    if env.storage().persistent().has(&key) {
        extend_replay_ttl(env, &key);
        true
    } else {
        false
    }
}

pub fn assert_liability_migration_not_running(env: &Env) -> Result<(), HyperionError> {
    if !liability_tracking(env)
        && migration_state(env)
            .map(|s| s.migration_pending)
            .unwrap_or(false)
    {
        return Err(HyperionError::TimelockNotReady);
    }
    Ok(())
}

pub fn next_claim_id(env: &Env) -> u64 {
    next_counter(env, &DataKey::ClaimSeq)
}

pub fn claim_count(env: &Env) -> u64 {
    read_counter(env, &DataKey::ClaimSeq)
}

pub fn claim(env: &Env, id: u64) -> Option<PendingClaim> {
    let key = DataKey::Claim(id);
    let record = env.storage().persistent().get(&key);
    if record.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        touch_persistent_key(env, &DataKey::ClaimSettledAt(id));
        let failure_key = DataKey::ClaimFailure(id);
        if env.storage().persistent().has(&failure_key) {
            env.storage()
                .persistent()
                .extend_ttl(&failure_key, BUMP_THRESHOLD, BUMP_TO);
        }
        let provenance_key = DataKey::ClaimProvenance(id);
        if env.storage().persistent().has(&provenance_key) {
            env.storage()
                .persistent()
                .extend_ttl(&provenance_key, BUMP_THRESHOLD, BUMP_TO);
        }
    }
    record
}

pub fn set_claim(env: &Env, record: &PendingClaim) {
    let key = DataKey::Claim(record.id);
    env.storage().persistent().set(&key, record);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn claim_failure(env: &Env, id: u64) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::ClaimFailure(id))
        .unwrap_or(0)
}

pub fn set_claim_failure(env: &Env, id: u64, reason: u32) {
    let key = DataKey::ClaimFailure(id);
    env.storage().persistent().set(&key, &reason);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn migration_state(env: &Env) -> Option<MigrationStatus> {
    env.storage().instance().get(&DataKey::MigrationState)
}

pub fn set_migration_state(env: &Env, status: &MigrationStatus) {
    env.storage()
        .instance()
        .set(&DataKey::MigrationState, status);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn claim_provenance(env: &Env, id: u64) -> Option<ClaimProvenance> {
    env.storage()
        .persistent()
        .get(&DataKey::ClaimProvenance(id))
}

pub fn set_claim_provenance(env: &Env, id: u64, value: &ClaimProvenance) {
    let key = DataKey::ClaimProvenance(id);
    env.storage().persistent().set(&key, value);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn next_queue_id(env: &Env) -> u64 {
    next_counter(env, &DataKey::QueueSeq)
}

pub fn queue_count(env: &Env) -> u64 {
    read_counter(env, &DataKey::QueueSeq)
}

pub fn queued(env: &Env, id: u64) -> Option<QueuedAction> {
    read_queued_action(env, &DataKey::Queued(id))
}

pub fn set_queued(env: &Env, action: &QueuedAction) {
    store_queued_action(env, &DataKey::Queued(action.id), action);
}

pub fn clear_queued(env: &Env, id: u64) {
    env.storage().persistent().remove(&DataKey::Queued(id));
}

/// Bump a flow counter's archival date without reading it into a decision.
///
/// The keeper calls this for lanes that have gone quiet. A counter that archives quietly
/// resets a limit back to full, which is the sort of bug that only shows up on the one day it
/// matters, so it is worth a scheduled job and a few stroops of fee.
pub fn touch_flow(env: &Env, token: &Address, route: RouteKind) {
    let key = DataKey::Flow(token.clone(), route);
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
}

/// Extend TTL on a persistent key if it currently exists in active storage.
pub fn touch_persistent_key(env: &Env, key: &DataKey) -> bool {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
        true
    } else {
        false
    }
}

pub fn schema_version(env: &Env) -> u32 {
    if let Some(v) = env.storage().instance().get(&DataKey::SchemaVersion) {
        v
    } else if is_initialized(env) {
        LEGACY_SCHEMA_VERSION
    } else {
        0
    }
}

pub fn set_schema_version(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&DataKey::SchemaVersion, &version);
}

pub fn retain_action(env: &Env, action: &QueuedAction) {
    store_queued_action(env, &DataKey::ResolvedAction(action.id), action);
}

pub fn action_payload(env: &Env, id: u64) -> Option<QueuedAction> {
    let key = if env.storage().persistent().has(&DataKey::Queued(id)) {
        DataKey::Queued(id)
    } else {
        DataKey::ResolvedAction(id)
    };
    touch_persistent_key(env, &key);
    read_queued_action(env, &key)
}

// Queued and resolved actions share the identical payload and retention policy.
#[inline(never)]
fn store_queued_action(env: &Env, key: &DataKey, action: &QueuedAction) {
    env.storage().persistent().set(key, action);
    env.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
}

#[inline(never)]
fn read_queued_action(env: &Env, key: &DataKey) -> Option<QueuedAction> {
    env.storage().persistent().get(key)
}

pub const MIN_CLAIM_RETENTION_SECONDS: u64 = 2_592_000;

pub fn claim_settled_at(env: &Env, id: u64) -> Option<u64> {
    env.storage().persistent().get(&DataKey::ClaimSettledAt(id))
}

pub fn set_claim_settled_at(env: &Env, id: u64, at: u64) {
    let key = DataKey::ClaimSettledAt(id);
    env.storage().persistent().set(&key, &at);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

// Compact, nonexpiring instance bitmap: 128 permanent nonpayment markers per word.
// The archive event contains the exact historical values; bitmap never permits repayment.
pub fn is_claim_archived(env: &Env, id: u64) -> bool {
    let word: u128 = env
        .storage()
        .instance()
        .get(&DataKey::ClaimArchiveWord(id / 128))
        .unwrap_or(0);
    word & (1u128 << (id % 128)) != 0
}

pub fn archive_claim(env: &Env, id: u64) {
    let key = DataKey::ClaimArchiveWord(id / 128);
    let word: u128 = env.storage().instance().get(&key).unwrap_or(0);
    env.storage()
        .instance()
        .set(&key, &(word | (1u128 << (id % 128))));
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
    env.storage().persistent().remove(&DataKey::Claim(id));
    env.storage()
        .persistent()
        .remove(&DataKey::ClaimFailure(id));
    env.storage()
        .persistent()
        .remove(&DataKey::ClaimSettledAt(id));
}
