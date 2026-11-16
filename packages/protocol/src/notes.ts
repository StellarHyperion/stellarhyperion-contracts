/**
 * What Hyperion says to itself across a rail.
 *
 * Every rail delivers to a contract, not to a person. The address on the envelope is Hyperion's own
 * contract on the far side, so who the money is actually for has to be written inside. These are
 * those notes, in the same packed layout `HyperionNotes.sol` writes and `hyperion_core::axelar`
 * reads.
 *
 * Two shapes, one per direction, because the directions describe different things. Coming out of
 * Stellar a note names an EVM address, which is twenty flat bytes. Going into Stellar it names a
 * strkey rather than a raw key, because the checksum comes free with the format and catches a
 * flipped bit before anybody gets paid.
 *
 * Both carry the originating router's nonce. No contract needs it. The person watching a transfer
 * does, because it is the one value that appears on both sides of a hop, which is what lets the app
 * say "this delivery is that transfer" instead of guessing from amounts and timestamps.
 */
import {
  AddressKind,
  parseStellarAddress,
  strkeyDestination,
  taggedDestination,
} from "./addresses.js";
import {
  bytesToAscii,
  bytesToBigInt,
  concatBytes,
  concatBytesBounded,
  fromHex,
  toHex,
} from "./bytes.js";
import type { Hex } from "./bytes.js";
import { fail } from "./errors.js";
import { assertWirePayloadBudget, resolveCodecLimits } from "./limits.js";
import type { CodecResourceLimits } from "./limits.js";

/** One envelope version across both rails, so nobody has to remember which rail numbers what. */
export const NOTE_VERSION = 1;

/** Version, twenty byte address, eight byte nonce. */
export const OUTBOUND_NOTE_LEN = 29;

/** The shortest an inbound note can be: version, kind, length, a strkey, a nonce. */
const INBOUND_NOTE_MIN = 1 + 3 + 8;

/** Axelar's own envelope version for "there is a payload and it is for a contract". */
export const METADATA_CONTRACT_CALL = 0;

export interface OutboundNote {
  /** The EVM address the funds are for, once they land. */
  readonly recipient: Hex;
  /** The Stellar router's transfer number, carried so both halves of the hop can be matched up. */
  readonly nonce: bigint;
}

export interface InboundNote {
  readonly kind: AddressKind;
  readonly strkey: string;
  readonly nonce: bigint;
}

/**
 * Read the note that came with a transfer out of Stellar.
 *
 * Exactly twenty nine bytes, refused otherwise. A note with something appended is a note somebody
 * else built, and reading the first twenty nine bytes of it anyway is how a parser becomes an
 * attack surface.
 */
export function decodeOutboundNote(
  payload: Uint8Array | Hex,
  limits?: Partial<CodecResourceLimits>,
): OutboundNote {
  const resolved = resolveCodecLimits(limits);
  assertWirePayloadBudget(payload, resolved.maxOutboundNoteBytes, "maxOutboundNoteBytes");
  const bytes =
    typeof payload === "string"
      ? fromHex(payload, { maxHexBytes: resolved.maxOutboundNoteBytes })
      : payload;
  if (bytes.length !== OUTBOUND_NOTE_LEN) {
    fail("MalformedMessage", `an outbound note is ${String(OUTBOUND_NOTE_LEN)} bytes`);
  }
  if (bytes[0] !== NOTE_VERSION) {
    fail("UnsupportedHookVersion", `note version ${String(bytes[0])}`);
  }

  const recipient = toHex(bytes.slice(1, 21));
  if (bytesToBigInt(bytes.slice(1, 21)) === 0n) fail("ZeroAddressKey");

  return { recipient, nonce: bytesToBigInt(bytes.slice(21, 29)) };
}

/** Write the note that goes with a transfer out of an EVM chain into Stellar. */
export function encodeOutboundNote(recipient: Hex, nonce: bigint): Uint8Array {
  const address = fromHex(recipient);
  if (address.length !== 20) fail("NotEvmAddress", `${recipient} is not twenty bytes`);
  if (bytesToBigInt(address) === 0n) fail("ZeroAddressKey");
  return concatBytes(Uint8Array.of(NOTE_VERSION), address, bigIntToEight(nonce));
}

/**
 * Write the note that goes with a transfer into Stellar.
 *
 * `[version][kind][length][ascii strkey][8 byte big endian nonce]`. Variable length, because a
 * muxed strkey is thirteen characters longer, and the length byte inside is what says which. The
 * far side reads the nonce from the end for that reason, so nothing may be appended after it.
 */
export function encodeInboundNote(strkey: string, nonce: bigint): Uint8Array {
  return concatBytes(Uint8Array.of(NOTE_VERSION), strkeyDestination(strkey), bigIntToEight(nonce));
}

/** Read an inbound note back, which is what the Stellar side does with it. */
export function decodeInboundNote(
  payload: Uint8Array | Hex,
  limits?: Partial<CodecResourceLimits>,
): InboundNote {
  const resolved = resolveCodecLimits(limits);
  assertWirePayloadBudget(payload, resolved.maxInboundNoteBytes, "maxInboundNoteBytes");
  const bytes =
    typeof payload === "string"
      ? fromHex(payload, { maxHexBytes: resolved.maxInboundNoteBytes })
      : payload;
  if (bytes.length < INBOUND_NOTE_MIN) fail("MalformedMessage", "too short to be a note");
  if (bytes[0] !== NOTE_VERSION) fail("UnsupportedHookVersion", `note version ${String(bytes[0])}`);

  const tag = bytes[1] ?? 0xff;
  if (tag > AddressKind.MuxedAccount) fail("MalformedMessage", `address kind ${String(tag)}`);
  const kind = tag as AddressKind;

  const len = bytes[2] ?? 0;
  if (bytes.length !== 3 + len + 8)
    fail("MalformedMessage", "the length byte and the note disagree");

  const strkey = bytesToAscii(bytes.slice(3, 3 + len), resolved);
  // The far side will parse this and check its checksum. Doing it here too means a note built by
  // something other than Hyperion fails in the app rather than at the rail.
  const parsed = parseStellarAddress(strkey, resolved);
  if (parsed.kind !== kind) fail("MalformedMessage", "the kind tag and the strkey disagree");

  return { kind, strkey, nonce: bytesToBigInt(bytes.slice(3 + len, 3 + len + 8)) };
}

/**
 * The hook a CCTP burn carries so the far side knows who the USDC is for.
 *
 * `[version][tagged destination]`. Thirty four bytes, or forty two for a muxed destination.
 *
 * CCTP's mint recipient is a bare thirty two byte slot with no room for a type tag, and no bridge
 * can tell a contract id from an account key by looking at it. So the mint recipient names
 * Hyperion's own adapter on the far side and the real destination rides in here, where there is
 * room to say which of the three kinds it is.
 */
export function encodeCctpHook(strkey: string): Uint8Array {
  const parts = parseStellarAddress(strkey);
  return concatBytes(Uint8Array.of(NOTE_VERSION), taggedDestination(parts));
}

/** Read a CCTP hook back into the destination it names. */
export function decodeCctpHook(
  payload: Uint8Array | Hex,
  limits?: Partial<CodecResourceLimits>,
): {
  kind: AddressKind;
  key: Hex;
  muxedId: bigint;
} {
  const resolved = resolveCodecLimits(limits);
  assertWirePayloadBudget(payload, resolved.maxCctpHookBytes, "maxCctpHookBytes");
  const bytes =
    typeof payload === "string"
      ? fromHex(payload, { maxHexBytes: resolved.maxCctpHookBytes })
      : payload;
  if (bytes.length !== 34 && bytes.length !== 42) {
    fail(
      "MalformedMessage",
      `a hook is thirty four or forty two bytes, got ${String(bytes.length)}`,
    );
  }
  if (bytes[0] !== NOTE_VERSION) fail("UnsupportedHookVersion", `hook version ${String(bytes[0])}`);

  const tag = bytes[1] ?? 0xff;
  if (tag > AddressKind.MuxedAccount) fail("MalformedMessage", `address kind ${String(tag)}`);
  const kind = tag as AddressKind;
  const wantsMuxed = kind === AddressKind.MuxedAccount;
  if (wantsMuxed !== (bytes.length === 42)) {
    fail("MalformedMessage", "the kind tag and the hook length disagree");
  }

  const key = toHex(bytes.slice(2, 34));
  if (bytesToBigInt(bytes.slice(2, 34)) === 0n) fail("ZeroAddressKey");

  return { kind, key, muxedId: wantsMuxed ? bytesToBigInt(bytes.slice(34, 42)) : 0n };
}

/**
 * Axelar's metadata envelope: four big endian bytes of version, then the note.
 *
 * Empty metadata and "version zero plus nothing" are not the same thing to the receiving side,
 * which is a distinction worth encoding once rather than rediscovering from a failed transfer.
 */
export function encodeAxelarMetadata(
  note: Uint8Array,
  limits?: Partial<CodecResourceLimits>,
): Uint8Array {
  return concatBytesBounded(
    [
      Uint8Array.of(
        (METADATA_CONTRACT_CALL >> 24) & 0xff,
        (METADATA_CONTRACT_CALL >> 16) & 0xff,
        (METADATA_CONTRACT_CALL >> 8) & 0xff,
        METADATA_CONTRACT_CALL & 0xff,
      ),
      note,
    ],
    limits,
  );
}

/**
 * Read a thirty two byte word as an EVM address, or refuse to.
 *
 * The twelve high bytes have to be zero. Truncating a full width word to its last twenty bytes
 * produces an address that looks completely ordinary and belongs to nobody, and that is the failure
 * this exists to prevent rather than tidy up after.
 */
export function toEvmAddress(word: Hex | Uint8Array, limits?: Partial<CodecResourceLimits>): Hex {
  const resolved = resolveCodecLimits(limits);
  assertWirePayloadBudget(word, resolved.maxHexBytes, "maxHexBytes");
  const bytes = typeof word === "string" ? fromHex(word, resolved) : word;
  if (bytes.length !== 32) fail("MalformedMessage", "a word is thirty two bytes");
  if (bytesToBigInt(bytes.slice(0, 12)) !== 0n) fail("NotEvmAddress");
  const out = bytes.slice(12, 32);
  if (bytesToBigInt(out) === 0n) fail("ZeroAddressKey");
  return toHex(out);
}

/** Widen an EVM address into the thirty two byte slot a rail carries it in. */
export function toWord(address: Hex): Hex {
  const bytes = fromHex(address);
  if (bytes.length !== 20) fail("NotEvmAddress", `${address} is not twenty bytes`);
  const out = new Uint8Array(32);
  out.set(bytes, 12);
  return toHex(out);
}

function bigIntToEight(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    fail("MalformedMessage", `${value.toString()} is not a sixty four bit nonce`);
  }
  const out = new Uint8Array(8);
  let remaining = value;
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}
