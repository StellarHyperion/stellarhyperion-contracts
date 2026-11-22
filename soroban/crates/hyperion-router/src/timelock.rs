use hyperion_core::amount::MAX_DECIMALS;
use hyperion_core::{HyperionError, MAX_FEE_BPS};
use soroban_sdk::{Address, ContractExecutable, Env, String};

use crate::storage;
use crate::types::{
    ActionAuditStatus, AdminAction, CancelReason, Config, MigrationStatus, ParsedAction,
    QueuedAction, RouteConfig, TokenConfig, CURRENT_SCHEMA_VERSION, MAX_REASON_LEN,
};

/// Shortest and longest delay the router will accept.
///
/// A floor of one hour exists because a timelock a compromised key can set to zero is not a
/// timelock. A ceiling of thirty days exists because a delay nobody will ever sit through is a
/// different way of bricking the contract.
pub const MIN_TIMELOCK_DELAY: u64 = 3_600;
pub const MAX_TIMELOCK_DELAY: u64 = 2_592_000;

// The configuration-diff command reports these bounds (and GRACE_PERIOD below) with every
// proposal it emits. It can only describe a change the admin still has to queue and execute after
// the wait, so there is no tool-side shortcut around the floor or the ceiling.

/// How long a matured action stays executable before it has to be requeued.
///
/// Without this, an action queued and forgotten a year ago is still sitting there ready to fire
/// the moment somebody calls execute, which is a nasty shape of surprise.
pub const GRACE_PERIOD: u64 = 604_800;

pub fn queue(
    env: &Env,
    cfg: &Config,
    queued_by: &Address,
    action: AdminAction,
) -> Result<QueuedAction, HyperionError> {
    #[cfg(target_family = "wasm")]
    let parsed = action.parsed(env);
    #[cfg(target_family = "wasm")]
    let validation_action = &parsed;
    #[cfg(not(target_family = "wasm"))]
    let validation_action = &action;
    validate(validation_action)?;
    if let ParsedAction::RegisterToken(token, decimals, _) = validation_action {
        validate_token_behavior(env, token, *decimals)?;
    }
    let now = env.ledger().timestamp();
    let id = storage::next_queue_id(env);
    let queued = QueuedAction {
        id,
        action,
        queued_at: now,
        eta: now + cfg.timelock_delay,
        expires_at: now + cfg.timelock_delay + GRACE_PERIOD,
    };
    storage::set_queued(env, &queued);
    crate::events::action_audit(
        env,
        id,
        ActionAuditStatus::Queued,
        queued_by,
        CancelReason::Unspecified,
        String::from_str(env, ""),
    );
    Ok(queued)
}

pub fn take_matured(env: &Env, caller: &Address, id: u64) -> Result<QueuedAction, HyperionError> {
    let queued = storage::queued(env, id).ok_or(HyperionError::TimelockNotQueued)?;
    let now = env.ledger().timestamp();
    if now < queued.eta {
        return Err(HyperionError::TimelockNotReady);
    }
    if now > queued.expires_at {
        return Err(HyperionError::TimelockExpired);
    }
    storage::resolve_queued(env, id, &queued);
    crate::events::action_audit(
        env,
        id,
        ActionAuditStatus::Executed,
        caller,
        CancelReason::Unspecified,
        String::from_str(env, ""),
    );
    Ok(queued)
}

pub fn cancel(
    env: &Env,
    caller: &Address,
    id: u64,
    reason: CancelReason,
    note: String,
) -> Result<(), HyperionError> {
    if note.len() > MAX_REASON_LEN {
        return Err(HyperionError::InvalidLimit);
    }
    // Printable ASCII is the deliberately narrow, shared EVM/Soroban wire encoding.
    if note
        .to_bytes()
        .iter()
        .any(|byte| !(32..=126).contains(&byte))
    {
        return Err(HyperionError::InvalidLimit);
    }
    let queued = storage::queued(env, id).ok_or(HyperionError::TimelockNotQueued)?;
    storage::resolve_queued(env, id, &queued);
    crate::events::action_cancelled(env, id, caller);
    crate::events::action_audit(env, id, ActionAuditStatus::Cancelled, caller, reason, note);
    Ok(())
}

/// Reject a queued action that could never be executed successfully.
///
/// Catching this at queue time rather than at execute time matters: a bad parameter that only
/// fails after the delay has elapsed costs another full delay to fix, and during an incident
/// that is the difference between a bad afternoon and a bad week.
fn validate(action: &ParsedAction) -> Result<(), HyperionError> {
    match action {
        ParsedAction::SetFeeBps(bps) => {
            if *bps > MAX_FEE_BPS {
                return Err(HyperionError::FeeTooHigh);
            }
        }
        ParsedAction::SetTimelockDelay(delay) => {
            if *delay < MIN_TIMELOCK_DELAY || *delay > MAX_TIMELOCK_DELAY {
                return Err(HyperionError::TimelockDelayOutOfRange);
            }
        }
        ParsedAction::SetFlowWindow(window) => {
            if *window == 0 {
                return Err(HyperionError::InvalidWindow);
            }
        }
        ParsedAction::RegisterToken(_, decimals, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            if *decimals > 38 {
                return Err(HyperionError::InvalidDecimals);
            }
        }
        ParsedAction::RaiseTokenFlowLimit(_, limit)
        | ParsedAction::SetRouteFlowLimit(_, _, limit)
        | ParsedAction::SetRouteMaxSingleTransfer(_, limit)
        | ParsedAction::SetDestinationFlowLimit(_, _, _, limit)
            if *limit < 0 =>
        {
            return Err(HyperionError::InvalidLimit)
        }
        ParsedAction::SetRouteConfig(_, cfg) if cfg.max_single_transfer < 0 => {
            return Err(HyperionError::InvalidLimit);
        }
        ParsedAction::BeginStorageMigration(version) if *version != CURRENT_SCHEMA_VERSION => {
            return Err(HyperionError::InvalidLimit);
        }
        _ => {}
    }
    Ok(())
}

/// Validate token admission against router accounting assumptions before activation.
///
/// Ensures the token contract exists, correctly implements SEP-41 decimals matching
/// `decimals`, does not exceed `MAX_DECIMALS`, and responds to standard balance checks.
pub fn validate_token_behavior(
    env: &Env,
    token: &Address,
    decimals: u32,
) -> Result<(), HyperionError> {
    if decimals > MAX_DECIMALS {
        return Err(HyperionError::InvalidDecimals);
    }
    let client = soroban_sdk::token::Client::new(env, token);
    let onchain_decimals = match client.try_decimals() {
        Ok(Ok(d)) => d,
        _ => return Err(HyperionError::InvalidDecimals),
    };
    if onchain_decimals != decimals {
        return Err(HyperionError::InvalidDecimals);
    }
    let this = env.current_contract_address();
    if !matches!(client.try_balance(&this), Ok(Ok(balance)) if balance >= 0) {
        return Err(HyperionError::InvalidAmount);
    }
    Ok(())
}

pub fn apply(env: &Env, action: &AdminAction) -> Result<(), HyperionError> {
    let mut cfg = storage::config(env)?;
    #[cfg(target_family = "wasm")]
    let parsed = action.parsed(env);
    #[cfg(target_family = "wasm")]
    let action = &parsed;
    let mut changed_config = false;
    match action {
        ParsedAction::SetFeeBps(bps) => {
            if *bps > MAX_FEE_BPS {
                return Err(HyperionError::FeeTooHigh);
            }
            cfg.fee_bps = *bps;
            changed_config = true;
        }
        ParsedAction::SetTreasury(addr) => {
            cfg.treasury = addr.clone();
            changed_config = true;
        }
        ParsedAction::SetAdmin(addr) => {
            cfg.admin = addr.clone();
            changed_config = true;
        }
        ParsedAction::SetGuardian(addr) => {
            cfg.guardian = addr.clone();
            changed_config = true;
        }
        ParsedAction::SetAdapter(route, addr) => {
            storage::set_adapter(env, *route, addr);
        }
        ParsedAction::SetRailReceiver(route, addr) => {
            storage::set_rail_receiver(env, *route, addr);
        }
        ParsedAction::EnableRoute(route) => {
            storage::set_route_enabled(env, *route, true);
            crate::events::route_configured(env, *route, true);
        }
        ParsedAction::RegisterToken(token, decimals, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            if *decimals > 38 {
                return Err(HyperionError::InvalidDecimals);
            }
            validate_token_behavior(env, token, *decimals)?;
            let token_cfg = TokenConfig {
                decimals: *decimals,
                flow_limit: *limit,
                enabled: true,
            };
            let encoded = storage::set_token_config(env, token, &token_cfg);
            crate::events::token_registered_encoded(env, token, encoded);
        }
        ParsedAction::RaiseTokenFlowLimit(token, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            let mut token_cfg = storage::token_config(env, token)?;
            token_cfg.flow_limit = *limit;
            let encoded = storage::set_token_config(env, token, &token_cfg);
            crate::events::token_registered_encoded(env, token, encoded);
        }
        ParsedAction::SetRouteFlowLimit(token, route, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            storage::set_route_flow_limit(env, token, *route, *limit);
        }
        ParsedAction::SetTimelockDelay(delay) => {
            if *delay < MIN_TIMELOCK_DELAY || *delay > MAX_TIMELOCK_DELAY {
                return Err(HyperionError::TimelockDelayOutOfRange);
            }
            cfg.timelock_delay = *delay;
            changed_config = true;
        }
        ParsedAction::SetFlowWindow(window) => {
            if *window == 0 {
                return Err(HyperionError::InvalidWindow);
            }
            cfg.flow_window_ledgers = *window;
            changed_config = true;
        }
        ParsedAction::Upgrade(wasm_hash) => {
            env.deployer()
                .update_current_contract(ContractExecutable::Wasm(wasm_hash.clone()));
        }
        ParsedAction::BeginStorageMigration(version) => {
            // The fixed high-water marks keep concurrent new deliveries from moving the goal.
            // Repeating a reviewed authorization never resets an interrupted migration.
            if storage::schema_version(env) < *version
                && storage::migration_state(env)
                    .map(|state| !state.migration_pending && state.target_version < *version)
                    .unwrap_or(true)
            {
                storage::set_migration_state(
                    env,
                    &MigrationStatus {
                        current_version: storage::schema_version(env),
                        target_version: *version,
                        migration_pending: true,
                        migrated_transfers: 0,
                        migrated_claims: 0,
                        total_transfers: storage::out_nonce(env),
                        total_claims: storage::claim_count(env),
                    },
                );
            }
        }
        ParsedAction::SetRouteConfig(route, route_cfg) => {
            if route_cfg.max_single_transfer < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            storage::set_route_config(env, *route, route_cfg);
        }
        ParsedAction::SetRouteMaxSingleTransfer(route, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            let route_cfg = RouteConfig {
                max_single_transfer: *limit,
            };
            storage::set_route_config(env, *route, &route_cfg);
        }
        ParsedAction::SetDestinationFlowLimit(token, route, chain, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            storage::set_destination_flow_limit(env, token, *route, chain, *limit);
        }
    }
    if changed_config {
        write_config_event(env, &cfg);
    }
    Ok(())
}

// Keep the existing write-before-event order for all six configuration mutations.
#[inline(never)]
fn write_config_event(env: &Env, cfg: &Config) {
    let encoded = storage::set_config(env, cfg);
    crate::events::config_changed_encoded(env, encoded);
}
