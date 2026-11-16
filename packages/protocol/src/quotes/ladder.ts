import {
  BPS_DENOMINATOR,
  MAX_DECIMALS,
  convertDecimals,
  floorToRepresentable,
} from "../amounts.js";
import { tryParseStellarAddress, AddressKind } from "../addresses.js";
import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS, carriesPayload, isCanonical, waitsOnAttestation } from "../routes.js";
import { MAX_QUOTE_AMOUNT, QuoteBlocker, bestQuote } from "../quotes.js";
import type { RouteQuote } from "../quotes.js";
import {
  RAIL_DESTINATION_GAS_ESTIMATES,
  type BatchQuoteResult,
  type QuoteParams,
} from "./types.js";

interface PrecomputedRailContext {
  readonly route: RouteKind;
  readonly staticBlocker: QuoteBlocker | null;
  readonly headroom: bigint;
  readonly waitsOnAttestation: boolean;
  readonly isCanonical: boolean;
}

/**
 * Price multiple amount tiers simultaneously across all rails without redundant recalculations.
 *
 * Designed for fee curve rendering, client UI ladders, and routing aggregators pricing
 * amount ladders (e.g. [100 USDC, 500 USDC, 1,000 USDC]) in a single call.
 *
 * Optimizations:
 * - Pre-validates destination address formatting and checksum once for the entire batch.
 * - Pre-checks static snapshot constraints (paused state, rail enablement, adapters, token status).
 * - Avoids repetitive allocations and string parsing inside the tier loop.
 * - Maintains zero external runtime dependencies and exact decimal parity with on-chain contracts.
 */
export function quoteBatch(
  tiers: readonly bigint[],
  params: QuoteParams,
): readonly BatchQuoteResult[] {
  const { strkey, destinationDecimals, snapshot, gasEstimates } = params;

  // Build combined gas projections from historical defaults and caller overrides
  const gasProjections: Record<RouteKind, bigint> = {
    ...RAIL_DESTINATION_GAS_ESTIMATES,
    ...gasEstimates,
  };

  // Pre-parse destination address once for all rails and all tiers
  const parsedAddress = tryParseStellarAddress(strkey);
  const isMuxed = parsedAddress.ok && parsedAddress.parts.kind === AddressKind.MuxedAccount;

  // Check static token bounds once
  const tokenDecimalsInvalid =
    snapshot.tokenDecimals > MAX_DECIMALS || destinationDecimals > MAX_DECIMALS;

  // Pre-compute static rail context so only amount-dependent arithmetic runs per tier
  const railContexts: readonly PrecomputedRailContext[] = ROUTE_KINDS.map((route) => {
    let staticBlocker: QuoteBlocker | null = null;

    if (snapshot.paused) {
      staticBlocker = QuoteBlocker.Paused;
    } else if (snapshot.routeEnabled[route] !== true) {
      staticBlocker = QuoteBlocker.RouteDisabled;
    } else if (snapshot.adapterSet[route] !== true) {
      staticBlocker = QuoteBlocker.AdapterNotSet;
    } else if (!parsedAddress.ok) {
      staticBlocker = QuoteBlocker.InvalidDestination;
    } else if (isMuxed && !carriesPayload(route)) {
      staticBlocker = QuoteBlocker.MuxedNotSupported;
    } else if (snapshot.chainSupported[route] !== true) {
      staticBlocker = QuoteBlocker.ChainNotSupported;
    } else if (!snapshot.tokenRegistered) {
      staticBlocker = QuoteBlocker.TokenNotRegistered;
    } else if (!snapshot.tokenEnabled) {
      staticBlocker = QuoteBlocker.TokenDisabled;
    } else if (snapshot.tokenCircuitTripped === true) {
      staticBlocker = QuoteBlocker.CircuitBreakerTripped;
    } else if (tokenDecimalsInvalid) {
      staticBlocker = QuoteBlocker.NotRepresentable;
    }

    return {
      route,
      staticBlocker,
      headroom: snapshot.flowAvailable[route] ?? 0n,
      waitsOnAttestation: waitsOnAttestation(route),
      isCanonical: isCanonical(route),
    };
  });

  const feeBps = BigInt(snapshot.feeBps);

  return tiers.map((tierAmount) => {
    const quotes: RouteQuote[] = railContexts.map((ctx) => {
      const base: RouteQuote = {
        route: ctx.route,
        available: false,
        reason: QuoteBlocker.None,
        grossAmount: tierAmount,
        fee: 0n,
        netAmount: 0n,
        destinationAmount: 0n,
        flowAvailable: ctx.headroom,
        waitsOnAttestation: ctx.waitsOnAttestation,
        isCanonical: ctx.isCanonical,
      };

      // If a static blocker was hit, return immediately
      if (ctx.staticBlocker !== null) {
        return { ...base, reason: ctx.staticBlocker };
      }

      // Tier amount bounds
      if (tierAmount <= 0n) {
        return { ...base, reason: QuoteBlocker.AmountTooSmall };
      }
      if (tierAmount > MAX_QUOTE_AMOUNT) {
        return { ...base, reason: QuoteBlocker.NotRepresentable };
      }

      // Fee and net token computation
      const fee = (tierAmount * feeBps) / BPS_DENOMINATOR;
      const netRaw = tierAmount - fee;
      if (netRaw === 0n) {
        return { ...base, reason: QuoteBlocker.AmountTooSmall };
      }

      const net = floorToRepresentable(netRaw, snapshot.tokenDecimals, destinationDecimals);
      if (net === 0n) {
        return { ...base, reason: QuoteBlocker.NotRepresentable };
      }
      if (snapshot.tokenCircuitRemaining !== undefined && net > snapshot.tokenCircuitRemaining) {
        return { ...base, reason: QuoteBlocker.CircuitBreakerTripped };
      }

      // Headroom flow limit check
      if (net > ctx.headroom) {
        return { ...base, reason: QuoteBlocker.FlowLimitExceeded };
      }

      // Convert to destination decimals
      const { converted } = convertDecimals(net, snapshot.tokenDecimals, destinationDecimals);

      return {
        ...base,
        available: true,
        reason: QuoteBlocker.None,
        fee,
        netAmount: net,
        grossAmount: fee + net,
        destinationAmount: converted,
      };
    });

    const best = bestQuote(quotes);
    const available = best !== null;

    return {
      amount: tierAmount,
      available,
      winningRail: best !== null ? best.route : null,
      bestQuote: best,
      grossAmount: best !== null ? best.grossAmount : tierAmount,
      fee: best !== null ? best.fee : 0n,
      netAmount: best !== null ? best.netAmount : 0n,
      destinationAmount: best !== null ? best.destinationAmount : 0n,
      estimatedDestinationGas: best !== null ? gasProjections[best.route] : null,
      gasProjections: Object.freeze(gasProjections),
      quotes,
    };
  });
}
