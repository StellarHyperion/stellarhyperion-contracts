import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AdmissionFormatError,
  DEFAULT_MAX_CPU_INSTRUCTIONS,
  DEFAULT_MAX_WASM_BYTES,
  DEFAULT_WARN_WASM_BYTES,
  buildResourceAdmissionReport,
  formatResourceAdmissionReport,
  isValidWasmBinary,
  resolveLedgerProtocolAssumptions,
} from "../src/resource-admission.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function makeWasmBytes(sizeBytes: number): Uint8Array {
  const buf = new Uint8Array(sizeBytes);
  if (sizeBytes >= 8) {
    buf.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00], 0);
  }
  return buf;
}

describe("deployment artifact size and resource admission reports", () => {
  it("admits valid artifacts, computes headroom and build deltas, and records protocol assumptions explicitly", () => {
    const activeManifest = JSON.parse(
      readFileSync(resolve(repoRoot, "deployments/stellar-testnet-phase1.json"), "utf8"),
    ) as {
      networks: {
        "stellar-testnet": {
          wasmHashes: {
            router: string;
            "adapter-cctp": string;
            "adapter-axelar": string;
          };
        };
      };
    };

    const recordedHashes = activeManifest.networks["stellar-testnet"].wasmHashes;

    const report = buildResourceAdmissionReport({
      chain: "stellar-testnet",
      previousDeploymentSet: activeManifest,
      previousArtifactSizes: {
        router: 38_000,
        "adapter-cctp": 24_500,
        "adapter-axelar": 21_200,
      },
      candidates: [
        {
          name: "router",
          sizeBytes: 45_000, // Above 43_690 warning ceiling, below 65_536 max ceiling.
          codeHash: "a".repeat(64),
          wasmBytes: makeWasmBytes(45_000),
          simulatedResources: {
            operation: "simulate-initialize-router",
            cpuInstructions: 18_500_000,
            memoryBytes: 8_388_608,
            readEntries: 6,
            writeEntries: 4,
            readBytes: 4_096,
            writeBytes: 45_256,
            txSizeBytes: 45_600,
            minResourceFeeStroops: "745000",
          },
        },
        {
          name: "adapter-cctp",
          sizeBytes: 24_500,
          codeHash: recordedHashes["adapter-cctp"],
          wasmBytes: makeWasmBytes(24_500),
        },
        {
          name: "adapter-axelar",
          sizeBytes: 21_200,
          codeHash: recordedHashes["adapter-axelar"],
          wasmBytes: makeWasmBytes(21_200),
        },
      ],
    });

    expect(report.stage).toBe("pre-signing");
    expect(report.admitted).toBe(true);
    expect(report.signingPermitted).toBe(true);
    expect(report.validationGate).toBe("active-validated");

    // Active ledger protocol assumptions recorded explicitly.
    expect(report.protocolAssumptions.protocolVersion).toBe(22);
    expect(report.protocolAssumptions.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(report.protocolAssumptions.maxContractSizeBytes).toBe(DEFAULT_MAX_WASM_BYTES);
    expect(report.protocolAssumptions.warnContractSizeBytes).toBe(DEFAULT_WARN_WASM_BYTES);
    expect(report.protocolAssumptions.maxCpuInstructions).toBe(DEFAULT_MAX_CPU_INSTRUCTIONS);
    expect(report.protocolAssumptions.source).toBe("soroban-protocol-baseline");

    const router = report.artifacts.find((a) => a.name === "router")!;
    expect(router.admitted).toBe(true);
    expect(router.headroomBytes).toBe(DEFAULT_MAX_WASM_BYTES - 45_000);
    expect(router.sizeWarning).toBe(true);
    expect(router.comparison).toEqual({
      status: "modified",
      previousCodeHash: recordedHashes.router,
      currentCodeHash: "a".repeat(64),
      codeHashChanged: true,
      previousSizeBytes: 38_000,
      sizeDeltaBytes: 7_000,
    });

    const cctp = report.artifacts.find((a) => a.name === "adapter-cctp")!;
    expect(cctp.comparison.status).toBe("unchanged");
    expect(cctp.comparison.codeHashChanged).toBe(false);
    expect(cctp.comparison.sizeDeltaBytes).toBe(0);

    const formatted = formatResourceAdmissionReport(report);
    expect(formatted).toContain("Admission: ADMITTED | signingPermitted=true");
    expect(formatted).toContain(
      'Ledger Protocol Assumptions [source=soroban-protocol-baseline, protocol=v22, passphrase="Test SDF Network ; September 2015"]',
    );
    expect(formatted).toContain("build vs previous: modified");
    expect(formatted).toContain("+7000 B");
  });

  it("rejects oversized WASM before signing with exact byte deficit", () => {
    const oversizedBytes = DEFAULT_MAX_WASM_BYTES + 1024;
    const report = buildResourceAdmissionReport({
      chain: "stellar-testnet",
      candidates: [
        {
          name: "router",
          sizeBytes: oversizedBytes,
          codeHash: "b".repeat(64),
          wasmBytes: makeWasmBytes(oversizedBytes),
        },
      ],
    });

    expect(report.admitted).toBe(false);
    expect(report.signingPermitted).toBe(false);
    const router = report.artifacts[0]!;
    expect(router.admitted).toBe(false);
    expect(router.headroomBytes).toBe(-1024);
    expect(router.violations.map((v) => v.code)).toContain("wasm-size-exceeded");
    expect(formatResourceAdmissionReport(report)).toContain("REJECTED (blocked before signing)");
  });

  it("rejects simulated resource budget overruns and corrupted WASM headers before signing", () => {
    const corrupt = new Uint8Array(128).fill(0xff);
    expect(isValidWasmBinary(corrupt)).toBe(false);

    const report = buildResourceAdmissionReport({
      chain: "stellar-testnet",
      protocolAssumptions: {
        protocolVersion: 22,
        source: "rpc-network-config",
        maxCpuInstructions: 50_000_000,
        maxWriteEntries: 25,
      },
      candidates: [
        {
          name: "router",
          sizeBytes: 32_000,
          codeHash: "c".repeat(64),
          simulatedResources: {
            operation: "simulate-bridge-out-paid",
            cpuInstructions: 62_000_000,
            writeEntries: 30,
          },
        },
        {
          name: "adapter-cctp",
          sizeBytes: 128,
          codeHash: "d".repeat(64),
          wasmBytes: corrupt,
        },
      ],
    });

    expect(report.admitted).toBe(false);
    expect(report.signingPermitted).toBe(false);
    expect(report.protocolAssumptions.source).toBe("rpc-network-config");

    const routerCodes = report.artifacts[0]!.violations.map((v) => v.code);
    expect(routerCodes).toContain("cpu-budget-exceeded");
    expect(routerCodes).toContain("write-entries-exceeded");

    const cctpCodes = report.artifacts[1]!.violations.map((v) => v.code);
    expect(cctpCodes).toContain("invalid-wasm-binary");
  });

  it("gates unvalidated chains and rejects wrong-network protocol assumptions or secret seeds", () => {
    const gatedReport = buildResourceAdmissionReport({
      chain: "sepolia",
      candidates: [
        {
          name: "router",
          sizeBytes: 20_000,
          codeHash: "e".repeat(64),
        },
      ],
    });
    expect(gatedReport.validationGate).toBe("gated-unvalidated");
    expect(gatedReport.admitted).toBe(false);
    expect(gatedReport.signingPermitted).toBe(false);

    expect(() => {
      resolveLedgerProtocolAssumptions("stellar-testnet", {
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      });
    }).toThrow(AdmissionFormatError);

    expect(() => {
      buildResourceAdmissionReport({
        chain: "stellar-testnet",
        candidates: [
          {
            name: "router",
            sizeBytes: 20_000,
            codeHash: "f".repeat(64),
            fileName: `S${"A".repeat(55)}.wasm`,
          },
        ],
      });
    }).toThrow(AdmissionFormatError);
  });
});
