//! Multi-currency token conservation invariant harness for local CCTP paths.
//!
//! Tracks `sender`, `treasury`, `adapter`, `router`, `recipient`, and Circle `rail_sink` balances
//! across successful and failed paid transfers, Circle sub-unit dust sweeps, inbound deliveries,
//! and parked claims while accounting separately for 7-to-6 decimal `source_dust` and relay gas
//! currency.

extern crate std;

use std::vec::Vec;

use hyperion_core::{
    amount::{apply_fee, floor_to_representable},
    HyperionError, RouteKind, STELLAR_DECIMALS,
};
use hyperion_router::{Destination, OutboundRequest};
use soroban_sdk::{token, BytesN};

use super::setup::{World, EVM_DECIMALS, FEE_BPS, HUNDRED};

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
enum ExpectedStep {
    PaidOutbound {
        requested_amount: i128,
        fee_bps: u32,
        destination_decimals: u32,
        in_band_relay_budget: i128,
        rail_sub_unit_dust: i128,
    },
    Sweep {
        swept_amount: i128,
    },
    Inbound {
        minted_amount: i128,
        parked_as_claim: bool,
    },
    FailedRollback,
}

fn audit_cctp_step(
    operation: &'static str,
    step: ExpectedStep,
    principal_before: BalanceSheet,
    principal_after: BalanceSheet,
    gas_before: BalanceSheet,
    gas_after: BalanceSheet,
) -> Vec<ConservationViolation> {
    let mut violations = Vec::new();
    let mut expected_p = BalanceSheet::default();
    let expected_g = BalanceSheet::default();

    match step {
        ExpectedStep::PaidOutbound {
            requested_amount,
            fee_bps,
            destination_decimals,
            in_band_relay_budget,
            rail_sub_unit_dust,
        } => {
            let split = apply_fee(requested_amount, fee_bps).expect("valid fee split");
            let net = floor_to_representable(split.net, STELLAR_DECIMALS, destination_decimals)
                .expect("valid decimal floor");
            assert!(
                in_band_relay_budget > 0 && in_band_relay_budget < net,
                "CCTP in-band relay budget must come strictly from net burned principal"
            );
            let gross = split.fee + net;
            let expected_source_dust = requested_amount - gross;

            expected_p.sender = -gross;
            expected_p.treasury = split.fee;
            expected_p.adapter = rail_sub_unit_dust;
            expected_p.rail_sink = net - rail_sub_unit_dust;

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
        ExpectedStep::Sweep { swept_amount } => {
            expected_p.adapter = -swept_amount;
            expected_p.treasury = swept_amount;
        }
        ExpectedStep::Inbound {
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
        ExpectedStep::FailedRollback => {}
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

    // CCTP forwarding fees are carved in-band out of USDC; separate native gas must never move.
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

struct CctpConservationHarness {
    w: World,
    gas_token_id: soroban_sdk::Address,
    rail_sink_balance: i128,
}

impl CctpConservationHarness {
    fn new() -> Self {
        let w = World::new();
        let gas_token_id = w
            .env
            .register_stellar_asset_contract_v2(w.admin.clone())
            .address();
        token::StellarAssetClient::new(&w.env, &gas_token_id).mint(&w.user, &(HUNDRED * 5));
        Self {
            w,
            gas_token_id,
            rail_sink_balance: HUNDRED * 20,
        }
    }

    fn principal_sheet(&self) -> BalanceSheet {
        let asset = self.w.token();
        BalanceSheet {
            sender: asset.balance(&self.w.user),
            treasury: asset.balance(&self.w.treasury),
            adapter: asset.balance(&self.w.adapter_id),
            router: asset.balance(&self.w.router_id),
            recipient: asset.balance(&self.w.recipient),
            rail_sink: self.rail_sink_balance,
        }
    }

    fn gas_sheet(&self) -> BalanceSheet {
        let gas = token::Client::new(&self.w.env, &self.gas_token_id);
        BalanceSheet {
            sender: gas.balance(&self.w.user),
            treasury: gas.balance(&self.w.treasury),
            adapter: gas.balance(&self.w.adapter_id),
            router: gas.balance(&self.w.router_id),
            recipient: gas.balance(&self.w.recipient),
            rail_sink: gas.balance(&self.w.messenger_id),
        }
    }

    fn paid_request(&self, amount: i128, min_destination_amount: i128) -> OutboundRequest {
        let mut recipient = [0u8; 32];
        recipient[12..].fill(0x22);
        OutboundRequest {
            token: self.w.token_id.clone(),
            amount,
            route: RouteKind::Cctp,
            destination: Destination {
                chain: self.w.ethereum(),
                address: BytesN::from_array(&self.w.env, &recipient),
            },
            destination_decimals: EVM_DECIMALS,
            min_destination_amount,
        }
    }
}

#[test]
fn paid_cctp_transfers_conserve_principal_separate_source_dust_and_sweep_rail_dust() {
    let mut h = CctpConservationHarness::new();

    // 1. Paid outbound with 9 stroops of 7-to-6 decimal source dust + 1_000_000 in-band fee budget.
    let p0 = h.principal_sheet();
    let g0 = h.gas_sheet();
    let req1 = h.paid_request(HUNDRED + 9, 0);
    h.w.router()
        .bridge_out_with_gas(&h.w.user, &req1, &1_000_000);
    let burn1 = h.w.messenger().last_burn();
    assert_eq!(burn1.max_fee, 1_000_000);
    h.rail_sink_balance += burn1.burned;
    let p1 = h.principal_sheet();
    let g1 = h.gas_sheet();

    assert_eq!(
        audit_cctp_step(
            "cctp_paid_outbound_source_dust_9",
            ExpectedStep::PaidOutbound {
                requested_amount: HUNDRED + 9,
                fee_bps: FEE_BPS,
                destination_decimals: EVM_DECIMALS,
                in_band_relay_budget: 1_000_000,
                rail_sub_unit_dust: 0,
            },
            p0,
            p1,
            g0,
            g1,
        ),
        Vec::new()
    );
    // Explicitly confirm the 9 stroops of unrepresentable source dust stayed in sender's wallet.
    assert_eq!(p0.sender - p1.sender, HUNDRED);

    // 2. Enable 3 stroops of Circle sub-unit burn dust on the messenger, send HUNDRED + 7, then sweep.
    h.w.messenger().init(&3i128, &0i128);
    let req2 = h.paid_request(HUNDRED + 7, 0);
    h.w.router()
        .bridge_out_with_gas(&h.w.user, &req2, &2_000_000);
    let burn2 = h.w.messenger().last_burn();
    h.rail_sink_balance += burn2.burned;
    let p2 = h.principal_sheet();
    let g2 = h.gas_sheet();

    assert_eq!(
        audit_cctp_step(
            "cctp_paid_outbound_with_circle_dust_3",
            ExpectedStep::PaidOutbound {
                requested_amount: HUNDRED + 7,
                fee_bps: FEE_BPS,
                destination_decimals: EVM_DECIMALS,
                in_band_relay_budget: 2_000_000,
                rail_sub_unit_dust: 3,
            },
            p1,
            p2,
            g1,
            g2,
        ),
        Vec::new()
    );
    assert_eq!(p2.adapter, 3);

    // 3. Permissionless sweep moves the 3 stroops of rail dust from adapter to treasury.
    let swept = h.w.adapter().sweep(&h.w.relayer, &h.w.token_id);
    assert_eq!(swept, 3);
    let p3 = h.principal_sheet();
    let g3 = h.gas_sheet();
    assert_eq!(
        audit_cctp_step(
            "cctp_sweep_rail_dust_to_treasury",
            ExpectedStep::Sweep { swept_amount: 3 },
            p2,
            p3,
            g2,
            g3,
        ),
        Vec::new()
    );
}

#[test]
fn failed_paid_cctp_transfers_preserve_zero_balance_deltas_across_all_accounts() {
    let h = CctpConservationHarness::new();
    let p0 = h.principal_sheet();
    let g0 = h.gas_sheet();
    let burns_before = h.w.messenger().burn_count();

    // 1. Slippage exceeded once in-band forwarding budget is deducted.
    let net = super::setup::net_of(HUNDRED);
    let req_slippage = h.paid_request(HUNDRED + 6, net / 10);
    assert_eq!(
        h.w.router()
            .try_bridge_out_with_gas(&h.w.user, &req_slippage, &1_000_000),
        Err(Ok(HyperionError::SlippageExceeded))
    );
    assert_eq!(h.w.messenger().burn_count(), burns_before);
    assert_eq!(
        audit_cctp_step(
            "cctp_failed_slippage",
            ExpectedStep::FailedRollback,
            p0,
            h.principal_sheet(),
            g0,
            h.gas_sheet(),
        ),
        Vec::new()
    );

    // 2. Invalid forwarding fee budgets (zero, negative, unrepresentable, >= net).
    for invalid_budget in [-1i128, 0, 1, net] {
        assert!(h
            .w
            .router()
            .try_bridge_out_with_gas(&h.w.user, &h.paid_request(HUNDRED + 4, 0), &invalid_budget)
            .is_err());
        assert_eq!(h.w.messenger().burn_count(), burns_before);
        assert_eq!(
            audit_cctp_step(
                "cctp_failed_invalid_gas_budget",
                ExpectedStep::FailedRollback,
                p0,
                h.principal_sheet(),
                g0,
                h.gas_sheet(),
            ),
            Vec::new()
        );
    }

    // 3. Paused router.
    h.w.router().pause(&h.w.guardian);
    assert_eq!(
        h.w.router().try_bridge_out_with_gas(
            &h.w.user,
            &h.paid_request(HUNDRED + 5, 0),
            &1_000_000
        ),
        Err(Ok(HyperionError::Paused))
    );
    assert_eq!(
        audit_cctp_step(
            "cctp_failed_paused_router",
            ExpectedStep::FailedRollback,
            p0,
            h.principal_sheet(),
            g0,
            h.gas_sheet(),
        ),
        Vec::new()
    );
    h.w.router().unpause(&h.w.admin);

    // 4. Non-zero restricted destination_caller rejects paid forwarding without moving funds.
    h.w.adapter().link_domain(
        &h.w.ethereum(),
        &0,
        &BytesN::from_array(&h.w.env, &[0xAB; 32]),
    );
    assert_eq!(
        h.w.router().try_bridge_out_with_gas(
            &h.w.user,
            &h.paid_request(HUNDRED + 5, 0),
            &1_000_000
        ),
        Err(Ok(HyperionError::InvalidDestination))
    );
    assert_eq!(h.w.router().last_out_nonce(), 0);
    assert_eq!(
        audit_cctp_step(
            "cctp_failed_restricted_destination_caller",
            ExpectedStep::FailedRollback,
            p0,
            h.principal_sheet(),
            g0,
            h.gas_sheet(),
        ),
        Vec::new()
    );
}

#[test]
fn inbound_cctp_deliveries_and_parked_claims_conserve_closed_loop_balances() {
    let mut h = CctpConservationHarness::new();
    h.w.transmitter().set_fee(&250_000);
    let arriving = 500_000_000i128;
    let net_minted = arriving - 250_000;

    // 1. Direct contract delivery credits `recipient` by exact minted delta (`arriving - fee`).
    let p0 = h.principal_sheet();
    let g0 = h.gas_sheet();
    let claim_id = h.w.adapter().receive(
        &h.w.relayer,
        &h.w.inbound(arriving, 901),
        &h.w.attestation(),
    );
    assert_eq!(claim_id, 0);
    h.rail_sink_balance -= net_minted;
    let p1 = h.principal_sheet();
    let g1 = h.gas_sheet();
    assert_eq!(
        audit_cctp_step(
            "cctp_inbound_direct_with_fast_fee",
            ExpectedStep::Inbound {
                minted_amount: net_minted,
                parked_as_claim: false,
            },
            p0,
            p1,
            g0,
            g1,
        ),
        Vec::new()
    );

    // 2. Classic recipient without trustline parks exact minted amount in `router`.
    let parked_id = h.w.adapter().receive(
        &h.w.relayer,
        &h.w.inbound_to_classic(arriving, 902),
        &h.w.attestation(),
    );
    assert_eq!(parked_id, 1);
    h.rail_sink_balance -= net_minted;
    let p2 = h.principal_sheet();
    let g2 = h.gas_sheet();
    assert_eq!(
        audit_cctp_step(
            "cctp_inbound_parked_claim",
            ExpectedStep::Inbound {
                minted_amount: net_minted,
                parked_as_claim: true,
            },
            p1,
            p2,
            g1,
            g2,
        ),
        Vec::new()
    );

    // 3. Failed `settle_claim` while recipient still lacks trustline preserves exact 0 delta.
    assert_eq!(
        h.w.router().try_settle_claim(&h.w.relayer, &parked_id),
        Err(Ok(HyperionError::RecipientNotReady))
    );
    assert_eq!(
        audit_cctp_step(
            "cctp_failed_settle_claim",
            ExpectedStep::FailedRollback,
            p2,
            h.principal_sheet(),
            g2,
            h.gas_sheet(),
        ),
        Vec::new()
    );
}

#[test]
fn cctp_conservation_auditor_pinpoints_operation_and_signed_balance_delta_on_fault() {
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

    // Fault 1: Sender is over-debited by 9 stroops of source dust, left stranded in `adapter`.
    let p_fault = BalanceSheet {
        sender: p_before.sender - (HUNDRED + 9),
        treasury: 1_000_000,
        adapter: 9,
        router: 0,
        recipient: 0,
        rail_sink: p_before.rail_sink + 999_000_000,
    };
    let violations = audit_cctp_step(
        "fault_cctp_dust_overpull",
        ExpectedStep::PaidOutbound {
            requested_amount: HUNDRED + 9,
            fee_bps: FEE_BPS,
            destination_decimals: EVM_DECIMALS,
            in_band_relay_budget: 1_000_000,
            rail_sub_unit_dust: 0,
        },
        p_before,
        p_fault,
        g_before,
        g_before,
    );
    assert!(violations.iter().any(|v| {
        v.operation == "fault_cctp_dust_overpull"
            && v.ledger_leg == LedgerLeg::SourceDust
            && v.account == AccountRole::Sender
            && v.expected_delta == 9
            && v.actual_delta == 0
            && v.balance_delta_discrepancy == -9
    }));
    assert!(violations.iter().any(|v| {
        v.operation == "fault_cctp_dust_overpull"
            && v.ledger_leg == LedgerLeg::Principal
            && v.account == AccountRole::Adapter
            && v.balance_delta_discrepancy == 9
    }));

    // Fault 2: Relay gas leaks 450 stroops from sender on a failed rollback.
    let mut g_fault = g_before;
    g_fault.sender -= 450;
    g_fault.adapter += 450;
    let gas_violations = audit_cctp_step(
        "fault_cctp_rollback_gas_leak",
        ExpectedStep::FailedRollback,
        p_before,
        p_before,
        g_before,
        g_fault,
    );
    assert!(gas_violations.iter().any(|v| {
        v.operation == "fault_cctp_rollback_gas_leak"
            && v.ledger_leg == LedgerLeg::RelayCurrency
            && v.account == AccountRole::Sender
            && v.balance_delta_discrepancy == -450
    }));
}
