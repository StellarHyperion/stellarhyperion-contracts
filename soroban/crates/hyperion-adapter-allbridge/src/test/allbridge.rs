//! A stand-in for Allbridge Core: the bridge, the messenger and a pool.
//!
//! Transcribed from `allbridge-io/allbridge-core-soroban-contracts` and kept faithful in the
//! three places that can actually break this adapter.
//!
//! The first is the order of operations in `swap_and_bridge`. The pool is paid before the relay
//! fee is checked, and the messenger is paid out of the bridge's own balance before the sender's
//! gas is pulled. An adapter written against a tidier order would pass every test built on one.
//!
//! The second is where each signature is demanded. The pool asks the sender to sign two frames
//! below this adapter and the token asks again one frame below that, and the bridge asks for the
//! gas payment on its own account. Every one of those is a separate authorisation this contract
//! has to have granted in advance, and a stand-in that asked for fewer would let a broken
//! adapter through.
//!
//! The third is `hash_message`, reproduced byte for byte including the two chain ids stamped over
//! the front of the digest, because the messenger reads the destination chain back out of those
//! two bytes rather than being told it.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, token, vec, Address, BytesN, Env, IntoVal, Map, Symbol,
    U256,
};

use crate::rail::{AnotherBridge, BridgeConfig};

/// Allbridge's own error numbers, in Allbridge's own order, for the refusals this adapter can
/// provoke. Reproduced so a test can tell a refusal from the rail apart from one of Hyperion's.
#[soroban_sdk::contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RailError {
    Unauthorized = 1,
    SwapProhibited = 2,
    AmountTooLowForFee = 3,
    BridgeToTheZeroAddress = 4,
    NoPool = 5,
    NotFound = 6,
    UnknownAnotherChain = 7,
    UnknownAnotherToken = 8,
    InvalidOtherChainId = 9,
    TokensAlreadySent = 10,
    HasMessage = 11,
    NotConfigured = 12,
}

/// What the bridge recorded about the last transfer it sent.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SentRecord {
    pub sender: Address,
    pub token: Address,
    pub amount: u128,
    pub recipient: BytesN<32>,
    pub destination_chain_id: u32,
    pub receive_token: BytesN<32>,
    pub nonce: U256,
    pub gas_amount: u128,
    pub fee_token_amount: u128,
    /// What the pool said the sale was worth, which is the number that actually crosses.
    pub v_usd: u128,
    pub message: BytesN<32>,
}

#[contracttype]
enum Key {
    Native,
    Messenger,
    Rebalancer,
    CanSwap,
    Pool(BytesN<32>),
    Remote(u32),
    Cost(u32),
    Last,
    Count,
}

const STELLAR_CHAIN_ID: u32 = 7;

// ------------------------------------------------------------------------------------------
// The bridge
// ------------------------------------------------------------------------------------------

#[contract]
pub struct MockBridge;

#[contractimpl]
impl MockBridge {
    pub fn initialize(env: Env, native: Address, messenger: Address, rebalancer: Address) {
        let s = env.storage().instance();
        s.set(&Key::Native, &native);
        s.set(&Key::Messenger, &messenger);
        s.set(&Key::Rebalancer, &rebalancer);
        s.set(&Key::CanSwap, &true);
        s.set(&Key::Count, &0u32);
    }

    // -- test wiring -----------------------------------------------------------------------

    pub fn add_pool(env: Env, pool: Address, token: BytesN<32>) {
        env.storage().instance().set(&Key::Pool(token), &pool);
    }

    pub fn register_bridge(env: Env, chain_id: u32, address: BytesN<32>) {
        env.storage().instance().set(
            &Key::Remote(chain_id),
            &AnotherBridge {
                address,
                tokens: Map::new(&env),
            },
        );
    }

    pub fn add_bridge_token(env: Env, chain_id: u32, token: BytesN<32>) {
        let mut remote: AnotherBridge = env
            .storage()
            .instance()
            .get(&Key::Remote(chain_id))
            .expect("register the bridge first");
        remote.tokens.set(token, true);
        env.storage()
            .instance()
            .set(&Key::Remote(chain_id), &remote);
    }

    pub fn set_cost(env: Env, chain_id: u32, cost: u128) {
        env.storage().instance().set(&Key::Cost(chain_id), &cost);
    }

    pub fn set_can_swap(env: Env, can_swap: bool) {
        env.storage().instance().set(&Key::CanSwap, &can_swap);
    }

    pub fn set_rebalancer(env: Env, rebalancer: Address) {
        env.storage().instance().set(&Key::Rebalancer, &rebalancer);
    }

    pub fn last_sent(env: Env) -> Option<SentRecord> {
        env.storage().instance().get(&Key::Last)
    }

    pub fn sent_count(env: Env) -> u32 {
        env.storage().instance().get(&Key::Count).unwrap_or(0)
    }

    // -- the call this adapter makes --------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn swap_and_bridge(
        env: Env,
        sender: Address,
        token: Address,
        amount: u128,
        recipient: BytesN<32>,
        destination_chain_id: u32,
        receive_token: BytesN<32>,
        nonce: U256,
        gas_amount: u128,
        fee_token_amount: u128,
    ) -> Result<(), RailError> {
        let s = env.storage().instance();
        if !s.get(&Key::CanSwap).unwrap_or(false) {
            return Err(RailError::SwapProhibited);
        }
        sender.require_auth();

        if amount <= fee_token_amount {
            return Err(RailError::AmountTooLowForFee);
        }
        if recipient == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(RailError::BridgeToTheZeroAddress);
        }

        let token_key = token_bytes(&env, &token);
        let pool: Address = s.get(&Key::Pool(token_key)).ok_or(RailError::NoPool)?;

        // Upstream converts a token denominated fee here, before the sale. Hyperion always
        // passes zero, so the branch is left as a refusal rather than pretended at: a stand-in
        // that quietly accepted a nonzero fee would hide an adapter that started sending one.
        if fee_token_amount != 0 {
            return Err(RailError::NotConfigured);
        }

        let rebalancer: Address = s.get(&Key::Rebalancer).unwrap();
        let v_usd = crate::test::allbridge::MockPoolClient::new(&env, &pool).swap_to_v_usd(
            &sender,
            &amount,
            &(rebalancer == sender),
        );

        Self::send_tokens(
            &env,
            &sender,
            &token,
            amount,
            v_usd,
            &recipient,
            destination_chain_id,
            &receive_token,
            &nonce,
            gas_amount,
            fee_token_amount,
        )
    }

    // -- views ------------------------------------------------------------------------------

    pub fn get_pool_address(env: Env, token_address: BytesN<32>) -> Result<Address, RailError> {
        env.storage()
            .instance()
            .get(&Key::Pool(token_address))
            .ok_or(RailError::NotFound)
    }

    pub fn get_transaction_cost(env: Env, chain_id: u32) -> u128 {
        env.storage()
            .instance()
            .get(&Key::Cost(chain_id))
            .unwrap_or(0)
    }

    pub fn get_config(env: Env) -> BridgeConfig {
        let s = env.storage().instance();
        BridgeConfig {
            messenger: s.get(&Key::Messenger).unwrap(),
            rebalancer: s.get(&Key::Rebalancer).unwrap(),
            from_gas_oracle_factor: Map::new(&env),
            bridging_fee_conversion_factor: Map::new(&env),
            pools: Map::new(&env),
            can_swap: s.get(&Key::CanSwap).unwrap_or(false),
        }
    }

    pub fn get_another_bridge(env: Env, chain_id: u32) -> Result<AnotherBridge, RailError> {
        env.storage()
            .instance()
            .get(&Key::Remote(chain_id))
            .ok_or(RailError::UnknownAnotherChain)
    }
}

impl MockBridge {
    /// Upstream's `send_tokens`, in upstream's order.
    ///
    /// The two things worth keeping: the messenger is paid out of this contract's own balance
    /// before the sender's gas is touched, and the affordability check happens after the message
    /// has already gone out.
    #[allow(clippy::too_many_arguments)]
    fn send_tokens(
        env: &Env,
        sender: &Address,
        _token: &Address,
        amount: u128,
        v_usd: u128,
        recipient: &BytesN<32>,
        destination_chain_id: u32,
        receive_token: &BytesN<32>,
        nonce: &U256,
        gas_amount: u128,
        fee_token_amount: u128,
    ) -> Result<(), RailError> {
        let s = env.storage().instance();
        if destination_chain_id == STELLAR_CHAIN_ID {
            return Err(RailError::InvalidOtherChainId);
        }
        let remote: AnotherBridge = s
            .get(&Key::Remote(destination_chain_id))
            .ok_or(RailError::UnknownAnotherChain)?;
        if remote.tokens.get(receive_token.clone()) != Some(true) {
            return Err(RailError::UnknownAnotherToken);
        }

        let message = hash_message(
            env,
            v_usd,
            recipient,
            STELLAR_CHAIN_ID,
            destination_chain_id,
            receive_token,
            nonce,
        );

        let native: Address = s.get(&Key::Native).unwrap();
        let messenger: Address = s.get(&Key::Messenger).unwrap();
        let this = env.current_contract_address();
        let bridge_cost: u128 = s.get(&Key::Cost(destination_chain_id)).unwrap_or(0);
        let message_cost =
            MockMessengerClient::new(env, &messenger).get_transaction_cost(&destination_chain_id);

        env.authorize_as_current_contract(vec![
            env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: native.clone(),
                    fn_name: Symbol::new(env, "transfer"),
                    args: (
                        this.clone(),
                        messenger.clone(),
                        i128::try_from(message_cost).unwrap(),
                    )
                        .into_val(env),
                },
                sub_invocations: vec![env],
            }),
        ]);
        MockMessengerClient::new(env, &messenger).send_message(&message, &this);

        if bridge_cost + message_cost > gas_amount + fee_token_amount {
            return Err(RailError::AmountTooLowForFee);
        }

        if gas_amount > 0 {
            token::Client::new(env, &native).transfer(
                sender,
                &this,
                &i128::try_from(gas_amount).unwrap(),
            );
        }

        s.set(
            &Key::Last,
            &SentRecord {
                sender: sender.clone(),
                token: _token.clone(),
                amount,
                recipient: recipient.clone(),
                destination_chain_id,
                receive_token: receive_token.clone(),
                nonce: nonce.clone(),
                gas_amount,
                fee_token_amount,
                v_usd,
                message,
            },
        );
        let count: u32 = s.get(&Key::Count).unwrap_or(0);
        s.set(&Key::Count, &(count + 1));
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------
// The pool
// ------------------------------------------------------------------------------------------

#[contracttype]
enum PoolKey {
    Bridge,
    Token,
    FeeBps,
    Sold,
}

#[contract]
pub struct MockPool;

#[contractimpl]
impl MockPool {
    pub fn initialize(env: Env, bridge: Address, asset: Address, fee_bps: u32) {
        let s = env.storage().instance();
        s.set(&PoolKey::Bridge, &bridge);
        s.set(&PoolKey::Token, &asset);
        s.set(&PoolKey::FeeBps, &fee_bps);
        s.set(&PoolKey::Sold, &0u128);
    }

    /// Sell into the pool. Both the seller and the bridge have to have signed.
    ///
    /// The bridge check is upstream's, and it is the reason nobody can drive a pool sale except
    /// through the bridge. It is satisfied here by the bridge being the direct invoker.
    pub fn swap_to_v_usd(env: Env, user: Address, amount: u128, zero_fee: bool) -> u128 {
        user.require_auth();
        let s = env.storage().instance();
        let bridge: Address = s.get(&PoolKey::Bridge).unwrap();
        bridge.require_auth();

        let asset: Address = s.get(&PoolKey::Token).unwrap();
        token::Client::new(&env, &asset).transfer(
            &user,
            env.current_contract_address(),
            &i128::try_from(amount).unwrap(),
        );

        let fee_bps: u32 = s.get(&PoolKey::FeeBps).unwrap();
        let fee = if zero_fee {
            0
        } else {
            amount * u128::from(fee_bps) / 10_000
        };
        let sold: u128 = s.get(&PoolKey::Sold).unwrap_or(0);
        s.set(&PoolKey::Sold, &(sold + amount));
        amount - fee
    }

    /// How much this pool has taken in, so a test can say the sale happened exactly once.
    pub fn sold(env: Env) -> u128 {
        env.storage().instance().get(&PoolKey::Sold).unwrap_or(0)
    }
}

// ------------------------------------------------------------------------------------------
// The messenger
// ------------------------------------------------------------------------------------------

#[contracttype]
enum MsgKey {
    Native,
    Cost(u32),
    Last,
    Count,
}

#[contract]
pub struct MockMessenger;

#[contractimpl]
impl MockMessenger {
    pub fn initialize(env: Env, native: Address) {
        env.storage().instance().set(&MsgKey::Native, &native);
        env.storage().instance().set(&MsgKey::Count, &0u32);
    }

    pub fn set_cost(env: Env, chain_id: u32, cost: u128) {
        env.storage().instance().set(&MsgKey::Cost(chain_id), &cost);
    }

    pub fn get_transaction_cost(env: Env, chain_id: u32) -> u128 {
        env.storage()
            .instance()
            .get(&MsgKey::Cost(chain_id))
            .unwrap_or(0)
    }

    /// Charge the sender and remember the message.
    ///
    /// The destination chain is read out of byte one of the digest, which is the reason
    /// `hash_message` stamps it there and the reason this stand-in reproduces that.
    pub fn send_message(env: Env, message: BytesN<32>, sender: Address) {
        sender.require_auth();
        let s = env.storage().instance();
        let native: Address = s.get(&MsgKey::Native).unwrap();
        let to_chain = u32::from(message.get(1).unwrap());
        let cost: u128 = s.get(&MsgKey::Cost(to_chain)).unwrap_or(0);
        if cost > 0 {
            token::Client::new(&env, &native).transfer(
                &sender,
                env.current_contract_address(),
                &i128::try_from(cost).unwrap(),
            );
        }
        s.set(&MsgKey::Last, &message);
        let count: u32 = s.get(&MsgKey::Count).unwrap_or(0);
        s.set(&MsgKey::Count, &(count + 1));
    }

    pub fn last_message(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&MsgKey::Last)
    }

    pub fn sent_count(env: Env) -> u32 {
        env.storage().instance().get(&MsgKey::Count).unwrap_or(0)
    }
}

// ------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------

fn token_bytes(env: &Env, token: &Address) -> BytesN<32> {
    BytesN::from_array(
        env,
        &hyperion_core::codec::contract_key(env, token).unwrap(),
    )
}

/// Allbridge's message digest, byte for byte.
///
/// The two overwritten bytes at the front are not a quirk to be tidied away. The messenger reads
/// the source and destination chain out of them, so a digest built without them routes nowhere.
fn hash_message(
    env: &Env,
    amount: u128,
    recipient: &BytesN<32>,
    source_chain_id: u32,
    destination_chain_id: u32,
    receive_token: &BytesN<32>,
    nonce: &U256,
) -> BytesN<32> {
    crate::rail::hash_message(
        env,
        amount,
        recipient,
        source_chain_id,
        destination_chain_id,
        receive_token,
        nonce,
    )
}
