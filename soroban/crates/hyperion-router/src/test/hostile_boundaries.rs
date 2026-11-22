//! The router's real token and receiver boundaries driven by the hostile fixtures.
//!
//! Each test snapshots the router's books (custody, fees, flow window, nonce, dispatch count,
//! claims and liabilities), runs a hostile operation, and checks that a refusal leaves every
//! field unchanged. A retry under honest behaviour must then succeed exactly once, so replay
//! protection and recipient binding hold across the rollback.
extern crate std;

use hyperion_core::{AddressKind, HyperionError, RouteKind};
use soroban_sdk::{testutils::Address as _, token, vec, Address};
use std::vec::Vec;

use super::doubles::{evm_destination, message_id, Delivery};
use super::hostile::{CallbackAttempt, Hostility, ReceiverMode, Reentry, HOSTILE_ROUTE};
use super::setup::{World, FEE_BPS, HUNDRED};
use crate::types::{Destination, OutboundRequest};

const FEE: i128 = HUNDRED * FEE_BPS as i128 / 10_000;

/// Picks the address a rule is installed for, out of a freshly built world.
type Target = fn(&World) -> Address;
/// Builds a rule that may need the world, for example to generate a cosigner.
type RuleFor = fn(&World) -> Hostility;

/// Everything a hostile transfer could corrupt, in one comparable value.
#[derive(Clone, Debug, Eq, PartialEq)]
struct Books {
    user: i128,
    treasury: i128,
    router: i128,
    rail: i128,
    recipient: i128,
    nonce: u64,
    dispatches: u32,
    flow: i128,
    claims: u64,
    outstanding: i128,
}

fn books(w: &World, token: &Address) -> Books {
    let balance = |who: &Address| token::Client::new(&w.env, token).balance(who);
    Books {
        user: balance(&w.user),
        treasury: balance(&w.treasury),
        router: balance(&w.router_id),
        rail: balance(&w.rail_id),
        recipient: balance(&w.recipient),
        nonce: w.router().last_out_nonce(),
        dispatches: w.rail().dispatch_count(),
        flow: w.router().flow_available(token, &RouteKind::Cctp),
        claims: w.router().claim_count(),
        outstanding: w.router().claim_liability(token).outstanding,
    }
}

fn request(w: &World, token: &Address) -> OutboundRequest {
    OutboundRequest {
        token: token.clone(),
        amount: HUNDRED,
        route: RouteKind::Cctp,
        destination: Destination {
            chain: w.ethereum(),
            address: evm_destination(&w.env, 1),
        },
        destination_decimals: 6,
        min_destination_amount: 0,
    }
}

fn delivery(w: &World, token: &Address, nonce: u64) -> Delivery {
    Delivery {
        route: HOSTILE_ROUTE,
        token: token.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: nonce,
    }
}

/// A world with an honest-by-default hostile token, a funded user and a funded rail.
fn hostile_world() -> (World, Address) {
    let w = World::new();
    let token = w.with_hostile_token();
    w.hostile(&token).mint(&w.user, &(HUNDRED * 10));
    w.hostile(&token).mint(&w.rail_id, &(HUNDRED * 10));
    (w, token)
}

// ------------------------------------------------------------------------------------------
// Outbound: user -> router -> treasury / adapter
// ------------------------------------------------------------------------------------------

#[test]
fn every_hostile_outbound_leg_rolls_back_fee_flow_nonce_and_dispatch() {
    // One case per (credited leg, behaviour). Each runs in its own world, so cases cannot leak
    // state into each other.
    let cases: [(&str, Target, RuleFor); 9] = [
        (
            "router",
            |w| w.router_id.clone(),
            |_| Hostility::ShortCredit(1),
        ),
        (
            "router",
            |w| w.router_id.clone(),
            |_| Hostility::ExtraDebit(1),
        ),
        (
            "router",
            |w| w.router_id.clone(),
            |w| Hostility::RequireCosigner(Address::generate(&w.env)),
        ),
        ("treasury", |w| w.treasury.clone(), |_| Hostility::Frozen),
        (
            "treasury",
            |w| w.treasury.clone(),
            |_| Hostility::ShortCredit(1),
        ),
        (
            "treasury",
            |w| w.treasury.clone(),
            |_| Hostility::ExtraDebit(1),
        ),
        ("adapter", |w| w.rail_id.clone(), |_| Hostility::Frozen),
        (
            "adapter",
            |w| w.rail_id.clone(),
            |_| Hostility::ShortCredit(1),
        ),
        (
            "adapter",
            |w| w.rail_id.clone(),
            |w| Hostility::RequireCosigner(Address::generate(&w.env)),
        ),
    ];
    for (leg, target, rule) in cases {
        let (w, token) = hostile_world();
        let target = target(&w);
        let rule = rule(&w);
        w.hostile(&token).set_rule(&target, &rule);
        let before = books(&w, &token);

        let result = w.router().try_bridge_out(&w.user, &request(&w, &token));
        assert!(result.is_err(), "{leg} {rule:?} was accepted");
        assert_eq!(
            books(&w, &token),
            before,
            "{leg} {rule:?} left state behind"
        );

        // The same request under honest behaviour goes through exactly once, with the nonce,
        // fee and flow it would have had if the hostile attempt never happened.
        w.hostile(&token).set_rule(&target, &Hostility::Honest);
        assert_eq!(w.router().bridge_out(&w.user, &request(&w, &token)), 1);
        let after = books(&w, &token);
        assert_eq!(after.user, before.user - HUNDRED, "{leg}");
        assert_eq!(after.treasury, before.treasury + FEE, "{leg}");
        assert_eq!(after.rail, before.rail + HUNDRED - FEE, "{leg}");
        assert_eq!(after.router, before.router, "{leg}");
        assert_eq!(after.dispatches, before.dispatches + 1, "{leg}");
        // The flow window meters what leaves through the rail, which is the net amount.
        assert_eq!(after.flow, before.flow - (HUNDRED - FEE), "{leg}");
        assert_eq!(w.rail().last_dispatch().amount, HUNDRED - FEE, "{leg}");
    }
}

#[test]
fn a_token_callback_cannot_reenter_bridge_out_mid_dispatch() {
    let (w, token) = hostile_world();
    let reentry = Reentry::BridgeOut(w.router_id.clone(), w.user.clone(), request(&w, &token));
    w.hostile(&token)
        .set_rule(&w.rail_id, &Hostility::Reenter(reentry));
    let before = books(&w, &token);

    assert_eq!(w.router().bridge_out(&w.user, &request(&w, &token)), 1);

    assert_eq!(
        w.hostile(&token).attempts(),
        vec![
            &w.env,
            CallbackAttempt {
                to: w.rail_id.clone(),
                refused: true
            }
        ]
    );
    let after = books(&w, &token);
    assert_eq!(after.nonce, 1);
    assert_eq!(after.dispatches, 1);
    assert_eq!(after.user, before.user - HUNDRED);
    assert_eq!(after.treasury, before.treasury + FEE);
    assert_eq!(after.flow, before.flow - (HUNDRED - FEE));
}

// ------------------------------------------------------------------------------------------
// Inbound: receiver -> router -> recipient, and claim settlement
// ------------------------------------------------------------------------------------------

#[test]
fn a_frozen_recipient_gets_a_recipient_bound_claim_that_survives_failed_settlements() {
    let (w, token) = hostile_world();
    w.hostile(&token).set_rule(&w.recipient, &Hostility::Frozen);
    let before = books(&w, &token);

    let id = w.rail().deliver(&delivery(&w, &token, 1));
    assert_eq!(id, 1);
    let parked = books(&w, &token);
    assert_eq!(parked.rail, before.rail - HUNDRED);
    assert_eq!(parked.router, before.router + HUNDRED);
    assert_eq!(parked.recipient, 0);
    assert_eq!(parked.claims, 1);
    assert_eq!(parked.outstanding, HUNDRED);
    let claim = w.router().get_claim(&id);
    assert_eq!(claim.recipient, w.recipient);
    assert_eq!(claim.amount, HUNDRED);
    assert!(!claim.settled);
    assert_eq!(w.router().claim_failure_reason(&id), 1);

    // The message is spent: a second delivery changes nothing.
    assert_eq!(
        w.rail().try_deliver(&delivery(&w, &token, 1)),
        Err(Ok(HyperionError::ReplayedMessage))
    );
    assert_eq!(books(&w, &token), parked);

    // Still frozen: settlement refuses and the claim stays unsettled and counted.
    assert_eq!(
        w.router().try_settle_claim(&w.user, &id),
        Err(Ok(HyperionError::RecipientNotReady))
    );
    assert_eq!(books(&w, &token), parked);
    assert!(!w.router().get_claim(&id).settled);

    // Unfrozen but short: the exact-credit check reverts the settlement, including the
    // settled flag and liability decrement it wrote first.
    w.hostile(&token)
        .set_rule(&w.recipient, &Hostility::ShortCredit(1));
    assert_eq!(
        w.router().try_settle_claim(&w.user, &id),
        Err(Ok(HyperionError::InvalidAmount))
    );
    assert_eq!(books(&w, &token), parked);
    assert!(!w.router().get_claim(&id).settled);

    // Honest: a third party settles, and the funds go to the recorded recipient only.
    let stranger = Address::generate(&w.env);
    w.hostile(&token).set_rule(&w.recipient, &Hostility::Honest);
    w.router().settle_claim(&stranger, &id);
    let settled = books(&w, &token);
    assert_eq!(settled.recipient, HUNDRED);
    assert_eq!(settled.router, before.router);
    assert_eq!(settled.outstanding, 0);
    assert_eq!(w.hostile(&token).balance(&stranger), 0);
    assert!(w.router().get_claim(&id).settled);
    assert_eq!(
        w.router().try_settle_claim(&w.user, &id),
        Err(Ok(HyperionError::ClaimAlreadySettled))
    );
}

#[test]
fn an_inexact_inbound_leg_reverts_the_delivery_and_its_replay_mark() {
    let cases: [(&str, Target, Hostility); 4] = [
        ("pull", |w| w.router_id.clone(), Hostility::ShortCredit(1)),
        ("pull", |w| w.router_id.clone(), Hostility::ExtraDebit(1)),
        ("payout", |w| w.recipient.clone(), Hostility::ShortCredit(1)),
        ("payout", |w| w.recipient.clone(), Hostility::ExtraDebit(1)),
    ];
    for (leg, target, rule) in cases {
        let (w, token) = hostile_world();
        // One unit of stray router custody. Without it an extra debit on the payout leg cannot
        // be paid, so the token refuses with nothing moved, which the router correctly parks as
        // a claim. With it the over-debit actually happens and has to be caught.
        w.hostile(&token).mint(&w.router_id, &1);
        let target = target(&w);
        w.hostile(&token).set_rule(&target, &rule);
        let before = books(&w, &token);

        assert!(
            w.rail().try_deliver(&delivery(&w, &token, 7)).is_err(),
            "{leg} {rule:?} was accepted"
        );
        assert_eq!(books(&w, &token), before, "{leg} {rule:?}");
        assert!(!w
            .router()
            .was_processed(&HOSTILE_ROUTE, &message_id(&w.env, 7)));

        // The rolled-back message can still be delivered, once.
        w.hostile(&token).set_rule(&target, &Hostility::Honest);
        assert_eq!(w.rail().deliver(&delivery(&w, &token, 7)), 0);
        assert_eq!(books(&w, &token).recipient, HUNDRED, "{leg}");
        assert_eq!(
            w.rail().try_deliver(&delivery(&w, &token, 7)),
            Err(Ok(HyperionError::ReplayedMessage))
        );
        assert_eq!(books(&w, &token).recipient, HUNDRED, "{leg}");
    }
}

#[test]
fn an_unsatisfiable_recipient_authorisation_parks_instead_of_stranding_funds() {
    let (w, token) = hostile_world();
    let cosigner = Address::generate(&w.env);
    w.hostile(&token)
        .set_rule(&w.recipient, &Hostility::RequireCosigner(cosigner));

    let id = w.rail().deliver(&delivery(&w, &token, 3));
    assert_eq!(id, 1);
    let parked = books(&w, &token);
    assert_eq!(parked.router, HUNDRED);
    assert_eq!(parked.outstanding, HUNDRED);
    assert_eq!(w.router().get_claim(&id).recipient, w.recipient);

    // The auth failure persists, so settlement refuses and changes nothing.
    assert_eq!(
        w.router().try_settle_claim(&w.user, &id),
        Err(Ok(HyperionError::RecipientNotReady))
    );
    assert_eq!(books(&w, &token), parked);

    w.hostile(&token).set_rule(&w.recipient, &Hostility::Honest);
    w.router().settle_claim(&w.user, &id);
    assert_eq!(books(&w, &token).recipient, HUNDRED);
    assert_eq!(books(&w, &token).outstanding, 0);
}

#[test]
fn a_token_callback_cannot_settle_a_claim_from_inside_a_payout() {
    let (w, token) = hostile_world();
    w.hostile(&token).set_rule(&w.recipient, &Hostility::Frozen);
    let id = w.rail().deliver(&delivery(&w, &token, 1));

    // A second delivery to the same recipient pays out directly. The token uses that payout to
    // try settling the first claim from inside the router's own call.
    let reenter = Hostility::Reenter(Reentry::SettleClaim(
        w.router_id.clone(),
        w.user.clone(),
        id,
    ));
    w.hostile(&token).set_rule(&w.recipient, &reenter);
    assert_eq!(w.rail().deliver(&delivery(&w, &token, 2)), 0);
    let after_second = books(&w, &token);
    assert_eq!(after_second.recipient, HUNDRED);
    assert_eq!(after_second.outstanding, HUNDRED);
    assert!(!w.router().get_claim(&id).settled);

    // The same callback fired during settlement of that very claim cannot pay it twice.
    w.router().settle_claim(&w.user, &id);
    let settled = books(&w, &token);
    assert_eq!(settled.recipient, HUNDRED * 2);
    assert_eq!(settled.router, 0);
    assert_eq!(settled.outstanding, 0);

    let refused = CallbackAttempt {
        to: w.recipient.clone(),
        refused: true,
    };
    assert_eq!(
        w.hostile(&token).attempts(),
        vec![&w.env, refused.clone(), refused]
    );
}

// ------------------------------------------------------------------------------------------
// Rail receiver protocol errors, with real signatures and the real Stellar Asset Contract
// ------------------------------------------------------------------------------------------

#[test]
fn a_receiver_that_skips_or_misstates_the_pull_authorisation_delivers_nothing() {
    for mode in [
        ReceiverMode::SkipAuthorization,
        ReceiverMode::AuthorizeAmount(HUNDRED - 1),
        ReceiverMode::AuthorizeAmount(HUNDRED + 1),
    ] {
        let w = World::new();
        let receiver = w.with_hostile_receiver(HOSTILE_ROUTE);
        w.sac().mint(&receiver.address, &HUNDRED);
        receiver.set_mode(&mode);
        // From here only the receiver's own pre-authorisation can satisfy the pull.
        w.env.set_auths(&[]);
        let before = (
            w.token().balance(&receiver.address),
            w.token().balance(&w.router_id),
            w.token().balance(&w.recipient),
            w.router().claim_count(),
        );

        assert!(
            receiver.try_deliver(&delivery(&w, &w.token_id, 5)).is_err(),
            "{mode:?} was accepted"
        );
        let after = (
            w.token().balance(&receiver.address),
            w.token().balance(&w.router_id),
            w.token().balance(&w.recipient),
            w.router().claim_count(),
        );
        assert_eq!(after, before, "{mode:?}");
        assert!(!w
            .router()
            .was_processed(&HOSTILE_ROUTE, &message_id(&w.env, 5)));

        receiver.set_mode(&ReceiverMode::Honest);
        assert_eq!(receiver.deliver(&delivery(&w, &w.token_id, 5)), 0);
        assert_eq!(w.token().balance(&w.recipient), HUNDRED, "{mode:?}");
    }
}

#[test]
fn a_receiver_replaying_inside_one_invocation_is_paid_out_once() {
    let w = World::new();
    let receiver = w.with_hostile_receiver(HOSTILE_ROUTE);
    w.sac().mint(&receiver.address, &(HUNDRED * 2));
    receiver.set_mode(&ReceiverMode::ReplayInSameInvocation);
    w.env.set_auths(&[]);

    assert_eq!(receiver.deliver(&delivery(&w, &w.token_id, 9)), 0);
    assert_eq!(
        receiver.replay_outcome(),
        Some(HyperionError::ReplayedMessage as u32)
    );
    assert_eq!(w.token().balance(&w.recipient), HUNDRED);
    assert_eq!(w.token().balance(&receiver.address), HUNDRED);
    assert_eq!(w.token().balance(&w.router_id), 0);
    assert_eq!(w.router().claim_count(), 0);
}

// ------------------------------------------------------------------------------------------
// Determinism
// ------------------------------------------------------------------------------------------

/// A scripted pass over every token mode. It returns each step's success flag and the books
/// after it.
fn scripted_run() -> Vec<(bool, Books)> {
    let (w, token) = hostile_world();
    let mut trace = Vec::new();
    let mut record = |ok: bool, w: &World| trace.push((ok, books(w, &token)));
    let hostile = w.hostile(&token);
    let rules = [
        (w.router_id.clone(), Hostility::ShortCredit(3)),
        (w.rail_id.clone(), Hostility::ExtraDebit(2)),
        (w.treasury.clone(), Hostility::Frozen),
        (w.recipient.clone(), Hostility::Frozen),
    ];
    for (step, (target, rule)) in rules.iter().enumerate() {
        hostile.set_rule(target, rule);
        record(
            w.router()
                .try_bridge_out(&w.user, &request(&w, &token))
                .is_ok(),
            &w,
        );
        record(
            w.rail()
                .try_deliver(&delivery(&w, &token, 11 + step as u64))
                .is_ok(),
            &w,
        );
        record(w.router().try_settle_claim(&w.user, &1).is_ok(), &w);
        hostile.set_rule(target, &Hostility::Honest);
    }
    record(w.router().try_settle_claim(&w.user, &1).is_ok(), &w);
    trace
}

#[test]
fn hostile_fixture_outcomes_are_deterministic_across_fresh_worlds() {
    let first = scripted_run();
    assert_eq!(first, scripted_run());
    // Spot check that the script went through refusals, a parked claim and its settlement
    // rather than trivially repeating one outcome.
    assert!(first.iter().any(|(ok, _)| !ok));
    assert!(first.iter().any(|(_, b)| b.outstanding == HUNDRED));
    assert!(first.last().unwrap().0);
    assert_eq!(first.last().unwrap().1.outstanding, 0);
}
