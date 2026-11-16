import { describe, expect, it } from "vitest";
import {
  formatReconciliationReport,
  reconcileActivationTransactions,
  RouteKind,
  type ExpectedActivationTransaction,
  type LiveActivationStateSnapshot,
  type PublicTransactionObservation,
} from "../src/index.js";
import { G_ADDR } from "./fixtures.js";

const DEPLOYER = "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA";
const ROUTER = "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V";
const AXELAR_ADAPTER = "CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ";
const SAC_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);

function baseIntents(): readonly ExpectedActivationTransaction[] {
  return [
    {
      stepId: "execute-register-usdc",
      hash: HASH_1,
      chain: "stellar-testnet",
      expectedSender: DEPLOYER,
      expectedTargetContract: ROUTER,
      irreversible: true,
      expectedEffect: {
        kind: "action-executed",
        actionId: 1,
        tokenSacId: SAC_ID,
        expectedFlowLimit: "10000000000000",
      },
    },
    {
      stepId: "link-sepolia",
      hash: HASH_2,
      chain: "stellar-testnet",
      expectedSender: DEPLOYER,
      expectedTargetContract: AXELAR_ADAPTER,
      irreversible: true,
      expectedEffect: {
        kind: "axelar-lane-linked",
        peerChain: "sepolia",
        axelarChainName: "ethereum-sepolia",
        peerHex20: "0".repeat(40),
      },
    },
    {
      stepId: "execute-enable-its",
      hash: HASH_3,
      chain: "stellar-testnet",
      expectedSender: DEPLOYER,
      expectedTargetContract: ROUTER,
      irreversible: true,
      expectedEffect: {
        kind: "action-executed",
        actionId: 4,
        route: RouteKind.AxelarIts,
        expectedAdapter: AXELAR_ADAPTER,
        expectedEnabled: true,
      },
    },
  ];
}

function matchingLiveState(): LiveActivationStateSnapshot {
  return {
    reachable: true,
    router: {
      initialized: true,
      admin: DEPLOYER,
      timelockDelay: 3_600,
      feeBps: 30,
      pendingActionIds: [],
      tokens: {
        [SAC_ID]: {
          enabled: true,
          decimals: 7,
          flowLimit: "10000000000000",
        },
      },
      adapters: {
        [RouteKind.AxelarIts]: AXELAR_ADAPTER,
      },
      enabledRoutes: {
        [RouteKind.AxelarIts]: true,
      },
    },
    axelarAdapter: {
      links: {
        sepolia: {
          axelarChainName: "ethereum-sepolia",
          peerHex20: "0".repeat(40),
        },
      },
    },
  };
}

describe("reconcileActivationTransactions", () => {
  it("never proposes a duplicate irreversible operation when lookup outcomes are unknown", () => {
    const intents = baseIntents();
    const observations: PublicTransactionObservation[] = [
      {
        hash: HASH_1,
        lookupState: "not-found",
        diagnostic: "Horizon 404 while ledger closes",
      },
      {
        hash: HASH_2,
        lookupState: "rpc-unreachable",
        diagnostic: "Soroban RPC gateway timeout",
      },
      // HASH_3 intentionally omitted to test missing observation handling.
    ];

    const report = reconcileActivationTransactions(intents, observations, matchingLiveState());
    expect(report.healthy).toBe(false);
    expect(report.summary.unknownCount).toBe(3);

    for (const res of report.results) {
      expect(res.outcome).toBe("unknown");
      expect(res.provesIntendedAction).toBe(false);
      expect(res.allowDuplicateSubmission).toBe(false);
      expect(res.proposal).toBe("wait-and-query-never-duplicate");
    }
  });

  it("compares confirmed transaction hashes against actual live contract configuration", () => {
    const intents = baseIntents();
    const observations: PublicTransactionObservation[] = [HASH_1, HASH_2, HASH_3].map(
      (hash, idx) => ({
        hash,
        lookupState: "confirmed",
        observedChain: "stellar-testnet",
        observedNetworkPassphrase: TESTNET_PASSPHRASE,
        observedSender: DEPLOYER,
        observedTargetContract: idx === 1 ? AXELAR_ADAPTER : ROUTER,
        ledgerOrBlock: 5_436_730 + idx,
      }),
    );

    const converged = reconcileActivationTransactions(intents, observations, matchingLiveState());
    expect(converged.healthy).toBe(true);
    expect(converged.summary.confirmedVerifiedCount).toBe(3);
    expect(converged.results.every((r) => r.provesIntendedAction)).toBe(true);
    expect(converged.results.every((r) => !r.allowDuplicateSubmission)).toBe(true);

    // Mutate live configuration (flowLimit overwritten and Axelar route disabled) to verify drift detection.
    const driftedLive: LiveActivationStateSnapshot = {
      ...matchingLiveState(),
      router: {
        ...matchingLiveState().router!,
        tokens: {
          [SAC_ID]: {
            enabled: true,
            decimals: 7,
            flowLimit: "5000000",
          },
        },
        enabledRoutes: {
          [RouteKind.AxelarIts]: false,
        },
      },
    };
    const drifted = reconcileActivationTransactions(intents, observations, driftedLive);
    expect(drifted.healthy).toBe(false);
    expect(drifted.summary.stateDriftCount).toBe(2);
    expect(drifted.results[0]?.outcome).toBe("confirmed-state-drift");
    expect(drifted.results[0]?.provesIntendedAction).toBe(false);
    expect(drifted.results[0]?.proposal).toBe("halt-and-investigate-drift");
    expect(drifted.results[2]?.outcome).toBe("confirmed-state-drift");
  });

  it("rejects hashes from a different network, sender, or target contract", () => {
    const intents = baseIntents();
    const foreignObservations: PublicTransactionObservation[] = [
      {
        // Different network passphrase (mainnet instead of testnet)
        hash: HASH_1,
        lookupState: "confirmed",
        observedChain: "stellar-testnet",
        observedNetworkPassphrase: MAINNET_PASSPHRASE,
        observedSender: DEPLOYER,
        observedTargetContract: ROUTER,
      },
      {
        // Different sender account
        hash: HASH_2,
        lookupState: "confirmed",
        observedChain: "stellar-testnet",
        observedNetworkPassphrase: TESTNET_PASSPHRASE,
        observedSender: G_ADDR,
        observedTargetContract: AXELAR_ADAPTER,
      },
      {
        // Different target contract
        hash: HASH_3,
        lookupState: "confirmed",
        observedChain: "stellar-testnet",
        observedNetworkPassphrase: TESTNET_PASSPHRASE,
        observedSender: DEPLOYER,
        observedTargetContract: AXELAR_ADAPTER,
      },
    ];

    // Even though live state matches, foreign provenance cannot prove the intended actions.
    const report = reconcileActivationTransactions(
      intents,
      foreignObservations,
      matchingLiveState(),
    );
    expect(report.healthy).toBe(false);
    expect(report.summary.provenanceMismatchCount).toBe(3);
    for (const res of report.results) {
      expect(res.outcome).toBe("provenance-mismatch");
      expect(res.provesIntendedAction).toBe(false);
      expect(res.allowDuplicateSubmission).toBe(false);
      expect(res.proposal).toBe("reject-foreign-hash");
    }

    const formatted = formatReconciliationReport(report);
    expect(formatted).toContain("ACTION_REQUIRED");
    expect(formatted).toContain("[provenance-mismatch]");
  });

  it("distinguishes retryable failures from failed duplicates whose state is already live", () => {
    const intents = baseIntents().slice(0, 2);
    const failedObservations: PublicTransactionObservation[] = [
      {
        hash: HASH_1,
        lookupState: "failed",
        observedChain: "stellar-testnet",
        observedNetworkPassphrase: TESTNET_PASSPHRASE,
        observedSender: DEPLOYER,
        observedTargetContract: ROUTER,
      },
      {
        hash: HASH_2,
        lookupState: "failed",
        observedChain: "stellar-testnet",
        observedNetworkPassphrase: TESTNET_PASSPHRASE,
        observedSender: DEPLOYER,
        observedTargetContract: AXELAR_ADAPTER,
      },
    ];

    // HASH_1 effect IS already live on router; HASH_2 link is NOT live on adapter.
    const partialLive: LiveActivationStateSnapshot = {
      ...matchingLiveState(),
      axelarAdapter: { links: {} },
    };

    const report = reconcileActivationTransactions(intents, failedObservations, partialLive);
    expect(report.results[0]?.outcome).toBe("failed-already-applied");
    expect(report.results[0]?.allowDuplicateSubmission).toBe(false);
    expect(report.results[0]?.proposal).toBe("skip-effect-already-live");

    expect(report.results[1]?.outcome).toBe("failed-safe-to-retry");
    expect(report.results[1]?.allowDuplicateSubmission).toBe(true);
    expect(report.results[1]?.proposal).toBe("safe-to-resubmit");
  });
});
