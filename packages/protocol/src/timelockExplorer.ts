/**
 * Deterministic timelock boundary and authority sequence explorer.
 *
 * Generates and audits multi-actor administration sequences covering role nomination/handover
 * (`SetAdmin`, `SetGuardian`), guardian/admin cancellation, exact maturity and grace-period
 * boundaries (`eta - 1`, `eta`, `expiresAt`, `expiresAt + 1`), emergency circuit-breaker
 * contractions (`pause`, `disableRoute`, `disableToken`, `lowerTokenFlowLimit`), and duplicate
 * execution races.
 *
 * Every step and any invariant violation trace captures chain time (`timestamp`, `ledgerSequence`)
 * alongside the full structured and canonical-JSON action payload.
 */
import type { SorobanErrorName } from "./errors.js";
import type { RouteSlug } from "./routes.js";

export const TIMELOCK_MIN_DELAY_SECONDS = 3_600n;
export const TIMELOCK_MAX_DELAY_SECONDS = 2_592_000n;
export const TIMELOCK_GRACE_PERIOD_SECONDS = 604_800n;
export const MAX_ROUTER_FEE_BPS = 100;

export type ActorId = "admin-1" | "admin-2" | "admin-3" | "guardian-1" | "guardian-2" | "stranger";

export type ExplorerActionPayload =
  | { readonly kind: "SetFeeBps"; readonly feeBps: number }
  | { readonly kind: "SetTreasury"; readonly treasury: string }
  | { readonly kind: "SetAdmin"; readonly newAdmin: ActorId }
  | { readonly kind: "SetGuardian"; readonly newGuardian: ActorId }
  | { readonly kind: "EnableRoute"; readonly route: RouteSlug }
  | {
      readonly kind: "RegisterToken";
      readonly token: string;
      readonly decimals: number;
      readonly flowLimit: bigint;
    }
  | { readonly kind: "RaiseTokenFlowLimit"; readonly token: string; readonly flowLimit: bigint }
  | {
      readonly kind: "SetRouteFlowLimit";
      readonly token: string;
      readonly route: RouteSlug;
      readonly flowLimit: bigint;
    }
  | { readonly kind: "SetTimelockDelay"; readonly delaySeconds: bigint }
  | { readonly kind: "SetFlowWindow"; readonly windowLedgers: number }
  | { readonly kind: "Upgrade"; readonly wasmHashHex: string }
  | {
      readonly kind: "SetRouteMaxSingleTransfer";
      readonly route: RouteSlug;
      readonly limit: bigint;
    };

export type ExplorerOperation =
  | { readonly op: "advanceTime"; readonly deltaSeconds: bigint; readonly deltaLedgers: number }
  | { readonly op: "queueAction"; readonly caller: ActorId; readonly action: ExplorerActionPayload }
  | { readonly op: "executeAction"; readonly caller: ActorId; readonly actionId: bigint }
  | { readonly op: "cancelAction"; readonly caller: ActorId; readonly actionId: bigint }
  | { readonly op: "pause"; readonly caller: ActorId }
  | { readonly op: "unpause"; readonly caller: ActorId }
  | { readonly op: "disableRoute"; readonly caller: ActorId; readonly route: RouteSlug }
  | { readonly op: "disableToken"; readonly caller: ActorId; readonly token: string }
  | {
      readonly op: "lowerTokenFlowLimit";
      readonly caller: ActorId;
      readonly token: string;
      readonly newLimit: bigint;
    };

export interface QueuedExplorerEntry {
  readonly id: bigint;
  readonly action: ExplorerActionPayload;
  readonly queuedBy: ActorId;
  readonly queuedAt: bigint;
  readonly eta: bigint;
  readonly expiresAt: bigint;
  readonly status: "queued" | "executed" | "cancelled";
}

export interface RouterGovernanceState {
  readonly timestamp: bigint;
  readonly ledgerSequence: number;
  readonly admin: ActorId;
  readonly guardian: ActorId;
  readonly treasury: string;
  readonly feeBps: number;
  readonly timelockDelay: bigint;
  readonly flowWindowLedgers: number;
  readonly paused: boolean;
  readonly wasmHashHex: string;
  readonly enabledRoutes: Readonly<Record<RouteSlug, boolean>>;
  readonly tokenEnabled: boolean;
  readonly tokenFlowLimit: bigint;
  readonly routeMaxSingleTransfer: Readonly<Record<RouteSlug, bigint>>;
  readonly queueCount: bigint;
}

export interface ExplorerStepRecord {
  readonly stepIndex: number;
  readonly timestamp: bigint;
  readonly ledgerSequence: number;
  readonly operationSummary: string;
  readonly fullActionPayloadJson: string;
  readonly caller: ActorId | null;
  readonly activeAdminBefore: ActorId;
  readonly activeGuardianBefore: ActorId;
  readonly activeAdminAfter: ActorId;
  readonly activeGuardianAfter: ActorId;
  readonly succeeded: boolean;
  readonly error: SorobanErrorName | null;
  readonly queuedId: bigint | null;
}

export interface TimelockFailureTrace {
  readonly sequenceName: string;
  readonly stepIndex: number;
  readonly invariantCode:
    | "EARLY_UNREVIEWED_EXPANSION"
    | "EXPIRED_ACTION_APPLIED"
    | "CANCELLED_OR_MISSING_ACTION_APPLIED"
    | "SUPERSEDED_ACTOR_RETAINED_AUTHORITY"
    | "UNAUTHORIZED_ROLE_MUTATION";
  readonly timestamp: bigint;
  readonly ledgerSequence: number;
  readonly caller: ActorId | null;
  readonly activeAdmin: ActorId;
  readonly activeGuardian: ActorId;
  readonly fullActionPayloadJson: string;
  readonly queuedWindow: {
    readonly id: bigint;
    readonly queuedAt: bigint;
    readonly eta: bigint;
    readonly expiresAt: bigint;
  } | null;
  readonly detail: string;
}

export interface SequenceExplorationReport {
  readonly sequenceName: string;
  readonly passed: boolean;
  readonly steps: readonly ExplorerStepRecord[];
  readonly failures: readonly TimelockFailureTrace[];
  readonly finalState: RouterGovernanceState;
}

export interface GeneratedSequenceSpec {
  readonly name: string;
  readonly seed: bigint;
  readonly operations: readonly ExplorerOperation[];
}

const DEFAULT_TOKEN = "USDC_SAC";
const INITIAL_WASM_HASH = "0x" + "11".repeat(32);
const UPGRADED_WASM_HASH = "0x" + "22".repeat(32);

/** Serialize an `ExplorerActionPayload` deterministically with lossless `bigint` string encoding. */
export function serializeActionPayload(action: ExplorerActionPayload | null): string {
  if (action === null) {
    return "null";
  }
  switch (action.kind) {
    case "SetFeeBps":
      return JSON.stringify({ kind: action.kind, feeBps: action.feeBps });
    case "SetTreasury":
      return JSON.stringify({ kind: action.kind, treasury: action.treasury });
    case "SetAdmin":
      return JSON.stringify({ kind: action.kind, newAdmin: action.newAdmin });
    case "SetGuardian":
      return JSON.stringify({ kind: action.kind, newGuardian: action.newGuardian });
    case "EnableRoute":
      return JSON.stringify({ kind: action.kind, route: action.route });
    case "RegisterToken":
      return JSON.stringify({
        kind: action.kind,
        token: action.token,
        decimals: action.decimals,
        flowLimit: action.flowLimit.toString(),
      });
    case "RaiseTokenFlowLimit":
      return JSON.stringify({
        kind: action.kind,
        token: action.token,
        flowLimit: action.flowLimit.toString(),
      });
    case "SetRouteFlowLimit":
      return JSON.stringify({
        kind: action.kind,
        token: action.token,
        route: action.route,
        flowLimit: action.flowLimit.toString(),
      });
    case "SetTimelockDelay":
      return JSON.stringify({
        kind: action.kind,
        delaySeconds: action.delaySeconds.toString(),
      });
    case "SetFlowWindow":
      return JSON.stringify({ kind: action.kind, windowLedgers: action.windowLedgers });
    case "Upgrade":
      return JSON.stringify({ kind: action.kind, wasmHashHex: action.wasmHashHex });
    case "SetRouteMaxSingleTransfer":
      return JSON.stringify({
        kind: action.kind,
        route: action.route,
        limit: action.limit.toString(),
      });
  }
}

export function formatFailureTrace(trace: TimelockFailureTrace): string {
  const windowPart =
    trace.queuedWindow === null
      ? "window=none"
      : `window={id:${trace.queuedWindow.id.toString()},queuedAt:${trace.queuedWindow.queuedAt.toString()},eta:${trace.queuedWindow.eta.toString()},expiresAt:${trace.queuedWindow.expiresAt.toString()}}`;
  return [
    `sequence=${trace.sequenceName}`,
    `step=${String(trace.stepIndex)}`,
    `invariant=${trace.invariantCode}`,
    `timestamp=${trace.timestamp.toString()}`,
    `ledger=${String(trace.ledgerSequence)}`,
    `caller=${trace.caller ?? "none"}`,
    `activeAdmin=${trace.activeAdmin}`,
    `activeGuardian=${trace.activeGuardian}`,
    windowPart,
    `payload=${trace.fullActionPayloadJson}`,
    `detail=${trace.detail}`,
  ].join(" | ");
}

function validateQueuedAction(action: ExplorerActionPayload): SorobanErrorName | null {
  switch (action.kind) {
    case "SetFeeBps":
      return action.feeBps < 0 || action.feeBps > MAX_ROUTER_FEE_BPS ? "FeeTooHigh" : null;
    case "SetTimelockDelay":
      return action.delaySeconds < TIMELOCK_MIN_DELAY_SECONDS ||
        action.delaySeconds > TIMELOCK_MAX_DELAY_SECONDS
        ? "TimelockDelayOutOfRange"
        : null;
    case "SetFlowWindow":
      return action.windowLedgers <= 0 ? "InvalidWindow" : null;
    case "RegisterToken":
      if (action.flowLimit < 0n) return "InvalidLimit";
      if (action.decimals < 0 || action.decimals > 38) return "InvalidDecimals";
      return null;
    case "RaiseTokenFlowLimit":
    case "SetRouteFlowLimit":
      return action.flowLimit < 0n ? "InvalidLimit" : null;
    case "SetRouteMaxSingleTransfer":
      return action.limit < 0n ? "InvalidLimit" : null;
    case "SetTreasury":
    case "SetAdmin":
    case "SetGuardian":
    case "EnableRoute":
    case "Upgrade":
      return null;
  }
}

function initialGovernanceState(): RouterGovernanceState {
  return {
    timestamp: 1_700_000_000n,
    ledgerSequence: 100_000,
    admin: "admin-1",
    guardian: "guardian-1",
    treasury: "treasury-initial",
    feeBps: 10,
    timelockDelay: TIMELOCK_MIN_DELAY_SECONDS,
    flowWindowLedgers: 720,
    paused: false,
    wasmHashHex: INITIAL_WASM_HASH,
    enabledRoutes: {
      cctp: true,
      "axelar-its": true,
      "axelar-gmp": false,
      allbridge: false,
    },
    tokenEnabled: true,
    tokenFlowLimit: 10_000_000_000n,
    routeMaxSingleTransfer: {
      cctp: 0n,
      "axelar-its": 0n,
      "axelar-gmp": 0n,
      allbridge: 0n,
    },
    queueCount: 0n,
  };
}

export interface FaultInjectionHooks {
  /** Fault-injection toggle used in tests to prove early expansion detection and trace formatting. */
  readonly allowEarlyExecution?: boolean;
  /** Fault-injection toggle used in tests to prove superseded-actor authority detection. */
  readonly allowSupersededAdmin?: boolean;
}

/**
 * Execute an administration sequence against the governance state machine while continuously
 * checking timelock maturity/expiration bounds and superseded-actor authority revocation.
 */
export function runTimelockSequence(
  sequenceName: string,
  operations: readonly ExplorerOperation[],
  faultHooks: FaultInjectionHooks = {},
): SequenceExplorationReport {
  let state = initialGovernanceState();
  const queue = new Map<bigint, QueuedExplorerEntry>();
  const supersededAdmins = new Set<ActorId>();
  const supersededGuardians = new Set<ActorId>();
  const steps: ExplorerStepRecord[] = [];
  const failures: TimelockFailureTrace[] = [];

  for (let idx = 0; idx < operations.length; idx += 1) {
    const op = operations[idx];
    if (op === undefined) continue;

    const adminBefore = state.admin;
    const guardianBefore = state.guardian;
    let succeeded = false;
    let error: SorobanErrorName | null = null;
    let queuedId: bigint | null = null;
    let caller: ActorId | null = null;
    let payloadForTrace: ExplorerActionPayload | null = null;
    let windowForTrace: TimelockFailureTrace["queuedWindow"] = null;
    let summary: string = op.op;

    const isCurrentAdmin = (who: ActorId): boolean =>
      who === state.admin ||
      (faultHooks.allowSupersededAdmin === true && supersededAdmins.has(who));
    const isAdminOrGuardian = (who: ActorId): boolean =>
      isCurrentAdmin(who) || who === state.guardian;

    switch (op.op) {
      case "advanceTime": {
        state = {
          ...state,
          timestamp: state.timestamp + op.deltaSeconds,
          ledgerSequence: state.ledgerSequence + op.deltaLedgers,
        };
        succeeded = true;
        summary = `advanceTime(+${op.deltaSeconds.toString()}s,+${String(op.deltaLedgers)}L)`;
        break;
      }

      case "queueAction": {
        caller = op.caller;
        payloadForTrace = op.action;
        summary = `queueAction(${op.action.kind})`;
        if (!isCurrentAdmin(op.caller)) {
          error = "Unauthorized";
        } else {
          const invalid = validateQueuedAction(op.action);
          if (invalid !== null) {
            error = invalid;
          } else {
            const nextId = state.queueCount + 1n;
            const eta = state.timestamp + state.timelockDelay;
            const expiresAt = eta + TIMELOCK_GRACE_PERIOD_SECONDS;
            const entry: QueuedExplorerEntry = {
              id: nextId,
              action: op.action,
              queuedBy: op.caller,
              queuedAt: state.timestamp,
              eta,
              expiresAt,
              status: "queued",
            };
            queue.set(nextId, entry);
            state = { ...state, queueCount: nextId };
            queuedId = nextId;
            succeeded = true;
            windowForTrace = {
              id: nextId,
              queuedAt: entry.queuedAt,
              eta: entry.eta,
              expiresAt: entry.expiresAt,
            };
          }
        }
        break;
      }

      case "executeAction": {
        caller = op.caller;
        summary = `executeAction(#${op.actionId.toString()})`;
        const entry = queue.get(op.actionId);
        if (entry !== undefined) {
          payloadForTrace = entry.action;
          windowForTrace = {
            id: entry.id,
            queuedAt: entry.queuedAt,
            eta: entry.eta,
            expiresAt: entry.expiresAt,
          };
        }
        if (!isCurrentAdmin(op.caller)) {
          error = "Unauthorized";
        } else if (entry?.status !== "queued") {
          error = "TimelockNotQueued";
        } else if (state.timestamp < entry.eta && faultHooks.allowEarlyExecution !== true) {
          error = "TimelockNotReady";
        } else if (state.timestamp > entry.expiresAt) {
          error = "TimelockExpired";
        } else {
          queue.set(op.actionId, { ...entry, status: "executed" });
          succeeded = true;

          // Audit maturity window invariant at moment of execution.
          if (state.timestamp < entry.eta) {
            failures.push({
              sequenceName,
              stepIndex: idx + 1,
              invariantCode: "EARLY_UNREVIEWED_EXPANSION",
              timestamp: state.timestamp,
              ledgerSequence: state.ledgerSequence,
              caller: op.caller,
              activeAdmin: state.admin,
              activeGuardian: state.guardian,
              fullActionPayloadJson: serializeActionPayload(entry.action),
              queuedWindow: windowForTrace,
              detail: `action #${entry.id.toString()} executed at ${state.timestamp.toString()} before eta ${entry.eta.toString()}`,
            });
          }

          state = applyExplorerAction(state, entry.action, supersededAdmins, supersededGuardians);
        }
        break;
      }

      case "cancelAction": {
        caller = op.caller;
        summary = `cancelAction(#${op.actionId.toString()})`;
        const entry = queue.get(op.actionId);
        if (entry !== undefined) {
          payloadForTrace = entry.action;
          windowForTrace = {
            id: entry.id,
            queuedAt: entry.queuedAt,
            eta: entry.eta,
            expiresAt: entry.expiresAt,
          };
        }
        if (!isAdminOrGuardian(op.caller)) {
          error = "Unauthorized";
        } else if (entry?.status !== "queued") {
          error = "TimelockNotQueued";
        } else {
          queue.set(op.actionId, { ...entry, status: "cancelled" });
          succeeded = true;
        }
        break;
      }

      case "pause": {
        caller = op.caller;
        if (!isAdminOrGuardian(op.caller)) {
          error = "Unauthorized";
        } else {
          state = { ...state, paused: true };
          succeeded = true;
        }
        break;
      }

      case "unpause": {
        caller = op.caller;
        if (!isCurrentAdmin(op.caller)) {
          error = "Unauthorized";
        } else {
          state = { ...state, paused: false };
          succeeded = true;
        }
        break;
      }

      case "disableRoute": {
        caller = op.caller;
        summary = `disableRoute(${op.route})`;
        if (!isAdminOrGuardian(op.caller)) {
          error = "Unauthorized";
        } else {
          state = {
            ...state,
            enabledRoutes: { ...state.enabledRoutes, [op.route]: false },
          };
          succeeded = true;
        }
        break;
      }

      case "disableToken": {
        caller = op.caller;
        summary = `disableToken(${op.token})`;
        if (!isAdminOrGuardian(op.caller)) {
          error = "Unauthorized";
        } else if (op.token !== DEFAULT_TOKEN) {
          error = "TokenNotRegistered";
        } else {
          state = { ...state, tokenEnabled: false };
          succeeded = true;
        }
        break;
      }

      case "lowerTokenFlowLimit": {
        caller = op.caller;
        summary = `lowerTokenFlowLimit(${op.newLimit.toString()})`;
        if (!isAdminOrGuardian(op.caller)) {
          error = "Unauthorized";
        } else if (op.token !== DEFAULT_TOKEN) {
          error = "TokenNotRegistered";
        } else if (op.newLimit < 0n || op.newLimit >= state.tokenFlowLimit) {
          error = "InvalidLimit";
        } else {
          state = { ...state, tokenFlowLimit: op.newLimit };
          succeeded = true;
        }
        break;
      }
    }

    // Audit superseded-actor authority invariant on every state-mutating success.
    if (succeeded && caller !== null) {
      const stillHoldsActiveRole = caller === adminBefore || caller === guardianBefore;
      const wasSuperseded = supersededAdmins.has(caller) || supersededGuardians.has(caller);
      if (wasSuperseded && !stillHoldsActiveRole) {
        failures.push({
          sequenceName,
          stepIndex: idx + 1,
          invariantCode: "SUPERSEDED_ACTOR_RETAINED_AUTHORITY",
          timestamp: state.timestamp,
          ledgerSequence: state.ledgerSequence,
          caller,
          activeAdmin: adminBefore,
          activeGuardian: guardianBefore,
          fullActionPayloadJson: serializeActionPayload(payloadForTrace),
          queuedWindow: windowForTrace,
          detail: `superseded actor ${caller} succeeded at ${summary} while active roles were (${adminBefore}, ${guardianBefore})`,
        });
      }
    }

    steps.push({
      stepIndex: idx + 1,
      timestamp: state.timestamp,
      ledgerSequence: state.ledgerSequence,
      operationSummary: summary,
      fullActionPayloadJson: serializeActionPayload(payloadForTrace),
      caller,
      activeAdminBefore: adminBefore,
      activeGuardianBefore: guardianBefore,
      activeAdminAfter: state.admin,
      activeGuardianAfter: state.guardian,
      succeeded,
      error,
      queuedId,
    });
  }

  return {
    sequenceName,
    passed: failures.length === 0,
    steps,
    failures,
    finalState: state,
  };
}

function applyExplorerAction(
  state: RouterGovernanceState,
  action: ExplorerActionPayload,
  supersededAdmins: Set<ActorId>,
  supersededGuardians: Set<ActorId>,
): RouterGovernanceState {
  switch (action.kind) {
    case "SetFeeBps":
      return { ...state, feeBps: action.feeBps };
    case "SetTreasury":
      return { ...state, treasury: action.treasury };
    case "SetAdmin":
      if (state.admin !== action.newAdmin) {
        supersededAdmins.add(state.admin);
      }
      supersededAdmins.delete(action.newAdmin);
      return { ...state, admin: action.newAdmin };
    case "SetGuardian":
      if (state.guardian !== action.newGuardian) {
        supersededGuardians.add(state.guardian);
      }
      supersededGuardians.delete(action.newGuardian);
      return { ...state, guardian: action.newGuardian };
    case "EnableRoute":
      return {
        ...state,
        enabledRoutes: { ...state.enabledRoutes, [action.route]: true },
      };
    case "RegisterToken":
      return {
        ...state,
        tokenEnabled: true,
        tokenFlowLimit: action.flowLimit,
      };
    case "RaiseTokenFlowLimit":
      return { ...state, tokenFlowLimit: action.flowLimit };
    case "SetRouteFlowLimit":
      return state;
    case "SetTimelockDelay":
      return { ...state, timelockDelay: action.delaySeconds };
    case "SetFlowWindow":
      return { ...state, flowWindowLedgers: action.windowLedgers };
    case "Upgrade":
      return { ...state, wasmHashHex: action.wasmHashHex };
    case "SetRouteMaxSingleTransfer":
      return {
        ...state,
        routeMaxSingleTransfer: {
          ...state.routeMaxSingleTransfer,
          [action.route]: action.limit,
        },
      };
  }
}

/** Deterministic XorShift64* PRNG for reproducible sequence exploration. */
class DeterministicPrng {
  private state: bigint;

  constructor(seed: bigint) {
    const mask = (1n << 64n) - 1n;
    const normalized = seed & mask;
    this.state = normalized === 0n ? 0x9e3779b97f4a7c15n : normalized;
  }

  nextU64(): bigint {
    const mask = (1n << 64n) - 1n;
    let x = this.state;
    x = (x ^ (x >> 12n)) & mask;
    x = (x ^ (x << 25n)) & mask;
    x = (x ^ (x >> 27n)) & mask;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & mask;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError("cannot pick from empty array");
    }
    const idx = Number(this.nextU64() % BigInt(items.length));
    const chosen = items[idx];
    if (chosen === undefined) {
      throw new RangeError("index out of bounds");
    }
    return chosen;
  }
}

/**
 * Generate a suite of curated adversarial boundary sequences plus deterministic PRNG-generated
 * administration sequences covering nomination, cancellation, expiration, disable, and execution races.
 */
export function generateTimelockExplorationSuite(
  randomCount = 12,
): readonly GeneratedSequenceSpec[] {
  const curated: GeneratedSequenceSpec[] = [
    {
      name: "exact-eta-and-expiration-boundaries",
      seed: 1n,
      operations: [
        {
          op: "queueAction",
          caller: "admin-1",
          action: { kind: "EnableRoute", route: "axelar-gmp" },
        },
        { op: "advanceTime", deltaSeconds: TIMELOCK_MIN_DELAY_SECONDS - 1n, deltaLedgers: 719 },
        { op: "executeAction", caller: "admin-1", actionId: 1n }, // TimelockNotReady at eta - 1
        { op: "advanceTime", deltaSeconds: 1n, deltaLedgers: 1 },
        { op: "executeAction", caller: "admin-1", actionId: 1n }, // Succeeds at exact eta
        { op: "executeAction", caller: "admin-1", actionId: 1n }, // Duplicate execute -> TimelockNotQueued
        {
          op: "queueAction",
          caller: "admin-1",
          action: { kind: "RaiseTokenFlowLimit", token: DEFAULT_TOKEN, flowLimit: 50_000_000_000n },
        },
        {
          op: "advanceTime",
          deltaSeconds: TIMELOCK_MIN_DELAY_SECONDS + TIMELOCK_GRACE_PERIOD_SECONDS,
          deltaLedgers: 121_680,
        },
        { op: "executeAction", caller: "admin-1", actionId: 2n }, // Succeeds at exact expiresAt
        {
          op: "queueAction",
          caller: "admin-1",
          action: { kind: "Upgrade", wasmHashHex: UPGRADED_WASM_HASH },
        },
        {
          op: "advanceTime",
          deltaSeconds: TIMELOCK_MIN_DELAY_SECONDS + TIMELOCK_GRACE_PERIOD_SECONDS + 1n,
          deltaLedgers: 121_681,
        },
        { op: "executeAction", caller: "admin-1", actionId: 3n }, // Fails at expiresAt + 1
      ],
    },
    {
      name: "admin-and-guardian-handover-revokes-superseded-actors",
      seed: 2n,
      operations: [
        { op: "queueAction", caller: "admin-1", action: { kind: "SetAdmin", newAdmin: "admin-2" } },
        { op: "queueAction", caller: "admin-1", action: { kind: "SetFeeBps", feeBps: 75 } },
        { op: "advanceTime", deltaSeconds: TIMELOCK_MIN_DELAY_SECONDS, deltaLedgers: 720 },
        { op: "executeAction", caller: "admin-1", actionId: 1n }, // Handover to admin-2
        // Superseded admin-1 loses queue, execute, cancel, pause, unpause, disable, and lower-limit powers:
        { op: "executeAction", caller: "admin-1", actionId: 2n },
        {
          op: "queueAction",
          caller: "admin-1",
          action: { kind: "SetTreasury", treasury: "rogue" },
        },
        { op: "cancelAction", caller: "admin-1", actionId: 2n },
        { op: "pause", caller: "admin-1" },
        { op: "disableRoute", caller: "admin-1", route: "cctp" },
        { op: "lowerTokenFlowLimit", caller: "admin-1", token: DEFAULT_TOKEN, newLimit: 1_000n },
        // Guardian-1 cancels admin-1's leftover fee hike; admin-2 rotates guardian to guardian-2:
        { op: "cancelAction", caller: "guardian-1", actionId: 2n },
        { op: "executeAction", caller: "admin-2", actionId: 2n }, // Cancelled -> TimelockNotQueued
        {
          op: "queueAction",
          caller: "admin-2",
          action: { kind: "SetGuardian", newGuardian: "guardian-2" },
        },
        { op: "advanceTime", deltaSeconds: TIMELOCK_MIN_DELAY_SECONDS, deltaLedgers: 720 },
        { op: "executeAction", caller: "admin-2", actionId: 3n },
        // Superseded guardian-1 loses emergency powers; guardian-2 exercises pause:
        { op: "pause", caller: "guardian-1" },
        { op: "disableToken", caller: "guardian-1", token: DEFAULT_TOKEN },
        { op: "pause", caller: "guardian-2" },
        { op: "unpause", caller: "guardian-2" }, // Guardian can never unpause
        { op: "unpause", caller: "admin-2" },
      ],
    },
    {
      name: "delay-change-and-emergency-disable-race",
      seed: 3n,
      operations: [
        // Raise timelock delay to 7200s, then queue an expansion and shorten delay back to 3600s;
        // verify the already-queued expansion still honors its original 7200s eta.
        {
          op: "queueAction",
          caller: "admin-1",
          action: { kind: "SetTimelockDelay", delaySeconds: 7_200n },
        },
        { op: "advanceTime", deltaSeconds: 3_600n, deltaLedgers: 720 },
        { op: "executeAction", caller: "admin-1", actionId: 1n },
        { op: "disableRoute", caller: "guardian-1", route: "cctp" },
        { op: "disableToken", caller: "guardian-1", token: DEFAULT_TOKEN },
        { op: "queueAction", caller: "admin-1", action: { kind: "EnableRoute", route: "cctp" } },
        {
          op: "queueAction",
          caller: "admin-1",
          action: { kind: "SetTimelockDelay", delaySeconds: 3_600n },
        },
        { op: "advanceTime", deltaSeconds: 7_199n, deltaLedgers: 1_439 },
        { op: "executeAction", caller: "admin-1", actionId: 2n }, // Still 1s before 7200s eta!
        { op: "advanceTime", deltaSeconds: 1n, deltaLedgers: 1 },
        { op: "executeAction", caller: "admin-1", actionId: 3n }, // Shorten delay to 3600s
        { op: "executeAction", caller: "admin-1", actionId: 2n }, // Now matured at 7200s
      ],
    },
  ];

  const actors: readonly ActorId[] = [
    "admin-1",
    "admin-2",
    "admin-3",
    "guardian-1",
    "guardian-2",
    "stranger",
  ];
  const routes: readonly RouteSlug[] = ["cctp", "axelar-its", "axelar-gmp", "allbridge"];
  const actions: readonly ExplorerActionPayload[] = [
    { kind: "SetFeeBps", feeBps: 25 },
    { kind: "SetFeeBps", feeBps: 250 }, // invalid -> FeeTooHigh
    { kind: "SetTreasury", treasury: "treasury-rotated" },
    { kind: "SetAdmin", newAdmin: "admin-2" },
    { kind: "SetAdmin", newAdmin: "admin-3" },
    { kind: "SetGuardian", newGuardian: "guardian-2" },
    { kind: "EnableRoute", route: "axelar-gmp" },
    { kind: "EnableRoute", route: "allbridge" },
    { kind: "RegisterToken", token: DEFAULT_TOKEN, decimals: 7, flowLimit: 25_000_000_000n },
    { kind: "RaiseTokenFlowLimit", token: DEFAULT_TOKEN, flowLimit: 40_000_000_000n },
    { kind: "SetTimelockDelay", delaySeconds: 5_400n },
    { kind: "SetTimelockDelay", delaySeconds: 120n }, // invalid -> TimelockDelayOutOfRange
    { kind: "SetFlowWindow", windowLedgers: 1_440 },
    { kind: "Upgrade", wasmHashHex: UPGRADED_WASM_HASH },
    { kind: "SetRouteMaxSingleTransfer", route: "cctp", limit: 5_000_000_000n },
  ];
  const timeDeltas: readonly [bigint, number][] = [
    [1n, 1],
    [1_799n, 360],
    [3_599n, 719],
    [3_600n, 720],
    [5_400n, 1_080],
    [608_401n, 121_681],
  ];

  for (let s = 0; s < randomCount; s += 1) {
    const seed = BigInt(1_000 + s * 37);
    const prng = new DeterministicPrng(seed);
    const ops: ExplorerOperation[] = [];
    for (let step = 0; step < 32; step += 1) {
      const roll = Number(prng.nextU64() % 9n);
      const caller = prng.pick(actors);
      const actionId = (prng.nextU64() % 6n) + 1n;
      switch (roll) {
        case 0:
        case 1:
          ops.push({ op: "queueAction", caller, action: prng.pick(actions) });
          break;
        case 2:
        case 3:
          ops.push({ op: "executeAction", caller, actionId });
          break;
        case 4:
          ops.push({ op: "cancelAction", caller, actionId });
          break;
        case 5: {
          const [sec, led] = prng.pick(timeDeltas);
          ops.push({ op: "advanceTime", deltaSeconds: sec, deltaLedgers: led });
          break;
        }
        case 6:
          ops.push({ op: "pause", caller });
          break;
        case 7:
          ops.push({ op: "disableRoute", caller, route: prng.pick(routes) });
          break;
        default:
          ops.push({
            op: "lowerTokenFlowLimit",
            caller,
            token: DEFAULT_TOKEN,
            newLimit: 1_000_000n + (prng.nextU64() % 5_000_000n),
          });
          break;
      }
    }
    curated.push({
      name: `generated-admin-race-seed-${seed.toString()}`,
      seed,
      operations: ops,
    });
  }

  return curated;
}
