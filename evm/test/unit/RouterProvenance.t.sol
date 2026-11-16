// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AmountNotRepresentable,
    FlowLimitExceeded,
    RefundFailed,
    SlippageExceeded
} from "../../src/HyperionErrors.sol";
import {
    AddressKind,
    OutboundRequest,
    ProvenanceWindow,
    RouteKind,
    TransferProvenance
} from "../../src/HyperionTypes.sol";
import {Fixture} from "../Fixture.sol";
import {RefundRefuser} from "../mocks/HostileCallers.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockRailAdapter} from "../mocks/MockRailAdapter.sol";

/// @title Bounded read-only outbound transfer provenance
/// @notice Verifies exact intent and provider association on dispatch, complete rollback on revert,
/// and bounded storage growth plus warm-slot gas behavior across circular buffer wrap-around.
contract RouterProvenanceTest is Fixture {
    function test_dispatch_records_exact_intent_and_provider_association_for_classic_account() public {
        OutboundRequest memory request = _usdcRequest(1000e6);
        request.minDestinationAmount = 999e7;

        uint64 expectedTime = uint64(block.timestamp);
        vm.prank(alice);
        uint64 nonce = router.bridgeOut(request);

        TransferProvenance memory record = _provenance(nonce);
        assertEq(record.nonce, 1);
        assertEq(uint8(record.route), uint8(RouteKind.Cctp));
        assertEq(record.sender, alice);
        assertEq(record.adapter, address(cctpRail));
        assertEq(record.token, address(usdc));
        assertEq(record.grossAmount, 1000e6);
        assertEq(record.fee, 1e6);
        assertEq(record.netAmount, 999e6);
        assertEq(record.destinationAmount, 999e7);
        assertEq(record.minDestinationAmount, 999e7);
        assertEq(record.destinationDecimals, STELLAR_DECIMALS);
        assertEq(uint8(record.destinationKind), uint8(AddressKind.Account));
        assertEq(record.destinationKey, G_KEY);
        assertEq(record.destinationMuxedId, 0);
        assertEq(record.destinationChainHash, keccak256(bytes(STELLAR)));
        assertEq(record.railRef, cctpRail.railRef());
        assertEq(record.createdAt, expectedTime);
    }

    function test_dispatch_records_muxed_and_contract_destinations_and_dust_floored_gross() public {
        MockERC20 wide = new MockERC20("Wide", "WIDE", 18);
        _registerToken(address(wide), 18, type(uint256).max);
        wide.mint(alice, 100e18);
        vm.prank(alice);
        wide.approve(address(router), type(uint256).max);

        OutboundRequest memory muxedReq = _usdcRequest(2000e6);
        muxedReq.route = RouteKind.AxelarIts;
        muxedReq.destination.strkey = M_ADDR;
        muxedReq.minDestinationAmount = 1998e7;

        vm.prank(alice);
        uint64 muxedNonce = router.bridgeOut(muxedReq);
        TransferProvenance memory muxedRecord = _provenance(muxedNonce);
        assertEq(muxedRecord.adapter, address(itsRail));
        assertEq(uint8(muxedRecord.route), uint8(RouteKind.AxelarIts));
        assertEq(uint8(muxedRecord.destinationKind), uint8(AddressKind.MuxedAccount));
        assertEq(muxedRecord.destinationKey, G_KEY);
        assertEq(muxedRecord.destinationMuxedId, MUXED_ID);

        OutboundRequest memory dustyReq = _tokenRequest(address(wide), 1e18 + 999_999_999_999, 6);
        dustyReq.destination.strkey = C_ADDR;
        vm.prank(alice);
        uint64 dustyNonce = router.bridgeOut(dustyReq);

        TransferProvenance memory dustyRecord = _provenance(dustyNonce);
        assertEq(uint8(dustyRecord.destinationKind), uint8(AddressKind.Contract));
        assertEq(dustyRecord.destinationKey, C_KEY);
        assertEq(dustyRecord.destinationMuxedId, 0);
        assertEq(dustyRecord.grossAmount, dustyRecord.fee + dustyRecord.netAmount);
        assertLt(dustyRecord.grossAmount, dustyReq.amount, "unrepresentable dust is not committed");
    }

    function test_reverting_dispatches_leave_no_committed_provenance_record() public {
        // 1. Adapter revert after router state writes rolls back everything.
        cctpRail.setDispatchReverts(true);
        vm.prank(alice);
        vm.expectRevert(MockRailAdapter.Rejected.selector);
        router.bridgeOut(_usdcRequest(1000e6));
        cctpRail.setDispatchReverts(false);

        assertEq(router.outboundNonce(), 0);
        assertEq(_provenance(1).nonce, 0);
        assertEq(router.provenanceWindow().latestNonce, 0);

        // 2. Slippage, precision, and flow-limit reverts leave zero record.
        OutboundRequest memory slipReq = _usdcRequest(1000e6);
        slipReq.minDestinationAmount = 999e7 + 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SlippageExceeded.selector, 999e7 + 1, 999e7));
        router.bridgeOut(slipReq);

        OutboundRequest memory tinyReq = _usdcRequest(1);
        tinyReq.destinationDecimals = 0;
        vm.prank(alice);
        vm.expectRevert(AmountNotRepresentable.selector);
        router.bridgeOut(tinyReq);

        _setRouteFlowLimit(address(usdc), RouteKind.Cctp, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FlowLimitExceeded.selector, 999e6, 100e6));
        router.bridgeOut(_usdcRequest(1000e6));
        _setRouteFlowLimit(address(usdc), RouteKind.Cctp, FLOW_LIMIT);

        // 3. Post-dispatch native refund failure rolls back _recordProvenance as well.
        RefundRefuser refuser = new RefundRefuser();
        usdc.mint(address(refuser), 10_000e6);
        refuser.approve(address(usdc), address(router), type(uint256).max);
        cctpRail.setRefund(0.1 ether);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(RefundFailed.selector);
        refuser.bridge{value: 0.2 ether}(address(router), _usdcRequest(1000e6), 0.2 ether);

        assertEq(router.outboundNonce(), 0);
        assertEq(_provenance(1).nonce, 0);
        assertEq(_provenance(0).nonce, 0);
    }

    function test_ring_buffer_bounds_record_growth_and_measures_warm_overwrite_cost() public {
        _setRouteFlowLimit(address(usdc), RouteKind.Cctp, type(uint256).max);
        usdc.mint(alice, 100_000_000e6);

        ProvenanceWindow memory emptyWindow = router.provenanceWindow();
        assertEq(emptyWindow.capacity, 256);
        assertEq(emptyWindow.earliestNonce, 0);
        assertEq(emptyWindow.latestNonce, 0);

        OutboundRequest memory req = _usdcRequest(100e6);
        uint256 coldSlotGas;
        vm.startPrank(alice);
        router.bridgeOut(req); // nonce 1 warms router/token/adapter counters

        uint256 gasBeforeCold = gasleft();
        router.bridgeOut(req); // nonce 2 writes cold ring slot 2
        coldSlotGas = gasBeforeCold - gasleft();

        for (uint64 n = 3; n <= 256; ++n) {
            router.bridgeOut(req);
        }

        ProvenanceWindow memory fullWindow = router.provenanceWindow();
        assertEq(fullWindow.capacity, 256);
        assertEq(fullWindow.earliestNonce, 1);
        assertEq(fullWindow.latestNonce, 256);
        assertEq(_provenance(1).nonce, 1);
        assertEq(_provenance(256).nonce, 256);

        // Nonce 257 wraps onto slot 1; nonce 258 wraps onto slot 2 (warm slot overwrite).
        router.bridgeOut(req); // nonce 257
        uint256 gasBeforeWarm = gasleft();
        router.bridgeOut(req); // nonce 258 overwrites slot 2
        uint256 warmSlotGas = gasBeforeWarm - gasleft();
        vm.stopPrank();

        ProvenanceWindow memory wrappedWindow = router.provenanceWindow();
        assertEq(wrappedWindow.capacity, 256);
        assertEq(wrappedWindow.earliestNonce, 3);
        assertEq(wrappedWindow.latestNonce, 258);

        // Evicted nonces 1 and 2 return empty records rather than colliding with 257 and 258.
        assertEq(_provenance(1).nonce, 0);
        assertEq(_provenance(2).nonce, 0);
        assertEq(_provenance(3).nonce, 3);
        assertEq(_provenance(257).nonce, 257);
        assertEq(_provenance(258).nonce, 258);

        // Warm circular slot reuse must cost strictly less gas than cold slot allocation.
        assertLt(warmSlotGas, coldSlotGas, "warm ring overwrite reuses existing storage words");
    }
}
