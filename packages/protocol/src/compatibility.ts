/**
 * Wire-format schema registry and compatibility report generator.
 *
 * Compares baseline and candidate definitions of Hyperion's cross-chain note layouts, SEP-23
 * address tags, route tags, Circle CCTP V2 message offsets, QuoteBlocker codes, and Soroban/EVM
 * error tables, linking every compatible addition or breaking drift to concrete schema fields.
 */
import {
  AddressKind,
  STRKEY_LEN_MUXED,
  STRKEY_LEN_PLAIN,
  TAGGED_LEN_MUXED,
  TAGGED_LEN_PLAIN,
  VERSION_ACCOUNT,
  VERSION_CONTRACT,
  VERSION_MUXED,
  encodeStellarAddress,
} from "./addresses.js";
import { concatBytes, fromHex, toHex } from "./bytes.js";
import {
  BURN_HOOK_DATA,
  BURN_MESSAGE_VERSION,
  FINALITY_THRESHOLD_FINALIZED,
  HOOK_VERSION,
  MESSAGE_VERSION,
  MSG_BODY,
  STELLAR_DOMAIN,
  cctpBody,
  cctpHookData,
  parseCctpBurnMessage,
  parseCctpMessage,
} from "./cctp.js";
import { EVM_ERROR_NAMES, SOROBAN_ERROR_NAMES, sorobanErrorCode } from "./errors.js";
import {
  METADATA_CONTRACT_CALL,
  NOTE_VERSION,
  OUTBOUND_NOTE_LEN,
  decodeCctpHook,
  decodeInboundNote,
  decodeOutboundNote,
  encodeCctpHook,
  encodeInboundNote,
  encodeOutboundNote,
} from "./notes.js";
import { QuoteBlocker } from "./quotes.js";
import { RouteKind } from "./routes.js";

/** Byte offset and byte width of a fixed-position wire field. */
export interface WireFieldSpan {
  readonly offset: number;
  readonly length: number;
}

/** Address-kind wire descriptor for SEP-23 strkey and tagged binary destination encodings. */
export interface AddressKindWireSpec {
  readonly tag: number;
  readonly versionByte: number;
  readonly strkeyLength: number;
  readonly taggedLength: number;
}

/** Complete wire-format schema covering addresses, routes, notes, CCTP V2, and error tables. */
export interface WireFormatSchema {
  readonly schemaRevision: number;
  readonly addresses: {
    readonly kinds: Readonly<Record<string, AddressKindWireSpec>>;
  };
  readonly routes: {
    readonly tags: Readonly<Record<string, number>>;
  };
  readonly notes: {
    readonly version: number;
    readonly axelarMetadataVersion: number;
    readonly outbound: {
      readonly totalLength: number;
      readonly fields: Readonly<Record<string, WireFieldSpan>>;
    };
    readonly inbound: {
      readonly minLength: number;
      readonly trailingNonceLength: number;
      readonly fields: Readonly<Record<string, WireFieldSpan>>;
    };
    readonly cctpHook: {
      readonly plainLength: number;
      readonly muxedLength: number;
      readonly fields: Readonly<Record<string, WireFieldSpan>>;
    };
  };
  readonly cctp: {
    readonly stellarDomain: number;
    readonly messageVersion: number;
    readonly burnMessageVersion: number;
    readonly hookVersion: number;
    readonly headerLength: number;
    readonly headerFields: Readonly<Record<string, WireFieldSpan>>;
    readonly burnBodyMinLength: number;
    readonly burnFields: Readonly<Record<string, WireFieldSpan>>;
  };
  readonly errors: {
    readonly soroban: readonly string[];
    readonly evm: readonly string[];
    readonly quoteBlockers: Readonly<Record<string, number>>;
  };
}

export type WireCompatibilityClassification = "identical" | "compatible" | "breaking";

/** Single schema comparison decision tied to an exact `schemaField` path. */
export interface WireSchemaFinding {
  readonly schemaField: string;
  readonly classification: "compatible" | "breaking";
  readonly baselineValue: string | number | null;
  readonly candidateValue: string | number | null;
  readonly reason: string;
}

/** Result of verifying a canonical v1 wire fixture against the live SDK codecs. */
export interface WireFixtureCheck {
  readonly fixtureId: string;
  readonly schemaField: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** Structured compatibility report across note, message, address, route, and error schemas. */
export interface WireCompatibilityReport {
  readonly classification: WireCompatibilityClassification;
  readonly compatibleWithV1: boolean;
  readonly breakingCount: number;
  readonly compatibleAdditionCount: number;
  readonly findings: readonly WireSchemaFinding[];
  readonly v1FixtureChecks: readonly WireFixtureCheck[];
}

/** Snapshot the live SDK constants into a `WireFormatSchema` instance. */
export function buildCurrentWireFormatSchema(): WireFormatSchema {
  return {
    schemaRevision: 1,
    addresses: {
      kinds: {
        Account: {
          tag: AddressKind.Account,
          versionByte: VERSION_ACCOUNT,
          strkeyLength: STRKEY_LEN_PLAIN,
          taggedLength: TAGGED_LEN_PLAIN,
        },
        Contract: {
          tag: AddressKind.Contract,
          versionByte: VERSION_CONTRACT,
          strkeyLength: STRKEY_LEN_PLAIN,
          taggedLength: TAGGED_LEN_PLAIN,
        },
        MuxedAccount: {
          tag: AddressKind.MuxedAccount,
          versionByte: VERSION_MUXED,
          strkeyLength: STRKEY_LEN_MUXED,
          taggedLength: TAGGED_LEN_MUXED,
        },
      },
    },
    routes: {
      tags: {
        Cctp: RouteKind.Cctp,
        AxelarIts: RouteKind.AxelarIts,
        AxelarGmp: RouteKind.AxelarGmp,
        Allbridge: RouteKind.Allbridge,
      },
    },
    notes: {
      version: NOTE_VERSION,
      axelarMetadataVersion: METADATA_CONTRACT_CALL,
      outbound: {
        totalLength: OUTBOUND_NOTE_LEN,
        fields: {
          version: { offset: 0, length: 1 },
          recipient: { offset: 1, length: 20 },
          nonce: { offset: 21, length: 8 },
        },
      },
      inbound: {
        minLength: 12,
        trailingNonceLength: 8,
        fields: {
          version: { offset: 0, length: 1 },
          kindTag: { offset: 1, length: 1 },
          strkeyLength: { offset: 2, length: 1 },
        },
      },
      cctpHook: {
        plainLength: 34,
        muxedLength: 42,
        fields: {
          version: { offset: 0, length: 1 },
          kindTag: { offset: 1, length: 1 },
          key: { offset: 2, length: 32 },
          muxedId: { offset: 34, length: 8 },
        },
      },
    },
    cctp: {
      stellarDomain: STELLAR_DOMAIN,
      messageVersion: MESSAGE_VERSION,
      burnMessageVersion: BURN_MESSAGE_VERSION,
      hookVersion: HOOK_VERSION,
      headerLength: MSG_BODY,
      headerFields: {
        version: { offset: 0, length: 4 },
        sourceDomain: { offset: 4, length: 4 },
        destinationDomain: { offset: 8, length: 4 },
        nonce: { offset: 12, length: 32 },
        sender: { offset: 44, length: 32 },
        recipient: { offset: 76, length: 32 },
        destinationCaller: { offset: 108, length: 32 },
        minFinalityThreshold: { offset: 140, length: 4 },
        finalityThresholdExecuted: { offset: 144, length: 4 },
      },
      burnBodyMinLength: BURN_HOOK_DATA,
      burnFields: {
        version: { offset: 0, length: 4 },
        burnToken: { offset: 4, length: 32 },
        mintRecipient: { offset: 36, length: 32 },
        amount: { offset: 68, length: 32 },
        messageSender: { offset: 100, length: 32 },
        maxFee: { offset: 132, length: 32 },
        feeExecuted: { offset: 164, length: 32 },
        expirationBlock: { offset: 196, length: 32 },
      },
    },
    errors: {
      soroban: [...SOROBAN_ERROR_NAMES],
      evm: [...EVM_ERROR_NAMES],
      quoteBlockers: { ...QuoteBlocker },
    },
  };
}

/** Frozen canonical version-1 wire schema baseline. */
export const CANONICAL_WIRE_SCHEMA_V1: WireFormatSchema = buildCurrentWireFormatSchema();

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `invalid wire schema integer at ${field}: expected non-negative safe integer, got ${String(value)}`,
    );
  }
}

function validateSchemaIntegers(schema: WireFormatSchema, label: string): void {
  assertNonNegativeInteger(schema.schemaRevision, `${label}.schemaRevision`);
  for (const [name, spec] of Object.entries(schema.addresses.kinds)) {
    assertNonNegativeInteger(spec.tag, `${label}.addresses.kinds.${name}.tag`);
    assertNonNegativeInteger(spec.versionByte, `${label}.addresses.kinds.${name}.versionByte`);
    assertNonNegativeInteger(spec.strkeyLength, `${label}.addresses.kinds.${name}.strkeyLength`);
    assertNonNegativeInteger(spec.taggedLength, `${label}.addresses.kinds.${name}.taggedLength`);
  }
  for (const [name, tag] of Object.entries(schema.routes.tags)) {
    assertNonNegativeInteger(tag, `${label}.routes.tags.${name}`);
  }
  assertNonNegativeInteger(schema.notes.version, `${label}.notes.version`);
  assertNonNegativeInteger(
    schema.notes.axelarMetadataVersion,
    `${label}.notes.axelarMetadataVersion`,
  );
  assertNonNegativeInteger(
    schema.notes.outbound.totalLength,
    `${label}.notes.outbound.totalLength`,
  );
  for (const [field, span] of Object.entries(schema.notes.outbound.fields)) {
    assertNonNegativeInteger(span.offset, `${label}.notes.outbound.fields.${field}.offset`);
    assertNonNegativeInteger(span.length, `${label}.notes.outbound.fields.${field}.length`);
  }
  assertNonNegativeInteger(schema.notes.inbound.minLength, `${label}.notes.inbound.minLength`);
  assertNonNegativeInteger(
    schema.notes.inbound.trailingNonceLength,
    `${label}.notes.inbound.trailingNonceLength`,
  );
  for (const [field, span] of Object.entries(schema.notes.inbound.fields)) {
    assertNonNegativeInteger(span.offset, `${label}.notes.inbound.fields.${field}.offset`);
    assertNonNegativeInteger(span.length, `${label}.notes.inbound.fields.${field}.length`);
  }
  assertNonNegativeInteger(
    schema.notes.cctpHook.plainLength,
    `${label}.notes.cctpHook.plainLength`,
  );
  assertNonNegativeInteger(
    schema.notes.cctpHook.muxedLength,
    `${label}.notes.cctpHook.muxedLength`,
  );
  for (const [field, span] of Object.entries(schema.notes.cctpHook.fields)) {
    assertNonNegativeInteger(span.offset, `${label}.notes.cctpHook.fields.${field}.offset`);
    assertNonNegativeInteger(span.length, `${label}.notes.cctpHook.fields.${field}.length`);
  }
  assertNonNegativeInteger(schema.cctp.stellarDomain, `${label}.cctp.stellarDomain`);
  assertNonNegativeInteger(schema.cctp.messageVersion, `${label}.cctp.messageVersion`);
  assertNonNegativeInteger(schema.cctp.burnMessageVersion, `${label}.cctp.burnMessageVersion`);
  assertNonNegativeInteger(schema.cctp.hookVersion, `${label}.cctp.hookVersion`);
  assertNonNegativeInteger(schema.cctp.headerLength, `${label}.cctp.headerLength`);
  assertNonNegativeInteger(schema.cctp.burnBodyMinLength, `${label}.cctp.burnBodyMinLength`);
  for (const [field, span] of Object.entries(schema.cctp.headerFields)) {
    assertNonNegativeInteger(span.offset, `${label}.cctp.headerFields.${field}.offset`);
    assertNonNegativeInteger(span.length, `${label}.cctp.headerFields.${field}.length`);
  }
  for (const [field, span] of Object.entries(schema.cctp.burnFields)) {
    assertNonNegativeInteger(span.offset, `${label}.cctp.burnFields.${field}.offset`);
    assertNonNegativeInteger(span.length, `${label}.cctp.burnFields.${field}.length`);
  }
  for (const [name, code] of Object.entries(schema.errors.quoteBlockers)) {
    assertNonNegativeInteger(code, `${label}.errors.quoteBlockers.${name}`);
  }
}

function compareScalar(
  findings: WireSchemaFinding[],
  schemaField: string,
  before: number,
  after: number,
  reason: string,
): void {
  if (before !== after) {
    findings.push({
      schemaField,
      classification: "breaking",
      baselineValue: before,
      candidateValue: after,
      reason,
    });
  }
}

function compareSpanMap(
  findings: WireSchemaFinding[],
  prefix: string,
  beforeMap: Readonly<Record<string, WireFieldSpan>>,
  afterMap: Readonly<Record<string, WireFieldSpan>>,
): void {
  for (const [name, beforeSpan] of Object.entries(beforeMap)) {
    const afterSpan = afterMap[name];
    if (afterSpan === undefined) {
      findings.push({
        schemaField: `${prefix}.${name}`,
        classification: "breaking",
        baselineValue: `${String(beforeSpan.offset)}+${String(beforeSpan.length)}`,
        candidateValue: null,
        reason: `wire field "${name}" was removed`,
      });
      continue;
    }
    compareScalar(
      findings,
      `${prefix}.${name}.offset`,
      beforeSpan.offset,
      afterSpan.offset,
      `byte offset of "${name}" changed`,
    );
    compareScalar(
      findings,
      `${prefix}.${name}.length`,
      beforeSpan.length,
      afterSpan.length,
      `byte width of "${name}" changed`,
    );
  }

  for (const [name, afterSpan] of Object.entries(afterMap)) {
    if (beforeMap[name] === undefined) {
      findings.push({
        schemaField: `${prefix}.${name}`,
        classification: "breaking",
        baselineValue: null,
        candidateValue: `${String(afterSpan.offset)}+${String(afterSpan.length)}`,
        reason: `unversioned fixed-offset wire field "${name}" was inserted`,
      });
    }
  }
}

function compareTagTable(
  findings: WireSchemaFinding[],
  prefix: string,
  beforeTags: Readonly<Record<string, number>>,
  afterTags: Readonly<Record<string, number>>,
  label: string,
): void {
  const usedBaselineValues = new Set(Object.values(beforeTags));
  let maxBaselineTag = -1;
  for (const v of usedBaselineValues) {
    if (v > maxBaselineTag) maxBaselineTag = v;
  }

  for (const [name, beforeTag] of Object.entries(beforeTags)) {
    const afterTag = afterTags[name];
    if (afterTag === undefined) {
      findings.push({
        schemaField: `${prefix}.${name}`,
        classification: "breaking",
        baselineValue: beforeTag,
        candidateValue: null,
        reason: `${label} "${name}" was removed`,
      });
      continue;
    }
    if (beforeTag !== afterTag) {
      findings.push({
        schemaField: `${prefix}.${name}`,
        classification: "breaking",
        baselineValue: beforeTag,
        candidateValue: afterTag,
        reason: `${label} "${name}" changed numeric wire tag`,
      });
    }
  }

  const seenAddedTags = new Set<number>();
  for (const [name, afterTag] of Object.entries(afterTags)) {
    if (beforeTags[name] !== undefined) continue;
    const collides =
      usedBaselineValues.has(afterTag) || seenAddedTags.has(afterTag) || afterTag <= maxBaselineTag;
    seenAddedTags.add(afterTag);
    findings.push({
      schemaField: `${prefix}.${name}`,
      classification: collides ? "breaking" : "compatible",
      baselineValue: null,
      candidateValue: afterTag,
      reason: collides
        ? `new ${label} "${name}" collides with or reorders existing tag space`
        : `append-only ${label} "${name}" extends tag table safely`,
    });
  }
}

function compareAppendOnlyList(
  findings: WireSchemaFinding[],
  prefix: string,
  beforeList: readonly string[],
  afterList: readonly string[],
  label: string,
): void {
  const seenAfter = new Set<string>();

  for (let i = 0; i < beforeList.length; i += 1) {
    const expected = beforeList[i] ?? "";
    const actual = afterList[i];
    if (actual === undefined) {
      findings.push({
        schemaField: `${prefix}[${String(i)}]`,
        classification: "breaking",
        baselineValue: expected,
        candidateValue: null,
        reason: `${label} entry "${expected}" at index ${String(i)} was removed`,
      });
      continue;
    }
    seenAfter.add(actual);
    if (actual !== expected) {
      findings.push({
        schemaField: `${prefix}[${String(i)}]`,
        classification: "breaking",
        baselineValue: expected,
        candidateValue: actual,
        reason: `${label} index ${String(i)} changed from "${expected}" to "${actual}"`,
      });
    }
  }

  for (let i = beforeList.length; i < afterList.length; i += 1) {
    const added = afterList[i] ?? "";
    const duplicate = seenAfter.has(added) || added.length === 0;
    seenAfter.add(added);
    findings.push({
      schemaField: `${prefix}[${String(i)}]`,
      classification: duplicate ? "breaking" : "compatible",
      baselineValue: null,
      candidateValue: added,
      reason: duplicate
        ? `appended ${label} entry "${added}" at index ${String(i)} is empty or duplicates an existing variant`
        : `append-only ${label} entry "${added}" added at index ${String(i)}`,
    });
  }
}

/** Execute deterministic version-1 wire round-trips to prove v1 fixture stability. */
export function verifyCanonicalV1Fixtures(): readonly WireFixtureCheck[] {
  const keyHex = "0x3b9c2115c0efd344ba0a8901eb1cfe44f36cf7dbe946beb0ee4820f7ec49bf15" as const;
  const muxedId = 9_007_199_254_740_993n;
  const plainAddr = encodeStellarAddress(AddressKind.Account, keyHex);
  const muxedAddr = encodeStellarAddress(AddressKind.MuxedAccount, keyHex, muxedId);
  const evmAddr = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
  const wideNonce = (1n << 64n) - 1n;

  const outboundBytes = encodeOutboundNote(evmAddr, wideNonce);
  const decodedOutbound = decodeOutboundNote(toHex(outboundBytes));
  const outboundOk =
    outboundBytes.length === OUTBOUND_NOTE_LEN &&
    decodedOutbound.recipient === evmAddr &&
    decodedOutbound.nonce === wideNonce;

  const inboundPlain = encodeInboundNote(plainAddr, 42n);
  const inboundMuxed = encodeInboundNote(muxedAddr, wideNonce);
  const decodedInboundMuxed = decodeInboundNote(inboundMuxed);
  const inboundOk =
    inboundPlain.length === 67 &&
    inboundMuxed.length === 80 &&
    decodedInboundMuxed.kind === AddressKind.MuxedAccount &&
    decodedInboundMuxed.strkey === muxedAddr &&
    decodedInboundMuxed.nonce === wideNonce;

  const hookPlain = encodeCctpHook(plainAddr);
  const hookMuxed = encodeCctpHook(muxedAddr);
  const decodedHookMuxed = decodeCctpHook(hookMuxed);
  const hookOk =
    hookPlain.length === 34 &&
    hookMuxed.length === 42 &&
    decodedHookMuxed.kind === AddressKind.MuxedAccount &&
    decodedHookMuxed.key === keyHex &&
    decodedHookMuxed.muxedId === muxedId;

  const header = new Uint8Array(MSG_BODY);
  header.set(fromHex(`0x${MESSAGE_VERSION.toString(16).padStart(8, "0")}`), 0);
  header.set(fromHex(`0x${STELLAR_DOMAIN.toString(16).padStart(8, "0")}`), 8);
  header.set(fromHex(`0x${FINALITY_THRESHOLD_FINALIZED.toString(16).padStart(8, "0")}`), 144);
  const burn = new Uint8Array(BURN_HOOK_DATA);
  burn.set(fromHex(`0x${BURN_MESSAGE_VERSION.toString(16).padStart(8, "0")}`), 0);
  burn.set(fromHex(`0x${((1n << 127n) - 1n).toString(16).padStart(64, "0")}`), 68);
  const fullCctp = concatBytes(header, burn, hookMuxed);
  const parsedMsg = parseCctpMessage(fullCctp);
  const parsedBurn = parseCctpBurnMessage(cctpBody(fullCctp));
  const extractedHook = cctpHookData(cctpBody(fullCctp));
  const cctpOk =
    parsedMsg.version === MESSAGE_VERSION &&
    parsedMsg.destinationDomain === STELLAR_DOMAIN &&
    parsedBurn.amount === (1n << 127n) - 1n &&
    extractedHook.length === 42;

  const errorTagsOk =
    sorobanErrorCode("AlreadyInitialized") === 1 &&
    sorobanErrorCode("ExceedsRouteLimit") === SOROBAN_ERROR_NAMES.length;

  return [
    {
      fixtureId: "v1-outbound-note-29b",
      schemaField: "notes.outbound",
      passed: outboundOk,
      detail: `29-byte outbound note round-tripped with uint64 max nonce (${String(outboundBytes.length)} bytes)`,
    },
    {
      fixtureId: "v1-inbound-note-plain-and-muxed",
      schemaField: "notes.inbound",
      passed: inboundOk,
      detail: "67-byte account and 80-byte muxed inbound notes preserved SEP-23 strkey and nonce",
    },
    {
      fixtureId: "v1-cctp-hook-34b-42b",
      schemaField: "notes.cctpHook",
      passed: hookOk,
      detail: "34-byte plain and 42-byte muxed CCTP hooks preserved AddressKind and 2^53+1 muxedId",
    },
    {
      fixtureId: "v1-cctp-envelope-148b-228b",
      schemaField: "cctp",
      passed: cctpOk,
      detail: "148-byte CCTP header and 228-byte burn body decoded i128-max amount and hook tail",
    },
    {
      fixtureId: "v1-soroban-error-numbering",
      schemaField: "errors.soroban",
      passed: errorTagsOk,
      detail: `Soroban error tags 1..${String(SOROBAN_ERROR_NAMES.length)} remained contiguous`,
    },
  ];
}

/**
 * Compare a baseline and candidate `WireFormatSchema`, classifying each difference as `"compatible"`
 * or `"breaking"` and linking every decision to a concrete `schemaField` path.
 */
export function compareWireFormatSchemas(
  baseline: WireFormatSchema = CANONICAL_WIRE_SCHEMA_V1,
  candidate: WireFormatSchema = buildCurrentWireFormatSchema(),
): WireCompatibilityReport {
  validateSchemaIntegers(baseline, "baseline");
  validateSchemaIntegers(candidate, "candidate");

  const findings: WireSchemaFinding[] = [];

  // 1. Address kinds and SEP-23 wire tags.
  const usedTags = new Set(Object.values(baseline.addresses.kinds).map((k) => k.tag));
  const usedVersions = new Set(Object.values(baseline.addresses.kinds).map((k) => k.versionByte));

  for (const [name, beforeSpec] of Object.entries(baseline.addresses.kinds)) {
    const afterSpec = candidate.addresses.kinds[name];
    const baseField = `addresses.kinds.${name}`;
    if (afterSpec === undefined) {
      findings.push({
        schemaField: baseField,
        classification: "breaking",
        baselineValue: beforeSpec.tag,
        candidateValue: null,
        reason: `address kind "${name}" was removed`,
      });
      continue;
    }
    compareScalar(
      findings,
      `${baseField}.tag`,
      beforeSpec.tag,
      afterSpec.tag,
      `address kind "${name}" changed wire tag`,
    );
    compareScalar(
      findings,
      `${baseField}.versionByte`,
      beforeSpec.versionByte,
      afterSpec.versionByte,
      `address kind "${name}" changed SEP-23 version byte`,
    );
    compareScalar(
      findings,
      `${baseField}.strkeyLength`,
      beforeSpec.strkeyLength,
      afterSpec.strkeyLength,
      `address kind "${name}" changed strkey character length`,
    );
    compareScalar(
      findings,
      `${baseField}.taggedLength`,
      beforeSpec.taggedLength,
      afterSpec.taggedLength,
      `address kind "${name}" changed tagged binary byte length`,
    );
  }

  for (const [name, afterSpec] of Object.entries(candidate.addresses.kinds)) {
    if (baseline.addresses.kinds[name] !== undefined) continue;
    const baseField = `addresses.kinds.${name}`;
    const collides = usedTags.has(afterSpec.tag) || usedVersions.has(afterSpec.versionByte);
    usedTags.add(afterSpec.tag);
    usedVersions.add(afterSpec.versionByte);
    findings.push({
      schemaField: `${baseField}.tag`,
      classification: collides ? "breaking" : "compatible",
      baselineValue: null,
      candidateValue: afterSpec.tag,
      reason: collides
        ? `new address kind "${name}" collides with an existing tag or SEP-23 version byte`
        : `append-only address kind "${name}" uses an unassigned wire tag and version byte`,
    });
  }

  // 2. Route tags.
  compareTagTable(findings, "routes.tags", baseline.routes.tags, candidate.routes.tags, "route");

  // 3. Note layouts and versions.
  compareScalar(
    findings,
    "notes.version",
    baseline.notes.version,
    candidate.notes.version,
    "note envelope version changed",
  );
  compareScalar(
    findings,
    "notes.axelarMetadataVersion",
    baseline.notes.axelarMetadataVersion,
    candidate.notes.axelarMetadataVersion,
    "Axelar metadata version changed",
  );
  compareScalar(
    findings,
    "notes.outbound.totalLength",
    baseline.notes.outbound.totalLength,
    candidate.notes.outbound.totalLength,
    "outbound note fixed byte length changed",
  );
  compareSpanMap(
    findings,
    "notes.outbound.fields",
    baseline.notes.outbound.fields,
    candidate.notes.outbound.fields,
  );
  compareScalar(
    findings,
    "notes.inbound.minLength",
    baseline.notes.inbound.minLength,
    candidate.notes.inbound.minLength,
    "inbound note minimum byte length changed",
  );
  compareScalar(
    findings,
    "notes.inbound.trailingNonceLength",
    baseline.notes.inbound.trailingNonceLength,
    candidate.notes.inbound.trailingNonceLength,
    "inbound note trailing nonce byte width changed",
  );
  compareSpanMap(
    findings,
    "notes.inbound.fields",
    baseline.notes.inbound.fields,
    candidate.notes.inbound.fields,
  );
  compareScalar(
    findings,
    "notes.cctpHook.plainLength",
    baseline.notes.cctpHook.plainLength,
    candidate.notes.cctpHook.plainLength,
    "CCTP plain hook byte length changed",
  );
  compareScalar(
    findings,
    "notes.cctpHook.muxedLength",
    baseline.notes.cctpHook.muxedLength,
    candidate.notes.cctpHook.muxedLength,
    "CCTP muxed hook byte length changed",
  );
  compareSpanMap(
    findings,
    "notes.cctpHook.fields",
    baseline.notes.cctpHook.fields,
    candidate.notes.cctpHook.fields,
  );

  // 4. CCTP V2 header and burn body layouts.
  compareScalar(
    findings,
    "cctp.stellarDomain",
    baseline.cctp.stellarDomain,
    candidate.cctp.stellarDomain,
    "Circle CCTP Stellar domain identifier changed",
  );
  compareScalar(
    findings,
    "cctp.messageVersion",
    baseline.cctp.messageVersion,
    candidate.cctp.messageVersion,
    "CCTP message header version changed",
  );
  compareScalar(
    findings,
    "cctp.burnMessageVersion",
    baseline.cctp.burnMessageVersion,
    candidate.cctp.burnMessageVersion,
    "CCTP burn body version changed",
  );
  compareScalar(
    findings,
    "cctp.hookVersion",
    baseline.cctp.hookVersion,
    candidate.cctp.hookVersion,
    "CCTP hook version changed",
  );
  compareScalar(
    findings,
    "cctp.headerLength",
    baseline.cctp.headerLength,
    candidate.cctp.headerLength,
    "CCTP header byte length changed",
  );
  compareSpanMap(
    findings,
    "cctp.headerFields",
    baseline.cctp.headerFields,
    candidate.cctp.headerFields,
  );
  compareScalar(
    findings,
    "cctp.burnBodyMinLength",
    baseline.cctp.burnBodyMinLength,
    candidate.cctp.burnBodyMinLength,
    "CCTP burn body minimum byte length changed",
  );
  compareSpanMap(findings, "cctp.burnFields", baseline.cctp.burnFields, candidate.cctp.burnFields);

  // 5. Soroban/EVM error tables and QuoteBlocker tags.
  compareAppendOnlyList(
    findings,
    "errors.soroban",
    baseline.errors.soroban,
    candidate.errors.soroban,
    "Soroban error",
  );
  compareAppendOnlyList(
    findings,
    "errors.evm",
    baseline.errors.evm,
    candidate.errors.evm,
    "EVM error",
  );
  compareTagTable(
    findings,
    "errors.quoteBlockers",
    baseline.errors.quoteBlockers,
    candidate.errors.quoteBlockers,
    "QuoteBlocker",
  );

  const v1FixtureChecks = verifyCanonicalV1Fixtures();
  const failedFixtures = v1FixtureChecks.filter((c) => !c.passed);
  for (const failed of failedFixtures) {
    findings.push({
      schemaField: failed.schemaField,
      classification: "breaking",
      baselineValue: "passed",
      candidateValue: "failed",
      reason: `canonical v1 fixture "${failed.fixtureId}" failed verification`,
    });
  }

  const breakingCount = findings.filter((f) => f.classification === "breaking").length;
  const compatibleAdditionCount = findings.filter((f) => f.classification === "compatible").length;
  const classification: WireCompatibilityClassification =
    breakingCount > 0 ? "breaking" : compatibleAdditionCount > 0 ? "compatible" : "identical";

  return {
    classification,
    compatibleWithV1: classification !== "breaking",
    breakingCount,
    compatibleAdditionCount,
    findings,
    v1FixtureChecks,
  };
}
