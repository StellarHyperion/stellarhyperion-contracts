use hyperion_core::RouteKind;
use soroban_sdk::{contracttype, Address, BytesN, String};

/// Everything the router needs to know about itself.
///
/// Two roles, not one. `admin` is the multisig that changes parameters and has to wait out a
/// timelock to do it. `guardian` can only ever make things safer: pause, cancel a queued
/// action, lower a flow limit. Splitting them means the key that can stop an incident is not
/// the same key that can quietly raise a fee, and neither one alone can do both.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub guardian: Address,
    pub treasury: Address,
    /// Protocol fee in basis points, charged on the outbound leg only.
    pub fee_bps: u32,
    /// Length of the flow-limit window in ledgers.
    pub flow_window_ledgers: u32,
    /// Seconds a parameter change waits between being queued and being executable.
    pub timelock_delay: u64,
    pub paused: bool,
}

/// Per-asset settings.
///
/// A token has to be registered before it can move, and registration carries a flow limit.
/// There is no implicit unlimited default anywhere in this contract: an unregistered token is
/// a refused transfer, which is the behaviour you want on the day someone adds a lane and
/// forgets the limit.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenConfig {
    /// Decimal places this asset uses on Stellar. Almost always 7.
    pub decimals: u32,
    /// Ceiling on outbound volume per window, across every route unless overridden.
    pub flow_limit: i128,
    pub enabled: bool,
}

/// Per-route settings.
///
/// Limits that apply to an entire route rather than to a single asset.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteConfig {
    /// Ceiling on the gross amount a single transfer may carry over this route.
    pub max_single_transfer: i128,
}

/// A transfer the router sent out, kept so the indexer and the app can find it again.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferRecord {
    pub nonce: u64,
    pub sender: Address,
    pub token: Address,
    /// What the sender handed over.
    pub gross_amount: i128,
    /// What the protocol kept.
    pub fee: i128,
    /// What actually went onto the rail.
    pub net_amount: i128,
    pub destination_chain: String,
    /// The recipient on the far side, as a 32 byte word with the twenty real bytes at the end.
    pub destination: BytesN<32>,
    pub route: RouteKind,
    pub created_ledger: u32,
    pub created_at: u64,
}

/// An inbound delivery that could not be handed over on the spot.
///
/// A classic Stellar account cannot hold an asset it has not opened a trustline for, and a
/// transfer into one that has not is simply refused. Reverting here would mean the burn on the
/// far side already happened and the funds are stranded, so the router keeps them and records
/// who they belong to. Settling is permissionless: the funds can only ever go to the recipient
/// written down at delivery time, so there is no reason to make them pay their own gas or wait
/// for us.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingClaim {
    pub id: u64,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub route: RouteKind,
    pub source_chain: String,
    pub source_nonce: u64,
    pub created_at: u64,
    pub settled: bool,
}

/// A completed inbound delivery.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InboundRecord {
    pub route: RouteKind,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub source_chain: String,
    pub source_nonce: u64,
    pub delivered: bool,
    pub claim_id: u64,
    pub ledger: u32,
}

/// A parameter change waiting out its delay.
///
/// Anything that can move value or widen risk goes through here. Anything that only ever
/// reduces risk does not, because a bridge that needs three days of notice to stop bleeding is
/// not actually pausable.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdminAction {
    SetFeeBps(u32),
    SetTreasury(Address),
    SetAdmin(Address),
    SetGuardian(Address),
    SetAdapter(RouteKind, Address),
    SetRailReceiver(RouteKind, Address),
    EnableRoute(RouteKind),
    RegisterToken(Address, u32, i128),
    RaiseTokenFlowLimit(Address, i128),
    SetRouteFlowLimit(Address, RouteKind, i128),
    SetTimelockDelay(u64),
    SetFlowWindow(u32),
    Upgrade(BytesN<32>),
    SetRouteConfig(RouteKind, RouteConfig),
    SetRouteMaxSingleTransfer(RouteKind, i128),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedAction {
    pub id: u64,
    pub action: AdminAction,
    pub queued_at: u64,
    /// Earliest timestamp at which this can be executed.
    pub eta: u64,
    /// Latest timestamp at which this can be executed, after which it has to be requeued.
    pub expires_at: u64,
}

/// What a caller is told about a route before committing to it.
///
/// The app shows all four of these side by side, including the ones it is not going to use,
/// which is the whole reason the router exposes it rather than keeping the arithmetic private.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteQuote {
    pub route: RouteKind,
    pub available: bool,
    /// Populated when `available` is false. Zero otherwise.
    pub reason: u32,
    pub gross_amount: i128,
    pub fee: i128,
    pub net_amount: i128,
    /// Amount the recipient sees, in the destination asset's decimal base.
    pub destination_amount: i128,
    /// Headroom left under the flow limit for this route right now.
    pub flow_available: i128,
    pub waits_on_attestation: bool,
    pub is_canonical: bool,
}

/// Everything about an outbound transfer except who is sending it.
///
/// Bundled rather than passed loose because eight positional arguments is exactly how a caller
/// ends up swapping `amount` and `min_destination_amount`, and because the generated TypeScript
/// binding reads as a named object this way instead of a line of anonymous numbers.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboundRequest {
    pub token: Address,
    pub amount: i128,
    pub route: RouteKind,
    pub destination: Destination,
    /// Decimals the asset uses on the far side. Six for USDC on every EVM chain here.
    pub destination_decimals: u32,
    /// Floor on what the recipient must end up with, in the destination base. Zero accepts
    /// whatever the rate gives.
    pub min_destination_amount: i128,
}

/// Where an outbound transfer is going, in the form the caller supplies it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Destination {
    pub chain: String,
    /// Left-padded 20 byte EVM address. The router validates the padding rather than
    /// truncating, because a Stellar key that ends up in this field looks perfectly valid
    /// once you chop the front off it.
    pub address: BytesN<32>,
}

// `Origin` and `Recipient` live in `hyperion-core` rather than here, because both sides of the
// adapter handover need them and an adapter cannot depend on this crate without dragging the
// router's own entry points into its WASM. They are re-exported so the router's public surface
// reads exactly as it did when they were declared in this file.
pub use hyperion_core::inbound::{Origin, Recipient};
