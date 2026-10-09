use hyperion_core::{HyperionError, MAX_FEE_BPS};
use soroban_sdk::{ContractExecutable, Env};

use crate::storage;
use crate::types::{AdminAction, Config, QueuedAction, RouteConfig, TokenConfig};

/// Shortest and longest delay the router will accept.
///
/// A floor of one hour exists because a timelock a compromised key can set to zero is not a
/// timelock. A ceiling of thirty days exists because a delay nobody will ever sit through is a
/// different way of bricking the contract.
pub const MIN_TIMELOCK_DELAY: u64 = 3_600;
pub const MAX_TIMELOCK_DELAY: u64 = 2_592_000;

/// How long a matured action stays executable before it has to be requeued.
///
/// Without this, an action queued and forgotten a year ago is still sitting there ready to fire
/// the moment somebody calls execute, which is a nasty shape of surprise.
pub const GRACE_PERIOD: u64 = 604_800;

pub fn queue(env: &Env, cfg: &Config, action: AdminAction) -> Result<QueuedAction, HyperionError> {
    validate(&action)?;
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
    Ok(queued)
}

pub fn take_matured(env: &Env, id: u64) -> Result<QueuedAction, HyperionError> {
    let queued = storage::queued(env, id).ok_or(HyperionError::TimelockNotQueued)?;
    let now = env.ledger().timestamp();
    if now < queued.eta {
        return Err(HyperionError::TimelockNotReady);
    }
    if now > queued.expires_at {
        return Err(HyperionError::TimelockExpired);
    }
    storage::clear_queued(env, id);
    Ok(queued)
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
            if *limit < 0 =>
        {
            return Err(HyperionError::InvalidLimit)
        }
        AdminAction::SetRouteConfig(_, cfg) if cfg.max_single_transfer < 0 => {
            return Err(HyperionError::InvalidLimit);
        }
        _ => {}
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
            storage::set_config(env, &cfg);
            crate::events::config_changed(env, &cfg);
        }
        AdminAction::SetTreasury(addr) => {
            cfg.treasury = addr.clone();
            storage::set_config(env, &cfg);
            crate::events::config_changed(env, &cfg);
        }
        AdminAction::SetAdmin(addr) => {
            cfg.admin = addr.clone();
            storage::set_config(env, &cfg);
            crate::events::config_changed(env, &cfg);
        }
        AdminAction::SetGuardian(addr) => {
            cfg.guardian = addr.clone();
            storage::set_config(env, &cfg);
            crate::events::config_changed(env, &cfg);
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
            storage::set_config(env, &cfg);
            crate::events::config_changed(env, &cfg);
        }
        AdminAction::SetFlowWindow(window) => {
            if *window == 0 {
                return Err(HyperionError::InvalidWindow);
            }
            cfg.flow_window_ledgers = *window;
            storage::set_config(env, &cfg);
            crate::events::config_changed(env, &cfg);
        }
        AdminAction::Upgrade(wasm_hash) => {
            env.deployer()
                .update_current_contract(ContractExecutable::Wasm(wasm_hash.clone()));
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
    }
    Ok(())
}
