use hyperion_core::RouteKind;
use soroban_sdk::{contracttype, Address, Bytes, BytesN, String};

use crate::rail::TokenManagerType;

/// Who this adapter works for, and which of the two Axelar shapes it speaks.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// Kept separate in storage rather than read back from the router, so that a router upgrade
    /// cannot silently move who controls the rail wiring.
    pub admin: Address,
    pub router: Address,
    pub its: Address,
    /// `AxelarIts` for a bare transfer, `AxelarGmp` for one carrying a Hyperion note. One WASM,
    /// two instances, and an instance never changes its mind about which it is.
    pub route: RouteKind,
}

/// One lane, in Hyperion's vocabulary and in Axelar's.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainLink {
    /// What Hyperion calls the chain, which is what a user sees and what the router carries.
    pub chain: String,
    /// What Axelar calls it. The two agree often enough to be tempting and differ often enough
    /// to be a bug, so both are written down.
    pub axelar_chain: String,
    /// Hyperion's own contract over there. Only the GMP shape needs one, and on that shape it is
    /// the single address an inbound note is accepted from.
    pub peer: BytesN<20>,
}

/// Deterministic summary of every contract, spender/recipient, and exact amount a sender must
/// authorize for a paid `AxelarIts` outbound transfer (`dispatch_from`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaidDispatchAuthPlan {
    pub router: Address,
    pub adapter: Address,
    pub its: Address,
    pub gas_service: Address,
    pub token: Address,
    pub token_id: BytesN<32>,
    pub token_manager_type: TokenManagerType,
    /// `None` when `token_manager_type` burns directly from sender; `Some(manager)` on `LockUnlock`.
    pub token_spender: Option<Address>,
    pub native_gas_token: Address,
    pub axelar_chain: String,
    pub destination_address: Bytes,
    pub net_amount: i128,
    pub gas_amount: i128,
}
