//! Everything this adapter says out loud.
//!
//! The indexer reads these. Topics are kept short because a literal topic has to fit in a small
//! symbol, and there is a hard ceiling of four topics per event.

use soroban_sdk::{contractevent, Address, BytesN, String, U256};

/// A transfer handed to Allbridge.
#[contractevent(topics = ["hyperion", "abr_out"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispatched {
    #[topic]
    pub token: Address,
    #[topic]
    pub chain: String,
    pub allbridge_chain_id: u32,
    pub amount: i128,
    pub recipient: BytesN<32>,
    pub receive_token: BytesN<32>,
    pub nonce: U256,
    /// Native token spent buying the relay, read live rather than configured.
    pub gas_spent: u128,
}

/// Somebody topped the gas float up.
#[contractevent(topics = ["hyperion", "abr_gas"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GasFunded {
    #[topic]
    pub funder: Address,
    pub amount: i128,
    pub balance: i128,
}

/// The admin took native token back out of the float.
#[contractevent(topics = ["hyperion", "abr_gas"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GasWithdrawn {
    #[topic]
    pub to: Address,
    pub amount: i128,
    pub balance: i128,
}

/// Dust sent on to the treasury.
#[contractevent(topics = ["hyperion", "abr_dust"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swept {
    #[topic]
    pub token: Address,
    pub amount: i128,
    pub treasury: Address,
    pub caller: Address,
}

#[contractevent(topics = ["hyperion", "abr_cfg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaneSet {
    #[topic]
    pub chain: String,
    pub allbridge_chain_id: u32,
}

#[contractevent(topics = ["hyperion", "abr_cfg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetLinked {
    #[topic]
    pub token: Address,
    pub allbridge_chain_id: u32,
    pub receive_token: BytesN<32>,
}

#[contractevent(topics = ["hyperion", "abr_cfg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    #[topic]
    pub old: Address,
    pub new: Address,
}

/// A message Allbridge attested and delivered, and that this adapter passed on to the router.
#[contractevent(topics = ["hyperion", "abr_in"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Received {
    #[topic]
    pub token: Address,
    #[topic]
    pub source_chain: String,
    pub amount: i128,
    pub recipient: Address,
    pub source_chain_id: u32,
    pub nonce: U256,
    pub message_id: BytesN<32>,
    /// Nonzero when the router had to park the delivery instead of handing it straight over.
    pub claim_id: u64,
}

#[contractevent(topics = ["hyperion", "abr_cfg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatorSet {
    pub validator: BytesN<32>,
}
