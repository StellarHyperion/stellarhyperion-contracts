use soroban_sdk::{contracttype, Address, Bytes, Env, MuxedAddress, String};

use crate::address::AddressKind;
use crate::error::HyperionError;

/// Character count of a G or C strkey. One version byte plus a 32 byte payload plus a two
/// byte CRC, base32 encoded without padding.
pub const STRKEY_LEN_PLAIN: u32 = 56;
/// Character count of an M strkey. Same as above with an extra eight byte muxed id folded in.
pub const STRKEY_LEN_MUXED: u32 = 69;
/// Framed wire byte count (`[kind][len][ascii]`) for a plain G or C strkey.
pub const STRKEY_WIRE_LEN_PLAIN: u32 = STRKEY_LEN_PLAIN + 2;
/// Framed wire byte count (`[kind][len][ascii]`) for a muxed M strkey.
pub const STRKEY_WIRE_LEN_MUXED: u32 = STRKEY_LEN_MUXED + 2;

/// A Stellar destination as it travels inside a rail's arbitrary payload field.
///
/// The binary tagged form in [`crate::address`] exists for the places where a bare 32 byte
/// slot is all there is, most notably CCTP's mint recipient. Wherever a rail gives us a real
/// payload to work with, we send the strkey instead, and the reason is worth stating plainly:
/// a strkey already carries a version byte that says which of G, C or M it is, and a CRC16
/// over the whole thing. Handing that straight to `Address::from_string` means the SDK checks
/// the checksum for us. A raw 32 byte key has neither property, so a single flipped bit
/// becomes a mint to an address nobody holds the secret for, and it looks completely valid on
/// the way past.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrkeyDestination {
    /// What the sender believes this address is. Cross-checked against the strkey's own
    /// version character, so a disagreement between the two is caught rather than resolved.
    pub kind: AddressKind,
    pub value: String,
}

fn expected_prefix(kind: AddressKind) -> u8 {
    match kind {
        AddressKind::Account => b'G',
        AddressKind::Contract => b'C',
        AddressKind::MuxedAccount => b'M',
    }
}

fn expected_len(kind: AddressKind) -> u32 {
    match kind {
        AddressKind::Account | AddressKind::Contract => STRKEY_LEN_PLAIN,
        AddressKind::MuxedAccount => STRKEY_LEN_MUXED,
    }
}

/// Base32 alphabet strkeys are encoded with, RFC 4648 without padding.
fn is_base32_char(c: u8) -> bool {
    c.is_ascii_uppercase() || (b'2'..=b'7').contains(&c)
}

impl StrkeyDestination {
    pub fn new(kind: AddressKind, value: String) -> Self {
        Self { kind, value }
    }

    /// Check the strkey is the right length and shape for the kind it claims to be.
    ///
    /// This runs before `Address::from_string` rather than instead of it. The SDK verifies
    /// the checksum; this verifies the sender and the string agree about what is being
    /// described, which the checksum cannot tell you.
    pub fn validate(&self) -> Result<(), HyperionError> {
        let len = self.value.len();
        if len != expected_len(self.kind) {
            return Err(HyperionError::InvalidDestination);
        }
        if len > STRKEY_LEN_MUXED {
            return Err(HyperionError::InvalidDestination);
        }

        let mut buf = [0u8; STRKEY_LEN_MUXED as usize];
        let slice = &mut buf[..len as usize];
        self.value.copy_into_slice(slice);

        if slice[0] != expected_prefix(self.kind) {
            return Err(HyperionError::InvalidDestination);
        }
        for c in slice.iter() {
            if !is_base32_char(*c) {
                return Err(HyperionError::InvalidDestination);
            }
        }
        Ok(())
    }

    /// Serialise as `[kind byte][length byte][ascii strkey]`.
    ///
    /// One byte of length is enough forever: the longest strkey Stellar defines is 69
    /// characters and this refuses anything else anyway.
    pub fn encode(&self, env: &Env) -> Result<Bytes, HyperionError> {
        self.validate()?;
        let len = self.value.len();
        let mut out = Bytes::new(env);
        out.push_back(self.kind.tag());
        out.push_back(len as u8);

        let mut buf = [0u8; STRKEY_LEN_MUXED as usize];
        let slice = &mut buf[..len as usize];
        self.value.copy_into_slice(slice);
        out.append(&Bytes::from_slice(env, slice));
        Ok(out)
    }

    /// Parse the wire form back out, validating as it goes.
    pub fn decode(env: &Env, raw: &Bytes) -> Result<Self, HyperionError> {
        if raw.len() < 3 {
            return Err(HyperionError::InvalidDestination);
        }
        let kind = AddressKind::from_tag(raw.get(0).ok_or(HyperionError::InvalidDestination)?)
            .ok_or(HyperionError::InvalidDestination)?;
        let len = raw.get(1).ok_or(HyperionError::InvalidDestination)? as u32;
        if len > STRKEY_LEN_MUXED || raw.len() != len + 2 {
            return Err(HyperionError::InvalidDestination);
        }

        let mut buf = [0u8; STRKEY_LEN_MUXED as usize];
        let mut i = 0u32;
        while i < len {
            buf[i as usize] = raw.get(2 + i).ok_or(HyperionError::InvalidDestination)?;
            i += 1;
        }
        let value = String::from_bytes(env, &buf[..len as usize]);
        let dest = Self { kind, value };
        dest.validate()?;
        Ok(dest)
    }

    /// The address funds should actually be sent to.
    ///
    /// A muxed destination collapses to its underlying account, exactly as it does in
    /// [`crate::address::StellarDestination::to_address`]. The muxed id is a routing hint for
    /// whoever operates that account rather than a balance of its own, so the transfer lands on
    /// the base account either way and the id travels in the event trail.
    ///
    /// The host parses the string here, which means it checks the CRC. That is the whole reason
    /// this wire format carries a strkey rather than a raw key.
    pub fn to_address(&self, env: &Env) -> Result<Address, HyperionError> {
        self.validate()?;
        let _ = env;
        Ok(match self.kind {
            AddressKind::MuxedAccount => MuxedAddress::from_string(&self.value).address(),
            _ => Address::from_string(&self.value),
        })
    }

    /// The muxed form, for the places that can carry a subaccount id through.
    pub fn to_muxed(&self, env: &Env) -> Result<MuxedAddress, HyperionError> {
        self.validate()?;
        let _ = env;
        Ok(match self.kind {
            AddressKind::MuxedAccount => MuxedAddress::from_string(&self.value),
            _ => Address::from_string(&self.value).into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    // Real strkeys, checksums and all. Generated with the Stellar CLI so the shapes here are
    // the shapes the network actually produces.
    const G_ADDR: &str = "GA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RLVNR";
    const C_ADDR: &str = "CAGR5KFYMZYI7WWQ6TWYYZ346T7GNZLKER4DOJTAG3SOB46QLR5RAPSN";
    const M_ADDR: &str = "MA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RKABAAAAAAAAAAFLXQ";

    #[test]
    fn the_reference_strkeys_are_the_lengths_the_protocol_defines() {
        assert_eq!(G_ADDR.len() as u32, STRKEY_LEN_PLAIN);
        assert_eq!(C_ADDR.len() as u32, STRKEY_LEN_PLAIN);
        assert_eq!(M_ADDR.len() as u32, STRKEY_LEN_MUXED);
    }

    #[test]
    fn a_classic_account_strkey_round_trips() {
        let env = Env::default();
        let dest = StrkeyDestination::new(AddressKind::Account, String::from_str(&env, G_ADDR));
        let wire = dest.encode(&env).unwrap();
        assert_eq!(wire.len(), STRKEY_LEN_PLAIN + 2);
        assert_eq!(StrkeyDestination::decode(&env, &wire).unwrap(), dest);
    }

    #[test]
    fn a_contract_strkey_round_trips() {
        let env = Env::default();
        let dest = StrkeyDestination::new(AddressKind::Contract, String::from_str(&env, C_ADDR));
        let wire = dest.encode(&env).unwrap();
        assert_eq!(StrkeyDestination::decode(&env, &wire).unwrap(), dest);
    }

    #[test]
    fn a_muxed_strkey_round_trips_and_is_longer() {
        let env = Env::default();
        let dest =
            StrkeyDestination::new(AddressKind::MuxedAccount, String::from_str(&env, M_ADDR));
        let wire = dest.encode(&env).unwrap();
        assert_eq!(wire.len(), STRKEY_LEN_MUXED + 2);
        assert_eq!(StrkeyDestination::decode(&env, &wire).unwrap(), dest);
    }

    #[test]
    fn the_sdk_accepts_what_we_validated() {
        // The point of sending a strkey rather than a raw key: this call does the checksum
        // work, and it only gets reached for strings that already passed our shape check.
        let env = Env::default();
        let dest = StrkeyDestination::new(AddressKind::Account, String::from_str(&env, G_ADDR));
        dest.validate().unwrap();
        let addr = Address::from_string(&dest.value);
        assert_eq!(addr.to_string(), dest.value);
    }

    #[test]
    fn a_contract_strkey_also_survives_the_sdk() {
        let env = Env::default();
        let dest = StrkeyDestination::new(AddressKind::Contract, String::from_str(&env, C_ADDR));
        dest.validate().unwrap();
        assert_eq!(Address::from_string(&dest.value).to_string(), dest.value);
    }

    #[test]
    fn an_sdk_generated_address_passes_our_own_validation() {
        // Whatever the test environment hands out should satisfy the same rules as the
        // reference strings above.
        let env = Env::default();
        let generated = Address::generate(&env).to_string();
        let mut buf = [0u8; STRKEY_LEN_MUXED as usize];
        generated.copy_into_slice(&mut buf[..generated.len() as usize]);
        let kind = match buf[0] {
            b'G' => AddressKind::Account,
            b'C' => AddressKind::Contract,
            other => panic!("unexpected generated prefix {}", other as char),
        };
        StrkeyDestination::new(kind, generated).validate().unwrap();
    }

    #[test]
    fn claiming_to_be_a_contract_while_sending_an_account_is_caught() {
        let env = Env::default();
        let lying = StrkeyDestination::new(AddressKind::Contract, String::from_str(&env, G_ADDR));
        assert_eq!(lying.validate(), Err(HyperionError::InvalidDestination));
    }

    #[test]
    fn claiming_to_be_muxed_while_sending_a_plain_account_is_caught_on_length() {
        let env = Env::default();
        let lying =
            StrkeyDestination::new(AddressKind::MuxedAccount, String::from_str(&env, G_ADDR));
        assert_eq!(lying.validate(), Err(HyperionError::InvalidDestination));
    }

    #[test]
    fn a_truncated_strkey_is_refused() {
        let env = Env::default();
        let short = StrkeyDestination::new(
            AddressKind::Account,
            String::from_str(
                &env,
                "GA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RLVN",
            ),
        );
        assert_eq!(short.validate(), Err(HyperionError::InvalidDestination));
    }

    #[test]
    fn lowercase_is_refused_because_strkeys_are_not_lowercase() {
        let env = Env::default();
        let lower = StrkeyDestination::new(
            AddressKind::Account,
            String::from_str(
                &env,
                "ga5zyiivydx5grf2bkeqd2y47zcpg3hx3puunpvq5zecb57mjg7rlvnr",
            ),
        );
        assert_eq!(lower.validate(), Err(HyperionError::InvalidDestination));
    }

    #[test]
    fn digits_outside_the_base32_alphabet_are_refused() {
        let env = Env::default();
        // 0, 1, 8 and 9 are not in the RFC 4648 base32 alphabet.
        let bad = StrkeyDestination::new(
            AddressKind::Account,
            String::from_str(
                &env,
                "G01ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RL189",
            ),
        );
        assert_eq!(bad.validate(), Err(HyperionError::InvalidDestination));
    }

    #[test]
    fn an_evm_style_hex_address_is_refused_outright() {
        let env = Env::default();
        let evm = StrkeyDestination::new(
            AddressKind::Account,
            String::from_str(&env, "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"),
        );
        assert_eq!(evm.validate(), Err(HyperionError::InvalidDestination));
    }

    #[test]
    fn a_wire_payload_whose_length_byte_lies_is_refused() {
        let env = Env::default();
        let mut wire = Bytes::new(&env);
        wire.push_back(AddressKind::Account.tag());
        wire.push_back(56);
        wire.append(&Bytes::from_slice(&env, b"GA5ZYIIVYDX5GRF2BKEQD2Y4"));
        assert_eq!(
            StrkeyDestination::decode(&env, &wire),
            Err(HyperionError::InvalidDestination)
        );
    }

    #[test]
    fn an_empty_wire_payload_is_refused() {
        let env = Env::default();
        assert_eq!(
            StrkeyDestination::decode(&env, &Bytes::new(&env)),
            Err(HyperionError::InvalidDestination)
        );
    }

    #[test]
    fn an_unknown_kind_byte_on_the_wire_is_refused() {
        let env = Env::default();
        let mut wire = Bytes::new(&env);
        wire.push_back(7);
        wire.push_back(56);
        wire.append(&Bytes::from_slice(&env, G_ADDR.as_bytes()));
        assert_eq!(
            StrkeyDestination::decode(&env, &wire),
            Err(HyperionError::InvalidDestination)
        );
    }

    #[test]
    fn a_length_byte_beyond_the_longest_strkey_is_refused() {
        let env = Env::default();
        let mut wire = Bytes::new(&env);
        wire.push_back(AddressKind::Account.tag());
        wire.push_back(200);
        wire.append(&Bytes::from_slice(&env, G_ADDR.as_bytes()));
        assert_eq!(
            StrkeyDestination::decode(&env, &wire),
            Err(HyperionError::InvalidDestination)
        );
    }
    #[test]
    fn every_kind_resolves_to_an_address_the_host_agrees_with() {
        let env = Env::default();
        for (kind, value) in [
            (AddressKind::Account, G_ADDR),
            (AddressKind::Contract, C_ADDR),
        ] {
            let dest = StrkeyDestination::new(kind, String::from_str(&env, value));
            assert_eq!(dest.to_address(&env).unwrap().to_string(), dest.value);
        }
    }

    #[test]
    fn a_muxed_destination_collapses_to_the_account_underneath_it() {
        let env = Env::default();
        let muxed =
            StrkeyDestination::new(AddressKind::MuxedAccount, String::from_str(&env, M_ADDR));
        let plain = StrkeyDestination::new(AddressKind::Account, String::from_str(&env, G_ADDR));

        // The M form and the G form above are the same key, so the money goes to the same place.
        // Two virtual subaccounts of one exchange account are not two balances.
        assert_eq!(
            muxed.to_address(&env).unwrap(),
            plain.to_address(&env).unwrap()
        );
        // The id survives the muxed form and is simply absent from the plain one.
        assert_eq!(
            muxed.to_muxed(&env).unwrap().id(),
            Some(9_007_199_254_740_993)
        );
        assert_eq!(plain.to_muxed(&env).unwrap().id(), None);
    }

    #[test]
    fn a_destination_that_fails_validation_never_produces_an_address() {
        let env = Env::default();
        // Resolving before validating would hand the host a string it might well accept, and the
        // disagreement about what kind of thing it is would go unnoticed.
        let lying = StrkeyDestination::new(AddressKind::Contract, String::from_str(&env, G_ADDR));
        assert_eq!(
            lying.to_address(&env),
            Err(HyperionError::InvalidDestination)
        );
        assert_eq!(lying.to_muxed(&env), Err(HyperionError::InvalidDestination));
    }
}
