import { describe, expect, it } from "vitest";
import {
  auditAllbridgeInboundEvidence,
  type AllbridgeInboundAuditInput,
} from "../src/allbridgeEvidenceAudit.js";
import { C_ADDR, G_ADDR, USDC_MAINNET_ISSUER } from "./fixtures.js";

function validAuditBundle(): AllbridgeInboundAuditInput {
  const recipientBytesHex = "0x" + "11".repeat(32);
  const receiveTokenHex = "0x" + "22".repeat(32);
  const messageIdHex = "0x0107" + "33".repeat(30);
  const validatorPublicKeyHex = "0x" + "44".repeat(32);
  const signatureHex = "0x" + "55".repeat(64);
  const fullNonce = ((1n << 200n) + 99n).toString(10);

  return {
    signedIntent: {
      token: C_ADDR,
      receiveTokenHex,
      amount: "1000000000",
      recipient: G_ADDR,
      recipientBytesHex,
      sourceChainId: 1,
      destinationChainId: 7,
      nonce: fullNonce,
      messageIdHex,
      validatorPublicKeyHex,
      signatureHex,
      signatureValid: true,
    },
    sourceProviderEvidence: {
      sourceTxHash: "0x" + "aa".repeat(32),
      sourceChainId: 1,
      destinationChainId: 7,
      recipientBytesHex,
      receiveTokenHex,
      amount: "1000000000",
      nonce: fullNonce,
      messageIdHex,
    },
    payoutRecord: {
      mode: "parked-claim",
      recipient: G_ADDR,
      token: C_ADDR,
      amount: "1000000000",
      route: "allbridge",
      adapterProcessed: true,
      routerProcessed: true,
      claimId: "1",
    },
  };
}

describe("auditAllbridgeInboundEvidence", () => {
  it("verifies when signed intent, independent source evidence, and payout all agree", () => {
    const bundle = validAuditBundle();
    const snapshot = structuredClone(bundle);
    const report = auditAllbridgeInboundEvidence(bundle);

    expect(report.status).toBe("verified");
    expect(report.verified).toBe(true);
    expect(report.trustModel).toBe("configured-validator-corroborated");
    expect(report.unresolvedTrustAssumptions).toEqual([]);
    expect(report.inconsistencies).toEqual([]);
    expect(bundle).toEqual(snapshot);
  });

  it("surfaces missing independent source provider evidence as an unresolved trust assumption", () => {
    const bundle: AllbridgeInboundAuditInput = {
      ...validAuditBundle(),
      sourceProviderEvidence: null,
    };
    const report = auditAllbridgeInboundEvidence(bundle);

    expect(report.status).toBe("unresolved-trust-assumption");
    expect(report.verified).toBe(false);
    expect(report.trustModel).toBe("configured-validator-only");
    expect(report.unresolvedTrustAssumptions.length).toBeGreaterThan(0);
  });

  it("blocks verified status on amount or recipient inconsistencies across source and payout", () => {
    const base = validAuditBundle();
    const src = base.sourceProviderEvidence;
    const payout = base.payoutRecord;
    if (src == null || payout == null) {
      throw new Error("expected populated validAuditBundle");
    }
    const sourceMismatch = auditAllbridgeInboundEvidence({
      ...base,
      sourceProviderEvidence: {
        ...src,
        amount: "999999999",
        recipientBytesHex: "0x" + "99".repeat(32),
      },
    });
    expect(sourceMismatch.status).toBe("inconsistent");
    expect(sourceMismatch.verified).toBe(false);
    expect(sourceMismatch.inconsistencies.map((i) => i.field)).toContain("amount");
    expect(sourceMismatch.inconsistencies.map((i) => i.field)).toContain("recipient");

    const payoutMismatch = auditAllbridgeInboundEvidence({
      ...base,
      payoutRecord: {
        ...payout,
        recipient: USDC_MAINNET_ISSUER,
        amount: "1000000001",
      },
    });
    expect(payoutMismatch.status).toBe("inconsistent");
    expect(payoutMismatch.verified).toBe(false);
    expect(payoutMismatch.inconsistencies.map((i) => i.field)).toContain("amount");
    expect(payoutMismatch.inconsistencies.map((i) => i.field)).toContain("recipient");
  });

  it("rejects malformed external amounts and nonces at integer boundaries", () => {
    const base = validAuditBundle();
    expect(() =>
      auditAllbridgeInboundEvidence({
        ...base,
        signedIntent: { ...base.signedIntent, amount: "0" },
      }),
    ).toThrow(RangeError);
    expect(() =>
      auditAllbridgeInboundEvidence({
        ...base,
        signedIntent: { ...base.signedIntent, nonce: (1n << 256n).toString(10) },
      }),
    ).toThrow(RangeError);
  });
});
