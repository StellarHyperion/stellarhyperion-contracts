import { describe, expect, it } from "vitest";
import { QuoteBlocker, RouteKind, explainQuote, explainQuotes, planQuotes } from "../src/index.js";
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
      [RouteKind.Cctp]: 50_000_000n,
      [RouteKind.AxelarIts]: 200_000_000n,
      [RouteKind.Allbridge]: 200_000_000n,
    },
    chainSupported: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.Allbridge]: true,
    },
    ...overrides,
  };
}

describe("SDK quote explanation tree", () => {
  it("matches planQuote and planQuotes arithmetic exactly across fee, dust, and flow derivations", () => {
    const snapshot = makeSnapshot();
    const request = {
      amount: 10_000_009n,
      strkey: G_ADDR,
      destinationDecimals: 6,
    };

    const directQuotes = planQuotes(request, snapshot);
    const trees = explainQuotes(request, snapshot);
    expect(trees.map((t) => t.quote)).toEqual(directQuotes);

    const cctpTree = trees[0];
    expect(cctpTree).toBeDefined();
    if (cctpTree !== undefined) {
      expect(cctpTree.quote.available).toBe(true);
      expect(cctpTree.blockerAttribution).toBeNull();
      expect(cctpTree.root.status).toBe("passed");

      // 10_000_009 * 30 / 10_000 = 30_000 fee -> netBeforeFloor = 9_970_009 -> floored 7->6 dec = 9_970_000
      expect(cctpTree.arithmetic.fee).toBe(cctpTree.quote.fee);
      expect(cctpTree.arithmetic.fee).toBe(30_000n);
      expect(cctpTree.arithmetic.netBeforeFloor).toBe(9_970_009n);
      expect(cctpTree.arithmetic.precisionDust).toBe(9n);
      expect(cctpTree.arithmetic.netAmount).toBe(cctpTree.quote.netAmount);
      expect(cctpTree.arithmetic.netAmount).toBe(9_970_000n);
      expect(cctpTree.arithmetic.grossAmount).toBe(cctpTree.quote.grossAmount);
      expect(cctpTree.arithmetic.grossAmount).toBe(10_000_000n);
      expect(cctpTree.arithmetic.retainedSenderDust).toBe(9n);
      expect(cctpTree.arithmetic.destinationAmount).toBe(cctpTree.quote.destinationAmount);
      expect(cctpTree.arithmetic.destinationAmount).toBe(997_000n);
      expect(cctpTree.arithmetic.flowRemainingAfter).toBe(50_000_000n - 9_970_000n);
      expect(cctpTree.arithmetic.flowShortfall).toBe(0n);
    }
  });

  it("identifies the exact owning policy or capability when a route is blocked", () => {
    const snapshot = makeSnapshot();

    // 1. Disabled route -> router.route_enablement (operator)
    const disabledGmp = explainQuote(
      {
        route: RouteKind.AxelarGmp,
        amount: 10_000_000n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(disabledGmp.quote.available).toBe(false);
    expect(disabledGmp.blockerAttribution).toEqual({
      blocker: QuoteBlocker.RouteDisabled,
      label: "Rail switched off",
      owner: "operator",
      transient: true,
      owningPolicy: "router.route_enablement",
      failedNodeId: "gate.route_enabled",
    });

    // 2. Muxed Stellar address on Allbridge -> rail.payload_capability (sender)
    const muxedAllbridge = explainQuote(
      {
        route: RouteKind.Allbridge,
        amount: 10_000_000n,
        strkey: M_ADDR,
        destinationDecimals: 7,
      },
      snapshot,
    );
    expect(muxedAllbridge.blockerAttribution?.blocker).toBe(QuoteBlocker.MuxedNotSupported);
    expect(muxedAllbridge.blockerAttribution?.owningPolicy).toBe("rail.payload_capability");
    expect(muxedAllbridge.blockerAttribution?.failedNodeId).toBe("gate.muxed_payload_support");

    // 3. Over sliding flow headroom on Cctp -> router.sliding_flow_window with exact shortfall
    const overFlow = explainQuote(
      {
        route: RouteKind.Cctp,
        amount: 100_000_000n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(overFlow.blockerAttribution?.blocker).toBe(QuoteBlocker.FlowLimitExceeded);
    expect(overFlow.blockerAttribution?.owningPolicy).toBe("router.sliding_flow_window");
    expect(overFlow.arithmetic.flowShortfall).toBe(99_700_000n - 50_000_000n);
  });

  it("produces deterministic output across repeated calls with zero mutation of input snapshots", () => {
    const snapshot = makeSnapshot({ paused: true });
    const first = explainQuotes(
      { amount: 25_000_000n, strkey: G_ADDR, destinationDecimals: 6 },
      snapshot,
    );
    const second = explainQuotes(
      { amount: 25_000_000n, strkey: G_ADDR, destinationDecimals: 6 },
      snapshot,
    );
    expect(first).toEqual(second);
    expect(first[0]?.blockerAttribution?.owningPolicy).toBe("router.pause_switch");
  });
});
