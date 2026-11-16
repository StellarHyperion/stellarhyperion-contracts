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

/// Read-only snapshot of authority, pool, liquidity, gas float and validator state for a
/// candidate Allbridge lane. Inspecting this never enables a route or moves assets.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaneReadinessSnapshot {
    pub admin: Address,
    pub router: Address,
    pub bridge: Address,
    pub native: Address,
    pub lane_linked: bool,
    pub allbridge_chain_id: u32,
    pub rail_open: bool,
    pub asset_mapped: bool,
    pub receive_token: BytesN<32>,
    pub pool: Option<Address>,
    pub pool_liquidity: i128,
    pub gas_float: i128,
    pub relay_cost: u128,
    pub float_covers_relay: bool,
    pub validator_configured: bool,
    pub validator: Option<BytesN<32>>,
}
