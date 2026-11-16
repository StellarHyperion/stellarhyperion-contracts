// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ActionKind,
    AdminAction,
    Origin,
    OutboundRequest,
    PendingClaim,
    RouteKind
} from "../../src/HyperionTypes.sol";
import {Fixture} from "../Fixture.sol";

/// @title Stateful reference model parity for the EVM router
/// @notice Compares multi-step generated operation sequences against an independent Solidity
/// reference state machine, checking conserved ERC-20 supply, exact router claim escrow,
/// fixed-recipient claim liabilities, unified wall-clock decay/timelock semantics, and
/// deterministic shrinking of failing sequences.
contract RouterReferenceModelTest is Fixture {
    enum OpKind {
        AdvanceTime,
        AdvanceBlocks,
        SetRecipientFrozen,
        BridgeOut,
        BridgeIn,
        SettleClaim,
        Pause,
        Unpause,
        PauseRoute,
        UnpauseRoute,
        LowerFlowLimit,
        QueueSetFeeBps,
        ExecuteAction,
        CancelAction
    }

    struct ModelOp {
        OpKind kind;
        uint8 actor;
        RouteKind route;
        uint256 amount;
        uint64 idOrNonce;
        bool flag;
    }

    struct ModelWindow {
        uint64 epoch;
        uint256 consumed;
        uint256 prevConsumed;
    }

    struct ModelClaim {
        address recipient;
        uint256 amount;
        bool exists;
        bool settled;
    }

    struct ModelQueued {
        uint16 feeBpsTarget;
        uint64 eta;
        uint64 expiresAt;
        bool exists;
        bool executed;
    }

    struct EvmModelState {
        uint64 timestamp;
        uint64 blockNumber;
        bool paused;
        uint16 feeBps;
        uint64 timelockDelay;
        uint64 flowWindow;
        uint256 tokenFlowLimit;
        uint64 outboundNonce;
        uint64 claimCount;
        uint64 actionCount;
        uint256 aliceBalance;
        uint256 bobBalance;
        uint256 treasuryBalance;
        uint256 routerEscrow;
        uint256 railReceiverBalance;
        bool bobFrozen;
    }

    uint256 internal constant INITIAL_RAIL_POOL = 5_000_000e6;

    EvmModelState internal model;
    mapping(RouteKind route => bool paused) internal modelRoutePaused;
    mapping(RouteKind route => uint256 balance) internal modelAdapterBalance;
    mapping(RouteKind route => ModelWindow window) internal modelWindows;
    mapping(bytes32 replayKey => bool seen) internal modelProcessed;
    mapping(uint64 claimId => ModelClaim claim) internal modelClaims;
    mapping(uint64 actionId => ModelQueued action) internal modelActions;

    function setUp() public override {
        super.setUp();
        usdc.mint(railReceiver, INITIAL_RAIL_POOL);
        vm.prank(railReceiver);
        usdc.approve(address(router), type(uint256).max);
        _syncInitialModel();
    }

    function test_generated_sequences_match_evm_router_and_preserve_conservation() public {
        uint256 totalParked = 0;
        uint256 totalSettled = 0;

        for (uint256 seed = 1; seed <= 16; ++seed) {
            uint256 snap = vm.snapshotState();
            _resetMappings();
            _syncInitialModel();

            ModelOp[] memory seq = _generateSequence(seed * 137 + 11, 36);
            for (uint256 i = 0; i < seq.length; ++i) {
                bool sutOk = _stepSut(seq[i]);
                bool modOk = _stepModel(seq[i], false);
                assertEq(sutOk, modOk, "step outcome diverged");
                _assertFullParity();
            }

            totalParked += model.claimCount;
            for (uint64 cid = 1; cid <= model.claimCount; ++cid) {
                if (modelClaims[cid].settled) ++totalSettled;
            }
            vm.revertToState(snap);
        }

        assertGt(totalParked, 0);
        assertGt(totalSettled, 0);
    }

    function test_evm_timestamp_drives_both_flow_decay_and_timelock_while_blocks_do_neither() public {
        uint64 baseActionId = router.actionCount() + 1;

        ModelOp[] memory seq = new ModelOp[](6);
        seq[0] = ModelOp(OpKind.BridgeOut, 0, RouteKind.Cctp, 400_000e6, 0, false);
        seq[1] = ModelOp(OpKind.QueueSetFeeBps, 0, RouteKind.Cctp, 25, 0, false);
        seq[2] = ModelOp(OpKind.AdvanceBlocks, 0, RouteKind.Cctp, 500, 0, false);
        seq[3] = ModelOp(OpKind.ExecuteAction, 0, RouteKind.Cctp, 0, baseActionId, false);
        seq[4] = ModelOp(OpKind.AdvanceTime, 0, RouteKind.Cctp, TIMELOCK + 1, 0, false);
        seq[5] = ModelOp(OpKind.ExecuteAction, 0, RouteKind.Cctp, 0, baseActionId, false);

        for (uint256 i = 0; i < seq.length; ++i) {
            bool sutOk = _stepSut(seq[i]);
            bool modOk = _stepModel(seq[i], false);
            assertEq(sutOk, modOk);
            _assertFullParity();

            if (i == 3) {
                assertFalse(sutOk, "block roll alone must not mature timelock");
                uint256 usedNet = 400_000e6 - ((uint256(400_000e6) * uint256(FEE_BPS)) / 10_000);
                assertEq(router.flowAvailable(address(usdc), RouteKind.Cctp), FLOW_LIMIT - usedNet);
            }
            if (i == 5) {
                assertTrue(sutOk, "timestamp warp matures timelock");
                assertEq(router.feeBps(), 25);
                // 2 days + 1s > 2 * 1h flow windows: EVM flow headroom decayed to 100% as well.
                assertEq(router.flowAvailable(address(usdc), RouteKind.Cctp), FLOW_LIMIT);
            }
        }
    }

    function test_failing_evm_sequence_shrinks_to_minimal_reproducible_trace() public {
        ModelOp[] memory noisy = new ModelOp[](8);
        noisy[0] = ModelOp(OpKind.AdvanceBlocks, 0, RouteKind.Cctp, 5, 0, false);
        noisy[1] = ModelOp(OpKind.BridgeOut, 0, RouteKind.AxelarIts, 10_000e6, 0, false);
        noisy[2] = ModelOp(OpKind.PauseRoute, 1, RouteKind.Cctp, 0, 0, false);
        noisy[3] = ModelOp(OpKind.AdvanceTime, 0, RouteKind.Cctp, 30, 0, false);
        noisy[4] = ModelOp(OpKind.BridgeIn, 0, RouteKind.Cctp, 1000e6, 77, false);
        noisy[5] = ModelOp(OpKind.BridgeOut, 0, RouteKind.Cctp, 20_000e6, 0, false);
        noisy[6] = ModelOp(OpKind.UnpauseRoute, 1, RouteKind.Cctp, 0, 0, false);
        noisy[7] = ModelOp(OpKind.AdvanceBlocks, 0, RouteKind.Cctp, 2, 0, false);

        ModelOp[] memory minimal = _shrinkIgnoreRoutePauseDivergence(noisy);
        assertEq(minimal.length, 2, "must shrink 8-step sequence down to [PauseRoute, BridgeOut]");
        assertEq(uint8(minimal[0].kind), uint8(OpKind.PauseRoute));
        assertEq(uint8(minimal[1].kind), uint8(OpKind.BridgeOut));
    }

    // -------------------------------------------------------------------------------------
    // Reference State Machine & SUT Execution
    // -------------------------------------------------------------------------------------

    function _syncInitialModel() internal {
        model = EvmModelState({
            timestamp: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            paused: router.paused(),
            feeBps: router.feeBps(),
            timelockDelay: router.timelockDelay(),
            flowWindow: router.flowWindow(),
            tokenFlowLimit: FLOW_LIMIT,
            outboundNonce: router.outboundNonce(),
            claimCount: router.claimCount(),
            actionCount: router.actionCount(),
            aliceBalance: usdc.balanceOf(alice),
            bobBalance: usdc.balanceOf(bob),
            treasuryBalance: usdc.balanceOf(treasury),
            routerEscrow: usdc.balanceOf(address(router)),
            railReceiverBalance: usdc.balanceOf(railReceiver),
            bobFrozen: false
        });
    }

    function _resetMappings() internal {
        for (uint8 r = 0; r < 4; ++r) {
            RouteKind rk = RouteKind(r);
            modelRoutePaused[rk] = false;
            modelAdapterBalance[rk] = 0;
            delete modelWindows[rk];
        }
        for (uint64 n = 1; n <= 50; ++n) {
            bytes32 key = keccak256(abi.encode(RouteKind.Cctp, bytes32(uint256(n))));
            modelProcessed[key] = false;
            delete modelClaims[n];
        }
        uint64 baseAct = router.actionCount();
        for (uint64 a = baseAct; a <= baseAct + 50; ++a) {
            delete modelActions[a];
        }
    }

    function _actorAddr(uint8 code) internal view returns (address) {
        if (code == 0) return admin;
        if (code == 1) return guardian;
        return stranger;
    }

    function _stepSut(ModelOp memory op) internal returns (bool) {
        if (op.kind == OpKind.AdvanceTime) {
            vm.warp(block.timestamp + op.amount);
            return true;
        }
        if (op.kind == OpKind.AdvanceBlocks) {
            vm.roll(block.number + op.amount);
            return true;
        }
        if (op.kind == OpKind.SetRecipientFrozen) {
            usdc.setBlocked(bob, op.flag);
            return true;
        }
        if (op.kind == OpKind.BridgeOut) {
            OutboundRequest memory req = _request(op.amount, op.route);
            req.token = address(usdc);
            req.destination = _dest(op.flag ? M_ADDR : G_ADDR);
            vm.prank(alice);
            try router.bridgeOut(req) returns (uint64) {
                return true;
            } catch {
                return false;
            }
        }
        if (op.kind == OpKind.BridgeIn) {
            Origin memory orig = Origin({
                chain: STELLAR, nonce: op.idOrNonce, messageId: bytes32(uint256(op.idOrNonce)), sender: G_KEY
            });
            vm.prank(op.flag ? stranger : railReceiver);
            try router.bridgeIn(RouteKind.Cctp, address(usdc), op.amount, bob, orig) returns (uint64) {
                return true;
            } catch {
                return false;
            }
        }
        return _stepSutGovernance(op);
    }

    function _stepSutGovernance(ModelOp memory op) internal returns (bool) {
        address caller = _actorAddr(op.actor);
        if (op.kind == OpKind.SettleClaim) {
            vm.prank(stranger);
            try router.settleClaim(op.idOrNonce) {
                return true;
            } catch {
                return false;
            }
        }
        if (op.kind == OpKind.Pause) {
            vm.prank(caller);
            try router.pause() {
                return true;
            } catch {
                return false;
            }
        }
        if (op.kind == OpKind.Unpause) {
            vm.prank(caller);
            try router.unpause() {
                return true;
            } catch {
                return false;
            }
        }
        if (op.kind == OpKind.PauseRoute) {
            vm.prank(caller);
            try router.pauseRoute(op.route) {
                return true;
            } catch {
                return false;
            }
        }
        if (op.kind == OpKind.UnpauseRoute) {
            vm.prank(caller);
            try router.unpauseRoute(op.route) {
                return true;
            } catch {
                return false;
            }
        }
        if (op.kind == OpKind.LowerFlowLimit) {
            vm.prank(caller);
            try router.lowerTokenFlowLimit(address(usdc), op.amount) {
                return true;
            } catch {
                return false;
            }
        }
        return _stepSutTimelock(op, caller);
    }

    function _stepSutTimelock(ModelOp memory op, address caller) internal returns (bool) {
        if (op.kind == OpKind.QueueSetFeeBps) {
            AdminAction memory act = _empty(ActionKind.SetFeeBps);
            act.amount = op.amount;
            vm.prank(caller);
            try router.queueAction(act) returns (uint64) {
                return true;
            } catch {
                return false;
            }
        }
        if (op.kind == OpKind.ExecuteAction) {
            vm.prank(caller);
            try router.executeAction(op.idOrNonce) {
                return true;
            } catch {
                return false;
            }
        }
        vm.prank(caller);
        try router.cancelAction(op.idOrNonce) {
            return true;
        } catch {
            return false;
        }
    }

    function _stepModel(ModelOp memory op, bool ignoreRoutePause) internal returns (bool) {
        if (op.kind == OpKind.AdvanceTime) {
            model.timestamp += uint64(op.amount);
            return true;
        }
        if (op.kind == OpKind.AdvanceBlocks) {
            model.blockNumber += uint64(op.amount);
            return true;
        }
        if (op.kind == OpKind.SetRecipientFrozen) {
            model.bobFrozen = op.flag;
            return true;
        }
        if (op.kind == OpKind.BridgeOut) {
            return _modelBridgeOut(op, ignoreRoutePause);
        }
        if (op.kind == OpKind.BridgeIn) {
            return _modelBridgeIn(op);
        }
        return _stepModelGovernance(op);
    }

    function _modelBridgeOut(ModelOp memory op, bool ignoreRoutePause) internal returns (bool) {
        if (model.paused || op.amount == 0) return false;
        if (!ignoreRoutePause && modelRoutePaused[op.route]) return false;
        if (op.flag && op.route == RouteKind.Allbridge) return false;

        uint256 fee = (op.amount * model.feeBps) / 10_000;
        uint256 net = op.amount - fee;
        if (net == 0) return false;

        ModelWindow memory rolled = _rollWindow(modelWindows[op.route], model.timestamp, model.flowWindow);
        uint256 used = _effectiveUsed(modelWindows[op.route], model.timestamp, model.flowWindow);
        if (used + net > model.tokenFlowLimit) return false;

        uint256 gross = fee + net;
        if (model.aliceBalance < gross) return false;

        rolled.consumed += net;
        modelWindows[op.route] = rolled;
        model.aliceBalance -= gross;
        model.treasuryBalance += fee;
        modelAdapterBalance[op.route] += net;
        ++model.outboundNonce;
        return true;
    }

    function _modelBridgeIn(ModelOp memory op) internal returns (bool) {
        if (op.flag || op.amount == 0) return false;
        bytes32 rKey = keccak256(abi.encode(RouteKind.Cctp, bytes32(uint256(op.idOrNonce))));
        if (modelProcessed[rKey]) return false;
        if (model.railReceiverBalance < op.amount) return false;

        modelProcessed[rKey] = true;
        model.railReceiverBalance -= op.amount;
        if (!model.bobFrozen) {
            model.bobBalance += op.amount;
            return true;
        }

        uint64 cid = ++model.claimCount;
        model.routerEscrow += op.amount;
        modelClaims[cid] = ModelClaim({recipient: bob, amount: op.amount, exists: true, settled: false});
        return true;
    }

    function _stepModelGovernance(ModelOp memory op) internal returns (bool) {
        bool isPriv = op.actor == 0 || op.actor == 1;
        if (op.kind == OpKind.SettleClaim) {
            ModelClaim storage c = modelClaims[op.idOrNonce];
            if (!c.exists || c.settled || model.bobFrozen || model.routerEscrow < c.amount) return false;
            c.settled = true;
            model.routerEscrow -= c.amount;
            model.bobBalance += c.amount;
            return true;
        }
        if (op.kind == OpKind.Pause) {
            if (!isPriv || model.paused) return false;
            model.paused = true;
            return true;
        }
        if (op.kind == OpKind.Unpause) {
            if (op.actor != 0 || !model.paused) return false;
            model.paused = false;
            return true;
        }
        if (op.kind == OpKind.PauseRoute) {
            if (!isPriv) return false;
            modelRoutePaused[op.route] = true;
            return true;
        }
        if (op.kind == OpKind.UnpauseRoute) {
            if (!isPriv) return false;
            modelRoutePaused[op.route] = false;
            return true;
        }
        if (op.kind == OpKind.LowerFlowLimit) {
            if (!isPriv || op.amount >= model.tokenFlowLimit) return false;
            model.tokenFlowLimit = op.amount;
            return true;
        }
        return _stepModelTimelock(op, isPriv);
    }

    function _stepModelTimelock(ModelOp memory op, bool isPriv) internal returns (bool) {
        if (op.kind == OpKind.QueueSetFeeBps) {
            if (op.actor != 0 || op.amount > 100) return false;
            uint64 id = ++model.actionCount;
            uint64 eta = model.timestamp + model.timelockDelay;
            modelActions[id] = ModelQueued({
                feeBpsTarget: uint16(op.amount),
                eta: eta,
                expiresAt: eta + router.GRACE_PERIOD(),
                exists: true,
                executed: false
            });
            return true;
        }
        if (op.kind == OpKind.ExecuteAction) {
            ModelQueued storage q = modelActions[op.idOrNonce];
            if (op.actor != 0 || !q.exists || q.executed) return false;
            if (model.timestamp < q.eta || model.timestamp > q.expiresAt) return false;
            q.executed = true;
            model.feeBps = q.feeBpsTarget;
            return true;
        }
        ModelQueued storage cAct = modelActions[op.idOrNonce];
        if (!isPriv || !cAct.exists || cAct.executed) return false;
        delete modelActions[op.idOrNonce];
        return true;
    }

    function _rollWindow(ModelWindow memory w, uint64 ts, uint64 win)
        internal
        pure
        returns (ModelWindow memory)
    {
        uint64 ep = ts / win;
        if (ep == w.epoch) return w;
        if (ep == w.epoch + 1) return ModelWindow({epoch: ep, consumed: 0, prevConsumed: w.consumed});
        return ModelWindow({epoch: ep, consumed: 0, prevConsumed: 0});
    }

    function _effectiveUsed(ModelWindow memory w, uint64 ts, uint64 win) internal pure returns (uint256) {
        ModelWindow memory rolled = _rollWindow(w, ts, win);
        uint256 rem = win - (ts % win);
        return (rolled.prevConsumed * rem) / win + rolled.consumed;
    }

    function _modelFlowAvailable(RouteKind route) internal view returns (uint256) {
        uint256 used = _effectiveUsed(modelWindows[route], model.timestamp, model.flowWindow);
        return used >= model.tokenFlowLimit ? 0 : model.tokenFlowLimit - used;
    }

    function _assertFullParity() internal view {
        assertEq(usdc.balanceOf(alice), model.aliceBalance, "alice balance");
        assertEq(usdc.balanceOf(bob), model.bobBalance, "bob balance");
        assertEq(usdc.balanceOf(treasury), model.treasuryBalance, "treasury balance");
        assertEq(usdc.balanceOf(address(router)), model.routerEscrow, "router escrow");
        assertEq(usdc.balanceOf(railReceiver), model.railReceiverBalance, "railReceiver balance");
        assertEq(usdc.balanceOf(stranger), 0, "stranger must never receive funds");

        uint256 adaptersSum = usdc.balanceOf(address(cctpRail)) + usdc.balanceOf(address(itsRail))
            + usdc.balanceOf(address(gmpRail)) + usdc.balanceOf(address(allbridgeRail));
        uint256 accounted = model.aliceBalance + model.bobBalance + model.treasuryBalance + model.routerEscrow
            + model.railReceiverBalance + adaptersSum;
        assertEq(accounted, usdc.totalSupply(), "ERC-20 supply conservation");

        uint256 unsettledSum = 0;
        for (uint64 cid = 1; cid <= model.claimCount; ++cid) {
            PendingClaim memory sutClaim = router.pendingClaim(cid);
            ModelClaim memory modClaim = modelClaims[cid];
            assertEq(sutClaim.recipient, bob, "fixed claim recipient");
            assertEq(sutClaim.amount, modClaim.amount, "fixed claim amount");
            assertEq(sutClaim.settled, modClaim.settled, "claim settled flag");
            if (!modClaim.settled) unsettledSum += modClaim.amount;
        }
        assertEq(model.routerEscrow, unsettledSum, "escrow == unsettled claims");
        assertEq(router.outboundNonce(), model.outboundNonce, "outbound nonce");
        assertEq(router.claimCount(), model.claimCount, "claim count");
        assertEq(
            router.flowAvailable(address(usdc), RouteKind.Cctp),
            _modelFlowAvailable(RouteKind.Cctp),
            "CCTP flow available"
        );
    }

    function _generateSequence(uint256 seed, uint256 len) internal view returns (ModelOp[] memory ops) {
        ops = new ModelOp[](len);
        uint64 baseAct = router.actionCount();
        uint64 nextNonce = 1;
        uint64 approxClaims = 1;
        uint64 approxActs = baseAct + 1;
        uint256 state = seed;

        for (uint256 i = 0; i < len; ++i) {
            state = uint256(keccak256(abi.encode(state, i)));
            ops[i] = _buildRandomOp(state, baseAct, nextNonce, approxClaims, approxActs);
            if (ops[i].kind == OpKind.BridgeIn && ops[i].idOrNonce == nextNonce) {
                ++nextNonce;
                ++approxClaims;
            } else if (ops[i].kind == OpKind.QueueSetFeeBps && ops[i].actor == 0) {
                ++approxActs;
            }
        }
    }

    function _buildRandomOp(
        uint256 r,
        uint64 baseAct,
        uint64 nextNonce,
        uint64 approxClaims,
        uint64 approxActs
    ) internal pure returns (ModelOp memory) {
        uint256 bucket = r % 100;
        RouteKind route = RouteKind((r >> 8) % 4);
        uint8 actor = uint8((r >> 16) % 3);

        if (bucket < 14) {
            if ((r >> 24) % 3 == 0) {
                return ModelOp(OpKind.AdvanceBlocks, 0, route, 1 + ((r >> 32) % 50), 0, false);
            }
            uint256 secs = ((r >> 32) % 2 == 0) ? 1800 : (TIMELOCK + 5);
            return ModelOp(OpKind.AdvanceTime, 0, route, secs, 0, false);
        }
        if (bucket < 26) {
            return ModelOp(OpKind.SetRecipientFrozen, 0, route, 0, 0, ((r >> 24) % 2 == 0));
        }
        if (bucket < 48) {
            uint256 amt = ((r >> 24) % 8 == 0) ? 0 : (1000e6 * (1 + ((r >> 32) % 120)));
            return ModelOp(OpKind.BridgeOut, 0, route, amt, 0, ((r >> 40) % 4 == 0));
        }
        if (bucket < 68) {
            bool replay = nextNonce > 1 && ((r >> 24) % 4 == 0);
            uint64 nonce = replay ? uint64(1 + ((r >> 32) % (nextNonce - 1))) : nextNonce;
            uint256 amt = ((r >> 40) % 7 == 0) ? 0 : 25_000e6;
            return ModelOp(OpKind.BridgeIn, 0, RouteKind.Cctp, amt, nonce, ((r >> 48) % 6 == 0));
        }
        if (bucket < 80) {
            uint64 cap = approxClaims > 3 ? 3 : approxClaims;
            uint64 cid = uint64(1 + ((r >> 24) % cap));
            return ModelOp(OpKind.SettleClaim, actor, route, 0, cid, false);
        }
        if (bucket < 90) {
            uint256 sub = (r >> 24) % 5;
            if (sub == 0) return ModelOp(OpKind.Pause, actor, route, 0, 0, false);
            if (sub == 1) return ModelOp(OpKind.Unpause, actor, route, 0, 0, false);
            if (sub == 2) return ModelOp(OpKind.PauseRoute, actor, route, 0, 0, false);
            if (sub == 3) return ModelOp(OpKind.UnpauseRoute, actor, route, 0, 0, false);
            return ModelOp(OpKind.LowerFlowLimit, actor, route, 800_000e6, 0, false);
        }
        uint256 admSub = (r >> 24) % 3;
        if (admSub == 0) {
            uint256 targetBps = ((r >> 32) % 5 == 0) ? 150 : 20;
            return ModelOp(OpKind.QueueSetFeeBps, actor, RouteKind.Cctp, targetBps, 0, false);
        }
        uint64 span = approxActs > baseAct ? (approxActs - baseAct) : 1;
        uint64 aid = baseAct + 1 + uint64((r >> 32) % span);
        if (admSub == 1) return ModelOp(OpKind.ExecuteAction, actor, RouteKind.Cctp, 0, aid, false);
        return ModelOp(OpKind.CancelAction, actor, RouteKind.Cctp, 0, aid, false);
    }

    function _shrinkIgnoreRoutePauseDivergence(ModelOp[] memory seq)
        internal
        returns (ModelOp[] memory current)
    {
        (bool failed, uint256 firstIdx) = _runsToDivergence(seq);
        require(failed, "expected initial sequence to diverge");
        current = _slicePrefix(seq, firstIdx + 1);

        bool reduced = true;
        while (reduced && current.length > 1) {
            reduced = false;
            for (uint256 omit = 0; omit < current.length; ++omit) {
                ModelOp[] memory candidate = _withoutIndex(current, omit);
                (bool candFailed, uint256 candIdx) = _runsToDivergence(candidate);
                if (candFailed) {
                    current = _slicePrefix(candidate, candIdx + 1);
                    reduced = true;
                    break;
                }
            }
        }
    }

    function _runsToDivergence(ModelOp[] memory candidate) internal returns (bool, uint256) {
        uint256 snap = vm.snapshotState();
        _resetMappings();
        _syncInitialModel();
        for (uint256 i = 0; i < candidate.length; ++i) {
            bool sutOk = _stepSut(candidate[i]);
            bool modOk = _stepModel(candidate[i], true);
            if (sutOk != modOk) {
                vm.revertToState(snap);
                return (true, i);
            }
        }
        vm.revertToState(snap);
        return (false, 0);
    }

    function _slicePrefix(ModelOp[] memory arr, uint256 len) internal pure returns (ModelOp[] memory out) {
        out = new ModelOp[](len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = arr[i];
        }
    }

    function _withoutIndex(ModelOp[] memory arr, uint256 omit) internal pure returns (ModelOp[] memory out) {
        out = new ModelOp[](arr.length - 1);
        uint256 dst = 0;
        for (uint256 i = 0; i < arr.length; ++i) {
            if (i != omit) {
                out[dst] = arr[i];
                ++dst;
            }
        }
    }
}
