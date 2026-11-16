/**
 * Deterministic bounded quote search across user spending constraints, destination minima, fee
 * budgets, and explicit route capability gates.
 *
 * Runs purely in memory against an immutable `RouterSnapshot` using exact `bigint` binary search,
 * terminating in O(log2(range)) evaluations even across full `uint128` / `uint256` bounds and
 * explaining why every excluded rail failed.
 */
import { BPS_DENOMINATOR, floorToRepresentable } from "../amounts.js";
import type { QuoteBlocker, RouteQuote, RouterSnapshot } from "../quotes.js";
import {
  MAX_QUOTE_AMOUNT,
  QuoteBlocker as QuoteBlockerEnum,
  bestQuote,
  planQuote,
} from "../quotes.js";
import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS, ROUTE_SLUGS, isCanonical, waitsOnAttestation } from "../routes.js";

/** Explicit per-route capability gate supplied to `searchBoundedQuotes`. */
export interface RouteCapabilityConstraint {
  readonly enabled: boolean;
  readonly paidDispatchSupported?: boolean;
  readonly maxSourceAmount?: bigint;
  readonly note?: string;
}

export type RouteCapabilityInput = boolean | RouteCapabilityConstraint;

/**Constraints governing a bounded local quote search. */
export interface QuoteSearchConstraints {
  /** Destination Stellar address (`G...`, `C...`, or `M...`) evaluated by `planQuote`. */
  readonly strkey: string;
  /** Token decimal precision on the destination chain. */
  readonly destinationDecimals: number;
  /** Minimum wallet spend in source base units (defaults to `1n`). */
  readonly minSourceAmount?: bigint;
  /** Maximum wallet spend in source base units (clamped to `MAX_QUOTE_AMOUNT`). */
  readonly maxSourceAmount: bigint;
  /** Minimum acceptable arriving amount in destination base units (defaults to `1n`). */
  readonly minDestinationAmount?: bigint;
  /** Optional ceiling on protocol fee in source base units. */
  readonly maxFeeAmount?: bigint;
  /** Explicit per-route capability overrides; omitted rails default to `strictCapabilities ? false : true`. */
  readonly routeCapabilities?: Partial<Record<RouteKind, RouteCapabilityInput>>;
  /** When true, any rail omitted from `routeCapabilities` is excluded as unvalidated. */
  readonly strictCapabilities?: boolean;
  /** Require `paidDispatchSupported: true` on the route capability entry. */
  readonly requirePaidDispatch?: boolean;
  /** Require canonical mint/burn or lock/mint rails (`isCanonical(route) === true`). */
  readonly requireCanonicalAsset?: boolean;
  /** Exclude rails that wait on asynchronous validator/Circle attestations. */
  readonly disallowAttestationWait?: boolean;
}

export type RouteExclusionCode =
  | "capability_disabled"
  | "paid_dispatch_unsupported"
  | "non_canonical_asset"
  | "waits_on_attestation"
  | "router_blocked"
  | "exceeds_capability_limit"
  | "exceeds_flow_headroom"
  | "below_minimum_source"
  | "below_minimum_destination"
  | "fee_exceeds_budget";

/** Structured explanation for why a candidate rail failed the search constraints. */
export interface ExcludedRouteExplanation {
  readonly route: RouteKind;
  readonly routeSlug: string;
  readonly code: RouteExclusionCode;
  readonly blocker: QuoteBlocker | null;
  readonly detail: string;
}

/** Feasible spend interval and boundary quotes for an admissible rail. */
export interface FeasibleRouteSearchMatch {
  readonly route: RouteKind;
  readonly routeSlug: string;
  /** Quote minimizing required source spend while meeting `minSourceAmount` and `minDestinationAmount`. */
  readonly minimumSpendQuote: RouteQuote;
  /** Quote maximizing `destinationAmount` within `maxSourceAmount`, `maxFeeAmount`, and flow headroom. */
  readonly maximumOutputQuote: RouteQuote;
  readonly minRequestAmount: bigint;
  readonly maxRequestAmount: bigint;
}

/** Complete deterministic search result across all four Hyperion rails. */
export interface BoundedQuoteSearchResult {
  readonly feasible: boolean;
  /** Recommended quote maximizing destination output (with standard Hyperion tie-breaking). */
  readonly recommendedMaxOutput: RouteQuote | null;
  /** Recommended quote minimizing source spend among feasible rails. */
  readonly recommendedMinSpend: RouteQuote | null;
  readonly matches: readonly FeasibleRouteSearchMatch[];
  readonly excludedRoutes: readonly ExcludedRouteExplanation[];
  /** Total local `planQuote` calls executed during the search. */
  readonly evaluationCount: number;
}

function normalizeCapability(
  input: RouteCapabilityInput | undefined,
  strict: boolean,
): RouteCapabilityConstraint {
  if (input === undefined) {
    return { enabled: !strict };
  }
  if (typeof input === "boolean") {
    return { enabled: input };
  }
  return input;
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

function maxAdmissibleRequestForFlow(
  route: RouteKind,
  snapshot: RouterSnapshot,
  destinationDecimals: number,
  hardCeiling: bigint,
): bigint {
  if (hardCeiling <= 0n) return 0n;
  const headroom = snapshot.flowAvailable[route] ?? 0n;
  if (headroom <= 0n) return 0n;

  // Binary search largest `amount` in [1n, hardCeiling] where floored net <= headroom.
  let lo = 1n;
  let hi = hardCeiling;
  let best = 0n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1n;
    const fee = (mid * BigInt(snapshot.feeBps)) / BPS_DENOMINATOR;
    const netRaw = mid - fee;
    const net =
      snapshot.tokenDecimals <= 38 && destinationDecimals <= 38
        ? floorToRepresentable(netRaw, snapshot.tokenDecimals, destinationDecimals)
        : 0n;
    if (net <= headroom) {
      best = mid;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }
  return best;
}

function validateConstraints(constraints: QuoteSearchConstraints): {
  minSource: bigint;
  maxSource: bigint;
  minDest: bigint;
} {
  const minSource = constraints.minSourceAmount ?? 1n;
  const maxSource = constraints.maxSourceAmount;
  const minDest = constraints.minDestinationAmount ?? 1n;

  if (minSource < 0n) {
    throw new RangeError("minSourceAmount cannot be negative");
  }
  if (maxSource < 0n) {
    throw new RangeError("maxSourceAmount cannot be negative");
  }
  if (minSource > maxSource) {
    throw new RangeError(
      `minSourceAmount (${minSource.toString()}) exceeds maxSourceAmount (${maxSource.toString()})`,
    );
  }
  if (minDest < 0n) {
    throw new RangeError("minDestinationAmount cannot be negative");
  }
  if (constraints.maxFeeAmount !== undefined && constraints.maxFeeAmount < 0n) {
    throw new RangeError("maxFeeAmount cannot be negative");
  }

  return {
    minSource: minSource === 0n ? 1n : minSource,
    maxSource,
    minDest: minDest === 0n ? 1n : minDest,
  };
}

/**
 * Deterministically search across user spend bounds, destination minima, fee caps, and explicit
 * route capabilities without performing network I/O or mutating `snapshot`.
 */
export function searchBoundedQuotes(
  constraints: QuoteSearchConstraints,
  snapshot: RouterSnapshot,
): BoundedQuoteSearchResult {
  const { minSource, maxSource, minDest } = validateConstraints(constraints);
  const strict = constraints.strictCapabilities === true;

  let evaluationCount = 0;
  const quoteAt = (route: RouteKind, amount: bigint): RouteQuote => {
    evaluationCount += 1;
    return planQuote(
      {
        route,
        amount,
        strkey: constraints.strkey,
        destinationDecimals: constraints.destinationDecimals,
      },
      snapshot,
    );
  };

  const matches: FeasibleRouteSearchMatch[] = [];
  const excludedRoutes: ExcludedRouteExplanation[] = [];

  for (const route of ROUTE_KINDS) {
    const slug = ROUTE_SLUGS[route];
    const cap = normalizeCapability(constraints.routeCapabilities?.[route], strict);

    if (!cap.enabled) {
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: "capability_disabled",
        blocker: null,
        detail:
          cap.note ??
          `route "${slug}" is disabled or gated by explicit route capability configuration`,
      });
      continue;
    }

    if (constraints.requirePaidDispatch === true && cap.paidDispatchSupported !== true) {
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: "paid_dispatch_unsupported",
        blocker: null,
        detail: `route "${slug}" does not declare paidDispatchSupported for this lane`,
      });
      continue;
    }

    if (constraints.requireCanonicalAsset === true && !isCanonical(route)) {
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: "non_canonical_asset",
        blocker: null,
        detail: `route "${slug}" transfers pooled or non-canonical representations`,
      });
      continue;
    }

    if (constraints.disallowAttestationWait === true && waitsOnAttestation(route)) {
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: "waits_on_attestation",
        blocker: null,
        detail: `route "${slug}" waits on external attestation finality`,
      });
      continue;
    }

    if (cap.maxSourceAmount !== undefined && minSource > cap.maxSourceAmount) {
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: "exceeds_capability_limit",
        blocker: null,
        detail: `minSourceAmount (${minSource.toString()}) exceeds capability maxSourceAmount (${cap.maxSourceAmount.toString()}) on "${slug}"`,
      });
      continue;
    }

    const effectiveCeiling = [
      maxSource,
      MAX_QUOTE_AMOUNT,
      ...(cap.maxSourceAmount === undefined ? [] : [cap.maxSourceAmount]),
    ].reduce((a, b) => (a < b ? a : b));

    if (effectiveCeiling <= 0n || minSource > effectiveCeiling) {
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: "below_minimum_source",
        blocker: QuoteBlockerEnum.NotRepresentable,
        detail: `effective spend ceiling (${effectiveCeiling.toString()}) cannot satisfy minSourceAmount (${minSource.toString()}) on "${slug}"`,
      });
      continue;
    }

    // Probe static route blockers once at `minSource`.
    const initialProbe = quoteAt(route, minSource);
    if (isStaticBlocker(initialProbe.reason)) {
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: "router_blocked",
        blocker: initialProbe.reason,
        detail:
          `router snapshot blocked "${slug}" withQuoteBlocker=${String(initialProbe.reason)}`.replace(
            "withQuoteBlocker=",
            "with QuoteBlocker=",
          ),
      });
      continue;
    }

    if (
      snapshot.tokenDecimals > 38 ||
      snapshot.tokenDecimals < 0 ||
      constraints.destinationDecimals > 38 ||
      constraints.destinationDecimals < 0
    ) {
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: "router_blocked",
        blocker: QuoteBlockerEnum.NotRepresentable,
        detail: `token or destination decimal precision exceeds protocol ceiling on "${slug}"`,
      });
      continue;
    }

    const flowCeiling = maxAdmissibleRequestForFlow(
      route,
      snapshot,
      constraints.destinationDecimals,
      effectiveCeiling,
    );

    if (flowCeiling < minSource) {
      const probe = quoteAt(route, minSource);
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: "exceeds_flow_headroom",
        blocker:
          probe.reason === QuoteBlockerEnum.None
            ? QuoteBlockerEnum.FlowLimitExceeded
            : probe.reason,
        detail: `available flow headroom (${(snapshot.flowAvailable[route] ?? 0n).toString()}) on "${slug}" cannot carry minSourceAmount (${minSource.toString()})`,
      });
      continue;
    }

    // Check highest output achievable within [minSource, flowCeiling] (and fee cap if present).
    let upperSearchHi = flowCeiling;
    if (constraints.maxFeeAmount !== undefined) {
      let fLo = minSource;
      let fHi = flowCeiling;
      let fBest = 0n;
      while (fLo <= fHi) {
        const mid = (fLo + fHi) >> 1n;
        const fee = (mid * BigInt(snapshot.feeBps)) / BPS_DENOMINATOR;
        if (fee <= constraints.maxFeeAmount) {
          fBest = mid;
          fLo = mid + 1n;
        } else {
          fHi = mid - 1n;
        }
      }
      if (fBest < minSource) {
        excludedRoutes.push({
          route,
          routeSlug: slug,
          code: "fee_exceeds_budget",
          blocker: null,
          detail: `protocol fee at minSourceAmount exceeds maxFeeAmount (${constraints.maxFeeAmount.toString()}) on "${slug}"`,
        });
        continue;
      }
      upperSearchHi = fBest;
    }

    const upperProbe = quoteAt(route, upperSearchHi);
    if (!upperProbe.available) {
      const code: RouteExclusionCode =
        upperProbe.reason === QuoteBlockerEnum.FlowLimitExceeded
          ? "exceeds_flow_headroom"
          : "below_minimum_source";
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code,
        blocker: upperProbe.reason,
        detail: `no representable transfer available within spend bounds on "${slug}"`,
      });
      continue;
    }

    if (upperProbe.grossAmount < minSource) {
      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: "below_minimum_source",
        blocker: null,
        detail: `maximum representable gross spend (${upperProbe.grossAmount.toString()}) is below minSourceAmount (${minSource.toString()}) on "${slug}"`,
      });
      continue;
    }

    if (upperProbe.destinationAmount < minDest) {
      const hitFee = constraints.maxFeeAmount !== undefined && upperSearchHi < flowCeiling;
      const hitFlow = !hitFee && flowCeiling < effectiveCeiling;
      const hitCapLimit =
        !hitFee && !hitFlow && cap.maxSourceAmount !== undefined && cap.maxSourceAmount < maxSource;

      excludedRoutes.push({
        route,
        routeSlug: slug,
        code: hitFee
          ? "fee_exceeds_budget"
          : hitFlow
            ? "exceeds_flow_headroom"
            : hitCapLimit
              ? "exceeds_capability_limit"
              : "below_minimum_destination",
        blocker: hitFlow ? QuoteBlockerEnum.FlowLimitExceeded : null,
        detail: `maximum deliverable output (${upperProbe.destinationAmount.toString()}) is below minDestinationAmount (${minDest.toString()}) on "${slug}"`,
      });
      continue;
    }

    // Binary search minimum request in [minSource, upperSearchHi] satisfying available && gross >= minSource && dest >= minDest.
    let lo = minSource;
    let hi = upperSearchHi;
    let minFeasibleReq = upperSearchHi;
    let minFeasibleQuote = upperProbe;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1n;
      const q = quoteAt(route, mid);
      if (q.available && q.grossAmount >= minSource && q.destinationAmount >= minDest) {
        minFeasibleReq = mid;
        minFeasibleQuote = q;
        hi = mid - 1n;
      } else {
        lo = mid + 1n;
      }
    }

    // Tighten upper request to the smallest request producing `upperProbe.destinationAmount` while keeping gross >= minSource, avoiding unrepresentable excess dust.
    let tLo = minFeasibleReq;
    let tHi = upperSearchHi;
    let maxFeasibleReq = upperSearchHi;
    let maxFeasibleQuote = upperProbe;

    while (tLo <= tHi) {
      const mid = (tLo + tHi) >> 1n;
      const q = quoteAt(route, mid);
      if (
        q.available &&
        q.grossAmount >= minSource &&
        q.destinationAmount === upperProbe.destinationAmount
      ) {
        maxFeasibleReq = mid;
        maxFeasibleQuote = q;
        tHi = mid - 1n;
      } else {
        tLo = mid + 1n;
      }
    }

    matches.push({
      route,
      routeSlug: slug,
      minimumSpendQuote: minFeasibleQuote,
      maximumOutputQuote: maxFeasibleQuote,
      minRequestAmount: minFeasibleReq,
      maxRequestAmount: maxFeasibleReq,
    });
  }

  const recommendedMaxOutput = bestQuote(matches.map((m) => m.maximumOutputQuote));

  let recommendedMinSpend: RouteQuote | null = null;
  for (const match of matches) {
    const candidate = match.minimumSpendQuote;
    if (recommendedMinSpend === null) {
      recommendedMinSpend = candidate;
      continue;
    }
    if (candidate.grossAmount !== recommendedMinSpend.grossAmount) {
      if (candidate.grossAmount < recommendedMinSpend.grossAmount) {
        recommendedMinSpend = candidate;
      }
      continue;
    }
    const tieWinner = bestQuote([recommendedMinSpend, candidate]);
    if (tieWinner !== null) recommendedMinSpend = tieWinner;
  }

  return {
    feasible: matches.length > 0,
    recommendedMaxOutput,
    recommendedMinSpend,
    matches,
    excludedRoutes,
    evaluationCount,
  };
}
