/**
 * Read-only reconciliation between encoded Hyperion Axelar notes and candidate ITS payment events.
 *
 * Both outbound (Stellar to EVM) and inbound (EVM to Stellar) notes carry an eight byte router
 * nonce so human operators can spot related rows in a UI, while actual rail authenticity and
 * replay protection depend on the full command identity, token id, exact integer amount, and
 * decoded recipient. This module joins source note records with candidate destination receipts
 * using only those four authoritative bindings and preserves all raw chain references verbatim.
 */
import { type AddressKind, parseStellarAddress } from "./addresses.js";
import { convertDecimals } from "./amounts.js";
import { bytesToBigInt, fromHex, slice, toHex } from "./bytes.js";
import type { Hex } from "./bytes.js";
import { decodeInboundNote, decodeOutboundNote, METADATA_CONTRACT_CALL } from "./notes.js";

export type ReconciliationDirection = "stellar-to-evm" | "evm-to-stellar";

export type ReconciliationDiscrepancyCode =
  | "malformed_source_note"
  | "invalid_source_token_id"
  | "invalid_source_command_identity"
  | "inexact_source_amount"
  | "no_candidate_receipts"
  | "recipient_mismatch"
  | "token_id_mismatch"
  | "amount_mismatch"
  | "command_identity_mismatch"
  | "receipt_not_executed"
  | "ambiguous_duplicate_receipts";

export interface AxelarSourceRawReferences {
  readonly sourceTxHash: string;
  readonly sourceEventId: string;
  readonly sourceChain: string;
  readonly axelarSourceChain: string;
  readonly axelarMessageId: string;
  readonly expectedCommandId: Hex;
  readonly rawNoteHex: Hex;
}

export interface AxelarDestinationRawReferences {
  readonly destinationTxHash: string;
  readonly destinationEventId: string;
  readonly commandId: Hex;
  readonly axelarMessageId: string;
  readonly rawSourceChain: string;
  readonly rawSourceAddressHex?: Hex;
}

export interface AxelarSourceNoteRecord {
  readonly recordId: string;
  readonly direction: ReconciliationDirection;
  readonly rawReferences: AxelarSourceRawReferences;
  readonly tokenId: Hex;
  readonly sourceAmount: bigint;
  readonly sourceDecimals?: number;
  readonly destinationDecimals?: number;
  readonly expectedDestinationAmount?: bigint;
}

export interface CandidateItsPaymentEvent {
  readonly receiptId: string;
  readonly rawReferences: AxelarDestinationRawReferences;
  readonly tokenId: Hex;
  readonly recipient: string;
  readonly amount: bigint;
  readonly executed: boolean;
  /** Informational UI nonce if emitted on destination; never consulted for verification. */
  readonly observedDisplayNonce?: bigint;
}

export interface DecodedNoteSummary {
  readonly intendedRecipient: string;
  readonly stellarAddressKind: AddressKind | null;
  /** Informational router sequence carried inside the note; never used as a join key. */
  readonly nonAuthoritativeDisplayNonce: bigint;
}

export interface EvaluatedCandidateReceipt {
  readonly receiptId: string;
  readonly rawReferences: AxelarDestinationRawReferences;
  readonly normalizedRecipient: string | null;
  readonly normalizedTokenId: Hex | null;
  readonly normalizedCommandId: Hex | null;
  readonly amount: bigint;
  readonly executed: boolean;
  readonly observedDisplayNonce: bigint | null;
  readonly matchedAllBindings: boolean;
  readonly discrepancies: readonly ReconciliationDiscrepancyCode[];
}

export interface AxelarNoteReconciliationEntry {
  readonly recordId: string;
  readonly direction: ReconciliationDirection;
  readonly status: "verified" | "unverified";
  readonly sourceRawReferences: AxelarSourceRawReferences;
  readonly decodedNote: DecodedNoteSummary | null;
  readonly expectedTokenId: Hex | null;
  readonly expectedCommandId: Hex | null;
  readonly sourceAmount: bigint;
  readonly expectedDestinationAmount: bigint | null;
  readonly verifiedReceiptId: string | null;
  readonly verifiedDestinationRawReferences: AxelarDestinationRawReferences | null;
  readonly discrepancies: readonly ReconciliationDiscrepancyCode[];
  readonly evaluatedReceipts: readonly EvaluatedCandidateReceipt[];
}

export interface AxelarReconciliationBatchReport {
  readonly totalRecords: number;
  readonly verifiedCount: number;
  readonly unverifiedCount: number;
  readonly allVerified: boolean;
  readonly entries: readonly AxelarNoteReconciliationEntry[];
}

function normalizeFixedHex(value: string, byteLength: number): Hex | null {
  try {
    const bytes = fromHex(value);
    if (bytes.length !== byteLength) return null;
    if (bytesToBigInt(bytes) === 0n) return null;
    return toHex(bytes);
  } catch {
    return null;
  }
}

function normalizeRecipientForDirection(
  direction: ReconciliationDirection,
  recipient: string,
): string | null {
  if (direction === "stellar-to-evm") {
    return normalizeFixedHex(recipient, 20);
  }
  try {
    parseStellarAddress(recipient);
    return recipient;
  } catch {
    return null;
  }
}

function stripAxelarMetadataEnvelope(rawBytes: Uint8Array): Uint8Array | null {
  if (rawBytes.length >= 4 && rawBytes[0] === 0 && rawBytes[1] === 0 && rawBytes[2] === 0) {
    if (rawBytes[3] === METADATA_CONTRACT_CALL) {
      return slice(rawBytes, 4, rawBytes.length);
    }
  }
  return rawBytes;
}

/**
 * Decode the destination recipient from a raw Hyperion Axelar note without trusting its nonce.
 */
export function decodeAxelarNoteIntent(
  direction: ReconciliationDirection,
  rawNoteHex: Hex,
): DecodedNoteSummary | null {
  try {
    const rawBytes = fromHex(rawNoteHex);
    if (direction === "stellar-to-evm") {
      const decoded = decodeOutboundNote(rawBytes);
      return {
        intendedRecipient: decoded.recipient,
        stellarAddressKind: null,
        nonAuthoritativeDisplayNonce: decoded.nonce,
      };
    }

    const unwrapped = stripAxelarMetadataEnvelope(rawBytes);
    if (unwrapped === null) return null;
    const decoded = decodeInboundNote(unwrapped);
    return {
      intendedRecipient: decoded.strkey,
      stellarAddressKind: decoded.kind,
      nonAuthoritativeDisplayNonce: decoded.nonce,
    };
  } catch {
    return null;
  }
}

function resolveExpectedDestinationAmount(source: AxelarSourceNoteRecord): bigint | null {
  if (source.sourceAmount <= 0n) return null;

  let derivedAmount = source.sourceAmount;
  if (source.sourceDecimals !== undefined || source.destinationDecimals !== undefined) {
    if (source.sourceDecimals === undefined || source.destinationDecimals === undefined) {
      return null;
    }
    try {
      const scaled = convertDecimals(
        source.sourceAmount,
        source.sourceDecimals,
        source.destinationDecimals,
      );
      if (scaled.dust !== 0n) return null;
      derivedAmount = scaled.converted;
    } catch {
      return null;
    }
  }

  if (derivedAmount <= 0n) return null;
  if (
    source.expectedDestinationAmount !== undefined &&
    source.expectedDestinationAmount !== derivedAmount
  ) {
    return null;
  }
  return source.expectedDestinationAmount ?? derivedAmount;
}

function pushUnique(
  target: ReconciliationDiscrepancyCode[],
  code: ReconciliationDiscrepancyCode,
): void {
  if (!target.includes(code)) {
    target.push(code);
  }
}

/**
 * Reconcile one source note record against candidate ITS payment events.
 *
 * A record is reported `verified` if and only if recipient, token id, exact integer destination
 * amount, and full command identity (`commandId`, `axelarMessageId`, and `axelarSourceChain`) all
 * agree on a single executed receipt. Display nonces are never used to establish or rescue matches.
 */
export function reconcileAxelarNoteRecord(
  source: AxelarSourceNoteRecord,
  candidates: readonly CandidateItsPaymentEvent[],
): AxelarNoteReconciliationEntry {
  const recordDiscrepancies: ReconciliationDiscrepancyCode[] = [];

  const decodedNote = decodeAxelarNoteIntent(source.direction, source.rawReferences.rawNoteHex);
  if (decodedNote === null) {
    pushUnique(recordDiscrepancies, "malformed_source_note");
  }

  const expectedTokenId = normalizeFixedHex(source.tokenId, 32);
  if (expectedTokenId === null) {
    pushUnique(recordDiscrepancies, "invalid_source_token_id");
  }

  const expectedCommandId = normalizeFixedHex(source.rawReferences.expectedCommandId, 32);
  const hasMessageId = source.rawReferences.axelarMessageId.trim().length > 0;
  const hasSourceChain = source.rawReferences.axelarSourceChain.trim().length > 0;
  if (expectedCommandId === null || !hasMessageId || !hasSourceChain) {
    pushUnique(recordDiscrepancies, "invalid_source_command_identity");
  }

  const expectedDestinationAmount = resolveExpectedDestinationAmount(source);
  if (expectedDestinationAmount === null) {
    pushUnique(recordDiscrepancies, "inexact_source_amount");
  }

  if (candidates.length === 0) {
    pushUnique(recordDiscrepancies, "no_candidate_receipts");
  }

  const evaluatedReceipts: EvaluatedCandidateReceipt[] = candidates.map((candidate) => {
    const itemIssues: ReconciliationDiscrepancyCode[] = [];
    const normalizedRecipient = normalizeRecipientForDirection(
      source.direction,
      candidate.recipient,
    );
    const normalizedTokenId = normalizeFixedHex(candidate.tokenId, 32);
    const normalizedCommandId = normalizeFixedHex(candidate.rawReferences.commandId, 32);

    if (
      decodedNote === null ||
      normalizedRecipient === null ||
      normalizedRecipient !== decodedNote.intendedRecipient
    ) {
      pushUnique(itemIssues, "recipient_mismatch");
    }

    if (
      expectedTokenId === null ||
      normalizedTokenId === null ||
      normalizedTokenId !== expectedTokenId
    ) {
      pushUnique(itemIssues, "token_id_mismatch");
    }

    if (
      expectedDestinationAmount === null ||
      candidate.amount <= 0n ||
      candidate.amount !== expectedDestinationAmount
    ) {
      pushUnique(itemIssues, "amount_mismatch");
    }

    const commandMatches =
      expectedCommandId !== null &&
      normalizedCommandId !== null &&
      normalizedCommandId === expectedCommandId &&
      hasMessageId &&
      hasSourceChain &&
      candidate.rawReferences.axelarMessageId === source.rawReferences.axelarMessageId &&
      candidate.rawReferences.rawSourceChain === source.rawReferences.axelarSourceChain;
    if (!commandMatches) {
      pushUnique(itemIssues, "command_identity_mismatch");
    }

    if (!candidate.executed) {
      pushUnique(itemIssues, "receipt_not_executed");
    }

    return {
      receiptId: candidate.receiptId,
      rawReferences: candidate.rawReferences,
      normalizedRecipient,
      normalizedTokenId,
      normalizedCommandId,
      amount: candidate.amount,
      executed: candidate.executed,
      observedDisplayNonce: candidate.observedDisplayNonce ?? null,
      matchedAllBindings: itemIssues.length === 0,
      discrepancies: itemIssues,
    };
  });

  const matchingReceipts = evaluatedReceipts.filter((item) => item.matchedAllBindings);

  if (recordDiscrepancies.length === 0 && matchingReceipts.length === 1) {
    const winner = matchingReceipts[0];
    if (winner !== undefined) {
      return {
        recordId: source.recordId,
        direction: source.direction,
        status: "verified",
        sourceRawReferences: source.rawReferences,
        decodedNote,
        expectedTokenId,
        expectedCommandId,
        sourceAmount: source.sourceAmount,
        expectedDestinationAmount,
        verifiedReceiptId: winner.receiptId,
        verifiedDestinationRawReferences: winner.rawReferences,
        discrepancies: [],
        evaluatedReceipts,
      };
    }
  }

  if (matchingReceipts.length > 1) {
    pushUnique(recordDiscrepancies, "ambiguous_duplicate_receipts");
  } else {
    for (const receipt of evaluatedReceipts) {
      for (const issue of receipt.discrepancies) {
        pushUnique(recordDiscrepancies, issue);
      }
    }
  }

  return {
    recordId: source.recordId,
    direction: source.direction,
    status: "unverified",
    sourceRawReferences: source.rawReferences,
    decodedNote,
    expectedTokenId,
    expectedCommandId,
    sourceAmount: source.sourceAmount,
    expectedDestinationAmount,
    verifiedReceiptId: null,
    verifiedDestinationRawReferences: null,
    discrepancies: recordDiscrepancies,
    evaluatedReceipts,
  };
}

export interface AxelarReconciliationPairInput {
  readonly source: AxelarSourceNoteRecord;
  readonly candidates: readonly CandidateItsPaymentEvent[];
}

/**
 * Reconcile a batch of source note records against candidate ITS payment receipts.
 */
export function reconcileAxelarBatch(
  pairs: readonly AxelarReconciliationPairInput[],
): AxelarReconciliationBatchReport {
  const entries = pairs.map((pair) => reconcileAxelarNoteRecord(pair.source, pair.candidates));
  const verifiedCount = entries.filter((entry) => entry.status === "verified").length;
  const unverifiedCount = entries.length - verifiedCount;
  return {
    totalRecords: entries.length,
    verifiedCount,
    unverifiedCount,
    allVerified: unverifiedCount === 0,
    entries,
  };
}
