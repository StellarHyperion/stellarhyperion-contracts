import { describe, expect, it } from "vitest";

import { AddressKind, encodeStellarAddress } from "../src/addresses.js";
import {
  type AxelarSourceNoteRecord,
  type CandidateItsPaymentEvent,
  decodeAxelarNoteIntent,
  reconcileAxelarBatch,
  reconcileAxelarNoteRecord,
} from "../src/axelarReconciliation.js";
import { toHex } from "../src/bytes.js";
import type { Hex } from "../src/bytes.js";
import { encodeAxelarMetadata, encodeInboundNote, encodeOutboundNote } from "../src/notes.js";

function bytes32Filled(byte: number): Hex {
  return toHex(new Uint8Array(32).fill(byte));
}

function evmAddressFilled(byte: number): Hex {
  return toHex(new Uint8Array(20).fill(byte));
}

describe("Axelar source-note and destination-payment reconciliation", () => {
  const tokenId = bytes32Filled(0xaa);
  const wrongTokenId = bytes32Filled(0xbb);
  const commandId = bytes32Filled(0x11);
  const wrongCommandId = bytes32Filled(0x22);
  const sourceTxRef = `${bytes32Filled(0x33)}:log-0`;
  const destinationTxRef = `${bytes32Filled(0x44)}:log-7`;
  const axelarMessageId = `${bytes32Filled(0x55)}-0`;

  const evmRecipient = evmAddressFilled(0x7a);
  const wrongEvmRecipient = evmAddressFilled(0x7b);

  const stellarMuxedRecipient = encodeStellarAddress(
    AddressKind.MuxedAccount,
    new Uint8Array(32).fill(0x61),
    9_001_002_003n,
  );
  const stellarSameKeyDifferentSubAccount = encodeStellarAddress(
    AddressKind.MuxedAccount,
    new Uint8Array(32).fill(0x61),
    9_001_002_004n,
  );

  function buildOutboundSource(
    overrides: Partial<AxelarSourceNoteRecord> = {},
  ): AxelarSourceNoteRecord {
    const rawNoteHex = toHex(encodeOutboundNote(evmRecipient, 42n));
    return {
      recordId: "out-42",
      direction: "stellar-to-evm",
      rawReferences: {
        sourceTxHash: sourceTxRef,
        sourceEventId: "stellar-testnet:ledger-88102:ev-2",
        sourceChain: "stellar-testnet",
        axelarSourceChain: "stellar-2025-q1",
        axelarMessageId,
        expectedCommandId: commandId,
        rawNoteHex,
      },
      tokenId,
      sourceAmount: 25_000_000n,
      sourceDecimals: 7,
      destinationDecimals: 6,
      ...overrides,
    };
  }

  function buildOutboundCandidate(
    overrides: Partial<CandidateItsPaymentEvent> = {},
  ): CandidateItsPaymentEvent {
    return {
      receiptId: "rcpt-evm-1",
      rawReferences: {
        destinationTxHash: destinationTxRef,
        destinationEventId: "base-sepolia:block-12004:log-7",
        commandId,
        axelarMessageId,
        rawSourceChain: "stellar-2025-q1",
      },
      tokenId,
      recipient: evmRecipient.toUpperCase().replace("0X", "0x"),
      amount: 2_500_000n,
      executed: true,
      ...overrides,
    };
  }

  it("verifies an outbound Stellar-to-EVM note when recipient, token id, amount, and command identity all agree", () => {
    const source = buildOutboundSource();
    const candidate = buildOutboundCandidate();

    const report = reconcileAxelarNoteRecord(source, [candidate]);
    expect(report.status).toBe("verified");
    expect(report.discrepancies).toEqual([]);
    expect(report.verifiedReceiptId).toBe("rcpt-evm-1");
    expect(report.expectedDestinationAmount).toBe(2_500_000n);
    // Original raw references are retained verbatim without relying on a display nonce.
    expect(report.sourceRawReferences).toEqual(source.rawReferences);
    expect(report.verifiedDestinationRawReferences).toEqual(candidate.rawReferences);
    expect(report.decodedNote?.nonAuthoritativeDisplayNonce).toBe(42n);
    expect(report.evaluatedReceipts[0]?.observedDisplayNonce).toBeNull();
  });

  it("verifies an inbound EVM-to-Stellar Axelar metadata envelope including muxed sub-account identity", () => {
    const wrappedNoteHex = toHex(
      encodeAxelarMetadata(encodeInboundNote(stellarMuxedRecipient, 99n)),
    );
    const decoded = decodeAxelarNoteIntent("evm-to-stellar", wrappedNoteHex);
    expect(decoded).toEqual({
      intendedRecipient: stellarMuxedRecipient,
      stellarAddressKind: AddressKind.MuxedAccount,
      nonAuthoritativeDisplayNonce: 99n,
    });

    const source: AxelarSourceNoteRecord = {
      recordId: "in-99",
      direction: "evm-to-stellar",
      rawReferences: {
        sourceTxHash: sourceTxRef,
        sourceEventId: "base-sepolia:tx-77:log-3",
        sourceChain: "base-sepolia",
        axelarSourceChain: "base-sepolia",
        axelarMessageId,
        expectedCommandId: commandId,
        rawNoteHex: wrappedNoteHex,
      },
      tokenId,
      sourceAmount: 1_250_000n,
      sourceDecimals: 6,
      destinationDecimals: 7,
    };

    const matchingCandidate: CandidateItsPaymentEvent = {
      receiptId: "rcpt-stellar-1",
      rawReferences: {
        destinationTxHash: destinationTxRef,
        destinationEventId: "stellar-testnet:ledger-99210:ev-1",
        commandId,
        axelarMessageId,
        rawSourceChain: "base-sepolia",
      },
      tokenId,
      recipient: stellarMuxedRecipient,
      amount: 12_500_000n,
      executed: true,
      observedDisplayNonce: 777_777n, // Deliberately different display nonce cannot invalidate or forge 4-way truth.
    };

    const entry = reconcileAxelarNoteRecord(source, [matchingCandidate]);
    expect(entry.status).toBe("verified");
    expect(entry.expectedDestinationAmount).toBe(12_500_000n);
    expect(entry.verifiedReceiptId).toBe("rcpt-stellar-1");

    // Changing only the muxed sub-account ID on the same underlying Ed25519 key must fail recipient binding.
    const wrongSubAccount = reconcileAxelarNoteRecord(source, [
      { ...matchingCandidate, recipient: stellarSameKeyDifferentSubAccount },
    ]);
    expect(wrongSubAccount.status).toBe("unverified");
    expect(wrongSubAccount.discrepancies).toContain("recipient_mismatch");
  });

  it("reports partial or mismatched receipts unverified even when display nonces match", () => {
    const source = buildOutboundSource();

    const wrongRecipient = buildOutboundCandidate({
      receiptId: "bad-recipient",
      recipient: wrongEvmRecipient,
      observedDisplayNonce: 42n,
    });
    const wrongToken = buildOutboundCandidate({
      receiptId: "bad-token",
      tokenId: wrongTokenId,
      observedDisplayNonce: 42n,
    });
    const wrongAmount = buildOutboundCandidate({
      receiptId: "bad-amount",
      amount: 2_499_999n,
      observedDisplayNonce: 42n,
    });
    const wrongCommand = buildOutboundCandidate({
      receiptId: "bad-command",
      rawReferences: {
        destinationTxHash: destinationTxRef,
        destinationEventId: "base-sepolia:block-12004:log-8",
        commandId: wrongCommandId,
        axelarMessageId,
        rawSourceChain: "stellar-2025-q1",
      },
      observedDisplayNonce: 42n,
    });
    const unexecutedReceipt = buildOutboundCandidate({
      receiptId: "unexecuted",
      executed: false,
      observedDisplayNonce: 42n,
    });

    const report = reconcileAxelarNoteRecord(source, [
      wrongRecipient,
      wrongToken,
      wrongAmount,
      wrongCommand,
      unexecutedReceipt,
    ]);

    expect(report.status).toBe("unverified");
    expect(report.verifiedReceiptId).toBeNull();
    expect(report.discrepancies).toEqual([
      "recipient_mismatch",
      "token_id_mismatch",
      "amount_mismatch",
      "command_identity_mismatch",
      "receipt_not_executed",
    ]);
    expect(report.evaluatedReceipts).toHaveLength(5);
    expect(report.sourceRawReferences).toEqual(source.rawReferences);
  });

  it("rejects non-representable decimal dust, malformed notes, missing receipts, and duplicate winners", () => {
    const dustySource = buildOutboundSource({
      recordId: "dusty",
      sourceAmount: 25_000_003n, // 7 decimals -> 6 decimals loses 3 stroops of dust.
    });
    const dustyReport = reconcileAxelarNoteRecord(dustySource, [buildOutboundCandidate()]);
    expect(dustyReport.status).toBe("unverified");
    expect(dustyReport.discrepancies).toContain("inexact_source_amount");

    const malformedSource = buildOutboundSource({
      recordId: "bad-note",
      rawReferences: {
        ...buildOutboundSource().rawReferences,
        rawNoteHex: "0x01deadbeef",
      },
    });
    const malformedReport = reconcileAxelarNoteRecord(malformedSource, []);
    expect(malformedReport.status).toBe("unverified");
    expect(malformedReport.discrepancies).toEqual([
      "malformed_source_note",
      "no_candidate_receipts",
    ]);

    const duplicateReport = reconcileAxelarBatch([
      {
        source: buildOutboundSource({ recordId: "dup" }),
        candidates: [
          buildOutboundCandidate({ receiptId: "r-1" }),
          buildOutboundCandidate({ receiptId: "r-2" }),
        ],
      },
    ]);
    expect(duplicateReport.allVerified).toBe(false);
    expect(duplicateReport.unverifiedCount).toBe(1);
    expect(duplicateReport.entries[0]?.discrepancies).toContain("ambiguous_duplicate_receipts");
  });
});
