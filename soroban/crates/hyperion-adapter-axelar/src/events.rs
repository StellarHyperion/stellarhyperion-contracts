//! What this adapter announces.
//!
//! Four topics is the ceiling, and the pair at the front of each one spends two of them on
//! `hyperion` and on the rail plus direction. That leaves two for the fields a subscriber
//! actually filters on, which here means the asset and the far side's chain. Everything else
//! lives in the body, where it costs nothing to carry and is still part of the contract spec,
//! so an indexer reads these as real types rather than as loose maps.
//!
//! Every configuration change shares one topic pair on purpose. The monitoring job that cares
//! about them cares about all of them at once, and wants a single subscription that fires
//! whenever somebody rewires a lane.

use soroban_sdk::{contractevent, Address, Bytes, BytesN, String};

use crate::rail::TokenManagerType;

/// Funds handed to ITS on the way out.
#[contractevent(topics = ["hyperion", "axl_out"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispatched {
    #[topic]
    pub token: Address,
    #[topic]
    pub destination_chain: String,
    pub amount: i128,
    pub token_id: BytesN<32>,
    /// Axelar's own name for the chain, which is what the gateway event will carry.
    pub axelar_chain: String,
    /// Where ITS is told to deliver. The final recipient on the bare shape, Hyperion's own
    /// contract over there on the shape that carries a note.
    pub destination_address: Bytes,
    /// How ITS took the funds, which is the one thing this adapter authorised.
    pub token_manager_type: TokenManagerType,
    /// Present only on the shape that carries a note, where the far side has work to do.
    pub note: Option<Bytes>,
    /// The router's own outbound nonce, so the two halves of the trail can be joined up.
    pub router_nonce: u64,
}

/// A transfer ITS delivered here, and that this adapter passed on to the router.
#[contractevent(topics = ["hyperion", "axl_in"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Received {
    #[topic]
    pub token: Address,
    #[topic]
    pub source_chain: String,
    pub amount: i128,
    pub token_id: BytesN<32>,
    /// Axelar's message id, which is the handle a support request will quote.
    pub message_id: String,
    pub recipient: Address,
    /// The note's own sequence number, set by whoever sent it.
    pub nonce: u64,
    /// Nonzero when the router had to park the delivery instead of handing it straight over.
    pub claim_id: u64,
}

/// Leftovers moved out of the adapter and into the treasury.
#[contractevent(topics = ["hyperion", "axl_dust"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swept {
    #[topic]
    pub token: Address,
    pub amount: i128,
    pub treasury: Address,
    pub caller: Address,
}

#[contractevent(topics = ["hyperion", "axl_cfg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinkSet {
    #[topic]
    pub chain: String,
    pub axelar_chain: String,
    pub peer: BytesN<20>,
}

#[contractevent(topics = ["hyperion", "axl_cfg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenMapped {
    #[topic]
    pub token: Address,
    pub token_id: BytesN<32>,
}

#[contractevent(topics = ["hyperion", "axl_cfg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    #[topic]
    pub old: Address,
    #[topic]
    pub new: Address,
}

#[contractevent(topics = ["hyperion", "axl_cfg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityAdmitted {
    #[topic]
    pub chain: String,
    #[topic]
    pub token: Address,
    pub token_id: BytesN<32>,
    pub local_manager_type: TokenManagerType,
    pub remote_manager_type: TokenManagerType,
    pub supports_direct_its: bool,
    pub supports_gmp_payload: bool,
    pub supports_paid_dispatch: bool,
    pub max_transfer_amount: i128,
    pub enabled: bool,
}

#[contractevent(topics = ["hyperion", "axl_cfg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrictCapabilitiesSet {
    pub required: bool,
}
