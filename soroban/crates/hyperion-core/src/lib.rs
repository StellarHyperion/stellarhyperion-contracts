//! Shared primitives for every Hyperion contract on Stellar.
//!
//! Everything in here exists because of one section of the architecture doc: the
//! Stellar/EVM impedance mismatches. Decimal conversion, Stellar address encoding and
//! flow-limit accounting all live in one place so that no contract is ever tempted to
//! inline the arithmetic, which is exactly how the 10x decimal bug shows up in the wild.
#![cfg_attr(not(test), no_std)]

pub mod address;
pub mod amount;
pub mod axelar;
pub mod cctp;
pub mod codec;
pub mod error;
pub mod flow;
pub mod inbound;
pub mod route;
pub mod strkey;

#[cfg(test)]
mod malformed_corpus_test;

pub use address::{AddressKind, StellarDestination};
pub use amount::{
    convert_decimals, convert_decimals_exact, floor_to_representable, scale_amount, Conversion,
    FeeSplit,
};
pub use axelar::{InboundNote, OutboundNote};
pub use cctp::{BurnMessage, CctpMessage, HyperionHook};
pub use error::HyperionError;
pub use flow::FlowWindow;
pub use inbound::{Origin, Recipient, Router, RouterClient};
pub use route::RouteKind;
pub use strkey::StrkeyDestination;

/// Ledgers used as the default flow-limit window. Stellar closes a ledger roughly every
/// five seconds, so 720 ledgers is about an hour.
pub const DEFAULT_FLOW_WINDOW_LEDGERS: u32 = 720;

/// Hard ceiling on the protocol fee, expressed in basis points. The architecture doc puts
/// the opening range at 5 to 15 bps; this cap means a compromised admin key still cannot
/// set a confiscatory fee, even after the timelock elapses.
pub const MAX_FEE_BPS: u32 = 100;

/// Basis-point denominator.
pub const BPS_DENOMINATOR: i128 = 10_000;

/// Decimal places used by USDC on every EVM chain Hyperion targets.
pub const EVM_USDC_DECIMALS: u32 = 6;

/// Decimal places used by Stellar assets by convention, and by XLM exactly (a stroop is
/// 10^-7 XLM).
pub const STELLAR_DECIMALS: u32 = 7;
