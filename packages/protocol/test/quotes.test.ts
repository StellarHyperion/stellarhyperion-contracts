import { describe, expect, it } from "vitest";
import {
  BLOCKER_COPY,
  MAX_QUOTE_AMOUNT,
  QuoteBlocker,
  bestQuote,
  describeBlocker,
  minimumFromTolerance,
  planQuote,
  planQuotes,
  quoteBatch,
  quoteRoute,
  quoteAllRails,
  RAIL_DESTINATION_GAS_ESTIMATES,
  wouldSlip,
} from "../src/quotes.js";
import type { QuoteParams, RouterSnapshot } from "../src/quotes.js";
import { ROUTE_KINDS, RouteKind } from "../src/routes.js";
import { G_ADDR, M_ADDR } from "./fixtures.js";

/** Everything open, a thirty basis point fee, six decimals in and seven out. */
function snapshot(overrides: Partial<RouterSnapshot> = {}): RouterSnapshot {
  const all = <T>(value: T): Record<RouteKind, T> => ({
    [RouteKind.Cctp]: value,
    [RouteKind.AxelarIts]: value,
    [RouteKind.AxelarGmp]: value,
    [RouteKind.Allbridge]: value,
  });
  return {
    paused: false,
    feeBps: 30,
    routeEnabled: all(true),
    adapterSet: all(true),
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals: 6,
    flowAvailable: all(1_000_000_000n),
    chainSupported: all(true),
    ...overrides,
  };
}

const request = { amount: 1_000_000n, strkey: G_ADDR, destinationDecimals: 7 } as const;

describe("a quote that goes through", () => {
  it("splits the amount and reports what lands", () => {
    const quote = planQuote({ ...request, route: RouteKind.Cctp }, snapshot());
    expect(quote.available).toBe(true);
    expect(quote.reason).toBe(QuoteBlocker.None);
    expect(quote.fee).toBe(3_000n);
    expect(quote.netAmount).toBe(997_000n);
    expect(quote.grossAmount).toBe(1_000_000n);
    // Six decimals widening to seven, so the landing figure gains a zero.
    expect(quote.destinationAmount).toBe(9_970_000n);
  });

  it("charges the fee on the whole amount, not on what was left after flooring", () => {
    // Flooring first would charge a fee on dust that never left the chain.
    const quote = planQuote({ ...request, route: RouteKind.Cctp }, snapshot());
    expect(quote.fee + quote.netAmount).toBe(request.amount);
  });

  it("reports the headroom it checked against", () => {
    const quote = planQuote({ ...request, route: RouteKind.Cctp }, snapshot());
    expect(quote.flowAvailable).toBe(1_000_000_000n);
  });

  it("carries the rail's own character through", () => {
    const cctp = planQuote({ ...request, route: RouteKind.Cctp }, snapshot());
    expect(cctp.isCanonical).toBe(true);
    expect(cctp.waitsOnAttestation).toBe(true);

    const allbridge = planQuote({ ...request, route: RouteKind.Allbridge }, snapshot());
    expect(allbridge.isCanonical).toBe(false);
    expect(allbridge.waitsOnAttestation).toBe(false);
  });

  it("loses nothing going the other way, seven decimals down to six", () => {
    const quote = planQuote(
      { amount: 10_000_000n, strkey: G_ADDR, destinationDecimals: 6, route: RouteKind.Cctp },
      snapshot({ tokenDecimals: 7 }),
    );
    expect(quote.available).toBe(true);
    expect(quote.destinationAmount).toBe(997_000n);
    // The net was floored to something representable, so nothing is quietly dropped later.
    expect(quote.netAmount).toBe(9_970_000n);
  });
});

describe("the reasons a quote comes back empty", () => {
  it("never throws, whatever it is handed", () => {
    // The whole value of this function. An app rendering four rows cannot wrap each one in a
    // try, so even the absurd question gets a reason rather than a stack trace.
    const nonsense = [
      { amount: 0n, strkey: "", destinationDecimals: 255 },
      { amount: -1n, strkey: "nope", destinationDecimals: 0 },
      { amount: MAX_QUOTE_AMOUNT + 1n, strkey: G_ADDR, destinationDecimals: 7 },
    ];
    for (const bad of nonsense) {
      for (const route of ROUTE_KINDS) {
        expect(() => planQuote({ ...bad, route }, snapshot())).not.toThrow();
      }
    }
  });

  it("says paused first, because nothing else matters while it is", () => {
    const quote = planQuote(
      { ...request, route: RouteKind.Cctp },
      snapshot({ paused: true, tokenRegistered: false }),
    );
    expect(quote.reason).toBe(QuoteBlocker.Paused);
  });

  it("says the rail is off before it says anything about the asset", () => {
    const quote = planQuote(
      { ...request, route: RouteKind.Cctp },
      snapshot({ routeEnabled: {}, tokenRegistered: false }),
    );
    expect(quote.reason).toBe(QuoteBlocker.RouteDisabled);
  });

  it("says no adapter when a rail is enabled but not wired up", () => {
    const quote = planQuote({ ...request, route: RouteKind.Cctp }, snapshot({ adapterSet: {} }));
    expect(quote.reason).toBe(QuoteBlocker.AdapterNotSet);
  });

  it("says the address is wrong before it looks at the amount", () => {
    const quote = planQuote(
      { amount: 0n, strkey: "not an address", destinationDecimals: 7, route: RouteKind.Cctp },
      snapshot(),
    );
    expect(quote.reason).toBe(QuoteBlocker.InvalidDestination);
  });

  it("turns a muxed address down on the one rail that cannot carry it", () => {
    const allbridge = planQuote(
      { ...request, strkey: M_ADDR, route: RouteKind.Allbridge },
      snapshot(),
    );
    expect(allbridge.reason).toBe(QuoteBlocker.MuxedNotSupported);

    // The other three carry a payload, so the sub account id has somewhere to travel.
    for (const route of [RouteKind.Cctp, RouteKind.AxelarIts, RouteKind.AxelarGmp]) {
      expect(planQuote({ ...request, strkey: M_ADDR, route }, snapshot()).available).toBe(true);
    }
  });

  it("says the rail does not reach there", () => {
    const quote = planQuote(
      { ...request, route: RouteKind.Cctp },
      snapshot({ chainSupported: {} }),
    );
    expect(quote.reason).toBe(QuoteBlocker.ChainNotSupported);
  });

  it("tells an unlisted asset apart from a retired one", () => {
    // Different decisions with different fixes, so they get different answers.
    expect(
      planQuote({ ...request, route: RouteKind.Cctp }, snapshot({ tokenRegistered: false })).reason,
    ).toBe(QuoteBlocker.TokenNotRegistered);
    expect(
      planQuote({ ...request, route: RouteKind.Cctp }, snapshot({ tokenEnabled: false })).reason,
    ).toBe(QuoteBlocker.TokenDisabled);
  });

  it("says too small for nothing, and for an amount the fee would eat whole", () => {
    expect(planQuote({ ...request, amount: 0n, route: RouteKind.Cctp }, snapshot()).reason).toBe(
      QuoteBlocker.AmountTooSmall,
    );
    // At ten thousand basis points the fee is the entire amount. The cap stops this today; the
    // branch is here for the day somebody raises it.
    expect(
      planQuote({ ...request, amount: 100n, route: RouteKind.Cctp }, snapshot({ feeBps: 10_000 }))
        .reason,
    ).toBe(QuoteBlocker.AmountTooSmall);
  });

  it("says not representable for an amount wider than it will price", () => {
    const quote = planQuote(
      { ...request, amount: MAX_QUOTE_AMOUNT + 1n, route: RouteKind.Cctp },
      snapshot(),
    );
    expect(quote.reason).toBe(QuoteBlocker.NotRepresentable);
  });

  it("says not representable when flooring leaves nothing", () => {
    // Nine units of a seven decimal asset cannot cross into six decimals at all.
    const quote = planQuote(
      { amount: 9n, strkey: G_ADDR, destinationDecimals: 6, route: RouteKind.Cctp },
      snapshot({ tokenDecimals: 7, feeBps: 0 }),
    );
    expect(quote.reason).toBe(QuoteBlocker.NotRepresentable);
  });

  it("says over the limit, and still reports the headroom so the app can suggest a number", () => {
    const quote = planQuote(
      { ...request, route: RouteKind.Cctp },
      snapshot({ flowAvailable: { [RouteKind.Cctp]: 500_000n } }),
    );
    expect(quote.reason).toBe(QuoteBlocker.FlowLimitExceeded);
    expect(quote.flowAvailable).toBe(500_000n);
  });

  it("reports a tripped or exceeded per-token circuit breaker distinctly from flow limits", () => {
    const tripped = planQuote(
      { ...request, route: RouteKind.Cctp },
      snapshot({ tokenCircuitTripped: true }),
    );
    expect(tripped.available).toBe(false);
    expect(tripped.reason).toBe(QuoteBlocker.CircuitBreakerTripped);

    const exceeded = planQuote(
      { ...request, route: RouteKind.Cctp },
      snapshot({ tokenCircuitRemaining: 500_000n }),
    );
    expect(exceeded.available).toBe(false);
    expect(exceeded.reason).toBe(QuoteBlocker.CircuitBreakerTripped);

    const batch = quoteBatch([100_000n, 1_000_000n], {
      strkey: G_ADDR,
      destinationDecimals: 7,
      snapshot: snapshot({ tokenCircuitRemaining: 500_000n }),
    });
    expect(batch[0]!.available).toBe(true);
    expect(batch[1]!.available).toBe(false);
    expect(batch[1]!.quotes[0]!.reason).toBe(QuoteBlocker.CircuitBreakerTripped);
  });

  it("treats a rail missing from the snapshot as closed rather than open", () => {
    // Failing shut. An absent key is an unknown, and an unknown rail is not a rail to send on.
    const quote = planQuote(
      { ...request, route: RouteKind.AxelarGmp },
      snapshot({ routeEnabled: {} }),
    );
    expect(quote.available).toBe(false);
  });
});

describe("the copy", () => {
  it("has a label and a sentence for every blocker", () => {
    for (const value of Object.values(QuoteBlocker)) {
      const copy = BLOCKER_COPY[value];
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.detail.endsWith(".")).toBe(true);
      expect(describeBlocker(value)).toBe(copy);
    }
  });

  it("says whose problem each one is", () => {
    expect(BLOCKER_COPY[QuoteBlocker.InvalidDestination].owner).toBe("sender");
    expect(BLOCKER_COPY[QuoteBlocker.Paused].owner).toBe("operator");
    expect(BLOCKER_COPY[QuoteBlocker.ChainNotSupported].owner).toBe("rail");
  });

  it("marks the ones worth trying again", () => {
    expect(BLOCKER_COPY[QuoteBlocker.FlowLimitExceeded].transient).toBe(true);
    expect(BLOCKER_COPY[QuoteBlocker.AmountTooSmall].transient).toBe(false);
  });
});

describe("pricing all four at once", () => {
  it("returns one per rail, in the enum's order", () => {
    const quotes = planQuotes(request, snapshot());
    expect(quotes.length).toBe(ROUTE_KINDS.length);
    expect(quotes.map((q) => q.route)).toEqual([...ROUTE_KINDS]);
  });

  it("does not reshuffle between renders", () => {
    const first = planQuotes(request, snapshot()).map((q) => q.route);
    const second = planQuotes(request, snapshot()).map((q) => q.route);
    expect(first).toEqual(second);
  });
});

describe("picking one", () => {
  it("is null when nothing can carry the transfer", () => {
    expect(bestQuote(planQuotes(request, snapshot({ paused: true })))).toBeNull();
  });

  it("takes the most arriving", () => {
    const quotes = planQuotes(request, snapshot());
    const best = bestQuote(quotes);
    expect(best).not.toBeNull();
    const most = quotes.filter((q) => q.available).map((q) => q.destinationAmount);
    expect(best?.destinationAmount).toBe(most.reduce((a, b) => (a > b ? a : b)));
  });

  it("breaks a tie towards the canonical asset rather than a wrapper of it", () => {
    // All four land the same amount here, so the tie break is the whole decision.
    const best = bestQuote(planQuotes(request, snapshot()));
    expect(best?.isCanonical).toBe(true);
  });

  it("prefers the rail that does not make somebody wait, all else equal", () => {
    const quotes = planQuotes(request, snapshot({ routeEnabled: { [RouteKind.Allbridge]: true } }));
    const best = bestQuote(quotes);
    expect(best?.route).toBe(RouteKind.Allbridge);
    expect(best?.waitsOnAttestation).toBe(false);
  });
});

describe("slippage, which the quote deliberately knows nothing about", () => {
  it("spots a quote that would be refused on chain", () => {
    const quote = planQuote({ ...request, route: RouteKind.Cctp }, snapshot());
    expect(wouldSlip(quote, quote.destinationAmount)).toBe(false);
    expect(wouldSlip(quote, quote.destinationAmount + 1n)).toBe(true);
  });

  it("says nothing about a quote that was already refused", () => {
    const blocked = planQuote({ ...request, route: RouteKind.Cctp }, snapshot({ paused: true }));
    expect(wouldSlip(blocked, 1n)).toBe(false);
  });

  it("builds a floor from a tolerance, rounding the floor down", () => {
    const quote = planQuote({ ...request, route: RouteKind.Cctp }, snapshot());
    // Fifty basis points of 9_970_000 is 49_850, so the floor sits just below.
    expect(minimumFromTolerance(quote, 50)).toBe(9_920_150n);
    expect(minimumFromTolerance(quote, 0)).toBe(quote.destinationAmount);
    expect(minimumFromTolerance(quote, 10_000)).toBe(0n);
  });

  it("refuses a tolerance that is not a tolerance", () => {
    const quote = planQuote({ ...request, route: RouteKind.Cctp }, snapshot());
    expect(() => minimumFromTolerance(quote, -1)).toThrow(RangeError);
    expect(() => minimumFromTolerance(quote, 10_001)).toThrow(RangeError);
  });
});

describe("batch quote simulation with gas projections (quoteBatch)", () => {
  const tiers = [100_000_000n, 500_000_000n, 1_000_000_000n] as const;
  const batchParams: QuoteParams = {
    strkey: G_ADDR,
    destinationDecimals: 7,
    snapshot: snapshot(),
  };

  it("calculates quotes across multiple tiers with parity to planQuote", () => {
    const results = quoteBatch(tiers, batchParams);
    expect(results.length).toBe(tiers.length);

    for (let i = 0; i < tiers.length; i++) {
      const result = results[i]!;
      const tier = tiers[i]!;
      expect(result.amount).toBe(tier);
      expect(result.available).toBe(true);
      expect(result.winningRail).toBe(RouteKind.Cctp);

      // Verify parity with planQuotes and bestQuote
      const individualQuotes = planQuotes(
        { amount: tier, strkey: G_ADDR, destinationDecimals: 7 },
        snapshot(),
      );
      const expectedBest = bestQuote(individualQuotes);
      expect(result.bestQuote).toEqual(expectedBest);
      expect(result.fee).toBe(expectedBest?.fee);
      expect(result.netAmount).toBe(expectedBest?.netAmount);
      expect(result.destinationAmount).toBe(expectedBest?.destinationAmount);
      expect(result.grossAmount).toBe(expectedBest?.grossAmount);
    }
  });

  it("projects estimated destination gas for the winning rail and all rails", () => {
    const results = quoteBatch([100_000_000n], batchParams);
    const result = results[0]!;

    expect(result.winningRail).toBe(RouteKind.Cctp);
    expect(result.estimatedDestinationGas).toBe(RAIL_DESTINATION_GAS_ESTIMATES[RouteKind.Cctp]);
    expect(result.gasProjections[RouteKind.Cctp]).toBe(65_000n);
    expect(result.gasProjections[RouteKind.AxelarIts]).toBe(150_000n);
    expect(result.gasProjections[RouteKind.AxelarGmp]).toBe(200_000n);
    expect(result.gasProjections[RouteKind.Allbridge]).toBe(120_000n);
  });

  it("allows overriding destination gas estimates per rail", () => {
    const customGas = { [RouteKind.Cctp]: 80_000n };
    const results = quoteBatch([100_000_000n], {
      ...batchParams,
      gasEstimates: customGas,
    });
    expect(results[0]!.estimatedDestinationGas).toBe(80_000n);
    expect(results[0]!.gasProjections[RouteKind.Cctp]).toBe(80_000n);
  });

  it("returns available: false and null winning rail when router is paused", () => {
    const results = quoteBatch(tiers, {
      ...batchParams,
      snapshot: snapshot({ paused: true }),
    });

    for (const res of results) {
      expect(res.available).toBe(false);
      expect(res.winningRail).toBeNull();
      expect(res.bestQuote).toBeNull();
      expect(res.estimatedDestinationGas).toBeNull();
      expect(res.destinationAmount).toBe(0n);
      for (const q of res.quotes) {
        expect(q.reason).toBe(QuoteBlocker.Paused);
      }
    }
  });

  it("handles headroom exhaustion across ascending tiers", () => {
    // Set flow limit to 200 USDC (200_000_000n)
    const tightSnapshot = snapshot({
      flowAvailable: {
        [RouteKind.Cctp]: 200_000_000n,
        [RouteKind.AxelarIts]: 200_000_000n,
        [RouteKind.AxelarGmp]: 200_000_000n,
        [RouteKind.Allbridge]: 200_000_000n,
      },
    });

    const results = quoteBatch([100_000_000n, 500_000_000n], {
      ...batchParams,
      snapshot: tightSnapshot,
    });

    const first = results[0]!;
    const second = results[1]!;

    // Tier 1 (100 USDC) is under 200 USDC -> available
    expect(first.available).toBe(true);
    // Tier 2 (500 USDC) exceeds 200 USDC -> blocked
    expect(second.available).toBe(false);
    expect(second.winningRail).toBeNull();
    for (const q of second.quotes) {
      expect(q.reason).toBe(QuoteBlocker.FlowLimitExceeded);
    }
  });

  it("handles empty tier array cleanly", () => {
    const results = quoteBatch([], batchParams);
    expect(results).toEqual([]);
  });

  it("handles negative or excessive tier amounts without throwing", () => {
    const weirdTiers = [-1n, 0n, MAX_QUOTE_AMOUNT + 1n];
    const results = quoteBatch(weirdTiers, batchParams);
    expect(results.length).toBe(3);
    for (const res of results) {
      expect(res.available).toBe(false);
      expect(res.winningRail).toBeNull();
    }
  });

  it("exports convenience aliases quoteRoute and quoteAllRails", () => {
    expect(quoteRoute).toBe(planQuote);
    expect(quoteAllRails).toBe(planQuotes);
  });
});
