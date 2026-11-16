//! Reusable hostile Soroban token and rail-receiver fixtures for exercising `HyperionRouter`
//! failure boundaries and post-rollback state invariants.
//!
//! Standard Stellar Asset Contracts in `soroban-sdk` testutils always credit exact amounts, open
//! trustlines automatically, and never attempt callbacks. Production integrations and adversarial
//! tokens/relayers can fail in four distinct ways at the router boundary:
//!
//! 1. **Short transfers** (`HostileTokenMode::ShortTransferBps`, `ShortTransferFlat`): debit the
//!    requested `amount` from `from` while crediting less to `to` (fee-on-transfer / haircut).
//! 2. **Authentication and leg failures** (`InboundAuthMode::OmitSubAuth`,
//!    `InboundAuthMode::UnderAuthorizeAmount`, `InboundAuthMode::AuthorizeWrongRecipient`,
//!    `env.set_auths(&[])` missing root auth, and `HostileTokenMode::FailOnTransferCall`): fail
//!    either before or mid-way through multi-transfer router flows.
//! 3. **Frozen accounts** (`HostileToken::set_frozen`): deterministically reject transfers into or
//!    out of frozen addresses on `bridge_out`, `bridge_in` (parking a recipient-bound claim), and
//!    `settle_claim` (`RecipientNotReady` until unfrozen).
//! 4. **Callback / reentrancy attempts** (`HostileTokenMode::CallbackSettleClaim`,
//!    `HostileTokenMode::CallbackPause`, `HostileRailMode::CallbackBridgeOut`,
//!    `HostileRailMode::CallbackBridgeIn`, `HostileRailMode::CallbackSettleClaim`): attempt to
//!    re-enter `HyperionRouter` while a router frame is already on the Soroban host call stack.

use hyperion_core::{AddressKind, HyperionError, RouteKind, BPS_DENOMINATOR, STELLAR_DECIMALS};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractimpl, contracttype, vec, Address, Bytes, BytesN, Env, IntoVal,
    String, Symbol,
};

use super::doubles::{evm_destination, message_id, Delivery};
use super::setup::{World, EVM_DECIMALS, FLOW_LIMIT, HUNDRED};
use crate::types::{AdminAction, Destination, Origin, OutboundRequest, PendingClaim, Recipient};
use crate::HyperionRouterClient;

// ------------------------------------------------------------------------------------------
// HostileToken
// ------------------------------------------------------------------------------------------

/// Deterministic fault profile for [`HostileToken`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostileTokenMode {
    /// Exact SEP-41 transfer semantics.
    Normal,
    /// Deduct `amount` from `from` and credit `amount - max(1, amount * bps / 10_000)` to `to`.
    ShortTransferBps(u32),
    /// Deduct `amount` from `from` and credit `amount - min(amount, flat_cut)` to `to`.
    ShortTransferFlat(i128),
    /// Deterministically fail on the `n`-th (1-based) `transfer` call after reset.
    FailOnTransferCall(u32),
    /// Attempt to re-enter `HyperionRouter::settle_claim(to, claim_id)` inside `transfer`.
    CallbackSettleClaim(Address, u64),
    /// Attempt to re-enter `HyperionRouter::pause(caller)` inside `transfer`.
    CallbackPause(Address, Address),
}

#[contracttype]
#[derive(Clone)]
enum HostileTokenKey {
    Decimals,
    Mode,
    TransferCalls,
    Balance(Address),
    Frozen(Address),
    Allowance(Address, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum HostileTokenError {
    InsufficientBalance = 1,
    AccountFrozen = 2,
    NegativeAmount = 3,
    InjectedLegFailure = 4,
    InsufficientAllowance = 5,
}

/// Configurable hostile SEP-41-compatible token fixture.
#[contract]
pub struct HostileToken;

#[contractimpl]
impl HostileToken {
    pub fn init(env: Env, decimals: u32) {
        env.storage()
            .instance()
            .set(&HostileTokenKey::Decimals, &decimals);
        env.storage()
            .instance()
            .set(&HostileTokenKey::Mode, &HostileTokenMode::Normal);
        env.storage()
            .instance()
            .set(&HostileTokenKey::TransferCalls, &0u32);
    }

    pub fn set_mode(env: Env, mode: HostileTokenMode) {
        env.storage().instance().set(&HostileTokenKey::Mode, &mode);
        env.storage()
            .instance()
            .set(&HostileTokenKey::TransferCalls, &0u32);
    }

    pub fn get_mode(env: Env) -> HostileTokenMode {
        env.storage()
            .instance()
            .get(&HostileTokenKey::Mode)
            .unwrap_or(HostileTokenMode::Normal)
    }

    pub fn set_frozen(env: Env, who: Address, frozen: bool) {
        env.storage()
            .instance()
            .set(&HostileTokenKey::Frozen(who), &frozen);
    }

    pub fn is_frozen(env: Env, who: Address) -> bool {
        env.storage()
            .instance()
            .get(&HostileTokenKey::Frozen(who))
            .unwrap_or(false)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let current = Self::balance(env.clone(), to.clone());
        env.storage()
            .instance()
            .set(&HostileTokenKey::Balance(to), &(current + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .instance()
            .get(&HostileTokenKey::Balance(id))
            .unwrap_or(0i128)
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&HostileTokenKey::Decimals)
            .unwrap_or(STELLAR_DECIMALS)
    }

    pub fn transfer_calls(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&HostileTokenKey::TransferCalls)
            .unwrap_or(0u32)
    }

    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        _expiration_ledger: u32,
    ) -> Result<(), HostileTokenError> {
        from.require_auth();
        if amount < 0 {
            return Err(HostileTokenError::NegativeAmount);
        }
        env.storage()
            .instance()
            .set(&HostileTokenKey::Allowance(from, spender), &amount);
        Ok(())
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .instance()
            .get(&HostileTokenKey::Allowance(from, spender))
            .unwrap_or(0i128)
    }

    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), HostileTokenError> {
        from.require_auth();
        Self::move_funds(&env, &from, &to, amount)
    }

    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), HostileTokenError> {
        spender.require_auth();
        let allowed = Self::allowance(env.clone(), from.clone(), spender.clone());
        if allowed < amount {
            return Err(HostileTokenError::InsufficientAllowance);
        }
        env.storage().instance().set(
            &HostileTokenKey::Allowance(from.clone(), spender),
            &(allowed - amount),
        );
        Self::move_funds(&env, &from, &to, amount)
    }

    fn move_funds(
        env: &Env,
        from: &Address,
        to: &Address,
        amount: i128,
    ) -> Result<(), HostileTokenError> {
        if amount < 0 {
            return Err(HostileTokenError::NegativeAmount);
        }
        let call_no = Self::transfer_calls(env.clone()) + 1;
        env.storage()
            .instance()
            .set(&HostileTokenKey::TransferCalls, &call_no);

        if Self::is_frozen(env.clone(), from.clone()) || Self::is_frozen(env.clone(), to.clone()) {
            return Err(HostileTokenError::AccountFrozen);
        }

        let mode = Self::get_mode(env.clone());
        let credit = match mode {
            HostileTokenMode::Normal => amount,
            HostileTokenMode::ShortTransferBps(bps) => {
                if bps == 0 || amount == 0 {
                    amount
                } else {
                    let cut = ((amount * i128::from(bps)) / BPS_DENOMINATOR).max(1);
                    amount - cut.min(amount)
                }
            }
            HostileTokenMode::ShortTransferFlat(flat_cut) => {
                let cut = flat_cut.max(0).min(amount);
                amount - cut
            }
            HostileTokenMode::FailOnTransferCall(target_call) => {
                if call_no == target_call {
                    return Err(HostileTokenError::InjectedLegFailure);
                }
                amount
            }
            HostileTokenMode::CallbackSettleClaim(router, claim_id) => {
                HyperionRouterClient::new(env, &router).settle_claim(to, &claim_id);
                amount
            }
            HostileTokenMode::CallbackPause(router, caller) => {
                HyperionRouterClient::new(env, &router).pause(&caller);
                amount
            }
        };

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(HostileTokenError::InsufficientBalance);
        }
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage().instance().set(
            &HostileTokenKey::Balance(from.clone()),
            &(from_balance - amount),
        );
        env.storage().instance().set(
            &HostileTokenKey::Balance(to.clone()),
            &(to_balance + credit),
        );
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------
// HostileRail (Outbound Adapter + Paid Adapter + Inbound Receiver)
// ------------------------------------------------------------------------------------------

/// Deterministic outbound fault/callback profile for [`HostileRail`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostileRailMode {
    /// Verify caller and funded balance, then record the dispatch.
    Normal,
    /// Revert after the router has charged flow, incremented nonce, and moved tokens.
    RevertDispatch,
    /// Attempt a reentrant `bridge_out` call back into the router during `dispatch`.
    CallbackBridgeOut(Address, OutboundRequest),
    /// Attempt a reentrant `bridge_in` call back into the router during `dispatch`.
    CallbackBridgeIn(RouteKind, Address, i128, Address),
    /// Attempt a reentrant `settle_claim` call back into the router during `dispatch`.
    CallbackSettleClaim(Address, u64),
}

/// Deterministic sub-invocation authorization mode for inbound [`HostileRail::deliver_with_auth`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InboundAuthMode {
    /// Authorize exact `(rail, router, amount)` pull.
    AuthorizedExact,
    /// Omit `authorize_as_current_contract` so the router's pull fails sub-invocation auth.
    OmitSubAuth,
    /// Authorize less than the amount promised to `bridge_in`.
    UnderAuthorizeAmount(i128),
    /// Authorize transfer to an address other than the router.
    AuthorizeWrongRecipient(Address),
}

#[contracttype]
#[derive(Clone)]
enum HostileRailKey {
    Router,
    Mode,
    DispatchCount,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum HostileRailError {
    NotRouter = 1,
    SimulatedDispatchRevert = 2,
    UnderfundedDispatch = 3,
}

/// Configurable hostile rail adapter and receiver fixture.
#[contract]
pub struct HostileRail;

#[contractimpl]
impl HostileRail {
    pub fn init(env: Env, router: Address) {
        env.storage()
            .instance()
            .set(&HostileRailKey::Router, &router);
        env.storage()
            .instance()
            .set(&HostileRailKey::Mode, &HostileRailMode::Normal);
        env.storage()
            .instance()
            .set(&HostileRailKey::DispatchCount, &0u32);
    }

    pub fn set_mode(env: Env, mode: HostileRailMode) {
        env.storage().instance().set(&HostileRailKey::Mode, &mode);
    }

    pub fn dispatch_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&HostileRailKey::DispatchCount)
            .unwrap_or(0u32)
    }

    pub fn dispatch(
        env: Env,
        caller: Address,
        token: Address,
        amount: i128,
        _destination_chain: String,
        _destination: BytesN<32>,
        _nonce: u64,
    ) -> Result<(), HostileRailError> {
        caller.require_auth();
        let router: Address = env
            .storage()
            .instance()
            .get(&HostileRailKey::Router)
            .unwrap();
        if caller != router {
            return Err(HostileRailError::NotRouter);
        }
        Self::execute_outbound_mode(&env, &router, &token, amount, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn dispatch_from(
        env: Env,
        caller: Address,
        sender: Address,
        token: Address,
        amount: i128,
        _destination_chain: String,
        _destination: BytesN<32>,
        _nonce: u64,
        _gas_amount: i128,
    ) -> Result<(), HostileRailError> {
        caller.require_auth();
        sender.require_auth();
        let router: Address = env
            .storage()
            .instance()
            .get(&HostileRailKey::Router)
            .unwrap();
        if caller != router {
            return Err(HostileRailError::NotRouter);
        }
        let this = env.current_contract_address();
        let before = soroban_sdk::token::Client::new(&env, &token).balance(&this);
        soroban_sdk::token::Client::new(&env, &token).transfer(&sender, &this, &amount);
        Self::execute_outbound_mode(&env, &router, &token, amount, Some(before))
    }

    pub fn deliver_with_auth(env: Env, delivery: Delivery, auth_mode: InboundAuthMode) -> u64 {
        let Delivery {
            route,
            token,
            amount,
            recipient,
            recipient_kind,
            source_chain,
            source_nonce,
        } = delivery;
        let router: Address = env
            .storage()
            .instance()
            .get(&HostileRailKey::Router)
            .unwrap();
        let this = env.current_contract_address();

        match auth_mode {
            InboundAuthMode::AuthorizedExact => {
                Self::authorize_pull(&env, &token, &this, &router, amount);
            }
            InboundAuthMode::OmitSubAuth => {}
            InboundAuthMode::UnderAuthorizeAmount(short_amount) => {
                Self::authorize_pull(&env, &token, &this, &router, short_amount);
            }
            InboundAuthMode::AuthorizeWrongRecipient(wrong_target) => {
                Self::authorize_pull(&env, &token, &this, &wrong_target, amount);
            }
        }

        HyperionRouterClient::new(&env, &router).bridge_in(
            &this,
            &route,
            &token,
            &amount,
            &Recipient {
                address: recipient,
                kind: recipient_kind,
                raw: Bytes::new(&env),
            },
            &Origin {
                chain: source_chain,
                nonce: source_nonce,
                message_id: message_id(&env, source_nonce),
                sender: BytesN::from_array(&env, &[0x44u8; 32]),
            },
        )
    }

    fn authorize_pull(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) {
        env.authorize_as_current_contract(vec![
            env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: Symbol::new(env, "transfer"),
                    args: (from.clone(), to.clone(), amount).into_val(env),
                },
                sub_invocations: vec![env],
            }),
        ]);
    }

    fn execute_outbound_mode(
        env: &Env,
        router: &Address,
        token: &Address,
        amount: i128,
        balance_before: Option<i128>,
    ) -> Result<(), HostileRailError> {
        let this = env.current_contract_address();
        let mode: HostileRailMode = env
            .storage()
            .instance()
            .get(&HostileRailKey::Mode)
            .unwrap_or(HostileRailMode::Normal);

        match mode {
            HostileRailMode::Normal => {
                let current = soroban_sdk::token::Client::new(env, token).balance(&this);
                let received = current - balance_before.unwrap_or(0);
                if received < amount {
                    return Err(HostileRailError::UnderfundedDispatch);
                }
            }
            HostileRailMode::RevertDispatch => {
                return Err(HostileRailError::SimulatedDispatchRevert);
            }
            HostileRailMode::CallbackBridgeOut(reentrant_sender, req) => {
                HyperionRouterClient::new(env, router).bridge_out(&reentrant_sender, &req);
            }
            HostileRailMode::CallbackBridgeIn(route, tok, amt, recipient) => {
                HyperionRouterClient::new(env, router).bridge_in(
                    &this,
                    &route,
                    &tok,
                    &amt,
                    &Recipient {
                        address: recipient,
                        kind: AddressKind::Account,
                        raw: Bytes::new(env),
                    },
                    &Origin {
                        chain: String::from_str(env, "ethereum"),
                        nonce: 999,
                        message_id: message_id(env, 999),
                        sender: BytesN::from_array(env, &[0x99u8; 32]),
                    },
                );
            }
            HostileRailMode::CallbackSettleClaim(settler, claim_id) => {
                HyperionRouterClient::new(env, router).settle_claim(&settler, &claim_id);
            }
        }

        let count = Self::dispatch_count(env.clone()) + 1;
        env.storage()
            .instance()
            .set(&HostileRailKey::DispatchCount, &count);
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------
// Deterministic Router State Snapshot & Rollback Assertions
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouterStateSnapshot {
    pub sender_balance: i128,
    pub treasury_balance: i128,
    pub router_balance: i128,
    pub rail_balance: i128,
    pub recipient_balance: i128,
    pub flow_available: i128,
    pub last_out_nonce: u64,
    pub claim_count: u64,
    pub was_processed: bool,
    pub tracked_claim: Option<PendingClaim>,
}

struct HostileHarness {
    world: World,
    hostile_token_id: Address,
    hostile_rail_id: Address,
}

impl HostileHarness {
    fn new() -> Self {
        let world = World::new();
        let hostile_token_id = world.env.register(HostileToken, ());
        HostileTokenClient::new(&world.env, &hostile_token_id).init(&STELLAR_DECIMALS);
        world.register_token(hostile_token_id.clone(), STELLAR_DECIMALS, FLOW_LIMIT);
        HostileTokenClient::new(&world.env, &hostile_token_id).mint(&world.user, &(HUNDRED * 10));

        let hostile_rail_id = world.env.register(HostileRail, ());
        HostileRailClient::new(&world.env, &hostile_rail_id).init(&world.router_id);
        for route in [RouteKind::Cctp, RouteKind::AxelarIts, RouteKind::AxelarGmp] {
            world.run_action(AdminAction::SetAdapter(route, hostile_rail_id.clone()));
            world.run_action(AdminAction::SetRailReceiver(route, hostile_rail_id.clone()));
            world.run_action(AdminAction::EnableRoute(route));
        }

        Self {
            world,
            hostile_token_id,
            hostile_rail_id,
        }
    }

    fn token(&self) -> HostileTokenClient<'_> {
        HostileTokenClient::new(&self.world.env, &self.hostile_token_id)
    }

    fn rail(&self) -> HostileRailClient<'_> {
        HostileRailClient::new(&self.world.env, &self.hostile_rail_id)
    }

    fn outbound_request(&self, route: RouteKind, amount: i128) -> OutboundRequest {
        OutboundRequest {
            token: self.hostile_token_id.clone(),
            amount,
            route,
            destination: Destination {
                chain: self.world.ethereum(),
                address: evm_destination(&self.world.env, 0x42),
            },
            destination_decimals: EVM_DECIMALS,
            min_destination_amount: 0,
        }
    }

    fn inbound_delivery(&self, route: RouteKind, amount: i128, source_nonce: u64) -> Delivery {
        Delivery {
            route,
            token: self.hostile_token_id.clone(),
            amount,
            recipient: self.world.recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: self.world.ethereum(),
            source_nonce,
        }
    }

    fn snapshot(
        &self,
        route: RouteKind,
        inbound_nonce: u64,
        tracked_claim_id: Option<u64>,
    ) -> RouterStateSnapshot {
        let tok = self.token();
        let router = self.world.router();
        let tracked_claim = tracked_claim_id.and_then(|id| match router.try_get_claim(&id) {
            Ok(Ok(claim)) => Some(claim),
            _ => None,
        });
        RouterStateSnapshot {
            sender_balance: tok.balance(&self.world.user),
            treasury_balance: tok.balance(&self.world.treasury),
            router_balance: tok.balance(&self.world.router_id),
            rail_balance: tok.balance(&self.hostile_rail_id),
            recipient_balance: tok.balance(&self.world.recipient),
            flow_available: router.flow_available(&self.hostile_token_id, &route),
            last_out_nonce: router.last_out_nonce(),
            claim_count: router.claim_count(),
            was_processed: router
                .was_processed(&route, &message_id(&self.world.env, inbound_nonce)),
            tracked_claim,
        }
    }
}

// ------------------------------------------------------------------------------------------
// Tests: 1. Short Transfers
// ------------------------------------------------------------------------------------------

#[test]
fn short_transfer_bps_rolls_back_fees_flow_and_nonce_on_bridge_out() {
    let h = HostileHarness::new();
    // 50 bps haircut on every transfer: router receives less than `gross`, so after paying
    // `treasury` it lacks sufficient balance to forward `net` to the adapter.
    h.token().set_mode(&HostileTokenMode::ShortTransferBps(50));

    let before = h.snapshot(RouteKind::Cctp, 1, None);
    let req = h.outbound_request(RouteKind::Cctp, HUNDRED);

    assert!(h
        .world
        .router()
        .try_bridge_out(&h.world.user, &req)
        .is_err());

    let after = h.snapshot(RouteKind::Cctp, 1, None);
    assert_eq!(after, before);
    assert_eq!(h.token().transfer_calls(), 0);
    assert_eq!(h.rail().dispatch_count(), 0);
    assert_eq!(
        h.world
            .router()
            .try_get_transfer(&(before.last_out_nonce + 1)),
        Err(Ok(HyperionError::UnknownNonce))
    );
}

#[test]
fn short_transfer_flat_rolls_back_paid_route_dispatch_from_when_adapter_verifies_funding() {
    let h = HostileHarness::new();
    // 1-stroop flat haircut: `bridge_out_with_gas` transfers treasury fee directly and delegates
    // net pull to `dispatch_from`, where `HostileRail` measures received balance < `net` and
    // reverts the entire transaction.
    h.token().set_mode(&HostileTokenMode::ShortTransferFlat(1));

    let before = h.snapshot(RouteKind::AxelarIts, 1, None);
    let req = h.outbound_request(RouteKind::AxelarIts, HUNDRED);

    assert!(h
        .world
        .router()
        .try_bridge_out_with_gas(&h.world.user, &req, &1_000)
        .is_err());

    let after = h.snapshot(RouteKind::AxelarIts, 1, None);
    assert_eq!(after, before);
    assert_eq!(h.rail().dispatch_count(), 0);
}

#[test]
fn short_transfer_on_inbound_pull_parks_unbacked_delivery_refusal_until_escrow_is_whole() {
    let h = HostileHarness::new();
    h.token().mint(&h.hostile_rail_id, &HUNDRED);
    // 10-stroop flat haircut on pull into router: router receives HUNDRED - 10, so immediate
    // `try_transfer(router -> recipient, HUNDRED)` fails with `InsufficientBalance` and parks a
    // claim rather than silently paying a Haircut amount to the recipient.
    h.token().set_mode(&HostileTokenMode::ShortTransferFlat(10));

    let claim_id = h.rail().deliver_with_auth(
        &h.inbound_delivery(RouteKind::Cctp, HUNDRED, 11),
        &InboundAuthMode::AuthorizedExact,
    );

    assert_eq!(claim_id, 1);
    assert_eq!(h.token().balance(&h.world.recipient), 0);
    assert_eq!(h.token().balance(&h.world.router_id), HUNDRED - 10);
    assert_eq!(h.token().balance(&h.world.treasury), 0);
    assert_eq!(
        h.world
            .router()
            .flow_available(&h.hostile_token_id, &RouteKind::Cctp),
        FLOW_LIMIT
    );
    assert_eq!(h.world.router().last_out_nonce(), 0);
    assert_eq!(
        h.world.router().try_settle_claim(&h.world.user, &claim_id),
        Err(Ok(HyperionError::RecipientNotReady))
    );
}

// ------------------------------------------------------------------------------------------
// Tests: 2. Auth Failures & Selective Leg Failures
// ------------------------------------------------------------------------------------------

#[test]
fn inbound_missing_or_short_sub_auth_rolls_back_replay_marker_and_claims() {
    let h = HostileHarness::new();
    h.token().mint(&h.hostile_rail_id, &(HUNDRED * 2));
    // Enforce real sub-invocation auth without blanket mocked signatures.
    h.world.env.set_auths(&[]);

    let before = h.snapshot(RouteKind::Cctp, 21, None);
    let delivery = h.inbound_delivery(RouteKind::Cctp, HUNDRED, 21);

    // 1. Omitted sub-invocation auth
    assert!(h
        .rail()
        .try_deliver_with_auth(&delivery, &InboundAuthMode::OmitSubAuth)
        .is_err());
    assert_eq!(h.snapshot(RouteKind::Cctp, 21, None), before);

    // 2. Under-authorized pull amount (`HUNDRED - 1` vs `HUNDRED`)
    assert!(h
        .rail()
        .try_deliver_with_auth(
            &delivery,
            &InboundAuthMode::UnderAuthorizeAmount(HUNDRED - 1)
        )
        .is_err());
    assert_eq!(h.snapshot(RouteKind::Cctp, 21, None), before);

    // 3. Authorized wrong target contract
    assert!(h
        .rail()
        .try_deliver_with_auth(
            &delivery,
            &InboundAuthMode::AuthorizeWrongRecipient(h.world.treasury.clone())
        )
        .is_err());
    assert_eq!(h.snapshot(RouteKind::Cctp, 21, None), before);

    // Because `mark_processed` rolled back on every auth failure, the real authorized delivery now
    // succeeds cleanly without hitting `ReplayedMessage`.
    let claim_id = h
        .rail()
        .deliver_with_auth(&delivery, &InboundAuthMode::AuthorizedExact);
    assert_eq!(claim_id, 0);
    assert_eq!(h.token().balance(&h.world.recipient), HUNDRED);
}

#[test]
fn missing_root_sender_auth_and_mid_flight_leg_failures_roll_back_completely() {
    let h = HostileHarness::new();
    let req = h.outbound_request(RouteKind::Cctp, HUNDRED);

    // 1. Missing root signature (`set_auths(&[])`) on `bridge_out`
    h.world.env.set_auths(&[]);
    let before_unauth = h.snapshot(RouteKind::Cctp, 1, None);
    assert!(h
        .world
        .router()
        .try_bridge_out(&h.world.user, &req)
        .is_err());
    assert_eq!(h.snapshot(RouteKind::Cctp, 1, None), before_unauth);

    // Restore root auths and test mid-flight leg failures on leg 2 (treasury fee) and leg 3
    // (adapter push) and adapter `RevertDispatch`.
    h.world.env.mock_all_auths();
    for mode in [
        HostileTokenMode::FailOnTransferCall(2),
        HostileTokenMode::FailOnTransferCall(3),
    ] {
        h.token().set_mode(&mode);
        let before = h.snapshot(RouteKind::Cctp, 1, None);
        assert!(h
            .world
            .router()
            .try_bridge_out(&h.world.user, &req)
            .is_err());
        assert_eq!(h.snapshot(RouteKind::Cctp, 1, None), before);
    }

    h.token().set_mode(&HostileTokenMode::Normal);
    h.rail().set_mode(&HostileRailMode::RevertDispatch);
    let before_rail = h.snapshot(RouteKind::Cctp, 1, None);
    assert!(h
        .world
        .router()
        .try_bridge_out(&h.world.user, &req)
        .is_err());
    assert_eq!(h.snapshot(RouteKind::Cctp, 1, None), before_rail);
}

// ------------------------------------------------------------------------------------------
// Tests: 3. Frozen Recipients & Frozen Treasury
// ------------------------------------------------------------------------------------------

#[test]
fn frozen_recipient_parks_claim_refuses_premature_settlement_and_settles_once_unfrozen() {
    let h = HostileHarness::new();
    h.token().mint(&h.hostile_rail_id, &HUNDRED);
    h.token().set_frozen(&h.world.recipient, &true);

    let claim_id = h.rail().deliver_with_auth(
        &h.inbound_delivery(RouteKind::AxelarGmp, HUNDRED, 31),
        &InboundAuthMode::AuthorizedExact,
    );
    assert_eq!(claim_id, 1);

    let parked = h.snapshot(RouteKind::AxelarGmp, 31, Some(claim_id));
    assert_eq!(parked.treasury_balance, 0);
    assert_eq!(parked.flow_available, FLOW_LIMIT);
    assert_eq!(parked.last_out_nonce, 0);
    assert_eq!(parked.router_balance, HUNDRED);
    assert_eq!(parked.recipient_balance, 0);
    assert_eq!(parked.claim_count, 1);
    assert!(parked.was_processed);
    assert_eq!(
        parked.tracked_claim.as_ref().map(|c| c.settled),
        Some(false)
    );

    // Settling while still frozen returns `RecipientNotReady` and preserves the parked claim.
    assert_eq!(
        h.world.router().try_settle_claim(&h.world.user, &claim_id),
        Err(Ok(HyperionError::RecipientNotReady))
    );
    assert_eq!(h.snapshot(RouteKind::AxelarGmp, 31, Some(claim_id)), parked);

    // Unfreezing allows permissionless settlement to the fixed recipient exactly once.
    h.token().set_frozen(&h.world.recipient, &false);
    h.world.router().settle_claim(&h.world.user, &claim_id);
    assert_eq!(h.token().balance(&h.world.recipient), HUNDRED);
    assert_eq!(h.token().balance(&h.world.router_id), 0);
    assert!(h.world.router().get_claim(&claim_id).settled);
    assert_eq!(
        h.world.router().try_settle_claim(&h.world.user, &claim_id),
        Err(Ok(HyperionError::ClaimAlreadySettled))
    );
}

#[test]
fn frozen_treasury_aborts_outbound_and_preserves_flow_and_nonce() {
    let h = HostileHarness::new();
    h.token().set_frozen(&h.world.treasury, &true);

    let before = h.snapshot(RouteKind::Cctp, 1, None);
    let req = h.outbound_request(RouteKind::Cctp, HUNDRED);

    assert!(h
        .world
        .router()
        .try_bridge_out(&h.world.user, &req)
        .is_err());
    assert_eq!(h.snapshot(RouteKind::Cctp, 1, None), before);
}

// ------------------------------------------------------------------------------------------
// Tests: 4. Callback / Reentrancy Attempts
// ------------------------------------------------------------------------------------------

#[test]
fn token_callback_reentry_during_settle_claim_is_trapped_and_cannot_double_spend() {
    let h = HostileHarness::new();
    h.token().mint(&h.hostile_rail_id, &(HUNDRED * 2));
    // Park claim #1 while recipient is frozen, plus extra router liquidity so a hypothetical
    // reentrant settlement would have funds to steal if reentrancy were not blocked.
    h.token().set_frozen(&h.world.recipient, &true);
    let claim_id = h.rail().deliver_with_auth(
        &h.inbound_delivery(RouteKind::Cctp, HUNDRED, 41),
        &InboundAuthMode::AuthorizedExact,
    );
    let _extra_claim = h.rail().deliver_with_auth(
        &h.inbound_delivery(RouteKind::Cctp, HUNDRED, 42),
        &InboundAuthMode::AuthorizedExact,
    );
    h.token().set_frozen(&h.world.recipient, &false);

    // Configure token to attempt re-entering `settle_claim(claim_id)` inside `transfer`.
    h.token().set_mode(&HostileTokenMode::CallbackSettleClaim(
        h.world.router_id.clone(),
        claim_id,
    ));

    let before = h.snapshot(RouteKind::Cctp, 41, Some(claim_id));
    assert_eq!(
        h.world.router().try_settle_claim(&h.world.user, &claim_id),
        Err(Ok(HyperionError::RecipientNotReady))
    );

    // Neither balance, fee, flow, nonce, nor claim status moved.
    assert_eq!(h.snapshot(RouteKind::Cctp, 41, Some(claim_id)), before);

    // Configure token to attempt re-entering `pause(guardian)` during `bridge_out`.
    h.token().set_mode(&HostileTokenMode::CallbackPause(
        h.world.router_id.clone(),
        h.world.guardian.clone(),
    ));
    let before_out = h.snapshot(RouteKind::Cctp, 41, Some(claim_id));
    let req = h.outbound_request(RouteKind::Cctp, HUNDRED);
    assert!(h
        .world
        .router()
        .try_bridge_out(&h.world.user, &req)
        .is_err());
    assert_eq!(h.snapshot(RouteKind::Cctp, 41, Some(claim_id)), before_out);
    assert!(!h.world.router().get_config().paused);
}

#[test]
fn rail_adapter_callback_reentry_into_router_rolls_back_outbound_state() {
    let h = HostileHarness::new();
    // Park a claim first so `CallbackSettleClaim` targets a real open claim id.
    h.token().mint(&h.hostile_rail_id, &HUNDRED);
    h.token().set_frozen(&h.world.recipient, &true);
    let claim_id = h.rail().deliver_with_auth(
        &h.inbound_delivery(RouteKind::Cctp, HUNDRED, 51),
        &InboundAuthMode::AuthorizedExact,
    );
    h.token().set_frozen(&h.world.recipient, &false);

    let req = h.outbound_request(RouteKind::Cctp, HUNDRED);

    for callback_mode in [
        HostileRailMode::CallbackBridgeOut(h.world.user.clone(), req.clone()),
        HostileRailMode::CallbackBridgeIn(
            RouteKind::Cctp,
            h.hostile_token_id.clone(),
            HUNDRED,
            h.world.recipient.clone(),
        ),
        HostileRailMode::CallbackSettleClaim(h.world.user.clone(), claim_id),
    ] {
        h.rail().set_mode(&callback_mode);
        let before = h.snapshot(RouteKind::Cctp, 999, Some(claim_id));
        assert!(h
            .world
            .router()
            .try_bridge_out(&h.world.user, &req)
            .is_err());
        assert_eq!(h.snapshot(RouteKind::Cctp, 999, Some(claim_id)), before);
    }
}
