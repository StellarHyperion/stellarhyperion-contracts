import { describe, expect, it } from "vitest";

import {
  buildFaultSchedule,
  FAULT_STAGES,
  formatSeedHex,
  INBOUND_FAULT_STAGES,
  OUTBOUND_FAULT_STAGES,
  parseSeedHex,
  type RehearsalState,
  rehearseInboundAttempt,
  rehearseOutboundAttempt,
  SplitMix64,
} from "../src/faultScheduling.js";
import { RouteKind } from "../src/routes.js";

function emptyState(overrides?: Partial<RehearsalState>): RehearsalState {
  return {
    senderAsset: 10_000_000_000n,
    senderGas: 2_000_000_000n,
    treasuryAsset: 0n,
    routerAsset: 0n,
    adapterAsset: 0n,
    adapterGas: 0n,
    railReceiverAsset: 5_000_000_000n,
    recipientAsset: 0n,
    outboundNonce: 0n,
    flowConsumed: 0n,
    processedMessageIds: new Set<string>(),
    parkedClaims: new Map(),
    ...overrides,
  };
}

describe("deterministic provider fault scheduling", () => {
  it("reproduces identical schedules from a saved seed and matches SplitMix64 reference words", () => {
    const seed = 0x0000_0000_00c0_ffeen;
    const savedHex = formatSeedHex(seed);
    expect(savedHex).toBe("0x0000000000c0ffee");
    expect(parseSeedHex(savedHex)).toBe(seed);

    const runA = buildFaultSchedule({
      seed,
      steps: 16,
      failureRateBps: 5_000,
    });
    const runB = buildFaultSchedule({
      seed: parseSeedHex(runA.seedHex),
      steps: 16,
      failureRateBps: 5_000,
    });
    expect(runB).toEqual(runA);
    expect(runA.stages).toEqual(FAULT_STAGES);

    // Different seed produces a distinct sequence.
    const other = buildFaultSchedule({
      seed: 0x0000_0000_00c0_ffefn,
      steps: 16,
      failureRateBps: 5_000,
    });
    expect(other.decisions).not.toEqual(runA.decisions);

    // Pin exact SplitMix64 first word for seed 0 so cross-language parity never drifts.
    const rngZero = new SplitMix64(0n);
    expect(rngZero.nextU64()).toBe(0xe220a8397b1dcdafn);
    expect(rngZero.nextU64()).toBe(0x6e789e6aa1b965f4n);
  });

  it("preserves atomic state invariants at every injected outbound and inbound stage", () => {
    const initial = emptyState();

    for (const stage of OUTBOUND_FAULT_STAGES) {
      const attempt = rehearseOutboundAttempt(
        initial,
        {
          route: RouteKind.AxelarIts,
          amount: 1_000_000_007n,
          feeBps: 10,
          sourceDecimals: 7,
          destinationDecimals: 6,
          gasAmount: 50_000_000n,
        },
        { stage, injectFault: true },
      );
      expect(attempt.succeeded).toBe(false);
      expect(attempt.injectedStage).toBe(stage);
      expect(attempt.state).toEqual(initial);
    }

    for (const stage of ["inbound-provider-verify", "inbound-pull"] as const) {
      const attempt = rehearseInboundAttempt(
        initial,
        {
          routeKey: "Cctp",
          messageIdHex: "11".repeat(32),
          amount: 500_000_000n,
        },
        { stage, injectFault: true },
      );
      expect(attempt.reverted).toBe(true);
      expect(attempt.delivered).toBe(false);
      expect(attempt.parkedClaimId).toBeNull();
      expect(attempt.state).toEqual(initial);
    }

    // Recipient-blocked inbound stage atomically escrows funds in router and records 1 claim.
    const parked = rehearseInboundAttempt(
      initial,
      {
        routeKey: "Cctp",
        messageIdHex: "22".repeat(32),
        amount: 500_000_000n,
      },
      { stage: "inbound-recipient-blocked", injectFault: true },
    );
    expect(parked.reverted).toBe(false);
    expect(parked.delivered).toBe(false);
    expect(parked.parkedClaimId).toBe(1n);
    expect(parked.state.routerAsset).toBe(500_000_000n);
    expect(parked.state.railReceiverAsset).toBe(initial.railReceiverAsset - 500_000_000n);
    expect(parked.state.recipientAsset).toBe(0n);
    expect(parked.state.processedMessageIds.has(`Cctp:${"22".repeat(32)}`)).toBe(true);
  });

  it("never repeats a source asset or relay gas debit when succeeding after recovery", () => {
    const schedule = buildFaultSchedule({
      seed: 0x5eed_1234_abcd_0001n,
      steps: 8,
      failureRateBps: 7_500,
      stages: OUTBOUND_FAULT_STAGES,
    });
    expect(schedule.decisions.some((d) => d.injectFault)).toBe(true);

    let state = emptyState({
      senderAsset: 1_000_000_007n, // 100.0000007 (7 stroops of unrepresentable 7->6 dust)
      senderGas: 250_000_000n,
    });

    const request = {
      route: RouteKind.AxelarIts,
      amount: 1_000_000_007n,
      feeBps: 10,
      sourceDecimals: 7,
      destinationDecimals: 6,
      gasAmount: 100_000_000n,
    };

    let faultCount = 0;
    let recovered = false;
    for (const decision of schedule.decisions) {
      const res = rehearseOutboundAttempt(state, request, decision);
      state = res.state;
      if (!res.succeeded) {
        faultCount += 1;
      } else {
        recovered = true;
        break;
      }
    }

    if (!recovered) {
      const clear = rehearseOutboundAttempt(state, request, null);
      expect(clear.succeeded).toBe(true);
      state = clear.state;
    }

    expect(faultCount).toBeGreaterThan(0);
    // 10 bps of 1_000_000_007 = 1_000_000; net = floor(999_000_007, 7->6) = 999_000_000; gross = 1_000_000_000.
    // The 7 stroops of unrepresentable dust remain with the sender, and gross + gas are debited once.
    expect(state.senderAsset).toBe(7n);
    expect(state.senderGas).toBe(150_000_000n);
    expect(state.treasuryAsset).toBe(1_000_000n);
    expect(state.adapterAsset).toBe(999_000_000n);
    expect(state.adapterGas).toBe(100_000_000n);
    expect(state.routerAsset).toBe(0n);
    expect(state.outboundNonce).toBe(1n);
    expect(state.flowConsumed).toBe(999_000_000n);

    // Inbound recovery after transient provider/pull faults also credits once and rejects replay.
    const inboundSchedule = buildFaultSchedule({
      seed: 0x5eed_1234_abcd_0002n,
      steps: 6,
      failureRateBps: 8_000,
      stages: INBOUND_FAULT_STAGES.filter((s) => s !== "inbound-recipient-blocked"),
    });
    const delivery = {
      routeKey: "Cctp",
      messageIdHex: "aa".repeat(32),
      amount: 400_000_000n,
    };
    let inboundDelivered = false;
    for (const decision of inboundSchedule.decisions) {
      const res = rehearseInboundAttempt(state, delivery, decision);
      state = res.state;
      if (res.delivered) {
        inboundDelivered = true;
        break;
      }
    }
    if (!inboundDelivered) {
      const clear = rehearseInboundAttempt(state, delivery, null);
      expect(clear.delivered).toBe(true);
      state = clear.state;
    }
    expect(state.recipientAsset).toBe(400_000_000n);
    const replayAttempt = rehearseInboundAttempt(state, delivery, null);
    expect(replayAttempt.reverted).toBe(true);
    expect(replayAttempt.state.recipientAsset).toBe(400_000_000n);
  });
});
