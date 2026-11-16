import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CORPUS_CATEGORIES,
  CORPUS_FORMATS,
  MALFORMED_CORPUS_SCHEMA_VERSION,
  canonicalSemanticJson,
  compareCorpusCaseOutcomes,
  evaluateMalformedCorpus,
  formatCorpusEvaluationReport,
  runTypeScriptCorpusDecoder,
} from "../src/malformedCorpus.js";
import type { MalformedMessageCorpus } from "../src/malformedCorpus.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");
const fixturePath = join(here, "fixtures", "malformed-message-corpus.v1.json");
const solidityCorpusTestPath = join(repoRoot, "evm", "test", "unit", "MalformedCorpus.t.sol");
const rustCorpusTestPath = join(
  repoRoot,
  "soroban",
  "crates",
  "hyperion-core",
  "src",
  "malformed_corpus_test.rs",
);

function loadCorpus(): MalformedMessageCorpus {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as MalformedMessageCorpus;
}

describe("cross-language malformed-message corpus v1", () => {
  it("covers truncation, trailing bytes, unsupported versions, wide IDs and legacy messages", () => {
    const corpus = loadCorpus();
    expect(corpus.corpusVersion).toBe(MALFORMED_CORPUS_SCHEMA_VERSION);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(40);

    const report = evaluateMalformedCorpus(corpus);
    for (const category of CORPUS_CATEGORIES) {
      expect(
        report.categoryCounts[category],
        `missing coverage for category ${category}`,
      ).toBeGreaterThanOrEqual(3);
    }

    const coveredFormats = new Set(corpus.cases.map((item) => item.format));
    for (const format of CORPUS_FORMATS) {
      expect(coveredFormats.has(format), `missing coverage for format ${format}`).toBe(true);
    }
  });

  it("evaluates cleanly with zero unacknowledged cross-language differences", () => {
    const corpus = loadCorpus();
    const report = evaluateMalformedCorpus(corpus);

    expect(report.unacknowledgedDifferences).toEqual([]);
    expect(report.legacyInconsistencies).toEqual([]);
    expect(report.passed).toBe(true);

    // Every documented helper difference names the implementation and exact byte vector.
    expect(report.differences.length).toBeGreaterThan(0);
    for (const diff of report.differences) {
      expect(diff.acknowledged).toBe(true);
      expect(["rust", "solidity", "typescript"]).toContain(diff.implementation);
      expect(diff.hexBytes.startsWith("0x")).toBe(true);
    }
  });

  it("retains identical semantic decoding across all implementations for accepted legacy messages", () => {
    const corpus = loadCorpus();
    const legacyCases = corpus.cases.filter((item) => item.legacyAccepted);
    expect(legacyCases.length).toBeGreaterThanOrEqual(14);

    for (const item of legacyCases) {
      const liveTs = runTypeScriptCorpusDecoder(item.format, item.hexBytes);
      expect(liveTs.status, `TypeScript rejected legacy case ${item.id}`).toBe("accept");

      const comparison = compareCorpusCaseOutcomes(item, {
        ...item.expected,
        typescript: liveTs,
      });
      expect(comparison.legacySemanticConsistent).toBe(true);
      expect(comparison.differences).toEqual([]);

      if (liveTs.status === "accept") {
        for (const [impl, outcome] of Object.entries(comparison.outcomes)) {
          expect(outcome.status, `${impl} rejected ${item.id}`).toBe("accept");
          if (outcome.status === "accept") {
            expect(canonicalSemanticJson(outcome.decoded)).toBe(
              canonicalSemanticJson(liveTs.decoded),
            );
          }
        }
      }
    }
  });

  it("identifies the exact diverging implementation and byte case when outcomes drift", () => {
    const corpus = loadCorpus();
    const truncatedOutbound = corpus.cases.find((item) => item.id === "outbound-truncated-28b");
    const wideOutbound = corpus.cases.find(
      (item) => item.id === "outbound-v1-wide-nonce-js-unsafe",
    );
    const badVersionHook = corpus.cases.find(
      (item) => item.id === "cctp-hook-unsupported-version-2",
    );

    expect(truncatedOutbound).toBeDefined();
    expect(wideOutbound).toBeDefined();
    expect(badVersionHook).toBeDefined();

    const report = evaluateMalformedCorpus(corpus, {
      // 1. Verdict drift: Solidity hypothetically accepts a 28-byte truncated outbound note.
      "outbound-truncated-28b": {
        solidity: {
          status: "accept",
          decoded: {
            format: "outbound_note",
            version: 1,
            recipient: "0x00000000000000000000000000000000000beef1",
            nonce: "0",
          },
        },
      },
      // 2. Semantic drift: TypeScript hypothetically loses precision on 2^53 + 1 wide nonce.
      "outbound-v1-wide-nonce-js-unsafe": {
        typescript: {
          status: "accept",
          decoded: {
            format: "outbound_note",
            version: 1,
            recipient: "0x1111111111111111111111111111111111111111",
            nonce: "9007199254740992",
          },
        },
      },
      // 3. Error classification drift: Rust hypothetically returns MalformedMessage on bad version.
      "cctp-hook-unsupported-version-2": {
        rust: {
          status: "reject",
          errorCode: "MalformedMessage",
        },
      },
    });

    expect(report.passed).toBe(false);
    expect(report.legacyInconsistencies).toEqual(["outbound-v1-wide-nonce-js-unsafe"]);

    const formatted = formatCorpusEvaluationReport(report);
    expect(formatted).toContain(
      `[UNEXPECTED] impl=solidity case=outbound-truncated-28b format=outbound_note kind=verdict_mismatch bytes=${truncatedOutbound!.hexBytes}`,
    );
    expect(formatted).toContain(
      `[UNEXPECTED] impl=typescript case=outbound-v1-wide-nonce-js-unsafe format=outbound_note kind=semantic_mismatch bytes=${wideOutbound!.hexBytes}`,
    );
    expect(formatted).toContain(
      `[UNEXPECTED] impl=rust case=cctp-hook-unsupported-version-2 format=cctp_hook kind=expected_outcome_mismatch bytes=${badVersionHook!.hexBytes}`,
    );
  });

  it("keeps the Rust and Solidity corpus harnesses synchronized with the canonical JSON manifest", () => {
    const corpus = loadCorpus();
    const rustSource = readFileSync(rustCorpusTestPath, "utf8");
    const soliditySource = readFileSync(solidityCorpusTestPath, "utf8");

    expect(rustSource).toContain("malformed-message-corpus.v1.json");

    // Strip whitespace/quotes between adjacent Solidity hex"..." literals so multi-line hex chunks
    // can be compared byte-for-byte against the manifest.
    const collapsedSolidityHex = soliditySource.toLowerCase().replace(/"\s*hex"/g, "");

    for (const item of corpus.cases) {
      const appliesToSolidity =
        item.expected.solidity !== undefined ||
        (item.format === "cctp_hook" && item.legacyAccepted);
      if (!appliesToSolidity) continue;

      expect(
        soliditySource.includes(`// case: ${item.id}`),
        `MalformedCorpus.t.sol is missing // case: ${item.id}`,
      ).toBe(true);

      const rawHex = item.hexBytes.slice(2).toLowerCase();
      if (rawHex.length > 0) {
        const hasHexLiteral = collapsedSolidityHex.includes(`hex"${rawHex}"`);
        const hasBytes32Literal = collapsedSolidityHex.includes(`bytes32(0x${rawHex})`);
        expect(
          hasHexLiteral || hasBytes32Literal,
          `MalformedCorpus.t.sol byte literal drifted for ${item.id}`,
        ).toBe(true);
      }
    }
  });
});
