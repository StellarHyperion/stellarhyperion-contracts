//! Tests for the CCTP adapter.
//!
//! Circle's two contracts are stood in for, because you cannot summon a real attestation service
//! into a unit test. Everything else is real: the router is the actual `hyperion-router`
//! contract, the asset is a real Stellar Asset Contract with real allowance semantics, and the
//! messages are built byte by byte in Circle's own wire format and parsed back by the same code
//! the deployed contract uses.
//!
//! The stand-ins are deliberately unhelpful. The messenger enforces the same preconditions
//! Circle's does and pulls funds with `transfer_from`, so a missing or undersized allowance
//! fails here exactly as it would on the network. The transmitter tracks used nonces, refuses an
//! empty attestation, and can be told to take a fee, so the adapter's habit of measuring the
//! balance delta rather than trusting `burn.amount` is genuinely exercised rather than asserted.

mod admin;
mod circle;
mod inbound;
mod outbound;
mod paid;
mod setup;
