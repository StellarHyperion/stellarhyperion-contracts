//! Native gas-float solvency view and bounded accounting tests.

use hyperion_core::HyperionError;

use super::setup::{World, ETH_CHAIN_ID, GAS_FLOAT, HUNDRED, RELAY_COST};

#[test]
fn insufficient_float_is_reported_before_outbound_dispatch() {
    let w = World::unlinked();
    w.link_ethereum();
    w.map_token();
    w.fund_user(HUNDRED * 10);

    let reserve: u128 = 20_000_000;
    w.adapter().set_min_gas_reserve(&reserve);
    assert_eq!(w.adapter().min_gas_reserve(), reserve);

    // Fund 1 stroop below (min_operational_reserve + RELAY_COST).
    let target = (reserve + RELAY_COST) as i128;
    w.fund_gas(target - 1);

    // Adapter-wide reserve alone is covered, so chain=None reports solvent=true...
    let reserve_only = w.adapter().gas_solvency(&None);
    assert!(reserve_only.solvent);
    assert_eq!(reserve_only.required_float, reserve);

    // ...but the lane-specific pre-dispatch check reports solvent=false with -1 headroom!
    let preflight = w.adapter().gas_solvency(&Some(w.ethereum()));
    assert!(!preflight.solvent);
    assert_eq!(preflight.current_float, target - 1);
    assert_eq!(preflight.committed_spending, 0);
    assert_eq!(preflight.min_operational_reserve, reserve);
    assert_eq!(preflight.next_relay_cost, RELAY_COST);
    assert_eq!(preflight.required_float, reserve + RELAY_COST);
    assert_eq!(preflight.headroom, -1);

    // Dispatch fails before user assets touch the pool.
    assert_eq!(
        w.router().try_bridge_out(&w.user, &w.request(HUNDRED)),
        Err(Ok(HyperionError::GasFloatTooLow))
    );
    assert_eq!(w.pool().sold(), 0);
    assert_eq!(w.adapter().committed_gas_spending(), 0);

    // Top up 1 stroop: solvency flips true and dispatch succeeds cleanly.
    w.fund_gas(1);
    let ready = w.adapter().gas_solvency(&Some(w.ethereum()));
    assert!(ready.solvent);
    assert_eq!(ready.headroom, 0);

    w.router().bridge_out(&w.user, &w.request(HUNDRED));
    let after = w.adapter().gas_solvency(&Some(w.ethereum()));
    assert_eq!(after.current_float, reserve as i128);
    assert_eq!(after.committed_spending, RELAY_COST);
    assert!(!after.solvent);
}

#[test]
fn native_gas_accounting_remains_separate_from_token_liabilities() {
    let w = World::new();
    w.adapter().set_min_gas_reserve(&10_000_000u128);
    let baseline = w.adapter().gas_solvency(&Some(w.ethereum()));

    // Minting and sweeping bridged SEP-41 tokens on the adapter never alters gas solvency.
    w.fund_adapter(HUNDRED * 25);
    assert_eq!(w.token().balance(&w.adapter_id), HUNDRED * 25);
    assert_eq!(w.adapter().gas_solvency(&Some(w.ethereum())), baseline);

    let swept = w.adapter().sweep(&w.relayer, &w.token_id);
    assert_eq!(swept, HUNDRED * 25);
    assert_eq!(w.adapter().gas_solvency(&Some(w.ethereum())), baseline);
}

#[test]
fn failed_provider_dispatch_does_not_consume_reported_committed_float() {
    let w = World::new();
    // Complete one valid dispatch so committed_spending is non-zero before the failure case.
    w.router().bridge_out(&w.user, &w.request(HUNDRED));
    let before = w.adapter().gas_solvency(&Some(w.ethereum()));
    assert_eq!(before.committed_spending, RELAY_COST);
    assert_eq!(before.current_float, GAS_FLOAT - RELAY_COST as i128);

    // Halt provider swapping so swap_and_bridge fails downstream inside Allbridge.
    w.bridge().set_can_swap(&false);
    assert!(w
        .router()
        .try_bridge_out(&w.user, &w.request(HUNDRED))
        .is_err());

    let after_failed = w.adapter().gas_solvency(&Some(w.ethereum()));
    assert_eq!(after_failed, before);
    assert_eq!(w.adapter().committed_gas_spending(), RELAY_COST);
}

#[test]
fn bounded_arithmetic_rejects_overflowing_reserves_and_relay_quotes() {
    let w = World::new();
    let over_i128 = (i128::MAX as u128) + 1;
    assert_eq!(
        w.adapter().try_set_min_gas_reserve(&over_i128),
        Err(Ok(HyperionError::InvalidLimit))
    );

    w.bridge().set_cost(&ETH_CHAIN_ID, &u128::MAX);
    assert_eq!(
        w.adapter().try_gas_solvency(&Some(w.ethereum())),
        Err(Ok(HyperionError::DecimalOverflow))
    );
}
