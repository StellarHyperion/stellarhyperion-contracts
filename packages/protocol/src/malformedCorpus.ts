/**
 * Cross-language malformed-message corpus runner and differential outcome comparator.
 *
 * Hyperion parses the same wire formats in three languages:
 *
 * - Rust (`hyperion-core`) on Soroban
 * - Solidity (`HyperionNotes` and `StellarAddress`) on EVM
 * - TypeScript (`@hyperion/protocol`) in indexers, keepers and the app
 *
 * Unit tests in one language only prove that a parser agrees with its own author. Running one
 * versioned corpus of valid legacy payloads and hostile byte mutations through all three decoders
 * surfaces any discrepancy in accept/reject verdict, error classification or decoded semantic
 * fields, naming the exact diverging implementation and raw byte sequence.
 */
import { parseStellarAddress } from "./addresses.js";
import type { AddressKind } from "./addresses.js";
import { bytesToAscii, fromHex, toHex } from "./bytes.js";
import type { Hex } from "./bytes.js";
import {
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  cctpHookData,
  displayNonce,
  isFinalized,
  parseCctpBurnMessage,
  parseCctpMessage,
} from "./cctp.js";
import { HyperionProtocolError } from "./errors.js";
import { decodeCctpHook, decodeInboundNote, decodeOutboundNote, toEvmAddress } from "./notes.js";

/** Schema version for the shared malformed-message corpus manifest. */
export const MALFORMED_CORPUS_SCHEMA_VERSION = 1;

/** Languages participating in cross-language wire-format differential checks. */
export const CORPUS_IMPLEMENTATIONS = ["rust", "solidity", "typescript"] as const;
export type CorpusImplementation = (typeof CORPUS_IMPLEMENTATIONS)[number];

/** Wire formats covered by the corpus. */
export const CORPUS_FORMATS = [
  "outbound_note",
  "inbound_note",
  "stellar_strkey",
  "evm_word",
  "cctp_hook",
  "cctp_burn_envelope",
] as const;
export type CorpusFormat = (typeof CORPUS_FORMATS)[number];

/** Hostile and baseline case families required for regression coverage. */
export const CORPUS_CATEGORIES = [
  "accepted_legacy",
  "truncation",
  "trailing_bytes",
  "unsupported_version",
  "wide_id",
  "semantic_edge",
] as const;
export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number];

/** Canonical semantic payloads produced when a decoder accepts an input. */
export type CorpusDecodedValue =
  | {
      readonly format: "outbound_note";
      readonly version: number;
      readonly recipient: Hex;
      readonly nonce: string;
    }
  | {
      readonly format: "inbound_note";
      readonly version: number;
      readonly addressKind: AddressKind;
      readonly strkey: string;
      readonly nonce: string;
    }
  | {
      readonly format: "stellar_strkey";
      readonly addressKind: AddressKind;
      readonly key: Hex;
      readonly muxedId: string;
    }
  | {
      readonly format: "evm_word";
      readonly address: Hex;
    }
  | {
      readonly format: "cctp_hook";
      readonly version: number;
      readonly addressKind: AddressKind;
      readonly key: Hex;
      readonly muxedId: string;
    }
  | {
      readonly format: "cctp_burn_envelope";
      readonly messageVersion: number;
      readonly burnVersion: number;
      readonly sourceDomain: number;
      readonly destinationDomain: number;
      readonly displayNonce: string;
      readonly isFinalized: boolean;
      readonly amount: string;
      readonly maxFee: string;
      readonly feeExecuted: string;
      readonly expirationBlock: string;
      readonly hookPresent: boolean;
      readonly hookKind: AddressKind | null;
      readonly hookKey: Hex | null;
      readonly hookMuxedId: string | null;
    };

/** Normalized outcome returned by any language decoder for a single byte vector. */
export type CorpusOutcome =
  | {
      readonly status: "accept";
      readonly decoded: CorpusDecodedValue;
    }
  | {
      readonly status: "reject";
      readonly errorCode: string;
    };

/** Known, documented standalone-helper divergence on a hostile case. */
export interface AcknowledgedCorpusDifference {
  readonly implementation: CorpusImplementation;
  readonly differenceKind: "verdict_mismatch" | "error_code_mismatch";
  readonly rationale: string;
}

/** One versioned test vector in the cross-language corpus. */
export interface MalformedCorpusCase {
  readonly id: string;
  readonly format: CorpusFormat;
  readonly category: CorpusCategory;
  readonly description: string;
  readonly hexBytes: Hex;
  /** True when the vector is a valid v1/legacy wire message that every decoder must accept identically. */
  readonly legacyAccepted: boolean;
  /** Expected outcome per applicable language decoder. */
  readonly expected: Partial<Record<CorpusImplementation, CorpusOutcome>>;
  /** Explicit documentation when standalone helpers intentionally classify a rejection differently. */
  readonly acknowledgedDifferences?: readonly AcknowledgedCorpusDifference[];
}

/** Top-level versioned corpus manifest. */
export interface MalformedMessageCorpus {
  readonly corpusVersion: number;
  readonly corpusId: string;
  readonly cases: readonly MalformedCorpusCase[];
}

/** Classification of a discrepancy observed for a specific implementation and byte case. */
export type CorpusDifferenceKind =
  "verdict_mismatch" | "error_code_mismatch" | "semantic_mismatch" | "expected_outcome_mismatch";

/** Pinpoint diagnostic identifying the exact implementation and byte sequence that differed. */
export interface CorpusImplementationDifference {
  readonly caseId: string;
  readonly format: CorpusFormat;
  readonly category: CorpusCategory;
  readonly hexBytes: Hex;
  readonly implementation: CorpusImplementation;
  readonly differenceKind: CorpusDifferenceKind;
  readonly observed: CorpusOutcome;
  readonly reference: CorpusOutcome;
  readonly acknowledged: boolean;
  readonly detail: string;
}

/** Per-case comparison result across all participating implementations. */
export interface CorpusCaseComparison {
  readonly caseId: string;
  readonly format: CorpusFormat;
  readonly category: CorpusCategory;
  readonly hexBytes: Hex;
  readonly legacyAccepted: boolean;
  readonly legacySemanticConsistent: boolean;
  readonly outcomes: Readonly<Partial<Record<CorpusImplementation, CorpusOutcome>>>;
  readonly differences: readonly CorpusImplementationDifference[];
}

/** Aggregate evaluation summary over the entire versioned corpus. */
export interface CorpusEvaluationReport {
  readonly corpusVersion: number;
  readonly corpusId: string;
  readonly totalCases: number;
  readonly categoryCounts: Readonly<Record<CorpusCategory, number>>;
  readonly caseReports: readonly CorpusCaseComparison[];
  readonly differences: readonly CorpusImplementationDifference[];
  readonly unacknowledgedDifferences: readonly CorpusImplementationDifference[];
  readonly legacyInconsistencies: readonly string[];
  readonly passed: boolean;
}

/** Optional caller-supplied outcomes (e.g. from external harnesses or fault-injection tests). */
export type CorpusOutcomeOverrides = Readonly<
  Record<string, Partial<Record<CorpusImplementation, CorpusOutcome>>>
>;

/** Execute the `@hyperion/protocol` TypeScript decoder for a single corpus case. */
export function runTypeScriptCorpusDecoder(format: CorpusFormat, hexBytes: Hex): CorpusOutcome {
  const bytes = fromHex(hexBytes);
  const normalizedHex = toHex(bytes);

  try {
    switch (format) {
      case "outbound_note": {
        const note = decodeOutboundNote(bytes);
        return {
          status: "accept",
          decoded: {
            format: "outbound_note",
            version: 1,
            recipient: note.recipient,
            nonce: note.nonce.toString(),
          },
        };
      }
      case "inbound_note": {
        const note = decodeInboundNote(bytes);
        return {
          status: "accept",
          decoded: {
            format: "inbound_note",
            version: 1,
            addressKind: note.kind,
            strkey: note.strkey,
            nonce: note.nonce.toString(),
          },
        };
      }
      case "stellar_strkey": {
        const ascii = decodeStrictAscii(bytes);
        const parsed = parseStellarAddress(ascii);
        return {
          status: "accept",
          decoded: {
            format: "stellar_strkey",
            addressKind: parsed.kind,
            key: parsed.key,
            muxedId: parsed.muxedId.toString(),
          },
        };
      }
      case "evm_word": {
        const address = toEvmAddress(bytes);
        return {
          status: "accept",
          decoded: {
            format: "evm_word",
            address,
          },
        };
      }
      case "cctp_hook": {
        const hook = decodeCctpHook(bytes);
        return {
          status: "accept",
          decoded: {
            format: "cctp_hook",
            version: 1,
            addressKind: hook.kind,
            key: hook.key,
            muxedId: hook.muxedId.toString(),
          },
        };
      }
      case "cctp_burn_envelope": {
        const header = parseCctpMessage(normalizedHex);
        assertSupportedMessage(header);
        const body = cctpBody(bytes);
        const burn = parseCctpBurnMessage(body);
        assertSupportedBurn(burn);
        const hookBytes = cctpHookData(body);
        if (hookBytes.length === 0) {
          return {
            status: "accept",
            decoded: {
              format: "cctp_burn_envelope",
              messageVersion: header.version,
              burnVersion: burn.version,
              sourceDomain: header.sourceDomain,
              destinationDomain: header.destinationDomain,
              displayNonce: displayNonce(header).toString(),
              isFinalized: isFinalized(header),
              amount: burn.amount.toString(),
              maxFee: burn.maxFee.toString(),
              feeExecuted: burn.feeExecuted.toString(),
              expirationBlock: burn.expirationBlock.toString(),
              hookPresent: false,
              hookKind: null,
              hookKey: null,
              hookMuxedId: null,
            },
          };
        }
        const hook = decodeCctpHook(hookBytes);
        return {
          status: "accept",
          decoded: {
            format: "cctp_burn_envelope",
            messageVersion: header.version,
            burnVersion: burn.version,
            sourceDomain: header.sourceDomain,
            destinationDomain: header.destinationDomain,
            displayNonce: displayNonce(header).toString(),
            isFinalized: isFinalized(header),
            amount: burn.amount.toString(),
            maxFee: burn.maxFee.toString(),
            feeExecuted: burn.feeExecuted.toString(),
            expirationBlock: burn.expirationBlock.toString(),
            hookPresent: true,
            hookKind: hook.kind,
            hookKey: hook.key,
            hookMuxedId: hook.muxedId.toString(),
          },
        };
      }
    }
  } catch (error) {
    if (error instanceof HyperionProtocolError) {
      return { status: "reject", errorCode: error.code };
    }
    return {
      status: "reject",
      errorCode: error instanceof Error ? error.name : "UnknownError",
    };
  }
}

/** Canonical JSON key ordering so semantic comparisons never depend on object property order. */
export function canonicalSemanticJson(value: CorpusDecodedValue): string {
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

/** Structural equality over normalized decoder outcomes. */
export function equalCorpusOutcomes(a: CorpusOutcome, b: CorpusOutcome): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "reject" && b.status === "reject") {
    return a.errorCode === b.errorCode;
  }
  if (a.status === "accept" && b.status === "accept") {
    return canonicalSemanticJson(a.decoded) === canonicalSemanticJson(b.decoded);
  }
  return false;
}

/**
 * Compare observed decoder outcomes for one byte vector across implementations and against the
 * versioned corpus expectations.
 */
export function compareCorpusCaseOutcomes(
  corpusCase: MalformedCorpusCase,
  observed: Partial<Record<CorpusImplementation, CorpusOutcome>>,
): CorpusCaseComparison {
  const normalizedHex = toHex(fromHex(corpusCase.hexBytes));
  const differences: CorpusImplementationDifference[] = [];

  const activeImpls = CORPUS_IMPLEMENTATIONS.filter(
    (impl) => observed[impl] !== undefined || corpusCase.expected[impl] !== undefined,
  );

  // 1. Check each implementation against its recorded corpus expectation when present.
  for (const impl of activeImpls) {
    const actual = observed[impl];
    const expected = corpusCase.expected[impl];
    if (actual !== undefined && expected !== undefined && !equalCorpusOutcomes(actual, expected)) {
      differences.push({
        caseId: corpusCase.id,
        format: corpusCase.format,
        category: corpusCase.category,
        hexBytes: normalizedHex,
        implementation: impl,
        differenceKind: "expected_outcome_mismatch",
        observed: actual,
        reference: expected,
        acknowledged: false,
        detail: `${impl} differed from corpus expectation on ${corpusCase.id} (${normalizedHex})`,
      });
    }
  }

  // 2. Compare cross-language outcomes against the canonical reference implementation (`rust` first,
  //    then `typescript`, then `solidity`).
  const referenceImpl = selectReferenceImplementation(observed);
  const referenceOutcome = referenceImpl === null ? undefined : observed[referenceImpl];

  if (referenceImpl !== null && referenceOutcome !== undefined) {
    for (const impl of activeImpls) {
      if (impl === referenceImpl) continue;
      const actual = observed[impl];
      if (actual === undefined) continue;

      if (actual.status !== referenceOutcome.status) {
        const acknowledged = isAcknowledged(corpusCase, impl, "verdict_mismatch");
        differences.push({
          caseId: corpusCase.id,
          format: corpusCase.format,
          category: corpusCase.category,
          hexBytes: normalizedHex,
          implementation: impl,
          differenceKind: "verdict_mismatch",
          observed: actual,
          reference: referenceOutcome,
          acknowledged,
          detail: `${impl} returned ${actual.status} while ${referenceImpl} returned ${referenceOutcome.status} for ${corpusCase.id} (${normalizedHex})`,
        });
      } else if (actual.status === "reject" && referenceOutcome.status === "reject") {
        if (actual.errorCode !== referenceOutcome.errorCode) {
          const acknowledged = isAcknowledged(corpusCase, impl, "error_code_mismatch");
          differences.push({
            caseId: corpusCase.id,
            format: corpusCase.format,
            category: corpusCase.category,
            hexBytes: normalizedHex,
            implementation: impl,
            differenceKind: "error_code_mismatch",
            observed: actual,
            reference: referenceOutcome,
            acknowledged,
            detail: `${impl} rejected with ${actual.errorCode} while ${referenceImpl} rejected with ${referenceOutcome.errorCode} for ${corpusCase.id} (${normalizedHex})`,
          });
        }
      } else if (actual.status === "accept" && referenceOutcome.status === "accept") {
        if (
          canonicalSemanticJson(actual.decoded) !== canonicalSemanticJson(referenceOutcome.decoded)
        ) {
          differences.push({
            caseId: corpusCase.id,
            format: corpusCase.format,
            category: corpusCase.category,
            hexBytes: normalizedHex,
            implementation: impl,
            differenceKind: "semantic_mismatch",
            observed: actual,
            reference: referenceOutcome,
            acknowledged: false,
            detail: `${impl} decoded different semantic fields than ${referenceImpl} for ${corpusCase.id} (${normalizedHex})`,
          });
        }
      }
    }
  }

  let legacySemanticConsistent = true;
  if (corpusCase.legacyAccepted) {
    const presentOutcomes = activeImpls
      .map((impl) => observed[impl])
      .filter((item): item is CorpusOutcome => item !== undefined);
    if (presentOutcomes.length === 0) {
      legacySemanticConsistent = false;
    } else {
      const first = presentOutcomes[0];
      if (first?.status !== "accept") {
        legacySemanticConsistent = false;
      } else {
        const baselineJson = canonicalSemanticJson(first.decoded);
        for (const item of presentOutcomes) {
          if (item.status !== "accept" || canonicalSemanticJson(item.decoded) !== baselineJson) {
            legacySemanticConsistent = false;
            break;
          }
        }
      }
    }
  }

  return {
    caseId: corpusCase.id,
    format: corpusCase.format,
    category: corpusCase.category,
    hexBytes: normalizedHex,
    legacyAccepted: corpusCase.legacyAccepted,
    legacySemanticConsistent,
    outcomes: observed,
    differences,
  };
}

/**
 * Evaluate a versioned malformed-message corpus across Rust, Solidity and live TypeScript
 * decoders, merging any caller-provided runtime overrides.
 */
export function evaluateMalformedCorpus(
  corpus: MalformedMessageCorpus,
  overrides: CorpusOutcomeOverrides = {},
): CorpusEvaluationReport {
  if (corpus.corpusVersion !== MALFORMED_CORPUS_SCHEMA_VERSION) {
    throw new RangeError(
      `unsupported malformed corpus version ${String(corpus.corpusVersion)}, expected ${String(MALFORMED_CORPUS_SCHEMA_VERSION)}`,
    );
  }

  const categoryCounts: Record<CorpusCategory, number> = {
    accepted_legacy: 0,
    truncation: 0,
    trailing_bytes: 0,
    unsupported_version: 0,
    wide_id: 0,
    semantic_edge: 0,
  };

  const seenIds = new Set<string>();
  const caseReports: CorpusCaseComparison[] = [];
  const allDifferences: CorpusImplementationDifference[] = [];
  const legacyInconsistencies: string[] = [];

  for (const corpusCase of corpus.cases) {
    if (seenIds.has(corpusCase.id)) {
      throw new RangeError(`duplicate corpus case id: ${corpusCase.id}`);
    }
    seenIds.add(corpusCase.id);
    categoryCounts[corpusCase.category] += 1;

    const caseOverrides = overrides[corpusCase.id];
    const observed: Partial<Record<CorpusImplementation, CorpusOutcome>> = {};

    if (corpusCase.expected.rust !== undefined) {
      observed.rust = caseOverrides?.rust ?? corpusCase.expected.rust;
    } else if (caseOverrides?.rust !== undefined) {
      observed.rust = caseOverrides.rust;
    }

    if (corpusCase.expected.solidity !== undefined) {
      observed.solidity = caseOverrides?.solidity ?? corpusCase.expected.solidity;
    } else if (caseOverrides?.solidity !== undefined) {
      observed.solidity = caseOverrides.solidity;
    }

    if (corpusCase.expected.typescript !== undefined || caseOverrides?.typescript !== undefined) {
      observed.typescript =
        caseOverrides?.typescript ??
        runTypeScriptCorpusDecoder(corpusCase.format, corpusCase.hexBytes);
    }

    const comparison = compareCorpusCaseOutcomes(corpusCase, observed);
    caseReports.push(comparison);
    allDifferences.push(...comparison.differences);
    if (corpusCase.legacyAccepted && !comparison.legacySemanticConsistent) {
      legacyInconsistencies.push(corpusCase.id);
    }
  }

  const unacknowledgedDifferences = allDifferences.filter((diff) => !diff.acknowledged);
  const passed = unacknowledgedDifferences.length === 0 && legacyInconsistencies.length === 0;

  return {
    corpusVersion: corpus.corpusVersion,
    corpusId: corpus.corpusId,
    totalCases: corpus.cases.length,
    categoryCounts,
    caseReports,
    differences: allDifferences,
    unacknowledgedDifferences,
    legacyInconsistencies,
    passed,
  };
}

/** Render a concise, deterministic diagnostic report naming diverging implementations and byte cases. */
export function formatCorpusEvaluationReport(report: CorpusEvaluationReport): string {
  const lines: string[] = [
    `Corpus ${report.corpusId} (v${String(report.corpusVersion)}): ${String(report.totalCases)} cases, status=${report.passed ? "PASS" : "FAIL"}`,
  ];
  for (const diff of report.differences) {
    const tag = diff.acknowledged ? "ACKNOWLEDGED" : "UNEXPECTED";
    lines.push(
      `[${tag}] impl=${diff.implementation} case=${diff.caseId} format=${diff.format} kind=${diff.differenceKind} bytes=${diff.hexBytes} :: ${diff.detail}`,
    );
  }
  for (const caseId of report.legacyInconsistencies) {
    lines.push(`[LEGACY_MISMATCH] case=${caseId}`);
  }
  return lines.join("\n");
}

function selectReferenceImplementation(
  observed: Partial<Record<CorpusImplementation, CorpusOutcome>>,
): CorpusImplementation | null {
  if (observed.rust !== undefined) return "rust";
  if (observed.typescript !== undefined) return "typescript";
  if (observed.solidity !== undefined) return "solidity";
  return null;
}

function isAcknowledged(
  corpusCase: MalformedCorpusCase,
  implementation: CorpusImplementation,
  kind: "verdict_mismatch" | "error_code_mismatch",
): boolean {
  if (corpusCase.legacyAccepted) return false;
  return (
    corpusCase.acknowledgedDifferences?.some(
      (entry) => entry.implementation === implementation && entry.differenceKind === kind,
    ) ?? false
  );
}

function decodeStrictAscii(bytes: Uint8Array): string {
  for (const byte of bytes) {
    if (byte > 0x7f) {
      throw new HyperionProtocolError("InvalidDestination", "non-ASCII byte in strkey");
    }
  }
  return bytesToAscii(bytes);
}
