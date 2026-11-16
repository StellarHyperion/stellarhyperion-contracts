/**
 * Versioned bigint-safe persistence serializers for `RouterSnapshot` and `RouteQuote` bundles.
 *
 * `JSON.stringify` throws on `bigint`, while coercing token balances or flow windows to `number`
 * silently corrupts values above `2^53 - 1`. This module persists quote state using canonical
 * base-10 integer strings, explicit unit descriptors, mandatory capture timestamps, and an
 * immutable `persisted_historical_snapshot` classification so cached or stored snapshots can never
 * be mistaken for live executable prices.
 */
import { MAX_DECIMALS, MAX_FEE_BPS } from "./amounts.js";
import type { ChainKey } from "./chains.js";
import { isChainKey } from "./chains.js";
import type { QuoteBlocker, RouteQuote, RouterSnapshot } from "./quotes.js";
import type { RouteKind, RouteSlug } from "./routes.js";
import {
  ROUTE_KINDS,
  ROUTE_SLUGS,
  isCanonical,
  tryRouteFromSlug,
  waitsOnAttestation,
} from "./routes.js";

/** Schema version for persisted snapshot and quote-bundle envelopes. */
export const SNAPSHOT_SERIALIZATION_VERSION = 1;

/** Immutable freshness marker proving a serialized payload is historical state, not a live price. */
export const PERSISTED_SNAPSHOT_FRESHNESS_CLASS = "persisted_historical_snapshot" as const;

const MAX_U256 = (1n << 256n) - 1n;
const CANONICAL_UINT_STRING = /^(?:0|[1-9]\d*)$/;
const VALID_QUOTE_BLOCKERS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

/** Raised when a persisted snapshot or quote bundle fails version, unit, timestamp, or integer checks. */
export class SnapshotSerializationError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`invalid persisted snapshot at ${path}: ${reason}`);
    this.name = "SnapshotSerializationError";
  }
}

function failSnapshot(path: string, reason: string): never {
  throw new SnapshotSerializationError(path, reason);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failSnapshot(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function validateIsoTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failSnapshot(path, "expected an ISO-8601 timestamp string");
  }
  if (Number.isNaN(Date.parse(value))) {
    failSnapshot(path, `invalid ISO-8601 timestamp "${value}"`);
  }
  return value;
}

function validateDecimalsField(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_DECIMALS) {
    failSnapshot(path, `expected integer decimals in 0..${String(MAX_DECIMALS)}`);
  }
  return value;
}

function validateFeeBpsField(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_FEE_BPS) {
    failSnapshot(path, `expected integer feeBps in 0..${String(MAX_FEE_BPS)}`);
  }
  return value;
}

function formatWideUint(value: unknown, path: string): string {
  if (typeof value !== "bigint") {
    failSnapshot(path, "expected a bigint");
  }
  if (value < 0n || value > MAX_U256) {
    failSnapshot(path, `bigint out of uint256 range 0..${MAX_U256.toString()}`);
  }
  return value.toString(10);
}

function parseWideUintString(value: unknown, path: string): bigint {
  if (typeof value === "number") {
    failSnapshot(
      path,
      "expected a base-10 integer string, not a JSON number (numbers lose precision above 2^53 - 1)",
    );
  }
  if (typeof value !== "string" || !CANONICAL_UINT_STRING.test(value)) {
    failSnapshot(path, "expected a canonical unsigned base-10 integer string");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U256) {
    failSnapshot(path, `integer exceeds uint256 maximum (${MAX_U256.toString()})`);
  }
  return parsed;
}

function readSchemaVersion(obj: Record<string, unknown>, path: string): 1 {
  const raw = obj.schemaVersion;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    failSnapshot(`${path}.schemaVersion`, "schemaVersion must be an integer");
  }
  if (raw !== SNAPSHOT_SERIALIZATION_VERSION) {
    failSnapshot(
      `${path}.schemaVersion`,
      `unsupported snapshot schemaVersion ${String(raw)}; expected ${String(SNAPSHOT_SERIALIZATION_VERSION)}`,
    );
  }
  return SNAPSHOT_SERIALIZATION_VERSION;
}

function verifyNonLiveProvenance(obj: Record<string, unknown>, path: string): void {
  if (obj.freshnessClass !== PERSISTED_SNAPSHOT_FRESHNESS_CLASS) {
    failSnapshot(
      `${path}.freshnessClass`,
      `expected "${PERSISTED_SNAPSHOT_FRESHNESS_CLASS}" so persisted state cannot masquerade as live quotes`,
    );
  }
  if (obj.impliesLivePrice !== false) {
    failSnapshot(
      `${path}.impliesLivePrice`,
      "persisted snapshots must carry impliesLivePrice=false",
    );
  }
}

export interface SnapshotUnitMetadata {
  readonly amountEncoding: "base_unit_uint_string";
  readonly tokenDecimals: number;
  readonly feeUnit: "bps";
  readonly destinationDecimals?: number;
}

export interface SerializeSnapshotContext {
  /** Mandatory ISO-8601 capture timestamp. */
  readonly capturedAt: string;
  readonly originChain?: ChainKey;
  readonly tokenSymbol?: string;
}

export interface SerializedRouterSnapshotStateV1 {
  readonly paused: boolean;
  readonly feeBps: number;
  readonly routeEnabled: Readonly<Partial<Record<RouteSlug, boolean>>>;
  readonly adapterSet: Readonly<Partial<Record<RouteSlug, boolean>>>;
  readonly tokenRegistered: boolean;
  readonly tokenEnabled: boolean;
  readonly tokenDecimals: number;
  readonly flowAvailable: Readonly<Partial<Record<RouteSlug, string>>>;
  readonly chainSupported: Readonly<Partial<Record<RouteSlug, boolean>>>;
}

export interface SerializedRouterSnapshotV1 {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly freshnessClass: typeof PERSISTED_SNAPSHOT_FRESHNESS_CLASS;
  readonly impliesLivePrice: false;
  readonly originChain: ChainKey | null;
  readonly tokenSymbol: string | null;
  readonly units: SnapshotUnitMetadata;
  readonly state: SerializedRouterSnapshotStateV1;
}

export interface DeserializedRouterSnapshot {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly capturedAtMs: number;
  readonly freshnessClass: typeof PERSISTED_SNAPSHOT_FRESHNESS_CLASS;
  readonly impliesLivePrice: false;
  readonly requiresChainReconfirmation: true;
  readonly originChain: ChainKey | null;
  readonly tokenSymbol: string | null;
  readonly units: SnapshotUnitMetadata;
  readonly snapshot: RouterSnapshot;
}

export interface SerializedRouteQuoteV1 {
  readonly route: RouteSlug;
  readonly available: boolean;
  readonly reason: QuoteBlocker;
  readonly grossAmount: string;
  readonly fee: string;
  readonly netAmount: string;
  readonly destinationAmount: string;
  readonly flowAvailable: string;
  readonly waitsOnAttestation: boolean;
  readonly isCanonical: boolean;
}

export interface SerializedQuoteBundleV1 {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly freshnessClass: typeof PERSISTED_SNAPSHOT_FRESHNESS_CLASS;
  readonly impliesLivePrice: false;
  readonly units: SnapshotUnitMetadata & { readonly destinationDecimals: number };
  readonly snapshot: SerializedRouterSnapshotStateV1;
  readonly quotes: readonly SerializedRouteQuoteV1[];
}

export interface DeserializedQuoteBundle {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly capturedAtMs: number;
  readonly freshnessClass: typeof PERSISTED_SNAPSHOT_FRESHNESS_CLASS;
  readonly impliesLivePrice: false;
  readonly requiresChainReconfirmation: true;
  readonly units: SnapshotUnitMetadata & { readonly destinationDecimals: number };
  readonly snapshot: RouterSnapshot;
  readonly quotes: readonly RouteQuote[];
}

function serializeBoolRouteMap(
  map: Partial<Record<RouteKind, boolean>>,
  path: string,
): Readonly<Partial<Record<RouteSlug, boolean>>> {
  const out: Partial<Record<RouteSlug, boolean>> = {};
  for (const kind of ROUTE_KINDS) {
    const val: unknown = map[kind];
    if (val === undefined) continue;
    if (typeof val !== "boolean") {
      failSnapshot(`${path}.${ROUTE_SLUGS[kind]}`, "expected a boolean");
    }
    out[ROUTE_SLUGS[kind]] = val;
  }
  return Object.freeze(out);
}

function deserializeBoolRouteMap(raw: unknown, path: string): Partial<Record<RouteKind, boolean>> {
  const obj = asRecord(raw, path);
  const out: Partial<Record<RouteKind, boolean>> = {};
  for (const [slug, val] of Object.entries(obj)) {
    const kind = tryRouteFromSlug(slug);
    if (kind === null) {
      failSnapshot(`${path}.${slug}`, `unknown route slug "${slug}"`);
    }
    if (typeof val !== "boolean") {
      failSnapshot(`${path}.${slug}`, "expected a boolean");
    }
    out[kind] = val;
  }
  return out;
}

function serializeFlowMap(
  map: Partial<Record<RouteKind, bigint>>,
  path: string,
): Readonly<Partial<Record<RouteSlug, string>>> {
  const out: Partial<Record<RouteSlug, string>> = {};
  for (const kind of ROUTE_KINDS) {
    const val = map[kind];
    if (val === undefined) continue;
    out[ROUTE_SLUGS[kind]] = formatWideUint(val, `${path}.${ROUTE_SLUGS[kind]}`);
  }
  return Object.freeze(out);
}

function deserializeFlowMap(raw: unknown, path: string): Partial<Record<RouteKind, bigint>> {
  const obj = asRecord(raw, path);
  const out: Partial<Record<RouteKind, bigint>> = {};
  for (const [slug, val] of Object.entries(obj)) {
    const kind = tryRouteFromSlug(slug);
    if (kind === null) {
      failSnapshot(`${path}.${slug}`, `unknown route slug "${slug}"`);
    }
    out[kind] = parseWideUintString(val, `${path}.${slug}`);
  }
  return out;
}

function serializeSnapshotState(
  snapshot: RouterSnapshot,
  path: string,
): SerializedRouterSnapshotStateV1 {
  const rawPaused: unknown = snapshot.paused;
  const rawTokenRegistered: unknown = snapshot.tokenRegistered;
  const rawTokenEnabled: unknown = snapshot.tokenEnabled;
  if (typeof rawPaused !== "boolean") {
    failSnapshot(`${path}.paused`, "expected a boolean");
  }
  if (typeof rawTokenRegistered !== "boolean") {
    failSnapshot(`${path}.tokenRegistered`, "expected a boolean");
  }
  if (typeof rawTokenEnabled !== "boolean") {
    failSnapshot(`${path}.tokenEnabled`, "expected a boolean");
  }
  const feeBps = validateFeeBpsField(snapshot.feeBps, `${path}.feeBps`);
  const tokenDecimals = validateDecimalsField(snapshot.tokenDecimals, `${path}.tokenDecimals`);

  return {
    paused: rawPaused,
    feeBps,
    routeEnabled: serializeBoolRouteMap(snapshot.routeEnabled, `${path}.routeEnabled`),
    adapterSet: serializeBoolRouteMap(snapshot.adapterSet, `${path}.adapterSet`),
    tokenRegistered: rawTokenRegistered,
    tokenEnabled: rawTokenEnabled,
    tokenDecimals,
    flowAvailable: serializeFlowMap(snapshot.flowAvailable, `${path}.flowAvailable`),
    chainSupported: serializeBoolRouteMap(snapshot.chainSupported, `${path}.chainSupported`),
  };
}

function deserializeSnapshotState(raw: unknown, path: string): RouterSnapshot {
  const obj = asRecord(raw, path);
  if (typeof obj.paused !== "boolean") {
    failSnapshot(`${path}.paused`, "expected a boolean");
  }
  if (typeof obj.tokenRegistered !== "boolean") {
    failSnapshot(`${path}.tokenRegistered`, "expected a boolean");
  }
  if (typeof obj.tokenEnabled !== "boolean") {
    failSnapshot(`${path}.tokenEnabled`, "expected a boolean");
  }
  const feeBps = validateFeeBpsField(obj.feeBps, `${path}.feeBps`);
  const tokenDecimals = validateDecimalsField(obj.tokenDecimals, `${path}.tokenDecimals`);

  return {
    paused: obj.paused,
    feeBps,
    routeEnabled: deserializeBoolRouteMap(obj.routeEnabled, `${path}.routeEnabled`),
    adapterSet: deserializeBoolRouteMap(obj.adapterSet, `${path}.adapterSet`),
    tokenRegistered: obj.tokenRegistered,
    tokenEnabled: obj.tokenEnabled,
    tokenDecimals,
    flowAvailable: deserializeFlowMap(obj.flowAvailable, `${path}.flowAvailable`),
    chainSupported: deserializeBoolRouteMap(obj.chainSupported, `${path}.chainSupported`),
  };
}

function validateUnitsBlock(
  raw: unknown,
  expectedTokenDecimals: number,
  requireDestinationDecimals: boolean,
  path: string,
): SnapshotUnitMetadata {
  const obj = asRecord(raw, path);
  if (obj.amountEncoding !== "base_unit_uint_string") {
    failSnapshot(`${path}.amountEncoding`, 'expected "base_unit_uint_string"');
  }
  if (obj.feeUnit !== "bps") {
    failSnapshot(`${path}.feeUnit`, 'expected "bps"');
  }
  const tokenDecimals = validateDecimalsField(obj.tokenDecimals, `${path}.tokenDecimals`);
  if (tokenDecimals !== expectedTokenDecimals) {
    failSnapshot(
      `${path}.tokenDecimals`,
      `units.tokenDecimals (${String(tokenDecimals)}) disagrees with snapshot tokenDecimals (${String(expectedTokenDecimals)})`,
    );
  }
  if (requireDestinationDecimals || obj.destinationDecimals !== undefined) {
    const dstDecimals = validateDecimalsField(
      obj.destinationDecimals,
      `${path}.destinationDecimals`,
    );
    return {
      amountEncoding: "base_unit_uint_string",
      tokenDecimals,
      feeUnit: "bps",
      destinationDecimals: dstDecimals,
    };
  }
  return {
    amountEncoding: "base_unit_uint_string",
    tokenDecimals,
    feeUnit: "bps",
  };
}

/**
 * Serialize a `RouterSnapshot` into a JSON-safe v1 persistence record with explicit units,
 * capture timestamp, and non-live freshness provenance.
 */
export function serializeRouterSnapshot(
  snapshot: RouterSnapshot,
  context: SerializeSnapshotContext,
): SerializedRouterSnapshotV1 {
  const capturedAt = validateIsoTimestamp(context.capturedAt, "$.capturedAt");
  let originChain: ChainKey | null = null;
  if (context.originChain !== undefined) {
    if (!isChainKey(context.originChain)) {
      failSnapshot("$.originChain", "unknown ChainKey");
    }
    originChain = context.originChain;
  }
  let tokenSymbol: string | null = null;
  if (context.tokenSymbol !== undefined) {
    if (context.tokenSymbol.trim().length === 0) {
      failSnapshot("$.tokenSymbol", "expected non-empty tokenSymbol");
    }
    tokenSymbol = context.tokenSymbol;
  }

  const state = serializeSnapshotState(snapshot, "$.state");

  return {
    schemaVersion: SNAPSHOT_SERIALIZATION_VERSION,
    capturedAt,
    freshnessClass: PERSISTED_SNAPSHOT_FRESHNESS_CLASS,
    impliesLivePrice: false,
    originChain,
    tokenSymbol,
    units: {
      amountEncoding: "base_unit_uint_string",
      tokenDecimals: state.tokenDecimals,
      feeUnit: "bps",
    },
    state,
  };
}

/**
 * Deserialize and validate a persisted `SerializedRouterSnapshotV1` envelope.
 */
export function deserializeRouterSnapshot(value: unknown): DeserializedRouterSnapshot {
  const root = asRecord(value, "$");
  readSchemaVersion(root, "$");
  verifyNonLiveProvenance(root, "$");
  const capturedAt = validateIsoTimestamp(root.capturedAt, "$.capturedAt");

  let originChain: ChainKey | null = null;
  if (root.originChain !== undefined && root.originChain !== null) {
    if (typeof root.originChain !== "string" || !isChainKey(root.originChain)) {
      failSnapshot("$.originChain", "expected a valid ChainKey or null");
    }
    originChain = root.originChain;
  }

  let tokenSymbol: string | null = null;
  if (root.tokenSymbol !== undefined && root.tokenSymbol !== null) {
    if (typeof root.tokenSymbol !== "string" || root.tokenSymbol.trim().length === 0) {
      failSnapshot("$.tokenSymbol", "expected a non-empty string or null");
    }
    tokenSymbol = root.tokenSymbol;
  }

  const snapshot = deserializeSnapshotState(root.state, "$.state");
  const units = validateUnitsBlock(root.units, snapshot.tokenDecimals, false, "$.units");

  return {
    schemaVersion: SNAPSHOT_SERIALIZATION_VERSION,
    capturedAt,
    capturedAtMs: Date.parse(capturedAt),
    freshnessClass: PERSISTED_SNAPSHOT_FRESHNESS_CLASS,
    impliesLivePrice: false,
    requiresChainReconfirmation: true,
    originChain,
    tokenSymbol,
    units,
    snapshot,
  };
}

/** Serialize a `RouterSnapshot` together with evaluated `RouteQuote` records for persistence. */
export function serializePersistedQuoteBundle(input: {
  readonly capturedAt: string;
  readonly destinationDecimals: number;
  readonly snapshot: RouterSnapshot;
  readonly quotes: readonly RouteQuote[];
}): SerializedQuoteBundleV1 {
  const capturedAt = validateIsoTimestamp(input.capturedAt, "$.capturedAt");
  const destinationDecimals = validateDecimalsField(
    input.destinationDecimals,
    "$.destinationDecimals",
  );
  const state = serializeSnapshotState(input.snapshot, "$.snapshot");

  const serializedQuotes: SerializedRouteQuoteV1[] = input.quotes.map((q, index) => {
    const qPath = `$.quotes[${String(index)}]`;
    if (!ROUTE_KINDS.includes(q.route)) {
      failSnapshot(`${qPath}.route`, `unknown RouteKind ${String(q.route)}`);
    }
    if (!VALID_QUOTE_BLOCKERS.has(q.reason)) {
      failSnapshot(`${qPath}.reason`, `unknown QuoteBlocker ${String(q.reason)}`);
    }
    return {
      route: ROUTE_SLUGS[q.route],
      available: q.available,
      reason: q.reason,
      grossAmount: formatWideUint(q.grossAmount, `${qPath}.grossAmount`),
      fee: formatWideUint(q.fee, `${qPath}.fee`),
      netAmount: formatWideUint(q.netAmount, `${qPath}.netAmount`),
      destinationAmount: formatWideUint(q.destinationAmount, `${qPath}.destinationAmount`),
      flowAvailable: formatWideUint(q.flowAvailable, `${qPath}.flowAvailable`),
      waitsOnAttestation: q.waitsOnAttestation,
      isCanonical: q.isCanonical,
    };
  });

  return {
    schemaVersion: SNAPSHOT_SERIALIZATION_VERSION,
    capturedAt,
    freshnessClass: PERSISTED_SNAPSHOT_FRESHNESS_CLASS,
    impliesLivePrice: false,
    units: {
      amountEncoding: "base_unit_uint_string",
      tokenDecimals: state.tokenDecimals,
      feeUnit: "bps",
      destinationDecimals,
    },
    snapshot: state,
    quotes: Object.freeze(serializedQuotes),
  };
}

/** Deserialize and validate a `SerializedQuoteBundleV1` back into bigint `RouteQuote` records. */
export function deserializePersistedQuoteBundle(value: unknown): DeserializedQuoteBundle {
  const root = asRecord(value, "$");
  readSchemaVersion(root, "$");
  verifyNonLiveProvenance(root, "$");
  const capturedAt = validateIsoTimestamp(root.capturedAt, "$.capturedAt");
  const snapshot = deserializeSnapshotState(root.snapshot, "$.snapshot");
  const units = validateUnitsBlock(root.units, snapshot.tokenDecimals, true, "$.units");

  if (!Array.isArray(root.quotes)) {
    failSnapshot("$.quotes", "expected an array of serialized quotes");
  }

  const quotes: RouteQuote[] = root.quotes.map((rawQuote: unknown, index) => {
    const qPath = `$.quotes[${String(index)}]`;
    const qObj = asRecord(rawQuote, qPath);
    if (typeof qObj.route !== "string") {
      failSnapshot(`${qPath}.route`, "expected a canonical route slug");
    }
    const route = tryRouteFromSlug(qObj.route);
    if (route === null) {
      failSnapshot(`${qPath}.route`, `unknown route slug "${qObj.route}"`);
    }
    if (typeof qObj.available !== "boolean") {
      failSnapshot(`${qPath}.available`, "expected a boolean");
    }
    if (
      typeof qObj.reason !== "number" ||
      !Number.isInteger(qObj.reason) ||
      !VALID_QUOTE_BLOCKERS.has(qObj.reason)
    ) {
      failSnapshot(`${qPath}.reason`, "expected a valid QuoteBlocker integer tag");
    }
    if (
      typeof qObj.waitsOnAttestation !== "boolean" ||
      qObj.waitsOnAttestation !== waitsOnAttestation(route)
    ) {
      failSnapshot(`${qPath}.waitsOnAttestation`, "route waitsOnAttestation metadata mismatch");
    }
    if (typeof qObj.isCanonical !== "boolean" || qObj.isCanonical !== isCanonical(route)) {
      failSnapshot(`${qPath}.isCanonical`, "route isCanonical metadata mismatch");
    }

    return {
      route,
      available: qObj.available,
      reason: qObj.reason as QuoteBlocker,
      grossAmount: parseWideUintString(qObj.grossAmount, `${qPath}.grossAmount`),
      fee: parseWideUintString(qObj.fee, `${qPath}.fee`),
      netAmount: parseWideUintString(qObj.netAmount, `${qPath}.netAmount`),
      destinationAmount: parseWideUintString(qObj.destinationAmount, `${qPath}.destinationAmount`),
      flowAvailable: parseWideUintString(qObj.flowAvailable, `${qPath}.flowAvailable`),
      waitsOnAttestation: qObj.waitsOnAttestation,
      isCanonical: qObj.isCanonical,
    };
  });

  return {
    schemaVersion: SNAPSHOT_SERIALIZATION_VERSION,
    capturedAt,
    capturedAtMs: Date.parse(capturedAt),
    freshnessClass: PERSISTED_SNAPSHOT_FRESHNESS_CLASS,
    impliesLivePrice: false,
    requiresChainReconfirmation: true,
    units: {
      amountEncoding: "base_unit_uint_string",
      tokenDecimals: units.tokenDecimals,
      feeUnit: "bps",
      destinationDecimals: units.destinationDecimals ?? 0,
    },
    snapshot,
    quotes: Object.freeze(quotes),
  };
}

/** Stringify a `RouterSnapshot` directly to canonical JSON text. */
export function stringifyRouterSnapshot(
  snapshot: RouterSnapshot,
  context: SerializeSnapshotContext,
): string {
  return JSON.stringify(serializeRouterSnapshot(snapshot, context));
}

/** Parse and validate JSON text produced by `stringifyRouterSnapshot`. */
export function parseRouterSnapshotJson(json: string): DeserializedRouterSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    failSnapshot("$", error instanceof Error ? `invalid JSON (${error.message})` : "invalid JSON");
  }
  return deserializeRouterSnapshot(parsed);
}
