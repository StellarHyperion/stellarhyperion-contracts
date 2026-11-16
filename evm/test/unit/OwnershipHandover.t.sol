// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "openzeppelin/access/Ownable.sol";

import {Handover} from "../../script/Handover.s.sol";
import {NotRailReceiver, TimelockAlreadyExecuted} from "../../src/HyperionErrors.sol";
import {HyperionRouter} from "../../src/HyperionRouter.sol";
import {ActionKind, AdminAction, AuthoritySnapshot, Origin, RouteKind} from "../../src/HyperionTypes.sol";
import {AxelarItsAdapter} from "../../src/adapters/AxelarItsAdapter.sol";
import {CctpAdapter} from "../../src/adapters/CctpAdapter.sol";

import {Fixture} from "../Fixture.sol";
import {MockGasService} from "../mocks/MockGasService.sol";
import {MockIts} from "../mocks/MockIts.sol";
import {MockTokenMessenger} from "../mocks/MockTokenMessenger.sol";

/// @title Multi-contract ownership handover rehearsal tests
contract OwnershipHandoverTest is Fixture {
    bytes32 private constant TOKEN_ID = keccak256("hyperion.usdc.its");
    bytes private constant STELLAR_PEER = "CAGR5KFYMZYI7WWQ6TWYYZ346T7GNZLKER4DOJTAG3SOB46QLR5RAPSN";

    address private deployer = makeAddr("deployer");

    HyperionRouter private bootRouter;
    CctpAdapter private cctpAdapter;
    AxelarItsAdapter private axelarAdapter;
    MockTokenMessenger private messenger;
    MockIts private its;
    MockGasService private gasService;
    Handover private handover;

    function setUp() public override {
        super.setUp();
        messenger = new MockTokenMessenger();
        its = new MockIts();
        gasService = new MockGasService();
        its.setRegistered(TOKEN_ID, address(usdc));

        bootRouter = _bootstrapRouter(deployer);
        address rtr = address(bootRouter);
        cctpAdapter = new CctpAdapter(rtr, address(messenger), address(usdc), deployer);
        axelarAdapter = new AxelarItsAdapter(rtr, address(its), address(gasService), deployer);
        handover = new Handover();

        vm.startPrank(deployer);
        cctpAdapter.setLane(STELLAR, 27, C_KEY);
        axelarAdapter.setPeer(STELLAR, STELLAR, STELLAR_PEER);
        axelarAdapter.linkToken(address(usdc), TOKEN_ID);
        vm.stopPrank();
    }

    function test_pending_owners_cannot_configure_adapters_before_acceptance() public {
        uint256 proposed = handover.proposeAdapterHandover(cctpAdapter, axelarAdapter, deployer, admin);
        assertEq(proposed, 2);
        assertEq(cctpAdapter.owner(), deployer);
        assertEq(cctpAdapter.pendingOwner(), admin);
        assertEq(axelarAdapter.owner(), deployer);
        assertEq(axelarAdapter.pendingOwner(), admin);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        vm.prank(admin);
        cctpAdapter.setLane("stellar-future", 27, G_KEY);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        vm.prank(admin);
        cctpAdapter.setLaneEnabled(STELLAR, false);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        vm.prank(admin);
        axelarAdapter.setPeer("stellar-future", "stellar-future", STELLAR_PEER);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        vm.prank(admin);
        axelarAdapter.setPeerEnabled(STELLAR, false);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        vm.prank(admin);
        axelarAdapter.linkToken(address(usdc), TOKEN_ID);

        AdminAction memory handAdmin = _empty(ActionKind.SetAdmin);
        handAdmin.subject = admin;
        vm.prank(deployer);
        bootRouter.queueAction(handAdmin);

        vm.expectRevert();
        vm.prank(admin);
        bootRouter.queueAction(_empty(ActionKind.SetFeeBps));

        vm.expectRevert(abi.encodeWithSelector(Handover.RouterAdminNotHandedOver.selector, admin));
        handover.renounceDeployerAdmin(bootRouter, deployer, admin);
    }

    function test_repeated_execution_cannot_transfer_authority_again() public {
        uint64[] memory ids = _queueBootstrapAndAdminHandover();
        handover.proposeAdapterHandover(cctpAdapter, axelarAdapter, deployer, admin);

        // Repeated proposal before acceptance is a no-op rather than a second transfer.
        assertEq(handover.proposeAdapterHandover(cctpAdapter, axelarAdapter, deployer, admin), 0);

        vm.warp(block.timestamp + TIMELOCK + 1);
        for (uint256 i = 0; i < ids.length; ++i) {
            vm.prank(deployer);
            bootRouter.executeAction(ids[i]);
        }

        uint256 accepted = handover.acceptAdapterHandover(cctpAdapter, axelarAdapter, admin);
        assertEq(accepted, 2);
        assertTrue(handover.renounceDeployerAdmin(bootRouter, deployer, admin));

        // Re-executing router SetAdmin reverts and cannot re-transfer authority.
        uint64 setAdminId = ids[ids.length - 1];
        vm.expectRevert(TimelockAlreadyExecuted.selector);
        vm.prank(admin);
        bootRouter.executeAction(setAdminId);

        // Repeated adapter acceptance and deployer renunciation are safe no-ops.
        assertEq(handover.acceptAdapterHandover(cctpAdapter, axelarAdapter, admin), 0);
        assertFalse(handover.renounceDeployerAdmin(bootRouter, deployer, admin));
        assertEq(handover.proposeAdapterHandover(cctpAdapter, axelarAdapter, deployer, stranger), 0);

        // Neither the former deployer nor a stranger can transfer or accept adapter ownership.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        vm.prank(deployer);
        cctpAdapter.transferOwnership(stranger);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        axelarAdapter.acceptOwnership();

        vm.expectRevert(
            abi.encodeWithSelector(
                Handover.UnexpectedPendingOwner.selector, address(cctpAdapter), stranger, address(0)
            )
        );
        handover.acceptAdapterHandover(cctpAdapter, axelarAdapter, stranger);
    }

    function test_reports_preserve_actual_current_and_pending_owners_and_transfer_safety() public {
        uint64[] memory ids = _queueBootstrapAndAdminHandover();
        vm.warp(block.timestamp + TIMELOCK + 1);
        // Execute wiring actions first, leaving SetAdmin unexecuted to inspect mid-handover state.
        for (uint256 i = 0; i + 1 < ids.length; ++i) {
            vm.prank(deployer);
            bootRouter.executeAction(ids[i]);
        }

        handover.proposeAdapterHandover(cctpAdapter, axelarAdapter, deployer, admin);

        AuthoritySnapshot memory pendingSnap = bootRouter.authoritySnapshot(deployer, admin);
        assertEq(pendingSnap.router, address(bootRouter));
        assertTrue(pendingSnap.deployerHasAdmin);
        assertFalse(pendingSnap.targetHasAdmin);
        assertTrue(pendingSnap.cctp.supportsTwoStep);
        assertEq(pendingSnap.cctp.owner, deployer);
        assertEq(pendingSnap.cctp.pendingOwner, admin);
        assertTrue(pendingSnap.axelar.supportsTwoStep);
        assertEq(pendingSnap.axelar.owner, deployer);
        assertEq(pendingSnap.axelar.pendingOwner, admin);

        Handover.HandoverReport memory pendingReport =
            handover.inspect(bootRouter, cctpAdapter, axelarAdapter, deployer, admin);
        assertEq(pendingReport.cctpOwner, deployer);
        assertEq(pendingReport.cctpPendingOwner, admin);
        assertEq(pendingReport.axelarOwner, deployer);
        assertEq(pendingReport.axelarPendingOwner, admin);

        vm.prank(deployer);
        bootRouter.executeAction(ids[ids.length - 1]);
        handover.acceptAdapterHandover(cctpAdapter, axelarAdapter, admin);
        handover.renounceDeployerAdmin(bootRouter, deployer, admin);

        AuthoritySnapshot memory finalSnap = bootRouter.authoritySnapshot(deployer, admin);
        assertFalse(finalSnap.deployerHasAdmin);
        assertTrue(finalSnap.targetHasAdmin);
        assertEq(finalSnap.cctp.owner, admin);
        assertEq(finalSnap.cctp.pendingOwner, address(0));
        assertEq(finalSnap.axelar.owner, admin);
        assertEq(finalSnap.axelar.pendingOwner, address(0));

        _assertPostHandoverDispatchAndInbound();
    }

    function _queueBootstrapAndAdminHandover() private returns (uint64[] memory ids) {
        ids = new uint64[](6);
        AdminAction memory reg = _empty(ActionKind.RegisterToken);
        reg.subject = address(usdc);
        reg.amount = FLOW_LIMIT;
        reg.decimals = USDC_DECIMALS;

        AdminAction memory setCctp = _empty(ActionKind.SetAdapter);
        setCctp.route = RouteKind.Cctp;
        setCctp.subject = address(cctpAdapter);

        AdminAction memory enCctp = _empty(ActionKind.EnableRoute);
        enCctp.route = RouteKind.Cctp;
        enCctp.amount = 1;

        AdminAction memory setAx = _empty(ActionKind.SetAdapter);
        setAx.route = RouteKind.AxelarIts;
        setAx.subject = address(axelarAdapter);

        AdminAction memory setAxRecv = _empty(ActionKind.SetRailReceiver);
        setAxRecv.route = RouteKind.AxelarIts;
        setAxRecv.subject = address(axelarAdapter);

        AdminAction memory setAdm = _empty(ActionKind.SetAdmin);
        setAdm.subject = admin;

        vm.startPrank(deployer);
        ids[0] = bootRouter.queueAction(reg);
        ids[1] = bootRouter.queueAction(setCctp);
        ids[2] = bootRouter.queueAction(enCctp);
        ids[3] = bootRouter.queueAction(setAx);
        ids[4] = bootRouter.queueAction(setAxRecv);
        ids[5] = bootRouter.queueAction(setAdm);
        vm.stopPrank();
    }

    function _assertPostHandoverDispatchAndInbound() private {
        vm.prank(alice);
        usdc.approve(address(bootRouter), 1000e6);
        vm.prank(alice);
        uint64 nonce = bootRouter.bridgeOut(_usdcRequest(1000e6));
        assertEq(nonce, 1);
        assertEq(messenger.burnCount(), 1);

        vm.expectRevert(NotRailReceiver.selector);
        vm.prank(stranger);
        bootRouter.bridgeIn(
            RouteKind.AxelarIts,
            address(usdc),
            500e6,
            bob,
            Origin({chain: STELLAR, nonce: 9, messageId: keccak256("msg-1"), sender: C_KEY})
        );
    }
}
