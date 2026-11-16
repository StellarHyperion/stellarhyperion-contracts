//! Adversarial replay-identity collision corpus for `HyperionRouter` inbound replay storage.

extern crate std;

use std::format;
use std::string::String as StdString;
use std::vec::Vec as StdVec;

use hyperion_core::cctp::{CctpMessage, MSG_BODY};
use hyperion_core::{
    AddressKind, HyperionError, Origin, Recipient, RouteKind, DEFAULT_FLOW_WINDOW_LEDGERS,
    STELLAR_DECIMALS,
};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype,
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, String, Symbol,
};

use super::doubles::{all_routes, FailableToken, FailableTokenClient};
use super::setup::{FEE_BPS, FLOW_LIMIT};
use crate::timelock::MIN_TIMELOCK_DELAY;
use crate::types::AdminAction;
use crate::{HyperionRouter, HyperionRouterClient};

const PER_DELIVERY: i128 = 10_000_000;

#[contracttype]
#[derive(Clone)]
enum FullWidthRailKey {
    Router,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct FullWidthDelivery {
    pub route: RouteKind,
    pub token: Address,
    pub amount: i128,
    pub recipient: Address,
    pub recipient_kind: AddressKind,
    pub source_chain: String,
    pub display_nonce: u64,
    pub message_id: BytesN<32>,
}

/// Test rail receiver that forwards an explicit 32-byte `Origin.message_id` decoupled from the
/// shortened 64-bit `Origin.nonce`, matching real CCTP, Axelar, and Allbridge inbound adapters.
#[contract]
pub struct FullWidthRail;

#[contractimpl]
impl FullWidthRail {
    pub fn init(env: Env, router: Address) {
        env.storage()
            .instance()
            .set(&FullWidthRailKey::Router, &router);
    }

    pub fn deliver(env: Env, delivery: FullWidthDelivery) -> Result<u64, HyperionError> {
        let router: Address = env
            .storage()
            .instance()
            .get(&FullWidthRailKey::Router)
            .expect("router configured");
        let this = env.current_contract_address();

        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: delivery.token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (this.clone(), router.clone(), delivery.amount).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        let outcome = HyperionRouterClient::new(&env, &router).try_bridge_in(
            &this,
            &delivery.route,
            &delivery.token,
            &delivery.amount,
            &Recipient {
                address: delivery.recipient,
                kind: delivery.recipient_kind,
                raw: Bytes::new(&env),
            },
            &Origin {
                chain: delivery.source_chain,
                nonce: delivery.display_nonce,
                message_id: delivery.message_id,
                sender: BytesN::from_array(&env, &[0x11u8; 32]),
            },
        );

        match outcome {
            Ok(Ok(claim_id)) => Ok(claim_id),
            Err(Ok(err)) => Err(err),
            _ => panic!("unexpected host error during full-width delivery"),
        }
    }
}

#[derive(Clone, Debug)]
struct CorpusVectorSpec {
    case_id: StdString,
    family: &'static str,
    route: RouteKind,
    source_chain: &'static str,
    message_id: [u8; 32],
    display_nonce: u64,
}

#[derive(Clone, Debug)]
struct CorpusDecisionLog {
    step: usize,
    case_id: StdString,
    family: &'static str,
    probe: &'static str,
    route: RouteKind,
    message_id: [u8; 32],
    display_nonce: u64,
    accepted: bool,
    error: Option<HyperionError>,
}

fn hex_encode_32(bytes: &[u8; 32]) -> StdString {
    let mut out = StdString::with_capacity(66);
    out.push_str("0x");
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn hex_decode_32(hex: &str) -> [u8; 32] {
    let body = hex.strip_prefix("0x").expect("0x prefix required");
    assert_eq!(body.len(), 64, "expected 64 hex chars for 32-byte ID");
    let mut out = [0u8; 32];
    for (idx, slot) in out.iter_mut().enumerate() {
        let slice = &body[idx * 2..idx * 2 + 2];
        *slot = u8::from_str_radix(slice, 16).expect("valid hex byte");
    }
    out
}

fn low_u64_tail(bytes: &[u8; 32]) -> u64 {
    let mut tail = [0u8; 8];
    tail.copy_from_slice(&bytes[24..32]);
    u64::from_be_bytes(tail)
}

fn axelar_xdr_replay_id(env: &Env, raw_chain: &str, raw_message_id: &str) -> [u8; 32] {
    let chain = String::from_str(env, raw_chain);
    let msg = String::from_str(env, raw_message_id);
    let digest: BytesN<32> = env.crypto().keccak256(&(chain, msg).to_xdr(env)).into();
    digest.to_array()
}

fn build_collision_corpus(env: &Env) -> StdVec<CorpusVectorSpec> {
    let mut out = StdVec::new();

    // 1. Shared 8-byte display prefix AND shared 8-byte shortened u64 tail; interior bytes[8..24] differ.
    let shared_prefix: [u8; 8] = [0x48, 0x59, 0x50, 0x52, 0x20, 0x26, 0x11, 0x16];
    let shared_tail = 0x0000_0000_00c0_ffee_u64.to_be_bytes();
    let interiors: [(&str, u64, u64); 3] = [
        ("prefix8-interior-a", 1, 0),
        ("prefix8-interior-b", 1, 1),
        ("prefix8-interior-c", 1u64 << 63, 0),
    ];
    for (name, hi, lo) in interiors {
        let mut id = [0u8; 32];
        id[0..8].copy_from_slice(&shared_prefix);
        id[8..16].copy_from_slice(&hi.to_be_bytes());
        id[16..24].copy_from_slice(&lo.to_be_bytes());
        id[24..32].copy_from_slice(&shared_tail);
        out.push(CorpusVectorSpec {
            case_id: StdString::from(name),
            family: "shared-display-prefix-8b",
            route: RouteKind::Cctp,
            source_chain: "ethereum",
            message_id: id,
            display_nonce: low_u64_tail(&id),
        });
    }

    // 2. Shared shortened u64 nonce across CCTP and Allbridge 256-bit IDs.
    let common_short: u64 = 42_000_000_777;
    let epoch_cases: [(&str, RouteKind, &str, u64); 4] = [
        ("short-cctp-1", RouteKind::Cctp, "base", 0x0001_0000_0001),
        ("short-cctp-2", RouteKind::Cctp, "base", 0x0001_0000_0002),
        (
            "short-allbridge-1",
            RouteKind::Allbridge,
            "arbitrum",
            0x00ab_0000_0001,
        ),
        (
            "short-allbridge-2",
            RouteKind::Allbridge,
            "arbitrum",
            0x00ab_0000_0002,
        ),
    ];
    for (name, route, chain, hi) in epoch_cases {
        let mut id = [0u8; 32];
        id[0..8].copy_from_slice(&hi.to_be_bytes());
        id[24..32].copy_from_slice(&common_short.to_be_bytes());
        out.push(CorpusVectorSpec {
            case_id: StdString::from(name),
            family: "shared-shortened-u64-nonce",
            route,
            source_chain: chain,
            message_id: id,
            display_nonce: low_u64_tail(&id),
        });
    }

    // 3. Zero vs non-zero high 192-bit prefix with identical 2^53 + 1 low u64 nonce.
    let wide_js_nonce: u64 = 9_007_199_254_740_993;
    for (name, high_byte_idx, mask) in [
        ("highword-zero", None, 0u8),
        ("highword-byte23-lsb", Some(23usize), 0x01u8),
        ("highword-byte0-msb", Some(0usize), 0x80u8),
    ] {
        let mut id = [0u8; 32];
        if let Some(idx) = high_byte_idx {
            id[idx] = mask;
        }
        id[24..32].copy_from_slice(&wide_js_nonce.to_be_bytes());
        out.push(CorpusVectorSpec {
            case_id: StdString::from(name),
            family: "zero-vs-nonzero-high-word",
            route: RouteKind::Cctp,
            source_chain: "optimism",
            message_id: id,
            display_nonce: low_u64_tail(&id),
        });
    }

    // 4. Single-bit Hamming neighbors across leading, interior, boundary, and trailing bytes.
    let mut base_digest = [0u8; 32];
    for (i, b) in base_digest.iter_mut().enumerate() {
        *b = ((i * 17 + 0x23) & 0xff) as u8;
    }
    out.push(CorpusVectorSpec {
        case_id: StdString::from("hamming-base"),
        family: "single-bit-hamming-neighbor",
        route: RouteKind::AxelarIts,
        source_chain: "ethereum",
        message_id: base_digest,
        display_nonce: low_u64_tail(&base_digest),
    });
    for (label, idx, bit) in [
        ("hamming-byte0-msb", 0usize, 0x80u8),
        ("hamming-byte7-lsb", 7usize, 0x01u8),
        ("hamming-byte15-mid", 15usize, 0x08u8),
        ("hamming-byte23-lsb", 23usize, 0x01u8),
        ("hamming-byte24-msb", 24usize, 0x80u8),
        ("hamming-byte31-lsb", 31usize, 0x01u8),
    ] {
        let mut neighbor = base_digest;
        neighbor[idx] ^= bit;
        out.push(CorpusVectorSpec {
            case_id: StdString::from(label),
            family: "single-bit-hamming-neighbor",
            route: RouteKind::AxelarIts,
            source_chain: "ethereum",
            message_id: neighbor,
            display_nonce: low_u64_tail(&neighbor),
        });
    }

    // 5. Axelar `(source_chain, message_id)` XDR boundary-shift pairs sharing identical note.nonce.
    for (label, raw_chain, raw_msg) in [
        ("axelar-xdr-eth-a", "eth", "ereum-tx-42"),
        ("axelar-xdr-eth-b", "ethereum", "-tx-42"),
        ("axelar-xdr-arb-a", "arbitrum", "10"),
        ("axelar-xdr-arb-b", "arbitrum1", "0"),
        ("axelar-xdr-empty-a", "base", ""),
        ("axelar-xdr-empty-b", "", "base"),
    ] {
        let id = axelar_xdr_replay_id(env, raw_chain, raw_msg);
        out.push(CorpusVectorSpec {
            case_id: StdString::from(label),
            family: "axelar-xdr-boundary-shift",
            route: RouteKind::AxelarGmp,
            source_chain: "ethereum",
            message_id: id,
            display_nonce: 777,
        });
    }

    // 6. Cross-route shared 32-byte message_id across every supported route.
    let mut shared_cross_route = [0u8; 32];
    for (i, b) in shared_cross_route.iter_mut().enumerate() {
        *b = (0xa0 + i) as u8;
    }
    for (route, slug) in [
        (RouteKind::Cctp, "cctp"),
        (RouteKind::AxelarIts, "axelar-its"),
        (RouteKind::AxelarGmp, "axelar-gmp"),
        (RouteKind::Allbridge, "allbridge"),
    ] {
        out.push(CorpusVectorSpec {
            case_id: format!("cross-route-{slug}"),
            family: "cross-route-shared-id",
            route,
            source_chain: "ethereum",
            message_id: shared_cross_route,
            display_nonce: low_u64_tail(&shared_cross_route),
        });
    }

    out
}

fn format_corpus_report(logs: &[CorpusDecisionLog]) -> StdString {
    let mut lines = StdVec::with_capacity(logs.len() + 1);
    lines.push(format!("decisions={}", logs.len()));
    for entry in logs {
        lines.push(format!(
            "step={} case={} probe={} family={} route={:?} message_id={} display_nonce={} accepted={} err={:?}",
            entry.step,
            entry.case_id,
            entry.probe,
            entry.family,
            entry.route,
            hex_encode_32(&entry.message_id),
            entry.display_nonce,
            entry.accepted,
            entry.error
        ));
    }
    lines.join("\n")
}

struct ReplayCorpusWorld {
    env: Env,
    router_id: Address,
    rail_id: Address,
    token_id: Address,
    admin: Address,
    recipient: Address,
    blocked_recipient: Address,
    settler: Address,
}

impl ReplayCorpusWorld {
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

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let treasury = Address::generate(&env);
        let recipient = Address::generate(&env);
        let blocked_recipient = Address::generate(&env);
        let settler = Address::generate(&env);

        let router_id = env.register(HyperionRouter, ());
        let rail_id = env.register(FullWidthRail, ());
        let token_id = env.register(FailableToken, ());

        FailableTokenClient::new(&env, &token_id).init(&STELLAR_DECIMALS);
        FailableTokenClient::new(&env, &token_id).set_blocked(&blocked_recipient, &true);
        FullWidthRailClient::new(&env, &rail_id).init(&router_id);

        let router = HyperionRouterClient::new(&env, &router_id);
        router.initialize(
            &admin,
            &guardian,
            &treasury,
            &FEE_BPS,
            &DEFAULT_FLOW_WINDOW_LEDGERS,
            &MIN_TIMELOCK_DELAY,
        );

        let run_timelocked = |action: AdminAction| {
            let id = router.queue_action(&admin, &action);
            env.ledger().with_mut(|li| {
                li.timestamp += MIN_TIMELOCK_DELAY + 1;
            });
            router.execute_action(&admin, &id);
        };

        for route in all_routes() {
            run_timelocked(AdminAction::SetAdapter(route, rail_id.clone()));
            run_timelocked(AdminAction::SetRailReceiver(route, rail_id.clone()));
            run_timelocked(AdminAction::EnableRoute(route));
        }
        run_timelocked(AdminAction::RegisterToken(
            token_id.clone(),
            STELLAR_DECIMALS,
            FLOW_LIMIT,
        ));

        Self {
            env,
            router_id,
            rail_id,
            token_id,
            admin,
            recipient,
            blocked_recipient,
            settler,
        }
    }

    fn router(&self) -> HyperionRouterClient<'_> {
        HyperionRouterClient::new(&self.env, &self.router_id)
    }

    fn rail(&self) -> FullWidthRailClient<'_> {
        FullWidthRailClient::new(&self.env, &self.rail_id)
    }

    fn token(&self) -> FailableTokenClient<'_> {
        FailableTokenClient::new(&self.env, &self.token_id)
    }
}

#[test]
fn distinct_full_width_ids_sharing_display_prefixes_and_shortened_nonces_never_merge_claims() {
    let world = ReplayCorpusWorld::new();
    let corpus = build_collision_corpus(&world.env);
    let prefix_family: StdVec<&CorpusVectorSpec> = corpus
        .iter()
        .filter(|v| v.family == "shared-display-prefix-8b")
        .collect();
    assert_eq!(prefix_family.len(), 3);

    // Confirm CctpMessage::display_nonce produces identical u64 values for all three colliding IDs.
    let mut header_a = [0u8; MSG_BODY as usize];
    header_a[12..44].copy_from_slice(&prefix_family[0].message_id);
    let mut header_b = [0u8; MSG_BODY as usize];
    header_b[12..44].copy_from_slice(&prefix_family[1].message_id);
    let parsed_a =
        CctpMessage::parse(&world.env, &Bytes::from_array(&world.env, &header_a)).unwrap();
    let parsed_b =
        CctpMessage::parse(&world.env, &Bytes::from_array(&world.env, &header_b)).unwrap();
    assert_eq!(parsed_a.display_nonce(), parsed_b.display_nonce());
    assert_eq!(
        &prefix_family[0].message_id[0..8],
        &prefix_family[1].message_id[0..8]
    );
    assert_ne!(parsed_a.nonce, parsed_b.nonce);

    world.token().mint(
        &world.rail_id,
        &(PER_DELIVERY * (prefix_family.len() as i128)),
    );

    // Park all three colliding-prefix/colliding-short-nonce deliveries into PendingClaim storage.
    for (idx, spec) in prefix_family.iter().enumerate() {
        let msg_id = BytesN::from_array(&world.env, &spec.message_id);
        assert!(!world.router().was_processed(&spec.route, &msg_id));

        let claim_id = world.rail().deliver(&FullWidthDelivery {
            route: spec.route,
            token: world.token_id.clone(),
            amount: PER_DELIVERY,
            recipient: world.blocked_recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: String::from_str(&world.env, spec.source_chain),
            display_nonce: spec.display_nonce,
            message_id: msg_id.clone(),
        });
        assert_eq!(claim_id, (idx + 1) as u64);
        assert!(world.router().was_processed(&spec.route, &msg_id));

        let stored = world.router().get_claim(&claim_id);
        assert_eq!(stored.source_nonce, spec.display_nonce);
        assert_eq!(stored.amount, PER_DELIVERY);
        assert!(!stored.settled);
    }

    assert_eq!(
        world.token().balance(&world.router_id),
        PER_DELIVERY * (prefix_family.len() as i128)
    );

    // Unblock recipient and settle each claim independently without cross-claim interference.
    world.token().set_blocked(&world.blocked_recipient, &false);
    for claim_id in 1..=(prefix_family.len() as u64) {
        world.router().settle_claim(&world.settler, &claim_id);
    }
    assert_eq!(
        world.token().balance(&world.blocked_recipient),
        PER_DELIVERY * (prefix_family.len() as i128)
    );
    assert_eq!(world.token().balance(&world.router_id), 0);
    let _ = &world.admin;
}

#[test]
fn exact_route_scoped_replays_reject_while_reports_preserve_all_32_identifier_bytes() {
    let world = ReplayCorpusWorld::new();
    let corpus = build_collision_corpus(&world.env);
    assert_eq!(corpus.len(), 27);

    // Fund enough tokens to cover every initial delivery plus extra headroom to detect accidental replay pulls.
    let funded = PER_DELIVERY * ((corpus.len() as i128) + 5);
    world.token().mint(&world.rail_id, &funded);

    let mut logs = StdVec::new();

    // Phase 1: Every distinct `(route, full 32-byte message_id)` vector must succeed without collision.
    for spec in &corpus {
        let msg_id = BytesN::from_array(&world.env, &spec.message_id);
        assert!(
            !world.router().was_processed(&spec.route, &msg_id),
            "distinct case {} was unexpectedly marked processed before delivery",
            spec.case_id
        );

        let res = world.rail().try_deliver(&FullWidthDelivery {
            route: spec.route,
            token: world.token_id.clone(),
            amount: PER_DELIVERY,
            recipient: world.recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: String::from_str(&world.env, spec.source_chain),
            display_nonce: spec.display_nonce,
            message_id: msg_id.clone(),
        });
        assert_eq!(
            res,
            Ok(Ok(0u64)),
            "distinct case {} failed on first delivery",
            spec.case_id
        );
        assert!(world.router().was_processed(&spec.route, &msg_id));

        logs.push(CorpusDecisionLog {
            step: logs.len() + 1,
            case_id: spec.case_id.clone(),
            family: spec.family,
            probe: "initial",
            route: spec.route,
            message_id: spec.message_id,
            display_nonce: spec.display_nonce,
            accepted: true,
            error: None,
        });
    }

    let recipient_after_initial = world.token().balance(&world.recipient);
    assert_eq!(
        recipient_after_initial,
        PER_DELIVERY * (corpus.len() as i128)
    );

    // Phase 2: Replaying every exact `(route, message_id)` must reject with ReplayedMessage and move zero tokens.
    for spec in &corpus {
        let msg_id = BytesN::from_array(&world.env, &spec.message_id);
        let res = world.rail().try_deliver(&FullWidthDelivery {
            route: spec.route,
            token: world.token_id.clone(),
            amount: PER_DELIVERY,
            recipient: world.recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: String::from_str(&world.env, spec.source_chain),
            display_nonce: spec.display_nonce,
            message_id: msg_id.clone(),
        });
        assert_eq!(
            res,
            Err(Ok(HyperionError::ReplayedMessage)),
            "exact replay for {} was not rejected with ReplayedMessage",
            spec.case_id
        );
        assert!(world.router().was_processed(&spec.route, &msg_id));

        logs.push(CorpusDecisionLog {
            step: logs.len() + 1,
            case_id: spec.case_id.clone(),
            family: spec.family,
            probe: "replay",
            route: spec.route,
            message_id: spec.message_id,
            display_nonce: spec.display_nonce,
            accepted: false,
            error: Some(HyperionError::ReplayedMessage),
        });
    }

    assert_eq!(
        world.token().balance(&world.recipient),
        recipient_after_initial
    );
    assert_eq!(world.token().balance(&world.router_id), 0);

    // Verify full 32-byte preservation across every line of the harness report.
    let report = format_corpus_report(&logs);
    assert!(report.contains("decisions=54"));
    assert!(!report.contains("..."));
    for spec in &corpus {
        let full_hex = hex_encode_32(&spec.message_id);
        assert_eq!(full_hex.len(), 66);
        assert!(
            report.contains(&format!("message_id={full_hex}")),
            "report truncated or omitted full 32-byte ID for {}",
            spec.case_id
        );
        assert_eq!(hex_decode_32(&full_hex), spec.message_id);
    }
}
