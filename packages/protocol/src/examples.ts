/**
 * Executable integration examples built around caller-supplied read-only clients.
 *
 * `@hyperion/protocol` ships zero runtime dependencies, holds no credentials, and never talks to
 * an RPC node or indexer on its own. Applications and keepers inject narrow read-only adapters for
 * deployment manifests, router snapshots, and raw transfer evidence while this module performs
 * deterministic validation, integer planning, and wire-format inspection.
 *
 * Three boundaries are enforced throughout these workflows:
 *
 * 1. Local planning estimates fees, decimal flooring, and flow headroom from a caller-supplied
 *    snapshot. It never signs a transaction and always requires an on-chain `quote` confirmation
 *    before execution.
 * 2. Active deployment gating reflects validated reality: Stellar Testnet outbound `USDC` via
 *    `axelar-its` (to `sepolia`) and `cctp` (to `sepolia`, `base-sepolia`, `arc-testnet`) are
 *    active when backed by a validated deployment manifest, whereas EVM origin routers and
 *    unvalidated rails (`axelar-gmp`, `allbridge`) remain explicitly gated.
 * 3. Attested rail payloads or source notes never constitute proof of destination payout. Payout
 *    proof requires a confirmed destination router receipt (`delivered: true`), while parked
 *    deliveries (`delivered: false` with a non-zero `claimId`) remain recipient-bound pending
 *    claims rather than completed payouts.
 */
import type { AddressKind } from "./addresses.js";
import { encodeStellarAddress, tryParseStellarAddress } from "./addresses.js";
import {
  MAX_DECIMALS,
  applyFee,
  convertDecimals,
  floorToRepresentable,
  formatUnits,
  parseAmountInput,
} from "./amounts.js";
import type { Hex } from "./bytes.js";
import { bytesToBigInt, fromHex } from "./bytes.js";
import {
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  cctpHookData,
  displayNonce,
  isFinalized,
  parseCctpBurnMessage,
  parseCctpMessage,
} from "./cctp.js";
import type { ChainKey } from "./chains.js";
import { chain } from "./chains.js";
import type { DeploymentSet } from "./deployments.js";
import { adapterFor, deploymentFor, parseDeploymentSet, tokenFor } from "./deployments.js";
import { fail } from "./errors.js";
import {
  decodeCctpHook,
  decodeInboundNote,
  decodeOutboundNote,
  encodeOutboundNote,
  toEvmAddress,
  toWord,
} from "./notes.js";
import type { BatchQuoteResult, RouteQuote, RouterSnapshot } from "./quotes.js";
import {
  MAX_QUOTE_AMOUNT,
  QuoteBlocker,
  bestQuote,
  minimumFromTolerance,
  planQuotes,
  quoteBatch,
  wouldSlip,
} from "./quotes.js";
import { assetOn } from "./registry/assets.js";
import type { RouteKind } from "./routes.js";
import { ROUTE_KINDS, RouteKind as RouteKindEnum } from "./routes.js";

/** Read-only adapter supplying a raw deployment manifest JSON payload (sync or async). */
export interface DeploymentManifestReader {
  readDeploymentManifest(): unknown;
}

/** Query parameters passed to a caller-supplied router state reader. */
export interface RouterSnapshotQuery {
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly routerAddress: string;
  readonly tokenSymbol: string;
}

/** Read-only adapter supplying a point-in-time `RouterSnapshot` from the caller's RPC client. */
export interface RouterSnapshotReader {
  readRouterSnapshot(query: RouterSnapshotQuery): Promise<RouterSnapshot> | RouterSnapshot;
}

/** Destination router receipt facts read from confirmed on-chain logs or storage. */
export interface DestinationRouterReceipt {
  /** True only when the destination router transferred funds directly to the recipient. */
  readonly delivered: boolean;
  /** Non-null positive claim id when funds were parked for later permissionless settlement. */
  readonly claimId: bigint | null;
  /** Full 32-byte rail message identifier recorded in the router's replay guard. */
  readonly messageId: Hex;
  /** Base-unit amount recorded on the destination router. */
  readonly amount: bigint;
  /** Token decimals on the destination chain. */
  readonly decimals: number;
}

/** Raw read-only transfer artifacts fetched by a caller-supplied indexer or archive client. */
export interface TransferEvidenceBundle {
  readonly kind: "cctp" | "axelar-its";
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  /** Full CCTP V2 wire message (header + burn body + optional Hyperion hook). */
  readonly rawCctpMessage?: Uint8Array | Hex | undefined;
  /** Packed 29-byte Hyperion outbound note carried on Stellar -> EVM payload rails. */
  readonly rawOutboundNote?: Uint8Array | Hex | undefined;
  /** Packed variable-length Hyperion inbound note carried on EVM -> Stellar payload rails. */
  readonly rawInboundNote?: Uint8Array | Hex | undefined;
  /** Optional confirmed destination router receipt. Absent while a transfer is still in flight. */
  readonly destinationReceipt?: DestinationRouterReceipt | null | undefined;
}

/** Read-only adapter supplying raw transfer evidence by caller transfer identifier. */
export interface TransferEvidenceReader {
  readTransferEvidence(
    transferId: string,
  ): Promise<TransferEvidenceBundle | null> | TransferEvidenceBundle | null;
}

/** Explicit deployment validation gate separating active corridors from unvalidated work. */
export type DeploymentValidationGate =
  | "validated_stellar_testnet_outbound"
  | "gated_missing_deployment"
  | "gated_unvalidated_origin"
  | "gated_unvalidated_corridor";

/** Explicit workflow boundary tag ensuring planners never masquerade as execution proofs. */
export type WorkflowStageBoundary = "local_planning_only" | "evidence_inspection_only";

/** Per-rail planning assessment for Stellar outbound corridors to EVM destinations. */
export interface OutboundRailAssessment {
  readonly route: RouteKind;
  readonly activatedInDeployment: boolean;
  readonly available: boolean;
  readonly blocker: QuoteBlocker;
  readonly gateReason: string | null;
  readonly adapterAddress: string | null;
  readonly grossAmount: bigint;
  readonly fee: bigint;
  readonly netAmount: bigint;
  readonly retainedDust: bigint;
  readonly destinationAmount: bigint;
  readonly formattedDestinationAmount: string;
}

/** Input to `runStellarOutboundPlanningExample`. */
export interface StellarOutboundPlanningInput {
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly symbol: string;
  readonly evmRecipient: Hex;
  /** Gross amount as user text (parsed via `parseAmountInput`) or exact base-unit `bigint`. */
  readonly amount: string | bigint;
  /** Expected outbound nonce for deterministic note preview (defaults to `0n`). */
  readonly previewNonce?: bigint | undefined;
}

/** Output of `runStellarOutboundPlanningExample`. */
export interface StellarOutboundPlanningResult {
  readonly stage: "local_planning_only";
  readonly deploymentGate: DeploymentValidationGate;
  readonly executionPermitted: boolean;
  readonly requiresOnChainQuoteConfirmation: true;
  readonly signedExecutionPerformed: false;
  readonly payoutProven: false;
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly routerAddress: string | null;
  readonly requestedAmount: bigint;
  readonly previewOutboundNote: Uint8Array;
  readonly rails: readonly OutboundRailAssessment[];
  readonly recommendedRail: RouteKind | null;
}

/** Input to `runQuoteLadderPlanningExample` for Stellar-bound local quote ladders. */
export interface QuoteLadderPlanningInput {
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly symbol: string;
  readonly stellarRecipient: string;
  readonly primaryAmount: bigint;
  readonly ladderTiers: readonly bigint[];
  readonly slippageToleranceBps?: number | undefined;
}

/** Output of `runQuoteLadderPlanningExample`. */
export interface QuoteLadderPlanningResult {
  readonly stage: "local_planning_only";
  readonly deploymentGate: DeploymentValidationGate;
  readonly executionPermitted: boolean;
  readonly requiresOnChainQuoteConfirmation: true;
  readonly signedExecutionPerformed: false;
  readonly payoutProven: false;
  readonly primaryQuotes: readonly RouteQuote[];
  readonly winningPrimaryQuote: RouteQuote | null;
  readonly suggestedMinDestinationAmount: bigint | null;
  readonly primaryWouldSlip: boolean;
  readonly ladder: readonly BatchQuoteResult[];
}

/** Settlement verification state derived from wire evidence and optional router receipt. */
export type InspectedSettlementStage =
  "source_or_attested_in_flight" | "recipient_claim_parked" | "destination_paid";

/** Output of `runEvidenceInspectionExample`. */
export interface EvidenceInspectionResult {
  readonly stage: "evidence_inspection_only";
  readonly settlementStage: InspectedSettlementStage;
  /** True strictly when a confirmed destination router receipt proves direct delivery. */
  readonly payoutProven: boolean;
  readonly kind: "cctp" | "axelar-its";
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  /** Full 32-byte replay key when carried by the rail message, or null for source-only notes. */
  readonly replayMessageId: Hex | null;
  /** Router or explorer sequence number preserved at full 64-bit `bigint` width. */
  readonly correlationNonce: bigint;
  /** Canonical recipient string (checksummed Stellar strkey or 20-byte EVM hex). */
  readonly recipient: string;
  readonly recipientKind: AddressKind | "evm_account";
  readonly muxedSubAccountId: bigint | null;
  readonly railAmount: bigint | null;
  readonly attestationFinalized: boolean | null;
  readonly parkedClaimId: bigint | null;
  readonly formattedSettledAmount: string | null;
}

const VALIDATED_STELLAR_TESTNET_CCTP_DESTINATIONS: ReadonlySet<ChainKey> = new Set<ChainKey>([
  "sepolia",
  "base-sepolia",
  "arc-testnet",
]);

const VALIDATED_STELLAR_TESTNET_ITS_DESTINATIONS: ReadonlySet<ChainKey> = new Set<ChainKey>([
  "sepolia",
]);

function isActivatedStellarTestnetOutbound(
  originChain: ChainKey,
  destinationChain: ChainKey,
  symbol: string,
  route: RouteKind,
): { readonly active: boolean; readonly gateReason: string | null } {
  if (originChain !== "stellar-testnet") {
    return {
      active: false,
      gateReason: `origin ${originChain} is gated until independent router deployment validation completes`,
    };
  }
  if (symbol !== "USDC") {
    return {
      active: false,
      gateReason: `asset ${symbol} is not part of the active Stellar Testnet USDC deployment`,
    };
  }
  if (route === RouteKindEnum.Cctp) {
    if (VALIDATED_STELLAR_TESTNET_CCTP_DESTINATIONS.has(destinationChain)) {
      return { active: true, gateReason: null };
    }
    return {
      active: false,
      gateReason: `CCTP outbound from stellar-testnet to ${destinationChain} is not yet validated`,
    };
  }
  if (route === RouteKindEnum.AxelarIts) {
    if (VALIDATED_STELLAR_TESTNET_ITS_DESTINATIONS.has(destinationChain)) {
      return { active: true, gateReason: null };
    }
    return {
      active: false,
      gateReason: `Axelar ITS outbound from stellar-testnet to ${destinationChain} is gated`,
    };
  }
  return {
    active: false,
    gateReason: "rail is gated in the active Stellar Testnet Phase 1 deployment",
  };
}

/**
 * Plan a Stellar -> EVM outbound transfer using caller-supplied deployment and snapshot readers.
 *
 * Validates the deployment manifest, enforces active Stellar Testnet corridor gates so unvalidated
 * rails or origins never appear live, previews the recipient-bound 29-byte outbound note, and
 * computes exact `bigint` fees, decimal flooring, and retained dust without signing or broadcasting.
 */
export async function runStellarOutboundPlanningExample(
  input: StellarOutboundPlanningInput,
  clients: {
    readonly manifests: DeploymentManifestReader;
    readonly snapshots: RouterSnapshotReader;
  },
): Promise<StellarOutboundPlanningResult> {
  const originMeta = chain(input.originChain);
  const destMeta = chain(input.destinationChain);
  if (originMeta.network !== destMeta.network) {
    fail(
      "UnknownChain",
      `cannot plan across ${originMeta.network} (${input.originChain}) and ${destMeta.network} (${input.destinationChain})`,
    );
  }
  if (originMeta.family !== "stellar" || destMeta.family !== "evm") {
    fail(
      "UnsupportedRoute",
      `Stellar outbound planner expects stellar -> evm, got ${originMeta.family} -> ${destMeta.family}`,
    );
  }

  // Canonicalize the 20-byte EVM recipient through the 32-byte wire slot check and build note preview.
  const canonicalEvmRecipient = toEvmAddress(toWord(input.evmRecipient));
  const previewOutboundNote = encodeOutboundNote(canonicalEvmRecipient, input.previewNonce ?? 0n);

  const rawManifest = await clients.manifests.readDeploymentManifest();
  const deployments: DeploymentSet = parseDeploymentSet(rawManifest);
  const deployment = deploymentFor(deployments, input.originChain);
  const deployedToken = tokenFor(deployments, input.originChain, input.symbol);
  const destinationAsset = assetOn(input.destinationChain, input.symbol);
  if (destinationAsset === null) {
    fail(
      "TokenNotRegistered",
      `${input.symbol} is not registered in registry for ${input.destinationChain}`,
    );
  }

  const sourceDecimals = deployedToken?.decimals ?? originMeta.decimals;
  const requestedAmount =
    typeof input.amount === "bigint"
      ? input.amount
      : parseAmountInput(input.amount, sourceDecimals);

  if (deployment === null || deployedToken === null) {
    return {
      stage: "local_planning_only",
      deploymentGate: "gated_missing_deployment",
      executionPermitted: false,
      requiresOnChainQuoteConfirmation: true,
      signedExecutionPerformed: false,
      payoutProven: false,
      originChain: input.originChain,
      destinationChain: input.destinationChain,
      routerAddress: deployment?.router ?? null,
      requestedAmount,
      previewOutboundNote,
      rails: [],
      recommendedRail: null,
    };
  }

  const snapshot = await clients.snapshots.readRouterSnapshot({
    originChain: input.originChain,
    destinationChain: input.destinationChain,
    routerAddress: deployment.router,
    tokenSymbol: input.symbol,
  });

  const rails: OutboundRailAssessment[] = ROUTE_KINDS.map((route) => {
    const adapterAddress = adapterFor(deployments, input.originChain, route);
    const gate = isActivatedStellarTestnetOutbound(
      input.originChain,
      input.destinationChain,
      input.symbol,
      route,
    );
    const baseBlocked = (
      blocker: QuoteBlocker,
      gateReason: string | null,
    ): OutboundRailAssessment => ({
      route,
      activatedInDeployment: gate.active,
      available: false,
      blocker,
      gateReason,
      adapterAddress,
      grossAmount: requestedAmount,
      fee: 0n,
      netAmount: 0n,
      retainedDust: 0n,
      destinationAmount: 0n,
      formattedDestinationAmount: "0",
    });

    if (!gate.active) {
      return baseBlocked(QuoteBlocker.RouteDisabled, gate.gateReason);
    }
    if (snapshot.paused) {
      return baseBlocked(QuoteBlocker.Paused, null);
    }
    if (snapshot.routeEnabled[route] !== true || !deployedToken.routes.includes(route)) {
      return baseBlocked(QuoteBlocker.RouteDisabled, null);
    }
    if (adapterAddress === null || snapshot.adapterSet[route] !== true) {
      return baseBlocked(QuoteBlocker.AdapterNotSet, null);
    }
    if (snapshot.chainSupported[route] !== true) {
      return baseBlocked(QuoteBlocker.ChainNotSupported, null);
    }
    if (!snapshot.tokenRegistered) {
      return baseBlocked(QuoteBlocker.TokenNotRegistered, null);
    }
    if (!snapshot.tokenEnabled) {
      return baseBlocked(QuoteBlocker.TokenDisabled, null);
    }
    if (requestedAmount <= 0n) {
      return baseBlocked(QuoteBlocker.AmountTooSmall, null);
    }
    if (
      requestedAmount > MAX_QUOTE_AMOUNT ||
      snapshot.tokenDecimals > MAX_DECIMALS ||
      destinationAsset.decimals > MAX_DECIMALS
    ) {
      return baseBlocked(QuoteBlocker.NotRepresentable, null);
    }
    if (snapshot.feeBps < 0 || BigInt(snapshot.feeBps) > 100n) {
      fail("FeeTooHigh", `snapshot feeBps ${String(snapshot.feeBps)} exceeds protocol ceiling`);
    }

    const { fee, net: netRaw } = applyFee(requestedAmount, snapshot.feeBps);
    const netAmount = floorToRepresentable(
      netRaw,
      snapshot.tokenDecimals,
      destinationAsset.decimals,
    );
    if (netAmount === 0n) {
      return baseBlocked(QuoteBlocker.NotRepresentable, null);
    }

    const headroom = snapshot.flowAvailable[route] ?? 0n;
    if (netAmount > headroom) {
      return baseBlocked(QuoteBlocker.FlowLimitExceeded, null);
    }

    const { converted } = convertDecimals(
      netAmount,
      snapshot.tokenDecimals,
      destinationAsset.decimals,
    );
    const grossAmount = fee + netAmount;
    const retainedDust = requestedAmount - grossAmount;

    return {
      route,
      activatedInDeployment: true,
      available: true,
      blocker: QuoteBlocker.None,
      gateReason: null,
      adapterAddress,
      grossAmount,
      fee,
      netAmount,
      retainedDust,
      destinationAmount: converted,
      formattedDestinationAmount: formatUnits(converted, destinationAsset.decimals),
    };
  });

  const usableRails = rails.filter((item) => item.available);
  let recommendedRail: RouteKind | null = null;
  let bestDest = -1n;
  for (const candidate of usableRails) {
    if (candidate.destinationAmount > bestDest) {
      bestDest = candidate.destinationAmount;
      recommendedRail = candidate.route;
    }
  }

  const anyCorridorActivated = rails.some((item) => item.activatedInDeployment);
  const deploymentGate: DeploymentValidationGate =
    input.originChain !== "stellar-testnet"
      ? "gated_unvalidated_origin"
      : anyCorridorActivated
        ? "validated_stellar_testnet_outbound"
        : "gated_unvalidated_corridor";

  return {
    stage: "local_planning_only",
    deploymentGate,
    executionPermitted:
      deploymentGate === "validated_stellar_testnet_outbound" && recommendedRail !== null,
    requiresOnChainQuoteConfirmation: true,
    signedExecutionPerformed: false,
    payoutProven: false,
    originChain: input.originChain,
    destinationChain: input.destinationChain,
    routerAddress: deployment.router,
    requestedAmount,
    previewOutboundNote,
    rails,
    recommendedRail,
  };
}

/**
 * Run local multi-tier quote planning (`planQuotes`, `bestQuote`, `quoteBatch`) for a Stellar
 * recipient while keeping unvalidated EVM origin routers explicitly gated against live execution.
 */
export async function runQuoteLadderPlanningExample(
  input: QuoteLadderPlanningInput,
  clients: {
    readonly manifests: DeploymentManifestReader;
    readonly snapshots: RouterSnapshotReader;
  },
): Promise<QuoteLadderPlanningResult> {
  const originMeta = chain(input.originChain);
  const destMeta = chain(input.destinationChain);
  if (originMeta.network !== destMeta.network) {
    fail(
      "UnknownChain",
      `cannot mix ${originMeta.network} and ${destMeta.network} in quote ladder planning`,
    );
  }
  if (destMeta.family !== "stellar") {
    fail(
      "InvalidDestination",
      `quote ladder target must be a Stellar chain, got ${input.destinationChain}`,
    );
  }

  const rawManifest = await clients.manifests.readDeploymentManifest();
  const deployments = parseDeploymentSet(rawManifest);
  const originDeployment = deploymentFor(deployments, input.originChain);
  const destAsset = assetOn(input.destinationChain, input.symbol);
  const destinationDecimals = destAsset?.decimals ?? 7;

  const snapshot = await clients.snapshots.readRouterSnapshot({
    originChain: input.originChain,
    destinationChain: input.destinationChain,
    routerAddress: originDeployment?.router ?? "unvalidated-evm-router",
    tokenSymbol: input.symbol,
  });

  const primaryQuotes = planQuotes(
    {
      amount: input.primaryAmount,
      strkey: input.stellarRecipient,
      destinationDecimals,
    },
    snapshot,
  );
  const winningPrimaryQuote = bestQuote(primaryQuotes);
  const toleranceBps = input.slippageToleranceBps ?? 0;
  const suggestedMinDestinationAmount =
    winningPrimaryQuote !== null ? minimumFromTolerance(winningPrimaryQuote, toleranceBps) : null;
  const primaryWouldSlip =
    winningPrimaryQuote !== null && suggestedMinDestinationAmount !== null
      ? wouldSlip(winningPrimaryQuote, suggestedMinDestinationAmount)
      : false;

  const ladder = quoteBatch(input.ladderTiers, {
    strkey: input.stellarRecipient,
    destinationDecimals,
    snapshot,
  });

  // EVM -> Stellar routers remain gated until independently deployed and validated.
  const deploymentGate: DeploymentValidationGate =
    originDeployment === null ? "gated_missing_deployment" : "gated_unvalidated_origin";

  return {
    stage: "local_planning_only",
    deploymentGate,
    executionPermitted: false,
    requiresOnChainQuoteConfirmation: true,
    signedExecutionPerformed: false,
    payoutProven: false,
    primaryQuotes,
    winningPrimaryQuote,
    suggestedMinDestinationAmount,
    primaryWouldSlip,
    ladder,
  };
}

/**
 * Inspect raw cross-chain transfer evidence fetched via a caller-supplied client.
 *
 * Verifies CCTP V2 headers, burn bodies, and recipient-bound hooks or Hyperion notes, preserves
 * full-width 32-byte replay message IDs and 64-bit muxed sub-account IDs, and strictly separates
 * in-flight rail attestations or parked claims from confirmed destination payout proof.
 */
export async function runEvidenceInspectionExample(
  transferId: string,
  reader: TransferEvidenceReader,
): Promise<EvidenceInspectionResult | null> {
  const bundle = await reader.readTransferEvidence(transferId);
  if (bundle === null) return null;

  const originMeta = chain(bundle.originChain);
  const destMeta = chain(bundle.destinationChain);
  if (originMeta.network !== destMeta.network) {
    fail("UnknownChain", `evidence bundle mixes ${originMeta.network} and ${destMeta.network}`);
  }

  let replayMessageId: Hex | null = null;
  let correlationNonce: bigint;
  let recipient: string;
  let recipientKind: AddressKind | "evm_account";
  let muxedSubAccountId: bigint | null = null;
  let railAmount: bigint | null = null;
  let attestationFinalized: boolean | null = null;

  if (bundle.kind === "cctp") {
    if (bundle.rawCctpMessage === undefined) {
      fail("MalformedMessage", "cctp evidence bundle requires rawCctpMessage");
    }
    const header = parseCctpMessage(bundle.rawCctpMessage);
    assertSupportedMessage(header);
    const body = cctpBody(bundle.rawCctpMessage);
    const burn = parseCctpBurnMessage(body);
    assertSupportedBurn(burn);
    const hookBytes = cctpHookData(body);

    replayMessageId = header.nonce;
    correlationNonce = displayNonce(header);
    railAmount = burn.amount;
    attestationFinalized = isFinalized(header);

    if (destMeta.family === "stellar") {
      if (hookBytes.length === 0) {
        fail("MalformedMessage", "Stellar-bound CCTP transfer requires a recipient hook");
      }
      const hook = decodeCctpHook(hookBytes);
      recipient = encodeStellarAddress(hook.kind, hook.key, hook.muxedId);
      recipientKind = hook.kind;
      muxedSubAccountId = hook.muxedId === 0n ? null : hook.muxedId;
    } else {
      if (hookBytes.length > 0) {
        const note = decodeOutboundNote(hookBytes);
        recipient = note.recipient;
        correlationNonce = note.nonce;
      } else {
        recipient = toEvmAddress(burn.mintRecipient);
      }
      recipientKind = "evm_account";
    }
  } else {
    if (bundle.rawOutboundNote !== undefined && bundle.rawInboundNote !== undefined) {
      fail("MalformedMessage", "axelar-its evidence cannot carry both outbound and inbound notes");
    }
    if (bundle.rawOutboundNote !== undefined) {
      const outbound = decodeOutboundNote(bundle.rawOutboundNote);
      correlationNonce = outbound.nonce;
      recipient = outbound.recipient;
      recipientKind = "evm_account";
    } else if (bundle.rawInboundNote !== undefined) {
      const inbound = decodeInboundNote(bundle.rawInboundNote);
      const parsed = tryParseStellarAddress(inbound.strkey);
      if (!parsed.ok) fail("InvalidDestination", parsed.reason);
      correlationNonce = inbound.nonce;
      recipient = inbound.strkey;
      recipientKind = inbound.kind;
      muxedSubAccountId = parsed.parts.muxedId === 0n ? null : parsed.parts.muxedId;
    } else {
      fail(
        "MalformedMessage",
        "axelar-its evidence bundle requires rawOutboundNote or rawInboundNote",
      );
    }
  }

  let settlementStage: InspectedSettlementStage = "source_or_attested_in_flight";
  let payoutProven = false;
  let parkedClaimId: bigint | null = null;
  let formattedSettledAmount: string | null = null;

  const receipt = bundle.destinationReceipt ?? null;
  if (receipt !== null) {
    const idBytes = fromHex(receipt.messageId);
    if (idBytes.length !== 32 || bytesToBigInt(idBytes) === 0n) {
      fail("MalformedMessage", "destinationReceipt.messageId must be a non-zero 32-byte hex value");
    }
    if (
      replayMessageId !== null &&
      receipt.messageId.toLowerCase() !== replayMessageId.toLowerCase()
    ) {
      fail(
        "MalformedMessage",
        "destinationReceipt.messageId does not match the inspected rail replay key",
      );
    }
    if (receipt.amount < 0n) {
      fail("InvalidAmount", "destinationReceipt.amount cannot be negative");
    }

    if (receipt.delivered) {
      if (receipt.claimId !== null && receipt.claimId !== 0n) {
        fail("MalformedMessage", "delivered receipt cannot also carry a non-zero parked claimId");
      }
      settlementStage = "destination_paid";
      payoutProven = true;
      formattedSettledAmount = formatUnits(receipt.amount, receipt.decimals);
    } else {
      if (receipt.claimId === null || receipt.claimId <= 0n) {
        fail(
          "MalformedMessage",
          "undelivered destination receipt must carry a positive parked claimId",
        );
      }
      settlementStage = "recipient_claim_parked";
      payoutProven = false;
      parkedClaimId = receipt.claimId;
    }
  }

  return {
    stage: "evidence_inspection_only",
    settlementStage,
    payoutProven,
    kind: bundle.kind,
    originChain: bundle.originChain,
    destinationChain: bundle.destinationChain,
    replayMessageId,
    correlationNonce,
    recipient,
    recipientKind,
    muxedSubAccountId,
    railAmount,
    attestationFinalized,
    parkedClaimId,
    formattedSettledAmount,
  };
}
