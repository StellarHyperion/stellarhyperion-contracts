import { describe, expect, it } from "vitest";
import {
  MAX_QUOTE_AMOUNT,
  QuoteBlocker,
  RouteKind,
  planMaxSend,
  planMaxSendAllRails,
  planQuote,
} from "../src/index.js";
import type { RouterSnapshot } from "../src/index.js";
import { G_ADDR, M_ADDR } from "./fixtures.js";

function makeSnapshot(overrides: Partial<RouterSnapshot> = {}): RouterSnapshot {
  return {
    paused: false,
    feeBps: 30,
    routeEnabled: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: false,
      [RouteKind.Allbridge]: true,
    },
    adapterSet: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.Allbridge]: true,
    },
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals: 7,
    flowAvailable: {
      [RouteKind.Cctp]: 500_000_000n,
      [RouteKind.AxelarIts]: 50_000_000n,
      [RouteKind.Allbridge]: 500_000_000n,
    },
    chainSupported: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.Allbridge]: true,
    },
    ...overrides,
  };
}

describe("SDK maximum-send planner", () => {
  it("never exceeds wallet balance, feeReserve, routeAllowance, or flowAvailable across integer boundaries", () => {
    const snapshot = makeSnapshot();

    // 1. Bound by routeAllowance
    const byAllowance = planMaxSend(
      {
        route: RouteKind.Cctp,
        walletBalance: 100_000_000n,
        feeReserve: 5_000_000n,
        routeAllowance: 40_000_007n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(byAllowance.ok).toBe(true);
    if (byAllowance.ok) {
      expect(byAllowance.limitingFactor).toBe("route_allowance");
      expect(byAllowance.suggestedRequestAmount).toBeLessThanOrEqual(40_000_007n);
      expect(byAllowance.quote.grossAmount).toBeLessThanOrEqual(40_000_007n);
      expect(byAllowance.quote.netAmount).toBeLessThanOrEqual(
        snapshot.flowAvailable[RouteKind.Cctp]!,
      );
    }

    // 2. Bound by flowAvailable
    const byFlow = planMaxSend(
      {
        route: RouteKind.AxelarIts,
        walletBalance: 200_000_000n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(byFlow.ok).toBe(true);
    if (byFlow.ok) {
      expect(byFlow.limitingFactor).toBe("flow_headroom");
      expect(byFlow.quote.netAmount).toBe(50_000_000n);
      expect(byFlow.suggestedRequestAmount).toBeLessThanOrEqual(200_000_000n);
    }

    // 3. Bound by MAX_QUOTE_AMOUNT when wallet holds > 2^128
    const wideSnapshot = makeSnapshot({
      flowAvailable: { [RouteKind.Cctp]: MAX_QUOTE_AMOUNT },
    });
    const byProtocolMax = planMaxSend(
      {
        route: RouteKind.Cctp,
        walletBalance: 1n << 200n,
        strkey: G_ADDR,
        destinationDecimals: 7,
      },
      wideSnapshot,
    );
    expect(byProtocolMax.ok).toBe(true);
    if (byProtocolMax.ok) {
      expect(byProtocolMax.limitingFactor).toBe("protocol_max_quote");
      expect(byProtocolMax.suggestedRequestAmount).toBe(MAX_QUOTE_AMOUNT);
    }
  });

  it("retains precision-boundary dust explicitly without overcharging rounding fees", () => {
    // At 0 bps, 10_000_009 stroops sends 10_000_000 gross (1,000,000 micro-USDC) and retains 9 stroops.
    const snapshot0 = makeSnapshot({ feeBps: 0 });
    const res0 = planMaxSend(
      {
        route: RouteKind.Cctp,
        walletBalance: 15_000_009n,
        feeReserve: 5_000_000n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot0,
    );
    expect(res0.ok).toBe(true);
    if (res0.ok) {
      expect(res0.suggestedRequestAmount).toBe(10_000_000n);
      expect(res0.retainedPrecisionDust).toBe(9n);
      expect(res0.remainingWalletBalance).toBe(5_000_009n);
    }

    // At 30 bps, 9_999_999 stroops pays 29,999 fee + 9,970,000 net = 997,000 micro-USDC, retaining 10 stroops!
    const snapshot30 = makeSnapshot({ feeBps: 30 });
    const res30 = planMaxSend(
      {
        route: RouteKind.Cctp,
        walletBalance: 15_000_009n,
        feeReserve: 5_000_000n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot30,
    );

    expect(res30.ok).toBe(true);
    if (res30.ok) {
      expect(res30.spendableBalance).toBe(10_000_009n);
      expect(res30.suggestedRequestAmount).toBe(9_999_999n);
      expect(res30.quote.grossAmount).toBe(9_999_999n);
      expect(res30.quote.destinationAmount).toBe(997_000n);
      expect(res30.retainedPrecisionDust).toBe(10n);
      expect(res30.remainingWalletBalance).toBe(5_000_010n);
    }

    // At 100 bps (1%), 1_009 stroops achieves 99 micro-USDC already at 999 stroops (fee=9, net=990), retaining 10 stroops!
    const snapshot100 = makeSnapshot({ feeBps: 100 });
    const res100 = planMaxSend(
      {
        route: RouteKind.Cctp,
        walletBalance: 1_009n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot100,
    );

    expect(res100.ok).toBe(true);
    if (res100.ok) {
      expect(res100.suggestedRequestAmount).toBe(999n);
      expect(res100.quote.fee).toBe(9n);
      expect(res100.quote.destinationAmount).toBe(99n);
      expect(res100.retainedPrecisionDust).toBe(10n);

      // Sending all 1_009 stroops would not deliver a single extra micro-USDC.
      const untightened = planQuote(
        {
          route: RouteKind.Cctp,
          amount: 1_009n,
          strkey: G_ADDR,
          destinationDecimals: 6,
        },
        snapshot100,
      );
      expect(untightened.destinationAmount).toBe(99n);
    }
  });

  it("returns structured diagnostics with quote=null rather than a zero executable quote on no-solution cases", () => {
    const snapshot = makeSnapshot();

    // 9 stroops on a 7 -> 6 decimal lane cannot form 1 micro-USDC (10 stroops).
    const dustOnly = planMaxSend(
      {
        route: RouteKind.Cctp,
        walletBalance: 9n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(dustOnly.ok).toBe(false);
    expect(dustOnly.available).toBe(false);
    expect(dustOnly.quote).toBeNull();
    if (!dustOnly.ok) {
      expect(dustOnly.diagnosticCode).toBe("DustOnlyBelowMinimum");
      expect(dustOnly.retainedPrecisionDust).toBe(9n);
    }

    const noBalance = planMaxSend(
      {
        route: RouteKind.Cctp,
        walletBalance: 1_000n,
        feeReserve: 1_000n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(noBalance).toMatchObject({
      ok: false,
      available: false,
      quote: null,
      diagnosticCode: "InsufficientBalance",
    });

    const zeroAllowance = planMaxSend(
      {
        route: RouteKind.Cctp,
        walletBalance: 100_000n,
        routeAllowance: 0n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(zeroAllowance).toMatchObject({
      ok: false,
      available: false,
      quote: null,
      diagnosticCode: "InsufficientAllowance",
    });

    const negativeInput = planMaxSend(
      {
        route: RouteKind.Cctp,
        walletBalance: -5n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(negativeInput).toMatchObject({
      ok: false,
      available: false,
      quote: null,
      diagnosticCode: "InvalidConstraint",
    });

    const summary = planMaxSendAllRails(
      {
        walletBalance: 100_000_000n,
        strkey: M_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(summary.available).toBe(true);
    expect(summary.recommended?.route).toBe(RouteKind.Cctp);
    expect(summary.plans[RouteKind.Allbridge]).toMatchObject({
      ok: false,
      diagnosticCode: "RouteBlocked",
      blocker: QuoteBlocker.MuxedNotSupported,
    });
  });
});
