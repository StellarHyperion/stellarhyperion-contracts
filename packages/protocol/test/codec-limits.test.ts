import { describe, expect, it } from "vitest";
import {
  BURN_HOOK_DATA,
  BURN_MESSAGE_VERSION,
  CodecResourceLimitError,
  DEFAULT_CODEC_LIMITS,
  FINALITY_THRESHOLD_FINALIZED,
  MESSAGE_VERSION,
  MSG_BODY,
  STELLAR_DOMAIN,
  asciiToBytes,
  bigIntToBytes,
  bytesToAscii,
  bytesToBigInt,
  cctpBody,
  cctpHookData,
  concatBytesBounded,
  decodeCctpHook,
  decodeInboundNote,
  decodeOutboundNote,
  encodeAxelarMetadata,
  encodeCctpHook,
  encodeInboundNote,
  encodeOutboundNote,
  formatUnits,
  fromHex,
  isStellarAddress,
  parseAmountInput,
  parseCctpBurnMessage,
  parseCctpMessage,
  parseStellarAddress,
  parseUnits,
  resolveCodecLimits,
  toEvmAddress,
  toHex,
  tryParseStellarAddress,
} from "../src/index.js";
import { C_ADDR, EVM_RECIPIENT, G_ADDR, MUXED_ID, M_ADDR } from "./fixtures.js";

function u32(value: number): Uint8Array {
  return fromHex(`0x${value.toString(16).padStart(8, "0")}`);
}

function word(hex: string): Uint8Array {
  return fromHex(`0x${hex.replace(/^0x/, "").padStart(64, "0")}`);
}

function buildBurnBody(hook: Uint8Array, amount = 10_000_000n): Uint8Array {
  const body = new Uint8Array(BURN_HOOK_DATA);
  body.set(u32(BURN_MESSAGE_VERSION), 0);
  body.set(word("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), 4);
  body.set(word("0d1ea8b866708fdad0f4ed8c677cf4fe66e56a247837266036e4e0f3d05c7b10"), 36);
  body.set(word(amount.toString(16)), 68);
  body.set(word("1111111111111111111111111111111111111111"), 100);
  return concatBytesBounded([body, hook], { maxConcatBytes: BURN_HOOK_DATA + hook.length });
}

function buildCctpEnvelope(body: Uint8Array): Uint8Array {
  const header = new Uint8Array(MSG_BODY);
  header.set(u32(MESSAGE_VERSION), 0);
  header.set(u32(0), 4);
  header.set(u32(STELLAR_DOMAIN), 8);
  header.set(word("2a"), 12);
  header.set(word("28b5a0e9c621a5badaa536219b3a228c8168cf5d"), 44);
  header.set(word("431871229103b780868f8c6bb820cd16ecf942bc"), 76);
  header.set(u32(FINALITY_THRESHOLD_FINALIZED), 140);
  header.set(u32(FINALITY_THRESHOLD_FINALIZED), 144);
  return concatBytesBounded([header, body], { maxConcatBytes: MSG_BODY + body.length });
}

describe("browser-safe codec resource limits", () => {
  it("rejects oversized byte and hex inputs before scanning or proportional allocation", () => {
    // Non-hex garbage past the budget proves the check happens before scanning hex pairs.
    const oversizedNonHex = `0x${"zz".repeat(DEFAULT_CODEC_LIMITS.maxHexBytes + 1)}` as const;
    expect(() => fromHex(oversizedNonHex)).toThrow(CodecResourceLimitError);
    expect(() => fromHex(oversizedNonHex)).toThrow(RangeError);

    try {
      fromHex(oversizedNonHex);
      expect.unreachable("expected CodecResourceLimitError");
    } catch (error) {
      expect(error).toBeInstanceOf(CodecResourceLimitError);
      const limitErr = error as CodecResourceLimitError;
      expect(limitErr.limit).toBe("maxHexBytes");
      expect(limitErr.actual).toBe(DEFAULT_CODEC_LIMITS.maxHexBytes + 1);
      expect(limitErr.maximum).toBe(DEFAULT_CODEC_LIMITS.maxHexBytes);
    }

    // 1 GB length request fails immediately without attempting `new Uint8Array(1_000_000_000)`.
    expect(() => bigIntToBytes(0n, 1_000_000_000)).toThrow(CodecResourceLimitError);
    expect(() => bytesToBigInt(new Uint8Array(DEFAULT_CODEC_LIMITS.maxBigIntBytes + 1))).toThrow(
      CodecResourceLimitError,
    );

    const chunk = new Uint8Array(9_000);
    expect(() => concatBytesBounded([chunk, chunk])).toThrow(CodecResourceLimitError);
    expect(() => encodeAxelarMetadata(new Uint8Array(DEFAULT_CODEC_LIMITS.maxConcatBytes))).toThrow(
      CodecResourceLimitError,
    );

    expect(() => asciiToBytes("A".repeat(DEFAULT_CODEC_LIMITS.maxAsciiBytes + 1))).toThrow(
      CodecResourceLimitError,
    );
    expect(() => bytesToAscii(new Uint8Array(DEFAULT_CODEC_LIMITS.maxAsciiBytes + 1))).toThrow(
      CodecResourceLimitError,
    );
    expect(() => toEvmAddress(oversizedNonHex)).toThrow(CodecResourceLimitError);
  });

  it("rejects oversized strkey, note, CCTP, and amount strings before decoding", () => {
    const hugeStrkey = "G".repeat(DEFAULT_CODEC_LIMITS.maxStrkeyChars + 1);
    expect(() => parseStellarAddress(hugeStrkey)).toThrow(CodecResourceLimitError);
    expect(isStellarAddress(hugeStrkey)).toBe(false);
    const tryResult = tryParseStellarAddress(hugeStrkey);
    expect(tryResult.ok).toBe(false);
    if (!tryResult.ok) {
      expect(tryResult.reason).toContain("maxStrkeyChars");
    }

    const hugeHex = `0x${"00".repeat(10_000)}` as const;
    expect(() => decodeOutboundNote(hugeHex)).toThrow(CodecResourceLimitError);
    expect(() => decodeInboundNote(hugeHex)).toThrow(CodecResourceLimitError);
    expect(() => decodeCctpHook(hugeHex)).toThrow(CodecResourceLimitError);
    expect(() => parseCctpMessage(hugeHex)).toThrow(CodecResourceLimitError);
    expect(() => cctpBody(hugeHex)).toThrow(CodecResourceLimitError);
    expect(() => parseCctpBurnMessage(hugeHex)).toThrow(CodecResourceLimitError);
    expect(() => cctpHookData(hugeHex)).toThrow(CodecResourceLimitError);

    const hugeAmount = "9".repeat(DEFAULT_CODEC_LIMITS.maxAmountInputChars + 1);
    expect(() => parseUnits(hugeAmount, 7)).toThrow(CodecResourceLimitError);
    expect(() => parseAmountInput(`  ${hugeAmount}  `, 7)).toThrow(CodecResourceLimitError);
  });

  it("decodes canonical v1 fixtures and wide integer boundaries identically under default limits", () => {
    expect(parseStellarAddress(G_ADDR).muxedId).toBe(0n);
    expect(parseStellarAddress(C_ADDR).muxedId).toBe(0n);
    expect(parseStellarAddress(M_ADDR).muxedId).toBe(MUXED_ID);

    const outbound = encodeOutboundNote(EVM_RECIPIENT, (1n << 64n) - 1n);
    expect(decodeOutboundNote(toHex(outbound))).toEqual({
      recipient: EVM_RECIPIENT.toLowerCase(),
      nonce: (1n << 64n) - 1n,
    });

    const inbound = encodeInboundNote(M_ADDR, MUXED_ID);
    expect(decodeInboundNote(toHex(inbound))).toEqual({
      kind: 2,
      strkey: M_ADDR,
      nonce: MUXED_ID,
    });

    const hook = encodeCctpHook(M_ADDR);
    expect(decodeCctpHook(toHex(hook)).muxedId).toBe(MUXED_ID);

    const maxSorobanAmount = (1n << 127n) - 1n;
    const burnBody = buildBurnBody(hook, maxSorobanAmount);
    const fullMessage = buildCctpEnvelope(burnBody);
    expect(parseCctpMessage(toHex(fullMessage)).destinationDomain).toBe(STELLAR_DOMAIN);
    expect(parseCctpBurnMessage(cctpBody(fullMessage)).amount).toBe(maxSorobanAmount);
    expect(cctpHookData(burnBody)).toEqual(hook);

    const maxUint256 = (1n << 256n) - 1n;
    const formattedMax = formatUnits(maxUint256, 18);
    expect(parseUnits(formattedMax, 18)).toBe(maxUint256);
    expect(parseUnits("0", 7)).toBe(0n);
  });

  it("supports configurable overrides for provider extensions and validates bad limit values", () => {
    // A 512-byte custom provider hook exceeds the default 256-byte hook ceiling unless configured.
    const extendedHook = new Uint8Array(512).fill(0xab);
    const extendedBody = buildBurnBody(extendedHook);
    const extendedMessage = buildCctpEnvelope(extendedBody);

    expect(() => cctpHookData(extendedBody)).toThrow(CodecResourceLimitError);

    const providerLimits = {
      maxCctpHookBytes: 1_024,
      maxCctpBodyBytes: 2_048,
      maxCctpMessageBytes: 2_048 + MSG_BODY,
    } as const;

    const extractedBody = cctpBody(extendedMessage, providerLimits);
    expect(parseCctpBurnMessage(extractedBody, providerLimits).amount).toBe(10_000_000n);
    expect(cctpHookData(extractedBody, providerLimits)).toEqual(extendedHook);

    // Callers can also tighten budgets below defaults for constrained contexts.
    expect(() => fromHex("0x0102030405", { maxHexBytes: 4 })).toThrow(CodecResourceLimitError);
    expect(fromHex("0x01020304", { maxHexBytes: 4 })).toEqual(Uint8Array.of(1, 2, 3, 4));

    // Malformed override configurations fail immediately with RangeError.
    expect(() => resolveCodecLimits({ maxHexBytes: -1 })).toThrow(RangeError);
    expect(() => resolveCodecLimits({ maxStrkeyChars: Number.NaN })).toThrow(RangeError);
    expect(() => resolveCodecLimits({ maxBigIntBytes: 3.5 })).toThrow(RangeError);
    expect(() => bigIntToBytes(1n, -1)).toThrow(RangeError);
  });
});
