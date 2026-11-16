//! Validator-independent inbound evidence auditing tests.

use ed25519_dalek::{Signer, SigningKey};
use hyperion_core::{codec, RouteKind};
use hyperion_router::AdminAction;
use soroban_sdk::{testutils::Address as _, Address, BytesN, U256};

use super::setup::{World, ETH_CHAIN_ID, HUNDRED};
use crate::{
    rail::{self, STELLAR_CHAIN_ID},
    types::{EvidenceAuditStatus, PayoutObservation, SignedInboundIntent, SourceProviderEvidence},
};

struct AuditFixture {
    world: World,
    signing_key: SigningKey,
    validator_pk: BytesN<32>,
    recipient: Address,
}

impl AuditFixture {
    fn new() -> Self {
        let world = World::new();
        let signing_key = SigningKey::from_bytes(&[0x37u8; 32]);
        let validator_pk = BytesN::from_array(&world.env, &signing_key.verifying_key().to_bytes());
        world.adapter().set_validator(&validator_pk);
        world.run_action(AdminAction::SetRailReceiver(
            RouteKind::Allbridge,
            world.adapter_id.clone(),
        ));
        let recipient = Address::generate(&world.env);
        Self {
            world,
            signing_key,
            validator_pk,
            recipient,
        }
    }

    fn build_intent_and_source(
        &self,
        recipient: &Address,
        amount: i128,
        nonce_val: u32,
    ) -> (SignedInboundIntent, SourceProviderEvidence) {
        let env = &self.world.env;
        let nonce = U256::from_u32(env, nonce_val);
        let (_, rec_key) = codec::address_key(env, recipient).unwrap();
        let recipient_bytes = BytesN::from_array(env, &rec_key);
        let tok_key = BytesN::from_array(
            env,
            &codec::contract_key(env, &self.world.token_id).unwrap(),
        );

        let message_id = rail::hash_message(
            env,
            amount as u128,
            &recipient_bytes,
            ETH_CHAIN_ID,
            STELLAR_CHAIN_ID,
            &tok_key,
            &nonce,
        );
        let sig = self.signing_key.sign(&message_id.to_array());
        let signature = BytesN::from_array(env, &sig.to_bytes());

        let intent = SignedInboundIntent {
            token: self.world.token_id.clone(),
            amount,
            recipient: recipient.clone(),
            source_chain_id: ETH_CHAIN_ID,
            nonce: nonce.clone(),
            signature,
        };
        let source = SourceProviderEvidence {
            source_chain_id: ETH_CHAIN_ID,
            destination_chain_id: STELLAR_CHAIN_ID,
            recipient: recipient_bytes,
            receive_token: tok_key,
            amount: amount as u128,
            nonce,
            message_id,
        };
        (intent, source)
    }
}

#[test]
fn missing_independent_evidence_surfaces_as_unresolved_trust_assumption() {
    let f = AuditFixture::new();
    let (intent, _source) = f.build_intent_and_source(&f.recipient, HUNDRED, 501);
    f.world.fund_user(HUNDRED);
    let claim_id = f.world.adapter().bridge_in(
        &f.world.user,
        &intent.token,
        &intent.amount,
        &intent.recipient,
        &intent.source_chain_id,
        &intent.nonce,
        &intent.signature,
    );
    assert_eq!(claim_id, 0);

    let report = f.world.adapter().audit_inbound_evidence(
        &intent,
        &None,
        &PayoutObservation::DirectPayout(f.recipient.clone(), f.world.token_id.clone(), HUNDRED),
    );
    assert_eq!(
        report.status,
        EvidenceAuditStatus::UnresolvedTrustAssumption
    );
    assert!(!report.verified);
    assert!(report.unresolved_validator_trust);
    assert!(!report.source_evidence_matches);
    assert!(report.payout_matches);
}

#[test]
fn amount_and_recipient_inconsistencies_block_verified_report() {
    let f = AuditFixture::new();
    let classic = Address::from_string(&codec::account_strkey(&f.world.env, &[0x66u8; 32]));
    let (intent, source) = f.build_intent_and_source(&classic, HUNDRED, 502);

    f.world.fund_user(HUNDRED);
    let claim_id = f.world.adapter().bridge_in(
        &f.world.user,
        &intent.token,
        &intent.amount,
        &intent.recipient,
        &intent.source_chain_id,
        &intent.nonce,
        &intent.signature,
    );
    assert_eq!(claim_id, 1);

    // Matching source + matching parked claim verifies cleanly.
    let ok_report = f.world.adapter().audit_inbound_evidence(
        &intent,
        &Some(source.clone()),
        &PayoutObservation::ParkedClaim(claim_id),
    );
    assert_eq!(ok_report.status, EvidenceAuditStatus::Verified);
    assert!(ok_report.verified);
    assert!(!ok_report.unresolved_validator_trust);

    // Source amount mismatch blocks Verified.
    let mut wrong_amt_src = source.clone();
    wrong_amt_src.amount = (HUNDRED as u128) - 1;
    let amt_report = f.world.adapter().audit_inbound_evidence(
        &intent,
        &Some(wrong_amt_src),
        &PayoutObservation::ParkedClaim(claim_id),
    );
    assert_eq!(amt_report.status, EvidenceAuditStatus::AmountMismatch);
    assert!(!amt_report.verified);

    // Source recipient mismatch blocks Verified.
    let mut wrong_rec_src = source.clone();
    wrong_rec_src.recipient = BytesN::from_array(&f.world.env, &[0x99u8; 32]);
    let rec_report = f.world.adapter().audit_inbound_evidence(
        &intent,
        &Some(wrong_rec_src),
        &PayoutObservation::ParkedClaim(claim_id),
    );
    assert_eq!(rec_report.status, EvidenceAuditStatus::RecipientMismatch);
    assert!(!rec_report.verified);

    // Payout amount or recipient mismatch also blocks Verified.
    let bad_payout_amt = f.world.adapter().audit_inbound_evidence(
        &intent,
        &Some(source.clone()),
        &PayoutObservation::DirectPayout(classic.clone(), f.world.token_id.clone(), HUNDRED + 10),
    );
    assert_eq!(bad_payout_amt.status, EvidenceAuditStatus::AmountMismatch);
    assert!(!bad_payout_amt.verified);

    let stranger = Address::generate(&f.world.env);
    let bad_payout_rec = f.world.adapter().audit_inbound_evidence(
        &intent,
        &Some(source),
        &PayoutObservation::DirectPayout(stranger, f.world.token_id.clone(), HUNDRED),
    );
    assert_eq!(
        bad_payout_rec.status,
        EvidenceAuditStatus::RecipientMismatch
    );
    assert!(!bad_payout_rec.verified);
}

#[test]
fn audit_never_submits_payouts_or_mutates_validators() {
    let f = AuditFixture::new();
    let (intent, source) = f.build_intent_and_source(&f.recipient, HUNDRED, 503);
    f.world.fund_adapter(HUNDRED);

    let report = f.world.adapter().audit_inbound_evidence(
        &intent,
        &Some(source.clone()),
        &PayoutObservation::Unobserved,
    );
    // Delivery has not occurred yet, so payout_matches is false and status is MetadataMismatch.
    assert_eq!(report.status, EvidenceAuditStatus::MetadataMismatch);
    assert!(!report.verified);
    assert!(!report.adapter_processed);
    assert!(!report.router_processed);

    // Neither recipient balance, adapter balance, replay map, claim count, nor validator changed.
    assert_eq!(f.world.token().balance(&f.recipient), 0);
    assert_eq!(f.world.token().balance(&f.world.adapter_id), HUNDRED);
    assert!(!f.world.adapter().is_processed(&source.message_id));
    assert_eq!(f.world.router().claim_count(), 0);
    assert_eq!(f.world.adapter().get_validator(), f.validator_pk);
}
