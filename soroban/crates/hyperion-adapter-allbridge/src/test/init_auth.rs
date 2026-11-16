//! Authorization, anti-hijack, reinitialization, and deployment-rehearsal tests for Allbridge
//! adapter initialization.

use hyperion_core::{codec, HyperionError};
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal,
};

use super::allbridge::{MockBridge, MockBridgeClient, MockMessenger, MockMessengerClient};
use super::setup::ETH_CHAIN_ID;
use crate::{AllbridgeAdapter, AllbridgeAdapterClient};

struct UnmockedDeployHarness {
    env: Env,
    intended_admin: Address,
    attacker: Address,
    router_id: Address,
    attacker_router_id: Address,
    bridge_id: Address,
    native_id: Address,
    adapter_id: Address,
}

impl UnmockedDeployHarness {
    /// Construct a deployment environment WITHOUT `mock_all_auths`, so every signature requirement
    /// is enforced identically to live Soroban host execution.
    fn new() -> Self {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.sequence_number = 250_000;
            li.timestamp = 1_710_000_000;
            li.min_persistent_entry_ttl = 4096;
            li.min_temp_entry_ttl = 16;
            li.max_entry_ttl = 6_312_000;
        });

        let intended_admin = Address::generate(&env);
        let attacker = Address::generate(&env);
        let issuer = Address::generate(&env);
        let rebalancer = Address::generate(&env);

        let native_id = env.register_stellar_asset_contract_v2(issuer).address();
        let router_id = env.register(MockMessenger, ());
        let attacker_router_id = env.register(MockMessenger, ());
        let messenger_id = env.register(MockMessenger, ());
        MockMessengerClient::new(&env, &messenger_id).initialize(&native_id);

        let bridge_id = env.register(MockBridge, ());
        MockBridgeClient::new(&env, &bridge_id).initialize(&native_id, &messenger_id, &rebalancer);
        MockBridgeClient::new(&env, &bridge_id).register_bridge(
            &ETH_CHAIN_ID,
            &soroban_sdk::BytesN::from_array(&env, &[0xE1; 32]),
        );

        let adapter_id = env.register(AllbridgeAdapter, ());
        Self {
            env,
            intended_admin,
            attacker,
            router_id,
            attacker_router_id,
            bridge_id,
            native_id,
            adapter_id,
        }
    }

    fn adapter(&self) -> AllbridgeAdapterClient<'_> {
        AllbridgeAdapterClient::new(&self.env, &self.adapter_id)
    }
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn unauthenticated_caller_cannot_initialize_adapter_with_attacker_router() {
    let h = UnmockedDeployHarness::new();
    // No auth provided: attacker tries to name `intended_admin` while binding `attacker_router_id`.
    h.env.set_auths(&[]);
    h.adapter().initialize(
        &h.intended_admin,
        &h.attacker_router_id,
        &h.bridge_id,
        &h.native_id,
    );
}

#[test]
fn attacker_auth_cannot_impersonate_intended_admin_and_frontrun_is_caught_by_authority_check() {
    let h = UnmockedDeployHarness::new();

    // 1. Signing as `attacker` while passing `intended_admin` as the `admin` parameter fails host
    //    authorization and leaves the contract uninitialized.
    h.env.mock_auths(&[MockAuth {
        address: &h.attacker,
        invoke: &MockAuthInvoke {
            contract: &h.adapter_id,
            fn_name: "initialize",
            args: (
                h.intended_admin.clone(),
                h.attacker_router_id.clone(),
                h.bridge_id.clone(),
                h.native_id.clone(),
            )
                .into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    assert!(h
        .adapter()
        .try_initialize(
            &h.intended_admin,
            &h.attacker_router_id,
            &h.bridge_id,
            &h.native_id,
        )
        .is_err());
    assert_eq!(
        h.adapter().try_get_config(),
        Err(Ok(HyperionError::NotInitialized))
    );

    // 2. If an attacker front-runs an uninitialized deployment by signing `initialize` as
    //    `h.attacker` themselves, `verify_admin_authority` rejects the deployed instance with
    //    `HyperionError::Unauthorized` before the router ever wires `SetAdapter`.
    h.env.mock_auths(&[MockAuth {
        address: &h.attacker,
        invoke: &MockAuthInvoke {
            contract: &h.adapter_id,
            fn_name: "initialize",
            args: (
                h.attacker.clone(),
                h.attacker_router_id.clone(),
                h.bridge_id.clone(),
                h.native_id.clone(),
            )
                .into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    h.adapter().initialize(
        &h.attacker,
        &h.attacker_router_id,
        &h.bridge_id,
        &h.native_id,
    );

    assert_eq!(
        h.adapter().try_verify_admin_authority(
            &h.intended_admin,
            &h.router_id,
            &h.bridge_id,
            &h.native_id,
        ),
        Err(Ok(HyperionError::Unauthorized))
    );
}

#[test]
fn invalid_contract_wiring_is_rejected_during_initialization() {
    let h = UnmockedDeployHarness::new();
    let classic_account = Address::from_string(&codec::account_strkey(&h.env, &[0x55u8; 32]));

    // Classic G-account passed where a contract address is required -> NotEvmAddress (from
    // `codec::contract_key`) and adapter stays uninitialized.
    h.env.mock_auths(&[MockAuth {
        address: &h.intended_admin,
        invoke: &MockAuthInvoke {
            contract: &h.adapter_id,
            fn_name: "initialize",
            args: (
                h.intended_admin.clone(),
                classic_account.clone(),
                h.bridge_id.clone(),
                h.native_id.clone(),
            )
                .into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    assert!(h
        .adapter()
        .try_initialize(
            &h.intended_admin,
            &classic_account,
            &h.bridge_id,
            &h.native_id,
        )
        .is_err());

    // Duplicate contract roles (`router == bridge`) -> UnexpectedRailContract.
    h.env.mock_auths(&[MockAuth {
        address: &h.intended_admin,
        invoke: &MockAuthInvoke {
            contract: &h.adapter_id,
            fn_name: "initialize",
            args: (
                h.intended_admin.clone(),
                h.bridge_id.clone(),
                h.bridge_id.clone(),
                h.native_id.clone(),
            )
                .into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(
        h.adapter()
            .try_initialize(&h.intended_admin, &h.bridge_id, &h.bridge_id, &h.native_id,),
        Err(Ok(HyperionError::UnexpectedRailContract))
    );
    assert_eq!(
        h.adapter().try_get_config(),
        Err(Ok(HyperionError::NotInitialized))
    );
}

#[test]
fn reinitialization_cannot_replace_live_admin_or_router() {
    let h = UnmockedDeployHarness::new();

    h.env.mock_auths(&[MockAuth {
        address: &h.intended_admin,
        invoke: &MockAuthInvoke {
            contract: &h.adapter_id,
            fn_name: "initialize",
            args: (
                h.intended_admin.clone(),
                h.router_id.clone(),
                h.bridge_id.clone(),
                h.native_id.clone(),
            )
                .into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    h.adapter()
        .initialize(&h.intended_admin, &h.router_id, &h.bridge_id, &h.native_id);

    // Attacker tries to reinitialize with their own signature.
    h.env.mock_auths(&[MockAuth {
        address: &h.attacker,
        invoke: &MockAuthInvoke {
            contract: &h.adapter_id,
            fn_name: "initialize",
            args: (
                h.attacker.clone(),
                h.attacker_router_id.clone(),
                h.bridge_id.clone(),
                h.native_id.clone(),
            )
                .into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(
        h.adapter().try_initialize(
            &h.attacker,
            &h.attacker_router_id,
            &h.bridge_id,
            &h.native_id,
        ),
        Err(Ok(HyperionError::AlreadyInitialized))
    );

    // Even the live admin cannot reinitialize to swap the router in-place.
    h.env.mock_auths(&[MockAuth {
        address: &h.intended_admin,
        invoke: &MockAuthInvoke {
            contract: &h.adapter_id,
            fn_name: "initialize",
            args: (
                h.intended_admin.clone(),
                h.attacker_router_id.clone(),
                h.bridge_id.clone(),
                h.native_id.clone(),
            )
                .into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(
        h.adapter().try_initialize(
            &h.intended_admin,
            &h.attacker_router_id,
            &h.bridge_id,
            &h.native_id,
        ),
        Err(Ok(HyperionError::AlreadyInitialized))
    );

    let cfg = h.adapter().get_config();
    assert_eq!(cfg.admin, h.intended_admin);
    assert_eq!(cfg.router, h.router_id);
}

#[test]
fn deployment_rehearsal_proves_intended_identity_controls_initialization() {
    let h = UnmockedDeployHarness::new();

    // Step 1: Intended admin signs `initialize`.
    h.env.mock_auths(&[MockAuth {
        address: &h.intended_admin,
        invoke: &MockAuthInvoke {
            contract: &h.adapter_id,
            fn_name: "initialize",
            args: (
                h.intended_admin.clone(),
                h.router_id.clone(),
                h.bridge_id.clone(),
                h.native_id.clone(),
            )
                .into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    h.adapter()
        .initialize(&h.intended_admin, &h.router_id, &h.bridge_id, &h.native_id);

    // Step 2: Read-only manifest check passes for exact wiring and fails on mismatched router.
    let record = h.adapter().verify_admin_authority(
        &h.intended_admin,
        &h.router_id,
        &h.bridge_id,
        &h.native_id,
    );
    assert_eq!(record.admin, h.intended_admin);
    assert_eq!(record.router, h.router_id);
    assert_eq!(record.initialized_ledger, 250_000);
    assert_eq!(record.initialized_timestamp, 1_710_000_000);

    assert_eq!(
        h.adapter().try_verify_admin_authority(
            &h.intended_admin,
            &h.attacker_router_id,
            &h.bridge_id,
            &h.native_id,
        ),
        Err(Ok(HyperionError::UnexpectedRailContract))
    );

    // Step 3: Authenticated deployment rehearsal (`confirm_admin_authority`) proves `intended_admin`
    // both matches `cfg.admin` and actively signs, then exercises an admin-gated lane link.
    h.env.mock_auths(&[MockAuth {
        address: &h.intended_admin,
        invoke: &MockAuthInvoke {
            contract: &h.adapter_id,
            fn_name: "confirm_admin_authority",
            args: (
                h.intended_admin.clone(),
                h.router_id.clone(),
                h.bridge_id.clone(),
                h.native_id.clone(),
            )
                .into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    let confirmed = h.adapter().confirm_admin_authority(
        &h.intended_admin,
        &h.router_id,
        &h.bridge_id,
        &h.native_id,
    );
    assert_eq!(confirmed, record);

    let eth = soroban_sdk::String::from_str(&h.env, "ethereum");
    h.env.mock_auths(&[MockAuth {
        address: &h.intended_admin,
        invoke: &MockAuthInvoke {
            contract: &h.adapter_id,
            fn_name: "link_chain",
            args: (eth.clone(), ETH_CHAIN_ID).into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    h.adapter().link_chain(&eth, &ETH_CHAIN_ID);
    assert_eq!(h.adapter().get_lane(&eth).allbridge_chain_id, ETH_CHAIN_ID);
}
