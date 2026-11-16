/**
 * Stateful cross-chain reference model for `HyperionRouter` (Soroban and EVM).
 *
 * Models outbound dispatch (including decimal flooring dust retention and paid-gas rails),
 * global and route-scoped pause controls, immediate safety narrowing vs timelocked administration,
 * authenticated inbound rail delivery with `(route, messageId)` replay protection, and
 * recipient-bound parked claims.
 *
 * Pure `bigint` and plain data structures only -- no Node globals or floating-point arithmetic.
 */

import { RouteKind } from "./routes.js";

export type RouterChainProfile = "soroban" | "evm";

export type ModelActorRole =
  | "admin"
  | "guardian"
  | "alice"
  | "bob"
  | "stranger"
  | "rail_cctp"
  | "rail_its"
  | "rail_gmp"
  | "rail_allbridge";

export type ModelAccountId =
  | ModelActorRole
  | "recipient_a"
  | "recipient_b"
  | "treasury"
  | "treasury_alt"
  | "router"
  | "adapter_cctp"
  | "adapter_its"
  | "adapter_gmp"
  | "adapter_allbridge";

export type ModelDestinationKind = "account" | "contract" | "muxed";

export interface RouterClockState {
  /** Wall-clock UNIX timestamp in seconds (`env.ledger().timestamp()` / `block.timestamp`). */
  readonly timestampSeconds: bigint;
  /** Soroban ledger sequence number (`env.ledger().sequence()`); unused for decay on EVM. */
  readonly ledgerSequence: bigint;
  /** EVM block height (`block.number`); never drives flow decay or timelock maturity. */
  readonly blockNumber: bigint;
}

export interface ModelFlowWindow {
  readonly epoch: bigint;
  readonly consumed: bigint;
  readonly prevConsumed: bigint;
}

export interface ModelPendingClaim {
  readonly id: bigint;
  readonly recipient: ModelAccountId;
  readonly amount: bigint;
  readonly route: RouteKind;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  readonly createdAt: bigint;
  readonly settled: boolean;
}

export type ModelAdminAction =
  | { readonly kind: "SetFeeBps"; readonly feeBps: bigint }
  | { readonly kind: "SetTreasury"; readonly treasury: ModelAccountId }
  | { readonly kind: "EnableRoute"; readonly route: RouteKind; readonly enabled: boolean }
  | { readonly kind: "RaiseTokenFlowLimit"; readonly limit: bigint }
  | { readonly kind: "SetRouteFlowLimit"; readonly route: RouteKind; readonly limit: bigint }
  | { readonly kind: "SetTimelockDelay"; readonly delaySeconds: bigint }
  | { readonly kind: "SetFlowWindow"; readonly windowUnits: bigint }
  | { readonly kind: "SetTokenEnabled"; readonly enabled: boolean }
  | {
      readonly kind: "SetRouteMaxSingleTransfer";
      readonly route: RouteKind;
      readonly maxAmount: bigint;
    };

export interface ModelQueuedAction {
  readonly id: bigint;
  readonly action: ModelAdminAction;
  readonly queuedAt: bigint;
  readonly eta: bigint;
  readonly expiresAt: bigint;
  readonly executed: boolean;
}

export interface RouterModelConfig {
  readonly chain: RouterChainProfile;
  readonly sourceDecimals: number;
  readonly destinationDecimals: number;
  readonly initialFeeBps?: bigint;
  readonly initialTimelockDelaySeconds?: bigint;
  /** Ledgers on Soroban (default `720n`), seconds on EVM (default `3600n`). */
  readonly initialFlowWindowUnits?: bigint;
  readonly initialTokenFlowLimit?: bigint;
  readonly initialTimestampSeconds?: bigint;
  readonly initialLedgerSequence?: bigint;
  readonly initialBlockNumber?: bigint;
  readonly initialAliceBalance?: bigint;
  readonly initialBobBalance?: bigint;
  readonly initialRailBalancePerRoute?: bigint;
}

export interface RouterModelState {
  readonly chain: RouterChainProfile;
  readonly clock: RouterClockState;
  readonly sourceDecimals: number;
  readonly destinationDecimals: number;
  readonly paused: boolean;
  readonly treasury: ModelAccountId;
  readonly feeBps: bigint;
  readonly timelockDelaySeconds: bigint;
  /** Ledgers when `chain === "soroban"`, seconds when `chain === "evm"`. */
  readonly flowWindowUnits: bigint;
  readonly tokenRegistered: boolean;
  readonly tokenEnabled: boolean;
  readonly tokenFlowLimit: bigint;
  readonly routeEnabled: Readonly<Record<RouteKind, boolean>>;
  readonly routePaused: Readonly<Record<RouteKind, boolean>>;
  readonly adapterConfigured: Readonly<Record<RouteKind, boolean>>;
  readonly railReceiver: Readonly<Record<RouteKind, ModelActorRole | null>>;
  readonly routeFlowLimit: Readonly<Partial<Record<RouteKind, bigint>>>;
  readonly routeMaxSingleTransfer: Readonly<Partial<Record<RouteKind, bigint>>>;
  readonly flowWindows: Readonly<Record<RouteKind, ModelFlowWindow>>;
  readonly outboundNonce: bigint;
  readonly claimCount: bigint;
  readonly actionCount: bigint;
  readonly processedMessages: ReadonlySet<string>;
  readonly claims: ReadonlyMap<bigint, ModelPendingClaim>;
  /** Initial immutable snapshots of claims at creation time for fixed-liability verification. */
  readonly claimCreationSnapshots: ReadonlyMap<bigint, ModelPendingClaim>;
  readonly queuedActions: ReadonlyMap<bigint, ModelQueuedAction>;
  readonly frozenAccounts: ReadonlySet<ModelAccountId>;
  readonly balances: Readonly<Record<ModelAccountId, bigint>>;
  readonly initialTotalSupply: bigint;
  readonly cumulativeFeesCollected: bigint;
}

export type RouterOperation =
  | { readonly type: "AdvanceTime"; readonly seconds: bigint }
  | { readonly type: "AdvanceLedgers"; readonly ledgers: bigint }
  | { readonly type: "AdvanceBlocks"; readonly blocks: bigint }
  | {
      readonly type: "SetAccountFrozen";
      readonly account: ModelAccountId;
      readonly frozen: boolean;
    }
  | {
      readonly type: "BridgeOut";
      readonly caller: "alice" | "bob";
      readonly route: RouteKind;
      readonly amount: bigint;
      readonly minDestinationAmount: bigint;
      readonly destinationChain: string;
      readonly destinationKind: ModelDestinationKind;
    }
  | {
      readonly type: "BridgeOutWithGas";
      readonly caller: "alice" | "bob";
      readonly route: RouteKind;
      readonly amount: bigint;
      readonly gasAmount: bigint;
      readonly minDestinationAmount: bigint;
      readonly destinationChain: string;
      readonly destinationKind: ModelDestinationKind;
    }
  | {
      readonly type: "BridgeIn";
      readonly caller: ModelActorRole;
      readonly route: RouteKind;
      readonly amount: bigint;
      readonly recipient: "recipient_a" | "recipient_b";
      readonly recipientKind: ModelDestinationKind;
      readonly sourceChain: string;
      readonly sourceNonce: bigint;
      readonly messageId: string;
    }
  | {
      readonly type: "SettleClaim";
      readonly caller: ModelActorRole;
      readonly claimId: bigint;
    }
  | { readonly type: "Pause"; readonly caller: ModelActorRole }
  | { readonly type: "Unpause"; readonly caller: ModelActorRole }
  | { readonly type: "PauseRoute"; readonly caller: ModelActorRole; readonly route: RouteKind }
  | { readonly type: "UnpauseRoute"; readonly caller: ModelActorRole; readonly route: RouteKind }
  | { readonly type: "DisableRoute"; readonly caller: ModelActorRole; readonly route: RouteKind }
  | { readonly type: "DisableToken"; readonly caller: ModelActorRole }
  | {
      readonly type: "LowerTokenFlowLimit";
      readonly caller: ModelActorRole;
      readonly limit: bigint;
    }
  | {
      readonly type: "QueueAction";
      readonly caller: ModelActorRole;
      readonly action: ModelAdminAction;
    }
  | {
      readonly type: "ExecuteAction";
      readonly caller: ModelActorRole;
      readonly actionId: bigint;
    }
  | {
      readonly type: "CancelAction";
      readonly caller: ModelActorRole;
      readonly actionId: bigint;
    };

export type RouterErrorCode =
  | "Paused"
  | "RouteIsPaused"
  | "RouteDisabled"
  | "AdapterNotSet"
  | "TokenNotRegistered"
  | "TokenDisabled"
  | "InvalidAmount"
  | "UnknownChain"
  | "MuxedNotSupported"
  | "AmountNotRepresentable"
  | "ExceedsRouteLimit"
  | "SlippageExceeded"
  | "FlowLimitExceeded"
  | "InsufficientSenderBalance"
  | "AccountFrozen"
  | "UnsupportedOperation"
  | "NotRailReceiver"
  | "ReplayedMessage"
  | "InsufficientRailBalance"
  | "ClaimNotFound"
  | "ClaimAlreadySettled"
  | "RecipientNotReady"
  | "Unauthorized"
  | "InvalidLimit"
  | "LimitNotRaised"
  | "FeeTooHigh"
  | "TimelockDelayOutOfRange"
  | "InvalidWindow"
  | "TimelockNotQueued"
  | "TimelockAlreadyExecuted"
  | "TimelockNotReady"
  | "TimelockExpired";

export type RouterStepOutcome =
  | {
      readonly ok: true;
      readonly value?: bigint;
      readonly feePaid?: bigint;
      readonly netBridged?: bigint;
      readonly dustRetained?: bigint;
    }
  | {
      readonly ok: false;
      readonly error: RouterErrorCode;
    };

export interface RouterStepResult {
  readonly state: RouterModelState;
  readonly outcome: RouterStepOutcome;
}

export interface RouterInvariantCheck {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

export interface RouterStepTrace {
  readonly stepIndex: number;
  readonly operation: RouterOperation;
  readonly clockBefore: RouterClockState;
  readonly clockAfter: RouterClockState;
  readonly outcome: RouterStepOutcome;
  readonly routerEscrowAfter: bigint;
  readonly treasuryBalanceAfter: bigint;
  readonly unsettledClaimCountAfter: number;
  readonly flowAvailableCctpAfter: bigint;
}

export interface RouterSequenceRunResult {
  readonly initialState: RouterModelState;
  readonly finalState: RouterModelState;
  readonly traces: readonly RouterStepTrace[];
  readonly invariantFailure: {
    readonly stepIndex: number;
    readonly violations: readonly string[];
  } | null;
}

export type SequenceCheckOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failedStepIndex: number;
      readonly reason: string;
    };

export interface MinimalRouterTrace {
  readonly chain: RouterChainProfile;
  readonly originalLength: number;
  readonly minimalLength: number;
  readonly failedStepIndex: number;
  readonly failureReason: string;
  readonly operations: readonly RouterOperation[];
  readonly stepTraces: readonly RouterStepTrace[];
  readonly formattedTrace: string;
}

export const MODEL_BPS_DENOMINATOR = 10_000n;
export const MODEL_MAX_FEE_BPS = 100n;
export const MODEL_MIN_TIMELOCK_DELAY = 3_600n;
export const MODEL_MAX_TIMELOCK_DELAY = 2_592_000n;
export const MODEL_TIMELOCK_GRACE_PERIOD = 604_800n;
export const MODEL_EVM_MIN_FLOW_WINDOW_SECONDS = 300n;
export const MODEL_EVM_MAX_FLOW_WINDOW_SECONDS = 604_800n;
export const MODEL_DEFAULT_SOROBAN_FLOW_WINDOW_LEDGERS = 720n;
export const MODEL_DEFAULT_EVM_FLOW_WINDOW_SECONDS = 3_600n;

const ALL_ACCOUNTS: readonly ModelAccountId[] = [
  "admin",
  "guardian",
  "alice",
  "bob",
  "stranger",
  "rail_cctp",
  "rail_its",
  "rail_gmp",
  "rail_allbridge",
  "recipient_a",
  "recipient_b",
  "treasury",
  "treasury_alt",
  "router",
  "adapter_cctp",
  "adapter_its",
  "adapter_gmp",
  "adapter_allbridge",
];

function adapterAccountFor(route: RouteKind): ModelAccountId {
  switch (route) {
    case RouteKind.Cctp:
      return "adapter_cctp";
    case RouteKind.AxelarIts:
      return "adapter_its";
    case RouteKind.AxelarGmp:
      return "adapter_gmp";
    case RouteKind.Allbridge:
      return "adapter_allbridge";
  }
}

function pow10(exp: number): bigint {
  return 10n ** BigInt(exp);
}

/**
 * Return the active flow-window clock value for the given chain profile.
 *
 * - Soroban: `ledgerSequence` (ledger count).
 * - EVM: `timestampSeconds` (`block.timestamp`).
 */
export function activeFlowClock(state: Pick<RouterModelState, "chain" | "clock">): bigint {
  return state.chain === "soroban" ? state.clock.ledgerSequence : state.clock.timestampSeconds;
}

function rollFlowForward(
  window: ModelFlowWindow,
  clock: bigint,
  windowSize: bigint,
): ModelFlowWindow {
  const epoch = clock / windowSize;
  if (epoch === window.epoch) {
    return window;
  }
  if (epoch === window.epoch + 1n) {
    return {
      epoch,
      consumed: 0n,
      prevConsumed: window.consumed,
    };
  }
  return {
    epoch,
    consumed: 0n,
    prevConsumed: 0n,
  };
}

function effectiveFlowConsumed(window: ModelFlowWindow, clock: bigint, windowSize: bigint): bigint {
  const rolled = rollFlowForward(window, clock, windowSize);
  const remaining = windowSize - (clock % windowSize);
  return (rolled.prevConsumed * remaining) / windowSize + rolled.consumed;
}

export function modelEffectiveFlowLimit(state: RouterModelState, route: RouteKind): bigint {
  return state.routeFlowLimit[route] ?? state.tokenFlowLimit;
}

export function modelFlowAvailable(state: RouterModelState, route: RouteKind): bigint {
  const limit = modelEffectiveFlowLimit(state, route);
  const clock = activeFlowClock(state);
  const used = effectiveFlowConsumed(state.flowWindows[route], clock, state.flowWindowUnits);
  return used >= limit ? 0n : limit - used;
}

function computeFeeAndNet(
  amount: bigint,
  feeBps: bigint,
  sourceDecimals: number,
  destinationDecimals: number,
): { fee: bigint; netRaw: bigint; net: bigint; gross: bigint; dust: bigint; landing: bigint } {
  const fee = (amount * feeBps) / MODEL_BPS_DENOMINATOR;
  const netRaw = amount - fee;
  let net = netRaw;
  if (sourceDecimals > destinationDecimals) {
    const scale = pow10(sourceDecimals - destinationDecimals);
    net = (netRaw / scale) * scale;
  }
  const gross = fee + net;
  const dust = amount - gross;
  const landing =
    sourceDecimals >= destinationDecimals
      ? net / pow10(sourceDecimals - destinationDecimals)
      : net * pow10(destinationDecimals - sourceDecimals);
  return { fee, netRaw, net, gross, dust, landing };
}

function convertExact(
  amount: bigint,
  sourceDecimals: number,
  destinationDecimals: number,
): bigint | null {
  if (sourceDecimals === destinationDecimals) {
    return amount;
  }
  if (sourceDecimals < destinationDecimals) {
    return amount * pow10(destinationDecimals - sourceDecimals);
  }
  const scale = pow10(sourceDecimals - destinationDecimals);
  if (amount % scale !== 0n) {
    return null;
  }
  return amount / scale;
}

function replayKey(route: RouteKind, messageId: string): string {
  return `${String(route)}:${messageId}`;
}

function emptyWindow(): ModelFlowWindow {
  return { epoch: 0n, consumed: 0n, prevConsumed: 0n };
}

export function createRouterModelState(config: RouterModelConfig): RouterModelState {
  const feeBps = config.initialFeeBps ?? 10n;
  const timelockDelaySeconds = config.initialTimelockDelaySeconds ?? MODEL_MIN_TIMELOCK_DELAY;
  const flowWindowUnits =
    config.initialFlowWindowUnits ??
    (config.chain === "soroban"
      ? MODEL_DEFAULT_SOROBAN_FLOW_WINDOW_LEDGERS
      : MODEL_DEFAULT_EVM_FLOW_WINDOW_SECONDS);
  const tokenFlowLimit =
    config.initialTokenFlowLimit ??
    (config.sourceDecimals === 7 ? 10_000_000_000n : 1_000_000_000n);
  const aliceBal =
    config.initialAliceBalance ??
    (config.sourceDecimals === 7 ? 100_000_000_000n : 10_000_000_000n);
  const bobBal =
    config.initialBobBalance ?? (config.sourceDecimals === 7 ? 100_000_000_000n : 10_000_000_000n);
  const railBal =
    config.initialRailBalancePerRoute ??
    (config.sourceDecimals === 7 ? 100_000_000_000n : 10_000_000_000n);

  const balances: Record<ModelAccountId, bigint> = {
    admin: 0n,
    guardian: 0n,
    alice: aliceBal,
    bob: bobBal,
    stranger: 0n,
    rail_cctp: railBal,
    rail_its: railBal,
    rail_gmp: railBal,
    rail_allbridge: railBal,
    recipient_a: 0n,
    recipient_b: 0n,
    treasury: 0n,
    treasury_alt: 0n,
    router: 0n,
    adapter_cctp: 0n,
    adapter_its: 0n,
    adapter_gmp: 0n,
    adapter_allbridge: 0n,
  };

  let initialTotalSupply = 0n;
  for (const id of ALL_ACCOUNTS) {
    initialTotalSupply += balances[id];
  }

  return {
    chain: config.chain,
    clock: {
      timestampSeconds: config.initialTimestampSeconds ?? 1_700_000_000n,
      ledgerSequence: config.initialLedgerSequence ?? 100_000n,
      blockNumber: config.initialBlockNumber ?? 1_000n,
    },
    sourceDecimals: config.sourceDecimals,
    destinationDecimals: config.destinationDecimals,
    paused: false,
    treasury: "treasury",
    feeBps,
    timelockDelaySeconds,
    flowWindowUnits,
    tokenRegistered: true,
    tokenEnabled: true,
    tokenFlowLimit,
    routeEnabled: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: true,
      [RouteKind.Allbridge]: true,
    },
    routePaused: {
      [RouteKind.Cctp]: false,
      [RouteKind.AxelarIts]: false,
      [RouteKind.AxelarGmp]: false,
      [RouteKind.Allbridge]: false,
    },
    adapterConfigured: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: true,
      [RouteKind.Allbridge]: true,
    },
    railReceiver: {
      [RouteKind.Cctp]: "rail_cctp",
      [RouteKind.AxelarIts]: "rail_its",
      [RouteKind.AxelarGmp]: "rail_gmp",
      [RouteKind.Allbridge]: "rail_allbridge",
    },
    routeFlowLimit: {},
    routeMaxSingleTransfer: {},
    flowWindows: {
      [RouteKind.Cctp]: emptyWindow(),
      [RouteKind.AxelarIts]: emptyWindow(),
      [RouteKind.AxelarGmp]: emptyWindow(),
      [RouteKind.Allbridge]: emptyWindow(),
    },
    outboundNonce: 0n,
    claimCount: 0n,
    actionCount: 0n,
    processedMessages: new Set<string>(),
    claims: new Map<bigint, ModelPendingClaim>(),
    claimCreationSnapshots: new Map<bigint, ModelPendingClaim>(),
    queuedActions: new Map<bigint, ModelQueuedAction>(),
    frozenAccounts: new Set<ModelAccountId>(),
    balances,
    initialTotalSupply,
    cumulativeFeesCollected: 0n,
  };
}

function fail(state: RouterModelState, error: RouterErrorCode): RouterStepResult {
  return { state, outcome: { ok: false, error } };
}

function validateAdminAction(
  state: RouterModelState,
  action: ModelAdminAction,
): RouterErrorCode | null {
  switch (action.kind) {
    case "SetFeeBps":
      if (action.feeBps < 0n || action.feeBps > MODEL_MAX_FEE_BPS) {
        return "FeeTooHigh";
      }
      return null;
    case "SetTreasury":
      return null;
    case "EnableRoute":
      if (state.chain === "soroban" && !action.enabled) {
        // Soroban uses immediate `disable_route` for false and `EnableRoute(route)` only for true.
        return "UnsupportedOperation";
      }
      return null;
    case "RaiseTokenFlowLimit":
      if (!state.tokenRegistered) {
        return "TokenNotRegistered";
      }
      if (action.limit < 0n) {
        return "InvalidLimit";
      }
      if (state.chain === "evm" && action.limit <= state.tokenFlowLimit) {
        return "LimitNotRaised";
      }
      return null;
    case "SetRouteFlowLimit":
      if (action.limit < 0n) {
        return "InvalidLimit";
      }
      return null;
    case "SetTimelockDelay":
      if (
        action.delaySeconds < MODEL_MIN_TIMELOCK_DELAY ||
        action.delaySeconds > MODEL_MAX_TIMELOCK_DELAY
      ) {
        return "TimelockDelayOutOfRange";
      }
      return null;
    case "SetFlowWindow":
      if (state.chain === "soroban") {
        return action.windowUnits <= 0n ? "InvalidWindow" : null;
      }
      if (
        action.windowUnits < MODEL_EVM_MIN_FLOW_WINDOW_SECONDS ||
        action.windowUnits > MODEL_EVM_MAX_FLOW_WINDOW_SECONDS
      ) {
        return "InvalidWindow";
      }
      return null;
    case "SetTokenEnabled":
      if (state.chain === "soroban") {
        // Soroban uses immediate `disable_token` and timelocked `RegisterToken` to re-enable.
        return "UnsupportedOperation";
      }
      return state.tokenRegistered ? null : "TokenNotRegistered";
    case "SetRouteMaxSingleTransfer":
      if (state.chain === "evm") {
        return "UnsupportedOperation";
      }
      return action.maxAmount < 0n ? "InvalidLimit" : null;
  }
}

function applyExecutedAdminAction(
  state: RouterModelState,
  action: ModelAdminAction,
): RouterModelState {
  switch (action.kind) {
    case "SetFeeBps":
      return { ...state, feeBps: action.feeBps };
    case "SetTreasury":
      return { ...state, treasury: action.treasury };
    case "EnableRoute":
      return {
        ...state,
        routeEnabled: { ...state.routeEnabled, [action.route]: action.enabled },
      };
    case "RaiseTokenFlowLimit":
      return { ...state, tokenFlowLimit: action.limit };
    case "SetRouteFlowLimit":
      return {
        ...state,
        routeFlowLimit: { ...state.routeFlowLimit, [action.route]: action.limit },
      };
    case "SetTimelockDelay":
      return { ...state, timelockDelaySeconds: action.delaySeconds };
    case "SetFlowWindow":
      return { ...state, flowWindowUnits: action.windowUnits };
    case "SetTokenEnabled":
      return { ...state, tokenEnabled: action.enabled };
    case "SetRouteMaxSingleTransfer":
      return {
        ...state,
        routeMaxSingleTransfer: {
          ...state.routeMaxSingleTransfer,
          [action.route]: action.maxAmount,
        },
      };
  }
}

function applyOutbound(
  state: RouterModelState,
  caller: "alice" | "bob",
  route: RouteKind,
  amount: bigint,
  minDestinationAmount: bigint,
  destinationChain: string,
  destinationKind: ModelDestinationKind,
  gasAmount: bigint | null,
): RouterStepResult {
  if (gasAmount !== null && state.chain === "evm") {
    return fail(state, "UnsupportedOperation");
  }
  if (state.paused) {
    return fail(state, "Paused");
  }
  if (amount <= 0n) {
    return fail(state, "InvalidAmount");
  }
  if (state.chain === "evm" && state.routePaused[route]) {
    return fail(state, "RouteIsPaused");
  }
  if (!state.routeEnabled[route]) {
    return fail(state, "RouteDisabled");
  }
  if (gasAmount !== null) {
    if (route !== RouteKind.AxelarIts && route !== RouteKind.Cctp) {
      return fail(state, "RouteDisabled");
    }
    if (gasAmount <= 0n) {
      return fail(state, "InvalidAmount");
    }
  }
  if (state.chain === "soroban") {
    const routeCap = state.routeMaxSingleTransfer[route];
    if (routeCap !== undefined && routeCap > 0n && amount > routeCap) {
      return fail(state, "ExceedsRouteLimit");
    }
  }
  if (destinationChain.length === 0) {
    return fail(state, "UnknownChain");
  }
  // EVM targets Stellar destinations where Allbridge lacks payload support for muxed IDs.
  if (state.chain === "evm" && destinationKind === "muxed" && route === RouteKind.Allbridge) {
    return fail(state, "MuxedNotSupported");
  }
  if (!state.tokenRegistered) {
    return fail(state, "TokenNotRegistered");
  }
  if (!state.tokenEnabled) {
    return fail(state, "TokenDisabled");
  }

  const split = computeFeeAndNet(
    amount,
    state.feeBps,
    state.sourceDecimals,
    state.destinationDecimals,
  );
  if (split.netRaw <= 0n || split.net <= 0n) {
    return fail(state, "AmountNotRepresentable");
  }

  if (gasAmount !== null && route === RouteKind.Cctp) {
    if (gasAmount >= split.net) {
      return fail(state, "InvalidAmount");
    }
    const postFeeLanding = convertExact(
      split.net - gasAmount,
      state.sourceDecimals,
      state.destinationDecimals,
    );
    if (postFeeLanding === null) {
      return fail(state, "AmountNotRepresentable");
    }
    if (postFeeLanding < minDestinationAmount) {
      return fail(state, "SlippageExceeded");
    }
  } else if (split.landing < minDestinationAmount) {
    return fail(state, "SlippageExceeded");
  }

  const limit = modelEffectiveFlowLimit(state, route);
  const clock = activeFlowClock(state);
  const currentWindow = state.flowWindows[route];
  const rolled = rollFlowForward(currentWindow, clock, state.flowWindowUnits);
  const used = effectiveFlowConsumed(currentWindow, clock, state.flowWindowUnits);
  if (used + split.net > limit) {
    return fail(state, "FlowLimitExceeded");
  }

  if (!state.adapterConfigured[route]) {
    return fail(state, "AdapterNotSet");
  }

  const adapterAccount = adapterAccountFor(route);
  if (
    state.frozenAccounts.has(caller) ||
    (split.fee > 0n && state.frozenAccounts.has(state.treasury)) ||
    state.frozenAccounts.has(adapterAccount) ||
    (gasAmount === null && state.frozenAccounts.has("router"))
  ) {
    return fail(state, "AccountFrozen");
  }
  if (state.balances[caller] < split.gross) {
    return fail(state, "InsufficientSenderBalance");
  }

  const nextWindow: ModelFlowWindow = {
    ...rolled,
    consumed: rolled.consumed + split.net,
  };
  const nextNonce = state.outboundNonce + 1n;
  const nextBalances: Record<ModelAccountId, bigint> = {
    ...state.balances,
    [caller]: state.balances[caller] - split.gross,
  };
  nextBalances[state.treasury] = nextBalances[state.treasury] + split.fee;
  nextBalances[adapterAccount] = nextBalances[adapterAccount] + split.net;

  return {
    state: {
      ...state,
      outboundNonce: nextNonce,
      flowWindows: {
        ...state.flowWindows,
        [route]: nextWindow,
      },
      balances: nextBalances,
      cumulativeFeesCollected: state.cumulativeFeesCollected + split.fee,
    },
    outcome: {
      ok: true,
      value: nextNonce,
      feePaid: split.fee,
      netBridged: split.net,
      dustRetained: split.dust,
    },
  };
}

/**
 * Apply a single operation to the reference model state. Failed operations leave `state`
 * completely unchanged, matching Soroban and EVM atomic transaction rollback.
 */
export function applyRouterOperation(
  state: RouterModelState,
  op: RouterOperation,
): RouterStepResult {
  switch (op.type) {
    case "AdvanceTime": {
      if (op.seconds < 0n) {
        return fail(state, "InvalidAmount");
      }
      return {
        state: {
          ...state,
          clock: {
            ...state.clock,
            timestampSeconds: state.clock.timestampSeconds + op.seconds,
          },
        },
        outcome: { ok: true },
      };
    }

    case "AdvanceLedgers": {
      if (state.chain !== "soroban") {
        return fail(state, "UnsupportedOperation");
      }
      if (op.ledgers < 0n) {
        return fail(state, "InvalidAmount");
      }
      return {
        state: {
          ...state,
          clock: {
            ...state.clock,
            ledgerSequence: state.clock.ledgerSequence + op.ledgers,
          },
        },
        outcome: { ok: true },
      };
    }

    case "AdvanceBlocks": {
      if (state.chain !== "evm") {
        return fail(state, "UnsupportedOperation");
      }
      if (op.blocks < 0n) {
        return fail(state, "InvalidAmount");
      }
      return {
        state: {
          ...state,
          clock: {
            ...state.clock,
            blockNumber: state.clock.blockNumber + op.blocks,
          },
        },
        outcome: { ok: true },
      };
    }

    case "SetAccountFrozen": {
      const nextFrozen = new Set(state.frozenAccounts);
      if (op.frozen) {
        nextFrozen.add(op.account);
      } else {
        nextFrozen.delete(op.account);
      }
      return {
        state: {
          ...state,
          frozenAccounts: nextFrozen,
        },
        outcome: { ok: true },
      };
    }

    case "BridgeOut":
      return applyOutbound(
        state,
        op.caller,
        op.route,
        op.amount,
        op.minDestinationAmount,
        op.destinationChain,
        op.destinationKind,
        null,
      );

    case "BridgeOutWithGas":
      return applyOutbound(
        state,
        op.caller,
        op.route,
        op.amount,
        op.minDestinationAmount,
        op.destinationChain,
        op.destinationKind,
        op.gasAmount,
      );

    case "BridgeIn": {
      const expectedReceiver = state.railReceiver[op.route];
      if (expectedReceiver === null) {
        return fail(state, "AdapterNotSet");
      }
      if (op.caller !== expectedReceiver) {
        return fail(state, "NotRailReceiver");
      }
      if (op.amount <= 0n) {
        return fail(state, "InvalidAmount");
      }
      const msgKey = replayKey(op.route, op.messageId);
      if (state.processedMessages.has(msgKey)) {
        return fail(state, "ReplayedMessage");
      }
      // Soroban checks muxed recipient compatibility before pulling inbound funds.
      if (
        state.chain === "soroban" &&
        op.recipientKind === "muxed" &&
        (op.route === RouteKind.Cctp || op.route === RouteKind.Allbridge)
      ) {
        return fail(state, "MuxedNotSupported");
      }
      if (state.frozenAccounts.has(op.caller) || state.frozenAccounts.has("router")) {
        return fail(state, "AccountFrozen");
      }
      if (state.balances[op.caller] < op.amount) {
        return fail(state, "InsufficientRailBalance");
      }

      const nextProcessed = new Set(state.processedMessages);
      nextProcessed.add(msgKey);

      if (!state.frozenAccounts.has(op.recipient)) {
        const nextBalances: Record<ModelAccountId, bigint> = {
          ...state.balances,
          [op.caller]: state.balances[op.caller] - op.amount,
          [op.recipient]: state.balances[op.recipient] + op.amount,
        };
        return {
          state: {
            ...state,
            processedMessages: nextProcessed,
            balances: nextBalances,
          },
          outcome: { ok: true, value: 0n },
        };
      }

      const claimId = state.claimCount + 1n;
      const claim: ModelPendingClaim = {
        id: claimId,
        recipient: op.recipient,
        amount: op.amount,
        route: op.route,
        sourceChain: op.sourceChain,
        sourceNonce: op.sourceNonce,
        createdAt: state.clock.timestampSeconds,
        settled: false,
      };
      const nextClaims = new Map(state.claims);
      nextClaims.set(claimId, claim);
      const nextSnapshots = new Map(state.claimCreationSnapshots);
      nextSnapshots.set(claimId, claim);
      const nextBalances: Record<ModelAccountId, bigint> = {
        ...state.balances,
        [op.caller]: state.balances[op.caller] - op.amount,
        router: state.balances.router + op.amount,
      };

      return {
        state: {
          ...state,
          claimCount: claimId,
          processedMessages: nextProcessed,
          claims: nextClaims,
          claimCreationSnapshots: nextSnapshots,
          balances: nextBalances,
        },
        outcome: { ok: true, value: claimId },
      };
    }

    case "SettleClaim": {
      const claim = state.claims.get(op.claimId);
      if (claim === undefined) {
        return fail(state, "ClaimNotFound");
      }
      if (claim.settled) {
        return fail(state, "ClaimAlreadySettled");
      }
      if (
        state.frozenAccounts.has(claim.recipient) ||
        state.frozenAccounts.has("router") ||
        state.balances.router < claim.amount
      ) {
        return fail(state, "RecipientNotReady");
      }

      const updatedClaim: ModelPendingClaim = { ...claim, settled: true };
      const nextClaims = new Map(state.claims);
      nextClaims.set(op.claimId, updatedClaim);
      const nextBalances: Record<ModelAccountId, bigint> = {
        ...state.balances,
        router: state.balances.router - claim.amount,
        [claim.recipient]: state.balances[claim.recipient] + claim.amount,
      };

      return {
        state: {
          ...state,
          claims: nextClaims,
          balances: nextBalances,
        },
        outcome: { ok: true },
      };
    }

    case "Pause": {
      if (op.caller !== "admin" && op.caller !== "guardian") {
        return fail(state, "Unauthorized");
      }
      if (state.chain === "evm" && state.paused) {
        return fail(state, "Paused");
      }
      return {
        state: { ...state, paused: true },
        outcome: { ok: true },
      };
    }

    case "Unpause": {
      if (op.caller !== "admin") {
        return fail(state, "Unauthorized");
      }
      if (state.chain === "evm" && !state.paused) {
        return fail(state, "Paused");
      }
      return {
        state: { ...state, paused: false },
        outcome: { ok: true },
      };
    }

    case "PauseRoute": {
      if (state.chain !== "evm") {
        return fail(state, "UnsupportedOperation");
      }
      if (op.caller !== "admin" && op.caller !== "guardian") {
        return fail(state, "Unauthorized");
      }
      return {
        state: {
          ...state,
          routePaused: { ...state.routePaused, [op.route]: true },
        },
        outcome: { ok: true },
      };
    }

    case "UnpauseRoute": {
      if (state.chain !== "evm") {
        return fail(state, "UnsupportedOperation");
      }
      if (op.caller !== "admin" && op.caller !== "guardian") {
        return fail(state, "Unauthorized");
      }
      return {
        state: {
          ...state,
          routePaused: { ...state.routePaused, [op.route]: false },
        },
        outcome: { ok: true },
      };
    }

    case "DisableRoute": {
      if (state.chain !== "soroban") {
        return fail(state, "UnsupportedOperation");
      }
      if (op.caller !== "admin" && op.caller !== "guardian") {
        return fail(state, "Unauthorized");
      }
      return {
        state: {
          ...state,
          routeEnabled: { ...state.routeEnabled, [op.route]: false },
        },
        outcome: { ok: true },
      };
    }

    case "DisableToken": {
      if (state.chain !== "soroban") {
        return fail(state, "UnsupportedOperation");
      }
      if (op.caller !== "admin" && op.caller !== "guardian") {
        return fail(state, "Unauthorized");
      }
      if (!state.tokenRegistered) {
        return fail(state, "TokenNotRegistered");
      }
      return {
        state: { ...state, tokenEnabled: false },
        outcome: { ok: true },
      };
    }

    case "LowerTokenFlowLimit": {
      if (op.caller !== "admin" && op.caller !== "guardian") {
        return fail(state, "Unauthorized");
      }
      if (!state.tokenRegistered) {
        return fail(state, "TokenNotRegistered");
      }
      if (op.limit < 0n) {
        return fail(state, "InvalidLimit");
      }
      if (op.limit >= state.tokenFlowLimit) {
        return fail(state, state.chain === "evm" ? "LimitNotRaised" : "InvalidLimit");
      }
      return {
        state: { ...state, tokenFlowLimit: op.limit },
        outcome: { ok: true },
      };
    }

    case "QueueAction": {
      if (op.caller !== "admin") {
        return fail(state, "Unauthorized");
      }
      const err = validateAdminAction(state, op.action);
      if (err !== null) {
        return fail(state, err);
      }
      const id = state.actionCount + 1n;
      const now = state.clock.timestampSeconds;
      const eta = now + state.timelockDelaySeconds;
      const expiresAt = eta + MODEL_TIMELOCK_GRACE_PERIOD;
      const queued: ModelQueuedAction = {
        id,
        action: op.action,
        queuedAt: now,
        eta,
        expiresAt,
        executed: false,
      };
      const nextQueued = new Map(state.queuedActions);
      nextQueued.set(id, queued);
      return {
        state: {
          ...state,
          actionCount: id,
          queuedActions: nextQueued,
        },
        outcome: { ok: true, value: id },
      };
    }

    case "ExecuteAction": {
      if (op.caller !== "admin") {
        return fail(state, "Unauthorized");
      }
      const queued = state.queuedActions.get(op.actionId);
      if (queued === undefined) {
        return fail(state, "TimelockNotQueued");
      }
      if (queued.executed) {
        return fail(state, "TimelockAlreadyExecuted");
      }
      const now = state.clock.timestampSeconds;
      if (now < queued.eta) {
        return fail(state, "TimelockNotReady");
      }
      if (now > queued.expiresAt) {
        return fail(state, "TimelockExpired");
      }

      if (state.chain === "evm") {
        const recheck = validateAdminAction(state, queued.action);
        if (recheck !== null) {
          return fail(state, recheck);
        }
      }

      const nextQueued = new Map(state.queuedActions);
      if (state.chain === "soroban") {
        nextQueued.delete(op.actionId);
      } else {
        nextQueued.set(op.actionId, { ...queued, executed: true });
      }

      const applied = applyExecutedAdminAction(
        {
          ...state,
          queuedActions: nextQueued,
        },
        queued.action,
      );
      return {
        state: applied,
        outcome: { ok: true },
      };
    }

    case "CancelAction": {
      if (op.caller !== "admin" && op.caller !== "guardian") {
        return fail(state, "Unauthorized");
      }
      const queued = state.queuedActions.get(op.actionId);
      if (queued === undefined) {
        return fail(state, "TimelockNotQueued");
      }
      if (queued.executed) {
        return fail(state, "TimelockAlreadyExecuted");
      }
      const nextQueued = new Map(state.queuedActions);
      nextQueued.delete(op.actionId);
      return {
        state: {
          ...state,
          queuedActions: nextQueued,
        },
        outcome: { ok: true },
      };
    }
  }
}

/**
 * Verify conserved token supply, exact escrow-to-unsettled-claims equality, immutable
 * fixed-recipient claim liabilities, and cumulative treasury fee accounting.
 */
export function verifyRouterModelInvariants(state: RouterModelState): RouterInvariantCheck {
  const violations: string[] = [];

  let totalSupply = 0n;
  for (const id of ALL_ACCOUNTS) {
    const bal = state.balances[id];
    if (bal < 0n) {
      violations.push(`negative balance on ${id}: ${String(bal)}`);
    }
    totalSupply += bal;
  }

  if (totalSupply !== state.initialTotalSupply) {
    violations.push(
      `supply conservation violated: expected ${String(state.initialTotalSupply)}, got ${String(totalSupply)}`,
    );
  }

  let unsettledEscrow = 0n;
  for (const [id, claim] of state.claims.entries()) {
    const initial = state.claimCreationSnapshots.get(id);
    if (initial === undefined) {
      violations.push(`claim ${String(id)} missing creation snapshot`);
      continue;
    }
    if (
      claim.recipient !== initial.recipient ||
      claim.amount !== initial.amount ||
      claim.route !== initial.route ||
      claim.sourceChain !== initial.sourceChain ||
      claim.sourceNonce !== initial.sourceNonce ||
      claim.createdAt !== initial.createdAt
    ) {
      violations.push(
        `fixed-recipient liability mutated on claim ${String(id)}: (${initial.recipient}, ${String(initial.amount)}) -> (${claim.recipient}, ${String(claim.amount)})`,
      );
    }
    if (!claim.settled) {
      unsettledEscrow += claim.amount;
    }
  }

  if (state.balances.router !== unsettledEscrow) {
    violations.push(
      `router escrow (${String(state.balances.router)}) != unsettled claims (${String(unsettledEscrow)})`,
    );
  }

  const treasuryTotal = state.balances.treasury + state.balances.treasury_alt;
  if (treasuryTotal !== state.cumulativeFeesCollected) {
    violations.push(
      `treasury balances (${String(treasuryTotal)}) != cumulative fees (${String(state.cumulativeFeesCollected)})`,
    );
  }

  if (
    state.balances.stranger !== 0n ||
    state.balances.admin !== 0n ||
    state.balances.guardian !== 0n
  ) {
    violations.push(
      `non-recipient actor received funds: admin=${String(state.balances.admin)} guardian=${String(state.balances.guardian)} stranger=${String(state.balances.stranger)}`,
    );
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

function countUnsettledClaims(state: RouterModelState): number {
  let count = 0;
  for (const claim of state.claims.values()) {
    if (!claim.settled) {
      count += 1;
    }
  }
  return count;
}

/**
 * Execute an operation sequence against the reference model, recording step-by-step traces and
 * checking conservation and fixed-recipient invariants after every transition.
 */
export function runRouterSequence(
  config: RouterModelConfig,
  operations: readonly RouterOperation[],
  stepRunner: (
    state: RouterModelState,
    op: RouterOperation,
  ) => RouterStepResult = applyRouterOperation,
): RouterSequenceRunResult {
  const initialState = createRouterModelState(config);
  let current = initialState;
  const traces: RouterStepTrace[] = [];
  let invariantFailure: {
    readonly stepIndex: number;
    readonly violations: readonly string[];
  } | null = null;

  for (const [i, op] of operations.entries()) {
    const clockBefore = current.clock;
    const next = stepRunner(current, op);
    current = next.state;
    traces.push({
      stepIndex: i,
      operation: op,
      clockBefore,
      clockAfter: current.clock,
      outcome: next.outcome,
      routerEscrowAfter: current.balances.router,
      treasuryBalanceAfter: current.balances.treasury + current.balances.treasury_alt,
      unsettledClaimCountAfter: countUnsettledClaims(current),
      flowAvailableCctpAfter: modelFlowAvailable(current, RouteKind.Cctp),
    });

    if (invariantFailure === null) {
      const check = verifyRouterModelInvariants(current);
      if (!check.ok) {
        invariantFailure = {
          stepIndex: i,
          violations: check.violations,
        };
      }
    }
  }

  return {
    initialState,
    finalState: current,
    traces,
    invariantFailure,
  };
}

// -------------------------------------------------------------------------------------------
// Deterministic Sequence Generator
// -------------------------------------------------------------------------------------------

class SplitMix32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  nextU32(): number {
    this.state = (this.state + 0x9e3779b9) | 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  }

  nextInt(maxExclusive: number): number {
    return this.nextU32() % maxExclusive;
  }

  pick<T>(items: readonly [T, ...T[]]): T {
    return items[this.nextInt(items.length)] ?? items[0];
  }
}

export interface GenerateSequenceOptions {
  readonly chain: RouterChainProfile;
  readonly length: number;
}

const ROUTES: readonly [RouteKind, ...RouteKind[]] = [
  RouteKind.Cctp,
  RouteKind.AxelarIts,
  RouteKind.AxelarGmp,
  RouteKind.Allbridge,
];

const RECEIVER_FOR_ROUTE: Readonly<Record<RouteKind, ModelActorRole>> = {
  [RouteKind.Cctp]: "rail_cctp",
  [RouteKind.AxelarIts]: "rail_its",
  [RouteKind.AxelarGmp]: "rail_gmp",
  [RouteKind.Allbridge]: "rail_allbridge",
};

/**
 * Deterministically generate a mixed operation sequence exercising dispatch, decimal-dust
 * amounts, pause/route-pause, immediate narrowing, timelocked admin actions, chain-specific
 * clocks, inbound replay attempts, frozen recipients, and third-party claim settlement.
 */
export function generateRouterSequence(
  seed: number,
  options: GenerateSequenceOptions,
): readonly RouterOperation[] {
  const rng = new SplitMix32(seed);
  const ops: RouterOperation[] = [];
  const callers = ["alice", "bob"] as const;
  const adminActors = ["admin", "guardian", "stranger"] as const;
  const recipients = ["recipient_a", "recipient_b"] as const;
  const destKinds = ["account", "contract", "muxed"] as const;
  const sampleAmounts = [
    0n,
    5n,
    100n,
    1_003n,
    25_007n,
    500_019n,
    2_500_000n,
    75_000_003n,
    400_000_000n,
  ] as const;

  let nextActionGuess = 1n;
  let nextClaimGuess = 1n;
  let nextInboundNonce = 1n;
  const stepCount = options.length;

  for (let step = 0; step < stepCount; step += 1) {
    const roll = rng.nextInt(100);

    if (roll < 14) {
      if (options.chain === "soroban" && rng.nextInt(2) === 0) {
        const ledgers = rng.pick([1n, 60n, 360n, 720n, 1_500n]);
        ops.push({ type: "AdvanceLedgers", ledgers });
      } else if (options.chain === "evm" && rng.nextInt(4) === 0) {
        ops.push({ type: "AdvanceBlocks", blocks: rng.pick([1n, 10n, 100n]) });
      } else {
        const seconds = rng.pick([30n, 600n, 1_800n, 3_601n, 86_400n, 700_000n]);
        ops.push({ type: "AdvanceTime", seconds });
      }
    } else if (roll < 24) {
      const target = rng.pick(["recipient_a", "recipient_b", "alice"] as const);
      ops.push({
        type: "SetAccountFrozen",
        account: target,
        frozen: rng.nextInt(2) === 0,
      });
    } else if (roll < 46) {
      const route = rng.pick(ROUTES);
      const amount = rng.pick(sampleAmounts);
      if (
        options.chain === "soroban" &&
        (route === RouteKind.Cctp || route === RouteKind.AxelarIts) &&
        rng.nextInt(3) === 0
      ) {
        ops.push({
          type: "BridgeOutWithGas",
          caller: rng.pick(callers),
          route,
          amount,
          gasAmount: rng.pick([100n, 1_000n, 50_000n]),
          minDestinationAmount: rng.pick([0n, 10n]),
          destinationChain: rng.nextInt(10) === 0 ? "" : "ethereum",
          destinationKind: rng.pick(destKinds),
        });
      } else {
        ops.push({
          type: "BridgeOut",
          caller: rng.pick(callers),
          route,
          amount,
          minDestinationAmount: rng.pick([0n, 10n, 1_000_000n]),
          destinationChain: rng.nextInt(12) === 0 ? "" : "stellar",
          destinationKind: rng.pick(destKinds),
        });
      }
    } else if (roll < 66) {
      const route = rng.pick(ROUTES);
      const legitimateReceiver = RECEIVER_FOR_ROUTE[route];
      const caller = rng.nextInt(5) === 0 ? "stranger" : legitimateReceiver;
      const isReplay = nextInboundNonce > 1n && rng.nextInt(4) === 0;
      const nonce = isReplay
        ? BigInt(1 + rng.nextInt(Number(nextInboundNonce - 1n)))
        : nextInboundNonce;
      if (!isReplay) {
        nextInboundNonce += 1n;
      }
      const recipient = rng.pick(recipients);
      ops.push({
        type: "BridgeIn",
        caller,
        route,
        amount: rng.pick([0n, 1_000n, 250_000n, 5_000_000n]),
        recipient,
        recipientKind: rng.pick(destKinds),
        sourceChain: options.chain === "soroban" ? "ethereum" : "stellar",
        sourceNonce: nonce,
        messageId: `msg-${String(nonce)}`,
      });
      if (rng.nextInt(3) === 0) {
        nextClaimGuess += 1n;
      }
    } else if (roll < 78) {
      const maxClaim = Math.min(4, Math.max(1, Number(nextClaimGuess)));
      const claimId = BigInt(1 + rng.nextInt(maxClaim));
      ops.push({
        type: "SettleClaim",
        caller: rng.pick(["stranger", "alice", "bob", "guardian"] as const),
        claimId,
      });
    } else if (roll < 88) {
      const caller = rng.pick(adminActors);
      const sub = rng.nextInt(5);
      if (sub === 0) {
        ops.push({ type: "Pause", caller });
      } else if (sub === 1) {
        ops.push({ type: "Unpause", caller });
      } else if (sub === 2 && options.chain === "evm") {
        ops.push({ type: "PauseRoute", caller, route: rng.pick(ROUTES) });
      } else if (sub === 3 && options.chain === "evm") {
        ops.push({ type: "UnpauseRoute", caller, route: rng.pick(ROUTES) });
      } else if (sub === 2 && options.chain === "soroban") {
        ops.push({ type: "DisableRoute", caller, route: rng.pick(ROUTES) });
      } else {
        ops.push({
          type: "LowerTokenFlowLimit",
          caller,
          limit: rng.pick([500_000_000n, 200_000_000n, 2_000_000_000_000n]),
        });
      }
    } else {
      const sub = rng.nextInt(3);
      if (sub === 0) {
        const action = rng.pick<ModelAdminAction>([
          { kind: "SetFeeBps", feeBps: rng.pick([0n, 5n, 25n, 100n, 150n]) },
          { kind: "SetTreasury", treasury: rng.pick(["treasury", "treasury_alt"] as const) },
          { kind: "EnableRoute", route: rng.pick(ROUTES), enabled: true },
          { kind: "RaiseTokenFlowLimit", limit: 50_000_000_000n },
          { kind: "SetRouteFlowLimit", route: rng.pick(ROUTES), limit: 20_000_000_000n },
          { kind: "SetTimelockDelay", delaySeconds: 3_600n },
          {
            kind: "SetFlowWindow",
            windowUnits: options.chain === "soroban" ? 720n : 3_600n,
          },
        ]);
        const caller = rng.nextInt(5) === 0 ? "guardian" : "admin";
        ops.push({ type: "QueueAction", caller, action });
        if (caller === "admin") {
          nextActionGuess += 1n;
        }
      } else if (sub === 1) {
        const maxId = nextActionGuess > 1n ? Number(nextActionGuess) : 1;
        ops.push({
          type: "ExecuteAction",
          caller: rng.nextInt(6) === 0 ? "guardian" : "admin",
          actionId: BigInt(1 + rng.nextInt(maxId)),
        });
      } else {
        const maxId = nextActionGuess > 1n ? Number(nextActionGuess) : 1;
        ops.push({
          type: "CancelAction",
          caller: rng.pick(adminActors),
          actionId: BigInt(1 + rng.nextInt(maxId)),
        });
      }
    }
  }

  return ops;
}

// -------------------------------------------------------------------------------------------
// Deterministic Counterexample Shrinking & Minimal Reproducible Trace Formatting
// -------------------------------------------------------------------------------------------

function formatOperation(op: RouterOperation): string {
  switch (op.type) {
    case "AdvanceTime":
      return `AdvanceTime(${String(op.seconds)}s)`;
    case "AdvanceLedgers":
      return `AdvanceLedgers(${String(op.ledgers)})`;
    case "AdvanceBlocks":
      return `AdvanceBlocks(${String(op.blocks)})`;
    case "SetAccountFrozen":
      return `SetAccountFrozen(${op.account}, frozen=${String(op.frozen)})`;
    case "BridgeOut":
      return `BridgeOut(caller=${op.caller}, route=${String(op.route)}, amount=${String(op.amount)}, minDest=${String(op.minDestinationAmount)}, chain="${op.destinationChain}", kind=${op.destinationKind})`;
    case "BridgeOutWithGas":
      return `BridgeOutWithGas(caller=${op.caller}, route=${String(op.route)}, amount=${String(op.amount)}, gas=${String(op.gasAmount)}, minDest=${String(op.minDestinationAmount)})`;
    case "BridgeIn":
      return `BridgeIn(caller=${op.caller}, route=${String(op.route)}, amount=${String(op.amount)}, recipient=${op.recipient}, kind=${op.recipientKind}, msg="${op.messageId}")`;
    case "SettleClaim":
      return `SettleClaim(caller=${op.caller}, claimId=${String(op.claimId)})`;
    case "Pause":
      return `Pause(caller=${op.caller})`;
    case "Unpause":
      return `Unpause(caller=${op.caller})`;
    case "PauseRoute":
      return `PauseRoute(caller=${op.caller}, route=${String(op.route)})`;
    case "UnpauseRoute":
      return `UnpauseRoute(caller=${op.caller}, route=${String(op.route)})`;
    case "DisableRoute":
      return `DisableRoute(caller=${op.caller}, route=${String(op.route)})`;
    case "DisableToken":
      return `DisableToken(caller=${op.caller})`;
    case "LowerTokenFlowLimit":
      return `LowerTokenFlowLimit(caller=${op.caller}, limit=${String(op.limit)})`;
    case "QueueAction":
      return `QueueAction(caller=${op.caller}, kind=${op.action.kind})`;
    case "ExecuteAction":
      return `ExecuteAction(caller=${op.caller}, actionId=${String(op.actionId)})`;
    case "CancelAction":
      return `CancelAction(caller=${op.caller}, actionId=${String(op.actionId)})`;
  }
}

function formatOutcome(outcome: RouterStepOutcome): string {
  if (!outcome.ok) {
    return `err(${outcome.error})`;
  }
  if (outcome.netBridged !== undefined) {
    return `ok(nonce=${String(outcome.value ?? 0n)}, fee=${String(outcome.feePaid ?? 0n)}, net=${String(outcome.netBridged)}, dust=${String(outcome.dustRetained ?? 0n)})`;
  }
  if (outcome.value !== undefined) {
    return `ok(${String(outcome.value)})`;
  }
  return "ok()";
}

export function formatMinimalRouterTrace(
  chain: RouterChainProfile,
  originalLength: number,
  failedStepIndex: number,
  failureReason: string,
  stepTraces: readonly RouterStepTrace[],
): string {
  const lines: string[] = [
    `Minimal reproducible router trace [chain=${chain}, shrunk ${String(originalLength)} -> ${String(stepTraces.length)} steps]`,
    `Failure at step ${String(failedStepIndex)}: ${failureReason}`,
  ];

  for (const step of stepTraces) {
    const clockDesc =
      chain === "soroban"
        ? `ts=${String(step.clockAfter.timestampSeconds)}s, ledger=${String(step.clockAfter.ledgerSequence)}`
        : `ts=${String(step.clockAfter.timestampSeconds)}s, block=${String(step.clockAfter.blockNumber)}`;
    lines.push(
      `  [${String(step.stepIndex)}] ${formatOperation(step.operation)} -> ${formatOutcome(step.outcome)} | ${clockDesc} | escrow=${String(step.routerEscrowAfter)} treasury=${String(step.treasuryBalanceAfter)} unsettled=${String(step.unsettledClaimCountAfter)}`,
    );
  }

  return lines.join("\n");
}

function coalesceAdjacentClockSteps(ops: readonly RouterOperation[]): RouterOperation[] {
  const merged: RouterOperation[] = [];
  for (const op of ops) {
    const prev = merged[merged.length - 1];
    if (prev?.type === "AdvanceTime" && op.type === "AdvanceTime") {
      merged[merged.length - 1] = { type: "AdvanceTime", seconds: prev.seconds + op.seconds };
    } else if (prev?.type === "AdvanceLedgers" && op.type === "AdvanceLedgers") {
      merged[merged.length - 1] = { type: "AdvanceLedgers", ledgers: prev.ledgers + op.ledgers };
    } else if (prev?.type === "AdvanceBlocks" && op.type === "AdvanceBlocks") {
      merged[merged.length - 1] = { type: "AdvanceBlocks", blocks: prev.blocks + op.blocks };
    } else {
      merged.push(op);
    }
  }
  return merged;
}

/**
 * Deterministically shrink a failing operation sequence to a 1-minimal reproducible trace via
 * prefix truncation, `ddmin` chunk elimination, and adjacent clock-step coalescing.
 */
export function shrinkFailingRouterSequence(
  config: RouterModelConfig,
  operations: readonly RouterOperation[],
  checkSequence: (candidate: readonly RouterOperation[]) => SequenceCheckOutcome,
  traceRunner: (
    state: RouterModelState,
    op: RouterOperation,
  ) => RouterStepResult = applyRouterOperation,
): MinimalRouterTrace {
  const initialCheck = checkSequence(operations);
  if (initialCheck.ok) {
    throw new Error("shrinkFailingRouterSequence called on a passing sequence");
  }

  let current: RouterOperation[] = operations.slice(0, initialCheck.failedStepIndex + 1);
  let latestFailure = checkSequence(current);
  if (latestFailure.ok) {
    current = [...operations];
    latestFailure = initialCheck;
  }

  // Delta-debugging (`ddmin`): remove largest failing-preserving chunks down to single steps.
  let granularity = 2;
  while (current.length > 1) {
    const chunkSize = Math.max(1, Math.floor(current.length / granularity));
    let reduced = false;

    for (let start = 0; start < current.length; start += chunkSize) {
      const end = Math.min(current.length, start + chunkSize);
      if (start === 0 && end === current.length) {
        continue;
      }
      const candidate = [...current.slice(0, start), ...current.slice(end)];
      if (candidate.length === 0) {
        continue;
      }
      const res = checkSequence(candidate);
      if (!res.ok) {
        current = candidate.slice(0, res.failedStepIndex + 1);
        const truncatedRes = checkSequence(current);
        if (!truncatedRes.ok) {
          latestFailure = truncatedRes;
        } else {
          current = candidate;
          latestFailure = res;
        }
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }

    if (!reduced) {
      if (chunkSize === 1) {
        break;
      }
      granularity = Math.min(current.length, granularity * 2);
    }
  }

  // Coalesce adjacent clock advances if the failure still reproduces.
  const coalesced = coalesceAdjacentClockSteps(current);
  if (coalesced.length < current.length) {
    const coalescedRes = checkSequence(coalesced);
    if (!coalescedRes.ok) {
      current = coalesced.slice(0, coalescedRes.failedStepIndex + 1);
      const truncRes = checkSequence(current);
      latestFailure = !truncRes.ok ? truncRes : coalescedRes;
    }
  }

  const run = runRouterSequence(config, current, traceRunner);
  const formattedTrace = formatMinimalRouterTrace(
    config.chain,
    operations.length,
    latestFailure.failedStepIndex,
    latestFailure.reason,
    run.traces,
  );

  return {
    chain: config.chain,
    originalLength: operations.length,
    minimalLength: current.length,
    failedStepIndex: latestFailure.failedStepIndex,
    failureReason: latestFailure.reason,
    operations: current,
    stepTraces: run.traces,
    formattedTrace,
  };
}
