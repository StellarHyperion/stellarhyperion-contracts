//! Cross-language malformed-message corpus runner (Rust / Soroban side).
//!
//! Reads `packages/protocol/test/fixtures/malformed-message-corpus.v1.json` directly and executes
//! every vector against `hyperion_core`'s real wire-format decoders (`OutboundNote::decode`,
//! `InboundNote::decode`, `StrkeyDestination` + host `to_muxed` + `codec::address_key`,
//! `address::bytes32_to_evm`, `HyperionHook::decode`, `CctpMessage::parse`, and
//! `BurnMessage::parse`), asserting exact agreement with the versioned corpus expectations.

use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use soroban_sdk::{Bytes, BytesN, Env, String as SorobanString};

use crate::address::{bytes32_to_evm, AddressKind};
use crate::axelar::{InboundNote, OutboundNote, NOTE_VERSION};
use crate::cctp::{
    BurnMessage, CctpMessage, HyperionHook, BURN_MESSAGE_VERSION, HOOK_VERSION, MESSAGE_VERSION,
};
use crate::codec;
use crate::error::HyperionError;
use crate::strkey::StrkeyDestination;

const CORPUS_JSON: &str =
    include_str!("../../../../packages/protocol/test/fixtures/malformed-message-corpus.v1.json");

#[derive(Clone, Debug, PartialEq, Eq)]
enum JsonVal {
    Null,
    Bool(bool),
    Num(i64),
    Str(String),
    Arr(Vec<JsonVal>),
    Obj(BTreeMap<String, JsonVal>),
}

impl JsonVal {
    fn as_obj(&self) -> &BTreeMap<String, JsonVal> {
        match self {
            Self::Obj(m) => m,
            other => panic!("expected JSON object, got {other:?}"),
        }
    }

    fn as_arr(&self) -> &[JsonVal] {
        match self {
            Self::Arr(v) => v,
            other => panic!("expected JSON array, got {other:?}"),
        }
    }

    fn as_str(&self) -> &str {
        match self {
            Self::Str(s) => s,
            other => panic!("expected JSON string, got {other:?}"),
        }
    }

    fn as_i64(&self) -> i64 {
        match self {
            Self::Num(n) => *n,
            other => panic!("expected JSON integer, got {other:?}"),
        }
    }

    fn as_bool(&self) -> bool {
        match self {
            Self::Bool(b) => *b,
            other => panic!("expected JSON boolean, got {other:?}"),
        }
    }
}

struct JsonParser<'a> {
    src: &'a [u8],
    pos: usize,
}

impl<'a> JsonParser<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            src: input.as_bytes(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.src.len() && self.src[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.src.get(self.pos).copied()
    }

    fn expect_byte(&mut self, expected: u8) {
        self.skip_ws();
        let found = self.src.get(self.pos).copied();
        assert_eq!(
            found,
            Some(expected),
            "expected '{}' at byte {}",
            expected as char,
            self.pos
        );
        self.pos += 1;
    }

    fn parse_value(&mut self) -> JsonVal {
        match self.peek().expect("unexpected EOF in corpus JSON") {
            b'{' => self.parse_object(),
            b'[' => self.parse_array(),
            b'"' => JsonVal::Str(self.parse_string()),
            b't' => {
                assert_eq!(&self.src[self.pos..self.pos + 4], b"true");
                self.pos += 4;
                JsonVal::Bool(true)
            }
            b'f' => {
                assert_eq!(&self.src[self.pos..self.pos + 5], b"false");
                self.pos += 5;
                JsonVal::Bool(false)
            }
            b'n' => {
                assert_eq!(&self.src[self.pos..self.pos + 4], b"null");
                self.pos += 4;
                JsonVal::Null
            }
            b'-' | b'0'..=b'9' => self.parse_number(),
            other => panic!("unexpected byte '{}' at {}", other as char, self.pos),
        }
    }

    fn parse_object(&mut self) -> JsonVal {
        self.expect_byte(b'{');
        let mut map = BTreeMap::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return JsonVal::Obj(map);
        }
        loop {
            let key = self.parse_string();
            self.expect_byte(b':');
            let val = self.parse_value();
            map.insert(key, val);
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                other => panic!("unexpected object separator {other:?} at {}", self.pos),
            }
        }
        JsonVal::Obj(map)
    }

    fn parse_array(&mut self) -> JsonVal {
        self.expect_byte(b'[');
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return JsonVal::Arr(items);
        }
        loop {
            items.push(self.parse_value());
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                other => panic!("unexpected array separator {other:?} at {}", self.pos),
            }
        }
        JsonVal::Arr(items)
    }

    fn parse_string(&mut self) -> String {
        self.expect_byte(b'"');
        let mut out = String::new();
        while self.pos < self.src.len() {
            let b = self.src[self.pos];
            self.pos += 1;
            match b {
                b'"' => return out,
                b'\\' => {
                    let esc = self.src[self.pos];
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        other => panic!("unsupported escape \\{}", other as char),
                    }
                }
                other => out.push(other as char),
            }
        }
        panic!("unterminated JSON string");
    }

    fn parse_number(&mut self) -> JsonVal {
        self.skip_ws();
        let start = self.pos;
        if self.src.get(self.pos) == Some(&b'-') {
            self.pos += 1;
        }
        while let Some(b'0'..=b'9') = self.src.get(self.pos) {
            self.pos += 1;
        }
        let text = std::str::from_utf8(&self.src[start..self.pos]).expect("utf8 integer");
        JsonVal::Num(text.parse::<i64>().expect("i64 integer"))
    }
}

fn decode_hex(input: &str) -> Vec<u8> {
    let body = input.strip_prefix("0x").unwrap_or(input);
    assert_eq!(body.len() % 2, 0, "odd hex length in {input}");
    let mut out = Vec::with_capacity(body.len() / 2);
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16).expect("hex digit");
        let lo = (bytes[i + 1] as char).to_digit(16).expect("hex digit");
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    out
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn error_name(err: HyperionError) -> &'static str {
    match err {
        HyperionError::AlreadyInitialized => "AlreadyInitialized",
        HyperionError::NotInitialized => "NotInitialized",
        HyperionError::Unauthorized => "Unauthorized",
        HyperionError::NotRailReceiver => "NotRailReceiver",
        HyperionError::Paused => "Paused",
        HyperionError::RouteDisabled => "RouteDisabled",
        HyperionError::AdapterNotSet => "AdapterNotSet",
        HyperionError::FlowLimitExceeded => "FlowLimitExceeded",
        HyperionError::InvalidAmount => "InvalidAmount",
        HyperionError::AmountNotRepresentable => "AmountNotRepresentable",
        HyperionError::DecimalOverflow => "DecimalOverflow",
        HyperionError::InvalidDecimals => "InvalidDecimals",
        HyperionError::SlippageExceeded => "SlippageExceeded",
        HyperionError::FeeTooHigh => "FeeTooHigh",
        HyperionError::InvalidDestination => "InvalidDestination",
        HyperionError::ZeroAddressKey => "ZeroAddressKey",
        HyperionError::MuxedNotSupported => "MuxedNotSupported",
        HyperionError::NotEvmAddress => "NotEvmAddress",
        HyperionError::UnknownChain => "UnknownChain",
        HyperionError::ReplayedMessage => "ReplayedMessage",
        HyperionError::UnknownNonce => "UnknownNonce",
        HyperionError::TimelockNotQueued => "TimelockNotQueued",
        HyperionError::TimelockNotReady => "TimelockNotReady",
        HyperionError::TimelockExpired => "TimelockExpired",
        HyperionError::TimelockDelayOutOfRange => "TimelockDelayOutOfRange",
        HyperionError::ClaimNotFound => "ClaimNotFound",
        HyperionError::ClaimAlreadySettled => "ClaimAlreadySettled",
        HyperionError::RecipientNotReady => "RecipientNotReady",
        HyperionError::InvalidLimit => "InvalidLimit",
        HyperionError::InvalidWindow => "InvalidWindow",
        HyperionError::TokenNotRegistered => "TokenNotRegistered",
        HyperionError::MalformedMessage => "MalformedMessage",
        HyperionError::UnsupportedHookVersion => "UnsupportedHookVersion",
        HyperionError::RailNotConfigured => "RailNotConfigured",
        HyperionError::WrongDomain => "WrongDomain",
        HyperionError::NotMintRecipient => "NotMintRecipient",
        HyperionError::UnexpectedRailContract => "UnexpectedRailContract",
        HyperionError::NothingMinted => "NothingMinted",
        HyperionError::TokenNotMapped => "TokenNotMapped",
        HyperionError::AlreadyConfigured => "AlreadyConfigured",
        HyperionError::InsufficientLiquidity => "InsufficientLiquidity",
        HyperionError::UnsupportedMessageVersion => "UnsupportedMessageVersion",
        HyperionError::NotTheRail => "NotTheRail",
        HyperionError::UnsupportedRoute => "UnsupportedRoute",
        HyperionError::GasFloatTooLow => "GasFloatTooLow",
        HyperionError::ProtectedAsset => "ProtectedAsset",
        HyperionError::ExceedsRouteLimit => "ExceedsRouteLimit",
    }
}

fn soroban_string_to_std(value: &SorobanString) -> String {
    let mut buf = vec![0u8; value.len() as usize];
    value.copy_into_slice(&mut buf);
    String::from_utf8(buf).expect("ascii strkey")
}

#[derive(Debug, PartialEq, Eq)]
enum RustOutcome {
    Accept(BTreeMap<String, JsonVal>),
    Reject(String),
}

fn run_rust_decoder(format: &str, raw_bytes: &[u8]) -> RustOutcome {
    let env = Env::default();
    let bytes = Bytes::from_slice(&env, raw_bytes);

    match format {
        "outbound_note" => match OutboundNote::decode(&env, &bytes) {
            Ok(note) => {
                let mut m = BTreeMap::new();
                m.insert("format".into(), JsonVal::Str("outbound_note".into()));
                m.insert("version".into(), JsonVal::Num(i64::from(NOTE_VERSION)));
                m.insert(
                    "recipient".into(),
                    JsonVal::Str(encode_hex(&note.recipient.to_array())),
                );
                m.insert("nonce".into(), JsonVal::Str(note.nonce.to_string()));
                RustOutcome::Accept(m)
            }
            Err(err) => RustOutcome::Reject(error_name(err).into()),
        },
        "inbound_note" => match InboundNote::decode(&env, &bytes) {
            Ok(note) => {
                let mut m = BTreeMap::new();
                m.insert("format".into(), JsonVal::Str("inbound_note".into()));
                m.insert("version".into(), JsonVal::Num(i64::from(NOTE_VERSION)));
                m.insert(
                    "addressKind".into(),
                    JsonVal::Num(i64::from(note.destination.kind.tag())),
                );
                m.insert(
                    "strkey".into(),
                    JsonVal::Str(soroban_string_to_std(&note.destination.value)),
                );
                m.insert("nonce".into(), JsonVal::Str(note.nonce.to_string()));
                RustOutcome::Accept(m)
            }
            Err(err) => RustOutcome::Reject(error_name(err).into()),
        },
        "stellar_strkey" => {
            if raw_bytes.is_empty() || raw_bytes.iter().any(|b| !b.is_ascii()) {
                return RustOutcome::Reject("InvalidDestination".into());
            }
            let kind = match raw_bytes[0] {
                b'G' => AddressKind::Account,
                b'C' => AddressKind::Contract,
                b'M' => AddressKind::MuxedAccount,
                _ => return RustOutcome::Reject("InvalidDestination".into()),
            };
            let dest = StrkeyDestination::new(kind, SorobanString::from_bytes(&env, raw_bytes));
            if let Err(err) = dest.validate() {
                return RustOutcome::Reject(error_name(err).into());
            }
            // Host `from_string` enforces SEP-23 CRC16 and canonical spare-bit rules by trapping
            // invalid strings, so catch_unwind maps host rejection to InvalidDestination.
            let host_resolved = catch_unwind(AssertUnwindSafe(|| -> Result<_, HyperionError> {
                let muxed = dest.to_muxed(&env)?;
                // Verify round-trip canonical encoding so non-zero spare bits never slip past if a
                // host implementation ignores trailing padding bits.
                if kind == AddressKind::MuxedAccount && muxed.to_strkey() != dest.value {
                    return Err(HyperionError::InvalidDestination);
                }
                let base_addr = muxed.address();
                if kind != AddressKind::MuxedAccount && base_addr.to_string() != dest.value {
                    return Err(HyperionError::InvalidDestination);
                }
                let (_, key) = codec::address_key(&env, &base_addr)?;
                if key == [0u8; 32] {
                    return Err(HyperionError::ZeroAddressKey);
                }
                let muxed_id = muxed.id().unwrap_or(0);
                Ok((key, muxed_id))
            }));
            match host_resolved {
                Ok(Ok((key, muxed_id))) => {
                    let mut m = BTreeMap::new();
                    m.insert("format".into(), JsonVal::Str("stellar_strkey".into()));
                    m.insert("addressKind".into(), JsonVal::Num(i64::from(kind.tag())));
                    m.insert("key".into(), JsonVal::Str(encode_hex(&key)));
                    m.insert("muxedId".into(), JsonVal::Str(muxed_id.to_string()));
                    RustOutcome::Accept(m)
                }
                Ok(Err(err)) => RustOutcome::Reject(error_name(err).into()),
                Err(_) => RustOutcome::Reject("InvalidDestination".into()),
            }
        }
        "evm_word" => {
            if raw_bytes.len() != 32 {
                return RustOutcome::Reject("MalformedMessage".into());
            }
            let mut word = [0u8; 32];
            word.copy_from_slice(raw_bytes);
            match bytes32_to_evm(&env, &BytesN::from_array(&env, &word)) {
                Ok(addr) => {
                    let mut m = BTreeMap::new();
                    m.insert("format".into(), JsonVal::Str("evm_word".into()));
                    m.insert("address".into(), JsonVal::Str(encode_hex(&addr.to_array())));
                    RustOutcome::Accept(m)
                }
                Err(err) => RustOutcome::Reject(error_name(err).into()),
            }
        }
        "cctp_hook" => match HyperionHook::decode(&env, &bytes) {
            Ok(hook) => {
                let mut m = BTreeMap::new();
                m.insert("format".into(), JsonVal::Str("cctp_hook".into()));
                m.insert("version".into(), JsonVal::Num(i64::from(HOOK_VERSION)));
                m.insert(
                    "addressKind".into(),
                    JsonVal::Num(i64::from(hook.destination.kind.tag())),
                );
                m.insert(
                    "key".into(),
                    JsonVal::Str(encode_hex(&hook.destination.key.to_array())),
                );
                m.insert(
                    "muxedId".into(),
                    JsonVal::Str(hook.destination.muxed_id.to_string()),
                );
                RustOutcome::Accept(m)
            }
            Err(err) => RustOutcome::Reject(error_name(err).into()),
        },
        "cctp_burn_envelope" => {
            let parsed = (|| -> Result<BTreeMap<String, JsonVal>, HyperionError> {
                let header = CctpMessage::parse(&env, &bytes)?;
                if header.version != MESSAGE_VERSION {
                    return Err(HyperionError::UnsupportedMessageVersion);
                }
                let body = CctpMessage::body(&bytes)?;
                let burn = BurnMessage::parse(&env, &body)?;
                if burn.version != BURN_MESSAGE_VERSION {
                    return Err(HyperionError::UnsupportedMessageVersion);
                }
                let hook_bytes = BurnMessage::hook_data(&body)?;
                let mut m = BTreeMap::new();
                m.insert("format".into(), JsonVal::Str("cctp_burn_envelope".into()));
                m.insert(
                    "messageVersion".into(),
                    JsonVal::Num(i64::from(header.version)),
                );
                m.insert("burnVersion".into(), JsonVal::Num(i64::from(burn.version)));
                m.insert(
                    "sourceDomain".into(),
                    JsonVal::Num(i64::from(header.source_domain)),
                );
                m.insert(
                    "destinationDomain".into(),
                    JsonVal::Num(i64::from(header.destination_domain)),
                );
                m.insert(
                    "displayNonce".into(),
                    JsonVal::Str(header.display_nonce().to_string()),
                );
                m.insert("isFinalized".into(), JsonVal::Bool(header.is_finalized()));
                m.insert("amount".into(), JsonVal::Str(burn.amount.to_string()));
                m.insert("maxFee".into(), JsonVal::Str(burn.max_fee.to_string()));
                m.insert(
                    "feeExecuted".into(),
                    JsonVal::Str(burn.fee_executed.to_string()),
                );
                m.insert(
                    "expirationBlock".into(),
                    JsonVal::Str(burn.expiration_block.to_string()),
                );
                if hook_bytes.is_empty() {
                    m.insert("hookPresent".into(), JsonVal::Bool(false));
                    m.insert("hookKind".into(), JsonVal::Null);
                    m.insert("hookKey".into(), JsonVal::Null);
                    m.insert("hookMuxedId".into(), JsonVal::Null);
                } else {
                    let hook = HyperionHook::decode(&env, &hook_bytes)?;
                    m.insert("hookPresent".into(), JsonVal::Bool(true));
                    m.insert(
                        "hookKind".into(),
                        JsonVal::Num(i64::from(hook.destination.kind.tag())),
                    );
                    m.insert(
                        "hookKey".into(),
                        JsonVal::Str(encode_hex(&hook.destination.key.to_array())),
                    );
                    m.insert(
                        "hookMuxedId".into(),
                        JsonVal::Str(hook.destination.muxed_id.to_string()),
                    );
                }
                Ok(m)
            })();
            match parsed {
                Ok(m) => RustOutcome::Accept(m),
                Err(err) => RustOutcome::Reject(error_name(err).into()),
            }
        }
        other => panic!("unsupported corpus format: {other}"),
    }
}

#[test]
fn rust_decoders_match_versioned_malformed_message_corpus() {
    let mut parser = JsonParser::new(CORPUS_JSON);
    let root = parser.parse_value();
    let root_obj = root.as_obj();

    assert_eq!(root_obj["corpusVersion"].as_i64(), 1);
    let cases = root_obj["cases"].as_arr();
    assert!(!cases.is_empty(), "corpus must contain cases");

    let mut checked = 0usize;
    let mut legacy_accepted_checked = 0usize;

    for item in cases {
        let case_obj = item.as_obj();
        let id = case_obj["id"].as_str();
        let format = case_obj["format"].as_str();
        let hex_bytes = case_obj["hexBytes"].as_str();
        let legacy_accepted = case_obj["legacyAccepted"].as_bool();
        let expected_map = case_obj["expected"].as_obj();

        let Some(expected_rust) = expected_map.get("rust") else {
            continue;
        };
        let expected_obj = expected_rust.as_obj();
        let expected = match expected_obj["status"].as_str() {
            "accept" => RustOutcome::Accept(expected_obj["decoded"].as_obj().clone()),
            "reject" => RustOutcome::Reject(expected_obj["errorCode"].as_str().to_owned()),
            other => panic!("unexpected status {other} in {id}"),
        };

        let raw = decode_hex(hex_bytes);
        let actual = run_rust_decoder(format, &raw);
        assert_eq!(
            actual, expected,
            "Rust decoder divergence on case={id} format={format} bytes={hex_bytes}"
        );

        if legacy_accepted {
            assert!(
                matches!(actual, RustOutcome::Accept(_)),
                "legacyAccepted case {id} must be accepted by Rust"
            );
            legacy_accepted_checked += 1;
        }
        checked += 1;
    }

    assert!(
        checked >= 40,
        "expected >= 40 Rust corpus vectors, got {checked}"
    );
    assert!(
        legacy_accepted_checked >= 12,
        "expected >= 12 legacyAccepted vectors, got {legacy_accepted_checked}"
    );
}
