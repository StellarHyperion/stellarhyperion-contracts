/**
 * Isolated local Soroban activation rehearsal workflow with delayed administration.
 *
 * Exercises the full two-phase Stellar operational lifecycle (deploy, queue, early-execution
 * rejection probe, delayed execute, repeated phase-two idempotency check, adapter peer linking,
 * and post-activation record verification) in a deterministic local fixture environment.
 *
 * Rehearsal outputs explicitly identify themselves as `local-fixture-rehearsal` with
 * `signedTestnetAcceptance: false` so local simulations can never be mistaken for signed public
 * testnet acceptance evidence.
 */
import { isStellarAddress } from "../addresses.js";
import { isChainKey, type ChainKey } from "../chains.js";
import {
  DEPLOYMENT_SCHEMA_VERSION,
  parseDeploymentSet,
  type DeploymentSet,
} from "../deployments.js";
import { RouteKind, ROUTE_SLUGS } from "../routes.js";

/** Matches `MIN_TIMELOCK_DELAY` in `soroban/crates/hyperion-router/src/timelock.rs`. */
export const MIN_ROUTER_TIMELOCK_DELAY_SECONDS = 3_600;
/** Matches `MAX_TIMELOCK_DELAY` in `soroban/crates/hyperion-router/src/timelock.rs`. */
export const MAX_ROUTER_TIMELOCK_DELAY_SECONDS = 2_592_000;
/** Matches `GRACE_PERIOD` in `soroban/crates/hyperion-router/src/timelock.rs`. */
export const ROUTER_TIMELOCK_GRACE_PERIOD_SECONDS = 604_800;

export type RehearsalAdminAction =
  | {
      readonly kind: "RegisterToken";
      readonly sacId: string;
      readonly decimals: number;
      readonly flowLimit: string;
    }
  | {
      readonly kind: "SetAdapter";
      readonly route: RouteKind;
      readonly adapter: string;
    }
  | {
      readonly kind: "SetRailReceiver";
      readonly route: RouteKind;
      readonly receiver: string;
    }
  | {
      readonly kind: "EnableRoute";
      readonly route: RouteKind;
    }
  | {
      readonly kind: "SetAdmin";
      readonly admin: string;
    };

export interface RehearsalQueuedEntry {
  readonly id: number;
  readonly label: string;
  readonly action: RehearsalAdminAction;
  readonly queuedAt: number;
  readonly eta: number;
  readonly expiresAt: number;
}

export interface RehearsalAxelarLinkInput {
  readonly adapter: string;
  readonly itsContract: string;
  readonly wasmHash: string;
  readonly peerChain: ChainKey;
  readonly axelarChainName: string;
  /** 20-byte EVM hex peer address (may be zero address for direct ITS recipient delivery). */
  readonly peerHex20: string;
  /** 32-byte hex ITS token id (without or with 0x prefix). */
  readonly tokenIdHex32: string;
}

export interface RehearsalCctpLinkInput {
  readonly adapter: string;
  readonly tokenMessenger: string;
  readonly messageTransmitter: string;
  readonly wasmHash: string;
  readonly peerChain: ChainKey;
  readonly peerDomain: number;
  /** 32-byte hex destination caller (may be zero bytes32 for unrestricted caller). */
  readonly destinationCallerHex32: string;
  /** 32-byte hex burn/remote token identifier on the peer domain. */
  readonly peerBurnTokenHex32: string;
}

export interface StellarActivationRehearsalInput {
  readonly chain?: "stellar-testnet" | "stellar" | undefined;
  readonly networkPassphrase?: string | undefined;
  readonly initialLedger?: number | undefined;
  readonly initialTimestampSeconds?: number | undefined;
  readonly router: string;
  readonly routerWasmHash: string;
  readonly deployer: string;
  readonly finalAdmin?: string | undefined;
  readonly guardian?: string | undefined;
  readonly treasury?: string | undefined;
  readonly feeBps?: number | undefined;
  readonly flowWindowLedgers?: number | undefined;
  readonly timelockDelaySeconds?: number | undefined;
  readonly token: {
    readonly code: string;
    readonly issuer: string;
    readonly sacId: string;
    readonly decimals?: number | undefined;
    readonly flowLimit: string;
  };
  readonly axelar?: RehearsalAxelarLinkInput | undefined;
  readonly cctp?: RehearsalCctpLinkInput | undefined;
  /** Optional index at which the first phase-two execution pass pauses to simulate interruption. */
  readonly interruptPhaseTwoAfterCount?: number | undefined;
  /** Optional extra delay past `eta` before delayed execution runs (default 5 seconds). */
  readonly executeOffsetAfterEtaSeconds?: number | undefined;
  readonly commit?: string | undefined;
}

export interface RehearsalRouterSnapshot {
  readonly admin: string;
  readonly guardian: string;
  readonly treasury: string;
  readonly feeBps: number;
  readonly flowWindowLedgers: number;
  readonly timelockDelaySeconds: number;
  readonly paused: boolean;
  readonly tokens: Readonly<
    Record<
      string,
      {
        readonly decimals: number;
        readonly flowLimit: string;
        readonly enabled: boolean;
      }
    >
  >;
  readonly adapters: Readonly<Partial<Record<RouteKind, string>>>;
  readonly receivers: Readonly<Partial<Record<RouteKind, string>>>;
  readonly enabledRoutes: Readonly<Partial<Record<RouteKind, boolean>>>;
}

export interface EarlyExecutionProbeResult {
  readonly actionId: number;
  readonly attemptedAtSeconds: number;
  readonly etaSeconds: number;
  readonly rejected: boolean;
  readonly errorCode: "TimelockNotReady";
  readonly contractError: "Error(Contract, #23)";
}

export interface PhaseTwoExecutionPassResult {
  readonly passNumber: number;
  readonly caller: string;
  readonly executedAtSeconds: number;
  readonly executedIds: readonly number[];
  readonly skippedIds: readonly number[];
  readonly remainingQueuedIds: readonly number[];
  readonly routerSnapshot: RehearsalRouterSnapshot;
}

export interface RehearsalVerificationCheck {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly matched: boolean;
}

export interface StellarActivationRehearsalReport {
  readonly environment: "local-soroban-rehearsal";
  readonly evidenceKind: "local-fixture-rehearsal";
  readonly signedTestnetAcceptance: false;
  readonly countsAsPublicTestnetDelivery: false;
  readonly bootstrapExemptionAllowed: false;
  readonly evmRailsGated: true;
  readonly healthy: boolean;
  readonly deploymentRecord: DeploymentSet;
  readonly queuedActions: readonly RehearsalQueuedEntry[];
  readonly duplicateQueueProbePreservedIds: boolean;
  readonly earlyExecutionProbes: readonly EarlyExecutionProbeResult[];
  readonly earlyExecutionRejected: boolean;
  readonly phaseTwoPasses: readonly PhaseTwoExecutionPassResult[];
  readonly configurationPreservedOnRepeat: boolean;
  readonly linkedPeers: {
    readonly axelar: {
      readonly peerChain: ChainKey;
      readonly axelarChainName: string;
      readonly peerHex20: string;
      readonly tokenIdHex32: string;
    } | null;
    readonly cctp: {
      readonly peerChain: ChainKey;
      readonly peerDomain: number;
      readonly destinationCallerHex32: string;
      readonly peerBurnTokenHex32: string;
    } | null;
  };
  readonly verificationChecks: readonly RehearsalVerificationCheck[];
  readonly verificationPassed: boolean;
}

function assertStellarContractId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("C") || !isStellarAddress(trimmed)) {
    throw new Error(`${label} must be a valid Soroban C... contract address.`);
  }
  return trimmed;
}

function assertStellarAccountId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("G") || !isStellarAddress(trimmed)) {
    throw new Error(`${label} must be a valid Stellar G... account address.`);
  }
  return trimmed;
}

function assertHexBytes(value: string, byteLength: number, label: string): string {
  const trimmed = value.trim();
  const body = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  const expectedChars = byteLength * 2;
  if (body.length !== expectedChars || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error(
      `${label} must be ${String(byteLength)} bytes (${String(expectedChars)} hex characters).`,
    );
  }
  return body.toLowerCase();
}

function assertDecimalUintString(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be an exact non-negative decimal integer string.`);
  }
  // Parse as bigint to prove arbitrary-precision integer validity above 2^53.
  const parsed = BigInt(trimmed);
  if (parsed < 0n) {
    throw new Error(`${label} cannot be negative.`);
  }
  return parsed.toString(10);
}

function canonicalActionKey(action: RehearsalAdminAction): string {
  switch (action.kind) {
    case "RegisterToken":
      return `RegisterToken:${action.sacId}:${String(action.decimals)}:${action.flowLimit}`;
    case "SetAdapter":
      return `SetAdapter:${String(action.route)}:${action.adapter}`;
    case "SetRailReceiver":
      return `SetRailReceiver:${String(action.route)}:${action.receiver}`;
    case "EnableRoute":
      return `EnableRoute:${String(action.route)}`;
    case "SetAdmin":
      return `SetAdmin:${action.admin}`;
  }
}

interface MutableRouterState {
  admin: string;
  guardian: string;
  treasury: string;
  feeBps: number;
  flowWindowLedgers: number;
  timelockDelaySeconds: number;
  paused: boolean;
  nextQueueId: number;
  queued: Map<number, RehearsalQueuedEntry>;
  tokens: Map<string, { decimals: number; flowLimit: string; enabled: boolean }>;
  adapters: Map<RouteKind, string>;
  receivers: Map<RouteKind, string>;
  enabledRoutes: Map<RouteKind, boolean>;
}

function snapshotRouter(state: MutableRouterState): RehearsalRouterSnapshot {
  const tokens: Record<string, { decimals: number; flowLimit: string; enabled: boolean }> = {};
  for (const [sacId, cfg] of state.tokens.entries()) {
    tokens[sacId] = { ...cfg };
  }
  const adapters: Partial<Record<RouteKind, string>> = {};
  for (const [route, addr] of state.adapters.entries()) {
    adapters[route] = addr;
  }
  const receivers: Partial<Record<RouteKind, string>> = {};
  for (const [route, addr] of state.receivers.entries()) {
    receivers[route] = addr;
  }
  const enabledRoutes: Partial<Record<RouteKind, boolean>> = {};
  for (const [route, enabled] of state.enabledRoutes.entries()) {
    enabledRoutes[route] = enabled;
  }
  return {
    admin: state.admin,
    guardian: state.guardian,
    treasury: state.treasury,
    feeBps: state.feeBps,
    flowWindowLedgers: state.flowWindowLedgers,
    timelockDelaySeconds: state.timelockDelaySeconds,
    paused: state.paused,
    tokens,
    adapters,
    receivers,
    enabledRoutes,
  };
}

function snapshotsEqual(a: RehearsalRouterSnapshot, b: RehearsalRouterSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyAction(state: MutableRouterState, action: RehearsalAdminAction): void {
  switch (action.kind) {
    case "RegisterToken":
      state.tokens.set(action.sacId, {
        decimals: action.decimals,
        flowLimit: action.flowLimit,
        enabled: true,
      });
      return;
    case "SetAdapter":
      state.adapters.set(action.route, action.adapter);
      return;
    case "SetRailReceiver":
      state.receivers.set(action.route, action.receiver);
      return;
    case "EnableRoute":
      state.enabledRoutes.set(action.route, true);
      return;
    case "SetAdmin":
      state.admin = action.admin;
      return;
  }
}

export function executeQueuedActionAtTimestamp(
  queued: RehearsalQueuedEntry,
  nowSeconds: number,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "TimelockNotReady" | "TimelockExpired" } {
  if (nowSeconds < queued.eta) {
    return { ok: false, code: "TimelockNotReady" };
  }
  if (nowSeconds > queued.expiresAt) {
    return { ok: false, code: "TimelockExpired" };
  }
  return { ok: true };
}

export function runLocalStellarActivationRehearsal(
  input: StellarActivationRehearsalInput,
): StellarActivationRehearsalReport {
  const chainKey = input.chain ?? "stellar-testnet";
  const networkPassphrase =
    input.networkPassphrase ??
    (chainKey === "stellar"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015");
  const initialLedger = input.initialLedger ?? 100_000;
  const initialTimestamp = input.initialTimestampSeconds ?? 1_793_192_700;
  if (!Number.isInteger(initialLedger) || initialLedger < 1) {
    throw new Error("initialLedger must be a positive integer.");
  }
  if (!Number.isInteger(initialTimestamp) || initialTimestamp < 1) {
    throw new Error("initialTimestampSeconds must be a positive integer.");
  }

  const router = assertStellarContractId(input.router, "router");
  const routerWasmHash = assertHexBytes(input.routerWasmHash, 32, "routerWasmHash");
  const deployer = assertStellarAccountId(input.deployer, "deployer");
  const finalAdmin = assertStellarAccountId(input.finalAdmin ?? deployer, "finalAdmin");
  const guardian = assertStellarAccountId(input.guardian ?? deployer, "guardian");
  const treasury = assertStellarAccountId(input.treasury ?? deployer, "treasury");

  const feeBps = input.feeBps ?? 30;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1_000) {
    throw new Error("feeBps must be an integer in [0, 1000] (FeeTooHigh).");
  }
  const flowWindowLedgers = input.flowWindowLedgers ?? 720;
  if (!Number.isInteger(flowWindowLedgers) || flowWindowLedgers < 1) {
    throw new Error("flowWindowLedgers must be a positive integer (InvalidWindow).");
  }
  const timelockDelay = input.timelockDelaySeconds ?? MIN_ROUTER_TIMELOCK_DELAY_SECONDS;
  if (
    !Number.isInteger(timelockDelay) ||
    timelockDelay < MIN_ROUTER_TIMELOCK_DELAY_SECONDS ||
    timelockDelay > MAX_ROUTER_TIMELOCK_DELAY_SECONDS
  ) {
    throw new Error(
      `timelockDelaySeconds (${String(timelockDelay)}) violates Soroban router bounds [${String(MIN_ROUTER_TIMELOCK_DELAY_SECONDS)}, ${String(MAX_ROUTER_TIMELOCK_DELAY_SECONDS)}] (TimelockDelayOutOfRange); bootstrap exemptions are forbidden.`,
    );
  }

  const tokenCode = input.token.code.trim();
  if (tokenCode.length === 0 || tokenCode.length > 12) {
    throw new Error("token.code must be 1..12 characters.");
  }
  const tokenIssuer = assertStellarAccountId(input.token.issuer, "token.issuer");
  const tokenSacId = assertStellarContractId(input.token.sacId, "token.sacId");
  const tokenDecimals = input.token.decimals ?? 7;
  if (tokenDecimals !== 7) {
    throw new Error("Stellar SAC rehearsal token.decimals must be 7.");
  }
  const tokenFlowLimit = assertDecimalUintString(input.token.flowLimit, "token.flowLimit");

  if (input.axelar === undefined && input.cctp === undefined) {
    throw new Error(
      "At least one outbound rail (axelar or cctp) must be configured for rehearsal.",
    );
  }

  // Validate adapter configs up front before mutating local state.
  const axelarCfg =
    input.axelar !== undefined
      ? {
          adapter: assertStellarContractId(input.axelar.adapter, "axelar.adapter"),
          itsContract: assertStellarContractId(input.axelar.itsContract, "axelar.itsContract"),
          wasmHash: assertHexBytes(input.axelar.wasmHash, 32, "axelar.wasmHash"),
          peerChain: input.axelar.peerChain,
          axelarChainName: input.axelar.axelarChainName.trim(),
          peerHex20: assertHexBytes(input.axelar.peerHex20, 20, "axelar.peerHex20"),
          tokenIdHex32: assertHexBytes(input.axelar.tokenIdHex32, 32, "axelar.tokenIdHex32"),
        }
      : null;
  if (axelarCfg !== null) {
    if (!isChainKey(axelarCfg.peerChain)) {
      throw new Error(`Unknown axelar.peerChain "${String(axelarCfg.peerChain)}".`);
    }
    if (axelarCfg.axelarChainName.length === 0) {
      throw new Error("axelar.axelarChainName must be non-empty.");
    }
  }

  const cctpCfg =
    input.cctp !== undefined
      ? {
          adapter: assertStellarContractId(input.cctp.adapter, "cctp.adapter"),
          tokenMessenger: assertStellarContractId(input.cctp.tokenMessenger, "cctp.tokenMessenger"),
          messageTransmitter: assertStellarContractId(
            input.cctp.messageTransmitter,
            "cctp.messageTransmitter",
          ),
          wasmHash: assertHexBytes(input.cctp.wasmHash, 32, "cctp.wasmHash"),
          peerChain: input.cctp.peerChain,
          peerDomain: input.cctp.peerDomain,
          destinationCallerHex32: assertHexBytes(
            input.cctp.destinationCallerHex32,
            32,
            "cctp.destinationCallerHex32",
          ),
          peerBurnTokenHex32: assertHexBytes(
            input.cctp.peerBurnTokenHex32,
            32,
            "cctp.peerBurnTokenHex32",
          ),
        }
      : null;
  if (cctpCfg !== null) {
    if (!isChainKey(cctpCfg.peerChain)) {
      throw new Error(`Unknown cctp.peerChain "${String(cctpCfg.peerChain)}".`);
    }
    if (!Number.isInteger(cctpCfg.peerDomain) || cctpCfg.peerDomain < 0) {
      throw new Error("cctp.peerDomain must be a non-negative integer.");
    }
  }

  // Stage 1: Deploy and initialize router (admin starts as deployer, matching deploy.sh).
  const routerState: MutableRouterState = {
    admin: deployer,
    guardian,
    treasury,
    feeBps,
    flowWindowLedgers,
    timelockDelaySeconds: timelockDelay,
    paused: false,
    nextQueueId: 1,
    queued: new Map(),
    tokens: new Map(),
    adapters: new Map(),
    receivers: new Map(),
    enabledRoutes: new Map(),
  };

  let clockSeconds = initialTimestamp;

  const desiredActions: { readonly label: string; readonly action: RehearsalAdminAction }[] = [
    {
      label: `register ${tokenCode}`,
      action: {
        kind: "RegisterToken",
        sacId: tokenSacId,
        decimals: tokenDecimals,
        flowLimit: tokenFlowLimit,
      },
    },
  ];

  const routeSlugs: string[] = [];
  const adaptersRecord: Record<string, string> = {};
  const wasmHashesRecord: Record<string, string> = { router: routerWasmHash };

  if (cctpCfg !== null) {
    routeSlugs.push(ROUTE_SLUGS[RouteKind.Cctp]);
    adaptersRecord[ROUTE_SLUGS[RouteKind.Cctp]] = cctpCfg.adapter;
    wasmHashesRecord["adapter-cctp"] = cctpCfg.wasmHash;
    desiredActions.push(
      {
        label: "set cctp adapter",
        action: { kind: "SetAdapter", route: RouteKind.Cctp, adapter: cctpCfg.adapter },
      },
      {
        label: "set cctp receiver",
        action: { kind: "SetRailReceiver", route: RouteKind.Cctp, receiver: cctpCfg.adapter },
      },
      {
        label: "enable cctp",
        action: { kind: "EnableRoute", route: RouteKind.Cctp },
      },
    );
  }

  if (axelarCfg !== null) {
    routeSlugs.push(ROUTE_SLUGS[RouteKind.AxelarIts]);
    adaptersRecord[ROUTE_SLUGS[RouteKind.AxelarIts]] = axelarCfg.adapter;
    wasmHashesRecord["adapter-axelar"] = axelarCfg.wasmHash;
    desiredActions.push(
      {
        label: "set axelar adapter",
        action: { kind: "SetAdapter", route: RouteKind.AxelarIts, adapter: axelarCfg.adapter },
      },
      {
        label: "set axelar receiver",
        action: {
          kind: "SetRailReceiver",
          route: RouteKind.AxelarIts,
          receiver: axelarCfg.adapter,
        },
      },
      {
        label: "enable axelar its",
        action: { kind: "EnableRoute", route: RouteKind.AxelarIts },
      },
    );
  }

  if (finalAdmin !== deployer) {
    desiredActions.push({
      label: "hand admin to the real holder",
      action: { kind: "SetAdmin", admin: finalAdmin },
    });
  }

  const queueOrReuse = (label: string, action: RehearsalAdminAction, now: number): number => {
    const wantedKey = canonicalActionKey(action);
    for (const existing of routerState.queued.values()) {
      if (canonicalActionKey(existing.action) === wantedKey) {
        return existing.id;
      }
    }
    const id = routerState.nextQueueId;
    routerState.nextQueueId += 1;
    const entry: RehearsalQueuedEntry = {
      id,
      label,
      action,
      queuedAt: now,
      eta: now + routerState.timelockDelaySeconds,
      expiresAt: now + routerState.timelockDelaySeconds + ROUTER_TIMELOCK_GRACE_PERIOD_SECONDS,
    };
    routerState.queued.set(id, entry);
    return id;
  };

  const queuedIdsFirstPass: number[] = [];
  for (const item of desiredActions) {
    clockSeconds += 5;
    queuedIdsFirstPass.push(queueOrReuse(item.label, item.action, clockSeconds));
  }
  const queuedActionsSnapshot: readonly RehearsalQueuedEntry[] = Array.from(
    routerState.queued.values(),
  );

  // Re-running phase-one queue logic (`pending_id_for`) must reuse existing pending IDs rather than
  // creating duplicate timelock entries.
  const queuedIdsSecondPass = desiredActions.map((item) =>
    queueOrReuse(item.label, item.action, clockSeconds + 10),
  );
  const duplicateQueueProbePreservedIds =
    JSON.stringify(queuedIdsFirstPass) === JSON.stringify(queuedIdsSecondPass) &&
    routerState.queued.size === desiredActions.length;

  // Stage 2a: Prove early execution is rejected without any bootstrap exemption.
  const firstAction = queuedActionsSnapshot[0];
  if (firstAction === undefined) {
    throw new Error("Rehearsal queued zero actions.");
  }
  const lastAction = queuedActionsSnapshot[queuedActionsSnapshot.length - 1] ?? firstAction;

  const probeTimestamps = [firstAction.queuedAt, lastAction.eta - 1];
  const earlyExecutionProbes: EarlyExecutionProbeResult[] = [];
  for (const probeTs of probeTimestamps) {
    const target = probeTs < firstAction.eta ? firstAction : lastAction;
    const verdict = executeQueuedActionAtTimestamp(target, probeTs);
    if (verdict.ok || verdict.code !== "TimelockNotReady") {
      throw new Error("Unexpectedly allowed execution prior to timelock maturity.");
    }
    earlyExecutionProbes.push({
      actionId: target.id,
      attemptedAtSeconds: probeTs,
      etaSeconds: target.eta,
      rejected: true,
      errorCode: "TimelockNotReady",
      contractError: "Error(Contract, #23)",
    });
  }
  const earlyExecutionRejected =
    earlyExecutionProbes.every((p) => p.rejected) &&
    routerState.tokens.size === 0 &&
    routerState.enabledRoutes.size === 0;

  // Stage 2b: Advance clock past maturity and run phase-two execution, then repeat phase-two to
  // prove idempotent preservation of router configuration.
  const offsetSeconds = input.executeOffsetAfterEtaSeconds ?? 5;
  if (!Number.isInteger(offsetSeconds) || offsetSeconds < 0) {
    throw new Error("executeOffsetAfterEtaSeconds must be a non-negative integer.");
  }
  const executeTimestamp = lastAction.eta + offsetSeconds;
  const phaseTwoPasses: PhaseTwoExecutionPassResult[] = [];

  const runExecutePass = (
    passNumber: number,
    caller: string,
    atSeconds: number,
    stopAfterExecutedCount?: number,
  ): PhaseTwoExecutionPassResult => {
    const executedIds: number[] = [];
    const skippedIds: number[] = [];
    for (const id of queuedIdsFirstPass) {
      if (stopAfterExecutedCount !== undefined && executedIds.length >= stopAfterExecutedCount) {
        break;
      }
      const pending = routerState.queued.get(id);
      if (pending === undefined) {
        skippedIds.push(id);
        continue;
      }
      if (caller !== routerState.admin) {
        throw new Error(`Unauthorized caller ${caller}; router admin is ${routerState.admin}.`);
      }
      const check = executeQueuedActionAtTimestamp(pending, atSeconds);
      if (!check.ok) {
        throw new Error(
          `Queued action ${String(id)} (${pending.label}) failed with ${check.code} at ${String(atSeconds)}.`,
        );
      }
      routerState.queued.delete(id);
      applyAction(routerState, pending.action);
      executedIds.push(id);
    }
    return {
      passNumber,
      caller,
      executedAtSeconds: atSeconds,
      executedIds,
      skippedIds,
      remainingQueuedIds: Array.from(routerState.queued.keys()),
      routerSnapshot: snapshotRouter(routerState),
    };
  };

  let passCounter = 1;
  if (
    input.interruptPhaseTwoAfterCount !== undefined &&
    input.interruptPhaseTwoAfterCount > 0 &&
    input.interruptPhaseTwoAfterCount < queuedIdsFirstPass.length
  ) {
    phaseTwoPasses.push(
      runExecutePass(passCounter, deployer, executeTimestamp, input.interruptPhaseTwoAfterCount),
    );
    passCounter += 1;
  }

  const completionPass = runExecutePass(passCounter, deployer, executeTimestamp + 5);
  phaseTwoPasses.push(completionPass);
  passCounter += 1;

  // Repeated phase-two run after all actions (including any SetAdmin handover) have landed.
  // Because `execute.sh` checks `get_queued --id` before invoking `execute_action`, re-running
  // skips every completed ID cleanly and leaves router state unchanged.
  const repeatPass = runExecutePass(passCounter, routerState.admin, executeTimestamp + 15);
  phaseTwoPasses.push(repeatPass);

  const configurationPreservedOnRepeat =
    repeatPass.executedIds.length === 0 &&
    repeatPass.skippedIds.length === queuedIdsFirstPass.length &&
    snapshotsEqual(completionPass.routerSnapshot, repeatPass.routerSnapshot);

  // Stage 3: Build & validate local deployment record via `parseDeploymentSet` (same schema gate
  // as `write-record.mjs` and `verify.sh`).
  const rawRecord = {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    generatedAt: new Date(executeTimestamp * 1_000).toISOString(),
    networks: {
      [chainKey]: {
        family: "stellar",
        networkPassphrase,
        router,
        adapters: adaptersRecord,
        tokens: {
          [tokenCode]: {
            sacId: tokenSacId,
            code: tokenCode,
            issuer: tokenIssuer,
            decimals: tokenDecimals,
            flowLimit: tokenFlowLimit,
            routes: routeSlugs,
          },
        },
        treasury,
        admin: finalAdmin,
        guardian,
        feeBps,
        flowWindow: flowWindowLedgers,
        timelockDelay,
        wasmHashes: wasmHashesRecord,
        deployedAt: {
          ledger: initialLedger,
          timestamp: new Date(initialTimestamp * 1_000).toISOString(),
        },
        commit: input.commit ?? "local-rehearsal",
      },
    },
  };
  const deploymentRecord = parseDeploymentSet(rawRecord);

  // Stage 4: Link peers and verify live rehearsal state against the parsed record.
  const linkedPeers = {
    axelar:
      axelarCfg !== null
        ? {
            peerChain: axelarCfg.peerChain,
            axelarChainName: axelarCfg.axelarChainName,
            peerHex20: axelarCfg.peerHex20,
            tokenIdHex32: axelarCfg.tokenIdHex32,
          }
        : null,
    cctp:
      cctpCfg !== null
        ? {
            peerChain: cctpCfg.peerChain,
            peerDomain: cctpCfg.peerDomain,
            destinationCallerHex32: cctpCfg.destinationCallerHex32,
            peerBurnTokenHex32: cctpCfg.peerBurnTokenHex32,
          }
        : null,
  };

  const finalSnap = repeatPass.routerSnapshot;
  const tokenSnap = finalSnap.tokens[tokenSacId];
  const verificationChecks: RehearsalVerificationCheck[] = [
    {
      name: "router.admin",
      expected: finalAdmin,
      actual: finalSnap.admin,
      matched: finalSnap.admin === finalAdmin,
    },
    {
      name: "router.guardian",
      expected: guardian,
      actual: finalSnap.guardian,
      matched: finalSnap.guardian === guardian,
    },
    {
      name: "router.treasury",
      expected: treasury,
      actual: finalSnap.treasury,
      matched: finalSnap.treasury === treasury,
    },
    {
      name: "router.feeBps",
      expected: String(feeBps),
      actual: String(finalSnap.feeBps),
      matched: finalSnap.feeBps === feeBps,
    },
    {
      name: "router.flowWindowLedgers",
      expected: String(flowWindowLedgers),
      actual: String(finalSnap.flowWindowLedgers),
      matched: finalSnap.flowWindowLedgers === flowWindowLedgers,
    },
    {
      name: "router.timelockDelay",
      expected: String(timelockDelay),
      actual: String(finalSnap.timelockDelaySeconds),
      matched: finalSnap.timelockDelaySeconds === timelockDelay,
    },
    {
      name: "router.paused",
      expected: "false",
      actual: String(finalSnap.paused),
      matched: !finalSnap.paused,
    },
    {
      name: `token.${tokenCode}.enabled`,
      expected: "true",
      actual: String(tokenSnap?.enabled ?? false),
      matched: tokenSnap?.enabled === true,
    },
    {
      name: `token.${tokenCode}.decimals`,
      expected: "7",
      actual: String(tokenSnap?.decimals ?? -1),
      matched: tokenSnap?.decimals === 7,
    },
    {
      name: `token.${tokenCode}.flowLimit`,
      expected: tokenFlowLimit,
      actual: tokenSnap?.flowLimit ?? "",
      matched: tokenSnap?.flowLimit === tokenFlowLimit,
    },
  ];

  if (cctpCfg !== null) {
    verificationChecks.push(
      {
        name: "rails.cctp.adapter",
        expected: cctpCfg.adapter,
        actual: finalSnap.adapters[RouteKind.Cctp] ?? "",
        matched: finalSnap.adapters[RouteKind.Cctp] === cctpCfg.adapter,
      },
      {
        name: "rails.cctp.receiver",
        expected: cctpCfg.adapter,
        actual: finalSnap.receivers[RouteKind.Cctp] ?? "",
        matched: finalSnap.receivers[RouteKind.Cctp] === cctpCfg.adapter,
      },
      {
        name: "rails.cctp.enabled",
        expected: "true",
        actual: String(finalSnap.enabledRoutes[RouteKind.Cctp] ?? false),
        matched: finalSnap.enabledRoutes[RouteKind.Cctp] === true,
      },
    );
  }

  if (axelarCfg !== null) {
    verificationChecks.push(
      {
        name: "rails.axelar-its.adapter",
        expected: axelarCfg.adapter,
        actual: finalSnap.adapters[RouteKind.AxelarIts] ?? "",
        matched: finalSnap.adapters[RouteKind.AxelarIts] === axelarCfg.adapter,
      },
      {
        name: "rails.axelar-its.receiver",
        expected: axelarCfg.adapter,
        actual: finalSnap.receivers[RouteKind.AxelarIts] ?? "",
        matched: finalSnap.receivers[RouteKind.AxelarIts] === axelarCfg.adapter,
      },
      {
        name: "rails.axelar-its.enabled",
        expected: "true",
        actual: String(finalSnap.enabledRoutes[RouteKind.AxelarIts] ?? false),
        matched: finalSnap.enabledRoutes[RouteKind.AxelarIts] === true,
      },
    );
  }

  const verificationPassed = verificationChecks.every((c) => c.matched);
  const healthy =
    duplicateQueueProbePreservedIds &&
    earlyExecutionRejected &&
    configurationPreservedOnRepeat &&
    verificationPassed;

  return {
    environment: "local-soroban-rehearsal",
    evidenceKind: "local-fixture-rehearsal",
    signedTestnetAcceptance: false,
    countsAsPublicTestnetDelivery: false,
    bootstrapExemptionAllowed: false,
    evmRailsGated: true,
    healthy,
    deploymentRecord,
    queuedActions: queuedActionsSnapshot,
    duplicateQueueProbePreservedIds,
    earlyExecutionProbes,
    earlyExecutionRejected,
    phaseTwoPasses,
    configurationPreservedOnRepeat,
    linkedPeers,
    verificationChecks,
    verificationPassed,
  };
}

export function isLocalRehearsalEvidence(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.evidenceKind === "local-fixture-rehearsal" &&
    rec.signedTestnetAcceptance === false &&
    rec.countsAsPublicTestnetDelivery === false
  );
}

export function formatRehearsalReport(report: StellarActivationRehearsalReport): string {
  const lines: string[] = [
    "LOCAL FIXTURE REHEARSAL REPORT (NOT SIGNED TESTNET ACCEPTANCE)",
    `evidenceKind=${report.evidenceKind} signedTestnetAcceptance=${String(report.signedTestnetAcceptance)} evmRailsGated=${String(report.evmRailsGated)} healthy=${String(report.healthy)}`,
    `queuedActions=${String(report.queuedActions.length)} duplicateQueuePreserved=${String(report.duplicateQueueProbePreservedIds)}`,
    `earlyExecutionRejected=${String(report.earlyExecutionRejected)} bootstrapExemptionAllowed=${String(report.bootstrapExemptionAllowed)}`,
    `phaseTwoPasses=${String(report.phaseTwoPasses.length)} configurationPreservedOnRepeat=${String(report.configurationPreservedOnRepeat)}`,
    `verificationPassed=${String(report.verificationPassed)} checks=${String(report.verificationChecks.length)}`,
  ];
  for (const probe of report.earlyExecutionProbes) {
    lines.push(
      `[early-probe] id=${String(probe.actionId)} at=${String(probe.attemptedAtSeconds)} eta=${String(probe.etaSeconds)} -> ${probe.errorCode} (${probe.contractError})`,
    );
  }
  for (const check of report.verificationChecks) {
    lines.push(
      `[${check.matched ? "ok" : "BAD"}] ${check.name}: actual=${check.actual} expected=${check.expected}`,
    );
  }
  return lines.join("\n");
}
