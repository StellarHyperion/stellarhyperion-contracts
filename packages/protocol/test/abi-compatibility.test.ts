import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  axelarItsAdapterAbi,
  cctpAdapterAbi,
  erc20Abi,
  hyperionRouterAbi,
  hyperionRouterInterfaceAbi,
  railAdapterAbi,
} from "../src/abi/index.js";
import {
  type AbiEntry,
  type AbiProvenanceRecord,
  type ConsumerMigrationAssessment,
  canonicalEntrySignature,
  canonicaliseAbi,
  compareContractAbis,
  evaluateAbiCompatibilityGate,
  isPayoutRelevantEntry,
  verifyAbiProvenance,
} from "../src/abiCompatibility.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const evmOutRoot = resolve(packageRoot, "..", "..", "evm", "out");
const cliScript = join(packageRoot, "scripts", "check-abi-compat.mjs");

function cloneAbi(abi: readonly AbiEntry[]): AbiEntry[] {
  return JSON.parse(JSON.stringify(abi)) as AbiEntry[];
}

function loadCompiledProvenance(
  contract: string,
  artifactFile: string,
  moduleName: string,
  symbolName: string,
  exportedAbi: readonly AbiEntry[],
): AbiProvenanceRecord {
  const raw = JSON.parse(
    readFileSync(join(evmOutRoot, artifactFile, `${contract}.json`), "utf8"),
  ) as {
    abi: AbiEntry[];
    bytecode?: { object?: string };
    metadata?: { compiler?: { version?: string } };
  };
  const bytecodeHex = raw.bytecode?.object ?? "";
  return {
    contract,
    artifactFile,
    moduleName,
    symbolName,
    hasConcreteBytecode: bytecodeHex !== "0x" && bytecodeHex.length > 2,
    compilerVersion: raw.metadata?.compiler?.version,
    compiledAbi: raw.abi,
    exportedAbi,
  };
}

describe("ABI semantic compatibility gate", () => {
  it("verifies live Foundry artifact provenance and passes with identical verdict", () => {
    const provenanceRecords: AbiProvenanceRecord[] = [
      loadCompiledProvenance(
        "HyperionRouter",
        "HyperionRouter.sol",
        "router",
        "hyperionRouterAbi",
        hyperionRouterAbi,
      ),
      loadCompiledProvenance(
        "IHyperionRouter",
        "IHyperionRouter.sol",
        "routerInterface",
        "hyperionRouterInterfaceAbi",
        hyperionRouterInterfaceAbi,
      ),
      loadCompiledProvenance(
        "CctpAdapter",
        "CctpAdapter.sol",
        "cctpAdapter",
        "cctpAdapterAbi",
        cctpAdapterAbi,
      ),
      loadCompiledProvenance(
        "AxelarItsAdapter",
        "AxelarItsAdapter.sol",
        "axelarItsAdapter",
        "axelarItsAdapterAbi",
        axelarItsAdapterAbi,
      ),
      loadCompiledProvenance(
        "IRailAdapter",
        "IRailAdapter.sol",
        "railAdapter",
        "railAdapterAbi",
        railAdapterAbi,
      ),
      loadCompiledProvenance("IERC20", "IERC20.sol", "erc20", "erc20Abi", erc20Abi),
    ];

    const baselineAbis: Record<string, readonly AbiEntry[]> = {};
    const proposedAbis: Record<string, readonly AbiEntry[]> = {};
    for (const rec of provenanceRecords) {
      baselineAbis[rec.contract] = rec.exportedAbi;
      proposedAbis[rec.contract] = canonicaliseAbi(rec.compiledAbi);
    }

    const report = evaluateAbiCompatibilityGate({
      baselineAbis,
      proposedAbis,
      provenanceRecords,
    });

    expect(report.passed).toBe(true);
    expect(report.verdict).toBe("identical");
    expect(report.provenanceVerified).toBe(true);
    expect(report.breakingChanges).toEqual([]);
    expect(report.additiveChanges).toEqual([]);
  });

  it("fails the gate when payout-relevant tuple or event fields are removed", () => {
    const base = cloneAbi(hyperionRouterAbi);
    const bridgeOutBase = base.find((e) => e.type === "function" && e.name === "bridgeOut");
    expect(bridgeOutBase).toBeDefined();
    expect(isPayoutRelevantEntry(bridgeOutBase!)).toBe(true);

    const mutated = base.map((entry): AbiEntry => {
      if (entry.type === "function" && entry.name === "bridgeOut") {
        const req = entry.inputs![0]!;
        return {
          ...entry,
          inputs: [
            {
              ...req,
              components: req.components!.filter((c) => c.name !== "minDestinationAmount"),
            },
          ],
        };
      }
      if (entry.type === "function" && entry.name === "pendingClaim") {
        const claim = entry.outputs![0]!;
        return {
          ...entry,
          outputs: [
            {
              ...claim,
              components: claim.components!.filter((c) => c.name !== "amount"),
            },
          ],
        };
      }
      if (entry.type === "event" && entry.name === "BridgeOut") {
        return {
          ...entry,
          inputs: entry.inputs!.slice(0, -1),
        };
      }
      return entry;
    });

    const diff = compareContractAbis("HyperionRouter", base, mutated);
    expect(diff.breakingChanges.length).toBeGreaterThanOrEqual(3);
    expect(diff.breakingChanges.every((c) => c.payoutRelevant)).toBe(true);
    expect(diff.breakingChanges.some((c) => c.code === "tuple-field-removed")).toBe(true);
    expect(diff.breakingChanges.some((c) => c.code === "event-field-removed")).toBe(true);
  });

  it("fails the gate when same-type payout fields are reordered without changing raw 4-byte selectors", () => {
    const base = cloneAbi(hyperionRouterAbi);

    const mutated = base.map((entry): AbiEntry => {
      if (entry.type === "function" && entry.name === "pendingClaim") {
        const claim = entry.outputs![0]!;
        const comps = [...claim.components!];
        const recIdx = comps.findIndex((c) => c.name === "recipient");
        const tokIdx = comps.findIndex((c) => c.name === "token");
        const tmp = comps[recIdx]!;
        comps[recIdx] = comps[tokIdx]!;
        comps[tokIdx] = tmp;
        return {
          ...entry,
          outputs: [{ ...claim, components: comps }],
        };
      }
      if (entry.type === "event" && entry.name === "BridgeOut") {
        const evInputs = [...entry.inputs!];
        const grossIdx = evInputs.findIndex((c) => c.name === "grossAmount");
        const netIdx = evInputs.findIndex((c) => c.name === "netAmount");
        const tmpEv = evInputs[grossIdx]!;
        evInputs[grossIdx] = evInputs[netIdx]!;
        evInputs[netIdx] = tmpEv;
        return {
          ...entry,
          inputs: evInputs,
        };
      }
      return entry;
    });

    const baseBridgeOutEv = base.find((e) => e.type === "event" && e.name === "BridgeOut")!;
    const mutatedBridgeOutEv = mutated.find((e) => e.type === "event" && e.name === "BridgeOut")!;
    expect(canonicalEntrySignature(mutatedBridgeOutEv)).toBe(
      canonicalEntrySignature(baseBridgeOutEv),
    );

    const report = evaluateAbiCompatibilityGate({
      baselineAbis: { HyperionRouter: base },
      proposedAbis: { HyperionRouter: mutated },
    });

    expect(report.passed).toBe(false);
    expect(report.verdict).toBe("breaking");
    expect(
      report.breakingChanges.filter((c) => c.code === "payout-fields-reordered").length,
    ).toBeGreaterThanOrEqual(2);
    expect(report.breakingChanges.every((c) => c.payoutRelevant)).toBe(true);
  });

  it("fails on event indexed toggles and incompatible stateMutability changes", () => {
    const base = cloneAbi(hyperionRouterAbi);
    const mutated = base.map((entry): AbiEntry => {
      if (entry.type === "event" && entry.name === "ClaimParked") {
        return {
          ...entry,
          inputs: entry.inputs!.map((i) => (i.name === "recipient" ? { ...i, indexed: false } : i)),
        };
      }
      if (entry.type === "function" && entry.name === "bridgeOut") {
        return {
          ...entry,
          stateMutability: "nonpayable",
        };
      }
      return entry;
    });

    const diff = compareContractAbis("HyperionRouter", base, mutated);
    expect(diff.breakingChanges.some((c) => c.code === "event-indexed-changed")).toBe(true);
    expect(diff.breakingChanges.some((c) => c.code === "state-mutability-incompatible")).toBe(true);
  });

  it("blocks undocumented additive changes and passes once consumer migration assessments are supplied", () => {
    const base = cloneAbi(hyperionRouterAbi);
    const proposed = cloneAbi(base);

    const addedFn: AbiEntry = {
      type: "function",
      name: "routeDiagnostic",
      stateMutability: "view",
      inputs: [{ name: "route", type: "uint8", internalType: "enum RouteKind" }],
      outputs: [{ name: "ready", type: "bool", internalType: "bool" }],
    };
    const addedEv: AbiEntry = {
      type: "event",
      name: "RouteDiagnosed",
      anonymous: false,
      inputs: [{ name: "route", type: "uint8", internalType: "enum RouteKind", indexed: true }],
    };
    proposed.push(addedFn, addedEv);

    const unassessedReport = evaluateAbiCompatibilityGate({
      baselineAbis: { HyperionRouter: base },
      proposedAbis: { HyperionRouter: proposed },
    });
    expect(unassessedReport.passed).toBe(false);
    expect(unassessedReport.verdict).toBe("breaking");
    expect(unassessedReport.additiveChanges.length).toBe(2);
    expect(unassessedReport.unassessedAdditiveChanges.length).toBe(2);

    const assessments: ConsumerMigrationAssessment[] = [
      {
        changeId: "HyperionRouter:function:routeDiagnostic(uint8):added-entry",
        summary: "Optional read-only diagnostic view for preflight route readiness inspection.",
        consumerSurfaces: ["sdk", "ui"],
        backwardCompatible: true,
        migrationSteps: [
          "Regenerate @hyperion/protocol/abi via npm run gen.",
          "Existing callers require no changes because routeDiagnostic is view-only.",
        ],
      },
      {
        changeId: "HyperionRouter:event:RouteDiagnosed(uint8):added-entry",
        summary: "Diagnostic event emitted only by operator rehearsal helpers.",
        consumerSurfaces: ["indexer"],
        backwardCompatible: true,
        migrationSteps: [
          "Indexers ignoring unknown topic0 hashes continue uninterrupted.",
          "Add optional topic0 handler in telemetry pipelines if diagnostic metrics are desired.",
        ],
      },
    ];

    const assessedReport = evaluateAbiCompatibilityGate({
      baselineAbis: { HyperionRouter: base },
      proposedAbis: { HyperionRouter: proposed },
      migrationAssessments: assessments,
    });
    expect(assessedReport.passed).toBe(true);
    expect(assessedReport.verdict).toBe("compatible-with-migration");
    expect(assessedReport.unassessedAdditiveChanges).toEqual([]);
  });

  it("rejects broken provenance when exported ABI drifts or lacks concrete bytecode", () => {
    const routerRecord = loadCompiledProvenance(
      "HyperionRouter",
      "HyperionRouter.sol",
      "router",
      "hyperionRouterAbi",
      hyperionRouterAbi,
    );

    const drifted = verifyAbiProvenance([
      {
        ...routerRecord,
        hasConcreteBytecode: false,
        compilerVersion: "0.8.24+commit.e11b9ed9",
        exportedAbi: routerRecord.exportedAbi.slice(1),
      },
    ]);

    expect(drifted.verified).toBe(false);
    expect(drifted.issues.length).toBe(3);
    expect(drifted.issues.every((i) => i.code === "provenance-mismatch")).toBe(true);
  });

  it("executes the CLI gate cleanly on current artifacts and rejects local failure fixtures", () => {
    const liveOut = execFileSync(process.execPath, [cliScript, "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const parsedLive = JSON.parse(liveOut) as { passed: boolean; provenanceVerified: boolean };
    expect(parsedLive.passed).toBe(true);
    expect(parsedLive.provenanceVerified).toBe(true);

    const tempDir = mkdtempSync(join(tmpdir(), "hyperion-abi-gate-"));
    try {
      const basePath = join(tempDir, "baseline.json");
      const brokenPath = join(tempDir, "broken.json");
      const additivePath = join(tempDir, "additive.json");
      const assessmentPath = join(tempDir, "assessments.json");

      const baseRouter = cloneAbi(hyperionRouterAbi);
      writeFileSync(basePath, JSON.stringify({ HyperionRouter: baseRouter }, null, 2));

      const withoutSettle = baseRouter.filter(
        (e) => !(e.type === "function" && e.name === "settleClaim"),
      );
      writeFileSync(brokenPath, JSON.stringify({ HyperionRouter: withoutSettle }, null, 2));

      let brokenExit = 0;
      try {
        execFileSync(
          process.execPath,
          [cliScript, "--baseline", basePath, "--proposed", brokenPath, "--json"],
          { cwd: packageRoot, stdio: "pipe" },
        );
      } catch (err) {
        brokenExit = (err as { status?: number }).status ?? 1;
      }
      expect(brokenExit).not.toBe(0);

      const withAdditive = [
        ...baseRouter,
        {
          type: "function",
          name: "schemaVersion",
          stateMutability: "pure",
          inputs: [],
          outputs: [{ name: "", type: "uint32", internalType: "uint32" }],
        },
      ];
      writeFileSync(additivePath, JSON.stringify({ HyperionRouter: withAdditive }, null, 2));

      let unassessedExit = 0;
      try {
        execFileSync(
          process.execPath,
          [cliScript, "--baseline", basePath, "--proposed", additivePath, "--json"],
          { cwd: packageRoot, stdio: "pipe" },
        );
      } catch (err) {
        unassessedExit = (err as { status?: number }).status ?? 1;
      }
      expect(unassessedExit).not.toBe(0);

      writeFileSync(
        assessmentPath,
        JSON.stringify(
          [
            {
              changeId: "HyperionRouter:function:schemaVersion():added-entry",
              summary: "Pure version query for deployment verification.",
              consumerSurfaces: ["sdk"],
              backwardCompatible: true,
              migrationSteps: ["Run npm run gen and rebuild @hyperion/protocol."],
            },
          ],
          null,
          2,
        ),
      );

      const assessedOut = execFileSync(
        process.execPath,
        [
          cliScript,
          "--baseline",
          basePath,
          "--proposed",
          additivePath,
          "--assessments",
          assessmentPath,
          "--json",
        ],
        { cwd: packageRoot, encoding: "utf8" },
      );
      const parsedAssessed = JSON.parse(assessedOut) as { passed: boolean; additiveCount: number };
      expect(parsedAssessed.passed).toBe(true);
      expect(parsedAssessed.additiveCount).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
