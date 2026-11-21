//! What this adapter stores.

use soroban_sdk::{contracttype, Address, BytesN, String};

/// Set once at `initialize` and afterwards only the admin moves.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// Holds the admin powers. In production this is the router's timelocked multisig.
    pub admin: Address,
    /// The only address allowed to ask for a dispatch.
    pub router: Address,
    /// Allbridge Core's bridge contract.
    pub bridge: Address,
    /// The wrapped native asset, which is what Allbridge charges relaying in.
    ///
    /// The bridge knows its own native token but does not expose it, so it is passed in and
    /// checked the first time a transfer needs it.
    pub native: Address,
}

/// One lane: Hyperion's name for a chain paired with Allbridge's number for it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainLane {
    pub chain: String,
    pub allbridge_chain_id: u32,
}

/// One asset on one lane, and the token it turns into at the far end.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetLink {
    pub token: Address,
    pub allbridge_chain_id: u32,
    /// The destination token's address, left padded to thirty two bytes.
    pub receive_token: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatorEpoch {
    pub epoch: u32,
    pub validator: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingValidator {
    pub epoch: u32,
    pub validator: BytesN<32>,
    pub activate_after: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboundRecord {
    pub nonce: u64,
    pub token: Address,
    pub amount: i128,
    pub destination_chain: String,
    pub destination: BytesN<32>,
    pub receive_token: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderStatus {
    Unknown,
    Submitted,
    Failed,
    Unsupported,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryDecision {
    pub nonce: u64,
    pub retry_allowed: bool,
    pub reason: u32,
    pub record: OutboundRecord,
}
