import { describe, expect, it } from "vitest";
import {
  ERROR_HELP,
  ERROR_RECOVERY,
  ERROR_RECOVERY_CATEGORIES,
  EVM_ERROR_NAMES,
  SOROBAN_ERROR_NAMES,
  classifyProtocolError,
  classifySorobanError,
  classifySubmissionOutcome,
  describeError,
  sorobanErrorCode,
} from "../src/index.js";

describe("protocol error classification for recovery decisions", () => {
  it("maps every Soroban and EVM error name to a stable documented category", () => {
    for (const sorobanName of SOROBAN_ERROR_NAMES) {
      const decision = classifyProtocolError(sorobanName);
      expect(decision.knownError).toBe(true);
      expect(["transient", "user_correctable", "operator_action"]).toContain(decision.category);
      expect(ERROR_RECOVERY_CATEGORIES).toContain(decision.category);
      expect(ERROR_HELP[sorobanName].recoveryCategory).toBe(decision.category);
      expect(ERROR_RECOVERY[sorobanName]).toEqual(decision);

      const code = sorobanErrorCode(sorobanName);
      expect(code).not.toBeNull();
      if (code !== null) {
        expect(classifySorobanError(code)).toEqual(decision);
      }
    }

    for (const evmName of EVM_ERROR_NAMES) {
      const decision = classifyProtocolError(evmName);
      expect(decision.knownError).toBe(true);
      expect(["transient", "user_correctable", "operator_action"]).toContain(decision.category);
      expect(ERROR_HELP[evmName].recoveryCategory).toBe(decision.category);
    }

    // Spot-check canonical category assignments across transient, user_correctable, operator_action.
    expect(classifyProtocolError("FlowLimitExceeded").category).toBe("transient");
    expect(classifyProtocolError("FlowLimitExceeded").autoRetryRecommended).toBe(true);
    expect(classifyProtocolError("Paused").category).toBe("transient");
    expect(classifyProtocolError("RouteIsPaused").category).toBe("transient");

    expect(classifyProtocolError("InvalidDestination").category).toBe("user_correctable");
    expect(classifyProtocolError("InvalidDestination").autoRetryRecommended).toBe(false);
    expect(classifyProtocolError("RecipientNotReady").category).toBe("user_correctable");
    expect(classifyProtocolError("SlippageExceeded").category).toBe("user_correctable");

    expect(classifyProtocolError("AdapterNotSet").category).toBe("operator_action");
    expect(classifyProtocolError("AdapterNotSet").autoRetryRecommended).toBe(false);
    expect(classifyProtocolError("GasFloatTooLow").category).toBe("operator_action");
    expect(classifyProtocolError("ReplayedMessage").category).toBe("operator_action");
  });

  it("never recommends automatic retry under submission uncertainty", () => {
    for (const transportStatus of [
      "rpc_timeout",
      "network_disconnect",
      "mempool_pending",
      "missing_receipt",
      "ambiguous_gateway_error",
    ] as const) {
      // Even when paired with a normally transient error hint, submission uncertainty must halt
      // automatic retries and demand on-chain state reconciliation.
      const decision = classifySubmissionOutcome({
        transportStatus,
        errorName: "FlowLimitExceeded",
      });
      expect(decision.category).toBe("unknown_outcome");
      expect(decision.action).toBe("reconcile_chain_state");
      expect(decision.autoRetryRecommended).toBe(false);
      expect(decision.requiresOnChainCheck).toBe(true);
    }

    const uncertainDirect = classifyProtocolError("Paused", {
      submissionCertainty: "uncertain_submission",
    });
    expect(uncertainDirect.category).toBe("unknown_outcome");
    expect(uncertainDirect.autoRetryRecommended).toBe(false);
    expect(uncertainDirect.requiresOnChainCheck).toBe(true);

    // Conversely, a pre-broadcast simulation revert on FlowLimitExceeded is safe to wait-and-retry.
    const simulated = classifySubmissionOutcome({
      transportStatus: "simulated_revert",
      errorName: "FlowLimitExceeded",
    });
    expect(simulated.category).toBe("transient");
    expect(simulated.autoRetryRecommended).toBe(true);
    expect(simulated.requiresOnChainCheck).toBe(false);
  });

  it("retains conservative unknown_outcome fallback for unknown future errors and tags", () => {
    const futureDecision = classifyProtocolError("FutureV2RouterError");
    expect(futureDecision.knownError).toBe(false);
    expect(futureDecision.category).toBe("unknown_outcome");
    expect(futureDecision.action).toBe("reconcile_chain_state");
    expect(futureDecision.autoRetryRecommended).toBe(false);
    expect(futureDecision.requiresOnChainCheck).toBe(true);

    const futureHelp = describeError("FutureV2RouterError");
    expect(futureHelp.recoveryCategory).toBe("unknown_outcome");
    expect(futureHelp.retryable).toBe(false);

    const unknownCodeDecision = classifySorobanError(9999);
    expect(unknownCodeDecision.knownError).toBe(false);
    expect(unknownCodeDecision.category).toBe("unknown_outcome");
    expect(unknownCodeDecision.autoRetryRecommended).toBe(false);
    expect(unknownCodeDecision.requiresOnChainCheck).toBe(true);
  });
});
