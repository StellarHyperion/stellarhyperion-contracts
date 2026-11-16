import { describe, expect, it, vi } from "vitest";
import {
  MAX_QUOTE_AMOUNT,
  QuoteBlocker,
  RouteKind,
  planQuote,
  searchBoundedQuotes,
} from "../src/index.js";
import type { RouterSnapshot } from "../src/index.js";
import { G_ADDR, M_ADDR } from "./fixtures.js";

function frozenSnapshot(overrides: Partial<RouterSnapshot> = {}): RouterSnapshot {
  return Object.freeze({
    paused: false,
    feeBps: 30,
    routeEnabled: Object.freeze({
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: true,
      [RouteKind.Allbridge]: true,
    }),
    adapterSet: Object.freeze({
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: true,
      [RouteKind.Allbridge]: true,
    }),
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals: 7,
    flowAvailable: Object.freeze({
      [RouteKind.Cctp]: MAX_QUOTE_AMOUNT,
      [RouteKind.AxelarIts]: 50_000_000n,
      [RouteKind.AxelarGmp]: 500_000_000n,
      [RouteKind.Allbridge]: 500_000_000n,
    }),
    chainSupported: Object.freeze({
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: true,
      [RouteKind.Allbridge]: true,
    }),
    ...overrides,
  });
}

describe("bounded quote search across user spending constraints", () => {
  it("runs synchronously with zero network calls, never mutates snapshots, and terminates logarithmically on 2^128 ranges", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network calls are forbidden");
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const snapshot = frozenSnapshot();
      const targetDest = 123_456_789n; // 123.456789 USDC (6 decimals)
      const result = searchBoundedQuotes(
        {
          strkey: G_ADDR,
          destinationDecimals: 6,
          minSourceAmount: 100n,
          maxSourceAmount: 1n << 200n,
          minDestinationAmount: targetDest,
          strictCapabilities: true,
          routeCapabilities: {
            [RouteKind.Cctp]: { enabled: true, paidDispatchSupported: false },
            [RouteKind.AxelarIts]: { enabled: true, paidDispatchSupported: true },
          },
        },
        snapshot,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.feasible).toBe(true);
      expect(result.evaluationCount).toBeLessThan(600);

      // CCTP has full uint128 flowAvailable and satisfies targetDest; AxelarIts only has 50M stroops (< 1.234B needed).
      expect(result.matches.map((m) => m.route)).toEqual([RouteKind.Cctp]);
      const cctpMatch = result.matches[0]!;
      expect(cctpMatch.minimumSpendQuote.destinationAmount).toBeGreaterThanOrEqual(targetDest);
      expect(cctpMatch.maximumOutputQuote.netAmount).toBeLessThanOrEqual(MAX_QUOTE_AMOUNT);

      // Minimality check: one stroop less than minRequestAmount fails targetDest.
      const oneBelow = planQuote(
        {
          route: RouteKind.Cctp,
          amount: cctpMatch.minRequestAmount - 1n,
          strkey: G_ADDR,
          destinationDecimals: 6,
        },
        snapshot,
      );
      expect(oneBelow.destinationAmount).toBeLessThan(targetDest);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("explains why every excluded route failed capability, router, flow, minimum, or fee constraints", () => {
    const snapshot = frozenSnapshot({
      flowAvailable: Object.freeze({
        [RouteKind.Cctp]: 500_000_000n, // 50 USDC (7 decimals)
        [RouteKind.AxelarIts]: 20_000_000n, // 2 USDC -> too little flow for 10 USDC min dest
        [RouteKind.AxelarGmp]: 500_000_000n,
        [RouteKind.Allbridge]: 500_000_000n,
      }),
    });

    const result = searchBoundedQuotes(
      {
        strkey: M_ADDR, // Muxed destination blocks Allbridge at router level
        destinationDecimals: 6,
        minSourceAmount: 10_000_000n,
        maxSourceAmount: 200_000_000n,
        minDestinationAmount: 10_000_000n, // 10 USDC (6 decimals)
        maxFeeAmount: 500_000n,
        routeCapabilities: {
          [RouteKind.Cctp]: { enabled: true, paidDispatchSupported: true },
          [RouteKind.AxelarIts]: { enabled: true, paidDispatchSupported: true },
          [RouteKind.AxelarGmp]: { enabled: false, note: "gated until GMP validation" },
          [RouteKind.Allbridge]: { enabled: true, paidDispatchSupported: true },
        },
        requirePaidDispatch: true,
      },
      snapshot,
    );

    expect(result.feasible).toBe(true);
    expect(result.matches.map((m) => m.route)).toEqual([RouteKind.Cctp]);

    const byRoute = new Map(result.excludedRoutes.map((e) => [e.route, e]));
    expect(byRoute.get(RouteKind.AxelarIts)?.code).toBe("exceeds_flow_headroom");
    expect(byRoute.get(RouteKind.AxelarIts)?.blocker).toBe(QuoteBlocker.FlowLimitExceeded);
    expect(byRoute.get(RouteKind.AxelarGmp)?.code).toBe("capability_disabled");
    expect(byRoute.get(RouteKind.Allbridge)?.code).toBe("router_blocked");
    expect(byRoute.get(RouteKind.Allbridge)?.blocker).toBe(QuoteBlocker.MuxedNotSupported);

    // Tight fee budget excludes even CCTP with fee_exceeds_budget.
    const feeBlocked = searchBoundedQuotes(
      {
        strkey: G_ADDR,
        destinationDecimals: 6,
        minSourceAmount: 100_000_000n,
        maxSourceAmount: 200_000_000n,
        minDestinationAmount: 10_000_000n,
        maxFeeAmount: 100n, // 30 bps on 100M is 300,000 > 100
      },
      snapshot,
    );
    expect(feeBlocked.feasible).toBe(false);
    const feeByRoute = new Map(feeBlocked.excludedRoutes.map((e) => [e.route, e.code]));
    expect(feeByRoute.get(RouteKind.Cctp)).toBe("fee_exceeds_budget");
    expect(feeByRoute.get(RouteKind.AxelarGmp)).toBe("fee_exceeds_budget");
    expect(feeByRoute.get(RouteKind.Allbridge)).toBe("fee_exceeds_budget");
    expect(feeByRoute.get(RouteKind.AxelarIts)).toBe("exceeds_flow_headroom");
  });

  it("rejects malformed negative or inverted spend bounds", () => {
    const snapshot = frozenSnapshot();
    expect(() =>
      searchBoundedQuotes(
        {
          strkey: G_ADDR,
          destinationDecimals: 6,
          minSourceAmount: 500n,
          maxSourceAmount: 100n,
        },
        snapshot,
      ),
    ).toThrow(RangeError);

    expect(() =>
      searchBoundedQuotes(
        {
          strkey: G_ADDR,
          destinationDecimals: 6,
          maxSourceAmount: -1n,
        },
        snapshot,
      ),
    ).toThrow(RangeError);
  });
});
