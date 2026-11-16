// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "openzeppelin/access/Ownable.sol";

import {
    InvalidAmount,
    InvalidDestination,
    InvalidLimit,
    MalformedMessage,
    RailNotConfigured,
    ReplayedMessage,
    TimelockExpired,
    TokenNotMapped,
    Unauthorized,
    UnknownChain,
    ZeroAddress
} from "../../src/HyperionErrors.sol";
import {Destination, RouteKind} from "../../src/HyperionTypes.sol";
import {AxelarItsAdapter} from "../../src/adapters/AxelarItsAdapter.sol";
import {Fixture} from "../Fixture.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockGasService} from "../mocks/MockGasService.sol";
import {MockIts} from "../mocks/MockIts.sol";

contract AxelarTopUpIntentTest is Fixture {
    bytes32 internal constant TOKEN_ID = keccak256("hyperion.its.usdc");
    string internal constant AXELAR_STELLAR = "stellar";
    uint256 internal constant AMOUNT = 1000e6;
    uint64 internal constant NONCE_ONE = 7;
    uint64 internal constant NONCE_TWO = 8;
    bytes32 internal constant SOURCE_TX_ONE = keccak256("evm.outbound.tx.1");
    bytes32 internal constant SOURCE_TX_TWO = keccak256("evm.outbound.tx.2");

    AxelarItsAdapter internal adapter;
    MockIts internal its;
    MockGasService internal gasService;
    bytes internal peerAddress;

    event GasTopUpCapsUpdated(uint256 maxPerCall, uint256 maxPerTransfer);
    event GasTopUpSubmitted(
        bytes32 indexed intentId,
        bytes32 indexed dispatchKey,
        address indexed sender,
        bytes32 txHash,
        uint256 logIndex,
        address refundAddress,
        uint256 paidValue
    );

    function setUp() public override {
        super.setUp();
        peerAddress = bytes(C_ADDR);

        its = new MockIts();
        gasService = new MockGasService();
        adapter = new AxelarItsAdapter(address(router), address(its), address(gasService), admin);

        its.setRegistered(TOKEN_ID, address(usdc));

        vm.startPrank(admin);
        adapter.setPeer(STELLAR, AXELAR_STELLAR, peerAddress);
        adapter.linkToken(address(usdc), TOKEN_ID);
        vm.stopPrank();

        _setRailReceiver(RouteKind.AxelarIts, address(adapter));

        _dispatchTransfer(NONCE_ONE, G_ADDR, AMOUNT);
    }

    function test_sender_bound_top_up_preserves_original_transfer_bindings() public {
        AxelarItsAdapter.OutboundDispatchBinding memory beforeBinding =
            adapter.outboundDispatchOf(STELLAR, NONCE_ONE);
        assertTrue(beforeBinding.recorded);

        AxelarItsAdapter.GasTopUpIntent memory intent = _validIntent();
        bytes32 expectedId = adapter.computeTopUpIntentId(intent);
        bytes32 expectedKey = adapter.dispatchBindingKey(STELLAR, NONCE_ONE);

        vm.deal(alice, 2 ether);
        vm.expectEmit(true, true, true, true, address(adapter));
        emit GasTopUpSubmitted(expectedId, expectedKey, alice, SOURCE_TX_ONE, 3, treasury, 0.25 ether);

        vm.prank(alice);
        bytes32 returnedId = adapter.topUpGasWithIntent{value: 0.25 ether}(intent);

        assertEq(returnedId, expectedId);
        assertTrue(adapter.topUpIntentUsed(expectedId));
        assertEq(adapter.cumulativeGasTopUpOf(expectedKey), 0.25 ether);

        MockGasService.TopUp memory receipt = gasService.lastTopUp();
        assertEq(receipt.txHash, SOURCE_TX_ONE);
        assertEq(receipt.logIndex, 3);
        assertEq(receipt.refundAddress, treasury);
        assertEq(receipt.value, 0.25 ether);

        AxelarItsAdapter.OutboundDispatchBinding memory afterBinding =
            adapter.outboundDispatchOf(STELLAR, NONCE_ONE);
        assertEq(afterBinding.token, beforeBinding.token);
        assertEq(afterBinding.tokenId, beforeBinding.tokenId);
        assertEq(afterBinding.amount, beforeBinding.amount);
        assertEq(afterBinding.recipientStrkeyHash, beforeBinding.recipientStrkeyHash);
        assertEq(afterBinding.noteHash, beforeBinding.noteHash);
    }

    function test_top_up_cannot_alter_recipient_token_or_amount() public {
        vm.deal(alice, 3 ether);

        AxelarItsAdapter.GasTopUpIntent memory wrongRecipient = _validIntent();
        wrongRecipient.recipientStrkey = M_ADDR;
        vm.prank(alice);
        vm.expectRevert(InvalidDestination.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(wrongRecipient);

        MockERC20 fakeToken = new MockERC20("Fake", "FAKE", 6);
        AxelarItsAdapter.GasTopUpIntent memory wrongToken = _validIntent();
        wrongToken.token = address(fakeToken);
        vm.prank(alice);
        vm.expectRevert(TokenNotMapped.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(wrongToken);

        AxelarItsAdapter.GasTopUpIntent memory wrongTokenId = _validIntent();
        wrongTokenId.tokenId = keccak256("other.token.id");
        vm.prank(alice);
        vm.expectRevert(TokenNotMapped.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(wrongTokenId);

        AxelarItsAdapter.GasTopUpIntent memory wrongAmount = _validIntent();
        wrongAmount.originalAmount = AMOUNT + 1;
        vm.prank(alice);
        vm.expectRevert(InvalidAmount.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(wrongAmount);
    }

    function test_wrong_message_or_destination_bindings_are_rejected() public {
        vm.deal(alice, 5 ether);

        AxelarItsAdapter.GasTopUpIntent memory unknownChain = _validIntent();
        unknownChain.destinationChain = "unknown-chain";
        vm.prank(alice);
        vm.expectRevert(UnknownChain.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(unknownChain);

        AxelarItsAdapter.GasTopUpIntent memory wrongAxelarChain = _validIntent();
        wrongAxelarChain.axelarChain = "binance";
        vm.prank(alice);
        vm.expectRevert(InvalidDestination.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(wrongAxelarChain);

        AxelarItsAdapter.GasTopUpIntent memory missingTransfer = _validIntent();
        missingTransfer.transferNonce = 999;
        vm.prank(alice);
        vm.expectRevert(MalformedMessage.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(missingTransfer);

        AxelarItsAdapter.GasTopUpIntent memory zeroTx = _validIntent();
        zeroTx.txHash = bytes32(0);
        vm.prank(alice);
        vm.expectRevert(MalformedMessage.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(zeroTx);

        // Bind (SOURCE_TX_ONE, 3) to NONCE_ONE, then verify cross-binding and re-binding fail.
        vm.prank(alice);
        adapter.topUpGasWithIntent{value: 0.1 ether}(_validIntent());

        AxelarItsAdapter.GasTopUpIntent memory switchedEvent = _validIntent();
        switchedEvent.intentNonce = 2;
        switchedEvent.txHash = SOURCE_TX_TWO;
        vm.prank(alice);
        vm.expectRevert(MalformedMessage.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(switchedEvent);

        _dispatchTransfer(NONCE_TWO, G_ADDR, AMOUNT);
        AxelarItsAdapter.GasTopUpIntent memory crossBound = _validIntent();
        crossBound.transferNonce = NONCE_TWO;
        crossBound.intentNonce = 3;
        vm.prank(alice);
        vm.expectRevert(MalformedMessage.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(crossBound);

        vm.prank(admin);
        adapter.setPeerEnabled(STELLAR, false);
        AxelarItsAdapter.GasTopUpIntent memory disabledPeer = _validIntent();
        disabledPeer.intentNonce = 4;
        vm.prank(alice);
        vm.expectRevert(RailNotConfigured.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(disabledPeer);
    }

    function test_sender_authorization_deadline_and_replay_protection() public {
        vm.deal(alice, 2 ether);
        vm.deal(stranger, 2 ether);

        AxelarItsAdapter.GasTopUpIntent memory intent = _validIntent();

        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(intent);

        AxelarItsAdapter.GasTopUpIntent memory zeroRefund = _validIntent();
        zeroRefund.refundAddress = address(0);
        vm.prank(alice);
        vm.expectRevert(ZeroAddress.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(zeroRefund);

        vm.warp(2000);
        AxelarItsAdapter.GasTopUpIntent memory expired = _validIntent();
        expired.deadline = 1999;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TimelockExpired.selector, uint64(1999)));
        adapter.topUpGasWithIntent{value: 0.1 ether}(expired);

        intent.deadline = 3000;
        vm.prank(alice);
        adapter.topUpGasWithIntent{value: 0.1 ether}(intent);

        vm.prank(alice);
        vm.expectRevert(ReplayedMessage.selector);
        adapter.topUpGasWithIntent{value: 0.1 ether}(intent);
    }

    function test_native_spending_caps_and_owner_cap_configuration() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        adapter.setGasTopUpCaps(0.2 ether, 0.5 ether);

        vm.prank(admin);
        vm.expectRevert(InvalidLimit.selector);
        adapter.setGasTopUpCaps(0, 0.5 ether);

        vm.prank(admin);
        vm.expectRevert(InvalidLimit.selector);
        adapter.setGasTopUpCaps(0.6 ether, 0.5 ether);

        vm.expectEmit(true, true, true, true, address(adapter));
        emit GasTopUpCapsUpdated(0.3 ether, 0.5 ether);
        vm.prank(admin);
        adapter.setGasTopUpCaps(0.3 ether, 0.5 ether);

        vm.deal(alice, 3 ether);

        // Exceeds intent.maxNativeGas (0.2 ether < 0.25 ether).
        AxelarItsAdapter.GasTopUpIntent memory lowMax = _validIntent();
        lowMax.maxNativeGas = 0.2 ether;
        vm.prank(alice);
        vm.expectRevert(InvalidLimit.selector);
        adapter.topUpGasWithIntent{value: 0.25 ether}(lowMax);

        // Exceeds adapter maxGasTopUpPerCall (0.3 ether).
        AxelarItsAdapter.GasTopUpIntent memory overPerCall = _validIntent();
        overPerCall.maxNativeGas = 0.4 ether;
        vm.prank(alice);
        vm.expectRevert(InvalidLimit.selector);
        adapter.topUpGasWithIntent{value: 0.35 ether}(overPerCall);

        // Legacy topUpGas also enforces maxGasTopUpPerCall.
        vm.prank(alice);
        vm.expectRevert(InvalidLimit.selector);
        adapter.topUpGas{value: 0.35 ether}(SOURCE_TX_ONE, 3, alice);

        // First intent spends 0.3 ether; second intent of 0.25 ether exceeds cumulative 0.5 ether cap.
        AxelarItsAdapter.GasTopUpIntent memory first = _validIntent();
        first.maxNativeGas = 0.3 ether;
        vm.prank(alice);
        adapter.topUpGasWithIntent{value: 0.3 ether}(first);

        AxelarItsAdapter.GasTopUpIntent memory second = _validIntent();
        second.intentNonce = 2;
        second.maxNativeGas = 0.3 ether;
        vm.prank(alice);
        vm.expectRevert(InvalidLimit.selector);
        adapter.topUpGasWithIntent{value: 0.25 ether}(second);

        // Within remaining cumulative budget (0.2 ether) succeeds cleanly.
        vm.prank(alice);
        adapter.topUpGasWithIntent{value: 0.2 ether}(second);
        bytes32 dispatchKey = adapter.dispatchBindingKey(STELLAR, NONCE_ONE);
        assertEq(adapter.cumulativeGasTopUpOf(dispatchKey), 0.5 ether);
    }

    function _dispatchTransfer(uint64 nonce, string memory recipient, uint256 amount) internal {
        usdc.mint(address(adapter), amount);
        Destination memory destination = Destination({chain: STELLAR, strkey: recipient});
        vm.prank(address(router));
        adapter.dispatch(address(usdc), amount, destination, nonce);
    }

    function _validIntent() internal view returns (AxelarItsAdapter.GasTopUpIntent memory) {
        return AxelarItsAdapter.GasTopUpIntent({
            sender: alice,
            txHash: SOURCE_TX_ONE,
            logIndex: 3,
            transferNonce: NONCE_ONE,
            destinationChain: STELLAR,
            axelarChain: AXELAR_STELLAR,
            recipientStrkey: G_ADDR,
            token: address(usdc),
            tokenId: TOKEN_ID,
            originalAmount: AMOUNT,
            refundAddress: treasury,
            maxNativeGas: 0.5 ether,
            intentNonce: 1,
            deadline: uint64(block.timestamp + 1 hours)
        });
    }
}
