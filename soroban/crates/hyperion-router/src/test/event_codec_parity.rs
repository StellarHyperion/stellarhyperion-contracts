//! Compare borrowed event publishing with the unchanged SDK event definitions.
use super::setup::World;
use crate::{events, storage, *};
use hyperion_core::RouteKind;
use soroban_sdk::{testutils::Events as _, BytesN, Event, String};

#[test]
fn borrowed_event_topics_and_sparse_data_match_all_sdk_event_definitions() {
    let w = World::bare();
    let nonce = (1u64 << 53) + 91;
    let amount = (1i128 << 96) + 17;
    let chain = String::from_str(&w.env, "ethereum:ø");
    let message_id = BytesN::from_array(&w.env, &[0xa7; 32]);
    let transfer = TransferRecord {
        nonce,
        sender: w.user.clone(),
        token: w.token_id.clone(),
        gross_amount: amount,
        fee: 31,
        net_amount: amount - 31,
        destination_chain: chain.clone(),
        destination: message_id.clone(),
        route: RouteKind::AxelarIts,
        created_ledger: 200_001,
        created_at: nonce,
    };
    let inbound = InboundRecord {
        route: RouteKind::Cctp,
        recipient: w.recipient.clone(),
        token: w.token_id.clone(),
        amount,
        source_chain: chain.clone(),
        source_nonce: nonce,
        delivered: false,
        claim_id: nonce + 1,
        ledger: 200_002,
    };
    let claim = PendingClaim {
        id: nonce + 1,
        recipient: w.recipient.clone(),
        token: w.token_id.clone(),
        amount,
        route: RouteKind::Cctp,
        source_chain: chain.clone(),
        source_nonce: nonce,
        created_at: nonce + 2,
        settled: true,
    };
    let queued = QueuedAction {
        id: nonce,
        action: AdminAction::SetDestinationFlowLimit(
            w.token_id.clone(),
            RouteKind::AxelarIts,
            chain.clone(),
            amount,
        ),
        queued_at: nonce + 3,
        eta: nonce + 4,
        expires_at: nonce + 5,
    };
    let cfg = w.router().get_config();
    let token_cfg = TokenConfig {
        decimals: 7,
        flow_limit: amount,
        enabled: false,
    };
    let status = MigrationStatus {
        current_version: 2,
        target_version: 3,
        migration_pending: true,
        migrated_transfers: nonce,
        migrated_claims: nonce + 1,
        total_transfers: nonce + 2,
        total_claims: nonce + 3,
    };

    macro_rules! check {
        ($reference:expr, $publish:expr) => {{
            let reference = $reference;
            w.env.as_contract(&w.router_id, || $publish);
            let expected = reference.to_xdr(&w.env, &w.router_id);
            let emitted = w.env.events().all();
            assert_eq!(emitted.events().last(), Some(&expected));
        }};
    }

    check!(
        events::BridgeOut {
            route: transfer.route,
            sender: w.user.clone(),
            transfer: transfer.clone()
        },
        events::bridge_out(&w.env, &transfer)
    );
    check!(
        events::BridgeIn {
            route: inbound.route,
            recipient: w.recipient.clone(),
            inbound: inbound.clone()
        },
        events::bridge_in(&w.env, &inbound)
    );
    check!(
        events::ClaimParked {
            recipient: w.recipient.clone(),
            token: w.token_id.clone(),
            claim: claim.clone()
        },
        events::claim_parked(&w.env, &claim)
    );
    check!(
        events::ClaimSettled {
            recipient: w.recipient.clone(),
            token: w.token_id.clone(),
            claim_id: claim.id,
            amount,
            settled_by: w.user.clone()
        },
        events::claim_settled(&w.env, &claim, &w.user)
    );
    check!(
        events::ClaimPayoutFailureV1 {
            claim_id: claim.id,
            reason: 3,
            outstanding_amount: amount,
            recipient: w.recipient.clone()
        },
        events::claim_payout_failure_v1(&w.env, &claim, 3)
    );
    check!(
        events::ClaimArchived {
            recipient: w.recipient.clone(),
            token: w.token_id.clone(),
            claim_id: claim.id,
            amount,
            source_nonce: nonce,
            claim: claim.clone(),
            provenance: None,
            settled_at: nonce + 6,
            archived_at: nonce + 7
        },
        events::claim_archived(&w.env, &claim, nonce + 6, nonce + 7)
    );
    let provenance = ClaimProvenance {
        route: RouteKind::Cctp,
        source_chain: chain.clone(),
        message_id: message_id.clone(),
    };
    w.env.as_contract(&w.router_id, || {
        storage::set_claim_provenance(&w.env, claim.id, &provenance)
    });
    check!(
        events::ClaimArchived {
            recipient: w.recipient.clone(),
            token: w.token_id.clone(),
            claim_id: claim.id,
            amount,
            source_nonce: nonce,
            claim: claim.clone(),
            provenance: Some(provenance.clone()),
            settled_at: nonce + 6,
            archived_at: nonce + 7
        },
        events::claim_archived(&w.env, &claim, nonce + 6, nonce + 7)
    );
    check!(
        events::PauseSet {
            by: w.guardian.clone(),
            paused: true
        },
        events::paused(&w.env, &w.guardian, true)
    );
    check!(
        events::ActionQueued {
            id: queued.id,
            action: queued.action.clone(),
            eta: queued.eta,
            expires_at: queued.expires_at
        },
        events::action_queued(&w.env, queued.clone())
    );
    check!(
        events::ActionExecuted {
            id: queued.id,
            action: queued.action.clone(),
            queued_at: queued.queued_at
        },
        events::action_executed(&w.env, queued.clone())
    );
    check!(
        events::ActionCancelled {
            by: w.guardian.clone(),
            id: nonce
        },
        events::action_cancelled(&w.env, nonce, &w.guardian)
    );
    let note = String::from_str(&w.env, "reviewed configuration");
    check!(
        events::ActionAuditRecorded {
            id: nonce,
            version: 1,
            status: ActionAuditStatus::Cancelled,
            actor: w.guardian.clone(),
            reason: CancelReason::SecurityConcern,
            note: note.clone()
        },
        events::action_audit(
            &w.env,
            nonce,
            ActionAuditStatus::Cancelled,
            &w.guardian,
            CancelReason::SecurityConcern,
            note
        )
    );
    check!(
        events::StorageMigrated {
            version: 1,
            by: w.admin.clone(),
            status: status.clone()
        },
        events::storage_migrated(&w.env, &w.admin, &status)
    );
    check!(
        events::ConfigChanged {
            config: cfg.clone()
        },
        events::config_changed(&w.env, &cfg)
    );
    check!(
        events::TokenRegistered {
            token: w.token_id.clone(),
            config: token_cfg.clone()
        },
        events::token_registered(&w.env, &w.token_id, &token_cfg)
    );
    check!(
        events::RouteConfigured {
            route: RouteKind::Allbridge,
            enabled: false
        },
        events::route_configured(&w.env, RouteKind::Allbridge, false)
    );
    check!(
        events::FlowLimitLowered {
            token: w.token_id.clone(),
            by: w.guardian.clone(),
            limit: amount
        },
        events::flow_limit_lowered(&w.env, &w.token_id, amount, &w.guardian)
    );
    check!(
        events::ReplayRecorded {
            route: RouteKind::Cctp,
            message_id: message_id.clone(),
            version: 1,
            ledger: w.env.ledger().sequence(),
            timestamp: w.env.ledger().timestamp()
        },
        events::replay_recorded(&w.env, RouteKind::Cctp, &message_id)
    );
}
