// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "openzeppelin/access/IAccessControl.sol";

import {
    ActionFieldNotEmpty,
    CircuitBreakerLatched,
    CircuitBreakerNotTripped,
    InvalidThreshold,
    TimelockExpired,
    TimelockNotReady,
    Unauthorized
} from "../../src/HyperionErrors.sol";
import {
    ActionKind,
    AdminAction,
    Origin,
    OutboundRequest,
    QuoteBlocker,
    RouteKind,
    RouteQuote
} from "../../src/HyperionTypes.sol";
import {OutboundProvenance} from "../../src/OutboundProvenance.sol";
import {IHyperionRouter} from "../../src/interfaces/IHyperionRouter.sol";
import {Fixture} from "../Fixture.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockRailAdapter} from "../mocks/MockRailAdapter.sol";

/// @title A token-wide emergency stop, distinct from the ordinary flow limit
/// @notice The breaker latches on a tighter rolling ceiling than the token's flow limit, refuses
/// every new departure for that token, and leaves arrivals and fixed-recipient claims alone.
/// @dev Resetting it is a timelocked admin action and never changes the threshold. That is the
/// whole safety argument: a trip is automatic, but re-arming it is a reviewed decision with a
/// delay.
contract RouterCircuitBreakerTest is Fixture {
    bytes32 internal constant MESSAGE_ID = keccak256("circuit.breaker.inbound");

    function setUp() public override {
        super.setUp();
        usdc.mint(railReceiver, 1_000_000e6);
        vm.prank(railReceiver);
        usdc.approve(address(router), type(uint256).max);
    }

    // -------------------------------------------------------------------------------------
    // Configuration boundaries
    // -------------------------------------------------------------------------------------

    function test_a_threshold_is_bounded_by_the_ordinary_flow_limit() public {
        AdminAction memory tooHigh = _empty(ActionKind.SetTokenCircuitBreakerThreshold);
        tooHigh.subject = address(usdc);
        tooHigh.amount = FLOW_LIMIT + 1;
        vm.prank(admin);
        vm.expectRevert(InvalidThreshold.selector);
        router.queueAction(tooHigh);

        AdminAction memory zero = _empty(ActionKind.SetTokenCircuitBreakerThreshold);
        zero.subject = address(usdc);
        zero.amount = 0;
        vm.prank(admin);
        vm.expectRevert(InvalidThreshold.selector);
        router.queueAction(zero);
    }

    function test_a_new_threshold_is_set_on_the_clock() public {
        _setBreakerThreshold(address(usdc), 500e6);

        // The threshold is effective: a departure under it still works, and one over it is
        // refused by the breaker rather than the ordinary route limit.
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(100e6));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 99_900_000, 500e6)
        );
        router.bridgeOut(_usdcRequest(1000e6));
    }

    function test_the_guardian_cannot_queue_a_breaker_change() public {
        AdminAction memory action = _empty(ActionKind.SetTokenCircuitBreakerThreshold);
        action.subject = address(usdc);
        action.amount = 500e6;

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole
            )
        );
        router.queueAction(action);
    }

    function test_a_threshold_can_wait_for_its_token_but_registration_enforces_the_bound() public {
        // A fresh deployment queues registration and the breaker in one phase. The breaker may
        // therefore land on an address that is not a token yet, which is harmless until a
        // registration tries to adopt a lower ceiling.
        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        AdminAction memory action = _empty(ActionKind.SetTokenCircuitBreakerThreshold);
        action.subject = address(dai);
        action.amount = 500e18;
        _run(action);

        AdminAction memory narrower = _empty(ActionKind.RegisterToken);
        narrower.subject = address(dai);
        narrower.amount = 400e18;
        narrower.decimals = 18;
        vm.prank(admin);
        vm.expectRevert(InvalidThreshold.selector);
        router.queueAction(narrower);

        _registerToken(address(dai), 18, 600e18);
        assertTrue(router.tokenConfig(address(dai)).registered);
    }

    function test_a_narrower_registration_cannot_leave_the_breaker_above_the_limit() public {
        _setBreakerThreshold(address(usdc), 500e6);

        AdminAction memory narrower = _empty(ActionKind.RegisterToken);
        narrower.subject = address(usdc);
        narrower.amount = 400e6;
        narrower.decimals = USDC_DECIMALS;

        vm.prank(admin);
        vm.expectRevert(InvalidThreshold.selector);
        router.queueAction(narrower);
    }

    // -------------------------------------------------------------------------------------
    // Tripping
    // -------------------------------------------------------------------------------------

    function test_the_departure_that_reaches_the_threshold_latches_it() public {
        _setBreakerThreshold(address(usdc), 999e6);

        // The immutable provenance child owns breaker state, so it is the emitter here.
        vm.expectEmit(true, true, true, true);
        emit IHyperionRouter.CircuitBreakerTripped(address(usdc), 999e6, 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 999e6, 999e6));
        router.bridgeOut(_usdcRequest(1e6));
    }

    function test_a_tripped_breaker_refuses_every_new_departure_for_that_token() public {
        _setBreakerThreshold(address(usdc), 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 999e6, 999e6));
        router.bridgeOut(_usdcRequest(1e6));
    }

    function test_a_departure_that_would_cross_the_threshold_is_refused_before_funds_move() public {
        _setBreakerThreshold(address(usdc), 500e6);

        uint256 senderBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 0, 500e6));
        router.bridgeOut(_usdcRequest(1000e6));

        assertEq(usdc.balanceOf(alice), senderBefore);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(address(cctpRail)), 0);
        assertEq(router.outboundNonce(), 0, "a refused attempt does not latch it");
    }

    function test_the_breaker_is_token_wide_rather_than_per_rail() public {
        _setBreakerThreshold(address(usdc), 500e6);

        // 299.7e6 crosses on one rail, and the same amount on another rail would take the token
        // to 599.4e6. The second must be refused even though each rail has its own ordinary limit.
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(300e6));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 299_700_000, 500e6)
        );
        router.bridgeOut(_itsRequest(300e6));

        vm.prank(alice);
        router.bridgeOut(_itsRequest(200e6));
    }

    function test_another_token_keeps_moving_while_one_breaker_is_tripped() public {
        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        _registerToken(address(dai), 18, 1_000_000e18);
        dai.mint(alice, 10e18);
        vm.prank(alice);
        dai.approve(address(router), type(uint256).max);

        _setBreakerThreshold(address(usdc), 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));

        OutboundRequest memory request = _usdcRequest(10e18);
        request.token = address(dai);
        vm.prank(alice);
        uint64 nonce = router.bridgeOut(request);
        assertEq(nonce, 2, "the USDC departure was the first");
        assertEq(dai.balanceOf(address(cctpRail)), 9.99e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 999e6, 999e6));
        router.bridgeOut(_usdcRequest(1e6));
    }

    // -------------------------------------------------------------------------------------
    // What the breaker deliberately does not stop
    // -------------------------------------------------------------------------------------

    function test_arrivals_and_fixed_recipient_claims_survive_a_trip() public {
        // A frozen recipient parks a claim. Unfreeze them, trip the token, and the saved claim
        // still pays the recipient the rail fixed before the breaker existed.
        usdc.setBlocked(bob, true);
        vm.prank(railReceiver);
        uint64 claimId = router.bridgeIn(RouteKind.Cctp, address(usdc), 500e6, bob, _origin(MESSAGE_ID));
        assertGt(claimId, 0);

        _setBreakerThreshold(address(usdc), 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));
        usdc.setBlocked(bob, false);

        vm.prank(stranger);
        router.settleClaim(claimId);
        assertEq(usdc.balanceOf(bob), 500e6, "the stored recipient was paid");

        // A fresh arrival is paid straight through while the same token's departures are stopped.
        vm.prank(railReceiver);
        router.bridgeIn(
            RouteKind.Cctp, address(usdc), 250e6, alice, _origin(keccak256("circuit.breaker.inbound.two"))
        );
        assertEq(usdc.balanceOf(alice), 10_000_000e6 - 1000e6 + 250e6);

        // And departures are still refused.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 999e6, 999e6));
        router.bridgeOut(_usdcRequest(1000e6));
    }

    // -------------------------------------------------------------------------------------
    // Reset policy
    // -------------------------------------------------------------------------------------

    function test_reset_is_timelocked_and_requires_an_admin() public {
        _setBreakerThreshold(address(usdc), 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));

        AdminAction memory reset = _empty(ActionKind.ResetTokenCircuitBreaker);
        reset.subject = address(usdc);

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole
            )
        );
        router.queueAction(reset);

        vm.prank(admin);
        uint64 id = router.queueAction(reset);
        uint64 eta = router.queuedAction(id).eta;
        vm.warp(eta - 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockNotReady.selector, eta));
        router.executeAction(id);
    }

    function test_reset_rearms_without_changing_the_threshold() public {
        _setBreakerThreshold(address(usdc), 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));

        AdminAction memory reset = _empty(ActionKind.ResetTokenCircuitBreaker);
        reset.subject = address(usdc);
        vm.prank(admin);
        uint64 id = router.queueAction(reset);
        vm.warp(block.timestamp + TIMELOCK + 1);

        vm.prank(admin);
        router.executeAction(id);

        // Re-armed: the same departure that tripped it can run again, and the same ceiling
        // applies, which the next refusal's threshold argument proves.
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 999e6, 999e6));
        router.bridgeOut(_usdcRequest(1e6));
    }

    function test_reset_needs_a_tripped_breaker_and_no_extra_fields() public {
        AdminAction memory reset = _empty(ActionKind.ResetTokenCircuitBreaker);
        reset.subject = address(usdc);
        vm.prank(admin);
        vm.expectRevert(CircuitBreakerNotTripped.selector);
        router.queueAction(reset);

        _setBreakerThreshold(address(usdc), 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));

        AdminAction memory withAmount = _empty(ActionKind.ResetTokenCircuitBreaker);
        withAmount.subject = address(usdc);
        withAmount.amount = 1;
        vm.prank(admin);
        vm.expectRevert(ActionFieldNotEmpty.selector);
        router.queueAction(withAmount);
    }

    function test_raising_the_threshold_does_not_quietly_reset_a_trip() public {
        _setBreakerThreshold(address(usdc), 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));

        _setBreakerThreshold(address(usdc), FLOW_LIMIT);

        // Only an explicit reset re-arms the breaker; the threshold argument in the refusal
        // proves the new ceiling was stored without clearing the latch.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 0, FLOW_LIMIT));
        router.bridgeOut(_usdcRequest(1000e6));
    }

    function test_a_ceiling_below_what_the_window_carried_latches_on_arrival() public {
        _setBreakerThreshold(address(usdc), 999e6);

        AdminAction memory lower = _empty(ActionKind.SetTokenCircuitBreakerThreshold);
        lower.subject = address(usdc);
        lower.amount = 500e6;
        vm.prank(admin);
        uint64 id = router.queueAction(lower);
        uint64 eta = router.queuedAction(id).eta;

        vm.warp(eta - 30 minutes);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(600e6));

        vm.warp(eta);
        vm.prank(admin);
        router.executeAction(id);

        (uint256 threshold, bool tripped) = router.circuitBreaker(address(usdc));
        assertEq(threshold, 500e6);
        assertTrue(tripped, "the new ceiling is already violated");

        _resetBreaker(address(usdc));
        (, tripped) = router.circuitBreaker(address(usdc));
        assertFalse(tripped, "and the reviewed reset can clear it");
    }

    // -------------------------------------------------------------------------------------
    // Quote diagnostics
    // -------------------------------------------------------------------------------------

    function test_a_quote_reports_a_crossing_departure_as_breaker_blocked() public {
        _setBreakerThreshold(address(usdc), 500e6);

        assertEq(uint8(_quote(1000e6).reason), uint8(QuoteBlocker.CircuitBreakerTripped));
        assertFalse(_quote(1000e6).available);

        // 100e6 gross is 99.9e6 net, which fits under the 500e6 breaker.
        assertEq(uint8(_quote(100e6).reason), uint8(QuoteBlocker.None));
        assertTrue(_quote(100e6).available);
    }

    function test_a_tripped_breaker_blocks_every_rail_in_the_ladder() public {
        _setBreakerThreshold(address(usdc), 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));

        RouteQuote[] memory quotes = router.quoteAll(address(usdc), 1e6, _dest(G_ADDR), STELLAR_DECIMALS);
        for (uint256 i; i < quotes.length; ++i) {
            assertFalse(quotes[i].available);
            assertEq(uint8(quotes[i].reason), uint8(QuoteBlocker.CircuitBreakerTripped));
        }

        assertEq(
            uint8(
                router.quoteV2(RouteKind.Cctp, address(usdc), 1e6, _dest(G_ADDR), STELLAR_DECIMALS).quote
                    .reason
            ),
            uint8(QuoteBlocker.CircuitBreakerTripped)
        );
    }

    // -------------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------------

    function test_crossing_refusal_does_not_latch_and_headroom_decays_without_a_boundary_reset() public {
        _setBreakerThreshold(address(usdc), 500e6);
        uint256 epochStart = (block.timestamp / FLOW_WINDOW + 1) * FLOW_WINDOW;
        vm.warp(epochStart + FLOW_WINDOW - 1);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(300e6));

        // Crossing a calendar boundary retains the previous window's full observation.
        vm.warp(epochStart + FLOW_WINDOW);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 299_700_000, 500e6)
        );
        router.bridgeOut(_usdcRequest(300e6));
        (, bool tripped) = router.circuitBreaker(address(usdc));
        assertFalse(tripped);
        assertEq(router.outboundNonce(), 1);
        assertEq(cctpRail.callCount(), 1);

        AdminAction memory reset = _empty(ActionKind.ResetTokenCircuitBreaker);
        reset.subject = address(usdc);
        vm.prank(admin);
        vm.expectRevert(CircuitBreakerNotTripped.selector);
        router.queueAction(reset);

        vm.warp(epochStart + FLOW_WINDOW + FLOW_WINDOW / 2);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(300e6));
        assertEq(router.outboundNonce(), 2);
        (, tripped) = router.circuitBreaker(address(usdc));
        assertFalse(tripped);
    }

    function test_a_latched_stop_survives_the_rolling_observation_expiring() public {
        _setBreakerThreshold(address(usdc), 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));
        vm.warp(block.timestamp + 3 * FLOW_WINDOW);
        (, bool tripped) = router.circuitBreaker(address(usdc));
        assertTrue(tripped);
        assertEq(uint8(_quote(1e6).reason), uint8(QuoteBlocker.CircuitBreakerTripped));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CircuitBreakerLatched.selector, address(usdc), 0, 999e6));
        router.bridgeOut(_usdcRequest(1e6));
    }

    function test_provider_failure_rolls_back_breaker_latch_flow_nonce_and_funds() public {
        _setBreakerThreshold(address(usdc), 999e6);
        uint256 senderBefore = usdc.balanceOf(alice);
        uint256 flowBefore = router.flowAvailable(address(usdc), RouteKind.Cctp);
        cctpRail.setDispatchReverts(true);
        vm.prank(alice);
        vm.expectRevert(MockRailAdapter.Rejected.selector);
        router.bridgeOut(_usdcRequest(1000e6));
        (, bool tripped) = router.circuitBreaker(address(usdc));
        assertFalse(tripped);
        assertEq(router.flowAvailable(address(usdc), RouteKind.Cctp), flowBefore);
        assertEq(router.outboundNonce(), 0);
        assertEq(cctpRail.callCount(), 0);
        assertEq(usdc.balanceOf(alice), senderBefore);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(address(cctpRail)), 0);

        cctpRail.setDispatchReverts(false);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));
        (, tripped) = router.circuitBreaker(address(usdc));
        assertTrue(tripped);
        assertEq(router.outboundNonce(), 1);
    }

    function test_breaker_child_refuses_external_accounting_and_configuration() public {
        // The creating router deploys its immutable provenance child at CREATE nonce one.
        address provenanceAddress =
            address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(router), hex"01")))));
        OutboundProvenance provenance = OutboundProvenance(provenanceAddress);
        assertEq(provenance.ROUTER(), address(router));
        AdminAction memory reset = _empty(ActionKind.ResetTokenCircuitBreaker);
        reset.subject = address(usdc);
        vm.expectRevert(Unauthorized.selector);
        provenance.consumeBreaker(address(usdc), 1);
        vm.expectRevert(Unauthorized.selector);
        provenance.configureBreaker(reset);
    }

    function test_threshold_execution_rechecks_a_limit_lowered_while_queued() public {
        AdminAction memory action = _empty(ActionKind.SetTokenCircuitBreakerThreshold);
        action.subject = address(usdc);
        action.amount = 500e6;
        vm.prank(admin);
        uint64 id = router.queueAction(action);
        uint64 eta = router.queuedAction(id).eta;
        vm.prank(guardian);
        router.lowerTokenFlowLimit(address(usdc), 400e6);
        vm.warp(eta);
        vm.prank(admin);
        vm.expectRevert(InvalidThreshold.selector);
        router.executeAction(id);
        assertFalse(router.queuedAction(id).executed);
        (uint256 threshold,) = router.circuitBreaker(address(usdc));
        assertEq(threshold, BREAKER_THRESHOLD);
    }

    function test_queued_reset_cannot_execute_after_another_reset_rearms_the_breaker() public {
        _setBreakerThreshold(address(usdc), 999e6);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));
        AdminAction memory reset = _empty(ActionKind.ResetTokenCircuitBreaker);
        reset.subject = address(usdc);
        vm.startPrank(admin);
        uint64 first = router.queueAction(reset);
        uint64 second = router.queueAction(reset);
        vm.stopPrank();
        vm.warp(router.queuedAction(first).eta);
        vm.prank(admin);
        router.executeAction(first);
        vm.prank(admin);
        vm.expectRevert(CircuitBreakerNotTripped.selector);
        router.executeAction(second);
        assertFalse(router.queuedAction(second).executed);
    }

    function test_threshold_action_accepts_the_expiry_boundary_and_refuses_after_it() public {
        AdminAction memory action = _empty(ActionKind.SetTokenCircuitBreakerThreshold);
        action.subject = address(usdc);
        action.amount = 500e6;
        vm.startPrank(admin);
        uint64 first = router.queueAction(action);
        uint64 second = router.queueAction(action);
        vm.stopPrank();
        uint64 expiresAt = router.queuedAction(first).expiresAt;
        vm.warp(expiresAt);
        vm.prank(admin);
        router.executeAction(first);
        vm.warp(uint256(expiresAt) + 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockExpired.selector, expiresAt));
        router.executeAction(second);
        assertFalse(router.queuedAction(second).executed);
    }

    function _quote(uint256 amount) private view returns (RouteQuote memory) {
        return router.quote(RouteKind.Cctp, address(usdc), amount, _dest(G_ADDR), STELLAR_DECIMALS);
    }

    function _itsRequest(uint256 amount) private view returns (OutboundRequest memory request) {
        request = _usdcRequest(amount);
        request.route = RouteKind.AxelarIts;
    }

    function _origin(bytes32 messageId) private pure returns (Origin memory) {
        return Origin({chain: STELLAR, nonce: 7, messageId: messageId, sender: bytes32(0)});
    }
}
