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

/// Signed inbound validator intent inspected by `audit_inbound_evidence`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedInboundIntent {
    pub token: Address,
    pub amount: i128,
    pub recipient: Address,
    pub source_chain_id: u32,
    pub nonce: U256,
    pub signature: BytesN<64>,
}

/// Validator-independent source-chain Allbridge bridge/messenger event evidence.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceProviderEvidence {
    pub source_chain_id: u32,
    pub destination_chain_id: u32,
    pub recipient: BytesN<32>,
    pub receive_token: BytesN<32>,
    pub amount: u128,
    pub nonce: U256,
    pub message_id: BytesN<32>,
}

/// On-chain destination payout or parked-claim observation paired with an inbound delivery.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PayoutObservation {
    /// Delivery has not yet settled on-chain or no payout receipt was supplied.
    Unobserved,
    /// Direct payout observed with `(recipient, token, amount)`.
    DirectPayout(Address, Address, i128),
    /// Parked claim ID on `HyperionRouter` (`claim_id > 0`), queried live from the router.
    ParkedClaim(u64),
}

/// Outcome classification for validator-independent inbound evidence auditing.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EvidenceAuditStatus {
    /// Validator intent, independent source-provider evidence, and on-chain payout all agree.
    Verified,
    /// Independent source-provider evidence is absent; validator trust remains unresolved.
    UnresolvedTrustAssumption,
    /// Amount in source evidence or payout record disagrees with signed inbound intent.
    AmountMismatch,
    /// Recipient in source evidence or payout record disagrees with signed inbound intent.
    RecipientMismatch,
    /// Chain, token, nonce, message digest, or router processed state is inconsistent.
    MetadataMismatch,
    /// Validator key is missing/zero or signature is empty.
    InvalidValidatorIntent,
}

/// Read-only audit report comparing signed inbound intent, source provider evidence, and payout.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InboundEvidenceAudit {
    pub status: EvidenceAuditStatus,
    pub verified: bool,
    pub unresolved_validator_trust: bool,
    pub expected_message_id: BytesN<32>,
    pub adapter_processed: bool,
    pub router_processed: bool,
    pub source_evidence_matches: bool,
    pub payout_matches: bool,
}
