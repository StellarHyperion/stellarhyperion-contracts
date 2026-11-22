//! Shared primitives for every Hyperion contract on Stellar.
//!
//! Everything in here exists because of one section of the architecture doc: the
//! Stellar/EVM impedance mismatches. Decimal conversion, Stellar address encoding and
//! flow-limit accounting all live in one place so that no contract is ever tempted to
//! inline the arithmetic, which is exactly how the 10x decimal bug shows up in the wild.
//!
//! The `model` module is an independent, allocation-free reference model of the router's
//! dispatch, pause, administration and claim semantics. It exists so that operation
//! sequences can be replayed against both the Soroban router and the EVM router and
//! compared step by step, and so that failing sequences can be reduced to a minimal
//! reproducible trace. Chain-specific time semantics (Stellar ledger sequence versus EVM
//! block timestamps) are modeled explicitly rather than assumed to be interchangeable.
//!
//! # Deployment trust assumptions
//!
//! The active deployment is Stellar Testnet outbound ITS/CCTP; these notes do not activate
//! EVM or any other rail. On inbound Stellar delivery, CCTP message authentication belongs to
//! Circle's `MessageTransmitter` interface (`hyperion-adapter-cctp::rail::Receiver`), while ITS
//! authenticates its callback as the invoking contract and the adapter separately checks the
//! configured remote peer. `inbound::Router` is deliberately limited to `bridge_in` and
//! `treasury`; the router checks the configured rail receiver before pulling funds.
//!
//! Adapter configuration is a separate authority surface from router configuration. Adapter
//! admin setters authenticate the adapter's own admin directly; they do not execute through the
//! router's timelock, even when deployments assign the same multisig to both. Router changes use
//! its queue-and-execute timelock. The source-level assertions in
//! `packages/protocol/test/parity.test.ts` pin these references and the concrete checks in the
//! interfaces and setters, so drift or a broken documentation reference fails parity.
#![cfg_attr(not(test), no_std)]

pub mod address;
pub mod amount;
pub mod axelar;
pub mod cctp;
pub mod codec;
pub mod error;
#[cfg(not(target_family = "wasm"))]
pub mod fault;
pub mod flow;
pub mod inbound;
pub mod maintenance;
pub mod model;
mod numeric;
pub mod route;
pub mod strkey;

pub use address::{AddressKind, StellarDestination};
pub use amount::{
    compute_quote_fingerprint, convert_decimals, convert_decimals_exact, floor_to_representable,
    scale_amount, Conversion, FeeSplit,
};
pub use axelar::{
    inspect_auth_tree_snapshot, AuthorizedDebit, PaidDispatchAuthSnapshot, PrivilegeExpansion,
};
pub use axelar::{
    verify_inbound_reconciliation, verify_outbound_reconciliation, CandidateInboundPayment,
    CandidatePayment, InboundNote, OutboundNote, ReconciliationDiscrepancy,
    MIN_PEER_ROTATION_DELAY,
};
pub use axelar::{TokenMappingConflict, TokenMappingReport};
pub use cctp::{
    validate_burn_boundary, ApprovalDiagnostics, ApprovalFinding, BurnMessage, CctpMessage,
    HyperionHook, APPROVAL_DIAGNOSTICS_VERSION, DOCUMENTED_RESIDUAL_ALLOWANCE,
};
pub use error::HyperionError;
#[cfg(not(target_family = "wasm"))]
pub use fault::{FaultStage, ProviderFaultController, ProviderFaultSchedule};
pub use flow::FlowWindow;
pub use inbound::{Origin, Recipient, Router, RouterClient};
pub use maintenance::{
    AdapterKeyCoverage, AdapterMaintenance, AdapterMaintenanceClient, MaintenanceSummary,
    MAX_MAINTENANCE_BATCH,
};
pub use model::{
    ChainClock, ModelError, ModelRouter, Operation, Rail, Trace, TraceStep, MODEL_MAX_CLAIMS,
};
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
