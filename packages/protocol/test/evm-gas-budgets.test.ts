import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  type EvmGasObservation,
  PINNED_EVM_COMPILER_PROFILE,
  PINNED_EVM_GAS_BUDGETS,
  evaluateEvmGasBudgets,
  gasBudgetCeiling,
} from "../src/evmGasBudgets.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const evmRoot = resolve(packageRoot, "..", "..", "evm");

describe("EVM governance and recovery gas budgets", () => {
  it("matches the pinned compiler profile in evm/foundry.toml and baselines in RouterGasBudgets.t.sol", () => {
    const foundryToml = readFileSync(join(evmRoot, "foundry.toml"), "utf8");
    expect(foundryToml).toContain(`solc = "${PINNED_EVM_COMPILER_PROFILE.solcVersion}"`);
    expect(foundryToml).toContain(`evm_version = "${PINNED_EVM_COMPILER_PROFILE.evmVersion}"`);
    expect(foundryToml).toContain("via_ir = true");
    expect(foundryToml).toContain("optimizer = true");
    expect(foundryToml).toContain(
      `optimizer_runs = ${String(PINNED_EVM_COMPILER_PROFILE.optimizerRuns)}`,
    );

    const solTest = readFileSync(
      join(evmRoot, "test", "unit", "RouterGasBudgets.t.sol"),
      "utf8",
    ).replaceAll("_", "");
    for (const budget of PINNED_EVM_GAS_BUDGETS) {
      const plain = budget.baselineGas.toString();
      expect(solTest, `missing baseline ${plain} for ${budget.id}`).toContain(`= ${plain};`);
    }
  });

  it("separates cold/warm storage and normal/hostile recipient budgets cleanly", () => {
    const baselineObservations: EvmGasObservation[] = PINNED_EVM_GAS_BUDGETS.map((b) => ({
      id: b.id,
      observedGas: b.baselineGas,
    }));

    const report = evaluateEvmGasBudgets(baselineObservations);
    expect(report.passed).toBe(true);
    expect(report.compilerProfileMatched).toBe(true);
    expect(report.regressions).toEqual([]);

    expect(report.byStorageTemperature.cold.length).toBeGreaterThanOrEqual(5);
    expect(report.byStorageTemperature.warm.length).toBeGreaterThanOrEqual(10);
    expect(report.byRecipientClass.normal.length).toBe(4);
    expect(report.byRecipientClass["hostile-frozen-revert"].length).toBe(3);
    expect(report.byRecipientClass["hostile-silent-false"].length).toBe(1);
    expect(report.byRecipientClass["hostile-malformed-hook"].length).toBe(1);

    // Every warm counterpart must have a lower baseline than its cold counterpart.
    const byId = new Map(report.metrics.map((m) => [m.id, m]));
    expect(byId.get("gov.queue.warm")!.baselineGas).toBeLessThan(
      byId.get("gov.queue.cold")!.baselineGas,
    );
    expect(byId.get("gov.execute.warm")!.baselineGas).toBeLessThan(
      byId.get("gov.execute.cold")!.baselineGas,
    );
    expect(byId.get("inbound.normal.warm")!.baselineGas).toBeLessThan(
      byId.get("inbound.normal.cold")!.baselineGas,
    );
    expect(byId.get("inbound.park.frozenWarm")!.baselineGas).toBeLessThan(
      byId.get("inbound.park.frozenCold")!.baselineGas,
    );
    expect(byId.get("recovery.settle.warm")!.baselineGas).toBeLessThan(
      byId.get("recovery.settle.cold")!.baselineGas,
    );
  });

  it("enforces documented tolerance ceilings and flags regressions with exact bps deltas", () => {
    const withinTolerance: EvmGasObservation[] = PINNED_EVM_GAS_BUDGETS.map((b) => ({
      id: b.id,
      observedGas: gasBudgetCeiling(b.baselineGas, b.toleranceBps),
    }));
    expect(evaluateEvmGasBudgets(withinTolerance).passed).toBe(true);

    const overCeiling: EvmGasObservation[] = PINNED_EVM_GAS_BUDGETS.map((b) => ({
      id: b.id,
      observedGas:
        b.id === "inbound.park.hostileHook" || b.id === "gov.queue.batch5"
          ? gasBudgetCeiling(b.baselineGas, b.toleranceBps) + 1n
          : b.baselineGas,
    }));
    const failed = evaluateEvmGasBudgets(overCeiling);
    expect(failed.passed).toBe(false);
    expect(failed.regressions.map((r) => r.id)).toEqual([
      "gov.queue.batch5",
      "inbound.park.hostileHook",
    ]);
    expect(failed.regressions[0]!.deltaBps).toBeGreaterThanOrEqual(1_000n);
  });

  it("rejects mismatched compiler profiles or missing observations", () => {
    const obs: EvmGasObservation[] = PINNED_EVM_GAS_BUDGETS.map((b) => ({
      id: b.id,
      observedGas: b.baselineGas,
    }));

    const wrongProfile = evaluateEvmGasBudgets(obs, {
      compilerProfile: {
        ...PINNED_EVM_COMPILER_PROFILE,
        evmVersion: "shanghai",
        viaIr: false,
      },
    });
    expect(wrongProfile.passed).toBe(false);
    expect(wrongProfile.compilerProfileMatched).toBe(false);
    expect(wrongProfile.profileMismatchReasons.length).toBe(2);

    const missingObs = evaluateEvmGasBudgets(obs.slice(1));
    expect(missingObs.passed).toBe(false);
    expect(missingObs.regressions[0]!.verdict).toBe("missing-observation");
  });
});
