//! Domain-separated Allbridge v2 inbound signing envelope and constrained v1 migration tests.

use ed25519_dalek::{Signer, SigningKey};
use hyperion_core::{codec, AddressKind, HyperionError, RouteKind, STELLAR_DECIMALS};
use hyperion_router::AdminAction;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, BytesN, U256,
};

use super::setup::{World, BASE_CHAIN_ID, ETH_CHAIN_ID, FLOW_LIMIT, HUNDRED};
use crate::{
    rail::{self, STELLAR_CHAIN_ID},
    AllbridgeAdapter, AllbridgeAdapterClient, MAX_LEGACY_DELIVERIES, MAX_LEGACY_MIGRATION_LEDGERS,
};

struct EnvelopeWorld {
    world: World,
    signing_key: SigningKey,
    recipient: Address,
}

impl EnvelopeWorld {
    fn new() -> Self {
        let world = World::new();
        let signing_key = SigningKey::from_bytes(&[0x42u8; 32]);
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
            recipient,
        }
    }

    fn sign_digest(&self, digest: &BytesN<32>) -> BytesN<64> {
        let sig = self.signing_key.sign(&digest.to_array());
        BytesN::from_array(&self.world.env, &sig.to_bytes())
    }

    fn sign_legacy_v1(
        &self,
        token: &Address,
        amount: i128,
        recipient: &Address,
        source_chain_id: u32,
        nonce: &U256,
    ) -> (BytesN<32>, BytesN<64>) {
        let env = &self.world.env;
        let (_, recipient_key) = codec::address_key(env, recipient).unwrap();
        let token_key = codec::contract_key(env, token).unwrap();
        let message_id = rail::hash_message(
            env,
            amount as u128,
            &BytesN::from_array(env, &recipient_key),
            source_chain_id,
            STELLAR_CHAIN_ID,
            &BytesN::from_array(env, &token_key),
            nonce,
        );
        let sig = self.sign_digest(&message_id);
        (message_id, sig)
    }
}

#[test]
fn signature_for_another_adapter_is_rejected() {
    let s = EnvelopeWorld::new();
    let amount = HUNDRED;
    let nonce = U256::from_u32(&s.world.env, 11);

    // Deploy a second Allbridge adapter configured with the same router, bridge, native, lane,
    // asset, and validator key.
    let second_id = s.world.env.register(AllbridgeAdapter, ());
    let second = AllbridgeAdapterClient::new(&s.world.env, &second_id);
    second.initialize(
        &s.world.admin,
        &s.world.router_id,
        &s.world.bridge_id,
        &s.world.native_id,
    );
    second.link_chain(&s.world.ethereum(), &ETH_CHAIN_ID);
    second.link_asset(
        &s.world.token_id,
        &s.world.ethereum(),
        &s.world.receive_token(),
    );
    second.set_validator(&s.world.adapter().get_validator());

    // Sign the digest produced for the second adapter.
    let foreign_digest = second.inbound_signing_digest(
        &s.world.token_id,
        &amount,
        &s.recipient,
        &ETH_CHAIN_ID,
        &nonce,
    );
    let local_digest = s.world.adapter().inbound_signing_digest(
        &s.world.token_id,
        &amount,
        &s.recipient,
        &ETH_CHAIN_ID,
        &nonce,
    );
    assert_ne!(foreign_digest, local_digest);

    let foreign_sig = s.sign_digest(&foreign_digest);
    s.world.fund_user(amount);

    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce,
            &foreign_sig,
        )
        .is_err());
    assert_eq!(s.world.token().balance(&s.recipient), 0);
}

#[test]
fn signature_for_another_network_is_rejected() {
    let s = EnvelopeWorld::new();
    let amount = HUNDRED;
    let nonce = U256::from_u32(&s.world.env, 12);

    // Sign under network A.
    s.world.env.ledger().with_mut(|li| {
        li.network_id = [0xAAu8; 32];
    });
    let digest_net_a = s.world.adapter().inbound_signing_digest(
        &s.world.token_id,
        &amount,
        &s.recipient,
        &ETH_CHAIN_ID,
        &nonce,
    );
    let sig_net_a = s.sign_digest(&digest_net_a);

    // Attempt delivery on network B.
    s.world.env.ledger().with_mut(|li| {
        li.network_id = [0xBBu8; 32];
    });
    let digest_net_b = s.world.adapter().inbound_signing_digest(
        &s.world.token_id,
        &amount,
        &s.recipient,
        &ETH_CHAIN_ID,
        &nonce,
    );
    assert_ne!(digest_net_a, digest_net_b);

    s.world.fund_user(amount);
    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce,
            &sig_net_a,
        )
        .is_err());
    assert_eq!(s.world.token().balance(&s.recipient), 0);
}

#[test]
fn every_payout_affecting_field_is_authenticated() {
    let s = EnvelopeWorld::new();
    let amount = HUNDRED;
    let nonce = U256::from_u32(&s.world.env, 13);

    // Link Base as a second source chain and register a second local token so we can test
    // mutating source_chain_id, local token, and remote receive_token independently.
    s.world
        .adapter()
        .link_chain(&s.world.base(), &BASE_CHAIN_ID);
    s.world
        .adapter()
        .link_asset(&s.world.token_id, &s.world.base(), &s.world.receive_token());

    let issuer2 = Address::generate(&s.world.env);
    let second_token = s
        .world
        .env
        .register_stellar_asset_contract_v2(issuer2)
        .address();
    let pool2 = s.world.pool_id.clone();
    s.world
        .bridge()
        .add_pool(&pool2, &s.world.token_key(&second_token));
    s.world
        .adapter()
        .link_asset(&second_token, &s.world.ethereum(), &s.world.receive_token());
    s.world.run_action(AdminAction::RegisterToken(
        second_token.clone(),
        STELLAR_DECIMALS,
        FLOW_LIMIT,
    ));
    token::StellarAssetClient::new(&s.world.env, &second_token).mint(&s.world.user, &(amount * 2));
    s.world.fund_user(amount * 2);

    let base_digest = s.world.adapter().inbound_signing_digest(
        &s.world.token_id,
        &amount,
        &s.recipient,
        &ETH_CHAIN_ID,
        &nonce,
    );
    let valid_sig = s.sign_digest(&base_digest);

    // 1. Amount tamper fails.
    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &(amount + 1),
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce,
            &valid_sig,
        )
        .is_err());

    // 2. Recipient address tamper fails.
    let other_recipient = Address::generate(&s.world.env);
    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &other_recipient,
            &ETH_CHAIN_ID,
            &nonce,
            &valid_sig,
        )
        .is_err());

    // 3. Recipient kind tamper (Contract vs Account sharing identical 32-byte key!) fails.
    // Allbridge v1 `hash_message` only hashed the 32-byte key without `AddressKind`.
    let (_, contract_key_32) = codec::address_key(&s.world.env, &s.recipient).unwrap();
    let same_key_classic =
        Address::from_string(&codec::account_strkey(&s.world.env, &contract_key_32));
    let (classic_kind, classic_key_32) =
        codec::address_key(&s.world.env, &same_key_classic).unwrap();
    assert_eq!(classic_kind, AddressKind::Account);
    assert_eq!(classic_key_32, contract_key_32);
    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &same_key_classic,
            &ETH_CHAIN_ID,
            &nonce,
            &valid_sig,
        )
        .is_err());

    // 4. Local token tamper fails.
    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &second_token,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce,
            &valid_sig,
        )
        .is_err());

    // 5. Source chain tamper fails.
    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &BASE_CHAIN_ID,
            &nonce,
            &valid_sig,
        )
        .is_err());

    // 6. Nonce tamper (including high bits outside the u64 display tail) fails.
    let mut high_bit_nonce_bytes = [0u8; 32];
    nonce
        .to_be_bytes()
        .copy_into_slice(&mut high_bit_nonce_bytes);
    high_bit_nonce_bytes[0] = 1;
    let high_bit_nonce = U256::from_be_bytes(
        &s.world.env,
        &soroban_sdk::Bytes::from_array(&s.world.env, &high_bit_nonce_bytes),
    );
    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &high_bit_nonce,
            &valid_sig,
        )
        .is_err());

    // 7. Remote asset mapping tamper (re-linking remote receive_token after signing) fails.
    let alt_remote = s.world.evm(0xEE);
    s.world
        .bridge()
        .add_bridge_token(&ETH_CHAIN_ID, &alt_remote);
    s.world
        .adapter()
        .link_asset(&s.world.token_id, &s.world.ethereum(), &alt_remote);
    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce,
            &valid_sig,
        )
        .is_err());

    // Restore original asset link and confirm the exact signed payload succeeds.
    s.world.map_token();
    assert_eq!(
        s.world.adapter().bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce,
            &valid_sig,
        ),
        0
    );
    assert_eq!(s.world.token().balance(&s.recipient), amount);
}

#[test]
fn legacy_v1_acceptance_is_disabled_by_default_and_explicitly_constrained() {
    let s = EnvelopeWorld::new();
    let amount = HUNDRED;
    s.world.fund_user(amount * 5);

    // Default policy is disabled.
    let initial = s.world.adapter().legacy_migration_policy();
    assert!(!initial.enabled);
    assert_eq!(initial.max_ledger, 0);
    assert_eq!(initial.remaining_deliveries, 0);

    let nonce1 = U256::from_u32(&s.world.env, 501);
    let (msg1, v1_sig1) = s.sign_legacy_v1(
        &s.world.token_id,
        amount,
        &s.recipient,
        ETH_CHAIN_ID,
        &nonce1,
    );

    // v1 signature is rejected on standard v2 `bridge_in` AND rejected on `bridge_in_legacy_v1`
    // while the migration window is closed.
    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce1,
            &v1_sig1,
        )
        .is_err());
    assert_eq!(
        s.world.adapter().try_bridge_in_legacy_v1(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce1,
            &v1_sig1,
        ),
        Err(Ok(HyperionError::UnsupportedMessageVersion))
    );

    // Window bounds are strictly enforced.
    let now = s.world.env.ledger().sequence();
    assert_eq!(
        s.world.adapter().try_configure_legacy_v1_window(&now, &1),
        Err(Ok(HyperionError::InvalidWindow))
    );
    assert_eq!(
        s.world
            .adapter()
            .try_configure_legacy_v1_window(&(now + MAX_LEGACY_MIGRATION_LEDGERS + 1), &1),
        Err(Ok(HyperionError::InvalidWindow))
    );
    assert_eq!(
        s.world
            .adapter()
            .try_configure_legacy_v1_window(&(now + 100), &0),
        Err(Ok(HyperionError::InvalidLimit))
    );
    assert_eq!(
        s.world
            .adapter()
            .try_configure_legacy_v1_window(&(now + 100), &(MAX_LEGACY_DELIVERIES + 1)),
        Err(Ok(HyperionError::InvalidLimit))
    );

    // Open a window with quota = 1 and max_ledger = now + 10.
    let policy = s
        .world
        .adapter()
        .configure_legacy_v1_window(&(now + 10), &1);
    assert!(policy.enabled);
    assert_eq!(policy.remaining_deliveries, 1);

    // First legacy v1 delivery succeeds and consumes the quota.
    assert_eq!(
        s.world.adapter().bridge_in_legacy_v1(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce1,
            &v1_sig1,
        ),
        0
    );
    assert!(s.world.adapter().is_processed(&msg1));

    // Quota is now exhausted and policy auto-disables.
    let after_one = s.world.adapter().legacy_migration_policy();
    assert!(!after_one.enabled);
    assert_eq!(after_one.remaining_deliveries, 0);

    // Cross-version replay of the delivered v1 message via v2 `bridge_in` is blocked.
    let v2_digest1 = s.world.adapter().inbound_signing_digest(
        &s.world.token_id,
        &amount,
        &s.recipient,
        &ETH_CHAIN_ID,
        &nonce1,
    );
    let v2_sig1 = s.sign_digest(&v2_digest1);
    assert_eq!(
        s.world.adapter().try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce1,
            &v2_sig1,
        ),
        Err(Ok(HyperionError::ReplayedMessage))
    );

    // Second legacy v1 message is rejected once quota is exhausted.
    let nonce2 = U256::from_u32(&s.world.env, 502);
    let (_msg2, v1_sig2) = s.sign_legacy_v1(
        &s.world.token_id,
        amount,
        &s.recipient,
        ETH_CHAIN_ID,
        &nonce2,
    );
    assert_eq!(
        s.world.adapter().try_bridge_in_legacy_v1(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce2,
            &v1_sig2,
        ),
        Err(Ok(HyperionError::UnsupportedMessageVersion))
    );

    // Re-open window with quota = 2, advance past `max_ledger`, and confirm ledger expiry blocks v1.
    s.world.adapter().configure_legacy_v1_window(&(now + 5), &2);
    s.world.env.ledger().with_mut(|li| {
        li.sequence_number = now + 6;
    });
    assert_eq!(
        s.world.adapter().try_bridge_in_legacy_v1(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce2,
            &v1_sig2,
        ),
        Err(Ok(HyperionError::UnsupportedMessageVersion))
    );

    // Explicit `disable_legacy_v1_window` closes an active window immediately.
    let later = s.world.env.ledger().sequence();
    s.world
        .adapter()
        .configure_legacy_v1_window(&(later + 20), &2);
    s.world.adapter().disable_legacy_v1_window();
    assert_eq!(
        s.world.adapter().try_bridge_in_legacy_v1(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce2,
            &v1_sig2,
        ),
        Err(Ok(HyperionError::UnsupportedMessageVersion))
    );
}
