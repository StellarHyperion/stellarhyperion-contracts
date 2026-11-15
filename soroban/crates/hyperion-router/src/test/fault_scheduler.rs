//! Deterministic seed-driven provider fault scheduling and atomic rehearsal tests.

extern crate std;

use std::vec::Vec as StdVec;

use hyperion_core::{AddressKind, HyperionError, RouteKind, STELLAR_DECIMALS};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractimpl, contracttype,
    testutils::Address as _,
    token, vec, Address, Bytes, BytesN, Env, IntoVal, String, Symbol,
};

use super::doubles::{evm_destination, message_id};
use super::setup::{World, EVM_DECIMALS, FLOW_LIMIT, HUNDRED};
use crate::types::{AdminAction, Destination, Origin, OutboundRequest, Recipient};
use crate::HyperionRouterClient;

// ---------------------------------------------------------------------------
// SplitMix64 PRNG matching `@hyperion/protocol` `faultScheduling.ts` bit-for-bit
// ---------------------------------------------------------------------------

const GOLDEN_GAMMA: u64 = 0x9E37_79B9_7F4A_7C15;
const MIX_1: u64 = 0xBF58_476D_1CE4_E5B9;
const MIX_2: u64 = 0x94D0_49BB_1331_11EB;

#[derive(Clone, Debug, Eq, PartialEq)]
struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(GOLDEN_GAMMA);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(MIX_1);
        z = (z ^ (z >> 27)).wrapping_mul(MIX_2);
        z ^ (z >> 31)
    }
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FaultStage {
    None = 0,
    OutboundDispatch = 1,
    OutboundPaidAssetPull = 2,
    OutboundPaidRelayGas = 3,
    InboundProviderVerify = 4,
    InboundPull = 5,
    InboundRecipientBlocked = 6,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
struct ScheduledFaultStep {
    step: u32,
    stage: FaultStage,
    inject_fault: bool,
    roll_bps: u32,
}

fn build_fault_schedule(
    seed: u64,
    steps: u32,
    failure_rate_bps: u32,
    stages: &[FaultStage],
) -> StdVec<ScheduledFaultStep> {
    assert!(!stages.is_empty());
    assert!(failure_rate_bps <= 10_000);
    let mut rng = SplitMix64::new(seed);
    let mut out = StdVec::with_capacity(steps as usize);
    for step in 0..steps {
        let roll_word = rng.next_u64();
        let stage_word = rng.next_u64();
        let roll_bps = (roll_word % 10_000) as u32;
        let stage_idx = (stage_word % (stages.len() as u64)) as usize;
        out.push(ScheduledFaultStep {
            step,
            stage: stages[stage_idx],
            inject_fault: roll_bps < failure_rate_bps,
            roll_bps,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Fault-injecting provider rail fixture for Soroban local rehearsals
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum FaultRailKey {
    Router,
    GasToken,
    ActiveFault,
    DispatchCount,
    PaidDispatchCount,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FaultRailError {
    NotRouter = 1,
    InjectedOutboundDispatchFault = 2,
    InjectedPaidAssetPullFault = 3,
    InjectedPaidRelayGasFault = 4,
    InjectedInboundProviderFault = 5,
}

#[contract]
pub struct FaultyProviderRail;

#[contractimpl]
impl FaultyProviderRail {
    pub fn init(env: Env, router: Address, gas_token: Address) {
        env.storage().instance().set(&FaultRailKey::Router, &router);
        env.storage()
            .instance()
            .set(&FaultRailKey::GasToken, &gas_token);
        env.storage()
            .instance()
            .set(&FaultRailKey::ActiveFault, &FaultStage::None);
    }

    pub fn set_fault(env: Env, stage: FaultStage) {
        env.storage()
            .instance()
            .set(&FaultRailKey::ActiveFault, &stage);
    }

    pub fn active_fault(env: Env) -> FaultStage {
        env.storage()
            .instance()
            .get(&FaultRailKey::ActiveFault)
            .unwrap_or(FaultStage::None)
    }

    pub fn gas_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&FaultRailKey::GasToken)
            .unwrap()
    }

    pub fn dispatch(
        env: Env,
        caller: Address,
        _token: Address,
        _amount: i128,
        _destination_chain: String,
        _destination: BytesN<32>,
        _nonce: u64,
    ) -> Result<(), FaultRailError> {
        caller.require_auth();
        let router: Address = env.storage().instance().get(&FaultRailKey::Router).unwrap();
        if caller != router {
            return Err(FaultRailError::NotRouter);
        }
        if Self::active_fault(env.clone()) == FaultStage::OutboundDispatch {
            return Err(FaultRailError::InjectedOutboundDispatchFault);
        }
        let count: u32 = env
            .storage()
            .instance()
            .get(&FaultRailKey::DispatchCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&FaultRailKey::DispatchCount, &(count + 1));
        Ok(())
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
        gas_amount: i128,
    ) -> Result<(), FaultRailError> {
        caller.require_auth();
        let router: Address = env.storage().instance().get(&FaultRailKey::Router).unwrap();
        if caller != router {
            return Err(FaultRailError::NotRouter);
        }
        let this = env.current_contract_address();
        let fault = Self::active_fault(env.clone());

        // Pull bridged asset first so `OutboundPaidAssetPull` proves partial sub-contract pulls
        // roll back together with the router's treasury fee and nonce mutation.
        token::Client::new(&env, &token).transfer(&sender, &this, &amount);
        if fault == FaultStage::OutboundPaidAssetPull {
            return Err(FaultRailError::InjectedPaidAssetPullFault);
        }

        // Pull separate relay gas second so `OutboundPaidRelayGas` proves both currencies revert
        // atomically when upstream provider submission fails.
        let gas_tok: Address = env
            .storage()
            .instance()
            .get(&FaultRailKey::GasToken)
            .unwrap();
        token::Client::new(&env, &gas_tok).transfer(&sender, &this, &gas_amount);
        if fault == FaultStage::OutboundPaidRelayGas {
            return Err(FaultRailError::InjectedPaidRelayGasFault);
        }

        let count: u32 = env
            .storage()
            .instance()
            .get(&FaultRailKey::PaidDispatchCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&FaultRailKey::PaidDispatchCount, &(count + 1));
        Ok(())
    }

    pub fn deliver_inbound(
        env: Env,
        route: RouteKind,
        token: Address,
        amount: i128,
        recipient: Address,
        source_chain: String,
        source_nonce: u64,
    ) -> Result<u64, FaultRailError> {
        let fault = Self::active_fault(env.clone());
        if fault == FaultStage::InboundProviderVerify {
            return Err(FaultRailError::InjectedInboundProviderFault);
        }

        let router: Address = env.storage().instance().get(&FaultRailKey::Router).unwrap();
        let this = env.current_contract_address();

        // When `InboundPull` fault is active, omit sub-invocation transfer authorization so the
        // router's `client.transfer(&caller, &this, &amount)` traps *after* `mark_processed`,
        // proving `was_processed` rolls back cleanly!
        if fault != FaultStage::InboundPull {
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
        }

        let id = HyperionRouterClient::new(&env, &router).bridge_in(
            &this,
            &route,
            &token,
            &amount,
            &Recipient {
                address: recipient,
                kind: AddressKind::Account,
                raw: Bytes::new(&env),
            },
            &Origin {
                chain: source_chain,
                nonce: source_nonce,
                message_id: message_id(&env, source_nonce),
                sender: BytesN::from_array(&env, &[0x55u8; 32]),
            },
        );
        Ok(id)
    }

    pub fn dispatch_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&FaultRailKey::DispatchCount)
            .unwrap_or(0)
    }

    pub fn paid_dispatch_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&FaultRailKey::PaidDispatchCount)
            .unwrap_or(0)
    }
}

struct RehearsalHarness {
    w: World,
    fault_rail_id: Address,
    gas_token_id: Address,
}

impl RehearsalHarness {
    fn new() -> Self {
        let w = World::bare();
        let gas_issuer = Address::generate(&w.env);
        let gas_sac = w.env.register_stellar_asset_contract_v2(gas_issuer);
        let gas_token_id = gas_sac.address();

        let fault_rail_id = w.env.register(FaultyProviderRail, ());
        FaultyProviderRailClient::new(&w.env, &fault_rail_id).init(&w.router_id, &gas_token_id);

        for route in [RouteKind::Cctp, RouteKind::AxelarIts] {
            w.run_action(AdminAction::SetAdapter(route, fault_rail_id.clone()));
            w.run_action(AdminAction::SetRailReceiver(route, fault_rail_id.clone()));
            w.run_action(AdminAction::EnableRoute(route));
        }

        w.register_token(w.token_id.clone(), STELLAR_DECIMALS, FLOW_LIMIT);
        w.fund_user(HUNDRED * 10 + 7);
        token::StellarAssetClient::new(&w.env, &gas_token_id).mint(&w.user, &(HUNDRED * 5));
        w.sac().mint(&fault_rail_id, &(HUNDRED * 5));

        Self {
            w,
            fault_rail_id,
            gas_token_id,
        }
    }

    fn rail(&self) -> FaultyProviderRailClient<'_> {
        FaultyProviderRailClient::new(&self.w.env, &self.fault_rail_id)
    }

    fn gas_token(&self) -> token::Client<'_> {
        token::Client::new(&self.w.env, &self.gas_token_id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RouterStateSnapshot {
    sender_asset: i128,
    sender_gas: i128,
    treasury_asset: i128,
    router_asset: i128,
    rail_asset: i128,
    rail_gas: i128,
    recipient_asset: i128,
    last_out_nonce: u64,
    claim_count: u64,
    flow_cctp: i128,
    flow_its: i128,
}

impl RehearsalHarness {
    fn snapshot(&self) -> RouterStateSnapshot {
        RouterStateSnapshot {
            sender_asset: self.w.token().balance(&self.w.user),
            sender_gas: self.gas_token().balance(&self.w.user),
            treasury_asset: self.w.token().balance(&self.w.treasury),
            router_asset: self.w.token().balance(&self.w.router_id),
            rail_asset: self.w.token().balance(&self.fault_rail_id),
            rail_gas: self.gas_token().balance(&self.fault_rail_id),
            recipient_asset: self.w.token().balance(&self.w.recipient),
            last_out_nonce: self.w.router().last_out_nonce(),
            claim_count: self.w.router().claim_count(),
            flow_cctp: self
                .w
                .router()
                .flow_available(&self.w.token_id, &RouteKind::Cctp),
            flow_its: self
                .w
                .router()
                .flow_available(&self.w.token_id, &RouteKind::AxelarIts),
        }
    }
}

#[test]
fn failure_scheduling_is_reproducible_from_a_saved_seed_and_matches_protocol_sdk() {
    let mut rng_zero = SplitMix64::new(0);
    assert_eq!(rng_zero.next_u64(), 0xe220_a839_7b1d_cdaf);
    assert_eq!(rng_zero.next_u64(), 0x6e78_9e6a_a1b9_65f4);

    let all_stages = [
        FaultStage::OutboundDispatch,
        FaultStage::OutboundPaidAssetPull,
        FaultStage::OutboundPaidRelayGas,
        FaultStage::InboundProviderVerify,
        FaultStage::InboundPull,
        FaultStage::InboundRecipientBlocked,
    ];
    let saved_seed: u64 = 0x0000_0000_00c0_ffee;
    let plan_a = build_fault_schedule(saved_seed, 16, 5_000, &all_stages);
    let plan_b = build_fault_schedule(saved_seed, 16, 5_000, &all_stages);
    assert_eq!(plan_a, plan_b);

    let plan_other = build_fault_schedule(saved_seed + 1, 16, 5_000, &all_stages);
    assert_ne!(plan_a, plan_other);
}

#[test]
fn atomic_state_invariants_hold_at_every_injected_dispatch_and_inbound_stage() {
    let h = RehearsalHarness::new();
    let baseline = h.snapshot();

    // 1. Outbound unpaid dispatch failure rolls back sender, treasury, router, rail, nonce, flow.
    h.rail().set_fault(&FaultStage::OutboundDispatch);
    let unpaid_req = OutboundRequest {
        token: h.w.token_id.clone(),
        amount: HUNDRED + 7,
        route: RouteKind::Cctp,
        destination: Destination {
            chain: h.w.ethereum(),
            address: evm_destination(&h.w.env, 0x11),
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    };
    assert!(h.w.router().try_bridge_out(&h.w.user, &unpaid_req).is_err());
    assert_eq!(h.snapshot(), baseline);
    assert_eq!(
        h.w.router().try_get_transfer(&1),
        Err(Ok(HyperionError::UnknownNonce))
    );

    // 2. Outbound paid asset-pull and relay-gas faults roll back both currencies and treasury fee.
    for stage in [
        FaultStage::OutboundPaidAssetPull,
        FaultStage::OutboundPaidRelayGas,
    ] {
        h.rail().set_fault(&stage);
        let paid_req = OutboundRequest {
            token: h.w.token_id.clone(),
            amount: HUNDRED + 7,
            route: RouteKind::AxelarIts,
            destination: Destination {
                chain: h.w.ethereum(),
                address: evm_destination(&h.w.env, 0x22),
            },
            destination_decimals: EVM_DECIMALS,
            min_destination_amount: 0,
        };
        assert!(h
            .w
            .router()
            .try_bridge_out_with_gas(&h.w.user, &paid_req, &10_000_000)
            .is_err());
        assert_eq!(
            h.snapshot(),
            baseline,
            "state drifted on injected fault stage {stage:?}"
        );
    }

    // 3. Inbound provider verification fault and inbound pull fault both leave `was_processed == false`.
    let inbound_nonce = 77u64;
    let msg_id = message_id(&h.w.env, inbound_nonce);
    for stage in [FaultStage::InboundProviderVerify, FaultStage::InboundPull] {
        h.rail().set_fault(&stage);
        assert!(h
            .rail()
            .try_deliver_inbound(
                &RouteKind::Cctp,
                &h.w.token_id,
                &HUNDRED,
                &h.w.recipient,
                &h.w.ethereum(),
                &inbound_nonce,
            )
            .is_err());
        assert_eq!(
            h.snapshot(),
            baseline,
            "state drifted on inbound fault {stage:?}"
        );
        assert!(
            !h.w.router().was_processed(&RouteKind::Cctp, &msg_id),
            "reverted inbound stage {stage:?} must never leave message marked processed"
        );
    }

    // 4. Controlled recipient-blocked stage on `FailableToken` parks an exact recipient-bound claim.
    let failable_id = h.w.with_failable_token();
    let failable = h.w.failable(&failable_id);
    failable.mint(&h.fault_rail_id, &HUNDRED);
    failable.set_blocked(&h.w.recipient, &true);
    h.rail().set_fault(&FaultStage::None);

    let claim_id = h.rail().deliver_inbound(
        &RouteKind::Cctp,
        &failable_id,
        &HUNDRED,
        &h.w.recipient,
        &h.w.ethereum(),
        &88u64,
    );
    assert_eq!(claim_id, 1);
    assert_eq!(failable.balance(&h.w.router_id), HUNDRED);
    assert_eq!(failable.balance(&h.w.recipient), 0);
    assert_eq!(
        h.w.router().try_settle_claim(&h.w.user, &claim_id),
        Err(Ok(HyperionError::RecipientNotReady))
    );
    assert_eq!(failable.balance(&h.w.router_id), HUNDRED);

    failable.set_blocked(&h.w.recipient, &false);
    h.w.router().settle_claim(&h.w.user, &claim_id);
    assert_eq!(failable.balance(&h.w.router_id), 0);
    assert_eq!(failable.balance(&h.w.recipient), HUNDRED);
}

#[test]
fn success_after_seeded_recovery_never_repeats_a_source_asset_or_gas_debit() {
    let outbound_stages = [
        FaultStage::OutboundDispatch,
        FaultStage::OutboundPaidAssetPull,
        FaultStage::OutboundPaidRelayGas,
    ];
    let schedule = build_fault_schedule(0x5eed_1234_abcd_0001, 6, 10_000, &outbound_stages);

    let h = RehearsalHarness::new();
    let before = h.snapshot();
    let gas_budget = 25_000_000i128;

    let paid_its_req = OutboundRequest {
        token: h.w.token_id.clone(),
        amount: HUNDRED + 7, // +7 stroops unrepresentable on 6-decimal EVM destination
        route: RouteKind::AxelarIts,
        destination: Destination {
            chain: h.w.ethereum(),
            address: evm_destination(&h.w.env, 0x33),
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    };

    // Execute every scheduled paid fault against the live router + adapter seam first.
    let mut injected_failures = 0u32;
    for step in &schedule {
        if step.stage == FaultStage::OutboundPaidAssetPull
            || step.stage == FaultStage::OutboundPaidRelayGas
        {
            h.rail().set_fault(&step.stage);
            assert!(h
                .w
                .router()
                .try_bridge_out_with_gas(&h.w.user, &paid_its_req, &gas_budget)
                .is_err());
            injected_failures += 1;
            assert_eq!(h.snapshot(), before);
        }
    }
    assert!(injected_failures >= 2);

    // Recover provider health and retry once: must debit `gross = HUNDRED` and `gas_budget` once!
    h.rail().set_fault(&FaultStage::None);
    let nonce =
        h.w.router()
            .bridge_out_with_gas(&h.w.user, &paid_its_req, &gas_budget);
    assert_eq!(nonce, 1);

    let fee = HUNDRED / 1_000;
    let net = HUNDRED - fee;
    let after = h.snapshot();

    assert_eq!(before.sender_asset - after.sender_asset, HUNDRED);
    assert_eq!(after.sender_asset % 10, 7); // 7 stroops of dust stayed with sender
    assert_eq!(before.sender_gas - after.sender_gas, gas_budget);
    assert_eq!(after.treasury_asset - before.treasury_asset, fee);
    assert_eq!(after.rail_asset - before.rail_asset, net);
    assert_eq!(after.rail_gas - before.rail_gas, gas_budget);
    assert_eq!(after.router_asset, 0);
    assert_eq!(after.last_out_nonce, 1);
    assert_eq!(before.flow_its - after.flow_its, net);
    assert_eq!(h.rail().paid_dispatch_count(), 1);
}
