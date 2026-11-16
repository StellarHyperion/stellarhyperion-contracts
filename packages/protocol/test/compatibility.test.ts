import { describe, expect, it } from "vitest";
import {
  CANONICAL_WIRE_SCHEMA_V1,
  buildCurrentWireFormatSchema,
  compareWireFormatSchemas,
  verifyCanonicalV1Fixtures,
} from "../src/index.js";
import type { WireFormatSchema } from "../src/index.js";

describe("wire-format compatibility report", () => {
  it("reports an unchanged identical result for canonical version-1 schemas and fixtures", () => {
    const report = compareWireFormatSchemas();
    expect(report.classification).toBe("identical");
    expect(report.compatibleWithV1).toBe(true);
    expect(report.breakingCount).toBe(0);
    expect(report.compatibleAdditionCount).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.v1FixtureChecks.length).toBeGreaterThanOrEqual(5);
    expect(report.v1FixtureChecks.every((check) => check.passed)).toBe(true);

    const standaloneFixtures = verifyCanonicalV1Fixtures();
    expect(standaloneFixtures.every((check) => check.passed)).toBe(true);
  });

  it("classifies append-only error, route, and blocker extensions as compatible with concrete field paths", () => {
    const base = buildCurrentWireFormatSchema();
    const candidate: WireFormatSchema = {
      ...base,
      routes: {
        tags: {
          ...base.routes.tags,
          FutureRail: 4,
        },
      },
      errors: {
        soroban: [...base.errors.soroban, "FutureSorobanError"],
        evm: [...base.errors.evm, "FutureEvmError"],
        quoteBlockers: {
          ...base.errors.quoteBlockers,
          FutureBlocker: 12,
        },
      },
    };

    const report = compareWireFormatSchemas(CANONICAL_WIRE_SCHEMA_V1, candidate);
    expect(report.classification).toBe("compatible");
    expect(report.compatibleWithV1).toBe(true);
    expect(report.breakingCount).toBe(0);
    expect(report.compatibleAdditionCount).toBe(4);

    const fields = report.findings.map((f) => f.schemaField);
    expect(fields).toContain("routes.tags.FutureRail");
    expect(fields).toContain(`errors.soroban[${String(base.errors.soroban.length)}]`);
    expect(fields).toContain(`errors.evm[${String(base.errors.evm.length)}]`);
    expect(fields).toContain("errors.quoteBlockers.FutureBlocker");
  });

  it("classifies changed byte offsets, altered address tags, and reordered errors as breaking", () => {
    const base = buildCurrentWireFormatSchema();
    const reorderedSoroban = [...base.errors.soroban];
    const first = reorderedSoroban[0]!;
    const second = reorderedSoroban[1]!;
    reorderedSoroban[0] = second;
    reorderedSoroban[1] = first;

    const broken: WireFormatSchema = {
      ...base,
      addresses: {
        kinds: {
          ...base.addresses.kinds,
          MuxedAccount: {
            ...base.addresses.kinds.MuxedAccount!,
            tag: 9,
          },
        },
      },
      notes: {
        ...base.notes,
        outbound: {
          ...base.notes.outbound,
          fields: {
            ...base.notes.outbound.fields,
            recipient: { offset: 2, length: 20 },
          },
        },
      },
      cctp: {
        ...base.cctp,
        headerFields: {
          ...base.cctp.headerFields,
          nonce: { offset: 16, length: 32 },
        },
      },
      errors: {
        ...base.errors,
        soroban: reorderedSoroban,
      },
    };

    const report = compareWireFormatSchemas(CANONICAL_WIRE_SCHEMA_V1, broken);
    expect(report.classification).toBe("breaking");
    expect(report.compatibleWithV1).toBe(false);
    expect(report.breakingCount).toBe(5);

    const byField = new Map(report.findings.map((f) => [f.schemaField, f]));
    expect(byField.get("addresses.kinds.MuxedAccount.tag")?.classification).toBe("breaking");
    expect(byField.get("addresses.kinds.MuxedAccount.tag")?.baselineValue).toBe(2);
    expect(byField.get("addresses.kinds.MuxedAccount.tag")?.candidateValue).toBe(9);

    expect(byField.get("notes.outbound.fields.recipient.offset")?.classification).toBe("breaking");
    expect(byField.get("cctp.headerFields.nonce.offset")?.classification).toBe("breaking");
    expect(byField.get("errors.soroban[0]")?.classification).toBe("breaking");
    expect(byField.get("errors.soroban[1]")?.classification).toBe("breaking");
  });

  it("rejects malformed negative or non-integer schema definitions and colliding tag additions", () => {
    const base = buildCurrentWireFormatSchema();
    const invalidOffset: WireFormatSchema = {
      ...base,
      cctp: {
        ...base.cctp,
        headerLength: -148,
      },
    };
    expect(() => compareWireFormatSchemas(CANONICAL_WIRE_SCHEMA_V1, invalidOffset)).toThrow(
      RangeError,
    );

    const collidingRoute: WireFormatSchema = {
      ...base,
      routes: {
        tags: {
          ...base.routes.tags,
          CollidingRail: 1,
        },
      },
    };
    const collidingReport = compareWireFormatSchemas(CANONICAL_WIRE_SCHEMA_V1, collidingRoute);
    expect(collidingReport.classification).toBe("breaking");
    expect(collidingReport.findings[0]?.schemaField).toBe("routes.tags.CollidingRail");
  });
});
