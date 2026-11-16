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

/// Active validator key, monotonic epoch, and emergency circuit-breaker flag.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatorState {
    pub validator: BytesN<32>,
    pub epoch: u64,
    pub activated_at: u64,
    pub emergency_disabled: bool,
}

/// Reviewed validator rotation waiting out the configured trust-change delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingValidatorRotation {
    pub next_validator: BytesN<32>,
    pub next_epoch: u64,
    pub queued_at: u64,
    pub eta: u64,
    pub expires_at: u64,
}
