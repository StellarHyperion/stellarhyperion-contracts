//! Contract-interface capability regression snapshot and live callability tests.

extern crate std;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::string::{String as StdString, ToString};
use std::vec::Vec as StdVec;

use hyperion_core::{HyperionError, RouteKind, STELLAR_DECIMALS};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, testutils::Address as _, token, Address,
    BytesN, Env, String,
};

use super::doubles::evm_destination;
use super::setup::{World, EVM_DECIMALS, FLOW_LIMIT, HUNDRED};
use crate::types::{AdminAction, Destination, OutboundRequest};

// ---------------------------------------------------------------------------
// Minimal deterministic JSON reader for committed capability snapshots
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum JsonVal {
    Null,
    Bool(bool),
    Num(i64),
    Str(StdString),
    Arr(StdVec<JsonVal>),
    Obj(BTreeMap<StdString, JsonVal>),
}

impl JsonVal {
    fn as_str(&self) -> Option<&str> {
        match self {
            JsonVal::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    fn as_bool(&self) -> Option<bool> {
        match self {
            JsonVal::Bool(b) => Some(*b),
            _ => None,
        }
    }

    fn as_arr(&self) -> Option<&[JsonVal]> {
        match self {
            JsonVal::Arr(items) => Some(items.as_slice()),
            _ => None,
        }
    }

    fn as_obj(&self) -> Option<&BTreeMap<StdString, JsonVal>> {
        match self {
            JsonVal::Obj(map) => Some(map),
            _ => None,
        }
    }
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> JsonParser<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            bytes: src.as_bytes(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn parse_value(&mut self) -> JsonVal {
        self.skip_ws();
        match self.bytes[self.pos] {
            b'"' => JsonVal::Str(self.parse_string()),
            b'{' => self.parse_object(),
            b'[' => self.parse_array(),
            b't' => {
                assert_eq!(&self.bytes[self.pos..self.pos + 4], b"true");
                self.pos += 4;
                JsonVal::Bool(true)
            }
            b'f' => {
                assert_eq!(&self.bytes[self.pos..self.pos + 5], b"false");
                self.pos += 5;
                JsonVal::Bool(false)
            }
            b'n' => {
                assert_eq!(&self.bytes[self.pos..self.pos + 4], b"null");
                self.pos += 4;
                JsonVal::Null
            }
            _ => self.parse_number(),
        }
    }

    fn parse_string(&mut self) -> StdString {
        assert_eq!(self.bytes[self.pos], b'"');
        self.pos += 1;
        let mut out = StdString::new();
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            self.pos += 1;
            if b == b'"' {
                return out;
            }
            if b == b'\\' {
                let esc = self.bytes[self.pos];
                self.pos += 1;
                match esc {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    other => out.push(other as char),
                }
            } else {
                out.push(b as char);
            }
        }
        panic!("unterminated JSON string");
    }

    fn parse_number(&mut self) -> JsonVal {
        let start = self.pos;
        if self.bytes[self.pos] == b'-' {
            self.pos += 1;
        }
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_digit() {
            self.pos += 1;
        }
        let s = core::str::from_utf8(&self.bytes[start..self.pos]).unwrap();
        JsonVal::Num(s.parse::<i64>().unwrap())
    }

    fn parse_array(&mut self) -> JsonVal {
        assert_eq!(self.bytes[self.pos], b'[');
        self.pos += 1;
        let mut items = StdVec::new();
        self.skip_ws();
        if self.bytes[self.pos] == b']' {
            self.pos += 1;
            return JsonVal::Arr(items);
        }
        loop {
            items.push(self.parse_value());
            self.skip_ws();
            if self.bytes[self.pos] == b',' {
                self.pos += 1;
            } else {
                assert_eq!(self.bytes[self.pos], b']');
                self.pos += 1;
                break;
            }
        }
        JsonVal::Arr(items)
    }

    fn parse_object(&mut self) -> JsonVal {
        assert_eq!(self.bytes[self.pos], b'{');
        self.pos += 1;
        let mut map = BTreeMap::new();
        self.skip_ws();
        if self.bytes[self.pos] == b'}' {
            self.pos += 1;
            return JsonVal::Obj(map);
        }
        loop {
            self.skip_ws();
            let key = self.parse_string();
            self.skip_ws();
            assert_eq!(self.bytes[self.pos], b':');
            self.pos += 1;
            let val = self.parse_value();
            map.insert(key, val);
            self.skip_ws();
            if self.bytes[self.pos] == b',' {
                self.pos += 1;
            } else {
                assert_eq!(self.bytes[self.pos], b'}');
                self.pos += 1;
                break;
            }
        }
        JsonVal::Obj(map)
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("canonical repo root")
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct MethodEntry {
    name: StdString,
    signature: StdString,
    paid: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ContractSnapshot {
    contract_name: StdString,
    surface_kind: StdString,
    stack: StdString,
    source_ref: StdString,
    deployment_status: StdString,
    supported_routes: StdVec<StdString>,
    paid_routes: StdVec<StdString>,
    methods: StdVec<MethodEntry>,
}

fn parse_snapshot_file(rel_path: &str) -> (StdString, StdVec<ContractSnapshot>) {
    let raw = fs::read_to_string(repo_root().join(rel_path)).expect("read snapshot json");
    let mut parser = JsonParser::new(&raw);
    let root = parser.parse_value();
    let obj = root.as_obj().expect("root object");
    let surface_kind = obj
        .get("surfaceKind")
        .and_then(JsonVal::as_str)
        .expect("surfaceKind")
        .to_string();
    let contracts_json = obj
        .get("contracts")
        .and_then(JsonVal::as_arr)
        .expect("contracts array");

    let mut contracts = StdVec::new();
    for item in contracts_json {
        let c = item.as_obj().expect("contract object");
        let methods = c
            .get("methods")
            .and_then(JsonVal::as_arr)
            .expect("methods array")
            .iter()
            .map(|m| {
                let mo = m.as_obj().expect("method object");
                MethodEntry {
                    name: mo
                        .get("name")
                        .and_then(JsonVal::as_str)
                        .unwrap()
                        .to_string(),
                    signature: mo
                        .get("signature")
                        .and_then(JsonVal::as_str)
                        .unwrap()
                        .to_string(),
                    paid: mo.get("paid").and_then(JsonVal::as_bool).unwrap(),
                }
            })
            .collect();
        let str_list = |field: &str| -> StdVec<StdString> {
            c.get(field)
                .and_then(JsonVal::as_arr)
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect()
        };
        contracts.push(ContractSnapshot {
            contract_name: c
                .get("contractName")
                .and_then(JsonVal::as_str)
                .unwrap()
                .to_string(),
            surface_kind: c
                .get("surfaceKind")
                .and_then(JsonVal::as_str)
                .unwrap()
                .to_string(),
            stack: c
                .get("stack")
                .and_then(JsonVal::as_str)
                .unwrap()
                .to_string(),
            source_ref: c
                .get("sourceRef")
                .and_then(JsonVal::as_str)
                .unwrap()
                .to_string(),
            deployment_status: c
                .get("deploymentStatus")
                .and_then(JsonVal::as_str)
                .unwrap()
                .to_string(),
            supported_routes: str_list("supportedRoutes"),
            paid_routes: str_list("paidRoutes"),
            methods,
        });
    }
    (surface_kind, contracts)
}

// ---------------------------------------------------------------------------
// Live Soroban `#[contractimpl]` signature extractor & evolution checker
// ---------------------------------------------------------------------------

fn normalize_ws(input: &str) -> StdString {
    input.split_whitespace().collect::<StdVec<_>>().join(" ")
}

fn split_top_level_commas(input: &str) -> StdVec<StdString> {
    let mut parts = StdVec::new();
    let mut angle = 0usize;
    let mut paren = 0usize;
    let mut start = 0usize;
    for (idx, ch) in input.char_indices() {
        match ch {
            '<' => angle += 1,
            '>' => angle = angle.saturating_sub(1),
            '(' => paren += 1,
            ')' => paren = paren.saturating_sub(1),
            ',' if angle == 0 && paren == 0 => {
                let piece = input[start..idx].trim();
                if !piece.is_empty() {
                    parts.push(piece.to_string());
                }
                start = idx + 1;
            }
            _ => {}
        }
    }
    let tail = input[start..].trim();
    if !tail.is_empty() {
        parts.push(tail.to_string());
    }
    parts
}

fn soroban_paid_methods(contract_name: &str) -> BTreeSet<&'static str> {
    match contract_name {
        "HyperionRouter" => ["bridge_out_with_gas", "supports_paid_route"]
            .into_iter()
            .collect(),
        "CctpAdapter" => ["dispatch_from", "quote_max_fee"].into_iter().collect(),
        "AxelarAdapter" => ["dispatch_from", "gas_token"].into_iter().collect(),
        "AllbridgeAdapter" => ["fund_gas", "gas_balance", "quote_gas"]
            .into_iter()
            .collect(),
        _ => BTreeSet::new(),
    }
}

fn extract_soroban_methods(contract_name: &str, rust_source: &str) -> StdVec<MethodEntry> {
    let start_idx = rust_source.find("#[contractimpl]").unwrap_or(0);
    let body = &rust_source[start_idx..];
    let paid_set = soroban_paid_methods(contract_name);
    let mut out = StdVec::new();
    let mut cursor = 0usize;

    while let Some(rel) = body[cursor..].find("pub fn ") {
        let fn_start = cursor + rel;
        let name_start = fn_start + "pub fn ".len();
        let Some(open_rel) = body[name_start..].find('(') else {
            break;
        };
        let name = body[name_start..name_start + open_rel].trim();
        let params_start = name_start + open_rel + 1;
        let mut depth = 1usize;
        let mut close_paren = params_start;
        for (idx, ch) in body[params_start..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close_paren = params_start + idx;
                        break;
                    }
                }
                _ => {}
            }
        }
        let raw_params = split_top_level_commas(&body[params_start..close_paren]);
        let param_types: StdVec<StdString> = raw_params
            .into_iter()
            .filter(|p| {
                let trimmed = p.trim();
                !trimmed.starts_with("env:")
                    && !trimmed.starts_with("_env:")
                    && !trimmed.starts_with("env :")
                    && !trimmed.starts_with("_env :")
            })
            .map(|p| match p.find(':') {
                Some(colon) => normalize_ws(&p[colon + 1..]),
                None => normalize_ws(&p),
            })
            .collect();

        let after_paren = close_paren + 1;
        let brace_pos = after_paren + body[after_paren..].find('{').expect("fn body brace");
        let ret_segment = body[after_paren..brace_pos].trim();
        let ret_ty = if let Some(stripped) = ret_segment.strip_prefix("->") {
            normalize_ws(stripped)
        } else {
            "()".to_string()
        };
        let signature = std::format!("{}({}) -> {}", name, param_types.join(", "), ret_ty);
        out.push(MethodEntry {
            name: name.to_string(),
            signature,
            paid: paid_set.contains(name),
        });
        cursor = brace_pos + 1;
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[derive(Clone, Debug)]
struct PaidCompatibilityAck {
    contract_name: StdString,
    target: StdString,
    acknowledge_paid_removal: bool,
    reason: StdString,
    consumer_migration: StdString,
    reference: StdString,
}

fn check_soroban_upgrade_evolution(
    baseline: &ContractSnapshot,
    proposed: &ContractSnapshot,
    acks: &[PaidCompatibilityAck],
) -> StdVec<StdString> {
    let mut violations = StdVec::new();
    let find_ack = |target: &str| -> Option<&PaidCompatibilityAck> {
        acks.iter().find(|a| {
            a.contract_name == baseline.contract_name
                && a.target == target
                && !a.reason.trim().is_empty()
                && !a.consumer_migration.trim().is_empty()
                && !a.reference.trim().is_empty()
        })
    };

    for base_m in &baseline.methods {
        match proposed.methods.iter().find(|m| m.name == base_m.name) {
            None => {
                let ack = find_ack(&base_m.name);
                if base_m.paid {
                    if !ack.map(|a| a.acknowledge_paid_removal).unwrap_or(false) {
                        violations.push(std::format!(
                            "paid-method-removed-without-ack:{}:{}",
                            baseline.contract_name,
                            base_m.name
                        ));
                    }
                } else if ack.is_none() {
                    violations.push(std::format!(
                        "method-removed-without-ack:{}:{}",
                        baseline.contract_name,
                        base_m.name
                    ));
                }
            }
            Some(next_m) => {
                if base_m.paid && !next_m.paid {
                    let ack = find_ack(&base_m.name);
                    if !ack.map(|a| a.acknowledge_paid_removal).unwrap_or(false) {
                        violations.push(std::format!(
                            "paid-method-removed-without-ack:{}:{}",
                            baseline.contract_name,
                            base_m.name
                        ));
                    }
                } else if base_m.signature != next_m.signature && find_ack(&base_m.name).is_none() {
                    violations.push(std::format!(
                        "method-signature-changed:{}:{}",
                        baseline.contract_name,
                        base_m.name
                    ));
                }
            }
        }
    }

    for paid_route in &baseline.paid_routes {
        if !proposed.paid_routes.contains(paid_route) {
            let target = std::format!("paidRoute:{}", paid_route);
            let ack = find_ack(&target);
            if !ack.map(|a| a.acknowledge_paid_removal).unwrap_or(false) {
                violations.push(std::format!(
                    "paid-route-removed-without-ack:{}:{}",
                    baseline.contract_name,
                    paid_route
                ));
            }
        }
    }

    violations
}

// ---------------------------------------------------------------------------
// Local callable paid rail mock for verifying advertised capabilities
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum PaidMockKey {
    Router,
    GasToken,
    PaidCount,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PaidMockError {
    NotRouter = 1,
}

#[contract]
pub struct MockPaidRail;

#[contractimpl]
impl MockPaidRail {
    pub fn init(env: Env, router: Address, gas_token: Address) {
        env.storage().instance().set(&PaidMockKey::Router, &router);
        env.storage()
            .instance()
            .set(&PaidMockKey::GasToken, &gas_token);
    }

    pub fn gas_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&PaidMockKey::GasToken)
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
    ) -> Result<(), PaidMockError> {
        caller.require_auth();
        let router: Address = env.storage().instance().get(&PaidMockKey::Router).unwrap();
        if caller != router {
            return Err(PaidMockError::NotRouter);
        }
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
    ) -> Result<(), PaidMockError> {
        caller.require_auth();
        let router: Address = env.storage().instance().get(&PaidMockKey::Router).unwrap();
        if caller != router {
            return Err(PaidMockError::NotRouter);
        }
        let this = env.current_contract_address();
        token::Client::new(&env, &token).transfer(&sender, &this, &amount);
        let gas_tok: Address = env
            .storage()
            .instance()
            .get(&PaidMockKey::GasToken)
            .unwrap();
        token::Client::new(&env, &gas_tok).transfer(&sender, &this, &gas_amount);
        let count: u32 = env
            .storage()
            .instance()
            .get(&PaidMockKey::PaidCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&PaidMockKey::PaidCount, &(count + 1));
        Ok(())
    }

    pub fn paid_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&PaidMockKey::PaidCount)
            .unwrap_or(0)
    }
}

fn route_from_name(name: &str) -> RouteKind {
    match name {
        "Cctp" => RouteKind::Cctp,
        "AxelarIts" => RouteKind::AxelarIts,
        "AxelarGmp" => RouteKind::AxelarGmp,
        "Allbridge" => RouteKind::Allbridge,
        other => panic!("unknown route name in snapshot: {other}"),
    }
}

#[test]
fn snapshots_separate_router_and_adapter_surfaces_and_match_live_soroban_sources() {
    let (router_kind, router_contracts) =
        parse_snapshot_file("packages/protocol/test/snapshots/router-capabilities.snapshot.json");
    let (adapter_kind, adapter_contracts) =
        parse_snapshot_file("packages/protocol/test/snapshots/adapter-capabilities.snapshot.json");

    assert_eq!(router_kind, "router");
    assert_eq!(adapter_kind, "adapter");
    assert!(router_contracts.iter().all(|c| c.surface_kind == "router"));
    assert!(adapter_contracts
        .iter()
        .all(|c| c.surface_kind == "adapter"));

    let all_soroban: StdVec<&ContractSnapshot> = router_contracts
        .iter()
        .chain(adapter_contracts.iter())
        .filter(|c| c.stack == "soroban")
        .collect();
    assert_eq!(all_soroban.len(), 4);

    for snap in all_soroban {
        let src = fs::read_to_string(repo_root().join(&snap.source_ref))
            .expect("read soroban contract source");
        let live_methods = extract_soroban_methods(&snap.contract_name, &src);
        assert_eq!(
            snap.methods, live_methods,
            "Soroban contract {} drifted from committed capability snapshot",
            snap.contract_name
        );
    }
}

#[test]
fn advertised_soroban_router_capabilities_match_callable_local_methods() {
    let (_, router_contracts) =
        parse_snapshot_file("packages/protocol/test/snapshots/router-capabilities.snapshot.json");
    let router_snap = router_contracts
        .iter()
        .find(|c| c.stack == "soroban" && c.contract_name == "HyperionRouter")
        .expect("Soroban HyperionRouter snapshot");

    assert_eq!(router_snap.deployment_status, "active-testnet-outbound");

    let w = World::bare();
    let gas_issuer = Address::generate(&w.env);
    let gas_sac = w.env.register_stellar_asset_contract_v2(gas_issuer);
    let gas_token_id = gas_sac.address();

    let paid_rail_id = w.env.register(MockPaidRail, ());
    MockPaidRailClient::new(&w.env, &paid_rail_id).init(&w.router_id, &gas_token_id);

    w.register_token(w.token_id.clone(), STELLAR_DECIMALS, FLOW_LIMIT);
    w.fund_user(HUNDRED * 20);
    token::StellarAssetClient::new(&w.env, &gas_token_id).mint(&w.user, &(HUNDRED * 5));

    for route_name in &router_snap.supported_routes {
        let route = route_from_name(route_name);
        w.run_action(AdminAction::SetAdapter(route, paid_rail_id.clone()));
        w.run_action(AdminAction::SetRailReceiver(route, paid_rail_id.clone()));
        w.run_action(AdminAction::EnableRoute(route));
        assert!(w.router().is_route_enabled(&route));
        assert_eq!(w.router().get_adapter(&route), paid_rail_id);
        assert_eq!(w.router().get_rail_receiver(&route), paid_rail_id);

        let expected_paid = router_snap.paid_routes.contains(route_name);
        assert_eq!(
            w.router().supports_paid_route(&route),
            expected_paid,
            "supports_paid_route({route_name}) must match snapshot paidRoutes"
        );

        let req = OutboundRequest {
            token: w.token_id.clone(),
            amount: HUNDRED,
            route,
            destination: Destination {
                chain: w.ethereum(),
                address: evm_destination(&w.env, 0x42),
            },
            destination_decimals: EVM_DECIMALS,
            min_destination_amount: 0,
        };

        // `gas_amount = 1_000_000` is divisible by 10 so CCTP's `net - max_fee` converts cleanly
        // from 7 Stellar decimals to 6 EVM decimals.
        let paid_outcome = w
            .router()
            .try_bridge_out_with_gas(&w.user, &req, &1_000_000);
        if expected_paid {
            assert!(
                matches!(paid_outcome, Ok(Ok(_))),
                "advertised paid route {route_name} must succeed via bridge_out_with_gas"
            );
        } else {
            assert_eq!(
                paid_outcome,
                Err(Ok(HyperionError::UnsupportedRoute)),
                "non-paid route {route_name} must reject bridge_out_with_gas with UnsupportedRoute"
            );
        }
    }

    assert_eq!(
        MockPaidRailClient::new(&w.env, &paid_rail_id).paid_count(),
        router_snap.paid_routes.len() as u32
    );

    // Verify core view and unpaid callable methods advertised in the router snapshot also respond.
    let quotes = w
        .router()
        .quote_routes(&w.token_id, &HUNDRED, &EVM_DECIMALS);
    assert_eq!(quotes.len() as usize, router_snap.supported_routes.len());
    assert_eq!(w.router().treasury(), w.treasury);
    assert_eq!(w.router().claim_count(), 0);
    assert!(w.router().last_out_nonce() >= 2);
}

#[test]
fn removing_paid_methods_or_paid_routes_requires_explicit_paid_acknowledgement() {
    let (_, router_contracts) =
        parse_snapshot_file("packages/protocol/test/snapshots/router-capabilities.snapshot.json");
    let baseline = router_contracts
        .iter()
        .find(|c| c.stack == "soroban" && c.contract_name == "HyperionRouter")
        .expect("Soroban HyperionRouter snapshot")
        .clone();

    let mut stripped = baseline.clone();
    stripped.methods.retain(|m| m.name != "bridge_out_with_gas");
    stripped.paid_routes.retain(|r| r != "Cctp");

    // 1. No acknowledgement -> fails both paid-method and paid-route checks.
    let unacked = check_soroban_upgrade_evolution(&baseline, &stripped, &[]);
    assert!(unacked
        .iter()
        .any(|v| v == "paid-method-removed-without-ack:HyperionRouter:bridge_out_with_gas"));
    assert!(unacked
        .iter()
        .any(|v| v == "paid-route-removed-without-ack:HyperionRouter:Cctp"));

    // 2. Non-paid acknowledgement (`acknowledge_paid_removal: false`) -> still rejected.
    let weak = check_soroban_upgrade_evolution(
        &baseline,
        &stripped,
        &[PaidCompatibilityAck {
            contract_name: "HyperionRouter".to_string(),
            target: "bridge_out_with_gas".to_string(),
            acknowledge_paid_removal: false,
            reason: "Attempted removal without paid flag".to_string(),
            consumer_migration: "None".to_string(),
            reference: "COMPAT-WEAK".to_string(),
        }],
    );
    assert!(weak
        .iter()
        .any(|v| v == "paid-method-removed-without-ack:HyperionRouter:bridge_out_with_gas"));

    // 3. Explicit paid acknowledgements for both targets -> passes cleanly.
    let explicit = check_soroban_upgrade_evolution(
        &baseline,
        &stripped,
        &[
            PaidCompatibilityAck {
                contract_name: "HyperionRouter".to_string(),
                target: "bridge_out_with_gas".to_string(),
                acknowledge_paid_removal: true,
                reason: "Major router interface replacement rehearsal".to_string(),
                consumer_migration: "Point SDK clients at v2 router paid entrypoint".to_string(),
                reference: "COMPAT-PAID-01".to_string(),
            },
            PaidCompatibilityAck {
                contract_name: "HyperionRouter".to_string(),
                target: "paidRoute:Cctp".to_string(),
                acknowledge_paid_removal: true,
                reason: "Temporarily retiring v1 paid CCTP lane during migration".to_string(),
                consumer_migration: "Submit paid CCTP burns through v2 router".to_string(),
                reference: "COMPAT-PAID-02".to_string(),
            },
        ],
    );
    assert!(
        explicit.is_empty(),
        "expected no violations, got {explicit:?}"
    );
}
