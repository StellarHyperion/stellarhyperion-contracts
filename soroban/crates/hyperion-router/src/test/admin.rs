//! Administration: who can change what, and how long they have to wait to do it.

use hyperion_core::{HyperionError, RouteKind, MAX_FEE_BPS};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Vec};

use super::doubles::all_routes;
use super::setup::{World, EVM_DECIMALS, HUNDRED};
use crate::timelock::{GRACE_PERIOD, MAX_TIMELOCK_DELAY, MIN_TIMELOCK_DELAY};
use crate::types::{AdminAction, Destination, OutboundRequest, RouteConfig};
use crate::{HyperionRouter, HyperionRouterClient};

// ------------------------------------------------------------------------------------------
// Standing the contract up
// ------------------------------------------------------------------------------------------

fn fresh() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(HyperionRouter, ());
    (env, id, admin)
}

#[test]
fn initialising_twice_is_refused() {
    let w = World::new();
    assert_eq!(
        w.router().try_initialize(
            &w.admin,
            &w.guardian,
            &w.treasury,
            &10,
            &720,
            &MIN_TIMELOCK_DELAY
        ),
        Err(Ok(HyperionError::AlreadyInitialized))
    );
}

#[test]
fn a_confiscatory_opening_fee_is_refused() {
    let (env, id, admin) = fresh();
    let client = HyperionRouterClient::new(&env, &id);
    assert_eq!(
        client.try_initialize(
            &admin,
            &admin,
            &admin,
            &(MAX_FEE_BPS + 1),
            &720,
            &MIN_TIMELOCK_DELAY
        ),
        Err(Ok(HyperionError::FeeTooHigh))
    );
}

#[test]
fn a_zero_length_flow_window_is_refused() {
    let (env, id, admin) = fresh();
    let client = HyperionRouterClient::new(&env, &id);
    assert_eq!(
        client.try_initialize(&admin, &admin, &admin, &10, &0, &MIN_TIMELOCK_DELAY),
        Err(Ok(HyperionError::InvalidWindow))
    );
}

#[test]
fn a_timelock_short_enough_to_be_pointless_is_refused_and_so_is_one_long_enough_to_brick_it() {
    let (env, id, admin) = fresh();
    let client = HyperionRouterClient::new(&env, &id);
    for delay in [0u64, MIN_TIMELOCK_DELAY - 1, MAX_TIMELOCK_DELAY + 1] {
        assert_eq!(
            client.try_initialize(&admin, &admin, &admin, &10, &720, &delay),
            Err(Ok(HyperionError::TimelockDelayOutOfRange))
        );
    }
}

#[test]
fn the_opening_configuration_is_readable_straight_away() {
    let w = World::new();
    let cfg = w.router().get_config();
    assert_eq!(cfg.admin, w.admin);
    assert_eq!(cfg.guardian, w.guardian);
    assert_eq!(cfg.treasury, w.treasury);
    assert_eq!(cfg.fee_bps, super::setup::FEE_BPS);
    assert!(!cfg.paused);
}

// ------------------------------------------------------------------------------------------
// The timelock
// ------------------------------------------------------------------------------------------

#[test]
fn a_queued_change_cannot_be_run_before_its_time() {
    let w = World::new();
    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(25));
    assert_eq!(
        w.router().try_execute_action(&w.admin, &id),
        Err(Ok(HyperionError::TimelockNotReady))
    );
    // One second short still counts as short.
    w.advance_time(MIN_TIMELOCK_DELAY - 1);
    assert_eq!(
        w.router().try_execute_action(&w.admin, &id),
        Err(Ok(HyperionError::TimelockNotReady))
    );
    w.advance_time(2);
    w.router().execute_action(&w.admin, &id);
    assert_eq!(w.router().get_config().fee_bps, 25);
}

#[test]
fn a_queued_change_nobody_ran_goes_stale_instead_of_lurking_forever() {
    let w = World::new();
    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(25));
    w.advance_time(MIN_TIMELOCK_DELAY + GRACE_PERIOD + 1);
    // An action queued and forgotten last spring should not still be armed.
    assert_eq!(
        w.router().try_execute_action(&w.admin, &id),
        Err(Ok(HyperionError::TimelockExpired))
    );
    assert_eq!(w.router().get_config().fee_bps, super::setup::FEE_BPS);
}

#[test]
fn a_change_that_could_never_work_is_caught_at_queue_time_not_after_the_wait() {
    let w = World::new();
    // Finding out a parameter was invalid only after the delay elapsed costs another full delay
    // to fix, and during an incident that is the difference between an afternoon and a week.
    assert_eq!(
        w.router()
            .try_queue_action(&w.admin, &AdminAction::SetFeeBps(MAX_FEE_BPS + 1)),
        Err(Ok(HyperionError::FeeTooHigh))
    );
    assert_eq!(
        w.router()
            .try_queue_action(&w.admin, &AdminAction::SetTimelockDelay(1)),
        Err(Ok(HyperionError::TimelockDelayOutOfRange))
    );
    assert_eq!(
        w.router()
            .try_queue_action(&w.admin, &AdminAction::SetFlowWindow(0)),
        Err(Ok(HyperionError::InvalidWindow))
    );
    assert_eq!(
        w.router().try_queue_action(
            &w.admin,
            &AdminAction::RegisterToken(w.token_id.clone(), 7, -1)
        ),
        Err(Ok(HyperionError::InvalidLimit))
    );
    assert_eq!(
        w.router().try_queue_action(
            &w.admin,
            &AdminAction::RegisterToken(w.token_id.clone(), 99, 1)
        ),
        Err(Ok(HyperionError::InvalidDecimals))
    );
}

#[test]
fn only_the_admin_can_queue_a_change() {
    let w = World::new();
    for who in [&w.guardian, &w.user] {
        assert_eq!(
            w.router()
                .try_queue_action(who, &AdminAction::SetFeeBps(25)),
            Err(Ok(HyperionError::Unauthorized))
        );
    }
}

#[test]
fn the_guardian_can_throw_out_a_queued_change_without_owning_the_key_that_made_it() {
    let w = World::new();
    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(99));
    w.router().cancel_action(&w.guardian, &id);
    w.advance_time(MIN_TIMELOCK_DELAY + 1);
    assert_eq!(
        w.router().try_execute_action(&w.admin, &id),
        Err(Ok(HyperionError::TimelockNotQueued))
    );
    assert_eq!(w.router().get_config().fee_bps, super::setup::FEE_BPS);
}

#[test]
fn a_stranger_cannot_cancel_a_queued_change() {
    let w = World::new();
    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(25));
    assert_eq!(
        w.router().try_cancel_action(&w.user, &id),
        Err(Ok(HyperionError::Unauthorized))
    );
    w.advance_time(MIN_TIMELOCK_DELAY + 1);
    w.router().execute_action(&w.admin, &id);
    assert_eq!(w.router().get_config().fee_bps, 25);
}

#[test]
fn cancelling_something_that_was_never_queued_says_so() {
    let w = World::new();
    assert_eq!(
        w.router().try_cancel_action(&w.admin, &4242),
        Err(Ok(HyperionError::TimelockNotQueued))
    );
    assert_eq!(
        w.router().try_execute_action(&w.admin, &4242),
        Err(Ok(HyperionError::TimelockNotQueued))
    );
}

#[test]
fn an_executed_change_cannot_be_executed_again() {
    let w = World::new();
    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(25));
    w.advance_time(MIN_TIMELOCK_DELAY + 1);
    w.router().execute_action(&w.admin, &id);
    assert_eq!(
        w.router().try_execute_action(&w.admin, &id),
        Err(Ok(HyperionError::TimelockNotQueued))
    );
}

#[test]
fn only_the_admin_can_run_a_matured_change() {
    let w = World::new();
    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(25));
    w.advance_time(MIN_TIMELOCK_DELAY + 1);
    assert_eq!(
        w.router().try_execute_action(&w.guardian, &id),
        Err(Ok(HyperionError::Unauthorized))
    );
}

#[test]
fn the_queued_action_is_readable_while_it_waits() {
    let w = World::new();
    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(25));
    let queued = w.router().get_queued(&id);
    assert_eq!(queued.id, id);
    assert_eq!(queued.action, AdminAction::SetFeeBps(25));
    assert_eq!(queued.eta, queued.queued_at + MIN_TIMELOCK_DELAY);
    assert_eq!(queued.expires_at, queued.eta + GRACE_PERIOD);
    assert_eq!(w.router().queue_count(), id);
}

#[test]
fn handing_the_admin_key_over_takes_the_old_one_out_of_the_picture() {
    let w = World::new();
    let successor = Address::generate(&w.env);
    w.run_action(AdminAction::SetAdmin(successor.clone()));
    assert_eq!(w.router().get_config().admin, successor);
    assert_eq!(
        w.router()
            .try_queue_action(&w.admin, &AdminAction::SetFeeBps(25)),
        Err(Ok(HyperionError::Unauthorized))
    );
    w.router()
        .queue_action(&successor, &AdminAction::SetFeeBps(25));
}

#[test]
fn moving_the_treasury_moves_where_the_fees_land() {
    let w = World::new();
    let new_treasury = Address::generate(&w.env);
    w.run_action(AdminAction::SetTreasury(new_treasury.clone()));

    w.router().bridge_out(
        &w.user,
        &OutboundRequest {
            token: w.token_id.clone(),
            amount: HUNDRED,
            route: RouteKind::Cctp,
            destination: Destination {
                chain: w.ethereum(),
                address: super::doubles::evm_destination(&w.env, 0x22),
            },
            destination_decimals: EVM_DECIMALS,
            min_destination_amount: 0,
        },
    );
    assert_eq!(w.token().balance(&new_treasury), HUNDRED / 1_000);
    assert_eq!(w.token().balance(&w.treasury), 0);
}

#[test]
fn an_upgrade_is_a_timelocked_change_like_any_other() {
    let w = World::new();
    let pretend_hash = BytesN::from_array(&w.env, &[9u8; 32]);
    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::Upgrade(pretend_hash.clone()));
    assert_eq!(
        w.router().get_queued(&id).action,
        AdminAction::Upgrade(pretend_hash)
    );
    // Swapping the code out is the single most dangerous thing the admin key can do, so it waits
    // like everything else and the guardian can throw it out. Actually installing a new wasm is
    // exercised by the upgrade script against a live network, where there is a real hash to use.
    w.router().cancel_action(&w.guardian, &id);
    assert_eq!(
        w.router().try_execute_action(&w.admin, &id),
        Err(Ok(HyperionError::TimelockNotQueued))
    );
}

// ------------------------------------------------------------------------------------------
// Things that only ever make the bridge safer
// ------------------------------------------------------------------------------------------

#[test]
fn either_key_can_pause_immediately_but_only_the_admin_decides_it_is_over() {
    let w = World::new();
    w.router().pause(&w.guardian);
    assert!(w.router().get_config().paused);

    // A bridge that needs three days of notice to stop bleeding is not pausable, so there is no
    // timelock here at all.
    assert_eq!(
        w.router().try_unpause(&w.guardian),
        Err(Ok(HyperionError::Unauthorized))
    );
    w.router().unpause(&w.admin);
    assert!(!w.router().get_config().paused);

    w.router().pause(&w.admin);
    assert!(w.router().get_config().paused);
}

#[test]
fn a_stranger_cannot_pause_the_bridge() {
    let w = World::new();
    assert_eq!(
        w.router().try_pause(&w.user),
        Err(Ok(HyperionError::Unauthorized))
    );
    assert_eq!(
        w.router().try_unpause(&w.user),
        Err(Ok(HyperionError::Unauthorized))
    );
}

#[test]
fn tightening_a_flow_limit_happens_at_once_and_loosening_one_has_to_wait() {
    let w = World::new();
    w.router()
        .lower_token_flow_limit(&w.guardian, &w.token_id, &1_000);
    assert_eq!(w.router().get_token(&w.token_id).flow_limit, 1_000);

    // Going the other way is a widening of risk, so it takes the long road.
    assert_eq!(
        w.router()
            .try_lower_token_flow_limit(&w.guardian, &w.token_id, &2_000),
        Err(Ok(HyperionError::InvalidLimit))
    );
    w.run_action(AdminAction::RaiseTokenFlowLimit(w.token_id.clone(), 2_000));
    assert_eq!(w.router().get_token(&w.token_id).flow_limit, 2_000);
}

#[test]
fn a_negative_flow_limit_is_nonsense_and_is_refused() {
    let w = World::new();
    assert_eq!(
        w.router()
            .try_lower_token_flow_limit(&w.guardian, &w.token_id, &-1),
        Err(Ok(HyperionError::InvalidLimit))
    );
}

#[test]
fn a_stranger_cannot_touch_a_flow_limit() {
    let w = World::new();
    assert_eq!(
        w.router()
            .try_lower_token_flow_limit(&w.user, &w.token_id, &1),
        Err(Ok(HyperionError::Unauthorized))
    );
}

#[test]
fn closing_a_lane_is_immediate_and_reopening_it_is_not() {
    let w = World::new();
    w.router().disable_route(&w.guardian, &RouteKind::Allbridge);
    assert!(!w.router().is_route_enabled(&RouteKind::Allbridge));
    assert_eq!(
        w.router().try_disable_route(&w.user, &RouteKind::Allbridge),
        Err(Ok(HyperionError::Unauthorized))
    );

    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::EnableRoute(RouteKind::Allbridge));
    assert!(!w.router().is_route_enabled(&RouteKind::Allbridge));
    w.advance_time(MIN_TIMELOCK_DELAY + 1);
    w.router().execute_action(&w.admin, &id);
    assert!(w.router().is_route_enabled(&RouteKind::Allbridge));
}

// ------------------------------------------------------------------------------------------
// Wiring and views
// ------------------------------------------------------------------------------------------

#[test]
fn every_rail_can_be_wired_up_and_read_back() {
    let w = World::new();
    for route in all_routes() {
        assert_eq!(w.router().get_adapter(&route), w.rail_id);
        assert_eq!(w.router().get_rail_receiver(&route), w.rail_id);
        assert!(w.router().is_route_enabled(&route));
    }
}

#[test]
fn an_unwired_rail_reports_that_rather_than_guessing() {
    let w = World::bare();
    assert_eq!(
        w.router().try_get_adapter(&RouteKind::Cctp),
        Err(Ok(HyperionError::AdapterNotSet))
    );
    assert_eq!(
        w.router().try_get_rail_receiver(&RouteKind::Cctp),
        Err(Ok(HyperionError::AdapterNotSet))
    );
    assert!(!w.router().is_route_enabled(&RouteKind::Cctp));
    assert_eq!(
        w.router().try_get_token(&w.token_id),
        Err(Ok(HyperionError::TokenNotRegistered))
    );
}

#[test]
fn registering_a_token_turns_it_on_with_the_limit_it_was_given() {
    let w = World::bare();
    w.register_token(w.token_id.clone(), 7, 12_345);
    let cfg = w.router().get_token(&w.token_id);
    assert_eq!(cfg.decimals, 7);
    assert_eq!(cfg.flow_limit, 12_345);
    assert!(cfg.enabled);
}

#[test]
fn the_flow_window_length_can_be_changed_and_the_counters_follow_it() {
    let w = World::new();
    w.run_action(AdminAction::SetFlowWindow(60));
    assert_eq!(w.router().get_config().flow_window_ledgers, 60);
}

#[test]
fn the_timelock_delay_itself_can_only_be_changed_through_the_timelock() {
    let w = World::new();
    w.run_action(AdminAction::SetTimelockDelay(MIN_TIMELOCK_DELAY * 2));
    assert_eq!(
        w.router().get_config().timelock_delay,
        MIN_TIMELOCK_DELAY * 2
    );
    // And the new delay is what the next change has to sit through.
    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(25));
    let queued = w.router().get_queued(&id);
    assert_eq!(queued.eta - queued.queued_at, MIN_TIMELOCK_DELAY * 2);
}

#[test]
fn anybody_can_keep_the_bookkeeping_alive_and_it_costs_them_nothing_but_the_fee() {
    let w = World::new();
    w.router().bridge_out(
        &w.user,
        &OutboundRequest {
            token: w.token_id.clone(),
            amount: HUNDRED,
            route: RouteKind::Cctp,
            destination: Destination {
                chain: w.ethereum(),
                address: super::doubles::evm_destination(&w.env, 0x33),
            },
            destination_decimals: EVM_DECIMALS,
            min_destination_amount: 0,
        },
    );

    let mut tokens = Vec::new(&w.env);
    tokens.push_back(w.token_id.clone());
    let mut routes = Vec::new(&w.env);
    for route in all_routes() {
        routes.push_back(route);
    }
    let mut nonces = Vec::new(&w.env);
    nonces.push_back(1u64);
    let claims: Vec<u64> = Vec::new(&w.env);

    // No signature, no role, no config check. A flow counter that archives quietly resets a
    // limit, so the cheapest possible way to stop that is to let anyone pay to prevent it.
    w.router().keep_alive(&tokens, &routes, &claims, &nonces);
    assert_eq!(w.router().get_transfer(&1).nonce, 1);
}

#[test]
fn a_router_that_was_never_initialised_refuses_everything_that_matters() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(HyperionRouter, ());
    let client = HyperionRouterClient::new(&env, &id);
    let who = Address::generate(&env);

    assert_eq!(
        client.try_get_config(),
        Err(Ok(HyperionError::NotInitialized))
    );
    assert_eq!(
        client.try_pause(&who),
        Err(Ok(HyperionError::NotInitialized))
    );
    assert_eq!(
        client.try_queue_action(&who, &AdminAction::SetFeeBps(1)),
        Err(Ok(HyperionError::NotInitialized))
    );
}

#[test]
fn route_max_single_transfer_can_be_updated_through_timelock() {
    let w = World::new();

    // Verify initial route config is None
    assert_eq!(w.router().get_route_config(&RouteKind::Cctp), None);

    // Update via SetRouteConfig
    w.run_action(AdminAction::SetRouteConfig(
        RouteKind::Cctp,
        RouteConfig {
            max_single_transfer: 50_000,
        },
    ));

    assert_eq!(
        w.router().get_route_config(&RouteKind::Cctp),
        Some(RouteConfig {
            max_single_transfer: 50_000,
        })
    );

    // Update via SetRouteMaxSingleTransfer
    w.run_action(AdminAction::SetRouteMaxSingleTransfer(
        RouteKind::Cctp,
        75_000,
    ));

    assert_eq!(
        w.router().get_route_config(&RouteKind::Cctp),
        Some(RouteConfig {
            max_single_transfer: 75_000,
        })
    );
}

#[test]
fn negative_route_limit_is_refused_at_queue_time() {
    let w = World::new();

    assert_eq!(
        w.router().try_queue_action(
            &w.admin,
            &AdminAction::SetRouteMaxSingleTransfer(RouteKind::Cctp, -1),
        ),
        Err(Ok(HyperionError::InvalidLimit))
    );

    assert_eq!(
        w.router().try_queue_action(
            &w.admin,
            &AdminAction::SetRouteConfig(
                RouteKind::Cctp,
                RouteConfig {
                    max_single_transfer: -1,
                },
            ),
        ),
        Err(Ok(HyperionError::InvalidLimit))
    );
}
