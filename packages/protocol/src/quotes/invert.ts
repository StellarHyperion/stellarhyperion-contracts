/**
 * Exact integer destination-minimum inversion for local route planning.
 *
 * Solves in O(1) closed-form arithmetic for the smallest source-asset request that delivers at
 * least `desiredDestinationMinimum` after Hyperion's outbound bps fee, cross-chain decimal
 * representability flooring, and an explicit provider forwarding budget, then verifies the result
 * through `planQuote` so forward and inverse plans never disagree.
 */
import { BPS_DENOMINATOR, MAX_DECIMALS, pow10 } from "../amounts.js";
import type { QuoteBlocker, RouteQuote, RouterSnapshot } from "../quotes.js";
import {
  MAX_QUOTE_AMOUNT,
  QuoteBlocker as QuoteBlockerEnum,
  describeBlocker,
  planQuote,
} from "../quotes.js";
import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS, ROUTE_SLUGS } from "../routes.js";

/** Explicit unit denomination for a provider forwarding/execution budget. */
export type ForwardingBudgetUnit =
  "destination_base_units" | "source_base_units" | "native_gas_units";

/** Caller-supplied forwarding-fee or relayer-deduction assumption. */
export interface ForwardingBudgetInput {
  readonly amount: bigint;
  readonly unit: ForwardingBudgetUnit;
  /** Optional asset or native gas unit label (for example `"USDC"`, `"XLM"`, `"ETH"`). */
  readonly tokenSymbol?: string;
  /** Human-readable explanation of the provider fee assumption echoed in the plan output. */
  readonly assumption: string;
}

/** Normalized provider forwarding budget echoed on every inversion output. */
export interface ResolvedForwardingBudget {
  readonly amount: bigint;
  readonly unit: ForwardingBudgetUnit;
  readonly tokenSymbol: string | null;
  readonly assumption: string;
}

/** Input parameters for `invertDestinationMinimum`. */
export interface DestinationMinimumRequest {
  readonly route: RouteKind;
  /** Minimum net tokens that must arrive in `destinationDecimals` after in-band deductions. */
  readonly desiredDestinationMinimum: bigint;
  /** Destination Stellar address (`G...`, `C...`, or `M...`) checked by `planQuote`. */
  readonly strkey: string;
  readonly destinationDecimals: number;
  /** Optional provider forwarding budget; defaults to zero destination-unit deduction. */
  readonly forwardingBudget?: ForwardingBudgetInput;
  /** Optional cap on total source-asset wallet spend. */
  readonly maxSourceSpend?: bigint;
}

export type InversionFailureCode =
  | "InvalidMinimum"
  | "InvalidForwardingBudget"
  | "InvalidDecimals"
  | "RouteBlocked"
  | "FlowLimitExceeded"
  | "ExceedsMaxQuoteAmount"
  | "ExceedsMaxSourceSpend";

/** Successful inverse quote solution verified against forward `planQuote`. */
export interface DestinationMinimumSuccess {
  readonly ok: true;
  readonly route: RouteKind;
  readonly routeSlug: string;
  /** Smallest `amount` argument to pass to `planQuote` / router `bridgeOut`. */
  readonly requiredRequestAmount: bigint;
  /** Exact source tokens debited by the router (`forwardQuote.grossAmount`). */
  readonly routerGrossSourceAmount: bigint;
  /** Total source tokens required from wallet including any `source_base_units` budget. */
  readonly totalSourceTokensRequired: bigint;
  /** Separate native gas required when `forwardingBudget.unit === "native_gas_units"`. */
  readonly separateNativeGasRequired: bigint;
  /** Verified forward `RouteQuote` at `requiredRequestAmount`. */
  readonly forwardQuote: RouteQuote;
  /** Desired minimum requested by the caller in destination base units. */
  readonly desiredDestinationMinimum: bigint;
  /** Net destination tokens remaining after subtracting any `destination_base_units` budget. */
  readonly netDestinationAfterBudget: bigint;
  /** Non-negative destination rounding excess (`netDestinationAfterBudget - desiredDestinationMinimum`). */
  readonly destinationRoundingExcess: bigint;
  /** Upper bound on unavoidable decimal-step rounding in destination base units. */
  readonly maxRoundingStepDestination: bigint;
  /** Explicit provider forwarding budget units and assumptions applied to this solution. */
  readonly forwardingBudget: ResolvedForwardingBudget;
}

/** Actionable failure returned when a destination minimum is invalid or unattainable. */
export interface DestinationMinimumFailure {
  readonly ok: false;
  readonly route: RouteKind;
  readonly routeSlug: string;
  readonly code: InversionFailureCode;
  readonly blocker: QuoteBlocker | null;
  readonly reason: string;
  readonly forwardingBudget: ResolvedForwardingBudget;
}

export type DestinationMinimumResult = DestinationMinimumSuccess | DestinationMinimumFailure;

const DEFAULT_ASSUMPTION =
  "zero in-band token forwarding fee assumed; external rail gas paid separately when applicable";

const VALID_BUDGET_UNITS: ReadonlySet<string> = new Set([
  "destination_base_units",
  "source_base_units",
  "native_gas_units",
]);

function resolveBudget(
  input: ForwardingBudgetInput | undefined,
):
  | { ok: true; budget: ResolvedForwardingBudget }
  | { ok: false; budget: ResolvedForwardingBudget; reason: string } {
  if (input === undefined) {
    return {
      ok: true,
      budget: {
        amount: 0n,
        unit: "destination_base_units",
        tokenSymbol: null,
        assumption: DEFAULT_ASSUMPTION,
      },
    };
  }
  const normalized: ResolvedForwardingBudget = {
    amount: input.amount,
    unit: input.unit,
    tokenSymbol: input.tokenSymbol ?? null,
    assumption: input.assumption.trim(),
  };
  if (input.amount < 0n) {
    return {
      ok: false,
      budget: normalized,
      reason: `forwardingBudget.amount must be non-negative, got ${input.amount.toString()}`,
    };
  }
  if (!VALID_BUDGET_UNITS.has(input.unit)) {
    return {
      ok: false,
      budget: normalized,
      reason:
        "forwardingBudget.unit must be destination_base_units, source_base_units, or native_gas_units",
    };
  }
  if (normalized.assumption.length === 0) {
    return {
      ok: false,
      budget: normalized,
      reason: "forwardingBudget.assumption must be a non-empty explanation string",
    };
  }
  return { ok: true, budget: normalized };
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

/**
 * Solve for the exact minimum source request required to deliver `desiredDestinationMinimum` on a
 * single rail under explicit protocol fee and provider forwarding-budget assumptions.
 */
export function invertDestinationMinimum(
  request: DestinationMinimumRequest,
  snapshot: RouterSnapshot,
): DestinationMinimumResult {
  const { route, desiredDestinationMinimum, strkey, destinationDecimals } = request;
  const routeSlug = ROUTE_SLUGS[route];
  const budgetCheck = resolveBudget(request.forwardingBudget);
  const forwardingBudget = budgetCheck.budget;

  if (!budgetCheck.ok) {
    return {
      ok: false,
      route,
      routeSlug,
      code: "InvalidForwardingBudget",
      blocker: null,
      reason: budgetCheck.reason,
      forwardingBudget,
    };
  }

  if (desiredDestinationMinimum <= 0n) {
    return {
      ok: false,
      route,
      routeSlug,
      code: "InvalidMinimum",
      blocker: QuoteBlockerEnum.AmountTooSmall,
      reason: `desiredDestinationMinimum must be greater than zero, got ${desiredDestinationMinimum.toString()}`,
      forwardingBudget,
    };
  }

  if (request.maxSourceSpend !== undefined && request.maxSourceSpend <= 0n) {
    return {
      ok: false,
      route,
      routeSlug,
      code: "ExceedsMaxSourceSpend",
      blocker: null,
      reason: `maxSourceSpend must be positive when supplied, got ${request.maxSourceSpend.toString()}`,
      forwardingBudget,
    };
  }

  if (
    !Number.isInteger(snapshot.tokenDecimals) ||
    snapshot.tokenDecimals < 0 ||
    snapshot.tokenDecimals > MAX_DECIMALS ||
    !Number.isInteger(destinationDecimals) ||
    destinationDecimals < 0 ||
    destinationDecimals > MAX_DECIMALS
  ) {
    return {
      ok: false,
      route,
      routeSlug,
      code: "InvalidDecimals",
      blocker: QuoteBlockerEnum.NotRepresentable,
      reason: `tokenDecimals (${String(snapshot.tokenDecimals)}) and destinationDecimals (${String(destinationDecimals)}) must be integers in 0..${String(MAX_DECIMALS)}`,
      forwardingBudget,
    };
  }

  if (!Number.isInteger(snapshot.feeBps) || snapshot.feeBps < 0 || snapshot.feeBps >= 10_000) {
    return {
      ok: false,
      route,
      routeSlug,
      code: "RouteBlocked",
      blocker: QuoteBlockerEnum.RouteDisabled,
      reason: `invalid snapshot feeBps ${String(snapshot.feeBps)}`,
      forwardingBudget,
    };
  }

  const staticProbe = planQuote({ route, amount: 1n, strkey, destinationDecimals }, snapshot);
  if (isStaticBlocker(staticProbe.reason)) {
    return {
      ok: false,
      route,
      routeSlug,
      code: "RouteBlocked",
      blocker: staticProbe.reason,
      reason: describeBlocker(staticProbe.reason).detail,
      forwardingBudget,
    };
  }

  const targetRouterDestination =
    forwardingBudget.unit === "destination_base_units"
      ? desiredDestinationMinimum + forwardingBudget.amount
      : desiredDestinationMinimum;

  const fromDec = snapshot.tokenDecimals;
  const toDec = destinationDecimals;

  let requiredNetSource: bigint;
  let maxRoundingStepDestination: bigint;

  if (fromDec >= toDec) {
    const downScale = pow10(fromDec - toDec);
    requiredNetSource = targetRouterDestination * downScale;
    maxRoundingStepDestination = 1n;
  } else {
    const upScale = pow10(toDec - fromDec);
    requiredNetSource = (targetRouterDestination + upScale - 1n) / upScale;
    maxRoundingStepDestination = upScale;
  }

  if (requiredNetSource > MAX_QUOTE_AMOUNT) {
    return {
      ok: false,
      route,
      routeSlug,
      code: "ExceedsMaxQuoteAmount",
      blocker: QuoteBlockerEnum.NotRepresentable,
      reason: `required bridged net amount (${requiredNetSource.toString()}) exceeds MAX_QUOTE_AMOUNT (${MAX_QUOTE_AMOUNT.toString()})`,
      forwardingBudget,
    };
  }

  const flowHeadroom = snapshot.flowAvailable[route] ?? 0n;
  if (requiredNetSource > flowHeadroom) {
    return {
      ok: false,
      route,
      routeSlug,
      code: "FlowLimitExceeded",
      blocker: QuoteBlockerEnum.FlowLimitExceeded,
      reason: `required bridged net amount (${requiredNetSource.toString()}) exceeds available flow headroom (${flowHeadroom.toString()}) on ${routeSlug}`,
      forwardingBudget,
    };
  }

  // Solve smallest `amount` such that `amount - floor(amount * feeBps / 10_000) >= requiredNetSource`.
  // Since `amount - floor(amount * feeBps / 10_000) = ceil(amount * keepBps / 10_000)`,
  // the exact integer solution is `ceil(((requiredNetSource - 1) * 10_000 + 1) / keepBps)`.
  const keepBps = BPS_DENOMINATOR - BigInt(snapshot.feeBps);
  const numerator = (requiredNetSource - 1n) * BPS_DENOMINATOR + 1n;
  const requiredRequestAmount = (numerator + keepBps - 1n) / keepBps;

  if (requiredRequestAmount > MAX_QUOTE_AMOUNT) {
    return {
      ok: false,
      route,
      routeSlug,
      code: "ExceedsMaxQuoteAmount",
      blocker: QuoteBlockerEnum.NotRepresentable,
      reason: `required gross request (${requiredRequestAmount.toString()}) exceeds MAX_QUOTE_AMOUNT (${MAX_QUOTE_AMOUNT.toString()}) once ${String(snapshot.feeBps)} bps fee is included`,
      forwardingBudget,
    };
  }

  const forwardQuote = planQuote(
    {
      route,
      amount: requiredRequestAmount,
      strkey,
      destinationDecimals,
    },
    snapshot,
  );

  if (!forwardQuote.available || forwardQuote.destinationAmount < targetRouterDestination) {
    return {
      ok: false,
      route,
      routeSlug,
      code:
        forwardQuote.reason === QuoteBlockerEnum.FlowLimitExceeded
          ? "FlowLimitExceeded"
          : "RouteBlocked",
      blocker: forwardQuote.reason,
      reason: describeBlocker(forwardQuote.reason).detail,
      forwardingBudget,
    };
  }

  const sourceExtra = forwardingBudget.unit === "source_base_units" ? forwardingBudget.amount : 0n;
  const totalSourceTokensRequired = forwardQuote.grossAmount + sourceExtra;
  const separateNativeGasRequired =
    forwardingBudget.unit === "native_gas_units" ? forwardingBudget.amount : 0n;

  if (request.maxSourceSpend !== undefined && totalSourceTokensRequired > request.maxSourceSpend) {
    return {
      ok: false,
      route,
      routeSlug,
      code: "ExceedsMaxSourceSpend",
      blocker: null,
      reason: `total required source spend (${totalSourceTokensRequired.toString()}) exceeds maxSourceSpend (${request.maxSourceSpend.toString()})`,
      forwardingBudget,
    };
  }

  const destDeducted =
    forwardingBudget.unit === "destination_base_units" ? forwardingBudget.amount : 0n;
  const netDestinationAfterBudget = forwardQuote.destinationAmount - destDeducted;
  const destinationRoundingExcess = netDestinationAfterBudget - desiredDestinationMinimum;

  return {
    ok: true,
    route,
    routeSlug,
    requiredRequestAmount,
    routerGrossSourceAmount: forwardQuote.grossAmount,
    totalSourceTokensRequired,
    separateNativeGasRequired,
    forwardQuote,
    desiredDestinationMinimum,
    netDestinationAfterBudget,
    destinationRoundingExcess,
    maxRoundingStepDestination,
    forwardingBudget,
  };
}

/** Solve destination-minimum inversion across all four rails in canonical `RouteKind` order. */
export function invertAllRoutesDestinationMinimum(
  request: Omit<DestinationMinimumRequest, "route">,
  snapshot: RouterSnapshot,
): readonly DestinationMinimumResult[] {
  return ROUTE_KINDS.map((route) => invertDestinationMinimum({ ...request, route }, snapshot));
}
