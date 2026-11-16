// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";

import {CreditRefundDisabled, NoRefundCredit, RefundFailed, ZeroAddress} from "../../src/HyperionErrors.sol";
import {OutboundRequest, RefundMode} from "../../src/HyperionTypes.sol";
import {IHyperionRouter} from "../../src/interfaces/IHyperionRouter.sol";
import {Fixture} from "../Fixture.sol";

/// @notice Contract sender that can toggle whether it accepts native currency transfers.
contract CreditRefundSender {
    bool public acceptsEth;

    receive() external payable {
        require(acceptsEth, "eth refused");
    }

    function setAcceptsEth(bool on) external {
        acceptsEth = on;
    }

    function approveToken(address token, address spender, uint256 amount) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        require(ok, "approve");
    }

    function setDefaultMode(address router, RefundMode mode) external {
        IHyperionRouter(router).setSenderRefundMode(mode);
    }

    function sendDefault(address router, OutboundRequest calldata request) external payable returns (uint64) {
        return IHyperionRouter(router).bridgeOut{value: msg.value}(request);
    }

    function sendWithMode(address router, OutboundRequest calldata request, RefundMode mode)
        external
        payable
        returns (uint64)
    {
        return IHyperionRouter(router).bridgeOutWithRefundMode{value: msg.value}(request, mode);
    }

    function claimSelf(address router) external returns (uint256) {
        return IHyperionRouter(router).withdrawNativeRefund();
    }

    function claimTo(address router, address payable recipient) external returns (uint256) {
        return IHyperionRouter(router).withdrawNativeRefundTo(recipient);
    }
}

/// @notice Hostile refund recipient that tries to reenter dispatch and double-withdraw credits.
contract ReentrantRefundRecipient {
    enum Mode {
        None,
        ReenterDispatchAndRevert,
        ReenterWithdrawSwallow,
        ReenterWithdrawBubble
    }

    address public router;
    OutboundRequest private _savedReq;
    Mode public mode;
    bytes4 public capturedSelector;

    constructor(address router_) {
        router = router_;
    }

    function approveToken(address token, uint256 amount) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", router, amount));
        require(ok, "approve");
    }

    function configure(Mode mode_, OutboundRequest calldata req) external {
        mode = mode_;
        _savedReq = req;
    }

    function sendCredit(OutboundRequest calldata req) external payable returns (uint64) {
        RefundMode mode_ = RefundMode.CreditOnFailure;
        return IHyperionRouter(router).bridgeOutWithRefundMode{value: msg.value}(req, mode_);
    }

    function withdrawCredit() external returns (uint256) {
        return IHyperionRouter(router).withdrawNativeRefund();
    }

    receive() external payable {
        if (mode == Mode.ReenterDispatchAndRevert) {
            IHyperionRouter(router).bridgeOutWithRefundMode(_savedReq, RefundMode.CreditOnFailure);
        } else if (mode == Mode.ReenterWithdrawSwallow) {
            mode = Mode.None;
            (bool ok, bytes memory ret) =
                router.call(abi.encodeCall(IHyperionRouter.withdrawNativeRefund, ()));
            require(!ok, "expected reentrancy guard");
            if (ret.length >= 4) capturedSelector = bytes4(ret);
        } else if (mode == Mode.ReenterWithdrawBubble) {
            IHyperionRouter(router).withdrawNativeRefund();
        }
    }
}

/// @title Opt-in native-refund failure credit recovery tests
contract NativeRefundRecoveryTest is Fixture {
    CreditRefundSender internal senderWallet;

    function setUp() public override {
        super.setUp();
        senderWallet = new CreditRefundSender();
        usdc.mint(address(senderWallet), 1_000_000e6);
        senderWallet.approveToken(address(usdc), address(router), type(uint256).max);
    }

    function test_credit_refund_mode_is_gated_until_enabled_by_timelock() public {
        assertFalse(router.creditRefundEnabled());
        cctpRail.setRefund(0.1 ether);
        vm.deal(address(this), 1 ether);

        vm.expectRevert(CreditRefundDisabled.selector);
        senderWallet.sendWithMode{value: 0.3 ether}(
            address(router), _usdcRequest(1000e6), RefundMode.CreditOnFailure
        );

        vm.expectRevert(CreditRefundDisabled.selector);
        senderWallet.setDefaultMode(address(router), RefundMode.CreditOnFailure);
    }

    function test_only_original_refund_beneficiary_can_withdraw_recorded_credit() public {
        _setCreditRefundEnabled(true);
        cctpRail.setRefund(0.2 ether);
        vm.deal(address(this), 2 ether);

        vm.expectEmit(true, true, false, true, address(router));
        emit IHyperionRouter.NativeRefundCredited(address(senderWallet), 1, 0.2 ether);
        uint64 nonce = senderWallet.sendWithMode{value: 0.5 ether}(
            address(router), _usdcRequest(1000e6), RefundMode.CreditOnFailure
        );
        assertEq(nonce, 1);
        assertEq(router.nativeRefundCredit(address(senderWallet)), 0.2 ether);
        assertEq(router.totalNativeRefundCredits(), 0.2 ether);
        assertEq(usdc.balanceOf(address(cctpRail)), 999e6);

        // Neither stranger, admin, guardian, nor alice can touch senderWallet's credit.
        address[4] memory unauthorizedCallers = [stranger, admin, guardian, alice];
        for (uint256 i = 0; i < unauthorizedCallers.length; ++i) {
            vm.prank(unauthorizedCallers[i]);
            vm.expectRevert(NoRefundCredit.selector);
            router.withdrawNativeRefund();

            vm.prank(unauthorizedCallers[i]);
            vm.expectRevert(NoRefundCredit.selector);
            router.withdrawNativeRefundTo(payable(unauthorizedCallers[i]));
        }

        // Zero recipient is rejected.
        vm.expectRevert(ZeroAddress.selector);
        senderWallet.claimTo(address(router), payable(address(0)));

        // Non-payable beneficiary contract can withdraw its credit to its chosen payout address.
        uint256 paid = senderWallet.claimTo(address(router), payable(bob));
        assertEq(paid, 0.2 ether);
        assertEq(bob.balance, 0.2 ether);
        assertEq(router.nativeRefundCredit(address(senderWallet)), 0);
        assertEq(router.totalNativeRefundCredits(), 0);

        // Once accepting ETH directly, beneficiary can also withdraw straight to itself.
        senderWallet.sendWithMode{value: 0.5 ether}(
            address(router), _usdcRequest(1000e6), RefundMode.CreditOnFailure
        );
        senderWallet.setAcceptsEth(true);
        uint256 directPaid = senderWallet.claimSelf(address(router));
        assertEq(directPaid, 0.2 ether);
        assertEq(address(senderWallet).balance, 0.2 ether);
    }

    function test_legacy_reverting_refund_semantics_remain_explicitly_selectable() public {
        _setCreditRefundEnabled(true);
        cctpRail.setRefund(0.15 ether);
        vm.deal(address(this), 2 ether);

        // Default mode remains RevertOnFailure when sender has not opted in.
        vm.expectRevert(RefundFailed.selector);
        senderWallet.sendDefault{value: 0.4 ether}(address(router), _usdcRequest(1000e6));

        // Sender opts into CreditOnFailure as account default, so `bridgeOut` credits on failure.
        senderWallet.setDefaultMode(address(router), RefundMode.CreditOnFailure);
        uint64 creditedNonce =
            senderWallet.sendDefault{value: 0.4 ether}(address(router), _usdcRequest(1000e6));
        assertEq(creditedNonce, 1);
        assertEq(router.nativeRefundCredit(address(senderWallet)), 0.15 ether);

        // Even with CreditOnFailure as account default, per-call RevertOnFailure explicitly reverts.
        vm.expectRevert(RefundFailed.selector);
        senderWallet.sendWithMode{value: 0.4 ether}(
            address(router), _usdcRequest(1000e6), RefundMode.RevertOnFailure
        );

        // Switching sender default back to RevertOnFailure restores reverting `bridgeOut`.
        senderWallet.setDefaultMode(address(router), RefundMode.RevertOnFailure);
        vm.expectRevert(RefundFailed.selector);
        senderWallet.sendDefault{value: 0.4 ether}(address(router), _usdcRequest(1000e6));
    }

    function test_reentrant_refund_recipients_cannot_duplicate_dispatch_or_withdraw_twice() public {
        _setCreditRefundEnabled(true);
        cctpRail.setRefund(0.2 ether);
        vm.deal(address(this), 3 ether);

        // Park an unrelated 0.2 ether credit for senderWallet so the router holds extra ETH.
        senderWallet.sendWithMode{value: 0.5 ether}(
            address(router), _usdcRequest(1000e6), RefundMode.CreditOnFailure
        );

        ReentrantRefundRecipient hostile = new ReentrantRefundRecipient(address(router));
        usdc.mint(address(hostile), 100_000e6);
        hostile.approveToken(address(usdc), type(uint256).max);

        // 1. Reentering dispatch from inside refund `receive()` fails `nonReentrant` and credits once.
        OutboundRequest memory req = _usdcRequest(1000e6);
        hostile.configure(ReentrantRefundRecipient.Mode.ReenterDispatchAndRevert, req);
        uint64 nonce = hostile.sendCredit{value: 0.5 ether}(req);
        assertEq(nonce, 2);
        assertEq(cctpRail.callCount(), 2);
        assertEq(router.nativeRefundCredit(address(hostile)), 0.2 ether);

        // 2. Bubbling reentrancy during withdrawal reverts the withdrawal cleanly.
        hostile.configure(ReentrantRefundRecipient.Mode.ReenterWithdrawBubble, req);
        vm.expectRevert(RefundFailed.selector);
        hostile.withdrawCredit();
        assertEq(router.nativeRefundCredit(address(hostile)), 0.2 ether);

        // 3. Swallowing reentrancy during withdrawal hits ReentrancyGuard and withdraws only once.
        hostile.configure(ReentrantRefundRecipient.Mode.ReenterWithdrawSwallow, req);
        uint256 withdrawn = hostile.withdrawCredit();
        assertEq(withdrawn, 0.2 ether);
        assertEq(hostile.capturedSelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(address(hostile).balance, 0.2 ether);
        assertEq(router.nativeRefundCredit(address(hostile)), 0);
        assertEq(router.nativeRefundCredit(address(senderWallet)), 0.2 ether);
    }
}
