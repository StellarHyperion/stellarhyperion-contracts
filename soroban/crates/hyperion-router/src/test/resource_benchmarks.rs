//! Reproducible Soroban CPU and memory budget benchmarks for `HyperionRouter`.
//!
//! Measures representative `quote_routes`, `bridge_out`, `bridge_out_with_gas`, `bridge_in`
//! (direct delivery and parked claim), `settle_claim`, and batched `keep_alive` paths against
//! the pinned `soroban-sdk 28.0.0` / `soroban-env-host 28.0.2` cost model, including fixtures with
//! large-but-valid stored records (`TransferRecord` and `PendingClaim` with 64-byte chain names,
//! 128-byte raw recipient payloads, active rolling flow windows, and pre-populated storage).

extern crate std;

use std::{format, string::String as StdString, vec::Vec as StdVec};

use hyperion_core::{AddressKind, RouteKind, DEFAULT_FLOW_WINDOW_LEDGERS, STELLAR_DECIMALS};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl,
    testutils::{Address as _, EnvTestConfig, Ledger},
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec,
};

use super::doubles::{all_routes, evm_destination, FailableToken, FailableTokenClient};
use super::setup::{EVM_DECIMALS, FEE_BPS, FLOW_LIMIT, HUNDRED};
use crate::types::{AdminAction, Destination, Origin, OutboundRequest, Recipient, RouteConfig};
use crate::{HyperionRouter, HyperionRouterClient, MIN_TIMELOCK_DELAY};

/// Pinned Soroban transaction-level CPU instruction ceiling (`BudgetImpl::default()`).
pub const SOROBAN_TX_CPU_LIMIT_INSNS: u64 = 100_000_000;
/// Pinned Soroban transaction-level memory ceiling (`40 MiB` = `41_943_040` bytes).
pub const SOROBAN_TX_MEM_LIMIT_BYTES: u64 = 41_943_040;
/// Pinned `soroban-sdk` crate version in `soroban/Cargo.toml`.
pub const PINNED_SOROBAN_SDK_VERSION: &str = "28.0.0";
/// Pinned vendored `soroban-env-host` crate version in `soroban/vendor/soroban-env-host`.
pub const PINNED_SOROBAN_ENV_HOST_VERSION: &str = "28.0.2";
/// Default ledger protocol version under `soroban-sdk 28.0.0` / `soroban-env-host 28.0.2`.
pub const PINNED_LEDGER_PROTOCOL_VERSION: u32 = 28;

pub const PINNED_ROUTER_BASELINES: [BenchmarkBaseline; 9] = [
    BenchmarkBaseline {
        operation: "quote_routes_compact",
        expected_input_bytes: 80,
        expected_stored_record_bytes: 1436,
        baseline_cpu_insns: 620_116,
        baseline_mem_bytes: 202_387,
        tolerance_bps: 500,
    },
    BenchmarkBaseline {
        operation: "bridge_out_compact",
        expected_input_bytes: 388,
        expected_stored_record_bytes: 456,
        baseline_cpu_insns: 755_523,
        baseline_mem_bytes: 297_851,
        tolerance_bps: 500,
    },
    BenchmarkBaseline {
        operation: "quote_routes_large_stored_state",
        expected_input_bytes: 80,
        expected_stored_record_bytes: 1436,
        baseline_cpu_insns: 788_236,
        baseline_mem_bytes: 277_323,
        tolerance_bps: 500,
    },
    BenchmarkBaseline {
        operation: "bridge_out_large_stored_record",
        expected_input_bytes: 444,
        expected_stored_record_bytes: 512,
        baseline_cpu_insns: 1_237_119,
        baseline_mem_bytes: 512_686,
        tolerance_bps: 500,
    },
    BenchmarkBaseline {
        operation: "bridge_out_with_gas_large_stored_record",
        expected_input_bytes: 464,
        expected_stored_record_bytes: 512,
        baseline_cpu_insns: 1_140_072,
        baseline_mem_bytes: 472_095,
        tolerance_bps: 500,
    },
    BenchmarkBaseline {
        operation: "bridge_in_direct_large_payload",
        expected_input_bytes: 600,
        expected_stored_record_bytes: 32,
        baseline_cpu_insns: 635_239,
        baseline_mem_bytes: 301_125,
        tolerance_bps: 500,
    },
    BenchmarkBaseline {
        operation: "bridge_in_park_large_claim_record",
        expected_input_bytes: 600,
        expected_stored_record_bytes: 392,
        baseline_cpu_insns: 873_442,
        baseline_mem_bytes: 395_871,
        tolerance_bps: 500,
    },
    BenchmarkBaseline {
        operation: "settle_claim_large_stored_record",
        expected_input_bytes: 64,
        expected_stored_record_bytes: 392,
        baseline_cpu_insns: 548_632,
        baseline_mem_bytes: 270_626,
        tolerance_bps: 500,
    },
    BenchmarkBaseline {
        operation: "keep_alive_large_batch",
        expected_input_bytes: 636,
        expected_stored_record_bytes: 68,
        baseline_cpu_insns: 4_025_009,
        baseline_mem_bytes: 1_486_695,
        tolerance_bps: 500,
    },
];

/// Minimal rail double supporting `dispatch`, `dispatch_from` (paid transfers), and `deliver`
/// with caller-controlled `Origin` / `Recipient.raw` byte sizes for benchmark fixtures.
#[contract]
pub struct BenchRail;

#[contractimpl]
impl BenchRail {
    pub fn dispatch(
        _env: Env,
        caller: Address,
        _token: Address,
        _amount: i128,
        _destination_chain: String,
        _destination: BytesN<32>,
        _nonce: u64,
    ) {
        caller.require_auth();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn dispatch_from(
        env: Env,
        caller: Address,
        sender: Address,
        token: Address,
        amount: i128,
        _destination_chain: String,
        _destination: BytesN<32>,
        _nonce: u64,
        _gas_amount: i128,
    ) {
        caller.require_auth();
        sender.require_auth();
        let this = env.current_contract_address();
        soroban_sdk::token::Client::new(&env, &token).transfer(&sender, &this, &amount);
    }

    pub fn deliver_custom(
        env: Env,
        router: Address,
        route: RouteKind,
        token: Address,
        amount: i128,
        recipient: Recipient,
        origin: Origin,
    ) -> u64 {
        let this = env.current_contract_address();
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (this.clone(), router.clone(), amount).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);
        HyperionRouterClient::new(&env, &router)
            .bridge_in(&this, &route, &token, &amount, &recipient, &origin)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceAssumptions {
    pub soroban_sdk_version: &'static str,
    pub soroban_env_host_version: &'static str,
    pub ledger_protocol_version: u32,
    pub tx_cpu_limit_insns: u64,
    pub tx_mem_limit_bytes: u64,
}

impl ResourceAssumptions {
    pub fn pinned() -> Self {
        Self {
            soroban_sdk_version: PINNED_SOROBAN_SDK_VERSION,
            soroban_env_host_version: PINNED_SOROBAN_ENV_HOST_VERSION,
            ledger_protocol_version: PINNED_LEDGER_PROTOCOL_VERSION,
            tx_cpu_limit_insns: SOROBAN_TX_CPU_LIMIT_INSNS,
            tx_mem_limit_bytes: SOROBAN_TX_MEM_LIMIT_BYTES,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BenchmarkSample {
    pub operation: &'static str,
    pub input_bytes: u64,
    pub stored_record_bytes: u64,
    pub seeded_claims: u32,
    pub seeded_transfers: u32,
    pub cpu_insns: u64,
    pub mem_bytes: u64,
    pub assumptions: ResourceAssumptions,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BenchmarkBaseline {
    pub operation: &'static str,
    pub expected_input_bytes: u64,
    pub expected_stored_record_bytes: u64,
    pub baseline_cpu_insns: u64,
    pub baseline_mem_bytes: u64,
    /// Allowed upward drift in basis points (`500` = `+5.00%`) before flagging regression.
    pub tolerance_bps: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionableRegressionDelta {
    pub operation: &'static str,
    pub cpu_delta_insns: i64,
    pub cpu_delta_bps: i64,
    pub cpu_ceiling_overrun_insns: i64,
    pub cpu_tx_headroom_insns: i64,
    pub mem_delta_bytes: i64,
    pub mem_delta_bps: i64,
    pub mem_ceiling_overrun_bytes: i64,
    pub mem_tx_headroom_bytes: i64,
    pub input_size_delta_bytes: i64,
    pub stored_record_delta_bytes: i64,
    pub regressed: bool,
    pub assumption_mismatch: bool,
    pub summary: StdString,
}

pub fn evaluate_benchmark_delta(
    sample: &BenchmarkSample,
    baseline: &BenchmarkBaseline,
    expected_assumptions: &ResourceAssumptions,
) -> ActionableRegressionDelta {
    let cpu_ceiling = baseline
        .baseline_cpu_insns
        .saturating_mul(10_000 + u64::from(baseline.tolerance_bps))
        / 10_000;
    let mem_ceiling = baseline
        .baseline_mem_bytes
        .saturating_mul(10_000 + u64::from(baseline.tolerance_bps))
        / 10_000;

    let cpu_delta_insns = sample.cpu_insns as i64 - baseline.baseline_cpu_insns as i64;
    let cpu_delta_bps = if baseline.baseline_cpu_insns > 0 {
        (cpu_delta_insns * 10_000) / (baseline.baseline_cpu_insns as i64)
    } else {
        0
    };
    let cpu_ceiling_overrun_insns = sample.cpu_insns as i64 - cpu_ceiling as i64;
    let cpu_tx_headroom_insns =
        sample.assumptions.tx_cpu_limit_insns as i64 - sample.cpu_insns as i64;

    let mem_delta_bytes = sample.mem_bytes as i64 - baseline.baseline_mem_bytes as i64;
    let mem_delta_bps = if baseline.baseline_mem_bytes > 0 {
        (mem_delta_bytes * 10_000) / (baseline.baseline_mem_bytes as i64)
    } else {
        0
    };
    let mem_ceiling_overrun_bytes = sample.mem_bytes as i64 - mem_ceiling as i64;
    let mem_tx_headroom_bytes =
        sample.assumptions.tx_mem_limit_bytes as i64 - sample.mem_bytes as i64;

    let input_size_delta_bytes = sample.input_bytes as i64 - baseline.expected_input_bytes as i64;
    let stored_record_delta_bytes =
        sample.stored_record_bytes as i64 - baseline.expected_stored_record_bytes as i64;
    let assumption_mismatch = &sample.assumptions != expected_assumptions
        || input_size_delta_bytes != 0
        || stored_record_delta_bytes != 0;
    let regressed =
        cpu_ceiling_overrun_insns > 0 || mem_ceiling_overrun_bytes > 0 || assumption_mismatch;

    let status = if regressed { "REGRESSION" } else { "OK" };
    let summary = format!(
        "[{status}] op={} | input={}B (delta={:+}B) | record={}B (delta={:+}B) | cpuDelta={:+} insns ({:+} bps, ceilingOverrun={:+}, txHeadroom={}) | memDelta={:+} B ({:+} bps, ceilingOverrun={:+}, txHeadroom={}) | proto=v{} host={}",
        sample.operation,
        sample.input_bytes,
        input_size_delta_bytes,
        sample.stored_record_bytes,
        stored_record_delta_bytes,
        cpu_delta_insns,
        cpu_delta_bps,
        cpu_ceiling_overrun_insns,
        cpu_tx_headroom_insns,
        mem_delta_bytes,
        mem_delta_bps,
        mem_ceiling_overrun_bytes,
        mem_tx_headroom_bytes,
        sample.assumptions.ledger_protocol_version,
        sample.assumptions.soroban_env_host_version,
    );

    ActionableRegressionDelta {
        operation: sample.operation,
        cpu_delta_insns,
        cpu_delta_bps,
        cpu_ceiling_overrun_insns,
        cpu_tx_headroom_insns,
        mem_delta_bytes,
        mem_delta_bps,
        mem_ceiling_overrun_bytes,
        mem_tx_headroom_bytes,
        input_size_delta_bytes,
        stored_record_delta_bytes,
        regressed,
        assumption_mismatch,
        summary,
    }
}

struct BenchHarness {
    env: Env,
    router_id: Address,
    rail_id: Address,
    token_id: Address,
    extra_tokens: StdVec<Address>,
    admin: Address,
    treasury: Address,
    user: Address,
    recipient: Address,
    settler: Address,
    seeded_claims: u32,
    seeded_transfers: u32,
}

impl BenchHarness {
    fn new() -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.sequence_number = 100_000;
            li.timestamp = 1_700_000_000;
            li.min_persistent_entry_ttl = 4096;
            li.min_temp_entry_ttl = 16;
            li.max_entry_ttl = 6_312_000;
        });

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);
        let recipient = Address::generate(&env);
        let settler = Address::generate(&env);

        let token_id = env.register(FailableToken, ());
        FailableTokenClient::new(&env, &token_id).init(&STELLAR_DECIMALS);
        FailableTokenClient::new(&env, &token_id).mint(&user, &(HUNDRED * 1_000));
        FailableTokenClient::new(&env, &token_id).mint(&treasury, &0);

        let router_id = env.register(HyperionRouter, ());
        let rail_id = env.register(BenchRail, ());
        FailableTokenClient::new(&env, &token_id).mint(&rail_id, &(HUNDRED * 1_000));

        let router = HyperionRouterClient::new(&env, &router_id);
        router.initialize(
            &admin,
            &guardian,
            &treasury,
            &FEE_BPS,
            &DEFAULT_FLOW_WINDOW_LEDGERS,
            &MIN_TIMELOCK_DELAY,
        );

        let h = Self {
            env,
            router_id,
            rail_id,
            token_id,
            extra_tokens: StdVec::new(),
            admin,
            treasury,
            user,
            recipient,
            settler,
            seeded_claims: 0,
            seeded_transfers: 0,
        };

        for route in all_routes() {
            h.run_action(AdminAction::SetAdapter(route, h.rail_id.clone()));
            h.run_action(AdminAction::SetRailReceiver(route, h.rail_id.clone()));
            h.run_action(AdminAction::EnableRoute(route));
        }
        h.run_action(AdminAction::RegisterToken(
            h.token_id.clone(),
            STELLAR_DECIMALS,
            FLOW_LIMIT * 100,
        ));
        h
    }

    fn run_action(&self, action: AdminAction) {
        let router = HyperionRouterClient::new(&self.env, &self.router_id);
        let id = router.queue_action(&self.admin, &action);
        self.env.ledger().with_mut(|li| {
            li.timestamp += MIN_TIMELOCK_DELAY + 1;
        });
        router.execute_action(&self.admin, &id);
    }

    fn assumptions(&self) -> ResourceAssumptions {
        let mut protocol_version = 0u32;
        self.env.ledger().with_mut(|li| {
            protocol_version = li.protocol_version;
        });
        ResourceAssumptions {
            soroban_sdk_version: PINNED_SOROBAN_SDK_VERSION,
            soroban_env_host_version: PINNED_SOROBAN_ENV_HOST_VERSION,
            ledger_protocol_version: protocol_version,
            tx_cpu_limit_insns: SOROBAN_TX_CPU_LIMIT_INSNS,
            tx_mem_limit_bytes: SOROBAN_TX_MEM_LIMIT_BYTES,
        }
    }

    /// Populate realistic large-but-valid stored records across persistent storage:
    /// - 3 additional registered tokens (4 total)
    /// - `RouteConfig` (`max_single_transfer`) and `RouteFlowLimit` overrides on all 4 routes
    /// - 16 outbound `TransferRecord`s carrying 64-byte destination chain names and active
    ///   `FlowWindow`s across all 4 routes
    /// - 16 parked `PendingClaim`s carrying 64-byte source chain names and 128-byte raw payloads
    fn seed_large_stored_state(&mut self) {
        let long_chain = String::from_str(
            &self.env,
            "ethereum-optimism-arbitrum-avalanche-polygon-zkevm-hyperion-lane",
        );
        assert_eq!(long_chain.len(), 64);

        for _ in 0..3 {
            let extra = self.env.register(FailableToken, ());
            FailableTokenClient::new(&self.env, &extra).init(&STELLAR_DECIMALS);
            self.run_action(AdminAction::RegisterToken(
                extra.clone(),
                STELLAR_DECIMALS,
                FLOW_LIMIT * 100,
            ));
            for route in all_routes() {
                self.run_action(AdminAction::SetRouteConfig(
                    route,
                    RouteConfig {
                        max_single_transfer: HUNDRED * 50,
                    },
                ));
                self.run_action(AdminAction::SetRouteFlowLimit(
                    extra.clone(),
                    route,
                    FLOW_LIMIT * 50,
                ));
            }
            self.extra_tokens.push(extra);
        }

        for route in all_routes() {
            self.run_action(AdminAction::SetRouteConfig(
                route,
                RouteConfig {
                    max_single_transfer: HUNDRED * 50,
                },
            ));
            self.run_action(AdminAction::SetRouteFlowLimit(
                self.token_id.clone(),
                route,
                FLOW_LIMIT * 50,
            ));
        }

        let router = HyperionRouterClient::new(&self.env, &self.router_id);
        let rail = BenchRailClient::new(&self.env, &self.rail_id);
        let failable = FailableTokenClient::new(&self.env, &self.token_id);

        for idx in 0..16u32 {
            let route = all_routes()[(idx as usize) % 4];
            let req = OutboundRequest {
                token: self.token_id.clone(),
                amount: HUNDRED,
                route,
                destination: Destination {
                    chain: long_chain.clone(),
                    address: evm_destination(&self.env, (idx + 1) as u8),
                },
                destination_decimals: EVM_DECIMALS,
                min_destination_amount: 0,
            };
            router.bridge_out(&self.user, &req);
            self.seeded_transfers += 1;
        }

        failable.set_blocked(&self.recipient, &true);
        let raw_payload = Bytes::from_array(&self.env, &[0xA5u8; 128]);
        for idx in 1..=16u64 {
            let mut msg_id = [0u8; 32];
            msg_id[0] = 0xEE;
            msg_id[24..].copy_from_slice(&idx.to_be_bytes());
            let claim_id = rail.deliver_custom(
                &self.router_id,
                &RouteKind::AxelarGmp,
                &self.token_id,
                &HUNDRED,
                &Recipient {
                    address: self.recipient.clone(),
                    kind: AddressKind::MuxedAccount,
                    raw: raw_payload.clone(),
                },
                &Origin {
                    chain: long_chain.clone(),
                    nonce: u64::MAX - idx,
                    message_id: BytesN::from_array(&self.env, &msg_id),
                    sender: BytesN::from_array(&self.env, &[0xCCu8; 32]),
                },
            );
            assert_eq!(claim_id, idx);
            self.seeded_claims += 1;
        }
        failable.set_blocked(&self.recipient, &false);
        let _ = &self.treasury;
    }

    fn measure<F, R>(&self, operation: &'static str, input_bytes: u64, f: F) -> (R, BenchmarkSample)
    where
        F: FnOnce() -> R,
    {
        self.env.cost_estimate().budget().reset_default();
        let out = f();
        let cpu_insns = self.env.cost_estimate().budget().cpu_instruction_cost();
        let mem_bytes = self.env.cost_estimate().budget().memory_bytes_cost();
        let sample = BenchmarkSample {
            operation,
            input_bytes,
            stored_record_bytes: 0,
            seeded_claims: self.seeded_claims,
            seeded_transfers: self.seeded_transfers,
            cpu_insns,
            mem_bytes,
            assumptions: self.assumptions(),
        };
        (out, sample)
    }
}

pub fn collect_canonical_router_benchmarks() -> StdVec<BenchmarkSample> {
    let mut samples = StdVec::new();

    // 1. Compact world baseline for `quote_routes` and `bridge_out` (comparison against large records).
    let compact = BenchHarness::new();
    let router_compact = HyperionRouterClient::new(&compact.env, &compact.router_id);
    let quote_input_compact = (compact.token_id.clone(), HUNDRED, EVM_DECIMALS)
        .to_xdr(&compact.env)
        .len() as u64;
    let (quotes_c, mut s_quote_compact) =
        compact.measure("quote_routes_compact", quote_input_compact, || {
            router_compact.quote_routes(&compact.token_id, &HUNDRED, &EVM_DECIMALS)
        });
    s_quote_compact.stored_record_bytes = quotes_c.to_xdr(&compact.env).len() as u64;
    samples.push(s_quote_compact);

    let req_compact = OutboundRequest {
        token: compact.token_id.clone(),
        amount: HUNDRED,
        route: RouteKind::Cctp,
        destination: Destination {
            chain: String::from_str(&compact.env, "ethereum"),
            address: evm_destination(&compact.env, 0x01),
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    };
    let out_input_compact = (compact.user.clone(), req_compact.clone())
        .to_xdr(&compact.env)
        .len() as u64;
    let (nonce_c, mut s_out_compact) =
        compact.measure("bridge_out_compact", out_input_compact, || {
            router_compact.bridge_out(&compact.user, &req_compact)
        });
    s_out_compact.stored_record_bytes = router_compact
        .get_transfer(&nonce_c)
        .to_xdr(&compact.env)
        .len() as u64;
    samples.push(s_out_compact);

    // 2. Populated world with large-but-valid stored records.
    let mut large = BenchHarness::new();
    large.seed_large_stored_state();
    let router = HyperionRouterClient::new(&large.env, &large.router_id);
    let rail = BenchRailClient::new(&large.env, &large.rail_id);
    let failable = FailableTokenClient::new(&large.env, &large.token_id);

    let long_chain = String::from_str(
        &large.env,
        "ethereum-optimism-arbitrum-avalanche-polygon-zkevm-hyperion-lane",
    );

    // 2a. `quote_routes_large_stored_state`
    let quote_input_large = (large.token_id.clone(), HUNDRED, EVM_DECIMALS)
        .to_xdr(&large.env)
        .len() as u64;
    let (quotes_l, mut s_quote_large) =
        large.measure("quote_routes_large_stored_state", quote_input_large, || {
            router.quote_routes(&large.token_id, &HUNDRED, &EVM_DECIMALS)
        });
    s_quote_large.stored_record_bytes = quotes_l.to_xdr(&large.env).len() as u64;
    samples.push(s_quote_large);

    // 2b. `bridge_out_large_stored_record` (64-byte destination_chain stored in TransferRecord)
    let req_large = OutboundRequest {
        token: large.token_id.clone(),
        amount: HUNDRED + 7,
        route: RouteKind::AxelarGmp,
        destination: Destination {
            chain: long_chain.clone(),
            address: evm_destination(&large.env, 0x77),
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    };
    let out_input_large = (large.user.clone(), req_large.clone())
        .to_xdr(&large.env)
        .len() as u64;
    let (nonce_l, mut s_out_large) =
        large.measure("bridge_out_large_stored_record", out_input_large, || {
            router.bridge_out(&large.user, &req_large)
        });
    s_out_large.stored_record_bytes = router.get_transfer(&nonce_l).to_xdr(&large.env).len() as u64;
    samples.push(s_out_large);

    // 2c. `bridge_out_with_gas_large_stored_record` (paid CCTP forwarding with 64-byte chain)
    let req_paid = OutboundRequest {
        token: large.token_id.clone(),
        amount: HUNDRED + 9,
        route: RouteKind::Cctp,
        destination: Destination {
            chain: long_chain.clone(),
            address: evm_destination(&large.env, 0x88),
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    };
    let gas_budget = 1_000_000i128;
    let paid_input = (large.user.clone(), req_paid.clone(), gas_budget)
        .to_xdr(&large.env)
        .len() as u64;
    let (nonce_p, mut s_paid) = large.measure(
        "bridge_out_with_gas_large_stored_record",
        paid_input,
        || router.bridge_out_with_gas(&large.user, &req_paid, &gas_budget),
    );
    s_paid.stored_record_bytes = router.get_transfer(&nonce_p).to_xdr(&large.env).len() as u64;
    samples.push(s_paid);

    // 2d. `bridge_in_direct_large_payload` (128-byte muxed raw payload + 64-byte source_chain)
    let raw_payload = Bytes::from_array(&large.env, &[0x5Au8; 128]);
    let rec_direct = Recipient {
        address: large.recipient.clone(),
        kind: AddressKind::MuxedAccount,
        raw: raw_payload,
    };
    let orig_direct = Origin {
        chain: long_chain.clone(),
        nonce: 900_001,
        message_id: BytesN::from_array(&large.env, &[0x31u8; 32]),
        sender: BytesN::from_array(&large.env, &[0x41u8; 32]),
    };
    let in_direct_input = (
        large.rail_id.clone(),
        RouteKind::AxelarGmp,
        large.token_id.clone(),
        HUNDRED,
        rec_direct.clone(),
        orig_direct.clone(),
    )
        .to_xdr(&large.env)
        .len() as u64;
    let (direct_claim_id, mut s_in_direct) =
        large.measure("bridge_in_direct_large_payload", in_direct_input, || {
            rail.deliver_custom(
                &large.router_id,
                &RouteKind::AxelarGmp,
                &large.token_id,
                &HUNDRED,
                &rec_direct,
                &orig_direct,
            )
        });
    assert_eq!(direct_claim_id, 0);
    s_in_direct.stored_record_bytes = 32;
    samples.push(s_in_direct);

    // 2e. `bridge_in_park_large_claim_record` (parks PendingClaim with 64-byte source_chain)
    failable.set_blocked(&large.recipient, &true);
    let orig_parked = Origin {
        chain: long_chain,
        nonce: u64::MAX,
        message_id: BytesN::from_array(&large.env, &[0x32u8; 32]),
        sender: BytesN::from_array(&large.env, &[0x42u8; 32]),
    };
    let in_park_input = (
        large.rail_id.clone(),
        RouteKind::AxelarGmp,
        large.token_id.clone(),
        HUNDRED,
        rec_direct.clone(),
        orig_parked.clone(),
    )
        .to_xdr(&large.env)
        .len() as u64;
    let (parked_claim_id, mut s_in_park) =
        large.measure("bridge_in_park_large_claim_record", in_park_input, || {
            rail.deliver_custom(
                &large.router_id,
                &RouteKind::AxelarGmp,
                &large.token_id,
                &HUNDRED,
                &rec_direct,
                &orig_parked,
            )
        });
    assert!(parked_claim_id > 0);
    s_in_park.stored_record_bytes =
        router.get_claim(&parked_claim_id).to_xdr(&large.env).len() as u64;
    samples.push(s_in_park);

    // 2f. `settle_claim_large_stored_record` (settles the large 64-byte-chain PendingClaim)
    failable.set_blocked(&large.recipient, &false);
    let settle_input = (large.settler.clone(), parked_claim_id)
        .to_xdr(&large.env)
        .len() as u64;
    let ((), mut s_settle) =
        large.measure("settle_claim_large_stored_record", settle_input, || {
            router.settle_claim(&large.settler, &parked_claim_id)
        });
    s_settle.stored_record_bytes =
        router.get_claim(&parked_claim_id).to_xdr(&large.env).len() as u64;
    samples.push(s_settle);

    // 2g. `keep_alive_large_batch` (4 tokens x 4 routes + 16 claims + 16 transfers)
    let mut tokens_vec: Vec<Address> = vec![&large.env, large.token_id.clone()];
    for extra in &large.extra_tokens {
        tokens_vec.push_back(extra.clone());
    }
    let mut routes_vec: Vec<RouteKind> = vec![&large.env];
    for r in all_routes() {
        routes_vec.push_back(r);
    }
    let mut claims_vec: Vec<u64> = vec![&large.env];
    for id in 1..=16u64 {
        claims_vec.push_back(id);
    }
    let mut transfers_vec: Vec<u64> = vec![&large.env];
    for n in 1..=16u64 {
        transfers_vec.push_back(n);
    }
    let keep_alive_input = (
        tokens_vec.clone(),
        routes_vec.clone(),
        claims_vec.clone(),
        transfers_vec.clone(),
    )
        .to_xdr(&large.env)
        .len() as u64;
    let ((), mut s_keep_alive) = large.measure("keep_alive_large_batch", keep_alive_input, || {
        router.keep_alive(&tokens_vec, &routes_vec, &claims_vec, &transfers_vec)
    });
    s_keep_alive.stored_record_bytes = 68;
    samples.push(s_keep_alive);

    samples
}

#[test]
fn reproducible_soroban_resource_benchmarks_match_pinned_baselines_within_tolerance() {
    let first = collect_canonical_router_benchmarks();
    let second = collect_canonical_router_benchmarks();
    assert_eq!(
        first, second,
        "Soroban CPU and memory measurements must be 100% deterministic across repeated runs"
    );
    assert_eq!(first.len(), PINNED_ROUTER_BASELINES.len());

    let expected_assumptions = ResourceAssumptions::pinned();
    for (sample, baseline) in first.iter().zip(PINNED_ROUTER_BASELINES.iter()) {
        assert_eq!(sample.operation, baseline.operation);
        let delta = evaluate_benchmark_delta(sample, baseline, &expected_assumptions);
        assert!(
            !delta.regressed && !delta.assumption_mismatch,
            "Unexpected Soroban benchmark regression: {}",
            delta.summary
        );
        assert!(delta.cpu_tx_headroom_insns > 90_000_000);
        assert!(delta.mem_tx_headroom_bytes > 38_000_000);
    }

    // Confirm large-but-valid stored records measurably exceed compact baselines.
    let quote_compact = &first[0];
    let out_compact = &first[1];
    let quote_large = &first[2];
    let out_large = &first[3];
    let in_direct = &first[5];
    let in_park = &first[6];

    assert!(quote_large.cpu_insns > quote_compact.cpu_insns);
    assert!(quote_large.mem_bytes > quote_compact.mem_bytes);
    assert!(out_large.stored_record_bytes > out_compact.stored_record_bytes);
    assert!(out_large.cpu_insns > out_compact.cpu_insns);
    assert!(in_park.stored_record_bytes > in_direct.stored_record_bytes);
    assert!(in_park.cpu_insns > in_direct.cpu_insns);
}

#[test]
fn budget_regression_evaluator_produces_actionable_cpu_and_memory_deltas_on_overrun() {
    let baseline = PINNED_ROUTER_BASELINES[3]; // bridge_out_large_stored_record
    let assumptions = ResourceAssumptions::pinned();

    let degraded_sample = BenchmarkSample {
        operation: baseline.operation,
        input_bytes: baseline.expected_input_bytes,
        stored_record_bytes: baseline.expected_stored_record_bytes,
        seeded_claims: 16,
        seeded_transfers: 16,
        cpu_insns: baseline.baseline_cpu_insns + 150_000,
        mem_bytes: baseline.baseline_mem_bytes + 80_000,
        assumptions: assumptions.clone(),
    };

    let delta = evaluate_benchmark_delta(&degraded_sample, &baseline, &assumptions);
    assert!(delta.regressed);
    assert!(!delta.assumption_mismatch);
    assert_eq!(delta.operation, "bridge_out_large_stored_record");
    assert_eq!(delta.cpu_delta_insns, 150_000);
    assert!(delta.cpu_delta_bps > 1_200);
    assert!(delta.cpu_ceiling_overrun_insns > 0);
    assert_eq!(delta.mem_delta_bytes, 80_000);
    assert!(delta.mem_delta_bps > 1_500);
    assert!(delta.mem_ceiling_overrun_bytes > 0);
    assert!(delta.summary.contains("[REGRESSION]"));
    assert!(delta.summary.contains("cpuDelta=+150000 insns"));
    assert!(delta.summary.contains("memDelta=+80000 B"));
    assert!(delta.summary.contains("txHeadroom="));
}

#[test]
fn assumption_and_input_size_drift_flags_actionable_mismatch() {
    let baseline = PINNED_ROUTER_BASELINES[6]; // bridge_in_park_large_claim_record
    let expected_assumptions = ResourceAssumptions::pinned();

    let mut drifted_assumptions = expected_assumptions.clone();
    drifted_assumptions.ledger_protocol_version = 29;

    let drifted_sample = BenchmarkSample {
        operation: baseline.operation,
        input_bytes: baseline.expected_input_bytes + 16,
        stored_record_bytes: baseline.expected_stored_record_bytes + 8,
        seeded_claims: 16,
        seeded_transfers: 16,
        cpu_insns: baseline.baseline_cpu_insns,
        mem_bytes: baseline.baseline_mem_bytes,
        assumptions: drifted_assumptions,
    };

    let delta = evaluate_benchmark_delta(&drifted_sample, &baseline, &expected_assumptions);
    assert!(delta.regressed);
    assert!(delta.assumption_mismatch);
    assert_eq!(delta.input_size_delta_bytes, 16);
    assert_eq!(delta.stored_record_delta_bytes, 8);
    assert!(delta.summary.contains("input=616B (delta=+16B)"));
    assert!(delta.summary.contains("record=400B (delta=+8B)"));
}
