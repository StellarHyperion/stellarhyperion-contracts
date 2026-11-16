//! Read-only candidate-lane readiness snapshot tests.

use hyperion_core::{HyperionError, RouteKind};
use soroban_sdk::BytesN;

use super::setup::{World, ETH_CHAIN_ID, GAS_FLOAT, HUNDRED, RELAY_COST};
use crate::{AllbridgeAdapter, AllbridgeAdapterClient};

#[test]
fn readiness_snapshot_refuses_uninitialized_adapter() {
    let w = World::new();
    let fresh_id = w.env.register(AllbridgeAdapter, ());
    let fresh = AllbridgeAdapterClient::new(&w.env, &fresh_id);
    assert_eq!(
        fresh.try_inspect_lane_readiness(&w.ethereum(), &w.token_id),
        Err(Ok(HyperionError::NotInitialized))
    );
}

#[test]
fn readiness_snapshot_reports_missing_prerequisites_without_enabling_routes() {
    let w = World::unlinked();
    // Disable Allbridge on router first to prove inspect_lane_readiness never flips route state.
    w.router().disable_route(&w.guardian, &RouteKind::Allbridge);

    let snap = w
        .adapter()
        .inspect_lane_readiness(&w.ethereum(), &w.token_id);
    assert!(!snap.lane_linked);
    assert_eq!(snap.allbridge_chain_id, 0);
    assert!(!snap.asset_mapped);
    assert_eq!(snap.pool, Some(w.pool_id.clone()));
    assert_eq!(snap.pool_liquidity, 0);
    assert_eq!(snap.gas_float, 0);
    assert!(!snap.float_covers_relay);
    assert!(!snap.validator_configured);
    assert_eq!(snap.validator, None);
    assert!(!w.router().is_route_enabled(&RouteKind::Allbridge));
}

#[test]
fn readiness_snapshot_captures_pool_liquidity_float_and_validator_state() {
    let w = World::new();
    // Seed pool liquidity and set a non-zero validator key.
    soroban_sdk::token::StellarAssetClient::new(&w.env, &w.token_id)
        .mint(&w.pool_id, &(HUNDRED * 50));
    let pk = BytesN::from_array(&w.env, &[0x44u8; 32]);
    w.adapter().set_validator(&pk);

    let snap = w
        .adapter()
        .inspect_lane_readiness(&w.ethereum(), &w.token_id);
    assert!(snap.lane_linked);
    assert_eq!(snap.allbridge_chain_id, ETH_CHAIN_ID);
    assert!(snap.rail_open);
    assert!(snap.asset_mapped);
    assert_eq!(snap.receive_token, w.receive_token());
    assert_eq!(snap.pool, Some(w.pool_id.clone()));
    assert_eq!(snap.pool_liquidity, HUNDRED * 50);
    assert_eq!(snap.gas_float, GAS_FLOAT);
    assert_eq!(snap.relay_cost, RELAY_COST);
    assert!(snap.float_covers_relay);
    assert!(snap.validator_configured);
    assert_eq!(snap.validator, Some(pk));

    // All-zero validator key is flagged as unconfigured.
    w.adapter()
        .set_validator(&BytesN::from_array(&w.env, &[0u8; 32]));
    let zero_val_snap = w
        .adapter()
        .inspect_lane_readiness(&w.ethereum(), &w.token_id);
    assert!(!zero_val_snap.validator_configured);
}
