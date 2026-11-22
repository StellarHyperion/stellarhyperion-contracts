//! The AdminAction wire format stays SDK-compatible while sharing its runtime codec.
use crate::types::ParsedAction as AdminAction;
#[cfg(not(target_family = "wasm"))]
use soroban_sdk::TryFromVal;
use soroban_sdk::{ConversionError, Env, EnvBase, Symbol, TryIntoVal, Val, Vec};

#[cfg(not(target_family = "wasm"))]
#[inline(never)]
pub(crate) fn encode(env: &Env, action: &AdminAction) -> Result<Val, ConversionError> {
    let mut values = [Val::VOID.to_val(); 5];
    let (name, count) = match action {
        AdminAction::SetFeeBps(a0) => {
            values[1] = a0.try_into_val(env)?;
            ("SetFeeBps", 2)
        }
        AdminAction::SetTreasury(a0) => {
            values[1] = a0.try_into_val(env)?;
            ("SetTreasury", 2)
        }
        AdminAction::SetAdmin(a0) => {
            values[1] = a0.try_into_val(env)?;
            ("SetAdmin", 2)
        }
        AdminAction::SetGuardian(a0) => {
            values[1] = a0.try_into_val(env)?;
            ("SetGuardian", 2)
        }
        AdminAction::SetAdapter(a0, a1) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            ("SetAdapter", 3)
        }
        AdminAction::SetRailReceiver(a0, a1) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            ("SetRailReceiver", 3)
        }
        AdminAction::EnableRoute(a0) => {
            values[1] = a0.try_into_val(env)?;
            ("EnableRoute", 2)
        }
        AdminAction::RegisterToken(a0, a1, a2) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            values[3] = a2.try_into_val(env)?;
            ("RegisterToken", 4)
        }
        AdminAction::RaiseTokenFlowLimit(a0, a1) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            ("RaiseTokenFlowLimit", 3)
        }
        AdminAction::SetRouteFlowLimit(a0, a1, a2) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            values[3] = a2.try_into_val(env)?;
            ("SetRouteFlowLimit", 4)
        }
        AdminAction::SetTimelockDelay(a0) => {
            values[1] = a0.try_into_val(env)?;
            ("SetTimelockDelay", 2)
        }
        AdminAction::SetFlowWindow(a0) => {
            values[1] = a0.try_into_val(env)?;
            ("SetFlowWindow", 2)
        }
        AdminAction::Upgrade(a0) => {
            values[1] = a0.try_into_val(env)?;
            ("Upgrade", 2)
        }
        AdminAction::SetRouteConfig(a0, a1) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            ("SetRouteConfig", 3)
        }
        AdminAction::SetRouteMaxSingleTransfer(a0, a1) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            ("SetRouteMaxSingleTransfer", 3)
        }
        AdminAction::SetDestinationFlowLimit(a0, a1, a2, a3) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            values[3] = a2.try_into_val(env)?;
            values[4] = a3.try_into_val(env)?;
            ("SetDestinationFlowLimit", 5)
        }
        AdminAction::BeginStorageMigration(a0) => {
            values[1] = a0.try_into_val(env)?;
            ("BeginStorageMigration", 2)
        }
    };
    values[0] = Symbol::try_from_val(env, &name)?.to_val();
    Ok(env.vec_new_from_slice(&values[..count])?.into())
}

#[inline(never)]
pub(crate) fn decode(env: &Env, value: &Val) -> Result<AdminAction, ConversionError> {
    let vector: Vec<Val> = value.try_into_val(env)?;
    let len = vector.len() as usize;
    if len == 0 || len > 5 {
        return Err(ConversionError);
    }
    let mut values = [Val::VOID.to_val(); 5];
    env.vec_unpack_to_slice(vector.to_object(), &mut values[..len])?;
    let discriminant: Symbol = values[0].try_into_val(env)?;
    const CASES: &[&str] = &[
        "SetFeeBps",
        "SetTreasury",
        "SetAdmin",
        "SetGuardian",
        "SetAdapter",
        "SetRailReceiver",
        "EnableRoute",
        "RegisterToken",
        "RaiseTokenFlowLimit",
        "SetRouteFlowLimit",
        "SetTimelockDelay",
        "SetFlowWindow",
        "Upgrade",
        "SetRouteConfig",
        "SetRouteMaxSingleTransfer",
        "SetDestinationFlowLimit",
        "BeginStorageMigration",
    ];
    let case = u32::from(env.symbol_index_in_strs(discriminant.to_symbol_val(), CASES)?);
    const ARITIES: [u8; 17] = [2, 2, 2, 2, 3, 3, 2, 4, 3, 4, 2, 2, 2, 3, 3, 5, 2];
    let count = usize::from(*ARITIES.get(case as usize).ok_or(ConversionError)?);
    if len != count {
        return Err(ConversionError);
    }
    Ok(match case {
        0 => AdminAction::SetFeeBps(values[1].try_into_val(env)?),
        1 => AdminAction::SetTreasury(values[1].try_into_val(env)?),
        2 => AdminAction::SetAdmin(values[1].try_into_val(env)?),
        3 => AdminAction::SetGuardian(values[1].try_into_val(env)?),
        4 => AdminAction::SetAdapter(values[1].try_into_val(env)?, values[2].try_into_val(env)?),
        5 => {
            AdminAction::SetRailReceiver(values[1].try_into_val(env)?, values[2].try_into_val(env)?)
        }
        6 => AdminAction::EnableRoute(values[1].try_into_val(env)?),
        7 => AdminAction::RegisterToken(
            values[1].try_into_val(env)?,
            values[2].try_into_val(env)?,
            values[3].try_into_val(env)?,
        ),
        8 => AdminAction::RaiseTokenFlowLimit(
            values[1].try_into_val(env)?,
            values[2].try_into_val(env)?,
        ),
        9 => AdminAction::SetRouteFlowLimit(
            values[1].try_into_val(env)?,
            values[2].try_into_val(env)?,
            values[3].try_into_val(env)?,
        ),
        10 => AdminAction::SetTimelockDelay(values[1].try_into_val(env)?),
        11 => AdminAction::SetFlowWindow(values[1].try_into_val(env)?),
        12 => AdminAction::Upgrade(values[1].try_into_val(env)?),
        13 => {
            AdminAction::SetRouteConfig(values[1].try_into_val(env)?, values[2].try_into_val(env)?)
        }
        14 => AdminAction::SetRouteMaxSingleTransfer(
            values[1].try_into_val(env)?,
            values[2].try_into_val(env)?,
        ),
        15 => AdminAction::SetDestinationFlowLimit(
            values[1].try_into_val(env)?,
            values[2].try_into_val(env)?,
            values[3].try_into_val(env)?,
            values[4].try_into_val(env)?,
        ),
        16 => AdminAction::BeginStorageMigration(values[1].try_into_val(env)?),
        _ => return Err(ConversionError),
    })
}

#[cfg(target_family = "wasm")]
#[inline(never)]
pub(crate) fn canonical(env: &Env, value: &Val) -> Result<Vec<Val>, ConversionError> {
    let action = decode(env, value)?;
    let mut vector: Vec<Val> = value.try_into_val(env)?;
    // Only RouteConfig is a record payload. Its SDK decoder accepts future map
    // fields, which the original action encoder removes before storage/events.
    if let AdminAction::SetRouteConfig(_, config) = action {
        vector.set(2, config.try_into_val(env)?);
    }
    Ok(vector)
}
