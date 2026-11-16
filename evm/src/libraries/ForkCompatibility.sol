// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkAssumptions, ForkCompatibilityReport} from "../HyperionTypes.sol";

/// @title Target-chain and EVM-fork diagnostics for Cancun builds
/// @notice Verifies `solc 0.8.28` compiler assumptions, `cancun` opcode availability (`PUSH0`,
/// `MCOPY`, `TLOAD`, `TSTORE`), and reviewed target-chain support before deployment or verification.
library ForkCompatibility {
    /// @notice Thrown when the configured EVM fork revision predates Cancun or is unrecognised.
    error UnsupportedForkRevision(string revision);

    /// @notice Thrown when the configured Solidity compiler version diverges from `0.8.28`.
    error UnsupportedCompilerAssumptions(string solcVersion);

    /// @notice Thrown when the target chain id is outside the reviewed deployment profiles.
    error UnsupportedTargetChain(uint256 chainId);

    /// @notice Thrown when a live Cancun opcode probe fails or returns false on the target chain.
    error CancunOpcodeProbeFailed(string feature);

    string internal constant EXPECTED_SOLC_VERSION = "0.8.28";
    string internal constant EXPECTED_EVM_REVISION = "cancun";

    bytes32 private constant HASH_SOLC_0_8_28 = keccak256("0.8.28");
    bytes32 private constant HASH_CANCUN = keccak256("cancun");
    bytes32 private constant HASH_PRAGUE = keccak256("prague");
    bytes32 private constant HASH_OSAKA = keccak256("osaka");
    bytes32 private constant MCOPY_SENTINEL = keccak256("hyperion.cancun.mcopy");
    bytes32 private constant TSTORE_SLOT = keccak256("hyperion.cancun.tstore.slot");
    bytes32 private constant TSTORE_SENTINEL = keccak256("hyperion.cancun.tstore.value");

    /// @notice Build the standard local Cancun profile used for Anvil and Hardhat verification.
    function localCancunProfile(uint256 chainId) internal pure returns (ForkAssumptions memory) {
        return ForkAssumptions({
            solcVersion: EXPECTED_SOLC_VERSION,
            evmRevision: EXPECTED_EVM_REVISION,
            chainId: chainId,
            allowDevChain: true,
            allowUnlistedChain: false
        });
    }

    /// @notice Build a pre-Cancun Shanghai profile (`PUSH0` present, `MCOPY` and `TSTORE` absent).
    function localShanghaiProfile(uint256 chainId) internal pure returns (ForkAssumptions memory) {
        return ForkAssumptions({
            solcVersion: EXPECTED_SOLC_VERSION,
            evmRevision: "shanghai",
            chainId: chainId,
            allowDevChain: true,
            allowUnlistedChain: false
        });
    }

    /// @notice Build a pre-Shanghai Paris profile (`PUSH0`, `MCOPY`, and `TSTORE` all absent).
    function localParisProfile(uint256 chainId) internal pure returns (ForkAssumptions memory) {
        return ForkAssumptions({
            solcVersion: EXPECTED_SOLC_VERSION,
            evmRevision: "paris",
            chainId: chainId,
            allowDevChain: true,
            allowUnlistedChain: false
        });
    }

    /// @notice Whether `evmRevision` supports every Cancun opcode emitted by this build.
    function isCancunOrLater(string memory evmRevision) internal pure returns (bool) {
        bytes32 digest = keccak256(bytes(evmRevision));
        return digest == HASH_CANCUN || digest == HASH_PRAGUE || digest == HASH_OSAKA;
    }

    /// @notice Whether `solcVersion` matches the pinned `0.8.28` compiler assumption.
    function isExpectedCompiler(string memory solcVersion) internal pure returns (bool) {
        return keccak256(bytes(solcVersion)) == HASH_SOLC_0_8_28;
    }

    /// @notice Whether `chainId` is an approved local rehearsal node or Cancun-capable network.
    function isSupportedChain(uint256 chainId, bool allowDevChain, bool allowUnlistedChain)
        internal
        pure
        returns (bool)
    {
        if (chainId == 0) return false;
        if (chainId == 31_337 || chainId == 1337) return allowDevChain;
        // Ethereum Mainnet/Sepolia, Base Mainnet/Sepolia, Arbitrum One/Sepolia, OP Mainnet/Sepolia.
        if (
            chainId == 1 || chainId == 11_155_111 || chainId == 8453 || chainId == 84_532 || chainId == 42_161
                || chainId == 421_614 || chainId == 10 || chainId == 11_155_420
        ) {
            return true;
        }
        return allowUnlistedChain;
    }

    /// @notice Validate compiler, fork revision, and target-chain assumptions before deployment.
    function validateAssumptions(ForkAssumptions memory assumptions) internal pure {
        if (!isExpectedCompiler(assumptions.solcVersion)) {
            revert UnsupportedCompilerAssumptions(assumptions.solcVersion);
        }
        if (!isCancunOrLater(assumptions.evmRevision)) {
            revert UnsupportedForkRevision(assumptions.evmRevision);
        }
        if (!isSupportedChain(assumptions.chainId, assumptions.allowDevChain, assumptions.allowUnlistedChain))
        {
            revert UnsupportedTargetChain(assumptions.chainId);
        }
    }

    /// @notice Execute `PUSH0` and `MCOPY` in scratch memory to confirm static Cancun support.
    function probeStaticOpcodes() internal pure returns (bool push0Ok, bool mcopyOk) {
        uint256 zeroCheck = 1;
        bytes32 expected = MCOPY_SENTINEL;
        bytes32 copied;
        assembly ("memory-safe") {
            zeroCheck := 0
            mstore(0x00, expected)
            mstore(0x20, 0)
            mcopy(0x20, 0x00, 0x20)
            copied := mload(0x20)
        }
        push0Ok = (zeroCheck == 0);
        mcopyOk = (copied == expected);
    }

    /// @notice Execute `TSTORE` and `TLOAD` to confirm EIP-1153 transient storage availability.
    function probeTransientOpcodes() internal returns (bool transientOk) {
        bytes32 slot = TSTORE_SLOT;
        bytes32 expected = TSTORE_SENTINEL;
        bytes32 loaded;
        bytes32 cleared;
        assembly ("memory-safe") {
            tstore(slot, expected)
            loaded := tload(slot)
            tstore(slot, 0)
            cleared := tload(slot)
        }
        transientOk = (loaded == expected && cleared == bytes32(0));
    }

    /// @notice Build a static `eth_call` compatibility report without mutating transient state.
    function staticReport(uint256 chainId) internal pure returns (ForkCompatibilityReport memory report) {
        (bool push0Ok, bool mcopyOk) = probeStaticOpcodes();
        bool chainOk = isSupportedChain(chainId, true, false);
        report = ForkCompatibilityReport({
            solcVersion: EXPECTED_SOLC_VERSION,
            evmRevision: EXPECTED_EVM_REVISION,
            viaIr: true,
            chainId: chainId,
            push0Supported: push0Ok,
            mcopySupported: mcopyOk,
            transientStorageSupported: false,
            targetChainSupported: chainOk,
            compatible: push0Ok && mcopyOk && chainOk
        });
    }

    /// @notice Build a full compatibility report exercising `PUSH0`, `MCOPY`, and `TSTORE`/`TLOAD`.
    function fullReport(uint256 chainId) internal returns (ForkCompatibilityReport memory report) {
        (bool push0Ok, bool mcopyOk) = probeStaticOpcodes();
        bool transientOk = probeTransientOpcodes();
        bool chainOk = isSupportedChain(chainId, true, false);
        report = ForkCompatibilityReport({
            solcVersion: EXPECTED_SOLC_VERSION,
            evmRevision: EXPECTED_EVM_REVISION,
            viaIr: true,
            chainId: chainId,
            push0Supported: push0Ok,
            mcopySupported: mcopyOk,
            transientStorageSupported: transientOk,
            targetChainSupported: chainOk,
            compatible: push0Ok && mcopyOk && transientOk && chainOk
        });
    }

    /// @notice Verify both declared fork assumptions and an external `CancunProbe` contract call.
    function verifyTargetExecution(ForkAssumptions memory assumptions, address probeContract) internal {
        validateAssumptions(assumptions);
        if (probeContract == address(0) || probeContract.code.length == 0) {
            revert CancunOpcodeProbeFailed("probe-code");
        }
        (bool ok, bytes memory data) = probeContract.call(abi.encodeCall(CancunProbe.runProbe, ()));
        if (!ok || data.length < 96) revert CancunOpcodeProbeFailed("cancun-opcodes");
        (bool push0Ok, bool mcopyOk, bool transientOk) = abi.decode(data, (bool, bool, bool));
        if (!push0Ok) revert CancunOpcodeProbeFailed("push0");
        if (!mcopyOk) revert CancunOpcodeProbeFailed("mcopy");
        if (!transientOk) revert CancunOpcodeProbeFailed("tstore-tload");
    }
}

/// @title Isolated opcode probe target for pre-proposal fork verification
/// @notice Exercises Shanghai `PUSH0` and Cancun `MCOPY` + `TSTORE`/`TLOAD` behind a low-level
/// call boundary so callers can catch `InvalidOpcode` failures cleanly instead of aborting blindly.
contract CancunProbe {
    /// @notice Run static and transient Cancun opcode checks and report each capability flag.
    function runProbe() external returns (bool push0Ok, bool mcopyOk, bool transientOk) {
        (push0Ok, mcopyOk) = ForkCompatibility.probeStaticOpcodes();
        transientOk = ForkCompatibility.probeTransientOpcodes();
    }
}
