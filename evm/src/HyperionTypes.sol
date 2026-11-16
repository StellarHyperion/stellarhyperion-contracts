// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Which rail a transfer travels on.
///
/// The ordering is not cosmetic. These values are the same integers `hyperion_core::RouteKind`
/// encodes on the Stellar side, so a route read off an event on one chain means the same thing
/// when an indexer reads it on the other. Appending is fine; reordering is not.
enum RouteKind {
    Cctp,
    AxelarIts,
    AxelarGmp,
    Allbridge
}

/// @dev What kind of Stellar address a 32 byte key describes.
///
/// Stellar has three, and a cross-chain message carries a bare key with nothing to say which.
/// `G` is a classic ed25519 account, `C` a Soroban contract, `M` a SEP-23 muxed account that
/// shares one underlying `G` with thousands of others. Paying the wrong kind is not a reverted
/// transaction, it is money delivered somewhere nobody holds a key for, so the kind travels
/// alongside the key everywhere in this codebase.
enum AddressKind {
    Account,
    Contract,
    MuxedAccount
}

/// @dev Where a transfer is going.
///
/// The address travels as the string a person copies out of their wallet rather than as a
/// pre-split key, because a strkey carries its own CRC16 and splitting it somewhere else throws
/// that checksum away. `StellarAddress.parse` verifies it here, before anything moves.
struct Destination {
    /// Hyperion's own name for the chain, which the adapter translates into whatever the rail
    /// calls it. Lowercase and stable, so "stellar" rather than "Stellar" or domain 27.
    string chain;
    /// Fifty six characters starting with G or C, or sixty nine starting with M.
    string strkey;
}

/// @dev A request to send funds out of this chain.
struct OutboundRequest {
    address token;
    uint256 amount;
    RouteKind route;
    Destination destination;
    /// How many decimal places the asset has where it lands. Six on EVM, seven on Stellar for
    /// most issued assets, and getting it wrong is a factor of ten rather than a revert.
    uint8 destinationDecimals;
    /// The least the sender will accept arriving. Zero means they did not say.
    uint256 minDestinationAmount;
}

/// @dev Everything the router knows about an asset it is willing to move.
struct TokenConfig {
    bool registered;
    uint8 decimals;
    /// Ceiling per flow window, in this chain's units for this asset.
    uint256 flowLimit;
    bool enabled;
}

/// @dev Bounded provenance metadata for a recent outbound transfer.
///
/// Stored in a fixed-capacity circular buffer (`PROVENANCE_CAPACITY` slots) using fixed-width
/// digests and decoded Stellar destination parts rather than unbounded strings. Contract state
/// growth is capped at `256 * 11 = 2,816` storage words across the lifetime of the deployment, and
/// dispatches past the first full cycle overwrite warm slots instead of allocating cold storage.
///
/// Compatibility and migration: `BridgeOut` logs remain unchanged as the permanent archival record.
/// Callers reconciling older nonces evicted past `ProvenanceWindow.earliestNonce`, or transfers sent
/// through a retired router deployment, fall back to `BridgeOut` logs keyed by router and `nonce`.
struct TransferProvenance {
    /// Router sequence number; zero when no retained record matches the requested nonce.
    uint64 nonce;
    RouteKind route;
    address sender;
    /// Rail adapter contract that accepted the outbound dispatch.
    address adapter;
    address token;
    /// Total token amount pulled from the sender (`fee + netAmount`).
    uint256 grossAmount;
    uint256 fee;
    /// Committed token amount transferred to `adapter` and dispatched onto the rail.
    uint256 netAmount;
    /// Exact landing amount expressed in `destinationDecimals`.
    uint256 destinationAmount;
    /// Sender's requested minimum destination amount floor.
    uint256 minDestinationAmount;
    uint8 destinationDecimals;
    AddressKind destinationKind;
    /// Decoded 32-byte Stellar destination key (`G`, `C`, or base `G` key of an `M` address).
    bytes32 destinationKey;
    /// SEP-23 muxed account id when `destinationKind == AddressKind.MuxedAccount`, else zero.
    uint64 destinationMuxedId;
    /// `keccak256(bytes(destination.chain))` for fixed-width destination chain reconciliation.
    bytes32 destinationChainHash;
    /// Provider reference returned by `IRailAdapter.dispatch`, or zero when unreferenced.
    bytes32 railRef;
    uint64 createdAt;
}

/// @dev Retention bounds for the router's on-chain outbound provenance ring buffer.
struct ProvenanceWindow {
    uint64 capacity;
    /// Earliest `nonce` still retained in storage, or zero before any outbound transfer commits.
    uint64 earliestNonce;
    /// Latest committed `outboundNonce`, or zero before any outbound transfer commits.
    uint64 latestNonce;
}

/// @dev Funds that arrived but could not be handed over yet.
///
/// A parked claim is the answer to a token that refuses a transfer to a particular address.
/// USDC can freeze an account, and a frozen recipient must not be able to wedge an attested
/// delivery: the rail has already burned the counterpart on the far side, so reverting would
/// destroy the money rather than delay it. The funds sit here instead and anybody may settle
/// the claim later, which needs no privileges because the recipient was fixed when the rail
/// signed the message.
struct PendingClaim {
    uint64 id;
    address recipient;
    address token;
    uint256 amount;
    RouteKind route;
    string sourceChain;
    uint64 sourceNonce;
    uint64 createdAt;
    bool settled;
}

/// @dev Where an inbound delivery says it came from.
struct Origin {
    string chain;
    /// The far side router's own sequence number, for humans and indexers.
    uint64 nonce;
    /// The rail's own identifier for this message, at full width. This is what the replay guard
    /// is keyed on, because squeezing a 32 byte CCTP nonce or an Axelar message id into a uint64
    /// lets two different messages collide on one key.
    bytes32 messageId;
    bytes32 sender;
}

/// @dev The administrative changes that exist. Anything not on this list cannot be done at all.
enum ActionKind {
    SetFeeBps,
    SetTreasury,
    SetAdmin,
    SetGuardian,
    SetAdapter,
    SetRailReceiver,
    EnableRoute,
    RegisterToken,
    RaiseTokenFlowLimit,
    SetRouteFlowLimit,
    SetTimelockDelay,
    SetFlowWindow,
    /// Retire an asset without unregistering it, or bring one back.
    ///
    /// Separate from the flow limit on purpose. Dropping a limit to zero is the guardian's
    /// emergency brake and it reports itself as a flow refusal, which is the right thing to say
    /// while an incident is running. Retiring an asset for good is a different decision, it
    /// waits out the timelock like every other one, and it should say so plainly to anybody
    /// reading a failed quote.
    SetTokenEnabled
}

/// @dev One administrative change, in a shape a reviewer can read as fast as the contract can.
///
/// Flat and fixed rather than an encoded blob, and every field a kind does not use has to be
/// zero. A timelock exists so somebody can read a pending change and understand it before it
/// lands, and a struct with a spare field carrying a value nobody validates is a change that
/// reads one way to a person and another way to the code.
struct AdminAction {
    ActionKind kind;
    RouteKind route;
    /// The token for the token scoped kinds, otherwise the address being set.
    address subject;
    /// Basis points, a flow ceiling, a delay in seconds, or a window in seconds.
    uint256 amount;
    /// Decimal places, and only `RegisterToken` uses it.
    uint8 decimals;
}

/// @dev A change that has been announced and is waiting out its delay.
struct QueuedAction {
    uint64 id;
    AdminAction action;
    uint64 queuedAt;
    /// The earliest it may be executed.
    uint64 eta;
    /// The point after which it has to be queued again, so a forgotten change does not sit
    /// executable forever.
    uint64 expiresAt;
    bool executed;
}

/// @dev What a route would do with a given amount right now, without doing it.
struct RouteQuote {
    RouteKind route;
    bool available;
    /// Why not, when `available` is false. Zero when it is true.
    QuoteBlocker reason;
    uint256 grossAmount;
    uint256 fee;
    uint256 netAmount;
    /// What lands, in the destination's own decimal base.
    uint256 destinationAmount;
    uint256 flowAvailable;
    /// True for rails whose second leg waits on an attestation somebody has to fetch.
    bool waitsOnAttestation;
    /// True for the rail that moves the asset itself rather than a wrapper of it.
    bool isCanonical;
}

/// @dev Why a route turned a quote down.
enum QuoteBlocker {
    None,
    Paused,
    RouteDisabled,
    AdapterNotSet,
    TokenNotRegistered,
    TokenDisabled,
    AmountTooSmall,
    FlowLimitExceeded,
    NotRepresentable,
    MuxedNotSupported,
    InvalidDestination,
    ChainNotSupported
}
