/**
 * Multi-snapshot route comparison across explicitly dated candidate observations.
 *
 * Aggregators, monitoring jobs, and UI quote drawers frequently hold snapshots collected from
 * multiple RPC polls or provider indexers at different instants. Comparing them safely requires
 * three invariants:
 * 1. Mixed networks (`mainnet` vs `testnet`) or distinct token representations (such as 6-decimal
 *    Circle native USDC vs 7-decimal Axelar ITS Stellar-USDC) are never ranked as equivalent
 *    destination amounts.
 * 2. Freshness policy separates stale or clock-skewed observations (`status: "stale"`) from fresh
 *    observations whose router/rail rejected the transfer (`status: "unavailable"`).
 * 3. Eligible equivalent candidates sort deterministically regardless of input arrival order.
 */
import type { ChainKey, NetworkMode } from "../chains.js";
import { CHAINS, isChainKey } from "../chains.js";
import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS } from "../routes.js";
import { QuoteBlocker, planQuote } from "../quotes.js";
import type { RouteQuote, RouterSnapshot } from "../quotes.js";

export type SnapshotTokenRepresentation =
  "classic_sac" | "native_erc20" | "axelar_its" | "wrapped_pool";

/** Explicit token identity bound to a snapshot endpoint so representations never silently mix. */
export interface SnapshotTokenDescriptor {
  readonly chain: ChainKey;
  readonly symbol: string;
  readonly decimals: number;
  readonly representation: SnapshotTokenRepresentation;
  /** Classic Stellar G-account issuer or EVM 0x-prefixed ERC-20 address. */
  readonly issuerOrAddress: string;
}

export interface SnapshotFreshnessPolicy {
  /** ISO-8601 evaluation clock used as the deterministic freshness anchor. */
  readonly referenceTime: string;
  /** Maximum permissible age (`referenceMs - observedAtMs`) in milliseconds. */
  readonly maxAgeMs: number;
  /** Maximum permissible forward clock skew (`observedAtMs - referenceMs`) in ms; defaults to 0. */
  readonly maxFutureSkewMs?: number;
}

export interface SnapshotComparisonTarget {
  readonly network: NetworkMode;
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly amount: bigint;
  readonly strkey: string;
  readonly sourceToken: SnapshotTokenDescriptor;
  readonly destinationToken: SnapshotTokenDescriptor;
  readonly freshnessPolicy: SnapshotFreshnessPolicy;
}

export interface DatedRouteSnapshotCandidate {
  readonly id: string;
  /** ISO-8601 timestamp when `snapshot` was sampled. */
  readonly observedAt: string;
  readonly route: RouteKind;
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly sourceToken: SnapshotTokenDescriptor;
  readonly destinationToken: SnapshotTokenDescriptor;
  readonly snapshot: RouterSnapshot;
}

export type SnapshotComparisonStatus = "eligible" | "unavailable" | "stale" | "incompatible";

export type SnapshotIncompatibilityReason =
  | "network_mismatch"
  | "chain_mismatch"
  | "invalid_route"
  | "source_token_mismatch"
  | "destination_token_mismatch"
  | "snapshot_decimals_mismatch";

export type SnapshotStaleReason = "invalid_timestamp" | "expired_snapshot" | "future_clock_skew";

export interface EvaluatedRouteSnapshot {
  readonly id: string;
  readonly route: RouteKind;
  readonly observedAt: string;
  readonly observedAtMs: number | null;
  readonly ageMs: number | null;
  readonly status: SnapshotComparisonStatus;
  readonly incompatibilityReason: SnapshotIncompatibilityReason | null;
  readonly staleReason: SnapshotStaleReason | null;
  readonly blocker: QuoteBlocker | null;
  readonly quote: RouteQuote | null;
}

export interface MultiSnapshotComparisonResult {
  readonly referenceTime: string;
  readonly referenceTimeMs: number;
  readonly winner: EvaluatedRouteSnapshot | null;
  readonly rankedEligible: readonly EvaluatedRouteSnapshot[];
  readonly unavailable: readonly EvaluatedRouteSnapshot[];
  readonly stale: readonly EvaluatedRouteSnapshot[];
  readonly incompatible: readonly EvaluatedRouteSnapshot[];
  readonly evaluations: readonly EvaluatedRouteSnapshot[];
}

function normalizeTokenKey(token: SnapshotTokenDescriptor): string {
  const normalizedAddr = token.issuerOrAddress.startsWith("0x")
    ? token.issuerOrAddress.toLowerCase()
    : token.issuerOrAddress;
  return `${token.chain}|${token.representation}|${normalizedAddr}|${token.symbol}|${String(token.decimals)}`;
}

function validateTarget(target: SnapshotComparisonTarget): number {
  if (!isChainKey(target.originChain) || !isChainKey(target.destinationChain)) {
    throw new RangeError(
      "SnapshotComparisonTarget requires known originChain and destinationChain",
    );
  }
  if (target.originChain === target.destinationChain) {
    throw new RangeError("SnapshotComparisonTarget originChain and destinationChain must differ");
  }
  const srcNet = CHAINS[target.originChain].network;
  const dstNet = CHAINS[target.destinationChain].network;
  if (srcNet !== target.network || dstNet !== target.network) {
    throw new RangeError(
      `SnapshotComparisonTarget network "${target.network}" disagrees with endpoint chains (${srcNet} -> ${dstNet})`,
    );
  }
  if (
    target.sourceToken.chain !== target.originChain ||
    target.destinationToken.chain !== target.destinationChain
  ) {
    throw new RangeError("SnapshotComparisonTarget token chains must match origin and destination");
  }
  const refMs = Date.parse(target.freshnessPolicy.referenceTime);
  if (Number.isNaN(refMs)) {
    throw new RangeError("freshnessPolicy.referenceTime must be a valid ISO-8601 timestamp");
  }
  if (!Number.isFinite(target.freshnessPolicy.maxAgeMs) || target.freshnessPolicy.maxAgeMs < 0) {
    throw new RangeError("freshnessPolicy.maxAgeMs must be a non-negative finite number");
  }
  const maxFuture = target.freshnessPolicy.maxFutureSkewMs ?? 0;
  if (!Number.isFinite(maxFuture) || maxFuture < 0) {
    throw new RangeError("freshnessPolicy.maxFutureSkewMs must be a non-negative finite number");
  }
  return refMs;
}

function checkCompatibility(
  candidate: DatedRouteSnapshotCandidate,
  target: SnapshotComparisonTarget,
  targetSourceKey: string,
  targetDestKey: string,
): SnapshotIncompatibilityReason | null {
  if (!isChainKey(candidate.originChain) || !isChainKey(candidate.destinationChain)) {
    return "chain_mismatch";
  }
  if (
    CHAINS[candidate.originChain].network !== target.network ||
    CHAINS[candidate.destinationChain].network !== target.network
  ) {
    return "network_mismatch";
  }
  if (
    candidate.originChain !== target.originChain ||
    candidate.destinationChain !== target.destinationChain
  ) {
    return "chain_mismatch";
  }
  if (!ROUTE_KINDS.includes(candidate.route)) {
    return "invalid_route";
  }
  if (normalizeTokenKey(candidate.sourceToken) !== targetSourceKey) {
    return "source_token_mismatch";
  }
  if (normalizeTokenKey(candidate.destinationToken) !== targetDestKey) {
    return "destination_token_mismatch";
  }
  if (candidate.snapshot.tokenDecimals !== target.sourceToken.decimals) {
    return "snapshot_decimals_mismatch";
  }
  return null;
}

function compareEligibleSnapshots(a: EvaluatedRouteSnapshot, b: EvaluatedRouteSnapshot): number {
  const qa = a.quote;
  const qb = b.quote;
  if (qa !== null && qb !== null) {
    if (qa.destinationAmount !== qb.destinationAmount) {
      return qa.destinationAmount > qb.destinationAmount ? -1 : 1;
    }
    if (qa.isCanonical !== qb.isCanonical) {
      return qa.isCanonical ? -1 : 1;
    }
    if (qa.waitsOnAttestation !== qb.waitsOnAttestation) {
      return qa.waitsOnAttestation ? 1 : -1;
    }
  }
  const ta = a.observedAtMs ?? 0;
  const tb = b.observedAtMs ?? 0;
  if (ta !== tb) {
    return tb - ta;
  }
  if (a.route !== b.route) {
    return a.route - b.route;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Compare candidate route snapshots against a canonical transfer target and freshness policy.
 */
export function compareRouteSnapshots(
  target: SnapshotComparisonTarget,
  candidates: readonly DatedRouteSnapshotCandidate[],
): MultiSnapshotComparisonResult {
  const referenceTimeMs = validateTarget(target);
  const maxAgeMs = target.freshnessPolicy.maxAgeMs;
  const maxFutureSkewMs = target.freshnessPolicy.maxFutureSkewMs ?? 0;
  const targetSourceKey = normalizeTokenKey(target.sourceToken);
  const targetDestKey = normalizeTokenKey(target.destinationToken);

  const evaluations: EvaluatedRouteSnapshot[] = [];
  const eligible: EvaluatedRouteSnapshot[] = [];
  const unavailable: EvaluatedRouteSnapshot[] = [];
  const stale: EvaluatedRouteSnapshot[] = [];
  const incompatible: EvaluatedRouteSnapshot[] = [];

  for (const candidate of candidates) {
    const incompatibility = checkCompatibility(candidate, target, targetSourceKey, targetDestKey);
    if (incompatibility !== null) {
      const record: EvaluatedRouteSnapshot = {
        id: candidate.id,
        route: candidate.route,
        observedAt: candidate.observedAt,
        observedAtMs: null,
        ageMs: null,
        status: "incompatible",
        incompatibilityReason: incompatibility,
        staleReason: null,
        blocker: null,
        quote: null,
      };
      evaluations.push(record);
      incompatible.push(record);
      continue;
    }

    const observedAtMs = Date.parse(candidate.observedAt);
    if (Number.isNaN(observedAtMs)) {
      const record: EvaluatedRouteSnapshot = {
        id: candidate.id,
        route: candidate.route,
        observedAt: candidate.observedAt,
        observedAtMs: null,
        ageMs: null,
        status: "stale",
        incompatibilityReason: null,
        staleReason: "invalid_timestamp",
        blocker: null,
        quote: null,
      };
      evaluations.push(record);
      stale.push(record);
      continue;
    }

    const ageMs = referenceTimeMs - observedAtMs;
    if (ageMs > maxAgeMs) {
      const record: EvaluatedRouteSnapshot = {
        id: candidate.id,
        route: candidate.route,
        observedAt: candidate.observedAt,
        observedAtMs,
        ageMs,
        status: "stale",
        incompatibilityReason: null,
        staleReason: "expired_snapshot",
        blocker: null,
        quote: null,
      };
      evaluations.push(record);
      stale.push(record);
      continue;
    }
    if (ageMs < -maxFutureSkewMs) {
      const record: EvaluatedRouteSnapshot = {
        id: candidate.id,
        route: candidate.route,
        observedAt: candidate.observedAt,
        observedAtMs,
        ageMs,
        status: "stale",
        incompatibilityReason: null,
        staleReason: "future_clock_skew",
        blocker: null,
        quote: null,
      };
      evaluations.push(record);
      stale.push(record);
      continue;
    }

    const quote = planQuote(
      {
        route: candidate.route,
        amount: target.amount,
        strkey: target.strkey,
        destinationDecimals: target.destinationToken.decimals,
      },
      candidate.snapshot,
    );

    if (!quote.available) {
      const record: EvaluatedRouteSnapshot = {
        id: candidate.id,
        route: candidate.route,
        observedAt: candidate.observedAt,
        observedAtMs,
        ageMs,
        status: "unavailable",
        incompatibilityReason: null,
        staleReason: null,
        blocker: quote.reason === QuoteBlocker.None ? QuoteBlocker.Paused : quote.reason,
        quote,
      };
      evaluations.push(record);
      unavailable.push(record);
      continue;
    }

    const record: EvaluatedRouteSnapshot = {
      id: candidate.id,
      route: candidate.route,
      observedAt: candidate.observedAt,
      observedAtMs,
      ageMs,
      status: "eligible",
      incompatibilityReason: null,
      staleReason: null,
      blocker: QuoteBlocker.None,
      quote,
    };
    evaluations.push(record);
    eligible.push(record);
  }

  const rankedEligible = [...eligible].sort(compareEligibleSnapshots);

  return {
    referenceTime: target.freshnessPolicy.referenceTime,
    referenceTimeMs,
    winner: rankedEligible[0] ?? null,
    rankedEligible: Object.freeze(rankedEligible),
    unavailable: Object.freeze(unavailable),
    stale: Object.freeze(stale),
    incompatible: Object.freeze(incompatible),
    evaluations: Object.freeze(evaluations),
  };
}
