use super::setup::{net_of, World, EVM_DECIMALS, HUNDRED};
use hyperion_core::{HyperionError, RouteKind};
use hyperion_router::{Destination, OutboundRequest};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Bytes, BytesN, IntoVal,
};

fn request(w: &World) -> OutboundRequest {
    let mut recipient = [0u8; 32];
    recipient[12..].fill(0x11);
    OutboundRequest {
        token: w.token_id.clone(),
        amount: HUNDRED,
        route: RouteKind::Cctp,
        destination: Destination {
            chain: w.ethereum(),
            address: BytesN::from_array(&w.env, &recipient),
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    }
}

#[test]
fn forwarding_budget_is_part_of_the_burn_and_never_an_extra_wallet_debit() {
    let w = World::new();
    let before = w.token().balance(&w.user);
    w.router()
        .bridge_out_with_gas(&w.user, &request(&w), &1_000_000);
    let burn = w.messenger().last_burn();
    assert_eq!(burn.amount, net_of(HUNDRED));
    assert_eq!(burn.max_fee, 1_000_000);
    assert!(burn.had_hook);
    let mut hook = [0u8; 32];
    hook[..12].copy_from_slice(b"cctp-forward");
    assert_eq!(w.messenger().last_hook(), Bytes::from_array(&w.env, &hook));
    assert_eq!(w.token().balance(&w.user), before - HUNDRED);
    assert_eq!(w.token().balance(&w.adapter_id), 0);
    assert_eq!(w.token().allowance(&w.adapter_id, &w.messenger_id), 0);
}

#[test]
fn minimum_receive_is_enforced_after_the_entire_circle_fee_budget() {
    let w = World::new();
    let before = w.token().balance(&w.user);
    let mut req = request(&w);
    req.min_destination_amount = net_of(HUNDRED) / 10;
    assert_eq!(
        w.router()
            .try_bridge_out_with_gas(&w.user, &req, &1_000_000),
        Err(Ok(HyperionError::SlippageExceeded))
    );
    assert_eq!(w.token().balance(&w.user), before);
    assert_eq!(w.messenger().burn_count(), 0);
    req.min_destination_amount = (net_of(HUNDRED) - 1_000_000) / 10;
    w.router().bridge_out_with_gas(&w.user, &req, &1_000_000);
    assert_eq!(w.messenger().burn_count(), 1);
}

#[test]
fn invalid_or_unrepresentable_fee_budgets_never_move_funds() {
    let w = World::new();
    let before = w.token().balance(&w.user);
    for fee in [-1, 0, 1, net_of(HUNDRED), HUNDRED * 2] {
        assert!(w
            .router()
            .try_bridge_out_with_gas(&w.user, &request(&w), &fee)
            .is_err());
        assert_eq!(w.token().balance(&w.user), before);
        assert_eq!(w.messenger().burn_count(), 0);
    }
}

#[test]
fn strangers_and_restricted_destination_callers_cannot_request_forwarding() {
    let w = World::new();
    let stranger = Address::generate(&w.env);
    let req = request(&w);
    assert_eq!(
        w.adapter().try_dispatch_from(
            &stranger,
            &w.user,
            &w.token_id,
            &net_of(HUNDRED),
            &w.ethereum(),
            &req.destination.address,
            &1,
            &1_000_000
        ),
        Err(Ok(HyperionError::Unauthorized))
    );
    w.adapter()
        .link_domain(&w.ethereum(), &0, &BytesN::from_array(&w.env, &[1; 32]));
    assert_eq!(
        w.router()
            .try_bridge_out_with_gas(&w.user, &req, &1_000_000),
        Err(Ok(HyperionError::InvalidDestination))
    );
    assert_eq!(w.messenger().burn_count(), 0);
}

#[test]
fn a_wallet_signature_authorizes_the_exact_fee_and_burn_without_a_contract_signature() {
    let w = World::new();
    let req = request(&w);
    let fee = HUNDRED - net_of(HUNDRED);
    w.env.mock_auths(&[MockAuth {
        address: &w.user,
        invoke: &MockAuthInvoke {
            contract: &w.router_id,
            fn_name: "bridge_out_with_gas",
            args: (w.user.clone(), req.clone(), 1_000_000i128).into_val(&w.env),
            sub_invokes: &[
                MockAuthInvoke {
                    contract: &w.token_id,
                    fn_name: "transfer",
                    args: (w.user.clone(), w.treasury.clone(), fee).into_val(&w.env),
                    sub_invokes: &[],
                },
                MockAuthInvoke {
                    contract: &w.adapter_id,
                    fn_name: "dispatch_from",
                    args: (
                        w.router_id.clone(),
                        w.user.clone(),
                        w.token_id.clone(),
                        net_of(HUNDRED),
                        w.ethereum(),
                        req.destination.address.clone(),
                        1u64,
                        1_000_000i128,
                    )
                        .into_val(&w.env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &w.token_id,
                        fn_name: "transfer",
                        args: (w.user.clone(), w.adapter_id.clone(), net_of(HUNDRED))
                            .into_val(&w.env),
                        sub_invokes: &[],
                    }],
                },
            ],
        },
    }]);
    w.router().bridge_out_with_gas(&w.user, &req, &1_000_000);
    assert_eq!(w.messenger().burn_count(), 1);
}
