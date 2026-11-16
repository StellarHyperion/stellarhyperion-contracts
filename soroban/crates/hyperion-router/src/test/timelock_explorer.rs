//! Stateful timelock boundary and multi-actor authority sequence explorer for `HyperionRouter`.

extern crate std;

use std::collections::{BTreeMap, BTreeSet};
use std::format;
use std::string::{String as StdString, ToString};
use std::vec::Vec as StdVec;

use hyperion_core::{
    HyperionError, RouteKind, DEFAULT_FLOW_WINDOW_LEDGERS, MAX_FEE_BPS, STELLAR_DECIMALS,
};
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    xdr::ToXdr,
    Address, BytesN, Env,
};

use super::doubles::{all_routes, FailableToken, FailableTokenClient, MockRail, MockRailClient};
use super::setup::{FEE_BPS, FLOW_LIMIT};
use crate::timelock::{GRACE_PERIOD, MAX_TIMELOCK_DELAY, MIN_TIMELOCK_DELAY};
use crate::types::{AdminAction, QueuedAction, RouteConfig};
use crate::{HyperionRouter, HyperionRouterClient};

const V1_WASM: [u8; 32] = [0x41; 32];
const V2_WASM: [u8; 32] = [0x42; 32];

#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum ActorSlot {
    Admin1,
    Admin2,
    Admin3,
    Guardian1,
    Guardian2,
    Stranger,
}

#[derive(Clone, Debug)]
enum SeqOp {
    Advance {
        seconds: u64,
        ledgers: u32,
    },
    Queue {
        caller: ActorSlot,
        action: AdminAction,
    },
    Execute {
        caller: ActorSlot,
        id: u64,
    },
    Cancel {
        caller: ActorSlot,
        id: u64,
    },
    Pause {
        caller: ActorSlot,
    },
    Unpause {
        caller: ActorSlot,
    },
    DisableRoute {
        caller: ActorSlot,
        route: RouteKind,
    },
    DisableToken {
        caller: ActorSlot,
    },
    LowerTokenFlowLimit {
        caller: ActorSlot,
        limit: i128,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FailureTrace {
    sequence_name: StdString,
    step_index: usize,
    invariant: &'static str,
    timestamp: u64,
    ledger_sequence: u32,
    caller: Option<ActorSlot>,
    active_admin: ActorSlot,
    active_guardian: ActorSlot,
    queued_window: Option<(u64, u64, u64, u64)>,
    action_debug: StdString,
    action_xdr_hex: StdString,
    detail: StdString,
}

impl FailureTrace {
    fn format_line(&self) -> StdString {
        let win = match self.queued_window {
            Some((id, q_at, eta, exp)) => {
                format!("window={{id={id},queued_at={q_at},eta={eta},expires_at={exp}}}")
            }
            None => StdString::from("window=none"),
        };
        format!(
            "sequence={} step={} invariant={} timestamp={} ledger={} caller={:?} active_admin={:?} active_guardian={:?} {} action={} action_xdr={} detail={}",
            self.sequence_name,
            self.step_index,
            self.invariant,
            self.timestamp,
            self.ledger_sequence,
            self.caller,
            self.active_admin,
            self.active_guardian,
            win,
            self.action_debug,
            self.action_xdr_hex,
            self.detail
        )
    }
}

fn encode_action_xdr_hex(env: &Env, action: &AdminAction) -> StdString {
    let raw = action.clone().to_xdr(env);
    let mut out = StdString::with_capacity((raw.len() as usize) * 2 + 2);
    out.push_str("0x");
    for i in 0..raw.len() {
        let byte = raw.get(i).unwrap_or(0);
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[derive(Clone, Debug)]
struct ShadowQueueItem {
    id: u64,
    action: AdminAction,
    queued_at: u64,
    eta: u64,
    expires_at: u64,
    active: bool,
}

struct ExplorerHarness {
    env: Env,
    router_id: Address,
    rail_id: Address,
    token_id: Address,
    actors: BTreeMap<ActorSlot, Address>,
    shadow_admin: ActorSlot,
    shadow_guardian: ActorSlot,
    shadow_treasury: Address,
    shadow_fee_bps: u32,
    shadow_delay: u64,
    shadow_window: u32,
    shadow_paused: bool,
    shadow_token_enabled: bool,
    shadow_token_limit: i128,
    shadow_routes: BTreeMap<u32, bool>,
    shadow_queue: BTreeMap<u64, ShadowQueueItem>,
    shadow_queue_seq: u64,
    superseded_admins: BTreeSet<ActorSlot>,
    superseded_guardians: BTreeSet<ActorSlot>,
}

impl ExplorerHarness {
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

        env.upload_at(V1_WASM, HyperionRouter);
        env.upload_at(V2_WASM, HyperionRouter);

        let deployer = Address::generate(&env);
        let v1_hash = BytesN::from_array(&env, &V1_WASM);
        let router_id = env
            .deployer()
            .with_address(deployer, [9u8; 32])
            .deploy_contract(soroban_sdk::ContractExecutable::Wasm(v1_hash), ());
        let rail_id = env.register(MockRail, ());
        let token_id = env.register(FailableToken, ());

        FailableTokenClient::new(&env, &token_id).init(&STELLAR_DECIMALS);
        MockRailClient::new(&env, &rail_id).init(&router_id);

        let mut actors = BTreeMap::new();
        for slot in [
            ActorSlot::Admin1,
            ActorSlot::Admin2,
            ActorSlot::Admin3,
            ActorSlot::Guardian1,
            ActorSlot::Guardian2,
            ActorSlot::Stranger,
        ] {
            actors.insert(slot, Address::generate(&env));
        }

        let treasury = Address::generate(&env);
        let admin1 = actors.get(&ActorSlot::Admin1).unwrap().clone();
        let guardian1 = actors.get(&ActorSlot::Guardian1).unwrap().clone();

        let router = HyperionRouterClient::new(&env, &router_id);
        router.initialize(
            &admin1,
            &guardian1,
            &treasury,
            &FEE_BPS,
            &DEFAULT_FLOW_WINDOW_LEDGERS,
            &MIN_TIMELOCK_DELAY,
        );

        let mut shadow_queue_seq = 0u64;
        let mut run_init_action = |action: AdminAction| {
            let id = router.queue_action(&admin1, &action);
            shadow_queue_seq = id;
            env.ledger().with_mut(|li| {
                li.timestamp += MIN_TIMELOCK_DELAY + 1;
                li.sequence_number += 720;
            });
            router.execute_action(&admin1, &id);
        };

        let mut shadow_routes = BTreeMap::new();
        for route in all_routes() {
            run_init_action(AdminAction::SetAdapter(route, rail_id.clone()));
            run_init_action(AdminAction::SetRailReceiver(route, rail_id.clone()));
            let open = matches!(route, RouteKind::Cctp | RouteKind::AxelarIts);
            if open {
                run_init_action(AdminAction::EnableRoute(route));
            }
            shadow_routes.insert(route as u32, open);
        }
        run_init_action(AdminAction::RegisterToken(
            token_id.clone(),
            STELLAR_DECIMALS,
            FLOW_LIMIT,
        ));

        // Extend infrastructure TTLs across multi-week exploration horizons.
        let horizon = 4_000_000;
        env.deployer()
            .extend_ttl(router_id.clone(), horizon, horizon);
        env.deployer().extend_ttl(rail_id.clone(), horizon, horizon);
        env.deployer()
            .extend_ttl(token_id.clone(), horizon, horizon);

        Self {
            env,
            router_id,
            rail_id,
            token_id,
            actors,
            shadow_admin: ActorSlot::Admin1,
            shadow_guardian: ActorSlot::Guardian1,
            shadow_treasury: treasury,
            shadow_fee_bps: FEE_BPS,
            shadow_delay: MIN_TIMELOCK_DELAY,
            shadow_window: DEFAULT_FLOW_WINDOW_LEDGERS,
            shadow_paused: false,
            shadow_token_enabled: true,
            shadow_token_limit: FLOW_LIMIT,
            shadow_routes,
            shadow_queue: BTreeMap::new(),
            shadow_queue_seq,
            superseded_admins: BTreeSet::new(),
            superseded_guardians: BTreeSet::new(),
        }
    }

    fn router(&self) -> HyperionRouterClient<'_> {
        HyperionRouterClient::new(&self.env, &self.router_id)
    }

    fn addr(&self, slot: ActorSlot) -> Address {
        self.actors.get(&slot).expect("actor registered").clone()
    }

    fn slot_of(&self, addr: &Address) -> Option<ActorSlot> {
        self.actors
            .iter()
            .find_map(|(&slot, candidate)| (candidate == addr).then_some(slot))
    }

    fn validate_action(action: &AdminAction) -> Result<(), HyperionError> {
        match action {
            AdminAction::SetFeeBps(bps) if *bps > MAX_FEE_BPS => Err(HyperionError::FeeTooHigh),
            AdminAction::SetTimelockDelay(d)
                if *d < MIN_TIMELOCK_DELAY || *d > MAX_TIMELOCK_DELAY =>
            {
                Err(HyperionError::TimelockDelayOutOfRange)
            }
            AdminAction::SetFlowWindow(0) => Err(HyperionError::InvalidWindow),
            AdminAction::RegisterToken(_, dec, lim) => {
                if *lim < 0 {
                    Err(HyperionError::InvalidLimit)
                } else if *dec > 38 {
                    Err(HyperionError::InvalidDecimals)
                } else {
                    Ok(())
                }
            }
            AdminAction::RaiseTokenFlowLimit(_, lim)
            | AdminAction::SetRouteFlowLimit(_, _, lim)
            | AdminAction::SetRouteMaxSingleTransfer(_, lim)
                if *lim < 0 =>
            {
                Err(HyperionError::InvalidLimit)
            }
            AdminAction::SetRouteConfig(_, rc) if rc.max_single_transfer < 0 => {
                Err(HyperionError::InvalidLimit)
            }
            _ => Ok(()),
        }
    }

    fn apply_shadow_action(&mut self, action: &AdminAction) {
        match action {
            AdminAction::SetFeeBps(bps) => self.shadow_fee_bps = *bps,
            AdminAction::SetTreasury(addr) => self.shadow_treasury = addr.clone(),
            AdminAction::SetAdmin(addr) => {
                if let Some(next_slot) = self.slot_of(addr) {
                    if self.shadow_admin != next_slot {
                        self.superseded_admins.insert(self.shadow_admin);
                    }
                    self.superseded_admins.remove(&next_slot);
                    self.shadow_admin = next_slot;
                }
            }
            AdminAction::SetGuardian(addr) => {
                if let Some(next_slot) = self.slot_of(addr) {
                    if self.shadow_guardian != next_slot {
                        self.superseded_guardians.insert(self.shadow_guardian);
                    }
                    self.superseded_guardians.remove(&next_slot);
                    self.shadow_guardian = next_slot;
                }
            }
            AdminAction::EnableRoute(r) => {
                self.shadow_routes.insert(*r as u32, true);
            }
            AdminAction::RegisterToken(tok, _, lim) if *tok == self.token_id => {
                self.shadow_token_enabled = true;
                self.shadow_token_limit = *lim;
            }
            AdminAction::RaiseTokenFlowLimit(tok, lim) if *tok == self.token_id => {
                self.shadow_token_limit = *lim;
            }
            AdminAction::SetTimelockDelay(d) => self.shadow_delay = *d,
            AdminAction::SetFlowWindow(w) => self.shadow_window = *w,
            _ => {}
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn build_failure_trace(
        &self,
        sequence_name: &str,
        step_index: usize,
        invariant: &'static str,
        caller: Option<ActorSlot>,
        queued: Option<&ShadowQueueItem>,
        fallback_action: Option<&AdminAction>,
        detail: StdString,
    ) -> FailureTrace {
        let action_opt = queued.map(|q| &q.action).or(fallback_action);
        let (action_debug, action_xdr_hex) = match action_opt {
            Some(act) => (format!("{act:?}"), encode_action_xdr_hex(&self.env, act)),
            None => (StdString::from("None"), StdString::from("0x")),
        };
        FailureTrace {
            sequence_name: StdString::from(sequence_name),
            step_index,
            invariant,
            timestamp: self.env.ledger().timestamp(),
            ledger_sequence: self.env.ledger().sequence(),
            caller,
            active_admin: self.shadow_admin,
            active_guardian: self.shadow_guardian,
            queued_window: queued.map(|q| (q.id, q.queued_at, q.eta, q.expires_at)),
            action_debug,
            action_xdr_hex,
            detail,
        }
    }

    fn execute_sequence(&mut self, sequence_name: &str, ops: &[SeqOp]) -> StdVec<FailureTrace> {
        let mut traces = StdVec::new();

        for (idx, op) in ops.iter().enumerate() {
            let step = idx + 1;
            let admin_before = self.shadow_admin;
            let guardian_before = self.shadow_guardian;
            let is_admin = |who: ActorSlot| who == admin_before;
            let is_admin_or_guardian =
                |who: ActorSlot| who == admin_before || who == guardian_before;

            match op {
                SeqOp::Advance { seconds, ledgers } => {
                    self.env.ledger().with_mut(|li| {
                        li.timestamp += *seconds;
                        li.sequence_number += *ledgers;
                    });
                    let horizon = 4_000_000;
                    self.env
                        .deployer()
                        .extend_ttl(self.router_id.clone(), horizon, horizon);
                }

                SeqOp::Queue { caller, action } => {
                    let caller_addr = self.addr(*caller);
                    let actual = self.router().try_queue_action(&caller_addr, action);
                    let expected: Result<u64, HyperionError> = if !is_admin(*caller) {
                        Err(HyperionError::Unauthorized)
                    } else if let Err(e) = Self::validate_action(action) {
                        Err(e)
                    } else {
                        let next_id = self.shadow_queue_seq + 1;
                        self.shadow_queue_seq = next_id;
                        let now = self.env.ledger().timestamp();
                        let eta = now + self.shadow_delay;
                        let expires_at = eta + GRACE_PERIOD;
                        self.shadow_queue.insert(
                            next_id,
                            ShadowQueueItem {
                                id: next_id,
                                action: action.clone(),
                                queued_at: now,
                                eta,
                                expires_at,
                                active: true,
                            },
                        );
                        Ok(next_id)
                    };

                    if actual != expected.map(Ok).map_err(Ok) {
                        traces.push(self.build_failure_trace(
                            sequence_name,
                            step,
                            "QUEUE_MISMATCH",
                            Some(*caller),
                            None,
                            Some(action),
                            format!("actual={actual:?} expected={expected:?}"),
                        ));
                    }
                }

                SeqOp::Execute { caller, id } => {
                    let caller_addr = self.addr(*caller);
                    let snapshot_item = self.shadow_queue.get(id).cloned();
                    let now = self.env.ledger().timestamp();
                    let actual = self.router().try_execute_action(&caller_addr, id);

                    if matches!(actual, Ok(Ok(()))) {
                        if (self.superseded_admins.contains(caller)
                            || self.superseded_guardians.contains(caller))
                            && !is_admin(*caller)
                        {
                            traces.push(self.build_failure_trace(
                                sequence_name,
                                step,
                                "SUPERSEDED_ACTOR_RETAINED_AUTHORITY",
                                Some(*caller),
                                snapshot_item.as_ref(),
                                None,
                                format!("superseded actor {caller:?} executed action #{id}"),
                            ));
                        }
                        if let Some(ref item) = snapshot_item {
                            if now < item.eta {
                                traces.push(self.build_failure_trace(
                                    sequence_name,
                                    step,
                                    "EARLY_UNREVIEWED_EXPANSION",
                                    Some(*caller),
                                    Some(item),
                                    None,
                                    format!("executed at {now} before eta {}", item.eta),
                                ));
                            }
                        }
                    }

                    let expected: Result<(), HyperionError> = if !is_admin(*caller) {
                        Err(HyperionError::Unauthorized)
                    } else {
                        match self.shadow_queue.get_mut(id) {
                            None => Err(HyperionError::TimelockNotQueued),
                            Some(item) if !item.active => Err(HyperionError::TimelockNotQueued),
                            Some(item) if now < item.eta => Err(HyperionError::TimelockNotReady),
                            Some(item) if now > item.expires_at => {
                                Err(HyperionError::TimelockExpired)
                            }
                            Some(item) => {
                                item.active = false;
                                let cloned_action = item.action.clone();
                                self.apply_shadow_action(&cloned_action);
                                Ok(())
                            }
                        }
                    };

                    if actual != expected.map(Ok).map_err(Ok) {
                        traces.push(self.build_failure_trace(
                            sequence_name,
                            step,
                            "EXECUTE_MISMATCH",
                            Some(*caller),
                            snapshot_item.as_ref(),
                            None,
                            format!("actual={actual:?} expected={expected:?}"),
                        ));
                    }
                }

                SeqOp::Cancel { caller, id } => {
                    let caller_addr = self.addr(*caller);
                    let snapshot_item = self.shadow_queue.get(id).cloned();
                    let actual = self.router().try_cancel_action(&caller_addr, id);
                    let expected: Result<(), HyperionError> = if !is_admin_or_guardian(*caller) {
                        Err(HyperionError::Unauthorized)
                    } else {
                        match self.shadow_queue.get_mut(id) {
                            Some(item) if item.active => {
                                item.active = false;
                                Ok(())
                            }
                            _ => Err(HyperionError::TimelockNotQueued),
                        }
                    };
                    if actual != expected.map(Ok).map_err(Ok) {
                        traces.push(self.build_failure_trace(
                            sequence_name,
                            step,
                            "CANCEL_MISMATCH",
                            Some(*caller),
                            snapshot_item.as_ref(),
                            None,
                            format!("actual={actual:?} expected={expected:?}"),
                        ));
                    }
                }

                SeqOp::Pause { caller } => {
                    let actual = self.router().try_pause(&self.addr(*caller));
                    let expected = if is_admin_or_guardian(*caller) {
                        self.shadow_paused = true;
                        Ok(())
                    } else {
                        Err(HyperionError::Unauthorized)
                    };
                    if actual != expected.map(Ok).map_err(Ok) {
                        traces.push(self.build_failure_trace(
                            sequence_name,
                            step,
                            "PAUSE_MISMATCH",
                            Some(*caller),
                            None,
                            None,
                            format!("actual={actual:?} expected={expected:?}"),
                        ));
                    }
                }

                SeqOp::Unpause { caller } => {
                    let actual = self.router().try_unpause(&self.addr(*caller));
                    let expected = if is_admin(*caller) {
                        self.shadow_paused = false;
                        Ok(())
                    } else {
                        Err(HyperionError::Unauthorized)
                    };
                    if actual != expected.map(Ok).map_err(Ok) {
                        traces.push(self.build_failure_trace(
                            sequence_name,
                            step,
                            "UNPAUSE_MISMATCH",
                            Some(*caller),
                            None,
                            None,
                            format!("actual={actual:?} expected={expected:?}"),
                        ));
                    }
                }

                SeqOp::DisableRoute { caller, route } => {
                    let actual = self.router().try_disable_route(&self.addr(*caller), route);
                    let expected = if is_admin_or_guardian(*caller) {
                        self.shadow_routes.insert(*route as u32, false);
                        Ok(())
                    } else {
                        Err(HyperionError::Unauthorized)
                    };
                    if actual != expected.map(Ok).map_err(Ok) {
                        traces.push(self.build_failure_trace(
                            sequence_name,
                            step,
                            "DISABLE_ROUTE_MISMATCH",
                            Some(*caller),
                            None,
                            None,
                            format!("actual={actual:?} expected={expected:?}"),
                        ));
                    }
                }

                SeqOp::DisableToken { caller } => {
                    let actual = self
                        .router()
                        .try_disable_token(&self.addr(*caller), &self.token_id);
                    let expected = if is_admin_or_guardian(*caller) {
                        self.shadow_token_enabled = false;
                        Ok(())
                    } else {
                        Err(HyperionError::Unauthorized)
                    };
                    if actual != expected.map(Ok).map_err(Ok) {
                        traces.push(self.build_failure_trace(
                            sequence_name,
                            step,
                            "DISABLE_TOKEN_MISMATCH",
                            Some(*caller),
                            None,
                            None,
                            format!("actual={actual:?} expected={expected:?}"),
                        ));
                    }
                }

                SeqOp::LowerTokenFlowLimit { caller, limit } => {
                    let actual = self.router().try_lower_token_flow_limit(
                        &self.addr(*caller),
                        &self.token_id,
                        limit,
                    );
                    let expected = if !is_admin_or_guardian(*caller) {
                        Err(HyperionError::Unauthorized)
                    } else if *limit < 0 || *limit >= self.shadow_token_limit {
                        Err(HyperionError::InvalidLimit)
                    } else {
                        self.shadow_token_limit = *limit;
                        Ok(())
                    };
                    if actual != expected.map(Ok).map_err(Ok) {
                        traces.push(self.build_failure_trace(
                            sequence_name,
                            step,
                            "LOWER_LIMIT_MISMATCH",
                            Some(*caller),
                            None,
                            None,
                            format!("actual={actual:?} expected={expected:?}"),
                        ));
                    }
                }
            }

            // Continuous post-step router state check against shadow governance model.
            let cfg = self.router().get_config();
            assert_eq!(cfg.admin, self.addr(self.shadow_admin));
            assert_eq!(cfg.guardian, self.addr(self.shadow_guardian));
            assert_eq!(cfg.treasury, self.shadow_treasury);
            assert_eq!(cfg.fee_bps, self.shadow_fee_bps);
            assert_eq!(cfg.timelock_delay, self.shadow_delay);
            assert_eq!(cfg.flow_window_ledgers, self.shadow_window);
            assert_eq!(cfg.paused, self.shadow_paused);
            let tok = self.router().get_token(&self.token_id);
            assert_eq!(tok.enabled, self.shadow_token_enabled);
            assert_eq!(tok.flow_limit, self.shadow_token_limit);
            for route in all_routes() {
                assert_eq!(
                    self.router().is_route_enabled(&route),
                    *self.shadow_routes.get(&(route as u32)).unwrap()
                );
            }
        }

        traces
    }
}

struct XorShift64(u64);

impl XorShift64 {
    fn new(seed: u64) -> Self {
        Self(if seed == 0 {
            0x9e37_79b9_7f4a_7c15
        } else {
            seed
        })
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn pick<'a, T>(&mut self, slice: &'a [T]) -> &'a T {
        let idx = (self.next_u64() as usize) % slice.len();
        &slice[idx]
    }
}

#[test]
fn boundary_handover_cancellation_expiration_disable_and_generated_sequences_preserve_invariants() {
    // 1. Exact boundaries + SetTimelockDelay + duplicate execution race.
    {
        let mut h = ExplorerHarness::new();
        let base_id = h.shadow_queue_seq;
        let v2_wasm = BytesN::from_array(&h.env, &V2_WASM);
        let ops = [
            SeqOp::Queue {
                caller: ActorSlot::Admin1,
                action: AdminAction::EnableRoute(RouteKind::AxelarGmp),
            },
            SeqOp::Advance {
                seconds: MIN_TIMELOCK_DELAY - 1,
                ledgers: 719,
            },
            SeqOp::Execute {
                caller: ActorSlot::Admin1,
                id: base_id + 1,
            }, // eta - 1 -> TimelockNotReady
            SeqOp::Advance {
                seconds: 1,
                ledgers: 1,
            },
            SeqOp::Execute {
                caller: ActorSlot::Admin1,
                id: base_id + 1,
            }, // exact eta -> ok
            SeqOp::Execute {
                caller: ActorSlot::Admin1,
                id: base_id + 1,
            }, // duplicate -> TimelockNotQueued
            SeqOp::Queue {
                caller: ActorSlot::Admin1,
                action: AdminAction::RaiseTokenFlowLimit(h.token_id.clone(), FLOW_LIMIT * 3),
            },
            SeqOp::Advance {
                seconds: MIN_TIMELOCK_DELAY + GRACE_PERIOD,
                ledgers: 121_680,
            },
            SeqOp::Execute {
                caller: ActorSlot::Admin1,
                id: base_id + 2,
            }, // exact expires_at -> ok
            SeqOp::Queue {
                caller: ActorSlot::Admin1,
                action: AdminAction::Upgrade(v2_wasm),
            },
            SeqOp::Advance {
                seconds: MIN_TIMELOCK_DELAY + GRACE_PERIOD + 1,
                ledgers: 121_681,
            },
            SeqOp::Execute {
                caller: ActorSlot::Admin1,
                id: base_id + 3,
            }, // expires_at + 1 -> TimelockExpired
        ];
        let traces = h.execute_sequence("soroban-exact-boundaries", &ops);
        assert!(traces.is_empty(), "unexpected failure traces: {traces:?}");
        assert!(h.router().is_route_enabled(&RouteKind::AxelarGmp));
        assert_eq!(h.router().get_token(&h.token_id).flow_limit, FLOW_LIMIT * 3);
    }

    // 2. Multi-actor nomination/handover race proving superseded admin and guardian lose all authority.
    {
        let mut h = ExplorerHarness::new();
        let base_id = h.shadow_queue_seq;
        let admin2_addr = h.addr(ActorSlot::Admin2);
        let guardian2_addr = h.addr(ActorSlot::Guardian2);
        let rogue_treasury = h.addr(ActorSlot::Stranger);
        let ops = [
            SeqOp::Queue {
                caller: ActorSlot::Admin1,
                action: AdminAction::SetAdmin(admin2_addr),
            },
            SeqOp::Queue {
                caller: ActorSlot::Admin1,
                action: AdminAction::SetTreasury(rogue_treasury),
            },
            SeqOp::Advance {
                seconds: MIN_TIMELOCK_DELAY,
                ledgers: 720,
            },
            SeqOp::Execute {
                caller: ActorSlot::Admin1,
                id: base_id + 1,
            }, // Handover to Admin2!
            // Superseded Admin1 loses execute, queue, cancel, pause, unpause, disable, and lower_limit:
            SeqOp::Execute {
                caller: ActorSlot::Admin1,
                id: base_id + 2,
            },
            SeqOp::Queue {
                caller: ActorSlot::Admin1,
                action: AdminAction::SetFeeBps(90),
            },
            SeqOp::Cancel {
                caller: ActorSlot::Admin1,
                id: base_id + 2,
            },
            SeqOp::Pause {
                caller: ActorSlot::Admin1,
            },
            SeqOp::DisableRoute {
                caller: ActorSlot::Admin1,
                route: RouteKind::Cctp,
            },
            SeqOp::DisableToken {
                caller: ActorSlot::Admin1,
            },
            SeqOp::LowerTokenFlowLimit {
                caller: ActorSlot::Admin1,
                limit: 1_000,
            },
            // Guardian1 cancels Admin1's leftover treasury change; Admin2 rotates guardian to Guardian2:
            SeqOp::Cancel {
                caller: ActorSlot::Guardian1,
                id: base_id + 2,
            },
            SeqOp::Execute {
                caller: ActorSlot::Admin2,
                id: base_id + 2,
            },
            SeqOp::Queue {
                caller: ActorSlot::Admin2,
                action: AdminAction::SetGuardian(guardian2_addr),
            },
            SeqOp::Advance {
                seconds: MIN_TIMELOCK_DELAY,
                ledgers: 720,
            },
            SeqOp::Execute {
                caller: ActorSlot::Admin2,
                id: base_id + 3,
            },
            // Superseded Guardian1 loses pause, disable, cancel, and lower_limit:
            SeqOp::Pause {
                caller: ActorSlot::Guardian1,
            },
            SeqOp::DisableRoute {
                caller: ActorSlot::Guardian1,
                route: RouteKind::Cctp,
            },
            SeqOp::LowerTokenFlowLimit {
                caller: ActorSlot::Guardian1,
                limit: 500,
            },
            // Guardian2 exercises emergency contraction; Admin2 unpauses:
            SeqOp::Pause {
                caller: ActorSlot::Guardian2,
            },
            SeqOp::Unpause {
                caller: ActorSlot::Guardian2,
            },
            SeqOp::Unpause {
                caller: ActorSlot::Admin2,
            },
        ];
        let traces = h.execute_sequence("soroban-authority-handover", &ops);
        assert!(traces.is_empty(), "unexpected failure traces: {traces:?}");
        assert_eq!(h.router().get_config().admin, h.addr(ActorSlot::Admin2));
        assert_eq!(
            h.router().get_config().guardian,
            h.addr(ActorSlot::Guardian2)
        );
    }

    // 3. Deterministic PRNG-generated multi-actor administration sequences.
    let slots = [
        ActorSlot::Admin1,
        ActorSlot::Admin2,
        ActorSlot::Admin3,
        ActorSlot::Guardian1,
        ActorSlot::Guardian2,
        ActorSlot::Stranger,
    ];
    let routes = all_routes();
    let deltas: [(u64, u32); 6] = [
        (1, 1),
        (1_799, 360),
        (3_599, 719),
        (3_600, 720),
        (7_200, 1_440),
        (MIN_TIMELOCK_DELAY + GRACE_PERIOD + 2, 122_000),
    ];

    for seed in 1u64..=12u64 {
        let mut h = ExplorerHarness::new();
        let mut rng = XorShift64::new(seed * 7_919);
        let base_id = h.shadow_queue_seq;
        let mut ops = StdVec::new();

        for _ in 0..36 {
            let caller = *rng.pick(&slots);
            let target_id = base_id + 1 + (rng.next_u64() % 6);
            match rng.next_u64() % 9 {
                0 | 1 => {
                    let action = match rng.next_u64() % 11 {
                        0 => AdminAction::SetFeeBps((rng.next_u64() % 130) as u32),
                        1 => AdminAction::SetTreasury(h.addr(*rng.pick(&slots))),
                        2 => AdminAction::SetAdmin(h.addr(*rng.pick(&[
                            ActorSlot::Admin1,
                            ActorSlot::Admin2,
                            ActorSlot::Admin3,
                        ]))),
                        3 => AdminAction::SetGuardian(
                            h.addr(*rng.pick(&[ActorSlot::Guardian1, ActorSlot::Guardian2])),
                        ),
                        4 => AdminAction::EnableRoute(*rng.pick(&routes)),
                        5 => AdminAction::RegisterToken(
                            h.token_id.clone(),
                            STELLAR_DECIMALS,
                            FLOW_LIMIT * 2,
                        ),
                        6 => AdminAction::RaiseTokenFlowLimit(h.token_id.clone(), FLOW_LIMIT * 4),
                        7 => AdminAction::SetTimelockDelay(*rng.pick(&[
                            120u64,
                            MIN_TIMELOCK_DELAY,
                            7_200,
                            MAX_TIMELOCK_DELAY + 5,
                        ])),
                        8 => AdminAction::SetFlowWindow(*rng.pick(&[0u32, 720, 1_440])),
                        9 => AdminAction::SetRouteConfig(
                            *rng.pick(&routes),
                            RouteConfig {
                                max_single_transfer: 5_000_000,
                            },
                        ),
                        _ => AdminAction::Upgrade(BytesN::from_array(&h.env, &V2_WASM)),
                    };
                    ops.push(SeqOp::Queue { caller, action });
                }
                2 | 3 => ops.push(SeqOp::Execute {
                    caller,
                    id: target_id,
                }),
                4 => ops.push(SeqOp::Cancel {
                    caller,
                    id: target_id,
                }),
                5 => {
                    let &(seconds, ledgers) = rng.pick(&deltas);
                    ops.push(SeqOp::Advance { seconds, ledgers });
                }
                6 => ops.push(SeqOp::Pause { caller }),
                7 => ops.push(SeqOp::DisableRoute {
                    caller,
                    route: *rng.pick(&routes),
                }),
                _ => ops.push(SeqOp::LowerTokenFlowLimit {
                    caller,
                    limit: (rng.next_u64() % 2_000_000) as i128,
                }),
            }
        }

        let name = format!("soroban-generated-seed-{seed}");
        let traces = h.execute_sequence(&name, &ops);
        assert!(
            traces.is_empty(),
            "generated sequence {name} failed with traces: {traces:?}"
        );
    }
}

#[test]
fn failure_trace_captures_chain_timestamp_ledger_and_full_xdr_action_payload() {
    let h = ExplorerHarness::new();
    let payload = AdminAction::RaiseTokenFlowLimit(h.token_id.clone(), FLOW_LIMIT * 9);
    let queued = QueuedAction {
        id: 42,
        action: payload.clone(),
        queued_at: 1_700_050_000,
        eta: 1_700_053_600,
        expires_at: 1_700_658_400,
    };
    let shadow_item = ShadowQueueItem {
        id: queued.id,
        action: queued.action,
        queued_at: queued.queued_at,
        eta: queued.eta,
        expires_at: queued.expires_at,
        active: true,
    };

    let trace = h.build_failure_trace(
        "local-fault-fixture",
        7,
        "EARLY_UNREVIEWED_EXPANSION",
        Some(ActorSlot::Admin1),
        Some(&shadow_item),
        None,
        StdString::from("simulated early expansion before eta"),
    );

    let formatted = trace.format_line();
    let expected_xdr = encode_action_xdr_hex(&h.env, &payload);
    assert!(expected_xdr.len() > 20);
    assert!(formatted.contains(&format!("timestamp={}", h.env.ledger().timestamp())));
    assert!(formatted.contains(&format!("ledger={}", h.env.ledger().sequence())));
    assert!(formatted
        .contains("window={id=42,queued_at=1700050000,eta=1700053600,expires_at=1700658400}"));
    assert!(formatted.contains("RaiseTokenFlowLimit"));
    assert!(formatted.contains(&h.token_id.to_string().to_string()));
    assert!(formatted.contains(&format!("action_xdr={expected_xdr}")));
    let _ = &h.rail_id;
}
