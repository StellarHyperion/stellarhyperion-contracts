//! Multi-currency token conservation invariant harness for local Axelar ITS paths.
//!
//! Tracks `sender`, `treasury`, `adapter`, `router`, `recipient`, and ITS `rail_sink` balances
//! across successful and failed paid transfers (`MintBurn` and `LockUnlock`), inbound GMP note
//! deliveries, and parked claims while accounting separately for 7-to-6 decimal `source_dust` and
//! a dedicated native relay gas asset (`XLM` SAC).

extern crate std;

use std::vec::Vec;

use hyperion_core::{
    amount::{apply_fee, floor_to_representable},
    HyperionError, RouteKind, STELLAR_DECIMALS,
};
use hyperion_router::{Destination, OutboundRequest};
use soroban_sdk::{token, Address, Bytes, String};

use super::setup::{net_of, World, EVM_DECIMALS, FEE_BPS, HUNDRED};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AccountRole {
    Sender,
    Treasury,
    Adapter,
    Router,
    Recipient,
    RailSink,
    Aggregate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LedgerLeg {
    Principal,
    SourceDust,
    RelayCurrency,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct BalanceSheet {
    sender: i128,
    treasury: i128,
    adapter: i128,
    router: i128,
    recipient: i128,
    rail_sink: i128,
}

impl BalanceSheet {
    fn total(&self) -> i128 {
        self.sender + self.treasury + self.adapter + self.router + self.recipient + self.rail_sink
    }

    fn get(&self, role: AccountRole) -> i128 {
        match role {
            AccountRole::Sender => self.sender,
            AccountRole::Treasury => self.treasury,
            AccountRole::Adapter => self.adapter,
            AccountRole::Router => self.router,
            AccountRole::Recipient => self.recipient,
            AccountRole::RailSink => self.rail_sink,
            AccountRole::Aggregate => self.total(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ConservationViolation {
    operation: &'static str,
    ledger_leg: LedgerLeg,
    account: AccountRole,
    expected_delta: i128,
    actual_delta: i128,
    balance_delta_discrepancy: i128,
}

#[derive(Clone, Copy, Debug)]
enum ExpectedItsStep {
    PaidOutbound {
        requested_amount: i128,
        fee_bps: u32,
        destination_decimals: u32,
        relay_gas_amount: i128,
    },
    Inbound {
        minted_amount: i128,
        parked_as_claim: bool,
    },
    FailedRollback,
}

fn audit_its_step(
    operation: &'static str,
    step: ExpectedItsStep,
    principal_before: BalanceSheet,
    principal_after: BalanceSheet,
    gas_before: BalanceSheet,
    gas_after: BalanceSheet,
) -> Vec<ConservationViolation> {
    let mut violations = Vec::new();
    let mut expected_p = BalanceSheet::default();
    let mut expected_g = BalanceSheet::default();

    match step {
        ExpectedItsStep::PaidOutbound {
            requested_amount,
            fee_bps,
            destination_decimals,
            relay_gas_amount,
        } => {
            let split = apply_fee(requested_amount, fee_bps).expect("valid fee split");
            let net = floor_to_representable(split.net, STELLAR_DECIMALS, destination_decimals)
                .expect("valid decimal floor");
            let gross = split.fee + net;
            let expected_source_dust = requested_amount - gross;

            expected_p.sender = -gross;
            expected_p.treasury = split.fee;
            expected_p.rail_sink = net;

            expected_g.sender = -relay_gas_amount;
            expected_g.rail_sink = relay_gas_amount;

            let actual_sender_debit = principal_before.sender - principal_after.sender;
            let actual_retained_dust = requested_amount - actual_sender_debit;
            if actual_retained_dust != expected_source_dust {
                violations.push(ConservationViolation {
                    operation,
                    ledger_leg: LedgerLeg::SourceDust,
                    account: AccountRole::Sender,
                    expected_delta: expected_source_dust,
                    actual_delta: actual_retained_dust,
                    balance_delta_discrepancy: actual_retained_dust - expected_source_dust,
                });
            }
        }
        ExpectedItsStep::Inbound {
            minted_amount,
            parked_as_claim,
        } => {
            expected_p.rail_sink = -minted_amount;
            if parked_as_claim {
                expected_p.router = minted_amount;
            } else {
                expected_p.recipient = minted_amount;
            }
        }
        ExpectedItsStep::FailedRollback => {}
    }

    let roles = [
        AccountRole::Sender,
        AccountRole::Treasury,
        AccountRole::Adapter,
        AccountRole::Router,
        AccountRole::Recipient,
        AccountRole::RailSink,
    ];

    for role in roles {
        let actual = principal_after.get(role) - principal_before.get(role);
        let expected = expected_p.get(role);
        if actual != expected {
            violations.push(ConservationViolation {
                operation,
                ledger_leg: LedgerLeg::Principal,
                account: role,
                expected_delta: expected,
                actual_delta: actual,
                balance_delta_discrepancy: actual - expected,
            });
        }
    }

    let total_p_delta = principal_after.total() - principal_before.total();
    if total_p_delta != 0 {
        violations.push(ConservationViolation {
            operation,
            ledger_leg: LedgerLeg::Principal,
            account: AccountRole::Aggregate,
            expected_delta: 0,
            actual_delta: total_p_delta,
            balance_delta_discrepancy: total_p_delta,
        });
    }

    for role in roles {
        let actual_g = gas_after.get(role) - gas_before.get(role);
        let expected_g_role = expected_g.get(role);
        if actual_g != expected_g_role {
            violations.push(ConservationViolation {
                operation,
                ledger_leg: LedgerLeg::RelayCurrency,
                account: role,
                expected_delta: expected_g_role,
                actual_delta: actual_g,
                balance_delta_discrepancy: actual_g - expected_g_role,
            });
        }
    }

    let total_g_delta = gas_after.total() - gas_before.total();
    if total_g_delta != 0 {
        violations.push(ConservationViolation {
            operation,
            ledger_leg: LedgerLeg::RelayCurrency,
            account: AccountRole::Aggregate,
            expected_delta: 0,
            actual_delta: total_g_delta,
            balance_delta_discrepancy: total_g_delta,
        });
    }

    violations
}

struct ItsConservationHarness {
    w: World,
    gas_sac: Address,
    mint_burn_sink: i128,
}

impl ItsConservationHarness {
    fn new() -> Self {
        let w = World::new();
        let gas_sac = w
            .env
            .register_stellar_asset_contract_v2(w.its_id.clone())
            .address();
        w.its().set_native(&gas_sac);
        w.its().faucet(&gas_sac, &w.user, &(HUNDRED * 5));
        Self {
            w,
            gas_sac,
            mint_burn_sink: HUNDRED * 20,
        }
    }

    fn mint_burn_sheet(&self) -> BalanceSheet {
        let asset = self.w.token();
        BalanceSheet {
            sender: asset.balance(&self.w.user),
            treasury: asset.balance(&self.w.treasury),
            adapter: asset.balance(&self.w.bare_id) + asset.balance(&self.w.adapter_id),
            router: asset.balance(&self.w.router_id),
            recipient: asset.balance(&self.w.recipient),
            rail_sink: self.mint_burn_sink,
        }
    }

    fn lock_unlock_sheet(&self) -> BalanceSheet {
        let asset = self.w.lock_token();
        BalanceSheet {
            sender: asset.balance(&self.w.user),
            treasury: asset.balance(&self.w.treasury),
            adapter: asset.balance(&self.w.bare_id) + asset.balance(&self.w.adapter_id),
            router: asset.balance(&self.w.router_id),
            recipient: asset.balance(&self.w.recipient),
            // LockUnlock transfers principal into `MockTokenManager` (`manager_id`), so `rail_sink`
            // is read directly from the live on-chain token manager balance!
            rail_sink: self.w.manager().locked(&self.w.lock_asset),
        }
    }

    fn gas_sheet(&self) -> BalanceSheet {
        let gas = token::Client::new(&self.w.env, &self.gas_sac);
        BalanceSheet {
            sender: gas.balance(&self.w.user),
            treasury: gas.balance(&self.w.treasury),
            adapter: gas.balance(&self.w.bare_id) + gas.balance(&self.w.adapter_id),
            router: gas.balance(&self.w.router_id),
            recipient: gas.balance(&self.w.recipient),
            rail_sink: gas.balance(&self.w.its_id),
        }
    }

    fn its_request(
        &self,
        token: Address,
        amount: i128,
        min_destination_amount: i128,
    ) -> OutboundRequest {
        OutboundRequest {
            token,
            amount,
            route: RouteKind::AxelarIts,
            destination: Destination {
                chain: self.w.ethereum(),
                address: self.w.evm(0x33),
            },
            destination_decimals: EVM_DECIMALS,
            min_destination_amount,
        }
    }
}

#[test]
fn paid_its_mint_burn_and_lock_unlock_separate_source_dust_from_native_relay_currency() {
    let mut h = ItsConservationHarness::new();

    // 1. MintBurn asset (`token_id`) with 7 stroops of 7-to-6 decimal source dust + 2_500_000 XLM gas.
    let mb0 = h.mint_burn_sheet();
    let g0 = h.gas_sheet();
    let req_mb = h.its_request(h.w.token_id.clone(), HUNDRED + 7, 0);
    h.w.router()
        .bridge_out_with_gas(&h.w.user, &req_mb, &2_500_000);
    let rec_mb = h.w.its().last_transfer();
    assert!(rec_mb.gas_attached);
    h.mint_burn_sink += rec_mb.amount;
    let mb1 = h.mint_burn_sheet();
    let g1 = h.gas_sheet();

    assert_eq!(
        audit_its_step(
            "its_mint_burn_paid_outbound_dust_7",
            ExpectedItsStep::PaidOutbound {
                requested_amount: HUNDRED + 7,
                fee_bps: FEE_BPS,
                destination_decimals: EVM_DECIMALS,
                relay_gas_amount: 2_500_000,
            },
            mb0,
            mb1,
            g0,
            g1,
        ),
        Vec::new()
    );
    assert_eq!(mb0.sender - mb1.sender, HUNDRED);
    assert_eq!(g0.sender - g1.sender, 2_500_000);
    assert_eq!(g1.rail_sink - g0.rail_sink, 2_500_000);

    // 2. LockUnlock asset (`lock_asset`) with 9 stroops of 7-to-6 decimal source dust + 3_250_000 XLM gas.
    let lu0 = h.lock_unlock_sheet();
    let req_lu = h.its_request(h.w.lock_asset.clone(), HUNDRED + 9, 0);
    h.w.router()
        .bridge_out_with_gas(&h.w.user, &req_lu, &3_250_000);
    let lu1 = h.lock_unlock_sheet();
    let g2 = h.gas_sheet();

    assert_eq!(
        audit_its_step(
            "its_lock_unlock_paid_outbound_dust_9",
            ExpectedItsStep::PaidOutbound {
                requested_amount: HUNDRED + 9,
                fee_bps: FEE_BPS,
                destination_decimals: EVM_DECIMALS,
                relay_gas_amount: 3_250_000,
            },
            lu0,
            lu1,
            g1,
            g2,
        ),
        Vec::new()
    );
    assert_eq!(lu0.sender - lu1.sender, HUNDRED);
    assert_eq!(lu1.rail_sink, net_of(HUNDRED + 9));
}

#[test]
fn failed_paid_its_transfers_roll_back_principal_and_relay_currency_atomically() {
    let h = ItsConservationHarness::new();
    let mb0 = h.mint_burn_sheet();
    let lu0 = h.lock_unlock_sheet();
    let g0 = h.gas_sheet();
    let count0 = h.w.its().transfer_count();

    // 1. Insufficient relay gas unwinds fee transfer and MintBurn burn.
    assert!(h
        .w
        .router()
        .try_bridge_out_with_gas(
            &h.w.user,
            &h.its_request(h.w.token_id.clone(), HUNDRED + 5, 0),
            &(HUNDRED * 100),
        )
        .is_err());
    assert_eq!(h.w.its().transfer_count(), count0);
    assert_eq!(
        audit_its_step(
            "its_failed_insufficient_gas_mint_burn",
            ExpectedItsStep::FailedRollback,
            mb0,
            h.mint_burn_sheet(),
            g0,
            h.gas_sheet(),
        ),
        Vec::new()
    );

    // 2. Insufficient relay gas also unwinds LockUnlock transfer to TokenManager.
    assert!(h
        .w
        .router()
        .try_bridge_out_with_gas(
            &h.w.user,
            &h.its_request(h.w.lock_asset.clone(), HUNDRED + 5, 0),
            &(HUNDRED * 100),
        )
        .is_err());
    assert_eq!(
        audit_its_step(
            "its_failed_insufficient_gas_lock_unlock",
            ExpectedItsStep::FailedRollback,
            lu0,
            h.lock_unlock_sheet(),
            g0,
            h.gas_sheet(),
        ),
        Vec::new()
    );

    // 3. Untrusted Axelar destination chain fails inside ITS after burn/lock and unwinds everything.
    h.w.its().set_trusted(&h.w.axelar_ethereum(), &false);
    assert!(h
        .w
        .router()
        .try_bridge_out_with_gas(
            &h.w.user,
            &h.its_request(h.w.lock_asset.clone(), HUNDRED + 8, 0),
            &1_000_000,
        )
        .is_err());
    assert_eq!(
        audit_its_step(
            "its_failed_untrusted_chain_rollback",
            ExpectedItsStep::FailedRollback,
            lu0,
            h.lock_unlock_sheet(),
            g0,
            h.gas_sheet(),
        ),
        Vec::new()
    );
    h.w.its().set_trusted(&h.w.axelar_ethereum(), &true);

    // 4. Paused router, slippage, zero gas, and unsupported route (`Allbridge`).
    h.w.router().pause(&h.w.guardian);
    assert_eq!(
        h.w.router().try_bridge_out_with_gas(
            &h.w.user,
            &h.its_request(h.w.token_id.clone(), HUNDRED + 3, 0),
            &1_000_000,
        ),
        Err(Ok(HyperionError::Paused))
    );
    assert_eq!(
        audit_its_step(
            "its_failed_paused_router",
            ExpectedItsStep::FailedRollback,
            mb0,
            h.mint_burn_sheet(),
            g0,
            h.gas_sheet(),
        ),
        Vec::new()
    );
    h.w.router().unpause(&h.w.admin);

    assert_eq!(
        h.w.router().try_bridge_out_with_gas(
            &h.w.user,
            &h.its_request(h.w.token_id.clone(), HUNDRED + 3, HUNDRED),
            &1_000_000,
        ),
        Err(Ok(HyperionError::SlippageExceeded))
    );
    assert_eq!(
        h.w.router().try_bridge_out_with_gas(
            &h.w.user,
            &h.its_request(h.w.token_id.clone(), HUNDRED + 3, 0),
            &0,
        ),
        Err(Ok(HyperionError::InvalidAmount))
    );
    let mut bad_route = h.its_request(h.w.token_id.clone(), HUNDRED + 3, 0);
    bad_route.route = RouteKind::Allbridge;
    assert_eq!(
        h.w.router()
            .try_bridge_out_with_gas(&h.w.user, &bad_route, &1_000_000),
        Err(Ok(HyperionError::UnsupportedRoute))
    );
    assert_eq!(
        audit_its_step(
            "its_failed_validation_rollbacks",
            ExpectedItsStep::FailedRollback,
            mb0,
            h.mint_burn_sheet(),
            g0,
            h.gas_sheet(),
        ),
        Vec::new()
    );
}

#[test]
fn inbound_its_deliveries_parked_claims_and_callback_rollbacks_conserve_balances() {
    let mut h = ItsConservationHarness::new();
    let mb0 = h.mint_burn_sheet();
    let g0 = h.gas_sheet();

    // 1. Direct delivery to contract recipient.
    let claim0 = h.w.its().deliver(
        &h.w.adapter_id,
        &h.w.axelar_ethereum(),
        &String::from_str(&h.w.env, "cons-msg-1"),
        &h.w.peer_bytes(),
        &h.w.note_to_recipient(10),
        &h.w.burn_id(),
        &HUNDRED,
    );
    assert_eq!(claim0, 0);
    h.mint_burn_sink -= HUNDRED;
    let mb1 = h.mint_burn_sheet();
    let g1 = h.gas_sheet();
    assert_eq!(
        audit_its_step(
            "its_inbound_direct_delivery",
            ExpectedItsStep::Inbound {
                minted_amount: HUNDRED,
                parked_as_claim: false,
            },
            mb0,
            mb1,
            g0,
            g1,
        ),
        Vec::new()
    );

    // 2. Delivery to classic account with missing trustline parks claim in router.
    let parked_id = h.w.its().deliver(
        &h.w.adapter_id,
        &h.w.axelar_ethereum(),
        &String::from_str(&h.w.env, "cons-msg-2"),
        &h.w.peer_bytes(),
        &h.w.note_to_classic(11),
        &h.w.burn_id(),
        &HUNDRED,
    );
    assert!(parked_id > 0);
    h.mint_burn_sink -= HUNDRED;
    let mb2 = h.mint_burn_sheet();
    let g2 = h.gas_sheet();
    assert_eq!(
        audit_its_step(
            "its_inbound_parked_claim",
            ExpectedItsStep::Inbound {
                minted_amount: HUNDRED,
                parked_as_claim: true,
            },
            mb1,
            mb2,
            g1,
            g2,
        ),
        Vec::new()
    );

    // 3. Rejected callback (impostor peer) unwinds ITS pre-callback mint to 0 delta, and failed
    // `settle_claim` keeps router claim balance untouched.
    assert!(h
        .w
        .its()
        .try_deliver(
            &h.w.adapter_id,
            &h.w.axelar_ethereum(),
            &String::from_str(&h.w.env, "cons-msg-impostor"),
            &Bytes::from_array(&h.w.env, &[0xEEu8; 20]),
            &h.w.note_to_recipient(12),
            &h.w.burn_id(),
            &HUNDRED,
        )
        .is_err());
    assert_eq!(
        h.w.router().try_settle_claim(&h.w.relayer, &parked_id),
        Err(Ok(HyperionError::RecipientNotReady))
    );
    assert_eq!(
        audit_its_step(
            "its_failed_callback_and_settlement_rollback",
            ExpectedItsStep::FailedRollback,
            mb2,
            h.mint_burn_sheet(),
            g2,
            h.gas_sheet(),
        ),
        Vec::new()
    );
}

#[test]
fn its_conservation_auditor_reports_exact_operation_and_signed_delta_for_fault_fixtures() {
    let p_before = BalanceSheet {
        sender: HUNDRED * 10,
        treasury: 0,
        adapter: 0,
        router: 0,
        recipient: 0,
        rail_sink: HUNDRED * 20,
    };
    let g_before = BalanceSheet {
        sender: HUNDRED * 5,
        treasury: 0,
        adapter: 0,
        router: 0,
        recipient: 0,
        rail_sink: 0,
    };

    // Fault: sender over-debited by 7 stroops of source dust, and ITS gas under-collected by 300.
    let p_fault = BalanceSheet {
        sender: p_before.sender - (HUNDRED + 7),
        treasury: 1_000_000,
        adapter: 7,
        router: 0,
        recipient: 0,
        rail_sink: p_before.rail_sink + 999_000_000,
    };
    let g_fault = BalanceSheet {
        sender: g_before.sender - 2_500_000,
        treasury: 0,
        adapter: 300,
        router: 0,
        recipient: 0,
        rail_sink: 2_499_700,
    };

    let violations = audit_its_step(
        "fault_its_dust_and_gas_split",
        ExpectedItsStep::PaidOutbound {
            requested_amount: HUNDRED + 7,
            fee_bps: FEE_BPS,
            destination_decimals: EVM_DECIMALS,
            relay_gas_amount: 2_500_000,
        },
        p_before,
        p_fault,
        g_before,
        g_fault,
    );
    assert!(violations.iter().any(|v| {
        v.operation == "fault_its_dust_and_gas_split"
            && v.ledger_leg == LedgerLeg::SourceDust
            && v.account == AccountRole::Sender
            && v.expected_delta == 7
            && v.actual_delta == 0
            && v.balance_delta_discrepancy == -7
    }));
    assert!(violations.iter().any(|v| {
        v.operation == "fault_its_dust_and_gas_split"
            && v.ledger_leg == LedgerLeg::RelayCurrency
            && v.account == AccountRole::Adapter
            && v.balance_delta_discrepancy == 300
    }));
    assert!(violations.iter().any(|v| {
        v.operation == "fault_its_dust_and_gas_split"
            && v.ledger_leg == LedgerLeg::RelayCurrency
            && v.account == AccountRole::RailSink
            && v.balance_delta_discrepancy == -300
    }));
}
