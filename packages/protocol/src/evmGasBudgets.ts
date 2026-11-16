/**
 * Reproducible EVM gas budgets and regression reporting for governance and recovery paths.
 *
 * Mirrors the pinned Foundry profile (`Solc 0.8.28`, `cancun`, `via_ir = true`,
 * `optimizer_runs = 20_000`) and separates cold vs warm storage access as well as normal vs
 * hostile recipient behavior under representative router state growth (128 queued actions,
 * 128 processed replay keys and 128 parked claims).
 */

export interface EvmCompilerProfile {
  readonly solcVersion: string;
  readonly evmVersion: string;
  readonly viaIr: boolean;
  readonly optimizer: boolean;
  readonly optimizerRuns: number;
}

export type EvmStorageTemperature = "cold" | "warm";

export type EvmRecipientClass =
  | "not-applicable"
  | "normal"
  | "hostile-frozen-revert"
  | "hostile-silent-false"
  | "hostile-malformed-hook";

export type EvmGasPathCategory =
  | "governance-batch"
  | "governance-emergency"
  | "inbound-direct"
  | "claim-parking"
  | "claim-settlement";

export interface EvmGasBudgetSpec {
  readonly id: string;
  readonly category: EvmGasPathCategory;
  readonly storageTemperature: EvmStorageTemperature;
  readonly recipientClass: EvmRecipientClass;
  readonly baselineGas: bigint;
  readonly toleranceBps: bigint;
  readonly stateGrowthEntries: number;
  readonly description: string;
}

export interface EvmGasObservation {
  readonly id: string;
  readonly observedGas: bigint;
}

export type EvmGasMetricVerdict = "within-budget" | "regression" | "missing-observation";

export interface EvmGasMetricDelta {
  readonly id: string;
  readonly category: EvmGasPathCategory;
  readonly storageTemperature: EvmStorageTemperature;
  readonly recipientClass: EvmRecipientClass;
  readonly baselineGas: bigint;
  readonly ceilingGas: bigint;
  readonly toleranceBps: bigint;
  readonly observedGas: bigint | null;
  readonly deltaGas: bigint | null;
  readonly deltaBps: bigint | null;
  readonly verdict: EvmGasMetricVerdict;
}

export interface EvmGasRegressionReport {
  readonly passed: boolean;
  readonly compilerProfileMatched: boolean;
  readonly profileMismatchReasons: readonly string[];
  readonly metrics: readonly EvmGasMetricDelta[];
  readonly regressions: readonly EvmGasMetricDelta[];
  readonly byStorageTemperature: Readonly<
    Record<EvmStorageTemperature, readonly EvmGasMetricDelta[]>
  >;
  readonly byRecipientClass: Readonly<Record<EvmRecipientClass, readonly EvmGasMetricDelta[]>>;
}

const BPS_DENOMINATOR = 10_000n;

export const PINNED_EVM_COMPILER_PROFILE: EvmCompilerProfile = {
  solcVersion: "0.8.28",
  evmVersion: "cancun",
  viaIr: true,
  optimizer: true,
  optimizerRuns: 20_000,
};

/**
 * Pinned EVM gas budgets measured in `evm/test/unit/RouterGasBudgets.t.sol`.
 */
export const PINNED_EVM_GAS_BUDGETS: readonly EvmGasBudgetSpec[] = [
  {
    id: "gov.queue.cold",
    category: "governance-batch",
    storageTemperature: "cold",
    recipientClass: "not-applicable",
    baselineGas: 91_989n,
    toleranceBps: 1_000n,
    stateGrowthEntries: 0,
    description: "First queueAction allocating cold _actionCount and role slots.",
  },
  {
    id: "gov.queue.warm",
    category: "governance-batch",
    storageTemperature: "warm",
    recipientClass: "not-applicable",
    baselineGas: 78_798n,
    toleranceBps: 1_000n,
    stateGrowthEntries: 128,
    description: "Warm queueAction inside a batched governance sequence at 128 queued actions.",
  },
  {
    id: "gov.queue.batch5",
    category: "governance-batch",
    storageTemperature: "warm",
    recipientClass: "not-applicable",
    baselineGas: 393_990n,
    toleranceBps: 1_000n,
    stateGrowthEntries: 128,
    description: "Five-action governance queue batch under 128-action state growth.",
  },
  {
    id: "gov.execute.cold",
    category: "governance-batch",
    storageTemperature: "cold",
    recipientClass: "not-applicable",
    baselineGas: 11_102n,
    toleranceBps: 1_500n,
    stateGrowthEntries: 128,
    description: "First matured executeAction touching cold config storage after warp.",
  },
  {
    id: "gov.execute.warm",
    category: "governance-batch",
    storageTemperature: "warm",
    recipientClass: "not-applicable",
    baselineGas: 8_302n,
    toleranceBps: 1_500n,
    stateGrowthEntries: 128,
    description: "Subsequent matured executeAction in a five-action governance batch.",
  },
  {
    id: "gov.execute.batch5",
    category: "governance-batch",
    storageTemperature: "warm",
    recipientClass: "not-applicable",
    baselineGas: 44_310n,
    toleranceBps: 1_500n,
    stateGrowthEntries: 128,
    description: "Five-action matured governance execution batch.",
  },
  {
    id: "gov.cancel.warm",
    category: "governance-batch",
    storageTemperature: "warm",
    recipientClass: "not-applicable",
    baselineGas: 6_087n,
    toleranceBps: 1_500n,
    stateGrowthEntries: 128,
    description: "Guardian cancellation of a queued action.",
  },
  {
    id: "gov.emergency.pauseCold",
    category: "governance-emergency",
    storageTemperature: "cold",
    recipientClass: "not-applicable",
    baselineGas: 25_163n,
    toleranceBps: 1_000n,
    stateGrowthEntries: 128,
    description: "Guardian pauseRoute writing zero-to-nonzero routePaused slot.",
  },
  {
    id: "gov.emergency.lowerLimit",
    category: "governance-emergency",
    storageTemperature: "warm",
    recipientClass: "not-applicable",
    baselineGas: 15_047n,
    toleranceBps: 1_500n,
    stateGrowthEntries: 128,
    description: "Guardian lowerTokenFlowLimit immediate emergency brake.",
  },
  {
    id: "inbound.normal.cold",
    category: "inbound-direct",
    storageTemperature: "cold",
    recipientClass: "normal",
    baselineGas: 113_898n,
    toleranceBps: 1_000n,
    stateGrowthEntries: 0,
    description:
      "Direct bridgeIn payout to a zero-balance normal recipient with empty router escrow.",
  },
  {
    id: "inbound.normal.warm",
    category: "inbound-direct",
    storageTemperature: "warm",
    recipientClass: "normal",
    baselineGas: 40_485n,
    toleranceBps: 1_000n,
    stateGrowthEntries: 128,
    description:
      "Direct bridgeIn payout to a pre-funded normal recipient at 128-entry state growth.",
  },
  {
    id: "inbound.park.frozenCold",
    category: "claim-parking",
    storageTemperature: "cold",
    recipientClass: "hostile-frozen-revert",
    baselineGas: 185_518n,
    toleranceBps: 1_000n,
    stateGrowthEntries: 0,
    description: "First parked claim when frozen recipient reverts (_claimCount 0 -> 1).",
  },
  {
    id: "inbound.park.frozenWarm",
    category: "claim-parking",
    storageTemperature: "warm",
    recipientClass: "hostile-frozen-revert",
    baselineGas: 159_036n,
    toleranceBps: 1_000n,
    stateGrowthEntries: 128,
    description: "Warm claim parking when frozen recipient reverts at 128 parked claims.",
  },
  {
    id: "inbound.park.silentFalse",
    category: "claim-parking",
    storageTemperature: "warm",
    recipientClass: "hostile-silent-false",
    baselineGas: 156_769n,
    toleranceBps: 1_000n,
    stateGrowthEntries: 128,
    description: "Claim parking when token returns false without reverting.",
  },
  {
    id: "inbound.park.hostileHook",
    category: "claim-parking",
    storageTemperature: "warm",
    recipientClass: "hostile-malformed-hook",
    baselineGas: 204_538n,
    toleranceBps: 1_000n,
    stateGrowthEntries: 128,
    description:
      "Claim parking when hostile token burns 32 keccak rounds and returns 4 malformed bytes.",
  },
  {
    id: "recovery.settle.cold",
    category: "claim-settlement",
    storageTemperature: "cold",
    recipientClass: "normal",
    baselineGas: 35_520n,
    toleranceBps: 1_500n,
    stateGrowthEntries: 128,
    description: "settleClaim paying a zero-balance recipient slot under 128 parked claims.",
  },
  {
    id: "recovery.settle.warm",
    category: "claim-settlement",
    storageTemperature: "warm",
    recipientClass: "normal",
    baselineGas: 11_620n,
    toleranceBps: 1_500n,
    stateGrowthEntries: 128,
    description:
      "settleClaim paying a warm nonzero-balance recipient slot under 128 parked claims.",
  },
  {
    id: "recovery.settle.hostileRevert",
    category: "claim-settlement",
    storageTemperature: "warm",
    recipientClass: "hostile-frozen-revert",
    baselineGas: 8_282n,
    toleranceBps: 1_500n,
    stateGrowthEntries: 128,
    description: "settleClaim reverting with RecipientNotReady while recipient remains frozen.",
  },
];

/** Compute the enforced gas ceiling from a baseline and tolerance in basis points. */
export function gasBudgetCeiling(baselineGas: bigint, toleranceBps: bigint): bigint {
  return baselineGas + (baselineGas * toleranceBps) / BPS_DENOMINATOR;
}

/** Check whether a candidate compiler profile matches the pinned Hyperion Foundry profile. */
export function verifyPinnedEvmCompilerProfile(
  actual: EvmCompilerProfile,
  expected: EvmCompilerProfile = PINNED_EVM_COMPILER_PROFILE,
): readonly string[] {
  const reasons: string[] = [];
  if (actual.solcVersion !== expected.solcVersion) {
    reasons.push(
      `solcVersion mismatch: expected ${expected.solcVersion}, got ${actual.solcVersion}`,
    );
  }
  if (actual.evmVersion !== expected.evmVersion) {
    reasons.push(`evmVersion mismatch: expected ${expected.evmVersion}, got ${actual.evmVersion}`);
  }
  if (actual.viaIr !== expected.viaIr) {
    reasons.push(`viaIr mismatch: expected ${String(expected.viaIr)}, got ${String(actual.viaIr)}`);
  }
  if (actual.optimizer !== expected.optimizer) {
    reasons.push(
      `optimizer mismatch: expected ${String(expected.optimizer)}, got ${String(actual.optimizer)}`,
    );
  }
  if (actual.optimizerRuns !== expected.optimizerRuns) {
    reasons.push(
      `optimizerRuns mismatch: expected ${String(expected.optimizerRuns)}, got ${String(actual.optimizerRuns)}`,
    );
  }
  return reasons;
}

/**
 * Evaluate observed EVM gas measurements against the pinned budget table and compiler profile,
 * grouping metrics cleanly by cold/warm storage temperature and normal/hostile recipient class.
 */
export function evaluateEvmGasBudgets(
  observations: readonly EvmGasObservation[],
  options?: {
    readonly compilerProfile?: EvmCompilerProfile | undefined;
    readonly budgets?: readonly EvmGasBudgetSpec[] | undefined;
    readonly allowPartialObservations?: boolean | undefined;
  },
): EvmGasRegressionReport {
  const budgets = options?.budgets ?? PINNED_EVM_GAS_BUDGETS;
  const profile = options?.compilerProfile ?? PINNED_EVM_COMPILER_PROFILE;
  const allowPartial = options?.allowPartialObservations ?? false;

  const profileMismatchReasons = verifyPinnedEvmCompilerProfile(profile);
  const obsMap = new Map<string, bigint>();
  for (const obs of observations) {
    obsMap.set(obs.id, obs.observedGas);
  }

  const metrics: EvmGasMetricDelta[] = [];
  const regressions: EvmGasMetricDelta[] = [];

  const byTemp: Record<EvmStorageTemperature, EvmGasMetricDelta[]> = {
    cold: [],
    warm: [],
  };
  const byRecipient: Record<EvmRecipientClass, EvmGasMetricDelta[]> = {
    "not-applicable": [],
    normal: [],
    "hostile-frozen-revert": [],
    "hostile-silent-false": [],
    "hostile-malformed-hook": [],
  };

  for (const spec of budgets) {
    const ceilingGas = gasBudgetCeiling(spec.baselineGas, spec.toleranceBps);
    const observed = obsMap.get(spec.id);

    let item: EvmGasMetricDelta;
    if (observed === undefined) {
      if (allowPartial) continue;
      item = {
        id: spec.id,
        category: spec.category,
        storageTemperature: spec.storageTemperature,
        recipientClass: spec.recipientClass,
        baselineGas: spec.baselineGas,
        ceilingGas,
        toleranceBps: spec.toleranceBps,
        observedGas: null,
        deltaGas: null,
        deltaBps: null,
        verdict: "missing-observation",
      };
    } else {
      const deltaGas = observed - spec.baselineGas;
      const deltaBps = (deltaGas * BPS_DENOMINATOR) / spec.baselineGas;
      const verdict: EvmGasMetricVerdict = observed <= ceilingGas ? "within-budget" : "regression";
      item = {
        id: spec.id,
        category: spec.category,
        storageTemperature: spec.storageTemperature,
        recipientClass: spec.recipientClass,
        baselineGas: spec.baselineGas,
        ceilingGas,
        toleranceBps: spec.toleranceBps,
        observedGas: observed,
        deltaGas,
        deltaBps,
        verdict,
      };
    }

    metrics.push(item);
    byTemp[item.storageTemperature].push(item);
    byRecipient[item.recipientClass].push(item);
    if (item.verdict !== "within-budget") {
      regressions.push(item);
    }
  }

  return {
    passed: profileMismatchReasons.length === 0 && regressions.length === 0,
    compilerProfileMatched: profileMismatchReasons.length === 0,
    profileMismatchReasons,
    metrics,
    regressions,
    byStorageTemperature: byTemp,
    byRecipientClass: byRecipient,
  };
}
