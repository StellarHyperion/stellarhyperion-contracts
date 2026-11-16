// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ZeroAddress} from "../HyperionErrors.sol";
import {AdminAction, TimelockActionStatus, TimelockState} from "../HyperionTypes.sol";
import {ITimelockState} from "../interfaces/ITimelockState.sol";

/// @title Read-only continuity adapter preserving historical action IDs across migrations
/// @author dotmantissa
/// @notice Routes historical action ID reads to a predecessor router while forwarding newer IDs
/// to the active router through the identical `ITimelockState` interface.
contract TimelockMigrationView is ITimelockState {
    /// @notice The predecessor router whose action IDs up to `LEGACY_CUTOFF_ID` remain preserved.
    ITimelockState public immutable PREDECESSOR;

    /// @notice The active successor router serving new governance actions.
    ITimelockState public immutable ACTIVE;

    /// @notice Highest action ID owned by `PREDECESSOR` when the migration cut over.
    uint64 public immutable LEGACY_CUTOFF_ID;

    /// @notice Construct a read-only continuity view bridging `predecessor` and `active` routers.
    /// @param predecessor Pre-migration router address.
    /// @param active Post-migration router address.
    /// @param legacyCutoffId Highest action ID allocated on `predecessor`.
    constructor(address predecessor, address active, uint64 legacyCutoffId) {
        if (predecessor == address(0) || active == address(0)) revert ZeroAddress();
        PREDECESSOR = ITimelockState(predecessor);
        ACTIVE = ITimelockState(active);
        LEGACY_CUTOFF_ID = legacyCutoffId;
    }

    /// @inheritdoc ITimelockState
    function actionPayloadId(AdminAction calldata action) external pure override returns (bytes32) {
        bytes memory encoded =
            abi.encode(action.kind, action.route, action.subject, action.amount, action.decimals);
        return keccak256(encoded);
    }

    /// @inheritdoc ITimelockState
    function timelockStatus(uint64 id) external view override returns (TimelockActionStatus memory) {
        return timelockStatusAt(id, uint64(block.timestamp));
    }

    /// @inheritdoc ITimelockState
    function timelockStatusAt(uint64 id, uint64 timestamp)
        public
        view
        override
        returns (TimelockActionStatus memory status)
    {
        if (id == 0) {
            return ACTIVE.timelockStatusAt(0, timestamp);
        }
        if (id <= LEGACY_CUTOFF_ID) {
            status = PREDECESSOR.timelockStatusAt(id, timestamp);
            if (status.state != TimelockState.Unqueued) return status;
        }
        return ACTIVE.timelockStatusAt(id, timestamp);
    }

    /// @inheritdoc ITimelockState
    function timelockStatuses(uint64[] calldata ids)
        external
        view
        override
        returns (TimelockActionStatus[] memory statuses)
    {
        statuses = new TimelockActionStatus[](ids.length);
        uint64 nowTs = uint64(block.timestamp);
        for (uint256 i = 0; i < ids.length; ++i) {
            statuses[i] = timelockStatusAt(ids[i], nowTs);
        }
    }
}
