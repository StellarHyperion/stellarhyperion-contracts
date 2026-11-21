import { describe, expect, it } from "vitest";
import {
  BPS_DENOMINATOR,
  applyFee,
  convertDecimals,
  floorToRepresentable,
} from "../src/amounts.js";

type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator <= 0n) throw new Error("rational denominator must be positive");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function multiply(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function floor(value: Rational): bigint {
  if (value.numerator < 0n) throw new Error("oracle only models unsigned amounts");
  return value.numerator / value.denominator;
}

function scaled(amount: bigint, from: number, to: number): Rational {
  return rational(amount * 10n ** BigInt(to), 10n ** BigInt(from));
}

function oracleConvert(amount: bigint, from: number, to: number) {
  if (from === to) return { converted: amount, dust: 0n };
  if (to > from) return { converted: floor(scaled(amount, from, to)), dust: 0n };

  const divisor = 10n ** BigInt(from - to);
  const converted = floor(scaled(amount, from, to));
  return { converted, dust: amount - converted * divisor };
}

function oracleFloor(amount: bigint, from: number, to: number): bigint {
  if (to >= from) return amount;
  const divisor = 10n ** BigInt(from - to);
  return floor(scaled(amount, from, to)) * divisor;
}

function oracleFee(amount: bigint, feeBps: number) {
  const fee = floor(multiply(rational(amount), rational(BigInt(feeBps), BPS_DENOMINATOR)));
  return { net: amount - fee, fee };
}

function corpus(): Array<readonly [bigint, number, number]> {
  let state = 0x155da11n;
  const cases: Array<readonly [bigint, number, number]> = [
    [1n, 7, 6],
    [9n, 7, 6],
    [10n, 7, 6],
    [10_000_001n, 7, 6],
    [(1n << 255n) + 123_456_789n, 38, 0],
  ];
  for (let index = 0; index < 96; index += 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffffn;
    const amount = (BigInt(state) << BigInt(index % 17)) + BigInt(index + 1);
    const from = Number(state % 39n);
    const to = Number((state / 39n) % 39n);
    cases.push([amount, from, to]);
  }
  return cases;
}

describe("SDK bigint arithmetic against an independent rational oracle", () => {
  it("matches exact fee splits across generated bigint inputs", () => {
    for (const [amount] of corpus()) {
      const feeBps = Number(amount % 101n);
      expect(applyFee(amount + 1n, feeBps)).toEqual(oracleFee(amount + 1n, feeBps));
    }
  });

  it("matches conversion and dust for both widening and narrowing", () => {
    for (const [amount, from, to] of corpus()) {
      expect(convertDecimals(amount, from, to)).toEqual(oracleConvert(amount, from, to));
      expect(floorToRepresentable(amount, from, to)).toBe(oracleFloor(amount, from, to));
    }
  });

  it("would catch a one-unit rounding mutation at the dust boundary", () => {
    const expected = oracleConvert(10_000_001n, 7, 6);
    const mutated = { converted: expected.converted + 1n, dust: expected.dust };
    expect(mutated).not.toEqual(expected);
    expect(convertDecimals(10_000_001n, 7, 6)).toEqual(expected);
  });
});
