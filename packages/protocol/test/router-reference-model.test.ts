import { describe, expect, it } from "vitest";
import {
  applyRouterOperation,
  createRouterModelState,
  generateRouterSequence,
  MODEL_DEFAULT_SOROBAN_FLOW_WINDOW_LEDGERS,
  MODEL_MIN_TIMELOCK_DELAY,
  modelFlowAvailable,
  RouteKind,
  type RouterModelConfig,
  type RouterModelState,
  type RouterOperation,
  type RouterStepResult,
  runRouterSequence,
  type SequenceCheckOutcome,
  shrinkFailingRouterSequence,
  verifyRouterModelInvariants,
} from "../src/index.js";

const SOROBAN_CONFIG: RouterModelConfig = {
  chain: "soroban",
  sourceDecimals: 7,
  destinationDecimals: 6,
  initialFeeBps: 10n,
  initialTimelockDelaySeconds: MODEL_MIN_TIMELOCK_DELAY,
  initialFlowWindowUnits: MODEL_DEFAULT_SOROBAN_FLOW_WINDOW_LEDGERS,
  initialTokenFlowLimit: 500_000_000n,
};

const EVM_CONFIG: RouterModelConfig = {
  chain: "evm",
  sourceDecimals: 6,
  destinationDecimals: 7,
  initialFeeBps: 10n,
  initialTimelockDelaySeconds: MODEL_MIN_TIMELOCK_DELAY,
  initialFlowWindowUnits: 3_600n,
  initialTokenFlowLimit: 500_000_000n,
};

describe("stateful cross-chain router reference model", () => {
  it("preserves conserved balances and fixed-recipient liabilities across generated Soroban sequences", () => {
    let parkedClaimsObserved = 0;
    let settledClaimsObserved = 0;
    let dustRetainedTransfers = 0;

    for (let seed = 1; seed <= 25; seed += 1) {
      const ops = generateRouterSequence(seed * 97 + 13, {
        chain: "soroban",
        length: 45,
      });
      const result = runRouterSequence(SOROBAN_CONFIG, ops);
      expect(result.invariantFailure).toBeNull();
      expect(verifyRouterModelInvariants(result.finalState).ok).toBe(true);

      for (const trace of result.traces) {
        if (trace.outcome.ok && (trace.outcome.dustRetained ?? 0n) > 0n) {
          dustRetainedTransfers += 1;
        }
      }
      for (const claim of result.finalState.claims.values()) {
        parkedClaimsObserved += 1;
        if (claim.settled) {
          settledClaimsObserved += 1;
        }
      }
    }

    expect(parkedClaimsObserved).toBeGreaterThan(0);
    expect(settledClaimsObserved).toBeGreaterThan(0);
    expect(dustRetainedTransfers).toBeGreaterThan(0);
  });

  it("preserves conserved balances and fixed-recipient liabilities across generated EVM sequences", () => {
    let parkedClaimsObserved = 0;
    let settledClaimsObserved = 0;

    for (let seed = 1; seed <= 25; seed += 1) {
      const ops = generateRouterSequence(seed * 131 + 7, {
        chain: "evm",
        length: 45,
      });
      const result = runRouterSequence(EVM_CONFIG, ops);
      expect(result.invariantFailure).toBeNull();
      expect(verifyRouterModelInvariants(result.finalState).ok).toBe(true);

      for (const claim of result.finalState.claims.values()) {
        parkedClaimsObserved += 1;
        if (claim.settled) {
          settledClaimsObserved += 1;
        }
      }
    }

    expect(parkedClaimsObserved).toBeGreaterThan(0);
    expect(settledClaimsObserved).toBeGreaterThan(0);
  });

  it("models Soroban ledger-driven flow decay separately from timestamp-driven timelocks", () => {
    const ops: readonly RouterOperation[] = [
      {
        type: "BridgeOut",
        caller: "alice",
        route: RouteKind.Cctp,
        amount: 100_000_000n,
        minDestinationAmount: 0n,
        destinationChain: "ethereum",
        destinationKind: "account",
      },
      {
        type: "QueueAction",
        caller: "admin",
        action: { kind: "SetFeeBps", feeBps: 25n },
      },
      // Wall-clock advances past 1h timelock delay, but zero ledgers close:
      // timelock matures while Soroban flow window does NOT decay.
      { type: "AdvanceTime", seconds: MODEL_MIN_TIMELOCK_DELAY + 1n },
      { type: "ExecuteAction", caller: "admin", actionId: 1n },
    ];

    const phaseOne = runRouterSequence(SOROBAN_CONFIG, ops);
    expect(phaseOne.invariantFailure).toBeNull();
    expect(phaseOne.finalState.feeBps).toBe(25n);
    const expectedUsedNet = 99_900_000n;
    expect(modelFlowAvailable(phaseOne.finalState, RouteKind.Cctp)).toBe(
      500_000_000n - expectedUsedNet,
    );

    // Queue a second action, then close 1,440 ledgers (2 full windows) with zero wall-clock change:
    // Soroban flow window decays back to 100% headroom, while the queued action stays immature.
    const phaseTwoOps: readonly RouterOperation[] = [
      ...ops,
      {
        type: "QueueAction",
        caller: "admin",
        action: { kind: "SetFeeBps", feeBps: 50n },
      },
      { type: "AdvanceLedgers", ledgers: MODEL_DEFAULT_SOROBAN_FLOW_WINDOW_LEDGERS * 2n },
      { type: "ExecuteAction", caller: "admin", actionId: 2n },
    ];

    const phaseTwo = runRouterSequence(SOROBAN_CONFIG, phaseTwoOps);
    expect(phaseTwo.invariantFailure).toBeNull();
    expect(modelFlowAvailable(phaseTwo.finalState, RouteKind.Cctp)).toBe(500_000_000n);
    const lastStep = phaseTwo.traces[phaseTwo.traces.length - 1]!;
    expect(lastStep.outcome).toEqual({ ok: false, error: "TimelockNotReady" });
    expect(phaseTwo.finalState.feeBps).toBe(25n);
  });

  it("models EVM timestamp-driven unified flow and timelock clocks plus route-scoped pause", () => {
    const ops: readonly RouterOperation[] = [
      {
        type: "BridgeOut",
        caller: "alice",
        route: RouteKind.Cctp,
        amount: 100_000_000n,
        minDestinationAmount: 0n,
        destinationChain: "stellar",
        destinationKind: "account",
      },
      {
        type: "QueueAction",
        caller: "admin",
        action: { kind: "SetFeeBps", feeBps: 30n },
      },
      // Advancing EVM block height alone neither decays flow nor matures timelocks.
      { type: "AdvanceBlocks", blocks: 1_000n },
      { type: "ExecuteAction", caller: "admin", actionId: 1n },
      // Advancing timestamp by 2 hours (> 3600s window and > 3600s timelock) advances BOTH.
      { type: "AdvanceTime", seconds: 7_200n },
      { type: "ExecuteAction", caller: "admin", actionId: 1n },
      // Guardian pauses only CCTP; Axelar ITS stays open and inbound CCTP still lands.
      { type: "PauseRoute", caller: "guardian", route: RouteKind.Cctp },
      {
        type: "BridgeOut",
        caller: "alice",
        route: RouteKind.Cctp,
        amount: 10_000n,
        minDestinationAmount: 0n,
        destinationChain: "stellar",
        destinationKind: "account",
      },
      {
        type: "BridgeOut",
        caller: "alice",
        route: RouteKind.AxelarIts,
        amount: 10_000n,
        minDestinationAmount: 0n,
        destinationChain: "stellar",
        destinationKind: "account",
      },
      {
        type: "BridgeIn",
        caller: "rail_cctp",
        route: RouteKind.Cctp,
        amount: 25_000n,
        recipient: "recipient_a",
        recipientKind: "account",
        sourceChain: "stellar",
        sourceNonce: 1n,
        messageId: "cctp-while-route-paused",
      },
    ];

    const run = runRouterSequence(EVM_CONFIG, ops);
    expect(run.invariantFailure).toBeNull();
    expect(run.traces[3]!.outcome).toEqual({ ok: false, error: "TimelockNotReady" });
    expect(run.traces[5]!.outcome).toEqual({ ok: true });
    expect(run.finalState.feeBps).toBe(30n);
    // After 7,200s (two full 3,600s windows), CCTP flow headroom is completely restored.
    expect(modelFlowAvailable(run.finalState, RouteKind.Cctp)).toBe(500_000_000n);
    expect(run.traces[7]!.outcome).toEqual({ ok: false, error: "RouteIsPaused" });
    expect(run.traces[8]!.outcome.ok).toBe(true);
    expect(run.traces[9]!.outcome).toEqual({ ok: true, value: 0n });
    expect(run.finalState.balances.recipient_a).toBe(25_000n);
  });

  it("enforces fixed-recipient claim settlement even when paused and settled by a stranger", () => {
    const ops: readonly RouterOperation[] = [
      { type: "SetAccountFrozen", account: "recipient_a", frozen: true },
      { type: "Pause", caller: "guardian" },
      {
        type: "BridgeIn",
        caller: "rail_cctp",
        route: RouteKind.Cctp,
        amount: 7_500_000n,
        recipient: "recipient_a",
        recipientKind: "account",
        sourceChain: "ethereum",
        sourceNonce: 99n,
        messageId: "parked-99",
      },
      { type: "SettleClaim", caller: "stranger", claimId: 1n },
      { type: "SetAccountFrozen", account: "recipient_a", frozen: false },
      { type: "SettleClaim", caller: "stranger", claimId: 1n },
      { type: "SettleClaim", caller: "stranger", claimId: 1n },
    ];

    const run = runRouterSequence(SOROBAN_CONFIG, ops);
    expect(run.invariantFailure).toBeNull();
    expect(run.traces[2]!.outcome).toEqual({ ok: true, value: 1n });
    expect(run.traces[3]!.outcome).toEqual({ ok: false, error: "RecipientNotReady" });
    expect(run.traces[5]!.outcome).toEqual({ ok: true });
    expect(run.traces[6]!.outcome).toEqual({ ok: false, error: "ClaimAlreadySettled" });
    expect(run.finalState.balances.recipient_a).toBe(7_500_000n);
    expect(run.finalState.balances.stranger).toBe(0n);
    expect(run.finalState.balances.router).toBe(0n);
  });

  it("shrinks a third-party claim-diversion bug from a noisy sequence to a 1-minimal trace", () => {
    // Faulty runner: credits `op.caller` instead of `claim.recipient` on `SettleClaim`.
    const buggyClaimRunner = (state: RouterModelState, op: RouterOperation): RouterStepResult => {
      if (op.type === "SettleClaim") {
        const claim = state.claims.get(op.claimId);
        if (
          claim !== undefined &&
          !claim.settled &&
          !state.frozenAccounts.has(claim.recipient) &&
          state.balances.router >= claim.amount
        ) {
          const nextClaims = new Map(state.claims);
          nextClaims.set(op.claimId, { ...claim, settled: true });
          return {
            state: {
              ...state,
              claims: nextClaims,
              balances: {
                ...state.balances,
                router: state.balances.router - claim.amount,
                [op.caller]: state.balances[op.caller] + claim.amount,
              },
            },
            outcome: { ok: true },
          };
        }
      }
      return applyRouterOperation(state, op);
    };

    const noisyOps: readonly RouterOperation[] = [
      ...generateRouterSequence(2026, { chain: "soroban", length: 18 }),
      { type: "SetAccountFrozen", account: "recipient_b", frozen: true },
      { type: "AdvanceLedgers", ledgers: 25n },
      {
        type: "BridgeIn",
        caller: "rail_its",
        route: RouteKind.AxelarIts,
        amount: 1_250_000n,
        recipient: "recipient_b",
        recipientKind: "account",
        sourceChain: "ethereum",
        sourceNonce: 777n,
        messageId: "diversion-target",
      },
      { type: "Pause", caller: "guardian" },
      { type: "SetAccountFrozen", account: "recipient_b", frozen: false },
      { type: "Unpause", caller: "admin" },
      { type: "SettleClaim", caller: "stranger", claimId: 1n },
      { type: "SettleClaim", caller: "stranger", claimId: 2n },
      { type: "SettleClaim", caller: "stranger", claimId: 3n },
      ...generateRouterSequence(4096, { chain: "soroban", length: 10 }),
    ];

    const check = (candidate: readonly RouterOperation[]): SequenceCheckOutcome => {
      const run = runRouterSequence(SOROBAN_CONFIG, candidate, buggyClaimRunner);
      if (run.invariantFailure !== null) {
        return {
          ok: false,
          failedStepIndex: run.invariantFailure.stepIndex,
          reason: run.invariantFailure.violations.join("; "),
        };
      }
      return { ok: true };
    };

    const minimal = shrinkFailingRouterSequence(SOROBAN_CONFIG, noisyOps, check, buggyClaimRunner);
    expect(minimal.minimalLength).toBeLessThanOrEqual(4);
    expect(minimal.failureReason).toContain("non-recipient actor received funds");
    expect(minimal.formattedTrace).toContain("Minimal reproducible router trace [chain=soroban");
    expect(minimal.formattedTrace).toContain("SettleClaim(caller=stranger");

    // Verify 1-minimality: dropping any single remaining step eliminates the failure.
    for (let i = 0; i < minimal.operations.length; i += 1) {
      const withoutStep = [...minimal.operations.slice(0, i), ...minimal.operations.slice(i + 1)];
      expect(check(withoutStep).ok).toBe(true);
    }
  });

  it("shrinks a Soroban clock-confusion bug and a decimal-dust leak to minimal traces", () => {
    // 1. Mutant Soroban model that decays flow on `timestampSeconds` instead of `ledgerSequence`.
    const wrongClockSorobanRunner = (
      state: RouterModelState,
      op: RouterOperation,
    ): RouterStepResult => {
      const spoofedEvmClockState: RouterModelState = {
        ...state,
        clock: {
          ...state.clock,
          // Wrongly project timestamp into ledgerSequence during outbound checks
          ledgerSequence:
            op.type === "BridgeOut" ? state.clock.timestampSeconds : state.clock.ledgerSequence,
        },
      };
      const res = applyRouterOperation(spoofedEvmClockState, op);
      return {
        state: {
          ...res.state,
          clock:
            op.type === "BridgeOut"
              ? { ...res.state.clock, ledgerSequence: state.clock.ledgerSequence }
              : res.state.clock,
        },
        outcome: res.outcome,
      };
    };

    const clockSequence: readonly RouterOperation[] = [
      { type: "AdvanceBlocks", blocks: 1n },
      {
        type: "BridgeOut",
        caller: "alice",
        route: RouteKind.Cctp,
        amount: 350_000_000n,
        minDestinationAmount: 0n,
        destinationChain: "ethereum",
        destinationKind: "account",
      },
      { type: "Pause", caller: "guardian" },
      { type: "Unpause", caller: "admin" },
      { type: "AdvanceTime", seconds: 1_800n },
      { type: "AdvanceTime", seconds: 1_800n },
      {
        type: "BridgeOut",
        caller: "alice",
        route: RouteKind.Cctp,
        amount: 350_000_000n,
        minDestinationAmount: 0n,
        destinationChain: "ethereum",
        destinationKind: "account",
      },
      { type: "AdvanceLedgers", ledgers: 50n },
    ];

    const compareWithReference = (candidate: readonly RouterOperation[]): SequenceCheckOutcome => {
      let refState = createRouterModelState(SOROBAN_CONFIG);
      let mutState = createRouterModelState(SOROBAN_CONFIG);
      for (let i = 0; i < candidate.length; i += 1) {
        const op = candidate[i]!;
        const refNext = applyRouterOperation(refState, op);
        const mutNext = wrongClockSorobanRunner(mutState, op);
        refState = refNext.state;
        mutState = mutNext.state;
        if (refNext.outcome.ok !== mutNext.outcome.ok) {
          const refLabel = refNext.outcome.ok ? "ok" : refNext.outcome.error;
          const mutLabel = mutNext.outcome.ok ? "ok" : mutNext.outcome.error;
          return {
            ok: false,
            failedStepIndex: i,
            reason: `outcome mismatch: ref=${refLabel} vs mut=${mutLabel}`,
          };
        }
      }
      return { ok: true };
    };

    const minimalClockTrace = shrinkFailingRouterSequence(
      SOROBAN_CONFIG,
      clockSequence,
      compareWithReference,
      wrongClockSorobanRunner,
    );
    // Adjacent AdvanceTime(1800s) + AdvanceTime(1800s) coalesce into AdvanceTime(3600s),
    // leaving [BridgeOut, AdvanceTime(3600s), BridgeOut] = 3 minimal steps!
    expect(minimalClockTrace.minimalLength).toBe(3);
    expect(minimalClockTrace.operations.map((o) => o.type)).toEqual([
      "BridgeOut",
      "AdvanceTime",
      "BridgeOut",
    ]);

    // 2. Mutant runner that burns decimal-flooring dust instead of leaving it with `sender`.
    const dustLeakRunner = (state: RouterModelState, op: RouterOperation): RouterStepResult => {
      const res = applyRouterOperation(state, op);
      if (op.type === "BridgeOut" && res.outcome.ok && (res.outcome.dustRetained ?? 0n) > 0n) {
        const dust = res.outcome.dustRetained ?? 0n;
        return {
          state: {
            ...res.state,
            balances: {
              ...res.state.balances,
              [op.caller]: res.state.balances[op.caller] - dust,
            },
          },
          outcome: res.outcome,
        };
      }
      return res;
    };

    const noisyDustSeq = generateRouterSequence(77, { chain: "soroban", length: 30 });
    const checkDust = (candidate: readonly RouterOperation[]): SequenceCheckOutcome => {
      const run = runRouterSequence(SOROBAN_CONFIG, candidate, dustLeakRunner);
      if (run.invariantFailure !== null) {
        return {
          ok: false,
          failedStepIndex: run.invariantFailure.stepIndex,
          reason: run.invariantFailure.violations.join("; "),
        };
      }
      return { ok: true };
    };

    const minimalDustTrace = shrinkFailingRouterSequence(
      SOROBAN_CONFIG,
      noisyDustSeq,
      checkDust,
      dustLeakRunner,
    );
    expect(minimalDustTrace.minimalLength).toBe(1);
    expect(minimalDustTrace.failureReason).toContain("supply conservation violated");
  });
});
