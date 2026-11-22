// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Hyperion's refusals, in one place.
//
// Every name here is the name the Stellar side uses for the same refusal. `hyperion_core`
// numbers its errors because Soroban puts an integer in the transaction result; Solidity gets a
// selector instead, and the shared vocabulary is the point rather than the shared integer. An
// operator reading "MuxedNotSupported" off an EVM revert and off a Soroban transaction result
// should not have to look up which one means what.

import {RouteKind} from "./HyperionTypes.sol";

// Lifecycle and roles.
error AlreadyInitialized();
error NotInitialized();
error Unauthorized();
error NotRailReceiver();
error RouteDisabled();
error RouteIsPaused(RouteKind route);
error AdapterNotSet();
error AdapterCodeMissing();
error AdapterIdentityMismatch();
error UpgradeableAdapterUnsupported();

// Amounts, decimals and fees.
error InvalidAmount();
error AmountNotRepresentable();
error DecimalOverflow();
error InvalidDecimals();
error SlippageExceeded(uint256 wanted, uint256 got);
error FeeTooHigh();
error AmountBelowMinimum();

// Flow control.
error FlowLimitExceeded(uint256 requested, uint256 available);
error InvalidLimit();
error InvalidWindow();
error LimitNotRaised();

// Per-token emergency circuit breaker. Separate vocabulary from the ordinary flow limit so an
// operator can tell a throughput refusal from an emergency stop in a revert trace.
error CircuitBreakerLatched(address token, uint256 observedAmount, uint256 threshold);
error CircuitBreakerNotTripped();
error InvalidThreshold();

// Destinations.
error InvalidDestination();
error ZeroAddressKey();
error MuxedNotSupported();
error NotEvmAddress();
error UnknownChain();

// Messages.
error ReplayedMessage();
error MalformedMessage();
error UnsupportedHookVersion();
error UnsupportedMessageVersion();
error WrongDomain();
error NotMintRecipient();
error UnexpectedRailContract();
error NothingMinted();
error UnsupportedRoute();

// The timelock.
error TimelockNotQueued();
error TimelockNotReady(uint64 eta);
error TimelockExpired(uint64 expiredAt);
error TimelockDelayOutOfRange();
error TimelockAlreadyExecuted();
error ActionFieldNotEmpty();

// Claims.
error ClaimNotFound();
error ClaimAlreadySettled();
error RecipientNotReady();

// Tokens and wiring.
error TokenNotRegistered();
error TokenDisabled();
error TokenNotMapped();
error RailNotConfigured();
error AlreadyConfigured();
error ProtectedAsset();
error ZeroAddress();

// Native currency, on the way back out.
//
// Rails quote destination gas high and refund the difference, so a `bridgeOut` usually ends by
// sending change to the sender. A sender who cannot accept it is refused rather than tipped,
// because silently keeping the difference is a second fee nobody agreed to.
error RefundFailed();
error NoRefundCredit();

/// @notice The native provider payment exceeds the explicit sender cap.
error ProviderBudgetExceeded();

/// @notice The adapter lacks a usable local dispatch validation method.
error AdapterMethodUnavailable();

error InvalidSignature();
error IntentExpired(uint256 deadline);
error IntentNonceMismatch(uint256 expected, uint256 provided);
error IntentDomainMismatch();

// Messenger rotation.
error RotationAlreadyPending();
error RotationNotPending();
error RotationNotReady();
error MessengerUnchanged();
error OldMessengerExpired();
/// @notice No outbound ITS transfer is registered for this top-up intent.
error TopUpIntentNotFound();

/// @notice A top-up changed an intent's bound message, destination, or refund recipient.
error TopUpBindingMismatch();

/// @notice A relayer fee names an unregistered or disabled fee asset.
error FeeTokenNotSupported();
/// @notice Fee fields or observed token balance changes violate the signed charge.
error InvalidRelayerFee();

/// @notice Token recovery is not available for this asset.
error TokenRecoveryForbidden();

/// @notice Requested recovery exceeds custody after outstanding claims are reserved.
error RecoveryExceedsSurplus();

/// @notice Tracked claim liabilities cannot cover a claim being settled.
error ClaimLiabilityInsufficient();
// Outbound preconditions, batching, and destination flow controls.
/// @notice The reviewed outbound configuration no longer matches the current quote.
error FingerprintMismatch();
/// @notice The caller's outbound deadline has passed.
error RequestExpired();
/// @notice The outbound batch exceeds its item or aggregate amount bound.
error BatchLimitExceeded();
/// @notice The destination's outbound flow window cannot accept this transfer.
error DestinationFlowLimitExceeded();
