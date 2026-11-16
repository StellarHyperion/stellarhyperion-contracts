import { fromHex, toHex } from "./bytes.js";

export type AllbridgeAuditStatus = "verified" | "unresolved-trust-assumption" | "inconsistent";

export interface AllbridgeSignedInboundIntentInput {
  readonly token: string;
  readonly receiveTokenHex: string;
  readonly amount: bigint | string;
  readonly recipient: string;
  readonly recipientBytesHex: string;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly nonce: bigint | string;
  readonly messageIdHex: string;
  readonly validatorPublicKeyHex: string;
  readonly signatureHex: string;
  readonly signatureValid?: boolean;
}

export interface AllbridgeSourceProviderEvidenceInput {
  readonly sourceTxHash: string;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly recipientBytesHex: string;
  readonly receiveTokenHex: string;
  readonly amount: bigint | string;
  readonly nonce: bigint | string;
  readonly messageIdHex: string;
}

export interface AllbridgeOnChainPayoutInput {
  readonly mode: "direct" | "parked-claim";
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint | string;
  readonly route: string;
  readonly adapterProcessed: boolean;
  readonly routerProcessed: boolean;
  readonly claimId?: bigint | string;
}

export interface AllbridgeInboundAuditInput {
  readonly signedIntent: AllbridgeSignedInboundIntentInput;
  readonly sourceProviderEvidence?: AllbridgeSourceProviderEvidenceInput | null;
  readonly payoutRecord?: AllbridgeOnChainPayoutInput | null;
}

export interface AllbridgeAuditInconsistency {
  readonly field:
    "signature" | "amount" | "recipient" | "token" | "chain" | "nonce" | "messageId" | "payout";
  readonly detail: string;
}

export interface AllbridgeInboundAuditReport {
  readonly status: AllbridgeAuditStatus;
  readonly verified: boolean;
  readonly trustModel: "configured-validator-corroborated" | "configured-validator-only";
  readonly unresolvedTrustAssumptions: readonly string[];
  readonly inconsistencies: readonly AllbridgeAuditInconsistency[];
}

const UINT256_MAX = (1n << 256n) - 1n;
const INT128_MAX = (1n << 127n) - 1n;
const ZERO_HEX_32 = "0x" + "00".repeat(32);
const ZERO_HEX_64 = "0x" + "00".repeat(64);

function parsePositiveAmount(raw: bigint | string, label: string): bigint {
  const value = typeof raw === "bigint" ? raw : parseDecimalBigInt(raw, label);
  if (value <= 0n || value > INT128_MAX) {
    throw new RangeError(`${label} must be in 1..=${String(INT128_MAX)}`);
  }
  return value;
}

function parseUint256(raw: bigint | string, label: string): bigint {
  const value = typeof raw === "bigint" ? raw : parseDecimalBigInt(raw, label);
  if (value < 0n || value > UINT256_MAX) {
    throw new RangeError(`${label} must fit in uint256`);
  }
  return value;
}

function parseDecimalBigInt(raw: string, label: string): bigint {
  if (!/^[0-9]+$/.test(raw)) {
    throw new RangeError(`${label} must be a base-10 integer string`);
  }
  return BigInt(raw);
}

function normalizeHex32(hex: string, label: string): string {
  const bytes = fromHex(hex);
  if (bytes.length !== 32) {
    throw new RangeError(`${label} must be 32 bytes`);
  }
  return toHex(bytes);
}

function normalizeHex64(hex: string, label: string): string {
  const trimmed = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    throw new RangeError(`${label} must be a 64-byte hex string`);
  }
  return "0x" + trimmed.toLowerCase();
}

/**
 * Read-only comparison of a signed Allbridge validator intent against independent
 * source-chain provider evidence and on-chain Hyperion router payout records.
 *
 * Missing independent source evidence is always surfaced as `unresolved-trust-assumption`
 * rather than `verified`. Never submits payouts or mutates validator state.
 */
export function auditAllbridgeInboundEvidence(
  input: AllbridgeInboundAuditInput,
): AllbridgeInboundAuditReport {
  const { signedIntent, sourceProviderEvidence, payoutRecord } = input;
  const intentAmount = parsePositiveAmount(signedIntent.amount, "signedIntent.amount");
  const intentNonce = parseUint256(signedIntent.nonce, "signedIntent.nonce");
  const intentRecipientHex = normalizeHex32(
    signedIntent.recipientBytesHex,
    "signedIntent.recipientBytesHex",
  );
  const intentReceiveTokenHex = normalizeHex32(
    signedIntent.receiveTokenHex,
    "signedIntent.receiveTokenHex",
  );
  const intentMessageIdHex = normalizeHex32(signedIntent.messageIdHex, "signedIntent.messageIdHex");
  const validatorPkHex = normalizeHex32(
    signedIntent.validatorPublicKeyHex,
    "signedIntent.validatorPublicKeyHex",
  );
  const signatureHex = normalizeHex64(signedIntent.signatureHex, "signedIntent.signatureHex");

  const inconsistencies: AllbridgeAuditInconsistency[] = [];
  const unresolved: string[] = [];

  if (
    validatorPkHex === ZERO_HEX_32 ||
    signatureHex === ZERO_HEX_64 ||
    signedIntent.signatureValid === false
  ) {
    inconsistencies.push({
      field: "signature",
      detail: "Validator key is empty, signature is all-zero, or signature verification failed",
    });
  }

  const msgFirstTwo = intentMessageIdHex.slice(2, 6);
  const expectedFirstTwo =
    (signedIntent.sourceChainId & 0xff).toString(16).padStart(2, "0") +
    (signedIntent.destinationChainId & 0xff).toString(16).padStart(2, "0");
  if (
    !Number.isInteger(signedIntent.sourceChainId) ||
    signedIntent.sourceChainId <= 0 ||
    signedIntent.sourceChainId > 255 ||
    !Number.isInteger(signedIntent.destinationChainId) ||
    signedIntent.destinationChainId <= 0 ||
    signedIntent.destinationChainId > 255 ||
    msgFirstTwo !== expectedFirstTwo
  ) {
    inconsistencies.push({
      field: "chain",
      detail:
        "Stamped chain header bytes in messageIdHex do not match source/destination chain IDs",
    });
  }

  if (payoutRecord == null) {
    inconsistencies.push({
      field: "payout",
      detail: "Missing on-chain router payout or parked-claim record",
    });
  } else {
    const payoutAmount = parsePositiveAmount(payoutRecord.amount, "payoutRecord.amount");
    if (payoutRecord.recipient !== signedIntent.recipient) {
      inconsistencies.push({
        field: "recipient",
        detail: `On-chain payout recipient ${payoutRecord.recipient} disagrees with signed intent ${signedIntent.recipient}`,
      });
    }
    if (payoutAmount !== intentAmount) {
      inconsistencies.push({
        field: "amount",
        detail: `On-chain payout amount ${String(payoutAmount)} disagrees with signed intent ${String(intentAmount)}`,
      });
    }
    if (payoutRecord.token !== signedIntent.token) {
      inconsistencies.push({
        field: "token",
        detail: `On-chain payout token ${payoutRecord.token} disagrees with signed intent ${signedIntent.token}`,
      });
    }
    if (
      payoutRecord.route !== "allbridge" ||
      !payoutRecord.adapterProcessed ||
      !payoutRecord.routerProcessed
    ) {
      inconsistencies.push({
        field: "payout",
        detail: "On-chain route tag or adapter/router replay-processed flags are incomplete",
      });
    }
    if (payoutRecord.mode === "parked-claim") {
      const claimId =
        payoutRecord.claimId === undefined
          ? 0n
          : parseUint256(payoutRecord.claimId, "payoutRecord.claimId");
      if (claimId <= 0n) {
        inconsistencies.push({
          field: "payout",
          detail: "Parked-claim payout record must carry a positive claimId",
        });
      }
    }
  }

  if (sourceProviderEvidence == null) {
    unresolved.push(
      "missing-independent-source-provider-evidence: inbound validity relies solely on configured Allbridge validator key",
    );
  } else {
    const srcAmount = parsePositiveAmount(
      sourceProviderEvidence.amount,
      "sourceProviderEvidence.amount",
    );
    const srcNonce = parseUint256(sourceProviderEvidence.nonce, "sourceProviderEvidence.nonce");
    const srcRecipientHex = normalizeHex32(
      sourceProviderEvidence.recipientBytesHex,
      "sourceProviderEvidence.recipientBytesHex",
    );
    const srcReceiveTokenHex = normalizeHex32(
      sourceProviderEvidence.receiveTokenHex,
      "sourceProviderEvidence.receiveTokenHex",
    );
    const srcMessageIdHex = normalizeHex32(
      sourceProviderEvidence.messageIdHex,
      "sourceProviderEvidence.messageIdHex",
    );

    if (sourceProviderEvidence.sourceTxHash.trim().length === 0) {
      unresolved.push("missing-source-transaction-reference");
    }
    if (srcRecipientHex !== intentRecipientHex) {
      inconsistencies.push({
        field: "recipient",
        detail: `Source provider recipient ${srcRecipientHex} disagrees with signed intent ${intentRecipientHex}`,
      });
    }
    if (srcAmount !== intentAmount) {
      inconsistencies.push({
        field: "amount",
        detail: `Source provider amount ${String(srcAmount)} disagrees with signed intent ${String(intentAmount)}`,
      });
    }
    if (srcReceiveTokenHex !== intentReceiveTokenHex) {
      inconsistencies.push({
        field: "token",
        detail: "Source provider receiveTokenHex disagrees with signed intent",
      });
    }
    if (
      sourceProviderEvidence.sourceChainId !== signedIntent.sourceChainId ||
      sourceProviderEvidence.destinationChainId !== signedIntent.destinationChainId
    ) {
      inconsistencies.push({
        field: "chain",
        detail: "Source provider chain IDs disagree with signed intent",
      });
    }
    if (srcNonce !== intentNonce) {
      inconsistencies.push({
        field: "nonce",
        detail: "Source provider full-width uint256 nonce disagrees with signed intent",
      });
    }
    if (srcMessageIdHex !== intentMessageIdHex) {
      inconsistencies.push({
        field: "messageId",
        detail: "Source provider 32-byte messageIdHex disagrees with signed intent",
      });
    }
  }

  if (inconsistencies.length > 0) {
    return {
      status: "inconsistent",
      verified: false,
      trustModel:
        sourceProviderEvidence == null
          ? "configured-validator-only"
          : "configured-validator-corroborated",
      unresolvedTrustAssumptions: unresolved,
      inconsistencies,
    };
  }

  if (unresolved.length > 0) {
    return {
      status: "unresolved-trust-assumption",
      verified: false,
      trustModel: "configured-validator-only",
      unresolvedTrustAssumptions: unresolved,
      inconsistencies: [],
    };
  }

  return {
    status: "verified",
    verified: true,
    trustModel: "configured-validator-corroborated",
    unresolvedTrustAssumptions: [],
    inconsistencies: [],
  };
}
