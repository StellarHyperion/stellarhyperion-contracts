// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ActionFieldNotEmpty,
    AdapterCodeMissing,
    AdapterIdentityMismatch,
    AdapterMethodUnavailable,
    CircuitBreakerLatched,
    CircuitBreakerNotTripped,
    FeeTooHigh,
    InvalidDecimals,
    InvalidLimit,
    InvalidThreshold,
    InvalidWindow,
    LimitNotRaised,
    TimelockDelayOutOfRange,
    TokenNotRegistered,
    Unauthorized,
    UpgradeableAdapterUnsupported,
    ZeroAddress
} from "./HyperionErrors.sol";
import {ActionKind, AdminAction, RouteKind, TokenConfig} from "./HyperionTypes.sol";
import {AmountMath} from "./libraries/AmountMath.sol";
import {FlowGuard, FlowWindow} from "./libraries/FlowGuard.sol";

/// @title Current router proposal constraints
/// @notice Read-only getters used by the immutable action validator and token-wide breaker.
interface IRouterActionState {
    /// @notice Read the router's current constraint.
    function tokenConfig(address token) external view returns (TokenConfig memory);
    /// @notice Read the router's current constraint.
    function MIN_TIMELOCK_DELAY() external view returns (uint64);
    /// @notice Read the router's current constraint.
    function MAX_TIMELOCK_DELAY() external view returns (uint64);
    /// @notice Read the router's current constraint.
    function MIN_FLOW_WINDOW() external view returns (uint64);
    /// @notice Read the router's current constraint.
    function MAX_FLOW_WINDOW() external view returns (uint64);
    /// @notice The router's active rolling window length.
    function flowWindow() external view returns (uint64);
}

/// @title Immutable governance validation and token-wide breaker accounting
/// @notice Evaluates the creating router's proposals and maintains its emergency breaker state.
/// Only the creating router can charge or configure breakers. This child cannot write router
/// storage, move funds or change either contract's code.
contract RouterActionValidator {
    using FlowGuard for FlowWindow;

    /// @notice The fixed router whose proposals this validator checks.
    address public immutable ROUTER;

    /// @dev The emergency breaker is token-wide rather than per rail: the risk it exists for is
    /// the asset itself misbehaving, and splitting the signal across four counters would let an
    /// attacker spread the same exposure over every rail and trip none of them.
    struct BreakerState {
        uint256 threshold;
        bool tripped;
        FlowWindow flow;
    }
    mapping(address token => BreakerState state) private _breakers;

    /// @notice A token's emergency breaker latched and new departures for it are refused.
    event CircuitBreakerTripped(address indexed token, uint256 observedAmount, uint256 threshold);

    /// @notice Bind the validator to the creating router.
    constructor() {
        ROUTER = msg.sender;
    }

    /// @notice Read a token's emergency breaker threshold and latch state.
    function circuitBreaker(address token) public view returns (uint256 threshold, bool tripped) {
        BreakerState storage breaker = _breakers[token];
        return (breaker.threshold, breaker.tripped);
    }

    /// @notice Charge the token-wide breaker and latch it at the threshold.
    /// @dev Called only by the router, immediately after the route flow limit is charged.
    function consumeBreaker(address token, uint256 net) external {
        if (msg.sender != ROUTER) revert Unauthorized();
        BreakerState storage breaker = _breakers[token];
        uint256 threshold = breaker.threshold;
        if (threshold == 0) return;

        uint64 window = IRouterActionState(ROUTER).flowWindow();
        (bool blocked, uint256 observed,) = _breakerBlocked(token, net, window);
        if (blocked) revert CircuitBreakerLatched(token, observed, threshold);

        uint64 timestamp = uint64(block.timestamp);
        breaker.flow = breaker.flow.consume(threshold, net, timestamp, window);
        observed = breaker.flow.effectiveConsumed(timestamp, window);
        if (observed >= threshold) _latchBreaker(token, observed, threshold);
    }

    /// @notice Apply a queued threshold change or reset to the breaker state.
    function configureBreaker(AdminAction calldata action) external {
        if (msg.sender != ROUTER) revert Unauthorized();
        BreakerState storage breaker = _breakers[action.subject];
        uint64 window = IRouterActionState(ROUTER).flowWindow();
        if (action.kind == ActionKind.SetTokenCircuitBreakerThreshold) {
            breaker.threshold = action.amount;
            uint256 observed = breaker.flow.effectiveConsumed(uint64(block.timestamp), window);
            if (observed >= action.amount) _latchBreaker(action.subject, observed, action.amount);
        } else {
            breaker.tripped = false;
            delete breaker.flow;
        }
    }

    /// @dev Whether `net` is refused right now, plus the numbers an operator needs to see why.
    function _breakerBlocked(address token, uint256 net, uint64 window)
        internal
        view
        returns (bool blocked, uint256 observed, uint256 threshold)
    {
        BreakerState storage breaker = _breakers[token];
        threshold = breaker.threshold;
        observed = breaker.flow.effectiveConsumed(uint64(block.timestamp), window);
        if (breaker.tripped) return (true, observed, threshold);
        blocked = threshold != 0 && (observed >= threshold || net > threshold - observed);
    }

    function _latchBreaker(address token, uint256 observed, uint256 threshold) private {
        BreakerState storage breaker = _breakers[token];
        if (breaker.tripped) return;
        breaker.tripped = true;
        emit CircuitBreakerTripped(token, observed, threshold);
    }

    /// @notice Validate a proposal against the router's actual current state.
    function validate(AdminAction calldata action) external view {
        if (msg.sender != ROUTER) revert Unauthorized();
        IRouterActionState target = IRouterActionState(ROUTER);
        ActionKind kind = action.kind;
        bool usesRoute = kind == ActionKind.SetAdapter || kind == ActionKind.SetRailReceiver
            || kind == ActionKind.EnableRoute || kind == ActionKind.SetRouteFlowLimit;
        bool usesSubject = kind == ActionKind.SetTreasury || kind == ActionKind.SetAdmin
            || kind == ActionKind.SetGuardian || kind == ActionKind.SetAdapter
            || kind == ActionKind.SetRailReceiver || kind == ActionKind.RegisterToken
            || kind == ActionKind.RaiseTokenFlowLimit || kind == ActionKind.SetRouteFlowLimit
            || kind == ActionKind.SetTokenEnabled || kind == ActionKind.SetTokenCircuitBreakerThreshold
            || kind == ActionKind.ResetTokenCircuitBreaker;
        bool usesAmount = kind == ActionKind.SetFeeBps || kind == ActionKind.EnableRoute
            || kind == ActionKind.RegisterToken || kind == ActionKind.RaiseTokenFlowLimit
            || kind == ActionKind.SetRouteFlowLimit || kind == ActionKind.SetTimelockDelay
            || kind == ActionKind.SetFlowWindow || kind == ActionKind.SetTokenEnabled
            || kind == ActionKind.SetTokenCircuitBreakerThreshold;
        bool usesDecimals = kind == ActionKind.RegisterToken;

        if (!usesRoute && action.route != RouteKind.Cctp) revert ActionFieldNotEmpty();
        if (!usesSubject && action.subject != address(0)) revert ActionFieldNotEmpty();
        if (!usesAmount && action.amount != 0) revert ActionFieldNotEmpty();
        if (!usesDecimals && action.decimals != 0) revert ActionFieldNotEmpty();
        if (usesSubject && action.subject == address(0)) revert ZeroAddress();

        if (kind == ActionKind.SetFeeBps && action.amount > AmountMath.MAX_FEE_BPS) revert FeeTooHigh();
        if (kind == ActionKind.EnableRoute && action.amount > 1) revert InvalidLimit();
        if (kind == ActionKind.SetTokenEnabled) {
            if (action.amount > 1) revert InvalidLimit();
            if (!target.tokenConfig(action.subject).registered) revert TokenNotRegistered();
        }
        if (kind == ActionKind.RegisterToken) {
            if (action.decimals > AmountMath.MAX_DECIMALS) revert InvalidDecimals();
            (bool okDec, bytes memory retDec) =
                action.subject.staticcall(abi.encodeWithSignature("decimals()"));
            if (!okDec || retDec.length != 32 || abi.decode(retDec, (uint8)) != action.decimals) {
                revert InvalidDecimals();
            }
            (bool okBal, bytes memory retBal) =
                action.subject.staticcall(abi.encodeWithSignature("balanceOf(address)", ROUTER));
            if (!okBal || retBal.length != 32) {
                revert TokenNotRegistered();
            }
        }
        if (kind == ActionKind.RaiseTokenFlowLimit) {
            TokenConfig memory cfg = target.tokenConfig(action.subject);
            if (!cfg.registered) revert TokenNotRegistered();
            if (action.amount <= cfg.flowLimit) revert LimitNotRaised();
        }
        _validateBreaker(action, kind, target);
        if (kind == ActionKind.SetTimelockDelay) {
            if (action.amount < target.MIN_TIMELOCK_DELAY() || action.amount > target.MAX_TIMELOCK_DELAY()) {
                revert TimelockDelayOutOfRange();
            }
        }
        if (kind == ActionKind.SetFlowWindow) {
            if (action.amount < target.MIN_FLOW_WINDOW() || action.amount > target.MAX_FLOW_WINDOW()) {
                revert InvalidWindow();
            }
        }
        if (kind == ActionKind.SetAdapter) _validateAdapter(action);
    }

    function _validateBreaker(AdminAction calldata action, ActionKind kind, IRouterActionState target)
        private
        view
    {
        if (kind == ActionKind.RegisterToken) {
            // A registration cannot narrow the ordinary ceiling below an existing breaker.
            if (_breakers[action.subject].threshold > action.amount) revert InvalidThreshold();
        } else if (kind == ActionKind.SetTokenCircuitBreakerThreshold) {
            if (action.amount == 0) revert InvalidThreshold();
            // A fresh deployment queues registration and the breaker together, so an unregistered
            // token may carry a threshold until registration lands and enforces the bound.
            TokenConfig memory cfg = target.tokenConfig(action.subject);
            if (cfg.registered && action.amount > cfg.flowLimit) revert InvalidThreshold();
        } else if (kind == ActionKind.ResetTokenCircuitBreaker) {
            if (!target.tokenConfig(action.subject).registered) revert TokenNotRegistered();
            if (!_breakers[action.subject].tripped) revert CircuitBreakerNotTripped();
        }
    }

    function _validateAdapter(AdminAction memory action) private view {
        if (action.subject.code.length == 0) revert AdapterCodeMissing();
        (bool okRouter, bytes memory routerData) =
            action.subject.staticcall(abi.encodeWithSignature("ROUTER()"));
        if (
            !okRouter || routerData.length != 32
                || abi.decode(routerData, (uint256)) != uint256(uint160(ROUTER))
        ) {
            revert AdapterIdentityMismatch();
        }
        address subject = action.subject;
        (bool okRoute, bytes memory routeData) = subject.staticcall(abi.encodeWithSignature("route()"));
        if (!okRoute || routeData.length != 32 || abi.decode(routeData, (uint256)) != uint256(action.route)) {
            revert AdapterIdentityMismatch();
        }
        (bool okSupports, bytes memory supportsData) =
            action.subject.staticcall(abi.encodeWithSignature("supportsChain(string)", ""));
        if (!okSupports || supportsData.length != 32 || abi.decode(supportsData, (uint256)) > 1) {
            revert AdapterMethodUnavailable();
        }
        (bool okImplementation, bytes memory implementationData) =
            action.subject.staticcall(abi.encodeWithSignature("implementation()"));
        if (
            okImplementation && implementationData.length == 32
                && abi.decode(implementationData, (uint256)) != 0
        ) {
            revert UpgradeableAdapterUnsupported();
        }
    }
}
