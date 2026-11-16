// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AdminAction, TimelockActionStatus} from "../HyperionTypes.sol";

/// @title Stable read-only interface for Hyperion timelock action state
/// @notice Exposes typed lifecycle states and payload digests without changing router authority.
interface ITimelockState {
    /// @notice Compute the canonical payload digest for an `AdminAction`.
    /// @param action The governance action parameters to hash.
    /// @return The deterministic `keccak256` payload identifier.
    function actionPayloadId(AdminAction calldata action) external pure returns (bytes32);

    /// @notice Read the current lifecycle status and payload digest of action `id`.
    /// @param id The timelock action identifier to inspect.
    /// @return status Typed state, timestamps, resolution time, and payload identity.
    function timelockStatus(uint64 id) external view returns (TimelockActionStatus memory status);

    /// @notice Evaluate the lifecycle status of action `id` at an explicit `timestamp`.
    /// @param id The timelock action identifier to inspect.
    /// @param timestamp The point in time (seconds) at which pending/executable/expired is evaluated.
    /// @return status Typed state, timestamps, resolution time, and payload identity.
    function timelockStatusAt(uint64 id, uint64 timestamp)
        external
        view
        returns (TimelockActionStatus memory status);

    /// @notice Batch-read lifecycle statuses for multiple action IDs across upgrades or migrations.
    /// @param ids The ordered list of action identifiers to query.
    /// @return statuses One `TimelockActionStatus` entry per requested identifier.
    function timelockStatuses(uint64[] calldata ids)
        external
        view
        returns (TimelockActionStatus[] memory statuses);
}
