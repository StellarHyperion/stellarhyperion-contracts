// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "openzeppelin/access/Ownable.sol";
import {Ownable2Step} from "openzeppelin/access/Ownable2Step.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";

import {
    AlreadyConfigured,
    DecimalOverflow,
    InvalidAmount,
    InvalidLimit,
    ProviderBudgetExceeded,
    RailNotConfigured,
    RefundFailed,
    TimelockDelayOutOfRange,
    TimelockNotQueued,
    TimelockNotReady,
    TokenNotMapped,
    TopUpBindingMismatch,
    TopUpIntentNotFound,
    Unauthorized,
    UnexpectedRailContract,
    UnknownChain,
    UnsupportedHookVersion,
    ZeroAddress
} from "../HyperionErrors.sol";
import {
    AddressKind,
    Destination,
    Origin,
    RouteKind,
    TokenMappingConflict,
    TokenMappingReport,
    TokenMappingRequest
} from "../HyperionTypes.sol";
import {
    IAxelarGasService,
    IInterchainTokenExecutable,
    IInterchainTokenManager,
    IInterchainTokenService,
    ITokenManager
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

    /// @notice The delivery surface admitted for a chain/token-manager pair.
    enum DestinationCapability {
        DirectItsTransfer,
        GmpPayload
    }

    struct CapabilityRecord {
        uint8 tokenManagerType;
        DestinationCapability capability;
        bytes32 peerHash;
        bool configured;
    }

    /// @notice The value ITS requires a receiving contract to return from `executeWithInterchainToken`.
    /// @dev What ITS insists a receiving contract hands back. Not reverting is not enough: Axelar
    /// wants proof the contract meant to accept this, rather than having a fallback that swallowed
    /// it without looking.
    bytes32 public constant EXECUTE_SUCCESS = keccak256("its-execute-success");

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

    /// @notice Minimum delay before a proposed peer rotation can become active (1 hour).
    uint64 public constant MIN_ROTATION_DELAY = 1 hours;

    /// @dev The top-up intent stores only fixed-size digests and integers. These bounds keep
    /// source-side destination metadata bounded before it is committed into an intent.
    /// @notice Maximum destination chain name length for an intent.
    uint256 public constant MAX_DESTINATION_CHAIN_LENGTH = 64;
    /// @notice Maximum destination strkey length for an intent.
    uint256 public constant MAX_DESTINATION_STRKEY_LENGTH = 69;

    /// @notice Exact outbound transfer fields which a later gas top-up is allowed to reference.
    struct TransferIntent {
        bytes32 destinationBinding;
        bytes32 tokenId;
        address token;
        uint256 amount;
        uint64 nonce;
        address sender;
        bytes32 messageTxHash;
        uint256 messageLogIndex;
        address refundAddress;
        uint256 maxNativeSpend;
        uint256 nativeSpent;
        bool exists;
        bool messageBound;
    }

    /// @notice The bounded metadata a payer must echo when topping up an ITS transfer.
    struct TopUpMetadata {
        bytes32 intentId;
        address sender;
        bytes32 txHash;
        uint256 logIndex;
        bytes32 destinationBinding;
        bytes32 tokenId;
        address token;
        uint256 originalAmount;
        address refundAddress;
        uint256 maxNativeSpend;
    }

    /// @notice A proposed peer rotation awaiting the timelock delay.
    struct PeerRotation {
        bytes newPeer;
        uint64 eta;
        uint64 queuedAt;
    }

    mapping(string chain => bool retired) private _retiredChains;
    mapping(string axelarChain => bool retired) private _retiredAxelarNames;
    mapping(string chain => Peer peer) private _peers;
    mapping(string chain => PeerRotation) private _pendingRotations;
    mapping(string chain => uint8 version) private _requiredNoteVersions;

    /// @dev Reverse lookup, so an inbound delivery can check the chain it names against the peer
    /// that is allowed to speak for it without the caller telling us which key to look under.
    mapping(string axelarChain => string chain) private _byAxelarName;

    /// @dev Outbound dispatches are immutable top-up intents. The first top-up binds its Axelar
    /// source log and refund address; later top-ups must repeat that binding and share its cap.
    mapping(bytes32 intentId => TransferIntent intent) private _topUpIntents;
    mapping(bytes32 messageBinding => bytes32 intentId) private _intentByMessage;

    /// @notice The ITS token id this chain's ERC20 is registered under, or zero if it is not
    /// linked. An unlinked token is a token this adapter will refuse to send.
    mapping(address token => bytes32 tokenId) public tokenIdOf;

    /// @dev The EVM adapter remains closed until operators independently validate this rail.
    /// @notice Whether independent validation permits development execution.
    bool public developmentGateOpen;
    /// @notice Operator supplied independent validation evidence digest.
    bytes32 public developmentValidationEvidence;
    mapping(bytes32 key => CapabilityRecord record) private _capabilities;
    /// @dev And back again, which is what makes the inbound allowlist and the reverse half of a
    /// registration conflict answerable without an event scan. Kept in step with `tokenIdOf` by
    /// `linkToken` and by nothing else.
    mapping(bytes32 tokenId => address token) private _tokenOfId;

    /// @notice The token manager kind Axelar uses for a token id, cached when it was linked.
    /// @dev Not consulted by any transfer path: `dispatch` and `executeWithInterchainToken` read
    /// nothing from here. It exists so a dry run can compare what an operator believes against
    /// what Axelar said at registration time, and it is refreshed only by a successful link.
    mapping(bytes32 tokenId => uint256 managerType) private _managerTypeOfId;

    /// @notice A chain became reachable.
    event PeerConfigured(string chain, string axelarChain, bytes peer);

    /// @notice A chain was turned on or off.
    event PeerEnabled(string chain, bool enabled);

    /// @notice Minimum Hyperion note version required by a destination.
    event NoteVersionRequirementSet(string indexed chain, uint8 requiredVersion);

    /// @notice A peer rotation was proposed.
    event PeerRotationQueued(string indexed chain, bytes currentPeer, bytes newPeer, uint64 eta);

    /// @notice A peer rotation was applied.
    event PeerRotationApplied(string indexed chain, bytes oldPeer, bytes newPeer);

    /// @notice A peer rotation was cancelled.
    event PeerRotationCancelled(string indexed chain, bytes cancelledPeer);

    /// @notice A chain was removed from the adapter.
    event PeerRemoved(string indexed chain, string axelarChain);

    /// @notice A token became routable over ITS.
    event TokenLinked(address indexed token, bytes32 tokenId);
    /// @notice A chain/token-manager pair was admitted for the GMP payload surface.
    event DestinationCapabilitySet(
        string chain, bytes32 indexed tokenId, uint8 tokenManagerType, DestinationCapability capability
    );
    /// @notice EVM development use was enabled or disabled with a validation evidence hash.
    event DevelopmentGateSet(bool enabled, bytes32 validationEvidence);

    /// @notice A transfer was handed to ITS.
    event TransferSubmitted(
        string chain, bytes32 tokenId, uint256 amount, uint64 nonce, uint256 gasValue, bytes note
    );

    /// @notice Immutable outbound metadata that a top-up must identify exactly.
    event TransferIntentRecorded(
        bytes32 indexed intentId,
        bytes32 indexed destinationBinding,
        bytes32 tokenId,
        address token,
        uint256 amount,
        uint64 nonce,
        address sender
    );

    /// @notice A top-up bound to one source-chain ITS message and refund recipient.
    event GasTopUpBound(
        bytes32 indexed intentId,
        bytes32 indexed txHash,
        uint256 logIndex,
        address refundAddress,
        uint256 maxNativeSpend
    );

    /// @notice Native gas was added against an existing transfer intent.
    event GasToppedUp(bytes32 indexed intentId, uint256 amount, uint256 totalSpent);

    /// @notice A delivery arrived from a peer and was passed to the router.
    event DeliveryAccepted(
        string sourceChain,
        bytes32 indexed commandId,
        address indexed recipient,
        uint256 amount,
        uint64 sourceNonce
    );

    constructor(address router, address its, address gasService, address owner_) Ownable(owner_) {
        if (router == address(0) || its == address(0) || gasService == address(0)) revert ZeroAddress();
        ROUTER = router;
        ITS = IInterchainTokenService(its);
        GAS_SERVICE = IAxelarGasService(gasService);
    }

    /// @dev Axelar refunds unspent destination gas by sending it back to whoever paid, which is
    /// this contract, and it does so from its relayer in a later transaction rather than inside
    /// the call that paid. Without this the refund bounces and the money is gone, so the door has
    /// to be open even though nothing here ever wants native currency.
    ///
    /// What arrives this way is kept separate from the next dispatch. Axelar does not identify
    /// the transfer that a later refund belongs to, so forwarding the whole balance would let a
    /// subsequent sender receive somebody else's refund. Only the refund created by the current
    /// provider call is returned to its current router caller.
    /// @notice Accepts the gas Axelar refunds after a delivery cost less than it was paid for.
    receive() external payable {}

    /// @inheritdoc IRailAdapter
    function route() external pure override returns (RouteKind) {
        return RouteKind.AxelarIts;
    }

    /// @inheritdoc IRailAdapter
    function supportsChain(string calldata chain) external view override returns (bool) {
        Peer storage peer = _peers[chain];
        return developmentGateOpen && peer.configured && peer.enabled;
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
    function checkDispatch(address token, uint256 amount, Destination calldata destination)
        external
        view
        override
    {
        _dispatchPlan(token, amount, destination);
    }

    function _dispatchPlan(address token, uint256 amount, Destination calldata destination)
        private
        view
        returns (Peer memory peer, bytes32 tokenId, AddressKind kind)
    {
        if (amount == 0) revert InvalidAmount();
        if (
            bytes(destination.chain).length > MAX_DESTINATION_CHAIN_LENGTH
                || bytes(destination.strkey).length > MAX_DESTINATION_STRKEY_LENGTH
        ) revert InvalidLimit();

        tokenId = tokenIdOf[token];
        if (tokenId == bytes32(0)) revert TokenNotMapped();

        peer = _peers[destination.chain];
        if (!peer.configured) revert UnknownChain();
        if (!peer.enabled || !developmentGateOpen) revert RailNotConfigured();
        _requireCapability(destination.chain, tokenId, peer);

        (kind,,) = StellarAddress.parse(destination.strkey);
    }

    /// @inheritdoc IRailAdapter
    function dispatch(address token, uint256 amount, Destination calldata destination, uint64 nonce)
        external
        payable
        override
        returns (bytes32)
    {
        if (msg.sender != ROUTER) revert Unauthorized();
        return _dispatch(token, amount, destination, nonce, address(0));
    }

    /// @notice Router entrypoint that additionally records the original transfer sender.
    function dispatchWithSender(
        address token,
        uint256 amount,
        Destination calldata destination,
        uint64 nonce,
        address sender
    ) external payable returns (bytes32) {
        if (msg.sender != ROUTER) revert Unauthorized();
        if (sender == address(0)) revert ZeroAddress();
        return _dispatch(token, amount, destination, nonce, sender);
    }

    function _dispatch(
        address token,
        uint256 amount,
        Destination calldata destination,
        uint64 nonce,
        address sender
    ) private returns (bytes32) {
        (Peer memory peer, bytes32 tokenId, AddressKind kind) = _dispatchPlan(token, amount, destination);
        uint8 noteVersion = HyperionNotes.negotiateNoteVersion(requiredNoteVersion(destination.chain));
        if (noteVersion != 1) revert UnsupportedHookVersion();
        bytes memory note = HyperionNotes.encodeInboundNote(kind, destination.strkey, nonce);
        bytes32 destinationBinding =
            keccak256(abi.encode(destination.chain, destination.strkey, peer.axelarChain, peer.peer));
        bytes32 intentId = keccak256(
            abi.encode(
                block.chainid, address(this), nonce, destinationBinding, tokenId, token, amount, sender
            )
        );
        if (_topUpIntents[intentId].exists) revert TopUpBindingMismatch();
        _topUpIntents[intentId] = TransferIntent({
            destinationBinding: destinationBinding,
            tokenId: tokenId,
            token: token,
            amount: amount,
            nonce: nonce,
            sender: sender,
            messageTxHash: bytes32(0),
            messageLogIndex: 0,
            refundAddress: address(0),
            maxNativeSpend: 0,
            nativeSpent: 0,
            exists: true,
            messageBound: false
        });
        emit TransferSubmitted(destination.chain, tokenId, amount, nonce, msg.value, note);
        emit TransferIntentRecorded(intentId, destinationBinding, tokenId, token, amount, nonce, sender);

        IERC20(token).forceApprove(address(ITS), amount);
        uint256 balanceBeforeProvider = address(this).balance - msg.value;
        ITS.interchainTransfer{value: msg.value}(
            tokenId,
            peer.axelarChain,
            peer.peer,
            amount,
            abi.encodePacked(METADATA_CONTRACT_CALL, note),
            msg.value
        );

        // ITS refunds what the destination gas market did not want. Measure from the balance
        // after accepting this call's value so a late, unattributed refund already held by the
        // adapter cannot be redirected to this dispatch's sender.
        uint256 providerRefund = address(this).balance - balanceBeforeProvider;
        _refund(providerRefund);

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
        if (!developmentGateOpen) revert RailNotConfigured();
        if (amount == 0) revert InvalidAmount();
        if (tokenIdOf[token] != tokenId) revert TokenNotMapped();

        string memory chain = _byAxelarName[sourceChain];
        Peer storage peer = _peers[chain];
        if (!peer.configured || !peer.enabled) revert RailNotConfigured();
        // Arriving through ITS proves a message was delivered, not who sent it. Any contract on
        // any connected chain can call ITS with a payload, so this is the check that turns "a
        // transfer arrived" into "Hyperion sent this".
        if (keccak256(sourceAddress) != keccak256(peer.peer)) revert UnexpectedRailContract();
        _requireCapability(chain, tokenId, peer);

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

    /// @notice Pay Axelar more gas for a previously dispatched ITS message.
    /// @dev The intent metadata and sender are fixed and recorded by `dispatch`; it cannot redirect
    /// the original token transfer or alter its recipient or amount. Only that sender may bind the
    /// source transaction/log and refund address. Subsequent top-ups must repeat that binding and
    /// share its cumulative native-spend cap. Axelar's `(txHash, logIndex)` identifies the delivery.
    function topUpGas(TopUpMetadata calldata metadata) external payable {
        if (msg.value == 0) revert InvalidAmount();
        if (metadata.txHash == bytes32(0) || metadata.refundAddress == address(0)) {
            revert ZeroAddress();
        }
        if (metadata.maxNativeSpend == 0) revert InvalidAmount();

        TransferIntent storage intent = _topUpIntents[metadata.intentId];
        if (!intent.exists) revert TopUpIntentNotFound();
        if (msg.sender != intent.sender || metadata.sender != intent.sender) revert Unauthorized();
        if (
            metadata.destinationBinding != intent.destinationBinding || metadata.tokenId != intent.tokenId
                || metadata.token != intent.token || metadata.originalAmount != intent.amount
        ) revert TopUpBindingMismatch();

        if (!intent.messageBound) {
            bytes32 messageBinding = keccak256(abi.encode(metadata.txHash, metadata.logIndex));
            bytes32 boundIntent = _intentByMessage[messageBinding];
            if (boundIntent != bytes32(0) && boundIntent != metadata.intentId) {
                revert TopUpBindingMismatch();
            }
            intent.messageTxHash = metadata.txHash;
            intent.messageLogIndex = metadata.logIndex;
            intent.refundAddress = metadata.refundAddress;
            intent.maxNativeSpend = metadata.maxNativeSpend;
            intent.messageBound = true;
            _intentByMessage[messageBinding] = metadata.intentId;
            emit GasTopUpBound(
                metadata.intentId,
                metadata.txHash,
                metadata.logIndex,
                metadata.refundAddress,
                metadata.maxNativeSpend
            );
        } else if (
            intent.messageTxHash != metadata.txHash || intent.messageLogIndex != metadata.logIndex
                || intent.refundAddress != metadata.refundAddress
                || intent.maxNativeSpend != metadata.maxNativeSpend
        ) {
            revert TopUpBindingMismatch();
        }

        if (
            intent.nativeSpent > intent.maxNativeSpend
                || msg.value > intent.maxNativeSpend - intent.nativeSpent
        ) revert ProviderBudgetExceeded();
        uint256 totalSpent = intent.nativeSpent + msg.value;
        intent.nativeSpent = totalSpent;
        address refundRecipient = metadata.refundAddress;
        GAS_SERVICE.addNativeGas{value: msg.value}(metadata.txHash, metadata.logIndex, refundRecipient);
        emit GasToppedUp(metadata.intentId, msg.value, totalSpent);
    }

    /// @notice Read the immutable outbound fields and mutable gas budget for a top-up intent.
    function topUpIntent(bytes32 intentId) external view returns (TransferIntent memory) {
        return _topUpIntents[intentId];
    }

    /// @notice Make a chain reachable, and name the contract allowed to speak for it.
    /// @dev Initial links are once only. Live peer changes use the delayed rotation functions.
    /// Retired names cannot be relinked to bypass that delay; use a separately governed adapter.
    function setPeer(string calldata chain, string calldata axelarChain, bytes calldata peerAddress)
        external
        onlyOwner
    {
        if (bytes(chain).length == 0 || bytes(axelarChain).length == 0) revert UnknownChain();
        if (!_hasNonzeroByte(peerAddress)) revert ZeroAddress();
        if (_retiredChains[chain] || _retiredAxelarNames[axelarChain]) revert AlreadyConfigured();
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

    /// @notice Set the minimum note version a destination requires.
    /// @dev An unavailable version remains a hard dispatch blocker until a compatible codec is
    /// implemented; it is never downgraded to v1.
    function setRequiredNoteVersion(string calldata chain, uint8 requiredVersion) external onlyOwner {
        if (!_peers[chain].configured) revert UnknownChain();
        if (requiredVersion == 0) revert InvalidAmount();
        _requiredNoteVersions[chain] = requiredVersion;
        emit NoteVersionRequirementSet(chain, requiredVersion);
    }

    /// @notice The destination's minimum note version; legacy peers default to v1.
    function requiredNoteVersion(string calldata chain) public view returns (uint8) {
        uint8 version = _requiredNoteVersions[chain];
        return version == 0 ? 1 : version;
    }

    /// @notice Propose a rotation of the trusted peer contract on a remote chain.
    /// @param chain The Hyperion chain name.
    /// @param newPeer The new peer address (wire format).
    /// @param delay Timelock delay in seconds (must be >= MIN_ROTATION_DELAY).
    function proposePeerRotation(string calldata chain, bytes calldata newPeer, uint64 delay)
        external
        onlyOwner
    {
        Peer storage peer = _peers[chain];
        if (!peer.configured) revert UnknownChain();
        if (!_hasNonzeroByte(newPeer)) revert ZeroAddress();
        if (keccak256(newPeer) == keccak256(peer.peer)) revert AlreadyConfigured();
        if (delay < MIN_ROTATION_DELAY) revert TimelockDelayOutOfRange();

        if (_pendingRotations[chain].eta != 0) revert AlreadyConfigured();
        if (block.timestamp > type(uint64).max - delay) revert DecimalOverflow();
        uint64 nowTime = uint64(block.timestamp);
        uint64 eta = nowTime + delay;
        _pendingRotations[chain] = PeerRotation({newPeer: newPeer, eta: eta, queuedAt: nowTime});

        emit PeerRotationQueued(chain, peer.peer, newPeer, eta);
    }

    /// @notice Apply a previously proposed peer rotation after the delay has passed.
    /// @param chain The Hyperion chain name.
    function applyPeerRotation(string calldata chain) external onlyOwner {
        Peer storage peer = _peers[chain];
        if (!peer.configured) revert UnknownChain();

        PeerRotation memory rotation = _pendingRotations[chain];
        if (rotation.eta == 0) revert TimelockNotQueued();
        if (block.timestamp < rotation.eta) revert TimelockNotReady(rotation.eta);

        bytes memory oldPeer = peer.peer;
        peer.peer = rotation.newPeer;
        delete _pendingRotations[chain];

        emit PeerRotationApplied(chain, oldPeer, peer.peer);
    }

    /// @notice Cancel a pending peer rotation.
    /// @param chain The Hyperion chain name.
    function cancelPeerRotation(string calldata chain) external onlyOwner {
        Peer storage peer = _peers[chain];
        if (!peer.configured) revert UnknownChain();

        PeerRotation memory rotation = _pendingRotations[chain];
        if (rotation.eta == 0) revert TimelockNotQueued();

        bytes memory cancelledPeer = rotation.newPeer;
        delete _pendingRotations[chain];

        emit PeerRotationCancelled(chain, cancelledPeer);
    }

    /// @notice Permanently retire both names and remove their active peer/reverse mapping.
    /// @param chain The Hyperion chain name.
    function removePeer(string calldata chain) external onlyOwner {
        Peer storage peer = _peers[chain];
        if (!peer.configured) revert UnknownChain();

        string memory axelarChain = peer.axelarChain;
        _retiredChains[chain] = true;
        _retiredAxelarNames[axelarChain] = true;
        delete _byAxelarName[axelarChain];
        delete _peers[chain];
        delete _pendingRotations[chain];

        emit PeerRemoved(chain, axelarChain);
    }

    /// @notice Point a local token at its ITS token id.
    /// @dev Once only. An id is the same value on every chain ITS connects, so getting it right
    /// once is the whole job, and being able to change it later is only useful to somebody who
    /// wants a transfer to arrive as a different asset than it left as.
    ///
    /// A link that is already in place is never rewritten. Where the stored link disagrees with
    /// the arguments the call is refused with `AlreadyConfigured` rather than quietly overwritten,
    /// because the reverse mapping is the inbound allowlist and repointing it would change which
    /// asset an arriving delivery is paid in. Repeating the same link is accepted and writes
    /// nothing, so a deploy script that runs twice is boring. To see exactly which fields
    /// disagree, call `checkTokenMapping` first.
    function linkToken(address token, bytes32 tokenId) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (tokenId == bytes32(0)) revert TokenNotMapped();

        TokenMappingReport memory report = _inspectTokenMapping(
            TokenMappingRequest({
                token: token,
                tokenId: tokenId,
                expectedDecimals: 0,
                hasExpectedDecimals: false,
                expectedManagerType: 0,
                hasExpectedManagerType: false
            })
        );
        if (report.conflicts.length != 0) {
            // Two different mistakes with two different fixes. A link that would repoint an
            // existing mapping is a configuration clash; anything else is Axelar not knowing the
            // asset, which the caller has to resolve before the link means anything.
            TokenMappingConflict first = report.conflicts[0];
            if (first == TokenMappingConflict.TokenId || first == TokenMappingConflict.LocalToken) {
                revert AlreadyConfigured();
            }
            revert TokenNotMapped();
        }

        // The link already reads back exactly as proposed. Writing it again would only republish
        // an event for a change that did not happen, so this is a successful no-op.
        if (report.mappedTokenId == tokenId && report.mappedToken == token) return;

        tokenIdOf[token] = tokenId;
        _tokenOfId[tokenId] = token;
        _managerTypeOfId[tokenId] = report.railManagerType;
        emit TokenLinked(token, tokenId);
    }

    /// @notice Admit a reviewed chain and token manager without opening the development gate.
    function setDestinationCapability(
        string calldata chain,
        address token,
        uint8 tokenManagerType,
        DestinationCapability capability
    ) external onlyOwner {
        Peer memory peer = _peers[chain];
        if (!peer.configured) revert UnknownChain();
        bytes32 tokenId = tokenIdOf[token];
        if (tokenId == bytes32(0) || ITS.registeredTokenAddress(tokenId) != token) {
            revert TokenNotMapped();
        }
        if (
            capability != DestinationCapability.GmpPayload
                || tokenManagerType != _currentTokenManagerType(tokenId)
        ) revert RailNotConfigured();
        _capabilities[_capabilityKey(chain, tokenId)] = CapabilityRecord({
            tokenManagerType: tokenManagerType,
            capability: capability,
            peerHash: keccak256(peer.peer),
            configured: true
        });
        emit DestinationCapabilitySet(chain, tokenId, tokenManagerType, capability);
    }

    /// @notice Open development dispatch only with explicit independent validation evidence.
    function setDevelopmentGate(bool enabled, bytes32 validationEvidence) external onlyOwner {
        if (enabled && validationEvidence == bytes32(0)) revert RailNotConfigured();
        developmentGateOpen = enabled;
        developmentValidationEvidence = validationEvidence;
        emit DevelopmentGateSet(enabled, validationEvidence);
    }

    /// @notice Report what linking `token` to `tokenId` would do, without doing any of it.
    /// @dev The EVM half of the Stellar adapter's `check_token_mapping`, and it answers the same
    /// question in the same order: every field that disagrees, named, rather than the first one
    /// that would have caused a revert. A caller passes `expectedDecimals` and
    /// `expectedManagerType` to have those judged; leaving them out reports what was observed
    /// without judging it.
    ///
    /// Read only. Nothing here writes storage or emits an event, so calling it twice leaves the
    /// adapter exactly as it found it, which is what makes it usable as a rehearsal step in a
    /// deployment script.
    /// @param token The local ERC20 the caller proposes to link.
    /// @param tokenId The ITS token id the caller proposes to link it to.
    /// @param expectedDecimals Decimals the caller expects the local asset to report.
    /// @param hasExpectedDecimals Whether `expectedDecimals` should be judged at all.
    /// @param expectedManagerType The `TokenManagerType` discriminant the caller expects.
    /// @param hasExpectedManagerType Whether `expectedManagerType` should be judged at all.
    function checkTokenMapping(
        address token,
        bytes32 tokenId,
        uint8 expectedDecimals,
        bool hasExpectedDecimals,
        uint256 expectedManagerType,
        bool hasExpectedManagerType
    ) external view returns (TokenMappingReport memory) {
        return _inspectTokenMapping(
            TokenMappingRequest({
                token: token,
                tokenId: tokenId,
                expectedDecimals: expectedDecimals,
                hasExpectedDecimals: hasExpectedDecimals,
                expectedManagerType: expectedManagerType,
                hasExpectedManagerType: hasExpectedManagerType
            })
        );
    }

    /// @notice The local asset already linked to a token id, or the zero address.
    /// @dev The reverse half of `tokenIdOf`, and the map the inbound path's allowlist check
    /// effectively uses.
    function tokenOfId(bytes32 tokenId) external view returns (address) {
        return _tokenOfId[tokenId];
    }

    /// @notice The manager kind Axelar reported for a token id when it was linked.
    /// @dev Zero is both "no manager recorded" and `NativeInterchainToken`, so this is only
    /// meaningful for an id where `tokenIdOf` is non-zero.
    function managerTypeOfId(bytes32 tokenId) external view returns (uint256) {
        return _managerTypeOfId[tokenId];
    }

    /// @dev Build the report `checkTokenMapping` returns and `linkToken` acts on.
    ///
    /// Every read is allowed to fail. ITS reverts for an id it has no manager for, and a token
    /// that is not a real ERC20 answers nothing; neither is an error here, it is a fact the
    /// report carries so the caller can tell "Axelar has never heard of this id" apart from
    /// "Axelar knows the id and it belongs to a different asset".
    function _inspectTokenMapping(TokenMappingRequest memory request)
        private
        view
        returns (TokenMappingReport memory report)
    {
        report.token = request.token;
        report.tokenId = request.tokenId;
        report.mappedTokenId = tokenIdOf[request.token];
        report.mappedToken = _tokenOfId[request.tokenId];

        // What Axelar itself says is behind this id.
        try ITS.registeredTokenAddress(request.tokenId) returns (address registered) {
            report.railToken = registered;
        } catch {}
        try ITS.tokenManagerAddress(request.tokenId) returns (address manager) {
            report.railManager = manager;
        } catch {}
        if (report.railManager != address(0)) {
            // A static call rather than a typed one: `try` catches a revert but not a decode
            // failure, and an address with no code returns nothing at all. A manager that cannot
            // be read is a fact this report carries, not a reason to fail the whole check.
            (bool okKind, bytes memory kindRet) = report.railManager
                .staticcall(abi.encodeWithSelector(ITokenManager.implementationType.selector));
            if (okKind && kindRet.length == 32) {
                report.railManagerType = abi.decode(kindRet, (uint256));
                report.managerTypeKnown = true;
            }
        }

        // A token that cannot answer `decimals()` is not an error, it is a token whose decimals
        // are unknown, which is a different finding from a token whose decimals are wrong.
        (bool ok, bytes memory ret) = request.token.staticcall(abi.encodeWithSignature("decimals()"));
        if (ok && ret.length == 32) {
            uint256 raw = abi.decode(ret, (uint256));
            if (raw <= type(uint8).max) {
                // Safe: the guard above is exactly the range check.
                // forge-lint: disable-next-line(unsafe-typecast)
                report.onchainDecimals = uint8(raw);
                report.decimalsKnown = true;
            }
        }

        report.conflicts = _classifyTokenMapping(request, report);
    }

    /// @dev Derive every disagreement from the observations, in the fixed order the Stellar side
    /// uses. Pure and separated from the reads, because these are the rules both chains have to
    /// agree on and the order is what makes two runs over the same facts print the same list.
    ///
    /// Two passes rather than a push: the length of the array has to be known before it is
    /// allocated, and computing the findings twice in a pure function is cheaper than growing an
    /// array across five branches.
    function _classifyTokenMapping(TokenMappingRequest memory request, TokenMappingReport memory report)
        private
        pure
        returns (TokenMappingConflict[] memory conflicts)
    {
        // A link that would move an asset already linked elsewhere silently changes where money
        // goes. Both directions are checked because they fail differently: the forward one breaks
        // outbound dispatch, the reverse one makes an inbound delivery pay a token nobody linked.
        bool idConflict = report.mappedTokenId != bytes32(0) && report.mappedTokenId != request.tokenId;
        bool tokenConflict = report.mappedToken != address(0) && report.mappedToken != request.token;
        bool railTokenConflict = report.railToken != address(0) && report.railToken != request.token;
        // A zero `railToken` is the rail not knowing the id, which is also the answer to "is there
        // a manager": ITS registers the two together.
        bool unregistered = report.railToken == address(0);
        // Judged on whether a kind was read, not on its value: zero is a real kind, so a
        // `NativeInterchainToken` manager reporting `0` is not the same as no manager at all.
        bool managerMissing = request.hasExpectedManagerType && !report.managerTypeKnown;
        bool decimalsConflict = request.hasExpectedDecimals && report.decimalsKnown
            && report.onchainDecimals != request.expectedDecimals;
        bool decimalsUnreadable = request.hasExpectedDecimals && !report.decimalsKnown;
        bool managerConflict = request.hasExpectedManagerType && report.managerTypeKnown
            && report.railManagerType != request.expectedManagerType;

        uint256 size;
        if (idConflict) ++size;
        if (tokenConflict) ++size;
        if (unregistered) ++size;
        if (railTokenConflict) ++size;
        if (decimalsUnreadable) ++size;
        if (decimalsConflict) ++size;
        if (managerMissing) ++size;
        if (managerConflict) ++size;

        conflicts = new TokenMappingConflict[](size);
        uint256 cursor;
        if (idConflict) conflicts[cursor++] = TokenMappingConflict.TokenId;
        if (tokenConflict) conflicts[cursor++] = TokenMappingConflict.LocalToken;
        if (unregistered) conflicts[cursor++] = TokenMappingConflict.UnregisteredTokenId;
        if (railTokenConflict) conflicts[cursor++] = TokenMappingConflict.RailTokenMismatch;
        if (decimalsUnreadable) conflicts[cursor++] = TokenMappingConflict.UnreadableMetadata;
        if (decimalsConflict) conflicts[cursor++] = TokenMappingConflict.Decimals;
        if (managerMissing) conflicts[cursor++] = TokenMappingConflict.UnregisteredTokenId;
        if (managerConflict) conflicts[cursor++] = TokenMappingConflict.ManagerType;
    }

    /// @notice Read a configured chain.
    function peerOf(string calldata chain) external view returns (Peer memory) {
        return _peers[chain];
    }

    /// @notice Read the pending rotation for a chain.
    function pendingRotationOf(string calldata chain) external view returns (PeerRotation memory) {
        return _pendingRotations[chain];
    }

    /// @notice Hyperion's own name for whatever Axelar calls a chain.
    function chainForAxelarName(string calldata axelarChain) external view returns (string memory) {
        return _byAxelarName[axelarChain];
    }

    /// @notice Read-only inspection of an Axelar outbound note payload.
    function inspectOutboundNote(bytes calldata payload)
        external
        pure
        returns (address recipient, uint64 nonce)
    {
        return HyperionNotes.decodeOutboundNote(payload);
    }

    /// @notice Read-only inspection of an Axelar inbound note payload.
    function inspectInboundNote(bytes calldata payload)
        external
        pure
        returns (AddressKind kind, string memory strkey, uint64 nonce)
    {
        return HyperionNotes.decodeInboundNote(payload);
    }

    /// @dev Reject empty or all-zero wire addresses without narrowing chain-specific formats.
    function _hasNonzeroByte(bytes calldata peerAddress) private pure returns (bool) {
        for (uint256 i; i < peerAddress.length; ++i) {
            if (peerAddress[i] != bytes1(0)) return true;
        }
        return false;
    }

    /// @notice Read-only inspection of the expected spender and gas recipient for paid dispatch on EVM.
    /// @dev The router alone calls dispatch; ITS alone is approved for token movement.
    /// Gas payment is forwarded directly in msg.value to ITS, which relays to AxelarGasService.
    function inspectPaidDispatchTargets()
        external
        view
        returns (address itsSpender, address gasServiceRecipient)
    {
        return (address(ITS), address(GAS_SERVICE));
    }

    function _refund(uint256 amount) private {
        if (amount == 0) return;
        (bool sent,) = payable(ROUTER).call{value: amount}("");
        if (!sent) revert RefundFailed();
    }

    function _requireCapability(string memory chain, bytes32 tokenId, Peer memory peer) private view {
        CapabilityRecord storage record = _capabilities[_capabilityKey(chain, tokenId)];
        if (
            !record.configured || record.capability != DestinationCapability.GmpPayload
                || record.peerHash != keccak256(peer.peer)
                || record.tokenManagerType != _currentTokenManagerType(tokenId)
        ) revert RailNotConfigured();
    }

    function _currentTokenManagerType(bytes32 tokenId) private view returns (uint8) {
        address manager = ITS.tokenManagerAddress(tokenId);
        if (manager == address(0)) revert TokenNotMapped();
        uint256 managerType = IInterchainTokenManager(manager).implementationType();
        if (managerType > type(uint8).max) revert RailNotConfigured();
        // The preceding uint8 maximum check prevents truncation.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(managerType);
    }

    function _capabilityKey(string memory chain, bytes32 tokenId) private pure returns (bytes32) {
        return keccak256(abi.encode(chain, tokenId));
    }
}
