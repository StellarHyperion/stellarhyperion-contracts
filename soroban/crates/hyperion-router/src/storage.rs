use hyperion_core::{FlowWindow, HyperionError, RouteKind};
use soroban_sdk::{
    contracttype, unwrap::UnwrapOptimized, Address, BytesN, Env, IntoVal, TryFromVal, Val,
};

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

#[cfg_attr(not(target_family = "wasm"), contracttype)]
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

pub fn set_config(env: &Env, cfg: &Config) -> Val {
    let encoded: Val = cfg.into_val(env);
    write_instance_bumped(env, &DataKey::Config.into_val(env), &encoded);
    encoded
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

// Encode the same liability key once and share storage access across both checked operations.
#[inline(never)]
fn adjust_claim_liability(
    env: &Env,
    token: &Address,
    amount: i128,
    decrease: bool,
) -> Result<(), HyperionError> {
    let key: Val = DataKey::ClaimLiability(token.clone()).into_val(env);
    let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
    let next = if decrease {
        current.checked_sub(amount).filter(|next| *next >= 0)
    } else {
        current.checked_add(amount)
    }
    .ok_or(HyperionError::InvalidAmount)?;
    env.storage().instance().set(&key, &next);
    Ok(())
}

pub fn increase_claim_liability(
    env: &Env,
    token: &Address,
    amount: i128,
) -> Result<(), HyperionError> {
    adjust_claim_liability(env, token, amount, false)
}

pub fn decrease_claim_liability(
    env: &Env,
    token: &Address,
    amount: i128,
) -> Result<(), HyperionError> {
    adjust_claim_liability(env, token, amount, true)
}

// The three monotonic sequences retain their distinct keys and checked increment behavior.
#[inline(never)]
fn next_counter(env: &Env, key: &Val) -> u64 {
    let next = read_counter(env, key) + 1;
    env.storage().instance().set(key, &next);
    next
}

#[inline(never)]
fn read_counter(env: &Env, key: &Val) -> u64 {
    env.storage().instance().get(key).unwrap_or(0u64)
}

pub fn next_out_nonce(env: &Env) -> u64 {
    next_counter(env, &DataKey::OutNonce.into_val(env))
}

pub fn out_nonce(env: &Env) -> u64 {
    read_counter(env, &DataKey::OutNonce.into_val(env))
}

pub fn adapter(env: &Env, route: RouteKind) -> Result<Address, HyperionError> {
    env.storage()
        .instance()
        .get(&DataKey::Adapter(route))
        .ok_or(HyperionError::AdapterNotSet)
}

pub fn set_adapter(env: &Env, route: RouteKind, addr: &Address) {
    write_instance_bumped(
        env,
        &DataKey::Adapter(route).into_val(env),
        &addr.into_val(env),
    );
}

pub fn rail_receiver(env: &Env, route: RouteKind) -> Result<Address, HyperionError> {
    env.storage()
        .instance()
        .get(&DataKey::RailReceiver(route))
        .ok_or(HyperionError::AdapterNotSet)
}

pub fn set_rail_receiver(env: &Env, route: RouteKind, addr: &Address) {
    write_instance_bumped(
        env,
        &DataKey::RailReceiver(route).into_val(env),
        &addr.into_val(env),
    );
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
    write_instance_bumped(
        env,
        &DataKey::RouteEnabled(route).into_val(env),
        &enabled.into_val(env),
    );
}

pub fn route_config(env: &Env, route: RouteKind) -> Option<RouteConfig> {
    let key: Val = DataKey::RouteConfig(route).into_val(env);
    let cfg = read_persistent(env, &key);
    if cfg.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    cfg
}

pub fn set_route_config(env: &Env, route: RouteKind, cfg: &RouteConfig) {
    let key: Val = DataKey::RouteConfig(route).into_val(env);
    write_persistent(env, &key, cfg);
}

pub fn token_config(env: &Env, token: &Address) -> Result<TokenConfig, HyperionError> {
    let key: Val = DataKey::Token(token.clone()).into_val(env);
    let cfg: TokenConfig = read_persistent(env, &key).ok_or(HyperionError::TokenNotRegistered)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    Ok(cfg)
}

pub fn token_config_opt(env: &Env, token: &Address) -> Option<TokenConfig> {
    read_persistent(env, &DataKey::Token(token.clone()).into_val(env))
}

pub fn set_token_config(env: &Env, token: &Address, cfg: &TokenConfig) -> Val {
    let key: Val = DataKey::Token(token.clone()).into_val(env);
    let encoded: Val = cfg.into_val(env);
    write_persistent(env, &key, &encoded);
    encoded
}

pub fn route_flow_limit(env: &Env, token: &Address, route: RouteKind) -> Option<i128> {
    let key: Val = DataKey::RouteFlowLimit(token.clone(), route).into_val(env);
    let limit = read_persistent(env, &key);
    if limit.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    limit
}

pub fn set_route_flow_limit(env: &Env, token: &Address, route: RouteKind, limit: i128) {
    let key: Val = DataKey::RouteFlowLimit(token.clone(), route).into_val(env);
    write_persistent(env, &key, &limit);
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
    let key: Val = DataKey::Flow(token.clone(), route).into_val(env);
    let window = read_persistent(env, &key).unwrap_or_else(FlowWindow::empty);
    touch_persistent_val(env, &key);
    window
}

pub fn set_flow_window(env: &Env, token: &Address, route: RouteKind, window: &FlowWindow) {
    let key: Val = DataKey::Flow(token.clone(), route).into_val(env);
    write_persistent(env, &key, window);
}

pub fn destination_flow_limit(
    env: &Env,
    token: &Address,
    route: RouteKind,
    chain: &soroban_sdk::String,
) -> Option<i128> {
    let key: Val = DataKey::DestinationFlowLimit(token.clone(), route, chain.clone()).into_val(env);
    let limit = read_persistent(env, &key);
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
    let key: Val = DataKey::DestinationFlowLimit(token.clone(), route, chain.clone()).into_val(env);
    write_persistent(env, &key, &limit);
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
    let key: Val = DataKey::DestinationFlow(token.clone(), route, chain.clone()).into_val(env);
    let window = read_persistent(env, &key).unwrap_or_else(FlowWindow::empty);
    touch_persistent_val(env, &key);
    window
}

pub fn set_destination_flow_window(
    env: &Env,
    token: &Address,
    route: RouteKind,
    chain: &soroban_sdk::String,
    window: &FlowWindow,
) {
    let key: Val = DataKey::DestinationFlow(token.clone(), route, chain.clone()).into_val(env);
    write_persistent(env, &key, window);
}

pub fn transfer(env: &Env, nonce: u64) -> Option<TransferRecord> {
    let key: Val = DataKey::Transfer(nonce).into_val(env);
    let record = read_persistent(env, &key);
    if record.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
    record
}

pub fn set_transfer(env: &Env, record: &TransferRecord) -> Val {
    let key: Val = DataKey::Transfer(record.nonce).into_val(env);
    let encoded: Val = record.into_val(env);
    write_persistent(env, &key, &encoded);
    encoded
}

/// Whether a given inbound message has already been acted on.
///
/// Persistent rather than temporary on purpose. A temporary entry that archives is a replay
/// window, and a replay window on a bridge is a mint-twice bug.
pub fn is_processed(env: &Env, route: RouteKind, message_id: &BytesN<32>) -> bool {
    touch_replay(env, route, message_id)
}

pub fn mark_processed(env: &Env, route: RouteKind, message_id: &BytesN<32>) {
    let key: Val = DataKey::Processed(route, message_id.clone()).into_val(env);
    env.storage().persistent().set(&key, &true);
    extend_replay_ttl(env, &key);
    crate::events::replay_recorded(env, route, message_id);
}

fn extend_replay_ttl(env: &Env, key: &Val) {
    let target = REPLAY_BUMP_TO.min(env.storage().max_ttl());
    env.storage()
        .persistent()
        .extend_ttl(key, REPLAY_BUMP_THRESHOLD.min(target), target);
}

pub fn touch_replay(env: &Env, route: RouteKind, message_id: &BytesN<32>) -> bool {
    let key: Val = DataKey::Processed(route, message_id.clone()).into_val(env);
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
    next_counter(env, &DataKey::ClaimSeq.into_val(env))
}

pub fn claim_count(env: &Env) -> u64 {
    read_counter(env, &DataKey::ClaimSeq.into_val(env))
}

pub fn claim(env: &Env, id: u64) -> Option<PendingClaim> {
    let key: Val = DataKey::Claim(id).into_val(env);
    let record = read_persistent(env, &key);
    if record.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        touch_persistent_key(env, &DataKey::ClaimSettledAt(id));
        let failure_key: Val = DataKey::ClaimFailure(id).into_val(env);
        touch_persistent_val(env, &failure_key);
        let provenance_key: Val = DataKey::ClaimProvenance(id).into_val(env);
        touch_persistent_val(env, &provenance_key);
    }
    record
}

pub fn set_claim(env: &Env, record: &PendingClaim) -> Val {
    let key: Val = DataKey::Claim(record.id).into_val(env);
    let encoded: Val = record.into_val(env);
    write_persistent(env, &key, &encoded);
    encoded
}

pub fn claim_failure(env: &Env, id: u64) -> u32 {
    read_persistent(env, &DataKey::ClaimFailure(id).into_val(env)).unwrap_or(0)
}

pub fn set_claim_failure(env: &Env, id: u64, reason: u32) {
    let key: Val = DataKey::ClaimFailure(id).into_val(env);
    write_persistent(env, &key, &reason);
}

pub fn migration_state(env: &Env) -> Option<MigrationStatus> {
    env.storage().instance().get(&DataKey::MigrationState)
}

pub fn set_migration_state(env: &Env, status: &MigrationStatus) {
    write_instance_bumped(
        env,
        &DataKey::MigrationState.into_val(env),
        &status.into_val(env),
    );
}

pub fn claim_provenance(env: &Env, id: u64) -> Option<ClaimProvenance> {
    read_persistent(env, &DataKey::ClaimProvenance(id).into_val(env))
}

pub fn set_claim_provenance(env: &Env, id: u64, value: &ClaimProvenance) {
    let key: Val = DataKey::ClaimProvenance(id).into_val(env);
    write_persistent(env, &key, value);
}

pub fn next_queue_id(env: &Env) -> u64 {
    next_counter(env, &DataKey::QueueSeq.into_val(env))
}

pub fn queue_count(env: &Env) -> u64 {
    read_counter(env, &DataKey::QueueSeq.into_val(env))
}

pub fn queued(env: &Env, id: u64) -> Option<QueuedAction> {
    read_queued_action(env, &DataKey::Queued(id).into_val(env))
}

pub fn set_queued(env: &Env, action: &QueuedAction) {
    store_queued_action(env, &DataKey::Queued(action.id).into_val(env), action);
}

#[inline(never)]
pub fn resolve_queued(env: &Env, id: u64, action: &QueuedAction) {
    retain_action(env, action);
    clear_queued(env, id);
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
    let key: Val = DataKey::Flow(token.clone(), route).into_val(env);
    touch_persistent_val(env, &key);
}

/// Extend TTL on a persistent key if it currently exists in active storage.
pub fn touch_persistent_key(env: &Env, key: &DataKey) -> bool {
    touch_persistent_val(env, &key.into_val(env))
}

#[inline(never)]
fn touch_persistent_val(env: &Env, key: &Val) -> bool {
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
    store_queued_action(
        env,
        &DataKey::ResolvedAction(action.id).into_val(env),
        action,
    );
}

pub fn action_payload(env: &Env, id: u64) -> Option<QueuedAction> {
    let queued: Val = DataKey::Queued(id).into_val(env);
    let key = if env.storage().persistent().has(&queued) {
        queued
    } else {
        DataKey::ResolvedAction(id).into_val(env)
    };
    touch_persistent_val(env, &key);
    read_queued_action(env, &key)
}

// Queued and resolved actions share the identical payload and retention policy.
#[inline(never)]
fn store_queued_action(env: &Env, key: &Val, action: &QueuedAction) {
    write_persistent(env, key, action);
}

#[inline(never)]
fn read_queued_action(env: &Env, key: &Val) -> Option<QueuedAction> {
    read_persistent(env, key)
}

pub const MIN_CLAIM_RETENTION_SECONDS: u64 = 2_592_000;

pub fn claim_settled_at(env: &Env, id: u64) -> Option<u64> {
    read_persistent(env, &DataKey::ClaimSettledAt(id).into_val(env))
}

pub fn set_claim_settled_at(env: &Env, id: u64, at: u64) {
    let key: Val = DataKey::ClaimSettledAt(id).into_val(env);
    write_persistent(env, &key, &at);
}

// Compact, nonexpiring instance bitmap: 128 permanent nonpayment markers per word.
// The archive event contains the exact historical values; bitmap never permits repayment.
#[inline(always)]
fn claim_archive_mask(id: u64) -> u128 {
    let half = u128::from(1u64 << (id % 64));
    if id % 128 < 64 {
        half
    } else {
        half << 64
    }
}

pub fn is_claim_archived(env: &Env, id: u64) -> bool {
    let word: u128 = env
        .storage()
        .instance()
        .get(&DataKey::ClaimArchiveWord(id / 128))
        .unwrap_or(0);
    word & (claim_archive_mask(id)) != 0
}

pub fn archive_claim(env: &Env, id: u64) {
    let key: Val = DataKey::ClaimArchiveWord(id / 128).into_val(env);
    let word: u128 = env.storage().instance().get(&key).unwrap_or(0);
    write_instance_bumped(env, &key, &(word | claim_archive_mask(id)).into_val(env));
    env.storage().persistent().remove(&DataKey::Claim(id));
    env.storage()
        .persistent()
        .remove(&DataKey::ClaimFailure(id));
    env.storage()
        .persistent()
        .remove(&DataKey::ClaimSettledAt(id));
}

#[inline(never)]
fn write_instance_bumped(env: &Env, key: &Val, value: &Val) {
    env.storage().instance().set(key, value);
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

// Outline raw host I/O while keeping the original SDK typed codecs, absence
// handling, and persistent retention policy at their existing call sites.
#[inline(never)]
fn read_persistent_val(env: &Env, key: &Val) -> Option<Val> {
    env.storage().persistent().get(key)
}

fn read_persistent<T>(env: &Env, key: &Val) -> Option<T>
where
    T: TryFromVal<Env, Val>,
    T::Error: core::fmt::Debug,
{
    read_persistent_val(env, key).map(|value| T::try_from_val(env, &value).unwrap_optimized())
}

fn write_persistent<T>(env: &Env, key: &Val, value: &T)
where
    T: IntoVal<Env, Val>,
{
    write_persistent_val(env, key, &value.into_val(env));
}

#[inline(never)]
fn write_persistent_val(env: &Env, key: &Val, value: &Val) {
    env.storage().persistent().set(key, value);
    env.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
}

#[cfg(target_family = "wasm")]
mod key_spec {
    use super::*;
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
}

#[cfg(target_family = "wasm")]
impl soroban_sdk::SpecShakingMarker for DataKey {
    fn spec_shaking_marker() {
        <key_spec::DataKey as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    }
}

#[cfg(target_family = "wasm")]
impl soroban_sdk::TryFromVal<Env, DataKey> for Val {
    type Error = soroban_sdk::ConversionError;
    fn try_from_val(env: &Env, key: &DataKey) -> Result<Self, Self::Error> {
        crate::key_codec::encode(env, key)
    }
}

#[cfg(target_family = "wasm")]
impl soroban_sdk::TryFromVal<Env, &DataKey> for Val {
    type Error = soroban_sdk::ConversionError;
    fn try_from_val(env: &Env, key: &&DataKey) -> Result<Self, Self::Error> {
        crate::key_codec::encode(env, key)
    }
}
