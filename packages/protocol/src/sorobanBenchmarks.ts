/**
 * Reproducible Soroban CPU and memory budget baseline catalog and actionable regression delta
 * comparator for `HyperionRouter` quote, outbound dispatch, inbound delivery, claim settlement,
 * and batch keeper paths.
 */

export interface SorobanResourceAssumptions {
  readonly sorobanSdkVersion: string;
  readonly sorobanEnvHostVersion: string;
  readonly rustToolchainMsrv: string;
  readonly ledgerProtocolVersion: number;
  readonly txCpuInstructionLimit: bigint;
  readonly txMemoryBytesLimit: bigint;
  readonly executionMode: "native-testutils-metered-host" | "wasm-vm-metered-host";
}

export interface SorobanBenchmarkBaseline {
  readonly operation: string;
  readonly category: "quote" | "dispatch" | "inbound" | "settlement" | "keeper";
  readonly inputBytes: number;
  readonly storedRecordBytes: number;
  readonly seededClaims: number;
  readonly seededTransfers: number;
  readonly baselineCpuInsns: bigint;
  readonly baselineMemBytes: bigint;
  /** Allowed upward budget drift in basis points (`500` = `+5.00%`). */
  readonly toleranceBps: number;
}

export interface SorobanBenchmarkMeasurement {
  readonly operation: string;
  readonly inputBytes: number;
  readonly storedRecordBytes: number;
  readonly cpuInsns: bigint;
  readonly memBytes: bigint;
  readonly assumptions: SorobanResourceAssumptions;
}

export interface SorobanActionableDelta {
  readonly operation: string;
  readonly regressed: boolean;
  readonly assumptionMismatch: boolean;
  readonly inputBytesDelta: number;
  readonly storedRecordBytesDelta: number;
  readonly cpuDeltaInsns: bigint;
  readonly cpuDeltaBps: bigint;
  readonly cpuCeilingInsns: bigint;
  readonly cpuCeilingOverrunInsns: bigint;
  readonly cpuTxHeadroomInsns: bigint;
  readonly cpuTxUtilizationBps: bigint;
  readonly memDeltaBytes: bigint;
  readonly memDeltaBps: bigint;
  readonly memCeilingBytes: bigint;
  readonly memCeilingOverrunBytes: bigint;
  readonly memTxHeadroomBytes: bigint;
  readonly memTxUtilizationBps: bigint;
  readonly summary: string;
}

export interface SorobanBenchmarkSuiteReport {
  readonly passed: boolean;
  readonly results: readonly SorobanActionableDelta[];
  readonly regressions: readonly SorobanActionableDelta[];
}

export const SOROBAN_RESOURCE_ASSUMPTIONS: SorobanResourceAssumptions = {
  sorobanSdkVersion: "28.0.0",
  sorobanEnvHostVersion: "28.0.2",
  rustToolchainMsrv: "1.87",
  ledgerProtocolVersion: 28,
  txCpuInstructionLimit: 100_000_000n,
  txMemoryBytesLimit: 41_943_040n,
  executionMode: "native-testutils-metered-host",
};

export const SOROBAN_ROUTER_BENCHMARK_BASELINES: readonly SorobanBenchmarkBaseline[] = [
  {
    operation: "quote_routes_compact",
    category: "quote",
    inputBytes: 80,
    storedRecordBytes: 1436,
    seededClaims: 0,
    seededTransfers: 0,
    baselineCpuInsns: 620_116n,
    baselineMemBytes: 202_387n,
    toleranceBps: 500,
  },
  {
    operation: "bridge_out_compact",
    category: "dispatch",
    inputBytes: 388,
    storedRecordBytes: 456,
    seededClaims: 0,
    seededTransfers: 0,
    baselineCpuInsns: 755_523n,
    baselineMemBytes: 297_851n,
    toleranceBps: 500,
  },
  {
    operation: "quote_routes_large_stored_state",
    category: "quote",
    inputBytes: 80,
    storedRecordBytes: 1436,
    seededClaims: 16,
    seededTransfers: 16,
    baselineCpuInsns: 788_236n,
    baselineMemBytes: 277_323n,
    toleranceBps: 500,
  },
  {
    operation: "bridge_out_large_stored_record",
    category: "dispatch",
    inputBytes: 444,
    storedRecordBytes: 512,
    seededClaims: 16,
    seededTransfers: 16,
    baselineCpuInsns: 1_237_119n,
    baselineMemBytes: 512_686n,
    toleranceBps: 500,
  },
  {
    operation: "bridge_out_with_gas_large_stored_record",
    category: "dispatch",
    inputBytes: 464,
    storedRecordBytes: 512,
    seededClaims: 16,
    seededTransfers: 16,
    baselineCpuInsns: 1_140_072n,
    baselineMemBytes: 472_095n,
    toleranceBps: 500,
  },
  {
    operation: "bridge_in_direct_large_payload",
    category: "inbound",
    inputBytes: 600,
    storedRecordBytes: 32,
    seededClaims: 16,
    seededTransfers: 16,
    baselineCpuInsns: 635_239n,
    baselineMemBytes: 301_125n,
    toleranceBps: 500,
  },
  {
    operation: "bridge_in_park_large_claim_record",
    category: "inbound",
    inputBytes: 600,
    storedRecordBytes: 392,
    seededClaims: 16,
    seededTransfers: 16,
    baselineCpuInsns: 873_442n,
    baselineMemBytes: 395_871n,
    toleranceBps: 500,
  },
  {
    operation: "settle_claim_large_stored_record",
    category: "settlement",
    inputBytes: 64,
    storedRecordBytes: 392,
    seededClaims: 16,
    seededTransfers: 16,
    baselineCpuInsns: 548_632n,
    baselineMemBytes: 270_626n,
    toleranceBps: 500,
  },
  {
    operation: "keep_alive_large_batch",
    category: "keeper",
    inputBytes: 636,
    storedRecordBytes: 68,
    seededClaims: 16,
    seededTransfers: 16,
    baselineCpuInsns: 4_025_009n,
    baselineMemBytes: 1_486_695n,
    toleranceBps: 500,
  },
];

function signedBigInt(n: bigint): string {
  return n >= 0n ? `+${n.toString()}` : n.toString();
}

function signedNumber(n: number): string {
  return n >= 0 ? `+${String(n)}` : String(n);
}

function sameAssumptions(a: SorobanResourceAssumptions, b: SorobanResourceAssumptions): boolean {
  return (
    a.sorobanSdkVersion === b.sorobanSdkVersion &&
    a.sorobanEnvHostVersion === b.sorobanEnvHostVersion &&
    a.rustToolchainMsrv === b.rustToolchainMsrv &&
    a.ledgerProtocolVersion === b.ledgerProtocolVersion &&
    a.txCpuInstructionLimit === b.txCpuInstructionLimit &&
    a.txMemoryBytesLimit === b.txMemoryBytesLimit &&
    a.executionMode === b.executionMode
  );
}

export function formatSorobanBenchmarkDelta(delta: SorobanActionableDelta): string {
  return delta.summary;
}

export function evaluateSorobanBenchmarkSample(
  sample: SorobanBenchmarkMeasurement,
  baseline: SorobanBenchmarkBaseline,
  expectedAssumptions: SorobanResourceAssumptions = SOROBAN_RESOURCE_ASSUMPTIONS,
): SorobanActionableDelta {
  const toleranceScale = 10_000n + BigInt(baseline.toleranceBps);
  const cpuCeilingInsns = (baseline.baselineCpuInsns * toleranceScale) / 10_000n;
  const memCeilingBytes = (baseline.baselineMemBytes * toleranceScale) / 10_000n;

  const cpuDeltaInsns = sample.cpuInsns - baseline.baselineCpuInsns;
  const cpuDeltaBps =
    baseline.baselineCpuInsns > 0n ? (cpuDeltaInsns * 10_000n) / baseline.baselineCpuInsns : 0n;
  const cpuCeilingOverrunInsns = sample.cpuInsns - cpuCeilingInsns;
  const cpuTxHeadroomInsns = sample.assumptions.txCpuInstructionLimit - sample.cpuInsns;
  const cpuTxUtilizationBps =
    (sample.cpuInsns * 10_000n) / sample.assumptions.txCpuInstructionLimit;

  const memDeltaBytes = sample.memBytes - baseline.baselineMemBytes;
  const memDeltaBps =
    baseline.baselineMemBytes > 0n ? (memDeltaBytes * 10_000n) / baseline.baselineMemBytes : 0n;
  const memCeilingOverrunBytes = sample.memBytes - memCeilingBytes;
  const memTxHeadroomBytes = sample.assumptions.txMemoryBytesLimit - sample.memBytes;
  const memTxUtilizationBps = (sample.memBytes * 10_000n) / sample.assumptions.txMemoryBytesLimit;

  const inputBytesDelta = sample.inputBytes - baseline.inputBytes;
  const storedRecordBytesDelta = sample.storedRecordBytes - baseline.storedRecordBytes;
  const assumptionMismatch =
    !sameAssumptions(sample.assumptions, expectedAssumptions) ||
    inputBytesDelta !== 0 ||
    storedRecordBytesDelta !== 0;

  const regressed =
    cpuCeilingOverrunInsns > 0n || memCeilingOverrunBytes > 0n || assumptionMismatch;

  const status = regressed ? "REGRESSION" : "OK";
  const summary = [
    `[${status}] op=${sample.operation}`,
    `input=${String(sample.inputBytes)}B (delta=${signedNumber(inputBytesDelta)}B)`,
    `record=${String(sample.storedRecordBytes)}B (delta=${signedNumber(storedRecordBytesDelta)}B)`,
    `cpuDelta=${signedBigInt(cpuDeltaInsns)} insns (${signedBigInt(cpuDeltaBps)} bps, ceilingOverrun=${signedBigInt(cpuCeilingOverrunInsns)}, txHeadroom=${cpuTxHeadroomInsns.toString()})`,
    `memDelta=${signedBigInt(memDeltaBytes)} B (${signedBigInt(memDeltaBps)} bps, ceilingOverrun=${signedBigInt(memCeilingOverrunBytes)}, txHeadroom=${memTxHeadroomBytes.toString()})`,
    `proto=v${String(sample.assumptions.ledgerProtocolVersion)} host=${sample.assumptions.sorobanEnvHostVersion}`,
  ].join(" | ");

  return {
    operation: sample.operation,
    regressed,
    assumptionMismatch,
    inputBytesDelta,
    storedRecordBytesDelta,
    cpuDeltaInsns,
    cpuDeltaBps,
    cpuCeilingInsns,
    cpuCeilingOverrunInsns,
    cpuTxHeadroomInsns,
    cpuTxUtilizationBps,
    memDeltaBytes,
    memDeltaBps,
    memCeilingBytes,
    memCeilingOverrunBytes,
    memTxHeadroomBytes,
    memTxUtilizationBps,
    summary,
  };
}

export function compareSorobanBenchmarkSuite(
  measurements: readonly SorobanBenchmarkMeasurement[],
  baselines: readonly SorobanBenchmarkBaseline[] = SOROBAN_ROUTER_BENCHMARK_BASELINES,
  expectedAssumptions: SorobanResourceAssumptions = SOROBAN_RESOURCE_ASSUMPTIONS,
): SorobanBenchmarkSuiteReport {
  const baselineByOp = new Map<string, SorobanBenchmarkBaseline>();
  for (const b of baselines) {
    baselineByOp.set(b.operation, b);
  }

  const results: SorobanActionableDelta[] = [];
  for (const sample of measurements) {
    const baseline = baselineByOp.get(sample.operation);
    if (baseline === undefined) {
      results.push({
        operation: sample.operation,
        regressed: true,
        assumptionMismatch: true,
        inputBytesDelta: sample.inputBytes,
        storedRecordBytesDelta: sample.storedRecordBytes,
        cpuDeltaInsns: sample.cpuInsns,
        cpuDeltaBps: 10_000n,
        cpuCeilingInsns: 0n,
        cpuCeilingOverrunInsns: sample.cpuInsns,
        cpuTxHeadroomInsns: sample.assumptions.txCpuInstructionLimit - sample.cpuInsns,
        cpuTxUtilizationBps: (sample.cpuInsns * 10_000n) / sample.assumptions.txCpuInstructionLimit,
        memDeltaBytes: sample.memBytes,
        memDeltaBps: 10_000n,
        memCeilingBytes: 0n,
        memCeilingOverrunBytes: sample.memBytes,
        memTxHeadroomBytes: sample.assumptions.txMemoryBytesLimit - sample.memBytes,
        memTxUtilizationBps: (sample.memBytes * 10_000n) / sample.assumptions.txMemoryBytesLimit,
        summary: `[REGRESSION] op=${sample.operation} | missing pinned baseline`,
      });
      continue;
    }
    results.push(evaluateSorobanBenchmarkSample(sample, baseline, expectedAssumptions));
  }

  const regressions = results.filter((r) => r.regressed);
  return {
    passed: regressions.length === 0 && results.length === baselines.length,
    results,
    regressions,
  };
}
