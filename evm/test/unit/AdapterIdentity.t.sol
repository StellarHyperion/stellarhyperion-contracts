// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AdapterCodeHashMismatch,
    AdapterRouterMismatch,
    InvalidAdapterCode,
    UnsupportedAdapterInterface
} from "../../src/HyperionErrors.sol";
import {HyperionRouter} from "../../src/HyperionRouter.sol";
import {
    ActionKind,
    AdapterDeploymentKind,
    AdapterIdentityReport,
    AdminAction,
    Destination,
    RouteKind
} from "../../src/HyperionTypes.sol";
import {IHyperionRouter} from "../../src/interfaces/IHyperionRouter.sol";
import {Fixture} from "../Fixture.sol";
import {MockRailAdapter} from "../mocks/MockRailAdapter.sol";

/// @notice Minimal contract bound to a router but missing `supportsChain` and `quoteFee`.
contract IncompleteAdapter {
    address public immutable ROUTER;
    RouteKind private immutable ROUTE;

    constructor(address router_, RouteKind route_) {
        ROUTER = router_;
        ROUTE = route_;
    }

    function route() external view returns (RouteKind) {
        return ROUTE;
    }
}

/// @notice Valid rail adapter that declares UUPS upgradeability markers so assumptions surface.
contract UpgradeableMockAdapter is MockRailAdapter {
    bytes32 private constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address public implementation;

    constructor(RouteKind route_, address router_, address impl_) MockRailAdapter(route_, router_) {
        implementation = impl_;
    }

    function proxiableUUID() external pure returns (bytes32) {
        return IMPLEMENTATION_SLOT;
    }
}

/// @notice Stateless implementation used behind an ERC-1167 minimal proxy clone.
contract CloneableAdapterImpl {
    address public immutable ROUTER;

    constructor(address router_) {
        ROUTER = router_;
    }

    function route() external pure returns (RouteKind) {
        return RouteKind.Cctp;
    }

    function supportsChain(string calldata) external pure returns (bool) {
        return true;
    }

    function quoteFee(string calldata, uint256) external pure returns (uint256) {
        return 0;
    }

    function dispatch(address, uint256, Destination calldata, uint64) external payable returns (bytes32) {
        return bytes32(uint256(1));
    }
}

/// @title Adapter code-identity, router-binding, and upgradeability reporting tests
contract AdapterIdentityTest is Fixture {
    function _deployErc1167Clone(address target) internal returns (address clone) {
        bytes memory initCode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            bytes20(target),
            hex"5af43d82803e903d91602b57fd5bf3"
        );
        assembly {
            clone := create(0, add(initCode, 32), mload(initCode))
        }
        assertTrue(clone != address(0));
    }

    function test_adapter_bound_to_another_router_is_rejected() public {
        HyperionRouter otherRouter = _freshRouter();
        MockRailAdapter wrongRouterAdapter = new MockRailAdapter(RouteKind.Cctp, address(otherRouter));

        AdapterIdentityReport memory report =
            router.inspectAdapterCandidate(RouteKind.Cctp, address(wrongRouterAdapter));
        assertTrue(report.hasCode);
        assertFalse(report.routerMatches);
        assertEq(report.declaredRouter, address(otherRouter));

        AdminAction memory action = _empty(ActionKind.SetAdapter);
        action.route = RouteKind.Cctp;
        action.subject = address(wrongRouterAdapter);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                AdapterRouterMismatch.selector,
                address(wrongRouterAdapter),
                address(otherRouter),
                address(router)
            )
        );
        router.queueAction(action);
    }

    function test_empty_code_and_unsupported_interfaces_cannot_become_active() public {
        // 1. EOA / empty code cannot be queued.
        AdminAction memory eoaAction = _empty(ActionKind.SetAdapter);
        eoaAction.route = RouteKind.Cctp;
        eoaAction.subject = stranger;

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(InvalidAdapterCode.selector, stranger));
        router.queueAction(eoaAction);

        // 2. Contract bound to router with wrong route tag is rejected.
        AdminAction memory wrongRouteAction = _empty(ActionKind.SetAdapter);
        wrongRouteAction.route = RouteKind.Cctp;
        wrongRouteAction.subject = address(itsRail);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedAdapterInterface.selector, address(itsRail), RouteKind.Cctp)
        );
        router.queueAction(wrongRouteAction);

        // 3. Contract bound to router missing IRailAdapter read functions is rejected.
        IncompleteAdapter incomplete = new IncompleteAdapter(address(router), RouteKind.Cctp);
        AdminAction memory incompleteAction = _empty(ActionKind.SetAdapter);
        incompleteAction.route = RouteKind.Cctp;
        incompleteAction.subject = address(incomplete);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedAdapterInterface.selector, address(incomplete), RouteKind.Cctp)
        );
        router.queueAction(incompleteAction);
    }

    function test_code_mutation_during_timelock_or_before_route_enable_is_rejected() public {
        MockRailAdapter candidate = new MockRailAdapter(RouteKind.Cctp, address(router));
        bytes32 originalHash = address(candidate).codehash;

        AdminAction memory setAct = _empty(ActionKind.SetAdapter);
        setAct.route = RouteKind.Cctp;
        setAct.subject = address(candidate);
        uint64 queuedId = _mature(setAct);
        assertEq(router.queuedAdapterCodeHash(queuedId), originalHash);

        // Mutate runtime code to another valid contract with a different codehash before execute.
        UpgradeableMockAdapter differentCode =
            new UpgradeableMockAdapter(RouteKind.Cctp, address(router), stranger);
        bytes32 mutatedHash = address(differentCode).codehash;
        vm.etch(address(candidate), address(differentCode).code);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                AdapterCodeHashMismatch.selector, address(candidate), originalHash, mutatedHash
            )
        );
        router.executeAction(queuedId);

        // If an already-wired adapter loses its code while disabled, re-enabling the route fails.
        _enableRoute(RouteKind.Allbridge, false);
        vm.etch(address(allbridgeRail), "");

        AdminAction memory enableAct = _empty(ActionKind.EnableRoute);
        enableAct.route = RouteKind.Allbridge;
        enableAct.amount = 1;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(InvalidAdapterCode.selector, address(allbridgeRail)));
        router.queueAction(enableAct);
    }

    function test_mutated_active_adapter_cannot_dispatch_outbound() public {
        bytes32 approved = router.adapterIdentity(RouteKind.Cctp).approvedCodeHash;
        UpgradeableMockAdapter next = new UpgradeableMockAdapter(RouteKind.Cctp, address(router), stranger);
        vm.etch(address(cctpRail), address(next).code);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                AdapterCodeHashMismatch.selector, address(cctpRail), approved, address(cctpRail).codehash
            )
        );
        router.bridgeOut(_usdcRequest(100e6));
    }

    function test_upgradeable_and_minimal_proxy_assumptions_are_reported_explicitly() public {
        // 1. Standard immutable adapter reports ImmutableContract.
        AdapterIdentityReport memory baseReport = router.adapterIdentity(RouteKind.Cctp);
        assertTrue(baseReport.hasCode);
        assertTrue(baseReport.routerMatches);
        assertTrue(baseReport.interfaceSupported);
        assertTrue(baseReport.codeHashMatches);
        assertEq(uint8(baseReport.deploymentKind), uint8(AdapterDeploymentKind.ImmutableContract));
        assertEq(baseReport.minimalProxyTarget, address(0));

        // 2. ERC-1167 minimal proxy clone reports MinimalProxy and its target implementation.
        CloneableAdapterImpl impl = new CloneableAdapterImpl(address(router));
        address clone = _deployErc1167Clone(address(impl));
        AdapterIdentityReport memory cloneReport = router.inspectAdapterCandidate(RouteKind.Cctp, clone);
        assertTrue(cloneReport.routerMatches);
        assertTrue(cloneReport.interfaceSupported);
        assertEq(uint8(cloneReport.deploymentKind), uint8(AdapterDeploymentKind.MinimalProxy));
        assertEq(cloneReport.minimalProxyTarget, address(impl));

        // 3. Upgradeable adapter reports UpgradeableContract and emits identity event on set.
        UpgradeableMockAdapter uups =
            new UpgradeableMockAdapter(RouteKind.Cctp, address(router), address(impl));
        AdapterIdentityReport memory uupsReport =
            router.inspectAdapterCandidate(RouteKind.Cctp, address(uups));
        assertEq(uint8(uupsReport.deploymentKind), uint8(AdapterDeploymentKind.UpgradeableContract));

        AdminAction memory action = _empty(ActionKind.SetAdapter);
        action.route = RouteKind.Cctp;
        action.subject = address(uups);
        uint64 id = _mature(action);

        vm.expectEmit(true, true, false, true, address(router));
        emit IHyperionRouter.AdapterIdentityVerified(
            RouteKind.Cctp, address(uups), address(uups).codehash, AdapterDeploymentKind.UpgradeableContract
        );
        vm.prank(admin);
        router.executeAction(id);
    }
}
