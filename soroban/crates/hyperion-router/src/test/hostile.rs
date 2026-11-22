//! Reusable hostile fixtures for the router's token and rail-receiver boundaries.
//!
//! `doubles.rs` holds single-purpose doubles that grew up next to the tests that needed them.
//! This module has the two configurable ones that the boundary suites share:
//!
//! * [`HostileToken`] is a token whose behaviour is set per transfer leg. A rule is keyed by
//!   the address being credited (`to`), so one token can be honest on the user-to-router pull
//!   and short on the router-to-adapter push in the same invocation. The modes are: honest,
//!   frozen recipient, short credit, extra debit, an authorisation the host cannot satisfy,
//!   and an attempt to call back into the router before moving funds.
//! * [`HostileReceiver`] stands in for a rail's inbound receiver that gets the delivery
//!   protocol wrong: it skips the pull pre-authorisation, pre-authorises the wrong amount, or
//!   replays the same message inside one invocation.
//!
//! Both fixtures are deterministic. They read no ledger time, sequence, PRNG or call counter,
//! so a given configuration and operation sequence always produces the same outcome. Their
//! state lives in the fixture contract's own instance storage, which rolls back with the
//! invocation that wrote it. A callback attempt is recorded only when the surrounding
//! transaction commits. Behaviour is documented in `docs/HOSTILE_FIXTURES.md`; keep the two
//! in step.
//!
//! None of this is compiled into the deployed router. It exercises the existing boundary
//! checks without adding runtime state, wire formats or storage keys.

use hyperion_core::{HyperionError, RouteKind};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, vec, Address, Bytes, Env, IntoVal, Symbol, Vec,
};

use super::doubles::{message_id, Delivery, TokenError};
use crate::types::{Origin, OutboundRequest, Recipient};
use crate::HyperionRouterClient;

// ------------------------------------------------------------------------------------------
// HostileToken
// ------------------------------------------------------------------------------------------

/// What a [`HostileToken`] does when asked to credit a particular address.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
// `#[contracttype]` fields cannot be boxed. These are test-only configuration values.
#[allow(clippy::large_enum_variant)]
pub enum Hostility {
    /// Moves exactly `amount`. This is the default for every address.
    Honest,
    /// Refuses with `TokenError::RecipientCannotReceive` and moves nothing. This is the shape
    /// of a frozen or trustline-less recipient.
    Frozen,
    /// Reports success but credits `amount - n` while debiting `amount`. This is a short
    /// transfer, such as a transfer fee taken out of the credit.
    ShortCredit(i128),
    /// Reports success and credits `amount` but debits `amount + n`. This is a hidden
    /// sender-side charge.
    ExtraDebit(i128),
    /// Demands authorisation from an address outside the invocation's auth tree. The host
    /// rejects that as an ordinary authentication failure, the same error a missing or
    /// mismatched signature produces.
    RequireCosigner(Address),
    /// Calls back into the router before moving funds, records whether the host refused the
    /// call, then transfers honestly.
    Reenter(Reentry),
}

/// The router entry point a [`Hostility::Reenter`] rule calls back into.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
// `#[contracttype]` fields cannot be boxed. These are test-only configuration values.
#[allow(clippy::large_enum_variant)]
pub enum Reentry {
    /// `settle_claim(settler, id)` on the given router.
    SettleClaim(Address, Address, u64),
    /// `bridge_out(sender, request)` on the given router.
    BridgeOut(Address, Address, OutboundRequest),
}

/// One recorded callback attempt.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallbackAttempt {
    /// The address being credited when the callback fired.
    pub to: Address,
    /// `true` when the router call failed. The test, not the fixture, decides whether a
    /// refusal is the right outcome.
    pub refused: bool,
}

#[contracttype]
#[derive(Clone)]
enum HostileTokenKey {
    Balance(Address),
    Rule(Address),
    Decimals,
    Attempts,
}

/// A token whose behaviour is configured per credited address. See the module docs.
#[contract]
pub struct HostileToken;

#[contractimpl]
impl HostileToken {
    pub fn init(env: Env, decimals: u32) {
        env.storage()
            .instance()
            .set(&HostileTokenKey::Decimals, &decimals);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let current = Self::balance(env.clone(), to.clone());
        env.storage()
            .instance()
            .set(&HostileTokenKey::Balance(to), &(current + amount));
    }

    /// Install `rule` for transfers that credit `to`. `Hostility::Honest` removes the rule.
    pub fn set_rule(env: Env, to: Address, rule: Hostility) {
        let key = HostileTokenKey::Rule(to);
        if rule == Hostility::Honest {
            env.storage().instance().remove(&key);
        } else {
            env.storage().instance().set(&key, &rule);
        }
    }

    pub fn rule(env: Env, to: Address) -> Hostility {
        env.storage()
            .instance()
            .get(&HostileTokenKey::Rule(to))
            .unwrap_or(Hostility::Honest)
    }

    /// Callback attempts from committed invocations, oldest first.
    pub fn attempts(env: Env) -> Vec<CallbackAttempt> {
        env.storage()
            .instance()
            .get(&HostileTokenKey::Attempts)
            .unwrap_or_else(|| Vec::new(&env))
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
            .unwrap_or(7)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        from.require_auth();
        if amount < 0 {
            return Err(TokenError::NegativeAmount);
        }
        let (debit, credit) = match Self::rule(env.clone(), to.clone()) {
            Hostility::Honest => (amount, amount),
            Hostility::Frozen => return Err(TokenError::RecipientCannotReceive),
            Hostility::ShortCredit(n) => (amount, amount - n),
            Hostility::ExtraDebit(n) => (amount + n, amount),
            Hostility::RequireCosigner(cosigner) => {
                cosigner.require_auth();
                (amount, amount)
            }
            Hostility::Reenter(reentry) => {
                let refused = match reentry {
                    Reentry::SettleClaim(router, settler, id) => {
                        HyperionRouterClient::new(&env, &router)
                            .try_settle_claim(&settler, &id)
                            .is_err()
                    }
                    Reentry::BridgeOut(router, sender, request) => {
                        HyperionRouterClient::new(&env, &router)
                            .try_bridge_out(&sender, &request)
                            .is_err()
                    }
                };
                let mut attempts = Self::attempts(env.clone());
                attempts.push_back(CallbackAttempt {
                    to: to.clone(),
                    refused,
                });
                env.storage()
                    .instance()
                    .set(&HostileTokenKey::Attempts, &attempts);
                (amount, amount)
            }
        };
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < debit {
            return Err(TokenError::InsufficientBalance);
        }
        // Read after the debit is written so a self-transfer cannot mint.
        env.storage()
            .instance()
            .set(&HostileTokenKey::Balance(from), &(from_balance - debit));
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .instance()
            .set(&HostileTokenKey::Balance(to), &(to_balance + credit));
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------
// HostileReceiver
// ------------------------------------------------------------------------------------------

/// How a [`HostileReceiver`] gets the inbound delivery protocol wrong.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReceiverMode {
    /// The same protocol as `MockRail::deliver`: authorise the exact pull, then call in.
    Honest,
    /// Calls `bridge_in` without pre-authorising the router's pull.
    SkipAuthorization,
    /// Pre-authorises a pull of this amount but declares the delivery's own amount to the
    /// router.
    AuthorizeAmount(i128),
    /// Delivers, then submits the same origin again in the same invocation. Two pulls are
    /// pre-authorised, so only replay protection can stop the second one.
    ReplayInSameInvocation,
}

#[contracttype]
#[derive(Clone)]
enum ReceiverKey {
    Router,
    Mode,
    ReplayOutcome,
}

/// A rail receiver that gets the delivery protocol wrong. See the module docs.
#[contract]
pub struct HostileReceiver;

#[contractimpl]
impl HostileReceiver {
    pub fn init(env: Env, router: Address) {
        env.storage().instance().set(&ReceiverKey::Router, &router);
    }

    pub fn set_mode(env: Env, mode: ReceiverMode) {
        env.storage().instance().set(&ReceiverKey::Mode, &mode);
    }

    pub fn mode(env: Env) -> ReceiverMode {
        env.storage()
            .instance()
            .get(&ReceiverKey::Mode)
            .unwrap_or(ReceiverMode::Honest)
    }

    /// The router's answer to the second, replayed `bridge_in` from the last committed
    /// `ReplayInSameInvocation` delivery, as a `HyperionError` code. `0` means the replay was
    /// accepted, which is always a bug.
    pub fn replay_outcome(env: Env) -> Option<u32> {
        env.storage().instance().get(&ReceiverKey::ReplayOutcome)
    }

    pub fn deliver(env: Env, delivery: Delivery) -> Result<u64, HyperionError> {
        let router: Address = env.storage().instance().get(&ReceiverKey::Router).unwrap();
        let mode = Self::mode(env.clone());
        let this = env.current_contract_address();

        let pull = |amount: i128| {
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: delivery.token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (this.clone(), router.clone(), amount).into_val(&env),
                },
                sub_invocations: vec![&env],
            })
        };
        match mode {
            ReceiverMode::Honest => {
                env.authorize_as_current_contract(vec![&env, pull(delivery.amount)]);
            }
            ReceiverMode::SkipAuthorization => {}
            ReceiverMode::AuthorizeAmount(amount) => {
                env.authorize_as_current_contract(vec![&env, pull(amount)]);
            }
            ReceiverMode::ReplayInSameInvocation => {
                env.authorize_as_current_contract(vec![
                    &env,
                    pull(delivery.amount),
                    pull(delivery.amount),
                ]);
            }
        }

        let first = Self::call(&env, &router, &this, &delivery);
        if mode == ReceiverMode::ReplayInSameInvocation {
            let code = match Self::call(&env, &router, &this, &delivery) {
                Ok(_) => 0,
                Err(Some(err)) => err as u32,
                Err(None) => u32::MAX,
            };
            env.storage()
                .instance()
                .set(&ReceiverKey::ReplayOutcome, &code);
        }
        match first {
            Ok(claim_id) => Ok(claim_id),
            Err(Some(err)) => Err(err),
            // A host-level refusal (auth, token abort) has no router error code. Abort so the
            // whole delivery, including anything this receiver wrote, rolls back.
            Err(None) => panic!("the router could not take the delivery"),
        }
    }
}

impl HostileReceiver {
    /// `Err(None)` is a host-level refusal (auth, token abort) that carries no router error.
    fn call(
        env: &Env,
        router: &Address,
        this: &Address,
        delivery: &Delivery,
    ) -> Result<u64, Option<HyperionError>> {
        let outcome = HyperionRouterClient::new(env, router).try_bridge_in(
            this,
            &delivery.route,
            &delivery.token,
            &delivery.amount,
            &Recipient {
                address: delivery.recipient.clone(),
                kind: delivery.recipient_kind,
                raw: Bytes::new(env),
            },
            &Origin {
                chain: delivery.source_chain.clone(),
                nonce: delivery.source_nonce,
                message_id: message_id(env, delivery.source_nonce),
                sender: soroban_sdk::BytesN::from_array(env, &[7u8; 32]),
            },
        );
        match outcome {
            Ok(Ok(claim_id)) => Ok(claim_id),
            Err(Ok(err)) => Err(Some(err)),
            _ => Err(None),
        }
    }
}

/// Route the inbound tests point at a [`HostileReceiver`]. Any route works; CCTP is the one
/// the active Testnet deployment carries.
pub const HOSTILE_ROUTE: RouteKind = RouteKind::Cctp;
