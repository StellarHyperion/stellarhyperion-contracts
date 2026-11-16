import { describe, expect, it } from "vitest";
import {
  ROUTER_EVENT_SCHEMA_VERSION,
  RouterEventFormatError,
  RouteKind,
  inspectProviderStatusNotice,
  inspectRouterEvent,
  inspectTransferEvidence,
  isPayoutProofEvent,
  tryInspectTransferEvidence,
} from "../src/index.js";
import { C_ADDR, G_ADDR } from "./fixtures.js";

const EVM_SENDER = "0x1111111111111111111111111111111111111111";
const EVM_TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const EVM_PADDED_RECIPIENT_WORD =
  "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8";
const SAMPLE_BYTES32 = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("raw contract-event inspection API", () => {
  it("preserves full-width u64 nonces and i128/u256 amounts across Soroban and EVM events", () => {
    const maxU64 = (1n << 64n) - 1n;
    const aboveSafeInt = (1n << 53n) + 1n;
    const maxSorobanI128 = (1n << 127n) - 1n;
    const wideEvmAmount = (1n << 200n) + 987654321n;

    const sorobanOut = inspectRouterEvent({
      schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
      family: "soroban",
      kind: "BridgeOut",
      route: RouteKind.Cctp,
      sender: G_ADDR,
      token: C_ADDR,
      nonce: maxU64.toString(),
      grossAmount: maxSorobanI128.toString(),
      fee: "1000000",
      netAmount: (maxSorobanI128 - 1000000n).toString(),
      destinationChain: "sepolia",
      destination: EVM_PADDED_RECIPIENT_WORD,
      railRef: SAMPLE_BYTES32,
    });

    expect(sorobanOut.kind).toBe("BridgeOut");
    if (sorobanOut.kind === "BridgeOut") {
      expect(sorobanOut.identity.nonce).toBe(maxU64);
      expect(sorobanOut.amounts.grossAmount).toBe(maxSorobanI128);
      expect(sorobanOut.amounts.netAmount).toBe(maxSorobanI128 - 1000000n);
      expect(sorobanOut.identity.destinationRecipient).toBe(
        "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      );
      expect(sorobanOut.payoutProven).toBe(false);
    }

    const evmIn = inspectRouterEvent({
      schemaVersion: 1,
      family: "evm",
      kind: "BridgeIn",
      route: "axelar-its",
      recipient: EVM_SENDER,
      token: EVM_TOKEN,
      amount: wideEvmAmount,
      sourceChain: "stellar-testnet",
      sourceNonce: aboveSafeInt,
      messageId: SAMPLE_BYTES32,
    });

    expect(evmIn.kind).toBe("BridgeIn");
    expect(isPayoutProofEvent(evmIn)).toBe(true);
    if (evmIn.kind === "BridgeIn") {
      expect(evmIn.amount).toBe(wideEvmAmount);
      expect(evmIn.identity.sourceNonce).toBe(aboveSafeInt);
      expect(evmIn.token).toBe(EVM_TOKEN.toLowerCase());
      expect(evmIn.payoutProven).toBe(true);
    }
  });

  it("never mislabels provider status notices, outbound dispatches, or parked claims as payout proof", () => {
    for (const providerStatus of [
      "pending",
      "attested",
      "inflight",
      "relayed",
      "executed_at_gateway",
      "failed",
      "unknown",
    ] as const) {
      const notice = inspectProviderStatusNotice({
        schemaVersion: 1,
        kind: "ProviderStatus",
        route: "cctp",
        providerStatus,
        sourceChain: "stellar-testnet",
        sourceNonce: "42",
        messageId: SAMPLE_BYTES32,
        observedAmount: "10000000",
      });
      expect(notice.payoutProven).toBe(false);
      expect(notice.evidenceClass).toBe("provider_status_not_payout_proof");
      expect(isPayoutProofEvent(notice)).toBe(false);
    }

    // Attempting to spoof payoutProven=true on a provider notice is rejected at $.payoutProven.
    expect(() =>
      inspectProviderStatusNotice({
        schemaVersion: 1,
        kind: "ProviderStatus",
        route: "cctp",
        providerStatus: "attested",
        payoutProven: true,
      }),
    ).toThrow(RouterEventFormatError);

    // Passing ProviderStatus directly to inspectRouterEvent is rejected so callers cannot treat it
    // as an on-chain router log.
    expect(() =>
      inspectRouterEvent({
        schemaVersion: 1,
        kind: "ProviderStatus",
        route: "cctp",
        providerStatus: "attested",
      }),
    ).toThrow(RouterEventFormatError);

    // Soroban BridgeIn with delivered=false and ClaimParked remain payoutProven=false, whereas
    // ClaimSettled marks payoutProven=true.
    const undeliveredIn = inspectTransferEvidence({
      schemaVersion: 1,
      family: "soroban",
      kind: "BridgeIn",
      route: RouteKind.AxelarIts,
      recipient: G_ADDR,
      token: C_ADDR,
      amount: 50_000_000n,
      sourceChain: "sepolia",
      sourceNonce: 9n,
      delivered: false,
      claimId: 77n,
    });
    expect(undeliveredIn.payoutProven).toBe(false);
    expect(undeliveredIn.settlementStage).toBe("parked_claim");

    const parked = inspectRouterEvent({
      schemaVersion: 1,
      family: "soroban",
      kind: "ClaimParked",
      claimId: "77",
      recipient: G_ADDR,
      token: C_ADDR,
      amount: "50000000",
      route: RouteKind.AxelarIts,
      sourceChain: "sepolia",
      sourceNonce: "9",
    });
    expect(parked.payoutProven).toBe(false);

    const settled = inspectRouterEvent({
      schemaVersion: 1,
      family: "soroban",
      kind: "ClaimSettled",
      claimId: "77",
      recipient: G_ADDR,
      token: C_ADDR,
      amount: "50000000",
      settledBy: G_ADDR,
    });
    expect(settled.payoutProven).toBe(true);
    expect(isPayoutProofEvent(settled)).toBe(true);
  });

  it("produces precise field-path diagnostics on unsupported versions, unsafe numbers, and broken payloads", () => {
    const badVersion = tryInspectTransferEvidence({
      schemaVersion: 2,
      family: "soroban",
      kind: "PauseSet",
      paused: true,
      actor: G_ADDR,
    });
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) {
      expect(badVersion.error.path).toBe("$.schemaVersion");
    }

    const unsafeNumber = tryInspectTransferEvidence({
      schemaVersion: 1,
      family: "evm",
      kind: "ClaimSettled",
      claimId: Number.MAX_SAFE_INTEGER + 2,
      recipient: EVM_SENDER,
      token: EVM_TOKEN,
      amount: "100",
      settledBy: EVM_SENDER,
    });
    expect(unsafeNumber.ok).toBe(false);
    if (!unsafeNumber.ok) {
      expect(unsafeNumber.error.path).toBe("$.claimId");
    }

    const badConservation = tryInspectTransferEvidence({
      schemaVersion: 1,
      family: "evm",
      kind: "BridgeOut",
      payload: {
        route: 0,
        sender: EVM_SENDER,
        token: EVM_TOKEN,
        nonce: "1",
        grossAmount: "1000",
        fee: "10",
        netAmount: "980",
        destinationChain: "stellar-testnet",
        destinationAddress: G_ADDR,
      },
    });
    expect(badConservation.ok).toBe(false);
    if (!badConservation.ok) {
      expect(badConservation.error.path).toBe("$.payload.grossAmount");
    }

    const badTimelock = tryInspectTransferEvidence({
      schemaVersion: 1,
      family: "soroban",
      kind: "ActionQueued",
      actionId: "5",
      eta: "2000",
      expiresAt: "2000",
    });
    expect(badTimelock.ok).toBe(false);
    if (!badTimelock.ok) {
      expect(badTimelock.error.path).toBe("$.expiresAt");
    }
  });
});
