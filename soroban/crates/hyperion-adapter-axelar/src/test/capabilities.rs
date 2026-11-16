//! Tests for Axelar destination capability admission records.

use hyperion_core::{HyperionError, RouteKind};
use hyperion_router::{Destination, OutboundRequest};
use soroban_sdk::{BytesN, String};

use super::setup::{gross_of, net_of, World, EVM_DECIMALS, HUNDRED};
use crate::rail::TokenManagerType;

#[test]
fn capabilities_distinguish_direct_its_transfer_from_gmp_payload_handling() {
    let w = World::new();
    w.its().set_native(&w.lock_asset);

    // 1. On the bare `AxelarIts` adapter (`peer == [0; 20]`), attempting to claim GMP payload
    //    support without a peer is refused with `ZeroAddressKey`.
    assert_eq!(
        w.bare().try_admit_capability(
            &w.ethereum(),
            &w.token_id,
            &TokenManagerType::MintBurn,
            &true,
            &true,
            &true,
            &0,
        ),
        Err(Ok(HyperionError::ZeroAddressKey))
    );

    // 2. Claiming paid dispatch without direct ITS support is refused with `UnsupportedRoute`.
    assert_eq!(
        w.adapter().try_admit_capability(
            &w.ethereum(),
            &w.token_id,
            &TokenManagerType::MintBurn,
            &false,
            &true,
            &true,
            &0,
        ),
        Err(Ok(HyperionError::UnsupportedRoute))
    );

    // 3. Admit an ITS-only capability (`supports_direct_its = true, supports_gmp_payload = false`)
    //    on the GMP adapter, and confirm GMP payload dispatch fails with `UnsupportedRoute`
    //    BEFORE any asset movement!
    let its_only = w.adapter().admit_capability(
        &w.ethereum(),
        &w.token_id,
        &TokenManagerType::MintBurn,
        &true,
        &false,
        &false,
        &0,
    );
    assert!(its_only.supports_direct_its);
    assert!(!its_only.supports_gmp_payload);

    let user_before = w.token().balance(&w.user);
    assert_eq!(
        w.adapter().try_validate_dispatch_capability(
            &w.token_id,
            &net_of(HUNDRED),
            &w.ethereum(),
            &false,
        ),
        Err(Ok(HyperionError::UnsupportedRoute))
    );
    assert_eq!(
        w.router().try_bridge_out(&w.user, &w.request(HUNDRED)),
        Err(Ok(HyperionError::UnsupportedRoute))
    );
    assert_eq!(w.token().balance(&w.user), user_before);
    assert_eq!(w.token().balance(&w.adapter_id), 0);
    assert_eq!(w.its().transfer_count(), 0);

    // 4. Conversely, admit a GMP-only capability (`supports_direct_its = false,
    //    supports_gmp_payload = true`) on `bare` after giving `bare` a peer, and confirm bare ITS
    //    dispatch fails with `UnsupportedRoute` BEFORE asset movement!
    w.bare()
        .link_chain(&w.ethereum(), &w.axelar_ethereum(), &w.peer());
    w.bare().admit_capability(
        &w.ethereum(),
        &w.token_id,
        &TokenManagerType::MintBurn,
        &false,
        &true,
        &false,
        &0,
    );
    let mut bare_req = w.request(HUNDRED);
    bare_req.route = RouteKind::AxelarIts;
    assert_eq!(
        w.router().try_bridge_out(&w.user, &bare_req),
        Err(Ok(HyperionError::UnsupportedRoute))
    );
    assert_eq!(w.token().balance(&w.user), user_before);
    assert_eq!(w.its().transfer_count(), 0);
}

#[test]
fn unsupported_destination_features_fail_before_asset_movement() {
    let w = World::new();
    w.its().set_native(&w.lock_asset);

    let user_tok_before = w.token().balance(&w.user);
    let user_gas_before = w.lock_token().balance(&w.user);

    // 1. Strict capability mode blocks unadmitted `(chain, token)` before any token or gas debit.
    w.bare().set_strict_capabilities(&true);
    let mut paid_req = w.request(HUNDRED);
    paid_req.route = RouteKind::AxelarIts;
    assert_eq!(
        w.router()
            .try_bridge_out_with_gas(&w.user, &paid_req, &1_000),
        Err(Ok(HyperionError::RailNotConfigured))
    );
    assert_eq!(w.token().balance(&w.user), user_tok_before);
    assert_eq!(w.lock_token().balance(&w.user), user_gas_before);
    assert_eq!(w.its().transfer_count(), 0);

    // 2. Admit unpaid-only ITS (`supports_paid_dispatch = false`) with `max_transfer_amount`:
    //    paid dispatch fails before moving tokens or gas, and over-cap unpaid dispatch fails with
    //    `ExceedsRouteLimit` before moving tokens.
    let cap_limit = net_of(HUNDRED) - 10;
    w.bare().admit_capability(
        &w.ethereum(),
        &w.token_id,
        &TokenManagerType::MintBurn,
        &true,
        &false,
        &false,
        &cap_limit,
    );
    assert_eq!(
        w.router()
            .try_bridge_out_with_gas(&w.user, &paid_req, &1_000),
        Err(Ok(HyperionError::UnsupportedRoute))
    );
    assert_eq!(
        w.router().try_bridge_out(&w.user, &paid_req),
        Err(Ok(HyperionError::ExceedsRouteLimit))
    );
    assert_eq!(w.token().balance(&w.user), user_tok_before);
    assert_eq!(w.lock_token().balance(&w.user), user_gas_before);
    assert_eq!(w.its().transfer_count(), 0);

    // 3. Manager-type drift on ITS after admission is caught with `UnexpectedRailContract` before
    //    touching lock-manager or burn balances.
    w.bare().admit_capability(
        &w.ethereum(),
        &w.lock_asset,
        &TokenManagerType::LockUnlock,
        &true,
        &false,
        &true,
        &0,
    );
    w.its().register(
        &w.lock_id(),
        &w.lock_asset,
        &w.manager_id,
        &TokenManagerType::MintBurn,
    );
    let mut lock_req = paid_req.clone();
    lock_req.token = w.lock_asset.clone();
    assert_eq!(
        w.router().try_bridge_out(&w.user, &lock_req),
        Err(Ok(HyperionError::UnexpectedRailContract))
    );
    assert_eq!(w.manager().locked(&w.lock_asset), 0);
    assert_eq!(w.its().transfer_count(), 0);

    // 4. Disabling a capability refuses dispatch with `RouteDisabled` before asset movement.
    w.bare().disable_capability(&w.ethereum(), &w.token_id);
    let mut small_req = paid_req;
    small_req.amount = HUNDRED / 2;
    assert_eq!(
        w.router().try_bridge_out(&w.user, &small_req),
        Err(Ok(HyperionError::RouteDisabled))
    );
    assert_eq!(w.token().balance(&w.user), user_tok_before);
    assert_eq!(w.its().transfer_count(), 0);
}

#[test]
fn record_updates_preserve_existing_active_sepolia_its_behavior() {
    let w = World::new();
    w.its().set_native(&w.lock_asset);

    let sepolia = String::from_str(&w.env, "sepolia");
    let axelar_sepolia = String::from_str(&w.env, "ethereum-sepolia");
    w.its().set_trusted(&axelar_sepolia, &true);
    w.bare().link_chain(
        &sepolia,
        &axelar_sepolia,
        &BytesN::from_array(&w.env, &[0u8; 20]),
    );

    let sepolia_req = OutboundRequest {
        token: w.token_id.clone(),
        amount: HUNDRED,
        route: RouteKind::AxelarIts,
        destination: Destination {
            chain: sepolia.clone(),
            address: w.evm(0x5E),
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    };

    // 1. Pre-admission active Sepolia ITS behavior works (both unpaid and paid `dispatch_from`).
    let n1 = w.router().bridge_out(&w.user, &sepolia_req);
    assert_eq!(n1, 1);
    let n2 = w
        .router()
        .bridge_out_with_gas(&w.user, &sepolia_req, &2_500);
    assert_eq!(n2, 2);

    // 2. Admitting Sepolia ITS capability and updating Ethereum capabilities preserves both unpaid
    //    and paid Sepolia ITS transfers even after strict capability mode is turned on.
    let admitted = w.bare().admit_capability(
        &sepolia,
        &w.token_id,
        &TokenManagerType::MintBurn,
        &true,
        &false,
        &true,
        &0,
    );
    assert_eq!(admitted.axelar_chain, axelar_sepolia);
    assert!(admitted.supports_direct_its);
    assert!(admitted.supports_paid_dispatch);
    assert!(!admitted.supports_gmp_payload);

    // Update capability records on another lane (`ethereum`) and turn on strict mode.
    w.bare().admit_capability(
        &w.ethereum(),
        &w.token_id,
        &TokenManagerType::LockUnlock,
        &true,
        &false,
        &false,
        &(HUNDRED * 5),
    );
    w.bare().disable_capability(&w.ethereum(), &w.token_id);
    w.bare().set_strict_capabilities(&true);

    let tok_before = w.token().balance(&w.user);
    let gas_before = w.lock_token().balance(&w.user);

    let n3 = w.router().bridge_out(&w.user, &sepolia_req);
    assert_eq!(n3, 3);
    let n4 = w
        .router()
        .bridge_out_with_gas(&w.user, &sepolia_req, &2_500);
    assert_eq!(n4, 4);

    assert_eq!(
        w.token().balance(&w.user),
        tok_before - gross_of(HUNDRED) * 2
    );
    assert_eq!(w.lock_token().balance(&w.user), gas_before - 2_500);
    assert_eq!(w.its().transfer_count(), 4);
}
