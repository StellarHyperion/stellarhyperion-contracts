/**
 * Deterministic seed-driven provider fault scheduling for local bridge rehearsals.
 *
 * Uses a 64-bit SplitMix64 generator identical to the Soroban Rust rehearsal controller so a
 * single saved seed reproduces the exact sequence of dispatch and inbound fault injections across
 * TypeScript and Rust harnesses.
 *
 * Browser-safe (`bigint` and plain objects only; zero Node.js builtins).
 */

import { applyFee, convertDecimalsExact, floorToRepresentable } from "./amounts.js";
import type { RouteKind } from "./routes.js";

const MASK_64 = (1n << 64n) - 1n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
const MIX_1 = 0xbf58476d1ce4e5b9n;
const MIX_2 = 0x94d049bb133111ebn;

export const FAULT_STAGES = [
  "outbound-dispatch",
  "outbound-paid-asset-pull",
  "outbound-paid-relay-gas",
  "inbound-provider-verify",
  "inbound-pull",
  "inbound-recipient-blocked",
] as const;

export type FaultStage = (typeof FAULT_STAGES)[number];

export const OUTBOUND_FAULT_STAGES: readonly FaultStage[] = [
  "outbound-dispatch",
  "outbound-paid-asset-pull",
  "outbound-paid-relay-gas",
] as const;

export const INBOUND_FAULT_STAGES: readonly FaultStage[] = [
  "inbound-provider-verify",
  "inbound-pull",
  "inbound-recipient-blocked",
] as const;

export interface FaultStepDecision {
  readonly step: number;
  readonly stage: FaultStage;
  readonly injectFault: boolean;
  readonly rollBps: number;
}

export interface FaultSchedule {
  readonly seedHex: string;
  readonly steps: number;
  readonly failureRateBps: number;
  readonly stages: readonly FaultStage[];
  readonly decisions: readonly FaultStepDecision[];
}

/**
 * Deterministic 64-bit SplitMix64 PRNG matching the Soroban Rust fault scheduler bit-for-bit.
 */
export class SplitMix64 {
  private state: bigint;

  constructor(seed: bigint) {
    if (seed < 0n || seed > MASK_64) {
      throw new RangeError("SplitMix64 seed must fit in an unsigned 64-bit integer");
    }
    this.state = seed & MASK_64;
  }

  nextU64(): bigint {
    this.state = (this.state + GOLDEN_GAMMA) & MASK_64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * MIX_1) & MASK_64;
    z = ((z ^ (z >> 27n)) * MIX_2) & MASK_64;
    return (z ^ (z >> 31n)) & MASK_64;
  }
}

export function formatSeedHex(seed: bigint): string {
  if (seed < 0n || seed > MASK_64) {
    throw new RangeError("Seed must fit in an unsigned 64-bit integer");
  }
  return `0x${seed.toString(16).padStart(16, "0")}`;
}

export function parseSeedHex(seedHex: string): bigint {
  const normalized = seedHex.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,16}$/.test(normalized)) {
    throw new RangeError(`Invalid 64-bit hex seed: '${seedHex}'`);
  }
  return BigInt(normalized);
}

/**
 * Build a reproducible fault schedule from a 64-bit seed, step count, failure rate (0..10_000 bps),
 * and candidate stages.
 */
export function buildFaultSchedule(params: {
  readonly seed: bigint;
  readonly steps: number;
  readonly failureRateBps: number;
  readonly stages?: readonly FaultStage[];
}): FaultSchedule {
  const { seed, steps, failureRateBps } = params;
  const stages = params.stages ?? FAULT_STAGES;
  if (!Number.isInteger(steps) || steps < 0) {
    throw new RangeError("steps must be a non-negative integer");
  }
  if (!Number.isInteger(failureRateBps) || failureRateBps < 0 || failureRateBps > 10_000) {
    throw new RangeError("failureRateBps must be an integer in 0..=10_000");
  }
  if (stages.length === 0) {
    throw new RangeError("stages must contain at least one FaultStage");
  }

  const rng = new SplitMix64(seed);
  const decisions: FaultStepDecision[] = [];
  for (let step = 0; step < steps; step += 1) {
    const rollWord = rng.nextU64();
    const stageWord = rng.nextU64();
    const rollBps = Number(rollWord % 10_000n);
    const stageIndex = Number(stageWord % BigInt(stages.length));
    const stage = stages[stageIndex];
    if (stage === undefined) {
      throw new Error("unreachable empty stage index");
    }
    decisions.push({
      step,
      stage,
      injectFault: rollBps < failureRateBps,
      rollBps,
    });
  }

  return {
    seedHex: formatSeedHex(seed),
    steps,
    failureRateBps,
    stages: [...stages],
    decisions,
  };
}

export interface RehearsalState {
  readonly senderAsset: bigint;
  readonly senderGas: bigint;
  readonly treasuryAsset: bigint;
  readonly routerAsset: bigint;
  readonly adapterAsset: bigint;
  readonly adapterGas: bigint;
  readonly railReceiverAsset: bigint;
  readonly recipientAsset: bigint;
  readonly outboundNonce: bigint;
  readonly flowConsumed: bigint;
  readonly processedMessageIds: ReadonlySet<string>;
  readonly parkedClaims: ReadonlyMap<
    bigint,
    { readonly amount: bigint; readonly settled: boolean }
  >;
}

export interface OutboundRehearsalAttemptResult {
  readonly succeeded: boolean;
  readonly injectedStage: FaultStage | null;
  readonly state: RehearsalState;
}

/**
 * Execute one atomic outbound transfer attempt under an optional injected fault stage, proving
 * full state rollback on provider failure and exact single-debit accounting on recovery.
 */
export function rehearseOutboundAttempt(
  before: RehearsalState,
  request: {
    readonly route: RouteKind;
    readonly amount: bigint;
    readonly feeBps: number;
    readonly sourceDecimals: number;
    readonly destinationDecimals: number;
    readonly gasAmount: bigint;
  },
  fault: { readonly stage: FaultStage; readonly injectFault: boolean } | null,
): OutboundRehearsalAttemptResult {
  const split = applyFee(request.amount, request.feeBps);
  const net = floorToRepresentable(split.net, request.sourceDecimals, request.destinationDecimals);
  if (net <= 0n) {
    throw new RangeError("Transfer net amount is not representable on destination");
  }
  // Ensure destination conversion succeeds without truncation.
  convertDecimalsExact(net, request.sourceDecimals, request.destinationDecimals);
  const gross = split.fee + net;

  if (before.senderAsset < gross || before.senderGas < request.gasAmount) {
    throw new RangeError("Insufficient sender balance for rehearsal");
  }

  if (
    fault !== null &&
    fault.injectFault &&
    (fault.stage === "outbound-dispatch" ||
      fault.stage === "outbound-paid-asset-pull" ||
      fault.stage === "outbound-paid-relay-gas")
  ) {
    // Atomic transaction rollback: partial fee, asset pull, gas pull, nonce, and flow window
    // consumption all revert together.
    return {
      succeeded: false,
      injectedStage: fault.stage,
      state: before,
    };
  }

  return {
    succeeded: true,
    injectedStage: null,
    state: {
      ...before,
      senderAsset: before.senderAsset - gross,
      senderGas: before.senderGas - request.gasAmount,
      treasuryAsset: before.treasuryAsset + split.fee,
      adapterAsset: before.adapterAsset + net,
      adapterGas: before.adapterGas + request.gasAmount,
      outboundNonce: before.outboundNonce + 1n,
      flowConsumed: before.flowConsumed + net,
    },
  };
}

export interface InboundRehearsalAttemptResult {
  readonly delivered: boolean;
  readonly parkedClaimId: bigint | null;
  readonly reverted: boolean;
  readonly injectedStage: FaultStage | null;
  readonly state: RehearsalState;
}

/**
 * Execute one inbound delivery attempt under an optional injected fault stage, modeling atomic
 * revert on provider/pull failure and recipient-bound claim parking when the recipient cannot
 * receive immediately.
 */
export function rehearseInboundAttempt(
  before: RehearsalState,
  delivery: {
    readonly routeKey: string;
    readonly messageIdHex: string;
    readonly amount: bigint;
  },
  fault: { readonly stage: FaultStage; readonly injectFault: boolean } | null,
): InboundRehearsalAttemptResult {
  const replayKey = `${delivery.routeKey}:${delivery.messageIdHex.toLowerCase()}`;
  if (before.processedMessageIds.has(replayKey)) {
    return {
      delivered: false,
      parkedClaimId: null,
      reverted: true,
      injectedStage: null,
      state: before,
    };
  }

  if (
    fault !== null &&
    fault.injectFault &&
    (fault.stage === "inbound-provider-verify" || fault.stage === "inbound-pull")
  ) {
    return {
      delivered: false,
      parkedClaimId: null,
      reverted: true,
      injectedStage: fault.stage,
      state: before,
    };
  }

  if (before.railReceiverAsset < delivery.amount) {
    return {
      delivered: false,
      parkedClaimId: null,
      reverted: true,
      injectedStage: "inbound-pull",
      state: before,
    };
  }

  const nextProcessed = new Set(before.processedMessageIds);
  nextProcessed.add(replayKey);

  if (fault !== null && fault.injectFault && fault.stage === "inbound-recipient-blocked") {
    const claimId = BigInt(before.parkedClaims.size + 1);
    const nextClaims = new Map(before.parkedClaims);
    nextClaims.set(claimId, { amount: delivery.amount, settled: false });
    return {
      delivered: false,
      parkedClaimId: claimId,
      reverted: false,
      injectedStage: "inbound-recipient-blocked",
      state: {
        ...before,
        railReceiverAsset: before.railReceiverAsset - delivery.amount,
        routerAsset: before.routerAsset + delivery.amount,
        processedMessageIds: nextProcessed,
        parkedClaims: nextClaims,
      },
    };
  }

  return {
    delivered: true,
    parkedClaimId: null,
    reverted: false,
    injectedStage: null,
    state: {
      ...before,
      railReceiverAsset: before.railReceiverAsset - delivery.amount,
      recipientAsset: before.recipientAsset + delivery.amount,
      processedMessageIds: nextProcessed,
    },
  };
}
