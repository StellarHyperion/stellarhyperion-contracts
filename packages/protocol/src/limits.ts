/**
 * Browser-safe input-size budgets for public wire, hex, address, and amount codecs.
 *
 * Every parser in `@hyperion/protocol` runs identically in browser bundles and server processes.
 * Checking character and byte budgets before allocating `Uint8Array` buffers, slicing multi-megabyte
 * hex strings, or shifting wide `bigint` accumulators stops malformed or adversarial payloads from
 * exhausting heap memory or stalling the UI thread while leaving every valid protocol message
 * untouched.
 */

/** Configurable resource-limit keys governing public protocol codecs. */
export interface CodecResourceLimits {
  /** Maximum decoded byte length accepted by `fromHex` (2 hex digits per byte). */
  readonly maxHexBytes: number;
  /** Maximum character/byte length accepted by `asciiToBytes` and `bytesToAscii`. */
  readonly maxAsciiBytes: number;
  /** Maximum combined output byte length accepted by `concatBytes`. */
  readonly maxConcatBytes: number;
  /** Maximum byte width accepted by `bytesToBigInt` and `bigIntToBytes`. */
  readonly maxBigIntBytes: number;
  /** Maximum input string length accepted by Stellar strkey parsers. */
  readonly maxStrkeyChars: number;
  /** Maximum byte length accepted before decoding an outbound note (`OUTBOUND_NOTE_LEN` is 29). */
  readonly maxOutboundNoteBytes: number;
  /** Maximum byte length accepted before decoding an inbound note (muxed v1 note is 80). */
  readonly maxInboundNoteBytes: number;
  /** Maximum byte length accepted before decoding a CCTP hook (v1 hook is 34 or 42; extensible). */
  readonly maxCctpHookBytes: number;
  /** Maximum byte length accepted for a CCTP burn body including trailing provider hook data. */
  readonly maxCctpBodyBytes: number;
  /** Maximum byte length accepted for a full CCTP V2 message (148-byte header plus body). */
  readonly maxCctpMessageBytes: number;
  /** Maximum input character length accepted by `parseUnits` and `parseAmountInput`. */
  readonly maxAmountInputChars: number;
}

export type CodecLimitKey = keyof CodecResourceLimits;

/**
 * Default browser-safe resource budgets.
 *
 * Sized comfortably above every canonical v1 Stellar, EVM, Axelar ITS, and Circle CCTP V2 payload
 * (including wide `uint256` decimal amounts and provider hook extensions up to 256 bytes) while
 * rejecting oversized inputs before proportional allocations occur.
 */
export const DEFAULT_CODEC_LIMITS: Readonly<CodecResourceLimits> = Object.freeze({
  maxHexBytes: 16_384,
  maxAsciiBytes: 4_096,
  maxConcatBytes: 16_384,
  maxBigIntBytes: 64,
  maxStrkeyChars: 128,
  maxOutboundNoteBytes: 64,
  maxInboundNoteBytes: 256,
  maxCctpHookBytes: 256,
  maxCctpBodyBytes: 4_096,
  maxCctpMessageBytes: 4_244,
  maxAmountInputChars: 128,
});

/**
 * Raised before allocation when an input exceeds the configured codec resource budget.
 *
 * Extends `RangeError` so existing callers catching `RangeError` on low-level byte/hex helpers
 * remain compatible while structured callers can inspect `limit`, `actual`, and `maximum`.
 */
export class CodecResourceLimitError extends RangeError {
  readonly limit: CodecLimitKey;
  readonly actual: number;
  readonly maximum: number;

  constructor(limit: CodecLimitKey, actual: number, maximum: number, unit: "bytes" | "chars") {
    super(
      `codec resource limit ${limit} exceeded: got ${String(actual)} ${unit}, maximum is ${String(maximum)} ${unit}`,
    );
    this.name = "CodecResourceLimitError";
    this.limit = limit;
    this.actual = actual;
    this.maximum = maximum;
  }
}

function validateBudgetValue(key: CodecLimitKey, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `invalid codec resource limit ${key}: expected a non-negative safe integer, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Merge optional caller overrides with `DEFAULT_CODEC_LIMITS`, validating every overridden budget.
 */
export function resolveCodecLimits(
  overrides?: Partial<CodecResourceLimits>,
): Readonly<CodecResourceLimits> {
  if (overrides === undefined) return DEFAULT_CODEC_LIMITS;

  return {
    maxHexBytes:
      overrides.maxHexBytes === undefined
        ? DEFAULT_CODEC_LIMITS.maxHexBytes
        : validateBudgetValue("maxHexBytes", overrides.maxHexBytes),
    maxAsciiBytes:
      overrides.maxAsciiBytes === undefined
        ? DEFAULT_CODEC_LIMITS.maxAsciiBytes
        : validateBudgetValue("maxAsciiBytes", overrides.maxAsciiBytes),
    maxConcatBytes:
      overrides.maxConcatBytes === undefined
        ? DEFAULT_CODEC_LIMITS.maxConcatBytes
        : validateBudgetValue("maxConcatBytes", overrides.maxConcatBytes),
    maxBigIntBytes:
      overrides.maxBigIntBytes === undefined
        ? DEFAULT_CODEC_LIMITS.maxBigIntBytes
        : validateBudgetValue("maxBigIntBytes", overrides.maxBigIntBytes),
    maxStrkeyChars:
      overrides.maxStrkeyChars === undefined
        ? DEFAULT_CODEC_LIMITS.maxStrkeyChars
        : validateBudgetValue("maxStrkeyChars", overrides.maxStrkeyChars),
    maxOutboundNoteBytes:
      overrides.maxOutboundNoteBytes === undefined
        ? DEFAULT_CODEC_LIMITS.maxOutboundNoteBytes
        : validateBudgetValue("maxOutboundNoteBytes", overrides.maxOutboundNoteBytes),
    maxInboundNoteBytes:
      overrides.maxInboundNoteBytes === undefined
        ? DEFAULT_CODEC_LIMITS.maxInboundNoteBytes
        : validateBudgetValue("maxInboundNoteBytes", overrides.maxInboundNoteBytes),
    maxCctpHookBytes:
      overrides.maxCctpHookBytes === undefined
        ? DEFAULT_CODEC_LIMITS.maxCctpHookBytes
        : validateBudgetValue("maxCctpHookBytes", overrides.maxCctpHookBytes),
    maxCctpBodyBytes:
      overrides.maxCctpBodyBytes === undefined
        ? DEFAULT_CODEC_LIMITS.maxCctpBodyBytes
        : validateBudgetValue("maxCctpBodyBytes", overrides.maxCctpBodyBytes),
    maxCctpMessageBytes:
      overrides.maxCctpMessageBytes === undefined
        ? DEFAULT_CODEC_LIMITS.maxCctpMessageBytes
        : validateBudgetValue("maxCctpMessageBytes", overrides.maxCctpMessageBytes),
    maxAmountInputChars:
      overrides.maxAmountInputChars === undefined
        ? DEFAULT_CODEC_LIMITS.maxAmountInputChars
        : validateBudgetValue("maxAmountInputChars", overrides.maxAmountInputChars),
  };
}

/** Enforce a byte-length ceiling before allocating or copying a buffer. */
export function assertByteBudget(
  actualBytes: number,
  maximumBytes: number,
  limit: CodecLimitKey,
): void {
  if (actualBytes > maximumBytes) {
    throw new CodecResourceLimitError(limit, actualBytes, maximumBytes, "bytes");
  }
}

/** Enforce a character-length ceiling before regex, string normalization, or allocation. */
export function assertCharBudget(
  actualChars: number,
  maximumChars: number,
  limit: CodecLimitKey,
): void {
  if (actualChars > maximumChars) {
    throw new CodecResourceLimitError(limit, actualChars, maximumChars, "chars");
  }
}

/**
 * Enforce a decoded-byte ceiling on either a `Uint8Array` or a `Hex` string before `fromHex`
 * slices or allocates a buffer.
 */
export function assertWirePayloadBudget(
  payload: Uint8Array | string,
  maximumBytes: number,
  limit: CodecLimitKey,
): void {
  if (typeof payload !== "string") {
    assertByteBudget(payload.length, maximumBytes, limit);
    return;
  }
  const hasPrefix = payload.startsWith("0x") || payload.startsWith("0X");
  const hexChars = payload.length - (hasPrefix ? 2 : 0);
  const estimatedBytes = Math.ceil(hexChars / 2);
  assertByteBudget(estimatedBytes, maximumBytes, limit);
}
