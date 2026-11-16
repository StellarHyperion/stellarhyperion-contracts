/**
 * Pre-signing deployment artifact WASM size, headroom, and simulated resource admission reports.
 *
 * Soroban enforces a hard ledger ceiling on uploaded contract WASM size (64 KiB under current
 * protocol configurations) plus per-transaction ceilings on CPU instructions, linear memory,
 * read/write ledger footprint entries, read/write ledger bytes, and total XDR transaction size.
 * Evaluating those ceilings before touching a signing identity turns an oversized build or bloated
 * initialization footprint into a deterministic local refusal rather than a wasted fee or partial
 * phase-one deployment.
 */
import type { ChainKey } from "./chains.js";
import { chain, isChainKey, isStellarChain } from "./chains.js";
import {
  type Deployment,
  deployedChains,
  isStellarDeployment,
  parseDeploymentSet,
} from "./deployments.js";
import { ROUTE_KINDS, RouteKind } from "./routes.js";

/** Default Soroban Protocol 22 ledger ceiling on contract WASM code (64 KiB). */
export const DEFAULT_MAX_WASM_BYTES = 65_536;

/** Two-thirds warning threshold matching `script/stellar/build.sh` (`43,690` bytes). */
export const DEFAULT_WARN_WASM_BYTES = Math.floor((DEFAULT_MAX_WASM_BYTES * 2) / 3);

export const DEFAULT_SOROBAN_PROTOCOL_VERSION = 22;
export const DEFAULT_MAX_CPU_INSTRUCTIONS = 100_000_000;
export const DEFAULT_MAX_MEMORY_BYTES = 41_943_040; // 40 MiB
export const DEFAULT_MAX_READ_ENTRIES = 100;
export const DEFAULT_MAX_WRITE_ENTRIES = 50;
export const DEFAULT_MAX_READ_BYTES = 204_800; // 200 KiB
export const DEFAULT_MAX_WRITE_BYTES = 131_072; // 128 KiB
export const DEFAULT_MAX_TX_SIZE_BYTES = 131_072; // 128 KiB

/** Approximate XDR transaction envelope overhead around a Soroban `UploadContractWasm` host fn. */
const UPLOAD_ENVELOPE_OVERHEAD_BYTES = 512;

const VALIDATED_ACTIVE_ROUTES: readonly RouteKind[] = [RouteKind.Cctp, RouteKind.AxelarIts];

/** WASM binary magic `\0asm` followed by version `1` little-endian (`01 00 00 00`). */
const WASM_MAGIC_AND_V1 = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export type AdmissionArtifactName = "router" | "adapter-cctp" | "adapter-axelar";

export const ADMISSION_ARTIFACT_FILENAMES: Readonly<Record<AdmissionArtifactName, string>> = {
  router: "hyperion_router.wasm",
  "adapter-cctp": "hyperion_adapter_cctp.wasm",
  "adapter-axelar": "hyperion_adapter_axelar.wasm",
};

export type LedgerAssumptionsSource =
  "soroban-protocol-baseline" | "rpc-network-config" | "explicit-override";

/**
 * Active ledger protocol resource ceilings recorded explicitly alongside every admission report.
 */
export interface LedgerProtocolAssumptions {
  readonly chain: ChainKey;
  readonly networkPassphrase: string;
  readonly protocolVersion: number;
  readonly source: LedgerAssumptionsSource;
  readonly recordedAt: string;
  readonly maxContractSizeBytes: number;
  readonly warnContractSizeBytes: number;
  readonly maxCpuInstructions: number;
  readonly maxMemoryBytes: number;
  readonly maxReadEntries: number;
  readonly maxWriteEntries: number;
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxTxSizeBytes: number;
}

export interface SimulatedResourceInput {
  readonly operation?: string | undefined;
  readonly cpuInstructions?: number | undefined;
  readonly memoryBytes?: number | undefined;
  readonly readEntries?: number | undefined;
  readonly writeEntries?: number | undefined;
  readonly readBytes?: number | undefined;
  readonly writeBytes?: number | undefined;
  readonly txSizeBytes?: number | undefined;
  readonly minResourceFeeStroops?: string | undefined;
}

export interface ResourceMetricDiagnostic {
  readonly metric:
    | "wasmSizeBytes"
    | "cpuInstructions"
    | "memoryBytes"
    | "readEntries"
    | "writeEntries"
    | "readBytes"
    | "writeBytes"
    | "txSizeBytes";
  readonly used: number;
  readonly limit: number;
  /** Positive when within budget, negative when over budget. */
  readonly headroom: number;
  /** Basis points of the ceiling consumed (`10000` = 100.00%). */
  readonly utilizationBps: number;
  readonly exceeded: boolean;
}

export interface ArtifactCandidateInput {
  readonly name: AdmissionArtifactName;
  readonly fileName?: string | undefined;
  readonly sizeBytes: number;
  readonly codeHash: string;
  /** Optional raw WASM binary header or full bytes for magic/version verification. */
  readonly wasmBytes?: Uint8Array | undefined;
  /** Optional simulated resource footprint from `stellar contract invoke` / `simulateTransaction`. */
  readonly simulatedResources?: SimulatedResourceInput | undefined;
}

export interface PreviousArtifactBaseline {
  readonly codeHash: string;
  readonly sizeBytes?: number | undefined;
}

export interface PreviousBuildComparison {
  readonly status: "unchanged" | "modified" | "new-artifact";
  readonly previousCodeHash: string | null;
  readonly currentCodeHash: string;
  readonly codeHashChanged: boolean;
  readonly previousSizeBytes: number | null;
  readonly sizeDeltaBytes: number | null;
}

export type AdmissionRejectionCode =
  | "empty-wasm-artifact"
  | "invalid-wasm-binary"
  | "wasm-size-exceeded"
  | "cpu-budget-exceeded"
  | "memory-budget-exceeded"
  | "read-entries-exceeded"
  | "write-entries-exceeded"
  | "read-bytes-exceeded"
  | "write-bytes-exceeded"
  | "tx-size-exceeded"
  | "gated-unvalidated-scope";

export interface AdmissionViolation {
  readonly code: AdmissionRejectionCode;
  readonly detail: string;
}

export interface ArtifactAdmissionReport {
  readonly name: AdmissionArtifactName;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly headroomBytes: number;
  readonly sizeUtilizationBps: number;
  readonly sizeWarning: boolean;
  readonly admitted: boolean;
  readonly comparison: PreviousBuildComparison;
  readonly simulatedOperation: string;
  readonly minResourceFeeStroops: string | null;
  readonly diagnostics: readonly ResourceMetricDiagnostic[];
  readonly violations: readonly AdmissionViolation[];
  readonly warnings: readonly string[];
}

export interface DeploymentAdmissionReport {
  readonly stage: "pre-signing";
  readonly chain: ChainKey;
  readonly family: "stellar" | "evm";
  readonly validationGate: "active-validated" | "gated-unvalidated";
  readonly admitted: boolean;
  /** False whenever `admitted` is false or the target chain/rail is gated. */
  readonly signingPermitted: boolean;
  readonly protocolAssumptions: LedgerProtocolAssumptions;
  readonly artifacts: readonly ArtifactAdmissionReport[];
}

export interface BuildAdmissionReportInput {
  readonly chain: ChainKey;
  readonly candidates: readonly ArtifactCandidateInput[];
  readonly previousDeploymentSet?: unknown;
  readonly previousArtifactSizes?: Partial<Record<AdmissionArtifactName, number>> | undefined;
  readonly protocolAssumptions?: Partial<Omit<LedgerProtocolAssumptions, "chain">> | undefined;
  readonly recordedAt?: string | undefined;
}

export class AdmissionFormatError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`invalid resource admission input at ${path}: ${detail}`);
    this.name = "AdmissionFormatError";
    this.path = path;
  }
}

function fail(path: string, detail: string): never {
  throw new AdmissionFormatError(path, detail);
}

function assertNoSecrets(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (/\bS[A-Z2-7]{55}\b/.test(value)) {
      fail(path, "secret Stellar seed material is forbidden in admission inputs");
    }
    if (/(?:private[_-]?key|secret[_-]?key|mnemonic)\s*[:=]/i.test(value)) {
      fail(path, "secret key material is forbidden in admission inputs");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoSecrets(value[i], `${path}[${String(i)}]`);
    }
    return;
  }
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}

function assertWasmHash(value: string, path: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    fail(path, `expected 64 lowercase hex characters, got "${value}"`);
  }
  return value;
}

function assertNonNegativeInt(value: number, path: string): number {
  if (!Number.isInteger(value) || value < 0) {
    fail(path, `expected non-negative integer, got ${String(value)}`);
  }
  return value;
}

function assertPositiveInt(value: number, path: string): number {
  if (!Number.isInteger(value) || value < 1) {
    fail(path, `expected positive integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Inspect a WASM binary's magic bytes and version header (`\0asm\x01\x00\x00\x00`).
 */
export function isValidWasmBinary(bytes: Uint8Array): boolean {
  if (bytes.length < WASM_MAGIC_AND_V1.length) return false;
  for (let i = 0; i < WASM_MAGIC_AND_V1.length; i += 1) {
    if (bytes[i] !== WASM_MAGIC_AND_V1[i]) return false;
  }
  return true;
}

/**
 * Resolve active ledger protocol assumptions for a Stellar chain, recording explicit ceilings and
 * provenance (`soroban-protocol-baseline`, `rpc-network-config`, or `explicit-override`).
 */
export function resolveLedgerProtocolAssumptions(
  chainKey: ChainKey,
  overrides?: Partial<Omit<LedgerProtocolAssumptions, "chain">>,
  recordedAt = "2026-10-29T00:00:00.000Z",
): LedgerProtocolAssumptions {
  if (!isChainKey(chainKey)) {
    fail("$.chain", `unknown chain key "${String(chainKey)}"`);
  }
  const meta = chain(chainKey);
  const defaultPassphrase = isStellarChain(meta)
    ? meta.networkPassphrase
    : `evm:${String(meta.chainId)}`;
  const networkPassphrase = overrides?.networkPassphrase ?? defaultPassphrase;
  if (isStellarChain(meta) && networkPassphrase !== meta.networkPassphrase) {
    fail(
      "$.protocolAssumptions.networkPassphrase",
      `protocol assumptions passphrase "${networkPassphrase}" disagrees with "${chainKey}" ("${meta.networkPassphrase}")`,
    );
  }

  const maxContractSizeBytes = assertPositiveInt(
    overrides?.maxContractSizeBytes ?? DEFAULT_MAX_WASM_BYTES,
    "$.protocolAssumptions.maxContractSizeBytes",
  );
  const warnContractSizeBytes = assertPositiveInt(
    overrides?.warnContractSizeBytes ?? Math.floor((maxContractSizeBytes * 2) / 3),
    "$.protocolAssumptions.warnContractSizeBytes",
  );
  if (warnContractSizeBytes > maxContractSizeBytes) {
    fail(
      "$.protocolAssumptions.warnContractSizeBytes",
      "warning ceiling cannot exceed maxContractSizeBytes",
    );
  }

  const hasCustomOverride =
    overrides !== undefined &&
    Object.keys(overrides).some((k) => k !== "recordedAt" && k !== "source");

  return {
    chain: chainKey,
    networkPassphrase,
    protocolVersion: assertPositiveInt(
      overrides?.protocolVersion ?? DEFAULT_SOROBAN_PROTOCOL_VERSION,
      "$.protocolAssumptions.protocolVersion",
    ),
    source:
      overrides?.source ?? (hasCustomOverride ? "explicit-override" : "soroban-protocol-baseline"),
    recordedAt: overrides?.recordedAt ?? recordedAt,
    maxContractSizeBytes,
    warnContractSizeBytes,
    maxCpuInstructions: assertPositiveInt(
      overrides?.maxCpuInstructions ?? DEFAULT_MAX_CPU_INSTRUCTIONS,
      "$.protocolAssumptions.maxCpuInstructions",
    ),
    maxMemoryBytes: assertPositiveInt(
      overrides?.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES,
      "$.protocolAssumptions.maxMemoryBytes",
    ),
    maxReadEntries: assertPositiveInt(
      overrides?.maxReadEntries ?? DEFAULT_MAX_READ_ENTRIES,
      "$.protocolAssumptions.maxReadEntries",
    ),
    maxWriteEntries: assertPositiveInt(
      overrides?.maxWriteEntries ?? DEFAULT_MAX_WRITE_ENTRIES,
      "$.protocolAssumptions.maxWriteEntries",
    ),
    maxReadBytes: assertPositiveInt(
      overrides?.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
      "$.protocolAssumptions.maxReadBytes",
    ),
    maxWriteBytes: assertPositiveInt(
      overrides?.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES,
      "$.protocolAssumptions.maxWriteBytes",
    ),
    maxTxSizeBytes: assertPositiveInt(
      overrides?.maxTxSizeBytes ?? DEFAULT_MAX_TX_SIZE_BYTES,
      "$.protocolAssumptions.maxTxSizeBytes",
    ),
  };
}

function makeMetricDiagnostic(
  metric: ResourceMetricDiagnostic["metric"],
  used: number,
  limit: number,
): ResourceMetricDiagnostic {
  const headroom = limit - used;
  const utilizationBps = Math.round((used * 10_000) / limit);
  return {
    metric,
    used,
    limit,
    headroom,
    utilizationBps,
    exceeded: used > limit,
  };
}

interface BaselineUploadEstimate {
  readonly operation: string;
  readonly cpuInstructions: number;
  readonly memoryBytes: number;
  readonly readEntries: number;
  readonly writeEntries: number;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly txSizeBytes: number;
}

function estimateBaselineUploadResources(sizeBytes: number): BaselineUploadEstimate {
  // Deterministic conservative pre-RPC model of a Soroban `UploadContractWasm` transaction:
  // - WASM parsing & validation scales linearly with binary size plus host dispatch overhead.
  // - 1 ContractCode ledger write entry of `sizeBytes + 128` XDR framing bytes.
  // - Envelope size equals WASM payload plus Soroban footprint + auth + XDR header (~512 B).
  return {
    operation: "upload-wasm-envelope-estimate",
    cpuInstructions: 2_500_000 + sizeBytes * 350,
    memoryBytes: 2_097_152 + sizeBytes * 16,
    readEntries: 1,
    writeEntries: 1,
    readBytes: 256,
    writeBytes: sizeBytes + 128,
    txSizeBytes: sizeBytes + UPLOAD_ENVELOPE_OVERHEAD_BYTES,
  };
}

function computeValidationGate(
  chainKey: ChainKey,
  previousDep: Deployment | undefined,
): "active-validated" | "gated-unvalidated" {
  if (chainKey !== "stellar-testnet") return "gated-unvalidated";
  if (previousDep !== undefined && isStellarDeployment(previousDep)) {
    for (const kind of ROUTE_KINDS) {
      if (previousDep.adapters[kind] !== undefined && !VALIDATED_ACTIVE_ROUTES.includes(kind)) {
        return "gated-unvalidated";
      }
    }
  }
  return "active-validated";
}

/**
 * Evaluate pre-signing WASM size, headroom, previous-build deltas, and simulated resource budgets.
 */
export function buildResourceAdmissionReport(
  input: BuildAdmissionReportInput,
): DeploymentAdmissionReport {
  assertNoSecrets(input, "$");
  if (!isChainKey(input.chain)) {
    fail("$.chain", `unknown chain key "${String(input.chain)}"`);
  }
  if (input.candidates.length === 0) {
    fail("$.candidates", "at least one deployment artifact candidate is required");
  }

  const prevSet =
    input.previousDeploymentSet !== undefined
      ? parseDeploymentSet(input.previousDeploymentSet)
      : undefined;
  if (
    prevSet !== undefined &&
    prevSet.networks[input.chain] === undefined &&
    deployedChains(prevSet).length > 0
  ) {
    fail(
      `$.previousDeploymentSet.networks.${input.chain}`,
      `previous deployment set does not contain "${input.chain}" (present: ${deployedChains(prevSet).join(", ")})`,
    );
  }
  const prevDep = prevSet?.networks[input.chain];
  const prevStellar = prevDep !== undefined && isStellarDeployment(prevDep) ? prevDep : undefined;

  const recordedAt = input.recordedAt ?? prevSet?.generatedAt ?? "2026-10-29T00:00:00.000Z";
  const assumptions = resolveLedgerProtocolAssumptions(
    input.chain,
    input.protocolAssumptions,
    recordedAt,
  );
  const chainMeta = chain(input.chain);
  const family = isStellarChain(chainMeta) ? "stellar" : "evm";
  const validationGate = computeValidationGate(input.chain, prevDep);

  const seen = new Set<string>();
  const artifactReports: ArtifactAdmissionReport[] = [];

  for (let i = 0; i < input.candidates.length; i += 1) {
    const cand = input.candidates[i];
    if (cand === undefined) continue;
    const cPath = `$.candidates[${String(i)}]`;
    if (!(cand.name in ADMISSION_ARTIFACT_FILENAMES)) {
      fail(`${cPath}.name`, `unknown artifact name "${cand.name}"`);
    }
    if (seen.has(cand.name)) {
      fail(`${cPath}.name`, `duplicate artifact candidate "${cand.name}"`);
    }
    seen.add(cand.name);

    const sizeBytes = assertNonNegativeInt(cand.sizeBytes, `${cPath}.sizeBytes`);
    const codeHash = assertWasmHash(cand.codeHash, `${cPath}.codeHash`);
    const fileName = cand.fileName ?? ADMISSION_ARTIFACT_FILENAMES[cand.name];

    const violations: AdmissionViolation[] = [];
    const warnings: string[] = [];

    if (validationGate === "gated-unvalidated") {
      violations.push({
        code: "gated-unvalidated-scope",
        detail: `chain "${input.chain}" is gated pending independent validation; pre-signing admission refuses live signing`,
      });
    }

    if (sizeBytes === 0) {
      violations.push({
        code: "empty-wasm-artifact",
        detail: `${fileName} is empty (0 bytes)`,
      });
    }

    if (cand.wasmBytes !== undefined) {
      if (cand.wasmBytes.length !== sizeBytes) {
        fail(
          `${cPath}.wasmBytes`,
          `wasmBytes length (${String(cand.wasmBytes.length)}) disagrees with sizeBytes (${String(sizeBytes)})`,
        );
      }
      if (!isValidWasmBinary(cand.wasmBytes)) {
        violations.push({
          code: "invalid-wasm-binary",
          detail: `${fileName} lacks a valid WebAssembly v1 binary header (\\0asm\\x01\\x00\\x00\\x00)`,
        });
      }
    }

    const wasmDiag = makeMetricDiagnostic(
      "wasmSizeBytes",
      sizeBytes,
      assumptions.maxContractSizeBytes,
    );
    if (wasmDiag.exceeded) {
      violations.push({
        code: "wasm-size-exceeded",
        detail: `${fileName} is ${String(sizeBytes)} bytes, exceeding maxContractSizeBytes (${String(assumptions.maxContractSizeBytes)}) by ${String(-wasmDiag.headroom)} bytes`,
      });
    }

    const sizeWarning = !wasmDiag.exceeded && sizeBytes > assumptions.warnContractSizeBytes;
    if (sizeWarning) {
      warnings.push(
        `${fileName} (${String(sizeBytes)} bytes) exceeds warning threshold (${String(assumptions.warnContractSizeBytes)} bytes); only ${String(wasmDiag.headroom)} bytes of headroom remain`,
      );
    }

    const baselineEst = estimateBaselineUploadResources(sizeBytes);
    const sim = cand.simulatedResources;
    const cpuUsed = assertNonNegativeInt(
      sim?.cpuInstructions ?? baselineEst.cpuInstructions,
      `${cPath}.simulatedResources.cpuInstructions`,
    );
    const memUsed = assertNonNegativeInt(
      sim?.memoryBytes ?? baselineEst.memoryBytes,
      `${cPath}.simulatedResources.memoryBytes`,
    );
    const readEntriesUsed = assertNonNegativeInt(
      sim?.readEntries ?? baselineEst.readEntries,
      `${cPath}.simulatedResources.readEntries`,
    );
    const writeEntriesUsed = assertNonNegativeInt(
      sim?.writeEntries ?? baselineEst.writeEntries,
      `${cPath}.simulatedResources.writeEntries`,
    );
    const readBytesUsed = assertNonNegativeInt(
      sim?.readBytes ?? baselineEst.readBytes,
      `${cPath}.simulatedResources.readBytes`,
    );
    const writeBytesUsed = assertNonNegativeInt(
      sim?.writeBytes ?? baselineEst.writeBytes,
      `${cPath}.simulatedResources.writeBytes`,
    );
    const txSizeUsed = assertNonNegativeInt(
      sim?.txSizeBytes ?? baselineEst.txSizeBytes,
      `${cPath}.simulatedResources.txSizeBytes`,
    );

    let minFeeStroops: string | null = null;
    if (sim?.minResourceFeeStroops !== undefined) {
      if (!/^\d+$/.test(sim.minResourceFeeStroops)) {
        fail(
          `${cPath}.simulatedResources.minResourceFeeStroops`,
          "expected non-negative integer stroop string",
        );
      }
      minFeeStroops = sim.minResourceFeeStroops;
    }

    const cpuDiag = makeMetricDiagnostic(
      "cpuInstructions",
      cpuUsed,
      assumptions.maxCpuInstructions,
    );
    const memDiag = makeMetricDiagnostic("memoryBytes", memUsed, assumptions.maxMemoryBytes);
    const readEntDiag = makeMetricDiagnostic(
      "readEntries",
      readEntriesUsed,
      assumptions.maxReadEntries,
    );
    const writeEntDiag = makeMetricDiagnostic(
      "writeEntries",
      writeEntriesUsed,
      assumptions.maxWriteEntries,
    );
    const readBytesDiag = makeMetricDiagnostic(
      "readBytes",
      readBytesUsed,
      assumptions.maxReadBytes,
    );
    const writeBytesDiag = makeMetricDiagnostic(
      "writeBytes",
      writeBytesUsed,
      assumptions.maxWriteBytes,
    );
    const txSizeDiag = makeMetricDiagnostic("txSizeBytes", txSizeUsed, assumptions.maxTxSizeBytes);

    const budgetChecks: readonly {
      readonly diag: ResourceMetricDiagnostic;
      readonly code: AdmissionRejectionCode;
      readonly label: string;
    }[] = [
      { diag: cpuDiag, code: "cpu-budget-exceeded", label: "CPU instructions" },
      { diag: memDiag, code: "memory-budget-exceeded", label: "linear memory bytes" },
      { diag: readEntDiag, code: "read-entries-exceeded", label: "read ledger entries" },
      { diag: writeEntDiag, code: "write-entries-exceeded", label: "write ledger entries" },
      { diag: readBytesDiag, code: "read-bytes-exceeded", label: "read ledger bytes" },
      { diag: writeBytesDiag, code: "write-bytes-exceeded", label: "write ledger bytes" },
      { diag: txSizeDiag, code: "tx-size-exceeded", label: "transaction size bytes" },
    ];

    for (const item of budgetChecks) {
      if (item.diag.exceeded) {
        violations.push({
          code: item.code,
          detail: `simulated ${item.label} (${String(item.diag.used)}) exceeds protocol ceiling (${String(item.diag.limit)}) by ${String(-item.diag.headroom)}`,
        });
      }
    }

    // Compare against previous recorded build.
    const previousCodeHash = prevStellar?.wasmHashes[cand.name] ?? null;
    const previousSizeBytes = input.previousArtifactSizes?.[cand.name] ?? null;
    const codeHashChanged = previousCodeHash !== null && previousCodeHash !== codeHash;
    const sizeDeltaBytes = previousSizeBytes !== null ? sizeBytes - previousSizeBytes : null;
    const comparisonStatus: PreviousBuildComparison["status"] =
      previousCodeHash === null ? "new-artifact" : codeHashChanged ? "modified" : "unchanged";

    const admitted = violations.length === 0;
    artifactReports.push({
      name: cand.name,
      fileName,
      sizeBytes,
      headroomBytes: wasmDiag.headroom,
      sizeUtilizationBps: wasmDiag.utilizationBps,
      sizeWarning,
      admitted,
      comparison: {
        status: comparisonStatus,
        previousCodeHash,
        currentCodeHash: codeHash,
        codeHashChanged,
        previousSizeBytes,
        sizeDeltaBytes,
      },
      simulatedOperation: sim?.operation ?? baselineEst.operation,
      minResourceFeeStroops: minFeeStroops,
      diagnostics: [
        wasmDiag,
        cpuDiag,
        memDiag,
        readEntDiag,
        writeEntDiag,
        readBytesDiag,
        writeBytesDiag,
        txSizeDiag,
      ],
      violations,
      warnings,
    });
  }

  const allAdmitted = artifactReports.length > 0 && artifactReports.every((art) => art.admitted);

  return {
    stage: "pre-signing",
    chain: input.chain,
    family,
    validationGate,
    admitted: allAdmitted,
    signingPermitted: allAdmitted && validationGate === "active-validated",
    protocolAssumptions: assumptions,
    artifacts: artifactReports,
  };
}

/**
 * Format a deterministic, secret-free pre-signing WASM size and resource admission report.
 */
export function formatResourceAdmissionReport(report: DeploymentAdmissionReport): string {
  const a = report.protocolAssumptions;
  const lines: string[] = [
    `Deployment Artifact Admission Report (${report.chain}, stage=${report.stage})`,
    `Admission: ${report.admitted ? "ADMITTED" : "REJECTED (blocked before signing)"} | signingPermitted=${String(report.signingPermitted)} | gate=${report.validationGate}`,
    `Ledger Protocol Assumptions [source=${a.source}, protocol=v${String(a.protocolVersion)}, passphrase="${a.networkPassphrase}"]`,
    `  maxContractSizeBytes=${String(a.maxContractSizeBytes)} (warn=${String(a.warnContractSizeBytes)}) | maxTxSizeBytes=${String(a.maxTxSizeBytes)}`,
    `  maxCpuInstructions=${String(a.maxCpuInstructions)} | maxMemoryBytes=${String(a.maxMemoryBytes)}`,
    `  maxReadEntries=${String(a.maxReadEntries)} (${String(a.maxReadBytes)} B) | maxWriteEntries=${String(a.maxWriteEntries)} (${String(a.maxWriteBytes)} B)`,
  ];

  for (const art of report.artifacts) {
    const pct = (art.sizeUtilizationBps / 100).toFixed(2);
    const deltaText =
      art.comparison.sizeDeltaBytes === null
        ? "n/a"
        : art.comparison.sizeDeltaBytes >= 0
          ? `+${String(art.comparison.sizeDeltaBytes)} B`
          : `${String(art.comparison.sizeDeltaBytes)} B`;
    lines.push("");
    lines.push(
      `[${art.admitted ? "PASS" : "FAIL"}] ${art.name} (${art.fileName}): ${String(art.sizeBytes)} B (${pct}%, headroom=${String(art.headroomBytes)} B, delta=${deltaText})`,
    );
    lines.push(
      `  build vs previous: ${art.comparison.status} (prev=${art.comparison.previousCodeHash ?? "<none>"} -> curr=${art.comparison.currentCodeHash})`,
    );
    const cpu = art.diagnostics.find((d) => d.metric === "cpuInstructions");
    const mem = art.diagnostics.find((d) => d.metric === "memoryBytes");
    const wb = art.diagnostics.find((d) => d.metric === "writeBytes");
    if (cpu !== undefined && mem !== undefined && wb !== undefined) {
      lines.push(
        `  simulated [${art.simulatedOperation}]: cpu=${String(cpu.used)}/${String(cpu.limit)}, mem=${String(mem.used)}/${String(mem.limit)} B, writeBytes=${String(wb.used)}/${String(wb.limit)} B`,
      );
    }
    for (const v of art.violations) {
      lines.push(`  violation [${v.code}]: ${v.detail}`);
    }
    for (const w of art.warnings) {
      lines.push(`  warning: ${w}`);
    }
  }

  return lines.join("\n");
}
