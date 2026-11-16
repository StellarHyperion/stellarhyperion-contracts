//! Explicit Allbridge token-pool admission validation tests.

use hyperion_core::{
    codec::account_strkey, AddressKind, HyperionError, StellarDestination, STELLAR_DECIMALS,
};
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};

use super::allbridge::{MockPool, MockPoolClient};
use super::setup::{World, ETH_CHAIN_ID, GAS_FLOAT, HUNDRED, POOL_FEE_BPS};

#[contract]
pub struct ExcessiveDecimalsToken;

#[contractimpl]
impl ExcessiveDecimalsToken {
    pub fn decimals(_env: Env) -> u32 {
        42
    }
}

fn alt_receive_token(w: &World) -> BytesN<32> {
    let mut raw = [0u8; 32];
    raw[12..].copy_from_slice(&[0xB1; 20]);
    BytesN::from_array(&w.env, &raw)
}

#[test]
fn wrong_token_precision_and_pool_mappings_fail_before_user_assets_move() {
    let w = World::unlinked();
    w.link_ethereum();
    w.fund_user(HUNDRED * 10);
    w.fund_gas(GAS_FLOAT);

    // 1. Native gas-float asset is protected from admission as a bridged token.
    assert_eq!(
        w.adapter()
            .try_link_asset(&w.native_id, &w.ethereum(), &w.receive_token()),
        Err(Ok(HyperionError::ProtectedAsset))
    );

    // 2. Classic G-account or non-SEP-41 contract fails token validation.
    let classic = Address::from_string(&account_strkey(&w.env, &[0x24u8; 32]));
    assert_eq!(
        w.adapter()
            .try_link_asset(&classic, &w.ethereum(), &w.receive_token()),
        Err(Ok(HyperionError::NotEvmAddress))
    );
    w.bridge()
        .add_pool(&w.pool_id, &w.token_key(&w.messenger_id));
    assert_eq!(
        w.adapter()
            .try_link_asset(&w.messenger_id, &w.ethereum(), &w.receive_token()),
        Err(Ok(HyperionError::UnexpectedRailContract))
    );

    // 3. Token precision above MAX_DECIMALS (38) or mismatched expected_decimals is rejected.
    let bad_dec_token = w.env.register(ExcessiveDecimalsToken, ());
    w.bridge()
        .add_pool(&w.pool_id, &w.token_key(&bad_dec_token));
    assert_eq!(
        w.adapter()
            .try_link_asset(&bad_dec_token, &w.ethereum(), &w.receive_token()),
        Err(Ok(HyperionError::InvalidDecimals))
    );
    assert_eq!(
        w.adapter().try_admit_asset(
            &w.token_id,
            &w.ethereum(),
            &w.pool_id,
            &6u32,
            &w.receive_token(),
        ),
        Err(Ok(HyperionError::InvalidDecimals))
    );

    // 4. Zero receive_token and self/rail pool miswiring are rejected at admission.
    assert_eq!(
        w.adapter()
            .try_link_asset(&w.token_id, &w.ethereum(), &w.zero_word()),
        Err(Ok(HyperionError::ZeroAddressKey))
    );
    w.bridge().add_pool(&w.bridge_id, &w.token_key(&w.token_id));
    assert_eq!(
        w.adapter()
            .try_link_asset(&w.token_id, &w.ethereum(), &w.receive_token()),
        Err(Ok(HyperionError::UnexpectedRailContract))
    );

    // Restore valid pool and admit with pinned pool + 7 decimals.
    w.bridge().add_pool(&w.pool_id, &w.token_key(&w.token_id));
    let report = w.adapter().admit_asset(
        &w.token_id,
        &w.ethereum(),
        &w.pool_id,
        &STELLAR_DECIMALS,
        &w.receive_token(),
    );
    assert_eq!(report.pool, w.pool_id);
    assert_eq!(report.local_decimals, STELLAR_DECIMALS);

    // 5. If Allbridge repoints the token to an unexpected pool after pinned admission,
    // outbound dispatch aborts BEFORE user funds or gas float move.
    let rogue_pool = w.env.register(MockPool, ());
    MockPoolClient::new(&w.env, &rogue_pool).initialize(&w.bridge_id, &w.token_id, &POOL_FEE_BPS);
    w.bridge().add_pool(&rogue_pool, &w.token_key(&w.token_id));

    let user_before = w.token().balance(&w.user);
    assert_eq!(
        w.router().try_bridge_out(&w.user, &w.request(HUNDRED)),
        Err(Ok(HyperionError::UnexpectedRailContract))
    );
    assert_eq!(w.token().balance(&w.user), user_before);
    assert_eq!(w.pool().sold(), 0);
    assert_eq!(MockPoolClient::new(&w.env, &rogue_pool).sold(), 0);
    assert_eq!(w.adapter().gas_balance(), GAS_FLOAT);
}

#[test]
fn muxed_recipients_remain_rejected_in_admission_and_inbound_delivery() {
    let w = World::new();

    // Dry-run admission explicitly rejects MuxedAccount recipient capability on Allbridge.
    assert_eq!(
        w.adapter().try_validate_asset_admission(
            &w.token_id,
            &w.ethereum(),
            &Some(w.pool_id.clone()),
            &Some(STELLAR_DECIMALS),
            &w.receive_token(),
            &Some(AddressKind::MuxedAccount),
        ),
        Err(Ok(HyperionError::MuxedNotSupported))
    );

    let ok_report = w.adapter().validate_asset_admission(
        &w.token_id,
        &w.ethereum(),
        &Some(w.pool_id.clone()),
        &Some(STELLAR_DECIMALS),
        &w.receive_token(),
        &Some(AddressKind::Account),
    );
    assert!(!ok_report.muxed_recipients_supported);

    // Qualified StellarDestination muxed recipients are also rejected because the 32-byte
    // Allbridge recipient slot cannot carry a 64-bit muxed sub-account ID.
    let muxed = StellarDestination::muxed(BytesN::from_array(&w.env, &[0x33u8; 32]), 9_001);
    assert_eq!(
        w.adapter().try_validate_recipient_admission(&muxed),
        Err(Ok(HyperionError::MuxedNotSupported))
    );
    let plain = StellarDestination::account(BytesN::from_array(&w.env, &[0x33u8; 32]));
    w.adapter().validate_recipient_admission(&plain);
}

#[test]
fn revalidation_never_silently_overwrites_live_mappings() {
    let w = World::new();
    let alt = alt_receive_token(&w);
    w.bridge().add_bridge_token(&ETH_CHAIN_ID, &alt);

    // Revalidating an existing mapping succeeds and leaves the live AssetLink untouched.
    let revalidated = w.adapter().revalidate_asset(&w.token_id, &w.ethereum());
    assert_eq!(revalidated.receive_token, w.receive_token());
    w.adapter()
        .link_asset(&w.token_id, &w.ethereum(), &w.receive_token());
    assert_eq!(
        w.adapter()
            .get_asset(&w.token_id, &w.ethereum())
            .receive_token,
        w.receive_token()
    );

    // Attempting to map a second valid remote token onto the same live (token, chain) fails
    // with AlreadyConfigured rather than silently overwriting the active mapping.
    assert_eq!(
        w.adapter().try_link_asset(&w.token_id, &w.ethereum(), &alt),
        Err(Ok(HyperionError::AlreadyConfigured))
    );
    assert_eq!(
        w.adapter().try_admit_asset(
            &w.token_id,
            &w.ethereum(),
            &w.pool_id,
            &STELLAR_DECIMALS,
            &alt,
        ),
        Err(Ok(HyperionError::AlreadyConfigured))
    );
    assert_eq!(
        w.adapter()
            .get_asset(&w.token_id, &w.ethereum())
            .receive_token,
        w.receive_token()
    );

    // Explicit unlink_asset is required before installing a replacement mapping.
    w.adapter().unlink_asset(&w.token_id, &w.ethereum());
    w.adapter().admit_asset(
        &w.token_id,
        &w.ethereum(),
        &w.pool_id,
        &STELLAR_DECIMALS,
        &alt,
    );
    assert_eq!(
        w.adapter()
            .get_asset(&w.token_id, &w.ethereum())
            .receive_token,
        alt
    );
    assert_eq!(
        w.adapter()
            .get_admission(&w.token_id, &w.ethereum())
            .pinned_pool,
        Some(w.pool_id)
    );
}
