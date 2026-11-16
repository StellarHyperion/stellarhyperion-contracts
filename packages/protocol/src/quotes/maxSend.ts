/**
 * Exact integer maximum-send planner accounting for wallet balance, token allowance, fee reserves,
 * sliding router flow headroom, and cross-chain decimal representability dust.
 *
 * Computes the largest admissible outbound request without exceeding source balance, ERC-20/SAC
 * route allowance, or router `flowAvailable`, tightens the suggested request so precision-boundary
 * dust stays in the sender's wallet rather than triggering dust refunds or overpaying rounding fees,
 * and returns structured diagnostics (`available: false`, `quote: null`) whenever no positive
 * executable transfer exists.
 */
import { BPS_DENOMINATOR, MAX_DECIMALS, floorToRepresentable } from "../amounts.js";
import type { QuoteBlocker, RouteQuote, RouterSnapshot } from "../quotes.js";
import {
  MAX_QUOTE_AMOUNT,
  QuoteBlocker as QuoteBlockerEnum,
  bestQuote,
  describeBlocker,
  planQuote,
} from "../quotes.js";
import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS, ROUTE_SLUGS } from "../routes.js";

/** Input constraints for planning the largest admissible transfer on a rail. */
export interface MaxSendRequest {
  readonly route: RouteKind;
  /** Sender's total source-token balance in `snapshot.tokenDecimals` base units. */
  readonly walletBalance: bigint;
  /** Optional source-token reserve to keep untouched in the wallet (defaults to `0n`). */
  readonly feeReserve?: bigint;
  /** Optional approved token allowance granted to the router for this asset/rail. */
  readonly routeAllowance?: bigint;
  /** Destination Stellar address (`G...`, `C...`, or `M...`). */
  readonly strkey: string;
  /** Decimal precision on the destination chain. */
  readonly destinationDecimals: number;
}

export type MaxSendLimitingFactor =
  "wallet_balance" | "route_allowance" | "flow_headroom" | "protocol_max_quote";

export type MaxSendDiagnosticCode =
  | "InvalidConstraint"
  | "InsufficientBalance"
  | "InsufficientAllowance"
  | "RouteBlocked"
  | "ZeroFlowHeadroom"
  | "DustOnlyBelowMinimum";

/** Executable maximum-send solution with explicit retained precision dust. */
export interface MaxSendPlanSuccess {
  readonly ok: true;
  readonly available: true;
  readonly route: RouteKind;
  readonly routeSlug: string;
  /** Exact dust-free request amount (`> 0n`) to submit to `planQuote` / `bridgeOut`. */
  readonly suggestedRequestAmount: bigint;
  /** Verified `RouteQuote` at `suggestedRequestAmount` (`quote.available === true`). */
  readonly quote: RouteQuote;
  /** `walletBalance - feeReserve`. */
  readonly spendableBalance: bigint;
  /** Upper spend cap before precision tightening (`min(spendableBalance, routeAllowance, flowCap)`). */
  readonly effectiveSpendCeiling: bigint;
  /** Precision-boundary dust retained in the wallet because it cannot form 1 destination unit. */
  readonly retainedPrecisionDust: bigint;
  /** Total source-token balance remaining in the sender's wallet (`walletBalance - quote.grossAmount`). */
  readonly remainingWalletBalance: bigint;
  /** Which ceiling bound the maximum admissible transfer. */
  readonly limitingFactor: MaxSendLimitingFactor;
}

/** Structured diagnostic returned instead of a zero executable quote when no transfer is possible. */
export interface MaxSendPlanDiagnostic {
  readonly ok: false;
  readonly available: false;
  readonly route: RouteKind;
  readonly routeSlug: string;
  readonly quote: null;
  readonly diagnosticCode: MaxSendDiagnosticCode;
  readonly blocker: QuoteBlocker | null;
  readonly reason: string;
  readonly spendableBalance: bigint;
  /** Unrepresentable dust left in the wallet when balance/headroom cannot clear 1 destination unit. */
  readonly retainedPrecisionDust: bigint;
}

export type MaxSendPlanResult = MaxSendPlanSuccess | MaxSendPlanDiagnostic;

export interface AllRailsMaxSendSummary {
  readonly available: boolean;
  readonly recommended: MaxSendPlanSuccess | null;
  readonly plans: readonly MaxSendPlanResult[];
}

function isStaticBlocker(reason: QuoteBlocker): boolean {
  return (
    reason === QuoteBlockerEnum.Paused ||
    reason === QuoteBlockerEnum.RouteDisabled ||
    reason === QuoteBlockerEnum.AdapterNotSet ||
    reason === QuoteBlockerEnum.InvalidDestination ||
    reason === QuoteBlockerEnum.MuxedNotSupported ||
    reason === QuoteBlockerEnum.ChainNotSupported ||
    reason === QuoteBlockerEnum.TokenNotRegistered ||
    reason === QuoteBlockerEnum.TokenDisabled
  );
}

function diagnostic(
  route: RouteKind,
  diagnosticCode: MaxSendDiagnosticCode,
  blocker: QuoteBlocker | null,
  reason: string,
  spendableBalance: bigint,
  retainedPrecisionDust: bigint,
): MaxSendPlanDiagnostic {
  return {
    ok: false,
    available: false,
    route,
    routeSlug: ROUTE_SLUGS[route],
    quote: null,
    diagnosticCode,
    blocker,
    reason,
    spendableBalance,
    retainedPrecisionDust,
  };
}

/**
 * Compute the largest admissible transfer request for a single rail using exact integer arithmetic.
 */
export function planMaxSend(request: MaxSendRequest, snapshot: RouterSnapshot): MaxSendPlanResult {
  const { route, walletBalance, strkey, destinationDecimals } = request;
  const feeReserve = request.feeReserve ?? 0n;

  if (walletBalance < 0n) {
    return diagnostic(
      route,
      "InvalidConstraint",
      null,
      `walletBalance cannot be negative, got ${walletBalance.toString()}`,
      0n,
      0n,
    );
  }
  if (feeReserve < 0n) {
    return diagnostic(
      route,
      "InvalidConstraint",
      null,
      `feeReserve cannot be negative, got ${feeReserve.toString()}`,
      0n,
      0n,
    );
  }
  if (request.routeAllowance !== undefined && request.routeAllowance < 0n) {
    return diagnostic(
      route,
      "InvalidConstraint",
      null,
      `routeAllowance cannot be negative, got ${request.routeAllowance.toString()}`,
      0n,
      0n,
    );
  }
  if (
    !Number.isInteger(snapshot.tokenDecimals) ||
    snapshot.tokenDecimals < 0 ||
    snapshot.tokenDecimals > MAX_DECIMALS ||
    !Number.isInteger(destinationDecimals) ||
    destinationDecimals < 0 ||
    destinationDecimals > MAX_DECIMALS
  ) {
    return diagnostic(
      route,
      "InvalidConstraint",
      QuoteBlockerEnum.NotRepresentable,
      `tokenDecimals and destinationDecimals must be integers in 0..${String(MAX_DECIMALS)}`,
      0n,
      0n,
    );
  }
  if (!Number.isInteger(snapshot.feeBps) || snapshot.feeBps < 0 || snapshot.feeBps >= 10_000) {
    return diagnostic(
      route,
      "InvalidConstraint",
      QuoteBlockerEnum.RouteDisabled,
      `invalid snapshot feeBps ${String(snapshot.feeBps)}`,
      0n,
      0n,
    );
  }

  // Static route readiness check comes before dust checks so paused/disabled rails report accurately.
  const staticProbe = planQuote({ route, amount: 1n, strkey, destinationDecimals }, snapshot);
  if (isStaticBlocker(staticProbe.reason)) {
    const rawSpendable = walletBalance > feeReserve ? walletBalance - feeReserve : 0n;
    return diagnostic(
      route,
      "RouteBlocked",
      staticProbe.reason,
      describeBlocker(staticProbe.reason).detail,
      rawSpendable,
      0n,
    );
  }

  if (walletBalance <= feeReserve) {
    return diagnostic(
      route,
      "InsufficientBalance",
      QuoteBlockerEnum.AmountTooSmall,
      `walletBalance (${walletBalance.toString()}) does not exceed feeReserve (${feeReserve.toString()})`,
      0n,
      0n,
    );
  }

  const spendableBalance = walletBalance - feeReserve;

  if (request.routeAllowance !== undefined && request.routeAllowance === 0n) {
    return diagnostic(
      route,
      "InsufficientAllowance",
      QuoteBlockerEnum.AmountTooSmall,
      `routeAllowance is zero on ${ROUTE_SLUGS[route]}`,
      spendableBalance,
      0n,
    );
  }

  const flowHeadroom = snapshot.flowAvailable[route] ?? 0n;
  if (flowHeadroom <= 0n) {
    return diagnostic(
      route,
      "ZeroFlowHeadroom",
      QuoteBlockerEnum.FlowLimitExceeded,
      `router flowAvailable is zero on ${ROUTE_SLUGS[route]}`,
      spendableBalance,
      0n,
    );
  }

  let preFlowCeiling = spendableBalance;
  let limitingFactor: MaxSendLimitingFactor = "wallet_balance";

  if (request.routeAllowance !== undefined && request.routeAllowance < preFlowCeiling) {
    preFlowCeiling = request.routeAllowance;
    limitingFactor = "route_allowance";
  }

  if (MAX_QUOTE_AMOUNT < preFlowCeiling) {
    preFlowCeiling = MAX_QUOTE_AMOUNT;
    limitingFactor = "protocol_max_quote";
  }

  // Find largest `amount` in [1n, preFlowCeiling] whose floored `net <= flowHeadroom`.
  let lo = 1n;
  let hi = preFlowCeiling;
  let effectiveSpendCeiling = 0n;
  const feeBpsBig = BigInt(snapshot.feeBps);

  while (lo <= hi) {
    const mid = (lo + hi) >> 1n;
    const fee = (mid * feeBpsBig) / BPS_DENOMINATOR;
    const netRaw = mid - fee;
    const net = floorToRepresentable(netRaw, snapshot.tokenDecimals, destinationDecimals);
    if (net <= flowHeadroom) {
      effectiveSpendCeiling = mid;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }

  if (effectiveSpendCeiling === 0n) {
    return diagnostic(
      route,
      "ZeroFlowHeadroom",
      QuoteBlockerEnum.FlowLimitExceeded,
      `flowAvailable (${flowHeadroom.toString()}) cannot accommodate even 1 representable unit on ${ROUTE_SLUGS[route]}`,
      spendableBalance,
      0n,
    );
  }

  if (effectiveSpendCeiling < preFlowCeiling) {
    limitingFactor = "flow_headroom";
  }

  const ceilingQuote = planQuote(
    {
      route,
      amount: effectiveSpendCeiling,
      strkey,
      destinationDecimals,
    },
    snapshot,
  );

  if (!ceilingQuote.available || ceilingQuote.destinationAmount <= 0n) {
    const code: MaxSendDiagnosticCode =
      ceilingQuote.reason === QuoteBlockerEnum.FlowLimitExceeded
        ? "ZeroFlowHeadroom"
        : request.routeAllowance !== undefined &&
            effectiveSpendCeiling === request.routeAllowance &&
            request.routeAllowance < spendableBalance
          ? "InsufficientAllowance"
          : "DustOnlyBelowMinimum";
    return diagnostic(
      route,
      code,
      ceilingQuote.reason,
      `admissible ceiling (${effectiveSpendCeiling.toString()}) leaves zero representable destination units after fee and decimal flooring`,
      spendableBalance,
      effectiveSpendCeiling,
    );
  }

  // Tighten down to the smallest `amount` in [1n, effectiveSpendCeiling] achieving the exact same
  // `ceilingQuote.destinationAmount` so precision-boundary dust stays in the sender's wallet.
  let tLo = 1n;
  let tHi = effectiveSpendCeiling;
  let suggestedRequestAmount = effectiveSpendCeiling;
  let finalQuote = ceilingQuote;

  while (tLo <= tHi) {
    const mid = (tLo + tHi) >> 1n;
    const q = planQuote(
      {
        route,
        amount: mid,
        strkey,
        destinationDecimals,
      },
      snapshot,
    );
    if (q.available && q.destinationAmount === ceilingQuote.destinationAmount) {
      suggestedRequestAmount = mid;
      finalQuote = q;
      tHi = mid - 1n;
    } else {
      tLo = mid + 1n;
    }
  }

  const retainedPrecisionDust = effectiveSpendCeiling - finalQuote.grossAmount;
  const remainingWalletBalance = walletBalance - finalQuote.grossAmount;

  return {
    ok: true,
    available: true,
    route,
    routeSlug: ROUTE_SLUGS[route],
    suggestedRequestAmount,
    quote: finalQuote,
    spendableBalance,
    effectiveSpendCeiling,
    retainedPrecisionDust,
    remainingWalletBalance,
    limitingFactor,
  };
}

/** Compute maximum-send plans across all four rails and select the highest-output feasible rail. */
export function planMaxSendAllRails(
  request: Omit<MaxSendRequest, "route">,
  snapshot: RouterSnapshot,
): AllRailsMaxSendSummary {
  const plans = ROUTE_KINDS.map((route) => planMaxSend({ ...request, route }, snapshot));
  const feasible = plans.filter((p): p is MaxSendPlanSuccess => p.ok);
  const winningQuote = bestQuote(feasible.map((p) => p.quote));
  const recommended =
    winningQuote === null ? null : (feasible.find((p) => p.route === winningQuote.route) ?? null);

  return {
    available: recommended !== null,
    recommended,
    plans,
  };
}
