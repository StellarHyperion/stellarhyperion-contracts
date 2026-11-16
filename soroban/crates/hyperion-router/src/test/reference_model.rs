//! Stateful reference model and differential sequence runner for `HyperionRouter`.
//!
//! Compares multi-step generated operation sequences (outbound dispatch with 7->6 decimal flooring,
//! pause/narrowing, timelocked administration, authenticated inbound delivery, replay protection,
//! frozen recipients, and third-party claim settlement) step-by-step against the live Soroban
//! `HyperionRouter` contract, verifying conserved balances, fixed-recipient claim liabilities,
//! Soroban dual-clock (`sequence_number` vs `timestamp`) semantics, and deterministic shrinking of
//! failing sequences to minimal reproducible traces.

extern crate std;

use std::collections::{BTreeMap, BTreeSet};
use std::format;
use std::string::String as StdString;
use std::vec::Vec as StdVec;

use hyperion_core::{
    AddressKind, FlowWindow, HyperionError, RouteKind, BPS_DENOMINATOR,
    DEFAULT_FLOW_WINDOW_LEDGERS, MAX_FEE_BPS, STELLAR_DECIMALS,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Bytes, BytesN, String,
};

use super::doubles::{all_routes, evm_destination, message_id, Delivery};
use super::setup::{World, EVM_DECIMALS, FLOW_LIMIT};
use crate::timelock::{GRACE_PERIOD, MAX_TIMELOCK_DELAY, MIN_TIMELOCK_DELAY};
use crate::types::{AdminAction, Destination, Origin, OutboundRequest, Recipient};

const INITIAL_ACTOR_FUNDING: i128 = 500_000_000_000;

#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum Actor {
    Admin,
    Guardian,
    Alice,
    Bob,
    Stranger,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum AccountSlot {
    Admin,
    Guardian,
    Alice,
    Bob,
    Stranger,
    RecipientA,
    RecipientB,
    Treasury,
    TreasuryAlt,
    Router,
    Rail,
}

const ALL_SLOTS: [AccountSlot; 11] = [
    AccountSlot::Admin,
    AccountSlot::Guardian,
    AccountSlot::Alice,
    AccountSlot::Bob,
    AccountSlot::Stranger,
    AccountSlot::RecipientA,
    AccountSlot::RecipientB,
    AccountSlot::Treasury,
    AccountSlot::TreasuryAlt,
    AccountSlot::Router,
    AccountSlot::Rail,
];

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum ModelAction {
    SetFeeBps(u32),
    SetTreasuryAlt(bool),
    EnableRoute(RouteKind),
    RaiseTokenFlowLimit(i128),
    SetRouteFlowLimit(RouteKind, i128),
    SetTimelockDelay(u64),
    SetFlowWindow(u32),
    SetRouteMaxSingleTransfer(RouteKind, i128),
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum ModelOp {
    AdvanceTime(u64),
    AdvanceLedgers(u32),
    SetBlocked {
        slot: AccountSlot,
        blocked: bool,
    },
    BridgeOut {
        caller_is_bob: bool,
        route: RouteKind,
        amount: i128,
        min_dest: i128,
        empty_chain: bool,
    },
    BridgeIn {
        from_rail_receiver: bool,
        route: RouteKind,
        amount: i128,
        to_recipient_b: bool,
        recipient_kind: AddressKind,
        source_nonce: u64,
    },
    SettleClaim {
        caller: Actor,
        claim_id: u64,
    },
    Pause(Actor),
    Unpause(Actor),
    DisableRoute(Actor, RouteKind),
    LowerTokenFlowLimit(Actor, i128),
    QueueAction(Actor, ModelAction),
    ExecuteAction(Actor, u64),
    CancelAction(Actor, u64),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ModelClaim {
    id: u64,
    recipient: AccountSlot,
    amount: i128,
    route: RouteKind,
    source_nonce: u64,
    created_at: u64,
    settled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ModelQueued {
    id: u64,
    action: ModelAction,
    queued_at: u64,
    eta: u64,
    expires_at: u64,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum StepOutcome {
    UnitOk,
    U64Ok(u64),
    RouterErr(HyperionError),
    TokenTrap,
}

#[derive(Clone)]
struct SorobanReferenceModel {
    ledger_seq: u32,
    timestamp: u64,
    paused: bool,
    treasury: AccountSlot,
    fee_bps: u32,
    flow_window_ledgers: u32,
    timelock_delay: u64,
    token_flow_limit: i128,
    route_enabled: BTreeMap<u32, bool>,
    route_flow_limit: BTreeMap<u32, i128>,
    route_max_single: BTreeMap<u32, i128>,
    flow_windows: BTreeMap<u32, FlowWindow>,
    out_nonce: u64,
    claim_count: u64,
    queue_count: u64,
    processed: BTreeSet<(u32, u64)>,
    claims: BTreeMap<u64, ModelClaim>,
    claim_snapshots: BTreeMap<u64, ModelClaim>,
    queued: BTreeMap<u64, ModelQueued>,
    blocked: BTreeSet<AccountSlot>,
    balances: BTreeMap<AccountSlot, i128>,
    initial_supply: i128,
    /// Fault-injection flag used only in minimal-trace shrinking tests.
    wrong_timestamp_flow_clock: bool,
}

impl SorobanReferenceModel {
    fn new(ledger_seq: u32, timestamp: u64, queue_count: u64) -> Self {
        let mut route_enabled = BTreeMap::new();
        let mut flow_windows = BTreeMap::new();
        for r in all_routes() {
            route_enabled.insert(r as u32, true);
            flow_windows.insert(
                r as u32,
                FlowWindow {
                    epoch: 0,
                    consumed: 0,
                    prev_consumed: 0,
                },
            );
        }

        let mut balances = BTreeMap::new();
        for slot in ALL_SLOTS {
            balances.insert(slot, 0);
        }
        balances.insert(AccountSlot::Alice, INITIAL_ACTOR_FUNDING);
        balances.insert(AccountSlot::Bob, INITIAL_ACTOR_FUNDING);
        balances.insert(AccountSlot::Rail, INITIAL_ACTOR_FUNDING);
        let initial_supply = INITIAL_ACTOR_FUNDING * 3;

        Self {
            ledger_seq,
            timestamp,
            paused: false,
            treasury: AccountSlot::Treasury,
            fee_bps: 10,
            flow_window_ledgers: DEFAULT_FLOW_WINDOW_LEDGERS,
            timelock_delay: MIN_TIMELOCK_DELAY,
            token_flow_limit: FLOW_LIMIT,
            route_enabled,
            route_flow_limit: BTreeMap::new(),
            route_max_single: BTreeMap::new(),
            flow_windows,
            out_nonce: 0,
            claim_count: 0,
            queue_count,
            processed: BTreeSet::new(),
            claims: BTreeMap::new(),
            claim_snapshots: BTreeMap::new(),
            queued: BTreeMap::new(),
            blocked: BTreeSet::new(),
            balances,
            initial_supply,
            wrong_timestamp_flow_clock: false,
        }
    }

    fn flow_clock(&self) -> u32 {
        if self.wrong_timestamp_flow_clock {
            (self.timestamp & 0xFFFF_FFFF) as u32
        } else {
            self.ledger_seq
        }
    }

    fn effective_limit(&self, route: RouteKind) -> i128 {
        self.route_flow_limit
            .get(&(route as u32))
            .copied()
            .unwrap_or(self.token_flow_limit)
    }

    fn flow_available(&self, route: RouteKind) -> i128 {
        let limit = self.effective_limit(route);
        let win = self.flow_windows.get(&(route as u32)).unwrap();
        hyperion_core::flow::available(win, limit, self.flow_clock(), self.flow_window_ledgers)
            .unwrap()
    }

    fn validate_action(action: ModelAction) -> Result<(), HyperionError> {
        match action {
            ModelAction::SetFeeBps(bps) if bps > MAX_FEE_BPS => Err(HyperionError::FeeTooHigh),
            ModelAction::SetTimelockDelay(d)
                if !(MIN_TIMELOCK_DELAY..=MAX_TIMELOCK_DELAY).contains(&d) =>
            {
                Err(HyperionError::TimelockDelayOutOfRange)
            }
            ModelAction::SetFlowWindow(0) => Err(HyperionError::InvalidWindow),
            ModelAction::RaiseTokenFlowLimit(lim)
            | ModelAction::SetRouteFlowLimit(_, lim)
            | ModelAction::SetRouteMaxSingleTransfer(_, lim)
                if lim < 0 =>
            {
                Err(HyperionError::InvalidLimit)
            }
            _ => Ok(()),
        }
    }

    fn step(&mut self, op: ModelOp) -> StepOutcome {
        let snapshot = self.clone();
        let outcome = self.step_inner(op);
        if matches!(outcome, StepOutcome::RouterErr(_) | StepOutcome::TokenTrap) {
            *self = snapshot;
        }
        outcome
    }

    fn step_inner(&mut self, op: ModelOp) -> StepOutcome {
        match op {
            ModelOp::AdvanceTime(secs) => {
                self.timestamp += secs;
                StepOutcome::UnitOk
            }
            ModelOp::AdvanceLedgers(ledgers) => {
                self.ledger_seq += ledgers;
                StepOutcome::UnitOk
            }
            ModelOp::SetBlocked { slot, blocked } => {
                if blocked {
                    self.blocked.insert(slot);
                } else {
                    self.blocked.remove(&slot);
                }
                StepOutcome::UnitOk
            }
            ModelOp::BridgeOut {
                caller_is_bob,
                route,
                amount,
                min_dest,
                empty_chain,
            } => {
                if self.paused {
                    return StepOutcome::RouterErr(HyperionError::Paused);
                }
                if amount <= 0 {
                    return StepOutcome::RouterErr(HyperionError::InvalidAmount);
                }
                if !self
                    .route_enabled
                    .get(&(route as u32))
                    .copied()
                    .unwrap_or(false)
                {
                    return StepOutcome::RouterErr(HyperionError::RouteDisabled);
                }
                if let Some(&cap) = self.route_max_single.get(&(route as u32)) {
                    if cap > 0 && amount > cap {
                        return StepOutcome::RouterErr(HyperionError::ExceedsRouteLimit);
                    }
                }
                if empty_chain {
                    return StepOutcome::RouterErr(HyperionError::UnknownChain);
                }
                let fee = (amount * i128::from(self.fee_bps)) / BPS_DENOMINATOR;
                let net_raw = amount - fee;
                if net_raw <= 0 {
                    return StepOutcome::RouterErr(HyperionError::InvalidAmount);
                }
                // 7 -> 6 decimal floor: scale = 10
                let net = (net_raw / 10) * 10;
                if net <= 0 {
                    return StepOutcome::RouterErr(HyperionError::AmountNotRepresentable);
                }
                let landing = net / 10;
                if landing < min_dest {
                    return StepOutcome::RouterErr(HyperionError::SlippageExceeded);
                }
                let limit = self.effective_limit(route);
                let clock = self.flow_clock();
                let current_win = self.flow_windows.get(&(route as u32)).unwrap().clone();
                let updated_win = match hyperion_core::flow::consume(
                    &current_win,
                    limit,
                    net,
                    clock,
                    self.flow_window_ledgers,
                ) {
                    Ok(w) => w,
                    Err(e) => return StepOutcome::RouterErr(e),
                };

                let sender = if caller_is_bob {
                    AccountSlot::Bob
                } else {
                    AccountSlot::Alice
                };
                let gross = fee + net;
                let sender_bal = self.balances[&sender];
                // `FailableToken` checks `blocked(to)` (Contract(2)) before `from_balance < amount`
                // (Contract(1)), which `HyperionRouterClient::try_*` surfaces via its error enum.
                if self.blocked.contains(&AccountSlot::Router) {
                    return StepOutcome::RouterErr(HyperionError::NotInitialized);
                }
                if sender_bal < gross {
                    return StepOutcome::RouterErr(HyperionError::AlreadyInitialized);
                }
                if fee > 0 && self.blocked.contains(&self.treasury) {
                    return StepOutcome::RouterErr(HyperionError::NotInitialized);
                }
                if self.blocked.contains(&AccountSlot::Rail) {
                    return StepOutcome::RouterErr(HyperionError::NotInitialized);
                }

                *self.balances.get_mut(&sender).unwrap() -= gross;
                *self.balances.get_mut(&self.treasury).unwrap() += fee;
                *self.balances.get_mut(&AccountSlot::Rail).unwrap() += net;
                self.flow_windows.insert(route as u32, updated_win);
                self.out_nonce += 1;
                StepOutcome::U64Ok(self.out_nonce)
            }
            ModelOp::BridgeIn {
                from_rail_receiver,
                route,
                amount,
                to_recipient_b,
                recipient_kind,
                source_nonce,
            } => {
                if !from_rail_receiver {
                    return StepOutcome::RouterErr(HyperionError::NotRailReceiver);
                }
                if amount <= 0 {
                    return StepOutcome::RouterErr(HyperionError::InvalidAmount);
                }
                if self.processed.contains(&(route as u32, source_nonce)) {
                    return StepOutcome::RouterErr(HyperionError::ReplayedMessage);
                }
                if recipient_kind == AddressKind::MuxedAccount
                    && (route == RouteKind::Cctp || route == RouteKind::Allbridge)
                {
                    return StepOutcome::RouterErr(HyperionError::MuxedNotSupported);
                }
                if self.blocked.contains(&AccountSlot::Router) {
                    return StepOutcome::RouterErr(HyperionError::NotInitialized);
                }
                if self.balances[&AccountSlot::Rail] < amount {
                    return StepOutcome::RouterErr(HyperionError::AlreadyInitialized);
                }
                self.processed.insert((route as u32, source_nonce));
                *self.balances.get_mut(&AccountSlot::Rail).unwrap() -= amount;

                let recipient = if to_recipient_b {
                    AccountSlot::RecipientB
                } else {
                    AccountSlot::RecipientA
                };
                if !self.blocked.contains(&recipient) {
                    *self.balances.get_mut(&recipient).unwrap() += amount;
                    StepOutcome::U64Ok(0)
                } else {
                    *self.balances.get_mut(&AccountSlot::Router).unwrap() += amount;
                    self.claim_count += 1;
                    let id = self.claim_count;
                    let claim = ModelClaim {
                        id,
                        recipient,
                        amount,
                        route,
                        source_nonce,
                        created_at: self.timestamp,
                        settled: false,
                    };
                    self.claims.insert(id, claim.clone());
                    self.claim_snapshots.insert(id, claim);
                    StepOutcome::U64Ok(id)
                }
            }
            ModelOp::SettleClaim { claim_id, .. } => {
                let Some(claim) = self.claims.get(&claim_id).cloned() else {
                    return StepOutcome::RouterErr(HyperionError::ClaimNotFound);
                };
                if claim.settled {
                    return StepOutcome::RouterErr(HyperionError::ClaimAlreadySettled);
                }
                if self.blocked.contains(&claim.recipient)
                    || self.balances[&AccountSlot::Router] < claim.amount
                {
                    return StepOutcome::RouterErr(HyperionError::RecipientNotReady);
                }
                *self.balances.get_mut(&AccountSlot::Router).unwrap() -= claim.amount;
                *self.balances.get_mut(&claim.recipient).unwrap() += claim.amount;
                self.claims.get_mut(&claim_id).unwrap().settled = true;
                StepOutcome::UnitOk
            }
            ModelOp::Pause(caller) => {
                if caller != Actor::Admin && caller != Actor::Guardian {
                    return StepOutcome::RouterErr(HyperionError::Unauthorized);
                }
                self.paused = true;
                StepOutcome::UnitOk
            }
            ModelOp::Unpause(caller) => {
                if caller != Actor::Admin {
                    return StepOutcome::RouterErr(HyperionError::Unauthorized);
                }
                self.paused = false;
                StepOutcome::UnitOk
            }
            ModelOp::DisableRoute(caller, route) => {
                if caller != Actor::Admin && caller != Actor::Guardian {
                    return StepOutcome::RouterErr(HyperionError::Unauthorized);
                }
                self.route_enabled.insert(route as u32, false);
                StepOutcome::UnitOk
            }
            ModelOp::LowerTokenFlowLimit(caller, limit) => {
                if caller != Actor::Admin && caller != Actor::Guardian {
                    return StepOutcome::RouterErr(HyperionError::Unauthorized);
                }
                if limit < 0 || limit >= self.token_flow_limit {
                    return StepOutcome::RouterErr(HyperionError::InvalidLimit);
                }
                self.token_flow_limit = limit;
                StepOutcome::UnitOk
            }
            ModelOp::QueueAction(caller, action) => {
                if caller != Actor::Admin {
                    return StepOutcome::RouterErr(HyperionError::Unauthorized);
                }
                if let Err(e) = Self::validate_action(action) {
                    return StepOutcome::RouterErr(e);
                }
                self.queue_count += 1;
                let id = self.queue_count;
                let eta = self.timestamp + self.timelock_delay;
                let expires_at = eta + GRACE_PERIOD;
                self.queued.insert(
                    id,
                    ModelQueued {
                        id,
                        action,
                        queued_at: self.timestamp,
                        eta,
                        expires_at,
                    },
                );
                StepOutcome::U64Ok(id)
            }
            ModelOp::ExecuteAction(caller, id) => {
                if caller != Actor::Admin {
                    return StepOutcome::RouterErr(HyperionError::Unauthorized);
                }
                let Some(entry) = self.queued.get(&id).cloned() else {
                    return StepOutcome::RouterErr(HyperionError::TimelockNotQueued);
                };
                if self.timestamp < entry.eta {
                    return StepOutcome::RouterErr(HyperionError::TimelockNotReady);
                }
                if self.timestamp > entry.expires_at {
                    return StepOutcome::RouterErr(HyperionError::TimelockExpired);
                }
                self.queued.remove(&id);
                if let Err(e) = Self::validate_action(entry.action) {
                    return StepOutcome::RouterErr(e);
                }
                match entry.action {
                    ModelAction::SetFeeBps(bps) => self.fee_bps = bps,
                    ModelAction::SetTreasuryAlt(alt) => {
                        self.treasury = if alt {
                            AccountSlot::TreasuryAlt
                        } else {
                            AccountSlot::Treasury
                        };
                    }
                    ModelAction::EnableRoute(r) => {
                        self.route_enabled.insert(r as u32, true);
                    }
                    ModelAction::RaiseTokenFlowLimit(lim) => self.token_flow_limit = lim,
                    ModelAction::SetRouteFlowLimit(r, lim) => {
                        self.route_flow_limit.insert(r as u32, lim);
                    }
                    ModelAction::SetTimelockDelay(d) => self.timelock_delay = d,
                    ModelAction::SetFlowWindow(w) => self.flow_window_ledgers = w,
                    ModelAction::SetRouteMaxSingleTransfer(r, lim) => {
                        self.route_max_single.insert(r as u32, lim);
                    }
                }
                StepOutcome::UnitOk
            }
            ModelOp::CancelAction(caller, id) => {
                if caller != Actor::Admin && caller != Actor::Guardian {
                    return StepOutcome::RouterErr(HyperionError::Unauthorized);
                }
                if !self.queued.contains_key(&id) {
                    return StepOutcome::RouterErr(HyperionError::TimelockNotQueued);
                }
                self.queued.remove(&id);
                StepOutcome::UnitOk
            }
        }
    }

    fn verify_invariants(&self) -> Result<(), StdString> {
        let total: i128 = ALL_SLOTS.iter().map(|s| self.balances[s]).sum();
        if total != self.initial_supply {
            return Err(format!(
                "conserved supply violated: expected {}, got {}",
                self.initial_supply, total
            ));
        }

        let mut unsettled = 0i128;
        for (id, claim) in &self.claims {
            let snap = self
                .claim_snapshots
                .get(id)
                .ok_or_else(|| format!("missing snapshot for claim {id}"))?;
            if claim.recipient != snap.recipient
                || claim.amount != snap.amount
                || claim.route != snap.route
                || claim.source_nonce != snap.source_nonce
                || claim.created_at != snap.created_at
            {
                return Err(format!("fixed-recipient liability mutated on claim {id}"));
            }
            if !claim.settled {
                unsettled += claim.amount;
            }
        }
        if self.balances[&AccountSlot::Router] != unsettled {
            return Err(format!(
                "router escrow {} != unsettled claims {}",
                self.balances[&AccountSlot::Router],
                unsettled
            ));
        }
        if self.balances[&AccountSlot::Stranger] != 0
            || self.balances[&AccountSlot::Admin] != 0
            || self.balances[&AccountSlot::Guardian] != 0
        {
            return Err(StdString::from("non-recipient actor received funds"));
        }
        Ok(())
    }
}

struct DifferentialWorld {
    world: World,
    token_id: Address,
    bob: Address,
    recipient_b: Address,
    stranger: Address,
    treasury_alt: Address,
}

impl DifferentialWorld {
    fn new() -> (Self, SorobanReferenceModel) {
        let world = World::bare();
        world.env.ledger().with_mut(|li| {
            li.min_persistent_entry_ttl = 1_000_000;
            li.max_entry_ttl = 6_312_000;
        });
        world.rail().init(&world.router_id);
        world.enable_every_route();
        let token_id = world.with_failable_token_with_decimals(STELLAR_DECIMALS);
        let bob = Address::generate(&world.env);
        let recipient_b = Address::generate(&world.env);
        let stranger = Address::generate(&world.env);
        let treasury_alt = Address::generate(&world.env);

        let failable = world.failable(&token_id);
        failable.mint(&world.user, &INITIAL_ACTOR_FUNDING);
        failable.mint(&bob, &INITIAL_ACTOR_FUNDING);
        failable.mint(&world.rail_id, &INITIAL_ACTOR_FUNDING);

        let seq = world.env.ledger().sequence();
        let ts = world.env.ledger().timestamp();
        let qcount = world.router().queue_count();
        let model = SorobanReferenceModel::new(seq, ts, qcount);

        (
            Self {
                world,
                token_id,
                bob,
                recipient_b,
                stranger,
                treasury_alt,
            },
            model,
        )
    }

    fn actor_address(&self, actor: Actor) -> Address {
        match actor {
            Actor::Admin => self.world.admin.clone(),
            Actor::Guardian => self.world.guardian.clone(),
            Actor::Alice => self.world.user.clone(),
            Actor::Bob => self.bob.clone(),
            Actor::Stranger => self.stranger.clone(),
        }
    }

    fn slot_address(&self, slot: AccountSlot) -> Address {
        match slot {
            AccountSlot::Admin => self.world.admin.clone(),
            AccountSlot::Guardian => self.world.guardian.clone(),
            AccountSlot::Alice => self.world.user.clone(),
            AccountSlot::Bob => self.bob.clone(),
            AccountSlot::Stranger => self.stranger.clone(),
            AccountSlot::RecipientA => self.world.recipient.clone(),
            AccountSlot::RecipientB => self.recipient_b.clone(),
            AccountSlot::Treasury => self.world.treasury.clone(),
            AccountSlot::TreasuryAlt => self.treasury_alt.clone(),
            AccountSlot::Router => self.world.router_id.clone(),
            AccountSlot::Rail => self.world.rail_id.clone(),
        }
    }

    fn to_admin_action(&self, action: ModelAction) -> AdminAction {
        match action {
            ModelAction::SetFeeBps(bps) => AdminAction::SetFeeBps(bps),
            ModelAction::SetTreasuryAlt(alt) => AdminAction::SetTreasury(if alt {
                self.treasury_alt.clone()
            } else {
                self.world.treasury.clone()
            }),
            ModelAction::EnableRoute(r) => AdminAction::EnableRoute(r),
            ModelAction::RaiseTokenFlowLimit(lim) => {
                AdminAction::RaiseTokenFlowLimit(self.token_id.clone(), lim)
            }
            ModelAction::SetRouteFlowLimit(r, lim) => {
                AdminAction::SetRouteFlowLimit(self.token_id.clone(), r, lim)
            }
            ModelAction::SetTimelockDelay(d) => AdminAction::SetTimelockDelay(d),
            ModelAction::SetFlowWindow(w) => AdminAction::SetFlowWindow(w),
            ModelAction::SetRouteMaxSingleTransfer(r, lim) => {
                AdminAction::SetRouteMaxSingleTransfer(r, lim)
            }
        }
    }

    fn step_sut(&self, op: ModelOp) -> StepOutcome {
        let router = self.world.router();
        match op {
            ModelOp::AdvanceTime(secs) => {
                self.world.advance_time(secs);
                StepOutcome::UnitOk
            }
            ModelOp::AdvanceLedgers(ledgers) => {
                self.world.advance_ledgers(ledgers);
                StepOutcome::UnitOk
            }
            ModelOp::SetBlocked { slot, blocked } => {
                self.world
                    .failable(&self.token_id)
                    .set_blocked(&self.slot_address(slot), &blocked);
                StepOutcome::UnitOk
            }
            ModelOp::BridgeOut {
                caller_is_bob,
                route,
                amount,
                min_dest,
                empty_chain,
            } => {
                let caller = if caller_is_bob {
                    self.bob.clone()
                } else {
                    self.world.user.clone()
                };
                let chain = if empty_chain {
                    String::from_str(&self.world.env, "")
                } else {
                    self.world.ethereum()
                };
                let req = OutboundRequest {
                    route,
                    token: self.token_id.clone(),
                    amount,
                    destination: Destination {
                        chain,
                        address: evm_destination(&self.world.env, 0x11),
                    },
                    destination_decimals: EVM_DECIMALS,
                    min_destination_amount: min_dest,
                };
                match router.try_bridge_out(&caller, &req) {
                    Ok(Ok(nonce)) => StepOutcome::U64Ok(nonce),
                    Err(Ok(err)) => StepOutcome::RouterErr(err),
                    Err(Err(_)) | Ok(Err(_)) => StepOutcome::TokenTrap,
                }
            }
            ModelOp::BridgeIn {
                from_rail_receiver,
                route,
                amount,
                to_recipient_b,
                recipient_kind,
                source_nonce,
            } => {
                let recipient = if to_recipient_b {
                    self.recipient_b.clone()
                } else {
                    self.world.recipient.clone()
                };
                if from_rail_receiver {
                    let del = Delivery {
                        route,
                        token: self.token_id.clone(),
                        amount,
                        recipient,
                        recipient_kind,
                        source_chain: self.world.ethereum(),
                        source_nonce,
                    };
                    match self.world.rail().try_deliver(&del) {
                        Ok(Ok(claim_id)) => StepOutcome::U64Ok(claim_id),
                        Err(Ok(err)) => StepOutcome::RouterErr(err),
                        Err(Err(_)) | Ok(Err(_)) => StepOutcome::TokenTrap,
                    }
                } else {
                    match router.try_bridge_in(
                        &self.stranger,
                        &route,
                        &self.token_id,
                        &amount,
                        &Recipient {
                            address: recipient,
                            kind: recipient_kind,
                            raw: Bytes::new(&self.world.env),
                        },
                        &Origin {
                            chain: self.world.ethereum(),
                            nonce: source_nonce,
                            message_id: message_id(&self.world.env, source_nonce),
                            sender: BytesN::from_array(&self.world.env, &[0x22u8; 32]),
                        },
                    ) {
                        Ok(Ok(claim_id)) => StepOutcome::U64Ok(claim_id),
                        Err(Ok(err)) => StepOutcome::RouterErr(err),
                        Err(Err(_)) | Ok(Err(_)) => StepOutcome::TokenTrap,
                    }
                }
            }
            ModelOp::SettleClaim { caller, claim_id } => {
                match router.try_settle_claim(&self.actor_address(caller), &claim_id) {
                    Ok(Ok(())) => StepOutcome::UnitOk,
                    Err(Ok(err)) => StepOutcome::RouterErr(err),
                    Err(Err(_)) | Ok(Err(_)) => StepOutcome::TokenTrap,
                }
            }
            ModelOp::Pause(caller) => match router.try_pause(&self.actor_address(caller)) {
                Ok(Ok(())) => StepOutcome::UnitOk,
                Err(Ok(err)) => StepOutcome::RouterErr(err),
                _ => StepOutcome::TokenTrap,
            },
            ModelOp::Unpause(caller) => match router.try_unpause(&self.actor_address(caller)) {
                Ok(Ok(())) => StepOutcome::UnitOk,
                Err(Ok(err)) => StepOutcome::RouterErr(err),
                _ => StepOutcome::TokenTrap,
            },
            ModelOp::DisableRoute(caller, route) => {
                match router.try_disable_route(&self.actor_address(caller), &route) {
                    Ok(Ok(())) => StepOutcome::UnitOk,
                    Err(Ok(err)) => StepOutcome::RouterErr(err),
                    _ => StepOutcome::TokenTrap,
                }
            }
            ModelOp::LowerTokenFlowLimit(caller, limit) => {
                match router.try_lower_token_flow_limit(
                    &self.actor_address(caller),
                    &self.token_id,
                    &limit,
                ) {
                    Ok(Ok(())) => StepOutcome::UnitOk,
                    Err(Ok(err)) => StepOutcome::RouterErr(err),
                    _ => StepOutcome::TokenTrap,
                }
            }
            ModelOp::QueueAction(caller, action) => {
                let act = self.to_admin_action(action);
                match router.try_queue_action(&self.actor_address(caller), &act) {
                    Ok(Ok(id)) => StepOutcome::U64Ok(id),
                    Err(Ok(err)) => StepOutcome::RouterErr(err),
                    _ => StepOutcome::TokenTrap,
                }
            }
            ModelOp::ExecuteAction(caller, id) => {
                match router.try_execute_action(&self.actor_address(caller), &id) {
                    Ok(Ok(())) => StepOutcome::UnitOk,
                    Err(Ok(err)) => StepOutcome::RouterErr(err),
                    _ => StepOutcome::TokenTrap,
                }
            }
            ModelOp::CancelAction(caller, id) => {
                match router.try_cancel_action(&self.actor_address(caller), &id) {
                    Ok(Ok(())) => StepOutcome::UnitOk,
                    Err(Ok(err)) => StepOutcome::RouterErr(err),
                    _ => StepOutcome::TokenTrap,
                }
            }
        }
    }

    fn verify_parity(&self, model: &SorobanReferenceModel) -> Result<(), StdString> {
        model.verify_invariants()?;

        let failable = self.world.failable(&self.token_id);
        for slot in ALL_SLOTS {
            let sut_bal = failable.balance(&self.slot_address(slot));
            let mod_bal = model.balances[&slot];
            if sut_bal != mod_bal {
                return Err(format!(
                    "balance mismatch on {slot:?}: sut={sut_bal} vs model={mod_bal}"
                ));
            }
        }

        let router = self.world.router();
        if router.last_out_nonce() != model.out_nonce {
            return Err(format!(
                "out_nonce mismatch: sut={} vs model={}",
                router.last_out_nonce(),
                model.out_nonce
            ));
        }
        if router.claim_count() != model.claim_count {
            return Err(format!(
                "claim_count mismatch: sut={} vs model={}",
                router.claim_count(),
                model.claim_count
            ));
        }
        if router.queue_count() != model.queue_count {
            return Err(format!(
                "queue_count mismatch: sut={} vs model={}",
                router.queue_count(),
                model.queue_count
            ));
        }
        for route in all_routes() {
            let sut_avail = router.flow_available(&self.token_id, &route);
            let mod_avail = model.flow_available(route);
            if sut_avail != mod_avail {
                return Err(format!(
                    "flow_available({route:?}) mismatch: sut={sut_avail} vs model={mod_avail}"
                ));
            }
        }
        for (id, mod_claim) in &model.claims {
            let sut_claim = router.get_claim(id);
            let expected_addr = self.slot_address(mod_claim.recipient);
            if sut_claim.recipient != expected_addr
                || sut_claim.amount != mod_claim.amount
                || sut_claim.route != mod_claim.route
                || sut_claim.source_nonce != mod_claim.source_nonce
                || sut_claim.created_at != mod_claim.created_at
                || sut_claim.settled != mod_claim.settled
            {
                return Err(format!("PendingClaim {id} diverged between sut and model"));
            }
        }
        Ok(())
    }
}

struct Rng32(u32);

impl Rng32 {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x9E37_79B9);
        let mut z = self.0;
        z = (z ^ (z >> 16)).wrapping_mul(0x85EB_CA6B);
        z = (z ^ (z >> 13)).wrapping_mul(0xC2B2_AE35);
        z ^ (z >> 16)
    }

    fn idx(&mut self, len: usize) -> usize {
        (self.next() as usize) % len
    }
}

fn generate_soroban_ops(seed: u32, len: usize, base_queue_id: u64) -> StdVec<ModelOp> {
    let mut rng = Rng32(seed);
    let routes = all_routes();
    let actors = [Actor::Admin, Actor::Guardian, Actor::Stranger];
    let amounts: [i128; 8] = [0, 7, 100, 1_003, 25_009, 500_000, 25_000_007, 4_000_000_000];
    let kinds = [
        AddressKind::Account,
        AddressKind::Contract,
        AddressKind::MuxedAccount,
    ];
    let mut ops = StdVec::with_capacity(len);
    let mut next_nonce = 1u64;
    let mut approx_claims = 1u64;
    let mut approx_queue = base_queue_id;

    for _ in 0..len {
        let roll = rng.idx(100);
        let op = if roll < 15 {
            if rng.idx(2) == 0 {
                let ledgers = [1u32, 90, 360, 720, 1_500][rng.idx(5)];
                ModelOp::AdvanceLedgers(ledgers)
            } else {
                let secs = [60u64, 1_800, 3_601, 86_400, 700_000][rng.idx(5)];
                ModelOp::AdvanceTime(secs)
            }
        } else if roll < 30 {
            let slot = [
                AccountSlot::RecipientA,
                AccountSlot::RecipientB,
                AccountSlot::RecipientA,
                AccountSlot::Treasury,
            ][rng.idx(4)];
            ModelOp::SetBlocked {
                slot,
                blocked: rng.idx(3) == 0,
            }
        } else if roll < 50 {
            ModelOp::BridgeOut {
                caller_is_bob: rng.idx(2) == 1,
                route: routes[rng.idx(4)],
                amount: amounts[rng.idx(amounts.len())],
                min_dest: [0i128, 10, 50_000_000][rng.idx(3)],
                empty_chain: rng.idx(12) == 0,
            }
        } else if roll < 70 {
            let replay = next_nonce > 1 && rng.idx(4) == 0;
            let nonce = if replay {
                1 + (rng.idx((next_nonce - 1) as usize) as u64)
            } else {
                let n = next_nonce;
                next_nonce += 1;
                n
            };
            approx_claims += 1;
            ModelOp::BridgeIn {
                from_rail_receiver: rng.idx(6) != 0,
                route: routes[rng.idx(4)],
                amount: [0i128, 5_000, 250_000, 10_000_000][rng.idx(4)],
                to_recipient_b: rng.idx(2) == 1,
                recipient_kind: kinds[rng.idx(3)],
                source_nonce: nonce,
            }
        } else if roll < 82 {
            let max_cid = core::cmp::min(3, approx_claims) as usize;
            let cid = 1 + (rng.idx(max_cid) as u64);
            let caller = [Actor::Stranger, Actor::Alice, Actor::Bob, Actor::Guardian][rng.idx(4)];
            ModelOp::SettleClaim {
                caller,
                claim_id: cid,
            }
        } else if roll < 91 {
            let caller = actors[rng.idx(3)];
            match rng.idx(4) {
                0 => ModelOp::Pause(caller),
                1 => ModelOp::Unpause(caller),
                2 => ModelOp::DisableRoute(caller, routes[rng.idx(4)]),
                _ => ModelOp::LowerTokenFlowLimit(
                    caller,
                    [8_000_000_000i128, 5_000_000_000, 20_000_000_000][rng.idx(3)],
                ),
            }
        } else {
            match rng.idx(3) {
                0 => {
                    let caller = if rng.idx(5) == 0 {
                        Actor::Guardian
                    } else {
                        Actor::Admin
                    };
                    let action = match rng.idx(8) {
                        0 => ModelAction::SetFeeBps([0u32, 5, 25, 100, 150][rng.idx(5)]),
                        1 => ModelAction::SetTreasuryAlt(rng.idx(2) == 1),
                        2 => ModelAction::EnableRoute(routes[rng.idx(4)]),
                        3 => ModelAction::RaiseTokenFlowLimit(15_000_000_000),
                        4 => ModelAction::SetRouteFlowLimit(routes[rng.idx(4)], 12_000_000_000),
                        5 => ModelAction::SetFlowWindow([0u32, 360, 720][rng.idx(3)]),
                        6 => ModelAction::SetTimelockDelay(
                            [100u64, MIN_TIMELOCK_DELAY, 7_200][rng.idx(3)],
                        ),
                        _ => ModelAction::SetRouteMaxSingleTransfer(
                            routes[rng.idx(4)],
                            2_000_000_000,
                        ),
                    };
                    if caller == Actor::Admin {
                        approx_queue += 1;
                    }
                    ModelOp::QueueAction(caller, action)
                }
                1 => {
                    let qid = base_queue_id
                        + 1
                        + (rng.idx((approx_queue - base_queue_id + 1) as usize) as u64);
                    ModelOp::ExecuteAction(
                        if rng.idx(5) == 0 {
                            Actor::Guardian
                        } else {
                            Actor::Admin
                        },
                        qid,
                    )
                }
                _ => {
                    let qid = base_queue_id
                        + 1
                        + (rng.idx((approx_queue - base_queue_id + 1) as usize) as u64);
                    ModelOp::CancelAction(actors[rng.idx(3)], qid)
                }
            }
        };
        ops.push(op);
    }
    ops
}

fn shrink_soroban_sequence<F>(ops: &[ModelOp], mut check: F) -> (StdVec<ModelOp>, usize, StdString)
where
    F: FnMut(&[ModelOp]) -> Option<(usize, StdString)>,
{
    let (first_idx, first_reason) = check(ops).expect("sequence must fail before shrinking");
    let mut current: StdVec<ModelOp> = ops[..=first_idx].to_vec();
    let mut latest = check(&current).unwrap_or((first_idx, first_reason));

    let mut granularity = 2usize;
    while current.len() > 1 {
        let chunk = core::cmp::max(1, current.len() / granularity);
        let mut reduced = false;
        let mut start = 0usize;
        while start < current.len() {
            let end = core::cmp::min(current.len(), start + chunk);
            if !(start == 0 && end == current.len()) {
                let mut candidate = StdVec::with_capacity(current.len() - (end - start));
                candidate.extend_from_slice(&current[..start]);
                candidate.extend_from_slice(&current[end..]);
                if !candidate.is_empty() {
                    if let Some((fail_idx, reason)) = check(&candidate) {
                        let truncated = candidate[..=fail_idx].to_vec();
                        if let Some(trunc_fail) = check(&truncated) {
                            current = truncated;
                            latest = trunc_fail;
                        } else {
                            current = candidate;
                            latest = (fail_idx, reason);
                        }
                        granularity = core::cmp::max(2, granularity - 1);
                        reduced = true;
                        break;
                    }
                }
            }
            start += chunk;
        }
        if !reduced {
            if chunk == 1 {
                break;
            }
            granularity = core::cmp::min(current.len(), granularity * 2);
        }
    }

    (current, latest.0, latest.1)
}

#[test]
fn generated_soroban_sequences_match_router_and_preserve_conservation_and_liabilities() {
    let mut total_parked_claims = 0u64;
    let mut total_settled_claims = 0u64;
    let mut total_outbounds = 0u64;

    for seed in 1u32..=16 {
        let (harness, mut model) = DifferentialWorld::new();
        let ops = generate_soroban_ops(seed * 251 + 19, 40, model.queue_count);

        for (step_idx, op) in ops.iter().copied().enumerate() {
            let sut_out = harness.step_sut(op);
            let mod_out = model.step(op);
            assert_eq!(
                sut_out, mod_out,
                "seed={seed} step={step_idx} op={op:?}: sut={sut_out:?} vs model={mod_out:?}"
            );
            if let Err(msg) = harness.verify_parity(&model) {
                panic!("seed={seed} step={step_idx} op={op:?}: {msg}");
            }
        }

        total_outbounds += model.out_nonce;
        total_parked_claims += model.claim_count;
        total_settled_claims += model.claims.values().filter(|c| c.settled).count() as u64;
    }

    assert!(total_outbounds > 0);
    assert!(total_parked_claims > 0);
    assert!(total_settled_claims > 0);
}

#[test]
fn soroban_ledger_flow_decay_and_timestamp_timelock_are_explicitly_decoupled() {
    let (harness, mut model) = DifferentialWorld::new();
    let qid_one = model.queue_count + 1;
    let qid_two = model.queue_count + 2;

    let sequence = [
        ModelOp::BridgeOut {
            caller_is_bob: false,
            route: RouteKind::Cctp,
            amount: 1_000_000_007,
            min_dest: 0,
            empty_chain: false,
        },
        ModelOp::QueueAction(Actor::Admin, ModelAction::SetFeeBps(25)),
        // Advance wall-clock past timelock delay with zero ledgers closed:
        // queued action matures, but flow window decays by 0.
        ModelOp::AdvanceTime(MIN_TIMELOCK_DELAY + 1),
        ModelOp::ExecuteAction(Actor::Admin, qid_one),
        ModelOp::QueueAction(Actor::Admin, ModelAction::SetFeeBps(40)),
        // Advance 2 full ledger windows with zero wall-clock seconds elapsed:
        // flow window restores 100% headroom, while the second queued action stays TimelockNotReady.
        ModelOp::AdvanceLedgers(DEFAULT_FLOW_WINDOW_LEDGERS * 2),
        ModelOp::ExecuteAction(Actor::Admin, qid_two),
    ];

    for (idx, op) in sequence.into_iter().enumerate() {
        let sut_out = harness.step_sut(op);
        let mod_out = model.step(op);
        assert_eq!(sut_out, mod_out, "step {idx}");
        harness.verify_parity(&model).unwrap();

        if idx == 3 {
            // 1_000_000_007 at 10 bps -> fee = 1_000_000, net_raw = 999_000_007 -> net = 999_000_000,
            // leaving 7 stroops of unrepresentable dust with Alice!
            assert_eq!(
                model.balances[&AccountSlot::Alice],
                INITIAL_ACTOR_FUNDING - 1_000_000_000
            );
            assert_eq!(model.fee_bps, 25);
            assert_eq!(
                harness
                    .world
                    .router()
                    .flow_available(&harness.token_id, &RouteKind::Cctp),
                FLOW_LIMIT - 999_000_000
            );
        }
        if idx == 6 {
            assert_eq!(
                sut_out,
                StepOutcome::RouterErr(HyperionError::TimelockNotReady)
            );
            assert_eq!(
                harness
                    .world
                    .router()
                    .flow_available(&harness.token_id, &RouteKind::Cctp),
                FLOW_LIMIT
            );
        }
    }
}

#[test]
fn failing_soroban_sequence_shrinks_to_minimal_reproducible_trace() {
    let (_, base_model) = DifferentialWorld::new();
    let mut noisy = generate_soroban_ops(999, 14, base_model.queue_count);
    noisy.extend([
        ModelOp::BridgeOut {
            caller_is_bob: false,
            route: RouteKind::Cctp,
            amount: 6_000_000_000,
            min_dest: 0,
            empty_chain: false,
        },
        ModelOp::Pause(Actor::Guardian),
        ModelOp::Unpause(Actor::Admin),
        ModelOp::AdvanceTime(7_200),
        ModelOp::BridgeOut {
            caller_is_bob: false,
            route: RouteKind::Cctp,
            amount: 6_000_000_000,
            min_dest: 0,
            empty_chain: false,
        },
        ModelOp::AdvanceLedgers(50),
    ]);

    let (minimal, fail_idx, reason) = shrink_soroban_sequence(&noisy, |candidate| {
        let (harness, mut wrong_clock_model) = DifferentialWorld::new();
        wrong_clock_model.wrong_timestamp_flow_clock = true;
        for (i, &op) in candidate.iter().enumerate() {
            let sut_out = harness.step_sut(op);
            let mod_out = wrong_clock_model.step(op);
            if sut_out != mod_out {
                return Some((
                    i,
                    format!("step {i} ({op:?}): sut={sut_out:?} vs mutant={mod_out:?}"),
                ));
            }
        }
        None
    });

    assert_eq!(minimal.len(), 3);
    assert_eq!(fail_idx, 2);
    assert!(reason.contains("FlowLimitExceeded"));
}
