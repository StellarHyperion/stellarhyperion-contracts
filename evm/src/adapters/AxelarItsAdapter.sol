// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "openzeppelin/access/Ownable.sol";
import {Ownable2Step} from "openzeppelin/access/Ownable2Step.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";

import {
    AlreadyConfigured,
    InvalidAmount,
    InvalidDestination,
    InvalidLimit,
    MalformedMessage,
    RailNotConfigured,
    RefundFailed,
    ReplayedMessage,
    TimelockExpired,
    TokenNotMapped,
    Unauthorized,
    UnexpectedRailContract,
    UnknownChain,
    ZeroAddress
} from "../HyperionErrors.sol";
import {AddressKind, Destination, Origin, RouteKind} from "../HyperionTypes.sol";
import {
    IAxelarGasService,
    IInterchainTokenExecutable,
    IInterchainTokenService
} from "../interfaces/IAxelar.sol";
import {IHyperionRouter} from "../interfaces/IHyperionRouter.sol";
import {IRailAdapter} from "../interfaces/IRailAdapter.sol";
import {HyperionNotes} from "../libraries/HyperionNotes.sol";
import {StellarAddress} from "../libraries/StellarAddress.sol";

/// @title Hyperion over Axelar's Interchain Token Service
/// @author dotmantissa
/// @notice The rail that goes both ways. Axelar carries a payload alongside the money, which is
/// what lets a delivery say who it is for, and its validator set is what decides whether a message
/// is real. Hyperion never makes that decision on either side.
///
/// Sending, this writes a note naming a Stellar destination and hands ITS the tokens. Receiving,
/// ITS transfers the tokens in and then calls `executeWithInterchainToken`, and this reads the note
/// to find an EVM address before handing the whole thing to the router.
///
/// The one check here that is load bearing is the peer comparison. ITS will happily deliver a
/// transfer with a payload from any contract on any connected chain, so the fact that a message
/// arrived through ITS says nothing about who sent it. The source address has to be Hyperion's own
/// contract on a chain Hyperion configured, and the comparison is on the raw bytes, because chains
/// disagree about how long an address is and about whether it is even binary.
contract AxelarItsAdapter is IRailAdapter, IInterchainTokenExecutable, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice The value ITS requires a receiving contract to return from `executeWithInterchainToken`.
    /// @dev What ITS insists a receiving contract hands back. Not reverting is not enough: Axelar
    /// wants proof the contract meant to accept this, rather than having a fallback that swallowed
    /// it without looking.
    bytes32 public constant EXECUTE_SUCCESS = keccak256("its-execute-success");

    /// @notice Default ceiling on native currency spent in a single gas top-up call.
    uint256 public constant DEFAULT_MAX_GAS_TOP_UP_PER_CALL = 1 ether;

    /// @notice Default cumulative ceiling on native gas top-ups for one outbound transfer.
    uint256 public constant DEFAULT_MAX_TOTAL_GAS_TOP_UP = 5 ether;

    /// @dev Axelar's own envelope version for "there is a payload and it is for a contract".
    uint32 private constant METADATA_CONTRACT_CALL = 0;

    /// @notice The router. The only address allowed to send, and the only address this delivers to.
    address public immutable ROUTER;

    /// @notice Axelar's Interchain Token Service on this chain.
    IInterchainTokenService public immutable ITS;

    /// @notice Axelar's gas service, for topping up a delivery that ran short.
    IAxelarGasService public immutable GAS_SERVICE;

    /// @notice Hyperion on the far side of one connected chain.
    struct Peer {
        /// Axelar's own name for the chain, which is not always Hyperion's name for it.
        string axelarChain;
        /// Hyperion's contract over there, in whatever form that chain's ITS puts on the wire.
        /// Twenty bytes for an EVM chain, and the string form of a contract id for Stellar.
        bytes peer;
        bool configured;
        bool enabled;
    }

    /// @notice Immutable record of an outbound ITS transfer used to verify gas top-up intents.
    struct OutboundDispatchBinding {
        address token;
        bytes32 tokenId;
        uint256 amount;
        bytes32 destinationChainHash;
        bytes32 axelarChainHash;
        bytes32 recipientStrkeyHash;
        bytes32 noteHash;
        bool recorded;
    }

    /// @notice Sender-bound gas top-up intent tied to a recorded outbound ITS transfer.
    struct GasTopUpIntent {
        address sender;
        bytes32 txHash;
        uint256 logIndex;
        uint64 transferNonce;
        string destinationChain;
        string axelarChain;
        string recipientStrkey;
        address token;
        bytes32 tokenId;
        uint256 originalAmount;
        address refundAddress;
        uint256 maxNativeGas;
        uint64 intentNonce;
        uint64 deadline;
    }

    /// @notice Maximum native currency permitted in any single gas top-up call.
    uint256 public maxGasTopUpPerCall;

    /// @notice Maximum cumulative native currency permitted across top-ups for one transfer.
    uint256 public maxTotalGasTopUpPerTransfer;

    mapping(string chain => Peer peer) private _peers;

    /// @dev Reverse lookup, so an inbound delivery can check the chain it names against the peer
    /// that is allowed to speak for it without the caller telling us which key to look under.
    mapping(string axelarChain => string chain) private _byAxelarName;

    /// @notice The ITS token id this chain's ERC20 is registered under, or zero if it is not
    /// linked. An unlinked token is a token this adapter will refuse to send.
    mapping(address token => bytes32 tokenId) public tokenIdOf;

    mapping(bytes32 dispatchKey => OutboundDispatchBinding binding) private _dispatches;

    /// @notice Cumulative native currency topped up for a recorded outbound transfer.
    mapping(bytes32 dispatchKey => uint256 totalPaid) public cumulativeGasTopUpOf;

    /// @notice Whether a domain-separated sender-bound gas top-up intent has already executed.
    mapping(bytes32 intentId => bool used) public topUpIntentUsed;

    mapping(bytes32 dispatchKey => bytes32 sourceEventHash) private _boundSourceEventOf;
    mapping(bytes32 sourceEventHash => bytes32 dispatchKey) private _dispatchKeyOfSourceEvent;

    /// @notice A chain became reachable.
    event PeerConfigured(string chain, string axelarChain, bytes peer);

    /// @notice A chain was turned on or off.
    event PeerEnabled(string chain, bool enabled);

    /// @notice A token became routable over ITS.
    event TokenLinked(address indexed token, bytes32 tokenId);

    /// @notice A transfer was handed to ITS.
    event TransferSubmitted(
        string chain, bytes32 tokenId, uint256 amount, uint64 nonce, uint256 gasValue, bytes note
    );

    /// @notice A delivery arrived from a peer and was passed to the router.
    event DeliveryAccepted(
        string sourceChain,
        bytes32 indexed commandId,
        address indexed recipient,
        uint256 amount,
        uint64 sourceNonce
    );

    /// @notice Native gas spending caps for top-ups were updated.
    event GasTopUpCapsUpdated(uint256 maxPerCall, uint256 maxPerTransfer);

    /// @notice A sender-bound gas top-up intent was validated and forwarded to Axelar Gas Service.
    event GasTopUpSubmitted(
        bytes32 indexed intentId,
        bytes32 indexed dispatchKey,
        address indexed sender,
        bytes32 txHash,
        uint256 logIndex,
        address refundAddress,
        uint256 paidValue
    );

    constructor(address router, address its, address gasService, address owner_) Ownable(owner_) {
        if (router == address(0) || its == address(0) || gasService == address(0)) revert ZeroAddress();
        ROUTER = router;
        ITS = IInterchainTokenService(its);
        GAS_SERVICE = IAxelarGasService(gasService);
        maxGasTopUpPerCall = DEFAULT_MAX_GAS_TOP_UP_PER_CALL;
        maxTotalGasTopUpPerTransfer = DEFAULT_MAX_TOTAL_GAS_TOP_UP;
    }

    /// @dev Axelar refunds unspent destination gas by sending it back to whoever paid, which is
    /// this contract, and it does so from its relayer in a later transaction rather than inside
    /// the call that paid. Without this the refund bounces and the money is gone, so the door has
    /// to be open even though nothing here ever wants native currency.
    ///
    /// What arrives this way is swept to the router by the next `dispatch`, where it leaves as
    /// change to that transfer's sender. That is not the person who overpaid, and pretending
    /// otherwise would mean keeping a ledger of gas refunds per transfer, off a rail that does
    /// not tell us which transfer a refund belongs to. Approximately returned beats precisely
    /// stranded.
    /// @notice Accepts the gas Axelar refunds after a delivery cost less than it was paid for.
    receive() external payable {}

    /// @inheritdoc IRailAdapter
    function route() external pure override returns (RouteKind) {
        return RouteKind.AxelarIts;
    }

    /// @inheritdoc IRailAdapter
    function supportsChain(string calldata chain) external view override returns (bool) {
        Peer storage peer = _peers[chain];
        return peer.configured && peer.enabled;
    }

    /// @inheritdoc IRailAdapter
    /// @dev Zero, because there is no honest on-chain answer. Axelar prices destination gas from
    /// the destination chain's own gas market, which this chain cannot see. The app asks Axelar's
    /// estimator and sends that much native currency; whatever is not wanted comes back in the
    /// same transaction. A made up number here would look authoritative and be wrong.
    function quoteFee(string calldata, uint256) external pure override returns (uint256) {
        return 0;
    }

    /// @inheritdoc IRailAdapter
    function dispatch(address token, uint256 amount, Destination calldata destination, uint64 nonce)
        external
        payable
        override
        returns (bytes32)
    {
        if (msg.sender != ROUTER) revert Unauthorized();
        if (amount == 0) revert InvalidAmount();

        bytes32 tokenId = tokenIdOf[token];
        if (tokenId == bytes32(0)) revert TokenNotMapped();

        Peer memory peer = _peers[destination.chain];
        if (!peer.configured) revert UnknownChain();
        if (!peer.enabled) revert RailNotConfigured();

        (AddressKind kind,,) = StellarAddress.parse(destination.strkey);
        bytes memory note = HyperionNotes.encodeInboundNote(kind, destination.strkey, nonce);
        _recordOutboundDispatch(
            token, tokenId, amount, destination.chain, peer.axelarChain, destination.strkey, nonce, note
        );

        emit TransferSubmitted(destination.chain, tokenId, amount, nonce, msg.value, note);

        IERC20(token).forceApprove(address(ITS), amount);
        ITS.interchainTransfer{value: msg.value}(
            tokenId,
            peer.axelarChain,
            peer.peer,
            amount,
            abi.encodePacked(METADATA_CONTRACT_CALL, note),
            msg.value
        );

        // ITS refunds what the destination gas market did not want, and none of it is this
        // contract's to keep.
        _refund();

        // ITS does not hand back a message id. The delivery is identified by the log Axelar's
        // gateway writes in this same transaction, which the indexer reads, so inventing a value
        // here would only give somebody a handle that resolves to nothing.
        return bytes32(0);
    }

    /// @inheritdoc IInterchainTokenExecutable
    /// @dev The tokens are already here by the time this runs. ITS transfers first and calls
    /// second, which is why this reads its own balance movement from the arguments rather than
    /// pulling anything.
    function executeWithInterchainToken(
        bytes32 commandId,
        string calldata sourceChain,
        bytes calldata sourceAddress,
        bytes calldata data,
        bytes32 tokenId,
        address token,
        uint256 amount
    ) external override returns (bytes32) {
        if (msg.sender != address(ITS)) revert Unauthorized();
        if (amount == 0) revert InvalidAmount();
        if (tokenIdOf[token] != tokenId) revert TokenNotMapped();

        string memory chain = _byAxelarName[sourceChain];
        Peer storage peer = _peers[chain];
        if (!peer.configured || !peer.enabled) revert RailNotConfigured();
        // Arriving through ITS proves a message was delivered, not who sent it. Any contract on
        // any connected chain can call ITS with a payload, so this is the check that turns "a
        // transfer arrived" into "Hyperion sent this".
        if (keccak256(sourceAddress) != keccak256(peer.peer)) revert UnexpectedRailContract();

        (address recipient, uint64 sourceNonce) = HyperionNotes.decodeOutboundNote(data);

        IERC20(token).forceApprove(ROUTER, amount);
        IHyperionRouter(ROUTER)
            .bridgeIn(
                RouteKind.AxelarIts,
                token,
                amount,
                recipient,
                Origin({
                    chain: chain,
                    nonce: sourceNonce,
                    // Axelar's command id is unique per delivery and is what its own replay protection
                    // is keyed on, so the router keys its replay guard on the same thing rather than
                    // on a nonce the far side chose.
                    messageId: commandId,
                    sender: keccak256(sourceAddress)
                })
            );
        // An approval that outlives the call it was for is an approval somebody eventually finds.
        IERC20(token).forceApprove(ROUTER, 0);

        emit DeliveryAccepted(chain, commandId, recipient, amount, sourceNonce);
        return EXECUTE_SUCCESS;
    }

    /// @notice Pay Axelar more gas for a delivery that ran short.
    /// @dev Permissionless, because a stuck transfer is somebody's money and the person most
    /// motivated to unstick it is not always the operator. Whoever pays gets nothing back except
    /// the transfer going through, which is the only incentive that needs to exist here.
    function topUpGas(bytes32 txHash, uint256 logIndex, address refundAddress) external payable {
        if (msg.value == 0) revert InvalidAmount();
        if (msg.value > maxGasTopUpPerCall) revert InvalidLimit();
        if (refundAddress == address(0)) revert ZeroAddress();
        if (txHash == bytes32(0)) revert MalformedMessage();
        GAS_SERVICE.addNativeGas{value: msg.value}(txHash, logIndex, refundAddress);
    }

    /// @notice Execute a sender-bound gas top-up intent verified against a recorded transfer.
    /// @dev Validates caller identity, deadline, per-call and per-transfer native gas caps,
    /// non-replay of the domain-separated intent hash, and exact immutable agreement on
    /// destination chain, recipient strkey, token, ITS token id, and original transfer amount.
    function topUpGasWithIntent(GasTopUpIntent calldata intent) external payable returns (bytes32 intentId) {
        if (intent.sender == address(0) || intent.refundAddress == address(0)) revert ZeroAddress();
        if (msg.sender != intent.sender) revert Unauthorized();
        if (msg.value == 0) revert InvalidAmount();
        if (block.timestamp > intent.deadline) revert TimelockExpired(intent.deadline);
        if (intent.maxNativeGas == 0 || msg.value > intent.maxNativeGas) revert InvalidLimit();
        if (msg.value > maxGasTopUpPerCall) revert InvalidLimit();
        if (intent.txHash == bytes32(0)) revert MalformedMessage();

        bytes32 dispatchKey = _verifyTopUpBindings(intent);

        intentId = computeTopUpIntentId(intent);
        if (topUpIntentUsed[intentId]) revert ReplayedMessage();

        uint256 updatedTotal = cumulativeGasTopUpOf[dispatchKey] + msg.value;
        if (updatedTotal > maxTotalGasTopUpPerTransfer) revert InvalidLimit();

        topUpIntentUsed[intentId] = true;
        cumulativeGasTopUpOf[dispatchKey] = updatedTotal;

        emit GasTopUpSubmitted(
            intentId, dispatchKey, msg.sender, intent.txHash, intent.logIndex, intent.refundAddress, msg.value
        );

        GAS_SERVICE.addNativeGas{value: msg.value}(intent.txHash, intent.logIndex, intent.refundAddress);
    }

    /// @notice Update per-call and cumulative per-transfer native gas top-up ceilings.
    function setGasTopUpCaps(uint256 maxPerCall, uint256 maxPerTransfer) external onlyOwner {
        if (maxPerCall == 0 || maxPerTransfer < maxPerCall) revert InvalidLimit();
        maxGasTopUpPerCall = maxPerCall;
        maxTotalGasTopUpPerTransfer = maxPerTransfer;
        emit GasTopUpCapsUpdated(maxPerCall, maxPerTransfer);
    }

    /// @notice Make a chain reachable, and name the contract allowed to speak for it.
    /// @dev Once only, like the CCTP adapter's lanes. Repointing a live peer would let a different
    /// contract deliver on a chain people are already using, which is not a configuration change,
    /// it is a new trust assumption, and those go through the router's timelock by way of a new
    /// adapter.
    function setPeer(string calldata chain, string calldata axelarChain, bytes calldata peerAddress)
        external
        onlyOwner
    {
        if (bytes(chain).length == 0 || bytes(axelarChain).length == 0) revert UnknownChain();
        if (peerAddress.length == 0) revert ZeroAddress();
        Peer storage peer = _peers[chain];
        if (peer.configured) revert AlreadyConfigured();
        if (bytes(_byAxelarName[axelarChain]).length != 0) revert AlreadyConfigured();

        peer.axelarChain = axelarChain;
        peer.peer = peerAddress;
        peer.configured = true;
        peer.enabled = true;
        _byAxelarName[axelarChain] = chain;

        emit PeerConfigured(chain, axelarChain, peerAddress);
        emit PeerEnabled(chain, true);
    }

    /// @notice Turn a configured chain on or off.
    function setPeerEnabled(string calldata chain, bool enabled) external onlyOwner {
        Peer storage peer = _peers[chain];
        if (!peer.configured) revert RailNotConfigured();
        peer.enabled = enabled;
        emit PeerEnabled(chain, enabled);
    }

    /// @notice Point a local token at its ITS token id.
    /// @dev Once only. An id is the same value on every chain ITS connects, so getting it right
    /// once is the whole job, and being able to change it later is only useful to somebody who
    /// wants a transfer to arrive as a different asset than it left as.
    function linkToken(address token, bytes32 tokenId) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (tokenId == bytes32(0)) revert TokenNotMapped();
        if (tokenIdOf[token] != bytes32(0)) revert AlreadyConfigured();
        // ITS knows which ERC20 an id belongs to on this chain. Asking rather than trusting the
        // argument turns a typo into a failed transaction now instead of a failed delivery later.
        if (ITS.registeredTokenAddress(tokenId) != token) revert TokenNotMapped();
        tokenIdOf[token] = tokenId;
        emit TokenLinked(token, tokenId);
    }

    /// @notice Read a configured chain.
    function peerOf(string calldata chain) external view returns (Peer memory) {
        return _peers[chain];
    }

    /// @notice Hyperion's own name for whatever Axelar calls a chain.
    function chainForAxelarName(string calldata axelarChain) external view returns (string memory) {
        return _byAxelarName[axelarChain];
    }

    /// @notice Deterministic storage key for a recorded outbound transfer binding.
    function dispatchBindingKey(string calldata chain, uint64 transferNonce) public pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(bytes(chain)), transferNonce));
    }

    /// @notice Read the immutable binding recorded when an outbound ITS transfer left.
    function outboundDispatchOf(string calldata chain, uint64 transferNonce)
        external
        view
        returns (OutboundDispatchBinding memory)
    {
        return _dispatches[dispatchBindingKey(chain, transferNonce)];
    }

    /// @notice Compute the domain-separated replay identifier for a sender-bound top-up intent.
    function computeTopUpIntentId(GasTopUpIntent calldata intent) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                intent.sender,
                intent.txHash,
                intent.logIndex,
                intent.transferNonce,
                keccak256(bytes(intent.destinationChain)),
                keccak256(bytes(intent.axelarChain)),
                keccak256(bytes(intent.recipientStrkey)),
                intent.token,
                intent.tokenId,
                intent.originalAmount,
                intent.refundAddress,
                intent.maxNativeGas,
                intent.intentNonce,
                intent.deadline
            )
        );
    }

    function _recordOutboundDispatch(
        address token,
        bytes32 tokenId,
        uint256 amount,
        string calldata destinationChain,
        string memory axelarChain,
        string calldata recipientStrkey,
        uint64 nonce,
        bytes memory note
    ) private {
        bytes32 dispatchKey = dispatchBindingKey(destinationChain, nonce);
        _dispatches[dispatchKey] = OutboundDispatchBinding({
            token: token,
            tokenId: tokenId,
            amount: amount,
            destinationChainHash: keccak256(bytes(destinationChain)),
            axelarChainHash: keccak256(bytes(axelarChain)),
            recipientStrkeyHash: keccak256(bytes(recipientStrkey)),
            noteHash: keccak256(note),
            recorded: true
        });
    }

    function _verifyTopUpBindings(GasTopUpIntent calldata intent) private returns (bytes32 dispatchKey) {
        Peer storage peer = _peers[intent.destinationChain];
        if (!peer.configured) revert UnknownChain();
        if (!peer.enabled) revert RailNotConfigured();

        dispatchKey = dispatchBindingKey(intent.destinationChain, intent.transferNonce);
        OutboundDispatchBinding storage recorded = _dispatches[dispatchKey];
        if (!recorded.recorded) revert MalformedMessage();

        if (keccak256(bytes(intent.axelarChain)) != recorded.axelarChainHash) {
            revert InvalidDestination();
        }
        if (keccak256(bytes(intent.recipientStrkey)) != recorded.recipientStrkeyHash) {
            revert InvalidDestination();
        }
        if (intent.token != recorded.token || intent.tokenId != recorded.tokenId) {
            revert TokenNotMapped();
        }
        if (intent.originalAmount != recorded.amount) revert InvalidAmount();

        bytes32 eventHash = keccak256(abi.encode(intent.txHash, intent.logIndex));
        bytes32 existingEvent = _boundSourceEventOf[dispatchKey];
        if (existingEvent != bytes32(0) && existingEvent != eventHash) revert MalformedMessage();

        bytes32 existingDispatch = _dispatchKeyOfSourceEvent[eventHash];
        if (existingDispatch != bytes32(0) && existingDispatch != dispatchKey) {
            revert MalformedMessage();
        }

        if (existingEvent == bytes32(0)) {
            _boundSourceEventOf[dispatchKey] = eventHash;
            _dispatchKeyOfSourceEvent[eventHash] = dispatchKey;
        }
    }

    function _refund() private {
        uint256 balance = address(this).balance;
        if (balance == 0) return;
        (bool sent,) = payable(ROUTER).call{value: balance}("");
        if (!sent) revert RefundFailed();
    }
}
