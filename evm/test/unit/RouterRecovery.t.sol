// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";

import {
    ProtectedAsset,
    TimelockAlreadyExecuted,
    TimelockNotReady,
    Unauthorized
} from "../../src/HyperionErrors.sol";
import {
    Origin,
    OutboundRequest,
    RecoveryRequest,
    RouteKind,
    TokenLiabilityReport
} from "../../src/HyperionTypes.sol";
import {IHyperionRouter} from "../../src/interfaces/IHyperionRouter.sol";

import {Fixture} from "../Fixture.sol";
import {CallbackRecoveryToken} from "../mocks/CallbackRecoveryToken.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title Accidental-token recovery with liability exclusions tests
contract RouterRecoveryTest is Fixture {
    MockERC20 private stray;
    CallbackRecoveryToken private hostile;

    function setUp() public override {
        super.setUp();
        stray = new MockERC20("Stray Token", "STRY", 18);
        hostile = new CallbackRecoveryToken();

        usdc.mint(railReceiver, 1_000_000e6);
        vm.prank(railReceiver);
        usdc.approve(address(router), type(uint256).max);
    }

    function test_registered_token_claims_and_dispatch_liabilities_cannot_be_swept() public {
        // Park a 500 USDC claim for frozen recipient bob.
        usdc.setBlocked(bob, true);
        vm.prank(railReceiver);
        uint64 claimId = router.bridgeIn(
            RouteKind.Cctp,
            address(usdc),
            500e6,
            bob,
            Origin({chain: STELLAR, nonce: 1, messageId: keccak256("claim-1"), sender: C_KEY})
        );
        assertEq(claimId, 1);
        assertEq(router.recoverableTokenAmount(address(usdc)), 0);

        vm.expectRevert(ProtectedAsset.selector);
        vm.prank(admin);
        router.queueTokenRecovery(address(usdc), treasury, 1);

        // Accidental 120 USDC sent directly creates only 120 USDC recoverable surplus; the 500 USDC
        // claim backing remains strictly excluded.
        usdc.mint(address(router), 120e6);
        assertEq(router.recoverableTokenAmount(address(usdc)), 120e6);

        vm.expectRevert(ProtectedAsset.selector);
        vm.prank(admin);
        router.queueTokenRecovery(address(usdc), treasury, 121e6);

        uint64 recId = _recoverToken(address(usdc), treasury, 120e6);
        assertTrue(router.tokenRecoveryRequest(recId).executed);
        assertEq(usdc.balanceOf(address(router)), 500e6);

        usdc.setBlocked(bob, false);
        router.settleClaim(claimId);
        assertEq(usdc.balanceOf(bob), 500e6);

        // Verify active dispatch liabilities are tracked and excluded mid-dispatch.
        _registerToken(address(hostile), 6, FLOW_LIMIT);
        hostile.mint(alice, 1000e6);
        vm.prank(alice);
        hostile.approve(address(router), 1000e6);
        hostile.armDispatchSnapshot(address(router));

        OutboundRequest memory req = _tokenRequest(address(hostile), 1000e6, STELLAR_DECIMALS);
        vm.prank(alice);
        router.bridgeOut(req);

        assertTrue(hostile.snapshotCaptured());
        TokenLiabilityReport memory snap = hostile.capturedSnapshot();
        assertEq(snap.dispatchLiabilities, 1000e6);
        assertEq(snap.recoverable, 0);
    }

    function test_recovery_recipient_and_token_are_authorized_and_observable() public {
        stray.mint(address(router), 250e18);

        vm.expectRevert();
        vm.prank(stranger);
        router.queueTokenRecovery(address(stray), bob, 100e18);

        vm.expectRevert();
        vm.prank(guardian);
        router.queueTokenRecovery(address(stray), bob, 100e18);

        address strayAddr = address(stray);
        uint64 expectedEta = uint64(block.timestamp) + TIMELOCK;
        uint64 expectedExpires = expectedEta + router.GRACE_PERIOD();
        vm.expectEmit(true, true, true, true, address(router));
        emit IHyperionRouter.TokenRecoveryQueued(1, strayAddr, bob, 100e18, expectedEta, expectedExpires);
        vm.prank(admin);
        uint64 id = router.queueTokenRecovery(address(stray), bob, 100e18);

        RecoveryRequest memory queued = router.tokenRecoveryRequest(id);
        assertEq(queued.token, address(stray));
        assertEq(queued.recipient, bob);
        assertEq(queued.amount, 100e18);
        assertFalse(queued.executed);

        vm.expectRevert(abi.encodeWithSelector(TimelockNotReady.selector, expectedEta));
        vm.prank(admin);
        router.executeTokenRecovery(id);

        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.expectEmit(true, true, true, true, address(router));
        emit IHyperionRouter.TokenRecoveryExecuted(id, address(stray), bob, 100e18);
        vm.prank(admin);
        router.executeTokenRecovery(id);

        assertEq(stray.balanceOf(bob), 100e18);
        assertEq(router.recoverableTokenAmount(address(stray)), 150e18);

        // Guardian can cancel a pending recovery; stranger cannot.
        vm.prank(admin);
        uint64 cancelId = router.queueTokenRecovery(address(stray), bob, 50e18);
        vm.expectRevert(Unauthorized.selector);
        vm.prank(stranger);
        router.cancelTokenRecovery(cancelId);

        vm.prank(guardian);
        router.cancelTokenRecovery(cancelId);
        assertEq(router.tokenRecoveryRequest(cancelId).id, 0);
    }

    function test_hostile_token_callbacks_cannot_reenter_protected_router_operations() public {
        hostile.mint(address(router), 400e6);

        vm.startPrank(admin);
        uint64 id1 = router.queueTokenRecovery(address(hostile), bob, 100e6);
        uint64 id2 = router.queueTokenRecovery(address(hostile), bob, 100e6);
        vm.stopPrank();
        vm.warp(block.timestamp + TIMELOCK + 1);

        // Reentering executeTokenRecovery from token transfer callback reverts.
        hostile.armRecoveryReentry(address(router), id2);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(admin);
        router.executeTokenRecovery(id1);

        // Reentering bridgeOut from token transfer callback reverts.
        OutboundRequest memory outReq = _usdcRequest(100e6);
        hostile.armBridgeOutReentry(address(router), outReq);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(admin);
        router.executeTokenRecovery(id1);

        // Reentering settleClaim from token transfer callback reverts.
        hostile.armSettleClaimReentry(address(router), 1);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(admin);
        router.executeTokenRecovery(id1);

        // Clean execution once hostile callback is disarmed succeeds once and refuses replay.
        hostile.disarm();
        vm.prank(admin);
        router.executeTokenRecovery(id1);
        assertEq(hostile.balanceOf(bob), 100e6);

        vm.expectRevert(TimelockAlreadyExecuted.selector);
        vm.prank(admin);
        router.executeTokenRecovery(id1);
    }
}
