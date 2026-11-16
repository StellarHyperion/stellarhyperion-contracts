//! Hyperion's adapter for Allbridge Core.
//!
//! Allbridge Core is the pooled rail. There is no attestation to wait for on the way out and no
//! wrapped asset at the far end: a transfer sells into a pool on this side, crosses as an
//! internal unit Allbridge calls vUSD, and buys out of a pool on the other. That makes it the
//! fastest route Hyperion can offer and the only one where the amount that arrives is not the
//! amount that left. Slippage is the price of not waiting.
//!
//! # Inbound delivery resolution
//!
//! Inbound transfers verify signed validator messages from Allbridge Core. The digest signed by
//! the validators covers `(amount, recipient, source_chain_id, destination_chain_id, receive_token, nonce)`.
//! The adapter verifies the ed25519 signature against the registered validator key, guards against
//! replay attacks, ensures the local asset mapping is valid, pre-authorises the transfer to the router,
//! and forwards the verified delivery to `router.bridge_in`.
//!
//! One consequence worth stating plainly: `receive_amount_min`, the slippage guard, is chosen by
//! whoever calls `receive_tokens` on the destination chain. Outbound from Stellar that is not
//! Hyperion, and `swap_and_bridge` has no minimum of its own, so this contract cannot promise an
//! amount out. The route planner quotes Allbridge as the lossy option for that reason.
//!
//! # The gas float
//!
//! Allbridge charges for relaying, in native token, at the moment the transfer is made. There is
//! no equivalent of Axelar's `add_gas` to top a message up afterwards, so the payment has to be
//! attached up front or the message is never carried.
//!
//! The bridge takes it two ways: `gas_amount`, pulled from the sender in native token, or
//! `fee_token_amount`, carved out of the transfer itself and converted at the gas oracle's
//! price. Hyperion pays in native. Paying from the transfer would mean this contract reproducing
//! Allbridge's fee conversion arithmetic to work out how much to carve off, getting it wrong by
//! a rounding unit on a price that moves, and silently delivering less than the router told the
//! user it would.
//!
//! So the contract holds a small native float and spends from it. Anybody may top it up and the
//! balance is a view, so a keeper watches one number and a transfer that would arrive unrelayed
//! is refused before it starts rather than after the funds are gone. The cost is read live from
//! the bridge and the messenger on every dispatch, never configured, because it moves with the
//! destination chain's gas price. `sweep` refuses to touch the native asset, so the float cannot
//! be tidied away by a well meaning keeper.
//!
//! # What this contract does not do
//!
//! It holds no pool, quotes no price, and trusts Allbridge's own numbers for the pool address, the
//! relay cost and the rebalancer. Every one of those is read at the moment it is used rather than
//! written down here, so there is nothing to keep in step.

#![no_std]
#![allow(clippy::too_many_arguments)]

mod events;
mod storage;

// Public so the rail interface this adapter was built against is readable from outside it, and
// so the deploy tooling can generate bindings from these shapes rather than transcribe them a
// second time.
pub mod rail;
pub mod types;

#[cfg(test)]
mod test;

use hyperion_core::{
    address::{assert_route_supports, bytes32_to_evm},
    codec,
    inbound::{Origin, Recipient, RouterClient},
    HyperionError, RouteKind,
};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, token, vec, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, U256,
};

use rail::{AllbridgeBridgeClient, AllbridgeMessengerClient, STELLAR_CHAIN_ID};
use types::{AssetLink, ChainLane, Config, PendingValidatorRotation, ValidatorState};

/// Minimum reviewed delay (1 hour) required before a queued validator rotation can take effect.
pub const MIN_TRUST_CHANGE_DELAY: u64 = 3_600;
/// Maximum configurable delay (7 days) for a validator rotation.
pub const MAX_TRUST_CHANGE_DELAY: u64 = 604_800;
/// Default reviewed delay (24 hours) when no explicit delay has been configured.
pub const DEFAULT_TRUST_CHANGE_DELAY: u64 = 86_400;
/// Execution window (48 hours) after `eta` before an unexecuted rotation expires.
pub const ROTATION_GRACE_PERIOD: u64 = 172_800;

#[contract]
pub struct AllbridgeAdapter;

#[contractimpl]
impl AllbridgeAdapter {
    /// Wire the adapter up.
    ///
    /// Starts with no lane and no asset, so a deploy script that stops halfway leaves something
    /// that refuses every transfer rather than something that guesses.
    pub fn initialize(
        env: Env,
        admin: Address,
        router: Address,
        bridge: Address,
        native: Address,
    ) -> Result<(), HyperionError> {
        if storage::is_initialized(&env) {
            return Err(HyperionError::AlreadyInitialized);
        }
        storage::set_config(
            &env,
            &Config {
                admin,
                router,
                bridge,
                native,
            },
        );
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Outbound
    // ---------------------------------------------------------------------------------------

    /// Sell funds the router has already moved here into Allbridge's pool and send them on.
    ///
    /// By the time this runs the money is sitting in this contract's balance, so the work is
    /// working out who to pay, what it costs to be relayed, and authorising exactly the two
    /// calls Allbridge will make back through this contract's identity.
    pub fn dispatch(
        env: Env,
        caller: Address,
        token: Address,
        amount: i128,
        destination_chain: String,
        destination: BytesN<32>,
        nonce: u64,
    ) -> Result<(), HyperionError> {
        caller.require_auth();
        let cfg = storage::config(&env)?;
        if caller != cfg.router {
            return Err(HyperionError::Unauthorized);
        }
        if amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        let lane = storage::lane(&env, &destination_chain).ok_or(HyperionError::UnknownChain)?;
        let link = storage::asset(&env, &token, lane.allbridge_chain_id)
            .ok_or(HyperionError::TokenNotMapped)?;

        // Allbridge wants the recipient as thirty two bytes and will take any thirty two bytes
        // it is given. Checking here means a mistyped destination comes back as a Hyperion
        // refusal instead of arriving somewhere unrecoverable.
        let _ = bytes32_to_evm(&env, &destination)?;

        let this = env.current_contract_address();
        let bridge = AllbridgeBridgeClient::new(&env, &cfg.bridge);
        let bridge_cfg = bridge.get_config();

        // Read live. The pool for an asset can be repointed by Allbridge's admin, and a stale
        // copy here would authorise a transfer to the wrong contract.
        let token_key = codec::contract_key(&env, &token)?;
        let pool = bridge.get_pool_address(&BytesN::from_array(&env, &token_key));

        // The relay is billed in two pieces and the bridge checks the sum, so both have to be
        // asked for. Neither is stored.
        let messenger = AllbridgeMessengerClient::new(&env, &bridge_cfg.messenger);
        let cost = bridge
            .get_transaction_cost(&lane.allbridge_chain_id)
            .checked_add(messenger.get_transaction_cost(&lane.allbridge_chain_id))
            .ok_or(HyperionError::DecimalOverflow)?;
        let cost_i128 = i128::try_from(cost).map_err(|_| HyperionError::DecimalOverflow)?;

        let native = token::Client::new(&env, &cfg.native);
        if native.balance(&this) < cost_i128 {
            return Err(HyperionError::GasFloatTooLow);
        }

        let amount_u128 = u128::try_from(amount).map_err(|_| HyperionError::InvalidAmount)?;
        // Allbridge waives the pool fee for its own rebalancer and passes that decision down as
        // an argument, so the authorisation has to name the same value the bridge will. Computed
        // rather than assumed false, because an authorisation that disagrees by one boolean
        // fails at the bottom of somebody's transfer.
        let zero_fee = bridge_cfg.rebalancer == this;

        env.authorize_as_current_contract(vec![
            &env,
            // The pool asks this contract to sign for the sale, and then the token asks again
            // one frame deeper for the transfer into the pool.
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: pool.clone(),
                    fn_name: Symbol::new(&env, "swap_to_v_usd"),
                    args: (this.clone(), amount_u128, zero_fee).into_val(&env),
                },
                sub_invocations: vec![
                    &env,
                    InvokerContractAuthEntry::Contract(SubContractInvocation {
                        context: ContractContext {
                            contract: token.clone(),
                            fn_name: Symbol::new(&env, "transfer"),
                            args: (this.clone(), pool.clone(), amount).into_val(&env),
                        },
                        sub_invocations: vec![&env],
                    }),
                ],
            }),
            // And the bridge takes the relay fee out of the float on its own account.
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: cfg.native.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (this.clone(), cfg.bridge.clone(), cost_i128).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        // The router's nonce is globally unique and monotonic, which is what keeps Allbridge's
        // own sent-message hash from colliding across two identical transfers.
        let rail_nonce = U256::from_u128(&env, u128::from(nonce));

        bridge.swap_and_bridge(
            &this,
            &token,
            &amount_u128,
            &destination,
            &lane.allbridge_chain_id,
            &link.receive_token,
            &rail_nonce,
            &cost,
            // Zero, always. The float pays, not the transfer.
            &0u128,
        );

        events::Dispatched {
            token,
            chain: lane.chain,
            allbridge_chain_id: lane.allbridge_chain_id,
            amount,
            recipient: destination,
            receive_token: link.receive_token,
            nonce: rail_nonce,
            gas_spent: cost,
        }
        .publish(&env);
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Inbound
    // ---------------------------------------------------------------------------------------

    /// Verify an inbound message from Allbridge Core under the active validator epoch and deliver
    /// it via the router.
    pub fn bridge_in(
        env: Env,
        caller: Address,
        token: Address,
        amount: i128,
        recipient: Address,
        source_chain_id: u32,
        nonce: U256,
        signature: BytesN<64>,
    ) -> Result<u64, HyperionError> {
        let active_epoch = storage::validator_state(&env).map(|s| s.epoch).unwrap_or(0);
        Self::bridge_in_at_epoch(
            env,
            caller,
            token,
            amount,
            recipient,
            source_chain_id,
            nonce,
            active_epoch,
            signature,
        )
    }

    /// Verify an inbound message explicitly bound to `expected_epoch`.
    ///
    /// Refuses delivery immediately when the validator authority is emergency-disabled or when
    /// `expected_epoch` does not match the active epoch.
    pub fn bridge_in_at_epoch(
        env: Env,
        caller: Address,
        token: Address,
        amount: i128,
        recipient: Address,
        source_chain_id: u32,
        nonce: U256,
        expected_epoch: u64,
        signature: BytesN<64>,
    ) -> Result<u64, HyperionError> {
        caller.require_auth();
        let cfg = storage::config(&env)?;
        if amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        let state = storage::validator_state(&env).ok_or(HyperionError::RailNotConfigured)?;
        if state.emergency_disabled {
            return Err(HyperionError::RouteDisabled);
        }
        if expected_epoch != state.epoch {
            return Err(HyperionError::UnsupportedMessageVersion);
        }
        let source_chain =
            storage::chain_of(&env, source_chain_id).ok_or(HyperionError::UnknownChain)?;
        let _link =
            storage::asset(&env, &token, source_chain_id).ok_or(HyperionError::TokenNotMapped)?;

        let (kind, recipient_key) = codec::address_key(&env, &recipient)?;
        assert_route_supports(RouteKind::Allbridge, kind)?;

        let amount_u128 = u128::try_from(amount).map_err(|_| HyperionError::InvalidAmount)?;
        let recipient_bytes = BytesN::from_array(&env, &recipient_key);
        let token_key = codec::contract_key(&env, &token)?;
        let receive_token = BytesN::from_array(&env, &token_key);

        let message_id = rail::hash_message(
            &env,
            amount_u128,
            &recipient_bytes,
            source_chain_id,
            STELLAR_CHAIN_ID,
            &receive_token,
            &nonce,
        );

        let this = env.current_contract_address();
        let adapter_key = codec::contract_key(&env, &this)?;
        let epoch_digest = rail::hash_epoch_message(&env, &adapter_key, state.epoch, &message_id);

        if storage::is_processed(&env, &message_id) || storage::is_processed(&env, &epoch_digest) {
            return Err(HyperionError::ReplayedMessage);
        }

        if signature == BytesN::from_array(&env, &[0u8; 64]) {
            return Err(HyperionError::Unauthorized);
        }

        env.crypto()
            .ed25519_verify(&state.validator, &epoch_digest.clone().into(), &signature);

        storage::mark_processed(&env, &message_id);
        storage::mark_processed(&env, &epoch_digest);

        let asset = token::Client::new(&env, &token);
        let balance = asset.balance(&this);
        if balance < amount {
            let needed = amount
                .checked_sub(balance)
                .ok_or(HyperionError::DecimalOverflow)?;
            asset.transfer(&caller, &this, &needed);
        }

        if asset.balance(&this) < amount {
            return Err(HyperionError::NothingMinted);
        }

        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (this.clone(), cfg.router.clone(), amount).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        let mut nonce_bytes = [0u8; 32];
        nonce.to_be_bytes().copy_into_slice(&mut nonce_bytes);
        let mut tail = [0u8; 8];
        tail.copy_from_slice(&nonce_bytes[24..32]);
        let display_nonce = u64::from_be_bytes(tail);

        let claim_id = RouterClient::new(&env, &cfg.router).bridge_in(
            &this,
            &RouteKind::Allbridge,
            &token,
            &amount,
            &Recipient {
                address: recipient.clone(),
                kind,
                raw: Bytes::from_array(&env, &recipient_key),
            },
            &Origin {
                chain: source_chain.clone(),
                nonce: display_nonce,
                message_id: message_id.clone(),
                sender: BytesN::from_array(&env, &[0u8; 32]),
            },
        );

        events::Received {
            token,
            source_chain,
            amount,
            recipient,
            source_chain_id,
            nonce,
            message_id,
            claim_id,
        }
        .publish(&env);

        Ok(claim_id)
    }

    /// Alias for `bridge_in` matching the arrival interface.
    pub fn receive(
        env: Env,
        caller: Address,
        token: Address,
        amount: i128,
        recipient: Address,
        source_chain_id: u32,
        nonce: U256,
        signature: BytesN<64>,
    ) -> Result<u64, HyperionError> {
        Self::bridge_in(
            env,
            caller,
            token,
            amount,
            recipient,
            source_chain_id,
            nonce,
            signature,
        )
    }

    // ---------------------------------------------------------------------------------------
    // The gas float
    // ---------------------------------------------------------------------------------------

    /// Put native token into the float. Open to anybody.
    ///
    /// Deliberately permissionless. The float is not a balance anybody can take out, so there is
    /// nothing to gain by filling it and quite a lot to lose by having only one address able to.
    /// A keeper normally does this; on the day the keeper is down, anybody can.
    pub fn fund_gas(env: Env, funder: Address, amount: i128) -> Result<i128, HyperionError> {
        funder.require_auth();
        let cfg = storage::config(&env)?;
        if amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        let this = env.current_contract_address();
        let native = token::Client::new(&env, &cfg.native);
        native.transfer(&funder, &this, &amount);
        let balance = native.balance(&this);
        events::GasFunded {
            funder,
            amount,
            balance,
        }
        .publish(&env);
        Ok(balance)
    }

    /// Take native token back out of the float. Admin only.
    ///
    /// The one call on this contract that moves value somewhere an admin chooses, which is why
    /// it is the only one gated this tightly. It exists so a retired adapter's float is not
    /// stranded, and because the alternative to having it is topping the float up forever.
    pub fn withdraw_gas(env: Env, to: Address, amount: i128) -> Result<i128, HyperionError> {
        let cfg = require_admin(&env)?;
        if amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        let this = env.current_contract_address();
        let native = token::Client::new(&env, &cfg.native);
        if native.balance(&this) < amount {
            return Err(HyperionError::GasFloatTooLow);
        }
        native.transfer(&this, &to, &amount);
        let balance = native.balance(&this);
        events::GasWithdrawn {
            to,
            amount,
            balance,
        }
        .publish(&env);
        Ok(balance)
    }

    /// What the float holds right now.
    pub fn gas_balance(env: Env) -> Result<i128, HyperionError> {
        let cfg = storage::config(&env)?;
        Ok(token::Client::new(&env, &cfg.native).balance(&env.current_contract_address()))
    }

    /// What the next transfer to this chain will cost to be relayed, read live.
    ///
    /// Both halves of the bill, summed the way the bridge sums them. The route planner shows
    /// this so a user is told the route is short of gas before they sign rather than after.
    pub fn quote_gas(env: Env, chain: String) -> Result<u128, HyperionError> {
        let cfg = storage::config(&env)?;
        let lane = storage::lane(&env, &chain).ok_or(HyperionError::UnknownChain)?;
        let bridge = AllbridgeBridgeClient::new(&env, &cfg.bridge);
        let messenger = AllbridgeMessengerClient::new(&env, &bridge.get_config().messenger);
        bridge
            .get_transaction_cost(&lane.allbridge_chain_id)
            .checked_add(messenger.get_transaction_cost(&lane.allbridge_chain_id))
            .ok_or(HyperionError::DecimalOverflow)
    }

    // ---------------------------------------------------------------------------------------
    // Housekeeping anybody may do
    // ---------------------------------------------------------------------------------------

    /// Send a stray balance on to the treasury.
    ///
    /// Pooled routes round, and people send tokens to contracts by hand. An admin only rescue
    /// would be a standing power to move tokens out of a contract users send tokens to, so this
    /// is open to anybody and the destination is read live from the router. The native asset is
    /// refused, because that balance is the gas float and it is there on purpose.
    pub fn sweep(env: Env, caller: Address, token: Address) -> Result<i128, HyperionError> {
        caller.require_auth();
        let cfg = storage::config(&env)?;
        if token == cfg.native {
            return Err(HyperionError::ProtectedAsset);
        }
        let this = env.current_contract_address();
        let asset = token::Client::new(&env, &token);
        let balance = asset.balance(&this);
        if balance <= 0 {
            return Ok(0);
        }
        let treasury = RouterClient::new(&env, &cfg.router).treasury();
        asset.transfer(&this, &treasury, &balance);
        events::Swept {
            token,
            amount: balance,
            treasury,
            caller,
        }
        .publish(&env);
        Ok(balance)
    }

    /// Keep a quiet lane's storage from being archived. Permissionless, changes nothing.
    pub fn keep_alive(env: Env, chain: String) -> Result<(), HyperionError> {
        let _ = storage::config(&env)?;
        env.storage()
            .instance()
            .extend_ttl(storage::BUMP_THRESHOLD, storage::BUMP_TO);
        storage::touch_lane(&env, &chain);
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------------------------

    /// Pair Hyperion's name for a chain with Allbridge's number for it.
    ///
    /// Checked against Allbridge rather than taken on trust. A chain id with no bridge
    /// registered on the far side is a lane whose first transfer would revert from two contracts
    /// away, and the sum of this check is one cross-contract read while an admin is watching.
    pub fn link_chain(
        env: Env,
        chain: String,
        allbridge_chain_id: u32,
    ) -> Result<(), HyperionError> {
        let cfg = require_admin(&env)?;
        if chain.is_empty() {
            return Err(HyperionError::UnknownChain);
        }
        // Allbridge refuses a destination equal to its own id, so a lane pointing home is a lane
        // that can never carry anything.
        if allbridge_chain_id == STELLAR_CHAIN_ID {
            return Err(HyperionError::UnknownChain);
        }
        AllbridgeBridgeClient::new(&env, &cfg.bridge)
            .try_get_another_bridge(&allbridge_chain_id)
            .map_err(|_| HyperionError::UnknownChain)?
            .map_err(|_| HyperionError::UnknownChain)?;

        let lane = ChainLane {
            chain,
            allbridge_chain_id,
        };
        storage::set_lane(&env, &lane);
        events::LaneSet {
            chain: lane.chain,
            allbridge_chain_id: lane.allbridge_chain_id,
        }
        .publish(&env);
        Ok(())
    }

    /// Say which token a local asset becomes at the far end of a lane.
    ///
    /// Both halves are checked: Allbridge has to hold a pool for the local asset, and the
    /// destination bridge has to accept the token being named. Getting either wrong produces a
    /// transfer that sells into a pool and then reverts on delivery.
    pub fn link_asset(
        env: Env,
        token: Address,
        chain: String,
        receive_token: BytesN<32>,
    ) -> Result<(), HyperionError> {
        let cfg = require_admin(&env)?;
        let lane = storage::lane(&env, &chain).ok_or(HyperionError::UnknownChain)?;
        let bridge = AllbridgeBridgeClient::new(&env, &cfg.bridge);

        let token_key = codec::contract_key(&env, &token)?;
        bridge
            .try_get_pool_address(&BytesN::from_array(&env, &token_key))
            .map_err(|_| HyperionError::TokenNotMapped)?
            .map_err(|_| HyperionError::TokenNotMapped)?;

        let remote = bridge
            .try_get_another_bridge(&lane.allbridge_chain_id)
            .map_err(|_| HyperionError::UnknownChain)?
            .map_err(|_| HyperionError::UnknownChain)?;
        if remote.tokens.get(receive_token.clone()) != Some(true) {
            return Err(HyperionError::TokenNotMapped);
        }

        let link = AssetLink {
            token,
            allbridge_chain_id: lane.allbridge_chain_id,
            receive_token,
        };
        storage::set_asset(&env, &link);
        events::AssetLinked {
            token: link.token,
            allbridge_chain_id: link.allbridge_chain_id,
            receive_token: link.receive_token,
        }
        .publish(&env);
        Ok(())
    }

    /// Bootstrap the initial Allbridge validator public key at epoch 1. Admin only.
    ///
    /// Once epoch 1 has been initialized, immediate replacement is refused with
    /// `HyperionError::AlreadyConfigured`; every subsequent validator update or recovery after an
    /// emergency disable must go through `queue_validator_rotation` and wait out the configured
    /// trust-change delay.
    pub fn set_validator(env: Env, validator: BytesN<32>) -> Result<(), HyperionError> {
        let _ = require_admin(&env)?;
        if validator == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(HyperionError::ZeroAddressKey);
        }
        if storage::validator_state(&env).is_some() {
            return Err(HyperionError::AlreadyConfigured);
        }
        let state = ValidatorState {
            validator: validator.clone(),
            epoch: 1,
            activated_at: env.ledger().timestamp(),
            emergency_disabled: false,
        };
        storage::set_validator_state(&env, &state);
        events::ValidatorSet { validator }.publish(&env);
        Ok(())
    }

    /// Configure the trust-change delay (in seconds) required for queued validator rotations.
    /// Admin only; refused while a rotation is already pending so an active countdown cannot be
    /// shortened retroactively.
    pub fn set_trust_change_delay(env: Env, delay_seconds: u64) -> Result<(), HyperionError> {
        let _ = require_admin(&env)?;
        if !(MIN_TRUST_CHANGE_DELAY..=MAX_TRUST_CHANGE_DELAY).contains(&delay_seconds) {
            return Err(HyperionError::TimelockDelayOutOfRange);
        }
        if storage::pending_rotation(&env).is_some() {
            return Err(HyperionError::AlreadyConfigured);
        }
        storage::set_trust_change_delay(&env, delay_seconds);
        events::TrustChangeDelayUpdated { delay_seconds }.publish(&env);
        Ok(())
    }

    /// Queue a reviewed validator rotation for `epoch + 1`, maturing after the configured
    /// trust-change delay. Admin only.
    pub fn queue_validator_rotation(
        env: Env,
        next_validator: BytesN<32>,
    ) -> Result<PendingValidatorRotation, HyperionError> {
        let _ = require_admin(&env)?;
        if next_validator == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(HyperionError::ZeroAddressKey);
        }
        if storage::pending_rotation(&env).is_some() {
            return Err(HyperionError::AlreadyConfigured);
        }
        let current_epoch = storage::validator_state(&env).map(|s| s.epoch).unwrap_or(0);
        let next_epoch = current_epoch
            .checked_add(1)
            .ok_or(HyperionError::DecimalOverflow)?;
        let delay = storage::trust_change_delay(&env, DEFAULT_TRUST_CHANGE_DELAY);
        let queued_at = env.ledger().timestamp();
        let eta = queued_at
            .checked_add(delay)
            .ok_or(HyperionError::DecimalOverflow)?;
        let expires_at = eta
            .checked_add(ROTATION_GRACE_PERIOD)
            .ok_or(HyperionError::DecimalOverflow)?;

        let pending = PendingValidatorRotation {
            next_validator: next_validator.clone(),
            next_epoch,
            queued_at,
            eta,
            expires_at,
        };
        storage::set_pending_rotation(&env, &pending);
        events::ValidatorRotationQueued {
            next_validator,
            next_epoch,
            eta,
            expires_at,
        }
        .publish(&env);
        Ok(pending)
    }

    /// Cancel a pending validator rotation before execution. Admin only.
    pub fn cancel_validator_rotation(env: Env) -> Result<(), HyperionError> {
        let _ = require_admin(&env)?;
        let pending = storage::pending_rotation(&env).ok_or(HyperionError::TimelockNotQueued)?;
        storage::clear_pending_rotation(&env);
        events::ValidatorRotationCancelled {
            cancelled_epoch: pending.next_epoch,
        }
        .publish(&env);
        Ok(())
    }

    /// Activate a matured validator rotation, advancing to `next_epoch` and clearing any prior
    /// emergency-disable state. Admin only.
    pub fn execute_validator_rotation(env: Env) -> Result<ValidatorState, HyperionError> {
        let _ = require_admin(&env)?;
        let pending = storage::pending_rotation(&env).ok_or(HyperionError::TimelockNotQueued)?;
        let now = env.ledger().timestamp();
        if now < pending.eta {
            return Err(HyperionError::TimelockNotReady);
        }
        if now > pending.expires_at {
            return Err(HyperionError::TimelockExpired);
        }
        storage::clear_pending_rotation(&env);
        let state = ValidatorState {
            validator: pending.next_validator.clone(),
            epoch: pending.next_epoch,
            activated_at: now,
            emergency_disabled: false,
        };
        storage::set_validator_state(&env, &state);
        events::ValidatorRotated {
            validator: state.validator.clone(),
            epoch: state.epoch,
        }
        .publish(&env);
        Ok(state)
    }

    /// Immediately halt inbound validator signature acceptance without affecting parked router
    /// claims. Also clears any unexecuted rotation so recovery requires a fresh delayed rotation.
    pub fn emergency_disable_validator(env: Env) -> Result<ValidatorState, HyperionError> {
        let _ = require_admin(&env)?;
        let mut state = storage::validator_state(&env).ok_or(HyperionError::RailNotConfigured)?;
        state.emergency_disabled = true;
        storage::set_validator_state(&env, &state);
        storage::clear_pending_rotation(&env);
        events::ValidatorEmergencyDisabled {
            validator: state.validator.clone(),
            epoch: state.epoch,
        }
        .publish(&env);
        Ok(state)
    }

    /// Hand the admin role to somebody else.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), HyperionError> {
        let mut cfg = require_admin(&env)?;
        let old = cfg.admin.clone();
        cfg.admin = new_admin.clone();
        storage::set_config(&env, &cfg);
        events::AdminChanged {
            old,
            new: new_admin,
        }
        .publish(&env);
        Ok(())
    }

    /// Replace this contract's code.
    ///
    /// An adapter is the one part of Hyperion that has to change when somebody else's rail
    /// changes, so being able to upgrade it is the difference between shipping a fix and
    /// redeploying the world.
    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) -> Result<(), HyperionError> {
        require_admin(&env)?;
        env.deployer()
            .update_current_contract(soroban_sdk::ContractExecutable::Wasm(wasm_hash));
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    pub fn get_config(env: Env) -> Result<Config, HyperionError> {
        storage::config(&env)
    }

    /// The route this adapter serves, which is only ever the one.
    pub fn route(env: Env) -> Result<RouteKind, HyperionError> {
        let _ = storage::config(&env)?;
        Ok(RouteKind::Allbridge)
    }

    pub fn get_lane(env: Env, chain: String) -> Result<ChainLane, HyperionError> {
        storage::lane(&env, &chain).ok_or(HyperionError::UnknownChain)
    }

    /// Hyperion's name for the chain Allbridge numbers this.
    pub fn chain_for(env: Env, allbridge_chain_id: u32) -> Result<String, HyperionError> {
        storage::chain_of(&env, allbridge_chain_id).ok_or(HyperionError::UnknownChain)
    }

    pub fn get_asset(env: Env, token: Address, chain: String) -> Result<AssetLink, HyperionError> {
        let lane = storage::lane(&env, &chain).ok_or(HyperionError::UnknownChain)?;
        storage::asset(&env, &token, lane.allbridge_chain_id).ok_or(HyperionError::TokenNotMapped)
    }

    /// The pool Allbridge currently holds this asset in, read live.
    pub fn pool_for(env: Env, token: Address) -> Result<Address, HyperionError> {
        let cfg = storage::config(&env)?;
        let token_key = codec::contract_key(&env, &token)?;
        AllbridgeBridgeClient::new(&env, &cfg.bridge)
            .try_get_pool_address(&BytesN::from_array(&env, &token_key))
            .map_err(|_| HyperionError::TokenNotMapped)?
            .map_err(|_| HyperionError::TokenNotMapped)
    }

    /// Whether Allbridge is currently accepting transfers at all.
    ///
    /// Allbridge's own stop authority can halt swapping, and a route planner that did not ask
    /// would keep offering a rail that reverts on every attempt.
    pub fn rail_open(env: Env) -> Result<bool, HyperionError> {
        let cfg = storage::config(&env)?;
        Ok(AllbridgeBridgeClient::new(&env, &cfg.bridge)
            .get_config()
            .can_swap)
    }

    /// Read the registered Allbridge validator public key.
    pub fn get_validator(env: Env) -> Result<BytesN<32>, HyperionError> {
        storage::validator(&env).ok_or(HyperionError::RailNotConfigured)
    }

    /// Read the active validator authority state including epoch and emergency status.
    pub fn validator_state(env: Env) -> Result<ValidatorState, HyperionError> {
        let _ = storage::config(&env)?;
        storage::validator_state(&env).ok_or(HyperionError::RailNotConfigured)
    }

    /// Read the active validator epoch (0 when no validator has been bootstrapped yet).
    pub fn validator_epoch(env: Env) -> Result<u64, HyperionError> {
        let _ = storage::config(&env)?;
        Ok(storage::validator_state(&env).map(|s| s.epoch).unwrap_or(0))
    }

    /// Read the currently queued validator rotation, if any.
    pub fn pending_validator_rotation(
        env: Env,
    ) -> Result<Option<PendingValidatorRotation>, HyperionError> {
        let _ = storage::config(&env)?;
        Ok(storage::pending_rotation(&env))
    }

    /// Read the configured trust-change delay in seconds.
    pub fn trust_change_delay(env: Env) -> Result<u64, HyperionError> {
        let _ = storage::config(&env)?;
        Ok(storage::trust_change_delay(
            &env,
            DEFAULT_TRUST_CHANGE_DELAY,
        ))
    }

    /// Compute the epoch-bound signing digest for a canonical Allbridge `message_id` and `epoch`.
    pub fn epoch_signing_digest(
        env: Env,
        message_id: BytesN<32>,
        epoch: u64,
    ) -> Result<BytesN<32>, HyperionError> {
        let _ = storage::config(&env)?;
        let adapter_key = codec::contract_key(&env, &env.current_contract_address())?;
        Ok(rail::hash_epoch_message(
            &env,
            &adapter_key,
            epoch,
            &message_id,
        ))
    }

    /// Check if an inbound message has already been processed.
    pub fn is_processed(env: Env, message_id: BytesN<32>) -> Result<bool, HyperionError> {
        let _ = storage::config(&env)?;
        Ok(storage::is_processed(&env, &message_id))
    }
}

/// Read the config and insist the admin signed for whatever is about to happen.
fn require_admin(env: &Env) -> Result<Config, HyperionError> {
    let cfg = storage::config(env)?;
    cfg.admin.require_auth();
    Ok(cfg)
}
