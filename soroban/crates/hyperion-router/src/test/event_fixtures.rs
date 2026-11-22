//! Golden router event encodings for the SDK's raw event inspector.
//!
//! `packages/protocol/src/events.ts` decodes the base64 XDR that Stellar RPC `getEvents`
//! returns. Hand-built bytes would only show that the decoder agrees with whoever wrote
//! them. These fixtures are what the real host emits instead: the router's actual
//! transfer-lifecycle flows, plus full-width records published through the router's own
//! event helpers.
//!
//! The test fails when the committed file differs from what the host produces now. To regenerate
//! it, run:
//!
//! ```sh
//! HYPERION_WRITE_EVENT_FIXTURES=1 cargo test -p hyperion-router --lib event_fixtures
//! ```
extern crate std;

use hyperion_core::{AddressKind, RouteKind};
use soroban_sdk::{
    testutils::Events as _,
    xdr::{ContractEventBody, Limits, ScAddress, WriteXdr},
    Address, BytesN, String,
};
use std::{format, string::String as StdString, vec::Vec};

use super::doubles::{evm_destination, Delivery};
use super::setup::{World, HUNDRED};
use crate::types::{Destination, InboundRecord, OutboundRequest, PendingClaim, TransferRecord};

const FIXTURE: &str = "../../../testdata/router-events-soroban.json";

fn strkey(address: &Address) -> StdString {
    format!("{}", ScAddress::from(address))
}

/// Every router event from the last top-level invocation, as JSON objects tagged with `label`.
/// The test host keeps events for the most recent invocation only.
fn capture(w: &World, label: &str, out: &mut Vec<StdString>) {
    let all = w.env.events().all();
    let events = all.events();
    let router = ScAddress::from(&w.router_id);
    for event in events {
        let Some(contract) = &event.contract_id else {
            continue;
        };
        if ScAddress::Contract(contract.clone()) != router {
            continue;
        }
        let ContractEventBody::V0(body) = &event.body;
        let topics: Vec<StdString> = body
            .topics
            .iter()
            .map(|t| format!("\"{}\"", t.to_xdr_base64(Limits::none()).unwrap()))
            .collect();
        out.push(format!(
            "  {{\"label\": \"{label}\", \"type\": \"contract\", \"contractId\": \"{}\", \"topic\": [{}], \"value\": \"{}\"}}",
            strkey(&w.router_id),
            topics.join(", "),
            body.data.to_xdr_base64(Limits::none()).unwrap()
        ));
    }
}

#[test]
fn router_event_encodings_match_the_committed_sdk_fixtures() {
    let w = World::new();
    let mut out = Vec::new();

    // Outbound: one BridgeOut.
    w.router().bridge_out(
        &w.user,
        &OutboundRequest {
            token: w.token_id.clone(),
            amount: HUNDRED,
            route: RouteKind::Cctp,
            destination: Destination {
                chain: w.ethereum(),
                address: evm_destination(&w.env, 1),
            },
            destination_decimals: 6,
            min_destination_amount: 0,
        },
    );
    capture(&w, "outbound", &mut out);

    // Inbound paid straight through: ReplayRecorded then BridgeIn(delivered).
    w.fund_rail(HUNDRED);
    w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 42,
    });
    capture(&w, "inbound-paid", &mut out);

    // Inbound parked: ReplayRecorded, ClaimParked, ClaimPayoutFailureV1, BridgeIn(parked).
    let token = w.with_failable_token();

    w.failable(&token).mint(&w.rail_id, &HUNDRED);
    w.failable(&token).set_blocked(&w.recipient, &true);
    let claim = w.rail().deliver(&Delivery {
        route: RouteKind::AxelarIts,
        token: token.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 43,
    });
    capture(&w, "inbound-parked", &mut out);

    // The parked claim settles: ClaimSettled.
    w.failable(&token).set_blocked(&w.recipient, &false);
    w.router().settle_claim(&w.user, &claim);
    capture(&w, "claim-settled", &mut out);

    // Full-width values through the router's own event helpers. No flow produces these
    // naturally, but the SDK must carry every representable nonce and amount exactly.
    w.env.as_contract(&w.router_id, || {
        let env = &w.env;
        crate::events::bridge_out(
            env,
            &TransferRecord {
                nonce: u64::MAX,
                sender: w.user.clone(),
                token: w.token_id.clone(),
                gross_amount: i128::MAX,
                fee: i128::MAX - 1,
                net_amount: 1,
                destination_chain: String::from_str(env, "ethereum"),
                destination: BytesN::from_array(env, &[0xff; 32]),
                route: RouteKind::Allbridge,
                created_ledger: u32::MAX,
                created_at: u64::MAX,
            },
        );
        crate::events::bridge_in(
            env,
            &InboundRecord {
                route: RouteKind::AxelarGmp,
                recipient: w.recipient.clone(),
                token: w.token_id.clone(),
                amount: i128::MAX,
                source_chain: String::from_str(env, "ethereum"),
                source_nonce: u64::MAX,
                delivered: true,
                claim_id: 0,
                ledger: u32::MAX,
            },
        );
        let claim = PendingClaim {
            id: u64::MAX,
            recipient: w.recipient.clone(),
            token: w.token_id.clone(),
            amount: i128::MAX,
            route: RouteKind::Cctp,
            source_chain: String::from_str(env, "ethereum"),
            source_nonce: u64::MAX,
            created_at: u64::MAX,
            settled: false,
        };
        crate::events::claim_parked(env, &claim);
        crate::events::claim_payout_failure_v1(env, &claim, 3);
        crate::events::claim_settled(env, &claim, &w.user);
        crate::events::replay_recorded(env, RouteKind::Cctp, &BytesN::from_array(env, &[0xff; 32]));
    });
    capture(&w, "full-width", &mut out);

    let rendered = format!(
        "{{\n\"generatedBy\": \"soroban/crates/hyperion-router/src/test/event_fixtures.rs\",\n\"events\": [\n{}\n]\n}}\n",
        out.join(",\n")
    );
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    if std::env::var_os("HYPERION_WRITE_EVENT_FIXTURES").is_some() {
        std::fs::write(&path, &rendered).unwrap();
    }
    let committed = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    assert_eq!(
        committed, rendered,
        "router event encodings changed; regenerate with HYPERION_WRITE_EVENT_FIXTURES=1 and review the SDK inspector"
    );
}
