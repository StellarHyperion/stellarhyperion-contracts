/**
 * The arithmetic of moving a balance between two chains that disagree about what a decimal is.
 *
 * Stellar carries seven. USDC on every EVM chain carries six. That one digit is the difference
 * between a transfer that lands and a transfer that lands slightly short, and the difference
 * compounds silently, which is why none of this is ever written inline anywhere. It is written
 * once here, once in `AmountMath.sol`, once in `hyperion_core::amount`, and all three are held to
 * the same numbers by tests.
 *
 * Everything below is `bigint`. A `number` cannot hold a `uint256`, and it cannot even hold a
 * muxed sub account id, so the temptation is removed by not offering the type.
 */
import { fail } from "./errors.js";

/** Past this and ten to the power of it stops fitting in a word. */
export const MAX_DECIMALS = 38;

/**
 * One percent, in basis points, and the hard ceiling on the protocol fee.
 *
 * The cap lives in the contract rather than in a policy document because a fee an operator can
 * raise without limit is not a fee, it is a claim on everything in flight.
 */
export const MAX_FEE_BPS = 100;

export const BPS_DENOMINATOR = 10_000n;

const MAX_UINT256 = (1n << 256n) - 1n;

/** Ten to the power of `exp`, refusing an exponent no token has. */
export function pow10(exp: number): bigint {
  if (!Number.isInteger(exp) || exp < 0 || exp > MAX_DECIMALS) {
    fail("DecimalOverflow", `ten to the ${String(exp)} is not a token precision`);
  }
  return 10n ** BigInt(exp);
}

export interface ConvertResult {
  /** The amount in the destination's base units. */
  readonly converted: bigint;
  /** What could not be represented there. */
  readonly dust: bigint;
}

/**
 * Move an amount between two precisions, and say what did not fit.
 *
 * Dust is returned rather than swallowed. Hyperion never keeps it and never rounds it up, so the
 * caller has to decide out loud: floor it and charge less, or refuse the transfer.
 */
export function convertDecimals(amount: bigint, from: number, to: number): ConvertResult {
  assertDecimals(from);
  assertDecimals(to);
  if (from === to) return { converted: amount, dust: 0n };

  if (to > from) {
    const factor = pow10(to - from);
    // The overflow would be caught anyway, but naming the reason is worth the branch.
    if (amount !== 0n && factor > MAX_UINT256 / amount) {
      fail("DecimalOverflow", "widening that amount leaves the word");
    }
    return { converted: amount * factor, dust: 0n };
  }

  const divisor = pow10(from - to);
  return { converted: amount / divisor, dust: amount % divisor };
}

/** Convert, or refuse if anything at all would be lost. */
export function convertDecimalsExact(amount: bigint, from: number, to: number): bigint {
  const { converted, dust } = convertDecimals(amount, from, to);
  if (dust !== 0n) fail("AmountNotRepresentable", `${dust.toString()} would be lost`);
  return converted;
}

/**
 * Round an amount down to something the destination can actually express.
 *
 * Down, never up. Rounding up means the protocol owes money it was not given.
 */
export function floorToRepresentable(amount: bigint, from: number, to: number): bigint {
  assertDecimals(from);
  assertDecimals(to);
  if (to >= from) return amount;
  const divisor = pow10(from - to);
  return amount - (amount % divisor);
}

export interface FeeSplit {
  /** What crosses. */
  readonly net: bigint;
  /** What the protocol keeps. */
  readonly fee: bigint;
}

/**
 * Split an amount into what crosses and what the protocol keeps.
 *
 * Two values of the same type, one careless swap away from charging a ninety nine percent fee,
 * which is why they are returned in a named object here instead of a tuple.
 *
 * The fee is charged on the outbound leg only and denominated in the asset being bridged, so the
 * number somebody was shown does not drift with a gas market they never looked at.
 */
export function applyFee(amount: bigint, feeBps: number): FeeSplit {
  if (amount === 0n) fail("InvalidAmount", "nothing to send");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    fail("FeeTooHigh", `${String(feeBps)} basis points is past the cap of ${String(MAX_FEE_BPS)}`);
  }
  const fee = (amount * BigInt(feeBps)) / BPS_DENOMINATOR;
  const net = amount - fee;
  // Only reachable if the ceiling were ever raised to ten thousand. Kept because the invariant
  // worth stating is "a transfer always delivers something", not "today's constants make it so".
  if (net === 0n) fail("InvalidAmount", "the fee ate the whole transfer");
  return { net, fee };
}

export interface InversePlan {
  /** Minimal source input amount whose forward transfer delivers at least `targetDestinationAmount`. */
  readonly requiredInput: bigint;
  /** Actual gross amount debited from the sender (`fee + net`). */
  readonly grossAmount: bigint;
  /** Protocol fee in source base units. */
  readonly fee: bigint;
  /** Floored net amount crossing the rail in source base units. */
  readonly net: bigint;
  /** Unpulled source precision dust (`requiredInput - grossAmount`), in source base units. */
  readonly dust: bigint;
  /** Actual amount arriving on the destination chain in destination base units. */
  readonly destinationAmount: bigint;
}

/**
 * Compute the minimal source base-unit input required so that after subtracting the floored
 * protocol fee and flooring to destination precision, at least `targetDestinationAmount` arrives
 * in destination base units.
 */
export function planSourceForTarget(
  targetDestinationAmount: bigint,
  sourceDecimals: number,
  destinationDecimals: number,
  feeBps: number,
): InversePlan {
  assertDecimals(sourceDecimals);
  assertDecimals(destinationDecimals);
  if (targetDestinationAmount <= 0n) {
    fail("InvalidAmount", "target destination amount must be positive");
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    fail("FeeTooHigh", `${String(feeBps)} basis points is past the cap of ${String(MAX_FEE_BPS)}`);
  }

  let requiredNetSource: bigint;
  if (sourceDecimals >= destinationDecimals) {
    const scale = pow10(sourceDecimals - destinationDecimals);
    if (targetDestinationAmount > MAX_UINT256 / scale) {
      fail("DecimalOverflow", "target destination amount overflows uint256 in source units");
    }
    requiredNetSource = targetDestinationAmount * scale;
  } else {
    const factor = pow10(destinationDecimals - sourceDecimals);
    requiredNetSource = (targetDestinationAmount + factor - 1n) / factor;
  }

  // `netRaw(A) = A - floor(A * feeBps / 10_000) = ceil(A * keep / 10_000)`.
  // `ceil(A * keep / 10_000) >= R` iff `A * keep >= (R - 1) * 10_000 + 1`, so the minimal integer
  // `A` is `ceil(((R - 1) * 10_000 + 1) / keep) = ((R - 1) * 10_000 + keep) / keep`.
  const keep = BPS_DENOMINATOR - BigInt(feeBps);
  const requiredInput = ((requiredNetSource - 1n) * BPS_DENOMINATOR + keep) / keep;
  if (requiredInput > MAX_UINT256) {
    fail("DecimalOverflow", "required source input overflows uint256");
  }

  const { fee, net: netRaw } = applyFee(requiredInput, feeBps);
  const net = floorToRepresentable(netRaw, sourceDecimals, destinationDecimals);
  const destinationAmount = convertDecimalsExact(net, sourceDecimals, destinationDecimals);
  const grossAmount = fee + net;
  return {
    requiredInput,
    grossAmount,
    fee,
    net,
    dust: requiredInput - grossAmount,
    destinationAmount,
  };
}

/**
 * Format a base unit amount as a canonical decimal string, without a rounding surprise.
 *
 * String arithmetic rather than division into a float, because a float cannot hold a `uint256` and
 * the one place a bridge cannot afford to be approximately right is the number on the button
 * somebody is about to press.
 *
 * Canonical means no thousands separators and no locale. That is a deliberate refusal: a comma is
 * a decimal point in most of Europe, so a package that groups digits here would be handing a
 * German reader a number ten to the third out. Grouping is a presentation decision and it belongs
 * in the app, where `Intl.NumberFormat` already knows whose conventions to use. What comes out of
 * here goes straight back into `parseUnits` unchanged, which is what makes it safe to put in an
 * input field.
 *
 * Truncates rather than rounds when `maxFractionDigits` is set, because rounding a balance up
 * shows somebody money they cannot send.
 */
export function formatUnits(amount: bigint, decimals: number, maxFractionDigits?: number): string {
  assertDecimals(decimals);
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const divisor = pow10(decimals);
  const whole = magnitude / divisor;
  const fraction = magnitude % divisor;

  let fractionText = decimals === 0 ? "" : fraction.toString().padStart(decimals, "0");
  if (maxFractionDigits !== undefined && fractionText.length > maxFractionDigits) {
    fractionText = fractionText.slice(0, maxFractionDigits);
  }
  fractionText = fractionText.replace(/0+$/, "");

  const body = fractionText.length === 0 ? whole.toString() : `${whole.toString()}.${fractionText}`;
  return negative ? `-${body}` : body;
}

/**
 * A typed amount back into base units, refusing more precision than the asset has.
 *
 * Refusing rather than truncating, because somebody who typed eight decimals of a seven decimal
 * asset meant something, and quietly dropping the last digit is the bug that gets reported as
 * "the app stole a stroop".
 */
export function parseUnits(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  // Strict on purpose. No whitespace, no grouping separators, no sign, no exponent. An amount is
  // unsigned everywhere in this protocol, and a parser that accepted "-1" here would hand a
  // negative into `applyFee` and surface three frames later as something unrelated. For input a
  // person is typing, `parseAmountInput` does the tidying first and then calls this.
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(value)) {
    fail("InvalidAmount", `"${value}" is not an amount`);
  }
  const [wholeText = "", fractionText = ""] = value.split(".");
  if (fractionText.length > decimals) {
    fail(
      "AmountNotRepresentable",
      `that asset carries ${String(decimals)} decimals and you typed ${String(fractionText.length)}`,
    );
  }
  const padded = fractionText.padEnd(decimals, "0");
  return BigInt(`${wholeText === "" ? "0" : wholeText}${padded}`);
}

/**
 * The same thing, for text a person is typing or pasting.
 *
 * Trims, and drops the grouping separators a copied figure arrives with, then hands the result to
 * the strict parser. Only separators that cannot be a decimal point are removed: a space, a
 * narrow no break space, an apostrophe and an underscore. A comma and a full stop are both a
 * decimal point somewhere, so guessing which one somebody meant in "1,234" is a guess about
 * whether they want one dollar or a thousand, and a bridge does not get to guess that.
 */
export function parseAmountInput(value: string, decimals: number): bigint {
  const tidied = value.trim().replace(/[\s\u202f\u00a0'_]/g, "");
  return parseUnits(tidied, decimals);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    fail("InvalidDecimals", `${String(decimals)} is not a token precision`);
  }
}
