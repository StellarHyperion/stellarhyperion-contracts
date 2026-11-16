//! Bounded operator reconciliation and recovery tests for interrupted Allbridge calls.

use hyperion_core::HyperionError;
use soroban_sdk::{BytesN, U256};

use super::setup::{after_pool, net_of, World, ETH_CHAIN_ID, HUNDRED};
use crate::{
    rail::STELLAR_CHAIN_ID,
    types::{OutboundStatus, ProviderObservation, RecoveryAction},
};

#[test]
fn unknown_provider_outcome_never_permits_a_second_token_debit() {
    let w = World::new();
    let nonce = w.router().bridge_out(&w.user, &w.request(HUNDRED));
    let sold_after_first = w.pool().sold();
    let user_balance_after_first = w.token().balance(&w.user);

    let recorded = w.adapter().get_outbound(&nonce);
    assert_eq!(recorded.status, OutboundStatus::Dispatched);
    assert_eq!(recorded.amount, net_of(HUNDRED));
    assert_eq!(recorded.recipient, w.evm(0x01));

    // Inspection under RPC/indexer uncertainty holds without permitting a second debit.
    let inspected = w.adapter().inspect_outbound_recovery(
        &nonce,
        &w.token_id,
        &net_of(HUNDRED),
        &w.ethereum(),
        &w.evm(0x01),
        &ProviderObservation::Unknown,
    );
    assert_eq!(inspected.status, OutboundStatus::OutcomeUnknown);
    assert_eq!(inspected.action, RecoveryAction::HoldDoNotDebit);
    assert!(!inspected.second_debit_permitted);

    // Persisting the unknown outcome via admin reconciliation also blocks recovery execution.
    let reconciled = w
        .adapter()
        .reconcile_outbound(&nonce, &ProviderObservation::Unknown);
    assert_eq!(reconciled.status, OutboundStatus::OutcomeUnknown);
    assert_eq!(reconciled.action, RecoveryAction::HoldDoNotDebit);
    assert!(!reconciled.second_debit_permitted);

    assert_eq!(
        w.adapter().try_attempt_provider_recovery(&nonce),
        Err(Ok(HyperionError::ReplayedMessage))
    );

    // A duplicate router-level dispatch for the same nonce is rejected before touching the pool.
    w.fund_adapter(net_of(HUNDRED));
    assert_eq!(
        w.adapter().try_dispatch(
            &w.router_id,
            &w.token_id,
            &net_of(HUNDRED),
            &w.ethereum(),
            &w.evm(0x01),
            &nonce,
        ),
        Err(Ok(HyperionError::ReplayedMessage))
    );
    assert_eq!(w.pool().sold(), sold_after_first);
    assert_eq!(w.token().balance(&w.user), user_balance_after_first);
}

#[test]
fn pre_inclusion_unknown_vs_confirmed_absent_distinguishes_hold_from_fresh_send() {
    let w = World::new();
    let unrecorded_nonce = 77u64;

    // Even when no on-chain record is visible yet, an Unknown RPC result must never green-light
    // an immediate retry while ledger finality or Horizon indexing is uncertain.
    let unknown_plan = w.adapter().inspect_outbound_recovery(
        &unrecorded_nonce,
        &w.token_id,
        &net_of(HUNDRED),
        &w.ethereum(),
        &w.evm(0x01),
        &ProviderObservation::Unknown,
    );
    assert_eq!(unknown_plan.status, OutboundStatus::OutcomeUnknown);
    assert_eq!(unknown_plan.action, RecoveryAction::HoldDoNotDebit);
    assert!(!unknown_plan.second_debit_permitted);

    // Only once ledger finality confirms no outbound debit landed is a fresh submission marked safe.
    let absent_plan = w.adapter().inspect_outbound_recovery(
        &unrecorded_nonce,
        &w.token_id,
        &net_of(HUNDRED),
        &w.ethereum(),
        &w.evm(0x01),
        &ProviderObservation::ConfirmedAbsent,
    );
    assert_eq!(absent_plan.status, OutboundStatus::InterruptedBeforeDebit);
    assert_eq!(absent_plan.action, RecoveryAction::SafeFreshSubmission);
    assert!(!absent_plan.second_debit_permitted);
    assert_eq!(absent_plan.recipient, w.evm(0x01));
    assert_eq!(
        absent_plan.rail_nonce,
        U256::from_u128(&w.env, u128::from(unrecorded_nonce))
    );
}

#[test]
fn reconciliation_preserves_original_recipient_and_full_message_identity() {
    let w = World::new();
    let nonce = w.router().bridge_out(&w.user, &w.request(HUNDRED));
    let sent = w.bridge().last_sent().unwrap();
    assert_eq!(sent.v_usd, after_pool(net_of(HUNDRED)));

    // Attempting to inspect recovery with an altered recipient fails immediately.
    assert_eq!(
        w.adapter().try_inspect_outbound_recovery(
            &nonce,
            &w.token_id,
            &net_of(HUNDRED),
            &w.ethereum(),
            &w.evm(0x99),
            &ProviderObservation::MessageSent(sent.v_usd, sent.message.clone()),
        ),
        Err(Ok(HyperionError::InvalidDestination))
    );

    // Attempting to reconcile with a tampered message digest or wrong vUSD fails.
    let mut forged = sent.message.to_array();
    forged[31] ^= 0x01;
    assert_eq!(
        w.adapter().try_reconcile_outbound(
            &nonce,
            &ProviderObservation::MessageSent(sent.v_usd, BytesN::from_array(&w.env, &forged)),
        ),
        Err(Ok(HyperionError::MalformedMessage))
    );
    assert_eq!(
        w.adapter().try_reconcile_outbound(
            &nonce,
            &ProviderObservation::MessageSent(sent.amount + 1, sent.message.clone()),
        ),
        Err(Ok(HyperionError::InvalidAmount))
    );
    assert_eq!(
        w.adapter()
            .try_reconcile_outbound(&nonce, &ProviderObservation::ConfirmedAbsent),
        Err(Ok(HyperionError::MalformedMessage))
    );

    // Reconciling with the authentic Allbridge provider message locks in the full 32-byte identity.
    let plan = w.adapter().reconcile_outbound(
        &nonce,
        &ProviderObservation::MessageSent(sent.v_usd, sent.message.clone()),
    );
    assert_eq!(plan.recipient, w.evm(0x01));
    assert_eq!(plan.rail_nonce, U256::from_u128(&w.env, u128::from(nonce)));
    assert_eq!(plan.message_id, sent.message);
    assert_eq!(plan.message_id.to_array()[0], STELLAR_CHAIN_ID as u8);
    assert_eq!(plan.message_id.to_array()[1], ETH_CHAIN_ID as u8);
    assert_eq!(plan.verified_v_usd, Some(sent.v_usd));
    assert_eq!(plan.status, OutboundStatus::ProviderConfirmed);
}

#[test]
fn unsupported_provider_recovery_is_reported_explicitly_instead_of_simulated() {
    let w = World::new();
    let nonce = w.router().bridge_out(&w.user, &w.request(HUNDRED));
    let sent = w.bridge().last_sent().unwrap();
    let pool_sold_before = w.pool().sold();
    let gas_before = w.adapter().gas_balance();

    let plan = w.adapter().reconcile_outbound(
        &nonce,
        &ProviderObservation::MessageSent(sent.v_usd, sent.message.clone()),
    );
    assert_eq!(plan.action, RecoveryAction::UnsupportedProviderRecovery);
    assert!(!plan.second_debit_permitted);

    // Attempting source-side provider recovery explicitly fails with UnsupportedRoute rather than
    // simulating a resend or performing a second pool swap/gas charge.
    assert_eq!(
        w.adapter().try_attempt_provider_recovery(&nonce),
        Err(Ok(HyperionError::UnsupportedRoute))
    );
    assert_eq!(w.pool().sold(), pool_sold_before);
    assert_eq!(w.adapter().gas_balance(), gas_before);
    assert_eq!(w.bridge().sent_count(), 1);

    // Permissionless TTL bump preserves the reconciled record unchanged.
    w.adapter().keep_alive_outbound(&nonce);
    let stored = w.adapter().get_outbound(&nonce);
    assert_eq!(stored.status, OutboundStatus::ProviderConfirmed);
    assert_eq!(stored.verified_message_id, Some(sent.message));
}

#[test]
#[should_panic]
fn non_admin_cannot_reconcile_outbound() {
    let w = World::new();
    let nonce = w.router().bridge_out(&w.user, &w.request(HUNDRED));
    w.env.mock_auths(&[]);
    w.adapter()
        .reconcile_outbound(&nonce, &ProviderObservation::Unknown);
}
