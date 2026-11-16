import { describe, expect, it } from "vitest";

import {
  applyFee,
  BPS_DENOMINATOR,
  convertDecimals,
  convertDecimalsExact,
  floorToRepresentable,
  MAX_DECIMALS,
  MAX_FEE_BPS,
  planSourceForTarget,
} from "../src/amounts.js";
import {
  MAX_QUOTE_AMOUNT,
  minimumFromTolerance,
  planInverseQuote,
  planQuote,
  quoteBatch,
  QuoteBlocker,
  type RouterSnapshot,
} from "../src/quotes.js";
import { RouteKind } from "../src/routes.js";
import { G_ADDR } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Independent exact Rational-Number Oracle over Q = { num / den : gcd(|num|, den) = 1, den > 0 }
// ---------------------------------------------------------------------------

function absBigInt(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = absBigInt(a);
  let y = absBigInt(b);
  while (y !== 0n) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x;
}

class Rational {
  readonly num: bigint;
  readonly den: bigint;

  constructor(num: bigint, den = 1n) {
    if (den === 0n) {
      throw new RangeError("Rational denominator cannot be zero");
    }
    const sign = den < 0n ? -1n : 1n;
    const n = num * sign;
    const d = den * sign;
    const g = gcdBigInt(n, d);
    this.num = n / g;
    this.den = d / g;
  }

  static fromInt(value: bigint): Rational {
    return new Rational(value, 1n);
  }

  static pow10(exp: number): Rational {
    let acc = 1n;
    const absExp = Math.abs(exp);
    for (let i = 0; i < absExp; i += 1) {
      acc *= 10n;
    }
    return exp >= 0 ? new Rational(acc, 1n) : new Rational(1n, acc);
  }

  add(other: Rational): Rational {
    return new Rational(this.num * other.den + other.num * this.den, this.den * other.den);
  }

  sub(other: Rational): Rational {
    return new Rational(this.num * other.den - other.num * this.den, this.den * other.den);
  }

  mul(other: Rational): Rational {
    return new Rational(this.num * other.num, this.den * other.den);
  }

  div(other: Rational): Rational {
    if (other.num === 0n) {
      throw new RangeError("Division by zero Rational");
    }
    return new Rational(this.num * other.den, this.den * other.num);
  }

  cmp(other: Rational): -1 | 0 | 1 {
    const lhs = this.num * other.den;
    const rhs = other.num * this.den;
    if (lhs < rhs) return -1;
    if (lhs > rhs) return 1;
    return 0;
  }

  /**
   * Mathematical floor `m = floor(num / den)` verified directly against the defining inequality
   * `m * den <= num < (m + 1) * den` across all signs.
   */
  floor(): bigint {
    const q = this.num / this.den;
    const r = this.num % this.den;
    const candidate = r < 0n ? q - 1n : q;
    if (!(candidate * this.den <= this.num && this.num < (candidate + 1n) * this.den)) {
      throw new Error("Rational floor inequality violated");
    }
    return candidate;
  }

  /**
   * Mathematical ceiling `c = ceil(num / den)` verified directly against the defining inequality
   * `(c - 1) * den < num <= c * den`.
   */
  ceil(): bigint {
    const negFloor = new Rational(-this.num, this.den).floor();
    const candidate = -negFloor;
    if (!((candidate - 1n) * this.den < this.num && this.num <= candidate * this.den)) {
      throw new Error("Rational ceil inequality violated");
    }
    return candidate;
  }

  exactBigInt(): bigint {
    if (this.den !== 1n) {
      throw new Error(
        `Expected exact integer Rational, got ${this.num.toString()}/${this.den.toString()}`,
      );
    }
    return this.num;
  }
}

// ---------------------------------------------------------------------------
// Distinct source and destination unit domains (compile-time branded + runtime guarded)
// ---------------------------------------------------------------------------

declare const SOURCE_BRAND: unique symbol;
declare const DESTINATION_BRAND: unique symbol;

export class UnitMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitMismatchError";
  }
}

interface SourceUnits {
  readonly [SOURCE_BRAND]: true;
  readonly unit: "source";
  readonly decimals: number;
  readonly raw: bigint;
}

interface DestinationUnits {
  readonly [DESTINATION_BRAND]: true;
  readonly unit: "destination";
  readonly decimals: number;
  readonly raw: bigint;
}

function sourceUnits(raw: bigint, decimals: number): SourceUnits {
  return { unit: "source", decimals, raw } as SourceUnits;
}

function destinationUnits(raw: bigint, decimals: number): DestinationUnits {
  return { unit: "destination", decimals, raw } as DestinationUnits;
}

function assertSameUnitDomain<T extends { readonly unit: string; readonly decimals: number }>(
  a: T,
  b: T,
): void {
  if (a.unit !== b.unit || a.decimals !== b.decimals) {
    throw new UnitMismatchError(
      `Cannot combine ${a.unit}(decimals=${String(a.decimals)}) with ${b.unit}(decimals=${String(b.decimals)})`,
    );
  }
}

function addSource(a: SourceUnits, b: SourceUnits): SourceUnits {
  assertSameUnitDomain(a, b);
  return sourceUnits(a.raw + b.raw, a.decimals);
}

function subSource(a: SourceUnits, b: SourceUnits): SourceUnits {
  assertSameUnitDomain(a, b);
  return sourceUnits(a.raw - b.raw, a.decimals);
}

function toWholeTokens(quantity: SourceUnits | DestinationUnits): Rational {
  return Rational.fromInt(quantity.raw).mul(Rational.pow10(-quantity.decimals));
}

interface OracleForwardResult {
  readonly input: SourceUnits;
  readonly fee: SourceUnits;
  readonly netRaw: SourceUnits;
  readonly netCrossed: SourceUnits;
  readonly grossDebited: SourceUnits;
  readonly unpulledDust: SourceUnits;
  readonly destinationDelivered: DestinationUnits;
}

/**
 * Independent whole-token rational oracle for fee deduction, decimal projection, and sender dust.
 *
 * Operates exclusively in reduced fractions over whole tokens and lattice projections (`10^-d_s`
 * and `10^-d_d`) without calling any SDK arithmetic helper.
 */
function oracleForwardTransfer(
  input: SourceUnits,
  destinationDecimals: number,
  feeBps: number,
): OracleForwardResult {
  const sourceScale = Rational.pow10(input.decimals);
  const destScale = Rational.pow10(destinationDecimals);
  const feeRate = new Rational(BigInt(feeBps), 10_000n);

  // 1. Exact rational fee in whole tokens, projected onto the source lattice by floor.
  const wholeInput = toWholeTokens(input);
  const exactFeeSourceUnits = wholeInput.mul(feeRate).mul(sourceScale);
  const fee = sourceUnits(exactFeeSourceUnits.floor(), input.decimals);

  // 2. Remaining whole-token value after floored source fee.
  const netRaw = subSource(input, fee);
  const wholeAfterFee = toWholeTokens(netRaw);

  // 3. Project onto destination base-unit lattice via floor; whatever cannot fit stays in source.
  const deliveredRaw = wholeAfterFee.mul(destScale).floor();
  const destinationDelivered = destinationUnits(deliveredRaw, destinationDecimals);

  const wholeDelivered = toWholeTokens(destinationDelivered);
  const wholeDust = wholeAfterFee.sub(wholeDelivered);
  const netCrossed = sourceUnits(wholeDelivered.mul(sourceScale).exactBigInt(), input.decimals);
  const unpulledDust = sourceUnits(wholeDust.mul(sourceScale).exactBigInt(), input.decimals);
  const grossDebited = addSource(fee, netCrossed);

  return {
    input,
    fee,
    netRaw,
    netCrossed,
    grossDebited,
    unpulledDust,
    destinationDelivered,
  };
}

/**
 * Independent rational-bracket + monotone binary search oracle for inverse planning.
 *
 * Finds the unique minimal `SourceUnits` input `A >= 1` whose forward transfer delivers at least
 * `target` in `DestinationUnits`, without sharing the production closed-form integer equation.
 */
function oracleInverseTransfer(
  target: DestinationUnits,
  sourceDecimals: number,
  feeBps: number,
): OracleForwardResult {
  if (target.raw <= 0n) {
    throw new RangeError("Oracle target must be positive");
  }
  const sourceScale = Rational.pow10(sourceDecimals);
  const keepRate = new Rational(10_000n - BigInt(feeBps), 10_000n);
  const wholeTarget = toWholeTokens(target);

  // Exact rational continuous approximation `wholeTarget * 10^sourceDecimals / (1 - feeRate)`.
  const approxSource = wholeTarget.mul(sourceScale).div(keepRate);
  let low = 1n;
  const floorApprox = approxSource.floor();
  if (floorApprox > 16n) {
    low = floorApprox - 16n;
  }
  let high = approxSource.ceil() + sourceScale.ceil() + 32n;
  while (
    oracleForwardTransfer(sourceUnits(high, sourceDecimals), target.decimals, feeBps)
      .destinationDelivered.raw < target.raw
  ) {
    high *= 2n;
  }

  while (low < high) {
    const mid = (low + high) / 2n;
    const res = oracleForwardTransfer(sourceUnits(mid, sourceDecimals), target.decimals, feeBps);
    if (res.destinationDelivered.raw >= target.raw) {
      high = mid;
    } else {
      low = mid + 1n;
    }
  }

  const optimal = oracleForwardTransfer(sourceUnits(low, sourceDecimals), target.decimals, feeBps);
  if (optimal.destinationDelivered.raw < target.raw) {
    throw new Error("Oracle binary search failed feasibility");
  }
  if (low > 1n) {
    const prev = oracleForwardTransfer(
      sourceUnits(low - 1n, sourceDecimals),
      target.decimals,
      feeBps,
    );
    if (prev.destinationDelivered.raw >= target.raw) {
      throw new Error("Oracle binary search failed minimality");
    }
  }
  return optimal;
}

function openSnapshot(tokenDecimals: number, feeBps: number): RouterSnapshot {
  const all = <T>(val: T): Record<RouteKind, T> => ({
    [RouteKind.Cctp]: val,
    [RouteKind.AxelarIts]: val,
    [RouteKind.AxelarGmp]: val,
    [RouteKind.Allbridge]: val,
  });
  return {
    paused: false,
    feeBps,
    routeEnabled: all(true),
    adapterSet: all(true),
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals,
    flowAvailable: all(MAX_QUOTE_AMOUNT),
    chainSupported: all(true),
  };
}

describe("SDK bigint arithmetic differential tests against a rational oracle", () => {
  it("enforces compile-time and runtime separation between source and destination units", () => {
    const src7 = sourceUnits(10_000_000n, 7);
    const dst6 = destinationUnits(1_000_000n, 6);

    // Same economic value (1 whole token), distinct base-unit domains.
    expect(toWholeTokens(src7).cmp(toWholeTokens(dst6))).toBe(0);
    expect(src7.raw).not.toBe(dst6.raw);

    expect(() => {
      // @ts-expect-error: deliberately passing DestinationUnits where SourceUnits is required
      addSource(src7, dst6);
    }).toThrow(UnitMismatchError);

    const src6 = sourceUnits(1_000_000n, 6);
    expect(() => addSource(src7, src6)).toThrow(UnitMismatchError);
  });

  it("matches documented floor conventions across boundary precisions, fees, and MAX_QUOTE_AMOUNT", () => {
    const decimalPairs: readonly (readonly [number, number])[] = [
      [7, 6], // Active Stellar -> EVM USDC narrowing
      [6, 7], // EVM -> Stellar USDC widening
      [6, 6],
      [18, 6],
      [6, 18],
      [8, 6],
      [0, 18],
      [18, 0],
      [MAX_DECIMALS, 6],
      [6, MAX_DECIMALS],
    ];
    const feeRates = [0, 1, 3, 7, 10, 30, 99, MAX_FEE_BPS] as const;
    const boundaryAmounts = [
      1n,
      2n,
      9n,
      10n,
      11n,
      99n,
      100n,
      101n,
      9_998n,
      9_999n,
      10_000n,
      10_001n,
      999_999n,
      1_000_000n,
      1_000_001n,
      10_000_009n,
      19_999_999n,
      10n ** 18n - 1n,
      10n ** 18n,
      10n ** 18n + 1n,
    ] as const;

    for (const [srcDec, dstDec] of decimalPairs) {
      for (const amount of boundaryAmounts) {
        // Direct decimal conversion & flooring parity with Q lattice projection at 0 fee.
        const zeroFeeOracle = oracleForwardTransfer(sourceUnits(amount, srcDec), dstDec, 0);
        const conv = convertDecimals(amount, srcDec, dstDec);
        expect(conv.converted).toBe(zeroFeeOracle.destinationDelivered.raw);
        expect(conv.dust).toBe(zeroFeeOracle.unpulledDust.raw);

        const floored = floorToRepresentable(amount, srcDec, dstDec);
        expect(floored).toBe(zeroFeeOracle.netCrossed.raw);
        if (floored > 0n) {
          expect(convertDecimalsExact(floored, srcDec, dstDec)).toBe(
            zeroFeeOracle.destinationDelivered.raw,
          );
        }
      }

      for (const feeBps of feeRates) {
        const snap = openSnapshot(srcDec, feeBps);
        for (const amount of boundaryAmounts) {
          const oracle = oracleForwardTransfer(sourceUnits(amount, srcDec), dstDec, feeBps);
          const sdkSplit = applyFee(amount, feeBps);
          expect(sdkSplit.fee).toBe(oracle.fee.raw);
          expect(sdkSplit.net).toBe(oracle.netRaw.raw);

          // Exact whole-token conservation: input == fee + netCrossed + unpulledDust.
          expect(addSource(addSource(oracle.fee, oracle.netCrossed), oracle.unpulledDust).raw).toBe(
            amount,
          );

          const quote = planQuote(
            {
              route: RouteKind.Cctp,
              amount,
              strkey: G_ADDR,
              destinationDecimals: dstDec,
            },
            snap,
          );

          if (oracle.netCrossed.raw === 0n) {
            expect(quote.available).toBe(false);
            expect(quote.reason).toBe(QuoteBlocker.NotRepresentable);
          } else {
            expect(quote.available).toBe(true);
            expect(quote.fee).toBe(oracle.fee.raw);
            expect(quote.netAmount).toBe(oracle.netCrossed.raw);
            expect(quote.grossAmount).toBe(oracle.grossDebited.raw);
            expect(quote.destinationAmount).toBe(oracle.destinationDelivered.raw);
            expect(amount - quote.grossAmount).toBe(oracle.unpulledDust.raw);
          }
        }
      }
    }

    // Verify MAX_QUOTE_AMOUNT boundary and slippage tolerance floor convention.
    const maxOracle = oracleForwardTransfer(sourceUnits(MAX_QUOTE_AMOUNT, 7), 6, 10);
    const maxQuote = planQuote(
      {
        route: RouteKind.AxelarIts,
        amount: MAX_QUOTE_AMOUNT,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      openSnapshot(7, 10),
    );
    expect(maxQuote.available).toBe(true);
    expect(maxQuote.fee).toBe(maxOracle.fee.raw);
    expect(maxQuote.destinationAmount).toBe(maxOracle.destinationDelivered.raw);

    const overMaxQuote = planQuote(
      {
        route: RouteKind.AxelarIts,
        amount: MAX_QUOTE_AMOUNT + 1n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      openSnapshot(7, 10),
    );
    expect(overMaxQuote.available).toBe(false);
    expect(overMaxQuote.reason).toBe(QuoteBlocker.NotRepresentable);

    for (const tolBps of [0, 1, 7, 50, 333, 9_999, 10_000]) {
      const expectedMin = new Rational(
        maxQuote.destinationAmount * (BPS_DENOMINATOR - BigInt(tolBps)),
        BPS_DENOMINATOR,
      ).floor();
      expect(minimumFromTolerance(maxQuote, tolBps)).toBe(expectedMin);
    }

    // Batch quote ladder agrees with oracle on every tier.
    const batch = quoteBatch([10n, 10_000_007n, 500_000_003n], {
      strkey: G_ADDR,
      destinationDecimals: 6,
      snapshot: openSnapshot(7, 10),
    });
    for (const row of batch) {
      const expected = oracleForwardTransfer(sourceUnits(row.amount, 7), 6, 10);
      expect(row.available).toBe(true);
      expect(row.fee).toBe(expected.fee.raw);
      expect(row.netAmount).toBe(expected.netCrossed.raw);
      expect(row.grossAmount).toBe(expected.grossDebited.raw);
      expect(row.destinationAmount).toBe(expected.destinationDelivered.raw);
    }
  });

  it("matches the rational oracle on inverse source-from-destination planning", () => {
    const cases: readonly (readonly [number, number])[] = [
      [7, 6],
      [6, 7],
      [6, 6],
      [18, 6],
      [6, 18],
    ];
    const fees = [0, 1, 10, 30, MAX_FEE_BPS] as const;
    const targets = [
      1n,
      2n,
      9n,
      10n,
      11n,
      997n,
      9_969n,
      9_970n,
      9_971n,
      999_000n,
      1_000_000n,
      10_000_003n,
      123_456_789n,
    ] as const;

    for (const [srcDec, dstDec] of cases) {
      for (const feeBps of fees) {
        const snap = openSnapshot(srcDec, feeBps);
        for (const rawTarget of targets) {
          const target = destinationUnits(rawTarget, dstDec);
          const oracleOpt = oracleInverseTransfer(target, srcDec, feeBps);
          const sdkInv = planSourceForTarget(rawTarget, srcDec, dstDec, feeBps);

          expect(sdkInv.requiredInput).toBe(oracleOpt.input.raw);
          expect(sdkInv.fee).toBe(oracleOpt.fee.raw);
          expect(sdkInv.net).toBe(oracleOpt.netCrossed.raw);
          expect(sdkInv.grossAmount).toBe(oracleOpt.grossDebited.raw);
          expect(sdkInv.dust).toBe(oracleOpt.unpulledDust.raw);
          expect(sdkInv.destinationAmount).toBe(oracleOpt.destinationDelivered.raw);
          expect(sdkInv.destinationAmount).toBeGreaterThanOrEqual(rawTarget);

          const invQuote = planInverseQuote(
            {
              route: RouteKind.Cctp,
              targetDestinationAmount: rawTarget,
              strkey: G_ADDR,
              destinationDecimals: dstDec,
            },
            snap,
          );
          expect(invQuote.available).toBe(true);
          expect(invQuote.grossAmount).toBe(oracleOpt.grossDebited.raw);
          expect(invQuote.destinationAmount).toBe(oracleOpt.destinationDelivered.raw);
        }
      }
    }
  });

  it("detects deliberate rounding, ordering, dust-swallowing, and unit-confusion mutations", () => {
    interface ForwardCandidate {
      readonly name: string;
      readonly run: (
        amount: bigint,
        srcDec: number,
        dstDec: number,
        feeBps: number,
      ) => {
        readonly fee: bigint;
        readonly netCrossed: bigint;
        readonly grossDebited: bigint;
        readonly destinationDelivered: bigint;
      };
    }

    const mutants: readonly ForwardCandidate[] = [
      {
        name: "ceil-fee-mutant",
        run: (amount, srcDec, dstDec, feeBps) => {
          const fee = (amount * BigInt(feeBps) + 9_999n) / 10_000n;
          const netCrossed = floorToRepresentable(amount - fee, srcDec, dstDec);
          return {
            fee,
            netCrossed,
            grossDebited: fee + netCrossed,
            destinationDelivered: convertDecimals(netCrossed, srcDec, dstDec).converted,
          };
        },
      },
      {
        name: "half-up-fee-mutant",
        run: (amount, srcDec, dstDec, feeBps) => {
          const fee = (amount * BigInt(feeBps) + 5_000n) / 10_000n;
          const netCrossed = floorToRepresentable(amount - fee, srcDec, dstDec);
          return {
            fee,
            netCrossed,
            grossDebited: fee + netCrossed,
            destinationDelivered: convertDecimals(netCrossed, srcDec, dstDec).converted,
          };
        },
      },
      {
        name: "half-up-decimal-narrowing-mutant",
        run: (amount, srcDec, dstDec, feeBps) => {
          const { fee, net } = applyFee(amount, feeBps);
          const divisor = 10n ** BigInt(srcDec - dstDec);
          const destinationDelivered = (net + divisor / 2n) / divisor;
          const netCrossed = destinationDelivered * divisor;
          return {
            fee,
            netCrossed,
            grossDebited: fee + netCrossed,
            destinationDelivered,
          };
        },
      },
      {
        name: "floor-before-fee-ordering-mutant",
        run: (amount, srcDec, dstDec, feeBps) => {
          const flooredInput = floorToRepresentable(amount, srcDec, dstDec);
          if (flooredInput === 0n) {
            return { fee: 0n, netCrossed: 0n, grossDebited: 0n, destinationDelivered: 0n };
          }
          const { fee, net } = applyFee(flooredInput, feeBps);
          const netCrossed = floorToRepresentable(net, srcDec, dstDec);
          return {
            fee,
            netCrossed,
            grossDebited: fee + netCrossed,
            destinationDelivered: convertDecimals(netCrossed, srcDec, dstDec).converted,
          };
        },
      },
      {
        name: "swallow-unpulled-dust-in-gross-mutant",
        run: (amount, srcDec, dstDec, feeBps) => {
          const { fee, net } = applyFee(amount, feeBps);
          const netCrossed = floorToRepresentable(net, srcDec, dstDec);
          return {
            fee,
            netCrossed,
            grossDebited: amount, // Bug: debits dust that never crossed
            destinationDelivered: convertDecimals(netCrossed, srcDec, dstDec).converted,
          };
        },
      },
      {
        name: "unit-confused-destination-minus-source-fee-mutant",
        run: (amount, srcDec, dstDec, feeBps) => {
          const { fee, net } = applyFee(amount, feeBps);
          const netCrossed = floorToRepresentable(net, srcDec, dstDec);
          const rawScaled = convertDecimals(amount, srcDec, dstDec).converted;
          return {
            fee,
            netCrossed,
            grossDebited: fee + netCrossed,
            destinationDelivered: rawScaled - fee, // Bug: subtracts 7-dec fee from 6-dec amount
          };
        },
      },
    ];

    const probeInputs: readonly (readonly [bigint, number, number, number])[] = [
      [1n, 7, 6, 30],
      [167n, 7, 6, 30], // 167 * 30 = 5010 -> triggers half-up fee mutant
      [10_000_005n, 7, 6, 10], // +5 stroops -> triggers half-up narrowing & dust-swallow mutants
      [10_009n, 7, 6, 10], // 10_009 * 10 = 100_090 (fee=10) vs floored 10_000 (fee=10, net differs at 9_999)
      [9_999n, 7, 6, 10], // flooredInput=9_990 -> fee(9_990)=9 vs fee(9_999)=9, test 10_001 @ 100 bps:
      [10_005n, 7, 6, 100], // fee(10_005)=100, netRaw=9_905->9_900; floor-first: 10_000->fee=100, check 199n @ 100bps!
      [199n, 7, 6, 100], // fee(199)=1, netRaw=198->190; floor-first: 190->fee=1, netRaw=189->180!
    ];

    for (const mutant of mutants) {
      let caught = false;
      for (const [amount, srcDec, dstDec, feeBps] of probeInputs) {
        const oracle = oracleForwardTransfer(sourceUnits(amount, srcDec), dstDec, feeBps);
        const actual = mutant.run(amount, srcDec, dstDec, feeBps);
        if (
          actual.fee !== oracle.fee.raw ||
          actual.netCrossed !== oracle.netCrossed.raw ||
          actual.grossDebited !== oracle.grossDebited.raw ||
          actual.destinationDelivered !== oracle.destinationDelivered.raw
        ) {
          caught = true;
          break;
        }
      }
      expect(caught, `Rational oracle failed to catch ${mutant.name}`).toBe(true);
    }

    // Naive inverse mutant `ceil(R * 10_000 / keep)` fails at target = 9_970, feeBps = 30
    // (returns 10_000 when 9_999 already yields 9_970 because fee(9_999) floors to 29).
    const naiveInverse = (targetRaw: bigint, feeBps: number): bigint => {
      const keep = 10_000n - BigInt(feeBps);
      return (targetRaw * 10_000n + keep - 1n) / keep;
    };
    const oracleInv = oracleInverseTransfer(destinationUnits(9_970n, 6), 6, 30);
    expect(oracleInv.input.raw).toBe(9_999n);
    expect(planSourceForTarget(9_970n, 6, 6, 30).requiredInput).toBe(9_999n);
    expect(naiveInverse(9_970n, 30)).not.toBe(oracleInv.input.raw);

    // Ceiling slippage tolerance mutant is caught by rational floor check.
    const sampleQuote = planQuote(
      {
        route: RouteKind.Cctp,
        amount: 10_000_030n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      openSnapshot(7, 10),
    );
    const ceilTolerance = (destAmount: bigint, tolBps: number): bigint =>
      (destAmount * (10_000n - BigInt(tolBps)) + 9_999n) / 10_000n;
    const expectedTolFloor = new Rational(sampleQuote.destinationAmount * 9_999n, 10_000n).floor();
    expect(minimumFromTolerance(sampleQuote, 1)).toBe(expectedTolFloor);
    expect(ceilTolerance(sampleQuote.destinationAmount, 1)).not.toBe(expectedTolFloor);
  });
});
