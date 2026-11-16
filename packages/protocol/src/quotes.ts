/**
 * Pricing a route without asking the chain.
 *
 * The router has a `quote` that never reverts, which is the honest answer and the one an app
 * should show before anybody signs. This is the same ladder, in the same order, running locally.
 * It exists for one reason: a planner that has to render four rails while somebody is still
 * typing cannot do four `eth_call`s per keystroke, and a number that appears half a second after
 * the digit that produced it feels broken even when it is right.
 *
 * So the app prices locally as you type and confirms on chain before you sign. The two have to
 * agree, and `quote.test.ts` walks the same cases through both. Where they ever disagree the
 * chain is right and this file is a bug.
 */
import { BPS_DENOMINATOR, MAX_DECIMALS, convertDecimals, floorToRepresentable } from "./amounts.js";
import { tryParseStellarAddress, AddressKind } from "./addresses.js";
import type { RouteKind } from "./routes.js";
import { ROUTE_KINDS, carriesPayload, isCanonical, waitsOnAttestation } from "./routes.js";

/**
 * Why a rail turned a quote down. Same integers as the Solidity enum and the Soroban one, in
 * declaration order, because these values travel in events an indexer reads on both chains.
 */
export const QuoteBlocker = {
  None: 0,
  Paused: 1,
  RouteDisabled: 2,
  AdapterNotSet: 3,
  TokenNotRegistered: 4,
  TokenDisabled: 5,
  AmountTooSmall: 6,
  FlowLimitExceeded: 7,
  NotRepresentable: 8,
  MuxedNotSupported: 9,
  InvalidDestination: 10,
  ChainNotSupported: 11,
} as const;

export type QuoteBlocker = (typeof QuoteBlocker)[keyof typeof QuoteBlocker];

/** Whose problem a blocker is, which decides whether the app offers a fix or an apology. */
export type BlockerOwner = "sender" | "operator" | "rail";

export interface BlockerCopy {
  /** Short enough for a row in a route list. */
  readonly label: string;
  /** One sentence, written for somebody who did not read the architecture document. */
  readonly detail: string;
  readonly owner: BlockerOwner;
  /** Whether trying the same thing again later could plausibly work. */
  readonly transient: boolean;
}

const COPY: Record<QuoteBlocker, BlockerCopy> = {
  [QuoteBlocker.None]: {
    label: "Ready",
    detail: "This rail can carry the transfer right now.",
    owner: "sender",
    transient: false,
  },
  [QuoteBlocker.Paused]: {
    label: "Departures paused",
    detail:
      "Somebody pulled the brake on this router. Arrivals still work, so anything already in flight keeps moving.",
    owner: "operator",
    transient: true,
  },
  [QuoteBlocker.RouteDisabled]: {
    label: "Rail switched off",
    detail: "This rail is turned off here. The other rails in the list are unaffected.",
    owner: "operator",
    transient: true,
  },
  [QuoteBlocker.AdapterNotSet]: {
    label: "Rail not wired up",
    detail: "No adapter is registered for this rail on this chain yet.",
    owner: "operator",
    transient: false,
  },
  [QuoteBlocker.TokenNotRegistered]: {
    label: "Asset not listed",
    detail: "This router has never been told about this asset, so it will not move it.",
    owner: "operator",
    transient: false,
  },
  [QuoteBlocker.TokenDisabled]: {
    label: "Asset retired",
    detail: "This asset was registered once and has since been retired here.",
    owner: "operator",
    transient: false,
  },
  [QuoteBlocker.AmountTooSmall]: {
    label: "Amount too small",
    detail: "After the fee there would be nothing left to send.",
    owner: "sender",
    transient: false,
  },
  [QuoteBlocker.FlowLimitExceeded]: {
    label: "Over the window limit",
    detail:
      "This would push the amount crossing in the current window past its ceiling. Send less, or wait for the window to roll.",
    owner: "sender",
    transient: true,
  },
  [QuoteBlocker.NotRepresentable]: {
    label: "Precision would be lost",
    detail:
      "The destination keeps fewer decimal places than this amount needs, and rounding somebody's money down without saying so is not an option.",
    owner: "sender",
    transient: false,
  },
  [QuoteBlocker.MuxedNotSupported]: {
    label: "Muxed address needs a payload",
    detail:
      "This rail cannot carry the sub account id an M address depends on. Use a rail that carries a payload, or the underlying G address.",
    owner: "sender",
    transient: false,
  },
  [QuoteBlocker.InvalidDestination]: {
    label: "Address does not check out",
    detail:
      "That is not a Stellar address, or a character in it changed somewhere between the wallet and here.",
    owner: "sender",
    transient: false,
  },
  [QuoteBlocker.ChainNotSupported]: {
    label: "Rail does not reach there",
    detail: "This rail has no route to that chain, at least not one configured here.",
    owner: "rail",
    transient: false,
  },
};

export const BLOCKER_COPY: Readonly<Record<QuoteBlocker, BlockerCopy>> = Object.freeze(COPY);

export function describeBlocker(blocker: QuoteBlocker): BlockerCopy {
  return COPY[blocker];
}

/**
 * The widest amount the router will price.
 *
 * `quote` refuses anything past this rather than risking an overflow inside a function whose
 * whole promise is that it answers instead of reverting. Nothing anybody is actually sending
 * comes near it.
 */
export const MAX_QUOTE_AMOUNT = (1n << 128n) - 1n;

/** What a route would do with an amount right now, without doing it. */
export interface RouteQuote {
  readonly route: RouteKind;
  readonly available: boolean;
  readonly reason: QuoteBlocker;
  /** Fee plus net, which is what leaves the sender's wallet. */
  readonly grossAmount: bigint;
  readonly fee: bigint;
  readonly netAmount: bigint;
  /** What lands, in the destination's own decimal base. */
  readonly destinationAmount: bigint;
  readonly flowAvailable: bigint;
  readonly waitsOnAttestation: boolean;
  readonly isCanonical: boolean;
}

/**
 * The router state a local quote needs.
 *
 * All of it is readable in one multicall, and the app refreshes it on a block rather than on a
 * keystroke. Keeping it in one object rather than a dozen arguments means adding a check later is
 * a field, not a signature change across every caller.
 */
export interface RouterSnapshot {
  readonly paused: boolean;
  readonly feeBps: number;
  /** Per rail. A rail missing from the record counts as disabled. */
  readonly routeEnabled: Partial<Record<RouteKind, boolean>>;
  /** Per rail. False when no adapter is registered. */
  readonly adapterSet: Partial<Record<RouteKind, boolean>>;
  readonly tokenRegistered: boolean;
  readonly tokenEnabled: boolean;
  readonly tokenDecimals: number;
  /** Per rail, in this chain's units for this asset. */
  readonly flowAvailable: Partial<Record<RouteKind, bigint>>;
  /** Per rail, whether the adapter says it can reach the destination chain. */
  readonly chainSupported: Partial<Record<RouteKind, boolean>>;
}

export interface QuoteRequest {
  readonly route: RouteKind;
  readonly amount: bigint;
  /** The destination address, exactly as it was pasted. */
  readonly strkey: string;
  readonly destinationDecimals: number;
}

function blocked(base: RouteQuote, reason: QuoteBlocker): RouteQuote {
  return { ...base, available: false, reason };
}

/**
 * Price one rail. Never throws, for the same reason the on-chain version never reverts: an app
 * rendering four rows should not have to wrap each one in a try, and even the absurd amount
 * deserves a reason rather than a stack trace.
 */
export function planQuote(request: QuoteRequest, snapshot: RouterSnapshot): RouteQuote {
  const { route, amount, destinationDecimals } = request;
  const base: RouteQuote = {
    route,
    available: false,
    reason: QuoteBlocker.None,
    grossAmount: amount,
    fee: 0n,
    netAmount: 0n,
    destinationAmount: 0n,
    flowAvailable: 0n,
    waitsOnAttestation: waitsOnAttestation(route),
    isCanonical: isCanonical(route),
  };

  // The half of a quote the amount has nothing to do with, in the router's own order.
  if (snapshot.paused) return blocked(base, QuoteBlocker.Paused);
  if (snapshot.routeEnabled[route] !== true) return blocked(base, QuoteBlocker.RouteDisabled);
  if (snapshot.adapterSet[route] !== true) return blocked(base, QuoteBlocker.AdapterNotSet);

  const parsed = tryParseStellarAddress(request.strkey);
  if (!parsed.ok) return blocked(base, QuoteBlocker.InvalidDestination);
  if (parsed.parts.kind === AddressKind.MuxedAccount && !carriesPayload(route)) {
    return blocked(base, QuoteBlocker.MuxedNotSupported);
  }
  if (snapshot.chainSupported[route] !== true) return blocked(base, QuoteBlocker.ChainNotSupported);

  if (!snapshot.tokenRegistered) return blocked(base, QuoteBlocker.TokenNotRegistered);
  if (!snapshot.tokenEnabled) return blocked(base, QuoteBlocker.TokenDisabled);

  if (amount <= 0n) return blocked(base, QuoteBlocker.AmountTooSmall);
  if (amount > MAX_QUOTE_AMOUNT) return blocked(base, QuoteBlocker.NotRepresentable);

  const fee = (amount * BigInt(snapshot.feeBps)) / BPS_DENOMINATOR;
  const netRaw = amount - fee;
  if (netRaw === 0n) return blocked(base, QuoteBlocker.AmountTooSmall);
  if (snapshot.tokenDecimals > MAX_DECIMALS || destinationDecimals > MAX_DECIMALS) {
    return blocked(base, QuoteBlocker.NotRepresentable);
  }

  const net = floorToRepresentable(netRaw, snapshot.tokenDecimals, destinationDecimals);
  if (net === 0n) return blocked(base, QuoteBlocker.NotRepresentable);

  const headroom = snapshot.flowAvailable[route] ?? 0n;
  const withFlow: RouteQuote = { ...base, flowAvailable: headroom };
  if (net > headroom) return blocked(withFlow, QuoteBlocker.FlowLimitExceeded);

  const { converted } = convertDecimals(net, snapshot.tokenDecimals, destinationDecimals);
  return {
    ...withFlow,
    available: true,
    reason: QuoteBlocker.None,
    fee,
    netAmount: net,
    grossAmount: fee + net,
    destinationAmount: converted,
  };
}

/** Price every rail, in the enum's own order so a list does not reshuffle itself between renders. */
export function planQuotes(
  request: Omit<QuoteRequest, "route">,
  snapshot: RouterSnapshot,
): readonly RouteQuote[] {
  return ROUTE_KINDS.map((route) => planQuote({ ...request, route }, snapshot));
}

/**
 * Which rail to put at the top.
 *
 * Most arriving wins, because that is the number people actually compare. Ties break towards the
 * canonical asset over a wrapper of it, then towards the rail that does not make somebody wait on
 * an attestation. Nothing here is clever, which is deliberate: a recommendation people cannot
 * explain to themselves is a recommendation they are right not to trust.
 */
export function bestQuote(quotes: readonly RouteQuote[]): RouteQuote | null {
  const usable = quotes.filter((q) => q.available);
  if (usable.length === 0) return null;
  return usable.reduce((best, candidate) => (outranks(candidate, best) ? candidate : best));
}

function outranks(candidate: RouteQuote, incumbent: RouteQuote): boolean {
  if (candidate.destinationAmount !== incumbent.destinationAmount) {
    return candidate.destinationAmount > incumbent.destinationAmount;
  }
  if (candidate.isCanonical !== incumbent.isCanonical) return candidate.isCanonical;
  if (candidate.waitsOnAttestation !== incumbent.waitsOnAttestation) {
    return !candidate.waitsOnAttestation;
  }
  return false;
}

/**
 * Whether a quote would trip the router's slippage guard.
 *
 * Deliberately not part of `planQuote`, because the router's `quote` does not know about a
 * minimum either. `bridgeOut` is where `minDestinationAmount` is enforced, and it reverts there
 * with `SlippageExceeded`. This is the courtesy check that stops an app letting somebody sign a
 * transaction it could already tell was going to fail.
 */
export function wouldSlip(quote: RouteQuote, minDestinationAmount: bigint): boolean {
  return quote.available && quote.destinationAmount < minDestinationAmount;
}

/**
 * A sane minimum from a quote and a tolerance in basis points.
 *
 * Rounds the floor down, so the guard is never tighter than the tolerance somebody chose. On a
 * rail with a fixed rate this is theatre, and on one that skims a variable fee it is the
 * difference between a transfer and a surprise.
 */
export function minimumFromTolerance(quote: RouteQuote, toleranceBps: number): bigint {
  if (toleranceBps < 0 || toleranceBps > Number(BPS_DENOMINATOR)) {
    throw new RangeError(`tolerance out of range: ${String(toleranceBps)} bps`);
  }
  const keep = BPS_DENOMINATOR - BigInt(toleranceBps);
  return (quote.destinationAmount * keep) / BPS_DENOMINATOR;
}

/** Convenience alias for single rail quote planning. */
export const quoteRoute = planQuote;

/** Convenience alias for all rail quote planning. */
export const quoteAllRails = planQuotes;

export * from "./quotes/types.js";
export * from "./quotes/ladder.js";
export * from "./quotes/maxSend.js";
