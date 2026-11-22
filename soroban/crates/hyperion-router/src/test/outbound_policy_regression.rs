//! Economic regressions at the paid provider boundary. The same tests can use the
//! production router WASM via HYPERION_POLICY_ROUTER_WASM; providers remain native fixtures.
extern crate std;

use super::{
    doubles::{evm_destination, FailableToken, FailableTokenClient, MockRail, MockRailClient},
    setup::World,
};
use crate::{
    AdminAction, BatchOutboundItem, DataKey, Destination, HyperionRouter, HyperionRouterClient,
    OutboundPreconditions, OutboundRequest, MIN_TIMELOCK_DELAY,
};
use hyperion_core::{FlowWindow, HyperionError, RouteKind, DEFAULT_FLOW_WINDOW_LEDGERS};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger},
    token, Address, BytesN, Env, String, Symbol, Vec,
};

const REQUESTED: i128 = 1_000_000_019;
// 10 bps = 1,000,000; floor the remaining 999,000,019 to a multiple of ten.
const FEE: i128 = 1_000_000;
const NET: i128 = 999_000_010;
const DEBIT: i128 = 1_000_000_010;
const GAS: i128 = 37;
const FUNDING: i128 = 20_000_000_000;
const LIMIT: i128 = 10_000_000_000;
const DEST_LIMIT: i128 = 5_000_000_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct ProviderRecord {
    sender: Address,
    token: Address,
    amount: i128,
    chain: String,
    destination: BytesN<32>,
    nonce: u64,
    gas: i128,
}

#[contract]
struct PolicyProvider;

#[contractimpl]
impl PolicyProvider {
    pub fn set_failure(env: Env, nonce: u64) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "fail"), &nonce);
    }

    pub fn records(env: Env) -> Vec<ProviderRecord> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "records"))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn dispatch(env: Env, record: ProviderRecord) {
        let mut records = Self::records(env.clone());
        records.push_back(record.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "records"), &records);
        let fail: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "fail"))
            .unwrap_or(0);
        if record.nonce == fail {
            // This error can only occur after a first item was delivered, followed by
            // this item's transfers and provider write. A pre-dispatch refusal cannot pass.
            let first = records.get(0).unwrap();
            if records.len() != 2
                || first.nonce != 1
                || first.amount != NET
                || first.chain != String::from_str(&env, "ethereum")
                || first.destination != evm_destination(&env, 0x11)
            {
                env.panic_with_error(HyperionError::InvalidLimit);
            }
            env.panic_with_error(HyperionError::UnknownChain);
        }
    }
}

#[contract]
struct PolicyPaidAdapter;

#[contractimpl]
impl PolicyPaidAdapter {
    pub fn init(env: Env, router: Address, gas_token: Address, provider: Address) {
        for (name, value) in [
            ("router", router),
            ("gas", gas_token),
            ("provider", provider),
        ] {
            env.storage()
                .instance()
                .set(&Symbol::new(&env, name), &value);
        }
    }

    pub fn gas_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "gas"))
            .unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn dispatch_from(
        env: Env,
        caller: Address,
        sender: Address,
        token: Address,
        amount: i128,
        destination_chain: String,
        destination: BytesN<32>,
        nonce: u64,
        gas_amount: i128,
    ) {
        caller.require_auth();
        sender.require_auth();
        let router: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "router"))
            .unwrap();
        assert_eq!(caller, router);
        let provider: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "provider"))
            .unwrap();
        let this = env.current_contract_address();
        token::Client::new(&env, &token).transfer(&sender, &this, &amount);
        token::Client::new(&env, &Self::gas_token(env.clone())).transfer(
            &sender,
            &provider,
            &gas_amount,
        );
        // Sending from the adapter uses its implicit contract authorization.
        token::Client::new(&env, &token).transfer(&this, &provider, &amount);
        PolicyProviderClient::new(&env, &provider).dispatch(&ProviderRecord {
            sender,
            token,
            amount,
            chain: destination_chain,
            destination,
            nonce,
            gas: gas_amount,
        });
    }
}

struct PaidWorld {
    world: World,
    adapter: Address,
    provider: Address,
    gas_token: Address,
}

impl PaidWorld {
    fn new() -> Self {
        Self::at(100_000, 1_700_000_000)
    }

    fn at(sequence: u32, timestamp: u64) -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| {
            ledger.sequence_number = sequence;
            ledger.timestamp = timestamp;
            ledger.min_persistent_entry_ttl = 4096;
            ledger.min_temp_entry_ttl = 16;
            ledger.max_entry_ttl = 6_312_000;
        });
        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);
        let recipient = Address::generate(&env);
        let issuer = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(issuer.clone())
            .address();
        let router_id = env.register(HyperionRouter, ());
        let rail_id = env.register(MockRail, ());
        MockRailClient::new(&env, &rail_id).init(&router_id);
        let world = World {
            env,
            router_id,
            rail_id,
            admin,
            guardian,
            treasury,
            user,
            recipient,
            token_id,
            issuer,
        };
        if let Ok(path) = std::env::var("HYPERION_POLICY_ROUTER_WASM") {
            let wasm = std::fs::read(path).expect("production policy router WASM");
            world.env.register_at(&world.router_id, wasm.as_slice(), ());
        }
        world.router().initialize(
            &world.admin,
            &world.guardian,
            &world.treasury,
            &10,
            &DEFAULT_FLOW_WINDOW_LEDGERS,
            &MIN_TIMELOCK_DELAY,
        );
        let provider = world.env.register(PolicyProvider, ());
        let gas_token = world
            .env
            .register_stellar_asset_contract_v2(Address::generate(&world.env))
            .address();
        let adapter = world.env.register(PolicyPaidAdapter, ());
        PolicyPaidAdapterClient::new(&world.env, &adapter).init(
            &world.router_id,
            &gas_token,
            &provider,
        );
        world.register_token(world.token_id.clone(), 7, LIMIT);
        world.run_action(AdminAction::SetAdapter(
            RouteKind::AxelarIts,
            adapter.clone(),
        ));
        world.run_action(AdminAction::EnableRoute(RouteKind::AxelarIts));
        for chain in ["ethereum", "Ethereum"] {
            world.run_action(AdminAction::SetDestinationFlowLimit(
                world.token_id.clone(),
                RouteKind::AxelarIts,
                String::from_str(&world.env, chain),
                DEST_LIMIT,
            ));
        }
        world.fund_user(FUNDING);
        token::StellarAssetClient::new(&world.env, &gas_token).mint(&world.user, &FUNDING);
        Self {
            world,
            adapter,
            provider,
            gas_token,
        }
    }

    fn router(&self) -> HyperionRouterClient<'_> {
        self.world.router()
    }

    fn provider(&self) -> PolicyProviderClient<'_> {
        PolicyProviderClient::new(&self.world.env, &self.provider)
    }

    fn request(&self, chain: &str, address: u8) -> OutboundRequest {
        OutboundRequest {
            token: self.world.token_id.clone(),
            amount: REQUESTED,
            route: RouteKind::AxelarIts,
            destination: Destination {
                chain: String::from_str(&self.world.env, chain),
                address: evm_destination(&self.world.env, address),
            },
            destination_decimals: 6,
            min_destination_amount: 99_900_001,
        }
    }

    fn fingerprint(&self) -> BytesN<32> {
        self.router()
            .quote_fingerprint(&RouteKind::AxelarIts, &self.world.token_id, &6)
    }

    fn snapshot(&self) -> EconomicState {
        let w = &self.world;
        let mut balances = std::vec::Vec::new();
        for token_id in [&w.token_id, &self.gas_token] {
            let client = token::Client::new(&w.env, token_id);
            for account in [
                &w.user,
                &w.treasury,
                &w.router_id,
                &self.adapter,
                &self.provider,
            ] {
                balances.push(client.balance(account));
            }
        }
        let windows = w.env.as_contract(&w.router_id, || {
            let persistent = w.env.storage().persistent();
            (
                persistent.get(&DataKey::Flow(w.token_id.clone(), RouteKind::AxelarIts)),
                persistent.get(&DataKey::DestinationFlow(
                    w.token_id.clone(),
                    RouteKind::AxelarIts,
                    String::from_str(&w.env, "ethereum"),
                )),
                persistent.get(&DataKey::DestinationFlow(
                    w.token_id.clone(),
                    RouteKind::AxelarIts,
                    String::from_str(&w.env, "Ethereum"),
                )),
            )
        });
        EconomicState {
            balances,
            windows,
            nonce: self.router().last_out_nonce(),
            records: self.provider().records(),
        }
    }

    fn assert_one_payment(&self) {
        let state = self.snapshot();
        assert_eq!(
            state.balances,
            std::vec![FUNDING - DEBIT, FEE, 0, 0, NET, FUNDING - GAS, 0, 0, 0, GAS,]
        );
        assert_eq!(state.nonce, 1);
        assert_eq!(state.records.len(), 1);
        let record = state.records.get(0).unwrap();
        assert_eq!(record.sender, self.world.user);
        assert_eq!(record.token, self.world.token_id);
        assert_eq!((record.amount, record.gas, record.nonce), (NET, GAS, 1));
        assert_eq!(record.chain, String::from_str(&self.world.env, "ethereum"));
        assert_eq!(record.destination, evm_destination(&self.world.env, 0x11));
        assert_eq!(state.windows.0.unwrap().consumed, NET);
        assert_eq!(state.windows.1.unwrap().consumed, NET);
        assert!(state.windows.2.is_none());
        let transfer = self.router().get_transfer(&1);
        assert_eq!(
            (transfer.gross_amount, transfer.fee, transfer.net_amount),
            (DEBIT, FEE, NET)
        );
    }
}

#[derive(Debug, Eq, PartialEq)]
struct EconomicState {
    balances: std::vec::Vec<i128>,
    windows: (Option<FlowWindow>, Option<FlowWindow>, Option<FlowWindow>),
    nonce: u64,
    records: Vec<ProviderRecord>,
}

#[test]
fn paid_fingerprint_and_legacy_calls_preserve_exact_debits_and_provider_results() {
    for mode in 0..3 {
        let p = PaidWorld::new();
        let request = p.request("ethereum", 0x11);
        let nonce = if mode == 2 {
            p.router()
                .bridge_out_with_gas(&p.world.user, &request, &GAS)
        } else {
            let preconditions = OutboundPreconditions {
                quote_fingerprint: if mode == 0 {
                    Some(p.fingerprint())
                } else {
                    None
                },
                deadline: None,
            };
            p.router()
                .bridge_out_gas_preconditions(&p.world.user, &request, &GAS, &preconditions)
        };
        assert_eq!(nonce, 1);
        p.assert_one_payment();
    }
}

#[test]
fn paid_adapter_fee_and_precision_changes_reject_stale_fingerprints_before_any_debit() {
    for change in 0..4 {
        let p = PaidWorld::new();
        let stale = p.fingerprint();
        let mut request = p.request("ethereum", 0x11);
        let replacement = p.world.env.register(PolicyPaidAdapter, ());
        PolicyPaidAdapterClient::new(&p.world.env, &replacement).init(
            &p.world.router_id,
            &p.gas_token,
            &p.provider,
        );
        match change {
            0 => p.world.run_action(AdminAction::SetAdapter(
                RouteKind::AxelarIts,
                replacement.clone(),
            )),
            1 => p.world.run_action(AdminAction::SetFeeBps(20)),
            2 => request.destination_decimals = 7,
            _ => {
                // Model a registered token whose reviewed upgrade changes its precision.
                p.world
                    .env
                    .register_at(&p.world.token_id, FailableToken, ());
                let token = FailableTokenClient::new(&p.world.env, &p.world.token_id);
                token.init(&8);
                token.mint(&p.world.user, &FUNDING);
                p.world.register_token(p.world.token_id.clone(), 8, LIMIT);
            }
        }
        let current = p.router().quote_fingerprint(
            &RouteKind::AxelarIts,
            &p.world.token_id,
            &request.destination_decimals,
        );
        assert_ne!(current, stale);
        let before = p.snapshot();
        let preconditions = OutboundPreconditions {
            quote_fingerprint: Some(stale),
            deadline: None,
        };
        assert_eq!(
            p.router().try_bridge_out_gas_preconditions(
                &p.world.user,
                &request,
                &GAS,
                &preconditions
            ),
            Err(Ok(HyperionError::FingerprintMismatch)),
        );
        assert_eq!(p.snapshot(), before);
        assert_eq!(
            token::Client::new(&p.world.env, &p.world.token_id).balance(&replacement),
            0
        );
        assert_eq!(
            token::Client::new(&p.world.env, &p.gas_token).balance(&replacement),
            0
        );
    }
}

#[test]
fn paid_expiry_allows_equal_boundaries_and_zero_but_rejects_expired_requests_atomically() {
    // Each case starts with fresh, live storage at its chosen ledger sequence.
    for case in 0..9 {
        let p = if case == 6 {
            PaidWorld::at(1_000_000_000, 800_000_000)
        } else if case >= 7 {
            PaidWorld::at(1_000_000_001, 999_950_000)
        } else {
            PaidWorld::new()
        };
        if case >= 7 {
            p.world.env.ledger().set_timestamp(if case == 7 {
                1_000_000_000
            } else {
                1_000_000_001
            });
        }
        let deadline = match case {
            0 => None,
            1 => Some(0),
            2 => Some(u64::from(p.world.env.ledger().sequence())),
            3 => Some(u64::from(p.world.env.ledger().sequence()) - 1),
            4 => Some(p.world.env.ledger().timestamp()),
            5 => Some(p.world.env.ledger().timestamp() - 1),
            6 => Some(999_999_999),
            _ => Some(1_000_000_000),
        };
        let expired = matches!(case, 3 | 5 | 6 | 8);
        let before = p.snapshot();
        let preconditions = OutboundPreconditions {
            quote_fingerprint: Some(p.fingerprint()),
            deadline,
        };
        let result = p.router().try_bridge_out_gas_preconditions(
            &p.world.user,
            &p.request("ethereum", 0x11),
            &GAS,
            &preconditions,
        );
        if expired {
            assert_eq!(
                result,
                Err(Ok(HyperionError::RequestExpired)),
                "case {case}"
            );
            assert_eq!(p.snapshot(), before, "case {case}");
        } else {
            assert_eq!(result, Ok(Ok(1)), "case {case}");
            p.assert_one_payment();
        }
    }
}

#[test]
fn late_paid_provider_failure_restores_all_balances_records_nonces_and_both_flow_windows() {
    let p = PaidWorld::new();
    p.provider().set_failure(&2);
    let items = Vec::from_array(
        &p.world.env,
        [
            BatchOutboundItem {
                request: p.request("ethereum", 0x11),
                preconditions: OutboundPreconditions {
                    quote_fingerprint: Some(p.fingerprint()),
                    deadline: None,
                },
                gas_amount: Some(GAS),
            },
            BatchOutboundItem {
                request: p.request("Ethereum", 0x22),
                preconditions: OutboundPreconditions {
                    quote_fingerprint: Some(p.fingerprint()),
                    deadline: None,
                },
                gas_amount: Some(GAS),
            },
        ],
    );
    let before = p.snapshot();
    assert_eq!(
        p.router()
            .try_bridge_out_batch_items(&p.world.user, &items, &(REQUESTED * 2)),
        Err(Ok(HyperionError::UnknownChain))
    );
    assert_eq!(p.snapshot(), before);
    assert_eq!(
        p.router().try_get_transfer(&1),
        Err(Ok(HyperionError::UnknownNonce))
    );
    assert_eq!(
        p.router().try_get_transfer(&2),
        Err(Ok(HyperionError::UnknownNonce))
    );
    p.provider().set_failure(&0);
    assert_eq!(
        p.router()
            .bridge_out_batch_items(&p.world.user, &items, &(REQUESTED * 2)),
        Vec::from_array(&p.world.env, [1u64, 2u64])
    );
    let after = p.snapshot();
    assert_eq!(
        after.balances,
        std::vec![
            FUNDING - DEBIT * 2,
            FEE * 2,
            0,
            0,
            NET * 2,
            FUNDING - GAS * 2,
            0,
            0,
            0,
            GAS * 2,
        ]
    );
    assert_eq!(after.nonce, 2);
    assert_eq!(after.records.len(), 2);
    for (index, chain, address) in [(0, "ethereum", 0x11), (1, "Ethereum", 0x22)] {
        let record = after.records.get(index).unwrap();
        assert_eq!(record.nonce, u64::from(index) + 1);
        assert_eq!((record.amount, record.gas), (NET, GAS));
        assert_eq!(record.chain, String::from_str(&p.world.env, chain));
        assert_eq!(record.destination, evm_destination(&p.world.env, address));
        let transfer = p.router().get_transfer(&record.nonce);
        assert_eq!(transfer.destination_chain, record.chain);
        assert_eq!(transfer.destination, record.destination);
    }
    assert_eq!(after.windows.0.unwrap().consumed, NET * 2);
    assert_eq!(after.windows.1.unwrap().consumed, NET);
    assert_eq!(after.windows.2.unwrap().consumed, NET);
}
