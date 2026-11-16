import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  type AllbridgeCandidateLaneEvidence,
  evaluateAllbridgeActivationEvidence,
} from "../src/allbridgeActivationGate.js";
import { C_ADDR, G_ADDR } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const cliPath = resolve(
  packageRoot,
  "..",
  "..",
  "script",
  "stellar",
  "check-allbridge-activation.mjs",
);

function validEvidence(): AllbridgeCandidateLaneEvidence {
  return {
    auth: {
      admin: G_ADDR,
      router: C_ADDR,
      adapter: C_ADDR,
      bridge: C_ADDR,
      nativeToken: C_ADDR,
      adminAuthVerified: true,
      routerTimelockDelaySeconds: 3_600,
      stage: "verified-canary",
    },
    pool: {
      chain: "ethereum",
      allbridgeChainId: 1,
      laneLinked: true,
      railOpen: true,
      localToken: C_ADDR,
      poolAddress: C_ADDR,
      receiveTokenHex: `0x${"00".repeat(12)}${"a0".repeat(20)}`,
      assetMapped: true,
    },
    liquidity: {
      poolLiquidity: 50_000_000_000n,
      minPoolLiquidity: 10_000_000_000n,
      gasFloat: 500_000_000n,
      relayCost: 5_000_000n,
      minGasFloatReserve: 50_000_000n,
    },
    validator: {
      validatorConfigured: true,
      validatorPublicKeyHex: `0x${"44".repeat(32)}`,
      provenance: "published-allbridge",
    },
    acceptanceProofs: [
      {
        direction: "outbound",
        stage: "verified-canary",
        sourceTxRef: "stellar-canary-outbound-001",
        destinationTxRef: "evm-canary-outbound-001",
        exactAmount: 100_000_000n,
        recipientBound: true,
        signedByReviewer: true,
        reviewerIdentity: G_ADDR,
      },
      {
        direction: "inbound",
        stage: "verified-canary",
        sourceTxRef: "evm-canary-inbound-001",
        destinationTxRef: "stellar-canary-inbound-001",
        exactAmount: 100_000_000n,
        recipientBound: true,
        signedByReviewer: true,
        reviewerIdentity: G_ADDR,
      },
    ],
  };
}

describe("Allbridge activation evidence gate", () => {
  it("reports validator trust separately from Circle and Axelar assurances without enabling routes", () => {
    const report = evaluateAllbridgeActivationEvidence(validEvidence());
    expect(report.ready).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.routeEnabledByGate).toBe(false);
    expect(report.submittedTransactions).toBe(0);
    expect(report.trustAssumptions.validatorTrustModel).toBe("configured-ed25519-validator-key");
    expect(report.trustAssumptions.reliesOnCircleAttestation).toBe(false);
    expect(report.trustAssumptions.reliesOnAxelarValidatorSet).toBe(false);
    expect(report.trustAssumptions.circleAssuranceDistinction).toContain("Circle CCTP V2");
    expect(report.trustAssumptions.axelarAssuranceDistinction).toContain("Axelar");
  });

  it("blocks ready status when acceptance proofs are absent or development-only", () => {
    const missingProofs = evaluateAllbridgeActivationEvidence({
      ...validEvidence(),
      acceptanceProofs: [],
    });
    expect(missingProofs.ready).toBe(false);
    expect(missingProofs.blockers.some((b) => b.code === "missing-acceptance-proofs")).toBe(true);

    const base = validEvidence();
    const devOnlyProof = evaluateAllbridgeActivationEvidence({
      ...base,
      validator: {
        ...base.validator,
        provenance: "development-only",
      },
      acceptanceProofs: base.acceptanceProofs.map((p) => ({
        ...p,
        stage: "development-only",
      })),
    });
    expect(devOnlyProof.ready).toBe(false);
    expect(devOnlyProof.blockers.some((b) => b.code === "development-only-validator")).toBe(true);
    expect(devOnlyProof.blockers.some((b) => b.code === "development-only-acceptance-proof")).toBe(
      true,
    );
  });

  it("blocks ready status on insufficient liquidity, low gas float, unverified admin or closed rail", () => {
    const base = validEvidence();
    const report = evaluateAllbridgeActivationEvidence({
      ...base,
      auth: { ...base.auth, adminAuthVerified: false, routerTimelockDelaySeconds: 60 },
      pool: { ...base.pool, railOpen: false },
      liquidity: {
        ...base.liquidity,
        poolLiquidity: 100n,
        gasFloat: 1_000n,
      },
    });
    expect(report.ready).toBe(false);
    const codes = report.blockers.map((b) => b.code);
    expect(codes).toContain("admin-auth-unverified");
    expect(codes).toContain("timelock-below-minimum");
    expect(codes).toContain("rail-closed");
    expect(codes).toContain("insufficient-pool-liquidity");
    expect(codes).toContain("insufficient-gas-float");
  });

  it("runs the read-only CLI gate on local JSON fixtures", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "hyperion-abr-gate-"));
    try {
      const okPath = resolve(tempDir, "ready.json");
      const devPath = resolve(tempDir, "dev.json");

      const serialize = (ev: AllbridgeCandidateLaneEvidence): string =>
        JSON.stringify(
          {
            ...ev,
            liquidity: {
              poolLiquidity: ev.liquidity.poolLiquidity.toString(),
              minPoolLiquidity: ev.liquidity.minPoolLiquidity.toString(),
              gasFloat: ev.liquidity.gasFloat.toString(),
              relayCost: ev.liquidity.relayCost.toString(),
              minGasFloatReserve: ev.liquidity.minGasFloatReserve.toString(),
            },
            acceptanceProofs: ev.acceptanceProofs.map((p) => ({
              ...p,
              exactAmount: p.exactAmount.toString(),
            })),
          },
          null,
          2,
        );

      writeFileSync(okPath, serialize(validEvidence()));
      const base = validEvidence();
      writeFileSync(
        devPath,
        serialize({
          ...base,
          validator: { ...base.validator, provenance: "development-only" },
        }),
      );

      const out = execFileSync(process.execPath, [cliPath, "--evidence", okPath, "--json"], {
        cwd: packageRoot,
        encoding: "utf8",
      });
      const parsed = JSON.parse(out) as { ready: boolean; routeEnabledByGate: boolean };
      expect(parsed.ready).toBe(true);
      expect(parsed.routeEnabledByGate).toBe(false);

      let devExit = 0;
      try {
        execFileSync(process.execPath, [cliPath, "--evidence", devPath, "--json"], {
          cwd: packageRoot,
          stdio: "pipe",
        });
      } catch (err) {
        devExit = (err as { status?: number }).status ?? 1;
      }
      expect(devExit).not.toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
