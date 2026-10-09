//! Allbridge Core, as this adapter needs to see it.
//!
//! Transcribed from `allbridge-io/allbridge-core-soroban-contracts` rather than imported. The
//! upstream crates are not published, the WASM is pulled in over there with `contractimport!`
//! from a build directory, and vendoring either would drag a second workspace into this one for
//! the sake of six function signatures.
//!
//! What matters is that the shapes below match the wire exactly. Argument order and type are the
//! whole contract, and the tests in this crate run against a stand-in built from the same source.

// The argument count in `swap_and_bridge` is Allbridge's, not a choice made here.
// Transcribing their signature faithfully is the whole point of this file, so the lint is
// switched off rather than the shape reworked into something that would not compile against
// the real contract.
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{contractclient, Address, BytesN, Env, Map, U256};

/// Allbridge's own numeric id for the Stellar network.
///
/// The bridge refuses a destination equal to its own id, so this is also the one chain id a
/// Hyperion lane can never point at.
pub const STELLAR_CHAIN_ID: u32 = 7;

/// The bridge's instance config, as `get_config` returns it.
///
/// Only `messenger` and `can_swap` are read here. The rest is carried so the type decodes.
#[soroban_sdk::contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeConfig {
    pub messenger: Address,
    pub rebalancer: Address,
    pub from_gas_oracle_factor: Map<Address, u128>,
    pub bridging_fee_conversion_factor: Map<Address, u128>,
    pub pools: Map<BytesN<32>, Address>,
    pub can_swap: bool,
}

/// A bridge Allbridge has registered on another chain, with the tokens it will accept.
#[soroban_sdk::contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnotherBridge {
    pub address: BytesN<32>,
    pub tokens: Map<BytesN<32>, bool>,
}

/// The Allbridge Core bridge contract.
#[contractclient(name = "AllbridgeBridgeClient")]
pub trait AllbridgeBridge {
    /// Take `amount` of `token` from `sender` and send it to `recipient` on another chain.
    ///
    /// The two payment arguments are alternatives. `gas_amount` is native token pulled from
    /// `sender`; `fee_token_amount` is carved out of `amount` and converted at the gas oracle's
    /// price. Between them they have to cover the bridge's cost plus the messenger's, or the
    /// call reverts. Hyperion pays in native and leaves `fee_token_amount` at zero, so the
    /// amount that reaches the pool is the amount the router handed over.
    fn swap_and_bridge(
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
    );

    /// The pool holding a token, keyed by the token's address as thirty two bytes.
    fn get_pool_address(env: Env, token_address: BytesN<32>) -> Address;

    /// What the bridge itself will spend relaying to a chain, in native token.
    ///
    /// Not the whole cost. The messenger charges separately and the bridge checks the sum.
    fn get_transaction_cost(env: Env, chain_id: u32) -> u128;

    fn get_config(env: Env) -> BridgeConfig;

    fn get_another_bridge(env: Env, chain_id: u32) -> AnotherBridge;
}

/// The messenger contract, which carries the attestation and charges for it separately.
#[contractclient(name = "AllbridgeMessengerClient")]
pub trait AllbridgeMessenger {
    fn get_transaction_cost(env: Env, chain_id: u32) -> u128;
}

/// The pool a token lives in. Declared only so the outbound authorisation can name the call.
#[contractclient(name = "AllbridgePoolClient")]
pub trait AllbridgePool {
    fn swap_to_v_usd(env: Env, user: Address, amount: u128, zero_fee: bool) -> u128;
}

/// Allbridge's message digest, byte for byte.
///
/// The two overwritten bytes at the front are not a quirk to be tidied away. The messenger reads
/// the source and destination chain out of them, so a digest built without them routes nowhere.
pub fn hash_message(
    env: &Env,
    amount: u128,
    recipient: &BytesN<32>,
    source_chain_id: u32,
    destination_chain_id: u32,
    receive_token: &BytesN<32>,
    nonce: &U256,
) -> BytesN<32> {
    let mut buf = soroban_sdk::Bytes::new(env);
    buf.extend_from_slice(&[0u8; 16]);
    buf.extend_from_slice(&amount.to_be_bytes());
    buf.extend_from_array(&recipient.to_array());
    buf.append(&U256::from_u32(env, source_chain_id).to_be_bytes());
    buf.extend_from_array(&receive_token.to_array());
    buf.append(&nonce.to_be_bytes());
    buf.extend_from_slice(&1u8.to_be_bytes());

    let digest: BytesN<32> = env.crypto().keccak256(&buf).into();
    let mut out = digest.to_array();
    out[0] = source_chain_id as u8;
    out[1] = destination_chain_id as u8;
    BytesN::from_array(env, &out)
}
