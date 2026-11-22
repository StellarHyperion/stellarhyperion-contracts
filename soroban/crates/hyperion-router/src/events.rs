use hyperion_core::RouteKind;
use soroban_sdk::{contractevent, Address, BytesN, Env, EnvBase, IntoVal, Val};

use crate::types::{
    ActionAuditStatus, AdminAction, CancelReason, Config, InboundRecord, MigrationStatus,
    PendingClaim, QueuedAction, TokenConfig, TransferRecord,
};

// Every state change the router makes is announced here.
// Every state change the router makes is announced here.
//
// The indexer reads these to answer "where is my transfer", and the monitoring job watches the
// privileged ones so a parameter change outside a known maintenance window gets somebody's
// attention. Each event carries a `hyperion` topic first so a subscriber can filter server side
// instead of pulling the whole ledger and sorting it out afterwards, and each is part of the
// contract spec so the TypeScript side reads these as real types rather than loose maps.

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

// An inbound delivery the recipient could not accept yet. Almost always a missing trustline.
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

// V1 reasons: 1 refused unchanged payout, 2 custody short, 3 token/accounting unavailable.
#[contractevent(topics = ["hyperion", "claim_failure_v1"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimPayoutFailureV1 {
    #[topic]
    pub claim_id: u64,
    pub reason: u32,
    pub outstanding_amount: i128,
    pub recipient: Address,
}

#[contractevent(topics = ["hyperion", "claim_archived"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimArchived {
    #[topic]
    pub recipient: Address,
    #[topic]
    pub token: Address,
    pub claim_id: u64,
    pub amount: i128,
    pub source_nonce: u64,
    pub claim: PendingClaim,
    pub provenance: Option<crate::types::ClaimProvenance>,
    pub settled_at: u64,
    pub archived_at: u64,
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

// Stable action lifecycle audit event emitted on queue, execution, and cancellation (#44).
#[contractevent(topics = ["hyperion", "audit"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionAuditRecorded {
    #[topic]
    pub id: u64,
    pub version: u32,
    pub status: ActionAuditStatus,
    // Actor for this lifecycle transition; legacy queuing authors are never invented.
    pub actor: Address,
    pub reason: CancelReason,
    pub note: soroban_sdk::String,
}

// Emitted when bounded storage migration advances or completes (#46).
#[contractevent(topics = ["hyperion", "migrated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StorageMigrated {
    pub version: u32,
    #[topic]
    pub by: Address,
    pub status: MigrationStatus,
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

// Emitted when a limit is tightened without waiting out the timelock, which is allowed precisely because it only ever narrows what the bridge will do.
// Emitted when a limit is tightened without waiting out the timelock, which is allowed
// precisely because it only ever narrows what the bridge will do.
#[contractevent(topics = ["hyperion", "flow"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FlowLimitLowered {
    #[topic]
    pub token: Address,
    #[topic]
    pub by: Address,
    pub limit: i128,
}

#[cfg(test)]
pub fn bridge_out(env: &Env, record: &TransferRecord) {
    bridge_out_encoded(env, record.route, &record.sender, record.into_val(env));
}

pub(crate) fn bridge_out_encoded(env: &Env, route: RouteKind, sender: &Address, encoded: Val) {
    <BridgeOut as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("out").into_val(env),
        route.into_val(env),
        sender.into_val(env),
    ];
    const KEYS: &[&str] = &["transfer"];
    let values = [encoded];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn bridge_in(env: &Env, record: &InboundRecord) {
    <BridgeIn as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("in").into_val(env),
        (record.route).into_val(env),
        (record.recipient).into_val(env),
    ];
    const KEYS: &[&str] = &["inbound"];
    let values = [(record).into_val(env)];
    publish_raw(env, &topics, KEYS, &values);
}

#[cfg(test)]
pub fn claim_parked(env: &Env, claim: &PendingClaim) {
    claim_parked_encoded(env, &claim.recipient, &claim.token, claim.into_val(env));
}

pub(crate) fn claim_parked_encoded(env: &Env, recipient: &Address, token: &Address, encoded: Val) {
    <ClaimParked as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("park").into_val(env),
        recipient.into_val(env),
        token.into_val(env),
    ];
    const KEYS: &[&str] = &["claim"];
    let values = [encoded];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn claim_settled(env: &Env, claim: &PendingClaim, settled_by: &Address) {
    <ClaimSettled as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("settled").into_val(env),
        (claim.recipient).into_val(env),
    ];
    const KEYS: &[&str] = &["amount", "claim_id", "settled_by", "token"];
    let values = [
        (claim.amount).into_val(env),
        (claim.id).into_val(env),
        (settled_by).into_val(env),
        (claim.token).into_val(env),
    ];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn claim_payout_failure_v1(env: &Env, claim: &PendingClaim, reason: u32) {
    <ClaimPayoutFailureV1 as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::Symbol::new(env, "claim_failure_v1").into_val(env),
        (claim.id).into_val(env),
    ];
    const KEYS: &[&str] = &["outstanding_amount", "reason", "recipient"];
    let values = [
        (claim.amount).into_val(env),
        (reason).into_val(env),
        (claim.recipient).into_val(env),
    ];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn claim_archived(env: &Env, claim: &PendingClaim, settled_at: u64, archived_at: u64) {
    <ClaimArchived as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::Symbol::new(env, "claim_archived").into_val(env),
        (claim.recipient).into_val(env),
        (claim.token).into_val(env),
    ];
    const KEYS: &[&str] = &[
        "amount",
        "archived_at",
        "claim",
        "claim_id",
        "provenance",
        "settled_at",
        "source_nonce",
    ];
    let values = [
        (claim.amount).into_val(env),
        (archived_at).into_val(env),
        (claim).into_val(env),
        (claim.id).into_val(env),
        (crate::storage::claim_provenance(env, claim.id)).into_val(env),
        (settled_at).into_val(env),
        (claim.source_nonce).into_val(env),
    ];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn paused(env: &Env, by: &Address, state: bool) {
    <PauseSet as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("pause").into_val(env),
        (by).into_val(env),
    ];
    const KEYS: &[&str] = &["paused"];
    let values = [(state).into_val(env)];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn action_queued(env: &Env, action: QueuedAction) {
    <ActionQueued as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("queued").into_val(env),
    ];
    const KEYS: &[&str] = &["action", "eta", "expires_at", "id"];
    let values = [
        (action.action).into_val(env),
        (action.eta).into_val(env),
        (action.expires_at).into_val(env),
        (action.id).into_val(env),
    ];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn action_executed(env: &Env, action: QueuedAction) {
    <ActionExecuted as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("executed").into_val(env),
    ];
    const KEYS: &[&str] = &["action", "id", "queued_at"];
    let values = [
        (action.action).into_val(env),
        (action.id).into_val(env),
        (action.queued_at).into_val(env),
    ];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn action_cancelled(env: &Env, id: u64, by: &Address) {
    <ActionCancelled as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("cancelled").into_val(env),
        (by).into_val(env),
    ];
    const KEYS: &[&str] = &["id"];
    let values = [(id).into_val(env)];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn action_audit(
    env: &Env,
    id: u64,
    status: ActionAuditStatus,
    actor: &Address,
    reason: CancelReason,
    note: soroban_sdk::String,
) {
    <ActionAuditRecorded as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("audit").into_val(env),
        (id).into_val(env),
    ];
    const KEYS: &[&str] = &["actor", "note", "reason", "status", "version"];
    let values = [
        (actor).into_val(env),
        (note).into_val(env),
        (reason).into_val(env),
        (status).into_val(env),
        (1u32).into_val(env),
    ];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn storage_migrated(env: &Env, by: &Address, status: &MigrationStatus) {
    <StorageMigrated as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("migrated").into_val(env),
        (by).into_val(env),
    ];
    const KEYS: &[&str] = &["status", "version"];
    let values = [(status).into_val(env), (1u32).into_val(env)];
    publish_raw(env, &topics, KEYS, &values);
}

#[cfg(test)]
pub fn config_changed(env: &Env, cfg: &Config) {
    config_changed_encoded(env, cfg.into_val(env));
}

pub(crate) fn config_changed_encoded(env: &Env, encoded: Val) {
    <ConfigChanged as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("config").into_val(env),
    ];
    const KEYS: &[&str] = &["config"];
    let values = [encoded];
    publish_raw(env, &topics, KEYS, &values);
}

#[cfg(test)]
pub fn token_registered(env: &Env, token: &Address, cfg: &TokenConfig) {
    token_registered_encoded(env, token, cfg.into_val(env));
}

pub(crate) fn token_registered_encoded(env: &Env, token: &Address, encoded: Val) {
    <TokenRegistered as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("token").into_val(env),
        (token).into_val(env),
    ];
    const KEYS: &[&str] = &["config"];
    let values = [encoded];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn route_configured(env: &Env, route: RouteKind, enabled: bool) {
    <RouteConfigured as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("route").into_val(env),
        (route).into_val(env),
    ];
    const KEYS: &[&str] = &["enabled"];
    let values = [(enabled).into_val(env)];
    publish_raw(env, &topics, KEYS, &values);
}

pub fn flow_limit_lowered(env: &Env, token: &Address, limit: i128, by: &Address) {
    <FlowLimitLowered as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("flow").into_val(env),
        (token).into_val(env),
        (by).into_val(env),
    ];
    const KEYS: &[&str] = &["limit"];
    let values = [(limit).into_val(env)];
    publish_raw(env, &topics, KEYS, &values);
}

// Durable journal identity for each successfully processed message; consumers archive all bytes.
#[contractevent(topics = ["hyperion", "replay"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplayRecorded {
    #[topic]
    pub route: RouteKind,
    #[topic]
    pub message_id: BytesN<32>,
    pub version: u32,
    pub ledger: u32,
    pub timestamp: u64,
}

pub fn replay_recorded(env: &Env, route: RouteKind, message_id: &BytesN<32>) {
    <ReplayRecorded as soroban_sdk::SpecShakingMarker>::spec_shaking_marker();
    let topics = [
        soroban_sdk::symbol_short!("hyperion").into_val(env),
        soroban_sdk::symbol_short!("replay").into_val(env),
        (route).into_val(env),
        (message_id).into_val(env),
    ];
    const KEYS: &[&str] = &["ledger", "timestamp", "version"];
    let values = [
        (env.ledger().sequence()).into_val(env),
        (env.ledger().timestamp()).into_val(env),
        (1u32).into_val(env),
    ];
    publish_raw(env, &topics, KEYS, &values);
}

// Borrow record values directly and share the topic/map host-call framing.
// Event specifications and sparse map encoding remain the SDK definitions above.
struct RawEvent<'a> {
    topics: &'a [Val],
    keys: &'a [&'a str],
    values: &'a [Val],
}

impl soroban_sdk::Event for RawEvent<'_> {
    fn topics(&self, env: &Env) -> soroban_sdk::Vec<Val> {
        soroban_sdk::Vec::from_slice(env, self.topics)
    }

    fn data(&self, env: &Env) -> Val {
        use soroban_sdk::unwrap::UnwrapInfallible;
        env.sparse_map_new_from_slices(self.keys, self.values)
            .unwrap_infallible()
            .into()
    }
}

#[inline(never)]
fn publish_raw(env: &Env, topics: &[Val], keys: &[&str], values: &[Val]) {
    env.events().publish_event(&RawEvent {
        topics,
        keys,
        values,
    });
}
