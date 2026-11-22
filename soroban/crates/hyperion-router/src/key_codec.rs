//! Storage keys retain the SDK tagged-vector encoding with one shared constructor.
use crate::storage::DataKey;
use soroban_sdk::{symbol_short, ConversionError, Env, EnvBase, Symbol, TryIntoVal, Val};

#[inline(never)]
pub(crate) fn encode(env: &Env, key: &DataKey) -> Result<Val, ConversionError> {
    let mut values = [Val::VOID.to_val(); 4];
    let (tag, count) = match key {
        DataKey::Config => (symbol_short!("Config").to_val(), 1),
        DataKey::LiabilityTracking => (long_symbol(env, "LiabilityTracking"), 1),
        DataKey::OutNonce => (symbol_short!("OutNonce").to_val(), 1),
        DataKey::Adapter(a0) => {
            values[1] = a0.try_into_val(env)?;
            (symbol_short!("Adapter").to_val(), 2)
        }
        DataKey::RailReceiver(a0) => {
            values[1] = a0.try_into_val(env)?;
            (long_symbol(env, "RailReceiver"), 2)
        }
        DataKey::RouteEnabled(a0) => {
            values[1] = a0.try_into_val(env)?;
            (long_symbol(env, "RouteEnabled"), 2)
        }
        DataKey::RouteConfig(a0) => {
            values[1] = a0.try_into_val(env)?;
            (long_symbol(env, "RouteConfig"), 2)
        }
        DataKey::Token(a0) => {
            values[1] = a0.try_into_val(env)?;
            (symbol_short!("Token").to_val(), 2)
        }
        DataKey::RouteFlowLimit(a0, a1) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            (long_symbol(env, "RouteFlowLimit"), 3)
        }
        DataKey::Flow(a0, a1) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            (symbol_short!("Flow").to_val(), 3)
        }
        DataKey::DestinationFlowLimit(a0, a1, a2) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            values[3] = a2.try_into_val(env)?;
            (long_symbol(env, "DestinationFlowLimit"), 4)
        }
        DataKey::DestinationFlow(a0, a1, a2) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            values[3] = a2.try_into_val(env)?;
            (long_symbol(env, "DestinationFlow"), 4)
        }
        DataKey::Transfer(a0) => {
            values[1] = a0.try_into_val(env)?;
            (symbol_short!("Transfer").to_val(), 2)
        }
        DataKey::Processed(a0, a1) => {
            values[1] = a0.try_into_val(env)?;
            values[2] = a1.try_into_val(env)?;
            (symbol_short!("Processed").to_val(), 3)
        }
        DataKey::Claim(a0) => {
            values[1] = a0.try_into_val(env)?;
            (symbol_short!("Claim").to_val(), 2)
        }
        DataKey::ClaimSeq => (symbol_short!("ClaimSeq").to_val(), 1),
        DataKey::Queued(a0) => {
            values[1] = a0.try_into_val(env)?;
            (symbol_short!("Queued").to_val(), 2)
        }
        DataKey::QueueSeq => (symbol_short!("QueueSeq").to_val(), 1),
        DataKey::SchemaVersion => (long_symbol(env, "SchemaVersion"), 1),
        DataKey::ResolvedAction(a0) => {
            values[1] = a0.try_into_val(env)?;
            (long_symbol(env, "ResolvedAction"), 2)
        }
        DataKey::MigrationState => (long_symbol(env, "MigrationState"), 1),
        DataKey::ClaimFailure(a0) => {
            values[1] = a0.try_into_val(env)?;
            (long_symbol(env, "ClaimFailure"), 2)
        }
        DataKey::ClaimProvenance(a0) => {
            values[1] = a0.try_into_val(env)?;
            (long_symbol(env, "ClaimProvenance"), 2)
        }
        DataKey::ClaimLiability(a0) => {
            values[1] = a0.try_into_val(env)?;
            (long_symbol(env, "ClaimLiability"), 2)
        }
        DataKey::ClaimSettledAt(a0) => {
            values[1] = a0.try_into_val(env)?;
            (long_symbol(env, "ClaimSettledAt"), 2)
        }
        DataKey::ClaimArchiveWord(a0) => {
            values[1] = a0.try_into_val(env)?;
            (long_symbol(env, "ClaimArchiveWord"), 2)
        }
    };
    values[0] = tag;
    Ok(env.vec_new_from_slice(&values[..count])?.into())
}

#[inline(never)]
fn long_symbol(env: &Env, name: &str) -> Val {
    Symbol::new(env, name).to_val()
}
