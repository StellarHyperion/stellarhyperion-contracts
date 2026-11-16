/**
 * Typed validation and conservative planning overlays for external route-health snapshots.
 *
 * Consumer services (indexers, status monitors, relayer health probes) frequently emit JSON health
 * records that mix historical event-driven configuration samples with live RPC observations and
 * third-party provider status endpoints. Validating measurement timestamps, scope, and tri-state /
 * unknown provider health before touching `RouterSnapshot` keeps event samples from masquerading as
 * live quotes and ensures unknown off-chain health degrades conservatively rather than optimistically.
 */
import type { ChainKey } from "./chains.js";
import { isChainKey } from "./chains.js";
import type { RouterSnapshot } from "./quotes.js";
import type { RouteKind } from "./routes.js";
import { ROUTE_KINDS, ROUTE_SLUGS, tryRouteFromSlug } from "./routes.js";

/** Schema version for serialized external route-health snapshots. */
export const ROUTE_HEALTH_SCHEMA_VERSION = 1;

/**
 * Measurement provenance of a route-health record:
 * - `live_quote`: fresh router + adapter read suitable for live local quote gating.
 * - `event_config_sample`: derived from historical contract logs (`RouteConfigured`, `PauseSet`);
 *   never proves current flow headroom or live provider reachability.
 * - `provider_status`: external rail status feed (Circle/Axelar/Allbridge) without on-chain state.
 */
export type RouteHealthScope = "live_quote" | "event_config_sample" | "provider_status";

export const ROUTE_HEALTH_SCOPES: readonly RouteHealthScope[] = Object.freeze([
  "live_quote",
  "event_config_sample",
  "provider_status",
]);

/** External rail / attestation health state, including explicit `unknown` when unconfirmed. */
export type ProviderHealthState = "healthy" | "degraded" | "unavailable" | "unknown";

export const PROVIDER_HEALTH_STATES: readonly ProviderHealthState[] = Object.freeze([
  "healthy",
  "degraded",
  "unavailable",
  "unknown",
]);

/** Reported router operational state for a rail at `measuredAt`. */
export type RouteOperationalState = "enabled" | "disabled" | "paused" | "unknown";

export const ROUTE_OPERATIONAL_STATES: readonly RouteOperationalState[] = Object.freeze([
  "enabled",
  "disabled",
  "paused",
  "unknown",
]);

/** Validated route-health observation for a single directional lane and rail. */
export interface RouteHealthRecord {
  readonly route: RouteKind;
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  /** Canonical ISO-8601 timestamp string as supplied and validated. */
  readonly measuredAt: string;
  /** Epoch milliseconds corresponding to `measuredAt`. */
  readonly measuredAtMs: number;
  readonly scope: RouteHealthScope;
  readonly routeState: RouteOperationalState;
  readonly providerHealth: ProviderHealthState;
  /** Validated base-unit flow headroom when reported by a `live_quote` probe, otherwise `null`. */
  readonly flowAvailable: bigint | null;
  /** True only when `scope === "live_quote"`, `routeState === "enabled"`, and provider is healthy/degraded. */
  readonly usableForLiveQuote: boolean;
}

/** Validated envelope holding one or more external route-health records. */
export interface RouteHealthSnapshot {
  readonly schemaVersion: number;
  readonly capturedAt: string;
  readonly capturedAtMs: number;
  readonly records: readonly RouteHealthRecord[];
}

/** Raised when an external health record or snapshot fails validation, naming the exact field path. */
export class RouteHealthFormatError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`route health invalid at ${path}: ${reason}`);
    this.name = "RouteHealthFormatError";
  }
}

function failHealth(path: string, reason: string): never {
  throw new RouteHealthFormatError(path, reason);
}

const ISO_8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function daysInUtcMonth(year: number, monthOneBased: number): number {
  return new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate();
}

function parseStrictTimestamp(value: unknown, path: string): { text: string; ms: number } {
  if (typeof value !== "string" || value.length === 0) {
    failHealth(path, "expected a non-empty ISO-8601 timestamp string");
  }
  const match = ISO_8601_PATTERN.exec(value);
  if (match === null) {
    failHealth(path, "expected an ISO-8601 timestamp with explicit UTC or timezone offset");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);

  if (month < 1 || month > 12) failHealth(path, `month ${String(month)} is out of range`);
  const maxDay = daysInUtcMonth(year, month);
  if (day < 1 || day > maxDay) failHealth(path, `day ${String(day)} is out of range for month`);
  if (hour > 23 || minute > 59 || second > 59) {
    failHealth(path, "time-of-day component is out of range");
  }
  if (offsetHour > 23 || offsetMinute > 59) {
    failHealth(path, "timezone offset is out of range");
  }

  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    failHealth(path, "timestamp could not be parsed");
  }
  return { text: value, ms };
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failHealth(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asChain(value: unknown, path: string): ChainKey {
  if (typeof value !== "string" || !isChainKey(value)) {
    failHealth(path, "expected a known ChainKey");
  }
  return value;
}

function asRoute(value: unknown, path: string): RouteKind {
  if (typeof value === "number") {
    if (ROUTE_KINDS.includes(value as RouteKind)) return value as RouteKind;
    failHealth(path, `unknown numeric RouteKind ${String(value)}`);
  }
  if (typeof value === "string") {
    const parsed = tryRouteFromSlug(value);
    if (parsed !== null) return parsed;
    failHealth(
      path,
      `unknown route slug "${value}", expected one of ${ROUTE_KINDS.map((k) => ROUTE_SLUGS[k]).join(", ")}`,
    );
  }
  failHealth(path, "expected a route slug string or RouteKind integer");
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    failHealth(path, `expected ${label} to be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function asOptionalUintBigInt(value: unknown, path: string): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    failHealth(path, "expected an unsigned decimal integer string or null");
  }
  if (!/^\d+$/.test(value)) {
    failHealth(path, "expected digits only in decimal integer string");
  }
  return BigInt(value);
}

/** Parse and validate a single consumer-supplied route-health record. */
export function parseRouteHealthRecord(value: unknown, basePath = "$"): RouteHealthRecord {
  const raw = asObject(value, basePath);
  const route = asRoute(raw.route, `${basePath}.route`);
  const originChain = asChain(raw.originChain, `${basePath}.originChain`);
  const destinationChain = asChain(raw.destinationChain, `${basePath}.destinationChain`);
  if (originChain === destinationChain) {
    failHealth(`${basePath}.destinationChain`, "destinationChain must differ from originChain");
  }

  const measured = parseStrictTimestamp(raw.measuredAt, `${basePath}.measuredAt`);
  const scope = asEnum(raw.scope, ROUTE_HEALTH_SCOPES, `${basePath}.scope`, "scope");
  const routeState = asEnum(
    raw.routeState,
    ROUTE_OPERATIONAL_STATES,
    `${basePath}.routeState`,
    "routeState",
  );
  const providerHealth = asEnum(
    raw.providerHealth,
    PROVIDER_HEALTH_STATES,
    `${basePath}.providerHealth`,
    "providerHealth",
  );
  const flowAvailable = asOptionalUintBigInt(raw.flowAvailable, `${basePath}.flowAvailable`);

  if (scope !== "live_quote" && flowAvailable !== null) {
    failHealth(
      `${basePath}.flowAvailable`,
      `scope "${scope}" cannot assert live flowAvailable; only "live_quote" records may carry live headroom`,
    );
  }

  const computedLiveUsable =
    scope === "live_quote" &&
    routeState === "enabled" &&
    (providerHealth === "healthy" || providerHealth === "degraded");

  if (raw.usableForLiveQuote !== undefined) {
    if (typeof raw.usableForLiveQuote !== "boolean") {
      failHealth(`${basePath}.usableForLiveQuote`, "expected a boolean when provided");
    }
    if (raw.usableForLiveQuote && !computedLiveUsable) {
      failHealth(
        `${basePath}.usableForLiveQuote`,
        `record with scope="${scope}", routeState="${routeState}", providerHealth="${providerHealth}" cannot masquerade as usableForLiveQuote`,
      );
    }
  }

  return {
    route,
    originChain,
    destinationChain,
    measuredAt: measured.text,
    measuredAtMs: measured.ms,
    scope,
    routeState,
    providerHealth,
    flowAvailable,
    usableForLiveQuote: raw.usableForLiveQuote === false ? false : computedLiveUsable,
  };
}

/** Parse and validate a versioned route-health snapshot envelope. */
export function parseRouteHealthSnapshot(value: unknown): RouteHealthSnapshot {
  const raw = asObject(value, "$");
  if (
    typeof raw.schemaVersion !== "number" ||
    !Number.isInteger(raw.schemaVersion) ||
    raw.schemaVersion < 1
  ) {
    failHealth("$.schemaVersion", "expected a positive integer schemaVersion");
  }
  if (raw.schemaVersion !== ROUTE_HEALTH_SCHEMA_VERSION) {
    failHealth(
      "$.schemaVersion",
      `expected ${String(ROUTE_HEALTH_SCHEMA_VERSION)}, found ${String(raw.schemaVersion)}`,
    );
  }

  const captured = parseStrictTimestamp(raw.capturedAt, "$.capturedAt");
  if (!Array.isArray(raw.records)) {
    failHealth("$.records", "expected an array of route health records");
  }

  const records = raw.records.map((entry, index) =>
    parseRouteHealthRecord(entry, `$.records[${String(index)}]`),
  );

  return {
    schemaVersion: raw.schemaVersion,
    capturedAt: captured.text,
    capturedAtMs: captured.ms,
    records,
  };
}

export interface LiveQuoteEligibilityOptions {
  /** Reference ISO-8601 timestamp or epoch ms used to check measurement freshness. */
  readonly referenceTime?: string | number;
  /** Maximum acceptable age in milliseconds when `referenceTime` is supplied. */
  readonly maxAgeMs?: number;
  /** Maximum clock-skew tolerance in milliseconds for records slightly ahead of `referenceTime`. */
  readonly maxFutureSkewMs?: number;
  /** Whether `"degraded"` provider health remains eligible for live quoting (defaults to `true`). */
  readonly allowDegradedProviderHealth?: boolean;
}

function resolveReferenceMs(referenceTime: string | number, path: string): number {
  if (typeof referenceTime === "number") {
    if (!Number.isFinite(referenceTime)) {
      failHealth(path, "expected a finite epoch millisecond number");
    }
    return referenceTime;
  }
  return parseStrictTimestamp(referenceTime, path).ms;
}

/**
 * Check whether a validated record is eligible to back a live local quote.
 *
 * Event-driven configuration samples (`event_config_sample`), provider-only status pings, disabled
 * or paused routes, and `"unknown"` or `"unavailable"` provider states always return `false`.
 */
export function isUsableForLiveQuote(
  record: RouteHealthRecord,
  options?: LiveQuoteEligibilityOptions,
): boolean {
  if (!record.usableForLiveQuote) return false;
  if (record.scope !== "live_quote") return false;
  if (record.routeState !== "enabled") return false;
  if (record.providerHealth === "unavailable" || record.providerHealth === "unknown") {
    return false;
  }
  if (options?.allowDegradedProviderHealth === false && record.providerHealth === "degraded") {
    return false;
  }
  if (options?.referenceTime !== undefined && options.maxAgeMs !== undefined) {
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
      failHealth("options.maxAgeMs", "expected a non-negative finite millisecond budget");
    }
    const refMs = resolveReferenceMs(options.referenceTime, "options.referenceTime");
    const maxSkew = options.maxFutureSkewMs ?? 5_000;
    const ageMs = refMs - record.measuredAtMs;
    if (ageMs > options.maxAgeMs || ageMs < -maxSkew) {
      return false;
    }
  }
  return true;
}

export type ConservativeHealthReason =
  | "eligible_live"
  | "non_live_scope"
  | "route_paused"
  | "route_disabled"
  | "route_state_unknown"
  | "provider_unavailable"
  | "provider_health_unknown"
  | "provider_degraded_disallowed"
  | "stale_measurement";

export interface RouteHealthPlanningDecision {
  readonly route: RouteKind;
  readonly allowed: boolean;
  readonly reason: ConservativeHealthReason;
  readonly record: RouteHealthRecord;
}

export interface ApplyRouteHealthOptions extends LiveQuoteEligibilityOptions {
  /** Optional origin filter so records for other lanes are ignored cleanly. */
  readonly originChain?: ChainKey;
  /** Optional destination filter so records for other lanes are ignored cleanly. */
  readonly destinationChain?: ChainKey;
}

export interface ConservativeHealthOverlayResult {
  readonly snapshot: RouterSnapshot;
  readonly decisions: Readonly<Partial<Record<RouteKind, RouteHealthPlanningDecision>>>;
}

function classifyDecisionReason(
  record: RouteHealthRecord,
  options?: ApplyRouteHealthOptions,
): ConservativeHealthReason {
  if (record.scope !== "live_quote") return "non_live_scope";
  if (record.routeState === "paused") return "route_paused";
  if (record.routeState === "disabled") return "route_disabled";
  if (record.routeState === "unknown") return "route_state_unknown";
  if (record.providerHealth === "unavailable") return "provider_unavailable";
  if (record.providerHealth === "unknown") return "provider_health_unknown";
  if (options?.allowDegradedProviderHealth === false && record.providerHealth === "degraded") {
    return "provider_degraded_disallowed";
  }
  if (!isUsableForLiveQuote(record, options)) return "stale_measurement";
  return "eligible_live";
}

/**
 * Overlay validated route-health records onto a `RouterSnapshot` conservatively without mutating
 * the input snapshot.
 *
 * - Records with `"unknown"` or `"unavailable"` provider health, `"unknown"`/`"disabled"`/`"paused"`
 *   route state, stale timestamps, or non-live scopes (`event_config_sample`, `provider_status`)
 *   conservatively disable that route in the returned snapshot rather than assuming healthy live
 *   capacity.
 * - When multiple records match the same rail, the newest `measuredAtMs` record governs.
 * - When an eligible `live_quote` record carries `flowAvailable`, the returned headroom is capped
 *   to `min(snapshot.flowAvailable[route], record.flowAvailable)` and never inflates router limits.
 */
export function applyRouteHealthToSnapshot(
  routerSnapshot: RouterSnapshot,
  health: RouteHealthSnapshot | readonly RouteHealthRecord[],
  options?: ApplyRouteHealthOptions,
): ConservativeHealthOverlayResult {
  const records = "records" in health ? health.records : health;

  const latestByRoute = new Map<RouteKind, RouteHealthRecord>();
  for (const record of records) {
    if (options?.originChain !== undefined && record.originChain !== options.originChain) continue;
    if (
      options?.destinationChain !== undefined &&
      record.destinationChain !== options.destinationChain
    ) {
      continue;
    }
    const existing = latestByRoute.get(record.route);
    if (existing === undefined || record.measuredAtMs >= existing.measuredAtMs) {
      latestByRoute.set(record.route, record);
    }
  }

  const nextRouteEnabled: Partial<Record<RouteKind, boolean>> = { ...routerSnapshot.routeEnabled };
  const nextFlowAvailable: Partial<Record<RouteKind, bigint>> = { ...routerSnapshot.flowAvailable };
  const decisions: Partial<Record<RouteKind, RouteHealthPlanningDecision>> = {};
  let routerPaused = routerSnapshot.paused;

  for (const [route, record] of latestByRoute.entries()) {
    const reason = classifyDecisionReason(record, options);
    const allowed = reason === "eligible_live" && routerSnapshot.routeEnabled[route] === true;
    decisions[route] = { route, allowed, reason, record };

    if (record.routeState === "paused" && record.scope !== "provider_status") {
      routerPaused = true;
    }

    if (!allowed) {
      nextRouteEnabled[route] = false;
      continue;
    }

    if (record.flowAvailable !== null) {
      const current = nextFlowAvailable[route];
      nextFlowAvailable[route] =
        current === undefined
          ? record.flowAvailable
          : record.flowAvailable < current
            ? record.flowAvailable
            : current;
    }
  }

  return {
    snapshot: {
      ...routerSnapshot,
      paused: routerPaused,
      routeEnabled: nextRouteEnabled,
      flowAvailable: nextFlowAvailable,
    },
    decisions,
  };
}
