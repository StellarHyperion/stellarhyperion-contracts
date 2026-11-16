import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
  migrateHistoricalAcceptanceEvidence,
  RouteKind,
  validateAcceptanceEvidence,
  type SignedAcceptanceEvidenceV2,
} from "../src/index.js";
import { C_ADDR, EVM_RECIPIENT, G_ADDR, ZERO_ACCOUNT } from "./fixtures.js";

function validV2Evidence(): SignedAcceptanceEvidenceV2 {
  return {
    schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
    evidenceOrigin: "public-signed-acceptance",
    claimedStatus: "delivered",
    verifiedAt: "2026-10-29T10:17:56.015Z",
    transfers: [
      {
        networkBinding: {
          sourceChain: "stellar-testnet",
          destinationChain: "sepolia",
          route: RouteKind.Cctp,
          router: C_ADDR,
        },
        partyBinding: {
          sender: G_ADDR,
          recipient: EVM_RECIPIENT,
        },
        assetBinding: {
          sourceToken: {
            address: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
            symbol: "USDC",
            decimals: 7,
          },
          destinationToken: {
            address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            decimals: 6,
          },
        },
        amountBinding: {
          // Above 2^53 to prove exact bigint string arithmetic (90071992547409930 -> 6 decimals: 9007199254740993)
          grossAmount: "90071992547419930",
          protocolFee: "10000",
          netDispatchedAmount: "90071992547409930",
          railFee: "30",
          destinationAmount: "9007199254740963",
        },
        sourceProof: {
          txHash: "a".repeat(64),
          ledgerOrBlock: "5448984",
          confirmed: true,
        },
        destinationProof: {
          txHash: `0x${"b".repeat(64)}`,
          blockOrLedger: "12018814",
          receiptStatus: "success",
          confirmations: 12,
          independentlyVerifiedEvents: true,
          verifiedRecipientAmount: "9007199254740963",
        },
      },
    ],
  };
}

describe("validateAcceptanceEvidence and migrateHistoricalAcceptanceEvidence", () => {
  it("enforces explicit recipient, asset, exact-integer amount, and network bindings", () => {
    const ok = validateAcceptanceEvidence(validV2Evidence());
    expect(ok.valid).toBe(true);
    expect(ok.classification).toBe("delivered");
    expect(ok.delivered).toBe(true);

    // Zero EVM recipient or zero Stellar sender is rejected.
    const base = validV2Evidence();
    const zeroRecipient = validateAcceptanceEvidence({
      ...base,
      transfers: [
        {
          ...base.transfers[0]!,
          partyBinding: {
            sender: ZERO_ACCOUNT,
            recipient: "0x0000000000000000000000000000000000000000",
          },
        },
      ],
    });
    expect(zeroRecipient.valid).toBe(false);
    expect(zeroRecipient.delivered).toBe(false);
    expect(zeroRecipient.errors.join(" ")).toContain("partyBinding.sender");
    expect(zeroRecipient.errors.join(" ")).toContain("partyBinding.recipient");

    // Mixing testnet source with mainnet destination or breaking exact fee conservation fails.
    const mismatchedNetAndAmount = validateAcceptanceEvidence({
      ...base,
      transfers: [
        {
          ...base.transfers[0]!,
          networkBinding: {
            ...base.transfers[0]!.networkBinding,
            destinationChain: "ethereum",
          },
          amountBinding: {
            ...base.transfers[0]!.amountBinding,
            destinationAmount: "9007199254740999",
          },
        },
      ],
    });
    expect(mismatchedNetAndAmount.valid).toBe(false);
    expect(mismatchedNetAndAmount.delivered).toBe(false);
    expect(mismatchedNetAndAmount.errors.join(" ")).toContain("cannot mix testnet source");
    expect(mismatchedNetAndAmount.errors.join(" ")).toContain("destinationAmount");
  });

  it("prevents source-only checkpoints, forwarding-API-only statuses, and mock fixtures from classifying as delivered", () => {
    const base = validV2Evidence();
    const first = base.transfers[0]!;

    // 1. Source-only checkpoint claiming pending -> valid pending-destination, NOT delivered.
    const sourceOnlyTransfer = {
      networkBinding: first.networkBinding,
      partyBinding: first.partyBinding,
      assetBinding: first.assetBinding,
      amountBinding: first.amountBinding,
      sourceProof: first.sourceProof,
    };
    const sourceOnlyPending = validateAcceptanceEvidence({
      ...base,
      evidenceOrigin: "source-only-checkpoint",
      claimedStatus: "pending",
      transfers: [sourceOnlyTransfer],
    });
    expect(sourceOnlyPending.valid).toBe(true);
    expect(sourceOnlyPending.classification).toBe("pending-destination");
    expect(sourceOnlyPending.delivered).toBe(false);

    // 2. Source-only evidence claiming delivered -> rejected as invalid.
    const sourceOnlyClaimingDelivered = validateAcceptanceEvidence({
      ...base,
      evidenceOrigin: "source-only-checkpoint",
      claimedStatus: "delivered",
      transfers: [sourceOnlyTransfer],
    });
    expect(sourceOnlyClaimingDelivered.valid).toBe(false);
    expect(sourceOnlyClaimingDelivered.delivered).toBe(false);

    // 3. Forwarding-API-only status without independent destination event check -> rejected when claiming delivered.
    const forwardingOnly = validateAcceptanceEvidence({
      ...base,
      transfers: [
        {
          ...first,
          destinationProof: {
            ...first.destinationProof!,
            independentlyVerifiedEvents: false,
          },
        },
      ],
    });
    expect(forwardingOnly.valid).toBe(false);
    expect(forwardingOnly.delivered).toBe(false);

    // 4. Mock fixture or local rehearsal report -> never delivered.
    const mockRehearsal = validateAcceptanceEvidence({
      ...base,
      evidenceOrigin: "mock-fixture",
      claimedStatus: "rehearsal",
    });
    expect(mockRehearsal.valid).toBe(true);
    expect(mockRehearsal.classification).toBe("non-acceptance-mock");
    expect(mockRehearsal.delivered).toBe(false);

    const mockClaimingDelivered = validateAcceptanceEvidence({
      ...base,
      evidenceOrigin: "mock-fixture",
      claimedStatus: "delivered",
    });
    expect(mockClaimingDelivered.valid).toBe(false);
    expect(mockClaimingDelivered.delivered).toBe(false);

    const rehearsalArtifact = validateAcceptanceEvidence({
      evidenceKind: "local-fixture-rehearsal",
      signedTestnetAcceptance: false,
      status: "delivered",
    });
    expect(rehearsalArtifact.valid).toBe(false);
    expect(rehearsalArtifact.delivered).toBe(false);
  });

  it("migrates all existing historical evidence files cleanly to valid v2 delivered proofs", () => {
    const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
    const files = [
      {
        path: "deployments/evidence/2026-10-28-paid-its.json",
        expectedFormat: "legacy-its-v1",
        expectedCount: 1,
      },
      {
        path: "deployments/evidence/2026-10-29-cctp.json",
        expectedFormat: "legacy-cctp-v1",
        expectedCount: 3,
      },
      {
        path: "deployments/evidence/2026-10-29-conversion.json",
        expectedFormat: "legacy-conversion-v1",
        expectedCount: 1,
      },
    ] as const;

    for (const entry of files) {
      const raw = JSON.parse(readFileSync(resolve(repoRoot, entry.path), "utf8")) as unknown;
      const migrated = migrateHistoricalAcceptanceEvidence(raw);
      expect(migrated.formatDetected).toBe(entry.expectedFormat);
      expect(migrated.migrationNotes.length).toBeGreaterThan(0);
      expect(migrated.migrated.transfers).toHaveLength(entry.expectedCount);

      const validation = validateAcceptanceEvidence(migrated.migrated);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
      expect(validation.classification).toBe("delivered");
      expect(validation.delivered).toBe(true);
    }
  });
});
