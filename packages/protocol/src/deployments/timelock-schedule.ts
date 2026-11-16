/**
 * Unsigned, read-only operator timelock scheduling and activation sequence reports.
 *
 * Both the Soroban router (`soroban/crates/hyperion-router/src/timelock.rs`) and the Solidity
 * router (`evm/src/HyperionRouter.sol`) enforce the same chain-time window rules:
 *
 * - `eta = queuedAt + timelockDelay` (`3_600` to `2_592_000` seconds)
 * - `expiresAt = eta + GRACE_PERIOD` (`604_800` seconds)
 * - `chainTimestamp < eta` -> `TimelockNotReady` (`waiting`)
 * - `eta <= chainTimestamp && chainTimestamp <= expiresAt` -> matured (`runnable` when unblocked)
 * - `chainTimestamp > expiresAt` -> `TimelockExpired` (`expired`, excluded from runnable steps)
 *
 * Nothing in this module reads local wall-clock time (`Date.now()`), mutates caller inputs, or
 * coerces exact token ceilings through floating-point numbers. Repeated calls over the same
 * chain-time snapshot produce identical output.
 */
import { isStellarAddress } from "../addresses.js";
import { MAX_DECIMALS, MAX_FEE_BPS } from "../amounts.js";
import type { ChainFamily, ChainKey } from "../chains.js";
import { CHAINS, isChainKey } from "../chains.js";
import { isRouteKind, ROUTE_SLUGS, RouteKind, tryRouteFromSlug } from "../routes.js";

export const TIMELOCK_MIN_DELAY_SECONDS = 3_600;
export const TIMELOCK_MAX_DELAY_SECONDS = 2_592_000;
export const TIMELOCK_GRACE_PERIOD_SECONDS = 604_800;

export type TimelockWindowState = "waiting" | "runnable" | "expired" | "cancelled" | "executed";

export type ActivationPhaseSlug =
  | "upgrade"
  | "token-registration"
  | "token-limit"
  | "route-adapter"
  | "route-wiring"
  | "route-enablement"
  | "router-policy"
  | "admin-handover";

export interface ScheduledUpgradeAction {
  readonly kind: "Upgrade";
  readonly target: string;
}

export interface ScheduledRegisterTokenAction {
  readonly kind: "RegisterToken";
  readonly token: string;
  readonly decimals: number;
  /** Exact non-negative integer in the token's own base units, preserved as a decimal string. */
  readonly flowLimit: string;
}

export interface ScheduledRaiseTokenFlowLimitAction {
  readonly kind: "RaiseTokenFlowLimit";
  readonly token: string;
  /** Exact non-negative integer in the token's own base units, preserved as a decimal string. */
  readonly flowLimit: string;
}

export interface ScheduledSetTokenEnabledAction {
  readonly kind: "SetTokenEnabled";
  readonly token: string;
  readonly enabled: boolean;
}

export interface ScheduledSetAdapterAction {
  readonly kind: "SetAdapter";
  readonly route: RouteKind;
  readonly adapter: string;
}

export interface ScheduledSetRailReceiverAction {
  readonly kind: "SetRailReceiver";
  readonly route: RouteKind;
  readonly receiver: string;
}

export interface ScheduledSetRouteFlowLimitAction {
  readonly kind: "SetRouteFlowLimit";
  readonly token: string;
  readonly route: RouteKind;
  /** Exact non-negative integer in the token's own base units, preserved as a decimal string. */
  readonly flowLimit: string;
}

export interface ScheduledSetRouteConfigAction {
  readonly kind: "SetRouteConfig";
  readonly route: RouteKind;
  /** Exact non-negative integer in base units, preserved as a decimal string. */
  readonly maxSingleTransfer: string;
}

export interface ScheduledSetRouteMaxSingleTransferAction {
  readonly kind: "SetRouteMaxSingleTransfer";
  readonly route: RouteKind;
  /** Exact non-negative integer in base units, preserved as a decimal string. */
  readonly maxSingleTransfer: string;
}

export interface ScheduledEnableRouteAction {
  readonly kind: "EnableRoute";
  readonly route: RouteKind;
  readonly enabled: boolean;
}

export interface ScheduledSetFeeBpsAction {
  readonly kind: "SetFeeBps";
  readonly feeBps: number;
}

export interface ScheduledSetFlowWindowAction {
  readonly kind: "SetFlowWindow";
  readonly flowWindow: number;
}

export interface ScheduledSetTimelockDelayAction {
  readonly kind: "SetTimelockDelay";
  readonly timelockDelaySeconds: number;
}

export interface ScheduledSetTreasuryAction {
  readonly kind: "SetTreasury";
  readonly treasury: string;
}

export interface ScheduledSetGuardianAction {
  readonly kind: "SetGuardian";
  readonly guardian: string;
}

export interface ScheduledSetAdminAction {
  readonly kind: "SetAdmin";
  readonly admin: string;
}

export type ScheduledAdminAction =
  | ScheduledUpgradeAction
  | ScheduledRegisterTokenAction
  | ScheduledRaiseTokenFlowLimitAction
  | ScheduledSetTokenEnabledAction
  | ScheduledSetAdapterAction
  | ScheduledSetRailReceiverAction
  | ScheduledSetRouteFlowLimitAction
  | ScheduledSetRouteConfigAction
  | ScheduledSetRouteMaxSingleTransferAction
  | ScheduledEnableRouteAction
  | ScheduledSetFeeBpsAction
  | ScheduledSetFlowWindowAction
  | ScheduledSetTimelockDelayAction
  | ScheduledSetTreasuryAction
  | ScheduledSetGuardianAction
  | ScheduledSetAdminAction;

export interface TimelockQueuedEntryInput {
  readonly id: number;
  readonly action: ScheduledAdminAction;
  readonly queuedAtSeconds: number;
  readonly etaSeconds?: number | undefined;
  readonly expiresAtSeconds?: number | undefined;
  readonly cancelled?: boolean | undefined;
  readonly executed?: boolean | undefined;
}

export interface TimelockScheduleInput {
  readonly chain: ChainKey;
  readonly router: string;
  /** Actual ledger close timestamp (Soroban) or block timestamp (EVM) in UTC epoch seconds. */
  readonly chainTimestampSeconds: number;
  readonly timelockDelaySeconds?: number | undefined;
  readonly gracePeriodSeconds?: number | undefined;
  readonly entries: readonly TimelockQueuedEntryInput[];
}

export interface TimelockActionWindow {
  readonly id: number;
  readonly action: ScheduledAdminAction;
  readonly summary: string;
  readonly sequencePhase: number;
  readonly phaseSlug: ActivationPhaseSlug;
  readonly windowState: TimelockWindowState;
  readonly queuedAtSeconds: number;
  readonly earliestExecutionSeconds: number;
  readonly expiresAtSeconds: number;
  readonly secondsUntilEarliestExecution: number;
  readonly secondsUntilExpiry: number;
  readonly prerequisiteIds: readonly number[];
  readonly blockingPrerequisiteIds: readonly number[];
  readonly requeueRequired: boolean;
  readonly gatedScopeNote: string | null;
}

export interface TimelockSequenceStep {
  readonly stepNumber: number;
  readonly id: number;
  readonly action: ScheduledAdminAction;
  readonly summary: string;
  readonly sequencePhase: number;
  readonly phaseSlug: ActivationPhaseSlug;
  readonly windowState: "waiting" | "runnable";
  readonly earliestExecutionSeconds: number;
  readonly expiresAtSeconds: number;
  readonly secondsUntilEarliestExecution: number;
  readonly secondsUntilExpiry: number;
  readonly prerequisiteIds: readonly number[];
  readonly blockingPrerequisiteIds: readonly number[];
  readonly runnableNow: boolean;
  readonly requeueRequired: boolean;
  readonly gatedScopeNote: string | null;
}

export interface TimelockExcludedOperation {
  readonly id: number;
  readonly action: ScheduledAdminAction;
  readonly summary: string;
  readonly reason: "expired" | "cancelled" | "executed";
  readonly earliestExecutionSeconds: number;
  readonly expiresAtSeconds: number;
  readonly requeueRequired: boolean;
}

export interface TimelockScheduleCounts {
  readonly total: number;
  readonly runnable: number;
  readonly waiting: number;
  readonly blocked: number;
  readonly expired: number;
  readonly cancelled: number;
  readonly executed: number;
}

export interface TimelockScheduleReport {
  readonly chain: ChainKey;
  readonly family: ChainFamily;
  readonly router: string;
  readonly chainTimestampSeconds: number;
  readonly timelockDelaySeconds: number;
  readonly gracePeriodSeconds: number;
  readonly scopeNotice: string | null;
  readonly counts: TimelockScheduleCounts;
  readonly earliestPendingExecutionSeconds: number | null;
  readonly allPendingExecutableAtSeconds: number | null;
  readonly nextExpirySeconds: number | null;
  readonly actionWindows: readonly TimelockActionWindow[];
  readonly requiredSequence: readonly TimelockSequenceStep[];
  readonly runnableOperations: readonly TimelockSequenceStep[];
  readonly excludedOperations: readonly TimelockExcludedOperation[];
}

export class TimelockScheduleFormatError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`timelock schedule invalid at ${path}: ${reason}`);
    this.name = "TimelockScheduleFormatError";
  }
}

function scheduleFail(path: string, reason: string): never {
  throw new TimelockScheduleFormatError(path, reason);
}

function asObjectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    scheduleFail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    scheduleFail(path, "expected a non-empty string");
  }
  return value;
}

function asSafeInt(value: unknown, path: string, min = 0): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < min) {
      scheduleFail(path, `expected an integer of at least ${String(min)}`);
    }
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min) {
      scheduleFail(path, `expected an integer of at least ${String(min)}`);
    }
    return parsed;
  }
  scheduleFail(path, `expected an integer of at least ${String(min)}`);
}

function asExactUintString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    scheduleFail(
      path,
      "expected an exact decimal integer string so large token limits do not lose precision",
    );
  }
  if (!/^\d+$/.test(value)) {
    scheduleFail(path, "expected a non-negative decimal integer string");
  }
  return value;
}

function asBooleanFlag(value: unknown, path: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    scheduleFail(path, "expected a boolean");
  }
  return value;
}

function asRoute(value: unknown, path: string): RouteKind {
  if (typeof value === "number" && isRouteKind(value)) {
    return value;
  }
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value);
      if (isRouteKind(numeric)) return numeric;
    }
    const fromSlug = tryRouteFromSlug(value);
    if (fromSlug !== null) return fromSlug;
  }
  scheduleFail(path, "expected a valid Hyperion route tag or slug");
}

function validateChainAddress(
  value: unknown,
  family: ChainFamily,
  role: "contract" | "account" | "upgrade",
  path: string,
): string {
  const text = asNonEmptyString(value, path);
  if (family === "stellar") {
    if (role === "upgrade") {
      if (!/^[0-9a-f]{64}$/.test(text)) {
        scheduleFail(path, "expected a 64 lowercase hex WASM hash");
      }
      return text;
    }
    if (role === "contract") {
      if (!text.startsWith("C") || !isStellarAddress(text)) {
        scheduleFail(path, "expected a Stellar contract id starting with C");
      }
      return text;
    }
    if (!isStellarAddress(text)) {
      scheduleFail(path, "expected a valid Stellar address");
    }
    return text;
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
    scheduleFail(path, "expected a 20-byte EVM hex address");
  }
  return text;
}

function parseChainKeyAlias(value: unknown, path: string): ChainKey {
  const text = asNonEmptyString(value, path);
  if (text === "testnet") return "stellar-testnet";
  if (text === "mainnet" || text === "public") return "stellar";
  if (!isChainKey(text)) {
    scheduleFail(path, `unknown chain key "${text}"`);
  }
  return text;
}

/**
 * Parse a queued router action from structured JSON, Soroban CLI tuple arrays, or single-key
 * Soroban CLI action objects.
 */
export function parseQueuedAdminAction(
  raw: unknown,
  family: ChainFamily,
  path = "$.action",
): ScheduledAdminAction {
  if (Array.isArray(raw)) {
    const tuple = raw as readonly unknown[];
    if (tuple.length === 0) scheduleFail(path, "expected a non-empty action tuple");
    const kind = asNonEmptyString(tuple[0], `${path}[0]`);
    return parseVariantPayload(kind, tuple.slice(1), family, path, true);
  }

  const record = asObjectRecord(raw, path);
  if (typeof record.kind === "string") {
    return parseStructuredAction(record, family, path);
  }

  const keys = Object.keys(record);
  if (keys.length === 1) {
    const variant = keys[0];
    if (variant !== undefined) {
      return parseVariantPayload(variant, record[variant], family, `${path}.${variant}`, false);
    }
  }

  scheduleFail(path, "unrecognized queued admin action shape");
}

function parseStructuredAction(
  record: Record<string, unknown>,
  family: ChainFamily,
  path: string,
): ScheduledAdminAction {
  const kind = asNonEmptyString(record.kind, `${path}.kind`);
  switch (kind) {
    case "Upgrade":
      return {
        kind: "Upgrade",
        target: validateChainAddress(record.target, family, "upgrade", `${path}.target`),
      };
    case "RegisterToken": {
      const decimals = asSafeInt(record.decimals, `${path}.decimals`, 0);
      if (decimals > MAX_DECIMALS) {
        scheduleFail(`${path}.decimals`, `decimals cannot exceed ${String(MAX_DECIMALS)}`);
      }
      return {
        kind: "RegisterToken",
        token: validateChainAddress(record.token, family, "contract", `${path}.token`),
        decimals,
        flowLimit: asExactUintString(record.flowLimit, `${path}.flowLimit`),
      };
    }
    case "RaiseTokenFlowLimit":
      return {
        kind: "RaiseTokenFlowLimit",
        token: validateChainAddress(record.token, family, "contract", `${path}.token`),
        flowLimit: asExactUintString(record.flowLimit, `${path}.flowLimit`),
      };
    case "SetTokenEnabled":
      return {
        kind: "SetTokenEnabled",
        token: validateChainAddress(record.token, family, "contract", `${path}.token`),
        enabled: asBooleanFlag(record.enabled, `${path}.enabled`),
      };
    case "SetAdapter":
      return {
        kind: "SetAdapter",
        route: asRoute(record.route, `${path}.route`),
        adapter: validateChainAddress(record.adapter, family, "contract", `${path}.adapter`),
      };
    case "SetRailReceiver":
      return {
        kind: "SetRailReceiver",
        route: asRoute(record.route, `${path}.route`),
        receiver: validateChainAddress(record.receiver, family, "contract", `${path}.receiver`),
      };
    case "SetRouteFlowLimit":
      return {
        kind: "SetRouteFlowLimit",
        token: validateChainAddress(record.token, family, "contract", `${path}.token`),
        route: asRoute(record.route, `${path}.route`),
        flowLimit: asExactUintString(record.flowLimit, `${path}.flowLimit`),
      };
    case "SetRouteConfig":
      return {
        kind: "SetRouteConfig",
        route: asRoute(record.route, `${path}.route`),
        maxSingleTransfer: asExactUintString(record.maxSingleTransfer, `${path}.maxSingleTransfer`),
      };
    case "SetRouteMaxSingleTransfer":
      return {
        kind: "SetRouteMaxSingleTransfer",
        route: asRoute(record.route, `${path}.route`),
        maxSingleTransfer: asExactUintString(record.maxSingleTransfer, `${path}.maxSingleTransfer`),
      };
    case "EnableRoute":
      return {
        kind: "EnableRoute",
        route: asRoute(record.route, `${path}.route`),
        enabled: asBooleanFlag(record.enabled, `${path}.enabled`, true),
      };
    case "SetFeeBps": {
      const feeBps = asSafeInt(record.feeBps, `${path}.feeBps`, 0);
      if (feeBps > MAX_FEE_BPS) {
        scheduleFail(`${path}.feeBps`, `feeBps cannot exceed ${String(MAX_FEE_BPS)}`);
      }
      return { kind: "SetFeeBps", feeBps };
    }
    case "SetFlowWindow":
      return {
        kind: "SetFlowWindow",
        flowWindow: asSafeInt(record.flowWindow, `${path}.flowWindow`, 1),
      };
    case "SetTimelockDelay": {
      const delay = asSafeInt(
        record.timelockDelaySeconds,
        `${path}.timelockDelaySeconds`,
        TIMELOCK_MIN_DELAY_SECONDS,
      );
      if (delay > TIMELOCK_MAX_DELAY_SECONDS) {
        scheduleFail(
          `${path}.timelockDelaySeconds`,
          `timelockDelaySeconds cannot exceed ${String(TIMELOCK_MAX_DELAY_SECONDS)}`,
        );
      }
      return { kind: "SetTimelockDelay", timelockDelaySeconds: delay };
    }
    case "SetTreasury":
      return {
        kind: "SetTreasury",
        treasury: validateChainAddress(record.treasury, family, "account", `${path}.treasury`),
      };
    case "SetGuardian":
      return {
        kind: "SetGuardian",
        guardian: validateChainAddress(record.guardian, family, "account", `${path}.guardian`),
      };
    case "SetAdmin":
      return {
        kind: "SetAdmin",
        admin: validateChainAddress(record.admin, family, "account", `${path}.admin`),
      };
    default:
      scheduleFail(`${path}.kind`, `unknown admin action kind "${kind}"`);
  }
}

function asTupleArgs(payload: unknown, expectedLength: number, path: string): readonly unknown[] {
  if (!Array.isArray(payload)) {
    if (expectedLength === 1) return [payload];
    scheduleFail(path, `expected an array of ${String(expectedLength)} arguments`);
  }
  const items = payload as readonly unknown[];
  if (items.length !== expectedLength) {
    scheduleFail(
      path,
      `expected ${String(expectedLength)} arguments, found ${String(items.length)}`,
    );
  }
  return items;
}

function parseVariantPayload(
  kind: string,
  payload: unknown,
  family: ChainFamily,
  path: string,
  fromFlatTuple: boolean,
): ScheduledAdminAction {
  switch (kind) {
    case "Upgrade": {
      const args = fromFlatTuple ? asTupleArgs(payload, 1, path) : asTupleArgs(payload, 1, path);
      return {
        kind: "Upgrade",
        target: validateChainAddress(args[0], family, "upgrade", `${path}[0]`),
      };
    }
    case "RegisterToken": {
      const args = asTupleArgs(payload, 3, path);
      const decimals = asSafeInt(args[1], `${path}[1]`, 0);
      if (decimals > MAX_DECIMALS) {
        scheduleFail(`${path}[1]`, `decimals cannot exceed ${String(MAX_DECIMALS)}`);
      }
      return {
        kind: "RegisterToken",
        token: validateChainAddress(args[0], family, "contract", `${path}[0]`),
        decimals,
        flowLimit: asExactUintString(args[2], `${path}[2]`),
      };
    }
    case "RaiseTokenFlowLimit": {
      const args = asTupleArgs(payload, 2, path);
      return {
        kind: "RaiseTokenFlowLimit",
        token: validateChainAddress(args[0], family, "contract", `${path}[0]`),
        flowLimit: asExactUintString(args[1], `${path}[1]`),
      };
    }
    case "SetTokenEnabled": {
      const args = asTupleArgs(payload, 2, path);
      return {
        kind: "SetTokenEnabled",
        token: validateChainAddress(args[0], family, "contract", `${path}[0]`),
        enabled: asBooleanFlag(args[1], `${path}[1]`),
      };
    }
    case "SetAdapter": {
      const args = asTupleArgs(payload, 2, path);
      return {
        kind: "SetAdapter",
        route: asRoute(args[0], `${path}[0]`),
        adapter: validateChainAddress(args[1], family, "contract", `${path}[1]`),
      };
    }
    case "SetRailReceiver": {
      const args = asTupleArgs(payload, 2, path);
      return {
        kind: "SetRailReceiver",
        route: asRoute(args[0], `${path}[0]`),
        receiver: validateChainAddress(args[1], family, "contract", `${path}[1]`),
      };
    }
    case "SetRouteFlowLimit": {
      const args = asTupleArgs(payload, 3, path);
      return {
        kind: "SetRouteFlowLimit",
        token: validateChainAddress(args[0], family, "contract", `${path}[0]`),
        route: asRoute(args[1], `${path}[1]`),
        flowLimit: asExactUintString(args[2], `${path}[2]`),
      };
    }
    case "SetRouteConfig": {
      const args = asTupleArgs(payload, 2, path);
      const cfg = asObjectRecord(args[1], `${path}[1]`);
      const rawLimit = cfg.maxSingleTransfer ?? cfg.max_single_transfer;
      return {
        kind: "SetRouteConfig",
        route: asRoute(args[0], `${path}[0]`),
        maxSingleTransfer: asExactUintString(rawLimit, `${path}[1].maxSingleTransfer`),
      };
    }
    case "SetRouteMaxSingleTransfer": {
      const args = asTupleArgs(payload, 2, path);
      return {
        kind: "SetRouteMaxSingleTransfer",
        route: asRoute(args[0], `${path}[0]`),
        maxSingleTransfer: asExactUintString(args[1], `${path}[1]`),
      };
    }
    case "EnableRoute": {
      if (Array.isArray(payload)) {
        const items = payload as readonly unknown[];
        if (items.length === 1) {
          return {
            kind: "EnableRoute",
            route: asRoute(items[0], `${path}[0]`),
            enabled: true,
          };
        }
        if (items.length === 2) {
          return {
            kind: "EnableRoute",
            route: asRoute(items[0], `${path}[0]`),
            enabled: asBooleanFlag(items[1], `${path}[1]`, true),
          };
        }
        scheduleFail(path, "expected 1 or 2 arguments for EnableRoute");
      }
      return {
        kind: "EnableRoute",
        route: asRoute(payload, path),
        enabled: true,
      };
    }
    case "SetFeeBps": {
      const args = asTupleArgs(payload, 1, path);
      const feeBps = asSafeInt(args[0], `${path}[0]`, 0);
      if (feeBps > MAX_FEE_BPS) {
        scheduleFail(`${path}[0]`, `feeBps cannot exceed ${String(MAX_FEE_BPS)}`);
      }
      return { kind: "SetFeeBps", feeBps };
    }
    case "SetFlowWindow": {
      const args = asTupleArgs(payload, 1, path);
      return {
        kind: "SetFlowWindow",
        flowWindow: asSafeInt(args[0], `${path}[0]`, 1),
      };
    }
    case "SetTimelockDelay": {
      const args = asTupleArgs(payload, 1, path);
      const delay = asSafeInt(args[0], `${path}[0]`, TIMELOCK_MIN_DELAY_SECONDS);
      if (delay > TIMELOCK_MAX_DELAY_SECONDS) {
        scheduleFail(
          `${path}[0]`,
          `timelockDelaySeconds cannot exceed ${String(TIMELOCK_MAX_DELAY_SECONDS)}`,
        );
      }
      return { kind: "SetTimelockDelay", timelockDelaySeconds: delay };
    }
    case "SetTreasury": {
      const args = asTupleArgs(payload, 1, path);
      return {
        kind: "SetTreasury",
        treasury: validateChainAddress(args[0], family, "account", `${path}[0]`),
      };
    }
    case "SetGuardian": {
      const args = asTupleArgs(payload, 1, path);
      return {
        kind: "SetGuardian",
        guardian: validateChainAddress(args[0], family, "account", `${path}[0]`),
      };
    }
    case "SetAdmin": {
      const args = asTupleArgs(payload, 1, path);
      return {
        kind: "SetAdmin",
        admin: validateChainAddress(args[0], family, "account", `${path}[0]`),
      };
    }
    default:
      scheduleFail(path, `unknown admin action kind "${kind}"`);
  }
}

/**
 * Parse a full timelock schedule snapshot or activation evidence object into a validated
 * `TimelockScheduleInput`. Requires an explicit chain timestamp rather than reading wall-clock time.
 */
export function parseTimelockScheduleInput(
  raw: unknown,
  overrideChainTimestampSeconds?: number,
): TimelockScheduleInput {
  const root = asObjectRecord(raw, "$");
  const chainRaw = root.chain ?? root.network;
  const chainKey = parseChainKeyAlias(chainRaw, "$.chain");
  const family = CHAINS[chainKey].family;

  const contractsObj =
    typeof root.contracts === "object" && root.contracts !== null && !Array.isArray(root.contracts)
      ? (root.contracts as Record<string, unknown>)
      : null;
  const routerRaw = root.router ?? contractsObj?.router;
  const router = validateChainAddress(routerRaw, family, "contract", "$.router");

  const chainTimestampSeconds =
    overrideChainTimestampSeconds !== undefined
      ? asSafeInt(overrideChainTimestampSeconds, "$.chainTimestampSeconds", 0)
      : asSafeInt(
          root.chainTimestampSeconds ?? root.ledgerTimestamp ?? root.blockTimestamp,
          "$.chainTimestampSeconds",
          0,
        );

  const rawDelay = root.timelockDelaySeconds ?? root.timelockDelay ?? root.timelock_delay;
  const timelockDelaySeconds =
    rawDelay !== undefined
      ? asSafeInt(rawDelay, "$.timelockDelaySeconds", TIMELOCK_MIN_DELAY_SECONDS)
      : undefined;
  if (timelockDelaySeconds !== undefined && timelockDelaySeconds > TIMELOCK_MAX_DELAY_SECONDS) {
    scheduleFail(
      "$.timelockDelaySeconds",
      `cannot exceed ${String(TIMELOCK_MAX_DELAY_SECONDS)} seconds`,
    );
  }

  const rawGrace = root.gracePeriodSeconds ?? root.grace_period;
  const gracePeriodSeconds =
    rawGrace !== undefined ? asSafeInt(rawGrace, "$.gracePeriodSeconds", 1) : undefined;

  const rawList = root.entries ?? root.queuedActions;
  if (!Array.isArray(rawList)) {
    scheduleFail("$.entries", "expected an array of queued timelock entries");
  }
  const items = rawList as readonly unknown[];

  const combinedRawEntries: { readonly rawEntry: unknown; readonly entryPath: string }[] =
    items.map((item, idx) => ({
      rawEntry: item,
      entryPath: `$.entries[${String(idx)}]`,
    }));

  if (root.routerUpgrade !== undefined && root.routerUpgrade !== null) {
    combinedRawEntries.push({
      rawEntry: root.routerUpgrade,
      entryPath: "$.routerUpgrade",
    });
  }

  const entries: TimelockQueuedEntryInput[] = combinedRawEntries.map(({ rawEntry, entryPath }) => {
    const entry = asObjectRecord(rawEntry, entryPath);
    const id = asSafeInt(entry.id, `${entryPath}.id`, 1);
    const queuedAtSeconds = asSafeInt(
      entry.queuedAtSeconds ?? entry.queued_at ?? entry.queuedAt,
      `${entryPath}.queuedAtSeconds`,
      0,
    );
    const rawEta = entry.etaSeconds ?? entry.eta;
    const etaSeconds =
      rawEta !== undefined ? asSafeInt(rawEta, `${entryPath}.etaSeconds`, 0) : undefined;
    const rawExpires = entry.expiresAtSeconds ?? entry.expires_at ?? entry.expiresAt;
    const expiresAtSeconds =
      rawExpires !== undefined
        ? asSafeInt(rawExpires, `${entryPath}.expiresAtSeconds`, 0)
        : undefined;

    return {
      id,
      action: parseQueuedAdminAction(entry.action, family, `${entryPath}.action`),
      queuedAtSeconds,
      etaSeconds,
      expiresAtSeconds,
      cancelled: asBooleanFlag(entry.cancelled, `${entryPath}.cancelled`, false),
      executed: asBooleanFlag(entry.executed, `${entryPath}.executed`, false),
    };
  });

  return {
    chain: chainKey,
    router,
    chainTimestampSeconds,
    timelockDelaySeconds,
    gracePeriodSeconds,
    entries,
  };
}

function phaseForAction(action: ScheduledAdminAction): {
  readonly phase: number;
  readonly slug: ActivationPhaseSlug;
} {
  switch (action.kind) {
    case "Upgrade":
      return { phase: 1, slug: "upgrade" };
    case "RegisterToken":
      return { phase: 2, slug: "token-registration" };
    case "RaiseTokenFlowLimit":
    case "SetTokenEnabled":
      return { phase: 3, slug: "token-limit" };
    case "SetAdapter":
      return { phase: 4, slug: "route-adapter" };
    case "SetRailReceiver":
    case "SetRouteConfig":
    case "SetRouteMaxSingleTransfer":
    case "SetRouteFlowLimit":
      return { phase: 5, slug: "route-wiring" };
    case "EnableRoute":
      return { phase: 6, slug: "route-enablement" };
    case "SetFeeBps":
    case "SetFlowWindow":
    case "SetTimelockDelay":
    case "SetTreasury":
    case "SetGuardian":
      return { phase: 7, slug: "router-policy" };
    case "SetAdmin":
      return { phase: 8, slug: "admin-handover" };
  }
}

function summarizeAction(action: ScheduledAdminAction): string {
  switch (action.kind) {
    case "Upgrade":
      return `Upgrade(${action.target})`;
    case "RegisterToken":
      return `RegisterToken(${action.token}, decimals=${String(action.decimals)}, flowLimit=${action.flowLimit})`;
    case "RaiseTokenFlowLimit":
      return `RaiseTokenFlowLimit(${action.token}, flowLimit=${action.flowLimit})`;
    case "SetTokenEnabled":
      return `SetTokenEnabled(${action.token}, enabled=${String(action.enabled)})`;
    case "SetAdapter":
      return `SetAdapter(${ROUTE_SLUGS[action.route]}, ${action.adapter})`;
    case "SetRailReceiver":
      return `SetRailReceiver(${ROUTE_SLUGS[action.route]}, ${action.receiver})`;
    case "SetRouteFlowLimit":
      return `SetRouteFlowLimit(${action.token}, ${ROUTE_SLUGS[action.route]}, flowLimit=${action.flowLimit})`;
    case "SetRouteConfig":
      return `SetRouteConfig(${ROUTE_SLUGS[action.route]}, maxSingleTransfer=${action.maxSingleTransfer})`;
    case "SetRouteMaxSingleTransfer":
      return `SetRouteMaxSingleTransfer(${ROUTE_SLUGS[action.route]}, maxSingleTransfer=${action.maxSingleTransfer})`;
    case "EnableRoute":
      return `EnableRoute(${ROUTE_SLUGS[action.route]}, enabled=${String(action.enabled)})`;
    case "SetFeeBps":
      return `SetFeeBps(${String(action.feeBps)})`;
    case "SetFlowWindow":
      return `SetFlowWindow(${String(action.flowWindow)})`;
    case "SetTimelockDelay":
      return `SetTimelockDelay(${String(action.timelockDelaySeconds)})`;
    case "SetTreasury":
      return `SetTreasury(${action.treasury})`;
    case "SetGuardian":
      return `SetGuardian(${action.guardian})`;
    case "SetAdmin":
      return `SetAdmin(${action.admin})`;
  }
}

function routeOfAction(action: ScheduledAdminAction): RouteKind | null {
  switch (action.kind) {
    case "SetAdapter":
    case "SetRailReceiver":
    case "SetRouteFlowLimit":
    case "SetRouteConfig":
    case "SetRouteMaxSingleTransfer":
    case "EnableRoute":
      return action.route;
    default:
      return null;
  }
}

function capabilitySlotKey(action: ScheduledAdminAction): string {
  switch (action.kind) {
    case "Upgrade":
      return "Upgrade";
    case "RegisterToken":
      return `RegisterToken:${action.token}`;
    case "RaiseTokenFlowLimit":
      return `RaiseTokenFlowLimit:${action.token}`;
    case "SetTokenEnabled":
      return `SetTokenEnabled:${action.token}`;
    case "SetAdapter":
      return `SetAdapter:${String(action.route)}`;
    case "SetRailReceiver":
      return `SetRailReceiver:${String(action.route)}`;
    case "SetRouteFlowLimit":
      return `SetRouteFlowLimit:${action.token}:${String(action.route)}`;
    case "SetRouteConfig":
    case "SetRouteMaxSingleTransfer":
      return `SetRouteConfig:${String(action.route)}`;
    case "EnableRoute":
      return `EnableRoute:${String(action.route)}`;
    case "SetFeeBps":
      return "SetFeeBps";
    case "SetFlowWindow":
      return "SetFlowWindow";
    case "SetTimelockDelay":
      return "SetTimelockDelay";
    case "SetTreasury":
      return "SetTreasury";
    case "SetGuardian":
      return "SetGuardian";
    case "SetAdmin":
      return "SetAdmin";
  }
}

function gatedNoteForEntry(chain: ChainKey, action: ScheduledAdminAction): string | null {
  const family = CHAINS[chain].family;
  if (family === "evm") {
    return "EVM router activation remains gated until independently validated; active deployment is Stellar Testnet outbound ITS/CCTP.";
  }
  const route = routeOfAction(action);
  if (route !== null && route !== RouteKind.Cctp && route !== RouteKind.AxelarIts) {
    return `Rail "${ROUTE_SLUGS[route]}" remains gated until independently validated; active deployment is Stellar Testnet outbound ITS/CCTP.`;
  }
  if (chain !== "stellar-testnet") {
    return `Chain "${chain}" activation remains gated; active deployment is Stellar Testnet outbound ITS/CCTP.`;
  }
  return null;
}

interface InternalEntry {
  readonly id: number;
  readonly action: ScheduledAdminAction;
  readonly summary: string;
  readonly sequencePhase: number;
  readonly phaseSlug: ActivationPhaseSlug;
  readonly windowState: TimelockWindowState;
  readonly queuedAtSeconds: number;
  readonly earliestExecutionSeconds: number;
  readonly expiresAtSeconds: number;
  readonly secondsUntilEarliestExecution: number;
  readonly secondsUntilExpiry: number;
  readonly gatedScopeNote: string | null;
}

interface ResolvedDependencies {
  readonly prerequisiteIds: readonly number[];
  readonly blockingPrerequisiteIds: readonly number[];
  readonly requeueRequired: boolean;
  readonly runnableNow: boolean;
}

function resolveGroupDependencies(
  candidates: readonly InternalEntry[],
  resolvedById: ReadonlyMap<number, ResolvedDependencies>,
): {
  readonly prerequisiteIds: readonly number[];
  readonly blockingIds: readonly number[];
  readonly brokenIds: readonly number[];
} {
  if (candidates.length === 0) {
    return { prerequisiteIds: [], blockingIds: [], brokenIds: [] };
  }

  const active = candidates.filter(
    (entry) => entry.windowState === "waiting" || entry.windowState === "runnable",
  );
  if (active.length > 0) {
    const prerequisiteIds = active.map((entry) => entry.id);
    const blockingIds = active
      .filter((entry) => resolvedById.get(entry.id)?.runnableNow !== true)
      .map((entry) => entry.id);
    const brokenIds = active
      .filter((entry) => resolvedById.get(entry.id)?.requeueRequired === true)
      .map((entry) => entry.id);
    return { prerequisiteIds, blockingIds, brokenIds };
  }

  const executed = candidates.filter((entry) => entry.windowState === "executed");
  if (executed.length > 0) {
    return {
      prerequisiteIds: executed.map((entry) => entry.id),
      blockingIds: [],
      brokenIds: [],
    };
  }

  const brokenIds = candidates.map((entry) => entry.id);
  return {
    prerequisiteIds: brokenIds,
    blockingIds: brokenIds,
    brokenIds,
  };
}

function computeEntryDependencies(
  entry: InternalEntry,
  allSortedByPhase: readonly InternalEntry[],
  resolvedById: ReadonlyMap<number, ResolvedDependencies>,
): ResolvedDependencies {
  if (
    entry.windowState === "expired" ||
    entry.windowState === "cancelled" ||
    entry.windowState === "executed"
  ) {
    return {
      prerequisiteIds: [],
      blockingPrerequisiteIds: [],
      requeueRequired: entry.windowState === "expired" || entry.windowState === "cancelled",
      runnableNow: false,
    };
  }

  const groups: InternalEntry[][] = [];
  const upgrades = allSortedByPhase.filter((other) => other.action.kind === "Upgrade");

  switch (entry.action.kind) {
    case "Upgrade":
      break;
    case "RegisterToken":
      groups.push(upgrades);
      break;
    case "RaiseTokenFlowLimit":
    case "SetTokenEnabled": {
      const targetToken = entry.action.token;
      groups.push(upgrades);
      groups.push(
        allSortedByPhase.filter(
          (other) => other.action.kind === "RegisterToken" && other.action.token === targetToken,
        ),
      );
      break;
    }
    case "SetAdapter":
      groups.push(upgrades);
      break;
    case "SetRailReceiver":
    case "SetRouteConfig":
    case "SetRouteMaxSingleTransfer": {
      const targetRoute = entry.action.route;
      groups.push(upgrades);
      groups.push(
        allSortedByPhase.filter(
          (other) => other.action.kind === "SetAdapter" && other.action.route === targetRoute,
        ),
      );
      break;
    }
    case "SetRouteFlowLimit": {
      const targetToken = entry.action.token;
      const targetRoute = entry.action.route;
      groups.push(upgrades);
      groups.push(
        allSortedByPhase.filter(
          (other) => other.action.kind === "RegisterToken" && other.action.token === targetToken,
        ),
      );
      groups.push(
        allSortedByPhase.filter(
          (other) => other.action.kind === "SetAdapter" && other.action.route === targetRoute,
        ),
      );
      break;
    }
    case "EnableRoute": {
      const targetRoute = entry.action.route;
      groups.push(upgrades);
      const tokenSlots = new Map<string, InternalEntry[]>();
      for (const other of allSortedByPhase) {
        if (other.action.kind === "RegisterToken") {
          const list = tokenSlots.get(other.action.token) ?? [];
          list.push(other);
          tokenSlots.set(other.action.token, list);
        }
      }
      for (const tokenGroup of tokenSlots.values()) {
        groups.push(tokenGroup);
      }
      groups.push(
        allSortedByPhase.filter(
          (other) => other.action.kind === "SetAdapter" && other.action.route === targetRoute,
        ),
      );
      groups.push(
        allSortedByPhase.filter(
          (other) => other.action.kind === "SetRailReceiver" && other.action.route === targetRoute,
        ),
      );
      groups.push(
        allSortedByPhase.filter(
          (other) =>
            (other.action.kind === "SetRouteConfig" ||
              other.action.kind === "SetRouteMaxSingleTransfer") &&
            other.action.route === targetRoute,
        ),
      );
      const routeFlowSlots = new Map<string, InternalEntry[]>();
      for (const other of allSortedByPhase) {
        if (other.action.kind === "SetRouteFlowLimit" && other.action.route === targetRoute) {
          const list = routeFlowSlots.get(other.action.token) ?? [];
          list.push(other);
          routeFlowSlots.set(other.action.token, list);
        }
      }
      for (const routeFlowGroup of routeFlowSlots.values()) {
        groups.push(routeFlowGroup);
      }
      break;
    }
    case "SetFeeBps":
    case "SetFlowWindow":
    case "SetTimelockDelay":
    case "SetTreasury":
    case "SetGuardian":
      groups.push(upgrades);
      break;
    case "SetAdmin": {
      const priorBySlot = new Map<string, InternalEntry[]>();
      for (const other of allSortedByPhase) {
        if (other.action.kind !== "SetAdmin") {
          const slot = capabilitySlotKey(other.action);
          const list = priorBySlot.get(slot) ?? [];
          list.push(other);
          priorBySlot.set(slot, list);
        }
      }
      for (const slotEntries of priorBySlot.values()) {
        groups.push(slotEntries);
      }
      break;
    }
  }

  const prereqSet = new Set<number>();
  const blockingSet = new Set<number>();
  const brokenSet = new Set<number>();

  for (const group of groups) {
    const resolved = resolveGroupDependencies(group, resolvedById);
    for (const id of resolved.prerequisiteIds) prereqSet.add(id);
    for (const id of resolved.blockingIds) blockingSet.add(id);
    for (const id of resolved.brokenIds) brokenSet.add(id);
  }

  const prerequisiteIds = Array.from(prereqSet).sort((a, b) => a - b);
  const blockingPrerequisiteIds = Array.from(blockingSet).sort((a, b) => a - b);
  const requeueRequired = brokenSet.size > 0;
  const runnableNow = entry.windowState === "runnable" && blockingPrerequisiteIds.length === 0;

  return {
    prerequisiteIds,
    blockingPrerequisiteIds,
    requeueRequired,
    runnableNow,
  };
}

function compareSequenceOrder(a: InternalEntry, b: InternalEntry): number {
  if (a.sequencePhase !== b.sequencePhase) return a.sequencePhase - b.sequencePhase;
  if (a.earliestExecutionSeconds !== b.earliestExecutionSeconds) {
    return a.earliestExecutionSeconds - b.earliestExecutionSeconds;
  }
  return a.id - b.id;
}

/**
 * Compute an unsigned, deterministic timelock schedule and activation sequence report from on-chain
 * timestamps and queued action state.
 */
export function buildTimelockScheduleReport(input: TimelockScheduleInput): TimelockScheduleReport {
  if (!isChainKey(input.chain)) {
    scheduleFail("$.chain", "unknown chain key");
  }
  const family = CHAINS[input.chain].family;
  const router = validateChainAddress(input.router, family, "contract", "$.router");
  const chainTimestampSeconds = asSafeInt(
    input.chainTimestampSeconds,
    "$.chainTimestampSeconds",
    0,
  );

  const timelockDelaySeconds =
    input.timelockDelaySeconds !== undefined
      ? asSafeInt(input.timelockDelaySeconds, "$.timelockDelaySeconds", TIMELOCK_MIN_DELAY_SECONDS)
      : TIMELOCK_MIN_DELAY_SECONDS;
  if (timelockDelaySeconds > TIMELOCK_MAX_DELAY_SECONDS) {
    scheduleFail(
      "$.timelockDelaySeconds",
      `cannot exceed ${String(TIMELOCK_MAX_DELAY_SECONDS)} seconds`,
    );
  }

  const gracePeriodSeconds =
    input.gracePeriodSeconds !== undefined
      ? asSafeInt(input.gracePeriodSeconds, "$.gracePeriodSeconds", 1)
      : TIMELOCK_GRACE_PERIOD_SECONDS;

  const seenIds = new Set<number>();
  const internalEntries: InternalEntry[] = input.entries.map((rawEntry, index) => {
    const entryPath = `$.entries[${String(index)}]`;
    const id = asSafeInt(rawEntry.id, `${entryPath}.id`, 1);
    if (seenIds.has(id)) {
      scheduleFail(`${entryPath}.id`, `duplicate action id ${String(id)}`);
    }
    seenIds.add(id);

    const validatedAction = parseQueuedAdminAction(rawEntry.action, family, `${entryPath}.action`);
    const queuedAtSeconds = asSafeInt(rawEntry.queuedAtSeconds, `${entryPath}.queuedAtSeconds`, 0);
    const earliestExecutionSeconds =
      rawEntry.etaSeconds !== undefined
        ? asSafeInt(rawEntry.etaSeconds, `${entryPath}.etaSeconds`, 0)
        : queuedAtSeconds + timelockDelaySeconds;
    if (earliestExecutionSeconds < queuedAtSeconds) {
      scheduleFail(`${entryPath}.etaSeconds`, "etaSeconds cannot precede queuedAtSeconds");
    }

    const expiresAtSeconds =
      rawEntry.expiresAtSeconds !== undefined
        ? asSafeInt(rawEntry.expiresAtSeconds, `${entryPath}.expiresAtSeconds`, 0)
        : earliestExecutionSeconds + gracePeriodSeconds;
    if (expiresAtSeconds <= earliestExecutionSeconds) {
      scheduleFail(
        `${entryPath}.expiresAtSeconds`,
        "expiresAtSeconds must be strictly greater than etaSeconds",
      );
    }

    const executed = rawEntry.executed === true;
    const cancelled = rawEntry.cancelled === true;
    if (executed && cancelled) {
      scheduleFail(entryPath, `action ${String(id)} cannot be both executed and cancelled`);
    }

    let windowState: TimelockWindowState;
    if (executed) {
      windowState = "executed";
    } else if (cancelled) {
      windowState = "cancelled";
    } else if (chainTimestampSeconds < earliestExecutionSeconds) {
      windowState = "waiting";
    } else if (chainTimestampSeconds > expiresAtSeconds) {
      windowState = "expired";
    } else {
      windowState = "runnable";
    }

    const secondsUntilEarliestExecution =
      windowState === "waiting" ? earliestExecutionSeconds - chainTimestampSeconds : 0;
    const secondsUntilExpiry =
      windowState === "waiting" || windowState === "runnable"
        ? expiresAtSeconds - chainTimestampSeconds
        : 0;

    const phase = phaseForAction(validatedAction);
    return {
      id,
      action: validatedAction,
      summary: summarizeAction(validatedAction),
      sequencePhase: phase.phase,
      phaseSlug: phase.slug,
      windowState,
      queuedAtSeconds,
      earliestExecutionSeconds,
      expiresAtSeconds,
      secondsUntilEarliestExecution,
      secondsUntilExpiry,
      gatedScopeNote: gatedNoteForEntry(input.chain, validatedAction),
    };
  });

  const sortedByPhase = [...internalEntries].sort(compareSequenceOrder);
  const resolvedById = new Map<number, ResolvedDependencies>();
  for (const entry of sortedByPhase) {
    resolvedById.set(entry.id, computeEntryDependencies(entry, sortedByPhase, resolvedById));
  }

  const sortedById = [...internalEntries].sort((a, b) => a.id - b.id);
  const actionWindows: TimelockActionWindow[] = sortedById.map((entry) => {
    const resolved = resolvedById.get(entry.id) ?? {
      prerequisiteIds: [],
      blockingPrerequisiteIds: [],
      requeueRequired: false,
      runnableNow: false,
    };
    return {
      id: entry.id,
      action: entry.action,
      summary: entry.summary,
      sequencePhase: entry.sequencePhase,
      phaseSlug: entry.phaseSlug,
      windowState: entry.windowState,
      queuedAtSeconds: entry.queuedAtSeconds,
      earliestExecutionSeconds: entry.earliestExecutionSeconds,
      expiresAtSeconds: entry.expiresAtSeconds,
      secondsUntilEarliestExecution: entry.secondsUntilEarliestExecution,
      secondsUntilExpiry: entry.secondsUntilExpiry,
      prerequisiteIds: resolved.prerequisiteIds,
      blockingPrerequisiteIds: resolved.blockingPrerequisiteIds,
      requeueRequired: resolved.requeueRequired,
      gatedScopeNote: entry.gatedScopeNote,
    };
  });

  const activeOrdered = sortedByPhase.filter(
    (entry) => entry.windowState === "waiting" || entry.windowState === "runnable",
  );

  const requiredSequence: TimelockSequenceStep[] = activeOrdered.map((entry, idx) => {
    const resolved = resolvedById.get(entry.id) ?? {
      prerequisiteIds: [],
      blockingPrerequisiteIds: [],
      requeueRequired: false,
      runnableNow: false,
    };
    const activeState: "waiting" | "runnable" =
      entry.windowState === "waiting" ? "waiting" : "runnable";
    return {
      stepNumber: idx + 1,
      id: entry.id,
      action: entry.action,
      summary: entry.summary,
      sequencePhase: entry.sequencePhase,
      phaseSlug: entry.phaseSlug,
      windowState: activeState,
      earliestExecutionSeconds: entry.earliestExecutionSeconds,
      expiresAtSeconds: entry.expiresAtSeconds,
      secondsUntilEarliestExecution: entry.secondsUntilEarliestExecution,
      secondsUntilExpiry: entry.secondsUntilExpiry,
      prerequisiteIds: resolved.prerequisiteIds,
      blockingPrerequisiteIds: resolved.blockingPrerequisiteIds,
      runnableNow: resolved.runnableNow,
      requeueRequired: resolved.requeueRequired,
      gatedScopeNote: entry.gatedScopeNote,
    };
  });

  const runnableOperations = requiredSequence.filter((step) => step.runnableNow);

  const excludedOperations: TimelockExcludedOperation[] = sortedById
    .filter(
      (
        entry,
      ): entry is InternalEntry & { readonly windowState: "expired" | "cancelled" | "executed" } =>
        entry.windowState === "expired" ||
        entry.windowState === "cancelled" ||
        entry.windowState === "executed",
    )
    .map((entry) => ({
      id: entry.id,
      action: entry.action,
      summary: entry.summary,
      reason: entry.windowState,
      earliestExecutionSeconds: entry.earliestExecutionSeconds,
      expiresAtSeconds: entry.expiresAtSeconds,
      requeueRequired: entry.windowState === "expired" || entry.windowState === "cancelled",
    }));

  const waitingCount = requiredSequence.filter((step) => step.windowState === "waiting").length;
  const blockedCount = requiredSequence.filter(
    (step) => step.windowState === "runnable" && !step.runnableNow,
  ).length;
  const expiredCount = excludedOperations.filter((op) => op.reason === "expired").length;
  const cancelledCount = excludedOperations.filter((op) => op.reason === "cancelled").length;
  const executedCount = excludedOperations.filter((op) => op.reason === "executed").length;

  const hasBrokenSequenceDependency = requiredSequence.some((step) => step.requeueRequired);
  const earliestPendingExecutionSeconds =
    requiredSequence.length > 0
      ? Math.min(...requiredSequence.map((step) => step.earliestExecutionSeconds))
      : null;
  const allPendingExecutableAtSeconds =
    requiredSequence.length > 0 && !hasBrokenSequenceDependency
      ? Math.max(...requiredSequence.map((step) => step.earliestExecutionSeconds))
      : null;
  const nextExpirySeconds =
    requiredSequence.length > 0
      ? Math.min(...requiredSequence.map((step) => step.expiresAtSeconds))
      : null;

  let scopeNotice: string | null = null;
  if (family === "evm") {
    scopeNotice =
      "EVM router schedule evaluated in planning mode; active production scope is Stellar Testnet outbound ITS/CCTP and EVM execution remains gated until independently validated.";
  } else if (input.chain !== "stellar-testnet") {
    scopeNotice = `Chain "${input.chain}" schedule evaluated in planning mode; active deployment is Stellar Testnet outbound ITS/CCTP.`;
  } else {
    const gatedStep = actionWindows.find((win) => win.gatedScopeNote !== null);
    if (gatedStep !== undefined) {
      scopeNotice = gatedStep.gatedScopeNote;
    }
  }

  return {
    chain: input.chain,
    family,
    router,
    chainTimestampSeconds,
    timelockDelaySeconds,
    gracePeriodSeconds,
    scopeNotice,
    counts: {
      total: actionWindows.length,
      runnable: runnableOperations.length,
      waiting: waitingCount,
      blocked: blockedCount,
      expired: expiredCount,
      cancelled: cancelledCount,
      executed: executedCount,
    },
    earliestPendingExecutionSeconds,
    allPendingExecutableAtSeconds,
    nextExpirySeconds,
    actionWindows,
    requiredSequence,
    runnableOperations,
    excludedOperations,
  };
}

/**
 * Render an operator-readable plain-text timelock schedule report.
 */
export function formatTimelockScheduleReport(report: TimelockScheduleReport): string {
  const lines: string[] = [
    `Timelock Schedule Report (${report.chain})`,
    `  router:                  ${report.router}`,
    `  chain timestamp (s):     ${String(report.chainTimestampSeconds)}`,
    `  timelock delay (s):      ${String(report.timelockDelaySeconds)}`,
    `  grace period (s):        ${String(report.gracePeriodSeconds)}`,
    `  summary:                 total=${String(report.counts.total)} runnable=${String(report.counts.runnable)} waiting=${String(report.counts.waiting)} blocked=${String(report.counts.blocked)} expired=${String(report.counts.expired)} cancelled=${String(report.counts.cancelled)} executed=${String(report.counts.executed)}`,
  ];

  if (report.earliestPendingExecutionSeconds !== null) {
    lines.push(`  earliest pending eta:    ${String(report.earliestPendingExecutionSeconds)}`);
  }
  if (report.allPendingExecutableAtSeconds !== null) {
    lines.push(`  all pending ready at:    ${String(report.allPendingExecutableAtSeconds)}`);
  }
  if (report.nextExpirySeconds !== null) {
    lines.push(`  next window expiry:      ${String(report.nextExpirySeconds)}`);
  }
  if (report.scopeNotice !== null) {
    lines.push(`  scope notice:            ${report.scopeNotice}`);
  }

  lines.push("", "Required Activation Sequence:");
  if (report.requiredSequence.length === 0) {
    lines.push("  (no pending actions)");
  } else {
    for (const step of report.requiredSequence) {
      const readiness = step.runnableNow
        ? "RUNNABLE"
        : step.windowState === "waiting"
          ? `WAITING (+${String(step.secondsUntilEarliestExecution)}s)`
          : `BLOCKED (by id ${step.blockingPrerequisiteIds.map(String).join(", ")})`;
      const prereqNote =
        step.prerequisiteIds.length > 0
          ? ` after=[${step.prerequisiteIds.map(String).join(",")}]`
          : "";
      const requeueNote = step.requeueRequired ? " REQUEUE_REQUIRED" : "";
      lines.push(
        `  ${String(step.stepNumber)}. [id ${String(step.id)}] ${readiness} [${step.phaseSlug}] eta=${String(step.earliestExecutionSeconds)} expires=${String(step.expiresAtSeconds)} ${step.summary}${prereqNote}${requeueNote}`,
      );
    }
  }

  lines.push("", "Runnable Operations (chain-time ready and dependency-unblocked):");
  if (report.runnableOperations.length === 0) {
    lines.push("  (none)");
  } else {
    for (const op of report.runnableOperations) {
      lines.push(
        `  - id ${String(op.id)} (step ${String(op.stepNumber)}): ${op.summary} [expires in ${String(op.secondsUntilExpiry)}s]`,
      );
    }
  }

  lines.push("", "Excluded Operations (expired, cancelled, or already executed):");
  if (report.excludedOperations.length === 0) {
    lines.push("  (none)");
  } else {
    for (const ex of report.excludedOperations) {
      const suffix = ex.requeueRequired ? " (requeue required if still intended)" : "";
      lines.push(
        `  - id ${String(ex.id)} [${ex.reason.toUpperCase()}]: ${ex.summary} (window ${String(ex.earliestExecutionSeconds)}..${String(ex.expiresAtSeconds)})${suffix}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
