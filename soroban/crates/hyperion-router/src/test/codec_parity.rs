//! Compare production manual codecs with the independent native SDK derives.
extern crate std;

use crate::{
    action_codec, key_codec, storage, AdminAction, DataKey, HyperionRouter, HyperionRouterClient,
    QueuedAction, RouteConfig, CURRENT_SCHEMA_VERSION, MIN_TIMELOCK_DELAY,
};
use hyperion_core::RouteKind;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    xdr::{FromXdr, Limits, ReadXdr, ScVal, ToXdr},
    Address, BytesN, ConversionError, Env, Error, IntoVal, Map, String, Symbol, TryFromVal, Val,
    Vec,
};
use std::panic::{catch_unwind, AssertUnwindSafe};

fn actions(
    env: &Env,
    address: &Address,
    route: RouteKind,
    signed: i128,
    wide: u64,
) -> [AdminAction; 17] {
    [
        AdminAction::SetFeeBps(u32::MAX),
        AdminAction::SetTreasury(address.clone()),
        AdminAction::SetAdmin(address.clone()),
        AdminAction::SetGuardian(address.clone()),
        AdminAction::SetAdapter(route, address.clone()),
        AdminAction::SetRailReceiver(route, address.clone()),
        AdminAction::EnableRoute(route),
        AdminAction::RegisterToken(address.clone(), u32::MAX, signed),
        AdminAction::RaiseTokenFlowLimit(address.clone(), signed),
        AdminAction::SetRouteFlowLimit(address.clone(), route, signed),
        AdminAction::SetTimelockDelay(wide),
        AdminAction::SetFlowWindow(u32::MAX),
        AdminAction::Upgrade(BytesN::from_array(env, &[0xA5; 32])),
        AdminAction::SetRouteConfig(
            route,
            RouteConfig {
                max_single_transfer: signed,
            },
        ),
        AdminAction::SetRouteMaxSingleTransfer(route, signed),
        AdminAction::SetDestinationFlowLimit(
            address.clone(),
            route,
            String::from_str(env, "chain\0雪/long-destination-name"),
            signed,
        ),
        AdminAction::BeginStorageMigration(u32::MAX),
    ]
}

fn keys(env: &Env, address: &Address, route: RouteKind, wide: u64) -> [DataKey; 26] {
    let chain = String::from_str(env, "chain\0雪/long-destination-name");
    [
        DataKey::Config,
        DataKey::LiabilityTracking,
        DataKey::OutNonce,
        DataKey::Adapter(route),
        DataKey::RailReceiver(route),
        DataKey::RouteEnabled(route),
        DataKey::RouteConfig(route),
        DataKey::Token(address.clone()),
        DataKey::RouteFlowLimit(address.clone(), route),
        DataKey::Flow(address.clone(), route),
        DataKey::DestinationFlowLimit(address.clone(), route, chain.clone()),
        DataKey::DestinationFlow(address.clone(), route, chain),
        DataKey::Transfer(wide),
        DataKey::Processed(route, BytesN::from_array(env, &[0x5A; 32])),
        DataKey::Claim(wide),
        DataKey::ClaimSeq,
        DataKey::Queued(wide),
        DataKey::QueueSeq,
        DataKey::SchemaVersion,
        DataKey::ResolvedAction(wide),
        DataKey::MigrationState,
        DataKey::ClaimFailure(wide),
        DataKey::ClaimProvenance(wide),
        DataKey::ClaimLiability(address.clone()),
        DataKey::ClaimSettledAt(wide),
        DataKey::ClaimArchiveWord(wide),
    ]
}

fn canonical(env: &Env, value: Val) -> ScVal {
    <ScVal as ReadXdr>::from_xdr(
        value.to_xdr(env).iter().collect::<std::vec::Vec<_>>(),
        Limits::none(),
    )
    .unwrap()
}

fn assert_action_parity(env: &Env, action: &AdminAction) {
    let sdk: Val = action.into_val(env);
    let manual = action_codec::encode(env, action).unwrap();
    assert_eq!(
        Vec::<Val>::try_from_val(env, &manual).unwrap(),
        Vec::<Val>::try_from_val(env, &sdk).unwrap()
    );
    assert_eq!(canonical(env, manual), ScVal::try_from(action).unwrap());
    assert_eq!(manual.to_xdr(env), sdk.to_xdr(env));
    assert_eq!(action_codec::decode(env, &sdk).unwrap(), *action);
    assert_eq!(AdminAction::try_from_val(env, &manual).unwrap(), *action);
    assert_eq!(
        AdminAction::from_xdr(env, &manual.to_xdr(env)).unwrap(),
        *action
    );
}

#[test]
fn all_17_action_variants_match_sdk_val_and_xdr_at_full_width_boundaries() {
    let env = Env::default();
    // Exhaustive ABI comparisons are not a transaction gas benchmark.
    env.cost_estimate().budget().reset_unlimited();
    let contract = Address::generate(&env);
    let account = Address::from_str(
        &env,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    for address in [contract, account] {
        for route in [
            RouteKind::Cctp,
            RouteKind::AxelarIts,
            RouteKind::AxelarGmp,
            RouteKind::Allbridge,
        ] {
            for (signed, wide) in [
                (i128::MIN, 0),
                (-1, 1),
                (0, u64::MAX),
                (1, u64::MAX - 1),
                (i128::MAX, 1u64 << 63),
            ] {
                for action in actions(&env, &address, route, signed, wide) {
                    assert_action_parity(&env, &action);
                }
            }
        }
    }
}

#[test]
fn all_26_storage_key_shapes_match_sdk_and_access_legacy_values_in_both_directions() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let contract = env.register(HyperionRouter, ());
    let account = Address::from_str(
        &env,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    env.as_contract(&contract, || {
        for address in [&contract, &account] {
            for route in [
                RouteKind::Cctp,
                RouteKind::AxelarIts,
                RouteKind::AxelarGmp,
                RouteKind::Allbridge,
            ] {
                for wide in [0, 1, 1u64 << 63, u64::MAX] {
                    for (index, key) in keys(&env, address, route, wide).iter().enumerate() {
                        let sdk: Val = key.into_val(&env);
                        let manual = key_codec::encode(&env, key).unwrap();
                        assert_eq!(
                            Vec::<Val>::try_from_val(&env, &manual).unwrap(),
                            Vec::<Val>::try_from_val(&env, &sdk).unwrap()
                        );
                        assert_eq!(canonical(&env, manual), ScVal::try_from(key).unwrap());
                        assert_eq!(manual.to_xdr(&env), sdk.to_xdr(&env));
                        assert_eq!(DataKey::try_from_val(&env, &manual).unwrap(), *key);
                        let marker = index as u64 + 1;
                        env.storage().persistent().set(key, &marker);
                        assert_eq!(
                            env.storage().persistent().get::<Val, u64>(&manual),
                            Some(marker)
                        );
                        env.storage().persistent().set(&manual, &(marker + 100));
                        assert_eq!(
                            env.storage().persistent().get::<DataKey, u64>(key),
                            Some(marker + 100)
                        );
                        env.storage().instance().set(key, &marker);
                        assert_eq!(
                            env.storage().instance().get::<Val, u64>(&manual),
                            Some(marker)
                        );
                        env.storage().instance().set(&manual, &(marker + 100));
                        assert_eq!(
                            env.storage().instance().get::<DataKey, u64>(key),
                            Some(marker + 100)
                        );
                    }
                }
            }
        }
    });
}

#[derive(Debug, PartialEq, Eq)]
enum DecodeOutcome {
    Accepted(AdminAction),
    ConversionError,
    HostPanic,
}

fn outcome(f: impl FnOnce() -> Result<AdminAction, ConversionError>) -> DecodeOutcome {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(action)) => DecodeOutcome::Accepted(action),
        Ok(Err(_)) => DecodeOutcome::ConversionError,
        Err(_) => DecodeOutcome::HostPanic,
    }
}

fn assert_rejected_like_sdk(env: &Env, value: Val) {
    let sdk = outcome(|| AdminAction::try_from_val(env, &value));
    let manual = outcome(|| action_codec::decode(env, &value));
    assert!(
        !matches!(sdk, DecodeOutcome::Accepted(_)),
        "SDK accepted malformed case"
    );
    assert!(
        !matches!(manual, DecodeOutcome::Accepted(_)),
        "manual codec accepted malformed case"
    );
    assert_eq!(manual, sdk, "malformed rejection class differs from SDK");
}

#[test]
fn malformed_action_vectors_tags_arity_and_every_field_type_match_sdk_rejection() {
    let env = Env::default();
    let address = Address::generate(&env);
    for value in [
        Val::VOID.to_val(),
        false.into_val(&env),
        0u32.into_val(&env),
        Map::<Symbol, Val>::new(&env).into_val(&env),
        Vec::<Val>::new(&env).into_val(&env),
    ] {
        assert_rejected_like_sdk(&env, value);
    }
    for action in actions(&env, &address, RouteKind::Cctp, 99, u64::MAX) {
        let encoded: Val = action.into_val(&env);
        let valid = Vec::<Val>::try_from_val(&env, &encoded).unwrap();
        for length in 0..=8 {
            if length == valid.len() {
                continue;
            }
            let mut wrong_arity = valid.clone();
            while wrong_arity.len() > length {
                wrong_arity.pop_back();
            }
            while wrong_arity.len() < length {
                wrong_arity.push_back(Val::VOID.to_val());
            }
            assert_rejected_like_sdk(&env, wrong_arity.into_val(&env));
        }
        for bad_tag in [
            false.into_val(&env),
            String::from_str(&env, "SetFeeBps").into_val(&env),
            Symbol::new(&env, "UnknownAction").into_val(&env),
        ] {
            let mut bad = valid.clone();
            bad.set(0, bad_tag);
            assert_rejected_like_sdk(&env, bad.into_val(&env));
        }
        for field in 1..valid.len() {
            let mut bad = valid.clone();
            bad.set(field, Val::VOID.to_val());
            assert_rejected_like_sdk(&env, bad.into_val(&env));
        }
    }
}

#[test]
fn malformed_nested_routes_integer_widths_bytes_and_config_match_sdk_rejection() {
    let env = Env::default();
    let address = Address::generate(&env);
    let cases = [
        (AdminAction::SetFeeBps(1), 1, u64::MAX.into_val(&env)),
        (
            AdminAction::SetTimelockDelay(1),
            1,
            i128::MAX.into_val(&env),
        ),
        (
            AdminAction::Upgrade(BytesN::from_array(&env, &[7; 32])),
            1,
            BytesN::<31>::from_array(&env, &[7; 31]).into_val(&env),
        ),
        (
            AdminAction::SetAdapter(RouteKind::Cctp, address.clone()),
            1,
            4u32.into_val(&env),
        ),
        (
            AdminAction::SetRailReceiver(RouteKind::Cctp, address),
            1,
            Symbol::new(&env, "Cctp").into_val(&env),
        ),
        (
            AdminAction::SetRouteConfig(
                RouteKind::Cctp,
                RouteConfig {
                    max_single_transfer: 1,
                },
            ),
            2,
            Map::<Symbol, Val>::new(&env).into_val(&env),
        ),
    ];
    for (action, field, bad_value) in cases {
        let encoded: Val = action.into_val(&env);
        let mut bad = Vec::<Val>::try_from_val(&env, &encoded).unwrap();
        bad.set(field, bad_value);
        assert_rejected_like_sdk(&env, bad.into_val(&env));
    }
}

#[test]
fn queued_records_roundtrip_manual_actions_and_legacy_sdk_queue_keys() {
    let env = Env::default();
    let contract = env.register(HyperionRouter, ());
    env.as_contract(&contract, || {
        for (index, action) in actions(&env, &contract, RouteKind::Allbridge, i128::MAX, u64::MAX)
            .into_iter()
            .enumerate()
        {
            let id = u64::MAX - index as u64;
            let queued = QueuedAction {
                id,
                action: action.clone(),
                queued_at: 11,
                eta: 22,
                expires_at: u64::MAX,
            };
            let sdk: Val = queued.into_val(&env);
            let mut manual = Map::<Symbol, Val>::try_from_val(&env, &sdk).unwrap();
            manual.set(
                Symbol::new(&env, "action"),
                action_codec::encode(&env, &action).unwrap(),
            );
            let manual: Val = manual.into_val(&env);
            assert_eq!(manual.to_xdr(&env), sdk.to_xdr(&env));
            assert_eq!(QueuedAction::try_from_val(&env, &manual).unwrap(), queued);
            let sdk_key = DataKey::Queued(id);
            env.storage().persistent().set(&sdk_key, &manual);
            assert_eq!(storage::queued(&env, id), Some(queued.clone()));
            let manual_key = key_codec::encode(&env, &sdk_key).unwrap();
            assert_eq!(
                env.storage()
                    .persistent()
                    .get::<Val, QueuedAction>(&manual_key),
                Some(queued)
            );
        }
    });
}

#[test]
fn all_17_actions_roundtrip_through_public_queue_and_record_methods() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|info| {
        info.sequence_number = 100_000;
        info.timestamp = 1_700_000_000;
        info.min_persistent_entry_ttl = 4096;
        info.min_temp_entry_ttl = 16;
        info.max_entry_ttl = 6_312_000;
    });
    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let treasury = Address::generate(&env);
    let issuer = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(issuer).address();
    let router = if let Ok(path) = std::env::var("HYPERION_POLICY_ROUTER_WASM") {
        let wasm = std::fs::read(&path).expect("explicit router WASM must be readable");
        assert_eq!(&wasm[..4], b"\0asm");
        std::println!(
            "HYPERION_CODEC_RUNTIME=production-wasm bytes={} path={path}",
            wasm.len()
        );
        env.register(wasm.as_slice(), ())
    } else {
        std::println!("HYPERION_CODEC_RUNTIME=native guest_execution_proven=false");
        env.register(HyperionRouter, ())
    };
    let client = HyperionRouterClient::new(&env, &router);
    client.initialize(
        &admin,
        &guardian,
        &treasury,
        &10,
        &3600,
        &MIN_TIMELOCK_DELAY,
    );
    let route = RouteKind::Cctp;
    let queueable = [
        AdminAction::SetFeeBps(25),
        AdminAction::SetTreasury(treasury),
        AdminAction::SetAdmin(admin.clone()),
        AdminAction::SetGuardian(guardian.clone()),
        AdminAction::SetAdapter(route, guardian.clone()),
        AdminAction::SetRailReceiver(route, guardian),
        AdminAction::EnableRoute(route),
        AdminAction::RegisterToken(token.clone(), 7, 100_000_000),
        AdminAction::RaiseTokenFlowLimit(token.clone(), 200_000_000),
        AdminAction::SetRouteFlowLimit(token.clone(), route, 100_000_000),
        AdminAction::SetTimelockDelay(MIN_TIMELOCK_DELAY),
        AdminAction::SetFlowWindow(3600),
        AdminAction::Upgrade(BytesN::from_array(&env, &[0xA5; 32])),
        AdminAction::SetRouteConfig(
            route,
            RouteConfig {
                max_single_transfer: 50_000_000,
            },
        ),
        AdminAction::SetRouteMaxSingleTransfer(route, 50_000_000),
        AdminAction::SetDestinationFlowLimit(
            token,
            route,
            String::from_str(&env, "ethereum"),
            40_000_000,
        ),
        AdminAction::BeginStorageMigration(CURRENT_SCHEMA_VERSION),
    ];
    for (index, action) in queueable.into_iter().enumerate() {
        let id = client.queue_action(&admin, &action);
        assert_eq!(id, index as u64 + 1);
        let queued = client.get_queued(&id);
        assert_eq!(queued.id, id);
        assert_eq!(queued.action, action);
        assert_eq!(client.get_action_payload(&id), queued);
        let legacy = env.as_contract(&router, || {
            env.storage()
                .persistent()
                .get::<DataKey, QueuedAction>(&DataKey::Queued(id))
        });
        assert_eq!(legacy, Some(queued));
    }
}

#[test]
fn public_malformed_action_errors_match_native_sdk_reference_including_combined_faults() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let native = env.register(HyperionRouter, ());
    let guest = if let Ok(path) = std::env::var("HYPERION_POLICY_ROUTER_WASM") {
        let wasm = std::fs::read(&path).expect("explicit router WASM must be readable");
        std::println!(
            "HYPERION_CODEC_MALFORMED_RUNTIME=production-wasm bytes={} path={path}",
            wasm.len()
        );
        env.register(wasm.as_slice(), ())
    } else {
        std::println!("HYPERION_CODEC_MALFORMED_RUNTIME=native guest_execution_proven=false");
        env.register(HyperionRouter, ())
    };
    for router in [&native, &guest] {
        HyperionRouterClient::new(&env, router).initialize(
            &admin,
            &admin,
            &admin,
            &10,
            &3600,
            &MIN_TIMELOCK_DELAY,
        );
    }
    let check = |value: Val| {
        let args = Vec::from_array(&env, [admin.into_val(&env), value]);
        let method = Symbol::new(&env, "queue_action");
        let sdk_error = env
            .try_invoke_contract::<u64, Error>(&native, &method, args.clone())
            .expect_err("SDK reference must reject malformed action")
            .expect("SDK rejection must preserve its typed host error");
        let guest_error = env
            .try_invoke_contract::<u64, Error>(&guest, &method, args)
            .expect_err("guest must reject malformed action")
            .expect("guest rejection must preserve its typed host error");
        assert_eq!(
            guest_error, sdk_error,
            "public malformed-input host error differs"
        );
    };
    for action in actions(&env, &admin, RouteKind::Cctp, 99, 100) {
        let encoded: Val = action.into_val(&env);
        let valid = Vec::<Val>::try_from_val(&env, &encoded).unwrap();
        for length in 0..=8 {
            if length != valid.len() {
                let mut malformed = valid.clone();
                while malformed.len() > length {
                    malformed.pop_back();
                }
                while malformed.len() < length {
                    malformed.push_back(Val::VOID.to_val());
                }
                check(malformed.into_val(&env));
            }
        }
        for field in 0..valid.len() {
            let mut malformed = valid.clone();
            malformed.set(field, Val::VOID.to_val());
            check(malformed.into_val(&env));
        }
        // Combined malformed tag and oversized arity exercise the decoder's early bounds path.
        let mut combined = valid.clone();
        combined.set(0, Symbol::new(&env, "UnknownAction").into_val(&env));
        while combined.len() < 8 {
            combined.push_back(Val::VOID.to_val());
        }
        check(combined.into_val(&env));
    }
    // Valid wire types must retain queue-time contract-error precedence too.
    for action in [
        AdminAction::SetFeeBps(u32::MAX),
        AdminAction::RegisterToken(admin.clone(), u32::MAX, i128::MIN),
        AdminAction::RegisterToken(admin.clone(), u32::MAX, 0),
        AdminAction::RegisterToken(admin.clone(), 7, 0),
        AdminAction::RaiseTokenFlowLimit(admin.clone(), i128::MIN),
        AdminAction::SetRouteFlowLimit(admin.clone(), RouteKind::Cctp, -1),
        AdminAction::SetTimelockDelay(0),
        AdminAction::SetTimelockDelay(u64::MAX),
        AdminAction::SetFlowWindow(0),
        AdminAction::SetRouteConfig(
            RouteKind::Cctp,
            RouteConfig {
                max_single_transfer: i128::MIN,
            },
        ),
        AdminAction::SetRouteMaxSingleTransfer(RouteKind::Cctp, -1),
        AdminAction::SetDestinationFlowLimit(
            admin.clone(),
            RouteKind::Cctp,
            String::from_str(&env, "ethereum"),
            -1,
        ),
        AdminAction::BeginStorageMigration(u32::MAX),
    ] {
        check(action.into_val(&env));
    }
}

fn legacy_state_projection(
    env: &Env,
    router: &Address,
    token: &Address,
    chain: &String,
    id: u64,
) -> std::vec::Vec<Option<ScVal>> {
    env.as_contract(router, || {
        let mut result = std::vec::Vec::new();
        let mut tracked = keys(env, token, RouteKind::Cctp, id).to_vec();
        tracked.push(DataKey::DestinationFlowLimit(
            token.clone(),
            RouteKind::Cctp,
            chain.clone(),
        ));
        for key in tracked {
            result.push(
                env.storage()
                    .instance()
                    .get::<DataKey, Val>(&key)
                    .map(|value| canonical(env, value)),
            );
            result.push(
                env.storage()
                    .persistent()
                    .get::<DataKey, Val>(&key)
                    .map(|value| canonical(env, value)),
            );
        }
        result
    })
}

fn contract_event_projection(
    env: &Env,
    router: &Address,
) -> std::vec::Vec<soroban_sdk::xdr::ContractEvent> {
    let ScVal::Address(soroban_sdk::xdr::ScAddress::Contract(hash)) =
        canonical(env, router.into_val(env))
    else {
        unreachable!("router must be a contract address")
    };
    env.events()
        .all()
        .events()
        .iter()
        .filter(|event| event.contract_id.as_ref() == Some(&hash))
        .map(|event| {
            let mut event = event.clone();
            event.contract_id = None;
            event
        })
        .collect()
}

#[test]
fn all_17_matured_actions_match_sdk_state_events_and_authority_lifecycle() {
    let wasm = std::env::var("HYPERION_POLICY_ROUTER_WASM")
        .ok()
        .map(|path| {
            let bytes = std::fs::read(&path).expect("explicit router WASM must be readable");
            assert_eq!(&bytes[..4], b"\0asm");
            std::println!(
                "HYPERION_CODEC_APPLY_RUNTIME=production-wasm bytes={} path={path}",
                bytes.len()
            );
            bytes
        });
    if wasm.is_none() {
        std::println!("HYPERION_CODEC_APPLY_RUNTIME=native guest_execution_proven=false");
    }
    for index in 0..17 {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|info| {
            info.sequence_number = 100_000;
            info.timestamp = 1_700_000_000;
            info.min_persistent_entry_ttl = 4096;
            info.min_temp_entry_ttl = 16;
            info.max_entry_ttl = 6_312_000;
        });
        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let treasury = Address::generate(&env);
        let replacement = Address::generate(&env);
        let issuer = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(issuer).address();
        let native = env.register(HyperionRouter, ());
        let guest = match &wasm {
            Some(bytes) => env.register(bytes.as_slice(), ()),
            None => env.register(HyperionRouter, ()),
        };
        let routers = [&native, &guest];
        for router in routers {
            let client = HyperionRouterClient::new(&env, router);
            client.initialize(
                &admin,
                &guardian,
                &treasury,
                &10,
                &3600,
                &MIN_TIMELOCK_DELAY,
            );
        }
        let native_client = HyperionRouterClient::new(&env, &native);
        let guest_client = HyperionRouterClient::new(&env, &guest);
        let registration = AdminAction::RegisterToken(token.clone(), 7, 100_000_000);
        let registered = native_client.queue_action(&admin, &registration);
        assert_eq!(guest_client.queue_action(&admin, &registration), registered);
        env.ledger()
            .set_timestamp(native_client.get_queued(&registered).eta);
        for router in routers {
            HyperionRouterClient::new(&env, router).execute_action(&admin, &registered);
        }
        // Both contracts queue the measured action at the same ledger timestamp.
        let chain = String::from_str(&env, "ethereum\0雪");
        let route = RouteKind::Cctp;
        let hash = match &wasm {
            Some(bytes) => env.deployer().upload_contract_wasm(bytes.as_slice()),
            None => BytesN::from_array(&env, &[0xA5; 32]),
        };
        let action = [
            AdminAction::SetFeeBps(25),
            AdminAction::SetTreasury(replacement.clone()),
            AdminAction::SetAdmin(replacement.clone()),
            AdminAction::SetGuardian(replacement.clone()),
            AdminAction::SetAdapter(route, replacement.clone()),
            AdminAction::SetRailReceiver(route, replacement.clone()),
            AdminAction::EnableRoute(route),
            AdminAction::RegisterToken(token.clone(), 7, 200_000_000),
            AdminAction::RaiseTokenFlowLimit(token.clone(), 200_000_000),
            AdminAction::SetRouteFlowLimit(token.clone(), route, 80_000_000),
            AdminAction::SetTimelockDelay(MIN_TIMELOCK_DELAY + 17),
            AdminAction::SetFlowWindow(99),
            AdminAction::Upgrade(hash),
            AdminAction::SetRouteConfig(
                route,
                RouteConfig {
                    max_single_transfer: 70_000_000,
                },
            ),
            AdminAction::SetRouteMaxSingleTransfer(route, 60_000_000),
            AdminAction::SetDestinationFlowLimit(token.clone(), route, chain.clone(), 50_000_000),
            AdminAction::BeginStorageMigration(CURRENT_SCHEMA_VERSION),
        ][index]
            .clone();
        if index == 12 && wasm.is_some() {
            let invalid = AdminAction::Upgrade(BytesN::from_array(&env, &[0xA5; 32]));
            let failed = native_client.queue_action(&admin, &invalid);
            assert_eq!(guest_client.queue_action(&admin, &invalid), failed);
            env.ledger()
                .set_timestamp(native_client.get_queued(&failed).eta);
            let before = legacy_state_projection(&env, &native, &token, &chain, failed);
            let original_native = native.executable();
            let original_guest = guest.executable();
            let failure = native_client.try_execute_action(&admin, &failed);
            assert!(failure.is_err());
            assert_eq!(guest_client.try_execute_action(&admin, &failed), failure);
            assert_eq!(native.executable(), original_native);
            assert_eq!(guest.executable(), original_guest);
            for router in routers {
                assert_eq!(
                    legacy_state_projection(&env, router, &token, &chain, failed),
                    before
                );
                HyperionRouterClient::new(&env, router).cancel_action(&guardian, &failed);
            }
        }
        if index == 16 {
            for router in routers {
                env.as_contract(router, || {
                    // Seed an independently SDK-encoded pre-upgrade migration snapshot.
                    env.storage()
                        .instance()
                        .set(&DataKey::SchemaVersion, &(CURRENT_SCHEMA_VERSION - 1));
                    env.storage().instance().set(&DataKey::OutNonce, &9u64);
                    env.storage().instance().set(&DataKey::ClaimSeq, &4u64);
                });
            }
        }
        let encoded: Val = action.into_val(&env);
        let input = if index == 13 {
            let mut vector = Vec::<Val>::try_from_val(&env, &encoded).unwrap();
            let mut config =
                Map::<Symbol, Val>::try_from_val(&env, &vector.get(2).unwrap()).unwrap();
            config.set(Symbol::new(&env, "future_extension"), 123u32.into_val(&env));
            vector.set(2, config.into_val(&env));
            std::println!("HYPERION_CODEC_ROUTE_CONFIG_EXTRA_FIELD=canonicalized");
            vector.into_val(&env)
        } else {
            encoded
        };
        let args = Vec::from_array(&env, [admin.into_val(&env), input]);
        let method = Symbol::new(&env, "queue_action");
        let id = env.invoke_contract::<u64>(&native, &method, args.clone());
        assert_eq!(env.invoke_contract::<u64>(&guest, &method, args), id);
        let queued = native_client.get_queued(&id);
        assert_eq!(queued.action, action);
        assert_eq!(guest_client.get_queued(&id), queued);
        for router in routers {
            let returned = env.invoke_contract::<Val>(
                router,
                &Symbol::new(&env, "get_queued"),
                Vec::from_array(&env, [id.into_val(&env)]),
            );
            assert_eq!(
                canonical(&env, returned),
                ScVal::try_from(&queued).unwrap(),
                "queued action must drop unknown nested configuration fields"
            );
        }
        for router in routers {
            assert_eq!(
                HyperionRouterClient::new(&env, router).try_execute_action(&admin, &id),
                Err(Ok(hyperion_core::HyperionError::TimelockNotReady))
            );
        }
        env.ledger().set_timestamp(queued.eta);
        if index == 12 && wasm.is_none() {
            let before = legacy_state_projection(&env, &native, &token, &chain, id);
            let native_error = native_client.try_execute_action(&admin, &id);
            assert!(native_error.is_err());
            assert_eq!(guest_client.try_execute_action(&admin, &id), native_error);
            assert_eq!(
                legacy_state_projection(&env, &native, &token, &chain, id),
                before
            );
            assert_eq!(
                legacy_state_projection(&env, &guest, &token, &chain, id),
                before
            );
            assert_eq!(native_client.get_queued(&id), queued);
            assert_eq!(guest_client.get_queued(&id), queued);
            continue;
        }
        for router in routers {
            let client = HyperionRouterClient::new(&env, router);
            client.execute_action(&admin, &id);
            assert_eq!(client.get_action_payload(&id), queued);
            assert_eq!(
                client.try_get_queued(&id),
                Err(Ok(hyperion_core::HyperionError::TimelockNotQueued))
            );
            let cfg = client.get_config();
            match index {
                0 => assert_eq!(cfg.fee_bps, 25),
                1 => assert_eq!(cfg.treasury, replacement),
                2 => assert_eq!(cfg.admin, replacement),
                3 => assert_eq!(cfg.guardian, replacement),
                4 => assert_eq!(client.get_adapter(&route), replacement),
                5 => assert_eq!(client.get_rail_receiver(&route), replacement),
                6 => assert!(client.is_route_enabled(&route)),
                7 | 8 => assert_eq!(client.get_token(&token).flow_limit, 200_000_000),
                9 => assert_eq!(
                    env.as_contract(router, || storage::effective_flow_limit(
                        &env, &token, route
                    )
                    .unwrap()),
                    80_000_000
                ),
                10 => assert_eq!(cfg.timelock_delay, MIN_TIMELOCK_DELAY + 17),
                11 => assert_eq!(cfg.flow_window_ledgers, 99),
                12 => {
                    let AdminAction::Upgrade(hash) = &action else {
                        unreachable!()
                    };
                    assert_eq!(
                        router.executable(),
                        Some(soroban_sdk::Executable::Wasm(hash.clone()))
                    );
                }
                13 => assert_eq!(
                    client.get_route_config(&route).unwrap().max_single_transfer,
                    70_000_000
                ),
                14 => assert_eq!(
                    client.get_route_config(&route).unwrap().max_single_transfer,
                    60_000_000
                ),
                15 => assert_eq!(
                    env.as_contract(router, || storage::effective_destination_flow_limit(
                        &env, &token, route, &chain
                    )
                    .unwrap()),
                    50_000_000
                ),
                16 => {
                    let migration = client.get_migration_status();
                    assert!(migration.migration_pending);
                    assert_eq!(migration.current_version, CURRENT_SCHEMA_VERSION - 1);
                    assert_eq!(migration.target_version, CURRENT_SCHEMA_VERSION);
                    assert_eq!((migration.total_transfers, migration.total_claims), (9, 4));
                }
                _ => {}
            }
            if index == 2 {
                assert_eq!(
                    client.try_pause(&admin),
                    Err(Ok(hyperion_core::HyperionError::Unauthorized))
                );
            }
            if index == 3 {
                assert_eq!(
                    client.try_pause(&guardian),
                    Err(Ok(hyperion_core::HyperionError::Unauthorized))
                );
            }
            client.pause(&cfg.guardian);
            assert!(client.get_config().paused);
            assert_eq!(
                client.try_unpause(&cfg.guardian),
                Err(Ok(hyperion_core::HyperionError::Unauthorized))
            );
            client.unpause(&cfg.admin);
            assert!(!client.get_config().paused);
            let cancelled = client.queue_action(&cfg.admin, &AdminAction::SetFeeBps(5));
            let payload = client.get_queued(&cancelled);
            client.cancel_action(&cfg.guardian, &cancelled);
            assert_eq!(client.get_action_payload(&cancelled), payload);
            assert_eq!(
                client.try_execute_action(&cfg.admin, &cancelled),
                Err(Ok(hyperion_core::HyperionError::TimelockNotQueued))
            );
        }
        assert_eq!(
            legacy_state_projection(&env, &guest, &token, &chain, id),
            legacy_state_projection(&env, &native, &token, &chain, id),
            "matured action {index} changed legacy storage encoding or state"
        );
        assert_eq!(
            contract_event_projection(&env, &guest),
            contract_event_projection(&env, &native),
            "matured action {index} changed event XDR"
        );
    }
}
