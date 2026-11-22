/**
 * A machine-readable derivation of a local quote.
 *
 * `planQuote` answers "what would this rail do with this amount". This answers "why". It walks
 * the same ladder in the same order, records every check with the policy or capability that owns
 * it, and records every derivation (fee, the net before precision, the precision floor and the
 * dust it leaves, flow headroom, the gross debit and the destination amount) with its formula,
 * its exact integer inputs and its value.
 *
 * Three guarantees:
 *
 * - **Exact.** Every derivation is recomputed here with `bigint` arithmetic. `explainQuote` then
 *   compares the result with `planQuote` and throws if any field differs, so an explanation can
 *   never describe a different quote from the one an app shows.
 * - **Attributed.** A blocked check names the `QuoteBlocker`, the policy id, whether it is a router
 *   policy, a rail capability, a sender input or a protocol bound, the exact snapshot or request
 *   field it read, and who can fix it.
 * - **Local and deterministic.** It takes only the request and a snapshot, makes no network call,
 *   reads no clock and uses no randomness. The same inputs give the same tree, and
 *   `serializeQuoteExplanation` gives the same text.
 */
import { BPS_DENOMINATOR, MAX_DECIMALS, convertDecimals, pow10 } from "../amounts.js";
import { AddressKind, tryParseStellarAddress } from "../addresses.js";
import { ROUTE_KINDS, carriesPayload, isRouteKind } from "../routes.js";
import type { RouteKind } from "../routes.js";
import { BLOCKER_COPY, MAX_QUOTE_AMOUNT, QuoteBlocker, bestQuote, planQuote } from "../quotes.js";
import type { BlockerOwner, QuoteRequest, RouteQuote, RouterSnapshot } from "../quotes.js";
import { MAX_WORD, validatePlanningSnapshot } from "./validation.js";

export const QUOTE_EXPLANATION_VERSION = 1 as const;

// ------------------------------------------------------------------------------------------------
// Policies
// ------------------------------------------------------------------------------------------------

/** The ladder's checks, in the order the router evaluates them. */
export const QUOTE_CHECK_IDS = [
  "route.paused",
  "route.enabled",
  "route.adapter",
  "destination.strkey",
  "destination.muxed-payload",
  "destination.chain",
  "token.registered",
  "token.enabled",
  "amount.positive",
  "amount.max",
  "amount.net-positive",
  "amount.decimals",
  "amount.representable",
  "breaker.latched",
  "breaker.headroom",
  "flow.headroom",
] as const;
export type QuoteCheckId = (typeof QUOTE_CHECK_IDS)[number];

/**
 * - `router-policy`: router state an operator sets.
 * - `rail-capability`: what a rail or its adapter can do.
 * - `sender-input`: something in the request.
 * - `protocol-bound`: a fixed limit of the protocol's arithmetic.
 */
export type QuotePolicyKind =
  "router-policy" | "rail-capability" | "sender-input" | "protocol-bound";

export interface QuotePolicy {
  readonly id: QuoteCheckId;
  readonly kind: QuotePolicyKind;
  /** The blocker this check returns when it fails. */
  readonly blocker: QuoteBlocker;
  /** The field the check reads, with `[route]` standing for the rail being priced. */
  readonly source: string;
  /** How the value changes on chain, or what the sender changes. */
  readonly control: string;
  /** Who can clear it, as `BLOCKER_COPY` words it for the app. */
  readonly fixableBy: BlockerOwner;
}

const policy = (
  id: QuoteCheckId,
  kind: QuotePolicyKind,
  blocker: QuoteBlocker,
  source: string,
  control: string,
): QuotePolicy => ({ id, kind, blocker, source, control, fixableBy: BLOCKER_COPY[blocker].owner });

/** Every check's owning policy or capability. */
export const QUOTE_POLICIES: Readonly<Record<QuoteCheckId, QuotePolicy>> = Object.freeze({
  "route.paused": policy(
    "route.paused",
    "router-policy",
    QuoteBlocker.Paused,
    "snapshot.paused",
    "guardian pause, admin unpause",
  ),
  "route.enabled": policy(
    "route.enabled",
    "router-policy",
    QuoteBlocker.RouteDisabled,
    "snapshot.routeEnabled[route]",
    "timelocked EnableRoute, immediate disable_route",
  ),
  "route.adapter": policy(
    "route.adapter",
    "router-policy",
    QuoteBlocker.AdapterNotSet,
    "snapshot.adapterSet[route]",
    "timelocked SetAdapter",
  ),
  "destination.strkey": policy(
    "destination.strkey",
    "sender-input",
    QuoteBlocker.InvalidDestination,
    "request.strkey",
    "a SEP-23 G, C or M address with a valid checksum",
  ),
  "destination.muxed-payload": policy(
    "destination.muxed-payload",
    "rail-capability",
    QuoteBlocker.MuxedNotSupported,
    "ROUTE_META[route].carriesPayload",
    "only payload-carrying rails can deliver to an M address",
  ),
  "destination.chain": policy(
    "destination.chain",
    "rail-capability",
    QuoteBlocker.ChainNotSupported,
    "snapshot.chainSupported[route]",
    "adapter lane configuration for the destination chain",
  ),
  "token.registered": policy(
    "token.registered",
    "router-policy",
    QuoteBlocker.TokenNotRegistered,
    "snapshot.tokenRegistered",
    "timelocked RegisterToken",
  ),
  "token.enabled": policy(
    "token.enabled",
    "router-policy",
    QuoteBlocker.TokenDisabled,
    "snapshot.tokenEnabled",
    "immediate disable_token",
  ),
  "amount.positive": policy(
    "amount.positive",
    "sender-input",
    QuoteBlocker.AmountTooSmall,
    "request.amount",
    "send a positive amount",
  ),
  "amount.max": policy(
    "amount.max",
    "protocol-bound",
    QuoteBlocker.NotRepresentable,
    "MAX_QUOTE_AMOUNT",
    "the router prices at most 2^128 - 1 base units",
  ),
  "amount.net-positive": policy(
    "amount.net-positive",
    "sender-input",
    QuoteBlocker.AmountTooSmall,
    "request.amount, snapshot.feeBps",
    "send enough that something remains after the fee",
  ),
  "amount.decimals": policy(
    "amount.decimals",
    "protocol-bound",
    QuoteBlocker.NotRepresentable,
    "MAX_DECIMALS",
    "both precisions must be at most 38",
  ),
  "amount.representable": policy(
    "amount.representable",
    "sender-input",
    QuoteBlocker.NotRepresentable,
    "request.amount, request.destinationDecimals",
    "send at least one destination base unit after the fee",
  ),
  "breaker.latched": policy(
    "breaker.latched",
    "router-policy",
    QuoteBlocker.CircuitBreakerTripped,
    "snapshot.circuitBreakerTripped",
    "token-wide emergency latch; operator reset",
  ),
  "breaker.headroom": policy(
    "breaker.headroom",
    "router-policy",
    QuoteBlocker.CircuitBreakerTripped,
    "snapshot.circuitBreakerAvailable",
    "token-wide emergency threshold; absent means not reported",
  ),
  "flow.headroom": policy(
    "flow.headroom",
    "router-policy",
    QuoteBlocker.FlowLimitExceeded,
    "snapshot.flowAvailable[route]",
    "timelocked flow limit; the window decays over time",
  ),
});

// ------------------------------------------------------------------------------------------------
// The tree
// ------------------------------------------------------------------------------------------------

export type DerivationId =
  | "amount.fee"
  | "amount.net-before-precision"
  | "amount.precision-floor"
  | "amount.dust"
  | "flow.available"
  | "flow.remaining"
  | "settlement.gross"
  | "settlement.retained"
  | "settlement.destination";

export type ExplanationStatus = "pass" | "blocked" | "not-reached" | "computed";

export interface CheckNode {
  readonly kind: "check";
  readonly id: QuoteCheckId;
  readonly status: "pass" | "blocked" | "not-reached";
  readonly policy: QuotePolicy;
  /** What the check read, or null when it was not reached. */
  readonly observed: bigint | boolean | string | null;
}

export interface DerivationNode {
  readonly kind: "derivation";
  readonly id: DerivationId;
  readonly status: "computed" | "not-reached";
  readonly formula: string;
  /** Exact integer inputs, by name. Empty when not reached. */
  readonly inputs: Readonly<Record<string, bigint>>;
  /** The result, or null when not reached. */
  readonly value: bigint | null;
}

export interface GroupNode {
  readonly kind: "group";
  readonly id: "route" | "destination" | "token" | "amount" | "breaker" | "flow" | "settlement";
  readonly status: ExplanationStatus;
  readonly children: readonly (CheckNode | DerivationNode)[];
}

export interface QuoteExplanation {
  readonly version: typeof QUOTE_EXPLANATION_VERSION;
  readonly route: RouteKind;
  /** Exactly what `planQuote` returns for the same inputs. */
  readonly quote: RouteQuote;
  /** The first failing check's policy, or null when the rail is available. */
  readonly blockedBy: QuotePolicy | null;
  readonly groups: readonly GroupNode[];
}

const FORMULAS: Readonly<Record<DerivationId, string>> = {
  "amount.fee": "floor(amount * feeBps / 10000)",
  "amount.net-before-precision": "amount - fee",
  "amount.precision-floor":
    "netBeforePrecision - (netBeforePrecision mod 10^max(0, sourceDecimals - destinationDecimals))",
  "amount.dust": "netBeforePrecision - net",
  "flow.available": "snapshot.flowAvailable[route], absent counts as 0",
  "flow.remaining": "flowAvailable - net",
  "settlement.gross": "fee + net",
  "settlement.retained": "amount - gross",
  "settlement.destination":
    "net * 10^(destinationDecimals - sourceDecimals) when widening, else floor(net / 10^(sourceDecimals - destinationDecimals))",
};

class Builder {
  private blocker: QuotePolicy | null = null;
  readonly nodes = new Map<string, CheckNode | DerivationNode>();

  get blocked(): boolean {
    return this.blocker !== null;
  }

  get blockedBy(): QuotePolicy | null {
    return this.blocker;
  }

  /** Record a check. Returns false if it blocked or was not reached. */
  check(
    id: QuoteCheckId,
    passes: () => boolean,
    observed: () => bigint | boolean | string,
  ): boolean {
    const p = QUOTE_POLICIES[id];
    if (this.blocked) {
      this.nodes.set(id, { kind: "check", id, status: "not-reached", policy: p, observed: null });
      return false;
    }
    const ok = passes();
    this.nodes.set(id, {
      kind: "check",
      id,
      status: ok ? "pass" : "blocked",
      policy: p,
      observed: observed(),
    });
    if (!ok) this.blocker = p;
    return ok;
  }

  /** Record a derivation. Returns null, without evaluating anything, once the ladder has blocked. */
  derive(
    id: DerivationId,
    compute: () => { inputs: Record<string, bigint>; value: bigint },
  ): bigint | null {
    if (this.blocked) {
      this.nodes.set(id, {
        kind: "derivation",
        id,
        status: "not-reached",
        formula: FORMULAS[id],
        inputs: {},
        value: null,
      });
      return null;
    }
    const { inputs, value } = compute();
    this.nodes.set(id, {
      kind: "derivation",
      id,
      status: "computed",
      formula: FORMULAS[id],
      inputs,
      value,
    });
    return value;
  }

  group(id: GroupNode["id"], ids: readonly string[]): GroupNode {
    const children = ids.map((x) => {
      const node = this.nodes.get(x);
      if (node === undefined) throw new Error(`explanation node ${x} was never visited`);
      return node;
    });
    const statuses = children.map((c) => c.status);
    const status: ExplanationStatus = statuses.includes("blocked")
      ? "blocked"
      : statuses.every((s) => s === "not-reached")
        ? "not-reached"
        : statuses.some((s) => s === "computed")
          ? "computed"
          : "pass";
    return { kind: "group", id, status, children };
  }
}

// ------------------------------------------------------------------------------------------------
// Input validation
// ------------------------------------------------------------------------------------------------

function validateRequest(request: QuoteRequest): void {
  if (typeof request !== "object" || (request as unknown) === null) {
    throw new TypeError("request must be an object");
  }
  if (typeof request.route !== "number" || !isRouteKind(request.route)) {
    throw new TypeError("request.route must be a supported route tag");
  }
  if (typeof request.amount !== "bigint") throw new TypeError("request.amount must be a bigint");
  if (typeof request.strkey !== "string") throw new TypeError("request.strkey must be a string");
  if (
    typeof request.destinationDecimals !== "number" ||
    !Number.isSafeInteger(request.destinationDecimals) ||
    request.destinationDecimals < 0
  ) {
    throw new RangeError("request.destinationDecimals must be a non-negative safe integer");
  }
}

/** The breaker fields are optional and outside the shared planning bounds, so check them here. */
function validateBreaker(snapshot: RouterSnapshot): void {
  const tripped: unknown = snapshot.circuitBreakerTripped;
  if (tripped !== undefined && typeof tripped !== "boolean") {
    throw new TypeError("snapshot.circuitBreakerTripped must be a boolean when present");
  }
  const available: unknown = snapshot.circuitBreakerAvailable;
  if (
    available !== undefined &&
    (typeof available !== "bigint" || available < 0n || available > MAX_WORD)
  ) {
    throw new TypeError(
      "snapshot.circuitBreakerAvailable must be a non-negative uint256 when present",
    );
  }
}

// ------------------------------------------------------------------------------------------------
// Explaining one rail
// ------------------------------------------------------------------------------------------------

/**
 * Explain one rail's quote.
 *
 * Throws `TypeError` or `RangeError`, with the field path, for a malformed request or snapshot,
 * using the same snapshot bounds as the bounded planners. For well-formed inputs it never throws,
 * and `quote` is exactly `planQuote(request, snapshot)`.
 */
export function explainQuote(request: QuoteRequest, snapshot: RouterSnapshot): QuoteExplanation {
  validateRequest(request);
  validatePlanningSnapshot(snapshot);
  validateBreaker(snapshot);
  const { route, amount, strkey, destinationDecimals } = request;
  const sourceDecimals = snapshot.tokenDecimals;
  const b = new Builder();

  b.check(
    "route.paused",
    () => !snapshot.paused,
    () => snapshot.paused,
  );
  b.check(
    "route.enabled",
    () => snapshot.routeEnabled[route] === true,
    () => snapshot.routeEnabled[route] === true,
  );
  b.check(
    "route.adapter",
    () => snapshot.adapterSet[route] === true,
    () => snapshot.adapterSet[route] === true,
  );

  const parsed = tryParseStellarAddress(strkey);
  b.check(
    "destination.strkey",
    () => parsed.ok,
    () => strkey,
  );
  const muxed = parsed.ok && parsed.parts.kind === AddressKind.MuxedAccount;
  b.check(
    "destination.muxed-payload",
    () => !muxed || carriesPayload(route),
    () =>
      muxed ? `muxed address; rail carries payload: ${String(carriesPayload(route))}` : "not muxed",
  );
  b.check(
    "destination.chain",
    () => snapshot.chainSupported[route] === true,
    () => snapshot.chainSupported[route] === true,
  );

  b.check(
    "token.registered",
    () => snapshot.tokenRegistered,
    () => snapshot.tokenRegistered,
  );
  b.check(
    "token.enabled",
    () => snapshot.tokenEnabled,
    () => snapshot.tokenEnabled,
  );

  b.check(
    "amount.positive",
    () => amount > 0n,
    () => amount,
  );
  b.check(
    "amount.max",
    () => amount <= MAX_QUOTE_AMOUNT,
    () => amount,
  );

  // Each derivation below only runs while nothing has blocked, so the `?? 0n` fallbacks on
  // earlier results are never taken by a computed node.
  const feeBps = BigInt(snapshot.feeBps);
  const fee = b.derive("amount.fee", () => ({
    inputs: { amount, feeBps, denominator: BPS_DENOMINATOR },
    value: (amount * feeBps) / BPS_DENOMINATOR,
  }));
  const netBefore = b.derive("amount.net-before-precision", () => ({
    inputs: { amount, fee: fee ?? 0n },
    value: amount - (fee ?? 0n),
  }));
  b.check(
    "amount.net-positive",
    () => netBefore !== 0n,
    () => netBefore ?? 0n,
  );
  b.check(
    "amount.decimals",
    () => sourceDecimals <= MAX_DECIMALS && destinationDecimals <= MAX_DECIMALS,
    () =>
      `source ${String(sourceDecimals)}, destination ${String(destinationDecimals)}, max ${String(MAX_DECIMALS)}`,
  );
  const net = b.derive("amount.precision-floor", () => {
    const before = netBefore ?? 0n;
    const divisor =
      sourceDecimals > destinationDecimals ? pow10(sourceDecimals - destinationDecimals) : 1n;
    return {
      inputs: {
        netBeforePrecision: before,
        sourceDecimals: BigInt(sourceDecimals),
        destinationDecimals: BigInt(destinationDecimals),
        divisor,
      },
      value: before - (before % divisor),
    };
  });
  b.derive("amount.dust", () => ({
    inputs: { netBeforePrecision: netBefore ?? 0n, net: net ?? 0n },
    value: (netBefore ?? 0n) - (net ?? 0n),
  }));
  b.check(
    "amount.representable",
    () => net !== 0n,
    () => net ?? 0n,
  );

  // The token-wide emergency breaker. Both fields are optional; absent means not tripped and not
  // reported, which is how planQuote reads them.
  const breakerAvailable = snapshot.circuitBreakerAvailable;
  b.check(
    "breaker.latched",
    () => snapshot.circuitBreakerTripped !== true,
    () => snapshot.circuitBreakerTripped === true,
  );
  b.check(
    "breaker.headroom",
    () => breakerAvailable === undefined || (net ?? 0n) <= breakerAvailable,
    () => breakerAvailable ?? "not reported",
  );

  // The router reports headroom from this point on, including when the flow check itself fails.
  const headroom = snapshot.flowAvailable[route] ?? 0n;
  const flowReached = !b.blocked;
  b.derive("flow.available", () => ({ inputs: { flowAvailable: headroom }, value: headroom }));
  b.check(
    "flow.headroom",
    () => (net ?? 0n) <= headroom,
    () => headroom,
  );
  b.derive("flow.remaining", () => ({
    inputs: { flowAvailable: headroom, net: net ?? 0n },
    value: headroom - (net ?? 0n),
  }));

  const gross = b.derive("settlement.gross", () => ({
    inputs: { fee: fee ?? 0n, net: net ?? 0n },
    value: (fee ?? 0n) + (net ?? 0n),
  }));
  b.derive("settlement.retained", () => ({
    inputs: { amount, gross: gross ?? 0n },
    value: amount - (gross ?? 0n),
  }));
  const destination = b.derive("settlement.destination", () => ({
    inputs: {
      net: net ?? 0n,
      sourceDecimals: BigInt(sourceDecimals),
      destinationDecimals: BigInt(destinationDecimals),
    },
    value: convertDecimals(net ?? 0n, sourceDecimals, destinationDecimals).converted,
  }));

  const blockedBy = b.blockedBy;
  const derived: Pick<RouteQuote, (typeof QUOTE_FIELDS)[number]> = {
    route,
    available: blockedBy === null,
    reason: blockedBy?.blocker ?? QuoteBlocker.None,
    grossAmount: blockedBy === null ? (gross ?? 0n) : amount,
    fee: blockedBy === null ? (fee ?? 0n) : 0n,
    netAmount: blockedBy === null ? (net ?? 0n) : 0n,
    destinationAmount: blockedBy === null ? (destination ?? 0n) : 0n,
    flowAvailable: flowReached ? headroom : 0n,
  };
  const quote = planQuote(request, snapshot);
  assertSameQuote(derived, quote);

  return {
    version: QUOTE_EXPLANATION_VERSION,
    route,
    quote,
    blockedBy,
    groups: [
      b.group("route", ["route.paused", "route.enabled", "route.adapter"]),
      b.group("destination", [
        "destination.strkey",
        "destination.muxed-payload",
        "destination.chain",
      ]),
      b.group("token", ["token.registered", "token.enabled"]),
      b.group("amount", [
        "amount.positive",
        "amount.max",
        "amount.fee",
        "amount.net-before-precision",
        "amount.net-positive",
        "amount.decimals",
        "amount.precision-floor",
        "amount.dust",
        "amount.representable",
      ]),
      b.group("breaker", ["breaker.latched", "breaker.headroom"]),
      b.group("flow", ["flow.available", "flow.headroom", "flow.remaining"]),
      b.group("settlement", ["settlement.gross", "settlement.retained", "settlement.destination"]),
    ],
  };
}

const QUOTE_FIELDS = [
  "route",
  "available",
  "reason",
  "grossAmount",
  "fee",
  "netAmount",
  "destinationAmount",
  "flowAvailable",
] as const;

function assertSameQuote(
  derived: Pick<RouteQuote, (typeof QUOTE_FIELDS)[number]>,
  quote: RouteQuote,
): void {
  for (const field of QUOTE_FIELDS) {
    if (derived[field] !== quote[field]) {
      // Unreachable while the two ladders agree. Failing closed beats explaining a different quote.
      throw new Error(
        `quote explanation diverged from planQuote at ${field}: ${String(derived[field])} vs ${String(quote[field])}`,
      );
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Explaining the ranking
// ------------------------------------------------------------------------------------------------

/** Why a rail did not win. */
export type RankingReason =
  | "winner"
  | "blocked"
  | "lower-destination-amount"
  | "tie-not-canonical"
  | "tie-waits-on-attestation"
  | "tie-earlier-rail-kept";

export interface RankingEntry {
  readonly route: RouteKind;
  readonly reason: RankingReason;
  /** The blocker's policy for a blocked rail, otherwise null. */
  readonly blockedBy: QuotePolicy | null;
}

export interface QuotesExplanation {
  readonly version: typeof QUOTE_EXPLANATION_VERSION;
  readonly explanations: readonly QuoteExplanation[];
  /** `bestQuote` over the same quotes, or null when every rail is blocked. */
  readonly winner: RouteKind | null;
  readonly ranking: readonly RankingEntry[];
}

/** Explain every rail in enum order, and why the winner won under `bestQuote`'s rule. */
export function explainQuotes(
  request: Omit<QuoteRequest, "route">,
  snapshot: RouterSnapshot,
): QuotesExplanation {
  const explanations = ROUTE_KINDS.map((route) => explainQuote({ ...request, route }, snapshot));
  const quotes = explanations.map((e) => e.quote);
  const best = bestQuote(quotes);
  const ranking = explanations.map((e): RankingEntry => {
    const q = e.quote;
    if (!q.available) return { route: q.route, reason: "blocked", blockedBy: e.blockedBy };
    if (best === null || q.route === best.route)
      return { route: q.route, reason: "winner", blockedBy: null };
    const reason: RankingReason =
      q.destinationAmount !== best.destinationAmount
        ? "lower-destination-amount"
        : q.isCanonical !== best.isCanonical
          ? "tie-not-canonical"
          : q.waitsOnAttestation !== best.waitsOnAttestation
            ? "tie-waits-on-attestation"
            : "tie-earlier-rail-kept";
    return { route: q.route, reason, blockedBy: null };
  });
  return { version: QUOTE_EXPLANATION_VERSION, explanations, winner: best?.route ?? null, ranking };
}

// ------------------------------------------------------------------------------------------------
// Serialisation
// ------------------------------------------------------------------------------------------------

/** Stable JSON: bigints as canonical decimal strings, keys in construction order. */
export function serializeQuoteExplanation(
  explanation: QuoteExplanation | QuotesExplanation,
): string {
  const bigints = (_key: string, value: unknown): unknown =>
    typeof value === "bigint" ? value.toString() : value;
  return `${JSON.stringify(explanation, bigints, 2)}\n`;
}
