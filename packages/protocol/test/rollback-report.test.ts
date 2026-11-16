import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AddressKind, encodeStellarAddress } from "../src/addresses.js";
import { DEPLOYMENT_SCHEMA_VERSION } from "../src/deployments.js";
import {
  REQUIRED_SAFETY_INVARIANTS,
  ROUTER_BASELINE_STORAGE_KEYS,
  RollbackFormatError,
  evaluateRollbackFeasibility,
  formatRollbackFeasibilityReport,
  parseRollbackReference,
} from "../src/rollback-report.js";
import { RouteKind } from "../src/routes.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

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

const ADMIN = accountAt(11);
const TREASURY = accountAt(12);
const GUARDIAN = accountAt(13);
const CCTP_ADMIN = accountAt(14);
const AXELAR_ADMIN = accountAt(15);
const ISSUER = accountAt(16);

function makeManifest(wasmHashes: {
  router: string;
  "adapter-cctp": string;
  "adapter-axelar": string;
}) {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    generatedAt: "2026-10-29T10:17:56.000Z",
    networks: {
      "stellar-testnet": {
        family: "stellar",
        networkPassphrase: "Test SDF Network ; September 2015",
        router: ROUTER,
        adapters: {
          cctp: CCTP_ADAPTER,
          "axelar-its": AXELAR_ADAPTER,
        },
        tokens: {
          USDC: {
            sacId: SAC,
            code: "USDC",
            issuer: ISSUER,
            decimals: 7,
            flowLimit: "10000000000000",
            routes: ["cctp", "axelar-its"],
          },
        },
        treasury: TREASURY,
        admin: ADMIN,
        guardian: GUARDIAN,
        feeBps: 30,
        flowWindow: 720,
        timelockDelay: 3600,
        wasmHashes,
        deployedAt: {
          ledger: 5_433_808,
          timestamp: "2026-10-28T13:04:40.000Z",
        },
        commit: "b91c6ca",
      },
    },
  };
}

describe("upgrade rollback feasibility reports", () => {
  it("reports compatible rollbacks with old/new code hashes, distinct authorities, and read-only guarantees", () => {
    const current = makeManifest({
      router: "2".repeat(64),
      "adapter-cctp": "4".repeat(64),
      "adapter-axelar": "6".repeat(64),
    });
    const previous = makeManifest({
      router: "1".repeat(64),
      "adapter-cctp": "3".repeat(64),
      "adapter-axelar": "5".repeat(64),
    });

    const report = evaluateRollbackFeasibility({
      chain: "stellar-testnet",
      currentDeploymentSet: current,
      previousDeploymentSet: previous,
      adapterAdmins: {
        [RouteKind.Cctp]: CCTP_ADMIN,
        [RouteKind.AxelarIts]: AXELAR_ADMIN,
      },
    });

    expect(report.readOnly).toBe(true);
    expect(report.executionPermitted).toBe(false);
    expect(report.validationGate).toBe("active-validated");
    expect(report.overallFeasible).toBe(true);
    expect(report.contracts).toHaveLength(3);

    const router = report.contracts.find((c) => c.artifact === "router")!;
    expect(router.feasible).toBe(true);
    expect(router.currentCodeHash).toBe("2".repeat(64));
    expect(router.targetCodeHash).toBe("1".repeat(64));
    expect(router.authority.mechanism).toBe("router-timelock");
    expect(router.authority.authorityRole).toBe("router-admin");
    expect(router.authority.requiredAuthority).toBe(ADMIN);
    expect(router.authority.treasuryAddress).toBe(TREASURY);
    expect(router.authority.emergencyPauseGuardian).toBe(GUARDIAN);
    expect(router.authority.timelockDelaySeconds).toBe(3600);
    // Distinct treasury vs admin surfaces an explicit reminder to sign with router admin.
    expect(router.warnings.some((w) => w.includes("distinct from treasury"))).toBe(true);

    const cctp = report.contracts.find((c) => c.artifact === "adapter-cctp")!;
    expect(cctp.feasible).toBe(true);
    expect(cctp.currentCodeHash).toBe("4".repeat(64));
    expect(cctp.targetCodeHash).toBe("3".repeat(64));
    expect(cctp.authority.mechanism).toBe("adapter-direct-admin");
    expect(cctp.authority.requiredAuthority).toBe(CCTP_ADMIN);
    expect(cctp.authority.timelockDelaySeconds).toBe(0);

    const rendered = formatRollbackFeasibilityReport(report);
    expect(rendered).toContain(
      "Mode: READ-ONLY ADVISORY (readOnly=true, executionPermitted=false)",
    );
    expect(rendered).toContain(`router-admin = ${ADMIN}`);
    expect(rendered).toContain(`adapter-admin = ${CCTP_ADMIN}`);
  });

  it("marks rollback unsupported when irreversible storage migrations or schema downgrades exist", () => {
    const current = makeManifest({
      router: "2".repeat(64),
      "adapter-cctp": "4".repeat(64),
      "adapter-axelar": "6".repeat(64),
    });
    const previous = makeManifest({
      router: "1".repeat(64),
      "adapter-cctp": "3".repeat(64),
      "adapter-axelar": "5".repeat(64),
    });

    const spec = parseRollbackReference({
      currentBuilds: {
        router: {
          codeHash: "2".repeat(64),
          schemaVersion: 2,
          migrations: [
            {
              id: "2026-11-claim-v2-key-split",
              fromSchemaVersion: 1,
              toSchemaVersion: 2,
              reversible: false,
              reason:
                "PendingClaim persistent entries were rewritten with recipient subaccount tags that v1 cannot decode",
              affectedKeys: ["Claim"],
            },
          ],
        },
      },
      targetBuilds: {
        router: {
          codeHash: "1".repeat(64),
          schemaVersion: 1,
        },
      },
    });

    const report = evaluateRollbackFeasibility({
      chain: "stellar-testnet",
      currentDeploymentSet: current,
      previousDeploymentSet: previous,
      ...(spec.currentBuilds !== undefined ? { currentBuilds: spec.currentBuilds } : {}),
      ...(spec.targetBuilds !== undefined ? { targetBuilds: spec.targetBuilds } : {}),
    });

    expect(report.overallFeasible).toBe(false);
    const router = report.contracts.find((c) => c.artifact === "router")!;
    expect(router.feasible).toBe(false);
    expect(router.status).toBe("unsupported");
    expect(router.blockers).toEqual([
      {
        code: "storage-migration-irreversible",
        migrationId: "2026-11-claim-v2-key-split",
        reason:
          'migration "2026-11-claim-v2-key-split" (v1 -> v2) is irreversible: PendingClaim persistent entries were rewritten with recipient subaccount tags that v1 cannot decode',
      },
      {
        code: "storage-schema-downgrade",
        reason:
          "active storage schema v2 cannot roll back to target schema v1 without an explicitly verified reversible migration",
      },
    ]);
  });

  it("blocks rollback when storage keys, safety invariants, or active rail entrypoints would regress", () => {
    const current = makeManifest({
      router: "2".repeat(64),
      "adapter-cctp": "4".repeat(64),
      "adapter-axelar": "6".repeat(64),
    });
    const previous = makeManifest({
      router: "1".repeat(64),
      "adapter-cctp": "3".repeat(64),
      "adapter-axelar": "5".repeat(64),
    });

    const report = evaluateRollbackFeasibility({
      chain: "stellar-testnet",
      currentDeploymentSet: current,
      previousDeploymentSet: previous,
      targetBuilds: {
        router: {
          codeHash: "1".repeat(64),
          storageKeys: ROUTER_BASELINE_STORAGE_KEYS.filter((k) => k !== "Processed"),
          preservedInvariants: REQUIRED_SAFETY_INVARIANTS.filter(
            (inv) => inv !== "replay-protection",
          ),
          entrypoints: ["initialize", "bridge_out", "bridge_in"],
        },
      },
    });

    expect(report.overallFeasible).toBe(false);
    const router = report.contracts.find((c) => c.artifact === "router")!;
    const codes = router.blockers.map((b) => b.code);
    expect(codes).toContain("storage-key-incompatible");
    expect(codes).toContain("safety-invariant-regression");
    expect(codes).toContain("active-route-entrypoint-missing");
  });

  it("evaluates real committed Stellar Testnet manifests and historical evidence/archive fixtures accurately", () => {
    const activeManifest = JSON.parse(
      readFileSync(resolve(repoRoot, "deployments/stellar-testnet-phase1.json"), "utf8"),
    ) as unknown;
    const paidItsEvidence = JSON.parse(
      readFileSync(resolve(repoRoot, "deployments/evidence/2026-10-28-paid-its.json"), "utf8"),
    ) as unknown;
    const oct1Archive = JSON.parse(
      readFileSync(
        resolve(repoRoot, "deployments/archive/stellar-testnet-2026-10-01.json"),
        "utf8",
      ),
    ) as unknown;

    // 1. Rolling active 2026-10-29 manifest back to 2026-10-28 paid-its evidence while CCTP is active:
    const ref28 = parseRollbackReference(paidItsEvidence);
    const report28 = evaluateRollbackFeasibility({
      chain: "stellar-testnet",
      currentDeploymentSet: activeManifest,
      ...(ref28.targetBuilds !== undefined ? { targetBuilds: ref28.targetBuilds } : {}),
    });
    expect(report28.overallFeasible).toBe(false);
    const router28 = report28.contracts.find((c) => c.artifact === "router")!;
    expect(router28.blockers.map((b) => b.code)).toContain("active-route-entrypoint-missing");
    const axelar28 = report28.contracts.find((c) => c.artifact === "adapter-axelar")!;
    expect(axelar28.blockers.map((b) => b.code)).toContain("already-at-target");

    // 2. Comparing active manifest against the archived October 1 router flags cross-instance mismatch:
    const reportArchive = evaluateRollbackFeasibility({
      chain: "stellar-testnet",
      currentDeploymentSet: activeManifest,
      previousDeploymentSet: oct1Archive,
    });
    expect(reportArchive.overallFeasible).toBe(false);
    const routerArchive = reportArchive.contracts.find((c) => c.artifact === "router")!;
    expect(routerArchive.blockers.map((b) => b.code)).toContain("contract-address-mismatch");
  });

  it("gates EVM deployments and rejects secret seeds", () => {
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
        },
      },
    };

    const evmReport = evaluateRollbackFeasibility({
      chain: "sepolia",
      currentDeploymentSet: evmSet,
    });
    expect(evmReport.validationGate).toBe("gated-unvalidated");
    expect(evmReport.overallFeasible).toBe(false);
    expect(evmReport.readOnly).toBe(true);
    expect(evmReport.executionPermitted).toBe(false);

    expect(() => {
      parseRollbackReference({
        targetBuilds: {
          router: {
            codeHash: "1".repeat(64),
            sourceCommit: `S${"A".repeat(55)}`,
          },
        },
      });
    }).toThrow(RollbackFormatError);
  });
});
