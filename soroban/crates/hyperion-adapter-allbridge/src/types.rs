//! What this adapter stores.

use soroban_sdk::{contracttype, Address, BytesN, String, U256};

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

/// Reconciliation lifecycle of an outbound Allbridge provider handoff.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum OutboundStatus {
    /// Committed on-chain in `dispatch`; awaiting independent provider reconciliation.
    Dispatched,
    /// Provider status could not be confirmed; blind retry or second debit is forbidden.
    OutcomeUnknown,
    /// Source-chain Allbridge message hash and pool-output vUSD have been verified.
    ProviderConfirmed,
    /// No on-chain `Outbound` debit occurred and external submission was confirmed absent.
    InterruptedBeforeDebit,
}

/// Operator-supplied observation of Allbridge Core source-chain provider state.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderObservation {
    /// Horizon/RPC timeout or unindexed state: provider outcome is unknown.
    Unknown,
    /// Allbridge emitted a source message for `(v_usd, message_id)`.
    MessageSent(u128, BytesN<32>),
    /// Verified ledger proof that no source-chain Allbridge handoff was committed.
    ConfirmedAbsent,
}

/// Bounded operator action permitted after reconciling outbound state with provider evidence.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum RecoveryAction {
    /// Halt and re-query provider evidence; never perform a second token debit.
    HoldDoNotDebit,
    /// No token debit ever landed on-chain; a fresh normal router transfer is safe.
    SafeFreshSubmission,
    /// Pool sale and message emission already occurred on-chain, and Allbridge Core Soroban
    /// exposes no standalone replay or gas-top-up entrypoint without a second pool debit.
    UnsupportedProviderRecovery,
}

/// Immutable outbound handoff record persisted on every successful `dispatch`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboundRecord {
    pub nonce: u64,
    pub rail_nonce: U256,
    pub token: Address,
    pub amount: i128,
    pub destination_chain: String,
    pub source_chain_id: u32,
    pub allbridge_chain_id: u32,
    pub recipient: BytesN<32>,
    pub receive_token: BytesN<32>,
    pub gas_spent: u128,
    /// Pre-fee reference digest preserving chain IDs, recipient, receive_token, and full nonce.
    pub nominal_message_id: BytesN<32>,
    /// Verified on-wire Allbridge digest once reconciled with observed `v_usd`.
    pub verified_message_id: Option<BytesN<32>>,
    pub verified_v_usd: Option<u128>,
    pub status: OutboundStatus,
}

/// Result of reconciling an interrupted or in-flight outbound provider call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryPlan {
    pub nonce: u64,
    pub rail_nonce: U256,
    pub recipient: BytesN<32>,
    pub destination_chain: String,
    pub source_chain_id: u32,
    pub allbridge_chain_id: u32,
    pub receive_token: BytesN<32>,
    pub amount: i128,
    pub verified_v_usd: Option<u128>,
    pub message_id: BytesN<32>,
    pub status: OutboundStatus,
    pub action: RecoveryAction,
    pub second_debit_permitted: bool,
}
