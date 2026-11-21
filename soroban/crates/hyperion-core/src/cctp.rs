//! Circle's CCTP v2 wire format, read only.
//!
//! Hyperion never signs a CCTP attestation and never mints. What it does do is read the message
//! Circle's own verifier is about to act on, so that it can work out three things the rail does
//! not tell it: which local asset the burn corresponds to, who on Stellar the sender actually
//! meant, and what identifier to file the delivery under.
//!
//! The offsets below are the format itself, not a guess. They match Circle's `cctp-utils` crate
//! field for field, which is the definition the on-chain contracts read from. Everything here is
//! a pure function over bytes so the whole parser can be tested without a rail in sight.

use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env};

use crate::address::{AddressKind, StellarDestination};
use crate::error::HyperionError;

/// Circle's domain number for Stellar.
pub const STELLAR_DOMAIN: u32 = 27;

/// Message version Hyperion speaks. CCTP v2 headers carry version one.
pub const MESSAGE_VERSION: u32 = 1;
/// Burn message version that pairs with it.
pub const BURN_MESSAGE_VERSION: u32 = 1;

/// Finality threshold at or above which Circle considers a message finalised.
pub const FINALITY_THRESHOLD_FINALIZED: u32 = 2000;
/// The supported fast-transfer threshold. Selecting this requires a lane-level admin action.
pub const FINALITY_THRESHOLD_FAST: u32 = 1000;

/// Whether Circle must attest a finalized burn or may attest a fast burn.
pub fn is_supported_finality_threshold(threshold: u32) -> bool {
    matches!(
        threshold,
        FINALITY_THRESHOLD_FAST | FINALITY_THRESHOLD_FINALIZED
    )
}

/// Minimum delay required before a proposed CCTP peer messenger rotation can become active (1 hour).
///
/// 3600 seconds (1 hour) enforces an explicit review and timelock window so that
/// unintended or unauthorized messenger migrations can be audited and cancelled before
/// taking effect.
pub const MIN_PEER_ROTATION_DELAY: u64 = 3_600;

/// Default overlap window during which historical/in-flight messages from a retired
/// peer messenger remain acceptable after rotation (24 hours).
pub const DEFAULT_ROTATION_OVERLAP_WINDOW: u64 = 86_400;

// ------------------------------------------------------------------------------------------
// Header offsets
// ------------------------------------------------------------------------------------------

const MSG_VERSION: u32 = 0;
const MSG_SOURCE_DOMAIN: u32 = 4;
const MSG_DESTINATION_DOMAIN: u32 = 8;
const MSG_NONCE: u32 = 12;
const MSG_SENDER: u32 = 44;
const MSG_RECIPIENT: u32 = 76;
const MSG_DESTINATION_CALLER: u32 = 108;
const MSG_MIN_FINALITY: u32 = 140;
const MSG_FINALITY_EXECUTED: u32 = 144;
/// Everything from here on is the body, which for a token transfer is a burn message.
pub const MSG_BODY: u32 = 148;

const BURN_VERSION: u32 = 0;
const BURN_TOKEN: u32 = 4;
const BURN_MINT_RECIPIENT: u32 = 36;
const BURN_AMOUNT: u32 = 68;
const BURN_MESSAGE_SENDER: u32 = 100;
const BURN_MAX_FEE: u32 = 132;
const BURN_FEE_EXECUTED: u32 = 164;
const BURN_EXPIRATION_BLOCK: u32 = 196;
/// Anything past here is the hook payload, which is where Hyperion puts the Stellar recipient.
pub const BURN_HOOK_DATA: u32 = 228;

// ------------------------------------------------------------------------------------------
// Primitive reads
// ------------------------------------------------------------------------------------------

fn byte_at(raw: &Bytes, index: u32) -> Result<u8, HyperionError> {
    raw.get(index).ok_or(HyperionError::MalformedMessage)
}

/// Read a big-endian u32.
fn read_u32(raw: &Bytes, offset: u32) -> Result<u32, HyperionError> {
    let mut value: u32 = 0;
    let mut i = 0u32;
    while i < 4 {
        value = (value << 8) | byte_at(raw, offset + i)? as u32;
        i += 1;
    }
    Ok(value)
}

/// Read a thirty two byte word.
fn read_word(env: &Env, raw: &Bytes, offset: u32) -> Result<BytesN<32>, HyperionError> {
    let mut word = [0u8; 32];
    let mut i = 0u32;
    while i < 32 {
        word[i as usize] = byte_at(raw, offset + i)?;
        i += 1;
    }
    Ok(BytesN::from_array(env, &word))
}

/// Read a uint256 that has to fit in an i128 to be usable on Stellar.
///
/// Refusing rather than truncating is the whole point. A token amount that genuinely needs more
/// than a hundred and twenty seven bits cannot be represented in a Soroban balance at all, and
/// quietly keeping the low half would turn an absurd number into a plausible one.
fn read_amount(raw: &Bytes, offset: u32) -> Result<i128, HyperionError> {
    let mut i = 0u32;
    while i < 16 {
        if byte_at(raw, offset + i)? != 0 {
            return Err(HyperionError::DecimalOverflow);
        }
        i += 1;
    }
    let mut value: u128 = 0;
    while i < 32 {
        value = (value << 8) | byte_at(raw, offset + i)? as u128;
        i += 1;
    }
    if value > i128::MAX as u128 {
        return Err(HyperionError::DecimalOverflow);
    }
    Ok(value as i128)
}

// ------------------------------------------------------------------------------------------
// Messages
// ------------------------------------------------------------------------------------------

/// A CCTP v2 message header, parsed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CctpMessage {
    pub version: u32,
    pub source_domain: u32,
    pub destination_domain: u32,
    /// The rail's own identifier for this message. Thirty two bytes, and the only sane thing to
    /// key replay protection on.
    pub nonce: BytesN<32>,
    pub sender: BytesN<32>,
    /// Who the message is addressed to on this domain. For a token transfer this is Circle's own
    /// TokenMessengerMinter, never us.
    pub recipient: BytesN<32>,
    pub destination_caller: BytesN<32>,
    pub min_finality_threshold: u32,
    pub finality_threshold_executed: u32,
}

impl CctpMessage {
    /// Parse a header, refusing anything too short to hold one.
    pub fn parse(env: &Env, raw: &Bytes) -> Result<Self, HyperionError> {
        if raw.len() < MSG_BODY {
            return Err(HyperionError::MalformedMessage);
        }
        Ok(Self {
            version: read_u32(raw, MSG_VERSION)?,
            source_domain: read_u32(raw, MSG_SOURCE_DOMAIN)?,
            destination_domain: read_u32(raw, MSG_DESTINATION_DOMAIN)?,
            nonce: read_word(env, raw, MSG_NONCE)?,
            sender: read_word(env, raw, MSG_SENDER)?,
            recipient: read_word(env, raw, MSG_RECIPIENT)?,
            destination_caller: read_word(env, raw, MSG_DESTINATION_CALLER)?,
            min_finality_threshold: read_u32(raw, MSG_MIN_FINALITY)?,
            finality_threshold_executed: read_u32(raw, MSG_FINALITY_EXECUTED)?,
        })
    }

    /// The body, which is the part Circle hands to whichever handler the recipient names.
    pub fn body(raw: &Bytes) -> Result<Bytes, HyperionError> {
        if raw.len() < MSG_BODY {
            return Err(HyperionError::MalformedMessage);
        }
        Ok(raw.slice(MSG_BODY..raw.len()))
    }

    /// Whether the message was attested at finalised confidence rather than fast confidence.
    pub fn is_finalized(&self) -> bool {
        self.finality_threshold_executed >= FINALITY_THRESHOLD_FINALIZED
    }

    /// A u64 view of the nonce, for people rather than for replay protection.
    ///
    /// The bottom eight bytes, which is what an explorer shows and what a support conversation
    /// tends to quote. Never used as a key: see [`crate::error::HyperionError::ReplayedMessage`]
    /// and the router's own storage notes for why thirty two bytes is the real identifier.
    pub fn display_nonce(&self) -> u64 {
        let raw = self.nonce.to_array();
        let mut tail = [0u8; 8];
        tail.copy_from_slice(&raw[24..32]);
        u64::from_be_bytes(tail)
    }
}

/// A CCTP v2 burn message, parsed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BurnMessage {
    pub version: u32,
    /// The burned asset, as it is addressed on the source domain.
    pub burn_token: BytesN<32>,
    /// Who Circle will mint to on this domain. For Hyperion this is the adapter itself.
    pub mint_recipient: BytesN<32>,
    pub amount: i128,
    pub message_sender: BytesN<32>,
    pub max_fee: i128,
    pub fee_executed: i128,
    pub expiration_block: i128,
}

impl BurnMessage {
    pub fn parse(env: &Env, body: &Bytes) -> Result<Self, HyperionError> {
        if body.len() < BURN_HOOK_DATA {
            return Err(HyperionError::MalformedMessage);
        }
        Ok(Self {
            version: read_u32(body, BURN_VERSION)?,
            burn_token: read_word(env, body, BURN_TOKEN)?,
            mint_recipient: read_word(env, body, BURN_MINT_RECIPIENT)?,
            amount: read_amount(body, BURN_AMOUNT)?,
            message_sender: read_word(env, body, BURN_MESSAGE_SENDER)?,
            max_fee: read_amount(body, BURN_MAX_FEE)?,
            fee_executed: read_amount(body, BURN_FEE_EXECUTED)?,
            expiration_block: read_amount(body, BURN_EXPIRATION_BLOCK)?,
        })
    }

    /// The trailing hook payload, empty when the sender attached none.
    pub fn hook_data(body: &Bytes) -> Result<Bytes, HyperionError> {
        if body.len() < BURN_HOOK_DATA {
            return Err(HyperionError::MalformedMessage);
        }
        Ok(body.slice(BURN_HOOK_DATA..body.len()))
    }
}

// ------------------------------------------------------------------------------------------
// Hyperion's hook payload
// ------------------------------------------------------------------------------------------

/// Version byte on Hyperion's own hook payload.
pub const HOOK_VERSION: u8 = 1;

/// What Hyperion's EVM side writes into a CCTP hook so the Stellar side knows where to pay.
///
/// A CCTP mint recipient is thirty two bytes and nothing else, which is exactly one key with no
/// room to say whether it is an account or a contract, let alone to carry a muxed id. The hook
/// is the only field wide enough to hold the answer, so that is where the real destination goes
/// and the mint recipient is simply the adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HyperionHook {
    pub destination: StellarDestination,
}

/// Verify both CCTP sender fields against one explicitly configured remote peer.
/// Both fields must match: the header sender identifies the source contract boundary,
/// while the burn sender is carried in the transfer body and may not be substituted independently.
pub fn verify_remote_sender(
    expected: &BytesN<32>,
    header_sender: &BytesN<32>,
    burn_sender: &BytesN<32>,
) -> Result<(), HyperionError> {
    if header_sender != expected || burn_sender != expected {
        return Err(HyperionError::UnexpectedRailContract);
    }
    Ok(())
}

impl HyperionHook {
    pub fn new(destination: StellarDestination) -> Self {
        Self { destination }
    }

    /// Serialise as `[version][kind][32 byte key][8 byte muxed id, muxed only]`.
    pub fn encode(&self, env: &Env) -> Result<Bytes, HyperionError> {
        self.destination.validate()?;
        let mut out = Bytes::new(env);
        out.push_back(HOOK_VERSION);
        out.append(&self.destination.encode(env));
        Ok(out)
    }

    /// Parse a hook payload, refusing a version we do not understand.
    ///
    /// An unknown version is refused rather than skipped past. A payload we cannot read is a
    /// destination we would be guessing at, and guessing here means paying the wrong person.
    pub fn decode(env: &Env, raw: &Bytes) -> Result<Self, HyperionError> {
        if raw.is_empty() {
            return Err(HyperionError::InvalidDestination);
        }
        let version = raw.get(0).ok_or(HyperionError::InvalidDestination)?;
        if version != HOOK_VERSION {
            return Err(HyperionError::UnsupportedHookVersion);
        }
        let body = raw.slice(1..raw.len());
        let destination = StellarDestination::decode(env, &body)?;
        destination.validate()?;
        Ok(Self { destination })
    }

    /// Whether this destination can be paid without its owner opting in first.
    pub fn needs_trustline(&self) -> bool {
        self.destination.kind.needs_trustline()
    }

    pub fn kind(&self) -> AddressKind {
        self.destination.kind
    }
}

// ------------------------------------------------------------------------------------------
// Approval lifecycle & diagnostics
// ------------------------------------------------------------------------------------------

/// Diagnostic format version for CCTP approval lifecycle audits.
pub const APPROVAL_DIAGNOSTICS_VERSION: u32 = 1;

/// Provider/attestation diagnostics versions remain independent from CCTP message versions.
pub const LANE_READINESS_VERSION: u32 = 1;
pub const EXPIRY_TOOL_VERSION: u32 = 1;

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProviderReadStatus {
    Unknown = 0,
    Usable = 1,
    Paused = 2,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AttestationCondition {
    Unverified = 0,
    Verified = 1,
    Expired = 2,
    UnsupportedRecovery = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaneReadiness {
    pub version: u32,
    pub router_paused: bool,
    pub messenger: ProviderReadStatus,
    pub transmitter: ProviderReadStatus,
    pub messenger_contract: Address,
    pub transmitter_contract: Address,
    pub lane_available: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenewalPlan {
    pub version: u32,
    pub condition: AttestationCondition,
    pub source_message_id: BytesN<32>,
    pub payout_intent: BytesN<32>,
    pub expires_at: i128,
    pub recovery_supported: bool,
}

impl RenewalPlan {
    pub fn classify(
        source_message_id: BytesN<32>,
        payout_intent: BytesN<32>,
        expires_at: i128,
        now: i128,
        has_verified_attestation: bool,
        recovery_supported: bool,
    ) -> Self {
        let condition = if expires_at <= now {
            AttestationCondition::Expired
        } else if !recovery_supported {
            AttestationCondition::UnsupportedRecovery
        } else if has_verified_attestation {
            AttestationCondition::Verified
        } else {
            AttestationCondition::Unverified
        };
        Self {
            version: EXPIRY_TOOL_VERSION,
            condition,
            source_message_id,
            payout_intent,
            expires_at,
            recovery_supported: recovery_supported && expires_at > now,
        }
    }
}

/// Documented residual allowance expected between adapter and token messenger.
/// Hyperion leaves no standing allowance on any rail messenger; expected residual is always zero.
pub const DOCUMENTED_RESIDUAL_ALLOWANCE: i128 = 0;

/// Findings produced by the allowance auditor.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ApprovalFinding {
    /// Allowance matches the documented state (clean zero allowance).
    Clean = 0,
    /// Unexpected residual allowance detected without caller authorization.
    UnexpectedResidual = 1,
    /// Allowance could not be read or was outside the token amount domain.
    Unavailable = 2,
}

/// Versioned diagnostics snapshot of the CCTP allowance and approval lifecycle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalDiagnostics {
    pub version: u32,
    /// Zero is a placeholder when finding is Unavailable, never proof of cleanliness.
    pub allowance: i128,
    pub expected_allowance: i128,
    pub is_clean: bool,
    pub finding: ApprovalFinding,
}

impl ApprovalDiagnostics {
    /// An unreadable value has no numeric allowance; callers must inspect the finding.
    pub fn unavailable() -> Self {
        Self {
            version: APPROVAL_DIAGNOSTICS_VERSION,
            allowance: 0,
            expected_allowance: DOCUMENTED_RESIDUAL_ALLOWANCE,
            is_clean: false,
            finding: ApprovalFinding::Unavailable,
        }
    }

    /// Evaluate an allowance against the documented baseline without mutating state.
    pub fn audit(allowance: i128) -> Self {
        if allowance < 0 {
            return Self::unavailable();
        }
        let is_clean = allowance == DOCUMENTED_RESIDUAL_ALLOWANCE;
        let finding = if is_clean {
            ApprovalFinding::Clean
        } else {
            ApprovalFinding::UnexpectedResidual
        };
        Self {
            version: APPROVAL_DIAGNOSTICS_VERSION,
            allowance,
            expected_allowance: DOCUMENTED_RESIDUAL_ALLOWANCE,
            is_clean,
            finding,
        }
    }
}

/// Validate burn parameters at the message boundary before dispatching to TokenMessenger.
///
/// Preserves exact integer amounts, verifies non-zero mint recipient, and ensures
/// fee policy and finality threshold match documented bounds.
pub fn validate_burn_boundary(
    amount: i128,
    destination: &BytesN<32>,
    max_fee: i128,
    min_finality_threshold: u32,
) -> Result<(), HyperionError> {
    if amount <= 0 {
        return Err(HyperionError::InvalidAmount);
    }
    let zero = [0u8; 32];
    if destination.to_array() == zero {
        return Err(HyperionError::InvalidDestination);
    }
    if max_fee < 0 || max_fee >= amount {
        return Err(HyperionError::FeeTooHigh);
    }
    if !is_supported_finality_threshold(min_finality_threshold) {
        return Err(HyperionError::InvalidLimit);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    /// Build a CCTP v2 header with a body appended, the way Circle's own test helpers do.
    fn header(env: &Env, source_domain: u32, destination_domain: u32, nonce_tail: u64) -> Bytes {
        let mut raw = [0u8; MSG_BODY as usize];
        raw[0..4].copy_from_slice(&MESSAGE_VERSION.to_be_bytes());
        raw[4..8].copy_from_slice(&source_domain.to_be_bytes());
        raw[8..12].copy_from_slice(&destination_domain.to_be_bytes());
        raw[36..44].copy_from_slice(&nonce_tail.to_be_bytes());
        raw[44..76].copy_from_slice(&[0xE1u8; 32]);
        raw[76..108].copy_from_slice(&[0xC1u8; 32]);
        raw[140..144].copy_from_slice(&2000u32.to_be_bytes());
        raw[144..148].copy_from_slice(&2000u32.to_be_bytes());
        Bytes::from_slice(env, &raw)
    }

    fn burn_body(env: &Env, amount: i128, hook: &Bytes) -> Bytes {
        let mut raw = [0u8; BURN_HOOK_DATA as usize];
        raw[0..4].copy_from_slice(&BURN_MESSAGE_VERSION.to_be_bytes());
        raw[4..36].copy_from_slice(&[0xB0u8; 32]);
        raw[36..68].copy_from_slice(&[0xA5u8; 32]);
        raw[84..100].copy_from_slice(&(amount as u128).to_be_bytes());
        raw[100..132].copy_from_slice(&[0x5Eu8; 32]);
        let mut out = Bytes::from_slice(env, &raw);
        out.append(hook);
        out
    }

    #[test]
    fn a_header_reads_back_field_for_field() {
        let env = Env::default();
        let raw = header(&env, 0, STELLAR_DOMAIN, 4242);
        let parsed = CctpMessage::parse(&env, &raw).unwrap();

        assert_eq!(parsed.version, MESSAGE_VERSION);
        assert_eq!(parsed.source_domain, 0);
        assert_eq!(parsed.destination_domain, STELLAR_DOMAIN);
        assert_eq!(parsed.display_nonce(), 4242);
        assert_eq!(parsed.sender, BytesN::from_array(&env, &[0xE1u8; 32]));
        assert_eq!(parsed.recipient, BytesN::from_array(&env, &[0xC1u8; 32]));
        assert!(parsed.is_finalized());
    }

    #[test]
    fn a_header_one_byte_short_is_refused_rather_than_read_past_the_end() {
        let env = Env::default();
        let full = header(&env, 0, STELLAR_DOMAIN, 1);
        let truncated = full.slice(0..MSG_BODY - 1);
        assert_eq!(
            CctpMessage::parse(&env, &truncated),
            Err(HyperionError::MalformedMessage)
        );
        assert_eq!(
            CctpMessage::body(&truncated),
            Err(HyperionError::MalformedMessage)
        );
    }

    #[test]
    fn a_fast_attestation_is_visibly_not_a_finalised_one() {
        let env = Env::default();
        let mut raw = [0u8; MSG_BODY as usize];
        raw[144..148].copy_from_slice(&1000u32.to_be_bytes());
        let parsed = CctpMessage::parse(&env, &Bytes::from_slice(&env, &raw)).unwrap();
        // Circle will still attest it, and it is still real money, but the caller deserves to
        // know which confidence level it arrived at.
        assert!(!parsed.is_finalized());
    }

    #[test]
    fn the_body_is_everything_after_the_header() {
        let env = Env::default();
        let mut raw = header(&env, 0, STELLAR_DOMAIN, 1);
        raw.append(&Bytes::from_slice(&env, &[1, 2, 3, 4]));
        assert_eq!(
            CctpMessage::body(&raw).unwrap(),
            Bytes::from_slice(&env, &[1, 2, 3, 4])
        );
    }

    #[test]
    fn a_burn_message_reads_its_amount_and_recipient_back() {
        let env = Env::default();
        let body = burn_body(&env, 1_234_567, &Bytes::new(&env));
        let parsed = BurnMessage::parse(&env, &body).unwrap();

        assert_eq!(parsed.version, BURN_MESSAGE_VERSION);
        assert_eq!(parsed.amount, 1_234_567);
        assert_eq!(parsed.burn_token, BytesN::from_array(&env, &[0xB0u8; 32]));
        assert_eq!(
            parsed.mint_recipient,
            BytesN::from_array(&env, &[0xA5u8; 32])
        );
        assert_eq!(
            parsed.message_sender,
            BytesN::from_array(&env, &[0x5Eu8; 32])
        );
        assert!(BurnMessage::hook_data(&body).unwrap().is_empty());
    }

    #[test]
    fn an_amount_wider_than_a_soroban_balance_is_refused_not_truncated() {
        let env = Env::default();
        let mut raw = [0u8; BURN_HOOK_DATA as usize];
        // A one in the upper half of the uint256, which no Stellar balance can hold.
        raw[68] = 1;
        assert_eq!(
            BurnMessage::parse(&env, &Bytes::from_slice(&env, &raw)),
            Err(HyperionError::DecimalOverflow)
        );
    }

    #[test]
    fn an_amount_at_the_top_of_the_signed_range_still_parses() {
        let env = Env::default();
        let mut raw = [0u8; BURN_HOOK_DATA as usize];
        raw[68 + 16..68 + 32].copy_from_slice(&(i128::MAX as u128).to_be_bytes());
        let parsed = BurnMessage::parse(&env, &Bytes::from_slice(&env, &raw)).unwrap();
        assert_eq!(parsed.amount, i128::MAX);
    }

    #[test]
    fn one_bit_above_the_signed_range_is_refused() {
        let env = Env::default();
        let mut raw = [0u8; BURN_HOOK_DATA as usize];
        raw[68 + 16..68 + 32].copy_from_slice(&(i128::MAX as u128 + 1).to_be_bytes());
        assert_eq!(
            BurnMessage::parse(&env, &Bytes::from_slice(&env, &raw)),
            Err(HyperionError::DecimalOverflow)
        );
    }

    #[test]
    fn a_burn_message_too_short_for_its_own_header_is_refused() {
        let env = Env::default();
        let raw = Bytes::from_slice(&env, &[0u8; 100]);
        assert_eq!(
            BurnMessage::parse(&env, &raw),
            Err(HyperionError::MalformedMessage)
        );
        assert_eq!(
            BurnMessage::hook_data(&raw),
            Err(HyperionError::MalformedMessage)
        );
    }

    #[test]
    fn a_hook_survives_the_round_trip_for_every_kind_of_destination() {
        let env = Env::default();
        for destination in [
            StellarDestination::account(BytesN::from_array(&env, &[0x21u8; 32])),
            StellarDestination::contract(BytesN::from_array(&env, &[0x22u8; 32])),
            StellarDestination::muxed(BytesN::from_array(&env, &[0x23u8; 32]), 9_000_001),
        ] {
            let hook = HyperionHook::new(destination.clone());
            let wire = hook.encode(&env).unwrap();
            assert_eq!(HyperionHook::decode(&env, &wire).unwrap(), hook);
            assert_eq!(
                HyperionHook::decode(&env, &wire).unwrap().destination,
                destination
            );
        }
    }

    #[test]
    fn a_hook_travels_inside_a_burn_message_without_being_disturbed() {
        let env = Env::default();
        let destination = StellarDestination::account(BytesN::from_array(&env, &[0x31u8; 32]));
        let wire = HyperionHook::new(destination.clone()).encode(&env).unwrap();
        let body = burn_body(&env, 500, &wire);

        let recovered = BurnMessage::hook_data(&body).unwrap();
        assert_eq!(
            HyperionHook::decode(&env, &recovered).unwrap().destination,
            destination
        );
        assert_eq!(BurnMessage::parse(&env, &body).unwrap().amount, 500);
    }

    #[test]
    fn a_hook_from_a_future_version_is_refused_rather_than_guessed_at() {
        let env = Env::default();
        let mut wire = Bytes::new(&env);
        wire.push_back(99);
        wire.append(
            &StellarDestination::account(BytesN::from_array(&env, &[0x41u8; 32])).encode(&env),
        );
        assert_eq!(
            HyperionHook::decode(&env, &wire),
            Err(HyperionError::UnsupportedHookVersion)
        );
    }

    #[test]
    fn an_empty_hook_is_refused() {
        let env = Env::default();
        assert_eq!(
            HyperionHook::decode(&env, &Bytes::new(&env)),
            Err(HyperionError::InvalidDestination)
        );
    }

    #[test]
    fn a_hook_pointing_at_the_zero_address_is_refused() {
        let env = Env::default();
        let mut wire = Bytes::new(&env);
        wire.push_back(HOOK_VERSION);
        wire.append(
            &StellarDestination::account(BytesN::from_array(&env, &[0u8; 32])).encode(&env),
        );
        assert_eq!(
            HyperionHook::decode(&env, &wire),
            Err(HyperionError::ZeroAddressKey)
        );
    }

    #[test]
    fn a_hook_says_whether_the_recipient_has_to_opt_in_first() {
        let env = Env::default();
        let account = HyperionHook::new(StellarDestination::account(BytesN::from_array(
            &env,
            &[0x51u8; 32],
        )));
        let contract = HyperionHook::new(StellarDestination::contract(BytesN::from_array(
            &env,
            &[0x52u8; 32],
        )));
        // A classic account needs a trustline and a contract does not, which decides whether a
        // delivery can go straight through or has to be parked.
        assert!(account.needs_trustline());
        assert!(!contract.needs_trustline());
        assert_eq!(account.kind(), AddressKind::Account);
    }

    #[test]
    fn stellar_is_domain_twenty_seven() {
        // Worth pinning: the whole CCTP integration is wrong in a quiet, funds-losing way if
        // this number drifts.
        assert_eq!(STELLAR_DOMAIN, 27);
    }

    #[test]
    fn unavailable_allowance_cannot_be_mistaken_for_clean_zero() {
        for value in [-1, i128::MIN] {
            let diag = ApprovalDiagnostics::audit(value);
            assert_eq!(diag, ApprovalDiagnostics::unavailable());
            assert!(!diag.is_clean);
            assert_eq!(diag.finding, ApprovalFinding::Unavailable);
        }
        let largest = ApprovalDiagnostics::audit(i128::MAX);
        assert_eq!(largest.allowance, i128::MAX);
        assert_eq!(largest.finding, ApprovalFinding::UnexpectedResidual);
    }

    #[test]
    fn allowance_auditor_reports_clean_when_zero() {
        let diag = ApprovalDiagnostics::audit(0);
        assert_eq!(diag.version, APPROVAL_DIAGNOSTICS_VERSION);
        assert_eq!(diag.allowance, 0);
        assert_eq!(diag.expected_allowance, DOCUMENTED_RESIDUAL_ALLOWANCE);
        assert!(diag.is_clean);
        assert_eq!(diag.finding, ApprovalFinding::Clean);
    }

    #[test]
    fn allowance_auditor_reports_residual_finding_without_mutation() {
        let residual = 12345i128;
        let diag = ApprovalDiagnostics::audit(residual);
        assert_eq!(diag.version, APPROVAL_DIAGNOSTICS_VERSION);
        assert_eq!(diag.allowance, residual);
        assert_eq!(diag.expected_allowance, DOCUMENTED_RESIDUAL_ALLOWANCE);
        assert!(!diag.is_clean);
        assert_eq!(diag.finding, ApprovalFinding::UnexpectedResidual);
    }

    #[test]
    fn burn_boundary_validation_guards_parameters() {
        let env = Env::default();
        let dest = BytesN::from_array(&env, &[0x42u8; 32]);
        let zero_dest = BytesN::from_array(&env, &[0u8; 32]);

        assert!(validate_burn_boundary(1000, &dest, 10, FINALITY_THRESHOLD_FINALIZED).is_ok());
        assert_eq!(
            validate_burn_boundary(0, &dest, 10, FINALITY_THRESHOLD_FINALIZED),
            Err(HyperionError::InvalidAmount)
        );
        assert_eq!(
            validate_burn_boundary(1000, &zero_dest, 10, FINALITY_THRESHOLD_FINALIZED),
            Err(HyperionError::InvalidDestination)
        );
        assert_eq!(
            validate_burn_boundary(1000, &dest, 1000, FINALITY_THRESHOLD_FINALIZED),
            Err(HyperionError::FeeTooHigh)
        );
        assert_eq!(
            validate_burn_boundary(1000, &dest, 10, 0),
            Err(HyperionError::InvalidLimit)
        );
        assert_eq!(
            validate_burn_boundary(1000, &dest, 10, 999),
            Err(HyperionError::InvalidLimit)
        );
        assert!(validate_burn_boundary(1000, &dest, 10, FINALITY_THRESHOLD_FAST).is_ok());
    }

    #[test]
    fn minimum_peer_rotation_delay_is_at_least_one_hour() {
        assert_eq!(MIN_PEER_ROTATION_DELAY, 3_600);
        assert_eq!(DEFAULT_ROTATION_OVERLAP_WINDOW, 86_400);
    }
}
