//! One world builder shared by every router test.
//!
//! Registering a token goes through the timelock even here, because making the tests take the
//! same path production takes is the only way the timelock stays honest. If setup ever gets
//! easier than reality, the tests stop testing reality.

use hyperion_core::{RouteKind, DEFAULT_FLOW_WINDOW_LEDGERS, STELLAR_DECIMALS};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env, String,
};

use crate::test::doubles::{FailableToken, FailableTokenClient, MockRail, MockRailClient};
use crate::test::hostile::{
    HostileReceiver, HostileReceiverClient, HostileToken, HostileTokenClient,
};
use crate::types::AdminAction;
use crate::{HyperionRouter, HyperionRouterClient, MIN_TIMELOCK_DELAY};

pub const FEE_BPS: u32 = 10;
/// USDC on every EVM chain Hyperion targets. Seven here, six there, off by exactly ten.
pub const EVM_DECIMALS: u32 = 6;
/// One hundred units of a seven decimal asset.
pub const HUNDRED: i128 = 1_000_000_000;
pub const FLOW_LIMIT: i128 = 10_000_000_000;

pub struct World {
    pub env: Env,
    pub router_id: Address,
    pub rail_id: Address,
    pub admin: Address,
    pub guardian: Address,
    pub treasury: Address,
    pub user: Address,
    pub recipient: Address,
    pub token_id: Address,
    pub issuer: Address,
}

impl World {
    /// A world with a real Stellar Asset Contract, every route live, and a funded user.
    pub fn new() -> Self {
        let world = Self::bare();
        world.enable_every_route();
        world.register_token(world.token_id.clone(), STELLAR_DECIMALS, FLOW_LIMIT);
        world.fund_user(HUNDRED * 10);
        world
    }

    /// Initialised, but nothing registered and no route enabled yet.
    pub fn bare() -> Self {
        let world = Self::uninitialised();
        world.router().initialize(
            &world.admin,
            &world.guardian,
            &world.treasury,
            &FEE_BPS,
            &DEFAULT_FLOW_WINDOW_LEDGERS,
            &MIN_TIMELOCK_DELAY,
        );
        world
    }

    /// Everything deployed and wired, but `initialize` never called. Used to prove the router
    /// refuses to do anything interesting before somebody sets it up.
    pub fn uninitialised() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.sequence_number = 100_000;
            li.timestamp = 1_700_000_000;
            li.min_persistent_entry_ttl = 4096;
            li.min_temp_entry_ttl = 16;
            li.max_entry_ttl = 6_312_000;
        });

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);
        let recipient = Address::generate(&env);
        let issuer = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(issuer.clone());
        let token_id = sac.address();

        let router_id = env.register(HyperionRouter, ());
        let rail_id = env.register(MockRail, ());
        MockRailClient::new(&env, &rail_id).init(&router_id);

        World {
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
        }
    }

    pub fn router(&self) -> HyperionRouterClient<'_> {
        HyperionRouterClient::new(&self.env, &self.router_id)
    }

    pub fn rail(&self) -> MockRailClient<'_> {
        MockRailClient::new(&self.env, &self.rail_id)
    }

    pub fn token(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.token_id)
    }

    pub fn sac(&self) -> token::StellarAssetClient<'_> {
        token::StellarAssetClient::new(&self.env, &self.token_id)
    }

    pub fn fund_user(&self, amount: i128) {
        self.sac().mint(&self.user, &amount);
    }

    pub fn fund_rail(&self, amount: i128) {
        self.sac().mint(&self.rail_id, &amount);
    }

    /// Queue an admin action, wait out the delay, execute it.
    pub fn run_action(&self, action: AdminAction) {
        let id = self.router().queue_action(&self.admin, &action);
        self.advance_time(MIN_TIMELOCK_DELAY + 1);
        self.router().execute_action(&self.admin, &id);
    }

    pub fn register_token(&self, token: Address, decimals: u32, limit: i128) {
        self.run_action(AdminAction::RegisterToken(token, decimals, limit));
    }

    pub fn enable_every_route(&self) {
        for route in super::doubles::all_routes() {
            self.enable_route(route);
        }
    }

    /// Point a rail at the mock and open it. Three timelocked changes, same as production.
    pub fn enable_route(&self, route: RouteKind) {
        self.run_action(AdminAction::SetAdapter(route, self.rail_id.clone()));
        self.run_action(AdminAction::SetRailReceiver(route, self.rail_id.clone()));
        self.run_action(AdminAction::EnableRoute(route));
    }

    pub fn advance_time(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| {
            li.timestamp += seconds;
        });
    }

    pub fn advance_ledgers(&self, ledgers: u32) {
        self.env.ledger().with_mut(|li| {
            li.sequence_number += ledgers;
        });
    }

    pub fn ethereum(&self) -> String {
        String::from_str(&self.env, "ethereum")
    }

    /// Swap the real asset contract for one that can be told to refuse a recipient, which is the
    /// only way to reach the parked claim path.
    pub fn with_failable_token(&self) -> Address {
        self.with_failable_token_with_decimals(STELLAR_DECIMALS)
    }

    pub fn with_failable_token_with_decimals(&self, decimals: u32) -> Address {
        let id = self.env.register(FailableToken, ());
        FailableTokenClient::new(&self.env, &id).init(&decimals);
        self.register_token(id.clone(), decimals, FLOW_LIMIT);
        id
    }

    pub fn failable(&self, id: &Address) -> FailableTokenClient<'_> {
        FailableTokenClient::new(&self.env, id)
    }

    /// Register a [`HostileToken`] through the same timelocked path as any other token. It
    /// starts honest on every leg until a test installs a rule.
    pub fn with_hostile_token(&self) -> Address {
        let id = self.env.register(HostileToken, ());
        HostileTokenClient::new(&self.env, &id).init(&STELLAR_DECIMALS);
        self.register_token(id.clone(), STELLAR_DECIMALS, FLOW_LIMIT);
        id
    }

    pub fn hostile(&self, id: &Address) -> HostileTokenClient<'_> {
        HostileTokenClient::new(&self.env, id)
    }

    /// Replace `route`'s rail receiver with a [`HostileReceiver`] via the timelock. The
    /// receiver starts in `ReceiverMode::Honest`.
    pub fn with_hostile_receiver(&self, route: RouteKind) -> HostileReceiverClient<'_> {
        let id = self.env.register(HostileReceiver, ());
        let receiver = HostileReceiverClient::new(&self.env, &id);
        receiver.init(&self.router_id);
        self.run_action(AdminAction::SetRailReceiver(route, id));
        receiver
    }
}
