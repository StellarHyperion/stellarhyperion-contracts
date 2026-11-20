use hyperion_core::amount::MAX_DECIMALS;
use hyperion_core::{HyperionError, MAX_FEE_BPS};
use soroban_sdk::{Address, ContractExecutable, Env, String};

use crate::storage;
use crate::types::{
    ActionAuditStatus, AdminAction, CancelReason, Config, MigrationStatus, QueuedAction,
    RouteConfig, TokenConfig, CURRENT_SCHEMA_VERSION, MAX_REASON_LEN,
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
    validate(&action)?;
    if let AdminAction::RegisterToken(token, decimals, _) = &action {
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
    storage::retain_action(env, &queued);
    storage::clear_queued(env, id);
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
    storage::retain_action(env, &queued);
    storage::clear_queued(env, id);
    crate::events::action_cancelled(env, id, caller);
    crate::events::action_audit(env, id, ActionAuditStatus::Cancelled, caller, reason, note);
    Ok(())
}

/// Reject a queued action that could never be executed successfully.
///
/// Catching this at queue time rather than at execute time matters: a bad parameter that only
/// fails after the delay has elapsed costs another full delay to fix, and during an incident
/// that is the difference between a bad afternoon and a bad week.
fn validate(action: &AdminAction) -> Result<(), HyperionError> {
    match action {
        AdminAction::SetFeeBps(bps) => {
            if *bps > MAX_FEE_BPS {
                return Err(HyperionError::FeeTooHigh);
            }
        }
        AdminAction::SetTimelockDelay(delay) => {
            if *delay < MIN_TIMELOCK_DELAY || *delay > MAX_TIMELOCK_DELAY {
                return Err(HyperionError::TimelockDelayOutOfRange);
            }
        }
        AdminAction::SetFlowWindow(window) => {
            if *window == 0 {
                return Err(HyperionError::InvalidWindow);
            }
        }
        AdminAction::RegisterToken(_, decimals, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            if *decimals > 38 {
                return Err(HyperionError::InvalidDecimals);
            }
        }
        AdminAction::RaiseTokenFlowLimit(_, limit)
        | AdminAction::SetRouteFlowLimit(_, _, limit)
        | AdminAction::SetRouteMaxSingleTransfer(_, limit)
        | AdminAction::SetDestinationFlowLimit(_, _, _, limit)
            if *limit < 0 =>
        {
            return Err(HyperionError::InvalidLimit)
        }
        AdminAction::SetRouteConfig(_, cfg) if cfg.max_single_transfer < 0 => {
            return Err(HyperionError::InvalidLimit);
        }
        AdminAction::BeginStorageMigration(version) if *version != CURRENT_SCHEMA_VERSION => {
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
    match action {
        AdminAction::SetFeeBps(bps) => {
            if *bps > MAX_FEE_BPS {
                return Err(HyperionError::FeeTooHigh);
            }
            cfg.fee_bps = *bps;
            write_config_event(env, &cfg);
        }
        AdminAction::SetTreasury(addr) => {
            cfg.treasury = addr.clone();
            write_config_event(env, &cfg);
        }
        AdminAction::SetAdmin(addr) => {
            cfg.admin = addr.clone();
            write_config_event(env, &cfg);
        }
        AdminAction::SetGuardian(addr) => {
            cfg.guardian = addr.clone();
            write_config_event(env, &cfg);
        }
        AdminAction::SetAdapter(route, addr) => {
            storage::set_adapter(env, *route, addr);
        }
        AdminAction::SetRailReceiver(route, addr) => {
            storage::set_rail_receiver(env, *route, addr);
        }
        AdminAction::EnableRoute(route) => {
            storage::set_route_enabled(env, *route, true);
            crate::events::route_configured(env, *route, true);
        }
        AdminAction::RegisterToken(token, decimals, limit) => {
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
            storage::set_token_config(env, token, &token_cfg);
            crate::events::token_registered(env, token, &token_cfg);
        }
        AdminAction::RaiseTokenFlowLimit(token, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            let mut token_cfg = storage::token_config(env, token)?;
            token_cfg.flow_limit = *limit;
            storage::set_token_config(env, token, &token_cfg);
            crate::events::token_registered(env, token, &token_cfg);
        }
        AdminAction::SetRouteFlowLimit(token, route, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            storage::set_route_flow_limit(env, token, *route, *limit);
        }
        AdminAction::SetTimelockDelay(delay) => {
            if *delay < MIN_TIMELOCK_DELAY || *delay > MAX_TIMELOCK_DELAY {
                return Err(HyperionError::TimelockDelayOutOfRange);
            }
            cfg.timelock_delay = *delay;
            write_config_event(env, &cfg);
        }
        AdminAction::SetFlowWindow(window) => {
            if *window == 0 {
                return Err(HyperionError::InvalidWindow);
            }
            cfg.flow_window_ledgers = *window;
            write_config_event(env, &cfg);
        }
        AdminAction::Upgrade(wasm_hash) => {
            env.deployer()
                .update_current_contract(ContractExecutable::Wasm(wasm_hash.clone()));
        }
        AdminAction::BeginStorageMigration(version) => {
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
        AdminAction::SetRouteConfig(route, route_cfg) => {
            if route_cfg.max_single_transfer < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            storage::set_route_config(env, *route, route_cfg);
        }
        AdminAction::SetRouteMaxSingleTransfer(route, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            let route_cfg = RouteConfig {
                max_single_transfer: *limit,
            };
            storage::set_route_config(env, *route, &route_cfg);
        }
        AdminAction::SetDestinationFlowLimit(token, route, chain, limit) => {
            if *limit < 0 {
                return Err(HyperionError::InvalidLimit);
            }
            storage::set_destination_flow_limit(env, token, *route, chain, *limit);
        }
    }
    Ok(())
}

// Keep the existing write-before-event order for all six configuration mutations.
#[inline(never)]
fn write_config_event(env: &Env, cfg: &Config) {
    storage::set_config(env, cfg);
    crate::events::config_changed(env, cfg);
}
