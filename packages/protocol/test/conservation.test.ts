import { describe, expect, it } from "vitest";
import {
  auditPaidTransferConservation,
  decomposePaidOutboundAccounting,
  formatConservationViolation,
} from "../src/index.js";
import type { BalanceSheet, ConservationStepEntry } from "../src/index.js";

function basePrincipal(sender = 10_000_000_000n): BalanceSheet {
  return {
    sender,
    treasury: 0n,
    adapter: 0n,
    router: 0n,
    recipient: 0n,
    railSink: 5_000_000_000n,
  };
}

function baseGas(sender = 500_000_000n): BalanceSheet {
  return {
    sender,
    treasury: 0n,
    adapter: 0n,
    router: 0n,
    recipient: 0n,
    railSink: 0n,
  };
}

describe("token conservation invariant harness", () => {
  it("separates 7-to-6 source dust from separate ITS relay currency and in-band CCTP forwarding budgets", () => {
    const itsDec = decomposePaidOutboundAccounting({
      route: "axelar-its",
      requestedAmount: 1_000_000_007n,
      feeBps: 10,
      sourceDecimals: 7,
      destinationDecimals: 6,
      relayGasAmount: 2_500_000n,
    });
    expect(itsDec.protocolFee).toBe(1_000_000n);
    expect(itsDec.netPrincipalToRail).toBe(999_000_000n);
    expect(itsDec.grossDebited).toBe(1_000_000_000n);
    expect(itsDec.sourceDustRetainedBySender).toBe(7n);
    expect(itsDec.separateRelayGasDebited).toBe(2_500_000n);
    expect(itsDec.inBandPrincipalRelayBudget).toBe(0n);

    const cctpDec = decomposePaidOutboundAccounting({
      route: "cctp",
      requestedAmount: 1_000_000_009n,
      feeBps: 10,
      sourceDecimals: 7,
      destinationDecimals: 6,
      relayGasAmount: 1_000_000n,
    });
    expect(cctpDec.protocolFee).toBe(1_000_000n);
    expect(cctpDec.netPrincipalToRail).toBe(999_000_000n);
    expect(cctpDec.sourceDustRetainedBySender).toBe(9n);
    expect(cctpDec.separateRelayGasDebited).toBe(0n);
    expect(cctpDec.inBandPrincipalRelayBudget).toBe(1_000_000n);
    expect(cctpDec.deliverablePrincipalAfterRelay).toBe(998_000_000n);
  });

  it("verifies multi-step successful and failed paid transfers, parked claims, settlements, and sweeps across ITS and CCTP", () => {
    const p0 = basePrincipal();
    const g0 = baseGas();

    // Step 1: Successful Axelar ITS paid outbound with 7 stroops of 7-to-6 source dust + 2.5M native gas.
    const p1: BalanceSheet = {
      ...p0,
      sender: p0.sender - 1_000_000_000n, // 7 stroops retained!
      treasury: p0.treasury + 1_000_000n,
      railSink: p0.railSink + 999_000_000n,
    };
    const g1: BalanceSheet = {
      ...g0,
      sender: g0.sender - 2_500_000n,
      railSink: g0.railSink + 2_500_000n,
    };

    // Step 2: Failed Axelar ITS paid outbound (insufficient gas / paused) -> strict 0 delta on both legs.
    const p2 = { ...p1 };
    const g2 = { ...g1 };

    // Step 3: Successful CCTP paid outbound with 9 stroops source dust + 3 stroops Circle rail dust + 1M in-band fee budget.
    const p3: BalanceSheet = {
      ...p2,
      sender: p2.sender - 1_000_000_000n, // 9 stroops retained!
      treasury: p2.treasury + 1_000_000n,
      adapter: p2.adapter + 3n,
      railSink: p2.railSink + 998_999_997n,
    };
    const g3 = { ...g2 }; // Zero separate native gas movement on CCTP!

    // Step 4: Sweep the 3 stroops of Circle burn dust from adapter to treasury.
    const p4: BalanceSheet = {
      ...p3,
      adapter: 0n,
      treasury: p3.treasury + 3n,
    };

    // Step 5: Inbound CCTP delivery parked as claim (500M stroops).
    const p5: BalanceSheet = {
      ...p4,
      railSink: p4.railSink - 500_000_000n,
      router: p4.router + 500_000_000n,
    };

    // Step 6: Failed claim settlement (RecipientNotReady) -> 0 delta.
    const p6 = { ...p5 };

    // Step 7: Final claim settlement -> router -500M, recipient +500M.
    const p7: BalanceSheet = {
      ...p6,
      router: 0n,
      recipient: p6.recipient + 500_000_000n,
    };

    const steps: ConservationStepEntry[] = [
      {
        spec: {
          kind: "paid-outbound",
          operation: "its_paid_outbound_with_dust",
          route: "axelar-its",
          requestedAmount: 1_000_000_007n,
          feeBps: 10,
          sourceDecimals: 7,
          destinationDecimals: 6,
          relayGasAmount: 2_500_000n,
          succeeded: true,
        },
        snapshots: {
          principalBefore: p0,
          principalAfter: p1,
          relayGasBefore: g0,
          relayGasAfter: g1,
        },
      },
      {
        spec: {
          kind: "paid-outbound",
          operation: "its_failed_insufficient_gas_rollback",
          route: "axelar-its",
          requestedAmount: 1_000_000_007n,
          feeBps: 10,
          sourceDecimals: 7,
          destinationDecimals: 6,
          relayGasAmount: 999_000_000_000n,
          succeeded: false,
          error: "InvalidAmount",
        },
        snapshots: {
          principalBefore: p1,
          principalAfter: p2,
          relayGasBefore: g1,
          relayGasAfter: g2,
        },
      },
      {
        spec: {
          kind: "paid-outbound",
          operation: "cctp_paid_outbound_with_forwarding_and_rail_dust",
          route: "cctp",
          requestedAmount: 1_000_000_009n,
          feeBps: 10,
          sourceDecimals: 7,
          destinationDecimals: 6,
          relayGasAmount: 1_000_000n,
          railSubUnitDust: 3n,
          succeeded: true,
        },
        snapshots: {
          principalBefore: p2,
          principalAfter: p3,
          relayGasBefore: g2,
          relayGasAfter: g3,
        },
      },
      {
        spec: {
          kind: "adapter-dust-sweep",
          operation: "cctp_sweep_adapter_dust",
          route: "cctp",
          sweptAmount: 3n,
          succeeded: true,
        },
        snapshots: {
          principalBefore: p3,
          principalAfter: p4,
          relayGasBefore: g3,
          relayGasAfter: g3,
        },
      },
      {
        spec: {
          kind: "inbound-delivery",
          operation: "cctp_park_claim_missing_trustline",
          route: "cctp",
          mintedAmount: 500_000_000n,
          parkedAsClaim: true,
          succeeded: true,
        },
        snapshots: {
          principalBefore: p4,
          principalAfter: p5,
          relayGasBefore: g3,
          relayGasAfter: g3,
        },
      },
      {
        spec: {
          kind: "claim-settlement",
          operation: "cctp_failed_settle_blocked_recipient",
          route: "cctp",
          claimAmount: 500_000_000n,
          succeeded: false,
          error: "RecipientNotReady",
        },
        snapshots: {
          principalBefore: p5,
          principalAfter: p6,
          relayGasBefore: g3,
          relayGasAfter: g3,
        },
      },
      {
        spec: {
          kind: "claim-settlement",
          operation: "cctp_settle_parked_claim",
          route: "cctp",
          claimAmount: 500_000_000n,
          succeeded: true,
        },
        snapshots: {
          principalBefore: p6,
          principalAfter: p7,
          relayGasBefore: g3,
          relayGasAfter: g3,
        },
      },
    ];

    const report = auditPaidTransferConservation(steps);
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("pinpoints the exact operation, ledger leg, account, and signed balance delta on conservation failures", () => {
    const p0 = basePrincipal();
    const g0 = baseGas();

    // Fault fixture 1: sender accidentally debited the 7 stroops of unrepresentable source dust,
    // and adapter retained 500 stroops of leakedrelay gas on a failed rollback.
    const leakedDustPrincipal: BalanceSheet = {
      ...p0,
      sender: p0.sender - 1_000_000_007n, // over-debited by 7 stroops!
      treasury: p0.treasury + 1_000_000n,
      adapter: p0.adapter + 7n, // stuck in adapter!
      railSink: p0.railSink + 999_000_000n,
    };
    const g1: BalanceSheet = {
      ...g0,
      sender: g0.sender - 2_500_000n,
      railSink: g0.railSink + 2_500_000n,
    };
    const leakedRollbackGas: BalanceSheet = {
      ...g1,
      sender: g1.sender - 500n,
      adapter: g1.adapter + 500n,
    };

    const report = auditPaidTransferConservation([
      {
        spec: {
          kind: "paid-outbound",
          operation: "faulty_its_dust_overpull",
          route: "axelar-its",
          requestedAmount: 1_000_000_007n,
          feeBps: 10,
          sourceDecimals: 7,
          destinationDecimals: 6,
          relayGasAmount: 2_500_000n,
          succeeded: true,
        },
        snapshots: {
          principalBefore: p0,
          principalAfter: leakedDustPrincipal,
          relayGasBefore: g0,
          relayGasAfter: g1,
        },
      },
      {
        spec: {
          kind: "paid-outbound",
          operation: "faulty_cctp_failed_rollback_gas_leak",
          route: "cctp",
          requestedAmount: 1_000_000_000n,
          feeBps: 10,
          sourceDecimals: 7,
          destinationDecimals: 6,
          relayGasAmount: 1_000_000n,
          succeeded: false,
          error: "SlippageExceeded",
        },
        snapshots: {
          principalBefore: leakedDustPrincipal,
          principalAfter: leakedDustPrincipal,
          relayGasBefore: g1,
          relayGasAfter: leakedRollbackGas,
        },
      },
    ]);

    expect(report.passed).toBe(false);

    const dustViolation = report.violations.find((v) => v.ledgerLeg === "source-dust");
    expect(dustViolation?.operation).toBe("faulty_its_dust_overpull");
    expect(dustViolation?.balanceDeltaDiscrepancy).toBe(-7n);

    const adapterPrincipalViolation = report.violations.find(
      (v) => v.operation === "faulty_its_dust_overpull" && v.account === "adapter",
    );
    expect(adapterPrincipalViolation?.balanceDeltaDiscrepancy).toBe(7n);

    const rollbackGasViolation = report.violations.find(
      (v) =>
        v.operation === "faulty_cctp_failed_rollback_gas_leak" &&
        v.ledgerLeg === "relay-currency" &&
        v.account === "sender",
    );
    expect(rollbackGasViolation?.balanceDeltaDiscrepancy).toBe(-500n);
    if (rollbackGasViolation !== undefined) {
      const formatted = formatConservationViolation(rollbackGasViolation);
      expect(formatted).toContain("op=faulty_cctp_failed_rollback_gas_leak");
      expect(formatted).toContain("discrepancy=-500");
    }
  });
});
