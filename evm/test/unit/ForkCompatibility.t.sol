// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deploy} from "../../script/Deploy.s.sol";
import {Verify} from "../../script/Verify.s.sol";
import {ForkAssumptions, ForkCompatibilityReport} from "../../src/HyperionTypes.sol";
import {CancunProbe, ForkCompatibility} from "../../src/libraries/ForkCompatibility.sol";
import {Fixture} from "../Fixture.sol";

/// @title Simulated pre-Cancun probe target that fails `MCOPY` or `TSTORE`
contract FailingCancunProbe {
    bool private immutable _push0Ok;
    bool private immutable _mcopyOk;
    bool private immutable _transientOk;
    bool private immutable _reverts;

    constructor(bool push0Ok_, bool mcopyOk_, bool transientOk_, bool reverts_) {
        _push0Ok = push0Ok_;
        _mcopyOk = mcopyOk_;
        _transientOk = transientOk_;
        _reverts = reverts_;
    }

    function runProbe() external view returns (bool, bool, bool) {
        if (_reverts) revert("invalid opcode");
        return (_push0Ok, _mcopyOk, _transientOk);
    }
}

/// @title Wrapper exposing internal `ForkCompatibility` library calls for revert assertions
contract ForkCompatibilityCaller {
    function validate(ForkAssumptions memory assumptions) external pure {
        ForkCompatibility.validateAssumptions(assumptions);
    }

    function verifyExecution(ForkAssumptions memory assumptions, address probe) external {
        ForkCompatibility.verifyTargetExecution(assumptions, probe);
    }
}

/// @title Cancun opcode, compiler assumption, and target-chain fork diagnostics
contract ForkCompatibilityTest is Fixture {
    ForkCompatibilityCaller internal caller;
    CancunProbe internal liveProbe;

    function setUp() public override {
        super.setUp();
        caller = new ForkCompatibilityCaller();
        liveProbe = new CancunProbe();
    }

    function test_unsupported_fork_and_compiler_settings_fail_before_deployment_proposal() public {
        Deploy deployerScript = new Deploy();
        uint64 actionsBefore = router.actionCount();

        // Pre-Cancun Shanghai fork rejected before any router deploy or queueAction proposal.
        ForkAssumptions memory shanghai = ForkCompatibility.localShanghaiProfile(block.chainid);
        vm.expectRevert(
            abi.encodeWithSelector(ForkCompatibility.UnsupportedForkRevision.selector, "shanghai")
        );
        deployerScript.preflightFork(shanghai);

        // Pre-Shanghai Paris fork rejected before any router deploy or queueAction proposal.
        ForkAssumptions memory paris = ForkCompatibility.localParisProfile(block.chainid);
        vm.expectRevert(abi.encodeWithSelector(ForkCompatibility.UnsupportedForkRevision.selector, "paris"));
        deployerScript.preflightFork(paris);

        // Compiler mismatch rejected before any proposal.
        ForkAssumptions memory wrongSolc = _cancunProfile();
        wrongSolc.solcVersion = "0.8.24";
        vm.expectRevert(
            abi.encodeWithSelector(ForkCompatibility.UnsupportedCompilerAssumptions.selector, "0.8.24")
        );
        deployerScript.preflightFork(wrongSolc);

        assertEq(router.actionCount(), actionsBefore, "no timelock proposal was queued");
    }

    function test_local_profiles_exercise_supported_and_unsupported_chain_and_opcode_assumptions() public {
        // Supported local Cancun profile on Anvil/Foundry (31337) and Sepolia (11155111).
        caller.verifyExecution(_cancunProfile(), address(liveProbe));
        ForkAssumptions memory sepoliaProfile = ForkAssumptions({
            solcVersion: "0.8.28",
            evmRevision: "cancun",
            chainId: 11_155_111,
            allowDevChain: false,
            allowUnlistedChain: false
        });
        caller.verifyExecution(sepoliaProfile, address(liveProbe));

        // Dev chain disallowed when production chain guard is active.
        ForkAssumptions memory devBlocked = _cancunProfile();
        devBlocked.allowDevChain = false;
        vm.expectRevert(
            abi.encodeWithSelector(ForkCompatibility.UnsupportedTargetChain.selector, block.chainid)
        );
        caller.validate(devBlocked);

        // Unlisted chain rejected unless explicitly opted into reviewed local testing.
        ForkAssumptions memory unlisted = ForkAssumptions({
            solcVersion: "0.8.28",
            evmRevision: "cancun",
            chainId: 999_999,
            allowDevChain: true,
            allowUnlistedChain: false
        });
        vm.expectRevert(abi.encodeWithSelector(ForkCompatibility.UnsupportedTargetChain.selector, 999_999));
        caller.validate(unlisted);

        unlisted.allowUnlistedChain = true;
        caller.verifyExecution(unlisted, address(liveProbe));

        // Probe failure modes: empty code, reverting invalid opcode, missing MCOPY, missing TSTORE.
        vm.expectRevert(
            abi.encodeWithSelector(ForkCompatibility.CancunOpcodeProbeFailed.selector, "probe-code")
        );
        caller.verifyExecution(_cancunProfile(), makeAddr("emptyCode"));

        FailingCancunProbe invalidOp = new FailingCancunProbe(false, false, false, true);
        vm.expectRevert(
            abi.encodeWithSelector(ForkCompatibility.CancunOpcodeProbeFailed.selector, "cancun-opcodes")
        );
        caller.verifyExecution(_cancunProfile(), address(invalidOp));

        FailingCancunProbe noMcopy = new FailingCancunProbe(true, false, true, false);
        vm.expectRevert(abi.encodeWithSelector(ForkCompatibility.CancunOpcodeProbeFailed.selector, "mcopy"));
        caller.verifyExecution(_cancunProfile(), address(noMcopy));

        FailingCancunProbe noTransient = new FailingCancunProbe(true, true, false, false);
        vm.expectRevert(
            abi.encodeWithSelector(ForkCompatibility.CancunOpcodeProbeFailed.selector, "tstore-tload")
        );
        caller.verifyExecution(_cancunProfile(), address(noTransient));
    }

    function test_router_and_verifier_reports_identify_compiler_and_evm_revision() public {
        ForkCompatibilityReport memory staticReport = router.forkCompatibility();
        assertEq(staticReport.solcVersion, "0.8.28");
        assertEq(staticReport.evmRevision, "cancun");
        assertTrue(staticReport.viaIr);
        assertEq(staticReport.chainId, block.chainid);
        assertTrue(staticReport.push0Supported);
        assertTrue(staticReport.mcopySupported);
        assertFalse(staticReport.transientStorageSupported, "view call skips stateful TSTORE");
        assertTrue(staticReport.targetChainSupported);
        assertTrue(staticReport.compatible);

        Verify verifier = new Verify();
        ForkCompatibilityReport memory fullReport = verifier.verifyFork(router, "0.8.28", "cancun");
        assertEq(fullReport.solcVersion, "0.8.28");
        assertEq(fullReport.evmRevision, "cancun");
        assertTrue(fullReport.viaIr);
        assertTrue(fullReport.push0Supported);
        assertTrue(fullReport.mcopySupported);
        assertTrue(fullReport.transientStorageSupported);
        assertTrue(fullReport.targetChainSupported);
        assertTrue(fullReport.compatible);

        // Switching chainid to an unapproved network marks targetChainSupported and compatible false.
        vm.chainId(777_777);
        ForkCompatibilityReport memory drifted = router.probeForkCompatibility();
        assertFalse(drifted.targetChainSupported);
        assertFalse(drifted.compatible);
    }
}
