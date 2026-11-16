/**
 * Byte handling, kept in one place so the codecs below read like the Solidity they mirror.
 *
 * Everything here works on `Uint8Array` and hex strings, with no dependency on Node's `Buffer`,
 * because this package is imported by a browser bundle as often as by a server.
 */

import { assertByteBudget, resolveCodecLimits } from "./limits.js";
import type { CodecResourceLimits } from "./limits.js";

/** A hex string with the prefix, which is what viem, ethers and every JSON RPC endpoint expect. */
export type Hex = `0x${string}`;

/** A byte array as lowercase prefixed hex. */
export function toHex(bytes: Uint8Array): Hex {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return `0x${out}`;
}

/** Hex back to bytes, with or without the prefix, refusing anything that is not even length. */
export function fromHex(value: string, limits?: Partial<CodecResourceLimits>): Uint8Array {
  const resolved = resolveCodecLimits(limits);
  const prefixLen = value.startsWith("0x") || value.startsWith("0X") ? 2 : 0;
  const digitLen = value.length - prefixLen;
  assertByteBudget(Math.ceil(digitLen / 2), resolved.maxHexBytes, "maxHexBytes");
  if (digitLen % 2 !== 0) {
    throw new RangeError(`hex needs an even number of digits, got ${String(digitLen)}`);
  }
  const out = new Uint8Array(digitLen / 2);
  for (let i = 0; i < out.length; i += 1) {
    const offset = prefixLen + i * 2;
    const pair = value.slice(offset, offset + 2);
    const byte = Number.parseInt(pair, 16);
    if (Number.isNaN(byte)) throw new RangeError(`${pair} is not a hex byte`);
    out[i] = byte;
  }
  return out;
}

/** Glue byte arrays together with explicit resource-budget overrides. */
export function concatBytesBounded(
  parts: readonly Uint8Array[],
  limits?: Partial<CodecResourceLimits>,
): Uint8Array {
  const resolved = resolveCodecLimits(limits);
  let total = 0;
  for (const part of parts) total += part.length;
  assertByteBudget(total, resolved.maxConcatBytes, "maxConcatBytes");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Glue byte arrays together, which is what `abi.encodePacked` does on the other side. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  return concatBytesBounded(parts);
}

/** Constant time is not the point here; these are public wire formats, not secrets. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Big endian, because every integer Hyperion puts on a wire is big endian. */
export function bytesToBigInt(bytes: Uint8Array, limits?: Partial<CodecResourceLimits>): bigint {
  const resolved = resolveCodecLimits(limits);
  assertByteBudget(bytes.length, resolved.maxBigIntBytes, "maxBigIntBytes");
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * A big endian fixed width integer.
 *
 * Refuses a value that does not fit rather than silently truncating, which is the mistake that
 * turns a muxed sub account id into somebody else's sub account id.
 */
export function bigIntToBytes(
  value: bigint,
  length: number,
  limits?: Partial<CodecResourceLimits>,
): Uint8Array {
  const resolved = resolveCodecLimits(limits);
  if (value < 0n) throw new RangeError("negative values have no place on this wire");
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`byte length must be a non-negative integer, got ${String(length)}`);
  }
  assertByteBudget(length, resolved.maxBigIntBytes, "maxBigIntBytes");
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) {
    throw new RangeError(`${value.toString()} does not fit in ${String(length)} bytes`);
  }
  return out;
}

/** ASCII to bytes. Strkeys are base32, so every character is one byte and stays one byte. */
export function asciiToBytes(value: string, limits?: Partial<CodecResourceLimits>): Uint8Array {
  const resolved = resolveCodecLimits(limits);
  assertByteBudget(value.length, resolved.maxAsciiBytes, "maxAsciiBytes");
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0x7f) throw new RangeError(`${value} is not ASCII`);
    out[i] = code;
  }
  return out;
}

/** Bytes back to ASCII. */
export function bytesToAscii(bytes: Uint8Array, limits?: Partial<CodecResourceLimits>): string {
  const resolved = resolveCodecLimits(limits);
  assertByteBudget(bytes.length, resolved.maxAsciiBytes, "maxAsciiBytes");
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/**
 * A slice that copies, so a caller cannot reach back into the buffer it came from, and that
 * refuses a range the buffer does not contain.
 *
 * `Uint8Array.prototype.slice` clamps silently, which in a wire format decoder means a message
 * three bytes short yields a recipient three bytes short instead of an error. Everything in this
 * package reads fixed offsets out of somebody else's bytes, so the clamp is the wrong default
 * here and the throw is the point.
 */
export function slice(bytes: Uint8Array, start: number, end: number): Uint8Array {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new RangeError(`slice [${String(start)}, ${String(end)}) is not a range`);
  }
  if (end > bytes.length) {
    throw new RangeError(
      `slice [${String(start)}, ${String(end)}) runs past ${String(bytes.length)} bytes`,
    );
  }
  return bytes.slice(start, end);
}
