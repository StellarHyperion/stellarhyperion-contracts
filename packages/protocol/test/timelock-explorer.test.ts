import { describe, expect, it } from "vitest";
import {
  TIMELOCK_GRACE_PERIOD_SECONDS,
  TIMELOCK_MIN_DELAY_SECONDS,
  formatFailureTrace,
  generateTimelockExplorationSuite,
  runTimelockSequence,
  serializeActionPayload,
} from "../src/index.js";

describe("timelock boundary and authority sequence explorer", () => {
  it("explores curated boundary, handover, cancellation, expiration, disable, and generated sequences with zero violations", () => {
    const suite = generateTimelockExplorationSuite(16);
    expect(suite.length).toBe(19);

    for (const spec of suite) {
      const report = runTimelockSequence(spec.name, spec.operations);
      expect(report.passed).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.steps.length).toBe(spec.operations.length);
    }
  });

  it("enforces exact eta - 1, eta, expiresAt, expiresAt + 1, and duplicate-execution boundaries", () => {
    const suite = generateTimelockExplorationSuite(0);
    const boundarySpec = suite.find((s) => s.name === "exact-eta-and-expiration-boundaries");
    if (boundarySpec === undefined) {
      throw new Error("missing exact-eta-and-expiration-boundaries spec");
    }

    const report = runTimelockSequence(boundarySpec.name, boundarySpec.operations);
    expect(report.passed).toBe(true);

    // Step 3: execute at eta - 1 -> TimelockNotReady
    expect(report.steps[2]?.succeeded).toBe(false);
    expect(report.steps[2]?.error).toBe("TimelockNotReady");

    // Step 5: execute at exact eta -> succeeds
    expect(report.steps[4]?.succeeded).toBe(true);
    expect(report.steps[4]?.error).toBeNull();

    // Step 6: duplicate execute -> TimelockNotQueued
    expect(report.steps[5]?.succeeded).toBe(false);
    expect(report.steps[5]?.error).toBe("TimelockNotQueued");

    // Step 9: execute at exact expiresAt (eta + GRACE_PERIOD) -> succeeds
    expect(report.steps[8]?.succeeded).toBe(true);

    // Step 12: execute at expiresAt + 1 -> TimelockExpired
    expect(report.steps[11]?.succeeded).toBe(false);
    expect(report.steps[11]?.error).toBe("TimelockExpired");
  });

  it("verifies superseded admins and guardians retain zero authority after handover", () => {
    const suite = generateTimelockExplorationSuite(0);
    const handoverSpec = suite.find(
      (s) => s.name === "admin-and-guardian-handover-revokes-superseded-actors",
    );
    if (handoverSpec === undefined) {
      throw new Error("missing handover spec");
    }

    const report = runTimelockSequence(handoverSpec.name, handoverSpec.operations);
    expect(report.passed).toBe(true);
    expect(report.finalState.admin).toBe("admin-2");
    expect(report.finalState.guardian).toBe("guardian-2");
    expect(report.finalState.feeBps).toBe(10); // admin-1's queued hike to 75 was cancelled by guardian-1

    // Steps 5..10 are superseded admin-1 attempting execute, queue, cancel, pause, disableRoute, lowerTokenFlowLimit.
    for (const stepIdx of [4, 5, 6, 7, 8, 9]) {
      expect(report.steps[stepIdx]?.caller).toBe("admin-1");
      expect(report.steps[stepIdx]?.succeeded).toBe(false);
      expect(report.steps[stepIdx]?.error).toBe("Unauthorized");
    }

    // Steps 16..17 are superseded guardian-1 attempting pause and disableToken.
    for (const stepIdx of [15, 16]) {
      expect(report.steps[stepIdx]?.caller).toBe("guardian-1");
      expect(report.steps[stepIdx]?.succeeded).toBe(false);
      expect(report.steps[stepIdx]?.error).toBe("Unauthorized");
    }
  });

  it("includes chain timestamp, ledger sequence, queued window, and full action payload in failure traces", () => {
    const targetAction = {
      kind: "RaiseTokenFlowLimit" as const,
      token: "USDC_SAC",
      flowLimit: 99_000_000_000n,
    };

    // Local fault fixture 1: premature unreviewed expansion before eta.
    const earlyReport = runTimelockSequence(
      "fault-early-expansion",
      [
        { op: "queueAction", caller: "admin-1", action: targetAction },
        { op: "advanceTime", deltaSeconds: TIMELOCK_MIN_DELAY_SECONDS - 5n, deltaLedgers: 719 },
        { op: "executeAction", caller: "admin-1", actionId: 1n },
      ],
      { allowEarlyExecution: true },
    );

    expect(earlyReport.passed).toBe(false);
    expect(earlyReport.failures.length).toBe(1);
    const earlyFailure = earlyReport.failures[0];
    if (earlyFailure === undefined) {
      throw new Error("expected earlyFailure");
    }
    expect(earlyFailure.invariantCode).toBe("EARLY_UNREVIEWED_EXPANSION");
    expect(earlyFailure.timestamp).toBe(1_700_000_000n + TIMELOCK_MIN_DELAY_SECONDS - 5n);
    expect(earlyFailure.ledgerSequence).toBe(100_719);
    expect(earlyFailure.fullActionPayloadJson).toBe(serializeActionPayload(targetAction));
    expect(earlyFailure.queuedWindow?.expiresAt).toBe(
      1_700_000_000n + TIMELOCK_MIN_DELAY_SECONDS + TIMELOCK_GRACE_PERIOD_SECONDS,
    );

    const formattedEarly = formatFailureTrace(earlyFailure);
    expect(formattedEarly).toContain("invariant=EARLY_UNREVIEWED_EXPANSION");
    expect(formattedEarly).toContain(`timestamp=${earlyFailure.timestamp.toString()}`);
    expect(formattedEarly).toContain("ledger=100719");
    expect(formattedEarly).toContain(serializeActionPayload(targetAction));

    // Local fault fixture 2: superseded admin retaining authority after SetAdmin handover.
    const supersededAction = { kind: "SetTreasury" as const, treasury: "rogue-vault" };
    const supersededReport = runTimelockSequence(
      "fault-superseded-admin",
      [
        { op: "queueAction", caller: "admin-1", action: { kind: "SetAdmin", newAdmin: "admin-2" } },
        { op: "advanceTime", deltaSeconds: TIMELOCK_MIN_DELAY_SECONDS, deltaLedgers: 720 },
        { op: "executeAction", caller: "admin-1", actionId: 1n },
        { op: "queueAction", caller: "admin-1", action: supersededAction },
      ],
      { allowSupersededAdmin: true },
    );

    expect(supersededReport.passed).toBe(false);
    expect(supersededReport.failures.length).toBe(1);
    const supFailure = supersededReport.failures[0];
    if (supFailure === undefined) {
      throw new Error("expected supFailure");
    }
    expect(supFailure.invariantCode).toBe("SUPERSEDED_ACTOR_RETAINED_AUTHORITY");
    expect(supFailure.caller).toBe("admin-1");
    expect(supFailure.activeAdmin).toBe("admin-2");
    expect(supFailure.fullActionPayloadJson).toBe(serializeActionPayload(supersededAction));
  });
});
