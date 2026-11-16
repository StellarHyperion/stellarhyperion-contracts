// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {InboundBalanceMismatch} from "../../src/HyperionErrors.sol";
import {InboundCustody, Origin, RouteKind} from "../../src/HyperionTypes.sol";
import {AxelarItsAdapter} from "../../src/adapters/AxelarItsAdapter.sol";

import {Fixture} from "../Fixture.sol";
import {DeflationaryERC20} from "../mocks/DeflationaryERC20.sol";
import {MockGasService} from "../mocks/MockGasService.sol";
import {MockIts} from "../mocks/MockIts.sol";
import {VoidReturnToken} from "../mocks/VoidReturnToken.sol";

/// @title Inbound token balance-delta reconciliation tests
contract InboundReconciliationTest is Fixture {
    bytes32 private constant TOKEN_ID = keccak256("hyperion.its.deflationary");
    bytes private constant STELLAR_PEER = "CAGR5KFYMZYI7WWQ6TWYYZ346T7GNZLKER4DOJTAG3SOB46QLR5RAPSN";

    DeflationaryERC20 private taxed;
    MockIts private its;
    MockGasService private gasService;
    AxelarItsAdapter private axelarAdapter;

    function setUp() public override {
        super.setUp();
        taxed = new DeflationaryERC20("Taxed Dollar", "TAXD", 6);
        _registerToken(address(taxed), 6, FLOW_LIMIT);

        taxed.mint(railReceiver, 1_000_000e6);
        vm.prank(railReceiver);
        taxed.approve(address(router), type(uint256).max);

        usdc.mint(railReceiver, 1_000_000e6);
        vm.prank(railReceiver);
        usdc.approve(address(router), type(uint256).max);

        its = new MockIts();
        gasService = new MockGasService();
        axelarAdapter = new AxelarItsAdapter(address(router), address(its), address(gasService), admin);
        its.setRegistered(TOKEN_ID, address(taxed));

        vm.startPrank(admin);
        axelarAdapter.setPeer(STELLAR, STELLAR, STELLAR_PEER);
        axelarAdapter.linkToken(address(taxed), TOKEN_ID);
        vm.stopPrank();

        _setRailReceiver(RouteKind.AxelarIts, address(axelarAdapter));
    }

    function test_deflationary_or_short_transfer_tokens_cannot_create_underfunded_claims() public {
        // 1% fee on transferFrom, and recipient is frozen so a naive router would park a claim
        // for 1_000e6 while holding only 990e6.
        taxed.setFees(100, 0);
        taxed.setBlocked(bob, true);

        Origin memory origin = _inboundOrigin(11, keccak256("short-claim"));
        vm.expectRevert(abi.encodeWithSelector(InboundBalanceMismatch.selector, 1000e6, 990e6));
        vm.prank(railReceiver);
        router.bridgeIn(RouteKind.Cctp, address(taxed), 1000e6, bob, origin);

        assertEq(router.claimCount(), 0);
        assertEq(taxed.balanceOf(address(router)), 0);

        // Even when transferFrom is exempt (0 bps) and only outbound transfer taxes 2%, direct
        // payout shortchanging recipient is rejected rather than silently accepted.
        taxed.setBlocked(bob, false);
        taxed.setFees(0, 200);
        Origin memory payoutOrigin = _inboundOrigin(12, keccak256("short-payout"));
        vm.expectRevert(abi.encodeWithSelector(InboundBalanceMismatch.selector, 1000e6, 980e6));
        vm.prank(railReceiver);
        router.bridgeIn(RouteKind.Cctp, address(taxed), 1000e6, bob, payoutOrigin);
        assertEq(taxed.balanceOf(bob), 0);

        // Short ITS delivery into AxelarItsAdapter is also rejected before underfunding claims.
        taxed.setFees(0, 100);
        taxed.mint(address(its), 1000e6);
        bytes memory note = abi.encodePacked(uint8(1), bob, uint64(13));
        vm.expectRevert(abi.encodeWithSelector(InboundBalanceMismatch.selector, 1000e6, 990e6));
        its.deliver(
            address(axelarAdapter),
            keccak256("its-short-cmd"),
            STELLAR,
            STELLAR_PEER,
            note,
            TOKEN_ID,
            address(taxed),
            1000e6
        );
    }

    function test_canonical_supported_token_deliveries_retain_exact_payouts() public {
        Origin memory first = _inboundOrigin(21, keccak256("canonical-direct"));
        vm.prank(railReceiver);
        uint64 directClaim = router.bridgeIn(RouteKind.Cctp, address(usdc), 750e6, bob, first);
        assertEq(directClaim, 0);
        assertEq(usdc.balanceOf(bob), 750e6);

        // Parked claim + settlement retains exact integer custody and solvency accounting.
        usdc.setBlocked(bob, true);
        Origin memory second = _inboundOrigin(22, keccak256("canonical-parked"));
        vm.prank(railReceiver);
        uint64 parkedId = router.bridgeIn(RouteKind.Cctp, address(usdc), 500e6, bob, second);
        assertEq(parkedId, 1);

        InboundCustody memory mid = router.inboundCustody(address(usdc));
        assertEq(mid.routerBalance, 500e6);
        assertEq(mid.parkedLiabilities, 500e6);
        assertTrue(mid.solvent);

        usdc.setBlocked(bob, false);
        router.settleClaim(parkedId);
        assertEq(usdc.balanceOf(bob), 1250e6);

        InboundCustody memory settled = router.inboundCustody(address(usdc));
        assertEq(settled.routerBalance, 0);
        assertEq(settled.parkedLiabilities, 0);
        assertTrue(settled.solvent);

        // Void-return ERC20s also retain exact canonical payouts.
        VoidReturnToken legacy = new VoidReturnToken();
        _registerToken(address(legacy), 6, FLOW_LIMIT);
        legacy.mint(railReceiver, 400e6);
        vm.prank(railReceiver);
        legacy.approve(address(router), 400e6);
        vm.prank(railReceiver);
        router.bridgeIn(RouteKind.Cctp, address(legacy), 400e6, bob, _inboundOrigin(23, keccak256("void")));
        assertEq(legacy.balanceOf(bob), 400e6);
    }

    function test_failed_reconciliation_rolls_back_complete_inbound_operation() public {
        taxed.setFees(50, 0);
        bytes32 msgId = keccak256("atomic-rollback-msg");
        bytes32 replayKey = keccak256(abi.encode(RouteKind.Cctp, msgId));
        uint256 receiverBefore = taxed.balanceOf(railReceiver);

        vm.expectRevert(abi.encodeWithSelector(InboundBalanceMismatch.selector, 2000e6, 1990e6));
        vm.prank(railReceiver);
        router.bridgeIn(RouteKind.Cctp, address(taxed), 2000e6, bob, _inboundOrigin(31, msgId));

        assertFalse(router.processed(replayKey), "replay flag must roll back");
        assertEq(router.claimCount(), 0, "claim counter must roll back");
        assertEq(taxed.balanceOf(railReceiver), receiverBefore, "sender balance must roll back");
        assertEq(taxed.balanceOf(address(router)), 0, "router custody must stay zero");
        assertEq(taxed.balanceOf(bob), 0, "recipient balance must stay zero");

        // Once canonical 1:1 transfer behavior is restored, the same message id can be delivered.
        taxed.setFees(0, 0);
        vm.prank(railReceiver);
        uint64 claimId =
            router.bridgeIn(RouteKind.Cctp, address(taxed), 2000e6, bob, _inboundOrigin(31, msgId));
        assertEq(claimId, 0);
        assertTrue(router.processed(replayKey));
        assertEq(taxed.balanceOf(bob), 2000e6);
    }
}
