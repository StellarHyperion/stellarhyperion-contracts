// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    LimitNotRaised,
    TimelockExpired,
    TimelockNotQueued,
    TimelockNotReady,
    Unauthorized
} from "../../src/HyperionErrors.sol";
import {HyperionRouter} from "../../src/HyperionRouter.sol";
import {ActionKind, AdminAction, TimelockActionStatus, TimelockState} from "../../src/HyperionTypes.sol";
import {ITimelockState} from "../../src/interfaces/ITimelockState.sol";
import {TimelockMigrationView} from "../../src/libraries/TimelockMigrationView.sol";

import {Fixture} from "../Fixture.sol";

/// @title Stable timelock state interface and migration continuity tests
contract TimelockStateTest is Fixture {
    function test_status_agrees_with_actual_execution_at_timestamp_boundaries() public {
        assertEq(uint8(router.timelockStatus(999).state), uint8(TimelockState.Unqueued));
        assertEq(uint8(router.timelockStatus(0).state), uint8(TimelockState.Unqueued));

        AdminAction memory action = _empty(ActionKind.SetFeeBps);
        action.amount = 25;
        uint64 id = _queueOnly(action);

        TimelockActionStatus memory pending = router.timelockStatus(id);
        assertEq(uint8(pending.state), uint8(TimelockState.Pending));
        assertTrue(pending.payloadValid);

        // 1 second before eta: status is Pending and execution reverts with TimelockNotReady.
        vm.warp(pending.eta - 1);
        assertEq(uint8(router.timelockStatus(id).state), uint8(TimelockState.Pending));
        vm.expectRevert(abi.encodeWithSelector(TimelockNotReady.selector, pending.eta));
        vm.prank(admin);
        router.executeAction(id);

        // Exact maturity boundary (eta): status is Executable and execution succeeds.
        uint64 exp = pending.expiresAt;
        vm.warp(pending.eta);
        assertEq(uint8(router.timelockStatus(id).state), uint8(TimelockState.Executable));
        assertEq(uint8(router.timelockStatusAt(id, exp).state), uint8(TimelockState.Executable));
        assertEq(uint8(router.timelockStatusAt(id, exp + 1).state), uint8(TimelockState.Expired));

        vm.prank(admin);
        router.executeAction(id);
        TimelockActionStatus memory done = router.timelockStatus(id);
        assertEq(uint8(done.state), uint8(TimelockState.Executed));
        assertEq(done.resolvedAt, pending.eta);
        assertFalse(done.payloadValid);

        // Exact grace-period end vs +1 second boundary on a second action.
        AdminAction memory second = _empty(ActionKind.SetFeeBps);
        second.amount = 30;
        uint64 expId = _queueOnly(second);
        uint64 expAt = router.timelockStatus(expId).expiresAt;

        vm.warp(expAt + 1);
        assertEq(uint8(router.timelockStatus(expId).state), uint8(TimelockState.Expired));
        vm.expectRevert(abi.encodeWithSelector(TimelockExpired.selector, expAt));
        vm.prank(admin);
        router.executeAction(expId);

        // Cancelled state remains distinguishable from Unqueued while queuedAction slot is deleted.
        AdminAction memory third = _empty(ActionKind.SetTreasury);
        third.subject = bob;
        uint64 cancelId = _queueOnly(third);
        vm.prank(guardian);
        router.cancelAction(cancelId);

        assertEq(router.queuedAction(cancelId).id, 0);
        TimelockActionStatus memory cancelled = router.timelockStatus(cancelId);
        assertEq(uint8(cancelled.state), uint8(TimelockState.Cancelled));
        assertEq(cancelled.resolvedAt, uint64(block.timestamp));
        vm.expectRevert(TimelockNotQueued.selector);
        vm.prank(admin);
        router.executeAction(cancelId);
    }

    function test_public_interface_includes_payload_identity_without_changing_authority() public {
        AdminAction memory raiseLow = _empty(ActionKind.RaiseTokenFlowLimit);
        raiseLow.subject = address(usdc);
        raiseLow.amount = FLOW_LIMIT + 10;

        AdminAction memory raiseHigh = _empty(ActionKind.RaiseTokenFlowLimit);
        raiseHigh.subject = address(usdc);
        raiseHigh.amount = FLOW_LIMIT * 5;

        bytes32 expectedDigest = router.actionPayloadId(raiseLow);
        assertTrue(expectedDigest != bytes32(0));
        assertTrue(expectedDigest != router.actionPayloadId(raiseHigh));

        uint64 id = _queueOnly(raiseLow);
        ITimelockState reader = ITimelockState(address(router));
        TimelockActionStatus memory st = reader.timelockStatus(id);
        assertEq(st.payloadId, expectedDigest);
        assertTrue(st.payloadValid);

        // Raising higher invalidates the lower pending action's payload without altering authority.
        _run(raiseHigh);
        vm.warp(st.eta);
        TimelockActionStatus memory stale = reader.timelockStatus(id);
        assertEq(uint8(stale.state), uint8(TimelockState.Executable));
        assertEq(stale.payloadId, expectedDigest);
        assertFalse(stale.payloadValid);

        vm.expectRevert(LimitNotRaised.selector);
        vm.prank(admin);
        router.executeAction(id);

        // Authority invariants remain unchanged: strangers cannot queue, execute, or cancel.
        vm.expectRevert();
        vm.prank(stranger);
        router.queueAction(_empty(ActionKind.SetFeeBps));

        vm.expectRevert(Unauthorized.selector);
        vm.prank(stranger);
        router.cancelAction(id);
    }

    function test_existing_action_ids_remain_queryable_after_upgrades_or_migrations() public {
        // Action IDs created during fixture setup (1..router.actionCount()) remain queryable.
        uint64 preCutoff = router.actionCount();
        assertTrue(preCutoff > 0);

        AdminAction memory pendingOnOld = _empty(ActionKind.SetFeeBps);
        pendingOnOld.amount = 15;
        uint64 legacyPendingId = _queueOnly(pendingOnOld);
        bytes32 legacyPayload = router.actionPayloadId(pendingOnOld);

        // Deploy successor router and bridge historical + new IDs via TimelockMigrationView.
        HyperionRouter successor = _freshRouter();
        AdminAction memory regOnNew = _empty(ActionKind.RegisterToken);
        regOnNew.subject = address(usdc);
        regOnNew.amount = FLOW_LIMIT;
        regOnNew.decimals = USDC_DECIMALS;
        uint64 newExecutedId = _runOn(successor, regOnNew);
        assertEq(newExecutedId, 1);

        // Queue enough actions on successor so an ID past legacyPendingId exists on successor.
        uint64 postCutoffId;
        for (uint256 i = 0; i <= legacyPendingId; ++i) {
            AdminAction memory nextFee = _empty(ActionKind.SetFeeBps);
            nextFee.amount = 10 + i;
            vm.prank(admin);
            postCutoffId = successor.queueAction(nextFee);
        }

        TimelockMigrationView migrated =
            new TimelockMigrationView(address(router), address(successor), legacyPendingId);

        uint64[] memory queryIds = new uint64[](3);
        queryIds[0] = 1;
        queryIds[1] = legacyPendingId;
        queryIds[2] = postCutoffId;

        TimelockActionStatus[] memory batch = migrated.timelockStatuses(queryIds);
        assertEq(uint8(batch[0].state), uint8(TimelockState.Executed));
        assertEq(batch[1].payloadId, legacyPayload);
        assertEq(uint8(batch[2].state), uint8(TimelockState.Pending));
        assertEq(batch[2].id, postCutoffId);
        assertEq(migrated.actionPayloadId(pendingOnOld), legacyPayload);
        assertEq(uint8(migrated.timelockStatus(0).state), uint8(TimelockState.Unqueued));
    }
}
