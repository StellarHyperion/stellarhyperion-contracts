//! Tests for delayed Allbridge validator rotation, explicit epochs, and emergency disable.

use ed25519_dalek::{Signer, SigningKey};
use hyperion_core::{codec, HyperionError, RouteKind, STELLAR_DECIMALS};
use hyperion_router::AdminAction;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger},
    Address, BytesN, Env, U256,
};

use super::setup::{World, ETH_CHAIN_ID, FLOW_LIMIT, HUNDRED};
use crate::{
    rail::{self, STELLAR_CHAIN_ID},
    DEFAULT_TRUST_CHANGE_DELAY, MAX_TRUST_CHANGE_DELAY, MIN_TRUST_CHANGE_DELAY,
    ROTATION_GRACE_PERIOD,
};

/// Minimal SEP-41 stand-in with a per-recipient block switch to simulate a classic account
/// opening its trustline after an inbound claim was parked on `HyperionRouter`.
#[contract]
pub struct ToggleableToken;

#[contracttype]
#[derive(Clone)]
enum TokKey {
    Bal(Address),
    Blocked(Address),
}

#[contractimpl]
impl ToggleableToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let cur: i128 = env
            .storage()
            .persistent()
            .get(&TokKey::Bal(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&TokKey::Bal(to), &(cur + amount));
    }

    pub fn set_blocked(env: Env, account: Address, blocked: bool) {
        env.storage()
            .persistent()
            .set(&TokKey::Blocked(account), &blocked);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&TokKey::Bal(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let blocked: bool = env
            .storage()
            .persistent()
            .get(&TokKey::Blocked(to.clone()))
            .unwrap_or(false);
        if blocked {
            panic!("recipient trustline missing");
        }
        let from_bal = Self::balance(env.clone(), from.clone());
        assert!(from_bal >= amount, "insufficient balance");
        env.storage()
            .persistent()
            .set(&TokKey::Bal(from), &(from_bal - amount));
        let to_bal = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&TokKey::Bal(to), &(to_bal + amount));
    }
}

struct RotationWorld {
    world: World,
    key_epoch_1: SigningKey,
    key_epoch_2: SigningKey,
    recipient: Address,
}

impl RotationWorld {
    fn new() -> Self {
        let world = World::new();
        let key_epoch_1 = SigningKey::from_bytes(&[0x31u8; 32]);
        let key_epoch_2 = SigningKey::from_bytes(&[0x32u8; 32]);
        let pk_1 = BytesN::from_array(&world.env, &key_epoch_1.verifying_key().to_bytes());

        world.adapter().set_validator(&pk_1);
        world.run_action(AdminAction::SetRailReceiver(
            RouteKind::Allbridge,
            world.adapter_id.clone(),
        ));

        let recipient = Address::generate(&world.env);
        Self {
            world,
            key_epoch_1,
            key_epoch_2,
            recipient,
        }
    }

    fn pk(&self, sk: &SigningKey) -> BytesN<32> {
        BytesN::from_array(&self.world.env, &sk.verifying_key().to_bytes())
    }

    fn sign_for_epoch(
        &self,
        sk: &SigningKey,
        token: &Address,
        amount: i128,
        recipient: &Address,
        source_chain_id: u32,
        nonce: &U256,
        epoch: u64,
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
        let digest = self
            .world
            .adapter()
            .epoch_signing_digest(&message_id, &epoch);
        let sig = sk.sign(&digest.to_array());
        (message_id, BytesN::from_array(env, &sig.to_bytes()))
    }
}

#[test]
fn bootstrap_is_one_shot_and_rotation_waits_configured_trust_change_delay() {
    let s = RotationWorld::new();
    assert_eq!(s.world.adapter().validator_epoch(), 1);
    assert_eq!(
        s.world.adapter().trust_change_delay(),
        DEFAULT_TRUST_CHANGE_DELAY
    );

    // Direct overwrite after epoch 1 is refused.
    let pk_2 = s.pk(&s.key_epoch_2);
    assert_eq!(
        s.world.adapter().try_set_validator(&pk_2),
        Err(Ok(HyperionError::AlreadyConfigured))
    );

    // Zero public key is refused on both bootstrap and rotation queue.
    let zero_pk = BytesN::from_array(&s.world.env, &[0u8; 32]);
    assert_eq!(
        s.world.adapter().try_queue_validator_rotation(&zero_pk),
        Err(Ok(HyperionError::ZeroAddressKey))
    );

    // Trust-change delay enforces [MIN_TRUST_CHANGE_DELAY, MAX_TRUST_CHANGE_DELAY].
    assert_eq!(
        s.world
            .adapter()
            .try_set_trust_change_delay(&(MIN_TRUST_CHANGE_DELAY - 1)),
        Err(Ok(HyperionError::TimelockDelayOutOfRange))
    );
    assert_eq!(
        s.world
            .adapter()
            .try_set_trust_change_delay(&(MAX_TRUST_CHANGE_DELAY + 1)),
        Err(Ok(HyperionError::TimelockDelayOutOfRange))
    );

    let custom_delay = 7_200u64;
    s.world.adapter().set_trust_change_delay(&custom_delay);
    assert_eq!(s.world.adapter().trust_change_delay(), custom_delay);

    let now = s.world.env.ledger().timestamp();
    let pending = s.world.adapter().queue_validator_rotation(&pk_2);
    assert_eq!(pending.next_epoch, 2);
    assert_eq!(pending.eta, now + custom_delay);
    assert_eq!(
        pending.expires_at,
        now + custom_delay + ROTATION_GRACE_PERIOD
    );

    // Delay cannot be changed while a rotation is pending.
    assert_eq!(
        s.world
            .adapter()
            .try_set_trust_change_delay(&MIN_TRUST_CHANGE_DELAY),
        Err(Ok(HyperionError::AlreadyConfigured))
    );

    // Execution 1 second before `eta` fails with TimelockNotReady.
    s.world.env.ledger().with_mut(|li| {
        li.timestamp = pending.eta - 1;
    });
    assert_eq!(
        s.world.adapter().try_execute_validator_rotation(),
        Err(Ok(HyperionError::TimelockNotReady))
    );
    assert_eq!(s.world.adapter().validator_epoch(), 1);

    // At `eta`, execution succeeds and advances to epoch 2.
    s.world.env.ledger().with_mut(|li| {
        li.timestamp = pending.eta;
    });
    let activated = s.world.adapter().execute_validator_rotation();
    assert_eq!(activated.epoch, 2);
    assert_eq!(activated.validator, pk_2);
    assert!(!activated.emergency_disabled);
    assert_eq!(s.world.adapter().pending_validator_rotation(), None);
}

#[test]
fn old_signatures_cannot_be_reinterpreted_under_a_new_validator_epoch() {
    let s = RotationWorld::new();
    let amount = HUNDRED;
    s.world.fund_user(amount * 4);

    // Pre-sign an undelivered message under epoch 1 using key_epoch_1.
    let nonce_stale = U256::from_u32(&s.world.env, 701);
    let (_msg_stale, sig_epoch_1) = s.sign_for_epoch(
        &s.key_epoch_1,
        &s.world.token_id,
        amount,
        &s.recipient,
        ETH_CHAIN_ID,
        &nonce_stale,
        1,
    );

    // Rotate to key_epoch_2 (epoch 2).
    let pk_2 = s.pk(&s.key_epoch_2);
    let pending_2 = s.world.adapter().queue_validator_rotation(&pk_2);
    s.world.env.ledger().with_mut(|li| {
        li.timestamp = pending_2.eta;
    });
    s.world.adapter().execute_validator_rotation();
    assert_eq!(s.world.adapter().validator_epoch(), 2);

    // Epoch 1 signature fails on `bridge_in` AND returns `UnsupportedMessageVersion` on
    // `bridge_in_at_epoch(..., 1, ...)`.
    assert_eq!(
        s.world.adapter().try_bridge_in_at_epoch(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce_stale,
            &1,
            &sig_epoch_1,
        ),
        Err(Ok(HyperionError::UnsupportedMessageVersion))
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
            &nonce_stale,
            &sig_epoch_1,
        )
        .is_err());

    // Now rotate BACK to the original key_epoch_1 at epoch 3!
    // Even with the exact same Ed25519 key active again, the old epoch 1 signature MUST still fail
    // because `validator_epoch` is bound inside the signed digest.
    let pk_1 = s.pk(&s.key_epoch_1);
    let pending_3 = s.world.adapter().queue_validator_rotation(&pk_1);
    s.world.env.ledger().with_mut(|li| {
        li.timestamp = pending_3.eta;
    });
    let state_3 = s.world.adapter().execute_validator_rotation();
    assert_eq!(state_3.epoch, 3);
    assert_eq!(state_3.validator, pk_1);

    assert!(s
        .world
        .adapter()
        .try_bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce_stale,
            &sig_epoch_1,
        )
        .is_err());
    assert_eq!(s.world.token().balance(&s.recipient), 0);

    // A fresh signature explicitly bound to epoch 3 succeeds.
    let (_msg_3, sig_epoch_3) = s.sign_for_epoch(
        &s.key_epoch_1,
        &s.world.token_id,
        amount,
        &s.recipient,
        ETH_CHAIN_ID,
        &nonce_stale,
        3,
    );
    assert_eq!(
        s.world.adapter().bridge_in(
            &s.world.user,
            &s.world.token_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce_stale,
            &sig_epoch_3,
        ),
        0
    );
    assert_eq!(s.world.token().balance(&s.recipient), amount);
}

#[test]
fn emergency_disable_prevents_further_acceptance_without_losing_parked_claims() {
    let s = RotationWorld::new();
    let amount = HUNDRED;

    // Register a toggleable token so we can park an inbound claim, trigger emergency disable,
    // verify new arrivals are blocked, and then unblock the recipient and settle the parked claim!
    let tok_id = s.world.env.register(ToggleableToken, ());
    let tok = ToggleableTokenClient::new(&s.world.env, &tok_id);
    tok.mint(&s.world.user, &(amount * 3));
    s.world
        .bridge()
        .add_pool(&s.world.pool_id, &s.world.token_key(&tok_id));
    s.world
        .adapter()
        .link_asset(&tok_id, &s.world.ethereum(), &s.world.receive_token());
    s.world.run_action(AdminAction::RegisterToken(
        tok_id.clone(),
        STELLAR_DECIMALS,
        FLOW_LIMIT,
    ));

    // Block recipient so the router parks delivery #1 as claim_id = 1.
    tok.set_blocked(&s.recipient, &true);
    let nonce_1 = U256::from_u32(&s.world.env, 801);
    let (_msg_1, sig_1) = s.sign_for_epoch(
        &s.key_epoch_1,
        &tok_id,
        amount,
        &s.recipient,
        ETH_CHAIN_ID,
        &nonce_1,
        1,
    );
    let claim_id = s.world.adapter().bridge_in(
        &s.world.user,
        &tok_id,
        &amount,
        &s.recipient,
        &ETH_CHAIN_ID,
        &nonce_1,
        &sig_1,
    );
    assert_eq!(claim_id, 1);
    assert!(!s.world.router().get_claim(&claim_id).settled);

    // Queue a pending rotation, then hit emergency disable: both active acceptance AND any queued
    // rotation are stopped immediately.
    let pk_2 = s.pk(&s.key_epoch_2);
    s.world.adapter().queue_validator_rotation(&pk_2);
    let disabled_state = s.world.adapter().emergency_disable_validator();
    assert!(disabled_state.emergency_disabled);
    assert_eq!(s.world.adapter().pending_validator_rotation(), None);

    // Any further inbound message is refused with `RouteDisabled`.
    let nonce_2 = U256::from_u32(&s.world.env, 802);
    let (_msg_2, sig_2) = s.sign_for_epoch(
        &s.key_epoch_1,
        &tok_id,
        amount,
        &s.recipient,
        ETH_CHAIN_ID,
        &nonce_2,
        1,
    );
    assert_eq!(
        s.world.adapter().try_bridge_in(
            &s.world.user,
            &tok_id,
            &amount,
            &s.recipient,
            &ETH_CHAIN_ID,
            &nonce_2,
            &sig_2,
        ),
        Err(Ok(HyperionError::RouteDisabled))
    );

    // Meanwhile, the recipient unblocks their account and settles the parked claim on the router
    // without losing a single stroop!
    tok.set_blocked(&s.recipient, &false);
    s.world.router().settle_claim(&s.world.relayer, &claim_id);
    assert!(s.world.router().get_claim(&claim_id).settled);
    assert_eq!(tok.balance(&s.recipient), amount);

    // Recovery after emergency disable requires a fresh delayed rotation into epoch 2.
    let recovery = s.world.adapter().queue_validator_rotation(&pk_2);
    s.world.env.ledger().with_mut(|li| {
        li.timestamp = recovery.eta;
    });
    let recovered = s.world.adapter().execute_validator_rotation();
    assert_eq!(recovered.epoch, 2);
    assert!(!recovered.emergency_disabled);
}

#[test]
fn expired_or_cancelled_rotation_cannot_be_executed() {
    let s = RotationWorld::new();
    let pk_2 = s.pk(&s.key_epoch_2);

    // Cancel path.
    s.world.adapter().queue_validator_rotation(&pk_2);
    s.world.adapter().cancel_validator_rotation();
    assert_eq!(
        s.world.adapter().try_execute_validator_rotation(),
        Err(Ok(HyperionError::TimelockNotQueued))
    );

    // Expiry path.
    let pending = s.world.adapter().queue_validator_rotation(&pk_2);
    s.world.env.ledger().with_mut(|li| {
        li.timestamp = pending.expires_at + 1;
    });
    assert_eq!(
        s.world.adapter().try_execute_validator_rotation(),
        Err(Ok(HyperionError::TimelockExpired))
    );
    assert_eq!(s.world.adapter().validator_epoch(), 1);
}
