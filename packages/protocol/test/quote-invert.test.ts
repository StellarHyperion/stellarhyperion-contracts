import { describe, expect, it } from "vitest";
import {
  MAX_QUOTE_AMOUNT,
  QuoteBlocker,
  RouteKind,
  invertAllRoutesDestinationMinimum,
  invertDestinationMinimum,
  planQuote,
} from "../src/index.js";
import type { ForwardingBudgetUnit, RouterSnapshot } from "../src/index.js";
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
      [RouteKind.Cctp]: MAX_QUOTE_AMOUNT,
      [RouteKind.AxelarIts]: 500_000_000n,
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

describe("SDK destination-minimum inversion", () => {
  it("satisfies destination minima with bounded rounding and exact forward parity across decimal directions", () => {
    // 1. Stellar (7 decimals) -> EVM (6 decimals) with destination_base_units CCTP fast-fee budget.
    const snapshot7to6 = makeSnapshot({ tokenDecimals: 7, feeBps: 30 });
    const invDown = invertDestinationMinimum(
      {
        route: RouteKind.Cctp,
        desiredDestinationMinimum: 100_000_000n, // 100.000000 USDC
        strkey: G_ADDR,
        destinationDecimals: 6,
        forwardingBudget: {
          amount: 50_000n, // 0.05 USDC fast-attestation fee
          unit: "destination_base_units",
          tokenSymbol: "USDC",
          assumption: "Circle CCTP V2 fast-transfer maxFee deducted in destination USDC",
        },
      },
      snapshot7to6,
    );

    expect(invDown.ok).toBe(true);
    if (invDown.ok) {
      expect(invDown.netDestinationAfterBudget).toBe(100_000_000n);
      expect(invDown.destinationRoundingExcess).toBe(0n);
      expect(invDown.forwardingBudget).toEqual({
        amount: 50_000n,
        unit: "destination_base_units",
        tokenSymbol: "USDC",
        assumption: "Circle CCTP V2 fast-transfer maxFee deducted in destination USDC",
      });

      // Minimality: 1 stroop smaller request delivers strictly less than 100_050_000n.
      const smaller = planQuote(
        {
          route: RouteKind.Cctp,
          amount: invDown.requiredRequestAmount - 1n,
          strkey: G_ADDR,
          destinationDecimals: 6,
        },
        snapshot7to6,
      );
      expect(smaller.destinationAmount).toBeLessThan(100_050_000n);
    }

    // 2. EVM (6 decimals) -> Stellar (7 decimals) where target is not a multiple of 10 stroops.
    const snapshot6to7 = makeSnapshot({ tokenDecimals: 6, feeBps: 100 });
    const invUp = invertDestinationMinimum(
      {
        route: RouteKind.AxelarIts,
        desiredDestinationMinimum: 12_345n, // 0.0012345 USDC on Stellar (needs 1235 EVM micro-USDC -> 12,350 stroops)
        strkey: G_ADDR,
        destinationDecimals: 7,
        forwardingBudget: {
          amount: 2_500_000n,
          unit: "native_gas_units",
          tokenSymbol: "WEI",
          assumption: "Axelar GasService prepaid in native wei alongside bridgeOut",
        },
      },
      snapshot6to7,
    );

    expect(invUp.ok).toBe(true);
    if (invUp.ok) {
      expect(invUp.netDestinationAfterBudget).toBe(12_350n);
      expect(invUp.destinationRoundingExcess).toBe(5n);
      expect(invUp.destinationRoundingExcess).toBeLessThan(invUp.maxRoundingStepDestination);
      expect(invUp.separateNativeGasRequired).toBe(2_500_000n);
      expect(invUp.forwardingBudget.unit).toBe("native_gas_units");

      const oneLess = planQuote(
        {
          route: RouteKind.AxelarIts,
          amount: invUp.requiredRequestAmount - 1n,
          strkey: G_ADDR,
          destinationDecimals: 7,
        },
        snapshot6to7,
      );
      expect(oneLess.destinationAmount).toBeLessThan(12_345n);
    }
  });

  it("accounts for source_base_units budgets, enforces maxSourceSpend, and preserves wide integers", () => {
    const snapshot = makeSnapshot({ tokenDecimals: 7, feeBps: 0 });
    const hugeMinimum = (1n << 120n) + 7n;

    const wide = invertDestinationMinimum(
      {
        route: RouteKind.Cctp,
        desiredDestinationMinimum: hugeMinimum,
        strkey: G_ADDR,
        destinationDecimals: 7,
        forwardingBudget: {
          amount: 1_000n,
          unit: "source_base_units",
          tokenSymbol: "USDC",
          assumption: "caller custody fee reserved in source USDC",
        },
      },
      snapshot,
    );

    expect(wide.ok).toBe(true);
    if (wide.ok) {
      expect(wide.requiredRequestAmount).toBe(hugeMinimum);
      expect(wide.totalSourceTokensRequired).toBe(hugeMinimum + 1_000n);
    }

    const capped = invertDestinationMinimum(
      {
        route: RouteKind.Cctp,
        desiredDestinationMinimum: 50_000_000n,
        strkey: G_ADDR,
        destinationDecimals: 7,
        maxSourceSpend: 40_000_000n,
      },
      snapshot,
    );
    expect(capped.ok).toBe(false);
    if (!capped.ok) {
      expect(capped.code).toBe("ExceedsMaxSourceSpend");
    }
  });

  it("fails invalid or unattainable minima with actionable failure codes across rails", () => {
    const snapshot = makeSnapshot();

    const zeroMin = invertDestinationMinimum(
      {
        route: RouteKind.Cctp,
        desiredDestinationMinimum: 0n,
        strkey: G_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(zeroMin.ok).toBe(false);
    if (!zeroMin.ok) expect(zeroMin.code).toBe("InvalidMinimum");

    const badBudget = invertDestinationMinimum(
      {
        route: RouteKind.Cctp,
        desiredDestinationMinimum: 100n,
        strkey: G_ADDR,
        destinationDecimals: 6,
        forwardingBudget: {
          amount: -1n,
          unit: "destination_base_units",
          assumption: "bad negative budget",
        },
      },
      snapshot,
    );
    expect(badBudget.ok).toBe(false);
    if (!badBudget.ok) expect(badBudget.code).toBe("InvalidForwardingBudget");

    const badUnit = invertDestinationMinimum(
      {
        route: RouteKind.Cctp,
        desiredDestinationMinimum: 100n,
        strkey: G_ADDR,
        destinationDecimals: 6,
        forwardingBudget: {
          amount: 1n,
          unit: "usd_cents" as ForwardingBudgetUnit,
          assumption: "unsupported unit",
        },
      },
      snapshot,
    );
    expect(badUnit.ok).toBe(false);
    if (!badUnit.ok) expect(badUnit.code).toBe("InvalidForwardingBudget");

    // Near MAX_QUOTE_AMOUNT where adding 30 bps fee overflows MAX_QUOTE_AMOUNT.
    const overMax = invertDestinationMinimum(
      {
        route: RouteKind.Cctp,
        desiredDestinationMinimum: MAX_QUOTE_AMOUNT,
        strkey: G_ADDR,
        destinationDecimals: 7,
      },
      snapshot,
    );
    expect(overMax.ok).toBe(false);
    if (!overMax.ok) expect(overMax.code).toBe("ExceedsMaxQuoteAmount");

    // Batch across all 4 rails with M_ADDR (Allbridge fails MuxedNotSupported, AxelarGmp fails RouteDisabled, AxelarIts fails FlowLimitExceeded at 100 USDC).
    const allRails = invertAllRoutesDestinationMinimum(
      {
        desiredDestinationMinimum: 100_000_000n, // 100 USDC (6 decimals) -> needs ~1,003,009,030 stroops > 500M ITS headroom
        strkey: M_ADDR,
        destinationDecimals: 6,
      },
      snapshot,
    );
    expect(allRails).toHaveLength(4);
    expect(allRails[RouteKind.Cctp]?.ok).toBe(true);
    expect(allRails[RouteKind.AxelarIts]).toMatchObject({
      ok: false,
      code: "FlowLimitExceeded",
      blocker: QuoteBlocker.FlowLimitExceeded,
    });
    expect(allRails[RouteKind.AxelarGmp]).toMatchObject({
      ok: false,
      code: "RouteBlocked",
      blocker: QuoteBlocker.RouteDisabled,
    });
    expect(allRails[RouteKind.Allbridge]).toMatchObject({
      ok: false,
      code: "RouteBlocked",
      blocker: QuoteBlocker.MuxedNotSupported,
    });
  });
});
