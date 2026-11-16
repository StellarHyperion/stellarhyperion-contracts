/**
 * Stateful batch transfer simulation over shared virtual flow windows and spend allowances.
 *
 * `quoteBatch` in `./ladder.ts` prices independent amount tiers (for example, rendering 100 / 500 /
 * 1,000 USDC fee curves) where only one tier will ever be signed. A multi-transfer treasury or
 * payout batch is different: every transfer that executes consumes `netAmount` from the route's
 * sliding flow headroom (and any global token flow ceiling or wallet allowance), reducing what
 * remains for later items in the same window.
 */
import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS } from "../routes.js";
import { QuoteBlocker, bestQuote, planQuotes, wouldSlip } from "../quotes.js";
import type { QuoteRequest, RouteQuote, RouterSnapshot } from "../quotes.js";
import { RAIL_DESTINATION_GAS_ESTIMATES, type BatchQuoteResult } from "./types.js";

/** How `planSharedFlowBatch` handles an item that cannot be satisfied under remaining budgets. */
export type SharedBatchFailurePolicy = "exclude_failed" | "rollback_all" | "halt_after_failure";

export type SharedBatchItemStatus =
  "planned" | "excluded" | "failed" | "rolled_back" | "halted_skipped";

export type SharedBatchItemFailureReason =
  | "none"
  | "route_blocked"
  | "slippage_exceeded"
  | "sender_allowance_exceeded"
  | "halted_by_prior_failure";

/** Single transfer entry inside a shared-flow batch plan. */
export interface SharedBatchTransferInput {
  readonly id?: string;
  readonly amount: bigint;
  readonly strkey: string;
  readonly destinationDecimals: number;
  /** Optional pinned rail; when omitted, the planner selects `bestQuote` among remaining headroom. */
  readonly route?: RouteKind;
  /** Optional minimum destination amount enforced via `wouldSlip`. */
  readonly minDestinationAmount?: bigint;
}

export interface SharedFlowBatchOptions {
  readonly failurePolicy?: SharedBatchFailurePolicy;
  /** Optional token-wide flow ceiling shared across all rails in the current window. */
  readonly sharedTokenFlowCeiling?: bigint;
  /** Optional total sender balance or token spend allowance shared across gross amounts. */
  readonly sharedSenderAllowance?: bigint;
  /** Optional custom destination gas estimates per rail, matching `QuoteParams.gasEstimates`. */
  readonly gasEstimates?: Partial<Record<RouteKind, bigint>>;
}

export interface SharedBatchItemResult {
  readonly index: number;
  readonly id: string;
  readonly status: SharedBatchItemStatus;
  readonly included: boolean;
  readonly failureReason: SharedBatchItemFailureReason;
  readonly blocker: QuoteBlocker;
  readonly selectedRoute: RouteKind | null;
  readonly selectedQuote: RouteQuote | null;
  readonly flowAvailableBefore: Readonly<Record<RouteKind, bigint>>;
  readonly flowAvailableAfter: Readonly<Record<RouteKind, bigint>>;
  readonly consumedNetAmount: bigint;
  readonly consumedGrossAmount: bigint;
  /** Compatible single-tier `BatchQuoteResult` view evaluated against the virtual flow state. */
  readonly batchQuote: BatchQuoteResult;
}

export interface SharedFlowBatchPlan {
  readonly policy: SharedBatchFailurePolicy;
  readonly allSucceeded: boolean;
  readonly rolledBack: boolean;
  readonly plannedCount: number;
  readonly failedCount: number;
  readonly initialFlowByRoute: Readonly<Record<RouteKind, bigint>>;
  readonly consumedFlowByRoute: Readonly<Record<RouteKind, bigint>>;
  readonly remainingFlowByRoute: Readonly<Record<RouteKind, bigint>>;
  readonly initialTokenFlowCeiling: bigint | null;
  readonly remainingTokenFlowCeiling: bigint | null;
  readonly initialSenderAllowance: bigint | null;
  readonly remainingSenderAllowance: bigint | null;
  readonly totalGrossAmount: bigint;
  readonly totalFee: bigint;
  readonly totalNetAmount: bigint;
  readonly totalDestinationAmount: bigint;
  readonly items: readonly SharedBatchItemResult[];
}

function cloneRouteMap(source: Partial<Record<RouteKind, bigint>>): Record<RouteKind, bigint> {
  const out = {} as Record<RouteKind, bigint>;
  for (const route of ROUTE_KINDS) {
    const val = source[route] ?? 0n;
    if (val < 0n) {
      throw new RangeError(`flowAvailable for route ${String(route)} cannot be negative`);
    }
    out[route] = val;
  }
  return out;
}

function zeroRouteMap(): Record<RouteKind, bigint> {
  const out = {} as Record<RouteKind, bigint>;
  for (const route of ROUTE_KINDS) {
    out[route] = 0n;
  }
  return out;
}

function effectiveRouteFlow(
  routeRemaining: Readonly<Record<RouteKind, bigint>>,
  tokenCeilingRemaining: bigint | null,
): Record<RouteKind, bigint> {
  const out = {} as Record<RouteKind, bigint>;
  for (const route of ROUTE_KINDS) {
    const perRoute = routeRemaining[route];
    out[route] =
      tokenCeilingRemaining !== null && tokenCeilingRemaining < perRoute
        ? tokenCeilingRemaining
        : perRoute;
  }
  return out;
}

/**
 * Simulate a sequence of transfers against a shared virtual flow window without mutating
 * `snapshot`.
 */
export function planSharedFlowBatch(
  transfers: readonly SharedBatchTransferInput[],
  snapshot: RouterSnapshot,
  options?: SharedFlowBatchOptions,
): SharedFlowBatchPlan {
  const policy: SharedBatchFailurePolicy = options?.failurePolicy ?? "exclude_failed";

  if (options?.sharedTokenFlowCeiling !== undefined && options.sharedTokenFlowCeiling < 0n) {
    throw new RangeError("sharedTokenFlowCeiling cannot be negative");
  }
  if (options?.sharedSenderAllowance !== undefined && options.sharedSenderAllowance < 0n) {
    throw new RangeError("sharedSenderAllowance cannot be negative");
  }

  const gasProjections: Readonly<Record<RouteKind, bigint>> = Object.freeze({
    ...RAIL_DESTINATION_GAS_ESTIMATES,
    ...options?.gasEstimates,
  });

  const initialFlow = Object.freeze(cloneRouteMap(snapshot.flowAvailable));
  const workingFlow = cloneRouteMap(snapshot.flowAvailable);
  const consumedFlow = zeroRouteMap();

  const initialTokenCeiling = options?.sharedTokenFlowCeiling ?? null;
  let remainingTokenCeiling = initialTokenCeiling;

  const initialAllowance = options?.sharedSenderAllowance ?? null;
  let remainingAllowance = initialAllowance;

  const mutableItems: SharedBatchItemResult[] = [];
  let halted = false;
  let sawFailure = false;

  for (const [i, item] of transfers.entries()) {
    const id = item.id ?? `item-${String(i)}`;
    const flowBefore = Object.freeze(effectiveRouteFlow(workingFlow, remainingTokenCeiling));

    if (halted) {
      const virtualSnapshot: RouterSnapshot = {
        ...snapshot,
        flowAvailable: flowBefore,
      };
      const baseReq: Omit<QuoteRequest, "route"> = {
        amount: item.amount,
        strkey: item.strkey,
        destinationDecimals: item.destinationDecimals,
      };
      const quotes = planQuotes(baseReq, virtualSnapshot);
      const haltedBatchQuote: BatchQuoteResult = {
        amount: item.amount,
        available: false,
        winningRail: null,
        bestQuote: null,
        grossAmount: item.amount,
        fee: 0n,
        netAmount: 0n,
        destinationAmount: 0n,
        estimatedDestinationGas: null,
        gasProjections,
        quotes,
      };
      mutableItems.push({
        index: i,
        id,
        status: "halted_skipped",
        included: false,
        failureReason: "halted_by_prior_failure",
        blocker: QuoteBlocker.None,
        selectedRoute: null,
        selectedQuote: null,
        flowAvailableBefore: flowBefore,
        flowAvailableAfter: flowBefore,
        consumedNetAmount: 0n,
        consumedGrossAmount: 0n,
        batchQuote: haltedBatchQuote,
      });
      continue;
    }

    const virtualSnapshot: RouterSnapshot = {
      ...snapshot,
      flowAvailable: flowBefore,
    };
    const baseReq: Omit<QuoteRequest, "route"> = {
      amount: item.amount,
      strkey: item.strkey,
      destinationDecimals: item.destinationDecimals,
    };
    const quotes = planQuotes(baseReq, virtualSnapshot);

    let candidate: RouteQuote | null;
    if (item.route !== undefined) {
      const pinned = quotes.find((q) => q.route === item.route) ?? null;
      candidate = pinned?.available ? pinned : null;
    } else {
      candidate = bestQuote(quotes);
    }

    const batchQuote: BatchQuoteResult = {
      amount: item.amount,
      available: candidate !== null,
      winningRail: candidate !== null ? candidate.route : null,
      bestQuote: candidate,
      grossAmount: candidate !== null ? candidate.grossAmount : item.amount,
      fee: candidate !== null ? candidate.fee : 0n,
      netAmount: candidate !== null ? candidate.netAmount : 0n,
      destinationAmount: candidate !== null ? candidate.destinationAmount : 0n,
      estimatedDestinationGas: candidate !== null ? gasProjections[candidate.route] : null,
      gasProjections,
      quotes,
    };

    if (candidate === null) {
      sawFailure = true;
      const pinnedQuote =
        item.route !== undefined ? (quotes.find((q) => q.route === item.route) ?? null) : null;
      const primaryBlocker =
        pinnedQuote !== null ? pinnedQuote.reason : (quotes[0]?.reason ?? QuoteBlocker.Paused);
      if (policy === "halt_after_failure") {
        halted = true;
      }
      mutableItems.push({
        index: i,
        id,
        status: policy === "exclude_failed" ? "excluded" : "failed",
        included: false,
        failureReason: "route_blocked",
        blocker: primaryBlocker,
        selectedRoute: null,
        selectedQuote: pinnedQuote,
        flowAvailableBefore: flowBefore,
        flowAvailableAfter: flowBefore,
        consumedNetAmount: 0n,
        consumedGrossAmount: 0n,
        batchQuote,
      });
      continue;
    }

    if (
      item.minDestinationAmount !== undefined &&
      wouldSlip(candidate, item.minDestinationAmount)
    ) {
      sawFailure = true;
      if (policy === "halt_after_failure") {
        halted = true;
      }
      mutableItems.push({
        index: i,
        id,
        status: policy === "exclude_failed" ? "excluded" : "failed",
        included: false,
        failureReason: "slippage_exceeded",
        blocker: QuoteBlocker.None,
        selectedRoute: candidate.route,
        selectedQuote: candidate,
        flowAvailableBefore: flowBefore,
        flowAvailableAfter: flowBefore,
        consumedNetAmount: 0n,
        consumedGrossAmount: 0n,
        batchQuote: {
          ...batchQuote,
          available: false,
          winningRail: null,
          bestQuote: null,
        },
      });
      continue;
    }

    if (remainingAllowance !== null && candidate.grossAmount > remainingAllowance) {
      sawFailure = true;
      if (policy === "halt_after_failure") {
        halted = true;
      }
      mutableItems.push({
        index: i,
        id,
        status: policy === "exclude_failed" ? "excluded" : "failed",
        included: false,
        failureReason: "sender_allowance_exceeded",
        blocker: QuoteBlocker.None,
        selectedRoute: candidate.route,
        selectedQuote: candidate,
        flowAvailableBefore: flowBefore,
        flowAvailableAfter: flowBefore,
        consumedNetAmount: 0n,
        consumedGrossAmount: 0n,
        batchQuote: {
          ...batchQuote,
          available: false,
          winningRail: null,
          bestQuote: null,
        },
      });
      continue;
    }

    workingFlow[candidate.route] -= candidate.netAmount;
    consumedFlow[candidate.route] += candidate.netAmount;
    if (remainingTokenCeiling !== null) {
      remainingTokenCeiling -= candidate.netAmount;
    }
    if (remainingAllowance !== null) {
      remainingAllowance -= candidate.grossAmount;
    }

    const flowAfter = Object.freeze(effectiveRouteFlow(workingFlow, remainingTokenCeiling));
    mutableItems.push({
      index: i,
      id,
      status: "planned",
      included: true,
      failureReason: "none",
      blocker: QuoteBlocker.None,
      selectedRoute: candidate.route,
      selectedQuote: candidate,
      flowAvailableBefore: flowBefore,
      flowAvailableAfter: flowAfter,
      consumedNetAmount: candidate.netAmount,
      consumedGrossAmount: candidate.grossAmount,
      batchQuote,
    });
  }

  if (sawFailure && policy === "rollback_all") {
    const rolledBackItems = mutableItems.map((entry): SharedBatchItemResult => {
      if (!entry.included) return entry;
      return {
        ...entry,
        status: "rolled_back",
        included: false,
        flowAvailableBefore: initialFlow,
        flowAvailableAfter: initialFlow,
        consumedNetAmount: 0n,
        consumedGrossAmount: 0n,
      };
    });

    const failedCount = rolledBackItems.filter((entry) => entry.status === "failed").length;

    return {
      policy,
      allSucceeded: false,
      rolledBack: true,
      plannedCount: 0,
      failedCount,
      initialFlowByRoute: initialFlow,
      consumedFlowByRoute: Object.freeze(zeroRouteMap()),
      remainingFlowByRoute: initialFlow,
      initialTokenFlowCeiling: initialTokenCeiling,
      remainingTokenFlowCeiling: initialTokenCeiling,
      initialSenderAllowance: initialAllowance,
      remainingSenderAllowance: initialAllowance,
      totalGrossAmount: 0n,
      totalFee: 0n,
      totalNetAmount: 0n,
      totalDestinationAmount: 0n,
      items: Object.freeze(rolledBackItems),
    };
  }

  let plannedCount = 0;
  let failedCount = 0;
  let totalGrossAmount = 0n;
  let totalFee = 0n;
  let totalNetAmount = 0n;
  let totalDestinationAmount = 0n;

  for (const entry of mutableItems) {
    if (entry.included && entry.selectedQuote !== null) {
      plannedCount += 1;
      totalGrossAmount += entry.selectedQuote.grossAmount;
      totalFee += entry.selectedQuote.fee;
      totalNetAmount += entry.selectedQuote.netAmount;
      totalDestinationAmount += entry.selectedQuote.destinationAmount;
    } else {
      failedCount += 1;
    }
  }

  return {
    policy,
    allSucceeded: !sawFailure,
    rolledBack: false,
    plannedCount,
    failedCount,
    initialFlowByRoute: initialFlow,
    consumedFlowByRoute: Object.freeze(consumedFlow),
    remainingFlowByRoute: Object.freeze(workingFlow),
    initialTokenFlowCeiling: initialTokenCeiling,
    remainingTokenFlowCeiling: remainingTokenCeiling,
    initialSenderAllowance: initialAllowance,
    remainingSenderAllowance: remainingAllowance,
    totalGrossAmount,
    totalFee,
    totalNetAmount,
    totalDestinationAmount,
    items: Object.freeze(mutableItems),
  };
}
