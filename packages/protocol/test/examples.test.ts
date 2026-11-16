import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AddressKind } from "../src/addresses.js";
import { concatBytes, fromHex } from "../src/bytes.js";
import type { Hex } from "../src/bytes.js";
import {
  BURN_HOOK_DATA,
  BURN_MESSAGE_VERSION,
  FINALITY_THRESHOLD_FINALIZED,
  MESSAGE_VERSION,
  MSG_BODY,
  STELLAR_DOMAIN,
} from "../src/cctp.js";
import { DeploymentFormatError } from "../src/deployments.js";
import type {
  DeploymentManifestReader,
  RouterSnapshotReader,
  TransferEvidenceBundle,
  TransferEvidenceReader,
} from "../src/examples.js";
import {
  runEvidenceInspectionExample,
  runQuoteLadderPlanningExample,
  runStellarOutboundPlanningExample,
} from "../src/examples.js";
import { encodeCctpHook, encodeInboundNote, encodeOutboundNote, toWord } from "../src/notes.js";
import type { RouterSnapshot } from "../src/quotes.js";
import { MAX_QUOTE_AMOUNT, QuoteBlocker } from "../src/quotes.js";
import { RouteKind } from "../src/routes.js";
import { EVM_RECIPIENT, G_ADDR, MUXED_ID, M_ADDR } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const phase1ManifestPath = resolve(
  here,
  "..",
  "..",
  "..",
  "deployments",
  "stellar-testnet-phase1.json",
);

function u32(value: number): Uint8Array {
  return fromHex(`0x${value.toString(16).padStart(8, "0")}`);
}

function word(hex: string): Uint8Array {
  return fromHex(`0x${hex.replace(/^0x/, "").padStart(64, "0")}`);
}

function buildMockCctpPacket(options: {
  readonly amount: bigint;
  readonly mintRecipientHex: string;
  readonly hook?: Uint8Array | undefined;
  readonly nonceHex?: string | undefined;
  readonly sourceDomain?: number | undefined;
  readonly destinationDomain?: number | undefined;
  readonly finalityExecuted?: number | undefined;
}): Uint8Array {
  const body = new Uint8Array(BURN_HOOK_DATA);
  body.set(u32(BURN_MESSAGE_VERSION), 0);
  body.set(word("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), 4);
  body.set(word(options.mintRecipientHex), 36);
  body.set(word(options.amount.toString(16)), 68);
  body.set(word("1111111111111111111111111111111111111111"), 100);
  body.set(word("0"), 132);
  body.set(word("0"), 164);
  body.set(word("0"), 196);
  const fullBody = options.hook === undefined ? body : concatBytes(body, options.hook);

  const header = new Uint8Array(MSG_BODY);
  header.set(u32(MESSAGE_VERSION), 0);
  header.set(u32(options.sourceDomain ?? 0), 4);
  header.set(u32(options.destinationDomain ?? STELLAR_DOMAIN), 8);
  header.set(word(options.nonceHex ?? `${"ab".repeat(24)}0020000000000001`), 12);
  header.set(word("28b5a0e9c621a5badaa536219b3a228c8168cf5d"), 44);
  header.set(word("431871229103b780868f8c6bb820cd16ecf942bc"), 76);
  header.set(word("0"), 108);
  header.set(u32(FINALITY_THRESHOLD_FINALIZED), 140);
  header.set(u32(options.finalityExecuted ?? FINALITY_THRESHOLD_FINALIZED), 144);
  return concatBytes(header, fullBody);
}

function phase1ManifestReader(): DeploymentManifestReader {
  const parsed: unknown = JSON.parse(readFileSync(phase1ManifestPath, "utf8"));
  return {
    readDeploymentManifest: () => parsed,
  };
}

function mockSnapshotReader(overrides: Partial<RouterSnapshot> = {}): RouterSnapshotReader {
  return {
    readRouterSnapshot: () => ({
      paused: false,
      feeBps: 30,
      routeEnabled: {
        [RouteKind.Cctp]: true,
        [RouteKind.AxelarIts]: true,
        [RouteKind.AxelarGmp]: true,
        [RouteKind.Allbridge]: true,
      },
      adapterSet: {
        [RouteKind.Cctp]: true,
        [RouteKind.AxelarIts]: true,
        [RouteKind.AxelarGmp]: true,
        [RouteKind.Allbridge]: true,
      },
      tokenRegistered: true,
      tokenEnabled: true,
      tokenDecimals: 7,
      flowAvailable: {
        [RouteKind.Cctp]: 10_000_000_000_000n,
        [RouteKind.AxelarIts]: 10_000_000_000_000n,
        [RouteKind.AxelarGmp]: 10_000_000_000_000n,
        [RouteKind.Allbridge]: 10_000_000_000_000n,
      },
      chainSupported: {
        [RouteKind.Cctp]: true,
        [RouteKind.AxelarIts]: true,
        [RouteKind.AxelarGmp]: true,
        [RouteKind.Allbridge]: true,
      },
      ...overrides,
    }),
  };
}

describe("injected client planning examples", () => {
  it("plans Stellar Testnet -> Sepolia outbound USDC while gating unvalidated rails", async () => {
    const result = await runStellarOutboundPlanningExample(
      {
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        symbol: "USDC",
        evmRecipient: EVM_RECIPIENT,
        amount: "100.0000009",
        previewNonce: MUXED_ID,
      },
      {
        manifests: phase1ManifestReader(),
        snapshots: mockSnapshotReader(),
      },
    );

    expect(result.stage).toBe("local_planning_only");
    expect(result.deploymentGate).toBe("validated_stellar_testnet_outbound");
    expect(result.executionPermitted).toBe(true);
    expect(result.requiresOnChainQuoteConfirmation).toBe(true);
    expect(result.signedExecutionPerformed).toBe(false);
    expect(result.payoutProven).toBe(false);
    expect(result.requestedAmount).toBe(1_000_000_009n);

    // 1_000_000_009 * 30 / 10_000 = 3_000_000 fee; netRaw = 997_000_009 -> floored to 997_000_000 (9 stroops dust retained)
    const cctp = result.rails.find((r) => r.route === RouteKind.Cctp)!;
    const its = result.rails.find((r) => r.route === RouteKind.AxelarIts)!;
    const gmp = result.rails.find((r) => r.route === RouteKind.AxelarGmp)!;
    const allbridge = result.rails.find((r) => r.route === RouteKind.Allbridge)!;

    expect(cctp.available).toBe(true);
    expect(cctp.fee).toBe(3_000_000n);
    expect(cctp.netAmount).toBe(997_000_000n);
    expect(cctp.grossAmount).toBe(1_000_000_000n);
    expect(cctp.retainedDust).toBe(9n);
    expect(cctp.destinationAmount).toBe(99_700_000n);
    expect(cctp.formattedDestinationAmount).toBe("99.7");

    expect(its.available).toBe(true);
    expect(its.destinationAmount).toBe(99_700_000n);

    // Even though mock snapshot marks GMP and Allbridge enabled, active deployment gate keeps them off.
    expect(gmp.activatedInDeployment).toBe(false);
    expect(gmp.available).toBe(false);
    expect(gmp.gateReason).toMatch(/gated/i);
    expect(allbridge.activatedInDeployment).toBe(false);
    expect(allbridge.available).toBe(false);
  });

  it("keeps Axelar ITS gated on Stellar Testnet -> Arc Testnet while allowing CCTP", async () => {
    const result = await runStellarOutboundPlanningExample(
      {
        originChain: "stellar-testnet",
        destinationChain: "arc-testnet",
        symbol: "USDC",
        evmRecipient: EVM_RECIPIENT,
        amount: 50_000_000n,
      },
      {
        manifests: phase1ManifestReader(),
        snapshots: mockSnapshotReader(),
      },
    );

    const cctp = result.rails.find((r) => r.route === RouteKind.Cctp)!;
    const its = result.rails.find((r) => r.route === RouteKind.AxelarIts)!;
    expect(cctp.available).toBe(true);
    expect(its.available).toBe(false);
    expect(its.activatedInDeployment).toBe(false);
    expect(result.recommendedRail).toBe(RouteKind.Cctp);
  });

  it("handles wide integer boundaries around MAX_QUOTE_AMOUNT without precision loss", async () => {
    const hugeFlow = MAX_QUOTE_AMOUNT;
    const atCeiling = await runStellarOutboundPlanningExample(
      {
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        symbol: "USDC",
        evmRecipient: EVM_RECIPIENT,
        amount: MAX_QUOTE_AMOUNT,
      },
      {
        manifests: phase1ManifestReader(),
        snapshots: mockSnapshotReader({
          flowAvailable: {
            [RouteKind.Cctp]: hugeFlow,
            [RouteKind.AxelarIts]: hugeFlow,
          },
        }),
      },
    );
    expect(atCeiling.rails[RouteKind.Cctp]?.available).toBe(true);

    const pastCeiling = await runStellarOutboundPlanningExample(
      {
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        symbol: "USDC",
        evmRecipient: EVM_RECIPIENT,
        amount: MAX_QUOTE_AMOUNT + 1n,
      },
      {
        manifests: phase1ManifestReader(),
        snapshots: mockSnapshotReader({
          flowAvailable: {
            [RouteKind.Cctp]: hugeFlow,
          },
        }),
      },
    );
    expect(pastCeiling.rails[RouteKind.Cctp]?.available).toBe(false);
    expect(pastCeiling.rails[RouteKind.Cctp]?.blocker).toBe(QuoteBlocker.NotRepresentable);
  });

  it("runs local quote ladders to Stellar muxed recipients while gating EVM origin execution", async () => {
    const result = await runQuoteLadderPlanningExample(
      {
        originChain: "sepolia",
        destinationChain: "stellar-testnet",
        symbol: "USDC",
        stellarRecipient: M_ADDR,
        primaryAmount: 250_000_000n,
        ladderTiers: [100_000_000n, 500_000_000n, MUXED_ID],
        slippageToleranceBps: 50,
      },
      {
        manifests: phase1ManifestReader(),
        snapshots: mockSnapshotReader({ tokenDecimals: 6 }),
      },
    );

    expect(result.stage).toBe("local_planning_only");
    expect(result.deploymentGate).toBe("gated_missing_deployment");
    expect(result.executionPermitted).toBe(false);
    expect(result.signedExecutionPerformed).toBe(false);
    expect(result.payoutProven).toBe(false);
    expect(result.winningPrimaryQuote?.route).toBe(RouteKind.Cctp);
    // Allbridge cannot carry muxed sub-account IDs
    expect(result.primaryQuotes[RouteKind.Allbridge]?.reason).toBe(QuoteBlocker.MuxedNotSupported);
    expect(result.ladder).toHaveLength(3);
  });

  it("rejects malformed deployment manifests, mixed networks, and zero EVM recipients", async () => {
    await expect(
      runStellarOutboundPlanningExample(
        {
          originChain: "stellar-testnet",
          destinationChain: "ethereum",
          symbol: "USDC",
          evmRecipient: EVM_RECIPIENT,
          amount: 10_000_000n,
        },
        { manifests: phase1ManifestReader(), snapshots: mockSnapshotReader() },
      ),
    ).rejects.toThrow(/UnknownChain/);

    await expect(
      runStellarOutboundPlanningExample(
        {
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          symbol: "USDC",
          evmRecipient: "0x0000000000000000000000000000000000000000",
          amount: 10_000_000n,
        },
        { manifests: phase1ManifestReader(), snapshots: mockSnapshotReader() },
      ),
    ).rejects.toThrow(/ZeroAddressKey/);

    await expect(
      runStellarOutboundPlanningExample(
        {
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          symbol: "USDC",
          evmRecipient: EVM_RECIPIENT,
          amount: 10_000_000n,
        },
        {
          manifests: { readDeploymentManifest: () => ({ schemaVersion: 99 }) },
          snapshots: mockSnapshotReader(),
        },
      ),
    ).rejects.toThrow(DeploymentFormatError);
  });
});

describe("injected client evidence inspection examples", () => {
  const replayHex = `0x${"cd".repeat(24)}0020000000000001` as Hex;

  function readerWith(
    records: Readonly<Record<string, TransferEvidenceBundle>>,
  ): TransferEvidenceReader {
    return {
      readTransferEvidence: (id) => records[id] ?? null,
    };
  }

  it("inspects attested in-flight CCTP muxed transfers without claiming payout proof", async () => {
    const hook = encodeCctpHook(M_ADDR);
    const rawCctpMessage = buildMockCctpPacket({
      amount: 125_000_000n,
      mintRecipientHex: "11".repeat(32),
      hook,
      nonceHex: replayHex,
      finalityExecuted: 1_000,
    });

    const reader = readerWith({
      "tx-in-flight": {
        kind: "cctp",
        originChain: "sepolia",
        destinationChain: "stellar-testnet",
        rawCctpMessage,
      },
    });

    const inspected = await runEvidenceInspectionExample("tx-in-flight", reader);
    expect(inspected).not.toBeNull();
    expect(inspected?.stage).toBe("evidence_inspection_only");
    expect(inspected?.settlementStage).toBe("source_or_attested_in_flight");
    expect(inspected?.payoutProven).toBe(false);
    expect(inspected?.replayMessageId).toBe(replayHex);
    expect(inspected?.recipient).toBe(M_ADDR);
    expect(inspected?.recipientKind).toBe(AddressKind.MuxedAccount);
    expect(inspected?.muxedSubAccountId).toBe(MUXED_ID);
    expect(inspected?.attestationFinalized).toBe(false);
  });

  it("distinguishes parked recipient-bound claims from confirmed destination payouts", async () => {
    const outboundNote = encodeOutboundNote(EVM_RECIPIENT, (1n << 64n) - 1n);
    const rawCctpMessage = buildMockCctpPacket({
      amount: 50_000_000n,
      mintRecipientHex: toWord(EVM_RECIPIENT),
      hook: outboundNote,
      nonceHex: replayHex,
      sourceDomain: STELLAR_DOMAIN,
      destinationDomain: 0,
    });

    const reader = readerWith({
      parked: {
        kind: "cctp",
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        rawCctpMessage,
        destinationReceipt: {
          delivered: false,
          claimId: MUXED_ID,
          messageId: replayHex,
          amount: 50_000_000n,
          decimals: 6,
        },
      },
      paid: {
        kind: "cctp",
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        rawCctpMessage,
        destinationReceipt: {
          delivered: true,
          claimId: null,
          messageId: replayHex,
          amount: 50_000_000n,
          decimals: 6,
        },
      },
    });

    const parked = await runEvidenceInspectionExample("parked", reader);
    expect(parked?.settlementStage).toBe("recipient_claim_parked");
    expect(parked?.payoutProven).toBe(false);
    expect(parked?.parkedClaimId).toBe(MUXED_ID);
    expect(parked?.correlationNonce).toBe((1n << 64n) - 1n);

    const paid = await runEvidenceInspectionExample("paid", reader);
    expect(paid?.settlementStage).toBe("destination_paid");
    expect(paid?.payoutProven).toBe(true);
    expect(paid?.formattedSettledAmount).toBe("50");
  });

  it("inspects Axelar ITS inbound notes and rejects contradictory or replayed receipts", async () => {
    const inboundNote = encodeInboundNote(G_ADDR, MUXED_ID);
    const rawCctpMessage = buildMockCctpPacket({
      amount: 10_000_000n,
      mintRecipientHex: toWord(EVM_RECIPIENT),
      nonceHex: replayHex,
      sourceDomain: STELLAR_DOMAIN,
      destinationDomain: 0,
    });

    const reader = readerWith({
      "its-inbound": {
        kind: "axelar-its",
        originChain: "sepolia",
        destinationChain: "stellar-testnet",
        rawInboundNote: inboundNote,
      },
      "bad-replay-match": {
        kind: "cctp",
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        rawCctpMessage,
        destinationReceipt: {
          delivered: true,
          claimId: null,
          messageId: `0x${"ef".repeat(32)}`,
          amount: 10_000_000n,
          decimals: 6,
        },
      },
      "contradictory-claim": {
        kind: "cctp",
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        rawCctpMessage,
        destinationReceipt: {
          delivered: true,
          claimId: 7n,
          messageId: replayHex,
          amount: 10_000_000n,
          decimals: 6,
        },
      },
    });

    const its = await runEvidenceInspectionExample("its-inbound", reader);
    expect(its?.recipient).toBe(G_ADDR);
    expect(its?.correlationNonce).toBe(MUXED_ID);
    expect(its?.payoutProven).toBe(false);
    expect(await runEvidenceInspectionExample("missing", reader)).toBeNull();

    await expect(runEvidenceInspectionExample("bad-replay-match", reader)).rejects.toThrow(
      /MalformedMessage/,
    );
    await expect(runEvidenceInspectionExample("contradictory-claim", reader)).rejects.toThrow(
      /MalformedMessage/,
    );
  });
});
