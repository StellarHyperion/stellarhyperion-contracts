//! One world builder shared by every test in this crate.
//!
//! Registering the token and enabling the route go through the router's timelock here exactly as
//! they would in production. Setup that takes a shortcut reality does not have is setup that
//! stops telling you anything.

use hyperion_core::{
    address::StellarDestination,
    cctp::{self, HyperionHook},
    codec, RouteKind, DEFAULT_FLOW_WINDOW_LEDGERS, STELLAR_DECIMALS,
};
use hyperion_router::{AdminAction, HyperionRouter, HyperionRouterClient, MIN_TIMELOCK_DELAY};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Bytes, BytesN, Env, String,
};

use super::circle::{MockMessenger, MockMessengerClient, MockTransmitter, MockTransmitterClient};
use crate::{CctpAdapter, CctpAdapterClient};

/// Ten basis points, the protocol fee the router is set up with.
pub const FEE_BPS: u32 = 10;
/// USDC on every EVM chain Hyperion targets. Seven decimals here, six there.
pub const EVM_DECIMALS: u32 = 6;
/// One hundred units of a seven decimal asset.
pub const HUNDRED: i128 = 1_000_000_000;
pub const FLOW_LIMIT: i128 = 10_000_000_000;

/// Circle's domain number for Ethereum mainnet, which is zero and looks like a mistake until you
/// remember Ethereum was the first thing CCTP ever shipped on.
pub const ETHEREUM_DOMAIN: u32 = 0;
/// A domain nobody has linked, for the tests that need an unrecognised source.
pub const UNLINKED_DOMAIN: u32 = 6;
/// USDC's address on Ethereum, widened into the 32 byte word CCTP carries it in.
pub const ETH_USDC: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xA0, 0xB8, 0x69, 0x91, 0xC6, 0x21, 0x8B, 0x36, 0xC1, 0xD1,
    0x9D, 0x4A, 0x2E, 0x9E, 0xB0, 0xCE, 0x36, 0x06, 0xEB, 0x48,
];

pub struct World {
    pub env: Env,
    pub adapter_id: Address,
    pub router_id: Address,
    pub messenger_id: Address,
    pub transmitter_id: Address,
    pub token_id: Address,
    pub admin: Address,
    pub guardian: Address,
    pub treasury: Address,
    pub user: Address,
    pub relayer: Address,
    /// Where a well formed message pays by default. A contract, because a contract holds an asset
    /// the moment somebody sends it one.
    pub recipient: Address,
    pub recipient_key: [u8; 32],
    /// A real classic account with no trustline for the asset, which is how a delivery ends up
    /// parked as a claim rather than handed over.
    pub classic: Address,
    pub classic_key: [u8; 32],
}

impl World {
    /// Everything wired, Ethereum linked, USDC mapped, the user holding a thousand units.
    pub fn new() -> Self {
        let world = Self::unlinked();
        world.link_ethereum();
        world
            .adapter()
            .map_asset(&ETHEREUM_DOMAIN, &world.eth_usdc(), &world.token_id);
        world.fund_user(HUNDRED * 10);
        world
    }

    /// Wired and open, but with no chain linked and no asset mapped yet.
    pub fn unlinked() -> Self {
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
        let relayer = Address::generate(&env);

        // Two destinations, because the two kinds behave differently and the difference is the
        // interesting part. `Address::generate` hands back contract ids, so this one is a C
        // address and can be paid on the spot.
        let recipient = Address::generate(&env);
        let recipient_key = codec::contract_key(&env, &recipient).unwrap();

        // And a real G address, built from a key the tests can also write into a hook payload. It
        // has no trustline for the asset and no way to open one, which is precisely the situation
        // the router's parked claims exist for.
        let classic_key = [0x44u8; 32];
        let classic = Address::from_string(&codec::account_strkey(&env, &classic_key));

        // The transmitter has to exist before the asset does, because it is the asset's admin.
        // That is what lets it mint without a mocked signature: it is the direct invoker of the
        // token, so its authority is implicit rather than granted by the test harness.
        let transmitter_id = env.register(MockTransmitter, ());
        let token_id = env
            .register_stellar_asset_contract_v2(transmitter_id.clone())
            .address();
        MockTransmitterClient::new(&env, &transmitter_id).init(&token_id);

        let messenger_id = env.register(MockMessenger, ());
        MockMessengerClient::new(&env, &messenger_id).init(&0i128, &0i128);

        let router_id = env.register(HyperionRouter, ());
        HyperionRouterClient::new(&env, &router_id).initialize(
            &admin,
            &guardian,
            &treasury,
            &FEE_BPS,
            &DEFAULT_FLOW_WINDOW_LEDGERS,
            &MIN_TIMELOCK_DELAY,
        );

        let adapter_id = env.register(CctpAdapter, ());
        CctpAdapterClient::new(&env, &adapter_id).initialize(
            &admin,
            &router_id,
            &messenger_id,
            &transmitter_id,
        );

        let world = World {
            env,
            adapter_id,
            router_id,
            messenger_id,
            transmitter_id,
            token_id,
            admin,
            guardian,
            treasury,
            user,
            relayer,
            recipient,
            recipient_key,
            classic,
            classic_key,
        };

        world.run_action(AdminAction::SetAdapter(
            RouteKind::Cctp,
            world.adapter_id.clone(),
        ));
        world.run_action(AdminAction::SetRailReceiver(
            RouteKind::Cctp,
            world.adapter_id.clone(),
        ));
        world.run_action(AdminAction::EnableRoute(RouteKind::Cctp));
        world.run_action(AdminAction::RegisterToken(
            world.token_id.clone(),
            STELLAR_DECIMALS,
            FLOW_LIMIT,
        ));
        world
    }

    // -------------------------------------------------------------------------------------
    // Clients
    // -------------------------------------------------------------------------------------

    pub fn adapter(&self) -> CctpAdapterClient<'_> {
        CctpAdapterClient::new(&self.env, &self.adapter_id)
    }

    pub fn router(&self) -> HyperionRouterClient<'_> {
        HyperionRouterClient::new(&self.env, &self.router_id)
    }

    pub fn messenger(&self) -> MockMessengerClient<'_> {
        MockMessengerClient::new(&self.env, &self.messenger_id)
    }

    pub fn transmitter(&self) -> MockTransmitterClient<'_> {
        MockTransmitterClient::new(&self.env, &self.transmitter_id)
    }

    pub fn token(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.token_id)
    }

    // -------------------------------------------------------------------------------------
    // Wiring helpers
    // -------------------------------------------------------------------------------------

    /// Queue an admin action on the router, wait out the delay, execute it.
    pub fn run_action(&self, action: AdminAction) {
        let id = self.router().queue_action(&self.admin, &action);
        self.env.ledger().with_mut(|li| {
            li.timestamp += MIN_TIMELOCK_DELAY + 1;
        });
        self.router().execute_action(&self.admin, &id);
    }

    pub fn link_ethereum(&self) {
        self.adapter().link_domain(
            &self.ethereum(),
            &ETHEREUM_DOMAIN,
            &BytesN::from_array(&self.env, &[0u8; 32]),
        );
        self.adapter().set_remote_sender(
            &ETHEREUM_DOMAIN,
            &BytesN::from_array(&self.env, &[0xE1u8; 32]),
        );
    }

    pub fn fund_user(&self, amount: i128) {
        self.transmitter().faucet(&self.user, &amount);
    }

    pub fn fund_adapter(&self, amount: i128) {
        self.transmitter().faucet(&self.adapter_id, &amount);
    }

    pub fn ethereum(&self) -> String {
        String::from_str(&self.env, "ethereum")
    }

    pub fn eth_usdc(&self) -> BytesN<32> {
        BytesN::from_array(&self.env, &ETH_USDC)
    }

    // -------------------------------------------------------------------------------------
    // Raw keys
    // -------------------------------------------------------------------------------------

    /// The adapter's contract id as the bare 32 bytes a CCTP field carries.
    pub fn adapter_key(&self) -> [u8; 32] {
        codec::contract_key(&self.env, &self.adapter_id).unwrap()
    }

    /// Circle's minter as CCTP addresses it, which is what every real burn message names.
    pub fn messenger_key(&self) -> [u8; 32] {
        codec::contract_key(&self.env, &self.messenger_id).unwrap()
    }

    // -------------------------------------------------------------------------------------
    // Hook payloads
    // -------------------------------------------------------------------------------------

    /// A hook naming the world's default recipient, which is a contract.
    ///
    /// Built from the raw key rather than from the `Address`, because raw bytes with a tag beside
    /// them is all a rail ever carries and going through the strkey form here would hide a
    /// round trip the production path has to get right.
    pub fn hook_to_recipient(&self) -> Bytes {
        HyperionHook::new(StellarDestination::contract(BytesN::from_array(
            &self.env,
            &self.recipient_key,
        )))
        .encode(&self.env)
        .unwrap()
    }

    /// A hook naming the world's classic account, trustline and all.
    pub fn hook_to_classic(&self) -> Bytes {
        self.hook_to_account(&self.classic_key)
    }

    /// A hook naming nobody at all.
    ///
    /// Built byte by byte rather than through `HyperionHook::encode`, because that refuses to
    /// serialise a zero key in the first place and the point here is to watch the contract on the
    /// receiving end refuse it.
    pub fn hook_to_nobody(&self) -> Bytes {
        let mut raw = Bytes::new(&self.env);
        raw.push_back(cctp::HOOK_VERSION);
        raw.push_back(hyperion_core::address::KIND_ACCOUNT);
        raw.append(&Bytes::from_array(&self.env, &[0u8; 32]));
        raw
    }

    pub fn hook_to_account(&self, key: &[u8; 32]) -> Bytes {
        HyperionHook::new(StellarDestination::account(BytesN::from_array(
            &self.env, key,
        )))
        .encode(&self.env)
        .unwrap()
    }

    pub fn hook_to_contract(&self, addr: &Address) -> Bytes {
        let key = codec::contract_key(&self.env, addr).unwrap();
        HyperionHook::new(StellarDestination::contract(BytesN::from_array(
            &self.env, &key,
        )))
        .encode(&self.env)
        .unwrap()
    }

    /// A hook naming a muxed account, which this route has nowhere to put.
    pub fn hook_to_muxed(&self) -> Bytes {
        HyperionHook::new(StellarDestination::muxed(
            BytesN::from_array(&self.env, &self.classic_key),
            99,
        ))
        .encode(&self.env)
        .unwrap()
    }

    // -------------------------------------------------------------------------------------
    // Messages
    // -------------------------------------------------------------------------------------

    /// A well formed inbound message from Ethereum, paying the world's recipient.
    pub fn inbound(&self, amount: i128, nonce_tail: u64) -> Bytes {
        self.spec(amount, nonce_tail, self.hook_to_recipient())
            .encode(&self.env)
    }

    /// The same, with a hook of the caller's choosing.
    pub fn inbound_with_hook(&self, amount: i128, nonce_tail: u64, hook: Bytes) -> Bytes {
        self.spec(amount, nonce_tail, hook).encode(&self.env)
    }

    /// A well formed message paying the classic account, which cannot receive the asset.
    pub fn inbound_to_classic(&self, amount: i128, nonce_tail: u64) -> Bytes {
        self.spec(amount, nonce_tail, self.hook_to_classic())
            .encode(&self.env)
    }

    /// The default wire message these tests build on, ready to be bent out of shape.
    pub fn spec(&self, amount: i128, nonce_tail: u64, hook: Bytes) -> MessageSpec {
        let mut nonce = [0u8; 32];
        nonce[24..].copy_from_slice(&nonce_tail.to_be_bytes());
        MessageSpec {
            version: cctp::MESSAGE_VERSION,
            source_domain: ETHEREUM_DOMAIN,
            destination_domain: cctp::STELLAR_DOMAIN,
            nonce,
            sender: [0xE1u8; 32],
            recipient: self.messenger_key(),
            min_finality_threshold: cctp::FINALITY_THRESHOLD_FINALIZED,
            finality_threshold_executed: cctp::FINALITY_THRESHOLD_FINALIZED,
            burn_version: cctp::BURN_MESSAGE_VERSION,
            burn_token: ETH_USDC,
            mint_recipient: self.adapter_key(),
            amount,
            message_sender: [0x5Eu8; 32],
            hook,
        }
    }

    /// Anything nonempty. The stand-in transmitter only checks that a signature is there, which
    /// is the whole of what a test can honestly say about Circle's cryptography.
    pub fn attestation(&self) -> Bytes {
        Bytes::from_array(&self.env, &[0x51u8; 65])
    }
}

/// A CCTP v2 message, field by field, before it becomes bytes.
///
/// Every inbound test starts from a valid one of these and breaks exactly one field, which is the
/// only way to be sure a refusal came from the reason the test claims and not from three other
/// things being wrong at once.
pub struct MessageSpec {
    pub version: u32,
    pub source_domain: u32,
    pub destination_domain: u32,
    pub nonce: [u8; 32],
    pub sender: [u8; 32],
    pub recipient: [u8; 32],
    pub min_finality_threshold: u32,
    pub finality_threshold_executed: u32,
    pub burn_version: u32,
    pub burn_token: [u8; 32],
    pub mint_recipient: [u8; 32],
    pub amount: i128,
    pub message_sender: [u8; 32],
    pub hook: Bytes,
}

impl MessageSpec {
    /// Lay the fields out at the byte offsets Circle's own contracts read them from.
    pub fn encode(&self, env: &Env) -> Bytes {
        let mut header = [0u8; cctp::MSG_BODY as usize];
        header[0..4].copy_from_slice(&self.version.to_be_bytes());
        header[4..8].copy_from_slice(&self.source_domain.to_be_bytes());
        header[8..12].copy_from_slice(&self.destination_domain.to_be_bytes());
        header[12..44].copy_from_slice(&self.nonce);
        header[44..76].copy_from_slice(&self.sender);
        header[76..108].copy_from_slice(&self.recipient);
        // 108..140 is the destination caller. Left at zero, which is CCTP for anybody may
        // broadcast this, and is how Hyperion's relayer expects to find it.
        header[140..144].copy_from_slice(&self.min_finality_threshold.to_be_bytes());
        header[144..148].copy_from_slice(&self.finality_threshold_executed.to_be_bytes());

        let mut body = [0u8; cctp::BURN_HOOK_DATA as usize];
        body[0..4].copy_from_slice(&self.burn_version.to_be_bytes());
        body[4..36].copy_from_slice(&self.burn_token);
        body[36..68].copy_from_slice(&self.mint_recipient);
        // A uint256 holding a number that fits in sixteen bytes, so the low half is where it goes.
        body[84..100].copy_from_slice(&(self.amount as u128).to_be_bytes());
        body[100..132].copy_from_slice(&self.message_sender);
        // 132..228 is max fee, fee executed and expiration block. Zero means Circle charged
        // nothing, which is what a finalized transfer costs.

        let mut out = Bytes::from_array(env, &header);
        out.append(&Bytes::from_array(env, &body));
        out.append(&self.hook);
        out
    }
}

/// What the router's fee leaves on an amount, once it has been floored for the far side.
pub fn net_of(gross: i128) -> i128 {
    let floored = gross - gross % 10;
    floored - floored * i128::from(FEE_BPS) / 10_000
}
