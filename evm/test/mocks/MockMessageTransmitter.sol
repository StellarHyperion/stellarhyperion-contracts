// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMessageTransmitterV2} from "../../src/interfaces/ICctpV2.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Local attestation boundary fixture for CctpAdapter receive tests.
contract MockMessageTransmitter is IMessageTransmitterV2 {
    uint32 public localDomain = 1;
    address public immutable USDC;
    mapping(bytes32 id => bool seen) public processed;
    bool public shouldRevert;

    constructor(address usdc, uint32 domain) {
        USDC = usdc;
        localDomain = domain;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setLocalDomain(uint32 domain) external {
        localDomain = domain;
    }

    function receiveMessage(bytes calldata message, bytes calldata) external override {
        if (shouldRevert) revert("MockMessageTransmitter: invalid attestation");
        if (message.length < 148 + 228) revert("MockMessageTransmitter: malformed");

        bytes32 replayId = bytes32(message[12:44]);
        if (processed[replayId]) revert("MockMessageTransmitter: replay");

        uint256 amount = 0;
        for (uint256 i; i < 32; ++i) {
            amount = (amount << 8) | uint8(message[216 + i]);
        }
        processed[replayId] = true;

        address recipient = address(bytes20(bytes32(message[184:216]) << 96));
        MockERC20(USDC).mint(recipient, amount);
    }
}
