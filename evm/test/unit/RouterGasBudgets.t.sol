// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";

import {RecipientNotReady} from "../../src/HyperionErrors.sol";
import {ActionKind, AdminAction, Origin, RouteKind} from "../../src/HyperionTypes.sol";
import {Fixture} from "../Fixture.sol";

/// @notice ERC20 test double that simulates a hostile recipient hook burning bounded gas and
/// returning malformed data (< 32 bytes) so `_tryPay` parks the claim rather than paying out.
contract HostileHookERC20 is ERC20 {
    mapping(address account => uint256 wordsToSpin) public hostileSpinWords;
    mapping(address account => bool malformedReturn) public hostileShortReturn;

    constructor() ERC20("Hostile USD", "hUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHostileProfile(address account, uint256 spinWords, bool shortReturn) external {
        hostileSpinWords[account] = spinWords;
        hostileShortReturn[account] = shortReturn;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        uint256 spin = hostileSpinWords[to];
        if (spin != 0) {
            bytes32 acc = bytes32(spin);
            for (uint256 i = 0; i < spin; ++i) {
                acc = keccak256(abi.encode(acc, i));
            }
            if (acc == bytes32(0)) {
                return false;
            }
        }
        if (hostileShortReturn[to]) {
            assembly {
                mstore(0x00, 0x01)
                return(0x00, 0x04)
            }
        }
        return super.transfer(to, value);
    }
}

contract RouterGasBudgetsTest is Fixture {
    uint256 internal constant STATE_GROWTH_ACTIONS = 128;
    uint256 internal constant STATE_GROWTH_CLAIMS = 128;
    uint256 internal constant STATE_GROWTH_REPLAYS = 128;
    uint256 internal constant BPS_DENOM = 10_000;

    // Pinned Solc 0.8.28 (cancun, via_ir = true, optimizer_runs = 20000) baselines:
    uint256 internal constant BASELINE_QUEUE_COLD = 91_989;
    uint256 internal constant BASELINE_QUEUE_WARM = 78_798;
    uint256 internal constant BASELINE_BATCH5_QUEUE = 393_990;
    uint256 internal constant BASELINE_EXECUTE_COLD = 11_102;
    uint256 internal constant BASELINE_EXECUTE_WARM = 8302;
    uint256 internal constant BASELINE_BATCH5_EXECUTE = 44_310;
    uint256 internal constant BASELINE_CANCEL_WARM = 6087;
    uint256 internal constant BASELINE_EMERGENCY_PAUSE_COLD = 25_163;
    uint256 internal constant BASELINE_EMERGENCY_LOWER_LIMIT = 15_047;

    uint256 internal constant BASELINE_BRIDGE_IN_NORMAL_COLD = 113_898;
    uint256 internal constant BASELINE_BRIDGE_IN_NORMAL_WARM = 40_485;
    uint256 internal constant BASELINE_PARK_FROZEN_COLD = 185_518;
    uint256 internal constant BASELINE_PARK_FROZEN_WARM = 159_036;
    uint256 internal constant BASELINE_PARK_SILENT_FALSE = 156_769;
    uint256 internal constant BASELINE_PARK_HOSTILE_HOOK = 204_538;

    uint256 internal constant BASELINE_SETTLE_NORMAL_COLD = 35_520;
    uint256 internal constant BASELINE_SETTLE_NORMAL_WARM = 11_620;
    uint256 internal constant BASELINE_SETTLE_HOSTILE_REVERT = 8282;

    // Documented tolerances: 10% (1000 bps) for SSTORE-heavy paths, 15% (1500 bps) for compact warm paths.
    uint256 internal constant TOLERANCE_STANDARD_BPS = 1000;
    uint256 internal constant TOLERANCE_COMPACT_BPS = 1500;
    uint256 internal constant MAX_STATE_GROWTH_DRIFT_GAS = 500;

    HostileHookERC20 internal hostileToken;
    address internal coldRecipient = makeAddr("coldRecipient");
    address internal warmRecipient = makeAddr("warmRecipient");
    address internal frozenRecipient = makeAddr("frozenRecipient");
    address internal hostileHookRecipient = makeAddr("hostileHookRecipient");

    function setUp() public override {
        super.setUp();
        hostileToken = new HostileHookERC20();
        _registerToken(address(hostileToken), USDC_DECIMALS, FLOW_LIMIT);

        usdc.mint(railReceiver, 50_000_000e6);
        vm.prank(railReceiver);
        usdc.approve(address(router), type(uint256).max);

        hostileToken.mint(railReceiver, 50_000_000e6);
        vm.prank(railReceiver);
        hostileToken.approve(address(router), type(uint256).max);

        usdc.mint(warmRecipient, 1e6);
        hostileToken.mint(warmRecipient, 1e6);

        usdc.setBlocked(frozenRecipient, true);
        hostileToken.setHostileProfile(hostileHookRecipient, 32, true);
    }

    function _ceiling(uint256 baseline, uint256 toleranceBps) internal pure returns (uint256) {
        return baseline + ((baseline * toleranceBps) / BPS_DENOM);
    }

    function _origin(uint64 seq, uint256 tag) internal pure returns (Origin memory) {
        return Origin({
            chain: STELLAR,
            nonce: seq,
            messageId: keccak256(abi.encode("gas-budget-msg", tag, seq)),
            sender: G_KEY
        });
    }

    function _seedStateGrowth() internal {
        for (uint256 i = 0; i < STATE_GROWTH_ACTIONS; ++i) {
            AdminAction memory act = _empty(ActionKind.SetFeeBps);
            act.amount = uint256((i % 50) + 1);
            vm.prank(admin);
            router.queueAction(act);
        }

        for (uint64 i = 1; i <= STATE_GROWTH_REPLAYS; ++i) {
            vm.prank(railReceiver);
            router.bridgeIn(RouteKind.Cctp, address(usdc), 10e6, warmRecipient, _origin(i, 1));
        }

        for (uint64 i = 1; i <= STATE_GROWTH_CLAIMS; ++i) {
            vm.prank(railReceiver);
            uint64 cid = router.bridgeIn(RouteKind.Cctp, address(usdc), 10e6, frozenRecipient, _origin(i, 2));
            assertGt(cid, 0);
        }
    }

    function _measureQueueFee(uint16 bps) internal returns (uint64 id, uint256 gasUsed) {
        AdminAction memory action = _empty(ActionKind.SetFeeBps);
        action.amount = bps;
        vm.prank(admin);
        uint256 g0 = gasleft();
        id = router.queueAction(action);
        gasUsed = g0 - gasleft();
    }

    function _measureExecute(uint64 id) internal returns (uint256 gasUsed) {
        vm.prank(admin);
        uint256 g0 = gasleft();
        router.executeAction(id);
        gasUsed = g0 - gasleft();
    }

    function test_governanceBatchedActionGasBudgetsUnderStateGrowth() public {
        (, uint256 preGrowthQueueCold) = _measureQueueFee(15);
        (, uint256 preGrowthQueueWarm) = _measureQueueFee(20);

        _seedStateGrowth();

        uint64[] memory ids = new uint64[](5);
        uint256 batchQueueTotal = 0;
        uint256 postGrowthQueueWarm = 0;

        for (uint256 i = 0; i < 5; ++i) {
            (uint64 id, uint256 used) = _measureQueueFee(uint16(25 + i));
            ids[i] = id;
            batchQueueTotal += used;
            if (i == 1) {
                postGrowthQueueWarm = used;
            }
        }

        (uint64 cancelId,) = _measureQueueFee(40);
        vm.prank(guardian);
        uint256 cancelG0 = gasleft();
        router.cancelAction(cancelId);
        uint256 cancelGas = cancelG0 - gasleft();

        vm.warp(block.timestamp + TIMELOCK + 1);

        uint256 execFirst = _measureExecute(ids[0]);
        uint256 execWarm = _measureExecute(ids[1]);
        uint256 batchExecTotal = execFirst + execWarm;
        for (uint256 i = 2; i < 5; ++i) {
            batchExecTotal += _measureExecute(ids[i]);
        }

        vm.prank(guardian);
        uint256 pauseG0 = gasleft();
        router.pauseRoute(RouteKind.AxelarIts);
        uint256 pauseColdGas = pauseG0 - gasleft();

        vm.prank(guardian);
        uint256 lowerG0 = gasleft();
        router.lowerTokenFlowLimit(address(usdc), FLOW_LIMIT / 2);
        uint256 lowerLimitGas = lowerG0 - gasleft();

        console2.log("gov.queue.cold", preGrowthQueueCold);
        console2.log("gov.queue.warm", postGrowthQueueWarm);
        console2.log("gov.queue.batch5", batchQueueTotal);
        console2.log("gov.execute.cold", execFirst);
        console2.log("gov.execute.warm", execWarm);
        console2.log("gov.execute.batch5", batchExecTotal);
        console2.log("gov.cancel.warm", cancelGas);
        console2.log("gov.emergency.pauseCold", pauseColdGas);
        console2.log("gov.emergency.lowerLimit", lowerLimitGas);

        assertLt(postGrowthQueueWarm, preGrowthQueueCold);
        assertLt(execWarm, execFirst);
        assertLe(preGrowthQueueCold, _ceiling(BASELINE_QUEUE_COLD, TOLERANCE_STANDARD_BPS));
        assertLe(postGrowthQueueWarm, _ceiling(BASELINE_QUEUE_WARM, TOLERANCE_STANDARD_BPS));
        assertLe(batchQueueTotal, _ceiling(BASELINE_BATCH5_QUEUE, TOLERANCE_STANDARD_BPS));
        assertLe(execFirst, _ceiling(BASELINE_EXECUTE_COLD, TOLERANCE_COMPACT_BPS));
        assertLe(execWarm, _ceiling(BASELINE_EXECUTE_WARM, TOLERANCE_COMPACT_BPS));
        assertLe(batchExecTotal, _ceiling(BASELINE_BATCH5_EXECUTE, TOLERANCE_COMPACT_BPS));
        assertLe(cancelGas, _ceiling(BASELINE_CANCEL_WARM, TOLERANCE_COMPACT_BPS));
        assertLe(pauseColdGas, _ceiling(BASELINE_EMERGENCY_PAUSE_COLD, TOLERANCE_STANDARD_BPS));
        assertLe(lowerLimitGas, _ceiling(BASELINE_EMERGENCY_LOWER_LIMIT, TOLERANCE_COMPACT_BPS));

        uint256 growthDrift = postGrowthQueueWarm > preGrowthQueueWarm
            ? postGrowthQueueWarm - preGrowthQueueWarm
            : preGrowthQueueWarm - postGrowthQueueWarm;
        assertLe(growthDrift, MAX_STATE_GROWTH_DRIFT_GAS);
    }

    function test_claimParkingAndSettlementGasBudgetsNormalVsHostile() public {
        // 1. Cold recipient direct payout when router holds zero parked claims.
        Origin memory oCold = _origin(1, 10);
        vm.prank(railReceiver);
        uint256 gCold0 = gasleft();
        uint64 cCold = router.bridgeIn(RouteKind.Cctp, address(usdc), 100e6, coldRecipient, oCold);
        uint256 normalColdGas = gCold0 - gasleft();
        assertEq(cCold, 0);

        // 2. First-ever parked claim (`_claimCount` 0 -> 1, router USDC escrow 0 -> 100e6).
        Origin memory oParkCold = _origin(2, 10);
        vm.prank(railReceiver);
        uint256 gParkCold0 = gasleft();
        uint64 firstClaimId =
            router.bridgeIn(RouteKind.Cctp, address(usdc), 100e6, frozenRecipient, oParkCold);
        uint256 parkFrozenColdGas = gParkCold0 - gasleft();
        assertEq(firstClaimId, 1);

        // 3. Warm warmRecipient's ERC20 balance slot once, then measure pre-growth warm payout.
        vm.prank(railReceiver);
        router.bridgeIn(RouteKind.Cctp, address(usdc), 10e6, warmRecipient, _origin(3, 10));

        Origin memory oWarmPre = _origin(4, 10);
        vm.prank(railReceiver);
        uint256 gWarmPre0 = gasleft();
        uint64 cWarmPre = router.bridgeIn(RouteKind.Cctp, address(usdc), 100e6, warmRecipient, oWarmPre);
        uint256 normalWarmPreGas = gWarmPre0 - gasleft();
        assertEq(cWarmPre, 0);

        // 4. Grow state to 128 actions, 128 replay entries and 129 parked claims.
        _seedStateGrowth();

        // 5. Post-growth warm normal payout vs hostile parking modes.
        Origin memory oWarmPost = _origin(500, 20);
        vm.prank(railReceiver);
        uint256 gWarmPost0 = gasleft();
        router.bridgeIn(RouteKind.Cctp, address(usdc), 100e6, warmRecipient, oWarmPost);
        uint256 normalWarmPostGas = gWarmPost0 - gasleft();

        Origin memory oParkWarm = _origin(501, 20);
        vm.prank(railReceiver);
        uint256 gParkWarm0 = gasleft();
        uint64 frozenClaimId =
            router.bridgeIn(RouteKind.Cctp, address(usdc), 100e6, frozenRecipient, oParkWarm);
        uint256 parkFrozenWarmGas = gParkWarm0 - gasleft();

        usdc.setSilentRefusal(true);
        Origin memory oSilent = _origin(502, 20);
        vm.prank(railReceiver);
        uint256 gSilent0 = gasleft();
        uint64 silentClaimId = router.bridgeIn(RouteKind.Cctp, address(usdc), 100e6, coldRecipient, oSilent);
        uint256 parkSilentFalseGas = gSilent0 - gasleft();
        usdc.setSilentRefusal(false);

        Origin memory oHostile = _origin(503, 20);
        vm.prank(railReceiver);
        uint256 gHostile0 = gasleft();
        uint64 hostileClaimId =
            router.bridgeIn(RouteKind.Cctp, address(hostileToken), 100e6, hostileHookRecipient, oHostile);
        uint256 parkHostileHookGas = gHostile0 - gasleft();

        _assertParkingAndSettlementBudgets(
            normalColdGas,
            normalWarmPreGas,
            normalWarmPostGas,
            parkFrozenColdGas,
            parkFrozenWarmGas,
            parkSilentFalseGas,
            parkHostileHookGas,
            frozenClaimId,
            silentClaimId,
            hostileClaimId
        );
    }

    function _assertParkingAndSettlementBudgets(
        uint256 normalColdGas,
        uint256 normalWarmPreGas,
        uint256 normalWarmPostGas,
        uint256 parkFrozenColdGas,
        uint256 parkFrozenWarmGas,
        uint256 parkSilentFalseGas,
        uint256 parkHostileHookGas,
        uint64 frozenClaimId,
        uint64 silentClaimId,
        uint64 hostileClaimId
    ) internal {
        vm.expectRevert(RecipientNotReady.selector);
        uint256 gFailSettle0 = gasleft();
        router.settleClaim(frozenClaimId);
        uint256 settleHostileRevertGas = gFailSettle0 - gasleft();

        address brandNewRecipient = makeAddr("brandNewRecipient");
        usdc.setSilentRefusal(true);
        vm.prank(railReceiver);
        uint64 coldSettleId =
            router.bridgeIn(RouteKind.Cctp, address(usdc), 100e6, brandNewRecipient, _origin(600, 30));
        usdc.setSilentRefusal(false);

        uint256 gSettleCold0 = gasleft();
        router.settleClaim(coldSettleId);
        uint256 settleColdGas = gSettleCold0 - gasleft();

        uint256 gSettleWarm0 = gasleft();
        router.settleClaim(silentClaimId);
        uint256 settleWarmGas = gSettleWarm0 - gasleft();

        hostileToken.setHostileProfile(hostileHookRecipient, 0, false);
        router.settleClaim(hostileClaimId);
        assertTrue(router.pendingClaim(hostileClaimId).settled);

        assertLt(normalWarmPostGas, normalColdGas);
        assertLt(parkFrozenWarmGas, parkFrozenColdGas);
        assertLt(settleWarmGas, settleColdGas);
        assertLe(normalColdGas, _ceiling(BASELINE_BRIDGE_IN_NORMAL_COLD, TOLERANCE_STANDARD_BPS));
        assertLe(normalWarmPostGas, _ceiling(BASELINE_BRIDGE_IN_NORMAL_WARM, TOLERANCE_STANDARD_BPS));
        assertLe(parkFrozenColdGas, _ceiling(BASELINE_PARK_FROZEN_COLD, TOLERANCE_STANDARD_BPS));
        assertLe(parkFrozenWarmGas, _ceiling(BASELINE_PARK_FROZEN_WARM, TOLERANCE_STANDARD_BPS));
        assertLe(parkSilentFalseGas, _ceiling(BASELINE_PARK_SILENT_FALSE, TOLERANCE_STANDARD_BPS));
        assertLe(parkHostileHookGas, _ceiling(BASELINE_PARK_HOSTILE_HOOK, TOLERANCE_STANDARD_BPS));
        assertLe(settleColdGas, _ceiling(BASELINE_SETTLE_NORMAL_COLD, TOLERANCE_COMPACT_BPS));
        assertLe(settleWarmGas, _ceiling(BASELINE_SETTLE_NORMAL_WARM, TOLERANCE_COMPACT_BPS));
        assertLe(settleHostileRevertGas, _ceiling(BASELINE_SETTLE_HOSTILE_REVERT, TOLERANCE_COMPACT_BPS));

        uint256 growthDrift = normalWarmPostGas > normalWarmPreGas
            ? normalWarmPostGas - normalWarmPreGas
            : normalWarmPreGas - normalWarmPostGas;
        assertLe(growthDrift, MAX_STATE_GROWTH_DRIFT_GAS);
    }
}
