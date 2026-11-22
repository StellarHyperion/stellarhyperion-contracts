/**
 * The wire schema registry and its compatibility report.
 *
 * The registry is only worth having if it says what the codecs actually do, so the first block
 * reads real codec output back through each registered layout. The frozen version-one baseline
 * in `testdata/wire-schemas-v1.json` must keep comparing as identical. To regenerate it after a
 * deliberate, reviewed compatible change, run:
 *
 *   HYPERION_WRITE_WIRE_BASELINE=1 npx vitest run test/wire-compat.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checksum, parseStellarAddress } from "../src/addresses.js";
import { fromHex, toHex } from "../src/bytes.js";
import { parseCctpBurnMessage, parseCctpMessage } from "../src/cctp.js";
import {
  decodeCctpHook,
  decodeInboundNote,
  decodeOutboundNote,
  encodeAxelarMetadata,
  encodeCctpHook,
  encodeInboundNote,
  encodeOutboundNote,
} from "../src/notes.js";
import {
  MAX_WIRE_BYTES,
  WIRE_COMPAT_REPORT_VERSION,
  WIRE_SCHEMAS,
  WireSchemaFormatError,
  compareWireSchemaSets,
  formatCompatibilityReport,
  parseWireSchemaSet,
  readWireMessage,
  serializeWireSchemaSet,
  wireSchemaKey,
} from "../src/wire-compat.js";
import type {
  CompatibilityReport,
  ErrorTableSchema,
  MessageSchema,
  WireField,
  WireSchema,
  WireSchemaSet,
} from "../src/wire-compat.js";
import { C_ADDR, EVM_RECIPIENT, G_ADDR, M_ADDR } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const BASELINE = join(repoRoot, "testdata", "wire-schemas-v1.json");
const U64_MAX = (1n << 64n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

function message(id: string, set: WireSchemaSet = WIRE_SCHEMAS): MessageSchema {
  const s = set.schemas.find((x) => x.id === id && x.version === 1);
  if (s?.kind !== "message") throw new Error(`no message schema ${id}`);
  return s;
}

function read(id: string, bytes: Uint8Array) {
  const result = readWireMessage(message(id), bytes);
  if (!result.ok) throw new Error(`${id}: ${result.field ?? "size"} ${result.detail}`);
  return result.fields;
}

/** A deep copy of the registry with one schema edited, for classifying a single change. */
function edit(id: string, change: (schema: WireSchema) => WireSchema): WireSchemaSet {
  const copy = parseWireSchemaSet(JSON.parse(serializeWireSchemaSet(WIRE_SCHEMAS)));
  return {
    ...copy,
    schemas: copy.schemas.map((s) => (s.id === id && s.version === 1 ? change(s) : s)),
  };
}

function editField(
  id: string,
  name: string,
  change: (field: WireField) => WireField,
): WireSchemaSet {
  return edit(id, (s) => {
    if (s.kind !== "message") throw new Error("not a message");
    return { ...s, fields: s.fields.map((f) => (f.name === name ? change(f) : f)) };
  });
}

function editErrors(id: string, change: (s: ErrorTableSchema) => ErrorTableSchema): WireSchemaSet {
  return edit(id, (s) => {
    if (s.kind !== "error-table") throw new Error("not an error table");
    return change(s);
  });
}

function only(report: CompatibilityReport) {
  expect(report.decisions, formatCompatibilityReport(report)).toHaveLength(1);
  return report.decisions[0]!;
}

/** Strkey text to its raw base32-decoded bytes, without leaning on the code under test. */
function strkeyRaw(strkey: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of strkey) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

describe("the registered version-one layouts", () => {
  it("validate as a schema set and survive a JSON round trip unchanged", () => {
    const text = serializeWireSchemaSet(WIRE_SCHEMAS);
    expect(parseWireSchemaSet(JSON.parse(text))).toEqual(WIRE_SCHEMAS);
    expect(compareWireSchemaSets(WIRE_SCHEMAS, parseWireSchemaSet(JSON.parse(text))).result).toBe(
      "identical",
    );
  });

  it("read outbound notes exactly as the codec does, at the full nonce width", () => {
    const bytes = encodeOutboundNote(EVM_RECIPIENT, U64_MAX);
    const codec = decodeOutboundNote(bytes);
    expect(read("note.outbound", bytes)).toEqual({
      version: 1n,
      recipient: codec.recipient,
      nonce: U64_MAX,
    });
  });

  it("read inbound notes for every address kind exactly as the codec does", () => {
    for (const strkey of [G_ADDR, C_ADDR, M_ADDR]) {
      const bytes = encodeInboundNote(strkey, U64_MAX);
      const codec = decodeInboundNote(bytes);
      expect(read("note.inbound", bytes)).toEqual({
        version: 1n,
        kind: BigInt(codec.kind),
        strkeyLength: BigInt(strkey.length),
        strkey: codec.strkey,
        nonce: U64_MAX,
      });
    }
  });

  it("read CCTP hooks for every address kind exactly as the codec does", () => {
    for (const strkey of [G_ADDR, C_ADDR, M_ADDR]) {
      const bytes = encodeCctpHook(strkey);
      const codec = decodeCctpHook(bytes);
      const fields = read("cctp.hook", bytes);
      expect(fields.kind).toBe(BigInt(codec.kind));
      expect(fields.key).toBe(codec.key);
      expect(fields.muxedId ?? 0n).toBe(codec.muxedId);
    }
  });

  it("read CCTP headers and burn bodies at the same offsets as the parsers", () => {
    const header = new Uint8Array(148 + 228 + 5).map((_, i) => (i * 7 + 3) & 0xff);
    header.set([0, 0, 0, 1], 0);
    const body = header.slice(148);
    body.set([0, 0, 0, 1], 0);
    // The parsers cap amounts at i128, so keep each 256 bit word below 2^127 for them.
    for (const offset of [68, 132, 164, 196]) body.fill(0, offset, offset + 17);
    header.set(body, 148);
    const parsed = parseCctpMessage(header);
    const fields = read("cctp.header", header);
    for (const [name, value] of Object.entries(parsed)) {
      expect(fields[name], name).toEqual(typeof value === "number" ? BigInt(value) : value);
    }
    expect(fields.body).toBe(toHex(body));
    const burn = parseCctpBurnMessage(body);
    const burnFields = read("cctp.burn", body);
    for (const [name, value] of Object.entries(burn)) {
      expect(burnFields[name], name).toEqual(typeof value === "number" ? BigInt(value) : value);
    }
    expect(burnFields.hookData).toBe(toHex(body.slice(228)));
    // The layout itself carries the full uint256; range policy belongs to the codec.
    const wide = body.slice();
    wide.fill(0xff, 68, 100);
    expect(read("cctp.burn", wide).amount).toBe(U256_MAX);
  });

  it("read Axelar metadata and SEP-23 strkeys as the encoders write them", () => {
    const note = encodeInboundNote(G_ADDR, 1n);
    expect(read("axelar.metadata", encodeAxelarMetadata(note))).toEqual({
      metadataVersion: 0n,
      note: toHex(note),
    });
    for (const strkey of [G_ADDR, C_ADDR, M_ADDR]) {
      const raw = strkeyRaw(strkey);
      const parts = parseStellarAddress(strkey);
      const fields = read("address.strkey", raw);
      expect(fields.key).toBe(parts.key);
      expect(fields.muxedId ?? 0n).toBe(parts.muxedId);
      expect(fields.checksum).toBe(BigInt(checksum(raw, raw.length - 2)));
    }
  });

  it("give the shared version-one corpus the same verdicts it records", () => {
    const rows = readFileSync(join(repoRoot, "testdata", "malformed-message-corpus.tsv"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [id, direction, payload, expected] = row.split("|");
      expect(direction).toBe("outbound");
      const verdict = readWireMessage(message("note.outbound"), fromHex(payload!)).ok;
      expect(verdict, id).toBe(expected === "ok");
      let codec = true;
      try {
        decodeOutboundNote(fromHex(payload!));
      } catch {
        codec = false;
      }
      expect(codec, id).toBe(verdict);
    }
  });
});

describe("the frozen version-one baseline", () => {
  it("still compares as identical, with an unchanged report", () => {
    if (process.env.HYPERION_WRITE_WIRE_BASELINE !== undefined) {
      writeFileSync(BASELINE, serializeWireSchemaSet(WIRE_SCHEMAS));
    }
    const baseline = parseWireSchemaSet(JSON.parse(readFileSync(BASELINE, "utf8")));
    const report = compareWireSchemaSets(baseline, WIRE_SCHEMAS);
    expect(report).toEqual({
      reportVersion: WIRE_COMPAT_REPORT_VERSION,
      result: "identical",
      breaking: 0,
      compatible: 0,
      decisions: [],
    });
    expect(formatCompatibilityReport(report)).toBe(
      "wire compatibility: identical (0 breaking, 0 compatible)\n",
    );
    expect(baseline.schemas.map(wireSchemaKey)).toEqual([
      "note.outbound@1",
      "note.inbound@1",
      "cctp.hook@1",
      "cctp.header@1",
      "cctp.burn@1",
      "axelar.metadata@1",
      "address.strkey@1",
      "errors.soroban@1",
      "errors.evm@1",
    ]);
  });
});

describe("classification of layout changes", () => {
  it("calls a moved offset breaking and links it to the exact field", () => {
    const d = only(
      compareWireSchemaSets(
        WIRE_SCHEMAS,
        editField("note.outbound", "nonce", (f) => ({ ...f, offset: 22 })),
      ),
    );
    expect(d).toEqual({
      classification: "breaking",
      rule: "field-offset-changed",
      schema: "note.outbound@1",
      field: "nonce",
      path: "note.outbound@1/fields/nonce/offset",
      baseline: "21",
      candidate: "22",
      detail: "the field moved",
    });
  });

  it("calls a moved CCTP offset breaking", () => {
    const d = only(
      compareWireSchemaSets(
        WIRE_SCHEMAS,
        editField("cctp.burn", "mintRecipient", (f) => ({ ...f, offset: 37 })),
      ),
    );
    expect(d).toMatchObject({
      classification: "breaking",
      path: "cctp.burn@1/fields/mintRecipient/offset",
    });
  });

  it("calls a renumbered, added or removed address tag breaking, and a relabel compatible", () => {
    const tags = (values: Record<string, number>) =>
      compareWireSchemaSets(
        WIRE_SCHEMAS,
        editField("cctp.hook", "kind", (f) => ({ ...f, values })),
      );
    expect(only(tags({ account: 0, contract: 1, muxed: 3 }))).toMatchObject({
      classification: "breaking",
      rule: "tag-value-changed",
      field: "kind",
      path: "cctp.hook@1/fields/kind/values/muxed",
      baseline: "2",
      candidate: "3",
    });
    expect(only(tags({ account: 0, contract: 1, muxed: 2, pool: 3 }))).toMatchObject({
      classification: "breaking",
      rule: "tag-added",
      path: "cctp.hook@1/fields/kind/values/pool",
    });
    expect(only(tags({ account: 0, contract: 1 }))).toMatchObject({
      classification: "breaking",
      rule: "tag-removed",
      baseline: "2",
      candidate: null,
    });
    expect(only(tags({ account: 0, contract: 1, muxedAccount: 2 }))).toMatchObject({
      classification: "compatible",
      rule: "tag-renamed",
      baseline: '{"muxed":2}',
      candidate: '{"muxedAccount":2}',
    });
    const strkey = only(
      compareWireSchemaSets(
        WIRE_SCHEMAS,
        editField("address.strkey", "versionByte", (f) => ({
          ...f,
          values: { account: 0x31, contract: 0x10, muxed: 0x60 },
        })),
      ),
    );
    expect(strkey).toMatchObject({
      classification: "breaking",
      path: "address.strkey@1/fields/versionByte/values/account",
    });
  });

  it("calls every other observable field change breaking", () => {
    const one = (set: WireSchemaSet) => only(compareWireSchemaSets(WIRE_SCHEMAS, set));
    expect(
      one(editField("note.outbound", "recipient", (f) => ({ ...f, length: 32 }))),
    ).toMatchObject({
      rule: "field-length-changed",
      classification: "breaking",
    });
    expect(
      one(editField("note.outbound", "recipient", (f) => ({ ...f, encoding: "ascii" }))),
    ).toMatchObject({
      rule: "field-encoding-changed",
    });
    expect(
      one(editField("note.outbound", "version", (f) => ({ ...f, constant: 2 }))),
    ).toMatchObject({
      rule: "field-constant-changed",
      path: "note.outbound@1/fields/version/constant",
      baseline: "1",
      candidate: "2",
    });
    expect(
      one(
        editField("cctp.hook", "muxedId", (f) => ({
          ...f,
          presentWhen: { field: "kind", equals: 1 },
        })),
      ),
    ).toMatchObject({ rule: "field-presence-changed" });
    expect(
      one(
        edit("note.outbound", (s) => ({ ...s, size: { kind: "fixed", bytes: 30 } }) as WireSchema),
      ),
    ).toMatchObject({ rule: "size-changed", path: "note.outbound@1/size", field: null });
  });

  it("separates field relabels from added and removed fields", () => {
    const renamed = only(
      compareWireSchemaSets(
        WIRE_SCHEMAS,
        editField("note.outbound", "nonce", (f) => ({ ...f, name: "sourceNonce" })),
      ),
    );
    expect(renamed).toMatchObject({
      classification: "compatible",
      rule: "field-renamed",
      field: "sourceNonce",
    });
    const removed = compareWireSchemaSets(
      WIRE_SCHEMAS,
      edit(
        "cctp.header",
        (s) =>
          ({
            ...s,
            fields: (s as MessageSchema).fields.filter((f) => f.name !== "sender"),
          }) as WireSchema,
      ),
    );
    expect(only(removed)).toMatchObject({
      classification: "breaking",
      rule: "field-removed",
      field: "sender",
    });
    const added = compareWireSchemaSets(
      WIRE_SCHEMAS,
      edit(
        "note.outbound",
        (s) =>
          ({
            ...s,
            fields: [
              ...(s as MessageSchema).fields,
              { name: "memo", encoding: "bytes", offset: 29, length: 4 },
            ],
          }) as WireSchema,
      ),
    );
    expect(only(added)).toMatchObject({
      classification: "breaking",
      rule: "field-added",
      field: "memo",
    });
  });

  it("treats a new schema version as compatible and a dropped one as breaking", () => {
    const outbound = message("note.outbound");
    const withV2: WireSchemaSet = {
      ...WIRE_SCHEMAS,
      schemas: [
        ...WIRE_SCHEMAS.schemas,
        { ...outbound, version: 2, size: { kind: "fixed", bytes: 37 } },
      ],
    };
    expect(only(compareWireSchemaSets(WIRE_SCHEMAS, withV2))).toMatchObject({
      classification: "compatible",
      rule: "schema-added",
      schema: "note.outbound@2",
    });
    const report = compareWireSchemaSets(withV2, WIRE_SCHEMAS);
    expect(report.result).toBe("breaking");
    expect(only(report)).toMatchObject({ rule: "schema-removed", schema: "note.outbound@2" });
  });
});

describe("classification of error-table changes", () => {
  it("allows only appends to the Soroban table", () => {
    const one = (change: (s: ErrorTableSchema) => ErrorTableSchema) =>
      only(compareWireSchemaSets(WIRE_SCHEMAS, editErrors("errors.soroban", change)));
    const last = (s: ErrorTableSchema) => s.entries.length;
    expect(
      one((s) => ({ ...s, entries: [...s.entries, { name: "BrandNewError", code: last(s) + 1 }] })),
    ).toMatchObject({
      classification: "compatible",
      rule: "error-appended",
      field: "BrandNewError",
    });
    expect(one((s) => ({ ...s, entries: s.entries.slice(0, -1) }))).toMatchObject({
      classification: "breaking",
      rule: "error-removed",
    });
    const renumbered = compareWireSchemaSets(
      WIRE_SCHEMAS,
      editErrors("errors.soroban", (s) => ({
        ...s,
        entries: s.entries.map((e) =>
          e.name === "Paused"
            ? { ...e, code: 6 }
            : e.name === "RouteDisabled"
              ? { ...e, code: 5 }
              : e,
        ),
      })),
    );
    expect(renumbered.result).toBe("breaking");
    expect(renumbered.decisions.map((x) => [x.rule, x.path, x.baseline, x.candidate])).toEqual([
      ["error-code-changed", "errors.soroban@1/entries/Paused/code", "5", "6"],
      ["error-code-changed", "errors.soroban@1/entries/RouteDisabled/code", "6", "5"],
    ]);
  });

  it("names a renamed Soroban code as a reassignment of that code", () => {
    const report = compareWireSchemaSets(
      WIRE_SCHEMAS,
      editErrors("errors.soroban", (s) => ({
        ...s,
        entries: s.entries.map((e) => (e.name === "Paused" ? { ...e, name: "Halted" } : e)),
      })),
    );
    expect(report.decisions.map((x) => x.rule).sort()).toEqual([
      "error-code-reassigned",
      "error-removed",
    ]);
    expect(report.decisions.find((x) => x.rule === "error-code-reassigned")).toMatchObject({
      field: "Halted",
      baseline: '{"Paused":5}',
      candidate: '{"Halted":5}',
    });
  });

  it("allows new EVM selectors and refuses changed ones", () => {
    const one = (change: (s: ErrorTableSchema) => ErrorTableSchema) =>
      only(compareWireSchemaSets(WIRE_SCHEMAS, editErrors("errors.evm", change)));
    expect(
      one((s) => ({
        ...s,
        entries: [...s.entries, { name: "Fresh", code: "0xdeadbeef", signature: "Fresh()" }],
      })),
    ).toMatchObject({ classification: "compatible", rule: "error-added" });
    const target = WIRE_SCHEMAS.schemas.find((s): s is ErrorTableSchema => s.id === "errors.evm")!
      .entries[0]!;
    expect(
      one((s) => ({
        ...s,
        entries: s.entries.map((e) => (e.name === target.name ? { ...e, code: "0x00000001" } : e)),
      })),
    ).toMatchObject({ classification: "breaking", rule: "error-code-changed", field: target.name });
    expect(
      one((s) => ({
        ...s,
        entries: s.entries.map((e) =>
          e.name === target.name ? { ...e, signature: `${target.name}(uint256)` } : e,
        ),
      })),
    ).toMatchObject({ rule: "error-signature-changed" });
    expect(one((s) => ({ ...s, codeSpace: "soroban-contract-error" }))).toMatchObject({
      rule: "error-code-space-changed",
      classification: "breaking",
    });
  });

  it("sorts decisions by path and reports breaking when any decision is breaking", () => {
    const set = editField("note.outbound", "nonce", (f) => ({ ...f, name: "n", offset: 22 }));
    const report = compareWireSchemaSets(WIRE_SCHEMAS, set);
    expect(report.result).toBe("breaking");
    expect(report.decisions.map((x) => x.path)).toEqual(
      [...report.decisions.map((x) => x.path)].sort(),
    );
    for (const x of report.decisions) expect(x.path.startsWith(x.schema)).toBe(true);
    expect(formatCompatibilityReport(report)).toMatch(
      /^wire compatibility: breaking \(2 breaking, 0 compatible\)\n/,
    );
  });
});

describe("loading malformed schema-set data", () => {
  const base = () =>
    JSON.parse(serializeWireSchemaSet(WIRE_SCHEMAS)) as {
      schemas: Record<string, unknown>[];
      [k: string]: unknown;
    };
  const field = (doc: ReturnType<typeof base>, schema: number, index: number) =>
    (doc.schemas[schema]!.fields as Record<string, unknown>[])[index]!;
  const rejects = (doc: unknown, path: string, reason?: RegExp) => {
    try {
      parseWireSchemaSet(doc);
    } catch (error) {
      expect(error).toBeInstanceOf(WireSchemaFormatError);
      expect((error as WireSchemaFormatError).path).toBe(path);
      if (reason !== undefined) expect((error as Error).message).toMatch(reason);
      return;
    }
    throw new Error(`accepted a schema set that should fail at ${path}`);
  };

  it("names the failing path for shape errors", () => {
    rejects(null, "$");
    rejects(
      { ...base(), schemaSetVersion: 2 },
      "$.schemaSetVersion",
      /unsupported schema set version 2/,
    );
    rejects({ ...base(), extra: 1 }, "$.extra", /unknown property/);
    const dup = base();
    dup.schemas.push(dup.schemas[0]!);
    rejects(dup, "$.schemas[9].id", /duplicate schema note.outbound@1/);
    const kind = base();
    kind.schemas[0]!.kind = "table";
    rejects(kind, "$.schemas[0].kind");
    const id = base();
    id.schemas[0]!.id = "Note Outbound";
    rejects(id, "$.schemas[0].id");
  });

  it("enforces integer bounds on versions, offsets, lengths, constants and codes", () => {
    const at = (mutate: (doc: ReturnType<typeof base>) => void, path: string) => {
      const doc = base();
      mutate(doc);
      rejects(doc, path);
    };
    at((d) => (d.schemas[0]!.version = 0), "$.schemas[0].version");
    at((d) => (d.schemas[0]!.version = 256), "$.schemas[0].version");
    at((d) => (field(d, 0, 2).offset = -1), "$.schemas[0].fields[2].offset");
    at((d) => (field(d, 0, 2).offset = MAX_WIRE_BYTES + 1), "$.schemas[0].fields[2].offset");
    at((d) => (field(d, 0, 2).offset = 21.5), "$.schemas[0].fields[2].offset");
    at((d) => (field(d, 0, 1).length = 0), "$.schemas[0].fields[1].length");
    at((d) => (field(d, 0, 2).length = 33), "$.schemas[0].fields[2].length");
    at((d) => (field(d, 0, 0).constant = 256), "$.schemas[0].fields[0].constant");
    at((d) => (field(d, 2, 1).values = { a: 0, b: 0 }), "$.schemas[2].fields[1].values.b");
    at((d) => (field(d, 2, 1).values = null), "$.schemas[2].fields[1].values");
    at(
      (d) => ((d.schemas[7]!.entries as { code: unknown }[])[0]!.code = 0),
      "$.schemas[7].entries[0].code",
    );
    at(
      (d) => ((d.schemas[7]!.entries as { code: unknown }[])[0]!.code = 2 ** 32),
      "$.schemas[7].entries[0].code",
    );
    at(
      (d) => ((d.schemas[8]!.entries as { code: unknown }[])[0]!.code = "0xABCDEF01"),
      "$.schemas[8].entries[0].code",
    );
    // The exact upper bounds are accepted.
    const ok = base();
    field(ok, 0, 0).constant = 255;
    (ok.schemas[7]!.entries as { name: string; code: unknown }[]).push({
      name: "Last",
      code: 0xffff_ffff,
    });
    expect(() => parseWireSchemaSet(ok)).not.toThrow();
  });

  it("refuses dangling references, misplaced rest fields, overlaps and bad sizes", () => {
    const at = (mutate: (doc: ReturnType<typeof base>) => void, path: string, reason: RegExp) => {
      const doc = base();
      mutate(doc);
      rejects(doc, path, reason);
    };
    at(
      (d) => (field(d, 1, 4).offset = { after: "later" }),
      "$.schemas[1].fields[4].offset.after",
      /not an earlier field/,
    );
    at(
      (d) => (field(d, 1, 3).length = { from: "kindz" }),
      "$.schemas[1].fields[3].length.from",
      /not an earlier field/,
    );
    at(
      (d) => (field(d, 1, 4).length = { from: "strkey" }),
      "$.schemas[1].fields[4].length.from",
      /not a uint field/,
    );
    at(
      (d) => (field(d, 3, 0).length = "rest"),
      "$.schemas[3].fields[0].length",
      /fixed length|only the last/,
    );
    at((d) => (field(d, 0, 2).offset = 20), "$.schemas[0].fields", /recipient and nonce overlap/);
    at(
      (d) => (d.schemas[1]!.size = { kind: "one-of", bytes: [80, 67] }),
      "$.schemas[1].size.bytes",
      /increasing/,
    );
    at(
      (d) => (d.schemas[0]!.size = { kind: "fixed", bytes: 29, min: 1 }),
      "$.schemas[0].size.min",
      /no min/,
    );
    at(
      (d) => ((d.schemas[8]!.entries as { signature: unknown }[])[0]!.signature = "Other()"),
      "$.schemas[8].entries[0].signature",
      /does not declare/,
    );
  });
});

describe("reading external bytes against a layout", () => {
  it("refuses wrong sizes, constants, tags, text and length bytes with the failing field", () => {
    const refuse = (id: string, bytes: Uint8Array) => {
      const r = readWireMessage(message(id), bytes);
      expect(r.ok).toBe(false);
      return r.ok ? null : r;
    };
    const note = encodeOutboundNote(EVM_RECIPIENT, 1n);
    expect(refuse("note.outbound", note.slice(0, 28))).toMatchObject({
      field: null,
      detail: "28 bytes, expected 29",
    });
    expect(refuse("note.outbound", Uint8Array.from([2, ...note.slice(1)]))).toMatchObject({
      field: "version",
    });
    const hook = encodeCctpHook(G_ADDR);
    hook[1] = 7;
    expect(refuse("cctp.hook", hook)).toMatchObject({
      field: "kind",
      detail: "value 7 is not one of 0, 1, 2",
    });
    const inbound = encodeInboundNote(G_ADDR, 1n);
    inbound[5] = 0x01;
    expect(refuse("note.inbound", inbound)).toMatchObject({ field: "strkey" });
    const muxed = encodeInboundNote(M_ADDR, 1n);
    muxed[2] = 56;
    expect(refuse("note.inbound", muxed)).toMatchObject({
      field: null,
      detail: "13 bytes follow the last field",
    });
    expect(refuse("cctp.header", new Uint8Array(147))).toMatchObject({
      detail: "147 bytes, expected at least 148",
    });
  });
});
