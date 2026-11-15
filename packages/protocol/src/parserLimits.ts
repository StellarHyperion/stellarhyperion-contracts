/**
 * Cross-stack byte ceilings and parser failure taxonomy across Soroban Rust, EVM Solidity, and
 * `@hyperion/protocol`.
 *
 * Kept in the shared protocol package so stress suites and documentation reports compare one
 * canonical table against all three implementations rather than re-transcribing magic lengths.
 */
import {
  STRKEY_LEN_MUXED,
  STRKEY_LEN_PLAIN,
  TAGGED_LEN_MUXED,
  TAGGED_LEN_PLAIN,
} from "./addresses.js";
import { BURN_HOOK_DATA, MSG_BODY } from "./cctp.js";
import {
  HOOK_LEN_MUXED,
  HOOK_LEN_PLAIN,
  INBOUND_NOTE_MIN,
  INBOUND_NOTE_MUXED_LEN,
  INBOUND_NOTE_PLAIN_LEN,
  OUTBOUND_NOTE_LEN,
} from "./notes.js";

export type ParserSurfaceId =
  | "outbound_note"
  | "inbound_note"
  | "strkey_ascii"
  | "strkey_wire"
  | "tagged_destination"
  | "cctp_header"
  | "cctp_burn_body"
  | "cctp_hook"
  | "evm_address_word"
  | "queued_admin_action";

export interface StackParserBehavior {
  readonly entrypoint: string;
  readonly acceptedByteLengths: readonly number[];
  readonly maxAcceptedBytes: number;
  readonly oversizedError: string;
  readonly complexityOnOversized: "O(1)" | "bounded-xdr";
  readonly notes: string;
}

export interface ParserLimitEntry {
  readonly id: ParserSurfaceId;
  readonly title: string;
  readonly rust: StackParserBehavior;
  readonly solidity: StackParserBehavior;
  readonly sdk: StackParserBehavior;
}

export const PARSER_STRESS_SIZES = [256, 4_096, 16_384, 65_536] as const;

export const PARSER_LIMITS_MATRIX: readonly ParserLimitEntry[] = [
  {
    id: "outbound_note",
    title: "Outbound note ([version][20B EVM][8B nonce])",
    rust: {
      entrypoint: "hyperion_core::axelar::OutboundNote::decode",
      acceptedByteLengths: [OUTBOUND_NOTE_LEN],
      maxAcceptedBytes: OUTBOUND_NOTE_LEN,
      oversizedError: "MalformedMessage",
      complexityOnOversized: "O(1)",
      notes: "Exact 29-byte equality check before reading version, address, or nonce.",
    },
    solidity: {
      entrypoint: "HyperionNotes.decodeOutboundNote",
      acceptedByteLengths: [OUTBOUND_NOTE_LEN],
      maxAcceptedBytes: OUTBOUND_NOTE_LEN,
      oversizedError: "MalformedMessage",
      complexityOnOversized: "O(1)",
      notes: "Exact calldata length check before fixed slice reads.",
    },
    sdk: {
      entrypoint: "decodeOutboundNote",
      acceptedByteLengths: [OUTBOUND_NOTE_LEN],
      maxAcceptedBytes: OUTBOUND_NOTE_LEN,
      oversizedError: "MalformedMessage",
      complexityOnOversized: "O(1)",
      notes: "Exact 29-byte length check before slicing recipient or nonce.",
    },
  },
  {
    id: "inbound_note",
    title: "Inbound note ([version][kind][len][strkey][8B nonce])",
    rust: {
      entrypoint: "hyperion_core::axelar::InboundNote::decode",
      acceptedByteLengths: [INBOUND_NOTE_PLAIN_LEN, INBOUND_NOTE_MUXED_LEN],
      maxAcceptedBytes: INBOUND_NOTE_MUXED_LEN,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes: `Rejects < ${String(INBOUND_NOTE_MIN)}B with MalformedMessage and != 67/80B with InvalidDestination before slicing.`,
    },
    solidity: {
      entrypoint: "HyperionNotes.decodeInboundNote + StellarAddress.parse",
      acceptedByteLengths: [INBOUND_NOTE_PLAIN_LEN, INBOUND_NOTE_MUXED_LEN],
      maxAcceptedBytes: INBOUND_NOTE_MUXED_LEN,
      oversizedError: "MalformedMessage (>266B or len mismatch) / InvalidDestination (strkey)",
      complexityOnOversized: "O(1)",
      notes:
        "uint8 length header rejects any payload > 266B in O(1) with MalformedMessage; StellarAddress.parse accepts only 56 or 69 chars.",
    },
    sdk: {
      entrypoint: "decodeInboundNote",
      acceptedByteLengths: [INBOUND_NOTE_PLAIN_LEN, INBOUND_NOTE_MUXED_LEN],
      maxAcceptedBytes: INBOUND_NOTE_MUXED_LEN,
      oversizedError: "MalformedMessage (frame mismatch) / InvalidDestination (strkey length)",
      complexityOnOversized: "O(1)",
      notes:
        "Frame check (`3 + len + 8`) rejects > 266B in O(1); inner length guard accepts only 56 or 69 chars before ASCII allocation.",
    },
  },
  {
    id: "strkey_ascii",
    title: "SEP-23 Stellar StrKey string (G / C / M)",
    rust: {
      entrypoint: "hyperion_core::strkey::StrkeyDestination::validate",
      acceptedByteLengths: [STRKEY_LEN_PLAIN, STRKEY_LEN_MUXED],
      maxAcceptedBytes: STRKEY_LEN_MUXED,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes:
        "Checks exact kind-specific length (56 or 69) before copying into 69-byte stack buffer.",
    },
    solidity: {
      entrypoint: "StellarAddress.parse",
      acceptedByteLengths: [STRKEY_LEN_PLAIN, STRKEY_LEN_MUXED],
      maxAcceptedBytes: STRKEY_LEN_MUXED,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes: "Rejects any byte length outside 56 or 69 before base32 decoding or CRC16.",
    },
    sdk: {
      entrypoint: "parseStellarAddress",
      acceptedByteLengths: [STRKEY_LEN_PLAIN, STRKEY_LEN_MUXED],
      maxAcceptedBytes: STRKEY_LEN_MUXED,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes: "Rejects any string length outside 56 or 69 before base32 decoding or CRC16.",
    },
  },
  {
    id: "strkey_wire",
    title: "Framed StrKey destination ([kind][len][ascii])",
    rust: {
      entrypoint: "hyperion_core::strkey::StrkeyDestination::decode",
      acceptedByteLengths: [STRKEY_LEN_PLAIN + 2, STRKEY_LEN_MUXED + 2],
      maxAcceptedBytes: STRKEY_LEN_MUXED + 2,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes: "Enforces `len <= 69` and `raw.len() == len + 2` before copying characters.",
    },
    solidity: {
      entrypoint: "StellarAddress.strkeyDestination",
      acceptedByteLengths: [STRKEY_LEN_PLAIN + 2, STRKEY_LEN_MUXED + 2],
      maxAcceptedBytes: STRKEY_LEN_MUXED + 2,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes: "Encoder refuses any input string outside 56 or 69 characters.",
    },
    sdk: {
      entrypoint: "strkeyDestination",
      acceptedByteLengths: [STRKEY_LEN_PLAIN + 2, STRKEY_LEN_MUXED + 2],
      maxAcceptedBytes: STRKEY_LEN_MUXED + 2,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes: "Delegates to parseStellarAddress before building 58- or 71-byte payload.",
    },
  },
  {
    id: "tagged_destination",
    title: "Binary tagged Stellar destination ([kind][32B key][optional 8B muxedId])",
    rust: {
      entrypoint: "hyperion_core::address::StellarDestination::decode",
      acceptedByteLengths: [TAGGED_LEN_PLAIN, TAGGED_LEN_MUXED],
      maxAcceptedBytes: TAGGED_LEN_MUXED,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes: "Exact 33- or 41-byte length check before reading key or muxed id.",
    },
    solidity: {
      entrypoint: "StellarAddress.tagged",
      acceptedByteLengths: [TAGGED_LEN_PLAIN, TAGGED_LEN_MUXED],
      maxAcceptedBytes: TAGGED_LEN_MUXED,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes: "Fixed 33- or 41-byte packed output keyed on AddressKind.",
    },
    sdk: {
      entrypoint: "taggedDestination",
      acceptedByteLengths: [TAGGED_LEN_PLAIN, TAGGED_LEN_MUXED],
      maxAcceptedBytes: TAGGED_LEN_MUXED,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes: "Requires 32-byte hex key and emits 33 or 41 bytes.",
    },
  },
  {
    id: "cctp_header",
    title: "CCTP v2 message header",
    rust: {
      entrypoint: "hyperion_core::cctp::CctpMessage::parse",
      acceptedByteLengths: [MSG_BODY],
      maxAcceptedBytes: MSG_BODY,
      oversizedError: "N/A (reads fixed 148B prefix; trailing bytes bounded by hook parser)",
      complexityOnOversized: "O(1)",
      notes: "Reads fixed offsets 0..148 regardless of trailing body length.",
    },
    solidity: {
      entrypoint: "ITokenMessengerV2 (Circle MessageTransmitterV2 on EVM)",
      acceptedByteLengths: [MSG_BODY],
      maxAcceptedBytes: MSG_BODY,
      oversizedError: "Circle transmitter revert",
      complexityOnOversized: "O(1)",
      notes: "Outbound-only EVM CctpAdapter delegates burn framing to Circle TokenMessengerV2.",
    },
    sdk: {
      entrypoint: "parseCctpMessage",
      acceptedByteLengths: [MSG_BODY],
      maxAcceptedBytes: MSG_BODY,
      oversizedError: "N/A (reads fixed 148B prefix)",
      complexityOnOversized: "O(1)",
      notes: "Reads fixed slices 0..148 without scanning trailing body bytes.",
    },
  },
  {
    id: "cctp_burn_body",
    title: "CCTP v2 burn body fixed fields",
    rust: {
      entrypoint: "hyperion_core::cctp::BurnMessage::parse",
      acceptedByteLengths: [BURN_HOOK_DATA],
      maxAcceptedBytes: BURN_HOOK_DATA,
      oversizedError: "DecimalOverflow (amount > i128::MAX)",
      complexityOnOversized: "O(1)",
      notes: "Reads fixed offsets 0..228 and enforces Soroban signed i128 balance ceiling.",
    },
    solidity: {
      entrypoint: "CctpAdapter.dispatch -> depositForBurnWithHook",
      acceptedByteLengths: [BURN_HOOK_DATA],
      maxAcceptedBytes: BURN_HOOK_DATA,
      oversizedError: "Circle TokenMessengerV2 revert",
      complexityOnOversized: "O(1)",
      notes: "Fixed 228-byte Circle burn body prefix ahead of Hyperion hookData.",
    },
    sdk: {
      entrypoint: "parseCctpBurnMessage",
      acceptedByteLengths: [BURN_HOOK_DATA],
      maxAcceptedBytes: BURN_HOOK_DATA,
      oversizedError: "DecimalOverflow (amount > i128::MAX)",
      complexityOnOversized: "O(1)",
      notes: "Matches Soroban i128 ceiling on all four uint256 fields in offsets 0..228.",
    },
  },
  {
    id: "cctp_hook",
    title: "CCTP Hyperion hook ([version][tagged Stellar destination])",
    rust: {
      entrypoint: "hyperion_core::cctp::HyperionHook::decode",
      acceptedByteLengths: [HOOK_LEN_PLAIN, HOOK_LEN_MUXED],
      maxAcceptedBytes: HOOK_LEN_MUXED,
      oversizedError: "InvalidDestination",
      complexityOnOversized: "O(1)",
      notes:
        "Rejects lengths outside 34 or 42 before slicing; CctpAdapter additionally refuses muxed kind with MuxedNotSupported.",
    },
    solidity: {
      entrypoint: "HyperionNotes.encodeCctpHook",
      acceptedByteLengths: [HOOK_LEN_PLAIN, HOOK_LEN_MUXED],
      maxAcceptedBytes: HOOK_LEN_MUXED,
      oversizedError: "MuxedNotSupported (router) / InvalidDestination (strkey)",
      complexityOnOversized: "O(1)",
      notes: "Produces 34 or 42 bytes; HyperionRouter blocks muxed destinations on CCTP.",
    },
    sdk: {
      entrypoint: "decodeCctpHook",
      acceptedByteLengths: [HOOK_LEN_PLAIN, HOOK_LEN_MUXED],
      maxAcceptedBytes: HOOK_LEN_MUXED,
      oversizedError: "MalformedMessage",
      complexityOnOversized: "O(1)",
      notes: "Rejects any payload length outside 34 or 42 before reading key or muxedId.",
    },
  },
  {
    id: "evm_address_word",
    title: "Left-padded 32-byte EVM address word",
    rust: {
      entrypoint: "hyperion_core::address::bytes32_to_evm",
      acceptedByteLengths: [32],
      maxAcceptedBytes: 32,
      oversizedError: "NotEvmAddress (dirty high 12B) / ZeroAddressKey",
      complexityOnOversized: "O(1)",
      notes: "Typed as BytesN<32>; host XDR decoder rejects non-32B words before contract entry.",
    },
    solidity: {
      entrypoint: "HyperionNotes.toEvmAddress",
      acceptedByteLengths: [32],
      maxAcceptedBytes: 32,
      oversizedError: "NotEvmAddress (dirty high 12B) / ZeroAddressKey",
      complexityOnOversized: "O(1)",
      notes: "Typed as bytes32; ABI decoder requires a full 32-byte word.",
    },
    sdk: {
      entrypoint: "toEvmAddress",
      acceptedByteLengths: [32],
      maxAcceptedBytes: 32,
      oversizedError: "MalformedMessage (len != 32) / NotEvmAddress / ZeroAddressKey",
      complexityOnOversized: "O(1)",
      notes: "Checks exact 32-byte length before inspecting 12-byte zero prefix.",
    },
  },
  {
    id: "queued_admin_action",
    title: "Timelocked router AdminAction payload",
    rust: {
      entrypoint: "HyperionRouter::queue_action (AdminAction XDR)",
      acceptedByteLengths: [16, 112],
      maxAcceptedBytes: 112,
      oversizedError: "Soroban XDR decode error / FeeTooHigh / InvalidDecimals / InvalidLimit",
      complexityOnOversized: "bounded-xdr",
      notes:
        "Closed 15-variant XDR enum with fixed-width fields only (no dynamic Bytes or String); FromXdr rejects trailing bytes.",
    },
    solidity: {
      entrypoint: "HyperionRouter.queueAction(AdminAction)",
      acceptedByteLengths: [160],
      maxAcceptedBytes: 160,
      oversizedError: "ActionFieldNotEmpty / FeeTooHigh / InvalidDecimals / InvalidLimit",
      complexityOnOversized: "O(1)",
      notes:
        "Fixed 5-word (160B) ABI struct with zero dynamic fields; unused slots must be zero (`ActionFieldNotEmpty`).",
    },
    sdk: {
      entrypoint: "hyperionRouterAbi queueAction tuple",
      acceptedByteLengths: [160],
      maxAcceptedBytes: 160,
      oversizedError: "ABI tuple validation failure",
      complexityOnOversized: "O(1)",
      notes:
        "Static 5-field ABI tuple `(uint8 kind, uint8 route, address subject, uint256 amount, uint8 decimals)`.",
    },
  },
] as const;

/** Render a deterministic Markdown comparison table across Rust, Solidity, and TypeScript SDK. */
export function formatParserLimitsReport(
  entries: readonly ParserLimitEntry[] = PARSER_LIMITS_MATRIX,
): string {
  const lines = [
    "| Surface | Rust Max (Error / Bound) | Solidity Max (Error / Bound) | SDK Max (Error / Bound) |",
    "| :--- | :--- | :--- | :--- |",
  ];
  for (const entry of entries) {
    lines.push(
      `| ${entry.title} | ${String(entry.rust.maxAcceptedBytes)} B (${entry.rust.oversizedError}; ${entry.rust.complexityOnOversized}) | ${String(entry.solidity.maxAcceptedBytes)} B (${entry.solidity.oversizedError}; ${entry.solidity.complexityOnOversized}) | ${String(entry.sdk.maxAcceptedBytes)} B (${entry.sdk.oversizedError}; ${entry.sdk.complexityOnOversized}) |`,
    );
  }
  return lines.join("\n");
}
