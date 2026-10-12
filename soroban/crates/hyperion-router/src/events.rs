use hyperion_core::RouteKind;
use soroban_sdk::{contractevent, Address, Env};

use crate::types::{
    AdminAction, Config, InboundRecord, PendingClaim, QueuedAction, TokenConfig, TransferRecord,
};

/// Every state change the router makes is announced here.
///
/// The indexer reads these to answer "where is my transfer", and the monitoring job watches the
/// privileged ones so a parameter change outside a known maintenance window gets somebody's
/// attention. Each event carries a `hyperion` topic first so a subscriber can filter server side
/// instead of pulling the whole ledger and sorting it out afterwards, and each is part of the
/// contract spec so the TypeScript side reads these as real types rather than loose maps.

#[contractevent(topics = ["hyperion", "out"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeOut {
    #[topic]
    pub route: RouteKind,
    #[topic]
    pub sender: Address,
    pub transfer: TransferRecord,
}

#[contractevent(topics = ["hyperion", "in"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeIn {
    #[topic]
    pub route: RouteKind,
    #[topic]
    pub recipient: Address,
    pub inbound: InboundRecord,
}

/// An inbound delivery the recipient could not accept yet. Almost always a missing trustline.
#[contractevent(topics = ["hyperion", "park"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimParked {
    #[topic]
    pub recipient: Address,
    #[topic]
    pub token: Address,
    pub claim: PendingClaim,
}

#[contractevent(topics = ["hyperion", "settled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimSettled {
    #[topic]
    pub recipient: Address,
    pub token: Address,
    pub claim_id: u64,
    pub amount: i128,
    pub settled_by: Address,
}

#[contractevent(topics = ["hyperion", "claim_ttl"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimTtlExtended {
    #[topic]
    pub claim_id: u64,
    pub threshold: u32,
    pub extend_to: u32,
}

#[contractevent(topics = ["hyperion", "pause"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseSet {
    #[topic]
    pub by: Address,
    pub paused: bool,
}

#[contractevent(topics = ["hyperion", "queued"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionQueued {
    pub id: u64,
    pub action: AdminAction,
    pub eta: u64,
    pub expires_at: u64,
}

#[contractevent(topics = ["hyperion", "executed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionExecuted {
    pub id: u64,
    pub action: AdminAction,
    pub queued_at: u64,
}

#[contractevent(topics = ["hyperion", "cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionCancelled {
    #[topic]
    pub by: Address,
    pub id: u64,
}

#[contractevent(topics = ["hyperion", "config"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigChanged {
    pub config: Config,
}

#[contractevent(topics = ["hyperion", "token"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenRegistered {
    #[topic]
    pub token: Address,
    pub config: TokenConfig,
}

#[contractevent(topics = ["hyperion", "route"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteConfigured {
    #[topic]
    pub route: RouteKind,
    pub enabled: bool,
}

/// Emitted when a limit is tightened without waiting out the timelock, which is allowed
/// precisely because it only ever narrows what the bridge will do.
#[contractevent(topics = ["hyperion", "flow"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FlowLimitLowered {
    #[topic]
    pub token: Address,
    #[topic]
    pub by: Address,
    pub limit: i128,
}

pub fn bridge_out(env: &Env, record: &TransferRecord) {
    BridgeOut {
        route: record.route,
        sender: record.sender.clone(),
        transfer: record.clone(),
    }
    .publish(env);
}

pub fn bridge_in(env: &Env, record: &InboundRecord) {
    BridgeIn {
        route: record.route,
        recipient: record.recipient.clone(),
        inbound: record.clone(),
    }
    .publish(env);
}

pub fn claim_parked(env: &Env, claim: &PendingClaim) {
    ClaimParked {
        recipient: claim.recipient.clone(),
        token: claim.token.clone(),
        claim: claim.clone(),
    }
    .publish(env);
}

pub fn claim_settled(env: &Env, claim: &PendingClaim, settled_by: &Address) {
    ClaimSettled {
        recipient: claim.recipient.clone(),
        token: claim.token.clone(),
        claim_id: claim.id,
        amount: claim.amount,
        settled_by: settled_by.clone(),
    }
    .publish(env);
}

pub fn claim_ttl_extended(env: &Env, claim_id: u64, threshold: u32, extend_to: u32) {
    ClaimTtlExtended {
        claim_id,
        threshold,
        extend_to,
    }
    .publish(env);
}

pub fn paused(env: &Env, by: &Address, state: bool) {
    PauseSet {
        by: by.clone(),
        paused: state,
    }
    .publish(env);
}

pub fn action_queued(env: &Env, action: &QueuedAction) {
    ActionQueued {
        id: action.id,
        action: action.action.clone(),
        eta: action.eta,
        expires_at: action.expires_at,
    }
    .publish(env);
}

pub fn action_executed(env: &Env, action: &QueuedAction) {
    ActionExecuted {
        id: action.id,
        action: action.action.clone(),
        queued_at: action.queued_at,
    }
    .publish(env);
}

pub fn action_cancelled(env: &Env, id: u64, by: &Address) {
    ActionCancelled { by: by.clone(), id }.publish(env);
}

pub fn config_changed(env: &Env, cfg: &Config) {
    ConfigChanged {
        config: cfg.clone(),
    }
    .publish(env);
}

pub fn token_registered(env: &Env, token: &Address, cfg: &TokenConfig) {
    TokenRegistered {
        token: token.clone(),
        config: cfg.clone(),
    }
    .publish(env);
}

pub fn route_configured(env: &Env, route: RouteKind, enabled: bool) {
    RouteConfigured { route, enabled }.publish(env);
}

pub fn flow_limit_lowered(env: &Env, token: &Address, limit: i128, by: &Address) {
    FlowLimitLowered {
        token: token.clone(),
        by: by.clone(),
        limit,
    }
    .publish(env);
}
