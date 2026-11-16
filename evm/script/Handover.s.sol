// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";

import {HyperionRouter} from "../src/HyperionRouter.sol";
import {AuthoritySnapshot} from "../src/HyperionTypes.sol";
import {AxelarItsAdapter} from "../src/adapters/AxelarItsAdapter.sol";
import {CctpAdapter} from "../src/adapters/CctpAdapter.sol";

import {DeployConfig} from "./DeployConfig.sol";

/// @title Multi-contract ownership handover rehearsal and execution helper
/// @author dotmantissa
/// @notice Completes or inspects two-step adapter ownership alongside router admin handover.
contract Handover is DeployConfig {
    using stdJson for string;

    error RouterAdminNotHandedOver(address expectedAdmin);
    error UnexpectedPendingOwner(address adapter, address caller, address pendingOwner);

    struct HandoverReport {
        address router;
        address deployer;
        address targetAdmin;
        bool deployerHasAdmin;
        bool targetHasAdmin;
        address cctpAdapter;
        address cctpOwner;
        address cctpPendingOwner;
        address axelarAdapter;
        address axelarOwner;
        address axelarPendingOwner;
    }

    function run() external view {
        string memory path = vm.envOr(
            "HYPERION_RECORD", string.concat("deployments/evm-", vm.toString(block.chainid), "-phase1.json")
        );
        string memory record = vm.readFile(path);

        HyperionRouter router = HyperionRouter(payable(record.readAddress(".router")));
        CctpAdapter cctp = CctpAdapter(payable(record.readAddress(".cctpAdapter")));
        AxelarItsAdapter axelar = vm.keyExistsJson(record, ".axelarAdapter")
            ? AxelarItsAdapter(payable(record.readAddress(".axelarAdapter")))
            : AxelarItsAdapter(payable(address(0)));

        address deployer = record.readAddress(".deployer");
        address targetAdmin = record.readAddress(".admin");
        HandoverReport memory report = inspect(router, cctp, axelar, deployer, targetAdmin);
        _printReport(report);
    }

    function proposeAdapterHandover(CctpAdapter cctp, AxelarItsAdapter axelar, address caller, address target)
        public
        returns (uint256 proposedCount)
    {
        if (address(cctp) != address(0) && cctp.owner() == caller && caller != target) {
            if (cctp.pendingOwner() != target) {
                vm.prank(caller);
                cctp.transferOwnership(target);
                proposedCount += 1;
            }
        }
        if (address(axelar) != address(0) && axelar.owner() == caller && caller != target) {
            if (axelar.pendingOwner() != target) {
                vm.prank(caller);
                axelar.transferOwnership(target);
                proposedCount += 1;
            }
        }
    }

    function acceptAdapterHandover(CctpAdapter cctp, AxelarItsAdapter axelar, address caller)
        public
        returns (uint256 acceptedCount)
    {
        if (address(cctp) != address(0)) {
            if (cctp.pendingOwner() == caller) {
                vm.prank(caller);
                cctp.acceptOwnership();
                acceptedCount += 1;
            } else if (cctp.owner() != caller) {
                revert UnexpectedPendingOwner(address(cctp), caller, cctp.pendingOwner());
            }
        }
        if (address(axelar) != address(0)) {
            if (axelar.pendingOwner() == caller) {
                vm.prank(caller);
                axelar.acceptOwnership();
                acceptedCount += 1;
            } else if (axelar.owner() != caller) {
                revert UnexpectedPendingOwner(address(axelar), caller, axelar.pendingOwner());
            }
        }
    }

    function renounceDeployerAdmin(HyperionRouter router, address deployer, address expectedAdmin)
        public
        returns (bool renounced)
    {
        bytes32 adminRole = router.DEFAULT_ADMIN_ROLE();
        if (!router.hasRole(adminRole, expectedAdmin)) {
            revert RouterAdminNotHandedOver(expectedAdmin);
        }
        if (deployer != expectedAdmin && router.hasRole(adminRole, deployer)) {
            vm.prank(deployer);
            router.renounceRole(adminRole, deployer);
            return true;
        }
        return false;
    }

    function inspect(
        HyperionRouter router,
        CctpAdapter cctp,
        AxelarItsAdapter axelar,
        address deployer,
        address targetAdmin
    ) public view returns (HandoverReport memory report) {
        AuthoritySnapshot memory snap = router.authoritySnapshot(deployer, targetAdmin);
        report.router = snap.router;
        report.deployer = deployer;
        report.targetAdmin = targetAdmin;
        report.deployerHasAdmin = snap.deployerHasAdmin;
        report.targetHasAdmin = snap.targetHasAdmin;
        report.cctpAdapter = address(cctp);
        if (address(cctp) != address(0)) {
            report.cctpOwner = cctp.owner();
            report.cctpPendingOwner = cctp.pendingOwner();
        }
        report.axelarAdapter = address(axelar);
        if (address(axelar) != address(0)) {
            report.axelarOwner = axelar.owner();
            report.axelarPendingOwner = axelar.pendingOwner();
        }
    }

    function _printReport(HandoverReport memory report) private pure {
        console.log("router              ", report.router);
        console.log("deployer admin      ", report.deployerHasAdmin);
        console.log("target admin        ", report.targetHasAdmin);
        console.log("cctp owner          ", report.cctpOwner);
        console.log("cctp pending owner  ", report.cctpPendingOwner);
        if (report.axelarAdapter != address(0)) {
            console.log("axelar owner        ", report.axelarOwner);
            console.log("axelar pending owner", report.axelarPendingOwner);
        }
    }
}
