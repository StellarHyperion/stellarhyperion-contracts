import { describe, expect, it } from "vitest";
import {
  SOROBAN_RESOURCE_ASSUMPTIONS,
  SOROBAN_ROUTER_BENCHMARK_BASELINES,
  compareSorobanBenchmarkSuite,
  evaluateSorobanBenchmarkSample,
  formatSorobanBenchmarkDelta,
} from "../src/index.js";
import type { SorobanBenchmarkMeasurement } from "../src/index.js";

function exactMeasurementsFromBaselines(): SorobanBenchmarkMeasurement[] {
  return SOROBAN_ROUTER_BENCHMARK_BASELINES.map((b) => ({
    operation: b.operation,
    inputBytes: b.inputBytes,
    storedRecordBytes: b.storedRecordBytes,
    cpuInsns: b.baselineCpuInsns,
    memBytes: b.baselineMemBytes,
    assumptions: SOROBAN_RESOURCE_ASSUMPTIONS,
  }));
}

describe("Soroban reproducible CPU and memory budget benchmarks", () => {
  it("records input sizes, stored-record sizes, and pinned protocol/resource assumptions across quote, dispatch, inbound, settlement, and keeper paths", () => {
    expect(SOROBAN_RESOURCE_ASSUMPTIONS.sorobanSdkVersion).toBe("28.0.0");
    expect(SOROBAN_RESOURCE_ASSUMPTIONS.sorobanEnvHostVersion).toBe("28.0.2");
    expect(SOROBAN_RESOURCE_ASSUMPTIONS.ledgerProtocolVersion).toBe(28);
    expect(SOROBAN_RESOURCE_ASSUMPTIONS.txCpuInstructionLimit).toBe(100_000_000n);
    expect(SOROBAN_RESOURCE_ASSUMPTIONS.txMemoryBytesLimit).toBe(41_943_040n);

    const report = compareSorobanBenchmarkSuite(exactMeasurementsFromBaselines());
    expect(report.passed).toBe(true);
    expect(report.regressions).toEqual([]);
    expect(report.results.length).toBe(9);

    const categories = new Set(SOROBAN_ROUTER_BENCHMARK_BASELINES.map((b) => b.category));
    expect(categories).toEqual(new Set(["quote", "dispatch", "inbound", "settlement", "keeper"]));

    // Large-but-valid stored records carry measurably larger serialized state and higher metered usage.
    const compactOut = SOROBAN_ROUTER_BENCHMARK_BASELINES.find(
      (b) => b.operation === "bridge_out_compact",
    );
    const largeOut = SOROBAN_ROUTER_BENCHMARK_BASELINES.find(
      (b) => b.operation === "bridge_out_large_stored_record",
    );
    expect(compactOut).toBeDefined();
    expect(largeOut).toBeDefined();
    if (compactOut !== undefined && largeOut !== undefined) {
      expect(largeOut.storedRecordBytes).toBeGreaterThan(compactOut.storedRecordBytes);
      expect(largeOut.baselineCpuInsns).toBeGreaterThan(compactOut.baselineCpuInsns);
      expect(largeOut.baselineMemBytes).toBeGreaterThan(compactOut.baselineMemBytes);
    }
  });

  it("produces actionable signed CPU/memory deltas, ceiling overruns, and network headroom on budget regressions", () => {
    const baseline = SOROBAN_ROUTER_BENCHMARK_BASELINES[3];
    expect(baseline?.operation).toBe("bridge_out_large_stored_record");
    if (baseline === undefined) return;

    const regressedSample: SorobanBenchmarkMeasurement = {
      operation: baseline.operation,
      inputBytes: baseline.inputBytes,
      storedRecordBytes: baseline.storedRecordBytes,
      cpuInsns: baseline.baselineCpuInsns + 150_000n,
      memBytes: baseline.baselineMemBytes + 80_000n,
      assumptions: SOROBAN_RESOURCE_ASSUMPTIONS,
    };

    const delta = evaluateSorobanBenchmarkSample(regressedSample, baseline);
    expect(delta.regressed).toBe(true);
    expect(delta.assumptionMismatch).toBe(false);
    expect(delta.cpuDeltaInsns).toBe(150_000n);
    expect(delta.cpuDeltaBps).toBeGreaterThan(1_200n);
    expect(delta.cpuCeilingOverrunInsns).toBeGreaterThan(0n);
    expect(delta.cpuTxHeadroomInsns).toBe(100_000_000n - regressedSample.cpuInsns);
    expect(delta.memDeltaBytes).toBe(80_000n);
    expect(delta.memCeilingOverrunBytes).toBeGreaterThan(0n);

    const formatted = formatSorobanBenchmarkDelta(delta);
    expect(formatted).toContain("[REGRESSION] op=bridge_out_large_stored_record");
    expect(formatted).toContain("cpuDelta=+150000 insns");
    expect(formatted).toContain("memDelta=+80000 B");
    expect(formatted).toContain("txHeadroom=");
  });

  it("flags input-size, stored-record-size, and host/protocol assumption drift explicitly", () => {
    const measurements = exactMeasurementsFromBaselines();
    const first = measurements[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    measurements[0] = {
      ...first,
      inputBytes: first.inputBytes + 12,
      assumptions: {
        ...first.assumptions,
        ledgerProtocolVersion: 29,
      },
    };

    const suite = compareSorobanBenchmarkSuite(measurements);
    expect(suite.passed).toBe(false);
    expect(suite.regressions.length).toBe(1);
    expect(suite.regressions[0]?.assumptionMismatch).toBe(true);
    expect(suite.regressions[0]?.inputBytesDelta).toBe(12);
    expect(suite.regressions[0]?.summary).toContain("delta=+12B");
  });
});
