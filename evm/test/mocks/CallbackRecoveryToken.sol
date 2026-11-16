// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";

import {OutboundRequest, TokenLiabilityReport} from "../../src/HyperionTypes.sol";
import {IHyperionRouter} from "../../src/interfaces/IHyperionRouter.sol";

/// @title Hostile callback ERC20 fixture for recovery and dispatch reentrancy tests
contract CallbackRecoveryToken is ERC20 {
    enum AttackMode {
        None,
        ReenterRecovery,
        ReenterBridgeOut,
        ReenterSettleClaim,
        SnapshotDispatchLiability
    }

    address public router;
    AttackMode public mode;
    uint64 public targetId;
    OutboundRequest private _outbound;
    TokenLiabilityReport private _snapshot;
    bool public snapshotCaptured;

    constructor() ERC20("Callback Token", "CBTK") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function armRecoveryReentry(address router_, uint64 recoveryId) external {
        router = router_;
        targetId = recoveryId;
        mode = AttackMode.ReenterRecovery;
    }

    function armBridgeOutReentry(address router_, OutboundRequest calldata req) external {
        router = router_;
        _outbound = req;
        mode = AttackMode.ReenterBridgeOut;
    }

    function armSettleClaimReentry(address router_, uint64 claimId) external {
        router = router_;
        targetId = claimId;
        mode = AttackMode.ReenterSettleClaim;
    }

    function armDispatchSnapshot(address router_) external {
        router = router_;
        mode = AttackMode.SnapshotDispatchLiability;
        snapshotCaptured = false;
    }

    function disarm() external {
        mode = AttackMode.None;
    }

    function capturedSnapshot() external view returns (TokenLiabilityReport memory) {
        return _snapshot;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        AttackMode active = mode;
        if (active != AttackMode.None) {
            if (active == AttackMode.SnapshotDispatchLiability) {
                if (!snapshotCaptured && msg.sender == router) {
                    snapshotCaptured = true;
                    _snapshot = IHyperionRouter(router).tokenLiabilityReport(address(this));
                }
            } else {
                mode = AttackMode.None;
                if (active == AttackMode.ReenterRecovery) {
                    IHyperionRouter(router).executeTokenRecovery(targetId);
                } else if (active == AttackMode.ReenterBridgeOut) {
                    IHyperionRouter(router).bridgeOut(_outbound);
                } else if (active == AttackMode.ReenterSettleClaim) {
                    IHyperionRouter(router).settleClaim(targetId);
                }
            }
        }
        return super.transfer(to, value);
    }
}
