//! Tests verifying actual Soroban paid-dispatch nested authorization trees (`env.auths()`)
//! against `expected_paid_auth_plan` across `MintBurn`, `LockUnlock`, and `MockGasService`.

extern crate std;

use hyperion_core::{address::bytes32_to_evm, RouteKind};
use hyperion_router::{Destination, OutboundRequest};
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation},
    Address, Bytes, IntoVal, Symbol,
};

use super::its::MockGasService;
use super::setup::{net_of, World, HUNDRED};
use crate::rail::{Token, TokenManagerType};

fn paid_request(w: &World, token: Address) -> OutboundRequest {
    OutboundRequest {
        token,
        amount: HUNDRED,
        route: RouteKind::AxelarIts,
        destination: Destination {
            chain: w.ethereum(),
            address: w.evm(0x42),
        },
        destination_decimals: 7,
        min_destination_amount: net_of(HUNDRED),
    }
}

#[test]
fn expected_paid_auth_plan_needs_no_signatures_and_matches_nested_mint_burn_and_gas_service_tree() {
    let w = World::new();
    let native_gas = w
        .env
        .register_stellar_asset_contract_v2(w.its_id.clone())
        .address();
    w.its().faucet(&native_gas, &w.user, &(HUNDRED * 2));
    w.its().set_native(&native_gas);

    let gas_service_id = w.env.register(MockGasService, ());
    w.its().set_gas_service(&gas_service_id);

    // Strip all mocked signatures to prove `expected_paid_auth_plan` requires zero private keys.
    w.env.set_auths(&[]);
    let gas_amount = 2_500i128;
    let plan = w.bare().expected_paid_auth_plan(
        &w.token_id,
        &net_of(HUNDRED),
        &w.ethereum(),
        &w.evm(0x42),
        &gas_amount,
    );
    assert_eq!(plan.router, w.router_id);
    assert_eq!(plan.adapter, w.bare_id);
    assert_eq!(plan.its, w.its_id);
    assert_eq!(plan.gas_service, gas_service_id);
    assert_eq!(plan.token_manager_type, TokenManagerType::MintBurn);
    assert_eq!(plan.token_spender, None);
    assert_eq!(plan.native_gas_token, native_gas);
    assert_eq!(plan.net_amount, net_of(HUNDRED));
    assert_eq!(plan.gas_amount, gas_amount);

    // Execute paid dispatch and capture the exact `AuthorizedInvocation` tree recorded by the host.
    w.env.mock_all_auths();
    let req = paid_request(&w, w.token_id.clone());
    let fee = HUNDRED - net_of(HUNDRED);
    let nonce = w.router().bridge_out_with_gas(&w.user, &req, &gas_amount);
    assert_eq!(nonce, 1);

    let auths = w.env.auths();
    assert_eq!(auths.len(), 1);
    let (signer, root) = &auths[0];
    assert_eq!(signer, &w.user);

    let recipient_bytes = Bytes::from_array(
        &w.env,
        &bytes32_to_evm(&w.env, &w.evm(0x42)).unwrap().to_array(),
    );
    let gas_struct = Token {
        address: native_gas.clone(),
        amount: gas_amount,
    };
    let no_data: Option<Bytes> = None;

    let expected_tree = AuthorizedInvocation {
        function: AuthorizedFunction::Contract((
            plan.router.clone(),
            Symbol::new(&w.env, "bridge_out_with_gas"),
            (w.user.clone(), req, gas_amount).into_val(&w.env),
        )),
        sub_invocations: std::vec![
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    plan.token.clone(),
                    Symbol::new(&w.env, "transfer"),
                    (w.user.clone(), w.treasury.clone(), fee).into_val(&w.env),
                )),
                sub_invocations: std::vec![],
            },
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    plan.adapter.clone(),
                    Symbol::new(&w.env, "dispatch_from"),
                    (
                        plan.router.clone(),
                        w.user.clone(),
                        plan.token.clone(),
                        plan.net_amount,
                        w.ethereum(),
                        w.evm(0x42),
                        nonce,
                        plan.gas_amount,
                    )
                        .into_val(&w.env),
                )),
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        plan.its.clone(),
                        Symbol::new(&w.env, "interchain_transfer"),
                        (
                            w.user.clone(),
                            plan.token_id.clone(),
                            plan.axelar_chain.clone(),
                            recipient_bytes.clone(),
                            plan.net_amount,
                            no_data,
                            Some(gas_struct.clone()),
                        )
                            .into_val(&w.env),
                    )),
                    sub_invocations: std::vec![
                        AuthorizedInvocation {
                            function: AuthorizedFunction::Contract((
                                plan.token.clone(),
                                Symbol::new(&w.env, "burn"),
                                (w.user.clone(), plan.net_amount).into_val(&w.env),
                            )),
                            sub_invocations: std::vec![],
                        },
                        AuthorizedInvocation {
                            function: AuthorizedFunction::Contract((
                                plan.gas_service.clone(),
                                Symbol::new(&w.env, "pay_gas"),
                                (
                                    plan.its.clone(),
                                    plan.axelar_chain.clone(),
                                    recipient_bytes,
                                    Bytes::new(&w.env),
                                    w.user.clone(),
                                    gas_struct,
                                    w.user.clone(),
                                )
                                    .into_val(&w.env),
                            )),
                            sub_invocations: std::vec![AuthorizedInvocation {
                                function: AuthorizedFunction::Contract((
                                    plan.native_gas_token.clone(),
                                    Symbol::new(&w.env, "transfer"),
                                    (w.user.clone(), plan.gas_service.clone(), plan.gas_amount)
                                        .into_val(&w.env),
                                )),
                                sub_invocations: std::vec![],
                            }],
                        },
                    ],
                }],
            },
        ],
    };

    assert_eq!(root, &expected_tree);
}

#[test]
fn expected_paid_auth_plan_captures_lock_unlock_manager_spender() {
    let w = World::new();
    let native_gas = Address::generate(&w.env);
    w.its().set_native(&native_gas);

    w.env.set_auths(&[]);
    let plan = w.bare().expected_paid_auth_plan(
        &w.lock_asset,
        &net_of(HUNDRED),
        &w.ethereum(),
        &w.evm(0x09),
        &5_000,
    );
    assert_eq!(plan.token_manager_type, TokenManagerType::LockUnlock);
    assert_eq!(plan.token_spender, Some(w.manager_id));
}
