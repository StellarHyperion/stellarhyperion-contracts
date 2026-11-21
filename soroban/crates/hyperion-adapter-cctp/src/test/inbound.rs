//! The leg where Circle mints on Stellar and Hyperion works out who the money belongs to.

use hyperion_core::{codec, HyperionError, RouteKind};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Bytes, BytesN, IntoVal,
};

use super::setup::{World, ETHEREUM_DOMAIN, UNLINKED_DOMAIN};

/// Fifty units of a seven decimal asset, as CCTP would carry them.
const ARRIVING: i128 = 500_000_000;

fn nonce_word(w: &World, tail: u64) -> BytesN<32> {
    let mut raw = [0u8; 32];
    raw[24..].copy_from_slice(&tail.to_be_bytes());
    BytesN::from_array(&w.env, &raw)
}

// ------------------------------------------------------------------------------------------
// The happy path
// ------------------------------------------------------------------------------------------

#[test]
fn an_attested_message_mints_and_pays_the_destination_named_in_the_hook() {
    let w = World::new();

    let claim_id = w
        .adapter()
        .receive(&w.relayer, &w.inbound(ARRIVING, 7), &w.attestation());

    // Zero means it went all the way through with nothing left parked.
    assert_eq!(claim_id, 0);
    assert_eq!(w.token().balance(&w.recipient), ARRIVING);
    // Neither the adapter nor the router keeps a stroop of it.
    assert_eq!(w.token().balance(&w.adapter_id), 0);
    assert_eq!(w.token().balance(&w.router_id), 0);
    // The router has written the message down, so the second attempt has something to trip over.
    assert!(w
        .router()
        .was_processed(&RouteKind::Cctp, &nonce_word(&w, 7)));
    // No fee on the way in. The protocol charges the sender on the outbound leg and the recipient
    // is not billed twice for the same transfer.
    assert_eq!(w.token().balance(&w.treasury), 0);
}

#[test]
fn the_relayer_signs_for_the_call_and_for_nothing_else() {
    let w = World::new();
    let message = w.inbound(ARRIVING, 1);
    let attestation = w.attestation();

    // One signature, naming one contract and one function, with no sub-invocations under it. Every
    // deeper permission on this path is either implicit because the adapter is the direct invoker,
    // or granted by the adapter itself for exactly one transfer. Nothing here is blanket mocked.
    w.env.mock_auths(&[MockAuth {
        address: &w.relayer,
        invoke: &MockAuthInvoke {
            contract: &w.adapter_id,
            fn_name: "receive",
            args: (w.relayer.clone(), message.clone(), attestation.clone()).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);

    assert_eq!(w.adapter().receive(&w.relayer, &message, &attestation), 0);
    assert_eq!(w.token().balance(&w.recipient), ARRIVING);
}

#[test]
fn anybody_at_all_can_be_the_relayer() {
    let w = World::new();
    // The relayer picks the moment and pays the fee. They cannot change where a single stroop
    // goes, because the destination came out of a message Circle signed.
    let passer_by = Address::generate(&w.env);
    w.adapter()
        .receive(&passer_by, &w.inbound(ARRIVING, 2), &w.attestation());
    assert_eq!(w.token().balance(&w.recipient), ARRIVING);
    assert_eq!(w.token().balance(&passer_by), 0);
}

#[test]
fn what_gets_delivered_is_what_arrived_not_what_was_sent() {
    let w = World::new();
    // Circle charged for a fast attestation. The burn message still says fifty units, because
    // that is what the sender asked for, and believing it would mean the adapter trying to pass on
    // money that never got minted.
    w.transmitter().set_fee(&250_000);

    w.adapter()
        .receive(&w.relayer, &w.inbound(ARRIVING, 3), &w.attestation());
    assert_eq!(w.token().balance(&w.recipient), ARRIVING - 250_000);
    assert_eq!(w.token().balance(&w.adapter_id), 0);
}

#[test]
fn the_same_thirty_two_bytes_mean_two_different_places_depending_on_the_tag() {
    let w = World::new();
    // One key, sent twice, tagged differently each time. This is the entire reason Hyperion
    // carries a tag at all: a raw 32 byte cross-chain field says nothing about whether it holds
    // an ed25519 public key or a contract id, and the two are different places on this network
    // even when the bytes are identical.
    let as_contract = Address::from_string(&codec::contract_strkey(&w.env, &w.classic_key));

    let hook = w.hook_to_contract(&as_contract);
    let claim_id = w.adapter().receive(
        &w.relayer,
        &w.inbound_with_hook(ARRIVING, 4, hook),
        &w.attestation(),
    );
    // The contract takes it straight away, because a contract has no trustline to open.
    assert_eq!(claim_id, 0);
    assert_eq!(w.token().balance(&as_contract), ARRIVING);

    // The same bytes read as an account land somewhere else entirely, and that somewhere cannot
    // hold the asset yet, so this one parks.
    let parked = w.adapter().receive(
        &w.relayer,
        &w.inbound_to_classic(ARRIVING, 5),
        &w.attestation(),
    );
    assert_eq!(parked, 1);
    assert_eq!(w.token().balance(&as_contract), ARRIVING);
}

#[test]
fn two_different_messages_both_get_through() {
    let w = World::new();
    w.adapter()
        .receive(&w.relayer, &w.inbound(ARRIVING, 10), &w.attestation());
    w.adapter()
        .receive(&w.relayer, &w.inbound(ARRIVING, 11), &w.attestation());
    assert_eq!(w.token().balance(&w.recipient), ARRIVING * 2);
    assert_eq!(w.router().claim_count(), 0);
}

#[test]
fn an_arrival_does_not_eat_into_the_outbound_flow_limit() {
    let w = World::new();
    let before = w.router().flow_available(&w.token_id, &RouteKind::Cctp);
    w.adapter()
        .receive(&w.relayer, &w.inbound(ARRIVING, 12), &w.attestation());
    // The limit caps how fast value can leave. This was value arriving, and throttling it would
    // only mean stranding money whose counterpart is already burned.
    assert_eq!(
        w.router().flow_available(&w.token_id, &RouteKind::Cctp),
        before
    );
}

// ------------------------------------------------------------------------------------------
// Replay
// ------------------------------------------------------------------------------------------

#[test]
fn the_same_message_cannot_be_delivered_twice() {
    let w = World::new();
    let message = w.inbound(ARRIVING, 20);
    w.adapter().receive(&w.relayer, &message, &w.attestation());

    // Two independent walls stand here. Circle's transmitter will not process a nonce it has
    // already spent, and the router will not accept a message id it has already recorded. This
    // one hits Circle's first, which unwinds the whole transaction.
    assert!(w
        .adapter()
        .try_receive(&w.relayer, &message, &w.attestation())
        .is_err());
    assert_eq!(w.token().balance(&w.recipient), ARRIVING);
    assert!(w
        .router()
        .was_processed(&RouteKind::Cctp, &nonce_word(&w, 20)));
}

#[test]
fn a_message_with_no_attestation_behind_it_goes_nowhere() {
    let w = World::new();
    // The adapter never inspects a signature and would not know a valid one if it saw one. This
    // test exists to prove the refusal still happens, from inside Circle's contract, which is
    // where every attestation check in Hyperion lives.
    assert!(w
        .adapter()
        .try_receive(&w.relayer, &w.inbound(ARRIVING, 21), &Bytes::new(&w.env))
        .is_err());
    assert_eq!(w.token().balance(&w.recipient), 0);
    assert!(!w
        .router()
        .was_processed(&RouteKind::Cctp, &nonce_word(&w, 21)));
}

// ------------------------------------------------------------------------------------------
// Messages that are not ours
// ------------------------------------------------------------------------------------------

#[test]
fn a_message_bound_for_another_chain_is_not_ours_to_process() {
    let w = World::new();
    let mut spec = w.spec(ARRIVING, 30, w.hook_to_recipient());
    spec.destination_domain = 3;
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &spec.encode(&w.env), &w.attestation()),
        Err(Ok(HyperionError::WrongDomain))
    );
}

#[test]
fn a_message_addressed_to_anything_but_circles_minter_is_refused() {
    let w = World::new();
    let mut spec = w.spec(ARRIVING, 31, w.hook_to_recipient());
    // A message for some other contract on this domain. Whatever it means, it does not mean a
    // USDC burn, and handing it to the transmitter on the chance it works out is not a plan.
    spec.recipient = [0x77u8; 32];
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &spec.encode(&w.env), &w.attestation()),
        Err(Ok(HyperionError::UnexpectedRailContract))
    );
}

#[test]
fn a_message_that_mints_to_somebody_else_is_none_of_our_business() {
    let w = World::new();
    let mut spec = w.spec(ARRIVING, 32, w.hook_to_recipient());
    spec.mint_recipient = [0x66u8; 32];
    // Processing this would spend Circle's nonce on somebody else's transfer and mint nothing
    // here, so the balance delta would be zero and the whole thing would unwind anyway. Naming
    // the real reason is cheaper and far easier to debug.
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &spec.encode(&w.env), &w.attestation()),
        Err(Ok(HyperionError::NotMintRecipient))
    );
}

#[test]
fn a_source_domain_the_admin_never_linked_is_refused() {
    let w = World::new();
    let mut spec = w.spec(ARRIVING, 33, w.hook_to_recipient());
    spec.source_domain = UNLINKED_DOMAIN;
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &spec.encode(&w.env), &w.attestation()),
        Err(Ok(HyperionError::UnknownChain))
    );
}

#[test]
fn forged_header_or_burn_sender_is_refused() {
    let w = World::new();

    let mut header = w.spec(ARRIVING, 34, w.hook_to_recipient());
    header.sender = [0xDEu8; 32];
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &header.encode(&w.env), &w.attestation()),
        Err(Ok(HyperionError::UnexpectedRailContract))
    );

    let mut body = w.spec(ARRIVING, 35, w.hook_to_recipient());
    body.message_sender = [0xDEu8; 32];
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &body.encode(&w.env), &w.attestation()),
        Err(Ok(HyperionError::UnexpectedRailContract))
    );
}

#[test]
fn a_burn_token_nobody_mapped_is_refused() {
    let w = World::new();
    let mut spec = w.spec(ARRIVING, 34, w.hook_to_recipient());
    // Some other ERC20 on Ethereum. The mapping is the allowlist, and an empty entry means the
    // adapter has no idea which local asset this is supposed to become.
    spec.burn_token = [0xDEu8; 32];
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &spec.encode(&w.env), &w.attestation()),
        Err(Ok(HyperionError::TokenNotMapped))
    );
}

#[test]
fn a_version_this_contract_does_not_know_is_refused_rather_than_guessed_at() {
    let w = World::new();

    let mut header = w.spec(ARRIVING, 35, w.hook_to_recipient());
    header.version = 2;
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &header.encode(&w.env), &w.attestation()),
        Err(Ok(HyperionError::UnsupportedMessageVersion))
    );

    let mut body = w.spec(ARRIVING, 36, w.hook_to_recipient());
    body.burn_version = 2;
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &body.encode(&w.env), &w.attestation()),
        Err(Ok(HyperionError::UnsupportedMessageVersion))
    );
}

#[test]
fn a_message_too_short_to_hold_a_header_is_refused_rather_than_read_past_the_end() {
    let w = World::new();
    let full = w.inbound(ARRIVING, 37);
    for cut in [0u32, 1, 147, 148, 375] {
        let truncated = full.slice(0..cut);
        assert_eq!(
            w.adapter()
                .try_receive(&w.relayer, &truncated, &w.attestation()),
            Err(Ok(HyperionError::MalformedMessage))
        );
    }
}

// ------------------------------------------------------------------------------------------
// Destinations
// ------------------------------------------------------------------------------------------

#[test]
fn a_message_with_no_hook_at_all_has_nowhere_to_pay_and_is_refused() {
    let w = World::new();
    // A plain CCTP transfer that happens to name this adapter as its mint recipient. There is no
    // destination anywhere in it, and the honest answer is that we cannot deliver it.
    assert_eq!(
        w.adapter().try_receive(
            &w.relayer,
            &w.inbound_with_hook(ARRIVING, 40, Bytes::new(&w.env)),
            &w.attestation()
        ),
        Err(Ok(HyperionError::InvalidDestination))
    );
    assert_eq!(w.token().balance(&w.adapter_id), 0);
}

#[test]
fn a_hook_version_from_the_future_is_refused_rather_than_read_hopefully() {
    let w = World::new();
    let mut hook = w.hook_to_recipient();
    hook.set(0, 9);
    // A payload this contract cannot read is a destination it would be guessing at, and guessing
    // here means paying the wrong person irreversibly.
    assert_eq!(
        w.adapter().try_receive(
            &w.relayer,
            &w.inbound_with_hook(ARRIVING, 41, hook),
            &w.attestation()
        ),
        Err(Ok(HyperionError::UnsupportedHookVersion))
    );
}

#[test]
fn a_hook_pointing_at_the_zero_key_is_refused() {
    let w = World::new();
    let hook = w.hook_to_nobody();
    assert_eq!(
        w.adapter().try_receive(
            &w.relayer,
            &w.inbound_with_hook(ARRIVING, 42, hook),
            &w.attestation()
        ),
        Err(Ok(HyperionError::ZeroAddressKey))
    );
}

#[test]
fn a_muxed_destination_is_refused_before_anything_is_minted() {
    let w = World::new();
    let hook = w.hook_to_muxed();

    // This is the whole reason the destination is resolved ahead of the mint. CCTP cannot carry a
    // muxed id, so delivering this would credit the base account and silently drop the subaccount
    // the sender cared about. Finding that out after the mint would leave freshly minted tokens in
    // an adapter with nowhere to send them and a burn on the far side that cannot be undone.
    assert_eq!(
        w.adapter().try_receive(
            &w.relayer,
            &w.inbound_with_hook(ARRIVING, 43, hook),
            &w.attestation()
        ),
        Err(Ok(HyperionError::MuxedNotSupported))
    );
    assert_eq!(w.token().balance(&w.adapter_id), 0);
    assert_eq!(w.token().balance(&w.recipient), 0);
    // And Circle's nonce is untouched, so the relayer can try the lane again once a forwarder
    // exists for it.
    assert!(!w
        .router()
        .was_processed(&RouteKind::Cctp, &nonce_word(&w, 43)));
}

// ------------------------------------------------------------------------------------------
// When the mint does not happen
// ------------------------------------------------------------------------------------------

#[test]
fn a_mint_that_produces_nothing_is_refused_rather_than_reported_as_a_success() {
    let w = World::new();
    // The transmitter accepts the message and mints nothing, which is what an unrecognised token
    // pairing looks like from the outside. Returning a claim id here would tell a user their money
    // arrived when it did not.
    w.transmitter().set_mute(&true);
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &w.inbound(ARRIVING, 50), &w.attestation()),
        Err(Ok(HyperionError::NothingMinted))
    );
    assert_eq!(w.token().balance(&w.recipient), 0);
}

#[test]
fn a_mint_swallowed_entirely_by_the_fee_is_refused() {
    let w = World::new();
    // Circle taking the whole amount should not be possible, and if it ever is, the answer is a
    // refusal rather than a delivery of nothing.
    w.transmitter().set_fee(&ARRIVING);
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &w.inbound(ARRIVING, 51), &w.attestation()),
        Err(Ok(HyperionError::NothingMinted))
    );
}

#[test]
fn an_arrival_gets_through_even_while_new_departures_are_paused() {
    let w = World::new();
    w.router().pause(&w.guardian);

    // The burn on the far side already happened. Refusing the arrival does not undo it, it only
    // leaves the money nowhere, so pause deliberately has no say on this leg.
    let claim_id = w
        .adapter()
        .receive(&w.relayer, &w.inbound(ARRIVING, 52), &w.attestation());
    assert_eq!(claim_id, 0);
    assert_eq!(w.token().balance(&w.recipient), ARRIVING);
}

#[test]
fn an_adapter_the_router_has_stopped_trusting_cannot_deliver_anything() {
    let w = World::new();
    // Point the rail receiver at something else, which is how an operator retires a compromised
    // adapter. The old one still holds its Circle wiring and can still make Circle mint, but the
    // router will not take a delivery from it, so the funds stop here rather than reaching anyone.
    let replacement = Address::generate(&w.env);
    w.run_action(hyperion_router::AdminAction::SetRailReceiver(
        RouteKind::Cctp,
        replacement,
    ));

    assert!(w
        .adapter()
        .try_receive(&w.relayer, &w.inbound(ARRIVING, 53), &w.attestation())
        .is_err());
    assert_eq!(w.token().balance(&w.recipient), 0);
}

#[test]
fn an_unmapped_lane_refuses_before_it_ever_reaches_circle() {
    let w = World::unlinked();
    // Deployed, wired to the router, and pointed at Circle, but nobody has said which domain is
    // which chain yet. Every arrival is refused until they do.
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &w.inbound(ARRIVING, 54), &w.attestation()),
        Err(Ok(HyperionError::UnknownChain))
    );
    // And the lane opens the moment the admin links it and maps the asset.
    w.link_ethereum();
    w.adapter()
        .map_asset(&ETHEREUM_DOMAIN, &w.eth_usdc(), &w.token_id);
    assert_eq!(
        w.adapter()
            .receive(&w.relayer, &w.inbound(ARRIVING, 54), &w.attestation()),
        0
    );
    assert_eq!(w.token().balance(&w.recipient), ARRIVING);
}

// ------------------------------------------------------------------------------------------
// A recipient who cannot receive
// ------------------------------------------------------------------------------------------
//
// These are the tests that made the whole parked-claim mechanism worth building. A classic
// Stellar account holds nothing until it has opened a trustline for the asset, and an account
// that has not opened one refuses the transfer. On the way out that would be an annoyance. On
// the way in the burn on the far side has already happened, so refusing means the money exists
// on Stellar and belongs to nobody. The router keeps it instead and writes down whose it is.

#[test]
fn an_account_with_no_trustline_leaves_the_money_with_the_router_as_a_claim() {
    let w = World::new();

    let claim_id = w.adapter().receive(
        &w.relayer,
        &w.inbound_to_classic(ARRIVING, 60),
        &w.attestation(),
    );

    // A claim id rather than the zero that means delivered.
    assert_eq!(claim_id, 1);
    assert_eq!(w.router().claim_count(), 1);
    // The adapter kept nothing. The router is holding it, which is the only place it can sit
    // where exactly one person is entitled to it and nobody else can move it.
    assert_eq!(w.token().balance(&w.adapter_id), 0);
    assert_eq!(w.token().balance(&w.router_id), ARRIVING);
    assert_eq!(w.token().balance(&w.treasury), 0);
    // And the message still counts as processed, so a second relayer cannot turn one burn into
    // two claims.
    assert!(w
        .router()
        .was_processed(&RouteKind::Cctp, &nonce_word(&w, 60)));
}

#[test]
fn a_parked_claim_says_who_it_belongs_to_and_where_it_came_from() {
    let w = World::new();
    w.adapter().receive(
        &w.relayer,
        &w.inbound_to_classic(ARRIVING, 61),
        &w.attestation(),
    );

    let claim = w.router().get_claim(&1);
    assert_eq!(claim.id, 1);
    // The account out of the hook, not the adapter and not the relayer.
    assert_eq!(claim.recipient, w.classic);
    assert_eq!(claim.token, w.token_id);
    assert_eq!(claim.amount, ARRIVING);
    assert_eq!(claim.route, RouteKind::Cctp);
    // The chain name the admin linked to Circle's domain zero, and the tail of Circle's own
    // nonce. Both come off the wire, travel through the adapter, and survive into storage, which
    // is the only way a support conversation about a stuck transfer can go anywhere.
    assert_eq!(claim.source_chain, w.ethereum());
    assert_eq!(claim.source_nonce, 61);
    assert!(!claim.settled);
}

#[test]
fn settling_a_claim_for_an_account_that_still_cannot_receive_is_refused() {
    let w = World::new();
    w.adapter().receive(
        &w.relayer,
        &w.inbound_to_classic(ARRIVING, 62),
        &w.attestation(),
    );

    // Settling is permissionless, so a passer by is allowed to try. What they are not allowed to
    // do is mark the claim paid when the transfer did not happen, and the account still has no
    // trustline, so it does not.
    let passer_by = Address::generate(&w.env);
    assert_eq!(
        w.router().try_settle_claim(&passer_by, &1),
        Err(Ok(HyperionError::RecipientNotReady))
    );
    // Untouched, and still claimable the moment the recipient opens a trustline.
    assert!(!w.router().get_claim(&1).settled);
    assert_eq!(w.token().balance(&w.router_id), ARRIVING);
}

#[test]
fn two_stuck_arrivals_are_two_separate_claims_rather_than_one_pile() {
    let w = World::new();
    w.adapter().receive(
        &w.relayer,
        &w.inbound_to_classic(ARRIVING, 63),
        &w.attestation(),
    );
    w.adapter().receive(
        &w.relayer,
        &w.inbound_with_hook(700_000_000, 64, w.hook_to_account(&[0x77u8; 32])),
        &w.attestation(),
    );

    assert_eq!(w.router().claim_count(), 2);
    assert_eq!(w.router().get_claim(&1).amount, ARRIVING);
    assert_eq!(w.router().get_claim(&2).amount, 700_000_000);
    // Different recipients, which is why they cannot be merged.
    assert_ne!(
        w.router().get_claim(&1).recipient,
        w.router().get_claim(&2).recipient
    );
    assert_eq!(w.token().balance(&w.router_id), ARRIVING + 700_000_000);
}

#[test]
fn a_claim_nobody_ever_made_cannot_be_settled() {
    let w = World::new();
    assert_eq!(
        w.router().try_settle_claim(&w.relayer, &99),
        Err(Ok(HyperionError::ClaimNotFound))
    );
}
