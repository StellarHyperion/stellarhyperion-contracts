/**
 * Every way Hyperion says no, in one vocabulary both chains share.
 *
 * Soroban returns a small integer. Solidity returns a four byte selector. Neither means anything
 * to somebody staring at a wallet, so this module keeps the names, the Soroban numbers and a
 * sentence per failure that is fit to put on a screen.
 *
 * Two rules hold this together and both are enforced by `test/parity.test.ts` rather than by
 * remembering them:
 *
 * 1. `SOROBAN_ERROR_NAMES` is index aligned with `hyperion_core::HyperionError`, whose first
 *    variant is 1. Append only. Reordering it rewrites the meaning of every error any contract has
 *    ever returned.
 * 2. `EVM_ERROR_NAMES` matches the declaration order of `evm/src/HyperionErrors.sol`. The selectors
 *    themselves are generated from the compiled ABI and live in `./abi`, so nobody ever types one.
 */

/**
 * The Soroban error table, in tag order. Index zero is tag one, because Soroban reserves zero and
 * an error nobody can distinguish from success is worse than no error at all.
 */
export const SOROBAN_ERROR_NAMES = [
  "AlreadyInitialized",
  "NotInitialized",
  "Unauthorized",
  "NotRailReceiver",
  "Paused",
  "RouteDisabled",
  "AdapterNotSet",
  "FlowLimitExceeded",
  "InvalidAmount",
  "AmountNotRepresentable",
  "DecimalOverflow",
  "InvalidDecimals",
  "SlippageExceeded",
  "FeeTooHigh",
  "InvalidDestination",
  "ZeroAddressKey",
  "MuxedNotSupported",
  "NotEvmAddress",
  "UnknownChain",
  "ReplayedMessage",
  "UnknownNonce",
  "TimelockNotQueued",
  "TimelockNotReady",
  "TimelockExpired",
  "TimelockDelayOutOfRange",
  "ClaimNotFound",
  "ClaimAlreadySettled",
  "RecipientNotReady",
  "InvalidLimit",
  "InvalidWindow",
  "TokenNotRegistered",
  "MalformedMessage",
  "UnsupportedHookVersion",
  "RailNotConfigured",
  "WrongDomain",
  "NotMintRecipient",
  "UnexpectedRailContract",
  "NothingMinted",
  "TokenNotMapped",
  "AlreadyConfigured",
  "InsufficientLiquidity",
  "UnsupportedMessageVersion",
  "NotTheRail",
  "UnsupportedRoute",
  "GasFloatTooLow",
  "ProtectedAsset",
  "ExceedsRouteLimit",
] as const;

export type SorobanErrorName = (typeof SOROBAN_ERROR_NAMES)[number];

/** The EVM error set, in the order `HyperionErrors.sol` declares it. */
export const EVM_ERROR_NAMES = [
  "AlreadyInitialized",
  "NotInitialized",
  "Unauthorized",
  "NotRailReceiver",
  "RouteDisabled",
  "RouteIsPaused",
  "AdapterNotSet",
  "InvalidAmount",
  "AmountNotRepresentable",
  "DecimalOverflow",
  "InvalidDecimals",
  "SlippageExceeded",
  "FeeTooHigh",
  "AmountBelowMinimum",
  "FlowLimitExceeded",
  "InvalidLimit",
  "InvalidWindow",
  "LimitNotRaised",
  "InvalidDestination",
  "ZeroAddressKey",
  "MuxedNotSupported",
  "NotEvmAddress",
  "UnknownChain",
  "ReplayedMessage",
  "MalformedMessage",
  "UnsupportedHookVersion",
  "UnsupportedMessageVersion",
  "WrongDomain",
  "NotMintRecipient",
  "UnexpectedRailContract",
  "NothingMinted",
  "UnsupportedRoute",
  "TimelockNotQueued",
  "TimelockNotReady",
  "TimelockExpired",
  "TimelockDelayOutOfRange",
  "TimelockAlreadyExecuted",
  "ActionFieldNotEmpty",
  "ClaimNotFound",
  "ClaimAlreadySettled",
  "RecipientNotReady",
  "TokenNotRegistered",
  "TokenDisabled",
  "TokenNotMapped",
  "RailNotConfigured",
  "AlreadyConfigured",
  "ProtectedAsset",
  "ZeroAddress",
  "RefundFailed",
] as const;

export type EvmErrorName = (typeof EVM_ERROR_NAMES)[number];

/** Every name either chain can produce. */
export type HyperionErrorName = SorobanErrorName | EvmErrorName;

/**
 * Whose problem it is. The interface uses this to decide what to offer: an input fault wants the
 * form back, a limit fault wants a clock, and a config fault wants an honest apology rather than a
 * retry button that will fail again.
 */
export type ErrorFault =
  | "input" // the request was wrong, and changing it fixes this
  | "limit" // the request was fine and the protocol is throttling
  | "config" // an operator has not set something up yet
  | "rail" // the underlying rail said no, or has not said yes yet
  | "timing" // right request, wrong moment
  | "internal"; // should not happen, and if it does somebody wants to know

/**
 * Operational recovery category used by wallets, keepers, and support tooling.
 *
 * - `transient`: temporary throttle, liquidity, or pause state that can clear over time without
 *   altering request parameters, provided the prior attempt is known not to be in flight.
 * - `user_correctable`: caller can resolve by fixing destination, amount, slippage, route choice,
 *   account authorization, or recipient trustline prerequisites.
 * - `operator_action`: requires admin/guardian/keeper intervention or marks a terminal protocol
 *   invariant/replay state that callers must not retry.
 * - `unknown_outcome`: submission outcome is uncertain or the error originates from a newer
 *   contract deployment this SDK does not recognize; callers must inspect chain state first and
 *   never auto-retry blindly.
 */
export type ErrorRecoveryCategory =
  "transient" | "user_correctable" | "operator_action" | "unknown_outcome";

export const ERROR_RECOVERY_CATEGORIES: readonly ErrorRecoveryCategory[] = Object.freeze([
  "transient",
  "user_correctable",
  "operator_action",
  "unknown_outcome",
]);

/** Concrete action recommended to an automated caller or wallet UI. */
export type RecoveryAction =
  "wait_and_retry" | "correct_user_input" | "await_operator_or_halt" | "reconcile_chain_state";

/** Whether a failure was observed before broadcast, from a confirmed revert, or after an uncertain broadcast. */
export type SubmissionCertainty =
  "pre_broadcast_simulation" | "confirmed_revert" | "uncertain_submission";

export interface ErrorHelp {
  /** One sentence, written for the person who hit it rather than the person who wrote it. */
  readonly summary: string;
  readonly fault: ErrorFault;
  /** Whether the identical request could work later with nothing changed. */
  readonly retryable: boolean;
  /** Operational recovery bucket for automated retry and UX routing decisions. */
  readonly recoveryCategory: ErrorRecoveryCategory;
  /** The Soroban tag, when Stellar has this error at all. */
  readonly sorobanCode: number | null;
}

export interface ErrorRecoveryDecision {
  readonly errorName: string;
  readonly knownError: boolean;
  readonly category: ErrorRecoveryCategory;
  readonly action: RecoveryAction;
  /** True only when the failure is transient AND prior submission is known not to have landed. */
  readonly autoRetryRecommended: boolean;
  /** True when caller must check ledger/block state for an existing nonce or tx before retrying. */
  readonly requiresOnChainCheck: boolean;
  readonly sorobanCode: number | null;
  readonly summary: string;
}

export interface ClassifyErrorOptions {
  readonly submissionCertainty?: SubmissionCertainty;
}

export type SubmissionTransportStatus =
  | "simulated_revert"
  | "confirmed_revert"
  | "rpc_timeout"
  | "network_disconnect"
  | "mempool_pending"
  | "missing_receipt"
  | "ambiguous_gateway_error";

export interface SubmissionOutcomeInput {
  readonly transportStatus: SubmissionTransportStatus;
  readonly errorName?: string;
  readonly sorobanCode?: number;
}

const HELP: Record<HyperionErrorName, Omit<ErrorHelp, "sorobanCode" | "recoveryCategory">> = {
  AlreadyInitialized: {
    summary: "This contract was already set up once, and setup only happens once.",
    fault: "config",
    retryable: false,
  },
  NotInitialized: {
    summary: "This contract has not been set up yet, so there is nothing to call into.",
    fault: "config",
    retryable: false,
  },
  Unauthorized: {
    summary: "Whoever sent this is not allowed to.",
    fault: "input",
    retryable: false,
  },
  NotRailReceiver: {
    summary:
      "Something claimed to be a rail delivering funds and is not the contract registered for that rail.",
    fault: "internal",
    retryable: false,
  },
  Paused: {
    summary:
      "New transfers are paused. Anything already in flight still lands, because arrivals are never paused.",
    fault: "timing",
    retryable: true,
  },
  RouteDisabled: {
    summary: "That rail is switched off right now. Pick another one.",
    fault: "config",
    retryable: true,
  },
  RouteIsPaused: {
    summary: "That rail is temporarily paused. Pick another one.",
    fault: "timing",
    retryable: true,
  },
  AdapterNotSet: {
    summary: "Nothing is wired up to carry that rail yet.",
    fault: "config",
    retryable: false,
  },
  FlowLimitExceeded: {
    summary:
      "This would push the amount moved in the current window past its cap. The cap frees up as the window slides forward.",
    fault: "limit",
    retryable: true,
  },
  InvalidAmount: {
    summary: "That amount is zero, or it rounds to zero once fees come out.",
    fault: "input",
    retryable: false,
  },
  AmountNotRepresentable: {
    summary:
      "The destination chain cannot express that amount at its own precision, and Hyperion will not quietly round your money away.",
    fault: "input",
    retryable: false,
  },
  DecimalOverflow: {
    summary: "Converting between the two chains' precisions overflows. Send less.",
    fault: "input",
    retryable: false,
  },
  InvalidDecimals: {
    summary: "A token was described with a precision no token actually has.",
    fault: "config",
    retryable: false,
  },
  SlippageExceeded: {
    summary: "The amount that would land is below the floor you set.",
    fault: "limit",
    retryable: true,
  },
  FeeTooHigh: {
    summary: "The fee on this route is above the ceiling the contract enforces.",
    fault: "config",
    retryable: false,
  },
  InvalidDestination: {
    summary:
      "That destination address does not check out. Strkeys carry their own checksum, so this usually means a character went missing in a copy and paste.",
    fault: "input",
    retryable: false,
  },
  ZeroAddressKey: {
    summary: "The destination decodes to all zeroes, which is an address nobody holds the key for.",
    fault: "input",
    retryable: false,
  },
  MuxedNotSupported: {
    summary:
      "This rail has nowhere to carry a muxed sub account id, so the M address cannot be honoured. Use the underlying G address, or pick a rail that carries a payload.",
    fault: "input",
    retryable: false,
  },
  NotEvmAddress: {
    summary: "Twelve of those thirty two bytes are not zero, so that is not an EVM address.",
    fault: "input",
    retryable: false,
  },
  UnknownChain: {
    summary: "Hyperion has no route to a chain by that name.",
    fault: "input",
    retryable: false,
  },
  ReplayedMessage: {
    summary: "This delivery has already been processed once.",
    fault: "internal",
    retryable: false,
  },
  UnknownNonce: {
    summary: "No transfer was ever recorded under that number.",
    fault: "input",
    retryable: false,
  },
  TimelockNotQueued: {
    summary: "That admin action was never queued, so there is nothing to execute.",
    fault: "config",
    retryable: false,
  },
  TimelockNotReady: {
    summary: "The waiting period on that admin action has not run out yet.",
    fault: "timing",
    retryable: true,
  },
  TimelockExpired: {
    summary: "That admin action sat in the queue past its window and has to be proposed again.",
    fault: "timing",
    retryable: false,
  },
  TimelockDelayOutOfRange: {
    summary: "The proposed delay is outside the bounds the contract accepts.",
    fault: "config",
    retryable: false,
  },
  ClaimNotFound: {
    summary: "There is no parked claim with that number.",
    fault: "input",
    retryable: false,
  },
  ClaimAlreadySettled: {
    summary: "That claim already paid out.",
    fault: "timing",
    retryable: false,
  },
  RecipientNotReady: {
    summary:
      "The funds arrived but the recipient cannot hold this asset yet. On Stellar that means a missing trustline, and it is fixable: open the trustline, then settle the claim.",
    fault: "rail",
    retryable: true,
  },
  InvalidLimit: {
    summary: "That limit is not a number the flow guard can work with.",
    fault: "config",
    retryable: false,
  },
  InvalidWindow: {
    summary: "A flow window of zero has no meaning.",
    fault: "config",
    retryable: false,
  },
  TokenNotRegistered: {
    summary: "Hyperion does not carry that token.",
    fault: "config",
    retryable: false,
  },
  MalformedMessage: {
    summary: "A rail delivered something Hyperion cannot read.",
    fault: "internal",
    retryable: false,
  },
  UnsupportedHookVersion: {
    summary: "A CCTP hook arrived at a version this deployment does not know how to read.",
    fault: "internal",
    retryable: false,
  },
  RailNotConfigured: {
    summary: "That rail is not set up for this chain pair yet.",
    fault: "config",
    retryable: false,
  },
  WrongDomain: {
    summary: "The message was addressed to a different CCTP domain than this one.",
    fault: "internal",
    retryable: false,
  },
  NotMintRecipient: {
    summary: "CCTP minted to somebody other than this contract, so this is not ours to forward.",
    fault: "internal",
    retryable: false,
  },
  UnexpectedRailContract: {
    summary:
      "The message came from a contract that is not Hyperion on the other side. Arriving through a rail proves delivery, not authorship.",
    fault: "internal",
    retryable: false,
  },
  NothingMinted: {
    summary: "The rail reported a delivery but no balance actually moved.",
    fault: "rail",
    retryable: false,
  },
  TokenNotMapped: {
    summary: "This rail has no identifier on file for that token.",
    fault: "config",
    retryable: false,
  },
  AlreadyConfigured: {
    summary: "That lane or token is already set, and setting it twice is not allowed on purpose.",
    fault: "config",
    retryable: false,
  },
  InsufficientLiquidity: {
    summary: "The pool on the far side cannot cover this right now. Try a smaller amount or wait.",
    fault: "rail",
    retryable: true,
  },
  UnsupportedMessageVersion: {
    summary: "A rail message arrived at a version this deployment predates.",
    fault: "internal",
    retryable: false,
  },
  NotTheRail: {
    summary: "Only the rail contract itself can make that call.",
    fault: "internal",
    retryable: false,
  },
  UnsupportedRoute: {
    summary: "That rail cannot do what this transfer is asking of it.",
    fault: "input",
    retryable: false,
  },
  GasFloatTooLow: {
    summary:
      "The adapter is out of the gas it needs to pay the rail. Anybody can top it up, and somebody should.",
    fault: "config",
    retryable: true,
  },
  ProtectedAsset: {
    summary: "That asset is not one an operator is allowed to sweep out of the contract.",
    fault: "config",
    retryable: false,
  },
  AmountBelowMinimum: {
    summary: "That is below the smallest amount this route will carry.",
    fault: "input",
    retryable: false,
  },
  LimitNotRaised: {
    summary:
      "That action would lower a limit, and limits only go up without a timelock. Lowering one waits.",
    fault: "config",
    retryable: false,
  },
  TimelockAlreadyExecuted: {
    summary: "That admin action already ran.",
    fault: "timing",
    retryable: false,
  },
  ActionFieldNotEmpty: {
    summary: "The queued action carries a field the action kind does not use.",
    fault: "config",
    retryable: false,
  },
  TokenDisabled: {
    summary: "That token is registered but switched off for new transfers.",
    fault: "config",
    retryable: true,
  },
  ZeroAddress: {
    summary: "An address argument is zero, which is never the one anybody meant.",
    fault: "input",
    retryable: false,
  },
  RefundFailed: {
    summary:
      "Change was owed and the sender would not accept it. A contract that rejects a plain transfer cannot send through Hyperion.",
    fault: "input",
    retryable: false,
  },
  ExceedsRouteLimit: {
    summary: "That transfer exceeds the maximum single transfer limit configured for this route.",
    fault: "limit",
    retryable: false,
  },
};

const RECOVERY_CATEGORY_BY_NAME: Record<
  HyperionErrorName,
  Exclude<ErrorRecoveryCategory, "unknown_outcome">
> = {
  AlreadyInitialized: "operator_action",
  NotInitialized: "operator_action",
  Unauthorized: "user_correctable",
  NotRailReceiver: "operator_action",
  Paused: "transient",
  RouteDisabled: "operator_action",
  RouteIsPaused: "transient",
  AdapterNotSet: "operator_action",
  FlowLimitExceeded: "transient",
  InvalidAmount: "user_correctable",
  AmountNotRepresentable: "user_correctable",
  DecimalOverflow: "user_correctable",
  InvalidDecimals: "operator_action",
  SlippageExceeded: "user_correctable",
  FeeTooHigh: "operator_action",
  InvalidDestination: "user_correctable",
  ZeroAddressKey: "user_correctable",
  MuxedNotSupported: "user_correctable",
  NotEvmAddress: "user_correctable",
  UnknownChain: "user_correctable",
  ReplayedMessage: "operator_action",
  UnknownNonce: "user_correctable",
  TimelockNotQueued: "operator_action",
  TimelockNotReady: "transient",
  TimelockExpired: "operator_action",
  TimelockDelayOutOfRange: "operator_action",
  ClaimNotFound: "user_correctable",
  ClaimAlreadySettled: "operator_action",
  RecipientNotReady: "user_correctable",
  InvalidLimit: "operator_action",
  InvalidWindow: "operator_action",
  TokenNotRegistered: "operator_action",
  MalformedMessage: "operator_action",
  UnsupportedHookVersion: "operator_action",
  RailNotConfigured: "operator_action",
  WrongDomain: "operator_action",
  NotMintRecipient: "operator_action",
  UnexpectedRailContract: "operator_action",
  NothingMinted: "operator_action",
  TokenNotMapped: "operator_action",
  AlreadyConfigured: "operator_action",
  InsufficientLiquidity: "transient",
  UnsupportedMessageVersion: "operator_action",
  NotTheRail: "operator_action",
  UnsupportedRoute: "user_correctable",
  GasFloatTooLow: "operator_action",
  ProtectedAsset: "operator_action",
  AmountBelowMinimum: "user_correctable",
  LimitNotRaised: "operator_action",
  TimelockAlreadyExecuted: "operator_action",
  ActionFieldNotEmpty: "operator_action",
  TokenDisabled: "operator_action",
  ZeroAddress: "user_correctable",
  RefundFailed: "user_correctable",
  ExceedsRouteLimit: "user_correctable",
};

function actionForCategory(category: ErrorRecoveryCategory): RecoveryAction {
  switch (category) {
    case "transient":
      return "wait_and_retry";
    case "user_correctable":
      return "correct_user_input";
    case "operator_action":
      return "await_operator_or_halt";
    case "unknown_outcome":
      return "reconcile_chain_state";
  }
}

const SOROBAN_CODE_BY_NAME: ReadonlyMap<string, number> = new Map(
  SOROBAN_ERROR_NAMES.map((name, index) => [name, index + 1]),
);

/** Every error name with its Soroban tag and recovery category filled in. */
export const ERROR_HELP: Readonly<Record<HyperionErrorName, ErrorHelp>> = Object.freeze(
  Object.fromEntries(
    Object.entries(HELP).map(([name, help]) => [
      name,
      {
        ...help,
        recoveryCategory: RECOVERY_CATEGORY_BY_NAME[name as HyperionErrorName],
        sorobanCode: SOROBAN_CODE_BY_NAME.get(name) ?? null,
      },
    ]),
  ) as Record<HyperionErrorName, ErrorHelp>,
);

export const HYPERION_ERROR_NAMES: readonly HyperionErrorName[] = Object.keys(
  HELP,
) as HyperionErrorName[];

/** Precomputed baseline recovery decisions for confirmed or simulated reverts of known errors. */
export const ERROR_RECOVERY: Readonly<Record<HyperionErrorName, ErrorRecoveryDecision>> =
  Object.freeze(
    Object.fromEntries(
      HYPERION_ERROR_NAMES.map((name) => {
        const help = ERROR_HELP[name];
        const category = help.recoveryCategory;
        return [
          name,
          Object.freeze({
            errorName: name,
            knownError: true,
            category,
            action: actionForCategory(category),
            autoRetryRecommended: category === "transient",
            requiresOnChainCheck: false,
            sorobanCode: help.sorobanCode,
            summary: help.summary,
          }),
        ];
      }),
    ) as Record<HyperionErrorName, ErrorRecoveryDecision>,
  );

export function isHyperionErrorName(value: string): value is HyperionErrorName {
  return Object.prototype.hasOwnProperty.call(HELP, value);
}

/** The name behind a Soroban error tag, or null for a tag this build has never heard of. */
export function sorobanErrorName(code: number): SorobanErrorName | null {
  if (!Number.isInteger(code) || code < 1 || code > SOROBAN_ERROR_NAMES.length) return null;
  return SOROBAN_ERROR_NAMES[code - 1] ?? null;
}

/** The tag a Soroban contract returns for a name, or null if only the EVM side has it. */
export function sorobanErrorCode(name: HyperionErrorName): number | null {
  return SOROBAN_CODE_BY_NAME.get(name) ?? null;
}

/** What to show somebody, including for a name from a newer deployment than this package. */
export function describeError(name: string): ErrorHelp {
  if (isHyperionErrorName(name)) return ERROR_HELP[name];
  return {
    summary: `The contract returned ${name}, which this version of the app does not have a translation for.`,
    fault: "internal",
    retryable: false,
    recoveryCategory: "unknown_outcome",
    sorobanCode: null,
  };
}

/**
 * Classify a protocol error name for automated recovery and UI guidance.
 *
 * When `submissionCertainty === "uncertain_submission"`, even otherwise transient errors return
 * `category: "unknown_outcome"` with `autoRetryRecommended: false` so a dropped RPC connection or
 * ambiguous mempool state never triggers a duplicate transfer broadcast. Unknown future error
 * names likewise fall back conservatively to `unknown_outcome`.
 */
export function classifyProtocolError(
  name: string,
  options?: ClassifyErrorOptions,
): ErrorRecoveryDecision {
  const certainty: SubmissionCertainty = options?.submissionCertainty ?? "confirmed_revert";
  const normalizedName = name.trim();

  if (certainty === "uncertain_submission") {
    const known = isHyperionErrorName(normalizedName);
    const sorobanCode = known ? ERROR_HELP[normalizedName].sorobanCode : null;
    return {
      errorName: normalizedName.length > 0 ? normalizedName : "UnknownSubmissionError",
      knownError: known,
      category: "unknown_outcome",
      action: "reconcile_chain_state",
      autoRetryRecommended: false,
      requiresOnChainCheck: true,
      sorobanCode,
      summary:
        "Submission outcome is uncertain on the network; inspect ledger or block state before retrying to avoid duplicate execution.",
    };
  }

  if (isHyperionErrorName(normalizedName)) {
    return ERROR_RECOVERY[normalizedName];
  }

  const label = normalizedName.length > 0 ? normalizedName : "UnrecognizedError";
  return {
    errorName: label,
    knownError: false,
    category: "unknown_outcome",
    action: "reconcile_chain_state",
    autoRetryRecommended: false,
    requiresOnChainCheck: true,
    sorobanCode: null,
    summary: describeError(label).summary,
  };
}

/** Classify a numeric Soroban contract error code with conservative fallback on unknown codes. */
export function classifySorobanError(
  code: number,
  options?: ClassifyErrorOptions,
): ErrorRecoveryDecision {
  const resolved = sorobanErrorName(code);
  if (resolved !== null) {
    return classifyProtocolError(resolved, options);
  }
  return {
    errorName: `UnknownSorobanError(${String(code)})`,
    knownError: false,
    category: "unknown_outcome",
    action: "reconcile_chain_state",
    autoRetryRecommended: false,
    requiresOnChainCheck: true,
    sorobanCode: null,
    summary: `The Soroban contract returned unrecognized error tag ${String(code)}; inspect on-chain state before taking further action.`,
  };
}

/**
 * Evaluate a transaction submission outcome across transport status and decoded revert metadata.
 *
 * Any transport uncertainty (`rpc_timeout`, `network_disconnect`, `mempool_pending`,
 * `missing_receipt`, `ambiguous_gateway_error`) forces `category: "unknown_outcome"` and
 * `autoRetryRecommended: false`, regardless of any accompanying error hint.
 */
export function classifySubmissionOutcome(input: SubmissionOutcomeInput): ErrorRecoveryDecision {
  const isCertainRevert =
    input.transportStatus === "simulated_revert" || input.transportStatus === "confirmed_revert";

  if (!isCertainRevert) {
    const hint =
      input.errorName ??
      (input.sorobanCode !== undefined
        ? (sorobanErrorName(input.sorobanCode) ??
          `UnknownSorobanError(${String(input.sorobanCode)})`)
        : `UncertainSubmission(${input.transportStatus})`);
    return classifyProtocolError(hint, { submissionCertainty: "uncertain_submission" });
  }

  const certainty: SubmissionCertainty =
    input.transportStatus === "simulated_revert" ? "pre_broadcast_simulation" : "confirmed_revert";

  if (input.sorobanCode !== undefined) {
    return classifySorobanError(input.sorobanCode, { submissionCertainty: certainty });
  }
  if (input.errorName !== undefined) {
    return classifyProtocolError(input.errorName, { submissionCertainty: certainty });
  }
  return classifyProtocolError("", { submissionCertainty: "uncertain_submission" });
}

/**
 * A failure raised by this package rather than by a contract, carrying the same name the contract
 * would have used. Encoding a destination locally and having it rejected on chain for the same
 * reason should read the same in both places.
 */
export class HyperionProtocolError extends Error {
  readonly code: HyperionErrorName;

  constructor(code: HyperionErrorName, detail?: string) {
    const help = ERROR_HELP[code];
    // The code leads the message so a log line names the failure the contract would have named.
    // Reading "InvalidDestination" in a server log and `InvalidDestination()` in a reverted trace
    // and having to work out they are the same thing is a cost paid at the worst possible moment.
    const body = detail === undefined ? help.summary : `${help.summary} (${detail})`;
    super(`${code}: ${body}`);
    this.name = "HyperionProtocolError";
    this.code = code;
  }
}

/** Throw, in a form TypeScript accepts as the end of a code path. */
export function fail(code: HyperionErrorName, detail?: string): never {
  throw new HyperionProtocolError(code, detail);
}
