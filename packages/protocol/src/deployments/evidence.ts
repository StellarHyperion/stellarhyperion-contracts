/**
 * Signed acceptance evidence schema validation and legacy v1 migration.
 *
 * Enforces explicit network, router, sender, recipient, asset, and exact-integer amount bindings
 * on public source transactions and independently verified destination payment proofs. Prevents
 * source-only checkpoints, forwarding-API-only statuses, or mock/local rehearsal fixtures from
 * being classified as `delivered`, while providing a deterministic migration path for historical
 * evidence files under `deployments/evidence/`.
 */
import { isStellarAddress } from "../addresses.js";
import { CHAINS, isChainKey, type ChainKey } from "../chains.js";
import { ROUTE_KINDS, RouteKind } from "../routes.js";

export const ACCEPTANCE_EVIDENCE_SCHEMA_VERSION = 2;

const ZERO_EVM_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_STELLAR_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const DEFAULT_STELLAR_TESTNET_USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

export type AcceptanceEvidenceOrigin =
  "public-signed-acceptance" | "source-only-checkpoint" | "mock-fixture";

export type AcceptanceClassification =
  "delivered" | "pending-destination" | "non-acceptance-mock" | "invalid";

export interface AcceptanceNetworkBinding {
  readonly sourceChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly route: RouteKind;
  readonly router: string;
}

export interface AcceptancePartyBinding {
  readonly sender: string;
  readonly recipient: string;
}

export interface AcceptanceAssetBinding {
  readonly sourceToken: {
    readonly address: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly destinationToken: {
    readonly address: string;
    readonly decimals: number;
  };
}

export interface AcceptanceAmountBinding {
  readonly grossAmount: string;
  readonly protocolFee: string;
  readonly netDispatchedAmount: string;
  readonly destinationAmount: string;
  readonly railFee?: string | undefined;
}

export interface AcceptanceSourceProof {
  readonly txHash: string;
  readonly ledgerOrBlock: string;
  readonly confirmed: boolean;
}

export interface AcceptanceDestinationProof {
  readonly txHash: string;
  readonly blockOrLedger: string;
  readonly receiptStatus: "success" | "reverted";
  readonly confirmations: number;
  /** True only when canonical destination receipt, token event, and recipient balance were checked. */
  readonly independentlyVerifiedEvents: boolean;
  readonly verifiedRecipientAmount: string;
}

export interface AcceptanceTransferProof {
  readonly networkBinding: AcceptanceNetworkBinding;
  readonly partyBinding: AcceptancePartyBinding;
  readonly assetBinding: AcceptanceAssetBinding;
  readonly amountBinding: AcceptanceAmountBinding;
  readonly sourceProof: AcceptanceSourceProof;
  readonly destinationProof?: AcceptanceDestinationProof | undefined;
}

export interface SignedAcceptanceEvidenceV2 {
  readonly schemaVersion: typeof ACCEPTANCE_EVIDENCE_SCHEMA_VERSION;
  readonly evidenceOrigin: AcceptanceEvidenceOrigin;
  readonly claimedStatus: "delivered" | "pending" | "rehearsal";
  readonly verifiedAt: string;
  readonly transfers: readonly AcceptanceTransferProof[];
}

export interface AcceptanceEvidenceValidationResult {
  readonly valid: boolean;
  readonly classification: AcceptanceClassification;
  readonly delivered: boolean;
  readonly errors: readonly string[];
  readonly evidence: SignedAcceptanceEvidenceV2 | null;
}

export interface MigratedAcceptanceEvidenceResult {
  readonly formatDetected:
    "canonical-v2" | "legacy-its-v1" | "legacy-cctp-v1" | "legacy-conversion-v1";
  readonly migrated: SignedAcceptanceEvidenceV2;
  readonly migrationNotes: readonly string[];
}

function asObj(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

function isValidHex32(value: string): boolean {
  const clean = value.trim();
  return /^(0x)?[0-9a-fA-F]{64}$/.test(clean);
}

function isNonZeroAddressForFamily(
  address: string,
  family: "evm" | "stellar",
  allowContract: boolean,
): boolean {
  const trimmed = address.trim();
  if (family === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return false;
    return trimmed.toLowerCase() !== ZERO_EVM_ADDRESS;
  }
  if (!isStellarAddress(trimmed)) return false;
  if (trimmed === ZERO_STELLAR_ACCOUNT) return false;
  if (!allowContract && !trimmed.startsWith("G") && !trimmed.startsWith("M")) return false;
  return true;
}

function isValidTokenOrRouterAddress(
  address: string,
  family: "evm" | "stellar",
  mustBeContractOnStellar: boolean,
): boolean {
  const trimmed = address.trim();
  if (family === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return false;
    return trimmed.toLowerCase() !== ZERO_EVM_ADDRESS;
  }
  if (!isStellarAddress(trimmed)) return false;
  if (mustBeContractOnStellar && !trimmed.startsWith("C")) return false;
  return trimmed !== ZERO_STELLAR_ACCOUNT;
}

function parseNonNegativeBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function scaleAmountDecimals(
  amount: bigint,
  fromDecimals: number,
  toDecimals: number,
): bigint | null {
  if (fromDecimals === toDecimals) return amount;
  if (fromDecimals > toDecimals) {
    const diff = BigInt(fromDecimals - toDecimals);
    const factor = 10n ** diff;
    return amount / factor;
  }
  const diff = BigInt(toDecimals - fromDecimals);
  return amount * 10n ** diff;
}

function validateSingleTransfer(
  rawTransfer: unknown,
  index: number,
  origin: AcceptanceEvidenceOrigin,
  errors: string[],
): {
  readonly parsed: AcceptanceTransferProof | null;
  readonly destinationVerified: boolean;
  readonly usesLocalChain: boolean;
} {
  const prefix = `transfers[${String(index)}]`;
  const rec = asObj(rawTransfer);
  if (rec === null) {
    errors.push(`${prefix}: expected transfer proof object.`);
    return { parsed: null, destinationVerified: false, usesLocalChain: false };
  }

  const netObj = asObj(rec.networkBinding);
  const partyObj = asObj(rec.partyBinding);
  const assetObj = asObj(rec.assetBinding);
  const amtObj = asObj(rec.amountBinding);
  const srcObj = asObj(rec.sourceProof);

  if (!netObj || !partyObj || !assetObj || !amtObj || !srcObj) {
    errors.push(
      `${prefix}: explicit networkBinding, partyBinding, assetBinding, amountBinding, and sourceProof objects are required.`,
    );
    return { parsed: null, destinationVerified: false, usesLocalChain: false };
  }

  const sourceChainRaw = netObj.sourceChain;
  const destChainRaw = netObj.destinationChain;
  if (typeof sourceChainRaw !== "string" || !isChainKey(sourceChainRaw)) {
    errors.push(`${prefix}.networkBinding.sourceChain: unknown chain key.`);
    return { parsed: null, destinationVerified: false, usesLocalChain: false };
  }
  if (typeof destChainRaw !== "string" || !isChainKey(destChainRaw)) {
    errors.push(`${prefix}.networkBinding.destinationChain: unknown chain key.`);
    return { parsed: null, destinationVerified: false, usesLocalChain: false };
  }

  const sourceChain = CHAINS[sourceChainRaw];
  const destChain = CHAINS[destChainRaw];
  const usesLocalChain = sourceChainRaw === "local" || destChainRaw === "local";

  if (sourceChainRaw === destChainRaw) {
    errors.push(`${prefix}.networkBinding: sourceChain and destinationChain must differ.`);
  }
  if (sourceChain.network !== destChain.network) {
    errors.push(
      `${prefix}.networkBinding: cannot mix ${sourceChain.network} source "${sourceChainRaw}" with ${destChain.network} destination "${destChainRaw}".`,
    );
  }

  const routeRaw = netObj.route;
  if (typeof routeRaw !== "number" || !ROUTE_KINDS.includes(routeRaw as RouteKind)) {
    errors.push(`${prefix}.networkBinding.route: invalid RouteKind.`);
  }
  const route = (typeof routeRaw === "number" ? routeRaw : RouteKind.Cctp) as RouteKind;

  const routerRaw = typeof netObj.router === "string" ? netObj.router.trim() : "";
  if (!isValidTokenOrRouterAddress(routerRaw, sourceChain.family, true)) {
    errors.push(`${prefix}.networkBinding.router: invalid router address for ${sourceChainRaw}.`);
  }

  const senderRaw = typeof partyObj.sender === "string" ? partyObj.sender.trim() : "";
  if (!isNonZeroAddressForFamily(senderRaw, sourceChain.family, true)) {
    errors.push(`${prefix}.partyBinding.sender: explicit non-zero sender address required.`);
  }

  const recipientRaw = typeof partyObj.recipient === "string" ? partyObj.recipient.trim() : "";
  if (!isNonZeroAddressForFamily(recipientRaw, destChain.family, true)) {
    errors.push(`${prefix}.partyBinding.recipient: explicit non-zero recipient address required.`);
  }

  const srcTokenObj = asObj(assetObj.sourceToken);
  const dstTokenObj = asObj(assetObj.destinationToken);
  const srcTokenAddr = typeof srcTokenObj?.address === "string" ? srcTokenObj.address.trim() : "";
  const srcTokenSymbol = typeof srcTokenObj?.symbol === "string" ? srcTokenObj.symbol.trim() : "";
  const srcDecimals = typeof srcTokenObj?.decimals === "number" ? srcTokenObj.decimals : -1;
  const dstTokenAddr = typeof dstTokenObj?.address === "string" ? dstTokenObj.address.trim() : "";
  const dstDecimals = typeof dstTokenObj?.decimals === "number" ? dstTokenObj.decimals : -1;

  if (!isValidTokenOrRouterAddress(srcTokenAddr, sourceChain.family, true)) {
    errors.push(`${prefix}.assetBinding.sourceToken.address: invalid token contract address.`);
  }
  if (srcTokenSymbol.length === 0) {
    errors.push(`${prefix}.assetBinding.sourceToken.symbol: non-empty asset symbol required.`);
  }
  if (!Number.isInteger(srcDecimals) || srcDecimals < 0 || srcDecimals > 38) {
    errors.push(`${prefix}.assetBinding.sourceToken.decimals: invalid precision.`);
  }
  if (!isValidTokenOrRouterAddress(dstTokenAddr, destChain.family, true)) {
    errors.push(
      `${prefix}.assetBinding.destinationToken.address: invalid destination token address.`,
    );
  }
  if (!Number.isInteger(dstDecimals) || dstDecimals < 0 || dstDecimals > 38) {
    errors.push(`${prefix}.assetBinding.destinationToken.decimals: invalid precision.`);
  }

  const gross = parseNonNegativeBigInt(amtObj.grossAmount);
  const fee = parseNonNegativeBigInt(amtObj.protocolFee);
  const netDispatched = parseNonNegativeBigInt(amtObj.netDispatchedAmount);
  const destAmt = parseNonNegativeBigInt(amtObj.destinationAmount);
  const railFee = amtObj.railFee !== undefined ? parseNonNegativeBigInt(amtObj.railFee) : undefined;

  if (gross === null || gross <= 0n) {
    errors.push(`${prefix}.amountBinding.grossAmount: positive decimal integer string required.`);
  }
  if (fee === null) {
    errors.push(`${prefix}.amountBinding.protocolFee: decimal integer string required.`);
  }
  if (netDispatched === null || netDispatched <= 0n) {
    errors.push(
      `${prefix}.amountBinding.netDispatchedAmount: positive decimal integer string required.`,
    );
  }
  if (destAmt === null || destAmt <= 0n) {
    errors.push(
      `${prefix}.amountBinding.destinationAmount: positive decimal integer string required.`,
    );
  }
  if (amtObj.railFee !== undefined && railFee === null) {
    errors.push(`${prefix}.amountBinding.railFee: decimal integer string required when present.`);
  }
  if (gross !== null && fee !== null && netDispatched !== null && gross - fee !== netDispatched) {
    errors.push(
      `${prefix}.amountBinding: grossAmount (${String(gross)}) - protocolFee (${String(fee)}) must equal netDispatchedAmount (${String(netDispatched)}).`,
    );
  }
  if (
    netDispatched !== null &&
    destAmt !== null &&
    Number.isInteger(srcDecimals) &&
    srcDecimals >= 0 &&
    Number.isInteger(dstDecimals) &&
    dstDecimals >= 0
  ) {
    const scaledNet = scaleAmountDecimals(netDispatched, srcDecimals, dstDecimals);
    if (scaledNet !== null) {
      const effectiveRailFee = railFee ?? 0n;
      if (scaledNet - effectiveRailFee !== destAmt) {
        errors.push(
          `${prefix}.amountBinding: scaled netDispatchedAmount (${String(scaledNet)}) minus railFee (${String(effectiveRailFee)}) must equal destinationAmount (${String(destAmt)}).`,
        );
      }
    }
  }

  const srcTxHash = typeof srcObj.txHash === "string" ? srcObj.txHash.trim() : "";
  const srcBlock = parseNonNegativeBigInt(srcObj.ledgerOrBlock);
  const srcConfirmed = srcObj.confirmed === true;
  if (!isValidHex32(srcTxHash)) {
    errors.push(`${prefix}.sourceProof.txHash: 32-byte hex transaction hash required.`);
  }
  if (srcBlock === null || srcBlock <= 0n) {
    errors.push(`${prefix}.sourceProof.ledgerOrBlock: positive decimal integer string required.`);
  }
  if (!srcConfirmed && origin === "public-signed-acceptance") {
    errors.push(`${prefix}.sourceProof.confirmed: source transaction must be confirmed.`);
  }

  let destinationProof: AcceptanceDestinationProof | undefined;
  let destinationVerified = false;
  if (rec.destinationProof !== undefined && rec.destinationProof !== null) {
    const dstObj = asObj(rec.destinationProof);
    if (dstObj === null) {
      errors.push(`${prefix}.destinationProof: expected object when provided.`);
    } else {
      const dstTxHash = typeof dstObj.txHash === "string" ? dstObj.txHash.trim() : "";
      const dstBlock = parseNonNegativeBigInt(dstObj.blockOrLedger);
      const receiptStatus = dstObj.receiptStatus;
      const confirmations = typeof dstObj.confirmations === "number" ? dstObj.confirmations : -1;
      const indepEvents = dstObj.independentlyVerifiedEvents === true;
      const verifiedRecipientAmt = parseNonNegativeBigInt(dstObj.verifiedRecipientAmount);

      if (!isValidHex32(dstTxHash)) {
        errors.push(`${prefix}.destinationProof.txHash: 32-byte hex transaction hash required.`);
      }
      if (
        isValidHex32(srcTxHash) &&
        isValidHex32(dstTxHash) &&
        srcTxHash.replace(/^0x/i, "").toLowerCase() === dstTxHash.replace(/^0x/i, "").toLowerCase()
      ) {
        errors.push(
          `${prefix}.destinationProof.txHash: destination hash must be independent of sourceProof.txHash.`,
        );
      }
      if (dstBlock === null || dstBlock <= 0n) {
        errors.push(
          `${prefix}.destinationProof.blockOrLedger: positive decimal integer string required.`,
        );
      }
      if (receiptStatus !== "success" && receiptStatus !== "reverted") {
        errors.push(`${prefix}.destinationProof.receiptStatus: expected "success" or "reverted".`);
      }
      if (!Number.isInteger(confirmations) || confirmations < 0) {
        errors.push(`${prefix}.destinationProof.confirmations: non-negative integer required.`);
      }
      if (verifiedRecipientAmt === null) {
        errors.push(
          `${prefix}.destinationProof.verifiedRecipientAmount: decimal integer string required.`,
        );
      }

      if (
        isValidHex32(dstTxHash) &&
        dstBlock !== null &&
        dstBlock > 0n &&
        (receiptStatus === "success" || receiptStatus === "reverted") &&
        Number.isInteger(confirmations) &&
        confirmations >= 0 &&
        verifiedRecipientAmt !== null
      ) {
        destinationProof = {
          txHash: dstTxHash,
          blockOrLedger: dstBlock.toString(10),
          receiptStatus,
          confirmations,
          independentlyVerifiedEvents: indepEvents,
          verifiedRecipientAmount: verifiedRecipientAmt.toString(10),
        };
        destinationVerified =
          srcConfirmed &&
          receiptStatus === "success" &&
          confirmations >= 1 &&
          indepEvents &&
          destAmt !== null &&
          verifiedRecipientAmt === destAmt;
      }
    }
  }

  if (errors.length > 0) {
    return { parsed: null, destinationVerified: false, usesLocalChain };
  }

  return {
    parsed: {
      networkBinding: {
        sourceChain: sourceChainRaw,
        destinationChain: destChainRaw,
        route,
        router: routerRaw,
      },
      partyBinding: {
        sender: senderRaw,
        recipient: recipientRaw,
      },
      assetBinding: {
        sourceToken: {
          address: srcTokenAddr,
          symbol: srcTokenSymbol,
          decimals: srcDecimals,
        },
        destinationToken: {
          address: dstTokenAddr,
          decimals: dstDecimals,
        },
      },
      amountBinding: {
        grossAmount: (gross ?? 0n).toString(10),
        protocolFee: (fee ?? 0n).toString(10),
        netDispatchedAmount: (netDispatched ?? 0n).toString(10),
        destinationAmount: (destAmt ?? 0n).toString(10),
        ...(railFee !== undefined && railFee !== null ? { railFee: railFee.toString(10) } : {}),
      },
      sourceProof: {
        txHash: srcTxHash,
        ledgerOrBlock: (srcBlock ?? 0n).toString(10),
        confirmed: srcConfirmed,
      },
      ...(destinationProof !== undefined ? { destinationProof } : {}),
    },
    destinationVerified,
    usesLocalChain,
  };
}

export function validateAcceptanceEvidence(raw: unknown): AcceptanceEvidenceValidationResult {
  const errors: string[] = [];
  const rec = asObj(raw);
  if (rec === null) {
    return {
      valid: false,
      classification: "invalid",
      delivered: false,
      errors: ["Acceptance evidence root must be an object."],
      evidence: null,
    };
  }

  if (
    rec.evidenceKind === "local-fixture-rehearsal" ||
    rec.mock === true ||
    rec.evidenceOrigin === "mock-fixture"
  ) {
    const claimedDelivered = rec.claimedStatus === "delivered" || rec.status === "delivered";
    if (claimedDelivered) {
      errors.push("Mock or local rehearsal evidence cannot claim delivered acceptance status.");
    }
    if (rec.schemaVersion !== ACCEPTANCE_EVIDENCE_SCHEMA_VERSION) {
      return {
        valid: !claimedDelivered,
        classification: claimedDelivered ? "invalid" : "non-acceptance-mock",
        delivered: false,
        errors,
        evidence: null,
      };
    }
  }

  if (rec.schemaVersion !== ACCEPTANCE_EVIDENCE_SCHEMA_VERSION) {
    return {
      valid: false,
      classification: "invalid",
      delivered: false,
      errors: [
        `Expected schemaVersion ${String(ACCEPTANCE_EVIDENCE_SCHEMA_VERSION)}; migrate legacy evidence with migrateHistoricalAcceptanceEvidence first.`,
      ],
      evidence: null,
    };
  }

  const origin = rec.evidenceOrigin;
  if (
    origin !== "public-signed-acceptance" &&
    origin !== "source-only-checkpoint" &&
    origin !== "mock-fixture"
  ) {
    errors.push(
      'evidenceOrigin must be "public-signed-acceptance", "source-only-checkpoint", or "mock-fixture".',
    );
    return {
      valid: false,
      classification: "invalid",
      delivered: false,
      errors,
      evidence: null,
    };
  }

  const claimedStatus = rec.claimedStatus;
  if (
    claimedStatus !== "delivered" &&
    claimedStatus !== "pending" &&
    claimedStatus !== "rehearsal"
  ) {
    errors.push('claimedStatus must be "delivered", "pending", or "rehearsal".');
  }

  const verifiedAt = typeof rec.verifiedAt === "string" ? rec.verifiedAt : "";
  if (verifiedAt.length === 0 || Number.isNaN(Date.parse(verifiedAt))) {
    errors.push("verifiedAt must be a valid ISO 8601 timestamp.");
  }

  if (!Array.isArray(rec.transfers) || rec.transfers.length === 0) {
    errors.push("transfers must be a non-empty array of transfer proofs.");
    return {
      valid: false,
      classification: "invalid",
      delivered: false,
      errors,
      evidence: null,
    };
  }

  const rawTransfers = rec.transfers as readonly unknown[];
  const parsedTransfers: AcceptanceTransferProof[] = [];
  let allDestinationsVerified = true;
  let anyLocalChain = false;

  for (let i = 0; i < rawTransfers.length; i += 1) {
    const item = validateSingleTransfer(rawTransfers[i], i, origin, errors);
    if (item.parsed !== null) {
      parsedTransfers.push(item.parsed);
    }
    if (!item.destinationVerified) {
      allDestinationsVerified = false;
    }
    if (item.usesLocalChain) {
      anyLocalChain = true;
    }
  }

  if (origin === "mock-fixture" || anyLocalChain) {
    if (claimedStatus === "delivered") {
      errors.push("Mock fixtures or local-chain transfers cannot be classified as delivered.");
    }
    if (errors.length > 0) {
      return {
        valid: false,
        classification: "invalid",
        delivered: false,
        errors,
        evidence: null,
      };
    }
    return {
      valid: true,
      classification: "non-acceptance-mock",
      delivered: false,
      errors: [],
      evidence: {
        schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
        evidenceOrigin: origin,
        claimedStatus: claimedStatus as "pending" | "rehearsal",
        verifiedAt,
        transfers: parsedTransfers,
      },
    };
  }

  if (origin === "source-only-checkpoint") {
    if (claimedStatus === "delivered") {
      errors.push(
        "Source-only checkpoints lack independent destination verification and cannot claim delivered status.",
      );
    }
    if (errors.length > 0) {
      return {
        valid: false,
        classification: "invalid",
        delivered: false,
        errors,
        evidence: null,
      };
    }
    return {
      valid: true,
      classification: "pending-destination",
      delivered: false,
      errors: [],
      evidence: {
        schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
        evidenceOrigin: origin,
        claimedStatus: claimedStatus as "pending" | "rehearsal",
        verifiedAt,
        transfers: parsedTransfers,
      },
    };
  }

  // origin === "public-signed-acceptance"
  if (claimedStatus === "delivered" && !allDestinationsVerified) {
    errors.push(
      "Delivered status requires every transfer to include a confirmed canonical destination receipt with >=1 confirmation, independently verified events, and exact recipient amount.",
    );
  }

  if (errors.length > 0) {
    return {
      valid: false,
      classification: "invalid",
      delivered: false,
      errors,
      evidence: null,
    };
  }

  const isDelivered = claimedStatus === "delivered" && allDestinationsVerified;
  return {
    valid: true,
    classification: isDelivered ? "delivered" : "pending-destination",
    delivered: isDelivered,
    errors: [],
    evidence: {
      schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
      evidenceOrigin: origin,
      claimedStatus: claimedStatus as "delivered" | "pending" | "rehearsal",
      verifiedAt,
      transfers: parsedTransfers,
    },
  };
}

/**
 * Migrate historical acceptance evidence files (`2026-10-28-paid-its.json`,
 * `2026-10-29-cctp.json`, `2026-10-29-conversion.json`) to schemaVersion 2.
 */
export function migrateHistoricalAcceptanceEvidence(
  raw: unknown,
  options?: { readonly stellarUsdcSacId?: string | undefined },
): MigratedAcceptanceEvidenceResult {
  const rec = asObj(raw);
  if (rec === null) {
    throw new Error("Historical acceptance evidence must be a JSON object.");
  }

  if (rec.schemaVersion === ACCEPTANCE_EVIDENCE_SCHEMA_VERSION) {
    const validated = validateAcceptanceEvidence(rec);
    if (!validated.valid || validated.evidence === null) {
      throw new Error(`Invalid v2 acceptance evidence: ${validated.errors.join("; ")}`);
    }
    return {
      formatDetected: "canonical-v2",
      migrated: validated.evidence,
      migrationNotes: [],
    };
  }

  const sacIdFallback = options?.stellarUsdcSacId ?? DEFAULT_STELLAR_TESTNET_USDC_SAC;
  const notes: string[] = [];

  const acceptanceObj = asObj(rec.acceptance);

  // Shape 1: `2026-10-28-paid-its.json` (`schemaVersion: 1` with `acceptance.indexedTransfer` + `destinationReceipt`)
  if (acceptanceObj !== null && asObj(acceptanceObj.indexedTransfer) !== null) {
    const indexed = asObj(acceptanceObj.indexedTransfer);
    const origin = asObj(indexed?.origin);
    const dest = asObj(indexed?.destination);
    const receipt = asObj(acceptanceObj.destinationReceipt);
    const contracts = asObj(rec.contracts);

    const sourceChain = asText(origin?.chain ?? rec.network) as ChainKey;
    const destChain = asText(dest?.chain ?? acceptanceObj.destination) as ChainKey;
    const decimals = typeof origin?.decimals === "number" ? origin.decimals : 7;
    notes.push(
      "Migrated legacy ITS schemaVersion 1 file: bound destination token decimals to 7 (Stellar-origin ITS representation on EVM).",
    );

    const migrated: SignedAcceptanceEvidenceV2 = {
      schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
      evidenceOrigin: "public-signed-acceptance",
      claimedStatus: acceptanceObj.status === "delivered" ? "delivered" : "pending",
      verifiedAt:
        typeof dest?.deliveredAt === "string"
          ? dest.deliveredAt
          : typeof rec.activatedAt === "string"
            ? rec.activatedAt
            : new Date(0).toISOString(),
      transfers: [
        {
          networkBinding: {
            sourceChain,
            destinationChain: destChain,
            route: (typeof indexed?.route === "number"
              ? indexed.route
              : RouteKind.AxelarIts) as RouteKind,
            router: asText(acceptanceObj.router ?? contracts?.router),
          },
          partyBinding: {
            sender: asText(acceptanceObj.sender ?? origin?.sender),
            recipient: asText(acceptanceObj.recipient),
          },
          assetBinding: {
            sourceToken: {
              address: asText(origin?.token, sacIdFallback),
              symbol: asText(origin?.symbol, "USDC"),
              decimals,
            },
            destinationToken: {
              address: asText(receipt?.token),
              decimals,
            },
          },
          amountBinding: {
            grossAmount: asText(acceptanceObj.grossAmount ?? origin?.grossAmount),
            protocolFee: asText(acceptanceObj.fee ?? origin?.fee),
            netDispatchedAmount: asText(origin?.netAmount ?? acceptanceObj.destinationAmount),
            destinationAmount: asText(acceptanceObj.destinationAmount),
          },
          sourceProof: {
            txHash: asText(acceptanceObj.sourceHash ?? origin?.txHash),
            ledgerOrBlock: asText(origin?.block),
            confirmed: true,
          },
          destinationProof: {
            txHash: asText(acceptanceObj.destinationHash ?? dest?.txHash),
            blockOrLedger: asText(receipt?.block ?? dest?.block),
            receiptStatus: receipt?.status === "success" ? "success" : "reverted",
            confirmations: Number(receipt?.confirmationsAtIndependentCheck ?? 0),
            independentlyVerifiedEvents: dest?.delivered === true && receipt?.status === "success",
            verifiedRecipientAmount: asText(receipt?.recipientBalance),
          },
        },
      ],
    };
    return {
      formatDetected: "legacy-its-v1",
      migrated,
      migrationNotes: notes,
    };
  }

  // Shape 2: `2026-10-29-cctp.json` (`acceptance.transfers` array)
  if (acceptanceObj !== null && Array.isArray(acceptanceObj.transfers)) {
    const sourceChain: ChainKey =
      rec.network === "testnet" || rec.network === "stellar-testnet"
        ? "stellar-testnet"
        : "stellar";
    notes.push(
      `Migrated legacy CCTP multi-destination file: normalized network "${asText(rec.network)}" to "${sourceChain}" and bound canonical Stellar USDC SAC ${sacIdFallback}.`,
    );
    const rawList = acceptanceObj.transfers as readonly unknown[];
    const transfers: AcceptanceTransferProof[] = rawList.map((entry) => {
      const tr = asObj(entry) ?? {};
      const destAmtStr = asText(tr.destinationAmount);
      const fwdFee = typeof tr.forwardingFee === "string" ? tr.forwardingFee : undefined;
      return {
        networkBinding: {
          sourceChain,
          destinationChain: asText(tr.destination) as ChainKey,
          route: RouteKind.Cctp,
          router: asText(rec.router),
        },
        partyBinding: {
          sender: asText(tr.sender),
          recipient: asText(tr.recipient),
        },
        assetBinding: {
          sourceToken: {
            address: sacIdFallback,
            symbol: "USDC",
            decimals: Number(tr.sourceDecimals ?? 7),
          },
          destinationToken: {
            address: asText(tr.destinationToken),
            decimals: Number(tr.destinationDecimals ?? 6),
          },
        },
        amountBinding: {
          grossAmount: asText(tr.grossAmount),
          protocolFee: asText(tr.protocolFee),
          netDispatchedAmount: asText(tr.burnAmount),
          destinationAmount: destAmtStr,
          ...(fwdFee !== undefined ? { railFee: fwdFee } : {}),
        },
        sourceProof: {
          txHash: asText(tr.sourceHash),
          ledgerOrBlock: asText(tr.sourceLedger),
          confirmed: Boolean(tr.sourceConfirmedAt),
        },
        destinationProof: {
          txHash: asText(tr.destinationHash),
          blockOrLedger: asText(tr.destinationBlock),
          receiptStatus: tr.status === "delivered" ? "success" : "reverted",
          confirmations: Number(tr.confirmationsAtVerification ?? 0),
          independentlyVerifiedEvents:
            tr.status === "delivered" &&
            typeof tr.destinationBlockHash === "string" &&
            tr.destinationBlockHash.length > 0,
          verifiedRecipientAmount: destAmtStr,
        },
      };
    });

    return {
      formatDetected: "legacy-cctp-v1",
      migrated: {
        schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
        evidenceOrigin: "public-signed-acceptance",
        claimedStatus: acceptanceObj.status === "delivered" ? "delivered" : "pending",
        verifiedAt: asText(acceptanceObj.verifiedAt, new Date(0).toISOString()),
        transfers,
      },
      migrationNotes: notes,
    };
  }

  // Shape 3: `2026-10-29-conversion.json` (flat conversion + bridge proof)
  if (typeof rec.sourceHash === "string" && typeof rec.bridgeAmount === "string") {
    notes.push(
      `Migrated legacy conversion proof: bound sourceChain="stellar-testnet", sourceToken=${sacIdFallback} (7 decimals), and mapped receiptStatus="success" to confirmations=1.`,
    );
    const migrated: SignedAcceptanceEvidenceV2 = {
      schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
      evidenceOrigin: "public-signed-acceptance",
      claimedStatus: rec.status === "delivered" ? "delivered" : "pending",
      verifiedAt: asText(rec.verifiedAt, new Date(0).toISOString()),
      transfers: [
        {
          networkBinding: {
            sourceChain: "stellar-testnet",
            destinationChain: asText(rec.destination) as ChainKey,
            route: Number(rec.route ?? RouteKind.AxelarIts) as RouteKind,
            router: asText(rec.router),
          },
          partyBinding: {
            sender: asText(rec.sender),
            recipient: asText(rec.recipient),
          },
          assetBinding: {
            sourceToken: {
              address: sacIdFallback,
              symbol: "USDC",
              decimals: 7,
            },
            destinationToken: {
              address: asText(rec.destinationToken),
              decimals: 7,
            },
          },
          amountBinding: {
            grossAmount: rec.bridgeAmount,
            protocolFee: asText(rec.sourceFee),
            netDispatchedAmount: asText(rec.destinationAmount),
            destinationAmount: asText(rec.destinationAmount),
          },
          sourceProof: {
            txHash: rec.sourceHash,
            ledgerOrBlock: asText(rec.sourceLedger),
            confirmed: true,
          },
          destinationProof: {
            txHash: asText(rec.destinationHash),
            blockOrLedger: asText(rec.destinationBlock),
            receiptStatus: rec.receiptStatus === "success" ? "success" : "reverted",
            confirmations: rec.receiptStatus === "success" ? 1 : 0,
            independentlyVerifiedEvents:
              rec.receiptStatus === "success" && typeof rec.actualReceived === "string",
            verifiedRecipientAmount: asText(rec.actualReceived),
          },
        },
      ],
    };
    return {
      formatDetected: "legacy-conversion-v1",
      migrated,
      migrationNotes: notes,
    };
  }

  throw new Error("Unrecognized legacy acceptance evidence structure.");
}
