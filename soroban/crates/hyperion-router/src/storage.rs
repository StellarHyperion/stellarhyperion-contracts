use hyperion_core::{FlowWindow, HyperionError, RouteKind};
use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::types::{Config, PendingClaim, QueuedAction, RouteConfig, TokenConfig, TransferRecord};

/// Ledgers of headroom below which the router tops a key's lifetime back up.
///
/// Soroban storage archives if nobody touches it, which is a difference from EVM storage that
/// bites long-lived bookkeeping in particular. Flow-limit counters and pending-claim records
/// are exactly the entries that sit untouched for weeks and then matter enormously, so every
/// read path bumps them and there is a permissionless keeper entrypoint for the rest.
pub const BUMP_THRESHOLD: u32 = 17_280; // about a day
pub const BUMP_TO: u32 = 518_400; // about thirty days

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
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

pub fn next_out_nonce(env: &Env) -> u64 {
    let current: u64 = env
        .storage()
        .instance()
        .get(&DataKey::OutNonce)
        .unwrap_or(0u64);
    let next = current + 1;
    env.storage().instance().set(&DataKey::OutNonce, &next);
    next
}

pub fn out_nonce(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::OutNonce)
        .unwrap_or(0u64)
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
    env.storage()
        .persistent()
        .has(&DataKey::Processed(route, message_id.clone()))
}

pub fn mark_processed(env: &Env, route: RouteKind, message_id: &BytesN<32>) {
    let key = DataKey::Processed(route, message_id.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

pub fn next_claim_id(env: &Env) -> u64 {
    let current: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ClaimSeq)
        .unwrap_or(0u64);
    let next = current + 1;
    env.storage().instance().set(&DataKey::ClaimSeq, &next);
    next
}

pub fn claim_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::ClaimSeq)
        .unwrap_or(0u64)
}

pub fn claim(env: &Env, id: u64) -> Option<PendingClaim> {
    let key = DataKey::Claim(id);
    let record = env.storage().persistent().get(&key);
    if record.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
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

pub fn next_queue_id(env: &Env) -> u64 {
    let current: u64 = env
        .storage()
        .instance()
        .get(&DataKey::QueueSeq)
        .unwrap_or(0u64);
    let next = current + 1;
    env.storage().instance().set(&DataKey::QueueSeq, &next);
    next
}

pub fn queue_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::QueueSeq)
        .unwrap_or(0u64)
}

pub fn queued(env: &Env, id: u64) -> Option<QueuedAction> {
    env.storage().persistent().get(&DataKey::Queued(id))
}

pub fn set_queued(env: &Env, action: &QueuedAction) {
    let key = DataKey::Queued(action.id);
    env.storage().persistent().set(&key, action);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
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
