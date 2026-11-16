import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AddressKind, encodeStellarAddress } from "../src/addresses.js";
import {
  DEPLOYMENT_SCHEMA_VERSION,
  DeploymentFormatError,
  parseDeploymentSet,
} from "../src/deployments.js";
import {
  assertEvmNetworkMatch,
  assertStellarNetworkMatch,
  buildNetworkBoundStellarRecord,
  formatNetworkBoundSummary,
  parseNetworkBoundDeploymentSet,
  recordStellarActivationPosition,
} from "../src/network-record.js";
import { RouteKind } from "../src/routes.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const FUTURENET_PASSPHRASE = "Test SDF Future Network ; October 2022";

function accountAt(seed: number): string {
  return encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(seed));
}

function contractAt(seed: number): string {
  return encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(seed));
}

const ROUTER = contractAt(1);
const CCTP_ADAPTER = contractAt(2);
const AXELAR_ADAPTER = contractAt(3);
const SAC = contractAt(4);

const DEPLOYER = accountAt(11);
const ADMIN = accountAt(12);
const GUARDIAN = accountAt(13);
const TREASURY = accountAt(14);
const ISSUER = accountAt(15);

function baseInput() {
  return {
    targetChain: "stellar-testnet" as const,
    observedNetworkPassphrase: TESTNET_PASSPHRASE,
    observedRpcChain: "stellar-testnet" as const,
    rpcProtocolVersion: 22,
    verifiedAt: "2026-10-28T13:04:40.000Z",
    generatedAt: "2026-10-28T13:04:40.000Z",
    router: ROUTER,
    adapters: {
      [RouteKind.Cctp]: CCTP_ADAPTER,
      [RouteKind.AxelarIts]: AXELAR_ADAPTER,
    },
    tokens: {
      USDC: {
        sacId: SAC,
        code: "USDC",
        issuer: ISSUER,
        decimals: 7,
        flowLimit: "10000000000000",
        routes: [RouteKind.Cctp, RouteKind.AxelarIts],
      },
    },
    treasury: TREASURY,
    admin: ADMIN,
    guardian: GUARDIAN,
    feeBps: 30,
    flowWindow: 720,
    timelockDelay: 3600,
    commit: "b91c6ca",
    deployer: DEPLOYER,
    peerChain: "sepolia" as const,
    queuedActionIds: [1, 2, 3, 4],
    queuedActions: ["register USDC", "set cctp adapter", "set cctp receiver", "enable cctp"],
    artifacts: [
      {
        name: "router",
        codeHash: "1".repeat(64),
        observedNetworkPassphrase: TESTNET_PASSPHRASE,
        uploadTxHash: "2".repeat(64),
        deployTxHash: "3".repeat(64),
      },
      {
        name: "adapter-cctp",
        codeHash: "4".repeat(64),
        observedNetworkPassphrase: TESTNET_PASSPHRASE,
        uploadTxHash: "5".repeat(64),
        deployTxHash: "6".repeat(64),
      },
      {
        name: "adapter-axelar",
        codeHash: "7".repeat(64),
        observedNetworkPassphrase: TESTNET_PASSPHRASE,
        uploadTxHash: "8".repeat(64),
        deployTxHash: "9".repeat(64),
      },
    ],
    initialization: {
      ledger: 5_433_811,
      timestamp: "2026-10-28T13:04:55.000Z",
      txHash: "a".repeat(64),
      observedNetworkPassphrase: TESTNET_PASSPHRASE,
    },
    activation: null,
  };
}

describe("network-bound deployment record writing and verification", () => {
  it("builds a phase-one network-bound record and separately attaches phase-two activation", () => {
    const phase1 = buildNetworkBoundStellarRecord(baseInput());
    // Canonical consumer parser accepts the output without special flags.
    const consumerSet = parseDeploymentSet(phase1);
    expect(consumerSet.networks["stellar-testnet"]?.router).toBe(ROUTER);

    const boundPhase1 = parseNetworkBoundDeploymentSet(phase1);
    const net1 = boundPhase1.networks["stellar-testnet"]!;
    expect(net1.evidenceStatus).toBe("network-bound");
    expect(net1.validationStatus).toBe("active-validated");
    expect(net1.evidenceLimitations).toEqual([]);
    expect(net1.positions.initialization).toEqual({
      ledger: 5_433_811,
      timestamp: "2026-10-28T13:04:55.000Z",
      txHash: "a".repeat(64),
    });
    expect(net1.positions.activation).toBeNull();

    const phase2 = recordStellarActivationPosition(phase1, {
      targetChain: "stellar-testnet",
      observedNetworkPassphrase: TESTNET_PASSPHRASE,
      ledger: 5_436_733,
      timestamp: "2026-10-28T17:08:25.000Z",
      actionTxHashes: ["b".repeat(64), "c".repeat(64)],
      rail: RouteKind.AxelarIts,
    });

    const boundPhase2 = parseNetworkBoundDeploymentSet(phase2);
    const net2 = boundPhase2.networks["stellar-testnet"]!;
    if (net2.family !== "stellar") {
      throw new Error("expected stellar bound record");
    }
    expect(net2.evidenceStatus).toBe("network-bound");
    // Initialization remains pinned to ledger 5_433_811 while activation is separately recorded.
    expect(net2.positions.initialization.ledger).toBe(5_433_811);
    expect(net2.positions.initialization.txHash).toBe("a".repeat(64));
    expect(net2.deployment.deployedAt.ledger).toBe(5_433_811);
    expect(net2.positions.activation).toEqual({
      ledger: 5_436_733,
      timestamp: "2026-10-28T17:08:25.000Z",
      actionTxHashes: ["b".repeat(64), "c".repeat(64)],
    });
    expect(net2.positions.railActivations?.[RouteKind.AxelarIts]?.ledger).toBe(5_436_733);

    const summary = formatNetworkBoundSummary(boundPhase2);
    expect(summary).toContain("[network-bound, active-validated]");
    expect(summary).toContain("initialization: ledger=5433811");
    expect(summary).toContain("activation:     ledger=5436733");
  });

  it("refuses wrong-network passphrases, futurenet observations, mainnet peers, and EVM chainId mismatches", () => {
    // Mainnet passphrase observed while writing stellar-testnet.
    expect(() =>
      buildNetworkBoundStellarRecord({
        ...baseInput(),
        observedNetworkPassphrase: MAINNET_PASSPHRASE,
      }),
    ).toThrow(/observed network passphrase/);

    // Futurenet passphrase observed while writing stellar-testnet.
    expect(() =>
      buildNetworkBoundStellarRecord({
        ...baseInput(),
        observedNetworkPassphrase: FUTURENET_PASSPHRASE,
      }),
    ).toThrow(/observed network passphrase/);

    // Single artifact uploaded against mainnet passphrase.
    expect(() =>
      buildNetworkBoundStellarRecord({
        ...baseInput(),
        artifacts: [
          {
            name: "router",
            codeHash: "1".repeat(64),
            observedNetworkPassphrase: MAINNET_PASSPHRASE,
            uploadTxHash: "2".repeat(64),
          },
        ],
      }),
    ).toThrow(/artifacts\.router\.observedNetworkPassphrase/);

    // Initialization tx observed on mainnet.
    expect(() =>
      buildNetworkBoundStellarRecord({
        ...baseInput(),
        initialization: {
          ledger: 5_433_811,
          timestamp: "2026-10-28T13:04:55.000Z",
          txHash: "a".repeat(64),
          observedNetworkPassphrase: MAINNET_PASSPHRASE,
        },
      }),
    ).toThrow(/initialization\.networkPassphrase/);

    // Mainnet peer chain paired with stellar-testnet.
    expect(() =>
      buildNetworkBoundStellarRecord({
        ...baseInput(),
        peerChain: "ethereum",
      }),
    ).toThrow(/peerChain/);

    // Activation attempted with wrong passphrase or an earlier ledger than initialization.
    const validPhase1 = buildNetworkBoundStellarRecord(baseInput());
    expect(() =>
      recordStellarActivationPosition(validPhase1, {
        targetChain: "stellar-testnet",
        observedNetworkPassphrase: MAINNET_PASSPHRASE,
        ledger: 5_436_733,
        timestamp: "2026-10-28T17:08:25.000Z",
        txHash: "b".repeat(64),
      }),
    ).toThrow(/observed network passphrase/);

    expect(() =>
      recordStellarActivationPosition(validPhase1, {
        targetChain: "stellar-testnet",
        observedNetworkPassphrase: TESTNET_PASSPHRASE,
        ledger: 5_433_800,
        timestamp: "2026-10-28T17:08:25.000Z",
        txHash: "b".repeat(64),
      }),
    ).toThrow(/cannot precede initialization ledger/);

    // Direct network match helpers for Stellar and EVM.
    expect(() => {
      assertStellarNetworkMatch("stellar-testnet", MAINNET_PASSPHRASE, "$.passphrase");
    }).toThrow(DeploymentFormatError);

    expect(() => {
      assertEvmNetworkMatch("base-sepolia", 8453, "$.chainId");
    }).toThrow(/expected chainId 84532/);
  });

  it("parses committed legacy records with explicit evidence limitations", () => {
    const activeRaw = JSON.parse(
      readFileSync(resolve(repoRoot, "deployments/stellar-testnet-phase1.json"), "utf8"),
    );
    const activeBound = parseNetworkBoundDeploymentSet(activeRaw);
    const activeNet = activeBound.networks["stellar-testnet"]!;
    if (activeNet.family !== "stellar") {
      throw new Error("expected stellar bound record");
    }
    expect(activeNet.evidenceStatus).toBe("legacy-limited");
    expect(activeNet.validationStatus).toBe("active-validated");
    expect(activeNet.positions.initialization.ledger).toBe(5_433_808);
    expect(activeNet.positions.activation).toBeNull();
    const activeCodes = activeNet.evidenceLimitations.map((item) => item.code);
    expect(activeCodes).toContain("missing-network-binding");
    expect(activeCodes).toContain("missing-initialization-tx");
    expect(activeCodes).toContain("missing-activation-ledger");

    const archiveRaw = JSON.parse(
      readFileSync(
        resolve(repoRoot, "deployments/archive/stellar-testnet-2026-10-01.json"),
        "utf8",
      ),
    );
    const archiveBound = parseNetworkBoundDeploymentSet(archiveRaw);
    const archiveNet = archiveBound.networks["stellar-testnet"]!;
    if (archiveNet.family !== "stellar") {
      throw new Error("expected stellar bound record");
    }
    expect(archiveNet.evidenceStatus).toBe("legacy-limited");
    expect(archiveNet.positions.initialization.ledger).toBe(4_965_951);
    expect(archiveNet.evidenceLimitations.map((item) => item.code)).toContain(
      "missing-activation-position",
    );
  });

  it("keeps EVM and unvalidated rails gated and rejects secret seeds", () => {
    const evmSet = {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      generatedAt: "2026-10-28T12:00:00.000Z",
      networks: {
        sepolia: {
          family: "evm",
          chainId: 11_155_111,
          router: `0x${"11".repeat(20)}`,
          adapters: { cctp: `0x${"22".repeat(20)}` },
          tokens: {
            USDC: {
              address: `0x${"33".repeat(20)}`,
              decimals: 6,
              flowLimit: "1000000000",
              routes: ["cctp"],
            },
          },
          treasury: `0x${"44".repeat(20)}`,
          admin: `0x${"55".repeat(20)}`,
          guardian: `0x${"66".repeat(20)}`,
          feeBps: 30,
          flowWindow: 3600,
          timelockDelay: 3600,
          deployedAt: {
            blockNumber: "12000000",
            timestamp: "2026-10-28T12:00:00.000Z",
            txHash: `0x${"ab".repeat(32)}`,
          },
          commit: "0123456",
          networkBinding: {
            observedChainId: 11_155_111,
            observedChain: "sepolia",
            verifiedAt: "2026-10-28T12:00:00.000Z",
            artifacts: {},
          },
          positions: {
            activation: {
              blockNumber: "12000500",
              timestamp: "2026-10-28T13:10:00.000Z",
              txHash: `0x${"cd".repeat(32)}`,
            },
          },
        },
      },
    };

    const parsedEvm = parseNetworkBoundDeploymentSet(evmSet);
    const sepolia = parsedEvm.networks.sepolia!;
    if (sepolia.family !== "evm") {
      throw new Error("expected evm bound record");
    }
    expect(sepolia.validationStatus).toBe("gated-unvalidated");
    expect(sepolia.evidenceStatus).toBe("network-bound");
    expect(sepolia.positions.initialization.blockNumber).toBe("12000000");
    expect(sepolia.positions.activation?.blockNumber).toBe("12000500");

    // Wrong EVM chainId on sepolia fails immediately.
    expect(() =>
      parseNetworkBoundDeploymentSet({
        ...evmSet,
        networks: {
          sepolia: {
            ...evmSet.networks.sepolia,
            chainId: 1,
          },
        },
      }),
    ).toThrow(/expected chainId 11155111/);

    // Secret seed in commit or passphrase fails immediately.
    expect(() =>
      buildNetworkBoundStellarRecord({
        ...baseInput(),
        commit: `S${"A".repeat(55)}`,
      }),
    ).toThrow(/secret/);
  });
});
