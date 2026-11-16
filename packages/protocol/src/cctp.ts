/**
 * Circle's CCTP V2 wire format, read only.
 *
 * Hyperion never signs an attestation and never mints. What the indexer does need is to read the
 * message Circle's own verifier is about to act on, because that is the only place three facts
 * live: which asset the burn corresponds to, who the sender actually meant on the far side, and
 * what identifier to file the delivery under when somebody asks where their money is.
 *
 * The offsets are the format, not a guess. They match `hyperion_core::cctp` field for field, which
 * in turn matches Circle's own `cctp-utils`, and the parity suite holds the two together.
 */
import { bytesToBigInt, fromHex, toHex } from "./bytes.js";
import type { Hex } from "./bytes.js";
import { fail } from "./errors.js";
import { assertByteBudget, assertWirePayloadBudget, resolveCodecLimits } from "./limits.js";
import type { CodecResourceLimits } from "./limits.js";

/** Circle's domain number for Stellar. */
export const STELLAR_DOMAIN = 27;

/** The version CCTP V2 headers carry, and the burn body version that pairs with it. */
export const MESSAGE_VERSION = 1;
export const BURN_MESSAGE_VERSION = 1;

/**
 * At or above this, Circle considers a message finalised rather than fast attested.
 *
 * The practical difference is minutes against seconds, and a fee. The app shows which one a
 * transfer took because "still waiting" and "waiting on purpose" feel very different.
 */
export const FINALITY_THRESHOLD_FINALIZED = 2000;

/** Version byte on Hyperion's own hook payload. */
export const HOOK_VERSION = 1;

/** Header field offsets. */
const MSG_VERSION = 0;
const MSG_SOURCE_DOMAIN = 4;
const MSG_DESTINATION_DOMAIN = 8;
const MSG_NONCE = 12;
const MSG_SENDER = 44;
const MSG_RECIPIENT = 76;
const MSG_DESTINATION_CALLER = 108;
const MSG_MIN_FINALITY = 140;
const MSG_FINALITY_EXECUTED = 144;

/** Everything from here on is the body, which for a token transfer is a burn message. */
export const MSG_BODY = 148;

/** Burn body field offsets. */
const BURN_VERSION = 0;
const BURN_TOKEN = 4;
const BURN_MINT_RECIPIENT = 36;
const BURN_AMOUNT = 68;
const BURN_MESSAGE_SENDER = 100;
const BURN_MAX_FEE = 132;
const BURN_FEE_EXECUTED = 164;
const BURN_EXPIRATION_BLOCK = 196;

/** Anything past here is the hook payload, which is where Hyperion puts the real destination. */
export const BURN_HOOK_DATA = 228;

export interface CctpMessage {
  readonly version: number;
  readonly sourceDomain: number;
  readonly destinationDomain: number;
  /** The rail's own identifier. Thirty two bytes, and the only sane thing to key replay on. */
  readonly nonce: Hex;
  readonly sender: Hex;
  /** Who the message is addressed to. For a token transfer this is Circle's own minter, never us. */
  readonly recipient: Hex;
  readonly destinationCaller: Hex;
  readonly minFinalityThreshold: number;
  readonly finalityThresholdExecuted: number;
}

export interface CctpBurnMessage {
  readonly version: number;
  /** The burned asset, as it is addressed on the source domain. */
  readonly burnToken: Hex;
  /** Who Circle will mint to. For Hyperion this is the adapter itself. */
  readonly mintRecipient: Hex;
  readonly amount: bigint;
  readonly messageSender: Hex;
  readonly maxFee: bigint;
  readonly feeExecuted: bigint;
  readonly expirationBlock: bigint;
}

/** Parse a header, refusing anything too short to hold one. */
export function parseCctpMessage(
  raw: Uint8Array | Hex,
  limits?: Partial<CodecResourceLimits>,
): CctpMessage {
  const resolved = resolveCodecLimits(limits);
  assertWirePayloadBudget(raw, resolved.maxCctpMessageBytes, "maxCctpMessageBytes");
  const bytes =
    typeof raw === "string" ? fromHex(raw, { maxHexBytes: resolved.maxCctpMessageBytes }) : raw;
  if (bytes.length < MSG_BODY) fail("MalformedMessage", "too short for a CCTP header");
  return {
    version: readU32(bytes, MSG_VERSION),
    sourceDomain: readU32(bytes, MSG_SOURCE_DOMAIN),
    destinationDomain: readU32(bytes, MSG_DESTINATION_DOMAIN),
    nonce: readWord(bytes, MSG_NONCE),
    sender: readWord(bytes, MSG_SENDER),
    recipient: readWord(bytes, MSG_RECIPIENT),
    destinationCaller: readWord(bytes, MSG_DESTINATION_CALLER),
    minFinalityThreshold: readU32(bytes, MSG_MIN_FINALITY),
    finalityThresholdExecuted: readU32(bytes, MSG_FINALITY_EXECUTED),
  };
}

/** The body Circle hands to whichever handler the recipient names. */
export function cctpBody(raw: Uint8Array | Hex, limits?: Partial<CodecResourceLimits>): Uint8Array {
  const resolved = resolveCodecLimits(limits);
  assertWirePayloadBudget(raw, resolved.maxCctpMessageBytes, "maxCctpMessageBytes");
  const bytes =
    typeof raw === "string" ? fromHex(raw, { maxHexBytes: resolved.maxCctpMessageBytes }) : raw;
  if (bytes.length < MSG_BODY) fail("MalformedMessage", "too short for a CCTP header");
  assertByteBudget(bytes.length - MSG_BODY, resolved.maxCctpBodyBytes, "maxCctpBodyBytes");
  return bytes.slice(MSG_BODY);
}

export function parseCctpBurnMessage(
  body: Uint8Array | Hex,
  limits?: Partial<CodecResourceLimits>,
): CctpBurnMessage {
  const resolved = resolveCodecLimits(limits);
  assertWirePayloadBudget(body, resolved.maxCctpBodyBytes, "maxCctpBodyBytes");
  const bytes =
    typeof body === "string" ? fromHex(body, { maxHexBytes: resolved.maxCctpBodyBytes }) : body;
  if (bytes.length < BURN_HOOK_DATA) fail("MalformedMessage", "too short for a burn message");
  return {
    version: readU32(bytes, BURN_VERSION),
    burnToken: readWord(bytes, BURN_TOKEN),
    mintRecipient: readWord(bytes, BURN_MINT_RECIPIENT),
    amount: readAmount(bytes, BURN_AMOUNT),
    messageSender: readWord(bytes, BURN_MESSAGE_SENDER),
    maxFee: readAmount(bytes, BURN_MAX_FEE),
    feeExecuted: readAmount(bytes, BURN_FEE_EXECUTED),
    expirationBlock: readAmount(bytes, BURN_EXPIRATION_BLOCK),
  };
}

/** The trailing hook payload, empty when the sender attached none. */
export function cctpHookData(
  body: Uint8Array | Hex,
  limits?: Partial<CodecResourceLimits>,
): Uint8Array {
  const resolved = resolveCodecLimits(limits);
  assertWirePayloadBudget(body, resolved.maxCctpBodyBytes, "maxCctpBodyBytes");
  const bytes =
    typeof body === "string" ? fromHex(body, { maxHexBytes: resolved.maxCctpBodyBytes }) : body;
  if (bytes.length < BURN_HOOK_DATA) fail("MalformedMessage", "too short for a burn message");
  assertByteBudget(bytes.length - BURN_HOOK_DATA, resolved.maxCctpHookBytes, "maxCctpHookBytes");
  return bytes.slice(BURN_HOOK_DATA);
}

/**
 * The two version checks the CCTP adapter makes before it acts on a message.
 *
 * The parsers above report a version rather than enforcing one, which is exactly what
 * `hyperion_core::cctp` does: a codec that refused an unknown version could not be used to look
 * at one, and looking at a message you are not going to act on is a thing an indexer does all
 * day. Enforcement belongs to whoever is about to move money, and on Stellar that is
 * `hyperion-adapter-cctp`, which makes precisely these two checks and returns
 * `UnsupportedMessageVersion` for either.
 *
 * This exists so a keeper or an app applies the same rule as the contract instead of writing its
 * own slightly different one, and finding out about the difference from a transfer that the chain
 * refused after the app said it was fine.
 */
export function assertSupportedMessage(message: CctpMessage): void {
  if (message.version !== MESSAGE_VERSION) {
    fail(
      "UnsupportedMessageVersion",
      `header version ${String(message.version)}, expected ${String(MESSAGE_VERSION)}`,
    );
  }
}

export function assertSupportedBurn(burn: CctpBurnMessage): void {
  if (burn.version !== BURN_MESSAGE_VERSION) {
    fail(
      "UnsupportedMessageVersion",
      `burn version ${String(burn.version)}, expected ${String(BURN_MESSAGE_VERSION)}`,
    );
  }
}

/** Whether Circle attested this at finalised confidence rather than fast confidence. */
export function isFinalized(message: CctpMessage): boolean {
  return message.finalityThresholdExecuted >= FINALITY_THRESHOLD_FINALIZED;
}

/**
 * The bottom eight bytes of the nonce, which is what an explorer shows and what a support
 * conversation tends to quote.
 *
 * Never used as a key. Thirty two bytes is the real identifier, and truncating it for display is
 * only safe because nothing downstream of this treats the result as unique.
 */
export function displayNonce(message: CctpMessage): bigint {
  return bytesToBigInt(fromHex(message.nonce).slice(24, 32));
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) fail("MalformedMessage", "a field runs past the message");
  return Number(bytesToBigInt(bytes.slice(offset, offset + 4)));
}

function readWord(bytes: Uint8Array, offset: number): Hex {
  if (offset + 32 > bytes.length) fail("MalformedMessage", "a word runs past the message");
  return toHex(bytes.slice(offset, offset + 32));
}

/**
 * A uint256 that has to fit in an i128 to be usable on Stellar.
 *
 * Refusing rather than truncating is the whole point. An amount that genuinely needs more than a
 * hundred and twenty seven bits cannot live in a Soroban balance at all, and quietly keeping the
 * low half would turn an absurd number into a plausible one.
 */
function readAmount(bytes: Uint8Array, offset: number): bigint {
  if (offset + 32 > bytes.length) fail("MalformedMessage", "an amount runs past the message");
  const value = bytesToBigInt(bytes.slice(offset, offset + 32));
  if (value > (1n << 127n) - 1n) fail("DecimalOverflow", "that amount does not fit a Soroban i128");
  return value;
}
