use super::setup::{net_of, World, HUNDRED};
use hyperion_core::{HyperionError, RouteKind};
use hyperion_router::{Destination, OutboundRequest};
use soroban_sdk::{
    testutils::{MockAuth, MockAuthInvoke},
    IntoVal,
};

fn request(w: &World) -> OutboundRequest {
    OutboundRequest {
        token: w.token_id.clone(),
        amount: HUNDRED,
        route: RouteKind::AxelarIts,
        destination: Destination {
            chain: w.ethereum(),
            address: w.evm(1),
        },
        destination_decimals: 7,
        min_destination_amount: net_of(HUNDRED),
    }
}
#[test]
fn paid_transfer_keeps_router_fees_and_pays_actual_gas_atomically() {
    let w = World::new();
    w.its().set_native(&w.lock_asset);
    let before = w.lock_token().balance(&w.user);
    let nonce = w.router().bridge_out_with_gas(&w.user, &request(&w), &1000);
    assert_eq!(nonce, 1);
    assert!(w.its().last_transfer().gas_attached);
    assert_eq!(w.its().last_transfer().amount, net_of(HUNDRED));
    assert_eq!(w.lock_token().balance(&w.user), before - 1000);
    assert_eq!(w.lock_token().balance(&w.its_id), 1000);
    assert_eq!(w.token().balance(&w.treasury), HUNDRED - net_of(HUNDRED));
    assert_eq!(w.token().balance(&w.bare_id), 0);
    assert_eq!(w.lock_token().balance(&w.bare_id), 0);
}
#[test]
fn the_sender_authorizes_gas_and_router_debit_with_no_adapter_signature() {
    let w = World::new();
    w.its().set_native(&w.lock_asset);
    let req = request(&w);
    let fee = HUNDRED - net_of(HUNDRED);
    let gas = Some(crate::rail::Token {
        address: w.lock_asset.clone(),
        amount: 1000,
    });
    let no_data: Option<soroban_sdk::Bytes> = None;
    let recipient = soroban_sdk::Bytes::from_array(
        &w.env,
        &hyperion_core::address::bytes32_to_evm(&w.env, &req.destination.address)
            .unwrap()
            .to_array(),
    );
    w.env.mock_auths(&[MockAuth {
        address: &w.user,
        invoke: &MockAuthInvoke {
            contract: &w.router_id,
            fn_name: "bridge_out_with_gas",
            args: (w.user.clone(), req.clone(), 1000i128).into_val(&w.env),
            sub_invokes: &[
                MockAuthInvoke {
                    contract: &w.token_id,
                    fn_name: "transfer",
                    args: (w.user.clone(), w.treasury.clone(), fee).into_val(&w.env),
                    sub_invokes: &[],
                },
                MockAuthInvoke {
                    contract: &w.bare_id,
                    fn_name: "dispatch_from",
                    args: (
                        w.router_id.clone(),
                        w.user.clone(),
                        w.token_id.clone(),
                        net_of(HUNDRED),
                        w.ethereum(),
                        req.destination.address.clone(),
                        1u64,
                        1000i128,
                    )
                        .into_val(&w.env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &w.its_id,
                        fn_name: "interchain_transfer",
                        args: (
                            w.user.clone(),
                            w.burn_id(),
                            w.axelar_ethereum(),
                            recipient,
                            net_of(HUNDRED),
                            no_data,
                            gas,
                        )
                            .into_val(&w.env),
                        sub_invokes: &[
                            MockAuthInvoke {
                                contract: &w.token_id,
                                fn_name: "burn",
                                args: (w.user.clone(), net_of(HUNDRED)).into_val(&w.env),
                                sub_invokes: &[],
                            },
                            MockAuthInvoke {
                                contract: &w.lock_asset,
                                fn_name: "transfer",
                                args: (w.user.clone(), w.its_id.clone(), 1000i128).into_val(&w.env),
                                sub_invokes: &[],
                            },
                        ],
                    }],
                },
            ],
        },
    }]);
    w.router().bridge_out_with_gas(&w.user, &req, &1000);
    assert!(w.its().last_transfer().gas_attached);
}
#[test]
fn router_refusal_rolls_back_the_gas_debit() {
    let w = World::new();
    w.its().set_native(&w.lock_asset);
    w.router().pause(&w.admin);
    let balance = w.lock_token().balance(&w.user);
    assert!(w
        .router()
        .try_bridge_out_with_gas(&w.user, &request(&w), &1000)
        .is_err());
    assert_eq!(w.lock_token().balance(&w.user), balance);
    assert_eq!(w.lock_token().balance(&w.bare_id), 0);
}
#[test]
fn gas_cannot_be_zero_or_negative_and_route_must_match() {
    let w = World::new();
    for gas in [0, -1] {
        assert_eq!(
            w.router()
                .try_bridge_out_with_gas(&w.user, &request(&w), &gas),
            Err(Ok(HyperionError::InvalidAmount))
        );
    }
    let mut req = request(&w);
    req.route = RouteKind::Allbridge;
    assert_eq!(
        w.router().try_bridge_out_with_gas(&w.user, &req, &1000),
        Err(Ok(HyperionError::UnsupportedRoute))
    );
}

#[test]
fn insufficient_relay_gas_rolls_back_fee_burn_nonce_and_flow() {
    let w = World::new();
    w.its().set_native(&w.lock_asset);
    let before = w.token().balance(&w.user);
    assert!(w
        .router()
        .try_bridge_out_with_gas(&w.user, &request(&w), &(HUNDRED * 100))
        .is_err());
    assert_eq!(w.token().balance(&w.user), before);
    assert_eq!(w.token().balance(&w.treasury), 0);
    assert_eq!(w.router().last_out_nonce(), 0);
    assert_eq!(w.its().transfer_count(), 0);
}
#[test]
fn a_direct_paid_dispatch_from_a_stranger_is_refused() {
    let w = World::new();
    w.its().set_native(&w.lock_asset);
    assert_eq!(
        w.bare().try_dispatch_from(
            &w.relayer,
            &w.user,
            &w.token_id,
            &HUNDRED,
            &w.ethereum(),
            &w.evm(1),
            &1,
            &1000
        ),
        Err(Ok(HyperionError::Unauthorized))
    );
}
