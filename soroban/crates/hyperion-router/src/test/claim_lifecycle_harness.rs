//! Stateful crash, interruption, upgrade, archival-restoration, and settlement harness for parked claims.

extern crate std;

use std::format;
use std::string::{String as StdString, ToString};
use std::vec::Vec as StdVec;

use hyperion_core::{
    AddressKind, HyperionError, RouteKind, DEFAULT_FLOW_WINDOW_LEDGERS, STELLAR_DECIMALS,
};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, EnvTestConfig, Ledger as _,
    },
    xdr::{ContractDataDurability, ContractExecutable as XdrExecutable, LedgerEntryData, ScVal},
    Address, BytesN, ContractExecutable, Env, String, Vec,
};

use super::doubles::{
    all_routes, message_id, Delivery, FailableToken, FailableTokenClient, MockRail, MockRailClient,
};
use super::setup::{FEE_BPS, FLOW_LIMIT, HUNDRED};
use crate::storage::{BUMP_THRESHOLD, BUMP_TO};
use crate::timelock::MIN_TIMELOCK_DELAY;
use crate::types::{AdminAction, Config, PendingClaim};
use crate::{DataKey, HyperionRouter, HyperionRouterClient};

const V1_WASM_HASH: [u8; 32] = [0x51; 32];
const V2_WASM_HASH: [u8; 32] = [0x52; 32];
const V3_WASM_HASH: [u8; 32] = [0x53; 32];
const TOKEN_WASM_HASH: [u8; 32] = [0x54; 32];
const RAIL_WASM_HASH: [u8; 32] = [0x58; 32];
const ROGUE_UPGRADE_HASH: [u8; 32] = [0x99; 32];

/// Upgraded router image preserving the exact persistent and instance storage layout while
/// exposing an explicit runtime marker so tests verify code replacement occurred on-ledger.
#[contract]
pub struct UpgradedHyperionRouterV2;

#[contractimpl]
impl UpgradedHyperionRouterV2 {
    pub fn runtime_version(_env: Env) -> u32 {
        2
    }

    pub fn settle_claim(env: Env, settler: Address, id: u64) -> Result<(), HyperionError> {
        HyperionRouter::settle_claim(env, settler, id)
    }

    pub fn keep_alive(
        env: Env,
        tokens: Vec<Address>,
        routes: Vec<RouteKind>,
        claims: Vec<u64>,
        transfers: Vec<u64>,
    ) {
        HyperionRouter::keep_alive(env, tokens, routes, claims, transfers);
    }

    pub fn pause(env: Env, caller: Address) -> Result<(), HyperionError> {
        HyperionRouter::pause(env, caller)
    }

    pub fn unpause(env: Env, caller: Address) -> Result<(), HyperionError> {
        HyperionRouter::unpause(env, caller)
    }

    pub fn queue_action(
        env: Env,
        caller: Address,
        action: AdminAction,
    ) -> Result<u64, HyperionError> {
        HyperionRouter::queue_action(env, caller, action)
    }

    pub fn execute_action(env: Env, caller: Address, id: u64) -> Result<(), HyperionError> {
        HyperionRouter::execute_action(env, caller, id)
    }

    pub fn cancel_action(env: Env, caller: Address, id: u64) -> Result<(), HyperionError> {
        HyperionRouter::cancel_action(env, caller, id)
    }

    pub fn get_config(env: Env) -> Result<Config, HyperionError> {
        HyperionRouter::get_config(env)
    }

    pub fn get_claim(env: Env, id: u64) -> Result<PendingClaim, HyperionError> {
        HyperionRouter::get_claim(env, id)
    }

    pub fn get_token(env: Env, token: Address) -> Result<crate::types::TokenConfig, HyperionError> {
        HyperionRouter::get_token(env, token)
    }

    pub fn is_route_enabled(env: Env, route: RouteKind) -> bool {
        HyperionRouter::is_route_enabled(env, route)
    }

    pub fn was_processed(env: Env, route: RouteKind, message_id: BytesN<32>) -> bool {
        HyperionRouter::was_processed(env, route, message_id)
    }

    pub fn claim_count(env: Env) -> u64 {
        HyperionRouter::claim_count(env)
    }

    pub fn queue_count(env: Env) -> u64 {
        HyperionRouter::queue_count(env)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ClaimPublicView {
    id: u64,
    present: bool,
    recipient: StdString,
    amount: i128,
    route: RouteKind,
    source_chain: StdString,
    source_nonce: u64,
    created_at: u64,
    settled: bool,
    replay_processed: bool,
    ttl_ledgers: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PublicLifecycleSnapshot {
    ledger_sequence: u32,
    ledger_timestamp: u64,
    executable_hash: [u8; 32],
    paused: bool,
    cctp_enabled: bool,
    axelar_gmp_enabled: bool,
    token_enabled: bool,
    token_flow_limit: i128,
    treasury: StdString,
    claim_count: u64,
    queue_count: u64,
    instance_ttl: u32,
    rail_balance: i128,
    router_balance: i128,
    treasury_balance: i128,
    settler_balance: i128,
    recipient_one_balance: i128,
    recipient_two_balance: i128,
    outstanding_liability: i128,
    claims: StdVec<ClaimPublicView>,
}

impl PublicLifecycleSnapshot {
    fn total_supply(&self) -> i128 {
        self.rail_balance
            + self.router_balance
            + self.treasury_balance
            + self.settler_balance
            + self.recipient_one_balance
            + self.recipient_two_balance
    }

    fn format_compact(&self) -> StdString {
        let claims_str = self
            .claims
            .iter()
            .map(|c| {
                format!(
                    "#{}(present={},amt={},settled={},replay={},ttl={})",
                    c.id, c.present, c.amount, c.settled, c.replay_processed, c.ttl_ledgers
                )
            })
            .collect::<StdVec<_>>()
            .join(",");
        format!(
            "seq={} ts={} exec={:02x}{:02x} paused={} cctp={} token={} claim_count={} queue_count={} rail={} router={} r1={} r2={} liability={} claims=[{}]",
            self.ledger_sequence,
            self.ledger_timestamp,
            self.executable_hash[0],
            self.executable_hash[1],
            self.paused,
            self.cctp_enabled,
            self.token_enabled,
            self.claim_count,
            self.queue_count,
            self.rail_balance,
            self.router_balance,
            self.recipient_one_balance,
            self.recipient_two_balance,
            self.outstanding_liability,
            claims_str
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TransitionRecord {
    step: usize,
    phase: &'static str,
    operation: StdString,
    outcome: StdString,
    before: PublicLifecycleSnapshot,
    after: PublicLifecycleSnapshot,
}

struct LifecycleRig {
    env: Env,
    router_id: Address,
    rail_id: Address,
    token_id: Address,
    admin: Address,
    guardian: Address,
    treasury: Address,
    recipient_one: Address,
    recipient_two: Address,
    settler: Address,
    transitions: StdVec<TransitionRecord>,
}

impl LifecycleRig {
    fn new() -> Self {
        let mut env = Env::default();
        env.set_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.sequence_number = 100_000;
            li.timestamp = 1_700_000_000;
            li.min_persistent_entry_ttl = 4_096;
            li.min_temp_entry_ttl = 16;
            li.max_entry_ttl = 6_312_000;
        });

        Self::register_executables(&env);

        let deployer_owner = Address::generate(&env);
        let v1_hash = BytesN::from_array(&env, &V1_WASM_HASH);
        let token_hash = BytesN::from_array(&env, &TOKEN_WASM_HASH);
        let rail_hash = BytesN::from_array(&env, &RAIL_WASM_HASH);

        let router_id = env
            .deployer()
            .with_address(deployer_owner.clone(), [1u8; 32])
            .deploy_contract(ContractExecutable::Wasm(v1_hash), ());
        let token_id = env
            .deployer()
            .with_address(deployer_owner.clone(), [2u8; 32])
            .deploy_contract(ContractExecutable::Wasm(token_hash), ());
        let rail_id = env
            .deployer()
            .with_address(deployer_owner, [3u8; 32])
            .deploy_contract(ContractExecutable::Wasm(rail_hash), ());

        FailableTokenClient::new(&env, &token_id).init(&STELLAR_DECIMALS);
        MockRailClient::new(&env, &rail_id).init(&router_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let treasury = Address::generate(&env);
        let recipient_one = Address::generate(&env);
        let recipient_two = Address::generate(&env);
        let settler = Address::generate(&env);

        let rig = Self {
            env,
            router_id,
            rail_id,
            token_id,
            admin,
            guardian,
            treasury,
            recipient_one,
            recipient_two,
            settler,
            transitions: StdVec::new(),
        };

        rig.router().initialize(
            &rig.admin,
            &rig.guardian,
            &rig.treasury,
            &FEE_BPS,
            &DEFAULT_FLOW_WINDOW_LEDGERS,
            &MIN_TIMELOCK_DELAY,
        );

        for route in all_routes() {
            rig.run_timelocked(AdminAction::SetAdapter(route, rig.rail_id.clone()));
            rig.run_timelocked(AdminAction::SetRailReceiver(route, rig.rail_id.clone()));
            rig.run_timelocked(AdminAction::EnableRoute(route));
        }
        rig.run_timelocked(AdminAction::RegisterToken(
            rig.token_id.clone(),
            STELLAR_DECIMALS,
            FLOW_LIMIT,
        ));

        rig.pin_infrastructure_ttl();
        rig
    }

    fn register_executables(env: &Env) {
        env.upload_at(V1_WASM_HASH, HyperionRouter);
        env.upload_at(V2_WASM_HASH, UpgradedHyperionRouterV2);
        env.upload_at(V3_WASM_HASH, HyperionRouter);
        env.upload_at(TOKEN_WASM_HASH, FailableToken);
        env.upload_at(RAIL_WASM_HASH, MockRail);
    }

    /// Keep test-double contracts and router code/instance live across multi-month ledger jumps so
    /// persistent claim entries are isolated as the exact archival surface under test.
    fn pin_infrastructure_ttl(&self) {
        let horizon = 5_000_000;
        self.env
            .deployer()
            .extend_ttl(self.router_id.clone(), horizon, horizon);
        self.env
            .deployer()
            .extend_ttl(self.token_id.clone(), horizon, horizon);
        self.env
            .deployer()
            .extend_ttl(self.rail_id.clone(), horizon, horizon);
        self.env.as_contract(&self.router_id, || {
            self.env.storage().persistent().extend_ttl(
                &DataKey::Token(self.token_id.clone()),
                horizon,
                horizon,
            );
        });
    }

    fn router(&self) -> HyperionRouterClient<'_> {
        HyperionRouterClient::new(&self.env, &self.router_id)
    }

    fn router_v2(&self) -> UpgradedHyperionRouterV2Client<'_> {
        UpgradedHyperionRouterV2Client::new(&self.env, &self.router_id)
    }

    fn token(&self) -> FailableTokenClient<'_> {
        FailableTokenClient::new(&self.env, &self.token_id)
    }

    fn rail(&self) -> MockRailClient<'_> {
        MockRailClient::new(&self.env, &self.rail_id)
    }

    fn advance_time(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| {
            li.timestamp += seconds;
        });
    }

    fn advance_ledgers(&self, ledgers: u32, seconds: u64) {
        self.env.ledger().with_mut(|li| {
            li.sequence_number += ledgers;
            li.timestamp += seconds;
        });
        self.pin_infrastructure_ttl();
    }

    fn run_timelocked(&self, action: AdminAction) {
        let id = self.router().queue_action(&self.admin, &action);
        self.advance_time(MIN_TIMELOCK_DELAY + 1);
        self.router().execute_action(&self.admin, &id);
    }

    fn current_executable_hash(&self) -> [u8; 32] {
        let snap = self.env.to_ledger_snapshot();
        let router_sc: soroban_sdk::xdr::ScAddress = self.router_id.clone().into();
        for (_key, (entry, _live_until)) in &snap.ledger_entries {
            if let LedgerEntryData::ContractData(cd) = &entry.data {
                if cd.contract == router_sc && cd.key == ScVal::LedgerKeyContractInstance {
                    if let ScVal::ContractInstance(instance) = &cd.val {
                        if let XdrExecutable::Wasm(hash) = &instance.executable {
                            return hash.0;
                        }
                    }
                }
            }
        }
        panic!("router contract instance executable hash not found in ledger snapshot");
    }

    fn snapshot_public_state(
        &self,
        expected_meta: &[(u64, RouteKind, u64, i128)],
    ) -> PublicLifecycleSnapshot {
        let cfg = self.router().get_config();
        let tok_cfg = self.router().get_token(&self.token_id);
        let claim_count = self.router().claim_count();
        let queue_count = self.router().queue_count();
        let instance_ttl = self
            .env
            .as_contract(&self.router_id, || self.env.storage().instance().get_ttl());

        let mut claims = StdVec::new();
        let mut outstanding_liability = 0i128;

        for &(id, route, source_nonce, expected_amt) in expected_meta {
            if id > claim_count {
                continue;
            }
            let replay_processed = self
                .router()
                .was_processed(&route, &message_id(&self.env, source_nonce));
            match self.router().try_get_claim(&id) {
                Ok(Ok(claim)) => {
                    let ttl_ledgers = self.env.as_contract(&self.router_id, || {
                        self.env.storage().persistent().get_ttl(&DataKey::Claim(id))
                    });
                    if !claim.settled {
                        outstanding_liability += claim.amount;
                    }
                    claims.push(ClaimPublicView {
                        id,
                        present: true,
                        recipient: claim.recipient.to_string().to_string(),
                        amount: claim.amount,
                        route: claim.route,
                        source_chain: claim.source_chain.to_string(),
                        source_nonce: claim.source_nonce,
                        created_at: claim.created_at,
                        settled: claim.settled,
                        replay_processed,
                        ttl_ledgers,
                    });
                }
                _ => {
                    // Entry is archived in active host storage; liability remains backed by router custody.
                    outstanding_liability += expected_amt;
                    claims.push(ClaimPublicView {
                        id,
                        present: false,
                        recipient: StdString::from("<archived>"),
                        amount: expected_amt,
                        route,
                        source_chain: StdString::from("<archived>"),
                        source_nonce,
                        created_at: 0,
                        settled: false,
                        replay_processed,
                        ttl_ledgers: 0,
                    });
                }
            }
        }

        PublicLifecycleSnapshot {
            ledger_sequence: self.env.ledger().sequence(),
            ledger_timestamp: self.env.ledger().timestamp(),
            executable_hash: self.current_executable_hash(),
            paused: cfg.paused,
            cctp_enabled: self.router().is_route_enabled(&RouteKind::Cctp),
            axelar_gmp_enabled: self.router().is_route_enabled(&RouteKind::AxelarGmp),
            token_enabled: tok_cfg.enabled,
            token_flow_limit: tok_cfg.flow_limit,
            treasury: cfg.treasury.to_string().to_string(),
            claim_count,
            queue_count,
            instance_ttl,
            rail_balance: self.token().balance(&self.rail_id),
            router_balance: self.token().balance(&self.router_id),
            treasury_balance: self.token().balance(&self.treasury),
            settler_balance: self.token().balance(&self.settler),
            recipient_one_balance: self.token().balance(&self.recipient_one),
            recipient_two_balance: self.token().balance(&self.recipient_two),
            outstanding_liability,
            claims,
        }
    }

    fn record_step<F>(
        &mut self,
        phase: &'static str,
        operation: &str,
        expected_meta: &[(u64, RouteKind, u64, i128)],
        action: F,
    ) where
        F: FnOnce(&mut Self) -> StdString,
    {
        let before = self.snapshot_public_state(expected_meta);
        let outcome = action(self);
        let after = self.snapshot_public_state(expected_meta);
        let step = self.transitions.len() + 1;
        self.transitions.push(TransitionRecord {
            step,
            phase,
            operation: StdString::from(operation),
            outcome,
            before,
            after,
        });
    }

    fn rebind_addresses(&mut self, next_env: Env) {
        let rebind = |addr: &Address| -> Address {
            let text = addr.to_string().to_string();
            Address::from_str(&next_env, &text)
        };
        self.router_id = rebind(&self.router_id);
        self.rail_id = rebind(&self.rail_id);
        self.token_id = rebind(&self.token_id);
        self.admin = rebind(&self.admin);
        self.guardian = rebind(&self.guardian);
        self.treasury = rebind(&self.treasury);
        self.recipient_one = rebind(&self.recipient_one);
        self.recipient_two = rebind(&self.recipient_two);
        self.settler = rebind(&self.settler);
        self.env = next_env;
    }

    /// Boot a fresh Soroban test host from a ledger snapshot while clearing recording-mode
    /// `LedgerKeyNonce` entries so the new host's deterministic auth PRNG does not collide with
    /// pre-crash mock-auth nonces. All contract `Instance`, `Persistent`, and `Temporary` data
    /// entries remain untouched.
    fn boot_env_from_snapshot(mut snapshot: soroban_sdk::testutils::Snapshot) -> Env {
        snapshot.ledger.ledger_entries.retain(|(_, (entry, _))| {
            !matches!(
                &entry.data,
                LedgerEntryData::ContractData(cd)
                    if matches!(cd.key, ScVal::LedgerKeyNonce(_))
            )
        });
        let mut recovered = Env::from_snapshot(snapshot);
        recovered.set_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        recovered.mock_all_auths();
        Self::register_executables(&recovered);
        recovered
    }

    /// Simulate an abrupt keeper/host crash by serializing ledger state into a snapshot,
    /// discarding the live Env, and booting a fresh Env from persisted ledger entries.
    fn simulate_host_crash_and_reload(&mut self) {
        let snapshot = self.env.to_snapshot();
        let recovered = Self::boot_env_from_snapshot(snapshot);
        self.rebind_addresses(recovered);
    }

    /// Evict router persistent entries whose `live_until_ledger_seq < sequence_number` from
    /// active host storage into an Expired State Store (ESS) snapshot. In recording mode,
    /// `soroban-env-host` auto-restores expired persistent entries on read; explicit eviction
    /// models Stellar Core's Hot Archive state prior to `RestoreFootprintOp`.
    fn evict_expired_router_persistent_entries(&mut self) -> soroban_sdk::testutils::Snapshot {
        let full_snapshot = self.env.to_snapshot();
        let mut active = full_snapshot.clone();
        let router_sc: soroban_sdk::xdr::ScAddress = self.router_id.clone().into();
        let seq = active.ledger.sequence_number;

        active
            .ledger
            .ledger_entries
            .retain(|(_, (entry, live_until))| {
                let is_expired_router_persistent = match &entry.data {
                    LedgerEntryData::ContractData(cd) => {
                        cd.contract == router_sc
                            && cd.durability == ContractDataDurability::Persistent
                            && cd.key != ScVal::LedgerKeyContractInstance
                            && live_until.is_some_and(|lu| lu < seq)
                    }
                    _ => false,
                };
                !is_expired_router_persistent
            });

        let recovered = Self::boot_env_from_snapshot(active);
        self.rebind_addresses(recovered);
        full_snapshot
    }

    /// Restore archived persistent ContractData entries for the router from a pre-expiry Expired
    /// State Store (ESS) snapshot, matching Stellar RestoreFootprintOp recovery semantics.
    fn restore_router_persistent_entries_from_ess(
        &mut self,
        ess_snapshot: &soroban_sdk::testutils::Snapshot,
    ) {
        let mut current = self.env.to_snapshot();
        let router_sc: soroban_sdk::xdr::ScAddress = self.router_id.clone().into();
        let restored_live_until = current.ledger.sequence_number + BUMP_TO;

        for (ess_key, (ess_entry, _)) in &ess_snapshot.ledger.ledger_entries {
            let is_router_persistent = match &ess_entry.data {
                LedgerEntryData::ContractData(cd) => {
                    cd.contract == router_sc
                        && cd.durability == ContractDataDurability::Persistent
                        && cd.key != ScVal::LedgerKeyContractInstance
                }
                _ => false,
            };
            if !is_router_persistent {
                continue;
            }
            if let Some(pos) = current
                .ledger
                .ledger_entries
                .iter()
                .position(|(k, _)| **k == **ess_key)
            {
                current.ledger.ledger_entries[pos] = (
                    ess_key.clone(),
                    (ess_entry.clone(), Some(restored_live_until)),
                );
            } else {
                current.ledger.ledger_entries.push((
                    ess_key.clone(),
                    (ess_entry.clone(), Some(restored_live_until)),
                ));
            }
        }

        let recovered = Self::boot_env_from_snapshot(current);
        self.rebind_addresses(recovered);
    }

    fn format_report(&self) -> StdString {
        let mut lines = StdVec::new();
        lines.push(format!("transitions={}", self.transitions.len()));
        for tr in &self.transitions {
            lines.push(format!(
                "step={} phase={} op={} outcome={}",
                tr.step, tr.phase, tr.operation, tr.outcome
            ));
            lines.push(format!("  before: {}", tr.before.format_compact()));
            lines.push(format!("  after:  {}", tr.after.format_compact()));
        }
        lines.join("\n")
    }
}

fn assert_trace_invariants(transitions: &[TransitionRecord], minted_supply: i128) {
    assert!(
        !transitions.is_empty(),
        "transition trace must not be empty"
    );
    for (idx, tr) in transitions.iter().enumerate() {
        if idx > 0 {
            assert_eq!(
                transitions[idx - 1].after,
                tr.before,
                "public state continuity broke before step {} ({})",
                tr.step,
                tr.operation
            );
        }
        assert_eq!(
            tr.before.total_supply(),
            minted_supply,
            "supply mismatch before step {} ({})",
            tr.step,
            tr.operation
        );
        assert_eq!(
            tr.after.total_supply(),
            minted_supply,
            "supply mismatch after step {} ({})",
            tr.step,
            tr.operation
        );
        assert!(
            tr.after.router_balance >= tr.after.outstanding_liability,
            "router became insolvent at step {} ({}): router={} liability={}",
            tr.step,
            tr.operation,
            tr.after.router_balance,
            tr.after.outstanding_liability
        );
        assert_eq!(
            tr.after.settler_balance, 0,
            "permissionless settler gained funds at step {}",
            tr.step
        );
        assert_eq!(
            tr.after.treasury_balance, 0,
            "treasury gained inbound claim funds at step {}",
            tr.step
        );
    }
}

#[test]
fn end_to_end_crash_upgrade_archival_restoration_and_settlement_preserves_liabilities() {
    let mut rig = LifecycleRig::new();
    let total_minted = HUNDRED * 3;
    rig.token().mint(&rig.rail_id, &total_minted);
    rig.token().set_blocked(&rig.recipient_one, &true);
    rig.token().set_blocked(&rig.recipient_two, &true);

    let meta = [
        (1u64, RouteKind::Cctp, 11u64, HUNDRED),
        (2u64, RouteKind::AxelarGmp, 12u64, HUNDRED * 2),
    ];

    // 1. Park claim #1 over CCTP.
    rig.record_step("parking", "deliver_claim_1_cctp", &meta, |r| {
        let id = r.rail().deliver(&Delivery {
            route: RouteKind::Cctp,
            token: r.token_id.clone(),
            amount: HUNDRED,
            recipient: r.recipient_one.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: String::from_str(&r.env, "ethereum"),
            source_nonce: 11,
        });
        assert_eq!(id, 1);
        StdString::from("parked:1")
    });

    // 2. Park claim #2 over AxelarGmp.
    rig.record_step("parking", "deliver_claim_2_axelar_gmp", &meta, |r| {
        let id = r.rail().deliver(&Delivery {
            route: RouteKind::AxelarGmp,
            token: r.token_id.clone(),
            amount: HUNDRED * 2,
            recipient: r.recipient_two.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: String::from_str(&r.env, "base"),
            source_nonce: 12,
        });
        assert_eq!(id, 2);
        StdString::from("parked:2")
    });

    // 3. Failed settlement while recipient_one is still blocked.
    rig.record_step("failed_settlement", "settle_blocked_claim_1", &meta, |r| {
        let res = r.router().try_settle_claim(&r.settler, &1);
        assert_eq!(res, Err(Ok(HyperionError::RecipientNotReady)));
        StdString::from("err:RecipientNotReady")
    });

    // 4. Controlled operational interruptions: pause, route disable, token disable, flow tighten, replay.
    rig.record_step(
        "interruption",
        "emergency_pause_and_lane_shutdown",
        &meta,
        |r| {
            r.router().pause(&r.guardian);
            r.router().disable_route(&r.guardian, &RouteKind::Cctp);
            r.router().disable_token(&r.guardian, &r.token_id);
            r.router()
                .lower_token_flow_limit(&r.guardian, &r.token_id, &500_000);
            let replay = r.rail().try_deliver(&Delivery {
                route: RouteKind::Cctp,
                token: r.token_id.clone(),
                amount: HUNDRED,
                recipient: r.recipient_one.clone(),
                recipient_kind: AddressKind::Account,
                source_chain: String::from_str(&r.env, "ethereum"),
                source_nonce: 11,
            });
            assert_eq!(replay, Err(Ok(HyperionError::ReplayedMessage)));
            StdString::from("paused_disabled_replay_refused")
        },
    );

    // 5. Simulate an abrupt host/keeper process crash and reload from ledger snapshot.
    rig.record_step(
        "interruption",
        "host_crash_and_snapshot_reload",
        &meta,
        |r| {
            r.simulate_host_crash_and_reload();
            StdString::from("reloaded_from_snapshot")
        },
    );

    // 6. Queue a rogue upgrade, refuse premature execution, and cancel via guardian.
    rig.record_step(
        "interruption",
        "queue_and_guardian_cancel_rogue_upgrade",
        &meta,
        |r| {
            let rogue_hash = BytesN::from_array(&r.env, &ROGUE_UPGRADE_HASH);
            let action_id = r
                .router()
                .queue_action(&r.admin, &AdminAction::Upgrade(rogue_hash));
            assert_eq!(
                r.router().try_execute_action(&r.admin, &action_id),
                Err(Ok(HyperionError::TimelockNotReady))
            );
            r.router().cancel_action(&r.guardian, &action_id);
            r.advance_time(MIN_TIMELOCK_DELAY + 1);
            let exec_after_cancel = r.router().try_execute_action(&r.admin, &action_id);
            assert_eq!(exec_after_cancel, Err(Ok(HyperionError::TimelockNotQueued)));
            StdString::from("rogue_upgrade_cancelled")
        },
    );

    // 7. Live timelocked contract upgrade to UpgradedHyperionRouterV2.
    rig.record_step("upgrade", "timelocked_upgrade_to_v2", &meta, |r| {
        let v2_hash = BytesN::from_array(&r.env, &V2_WASM_HASH);
        r.run_timelocked(AdminAction::Upgrade(v2_hash));
        assert_eq!(r.router_v2().runtime_version(), 2);
        assert_eq!(r.current_executable_hash(), V2_WASM_HASH);
        StdString::from("upgraded:v2")
    });

    // 8. Advance ledgers into the archival danger zone (< BUMP_THRESHOLD = 17_280) and restore via keep_alive.
    rig.record_step(
        "restoration",
        "ttl_decay_and_proactive_keep_alive",
        &meta,
        |r| {
            r.advance_ledgers(505_000, 2_525_000);
            let ttl_before = r.env.as_contract(&r.router_id, || {
                r.env.storage().persistent().get_ttl(&DataKey::Claim(1))
            });
            assert_eq!(ttl_before, BUMP_TO - 505_000);
            assert!(ttl_before < BUMP_THRESHOLD);

            let mut tokens = Vec::new(&r.env);
            tokens.push_back(r.token_id.clone());
            let mut routes = Vec::new(&r.env);
            routes.push_back(RouteKind::Cctp);
            let mut claims = Vec::new(&r.env);
            claims.push_back(1u64);
            claims.push_back(2u64);
            let transfers = Vec::new(&r.env);

            r.router_v2()
                .keep_alive(&tokens, &routes, &claims, &transfers);
            let ttl_after = r.env.as_contract(&r.router_id, || {
                r.env.storage().persistent().get_ttl(&DataKey::Claim(1))
            });
            assert_eq!(ttl_after, BUMP_TO);
            StdString::from("keep_alive_restored_ttl")
        },
    );

    let mut ess_archive = None;

    // 9. Advance past BUMP_TO so persistent claim records expire into ESS archive.
    rig.record_step(
        "interruption",
        "advance_past_persistent_ttl_expiry",
        &meta,
        |r| {
            r.advance_ledgers(BUMP_TO + 1_600, 2_600_000);
            ess_archive = Some(r.evict_expired_router_persistent_entries());
            assert_eq!(
                r.router_v2().try_settle_claim(&r.settler, &1),
                Err(Ok(HyperionError::ClaimNotFound))
            );
            StdString::from("expired_in_active_storage")
        },
    );

    // 10. Restore archived persistent claim and replay entries from ESS snapshot.
    rig.record_step(
        "restoration",
        "restore_archived_claims_from_ess",
        &meta,
        |r| {
            r.restore_router_persistent_entries_from_ess(
                ess_archive.as_ref().expect("ess archive captured"),
            );
            assert_eq!(r.router_v2().get_claim(&1).amount, HUNDRED);
            assert_eq!(r.router_v2().get_claim(&2).amount, HUNDRED * 2);
            assert!(r
                .router_v2()
                .was_processed(&RouteKind::Cctp, &message_id(&r.env, 11)));
            StdString::from("restored_from_ess")
        },
    );

    // 11. Unblock recipient_one and settle claim #1 while bridge remains paused and route/token disabled.
    rig.record_step(
        "final_settlement",
        "unblock_and_settle_claim_1_while_paused",
        &meta,
        |r| {
            r.token().set_blocked(&r.recipient_one, &false);
            r.router_v2().settle_claim(&r.settler, &1);
            StdString::from("settled:1")
        },
    );

    // 12. Repeated settlement attempts on claim #1 across callers, upgrade to v3, and unpause never pay twice.
    rig.record_step(
        "duplicate_settlement",
        "reject_repeated_settlement_on_claim_1",
        &meta,
        |r| {
            assert_eq!(
                r.router_v2().try_settle_claim(&r.settler, &1),
                Err(Ok(HyperionError::ClaimAlreadySettled))
            );
            assert_eq!(
                r.router_v2().try_settle_claim(&r.recipient_one, &1),
                Err(Ok(HyperionError::ClaimAlreadySettled))
            );
            let v3_hash = BytesN::from_array(&r.env, &V3_WASM_HASH);
            r.run_timelocked(AdminAction::Upgrade(v3_hash));
            assert_eq!(r.current_executable_hash(), V3_WASM_HASH);
            r.router().unpause(&r.admin);
            assert_eq!(
                r.router().try_settle_claim(&r.admin, &1),
                Err(Ok(HyperionError::ClaimAlreadySettled))
            );
            StdString::from("err:ClaimAlreadySettled")
        },
    );

    // 13. Unblock recipient_two, settle claim #2 on v3, and confirm repeated settlement fails.
    rig.record_step(
        "final_settlement",
        "unblock_and_settle_claim_2_on_v3",
        &meta,
        |r| {
            r.token().set_blocked(&r.recipient_two, &false);
            r.router().settle_claim(&r.settler, &2);
            assert_eq!(
                r.router().try_settle_claim(&r.settler, &2),
                Err(Ok(HyperionError::ClaimAlreadySettled))
            );
            StdString::from("settled:2")
        },
    );

    assert_trace_invariants(&rig.transitions, total_minted);

    let final_snap = &rig.transitions.last().expect("non-empty transitions").after;
    assert_eq!(final_snap.router_balance, 0);
    assert_eq!(final_snap.outstanding_liability, 0);
    assert_eq!(final_snap.recipient_one_balance, HUNDRED);
    assert_eq!(final_snap.recipient_two_balance, HUNDRED * 2);
    assert!(final_snap
        .claims
        .iter()
        .all(|c| c.present && c.settled && c.replay_processed));

    let report = rig.format_report();
    assert!(report.contains("transitions=13"));
    assert!(report.contains("step=7 phase=upgrade op=timelocked_upgrade_to_v2 outcome=upgraded:v2"));
    assert!(report.contains(
        "step=10 phase=restoration op=restore_archived_claims_from_ess outcome=restored_from_ess"
    ));
    assert!(report.contains("  before: seq="));
    assert!(report.contains("  after:  seq="));
}

#[test]
fn treasury_and_role_rotations_during_parked_custody_never_divert_recipient_payout() {
    let mut rig = LifecycleRig::new();
    rig.token().mint(&rig.rail_id, &HUNDRED);
    rig.token().set_blocked(&rig.recipient_one, &true);

    let meta = [(1u64, RouteKind::AxelarIts, 77u64, HUNDRED)];

    rig.record_step("parking", "park_claim_its", &meta, |r| {
        let id = r.rail().deliver(&Delivery {
            route: RouteKind::AxelarIts,
            token: r.token_id.clone(),
            amount: HUNDRED,
            recipient: r.recipient_one.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: String::from_str(&r.env, "arbitrum"),
            source_nonce: 77,
        });
        assert_eq!(id, 1);
        StdString::from("parked:1")
    });

    rig.record_step(
        "interruption",
        "rotate_treasury_guardian_and_admin",
        &meta,
        |r| {
            let new_treasury = Address::generate(&r.env);
            let new_guardian = Address::generate(&r.env);
            let new_admin = Address::generate(&r.env);
            r.run_timelocked(AdminAction::SetTreasury(new_treasury.clone()));
            r.run_timelocked(AdminAction::SetGuardian(new_guardian.clone()));
            r.run_timelocked(AdminAction::SetAdmin(new_admin.clone()));
            r.treasury = new_treasury;
            r.guardian = new_guardian;
            r.admin = new_admin;
            StdString::from("roles_rotated")
        },
    );

    rig.record_step(
        "final_settlement",
        "settle_to_original_recipient",
        &meta,
        |r| {
            r.token().set_blocked(&r.recipient_one, &false);
            r.router().settle_claim(&r.admin, &1);
            StdString::from("settled:1")
        },
    );

    assert_trace_invariants(&rig.transitions, HUNDRED);
    let last = &rig.transitions.last().unwrap().after;
    assert_eq!(last.recipient_one_balance, HUNDRED);
    assert_eq!(last.treasury_balance, 0);
    assert_eq!(last.router_balance, 0);
}
