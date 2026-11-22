/**
 * Wire-format schemas and a compatibility report between two sets of them.
 *
 * The notes, CCTP messages, address tags and error tables in this package are wire contracts.
 * The Solidity, the Rust, the indexer and the app all read the same bytes. A change that moves
 * an offset or renumbers a tag does not fail to compile anywhere. It shows up later as a
 * delivery read under the wrong recipient. This module writes those layouts down as data
 * (`WIRE_SCHEMAS`) and compares two sets field by field. Each difference becomes a decision
 * that names its rule, its schema, its field and the exact before and after values, so a
 * reviewer can see why a change is breaking instead of taking a verdict on trust.
 *
 * Classification is deliberately conservative. Within one schema version, any change a decoder
 * could observe is breaking: a field's offset, length, encoding, constant or presence condition,
 * the message size, and any added, removed or renumbered tag value. The ways to make a compatible
 * change are a new schema or a new schema version alongside the old one (this mirrors
 * `negotiateNoteVersion`, where the required version is a floor), relabelling a field or a tag
 * value without changing its bytes, appending a Soroban error code, and adding an EVM error.
 *
 * `readWireMessage` decodes bytes against a schema. It exists so the registry can be tested
 * against the real codecs and the shared fixtures, and so external bytes can be checked against a
 * registered layout with a field-level diagnostic.
 */
import { toHex } from "./bytes.js";
import { SOROBAN_ERROR_NAMES } from "./errors.js";
import { EVM_ERROR_SELECTORS } from "./abi/errors.js";
import { AddressKind, VERSION_ACCOUNT, VERSION_CONTRACT, VERSION_MUXED } from "./addresses.js";

/** Version of the schema-set document format. */
export const WIRE_SCHEMA_SET_VERSION = 1 as const;
/** Version of the compatibility report format. */
export const WIRE_COMPAT_REPORT_VERSION = 1 as const;
/** No registered layout comes near this. Larger values in external input are refused. */
export const MAX_WIRE_BYTES = 65_535;

// ------------------------------------------------------------------------------------------------
// Schema types
// ------------------------------------------------------------------------------------------------

/** `uint` is big endian unsigned, `uint-le` little endian (the strkey checksum), `ascii` printable. */
export type WireEncoding = "uint" | "uint-le" | "bytes" | "ascii";

export interface WireField {
  readonly name: string;
  readonly encoding: WireEncoding;
  /** A fixed byte offset, or the field this one immediately follows. */
  readonly offset: number | { readonly after: string };
  /** A fixed byte count, the `uint` field that holds the count, or everything that remains. */
  readonly length: number | { readonly from: string } | "rest";
  /** A value the field must hold, such as a version byte. */
  readonly constant?: number;
  /** The only values the field may hold, by label. Address tags and length markers live here. */
  readonly values?: Readonly<Record<string, number>>;
  /** The field is present only when another field holds this value. */
  readonly presentWhen?: { readonly field: string; readonly equals: number };
}

export type WireSize =
  | { readonly kind: "fixed"; readonly bytes: number }
  | { readonly kind: "one-of"; readonly bytes: readonly number[] }
  | { readonly kind: "open"; readonly min: number };

export interface MessageSchema {
  readonly kind: "message";
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly size: WireSize;
  readonly fields: readonly WireField[];
}

export interface ErrorEntry {
  readonly name: string;
  /** A Soroban contract error number, or a four byte EVM selector as lowercase hex. */
  readonly code: number | string;
  /** EVM only: the declared signature the selector hashes. */
  readonly signature?: string;
}

export interface ErrorTableSchema {
  readonly kind: "error-table";
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly codeSpace: "soroban-contract-error" | "evm-selector";
  readonly entries: readonly ErrorEntry[];
}

export type WireSchema = MessageSchema | ErrorTableSchema;

export interface WireSchemaSet {
  readonly schemaSetVersion: typeof WIRE_SCHEMA_SET_VERSION;
  readonly schemas: readonly WireSchema[];
}

/** `id@version`, the identity a schema is compared under. */
export function wireSchemaKey(schema: Pick<WireSchema, "id" | "version">): string {
  return `${schema.id}@${String(schema.version)}`;
}

// ------------------------------------------------------------------------------------------------
// The registered version-one layouts
// ------------------------------------------------------------------------------------------------

const ADDRESS_KIND_TAGS = {
  account: AddressKind.Account,
  contract: AddressKind.Contract,
  muxed: AddressKind.MuxedAccount,
} as const;

const word = (name: string, offset: number): WireField => ({
  name,
  encoding: "bytes",
  offset,
  length: 32,
});
const u32 = (name: string, offset: number, constant?: number): WireField =>
  constant === undefined
    ? { name, encoding: "uint", offset, length: 4 }
    : { name, encoding: "uint", offset, length: 4, constant };
const u256 = (name: string, offset: number): WireField => ({
  name,
  encoding: "uint",
  offset,
  length: 32,
});

const MESSAGE_SCHEMAS: readonly MessageSchema[] = [
  {
    kind: "message",
    id: "note.outbound",
    version: 1,
    description: "Stellar to EVM note: version, twenty byte EVM recipient, eight byte nonce",
    size: { kind: "fixed", bytes: 29 },
    fields: [
      { name: "version", encoding: "uint", offset: 0, length: 1, constant: 1 },
      { name: "recipient", encoding: "bytes", offset: 1, length: 20 },
      { name: "nonce", encoding: "uint", offset: 21, length: 8 },
    ],
  },
  {
    kind: "message",
    id: "note.inbound",
    version: 1,
    description: "EVM to Stellar note: version, address kind, strkey length, ascii strkey, nonce",
    size: { kind: "one-of", bytes: [67, 80] },
    fields: [
      { name: "version", encoding: "uint", offset: 0, length: 1, constant: 1 },
      { name: "kind", encoding: "uint", offset: 1, length: 1, values: ADDRESS_KIND_TAGS },
      {
        name: "strkeyLength",
        encoding: "uint",
        offset: 2,
        length: 1,
        values: { plain: 56, muxed: 69 },
      },
      { name: "strkey", encoding: "ascii", offset: 3, length: { from: "strkeyLength" } },
      { name: "nonce", encoding: "uint", offset: { after: "strkey" }, length: 8 },
    ],
  },
  {
    kind: "message",
    id: "cctp.hook",
    version: 1,
    description: "CCTP hook data: version, address kind tag, key, muxed id for muxed destinations",
    size: { kind: "one-of", bytes: [34, 42] },
    fields: [
      { name: "version", encoding: "uint", offset: 0, length: 1, constant: 1 },
      { name: "kind", encoding: "uint", offset: 1, length: 1, values: ADDRESS_KIND_TAGS },
      word("key", 2),
      {
        name: "muxedId",
        encoding: "uint",
        offset: 34,
        length: 8,
        presentWhen: { field: "kind", equals: AddressKind.MuxedAccount },
      },
    ],
  },
  {
    kind: "message",
    id: "cctp.header",
    version: 1,
    description: "CCTP V2 message header, followed by the message body",
    size: { kind: "open", min: 148 },
    fields: [
      u32("version", 0, 1),
      u32("sourceDomain", 4),
      u32("destinationDomain", 8),
      word("nonce", 12),
      word("sender", 44),
      word("recipient", 76),
      word("destinationCaller", 108),
      u32("minFinalityThreshold", 140),
      u32("finalityThresholdExecuted", 144),
      { name: "body", encoding: "bytes", offset: 148, length: "rest" },
    ],
  },
  {
    kind: "message",
    id: "cctp.burn",
    version: 1,
    description: "CCTP V2 burn message body, followed by hook data",
    size: { kind: "open", min: 228 },
    fields: [
      u32("version", 0, 1),
      word("burnToken", 4),
      word("mintRecipient", 36),
      u256("amount", 68),
      word("messageSender", 100),
      u256("maxFee", 132),
      u256("feeExecuted", 164),
      u256("expirationBlock", 196),
      { name: "hookData", encoding: "bytes", offset: 228, length: "rest" },
    ],
  },
  {
    kind: "message",
    id: "axelar.metadata",
    version: 1,
    description: "Axelar ITS metadata: four byte contract-call version, then the note",
    size: { kind: "open", min: 4 },
    fields: [
      u32("metadataVersion", 0, 0),
      { name: "note", encoding: "bytes", offset: 4, length: "rest" },
    ],
  },
  {
    kind: "message",
    id: "address.strkey",
    version: 1,
    description: "SEP-23 strkey after base32: version byte, key, muxed id, CRC16 little endian",
    size: { kind: "one-of", bytes: [35, 43] },
    fields: [
      {
        name: "versionByte",
        encoding: "uint",
        offset: 0,
        length: 1,
        values: { account: VERSION_ACCOUNT, contract: VERSION_CONTRACT, muxed: VERSION_MUXED },
      },
      word("key", 1),
      {
        name: "muxedId",
        encoding: "uint",
        offset: 33,
        length: 8,
        presentWhen: { field: "versionByte", equals: VERSION_MUXED },
      },
      { name: "checksum", encoding: "uint-le", offset: { after: "muxedId" }, length: 2 },
    ],
  },
];

const ERROR_SCHEMAS: readonly ErrorTableSchema[] = [
  {
    kind: "error-table",
    id: "errors.soroban",
    version: 1,
    description: "hyperion_core::HyperionError contract error numbers, append only",
    codeSpace: "soroban-contract-error",
    entries: SOROBAN_ERROR_NAMES.map((name, index) => ({ name, code: index + 1 })),
  },
  {
    kind: "error-table",
    id: "errors.evm",
    version: 1,
    description: "Errors the compiled EVM contracts can revert with, by selector",
    codeSpace: "evm-selector",
    entries: Object.entries(EVM_ERROR_SELECTORS)
      .map(([code, { name, signature }]) => ({ name, code, signature }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  },
];

/** Every wire layout and error table this package implements, at its current versions. */
export const WIRE_SCHEMAS: WireSchemaSet = {
  schemaSetVersion: WIRE_SCHEMA_SET_VERSION,
  schemas: [...MESSAGE_SCHEMAS, ...ERROR_SCHEMAS],
};

// ------------------------------------------------------------------------------------------------
// Loading a schema set from outside
// ------------------------------------------------------------------------------------------------

/** Thrown when external schema-set data does not hold together. Carries the failing path. */
export class WireSchemaFormatError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`wire schema set invalid at ${path}: ${reason}`);
    this.name = "WireSchemaFormatError";
  }
}

function bad(path: string, reason: string): never {
  throw new WireSchemaFormatError(path, reason);
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    bad(path, "expected an object");
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) bad(`${path}.${key}`, "unknown property");
  }
  return value as Record<string, unknown>;
}

function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    bad(path, `expected an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}

function text(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value))
    bad(path, `expected text matching ${String(pattern)}`);
  return value;
}

const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)*$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const ENCODINGS: readonly WireEncoding[] = ["uint", "uint-le", "bytes", "ascii"];

/** The largest value a `uint` field of `length` bytes can hold, capped at a safe JSON integer. */
function uintMax(length: number): number {
  return length >= 7 ? Number.MAX_SAFE_INTEGER : 2 ** (8 * length) - 1;
}

function parseField(
  value: unknown,
  path: string,
  earlier: ReadonlyMap<string, WireField>,
): WireField {
  const f = record(value, path, [
    "name",
    "encoding",
    "offset",
    "length",
    "constant",
    "values",
    "presentWhen",
  ]);
  const name = text(f.name, `${path}.name`, NAME);
  if (earlier.has(name)) bad(`${path}.name`, `duplicate field ${name}`);
  if (!ENCODINGS.includes(f.encoding as WireEncoding)) {
    bad(`${path}.encoding`, `expected one of ${ENCODINGS.join(", ")}`);
  }
  const encoding = f.encoding as WireEncoding;
  const reference = (target: unknown, at: string, uintOnly: boolean): string => {
    const ref = text(target, at, NAME);
    const field = earlier.get(ref);
    if (field === undefined) bad(at, `names ${ref}, which is not an earlier field`);
    if (uintOnly && field.encoding !== "uint") bad(at, `${ref} is not a uint field`);
    return ref;
  };
  const offset =
    typeof f.offset === "number"
      ? int(f.offset, `${path}.offset`, 0, MAX_WIRE_BYTES)
      : {
          after: reference(
            record(f.offset, `${path}.offset`, ["after"]).after,
            `${path}.offset.after`,
            false,
          ),
        };
  const length =
    f.length === "rest"
      ? ("rest" as const)
      : typeof f.length === "number"
        ? int(f.length, `${path}.length`, 1, MAX_WIRE_BYTES)
        : {
            from: reference(
              record(f.length, `${path}.length`, ["from"]).from,
              `${path}.length.from`,
              true,
            ),
          };
  const isUint = encoding === "uint" || encoding === "uint-le";
  if (isUint && typeof length !== "number")
    bad(`${path}.length`, "a uint field needs a fixed length");
  if (isUint && typeof length === "number" && length > 32)
    bad(`${path}.length`, "a uint field is at most 32 bytes");
  const max = typeof length === "number" ? uintMax(length) : 0;
  let field: WireField = { name, encoding, offset, length };
  if (f.constant !== undefined) {
    if (!isUint) bad(`${path}.constant`, "only a uint field can hold a constant");
    field = { ...field, constant: int(f.constant, `${path}.constant`, 0, max) };
  }
  if (f.values !== undefined) {
    if (!isUint) bad(`${path}.values`, "only a uint field can have enumerated values");
    const keys = typeof f.values === "object" && f.values !== null ? Object.keys(f.values) : [];
    const raw = record(f.values, `${path}.values`, keys);
    const values: Record<string, number> = {};
    const seen = new Set<number>();
    for (const [label, v] of Object.entries(raw)) {
      text(label, `${path}.values`, NAME);
      const n = int(v, `${path}.values.${label}`, 0, max);
      if (seen.has(n)) bad(`${path}.values.${label}`, `value ${String(n)} has two labels`);
      seen.add(n);
      values[label] = n;
    }
    if (seen.size === 0) bad(`${path}.values`, "expected at least one value");
    field = { ...field, values };
  }
  if (f.presentWhen !== undefined) {
    const p = record(f.presentWhen, `${path}.presentWhen`, ["field", "equals"]);
    const target = reference(p.field, `${path}.presentWhen.field`, true);
    field = {
      ...field,
      presentWhen: {
        field: target,
        equals: int(p.equals, `${path}.presentWhen.equals`, 0, Number.MAX_SAFE_INTEGER),
      },
    };
  }
  return field;
}

function parseSize(value: unknown, path: string): WireSize {
  const s = record(value, path, ["kind", "bytes", "min"]);
  switch (s.kind) {
    case "fixed":
      if (s.min !== undefined) bad(`${path}.min`, "a fixed size has no min");
      return { kind: "fixed", bytes: int(s.bytes, `${path}.bytes`, 1, MAX_WIRE_BYTES) };
    case "one-of": {
      if (s.min !== undefined) bad(`${path}.min`, "a one-of size has no min");
      if (!Array.isArray(s.bytes) || s.bytes.length < 2)
        bad(`${path}.bytes`, "expected at least two sizes");
      const bytes = s.bytes.map((b, i) => int(b, `${path}.bytes[${String(i)}]`, 1, MAX_WIRE_BYTES));
      for (let i = 1; i < bytes.length; i += 1) {
        if ((bytes[i] ?? 0) <= (bytes[i - 1] ?? 0))
          bad(`${path}.bytes`, "sizes must be strictly increasing");
      }
      return { kind: "one-of", bytes };
    }
    case "open":
      if (s.bytes !== undefined) bad(`${path}.bytes`, "an open size has no bytes");
      return { kind: "open", min: int(s.min, `${path}.min`, 0, MAX_WIRE_BYTES) };
    default:
      return bad(`${path}.kind`, "expected fixed, one-of or open");
  }
}

function parseMessage(s: Record<string, unknown>, path: string): MessageSchema {
  if (!Array.isArray(s.fields) || s.fields.length === 0)
    bad(`${path}.fields`, "expected a non-empty array");
  const fields = new Map<string, WireField>();
  s.fields.forEach((value, i) => {
    const field = parseField(value, `${path}.fields[${String(i)}]`, fields);
    if (field.length === "rest" && i !== (s.fields as unknown[]).length - 1) {
      bad(`${path}.fields[${String(i)}].length`, "only the last field can take the rest");
    }
    fields.set(field.name, field);
  });
  // Unconditional fixed fields must not overlap: two names for the same bytes is a layout bug.
  const fixed = [...fields.values()]
    .filter(
      (f) =>
        typeof f.offset === "number" && typeof f.length === "number" && f.presentWhen === undefined,
    )
    .sort((a, b) => (a.offset as number) - (b.offset as number));
  for (let i = 1; i < fixed.length; i += 1) {
    const prev = fixed[i - 1];
    const cur = fixed[i];
    if (
      prev !== undefined &&
      cur !== undefined &&
      (prev.offset as number) + (prev.length as number) > (cur.offset as number)
    ) {
      bad(`${path}.fields`, `${prev.name} and ${cur.name} overlap`);
    }
  }
  return {
    kind: "message",
    id: text(s.id, `${path}.id`, ID),
    version: int(s.version, `${path}.version`, 1, 255),
    description:
      typeof s.description === "string"
        ? s.description
        : bad(`${path}.description`, "expected text"),
    size: parseSize(s.size, `${path}.size`),
    fields: [...fields.values()],
  };
}

function parseErrorTable(s: Record<string, unknown>, path: string): ErrorTableSchema {
  const codeSpace = s.codeSpace;
  if (codeSpace !== "soroban-contract-error" && codeSpace !== "evm-selector") {
    bad(`${path}.codeSpace`, "expected soroban-contract-error or evm-selector");
  }
  if (!Array.isArray(s.entries)) bad(`${path}.entries`, "expected an array");
  const names = new Set<string>();
  const codes = new Set<number | string>();
  const entries = s.entries.map((value, i): ErrorEntry => {
    const at = `${path}.entries[${String(i)}]`;
    const e = record(value, at, ["name", "code", "signature"]);
    const name = text(e.name, `${at}.name`, NAME);
    if (names.has(name)) bad(`${at}.name`, `duplicate error ${name}`);
    names.add(name);
    const code =
      codeSpace === "soroban-contract-error"
        ? int(e.code, `${at}.code`, 1, 0xffff_ffff)
        : text(e.code, `${at}.code`, /^0x[0-9a-f]{8}$/);
    if (codes.has(code)) bad(`${at}.code`, `code ${String(code)} is used twice`);
    codes.add(code);
    if (e.signature === undefined) return { name, code };
    const signature = text(e.signature, `${at}.signature`, /^[A-Za-z_][A-Za-z0-9_]*\(.*\)$/);
    if (!signature.startsWith(`${name}(`)) bad(`${at}.signature`, `does not declare ${name}`);
    return { name, code, signature };
  });
  return {
    kind: "error-table",
    id: text(s.id, `${path}.id`, ID),
    version: int(s.version, `${path}.version`, 1, 255),
    description:
      typeof s.description === "string"
        ? s.description
        : bad(`${path}.description`, "expected text"),
    codeSpace,
    entries,
  };
}

/** Validate untrusted schema-set data, such as a committed baseline file or one from another build. */
export function parseWireSchemaSet(input: unknown): WireSchemaSet {
  const root = record(input, "$", ["schemaSetVersion", "schemas"]);
  if (root.schemaSetVersion !== WIRE_SCHEMA_SET_VERSION) {
    bad("$.schemaSetVersion", `unsupported schema set version ${String(root.schemaSetVersion)}`);
  }
  if (!Array.isArray(root.schemas)) bad("$.schemas", "expected an array");
  const keys = new Set<string>();
  const schemas = root.schemas.map((value, i): WireSchema => {
    const path = `$.schemas[${String(i)}]`;
    const kind = (value as { kind?: unknown } | null)?.kind;
    const schema =
      kind === "message"
        ? parseMessage(
            record(value, path, ["kind", "id", "version", "description", "size", "fields"]),
            path,
          )
        : kind === "error-table"
          ? parseErrorTable(
              record(value, path, ["kind", "id", "version", "description", "codeSpace", "entries"]),
              path,
            )
          : bad(`${path}.kind`, "expected message or error-table");
    const key = wireSchemaKey(schema);
    if (keys.has(key)) bad(`${path}.id`, `duplicate schema ${key}`);
    keys.add(key);
    return schema;
  });
  return { schemaSetVersion: WIRE_SCHEMA_SET_VERSION, schemas };
}

/** Stable JSON for a schema set, suitable for committing as a baseline. */
export function serializeWireSchemaSet(set: WireSchemaSet): string {
  return `${JSON.stringify(set, null, 2)}\n`;
}

// ------------------------------------------------------------------------------------------------
// Reading bytes against a schema
// ------------------------------------------------------------------------------------------------

/** `uint` fields decode to `bigint`, `bytes` to `Hex`, `ascii` to a string. */
export type WireFieldValue = bigint | string;

export type WireReadResult =
  | { readonly ok: true; readonly fields: Readonly<Record<string, WireFieldValue>> }
  | { readonly ok: false; readonly field: string | null; readonly detail: string };

/** Decode `bytes` against one message schema, refusing anything the layout does not allow. */
export function readWireMessage(schema: MessageSchema, bytes: Uint8Array): WireReadResult {
  const refuse = (field: string | null, detail: string): WireReadResult => ({
    ok: false,
    field,
    detail,
  });
  const { size } = schema;
  if (size.kind === "fixed" && bytes.length !== size.bytes) {
    return refuse(null, `${String(bytes.length)} bytes, expected ${String(size.bytes)}`);
  }
  if (size.kind === "one-of" && !size.bytes.includes(bytes.length)) {
    return refuse(null, `${String(bytes.length)} bytes, expected one of ${size.bytes.join(", ")}`);
  }
  if (size.kind === "open" && bytes.length < size.min) {
    return refuse(null, `${String(bytes.length)} bytes, expected at least ${String(size.min)}`);
  }
  const fields: Record<string, WireFieldValue> = {};
  const ends = new Map<string, number>();
  const numbers = new Map<string, bigint>();
  let end = 0;
  for (const field of schema.fields) {
    if (
      field.presentWhen !== undefined &&
      numbers.get(field.presentWhen.field) !== BigInt(field.presentWhen.equals)
    ) {
      ends.set(field.name, ends.get(previousName(schema, field)) ?? end);
      continue;
    }
    const start =
      typeof field.offset === "number" ? field.offset : (ends.get(field.offset.after) ?? 0);
    const length =
      field.length === "rest"
        ? bytes.length - start
        : typeof field.length === "number"
          ? field.length
          : Number(numbers.get(field.length.from) ?? 0n);
    if (start + length > bytes.length || length < 0) {
      return refuse(
        field.name,
        `needs bytes ${String(start)}..${String(start + length)} of ${String(bytes.length)}`,
      );
    }
    const raw = bytes.slice(start, start + length);
    let value: WireFieldValue;
    if (field.encoding === "uint" || field.encoding === "uint-le") {
      let n = 0n;
      const ordered = field.encoding === "uint" ? raw : raw.slice().reverse();
      for (const b of ordered) n = (n << 8n) | BigInt(b);
      if (field.constant !== undefined && n !== BigInt(field.constant)) {
        return refuse(field.name, `is ${String(n)}, expected ${String(field.constant)}`);
      }
      if (field.values !== undefined && !Object.values(field.values).some((v) => BigInt(v) === n)) {
        return refuse(
          field.name,
          `value ${String(n)} is not one of ${Object.values(field.values).join(", ")}`,
        );
      }
      numbers.set(field.name, n);
      value = n;
    } else if (field.encoding === "ascii") {
      let s = "";
      for (const b of raw) {
        if (b < 0x20 || b > 0x7e)
          return refuse(field.name, `byte ${String(b)} is not printable ascii`);
        s += String.fromCharCode(b);
      }
      value = s;
    } else {
      value = toHex(raw);
    }
    fields[field.name] = value;
    ends.set(field.name, start + length);
    end = Math.max(end, start + length);
  }
  if (end !== bytes.length)
    return refuse(null, `${String(bytes.length - end)} bytes follow the last field`);
  return { ok: true, fields };
}

function previousName(schema: MessageSchema, field: WireField): string {
  const i = schema.fields.indexOf(field);
  return schema.fields[i - 1]?.name ?? "";
}

// ------------------------------------------------------------------------------------------------
// Comparing two schema sets
// ------------------------------------------------------------------------------------------------

export type CompatibilityRule =
  | "schema-added"
  | "schema-removed"
  | "schema-kind-changed"
  | "size-changed"
  | "field-added"
  | "field-removed"
  | "field-renamed"
  | "field-offset-changed"
  | "field-length-changed"
  | "field-encoding-changed"
  | "field-constant-changed"
  | "field-presence-changed"
  | "tag-added"
  | "tag-removed"
  | "tag-value-changed"
  | "tag-renamed"
  | "error-code-space-changed"
  | "error-appended"
  | "error-inserted"
  | "error-added"
  | "error-removed"
  | "error-code-changed"
  | "error-code-reassigned"
  | "error-signature-changed";

const BREAKING: ReadonlySet<CompatibilityRule> = new Set<CompatibilityRule>([
  "schema-removed",
  "schema-kind-changed",
  "size-changed",
  "field-added",
  "field-removed",
  "field-offset-changed",
  "field-length-changed",
  "field-encoding-changed",
  "field-constant-changed",
  "field-presence-changed",
  "tag-added",
  "tag-removed",
  "tag-value-changed",
  "error-code-space-changed",
  "error-inserted",
  "error-removed",
  "error-code-changed",
  "error-code-reassigned",
  "error-signature-changed",
]);

export interface CompatibilityDecision {
  readonly classification: "compatible" | "breaking";
  readonly rule: CompatibilityRule;
  /** `id@version`. */
  readonly schema: string;
  /** The field or error name the decision is about, or null for a schema-level decision. */
  readonly field: string | null;
  /** A JSON-pointer-like path to the exact schema property, e.g. `note.outbound@1/fields/nonce/offset`. */
  readonly path: string;
  /** The value before and after, as canonical JSON, or null when the item does not exist on that side. */
  readonly baseline: string | null;
  readonly candidate: string | null;
  readonly detail: string;
}

export interface CompatibilityReport {
  readonly reportVersion: typeof WIRE_COMPAT_REPORT_VERSION;
  /** `identical` only when there are no decisions at all. */
  readonly result: "identical" | "compatible" | "breaking";
  readonly breaking: number;
  readonly compatible: number;
  readonly decisions: readonly CompatibilityDecision[];
}

/** JSON with object keys sorted at every depth, so equal values always print the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const json = (value: unknown): string | null => (value === undefined ? null : canonical(value));

class Decisions {
  readonly list: CompatibilityDecision[] = [];
  add(
    rule: CompatibilityRule,
    schema: string,
    field: string | null,
    path: string,
    baseline: unknown,
    candidate: unknown,
    detail: string,
  ): void {
    this.list.push({
      classification: BREAKING.has(rule) ? "breaking" : "compatible",
      rule,
      schema,
      field,
      path,
      baseline: json(baseline),
      candidate: json(candidate),
      detail,
    });
  }
}

/** Field shape without the name, for rename detection. */
function shape(field: WireField): string {
  return canonical({ ...field, name: undefined });
}

function compareMessages(a: MessageSchema, b: MessageSchema, d: Decisions): void {
  const key = wireSchemaKey(a);
  if (json(a.size) !== json(b.size)) {
    d.add(
      "size-changed",
      key,
      null,
      `${key}/size`,
      a.size,
      b.size,
      "decoders enforce the message size",
    );
  }
  const before = new Map(a.fields.map((f) => [f.name, f]));
  const after = new Map(b.fields.map((f) => [f.name, f]));
  const removed = a.fields.filter((f) => !after.has(f.name));
  const added = b.fields.filter((f) => !before.has(f.name));
  // A field that vanished under one name and reappeared under another with identical bytes is a
  // relabel. Names are not on the wire.
  for (const old of [...removed]) {
    const twin = added.find((f) => shape(f) === shape(old));
    if (twin === undefined) continue;
    removed.splice(removed.indexOf(old), 1);
    added.splice(added.indexOf(twin), 1);
    d.add(
      "field-renamed",
      key,
      twin.name,
      `${key}/fields/${old.name}/name`,
      old.name,
      twin.name,
      "same bytes, new label",
    );
  }
  for (const f of removed) {
    d.add(
      "field-removed",
      key,
      f.name,
      `${key}/fields/${f.name}`,
      f,
      undefined,
      "a decoder reading this field gets other bytes",
    );
  }
  for (const f of added) {
    d.add(
      "field-added",
      key,
      f.name,
      `${key}/fields/${f.name}`,
      undefined,
      f,
      "the layout changed within one version; add a new version instead",
    );
  }
  for (const [name, old] of before) {
    const cur = after.get(name);
    if (cur === undefined) continue;
    const at = `${key}/fields/${name}`;
    if (json(old.offset) !== json(cur.offset)) {
      d.add(
        "field-offset-changed",
        key,
        name,
        `${at}/offset`,
        old.offset,
        cur.offset,
        "the field moved",
      );
    }
    if (json(old.length) !== json(cur.length)) {
      d.add(
        "field-length-changed",
        key,
        name,
        `${at}/length`,
        old.length,
        cur.length,
        "the field's width changed",
      );
    }
    if (old.encoding !== cur.encoding) {
      d.add(
        "field-encoding-changed",
        key,
        name,
        `${at}/encoding`,
        old.encoding,
        cur.encoding,
        "the same bytes now mean something else",
      );
    }
    if (old.constant !== cur.constant) {
      d.add(
        "field-constant-changed",
        key,
        name,
        `${at}/constant`,
        old.constant,
        cur.constant,
        "decoders check this value exactly",
      );
    }
    if (json(old.presentWhen) !== json(cur.presentWhen)) {
      d.add(
        "field-presence-changed",
        key,
        name,
        `${at}/presentWhen`,
        old.presentWhen,
        cur.presentWhen,
        "the field appears under different conditions",
      );
    }
    compareTags(key, name, old.values, cur.values, d);
  }
}

function compareTags(
  key: string,
  field: string,
  a: Readonly<Record<string, number>> | undefined,
  b: Readonly<Record<string, number>> | undefined,
  d: Decisions,
): void {
  if (a === undefined && b === undefined) return;
  const at = `${key}/fields/${field}/values`;
  const before = a ?? {};
  const after = b ?? {};
  const labelOf = (values: Readonly<Record<string, number>>, n: number) =>
    Object.entries(values).find(([, v]) => v === n)?.[0];
  for (const [label, value] of Object.entries(before)) {
    const now = after[label];
    if (now === value) continue;
    const relabel = labelOf(after, value);
    if (now === undefined && relabel !== undefined && before[relabel] === undefined) {
      d.add(
        "tag-renamed",
        key,
        field,
        `${at}/${label}`,
        { [label]: value },
        { [relabel]: value },
        "same tag value, new label",
      );
    } else if (now === undefined) {
      d.add(
        "tag-removed",
        key,
        field,
        `${at}/${label}`,
        value,
        undefined,
        `tag ${String(value)} is no longer accepted`,
      );
    } else {
      d.add(
        "tag-value-changed",
        key,
        field,
        `${at}/${label}`,
        value,
        now,
        `${label} is now encoded as ${String(now)}`,
      );
    }
  }
  for (const [label, value] of Object.entries(after)) {
    if (before[label] !== undefined || labelOf(before, value) !== undefined) continue;
    d.add(
      "tag-added",
      key,
      field,
      `${at}/${label}`,
      undefined,
      value,
      "decoders of this version refuse the new tag; add a new version instead",
    );
  }
}

function compareErrors(a: ErrorTableSchema, b: ErrorTableSchema, d: Decisions): void {
  const key = wireSchemaKey(a);
  if (a.codeSpace !== b.codeSpace) {
    d.add(
      "error-code-space-changed",
      key,
      null,
      `${key}/codeSpace`,
      a.codeSpace,
      b.codeSpace,
      "every code changes meaning",
    );
    return;
  }
  const before = new Map(a.entries.map((e) => [e.name, e]));
  const after = new Map(b.entries.map((e) => [e.name, e]));
  const nameByCode = new Map(a.entries.map((e) => [e.code, e.name]));
  const maxBefore = Math.max(0, ...a.entries.map((e) => (typeof e.code === "number" ? e.code : 0)));
  for (const [name, old] of before) {
    const at = `${key}/entries/${name}`;
    const cur = after.get(name);
    if (cur === undefined) {
      d.add(
        "error-removed",
        key,
        name,
        at,
        old.code,
        undefined,
        "contracts may still return this code",
      );
      continue;
    }
    if (cur.code !== old.code) {
      d.add(
        "error-code-changed",
        key,
        name,
        `${at}/code`,
        old.code,
        cur.code,
        "an already-returned code is renamed or misread",
      );
    }
    if (old.signature !== cur.signature) {
      d.add(
        "error-signature-changed",
        key,
        name,
        `${at}/signature`,
        old.signature,
        cur.signature,
        "revert data decodes differently",
      );
    }
  }
  for (const [name, cur] of after) {
    if (before.has(name)) continue;
    const at = `${key}/entries/${name}`;
    const previous = nameByCode.get(cur.code);
    if (previous !== undefined) {
      d.add(
        "error-code-reassigned",
        key,
        name,
        `${at}/code`,
        { [previous]: cur.code },
        { [name]: cur.code },
        `${String(cur.code)} used to mean ${previous}`,
      );
    } else if (a.codeSpace === "soroban-contract-error") {
      const appended = typeof cur.code === "number" && cur.code > maxBefore;
      d.add(
        appended ? "error-appended" : "error-inserted",
        key,
        name,
        `${at}/code`,
        undefined,
        cur.code,
        appended ? "new code past the end of the table" : "the table is append only",
      );
    } else {
      d.add("error-added", key, name, `${at}/code`, undefined, cur.code, "a new selector");
    }
  }
}

/** Compare `candidate` against `baseline` and classify every difference. */
export function compareWireSchemaSets(
  baseline: WireSchemaSet,
  candidate: WireSchemaSet,
): CompatibilityReport {
  const d = new Decisions();
  const before = new Map(baseline.schemas.map((s) => [wireSchemaKey(s), s]));
  const after = new Map(candidate.schemas.map((s) => [wireSchemaKey(s), s]));
  for (const [key, old] of before) {
    const cur = after.get(key);
    if (cur === undefined) {
      d.add(
        "schema-removed",
        key,
        null,
        key,
        old.kind,
        undefined,
        "peers producing or reading this layout lose support",
      );
    } else if (old.kind !== cur.kind) {
      d.add(
        "schema-kind-changed",
        key,
        null,
        `${key}/kind`,
        old.kind,
        cur.kind,
        "a different kind of schema under the same identity",
      );
    } else if (old.kind === "message" && cur.kind === "message") {
      compareMessages(old, cur, d);
    } else if (old.kind === "error-table" && cur.kind === "error-table") {
      compareErrors(old, cur, d);
    }
  }
  for (const [key, cur] of after) {
    if (!before.has(key))
      d.add(
        "schema-added",
        key,
        null,
        key,
        undefined,
        cur.kind,
        "new layout; existing ones are unaffected",
      );
  }
  const decisions = d.list.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const breaking = decisions.filter((x) => x.classification === "breaking").length;
  return {
    reportVersion: WIRE_COMPAT_REPORT_VERSION,
    result: decisions.length === 0 ? "identical" : breaking > 0 ? "breaking" : "compatible",
    breaking,
    compatible: decisions.length - breaking,
    decisions,
  };
}

/** A plain-text rendering, one line per decision, for a PR description or a CI log. */
export function formatCompatibilityReport(report: CompatibilityReport): string {
  const lines = [
    `wire compatibility: ${report.result} (${String(report.breaking)} breaking, ${String(report.compatible)} compatible)`,
  ];
  for (const x of report.decisions) {
    lines.push(
      `${x.classification === "breaking" ? "BREAKING  " : "compatible"} ${x.rule} ${x.path}: ${x.baseline ?? "absent"} -> ${x.candidate ?? "absent"} (${x.detail})`,
    );
  }
  return `${lines.join("\n")}\n`;
}
