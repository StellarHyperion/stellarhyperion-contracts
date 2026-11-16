// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "openzeppelin/access/IAccessControl.sol";

import {
    ActionFieldNotEmpty,
    CircuitBreakerActive,
    CircuitBreakerNotConfigured,
    InvalidLimit,
    LimitNotRaised,
    TokenNotRegistered,
    Unauthorized
} from "../../src/HyperionErrors.sol";
import {
    ActionKind,
    AdminAction,
    Origin,
    OutboundRequest,
    PendingClaim,
    QuoteBlocker,
    RouteKind,
    RouteQuote,
    TokenCircuitBreaker
} from "../../src/HyperionTypes.sol";
import {IHyperionRouter} from "../../src/interfaces/IHyperionRouter.sol";
import {Fixture} from "../Fixture.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title Per-token emergency circuit-breaker tests
/// @notice Verifies cumulative departure thresholds, inbound continuity, and timelocked reset bounds.
contract CircuitBreakerTest is Fixture {
    MockERC20 internal eurc;

    function setUp() public override {
        super.setUp();
        eurc = new MockERC20("Euro Coin", "EURC", USDC_DECIMALS);
        _registerToken(address(eurc), USDC_DECIMALS, FLOW_LIMIT);
        eurc.mint(alice, 10_000_000e6);
        vm.prank(alice);
        eurc.approve(address(router), type(uint256).max);
    }

    function _origin(bytes32 messageId, uint64 nonce) internal pure returns (Origin memory) {
        return Origin({chain: STELLAR, nonce: nonce, messageId: messageId, sender: G_KEY});
    }

    function test_reaching_threshold_latches_breaker_and_stops_departures_only_for_that_token() public {
        _setFeeBps(0);
        _setTokenCircuitThreshold(address(usdc), 1000e6);

        vm.prank(alice);
        router.bridgeOut(_usdcRequest(600e6));
        assertFalse(router.tokenCircuitBreaker(address(usdc)).tripped);
        assertEq(router.circuitRemaining(address(usdc)), 400e6);

        vm.expectEmit(true, true, false, true, address(router));
        emit IHyperionRouter.CircuitBreakerTripped(address(usdc), alice, 1000e6, 1000e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(400e6));

        TokenCircuitBreaker memory cb = router.tokenCircuitBreaker(address(usdc));
        assertTrue(cb.configured);
        assertTrue(cb.tripped);
        assertEq(cb.cumulativeVolume, 1000e6);
        assertEq(router.circuitRemaining(address(usdc)), 0);

        // Even after several flow windows pass, the tripped circuit breaker remains latched.
        vm.warp(block.timestamp + 6 hours);

        RouteQuote memory usdcQuote =
            router.quote(RouteKind.Cctp, address(usdc), 10e6, _dest(G_ADDR), STELLAR_DECIMALS);
        assertFalse(usdcQuote.available);
        assertEq(uint8(usdcQuote.reason), uint8(QuoteBlocker.CircuitBreakerTripped));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CircuitBreakerActive.selector, address(usdc), 10e6, 0));
        router.bridgeOut(_usdcRequest(10e6));

        // Unrelated registered tokens remain open for departures.
        OutboundRequest memory eurcReq = _tokenRequest(address(eurc), 250e6, STELLAR_DECIMALS);
        vm.prank(alice);
        uint64 eurcNonce = router.bridgeOut(eurcReq);
        assertEq(eurcNonce, 3);
    }

    function test_exceeding_remaining_headroom_reverts_and_quotes_circuit_blocker() public {
        _setFeeBps(0);
        _setTokenCircuitThreshold(address(usdc), 500e6);

        vm.prank(alice);
        router.bridgeOut(_usdcRequest(350e6));
        assertEq(router.circuitRemaining(address(usdc)), 150e6);

        RouteQuote memory overQuote =
            router.quote(RouteKind.Cctp, address(usdc), 200e6, _dest(G_ADDR), STELLAR_DECIMALS);
        assertFalse(overQuote.available);
        assertEq(uint8(overQuote.reason), uint8(QuoteBlocker.CircuitBreakerTripped));

        RouteQuote memory underQuote =
            router.quote(RouteKind.Cctp, address(usdc), 100e6, _dest(G_ADDR), STELLAR_DECIMALS);
        assertTrue(underQuote.available);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CircuitBreakerActive.selector, address(usdc), 200e6, 150e6));
        router.bridgeOut(_usdcRequest(200e6));
    }

    function test_guardian_tightening_and_emergency_trip_take_effect_immediately() public {
        _setFeeBps(0);

        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        router.tightenTokenCircuitThreshold(address(usdc), 800e6);

        vm.prank(guardian);
        router.tightenTokenCircuitThreshold(address(usdc), 800e6);
        assertEq(router.tokenCircuitBreaker(address(usdc)).threshold, 800e6);

        // Guardian cannot raise an existing threshold without the timelock.
        vm.prank(guardian);
        vm.expectRevert(LimitNotRaised.selector);
        router.tightenTokenCircuitThreshold(address(usdc), 800e6);

        vm.prank(alice);
        router.bridgeOut(_usdcRequest(500e6));

        // Tightening below accumulated volume immediately latches the breaker.
        vm.prank(guardian);
        router.tightenTokenCircuitThreshold(address(usdc), 400e6);
        assertTrue(router.tokenCircuitBreaker(address(usdc)).tripped);

        // Emergency manual trip also works on an un-tripped configured token.
        vm.prank(guardian);
        router.tightenTokenCircuitThreshold(address(eurc), 900e6);
        vm.prank(guardian);
        router.tripTokenCircuitBreaker(address(eurc));
        assertTrue(router.tokenCircuitBreaker(address(eurc)).tripped);
    }

    function test_inbound_delivery_and_fixed_recipient_claims_stay_open_while_tripped() public {
        _setFeeBps(0);
        _setTokenCircuitThreshold(address(usdc), 200e6);
        vm.prank(guardian);
        router.tripTokenCircuitBreaker(address(usdc));
        assertTrue(router.tokenCircuitBreaker(address(usdc)).tripped);

        // Direct inbound delivery still succeeds.
        usdc.mint(railReceiver, 500e6);
        vm.startPrank(railReceiver);
        usdc.approve(address(router), 500e6);
        uint64 directClaim =
            router.bridgeIn(RouteKind.Cctp, address(usdc), 200e6, bob, _origin(keccak256("msg-1"), 11));
        vm.stopPrank();
        assertEq(directClaim, 0);
        assertEq(usdc.balanceOf(bob), 200e6);

        // Frozen recipient parks a fixed-recipient claim and settles cleanly once unfrozen.
        usdc.setBlocked(bob, true);
        vm.prank(railReceiver);
        uint64 parkedId =
            router.bridgeIn(RouteKind.Cctp, address(usdc), 300e6, bob, _origin(keccak256("msg-2"), 12));
        assertGt(parkedId, 0);

        usdc.setBlocked(bob, false);
        vm.prank(stranger);
        router.settleClaim(parkedId);

        PendingClaim memory settled = router.pendingClaim(parkedId);
        assertTrue(settled.settled);
        assertEq(usdc.balanceOf(bob), 500e6);
    }

    function test_reset_cannot_expand_risk_or_bypass_authorized_timelock_policy() public {
        _setFeeBps(0);
        _setTokenCircuitThreshold(address(usdc), 500e6);

        vm.prank(alice);
        router.bridgeOut(_usdcRequest(500e6));
        assertTrue(router.tokenCircuitBreaker(address(usdc)).tripped);

        // Guardian cannot queue a reset.
        AdminAction memory resetAttempt = _empty(ActionKind.ResetTokenCircuitBreaker);
        resetAttempt.subject = address(usdc);
        resetAttempt.amount = 500e6;
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole
            )
        );
        router.queueAction(resetAttempt);

        // Admin cannot queue a reset with zero ceiling or higher ceiling than active policy.
        resetAttempt.amount = 0;
        vm.prank(admin);
        vm.expectRevert(InvalidLimit.selector);
        router.queueAction(resetAttempt);

        resetAttempt.amount = 600e6;
        vm.prank(admin);
        vm.expectRevert(InvalidLimit.selector);
        router.queueAction(resetAttempt);

        // Raising threshold while tripped updates policy ceiling ONLY and does NOT untrip.
        _setTokenCircuitThreshold(address(usdc), 750e6);
        assertTrue(router.tokenCircuitBreaker(address(usdc)).tripped);
        assertEq(router.tokenCircuitBreaker(address(usdc)).cumulativeVolume, 500e6);

        // If guardian tightens ceiling while a reset is queued, stale wider reset is rejected.
        resetAttempt.amount = 750e6;
        uint64 staleId = _mature(resetAttempt);
        vm.prank(guardian);
        router.tightenTokenCircuitThreshold(address(usdc), 400e6);
        vm.prank(admin);
        vm.expectRevert(InvalidLimit.selector);
        router.executeAction(staleId);

        // Authorized timelocked reset at or below active policy ceiling restores departures.
        _resetTokenCircuitBreaker(address(usdc), 400e6);
        TokenCircuitBreaker memory afterReset = router.tokenCircuitBreaker(address(usdc));
        assertFalse(afterReset.tripped);
        assertEq(afterReset.cumulativeVolume, 0);
        assertEq(afterReset.threshold, 400e6);

        vm.prank(alice);
        uint64 resumedNonce = router.bridgeOut(_usdcRequest(250e6));
        assertGt(resumedNonce, 0);
    }

    function test_circuit_action_validation_rejects_unused_fields_and_unconfigured_resets() public {
        MockERC20 unlisted = new MockERC20("Unlisted", "UNL", 6);

        AdminAction memory badField = _empty(ActionKind.SetTokenCircuitThreshold);
        badField.subject = address(usdc);
        badField.amount = 100e6;
        badField.decimals = 6;
        vm.prank(admin);
        vm.expectRevert(ActionFieldNotEmpty.selector);
        router.queueAction(badField);

        AdminAction memory resetUnconfigured = _empty(ActionKind.ResetTokenCircuitBreaker);
        resetUnconfigured.subject = address(usdc);
        resetUnconfigured.amount = 100e6;
        vm.prank(admin);
        vm.expectRevert(CircuitBreakerNotConfigured.selector);
        router.queueAction(resetUnconfigured);

        vm.prank(guardian);
        vm.expectRevert(TokenNotRegistered.selector);
        router.tripTokenCircuitBreaker(address(unlisted));
    }
}
