/**
 * Stellar addresses, decoded and encoded exactly the way both contracts do it.
 *
 * This is a deliberate third implementation of SEP-23. `hyperion_core::strkey` has one in Rust and
 * `StellarAddress.sol` has one in Solidity, and the app needs a fourth opinion before it asks
 * anybody to sign anything. Getting a destination wrong in a bridge is not an error message, it is
 * money delivered to an address nobody on earth holds the secret for, so the checksum gets verified
 * here, again on chain, and once more by the rail.
 *
 * The three parts people get wrong, all of which are handled below:
 *
 * - The CRC16 goes on the wire little endian, which no part of the spec's prose prepares you for.
 * - A muxed strkey is sixty nine base32 characters carrying three hundred and forty four bits, so
 *   the last character has one spare bit. It has to be zero, or two different strings decode to the
 *   same address and only one of them is the one the sender read.
 * - The ed25519 key comes first and the eight byte sub account id comes last, not the other way
 *   round.
 */
import { asciiToBytes, bigIntToBytes, bytesToBigInt, concatBytes, toHex } from "./bytes.js";
import type { Hex } from "./bytes.js";
import { fail } from "./errors.js";
import { assertCharBudget, resolveCodecLimits } from "./limits.js";
import type { CodecResourceLimits } from "./limits.js";

/**
 * The three kinds of Stellar address, numbered the way `AddressKind` numbers them in Solidity and
 * `StellarKind` numbers them in Rust. These integers travel on the wire, so they are fixed.
 */
export const AddressKind = {
  Account: 0,
  Contract: 1,
  MuxedAccount: 2,
} as const;

export type AddressKind = (typeof AddressKind)[keyof typeof AddressKind];

export const ADDRESS_KIND_LABELS = {
  [AddressKind.Account]: "Stellar account",
  [AddressKind.Contract]: "Soroban contract",
  [AddressKind.MuxedAccount]: "muxed account",
} as const;

/** RFC 4648 base32. Strkeys carry no padding. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * SEP-23 version bytes. Each is a five bit value sitting in the top of a byte, which is why the
 * first character of a strkey is always the same letter for its kind.
 */
export const VERSION_ACCOUNT = 6 << 3; // 0x30, reads as G
export const VERSION_CONTRACT = 2 << 3; // 0x10, reads as C
export const VERSION_MUXED = 12 << 3; // 0x60, reads as M

export const STRKEY_LEN_PLAIN = 56;
export const STRKEY_LEN_MUXED = 69;

const RAW_LEN_PLAIN = 35;
const RAW_LEN_MUXED = 43;

const BODY_LEN_PLAIN = 33;
const BODY_LEN_MUXED = 41;

/** The tagged binary form's byte counts, for rails that hand over a bare slot and no payload. */
export const TAGGED_LEN_PLAIN = 33;
export const TAGGED_LEN_MUXED = 41;

/** What a strkey decodes to. */
export interface StellarAddressParts {
  readonly kind: AddressKind;
  /** The raw ed25519 public key, or the contract id, as thirty two bytes of hex. */
  readonly key: Hex;
  /** The sub account id for a muxed address, and zero for the other two. */
  readonly muxedId: bigint;
}

const KIND_BY_VERSION: ReadonlyMap<number, AddressKind> = new Map([
  [VERSION_ACCOUNT, AddressKind.Account],
  [VERSION_CONTRACT, AddressKind.Contract],
  [VERSION_MUXED, AddressKind.MuxedAccount],
]);

const VERSION_BY_KIND = {
  [AddressKind.Account]: VERSION_ACCOUNT,
  [AddressKind.Contract]: VERSION_CONTRACT,
  [AddressKind.MuxedAccount]: VERSION_MUXED,
} as const;

/**
 * CRC16 XModem over the first `length` bytes.
 *
 * Polynomial 0x1021, zero initial value, most significant bit first, no reflection, no final xor.
 * The `& 0xffff` on each pass is what a `uint16` accumulator does for free in Solidity and Rust.
 */
export function checksum(data: Uint8Array, length: number = data.length): number {
  let crc = 0;
  for (let i = 0; i < length; i += 1) {
    crc ^= (data[i] ?? 0) << 8;
    crc &= 0xffff;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

/** Take a strkey apart, refusing anything that does not add up. */
export function parseStellarAddress(
  value: string,
  limits?: Partial<CodecResourceLimits>,
): StellarAddressParts {
  const resolved = resolveCodecLimits(limits);
  assertCharBudget(value.length, resolved.maxStrkeyChars, "maxStrkeyChars");

  let rawLen: number;
  let bodyLen: number;

  if (value.length === STRKEY_LEN_PLAIN) {
    rawLen = RAW_LEN_PLAIN;
    bodyLen = BODY_LEN_PLAIN;
  } else if (value.length === STRKEY_LEN_MUXED) {
    rawLen = RAW_LEN_MUXED;
    bodyLen = BODY_LEN_MUXED;
  } else {
    fail("InvalidDestination", `${String(value.length)} characters is not a strkey length`);
  }

  const raw = base32Decode(value, rawLen);
  const kind = KIND_BY_VERSION.get(raw[0] ?? -1);
  if (kind === undefined) {
    fail("InvalidDestination", `version byte ${String(raw[0])} is not one Stellar defines`);
  }

  // A muxed version byte on a fifty six character string, or an account version byte on a sixty
  // nine character one. Both decode to something shaped like an address and neither is the address
  // anybody meant.
  const wantsMuxed = kind === AddressKind.MuxedAccount;
  if (wantsMuxed !== (value.length === STRKEY_LEN_MUXED)) {
    fail("InvalidDestination", "the version byte and the length disagree");
  }

  const expected = checksum(raw, bodyLen);
  const found = (raw[bodyLen] ?? 0) | ((raw[bodyLen + 1] ?? 0) << 8);
  if (expected !== found) {
    fail("InvalidDestination", "the checksum does not match, so a character is wrong or missing");
  }

  const keyBytes = raw.slice(1, 33);
  const key = toHex(keyBytes);
  if (bytesToBigInt(keyBytes) === 0n) {
    fail("ZeroAddressKey");
  }

  const muxedId = wantsMuxed ? bytesToBigInt(raw.slice(33, 41)) : 0n;
  return { kind, key, muxedId };
}

/** Whether a string is a strkey this library will accept, without throwing to find out. */
export function isStellarAddress(value: string, limits?: Partial<CodecResourceLimits>): boolean {
  const resolved = resolveCodecLimits(limits);
  if (value.length > resolved.maxStrkeyChars) return false;
  try {
    parseStellarAddress(value, resolved);
    return true;
  } catch {
    return false;
  }
}

/** Parse without throwing, for a form field that revalidates on every keystroke. */
export function tryParseStellarAddress(
  value: string,
  limits?: Partial<CodecResourceLimits>,
): { ok: true; parts: StellarAddressParts } | { ok: false; reason: string } {
  const resolved = resolveCodecLimits(limits);
  try {
    return { ok: true, parts: parseStellarAddress(value, resolved) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "not a Stellar address" };
  }
}

/** Build a strkey from its parts, which is the exact inverse of the parse above. */
export function encodeStellarAddress(
  kind: AddressKind,
  key: Uint8Array | Hex,
  muxedId = 0n,
): string {
  const keyBytes = typeof key === "string" ? hexToFixed(key, 32) : key;
  if (keyBytes.length !== 32) {
    fail("InvalidDestination", `a key is thirty two bytes, got ${String(keyBytes.length)}`);
  }
  if (kind !== AddressKind.MuxedAccount && muxedId !== 0n) {
    fail("InvalidDestination", "only a muxed address carries a sub account id");
  }

  const bodyLen = kind === AddressKind.MuxedAccount ? BODY_LEN_MUXED : BODY_LEN_PLAIN;
  const raw = new Uint8Array(bodyLen + 2);
  raw[0] = VERSION_BY_KIND[kind];
  raw.set(keyBytes, 1);
  if (kind === AddressKind.MuxedAccount) {
    raw.set(bigIntToBytes(muxedId, 8), 33);
  }

  const crc = checksum(raw, bodyLen);
  // Low byte then high byte. The little endian checksum again.
  raw[bodyLen] = crc & 0xff;
  raw[bodyLen + 1] = (crc >> 8) & 0xff;

  return base32Encode(raw);
}

/**
 * The tagged binary form: `[kind][32 byte key]`, with eight big endian bytes of muxed id appended
 * when there is one. Thirty three bytes or forty one.
 *
 * CCTP's mint recipient is thirty two bytes with no room for a tag at all, which is why that rail
 * carries this inside its hook rather than in the recipient slot.
 */
export function taggedDestination(parts: StellarAddressParts): Uint8Array {
  const key = hexToFixed(parts.key, 32);
  if (parts.kind === AddressKind.MuxedAccount) {
    return concatBytes(Uint8Array.of(parts.kind), key, bigIntToBytes(parts.muxedId, 8));
  }
  return concatBytes(Uint8Array.of(parts.kind), key);
}

/**
 * The strkey form: `[kind][length][ascii strkey]`.
 *
 * One byte of length is enough forever, because the longest strkey Stellar defines is sixty nine
 * characters and the parser refuses anything else.
 */
export function strkeyDestination(strkey: string): Uint8Array {
  const parts = parseStellarAddress(strkey);
  return concatBytes(Uint8Array.of(parts.kind, strkey.length), asciiToBytes(strkey));
}

/**
 * Whether this kind of address has to opt into an asset before it can be paid.
 *
 * Stellar's trustline rule, and the reason an EVM to Stellar quote is not simply yes. A contract
 * holds any asset without asking. A classic account holds nothing it has not opened a trustline
 * for, and a payment into one that has not is a payment that fails.
 */
export function needsTrustline(kind: AddressKind): boolean {
  return kind !== AddressKind.Contract;
}

/** Shorten an address for a table cell without losing the parts people recognise. */
export function shortenStellarAddress(value: string, lead = 6, tail = 6): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

function hexToFixed(value: Hex, length: number): Uint8Array {
  const body = value.slice(2);
  if (body.length !== length * 2) {
    fail("InvalidDestination", `expected ${String(length)} bytes of hex, got ${value}`);
  }
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    const byte = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) fail("InvalidDestination", `${value} is not hex`);
    out[i] = byte;
  }
  return out;
}

function charValue(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A to Z
  if (code >= 0x32 && code <= 0x37) return code - 0x32 + 26; // 2 to 7
  fail("InvalidDestination", `${String.fromCharCode(code)} is not a base32 character`);
}

function base32Decode(value: string, rawLen: number): Uint8Array {
  const raw = new Uint8Array(rawLen);
  let accumulator = 0;
  let pending = 0;
  let written = 0;

  for (let i = 0; i < value.length; i += 1) {
    accumulator = (accumulator << 5) | charValue(value.charCodeAt(i));
    pending += 5;
    if (pending >= 8) {
      pending -= 8;
      if (written >= rawLen) {
        fail("InvalidDestination", "more bytes than this strkey length allows");
      }
      raw[written] = (accumulator >> pending) & 0xff;
      written += 1;
      accumulator &= (1 << pending) - 1;
    }
  }

  // The spare bit in the final character, which has to be zero. Without this check two different
  // strings decode to the same address.
  if (accumulator !== 0) {
    fail("InvalidDestination", "the trailing bits of the last character are not zero");
  }
  if (written !== rawLen) {
    fail("InvalidDestination", "the decoded length is wrong");
  }
  return raw;
}

function base32Encode(raw: Uint8Array): string {
  let out = "";
  let accumulator = 0;
  let pending = 0;

  for (const byte of raw) {
    accumulator = (accumulator << 8) | byte;
    pending += 8;
    while (pending >= 5) {
      pending -= 5;
      out += ALPHABET.charAt((accumulator >> pending) & 0x1f);
    }
    accumulator &= (1 << pending) - 1;
  }
  if (pending > 0) {
    out += ALPHABET.charAt((accumulator << (5 - pending)) & 0x1f);
  }
  return out;
}
