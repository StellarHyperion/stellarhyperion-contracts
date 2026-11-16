/**
 * Deterministic machine-readable quote explanation trees.
 *
 * `planQuote` computes whether a rail can carry a transfer and what arrives on the destination
 * chain, intentionally collapsing intermediate calculations into a compact `RouteQuote`. Support
 * tooling, audit logs, and expandable UI fee breakdowns often need the exact intermediate numbers
 * (raw post-fee net, precision-boundary dust returned to the sender, sliding flow headroom
 * remaining or shortfall) and the concrete router policy or rail capability responsible when a
 * route is blocked, without making any network calls.
 */
import {
  BPS_DENOMINATOR,
  MAX_DECIMALS,
  convertDecimals,
  floorToRepresentable,
} from "../amounts.js";
import { AddressKind, tryParseStellarAddress } from "../addresses.js";
import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS, carriesPayload } from "../routes.js";
import { MAX_QUOTE_AMOUNT, QuoteBlocker, describeBlocker, planQuote } from "../quotes.js";
import type { BlockerOwner, QuoteRequest, RouteQuote, RouterSnapshot } from "../quotes.js";

/** Concrete router policy or rail capability governing each step in the quote ladder. */
export type QuotePolicyDomain =
  | "router.pause_switch"
  | "router.route_enablement"
  | "router.adapter_binding"
  | "destination.strkey_validation"
  | "rail.payload_capability"
  | "rail.destination_chain_capability"
  | "router.token_registration"
  | "router.token_enablement"
  | "amount.positive_input"
  | "amount.max_quote_ceiling"
  | "fee.protocol_bps"
  | "precision.max_decimals_bound"
  | "precision.representable_floor"
  | "router.sliding_flow_window"
  | "precision.destination_conversion";

export type QuoteExplanationNodeStatus = "passed" | "blocked" | "skipped";

export interface QuoteExplanationCheckNode {
  readonly kind: "check";
  readonly id: string;
  readonly policy: QuotePolicyDomain;
  readonly status: QuoteExplanationNodeStatus;
  readonly blocker: QuoteBlocker | null;
  readonly values: Readonly<Record<string, bigint | number | boolean | string>>;
}

export interface QuoteExplanationGroupNode {
  readonly kind: "group";
  readonly id:
    | "quote_root"
    | "eligibility_gates"
    | "fee_derivation"
    | "dust_derivation"
    | "flow_headroom"
    | "destination_conversion";
  readonly status: QuoteExplanationNodeStatus;
  readonly children: readonly (QuoteExplanationGroupNode | QuoteExplanationCheckNode)[];
}

export type QuoteExplanationNode = QuoteExplanationGroupNode | QuoteExplanationCheckNode;

export interface QuoteArithmeticDerivation {
  readonly requestedAmount: bigint;
  readonly feeBps: number;
  readonly bpsDenominator: bigint;
  readonly fee: bigint;
  readonly netBeforeFloor: bigint;
  readonly precisionDust: bigint;
  readonly netAmount: bigint;
  readonly grossAmount: bigint;
  readonly retainedSenderDust: bigint;
  readonly flowAvailable: bigint;
  readonly flowRemainingAfter: bigint;
  readonly flowShortfall: bigint;
  readonly destinationAmount: bigint;
}

export interface QuoteBlockerAttribution {
  readonly blocker: QuoteBlocker;
  readonly label: string;
  readonly owner: BlockerOwner;
  readonly transient: boolean;
  readonly owningPolicy: QuotePolicyDomain;
  readonly failedNodeId: string;
}

export interface QuoteExplanationTree {
  readonly route: RouteKind;
  readonly quote: RouteQuote;
  readonly arithmetic: QuoteArithmeticDerivation;
  readonly blockerAttribution: QuoteBlockerAttribution | null;
  readonly root: QuoteExplanationGroupNode;
}

function summarizeGroupStatus(
  children: readonly (QuoteExplanationGroupNode | QuoteExplanationCheckNode)[],
): QuoteExplanationNodeStatus {
  if (children.some((c) => c.status === "blocked")) return "blocked";
  if (children.every((c) => c.status === "skipped")) return "skipped";
  return "passed";
}

/**
 * Produce a deterministic machine-readable explanation tree alongside `planQuote(request, snapshot)`.
 */
export function explainQuote(
  request: QuoteRequest,
  snapshot: RouterSnapshot,
): QuoteExplanationTree {
  const quote = planQuote(request, snapshot);
  const { route, amount, destinationDecimals } = request;
  const headroom = snapshot.flowAvailable[route] ?? 0n;

  const state: {
    failedPolicy: QuotePolicyDomain | null;
    failedBlocker: QuoteBlocker | null;
    failedNodeId: string | null;
  } = {
    failedPolicy: null,
    failedBlocker: null,
    failedNodeId: null,
  };

  const recordCheck = (
    id: string,
    policy: QuotePolicyDomain,
    passes: () => boolean,
    blockerOnFail: QuoteBlocker,
    values: Readonly<Record<string, bigint | number | boolean | string>>,
  ): QuoteExplanationCheckNode => {
    if (state.failedBlocker !== null) {
      return {
        kind: "check",
        id,
        policy,
        status: "skipped",
        blocker: null,
        values,
      };
    }
    if (passes()) {
      return {
        kind: "check",
        id,
        policy,
        status: "passed",
        blocker: null,
        values,
      };
    }
    state.failedPolicy = policy;
    state.failedBlocker = blockerOnFail;
    state.failedNodeId = id;
    return {
      kind: "check",
      id,
      policy,
      status: "blocked",
      blocker: blockerOnFail,
      values,
    };
  };

  const parsedDest = tryParseStellarAddress(request.strkey);
  const isMuxed = parsedDest.ok && parsedDest.parts.kind === AddressKind.MuxedAccount;
  const railCarriesPayload = carriesPayload(route);

  const eligibilityChecks: QuoteExplanationCheckNode[] = [
    recordCheck(
      "gate.router_not_paused",
      "router.pause_switch",
      () => !snapshot.paused,
      QuoteBlocker.Paused,
      { paused: snapshot.paused },
    ),
    recordCheck(
      "gate.route_enabled",
      "router.route_enablement",
      () => snapshot.routeEnabled[route] === true,
      QuoteBlocker.RouteDisabled,
      { route, routeEnabled: snapshot.routeEnabled[route] === true },
    ),
    recordCheck(
      "gate.adapter_set",
      "router.adapter_binding",
      () => snapshot.adapterSet[route] === true,
      QuoteBlocker.AdapterNotSet,
      { route, adapterSet: snapshot.adapterSet[route] === true },
    ),
    recordCheck(
      "gate.destination_valid",
      "destination.strkey_validation",
      () => parsedDest.ok,
      QuoteBlocker.InvalidDestination,
      { validStrkey: parsedDest.ok },
    ),
    recordCheck(
      "gate.muxed_payload_support",
      "rail.payload_capability",
      () => !(isMuxed && !railCarriesPayload),
      QuoteBlocker.MuxedNotSupported,
      { isMuxed, carriesPayload: railCarriesPayload },
    ),
    recordCheck(
      "gate.chain_supported",
      "rail.destination_chain_capability",
      () => snapshot.chainSupported[route] === true,
      QuoteBlocker.ChainNotSupported,
      { route, chainSupported: snapshot.chainSupported[route] === true },
    ),
    recordCheck(
      "gate.token_registered",
      "router.token_registration",
      () => snapshot.tokenRegistered,
      QuoteBlocker.TokenNotRegistered,
      { tokenRegistered: snapshot.tokenRegistered },
    ),
    recordCheck(
      "gate.token_enabled",
      "router.token_enablement",
      () => snapshot.tokenEnabled,
      QuoteBlocker.TokenDisabled,
      { tokenEnabled: snapshot.tokenEnabled },
    ),
  ];

  const amountPositiveCheck = recordCheck(
    "fee.amount_positive",
    "amount.positive_input",
    () => amount > 0n,
    QuoteBlocker.AmountTooSmall,
    { requestedAmount: amount },
  );

  const amountCeilingCheck = recordCheck(
    "fee.amount_within_ceiling",
    "amount.max_quote_ceiling",
    () => amount <= MAX_QUOTE_AMOUNT,
    QuoteBlocker.NotRepresentable,
    { requestedAmount: amount, maxQuoteAmount: MAX_QUOTE_AMOUNT },
  );

  const canComputeFee = state.failedBlocker === null;
  const computedFee = canComputeFee ? (amount * BigInt(snapshot.feeBps)) / BPS_DENOMINATOR : 0n;
  const netBeforeFloor = canComputeFee ? amount - computedFee : 0n;

  const postFeeCheck = recordCheck(
    "fee.post_fee_nonzero",
    "fee.protocol_bps",
    () => netBeforeFloor > 0n,
    QuoteBlocker.AmountTooSmall,
    {
      requestedAmount: amount,
      feeBps: snapshot.feeBps,
      bpsDenominator: BPS_DENOMINATOR,
      fee: computedFee,
      netBeforeFloor,
    },
  );

  const decimalsBoundCheck = recordCheck(
    "dust.decimals_within_ceiling",
    "precision.max_decimals_bound",
    () => snapshot.tokenDecimals <= MAX_DECIMALS && destinationDecimals <= MAX_DECIMALS,
    QuoteBlocker.NotRepresentable,
    {
      sourceDecimals: snapshot.tokenDecimals,
      destinationDecimals,
      maxDecimals: MAX_DECIMALS,
    },
  );

  const canFloor = state.failedBlocker === null;
  const flooredNet = canFloor
    ? floorToRepresentable(netBeforeFloor, snapshot.tokenDecimals, destinationDecimals)
    : 0n;
  const precisionDust = canFloor ? netBeforeFloor - flooredNet : 0n;

  const representableFloorCheck = recordCheck(
    "dust.representable_floor",
    "precision.representable_floor",
    () => flooredNet > 0n,
    QuoteBlocker.NotRepresentable,
    {
      netBeforeFloor,
      flooredNetAmount: flooredNet,
      precisionDust,
    },
  );

  const flowShortfall =
    state.failedBlocker === null && flooredNet > headroom ? flooredNet - headroom : 0n;
  const flowRemainingAfter =
    state.failedBlocker === null && flooredNet <= headroom ? headroom - flooredNet : headroom;

  const flowHeadroomCheck = recordCheck(
    "flow.sliding_window_headroom",
    "router.sliding_flow_window",
    () => flooredNet <= headroom,
    QuoteBlocker.FlowLimitExceeded,
    {
      flowAvailable: headroom,
      requiredNetAmount: flooredNet,
      flowShortfall,
      flowRemainingAfter,
    },
  );

  const canConvert = state.failedBlocker === null;
  const destinationAmount = canConvert
    ? convertDecimals(flooredNet, snapshot.tokenDecimals, destinationDecimals).converted
    : 0n;

  const conversionCheck = recordCheck(
    "destination.decimal_conversion",
    "precision.destination_conversion",
    () => true,
    QuoteBlocker.None,
    {
      flooredNetAmount: flooredNet,
      sourceDecimals: snapshot.tokenDecimals,
      destinationDecimals,
      destinationAmount,
    },
  );

  const finalFee = quote.available ? computedFee : 0n;
  const finalNet = quote.available ? flooredNet : 0n;
  const finalGross = quote.available ? finalFee + finalNet : amount;
  const retainedSenderDust = quote.available ? amount - finalGross : 0n;

  const eligibilityGroup: QuoteExplanationGroupNode = {
    kind: "group",
    id: "eligibility_gates",
    status: summarizeGroupStatus(eligibilityChecks),
    children: Object.freeze(eligibilityChecks),
  };

  const feeChildren = [amountPositiveCheck, amountCeilingCheck, postFeeCheck];
  const feeGroup: QuoteExplanationGroupNode = {
    kind: "group",
    id: "fee_derivation",
    status: summarizeGroupStatus(feeChildren),
    children: Object.freeze(feeChildren),
  };

  const dustChildren = [decimalsBoundCheck, representableFloorCheck];
  const dustGroup: QuoteExplanationGroupNode = {
    kind: "group",
    id: "dust_derivation",
    status: summarizeGroupStatus(dustChildren),
    children: Object.freeze(dustChildren),
  };

  const flowChildren = [flowHeadroomCheck];
  const flowGroup: QuoteExplanationGroupNode = {
    kind: "group",
    id: "flow_headroom",
    status: summarizeGroupStatus(flowChildren),
    children: Object.freeze(flowChildren),
  };

  const conversionChildren = [conversionCheck];
  const conversionGroup: QuoteExplanationGroupNode = {
    kind: "group",
    id: "destination_conversion",
    status: summarizeGroupStatus(conversionChildren),
    children: Object.freeze(conversionChildren),
  };

  const topGroups = [eligibilityGroup, feeGroup, dustGroup, flowGroup, conversionGroup];
  const root: QuoteExplanationGroupNode = {
    kind: "group",
    id: "quote_root",
    status: summarizeGroupStatus(topGroups),
    children: Object.freeze(topGroups),
  };

  let blockerAttribution: QuoteBlockerAttribution | null = null;
  if (state.failedBlocker !== null && state.failedPolicy !== null && state.failedNodeId !== null) {
    const copy = describeBlocker(state.failedBlocker);
    blockerAttribution = {
      blocker: state.failedBlocker,
      label: copy.label,
      owner: copy.owner,
      transient: copy.transient,
      owningPolicy: state.failedPolicy,
      failedNodeId: state.failedNodeId,
    };
  }

  return {
    route,
    quote,
    arithmetic: {
      requestedAmount: amount,
      feeBps: snapshot.feeBps,
      bpsDenominator: BPS_DENOMINATOR,
      fee: finalFee,
      netBeforeFloor,
      precisionDust,
      netAmount: finalNet,
      grossAmount: finalGross,
      retainedSenderDust,
      flowAvailable: quote.flowAvailable,
      flowRemainingAfter: quote.available ? headroom - finalNet : headroom,
      flowShortfall,
      destinationAmount: quote.destinationAmount,
    },
    blockerAttribution,
    root,
  };
}

/** Produce deterministic quote explanation trees across all registered `ROUTE_KINDS`. */
export function explainQuotes(
  request: Omit<QuoteRequest, "route">,
  snapshot: RouterSnapshot,
): readonly QuoteExplanationTree[] {
  return ROUTE_KINDS.map((route) => explainQuote({ ...request, route }, snapshot));
}
