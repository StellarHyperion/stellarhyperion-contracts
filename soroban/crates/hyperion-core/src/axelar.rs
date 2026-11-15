//! Hyperion's own note, carried in the payload slot the Axelar rails leave open.
//!
//! ITS gives every transfer an optional `data` field. When it is set, the tokens land on the
//! contract named as the destination and that contract gets called back with the data. That is
//! the whole of what Hyperion needs from it: somewhere to say who the money is actually for,
//! because the address ITS delivers to is Hyperion's own contract rather than the person who
//! asked for the transfer.
//!
//! Two shapes, one per direction, because the two directions describe different things. Leaving
//! Stellar the note names an EVM address, which is twenty flat bytes the far side reads with a
//! slice. Arriving on Stellar it names a Stellar destination, and there the note carries a
//! strkey rather than a raw key, for the reason set out in [`crate::strkey`]: the checksum comes
//! free with the format and it catches a flipped bit before anybody gets paid.
//!
//! Both carry the originating router's nonce. No contract needs it. The person watching a
//! transfer in the app does, because it is the one value that appears on both sides of the hop,
//! and it lets an indexer say *this delivery is that transfer* rather than guessing from amounts
//! and timestamps.

use soroban_sdk::{Bytes, BytesN, Env};

use crate::error::HyperionError;
use crate::strkey::{StrkeyDestination, STRKEY_WIRE_LEN_MUXED, STRKEY_WIRE_LEN_PLAIN};

/// Version byte leading every Hyperion note on these rails.
///
/// Shared with [`crate::cctp::HOOK_VERSION`] on purpose. Two rails, one envelope version, so a
/// reader never has to remember which rail numbers its payloads differently from the other.
pub const NOTE_VERSION: u8 = 1;

/// Version, twenty byte address, eight byte nonce.
pub const OUTBOUND_NOTE_LEN: u32 = 29;

/// The shortest an inbound note can be: version, kind, length, a strkey, a nonce.
pub const INBOUND_NOTE_MIN: u32 = 1 + 3 + 8;

/// Eight bytes of big-endian nonce sitting at the end of a note.
const NONCE_LEN: u32 = 8;

/// Exact byte length of an inbound note carrying a plain G or C strkey (`1 + 58 + 8`).
pub const INBOUND_NOTE_PLAIN_LEN: u32 = 1 + STRKEY_WIRE_LEN_PLAIN + NONCE_LEN;

/// Exact byte length of an inbound note carrying a muxed M strkey (`1 + 71 + 8`).
pub const INBOUND_NOTE_MUXED_LEN: u32 = 1 + STRKEY_WIRE_LEN_MUXED + NONCE_LEN;

/// Maximum valid byte length for any inbound note accepted by this version of the protocol.
pub const INBOUND_NOTE_MAX_LEN: u32 = INBOUND_NOTE_MUXED_LEN;

/// What Hyperion says to its own contract on the far side when a transfer leaves Stellar.
///
/// Wire form is `[version][20 byte recipient][8 byte big-endian nonce]`, packed rather than ABI
/// encoded. The consumer is one Solidity function reading three fixed slices, and a packed
/// layout is both cheaper for it and something this crate can write without an ABI encoder.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboundNote {
    /// Who the tokens are for once they arrive.
    pub recipient: BytesN<20>,
    /// The Stellar router's outbound sequence number for this transfer.
    pub nonce: u64,
}

impl OutboundNote {
    pub fn new(recipient: BytesN<20>, nonce: u64) -> Self {
        Self { recipient, nonce }
    }

    pub fn encode(&self, env: &Env) -> Result<Bytes, HyperionError> {
        if self.recipient == BytesN::from_array(env, &[0u8; 20]) {
            return Err(HyperionError::ZeroAddressKey);
        }
        let mut out = Bytes::new(env);
        out.push_back(NOTE_VERSION);
        out.append(&Bytes::from_array(env, &self.recipient.to_array()));
        out.append(&Bytes::from_array(env, &self.nonce.to_be_bytes()));
        Ok(out)
    }

    /// Read a note back, which the Stellar side only ever does in its own tests.
    ///
    /// Kept here rather than in the test module because a format with no decoder is a format
    /// nobody can prove round trips, and this one has to agree with a Solidity reader byte for
    /// byte.
    pub fn decode(env: &Env, raw: &Bytes) -> Result<Self, HyperionError> {
        if raw.len() != OUTBOUND_NOTE_LEN {
            return Err(HyperionError::MalformedMessage);
        }
        if raw.get(0).ok_or(HyperionError::MalformedMessage)? != NOTE_VERSION {
            return Err(HyperionError::UnsupportedHookVersion);
        }
        let mut address = [0u8; 20];
        let mut i = 0u32;
        while i < 20 {
            address[i as usize] = raw.get(1 + i).ok_or(HyperionError::MalformedMessage)?;
            i += 1;
        }
        let note = Self {
            recipient: BytesN::from_array(env, &address),
            nonce: read_nonce(raw, 21)?,
        };
        if note.recipient == BytesN::from_array(env, &[0u8; 20]) {
            return Err(HyperionError::ZeroAddressKey);
        }
        Ok(note)
    }
}

/// What Hyperion's contract on the far side says when a transfer arrives on Stellar.
///
/// Wire form is `[version][StrkeyDestination][8 byte big-endian nonce]`, where the middle part
/// is exactly what [`StrkeyDestination::encode`] produces. Variable length, because a muxed
/// strkey is thirteen characters longer than a plain one, and the length byte inside the
/// destination is what says which.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InboundNote {
    /// Where the tokens go once the adapter has handed them to the router.
    pub destination: StrkeyDestination,
    /// The far side's own sequence number for this transfer.
    pub nonce: u64,
}

impl InboundNote {
    pub fn new(destination: StrkeyDestination, nonce: u64) -> Self {
        Self { destination, nonce }
    }

    pub fn encode(&self, env: &Env) -> Result<Bytes, HyperionError> {
        let mut out = Bytes::new(env);
        out.push_back(NOTE_VERSION);
        out.append(&self.destination.encode(env)?);
        out.append(&Bytes::from_array(env, &self.nonce.to_be_bytes()));
        Ok(out)
    }

    /// Parse a note, refusing a version this build does not understand.
    ///
    /// An unknown version is refused rather than skipped past, for the same reason the CCTP hook
    /// refuses one: a payload we cannot read is a destination we would be guessing at, and
    /// guessing here means paying the wrong person.
    pub fn decode(env: &Env, raw: &Bytes) -> Result<Self, HyperionError> {
        if raw.len() < INBOUND_NOTE_MIN {
            return Err(HyperionError::MalformedMessage);
        }
        if raw.get(0).ok_or(HyperionError::MalformedMessage)? != NOTE_VERSION {
            return Err(HyperionError::UnsupportedHookVersion);
        }
        if raw.len() != INBOUND_NOTE_PLAIN_LEN && raw.len() != INBOUND_NOTE_MUXED_LEN {
            return Err(HyperionError::InvalidDestination);
        }
        let nonce = read_nonce(raw, raw.len() - NONCE_LEN)?;
        let destination = StrkeyDestination::decode(env, &raw.slice(1..raw.len() - NONCE_LEN))?;
        Ok(Self { destination, nonce })
    }

    /// Whether this destination has to opt into the asset before it can be paid.
    pub fn needs_trustline(&self) -> bool {
        self.destination.kind.needs_trustline()
    }
}

/// Eight big-endian bytes starting at `offset`.
fn read_nonce(raw: &Bytes, offset: u32) -> Result<u64, HyperionError> {
    let mut value = 0u64;
    let mut i = 0u32;
    while i < NONCE_LEN {
        let byte = raw.get(offset + i).ok_or(HyperionError::MalformedMessage)? as u64;
        value = (value << 8) | byte;
        i += 1;
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::address::AddressKind;
    use soroban_sdk::{Env, String};

    /// Real strkeys with real checksums, the same ones the strkey module is tested against.
    const G_ADDR: &str = "GA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RLVNR";
    const C_ADDR: &str = "CAGR5KFYMZYI7WWQ6TWYYZ346T7GNZLKER4DOJTAG3SOB46QLR5RAPSN";
    const M_ADDR: &str = "MA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RKABAAAAAAAAAAFLXQ";

    fn evm(env: &Env, last: u8) -> BytesN<20> {
        let mut raw = [0x7Cu8; 20];
        raw[19] = last;
        BytesN::from_array(env, &raw)
    }

    fn inbound(env: &Env, kind: AddressKind, value: &str, nonce: u64) -> InboundNote {
        InboundNote::new(
            StrkeyDestination::new(kind, String::from_str(env, value)),
            nonce,
        )
    }

    #[test]
    fn an_outbound_note_is_twenty_nine_bytes_and_reads_back_field_for_field() {
        let env = Env::default();
        let note = OutboundNote::new(evm(&env, 0x11), 4242);
        let wire = note.encode(&env).unwrap();

        assert_eq!(wire.len(), OUTBOUND_NOTE_LEN);
        assert_eq!(wire.get(0).unwrap(), NOTE_VERSION);
        assert_eq!(OutboundNote::decode(&env, &wire).unwrap(), note);
    }

    #[test]
    fn the_outbound_nonce_sits_big_endian_where_a_solidity_slice_expects_it() {
        let env = Env::default();
        // The far side reads this as `uint64(bytes8(payload[21:29]))`. Spelling the bytes out
        // rather than round tripping is the only way this test would notice an endianness flip.
        let wire = OutboundNote::new(evm(&env, 0x11), 0x0102_0304_0506_0708)
            .encode(&env)
            .unwrap();
        for (i, expected) in [1u8, 2, 3, 4, 5, 6, 7, 8].iter().enumerate() {
            assert_eq!(wire.get(21 + i as u32).unwrap(), *expected);
        }
    }

    #[test]
    fn the_twenty_address_bytes_land_flat_rather_than_padded() {
        let env = Env::default();
        let address = evm(&env, 0x99);
        let wire = OutboundNote::new(address.clone(), 1).encode(&env).unwrap();
        // No left padding, no length prefix. A Solidity reader slicing [1:21] gets the address
        // and nothing else, which is the entire point of a packed layout.
        assert_eq!(
            wire.slice(1..21),
            Bytes::from_array(&env, &address.to_array())
        );
    }

    #[test]
    fn an_outbound_note_naming_nobody_is_refused_on_the_way_out_and_on_the_way_in() {
        let env = Env::default();
        let zero = BytesN::from_array(&env, &[0u8; 20]);
        assert_eq!(
            OutboundNote::new(zero, 1).encode(&env),
            Err(HyperionError::ZeroAddressKey)
        );

        // And built by hand, because a payload arriving from somewhere else was not built by us.
        let mut raw = Bytes::new(&env);
        raw.push_back(NOTE_VERSION);
        raw.append(&Bytes::from_array(&env, &[0u8; 28]));
        assert_eq!(
            OutboundNote::decode(&env, &raw),
            Err(HyperionError::ZeroAddressKey)
        );
    }

    #[test]
    fn an_outbound_note_one_byte_out_is_refused_rather_than_read_past_the_end() {
        let env = Env::default();
        let full = OutboundNote::new(evm(&env, 0x11), 7).encode(&env).unwrap();

        assert_eq!(
            OutboundNote::decode(&env, &full.slice(0..OUTBOUND_NOTE_LEN - 1)),
            Err(HyperionError::MalformedMessage)
        );

        let mut long = full.clone();
        long.push_back(0);
        assert_eq!(
            OutboundNote::decode(&env, &long),
            Err(HyperionError::MalformedMessage)
        );
    }

    #[test]
    fn all_three_kinds_of_stellar_destination_survive_the_inbound_round_trip() {
        let env = Env::default();
        for (kind, value) in [
            (AddressKind::Account, G_ADDR),
            (AddressKind::Contract, C_ADDR),
            (AddressKind::MuxedAccount, M_ADDR),
        ] {
            let note = inbound(&env, kind, value, 11);
            let wire = note.encode(&env).unwrap();
            assert_eq!(InboundNote::decode(&env, &wire).unwrap(), note);
        }
    }

    #[test]
    fn a_muxed_inbound_note_is_longer_and_still_finds_its_nonce() {
        let env = Env::default();
        // The nonce is read from the end rather than a fixed offset, so a destination that
        // changes length must not move it. This is the case that would catch it if it did.
        let plain = inbound(&env, AddressKind::Account, G_ADDR, u64::MAX);
        let muxed = inbound(&env, AddressKind::MuxedAccount, M_ADDR, u64::MAX);
        let plain_wire = plain.encode(&env).unwrap();
        let muxed_wire = muxed.encode(&env).unwrap();

        assert_eq!(muxed_wire.len(), plain_wire.len() + 13);
        assert_eq!(
            InboundNote::decode(&env, &plain_wire).unwrap().nonce,
            u64::MAX
        );
        assert_eq!(
            InboundNote::decode(&env, &muxed_wire).unwrap().nonce,
            u64::MAX
        );
    }

    #[test]
    fn a_note_from_a_version_we_do_not_speak_is_refused_outright() {
        let env = Env::default();
        let mut outbound = OutboundNote::new(evm(&env, 1), 1).encode(&env).unwrap();
        let tail = outbound.slice(1..outbound.len());
        outbound = Bytes::from_array(&env, &[NOTE_VERSION + 1]);
        outbound.append(&tail);
        assert_eq!(
            OutboundNote::decode(&env, &outbound),
            Err(HyperionError::UnsupportedHookVersion)
        );

        let encoded = inbound(&env, AddressKind::Account, G_ADDR, 1)
            .encode(&env)
            .unwrap();
        let mut bumped = Bytes::from_array(&env, &[9u8]);
        bumped.append(&encoded.slice(1..encoded.len()));
        assert_eq!(
            InboundNote::decode(&env, &bumped),
            Err(HyperionError::UnsupportedHookVersion)
        );
    }

    #[test]
    fn a_truncated_inbound_note_never_becomes_a_shorter_valid_one() {
        let env = Env::default();
        let full = inbound(&env, AddressKind::Account, G_ADDR, 5)
            .encode(&env)
            .unwrap();
        // Chop a byte at a time off the end. Every single one of these has to fail, because a
        // strkey that parses after being cut short is a different address than was sent.
        let mut cut = 1u32;
        while cut < full.len() {
            assert!(InboundNote::decode(&env, &full.slice(0..full.len() - cut)).is_err());
            cut += 1;
        }
    }

    #[test]
    fn an_inbound_note_carrying_a_strkey_that_lies_about_its_kind_is_refused() {
        let env = Env::default();
        // A G address tagged as a contract. The checksum is perfect and the string is real; the
        // only thing wrong is that the sender and the address disagree, which is exactly the
        // disagreement a bridge must not resolve on its own.
        let note = inbound(&env, AddressKind::Contract, G_ADDR, 1);
        assert_eq!(note.encode(&env), Err(HyperionError::InvalidDestination));
    }

    #[test]
    fn a_trustline_is_needed_for_the_kinds_that_need_one_and_not_for_contracts() {
        let env = Env::default();
        assert!(inbound(&env, AddressKind::Account, G_ADDR, 1).needs_trustline());
        assert!(inbound(&env, AddressKind::MuxedAccount, M_ADDR, 1).needs_trustline());
        assert!(!inbound(&env, AddressKind::Contract, C_ADDR, 1).needs_trustline());
    }

    #[test]
    fn both_directions_share_the_version_byte_the_cctp_hook_uses() {
        // One envelope version across both rails. If these ever diverge it should be because
        // somebody changed one deliberately, and this is the test that makes them notice.
        assert_eq!(NOTE_VERSION, crate::cctp::HOOK_VERSION);
    }
}
