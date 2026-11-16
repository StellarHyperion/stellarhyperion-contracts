// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AdapterCodeHashMismatch,
    AdapterRouterMismatch,
    InvalidAdapterCode,
    UnsupportedAdapterInterface
} from "../HyperionErrors.sol";
import {AdapterDeploymentKind, AdapterIdentityReport, RouteKind} from "../HyperionTypes.sol";
import {IRailAdapter} from "../interfaces/IRailAdapter.sol";

/// @title Adapter runtime code-identity and router-binding inspector
/// @notice Probes candidate rail adapters for non-empty code, router binding, interface support,
/// reviewed codehashes, and proxy or upgradeable markers before route activation.
library AdapterIdentity {
    bytes10 private constant ERC1167_PREFIX = 0x363d3d373d3d3d363d73;
    bytes15 private constant ERC1167_SUFFIX = 0x5af43d82803e903d91602b57fd5bf3;

    /// @notice Inspect a candidate adapter without reverting on malformed targets.
    function inspect(
        RouteKind expectedRoute,
        address candidate,
        address expectedRouter,
        bytes32 approvedCodeHash
    ) internal view returns (AdapterIdentityReport memory report) {
        report.adapter = candidate;
        report.approvedCodeHash = approvedCodeHash;
        if (candidate == address(0)) return report;

        bytes memory code = candidate.code;
        if (code.length == 0) return report;

        report.hasCode = true;
        report.codeHash = candidate.codehash;
        report.codeHashMatches = approvedCodeHash == bytes32(0) || report.codeHash == approvedCodeHash;
        (report.deploymentKind, report.minimalProxyTarget) = _classifyDeployment(candidate, code);

        (bool routerOk, address declaredRouter) = _probeRouter(candidate);
        if (routerOk) {
            report.declaredRouter = declaredRouter;
            report.routerMatches = declaredRouter == expectedRouter;
        }

        (bool ifaceOk, RouteKind declaredRoute) = _probeInterface(candidate);
        if (ifaceOk) {
            report.declaredRoute = declaredRoute;
            report.routeMatches = declaredRoute == expectedRoute;
            report.interfaceSupported = true;
        }
    }

    /// @notice Require a candidate adapter to satisfy code, router, interface, and codehash rules.
    function requireValid(
        RouteKind expectedRoute,
        address candidate,
        address expectedRouter,
        bytes32 expectedCodeHash
    ) internal view returns (AdapterIdentityReport memory report) {
        report = inspect(expectedRoute, candidate, expectedRouter, expectedCodeHash);
        if (!report.hasCode) revert InvalidAdapterCode(candidate);
        if (!report.routerMatches) {
            revert AdapterRouterMismatch(candidate, report.declaredRouter, expectedRouter);
        }
        if (!report.interfaceSupported || !report.routeMatches) {
            revert UnsupportedAdapterInterface(candidate, expectedRoute);
        }
        if (expectedCodeHash != bytes32(0) && !report.codeHashMatches) {
            revert AdapterCodeHashMismatch(candidate, expectedCodeHash, report.codeHash);
        }
    }

    function _probeRouter(address candidate) private view returns (bool ok, address declaredRouter) {
        bytes memory ret;
        (ok, ret) = candidate.staticcall(abi.encodeWithSignature("ROUTER()"));
        if (!ok || ret.length != 32) return (false, address(0));
        uint256 word = abi.decode(ret, (uint256));
        if (word > type(uint160).max) return (false, address(0));
        return (true, address(uint160(word)));
    }

    function _probeInterface(address candidate) private view returns (bool ok, RouteKind declaredRoute) {
        (bool routeOk, bytes memory routeRet) = candidate.staticcall(abi.encodeCall(IRailAdapter.route, ()));
        if (!routeOk || routeRet.length != 32) return (false, RouteKind.Cctp);
        uint256 rawRoute = abi.decode(routeRet, (uint256));
        if (rawRoute > uint256(RouteKind.Allbridge)) return (false, RouteKind.Cctp);

        (bool supOk, bytes memory supRet) =
            candidate.staticcall(abi.encodeCall(IRailAdapter.supportsChain, ("")));
        if (!supOk || supRet.length != 32) return (false, RouteKind.Cctp);
        uint256 rawBool = abi.decode(supRet, (uint256));
        if (rawBool > 1) return (false, RouteKind.Cctp);

        (bool feeOk, bytes memory feeRet) =
            candidate.staticcall(abi.encodeCall(IRailAdapter.quoteFee, ("", 0)));
        if (!feeOk || feeRet.length != 32) return (false, RouteKind.Cctp);

        return (true, RouteKind(rawRoute));
    }

    function _classifyDeployment(address candidate, bytes memory code)
        private
        view
        returns (AdapterDeploymentKind kind, address cloneTarget)
    {
        if (code.length == 45) {
            bytes10 prefix;
            bytes20 targetBytes;
            bytes15 suffix;
            assembly {
                prefix := mload(add(code, 32))
                targetBytes := mload(add(code, 42))
                suffix := mload(add(code, 62))
            }
            if (prefix == ERC1167_PREFIX && suffix == ERC1167_SUFFIX) {
                return (AdapterDeploymentKind.MinimalProxy, address(targetBytes));
            }
        }

        bytes memory uuidCall = abi.encodeWithSignature("proxiableUUID()");
        (bool uuidOk, bytes memory uuidRet) = candidate.staticcall(uuidCall);
        if (uuidOk && uuidRet.length == 32) {
            return (AdapterDeploymentKind.UpgradeableContract, address(0));
        }

        (bool verOk, bytes memory verRet) =
            candidate.staticcall(abi.encodeWithSignature("UPGRADE_INTERFACE_VERSION()"));
        if (verOk && verRet.length > 0) {
            return (AdapterDeploymentKind.UpgradeableContract, address(0));
        }

        (bool implOk, bytes memory implRet) =
            candidate.staticcall(abi.encodeWithSignature("implementation()"));
        if (implOk && implRet.length == 32) {
            uint256 rawImpl = abi.decode(implRet, (uint256));
            if (rawImpl != 0 && rawImpl <= type(uint160).max) {
                return (AdapterDeploymentKind.UpgradeableContract, address(uint160(rawImpl)));
            }
        }

        return (AdapterDeploymentKind.ImmutableContract, address(0));
    }
}
