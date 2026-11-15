//! Bounded large-input stress fixtures and host resource measurements for Hyperion parsers.
//!
//! Covers notes (`OutboundNote`, `InboundNote`), StrKeys (`StrkeyDestination`,
//! `StellarDestination`), CCTP v2 headers/burn bodies/hooks (`CctpMessage`, `BurnMessage`,
//! `HyperionHook`), and router queued action payloads (`AdminAction`, `QueuedAction`).

extern crate std;

use std::vec::Vec as StdVec;

use hyperion_core::{
    address::{
        assert_route_supports, bytes32_to_evm, evm_to_bytes32, AddressKind, StellarDestination,
        TAGGED_LEN_MUXED, TAGGED_LEN_PLAIN,
    },
    axelar::{
        InboundNote, OutboundNote, INBOUND_NOTE_MAX_LEN, INBOUND_NOTE_MIN, INBOUND_NOTE_MUXED_LEN,
        INBOUND_NOTE_PLAIN_LEN, NOTE_VERSION, OUTBOUND_NOTE_LEN,
    },
    cctp::{
        BurnMessage, CctpMessage, HyperionHook, BURN_HOOK_DATA, BURN_MESSAGE_VERSION,
        FINALITY_THRESHOLD_FINALIZED, HOOK_LEN_MUXED, HOOK_LEN_PLAIN, HOOK_MAX_LEN, HOOK_VERSION,
        MESSAGE_VERSION, MSG_BODY, STELLAR_DOMAIN,
    },
    strkey::{
        StrkeyDestination, STRKEY_LEN_MUXED, STRKEY_LEN_PLAIN, STRKEY_WIRE_LEN_MUXED,
        STRKEY_WIRE_LEN_PLAIN,
    },
    HyperionError, RouteKind, MAX_FEE_BPS,
};
use soroban_sdk::{
    testutils::Address as _,
    xdr::{FromXdr, ToXdr},
    Address, Bytes, BytesN, Env, String,
};

use crate::test::doubles::evm_destination;
use crate::test::setup::{World, EVM_DECIMALS, HUNDRED};
use crate::types::{AdminAction, Destination, OutboundRequest, QueuedAction, RouteConfig};
use crate::{MAX_TIMELOCK_DELAY, MIN_TIMELOCK_DELAY};

const G_ADDR: &str = "GA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RLVNR";
const C_ADDR: &str = "CAGR5KFYMZYI7WWQ6TWYYZ346T7GNZLKER4DOJTAG3SOB46QLR5RAPSN";
const M_ADDR: &str = "MA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RKABAAAAAAAAAAFLXQ";

/// Oversized stress lengths spanning small trailing corruption through the 64 KiB Wasm ceiling.
const OVERSIZED_BYTES: [usize; 4] = [256, 4_096, 16_384, 65_536];

/// Conservative ceiling on Soroban CPU instructions for an early-exit O(1) parser rejection.
const EARLY_REJECT_CPU_CEILING: u64 = 50_000;
/// Conservative ceiling on Soroban host memory bytes for an early-exit O(1) parser rejection.
const EARLY_REJECT_MEM_CEILING: u64 = 1_024;

#[derive(Clone, Copy, Debug)]
struct BudgetSample {
    cpu_instructions: u64,
    memory_bytes: u64,
}

fn measure<T>(env: &Env, f: impl FnOnce() -> T) -> (T, BudgetSample) {
    env.cost_estimate().budget().reset_unlimited();
    let out = f();
    let budget = env.cost_estimate().budget();
    let sample = BudgetSample {
        cpu_instructions: budget.cpu_instruction_cost(),
        memory_bytes: budget.memory_bytes_cost(),
    };
    (out, sample)
}

fn filled_bytes(env: &Env, prefix: &[u8], total_len: usize, fill: u8) -> Bytes {
    let mut raw = StdVec::with_capacity(total_len);
    raw.extend_from_slice(prefix);
    if raw.len() < total_len {
        raw.resize(total_len, fill);
    }
    Bytes::from_slice(env, &raw)
}

fn cctp_header_bytes(source_domain: u32, destination_domain: u32, nonce_tail: u64) -> [u8; 148] {
    let mut raw = [0u8; MSG_BODY as usize];
    raw[0..4].copy_from_slice(&MESSAGE_VERSION.to_be_bytes());
    raw[4..8].copy_from_slice(&source_domain.to_be_bytes());
    raw[8..12].copy_from_slice(&destination_domain.to_be_bytes());
    raw[12..36].copy_from_slice(&[0xABu8; 24]);
    raw[36..44].copy_from_slice(&nonce_tail.to_be_bytes());
    raw[44..76].copy_from_slice(&[0xE1u8; 32]);
    raw[76..108].copy_from_slice(&[0xC1u8; 32]);
    raw[108..140].copy_from_slice(&[0xD1u8; 32]);
    raw[140..144].copy_from_slice(&FINALITY_THRESHOLD_FINALIZED.to_be_bytes());
    raw[144..148].copy_from_slice(&FINALITY_THRESHOLD_FINALIZED.to_be_bytes());
    raw
}

fn cctp_burn_prefix(
    amount: i128,
    max_fee: i128,
    fee_executed: i128,
    expiration: i128,
) -> [u8; 228] {
    let mut raw = [0u8; BURN_HOOK_DATA as usize];
    raw[0..4].copy_from_slice(&BURN_MESSAGE_VERSION.to_be_bytes());
    raw[4..36].copy_from_slice(&[0xB0u8; 32]);
    raw[36..68].copy_from_slice(&[0xA5u8; 32]);
    raw[84..100].copy_from_slice(&(amount as u128).to_be_bytes());
    raw[100..132].copy_from_slice(&[0x5Eu8; 32]);
    raw[148..164].copy_from_slice(&(max_fee as u128).to_be_bytes());
    raw[180..196].copy_from_slice(&(fee_executed as u128).to_be_bytes());
    raw[212..228].copy_from_slice(&(expiration as u128).to_be_bytes());
    raw
}

#[test]
fn valid_maximum_size_notes_strkeys_and_hooks_accept_consistently() {
    let env = Env::default();

    // 1. OutboundNote at max recipient + u64::MAX nonce (exact 29 bytes).
    let max_evm = BytesN::from_array(&env, &[0xFFu8; 20]);
    let outbound = OutboundNote::new(max_evm.clone(), u64::MAX);
    let outbound_wire = outbound.encode(&env).unwrap();
    assert_eq!(outbound_wire.len(), OUTBOUND_NOTE_LEN);
    assert_eq!(
        OutboundNote::decode(&env, &outbound_wire).unwrap(),
        outbound
    );

    // Widened 32-byte EVM word round-trip at max 20-byte address.
    let wide = evm_to_bytes32(&env, &max_evm);
    assert_eq!(bytes32_to_evm(&env, &wide).unwrap(), max_evm);

    // 2. StrkeyDestination + InboundNote across plain (56 / 58 / 67) and muxed max (69 / 71 / 80).
    for (kind, strkey, expected_chars, expected_wire, expected_note) in [
        (
            AddressKind::Account,
            G_ADDR,
            STRKEY_LEN_PLAIN,
            STRKEY_WIRE_LEN_PLAIN,
            INBOUND_NOTE_PLAIN_LEN,
        ),
        (
            AddressKind::Contract,
            C_ADDR,
            STRKEY_LEN_PLAIN,
            STRKEY_WIRE_LEN_PLAIN,
            INBOUND_NOTE_PLAIN_LEN,
        ),
        (
            AddressKind::MuxedAccount,
            M_ADDR,
            STRKEY_LEN_MUXED,
            STRKEY_WIRE_LEN_MUXED,
            INBOUND_NOTE_MUXED_LEN,
        ),
    ] {
        let dest = StrkeyDestination::new(kind, String::from_str(&env, strkey));
        dest.validate().unwrap();
        assert_eq!(dest.value.len(), expected_chars);

        let dest_wire = dest.encode(&env).unwrap();
        assert_eq!(dest_wire.len(), expected_wire);
        let decoded_dest = StrkeyDestination::decode(&env, &dest_wire).unwrap();
        assert_eq!(decoded_dest, dest);
        let _ = decoded_dest.to_address(&env).unwrap();
        let _ = decoded_dest.to_muxed(&env).unwrap();

        let note = InboundNote::new(dest, u64::MAX);
        let note_wire = note.encode(&env).unwrap();
        assert_eq!(note_wire.len(), expected_note);
        assert!(note_wire.len() <= INBOUND_NOTE_MAX_LEN);
        assert_eq!(InboundNote::decode(&env, &note_wire).unwrap(), note);
    }

    // 3. Tagged StellarDestination + HyperionHook + full CCTP v2 burn message at max fields.
    for (dest, expected_tagged, expected_hook) in [
        (
            StellarDestination::account(BytesN::from_array(&env, &[0xFEu8; 32])),
            TAGGED_LEN_PLAIN,
            HOOK_LEN_PLAIN,
        ),
        (
            StellarDestination::contract(BytesN::from_array(&env, &[0xFDu8; 32])),
            TAGGED_LEN_PLAIN,
            HOOK_LEN_PLAIN,
        ),
        (
            StellarDestination::muxed(BytesN::from_array(&env, &[0xFCu8; 32]), u64::MAX),
            TAGGED_LEN_MUXED,
            HOOK_LEN_MUXED,
        ),
    ] {
        let tagged = dest.encode(&env);
        assert_eq!(tagged.len(), expected_tagged);
        assert_eq!(StellarDestination::decode(&env, &tagged).unwrap(), dest);

        let hook = HyperionHook::new(dest.clone());
        let hook_wire = hook.encode(&env).unwrap();
        assert_eq!(hook_wire.len(), expected_hook);
        assert!(hook_wire.len() <= HOOK_MAX_LEN);
        assert_eq!(HyperionHook::decode(&env, &hook_wire).unwrap(), hook);

        // Route policy: codec parses 42-byte muxed hook cleanly, while CCTP route refuses muxed delivery.
        if dest.kind == AddressKind::MuxedAccount {
            assert_eq!(
                assert_route_supports(RouteKind::Cctp, dest.kind),
                Err(HyperionError::MuxedNotSupported)
            );
        } else {
            assert!(assert_route_supports(RouteKind::Cctp, dest.kind).is_ok());
        }

        // Full CCTP message (148 header + 228 burn body + hook) at i128::MAX numeric boundaries.
        let header_arr = cctp_header_bytes(0, STELLAR_DOMAIN, u64::MAX);
        let burn_arr = cctp_burn_prefix(i128::MAX, i128::MAX, i128::MAX, i128::MAX);
        let mut full = Bytes::from_slice(&env, &header_arr);
        full.append(&Bytes::from_slice(&env, &burn_arr));
        full.append(&hook_wire);
        assert_eq!(full.len(), MSG_BODY + BURN_HOOK_DATA + expected_hook);

        let parsed_msg = CctpMessage::parse(&env, &full).unwrap();
        assert_eq!(parsed_msg.display_nonce(), u64::MAX);
        assert!(parsed_msg.is_finalized());

        let body = CctpMessage::body(&full).unwrap();
        let parsed_burn = BurnMessage::parse(&env, &body).unwrap();
        assert_eq!(parsed_burn.amount, i128::MAX);
        assert_eq!(parsed_burn.max_fee, i128::MAX);
        assert_eq!(parsed_burn.fee_executed, i128::MAX);
        assert_eq!(parsed_burn.expiration_block, i128::MAX);

        let extracted_hook = BurnMessage::hook_data(&body).unwrap();
        assert_eq!(HyperionHook::decode(&env, &extracted_hook).unwrap(), hook);
    }
}

#[test]
fn oversized_notes_strkeys_and_hooks_terminate_with_constant_resource_use() {
    let env = Env::default();

    // Ensure boundary constants match cross-stack specification.
    assert_eq!(INBOUND_NOTE_MIN, 12);
    assert_eq!(INBOUND_NOTE_PLAIN_LEN, 67);
    assert_eq!(INBOUND_NOTE_MUXED_LEN, 80);
    assert_eq!(INBOUND_NOTE_MAX_LEN, 80);
    assert_eq!(HOOK_LEN_PLAIN, 34);
    assert_eq!(HOOK_LEN_MUXED, 42);
    assert_eq!(HOOK_MAX_LEN, 42);

    let mut inbound_samples = StdVec::new();
    let mut outbound_samples = StdVec::new();
    let mut strkey_wire_samples = StdVec::new();
    let mut strkey_val_samples = StdVec::new();
    let mut tagged_samples = StdVec::new();
    let mut hook_samples = StdVec::new();

    for size in OVERSIZED_BYTES {
        // 1. Oversized InboundNote (valid version + kind + lied/valid length byte, padded to `size`).
        let oversized_inbound = filled_bytes(
            &env,
            &[NOTE_VERSION, AddressKind::MuxedAccount.tag(), 69],
            size,
            b'A',
        );
        let (res_in, sample_in) = measure(&env, || InboundNote::decode(&env, &oversized_inbound));
        assert_eq!(res_in, Err(HyperionError::InvalidDestination));
        assert!(sample_in.cpu_instructions <= EARLY_REJECT_CPU_CEILING);
        assert!(sample_in.memory_bytes <= EARLY_REJECT_MEM_CEILING);
        inbound_samples.push(sample_in);

        // 2. Oversized OutboundNote.
        let oversized_outbound = filled_bytes(&env, &[NOTE_VERSION, 0x11], size, 0x22);
        let (res_out, sample_out) =
            measure(&env, || OutboundNote::decode(&env, &oversized_outbound));
        assert_eq!(res_out, Err(HyperionError::MalformedMessage));
        assert!(sample_out.cpu_instructions <= EARLY_REJECT_CPU_CEILING);
        assert!(sample_out.memory_bytes <= EARLY_REJECT_MEM_CEILING);
        outbound_samples.push(sample_out);

        // 3. Oversized StrkeyDestination wire bytes (`[kind][255][...]`).
        let oversized_strkey_wire =
            filled_bytes(&env, &[AddressKind::Account.tag(), 255], size, b'G');
        let (res_sw, sample_sw) = measure(&env, || {
            StrkeyDestination::decode(&env, &oversized_strkey_wire)
        });
        assert_eq!(res_sw, Err(HyperionError::InvalidDestination));
        assert!(sample_sw.cpu_instructions <= EARLY_REJECT_CPU_CEILING);
        assert!(sample_sw.memory_bytes <= EARLY_REJECT_MEM_CEILING);
        strkey_wire_samples.push(sample_sw);

        // 4. Oversized StrkeyDestination in-memory String (`validate`).
        let mut raw_ascii = StdVec::with_capacity(size);
        raw_ascii.push(b'M');
        raw_ascii.resize(size, b'A');
        let oversized_str = String::from_bytes(&env, &raw_ascii);
        let dest = StrkeyDestination::new(AddressKind::MuxedAccount, oversized_str);
        let (res_sv, sample_sv) = measure(&env, || dest.validate());
        assert_eq!(res_sv, Err(HyperionError::InvalidDestination));
        assert!(sample_sv.cpu_instructions <= EARLY_REJECT_CPU_CEILING);
        assert!(sample_sv.memory_bytes <= EARLY_REJECT_MEM_CEILING);
        strkey_val_samples.push(sample_sv);

        // 5. Oversized binary tagged StellarDestination.
        let oversized_tagged = filled_bytes(&env, &[AddressKind::MuxedAccount.tag()], size, 0x33);
        let (res_td, sample_td) =
            measure(&env, || StellarDestination::decode(&env, &oversized_tagged));
        assert_eq!(res_td, Err(HyperionError::InvalidDestination));
        assert!(sample_td.cpu_instructions <= EARLY_REJECT_CPU_CEILING);
        assert!(sample_td.memory_bytes <= EARLY_REJECT_MEM_CEILING);
        tagged_samples.push(sample_td);

        // 6. Oversized HyperionHook.
        let oversized_hook = filled_bytes(
            &env,
            &[HOOK_VERSION, AddressKind::Account.tag()],
            size,
            0x44,
        );
        let (res_hk, sample_hk) = measure(&env, || HyperionHook::decode(&env, &oversized_hook));
        assert_eq!(res_hk, Err(HyperionError::InvalidDestination));
        assert!(sample_hk.cpu_instructions <= EARLY_REJECT_CPU_CEILING);
        assert!(sample_hk.memory_bytes <= EARLY_REJECT_MEM_CEILING);
        hook_samples.push(sample_hk);
    }

    // Prove O(1) non-scaling across 256 B -> 64 KiB (256x input growth):
    // 64 KiB rejection must not allocate linear memory proportional to input length.
    for samples in [
        &inbound_samples,
        &outbound_samples,
        &strkey_wire_samples,
        &strkey_val_samples,
        &tagged_samples,
        &hook_samples,
    ] {
        let small = samples[0];
        let huge = samples[samples.len() - 1];
        assert!(
            huge.cpu_instructions <= small.cpu_instructions + 2_000,
            "CPU scaled with input length: 256B={} vs 64KiB={}",
            small.cpu_instructions,
            huge.cpu_instructions
        );
        assert!(
            huge.memory_bytes <= small.memory_bytes + 128,
            "Memory scaled with input length: 256B={} vs 64KiB={}",
            small.memory_bytes,
            huge.memory_bytes
        );
    }
}

#[test]
fn cctp_header_and_burn_parsers_bound_work_when_trailing_payload_is_huge() {
    let env = Env::default();
    let header_arr = cctp_header_bytes(0, STELLAR_DOMAIN, 77);
    let burn_arr = cctp_burn_prefix(HUNDRED, 0, 0, 0);

    let mut header_samples = StdVec::new();
    let mut burn_samples = StdVec::new();

    for trailing in OVERSIZED_BYTES {
        let mut msg_vec =
            StdVec::with_capacity(MSG_BODY as usize + BURN_HOOK_DATA as usize + trailing);
        msg_vec.extend_from_slice(&header_arr);
        msg_vec.extend_from_slice(&burn_arr);
        msg_vec.resize(msg_vec.len() + trailing, 0xAA);
        let msg_bytes = Bytes::from_slice(&env, &msg_vec);

        let (parsed_hdr, hdr_sample) = measure(&env, || CctpMessage::parse(&env, &msg_bytes));
        assert_eq!(parsed_hdr.unwrap().display_nonce(), 77);
        header_samples.push(hdr_sample);

        let mut body_vec = StdVec::with_capacity(BURN_HOOK_DATA as usize + trailing);
        body_vec.extend_from_slice(&burn_arr);
        body_vec.resize(body_vec.len() + trailing, 0xBB);
        let body_bytes = Bytes::from_slice(&env, &body_vec);

        let (parsed_burn, burn_sample) = measure(&env, || BurnMessage::parse(&env, &body_bytes));
        assert_eq!(parsed_burn.unwrap().amount, HUNDRED);
        burn_samples.push(burn_sample);
    }

    for samples in [&header_samples, &burn_samples] {
        let first = samples[0];
        let last = samples[samples.len() - 1];
        assert!(
            last.cpu_instructions <= first.cpu_instructions + 2_000,
            "Fixed-offset CCTP parser scaled with trailing bytes: 256B={} vs 64KiB={}",
            first.cpu_instructions,
            last.cpu_instructions
        );
        assert!(
            last.memory_bytes <= first.memory_bytes + 128,
            "Fixed-offset CCTP parser memory scaled with trailing bytes: 256B={} vs 64KiB={}",
            first.memory_bytes,
            last.memory_bytes
        );
    }
}

#[test]
fn queued_action_payloads_accept_max_valid_variants_and_reject_corrupted_or_oversized_xdr() {
    let w = World::new();
    let extra_token = Address::generate(&w.env);
    let candidate = Address::generate(&w.env);
    let wasm_hash = BytesN::from_array(&w.env, &[0xFFu8; 32]);

    // Exercise every non-self-mutating AdminAction variant at its maximum valid boundary
    // through queue_action -> get_queued -> XDR round-trip -> execute_action (or cancel for
    // Upgrade, since [0xFF; 32] is a synthetic hash not uploaded as Wasm).
    let max_valid_actions = [
        AdminAction::SetFeeBps(MAX_FEE_BPS),
        AdminAction::SetTreasury(candidate.clone()),
        AdminAction::SetGuardian(candidate.clone()),
        AdminAction::SetAdapter(RouteKind::Allbridge, w.rail_id.clone()),
        AdminAction::SetRailReceiver(RouteKind::Allbridge, w.rail_id.clone()),
        AdminAction::EnableRoute(RouteKind::Allbridge),
        AdminAction::RegisterToken(extra_token.clone(), 38, i128::MAX),
        AdminAction::RaiseTokenFlowLimit(w.token_id.clone(), i128::MAX),
        AdminAction::SetRouteFlowLimit(w.token_id.clone(), RouteKind::Allbridge, i128::MAX),
        AdminAction::SetTimelockDelay(MAX_TIMELOCK_DELAY),
        AdminAction::SetFlowWindow(u32::MAX),
        AdminAction::SetRouteConfig(
            RouteKind::Cctp,
            RouteConfig {
                max_single_transfer: i128::MAX,
            },
        ),
        AdminAction::SetRouteMaxSingleTransfer(RouteKind::AxelarIts, i128::MAX),
    ];

    let mut min_action_xdr = u32::MAX;
    let mut max_action_xdr = 0u32;
    let mut max_queued_xdr = 0u32;

    for action in max_valid_actions {
        let action_xdr = action.clone().to_xdr(&w.env);
        min_action_xdr = min_action_xdr.min(action_xdr.len());
        max_action_xdr = max_action_xdr.max(action_xdr.len());
        assert_eq!(
            AdminAction::from_xdr(&w.env, &action_xdr),
            Ok(action.clone())
        );

        let id = w.router().queue_action(&w.admin, &action);
        let queued = w.router().get_queued(&id);
        let queued_xdr = queued.clone().to_xdr(&w.env);
        max_queued_xdr = max_queued_xdr.max(queued_xdr.len());
        assert_eq!(QueuedAction::from_xdr(&w.env, &queued_xdr), Ok(queued));

        let delay = w.router().get_config().timelock_delay;
        w.advance_time(delay + 1);
        w.router().execute_action(&w.admin, &id);
    }

    // Restore standard timelock delay and also test queueing Upgrade([0xFF; 32]) + SetAdmin.
    let reset_delay_id = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetTimelockDelay(MIN_TIMELOCK_DELAY));
    w.advance_time(MAX_TIMELOCK_DELAY + 1);
    w.router().execute_action(&w.admin, &reset_delay_id);

    let upgrade_action = AdminAction::Upgrade(wasm_hash);
    let upgrade_id = w.router().queue_action(&w.admin, &upgrade_action);
    assert_eq!(w.router().get_queued(&upgrade_id).action, upgrade_action);
    w.router().cancel_action(&candidate, &upgrade_id);

    let set_admin_action = AdminAction::SetAdmin(candidate.clone());
    let set_admin_id = w.router().queue_action(&w.admin, &set_admin_action);
    w.advance_time(MIN_TIMELOCK_DELAY + 1);
    w.router().execute_action(&w.admin, &set_admin_id);
    assert_eq!(w.router().get_config().admin, candidate);

    // Every Soroban AdminAction and QueuedAction ScVal XDR payload is strictly bounded and compact.
    assert!(
        min_action_xdr >= 16 && max_action_xdr <= 256 && max_queued_xdr <= 512,
        "unexpected XDR bounds: min_action={}, max_action={}, max_queued={}",
        min_action_xdr,
        max_action_xdr,
        max_queued_xdr
    );

    // Out-of-range AdminAction fields are rejected immediately at queue time before storage write.
    let invalid_actions = [
        (
            AdminAction::SetFeeBps(MAX_FEE_BPS + 1),
            HyperionError::FeeTooHigh,
        ),
        (
            AdminAction::SetTimelockDelay(MIN_TIMELOCK_DELAY - 1),
            HyperionError::TimelockDelayOutOfRange,
        ),
        (
            AdminAction::SetTimelockDelay(MAX_TIMELOCK_DELAY + 1),
            HyperionError::TimelockDelayOutOfRange,
        ),
        (AdminAction::SetFlowWindow(0), HyperionError::InvalidWindow),
        (
            AdminAction::RegisterToken(extra_token.clone(), 39, HUNDRED),
            HyperionError::InvalidDecimals,
        ),
        (
            AdminAction::RegisterToken(extra_token, 7, -1),
            HyperionError::InvalidLimit,
        ),
        (
            AdminAction::RaiseTokenFlowLimit(w.token_id.clone(), -1),
            HyperionError::InvalidLimit,
        ),
        (
            AdminAction::SetRouteMaxSingleTransfer(RouteKind::Cctp, -1),
            HyperionError::InvalidLimit,
        ),
    ];
    for (bad_action, expected_err) in invalid_actions {
        assert_eq!(
            w.router().try_queue_action(&candidate, &bad_action),
            Err(Ok(expected_err))
        );
    }

    // Oversized XDR trailing bytes on AdminAction and QueuedAction must fail closed with bounded cost.
    let canonical_action =
        AdminAction::SetRouteFlowLimit(w.token_id.clone(), RouteKind::Cctp, HUNDRED);
    let valid_xdr = canonical_action.to_xdr(&w.env);
    let mut xdr_vec = StdVec::with_capacity(valid_xdr.len() as usize);
    for idx in 0..valid_xdr.len() {
        xdr_vec.push(valid_xdr.get(idx).unwrap());
    }

    for total_size in OVERSIZED_BYTES {
        let xdr_env = Env::default();
        let oversized_xdr = filled_bytes(&xdr_env, &xdr_vec, total_size, 0xAB);
        let (outcome, sample) = measure(&xdr_env, || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                AdminAction::from_xdr(&xdr_env, &oversized_xdr)
            }))
        });
        assert!(
            matches!(outcome, Err(_) | Ok(Err(_))),
            "oversized AdminAction XDR unexpectedly decoded at {} bytes",
            total_size
        );
        // Soroban host `deserialize_from_bytes` meters ~34 CPU instructions per input byte;
        // even a full 64 KiB buffer stays under 3M CPU (< 3% of the 100M ledger transaction cap).
        assert!(
            sample.cpu_instructions <= 3_000_000,
            "AdminAction::from_xdr CPU exceeded bound for {} bytes: {}",
            total_size,
            sample.cpu_instructions
        );
        assert!(
            sample.memory_bytes <= 262_144,
            "AdminAction::from_xdr memory exceeded bound for {} bytes: {}",
            total_size,
            sample.memory_bytes
        );
    }

    // Also verify bounded valid chain identifiers on OutboundRequest while empty chain is rejected.
    let empty_req = OutboundRequest {
        token: w.token_id.clone(),
        amount: HUNDRED,
        route: RouteKind::Cctp,
        destination: Destination {
            chain: String::from_str(&w.env, ""),
            address: evm_destination(&w.env, 0x01),
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    };
    assert_eq!(
        w.router().try_bridge_out(&w.user, &empty_req),
        Err(Ok(HyperionError::UnknownChain))
    );

    let max_chain_name = "ethereum-sepolia-canonical-testnet-lane-v1";
    let valid_req = OutboundRequest {
        token: w.token_id.clone(),
        amount: HUNDRED,
        route: RouteKind::Cctp,
        destination: Destination {
            chain: String::from_str(&w.env, max_chain_name),
            address: evm_destination(&w.env, 0x02),
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    };
    let nonce = w.router().bridge_out(&w.user, &valid_req);
    assert_eq!(
        w.router().get_transfer(&nonce).destination_chain,
        String::from_str(&w.env, max_chain_name)
    );
}
