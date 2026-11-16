import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AddressKind, encodeStellarAddress } from "../src/addresses.js";
import {
  AUTHORITY_POLICY_SCHEMA_VERSION,
  assertNoSecretMaterial,
  containsSecretMaterial,
  deriveNetworkAuthorityPolicy,
  extractQueuedAuthorityChanges,
  formatAuthorityConsistencyReport,
  parseAuthorityManifestPolicy,
  parseStellarAuthoritySnapshot,
  verifyAuthorityConsistency,
} from "../src/authority-policy.js";
import {
  DEPLOYMENT_SCHEMA_VERSION,
  DeploymentFormatError,
  parseDeploymentSet,
} from "../src/deployments.js";
import { RouteKind } from "../src/routes.js";
import { M_ADDR, ZERO_ACCOUNT } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function accountAt(seedByte: number): string {
  return encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(seedByte));
}

function contractAt(seedByte: number): string {
  return encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(seedByte));
}

const ROUTER_ID = contractAt(11);
const CCTP_ADAPTER_ID = contractAt(12);
const AXELAR_ADAPTER_ID = contractAt(13);
const SAC_ID = contractAt(14);
const MULTISIG_ADMIN_CONTRACT = contractAt(15);

const DEPLOYER_ACCOUNT = accountAt(21);
const TREASURY_ACCOUNT = accountAt(22);
const ROUTER_ADMIN_ACCOUNT = accountAt(23);
const GUARDIAN_ACCOUNT = accountAt(24);
const CCTP_ADMIN_ACCOUNT = accountAt(25);
const AXELAR_ADMIN_ACCOUNT = accountAt(26);
const ROGUE_ACCOUNT = accountAt(99);
const ISSUER_ACCOUNT = accountAt(30);

function makeStellarManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    generatedAt: "2026-10-29T10:17:56.262Z",
    networks: {
      "stellar-testnet": {
        family: "stellar",
        networkPassphrase: "Test SDF Network ; September 2015",
        router: ROUTER_ID,
        adapters: {
          cctp: CCTP_ADAPTER_ID,
          "axelar-its": AXELAR_ADAPTER_ID,
        },
        tokens: {
          USDC: {
            sacId: SAC_ID,
            code: "USDC",
            issuer: ISSUER_ACCOUNT,
            decimals: 7,
            flowLimit: "10000000000000",
            routes: ["cctp", "axelar-its"],
          },
        },
        treasury: TREASURY_ACCOUNT,
        admin: ROUTER_ADMIN_ACCOUNT,
        guardian: GUARDIAN_ACCOUNT,
        feeBps: 30,
        flowWindow: 720,
        timelockDelay: 3600,
        wasmHashes: {
          router: "a".repeat(64),
          "adapter-cctp": "b".repeat(64),
          "adapter-axelar": "c".repeat(64),
        },
        deployedAt: {
          ledger: 5_433_808,
          timestamp: "2026-10-28T13:04:40.000Z",
        },
        commit: "b91c6ca",
        deployer: DEPLOYER_ACCOUNT,
        ...overrides,
      },
    },
  };
}

describe("authority policy verification on active Stellar Testnet", () => {
  it("validates the committed canonical stellar-testnet-phase1.json manifest without secrets", () => {
    const raw = JSON.parse(
      readFileSync(resolve(repoRoot, "deployments/stellar-testnet-phase1.json"), "utf8"),
    );
    const set = parseDeploymentSet(raw);
    const deployment = set.networks["stellar-testnet"]!;
    const policy = parseAuthorityManifestPolicy(raw).networks["stellar-testnet"]!;

    const live = parseStellarAuthoritySnapshot(
      {
        router: deployment.router,
        routerConfig: {
          admin: deployment.admin,
          guardian: deployment.guardian,
          treasury: deployment.treasury,
          paused: false,
        },
        routerTreasuryView: deployment.treasury,
        adapters: {
          cctp: {
            address: deployment.adapters[RouteKind.Cctp],
            admin: deployment.admin,
            router: deployment.router,
          },
          "axelar-its": {
            address: deployment.adapters[RouteKind.AxelarIts],
            admin: deployment.admin,
            router: deployment.router,
          },
        },
        queuedActions: [],
      },
      "stellar-testnet",
      policy.router,
    );

    const report = verifyAuthorityConsistency({ policy, live, deployment });
    expect(report.ready).toBe(true);
    expect(report.gated).toBe(false);
    expect(report.mismatches).toEqual([]);
  });

  it("supports distinct treasury, guardian, router admin, and per-adapter admins without assuming treasury == admin", () => {
    const manifest = makeStellarManifest({
      treasury: TREASURY_ACCOUNT,
      admin: MULTISIG_ADMIN_CONTRACT,
      guardian: GUARDIAN_ACCOUNT,
      authorityPolicy: {
        adapterAdmins: {
          cctp: CCTP_ADMIN_ACCOUNT,
          "axelar-its": AXELAR_ADMIN_ACCOUNT,
        },
        roleSeparation: {
          allowSharedAdminAndTreasury: false,
          requireDistinctGuardian: true,
        },
      },
    });

    const deploymentSet = parseDeploymentSet(manifest);
    const deployment = deploymentSet.networks["stellar-testnet"]!;
    const policy = parseAuthorityManifestPolicy(manifest).networks["stellar-testnet"]!;

    expect(policy.treasury).not.toBe(policy.admin);
    expect(policy.guardian).not.toBe(policy.admin);
    expect(policy.adapterAdmins[RouteKind.Cctp]).toBe(CCTP_ADMIN_ACCOUNT);
    expect(policy.adapterAdmins[RouteKind.AxelarIts]).toBe(AXELAR_ADMIN_ACCOUNT);

    const live = parseStellarAuthoritySnapshot(
      {
        routerConfig: {
          admin: MULTISIG_ADMIN_CONTRACT,
          guardian: GUARDIAN_ACCOUNT,
          treasury: TREASURY_ACCOUNT,
          paused: false,
        },
        routerTreasuryView: TREASURY_ACCOUNT,
        adapters: {
          cctp: {
            address: CCTP_ADAPTER_ID,
            admin: CCTP_ADMIN_ACCOUNT,
            router: ROUTER_ID,
          },
          "axelar-its": {
            address: AXELAR_ADAPTER_ID,
            admin: AXELAR_ADMIN_ACCOUNT,
            router: ROUTER_ID,
          },
        },
      },
      "stellar-testnet",
      policy.router,
    );

    const report = verifyAuthorityConsistency({
      policy,
      live,
      deployment,
      deployer: DEPLOYER_ACCOUNT,
    });
    expect(report.ready).toBe(true);
    expect(report.mismatches).toHaveLength(0);
    const text = formatAuthorityConsistencyReport(report);
    expect(text).toContain("Status: READY");
    expect(text).toContain(`router.treasury (treasury): observed=${TREASURY_ACCOUNT}`);
    expect(text).toContain(`router.admin (admin): observed=${MULTISIG_ADMIN_CONTRACT}`);
  });

  it("fails the ready report and identifies every mismatch when live authorities diverge from policy", () => {
    const manifest = makeStellarManifest({
      treasury: TREASURY_ACCOUNT,
      admin: ROUTER_ADMIN_ACCOUNT,
      guardian: GUARDIAN_ACCOUNT,
    });
    const deploymentSet = parseDeploymentSet(manifest);
    const deployment = deploymentSet.networks["stellar-testnet"]!;
    const policy = deriveNetworkAuthorityPolicy(deployment);

    // Live router mistakenly sets treasury to admin, keeps deployer as admin, uses a rogue
    // guardian, leaves rogue admin on CCTP adapter, points Axelar adapter at a wrong router, and
    // has an unexpected queued SetAdmin in the timelock.
    const live = parseStellarAuthoritySnapshot(
      {
        routerConfig: {
          admin: DEPLOYER_ACCOUNT,
          guardian: ROGUE_ACCOUNT,
          treasury: ROUTER_ADMIN_ACCOUNT,
          paused: false,
        },
        routerTreasuryView: ROUTER_ADMIN_ACCOUNT,
        adapters: {
          cctp: {
            address: CCTP_ADAPTER_ID,
            admin: ROGUE_ACCOUNT,
            router: ROUTER_ID,
          },
          "axelar-its": {
            address: AXELAR_ADAPTER_ID,
            admin: ROUTER_ADMIN_ACCOUNT,
            router: contractAt(88),
          },
        },
        queuedActions: [
          {
            id: 9,
            action: { SetAdmin: ROGUE_ACCOUNT },
          },
        ],
      },
      "stellar-testnet",
      policy.router,
    );

    const report = verifyAuthorityConsistency({
      policy,
      live,
      deployment,
      deployer: DEPLOYER_ACCOUNT,
    });

    expect(report.ready).toBe(false);
    const scopes = report.mismatches.map((m) => m.scope);
    expect(scopes).toContain("router.treasury");
    expect(scopes).toContain("router.treasury_view");
    expect(scopes).toContain("router.admin");
    expect(scopes).toContain("router.guardian");
    expect(scopes).toContain("adapter.cctp.admin");
    expect(scopes).toContain("adapter.axelar-its.router");
    expect(scopes).toContain("timelock.queue[9].SetAdmin");

    const adminMismatch = report.mismatches.find((m) => m.scope === "router.admin");
    expect(adminMismatch?.code).toBe("pending-handover");

    const rendered = formatAuthorityConsistencyReport(report);
    expect(rendered).toContain("Status: FAILED (NOT READY)");
    for (const scope of scopes) {
      expect(rendered).toContain(scope);
    }
  });

  it("enforces role separation policy when shared treasury/admin or shared guardian is disallowed", () => {
    const sharedManifest = makeStellarManifest({
      treasury: ROUTER_ADMIN_ACCOUNT,
      admin: ROUTER_ADMIN_ACCOUNT,
      guardian: ROUTER_ADMIN_ACCOUNT,
      authorityPolicy: {
        roleSeparation: {
          allowSharedAdminAndTreasury: false,
          requireDistinctGuardian: true,
        },
      },
    });
    const set = parseDeploymentSet(sharedManifest);
    const policy = parseAuthorityManifestPolicy(sharedManifest).networks["stellar-testnet"]!;
    const live = parseStellarAuthoritySnapshot(
      {
        routerConfig: {
          admin: ROUTER_ADMIN_ACCOUNT,
          guardian: ROUTER_ADMIN_ACCOUNT,
          treasury: ROUTER_ADMIN_ACCOUNT,
        },
        adapters: {
          cctp: { address: CCTP_ADAPTER_ID, admin: ROUTER_ADMIN_ACCOUNT, router: ROUTER_ID },
          "axelar-its": {
            address: AXELAR_ADAPTER_ID,
            admin: ROUTER_ADMIN_ACCOUNT,
            router: ROUTER_ID,
          },
        },
      },
      "stellar-testnet",
      policy.router,
    );

    const report = verifyAuthorityConsistency({
      policy,
      live,
      deployment: set.networks["stellar-testnet"],
    });
    expect(report.ready).toBe(false);
    expect(report.mismatches.map((m) => m.scope)).toEqual([
      "policy.roleSeparation.treasuryAdmin",
      "policy.roleSeparation.guardian",
    ]);
  });

  it("detects drift between a canonical deployment record and an external reviewed policy", () => {
    const manifest = makeStellarManifest();
    const set = parseDeploymentSet(manifest);
    const deployment = set.networks["stellar-testnet"]!;

    const externalPolicy = parseAuthorityManifestPolicy({
      schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
      networks: {
        "stellar-testnet": {
          family: "stellar",
          router: ROUTER_ID,
          treasury: accountAt(77),
          admin: ROUTER_ADMIN_ACCOUNT,
          guardian: GUARDIAN_ACCOUNT,
          adapters: {
            cctp: CCTP_ADAPTER_ID,
            "axelar-its": AXELAR_ADAPTER_ID,
          },
        },
      },
    }).networks["stellar-testnet"]!;

    const live = parseStellarAuthoritySnapshot(
      {
        routerConfig: {
          admin: ROUTER_ADMIN_ACCOUNT,
          guardian: GUARDIAN_ACCOUNT,
          treasury: accountAt(77),
        },
        adapters: {
          cctp: { address: CCTP_ADAPTER_ID, admin: ROUTER_ADMIN_ACCOUNT, router: ROUTER_ID },
          "axelar-its": {
            address: AXELAR_ADAPTER_ID,
            admin: ROUTER_ADMIN_ACCOUNT,
            router: ROUTER_ID,
          },
        },
      },
      "stellar-testnet",
      ROUTER_ID,
    );

    const report = verifyAuthorityConsistency({ policy: externalPolicy, live, deployment });
    expect(report.ready).toBe(false);
    expect(report.mismatches).toContainEqual(
      expect.objectContaining({
        scope: "manifest.treasury",
        code: "manifest-policy-drift",
      }),
    );
  });

  it("explicitly gates EVM deployments and unvalidated rails until independently validated", () => {
    const evmPolicy = parseAuthorityManifestPolicy({
      schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
      networks: {
        sepolia: {
          family: "evm",
          router: `0x${"11".repeat(20)}`,
          treasury: `0x${"22".repeat(20)}`,
          admin: `0x${"33".repeat(20)}`,
          guardian: `0x${"44".repeat(20)}`,
          adapters: {
            cctp: `0x${"55".repeat(20)}`,
          },
        },
      },
    }).networks.sepolia!;

    const evmReport = verifyAuthorityConsistency({
      policy: evmPolicy,
      live: {
        family: "evm",
        chain: "sepolia",
        router: `0x${"11".repeat(20)}`,
        treasury: `0x${"22".repeat(20)}`,
        adminHolders: [`0x${"33".repeat(20)}`],
        guardianHolders: [`0x${"44".repeat(20)}`],
        adapters: {
          [RouteKind.Cctp]: {
            address: `0x${"55".repeat(20)}`,
            adminHolders: [`0x${"33".repeat(20)}`],
            router: `0x${"11".repeat(20)}`,
          },
        },
      },
    });
    expect(evmReport.gated).toBe(true);
    expect(evmReport.ready).toBe(false);
    expect(evmReport.mismatches).toContainEqual(
      expect.objectContaining({
        scope: "gate.chain.sepolia",
        code: "unvalidated-scope-gated",
      }),
    );

    // Unvalidated rail (allbridge) on stellar-testnet is also gated.
    const unvalidatedRailManifest = makeStellarManifest({
      adapters: {
        cctp: CCTP_ADAPTER_ID,
        allbridge: contractAt(61),
      },
    });
    const railSet = parseDeploymentSet(unvalidatedRailManifest);
    const railPolicy =
      parseAuthorityManifestPolicy(unvalidatedRailManifest).networks["stellar-testnet"]!;
    const railLive = parseStellarAuthoritySnapshot(
      {
        routerConfig: {
          admin: ROUTER_ADMIN_ACCOUNT,
          guardian: GUARDIAN_ACCOUNT,
          treasury: TREASURY_ACCOUNT,
        },
        adapters: {
          cctp: { address: CCTP_ADAPTER_ID, admin: ROUTER_ADMIN_ACCOUNT, router: ROUTER_ID },
          allbridge: { address: contractAt(61), admin: ROUTER_ADMIN_ACCOUNT, router: ROUTER_ID },
        },
      },
      "stellar-testnet",
      ROUTER_ID,
    );
    const railReport = verifyAuthorityConsistency({
      policy: railPolicy,
      live: railLive,
      deployment: railSet.networks["stellar-testnet"],
    });
    expect(railReport.gated).toBe(true);
    expect(railReport.ready).toBe(false);
    expect(railReport.mismatches).toContainEqual(
      expect.objectContaining({
        scope: "gate.route.allbridge",
        code: "unvalidated-scope-gated",
      }),
    );
  });

  it("refuses secret seeds, zero addresses, and muxed addresses in policy and snapshot inputs", () => {
    const syntheticSeed = `S${"A".repeat(55)}`;
    expect(containsSecretMaterial(syntheticSeed)).toBe(true);
    expect(() => {
      assertNoSecretMaterial(syntheticSeed, "STELLAR_IDENTITY");
    }).toThrow(DeploymentFormatError);

    for (const badAuthority of [ZERO_ACCOUNT, M_ADDR, syntheticSeed]) {
      expect(() =>
        parseAuthorityManifestPolicy({
          schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
          networks: {
            "stellar-testnet": {
              family: "stellar",
              router: ROUTER_ID,
              treasury: badAuthority,
              admin: ROUTER_ADMIN_ACCOUNT,
              guardian: GUARDIAN_ACCOUNT,
            },
          },
        }),
      ).toThrow(DeploymentFormatError);
    }

    expect(() =>
      parseAuthorityManifestPolicy({
        schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
        networks: {
          sepolia: {
            family: "evm",
            router: `0x${"11".repeat(20)}`,
            treasury: `0x${"00".repeat(20)}`,
            admin: `0x${"33".repeat(20)}`,
            guardian: `0x${"44".repeat(20)}`,
          },
        },
      }),
    ).toThrow(/zero address/);
  });

  it("extracts both tuple-encoded and map-encoded queued authority actions", () => {
    const parsed = extractQueuedAuthorityChanges([
      { id: "1", action: ["RegisterToken", SAC_ID, 7, "1000"] },
      { id: "2", action: ["SetAdmin", ROUTER_ADMIN_ACCOUNT] },
      { id: 3, action: { SetGuardian: GUARDIAN_ACCOUNT } },
      { id: 4, action: { SetTreasury: TREASURY_ACCOUNT } },
    ]);
    expect(parsed).toEqual([
      { id: 2, kind: "SetAdmin", target: ROUTER_ADMIN_ACCOUNT },
      { id: 3, kind: "SetGuardian", target: GUARDIAN_ACCOUNT },
      { id: 4, kind: "SetTreasury", target: TREASURY_ACCOUNT },
    ]);
  });
});
