import { describe, expect, it } from "vitest";
import {
  QuoteBlocker,
  RouteKind,
  planQuotes,
  planSharedFlowBatch,
  quoteBatch,
} from "../src/index.js";
import type { RouterSnapshot } from "../src/index.js";
import { G_ADDR } from "./fixtures.js";

function makeSnapshot(flowOverrides: Partial<Record<RouteKind, bigint>> = {}): RouterSnapshot {
  return {
    paused: false,
    feeBps: 0,
    routeEnabled: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: false,
      [RouteKind.Allbridge]: false,
    },
    adapterSet: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
    },
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals: 7,
    flowAvailable: {
      [RouteKind.Cctp]: 100_000_000n,
      [RouteKind.AxelarIts]: 80_000_000n,
      ...flowOverrides,
    },
    chainSupported: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
    },
  };
}

describe("SDK batch planning against shared flow budgets", () => {
  it("consumes shared route flow sequentially without mutating the supplied snapshot", () => {
    const snapshot = makeSnapshot();

    // Three transfers of 60M stroops each:
    // - Item 0 takes Cctp (100M -> 40M left on Cctp)
    // - Item 1 cannot fit 60M on Cctp (40M left), so it shifts to AxelarIts (80M -> 20M left)
    // - Item 2 cannot fit 60M on either rail (40M and 20M left), so it is excluded!
    const plan = planSharedFlowBatch(
      [
        { id: "t1", amount: 60_000_000n, strkey: G_ADDR, destinationDecimals: 6 },
        { id: "t2", amount: 60_000_000n, strkey: G_ADDR, destinationDecimals: 6 },
        { id: "t3", amount: 60_000_000n, strkey: G_ADDR, destinationDecimals: 6 },
      ],
      snapshot,
    );

    // Original snapshot was never mutated
    expect(snapshot.flowAvailable[RouteKind.Cctp]).toBe(100_000_000n);
    expect(snapshot.flowAvailable[RouteKind.AxelarIts]).toBe(80_000_000n);

    expect(plan.plannedCount).toBe(2);
    expect(plan.failedCount).toBe(1);
    expect(plan.items[0]?.selectedRoute).toBe(RouteKind.Cctp);
    expect(plan.items[1]?.selectedRoute).toBe(RouteKind.AxelarIts);
    expect(plan.items[2]?.included).toBe(false);
    expect(plan.items[2]?.status).toBe("excluded");
    expect(plan.items[2]?.blocker).toBe(QuoteBlocker.FlowLimitExceeded);

    expect(plan.consumedFlowByRoute[RouteKind.Cctp]).toBe(60_000_000n);
    expect(plan.consumedFlowByRoute[RouteKind.AxelarIts]).toBe(60_000_000n);
    expect(plan.remainingFlowByRoute[RouteKind.Cctp]).toBe(40_000_000n);
    expect(plan.remainingFlowByRoute[RouteKind.AxelarIts]).toBe(20_000_000n);
    expect(plan.totalDestinationAmount).toBe(12_000_000n);
  });

  it("enforces rollback_all, exclude_failed, and halt_after_failure semantics deterministically", () => {
    const snapshot = makeSnapshot({
      [RouteKind.Cctp]: 100_000_000n,
      [RouteKind.AxelarIts]: 0n,
    });

    const transfers = [
      { id: "ok-1", amount: 50_000_000n, strkey: G_ADDR, destinationDecimals: 6 },
      { id: "too-big", amount: 80_000_000n, strkey: G_ADDR, destinationDecimals: 6 },
      { id: "ok-2", amount: 40_000_000n, strkey: G_ADDR, destinationDecimals: 6 },
    ] as const;

    // 1. exclude_failed skips item 1 and still plans item 2 using the remaining 50M headroom!
    const excludedPlan = planSharedFlowBatch(transfers, snapshot, {
      failurePolicy: "exclude_failed",
    });
    expect(excludedPlan.plannedCount).toBe(2);
    expect(excludedPlan.items[0]?.status).toBe("planned");
    expect(excludedPlan.items[1]?.status).toBe("excluded");
    expect(excludedPlan.items[2]?.status).toBe("planned");
    expect(excludedPlan.consumedFlowByRoute[RouteKind.Cctp]).toBe(90_000_000n);
    expect(excludedPlan.remainingFlowByRoute[RouteKind.Cctp]).toBe(10_000_000n);

    // 2. rollback_all restores full initial allowance and zeroes totals when item 1 fails!
    const rollbackPlan = planSharedFlowBatch(transfers, snapshot, {
      failurePolicy: "rollback_all",
    });
    expect(rollbackPlan.rolledBack).toBe(true);
    expect(rollbackPlan.plannedCount).toBe(0);
    expect(rollbackPlan.totalGrossAmount).toBe(0n);
    expect(rollbackPlan.consumedFlowByRoute[RouteKind.Cctp]).toBe(0n);
    expect(rollbackPlan.remainingFlowByRoute[RouteKind.Cctp]).toBe(100_000_000n);
    expect(rollbackPlan.items[0]?.status).toBe("rolled_back");
    expect(rollbackPlan.items[1]?.status).toBe("failed");

    // 3. halt_after_failure keeps item 0 planned and marks item 2 halted_skipped!
    const haltedPlan = planSharedFlowBatch(transfers, snapshot, {
      failurePolicy: "halt_after_failure",
    });
    expect(haltedPlan.plannedCount).toBe(1);
    expect(haltedPlan.items[0]?.status).toBe("planned");
    expect(haltedPlan.items[1]?.status).toBe("failed");
    expect(haltedPlan.items[2]?.status).toBe("halted_skipped");
    expect(haltedPlan.consumedFlowByRoute[RouteKind.Cctp]).toBe(50_000_000n);
    expect(haltedPlan.remainingFlowByRoute[RouteKind.Cctp]).toBe(50_000_000n);
  });

  it("matches existing planQuotes and quoteBatch outputs on single-transfer inputs", () => {
    const snapshot: RouterSnapshot = {
      ...makeSnapshot(),
      feeBps: 30,
    };
    const amount = 25_000_009n;

    const legacyQuotes = planQuotes({ amount, strkey: G_ADDR, destinationDecimals: 6 }, snapshot);
    const [legacyBatch] = quoteBatch([amount], {
      strkey: G_ADDR,
      destinationDecimals: 6,
      snapshot,
    });
    const shared = planSharedFlowBatch(
      [{ amount, strkey: G_ADDR, destinationDecimals: 6 }],
      snapshot,
    );

    expect(shared.plannedCount).toBe(1);
    expect(shared.items[0]?.batchQuote).toEqual(legacyBatch);
    expect(shared.items[0]?.batchQuote.quotes).toEqual(legacyQuotes);
    expect(shared.totalGrossAmount).toBe(legacyBatch?.grossAmount);
    expect(shared.totalDestinationAmount).toBe(legacyBatch?.destinationAmount);
  });
});
