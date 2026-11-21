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
//! This is a configured-validator trust model: successful verification proves that the configured
//! Allbridge key signed the message, not that Circle or Axelar independently attested to it.
//! Deployment readiness is assessed off-chain; this contract does not implement an activation gate.
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
//! # Token and pool admission
//!
//! A lane is not eligible just because it has a name and a chain id. Before an asset can be used
//! on it, Allbridge's own views have to agree that the local token is the one behind its pool, that
//! the pool belongs to this bridge, that the precision recorded in the pool and in Allbridge's
//! conversion factors is the precision the token actually reports, and that the destination bridge
//! accepts the token the mapping pays out in. The same checks run again at dispatch, so a rail-side
//! change after configuration fails closed before any amount is authorised or sold.
//!
//! # What this contract does not do
//!
//! It holds no pool and quotes no price. The relay cost and the rebalancer are still read live at
//! the moment they are used. Pool identity and precision are the exception: they are checked on
//! every use rather than cached, but a disagreement stops the transfer instead of being followed
//! blindly. The validator key and the native gas float keep their existing authority.

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
    AdapterKeyCoverage, HyperionError, MaintenanceSummary, RouteKind, MAX_MAINTENANCE_BATCH,
};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, token, vec, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec,
    U256,
};

use rail::{AllbridgeBridgeClient, AllbridgeMessengerClient, STELLAR_CHAIN_ID};
use types::{AssetLink, ChainLane, Config, OutboundRecord, PendingValidator, ProviderStatus, RecoveryDecision, ValidatorEpoch};

#[contract]
pub struct AllbridgeAdapter;

#[contractimpl]
impl AllbridgeAdapter {
    /// Wire the adapter up.
    ///
    /// The configured administrator must authorize this one-time transition. Starts with no lane
    /// and no asset, so a deploy script that stops halfway leaves something that refuses every
    /// transfer rather than something that guesses.
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
        admin.require_auth();
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
        if storage::emergency_disabled(&env) {
            return Err(HyperionError::Unauthorized);
        }
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
        // refusal instead of arriving somewhere unrecoverable. A muxed account does not fit in
        // this field either, so it fails the same EVM word check.
        let _ = bytes32_to_evm(&env, &destination)?;

        let this = env.current_contract_address();
        let bridge = AllbridgeBridgeClient::new(&env, &cfg.bridge);
        let bridge_cfg = bridge.get_config();

        // Admission is checked before any authorisation is granted. A pool repointed at a
        // different token, a changed precision or a removed destination token stops here, with
        // the funds still in this contract and nothing sold.
        let admission = rail::validate_asset_admission(
            &env,
            &cfg.bridge,
            &bridge_cfg,
            &token,
            lane.allbridge_chain_id,
            &link.receive_token,
        )?;
        let pool = admission.pool;

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

        storage::set_outbound(
            &env,
            &OutboundRecord {
                nonce,
                token: token.clone(),
                amount,
                destination_chain: destination_chain.clone(),
                destination: destination.clone(),
                receive_token: link.receive_token.clone(),
            },
        );

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

    /// Verify an inbound message from Allbridge Core and deliver it via the router.
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
        caller.require_auth();
        let cfg = storage::config(&env)?;
        if storage::emergency_disabled(&env) {
            return Err(HyperionError::Unauthorized);
        }
        if amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        let validator = storage::validator_epoch(&env)
            .map(|v| v.validator)
            .or_else(|| storage::validator(&env))
            .ok_or(HyperionError::RailNotConfigured)?;
        let source_chain =
            storage::chain_of(&env, source_chain_id).ok_or(HyperionError::UnknownChain)?;
        let _link =
            storage::asset(&env, &token, source_chain_id).ok_or(HyperionError::TokenNotMapped)?;

        let (kind, recipient_key) = codec::address_key(&env, &recipient)?;
        assert_route_supports(RouteKind::Allbridge, kind)?;

        // The same pool and precision authority used outbound applies to a delivery. It is
        // checked before the caller is asked for any shortfall and before the message is marked
        // processed, so a bad mapping cannot consume a nonce or strand a top-up.
        let bridge_cfg = AllbridgeBridgeClient::new(&env, &cfg.bridge).get_config();
        let _admission = rail::validate_pool(&env, &cfg.bridge, &bridge_cfg, &token)?;

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

        if storage::is_processed(&env, &message_id) {
            return Err(HyperionError::ReplayedMessage);
        }

        if signature == BytesN::from_array(&env, &[0u8; 64]) {
            return Err(HyperionError::Unauthorized);
        }

        env.crypto()
            .ed25519_verify(&validator, &message_id.clone().into(), &signature);

        storage::mark_processed(&env, &message_id);

        let this = env.current_contract_address();
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
        let _ = storage::touch_lane(&env, &chain);
        Ok(())
    }

    /// Bounded storage maintenance for Allbridge peer trust (`Lane`, `Chain`), token mappings
    /// (`Asset`), and inbound replay records (`Processed`).
    pub fn maintain_storage(
        env: Env,
        tokens: Vec<Address>,
        peer_chains: Vec<String>,
        peer_domains: Vec<u32>,
        remote_tokens: Vec<BytesN<32>>,
        inbound_messages: Vec<BytesN<32>>,
    ) -> Result<MaintenanceSummary, HyperionError> {
        let _ = storage::config(&env)?;
        if tokens.len() > MAX_MAINTENANCE_BATCH
            || peer_chains.len() > MAX_MAINTENANCE_BATCH
            || peer_domains.len() > MAX_MAINTENANCE_BATCH
            || remote_tokens.len() > MAX_MAINTENANCE_BATCH
            || inbound_messages.len() > MAX_MAINTENANCE_BATCH
            || peer_chains
                .len()
                .saturating_mul(2)
                .saturating_add(peer_domains.len())
                .saturating_add(tokens.len().saturating_mul(peer_domains.len()))
                .saturating_add(inbound_messages.len())
                > MAX_MAINTENANCE_BATCH
            || !remote_tokens.is_empty()
        {
            return Err(HyperionError::InvalidLimit);
        }
        env.storage()
            .instance()
            .extend_ttl(storage::BUMP_THRESHOLD, storage::BUMP_TO);

        let mut peer_trust_touched = 0u32;
        for chain in peer_chains.iter() {
            peer_trust_touched += storage::touch_lane(&env, &chain);
        }
        for chain_id in peer_domains.iter() {
            if storage::touch_chain_id(&env, chain_id) {
                peer_trust_touched += 1;
            }
        }

        let mut token_mappings_touched = 0u32;
        for token in tokens.iter() {
            for chain_id in peer_domains.iter() {
                if storage::touch_asset(&env, &token, chain_id) {
                    token_mappings_touched += 1;
                }
            }
        }

        let mut inbound_records_touched = 0u32;
        for message_id in inbound_messages.iter() {
            if storage::touch_processed(&env, &message_id) {
                inbound_records_touched += 1;
            }
        }

        Ok(MaintenanceSummary {
            instance_extended: true,
            token_mappings_touched,
            peer_trust_touched,
            inbound_records_touched,
            total_keys_touched: peer_trust_touched
                + token_mappings_touched
                + inbound_records_touched,
        })
    }

    /// Explicit key coverage for Allbridge adapter storage maintenance.
    pub fn key_coverage(_env: Env) -> Result<AdapterKeyCoverage, HyperionError> {
        Ok(AdapterKeyCoverage {
            route: RouteKind::Allbridge,
            has_token_mappings: true,
            has_peer_trust: true,
            has_inbound_records: true,
            token_mapping_keys: 1,
            peer_trust_keys: 2,
            inbound_record_keys: 1,
        })
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
        storage::set_lane(&env, &lane)?;
        events::LaneSet {
            chain: lane.chain,
            allbridge_chain_id: lane.allbridge_chain_id,
        }
        .publish(&env);
        Ok(())
    }

    /// Say which token a local asset becomes at the far end of a lane.
    ///
    /// The mapping is admitted only when Allbridge's own views agree about the local pool and its
    /// precision, and the far bridge accepts the destination token. Re-running this with the same
    /// answer is a no-op; changing a live answer is refused rather than written over.
    pub fn link_asset(
        env: Env,
        token: Address,
        chain: String,
        receive_token: BytesN<32>,
    ) -> Result<(), HyperionError> {
        let cfg = require_admin(&env)?;
        let lane = storage::lane(&env, &chain).ok_or(HyperionError::UnknownChain)?;
        let bridge_cfg = AllbridgeBridgeClient::new(&env, &cfg.bridge).get_config();
        let _admission = rail::validate_asset_admission(
            &env,
            &cfg.bridge,
            &bridge_cfg,
            &token,
            lane.allbridge_chain_id,
            &receive_token,
        )?;

        let link = AssetLink {
            token,
            allbridge_chain_id: lane.allbridge_chain_id,
            receive_token,
        };
        storage::set_asset(&env, &link)?;
        events::AssetLinked {
            token: link.token,
            allbridge_chain_id: link.allbridge_chain_id,
            receive_token: link.receive_token,
        }
        .publish(&env);
        Ok(())
    }

    /// Register the Allbridge validator public key used to verify incoming messages. Admin only.
    pub fn set_validator(env: Env, validator: BytesN<32>) -> Result<(), HyperionError> {
        let _ = require_admin(&env)?;
        storage::set_validator(&env, &validator);
        if storage::validator_epoch(&env).is_none() {
            storage::set_validator_epoch(&env, &ValidatorEpoch { epoch: 0, validator: validator.clone() });
        }
        events::ValidatorSet { validator }.publish(&env);
        Ok(())
    }

    pub fn queue_validator_rotation(env: Env, validator: BytesN<32>) -> Result<u64, HyperionError> {
        let _ = require_admin(&env)?;
        let current = storage::validator_epoch(&env).ok_or(HyperionError::RailNotConfigured)?;
        if validator == current.validator || storage::pending_validator(&env).is_some() {
            return Err(HyperionError::AlreadyConfigured);
        }
        let pending = PendingValidator {
            epoch: current.epoch.saturating_add(1),
            validator,
            activate_after: env.ledger().timestamp().saturating_add(storage::VALIDATOR_ROTATION_DELAY),
        };
        let at = pending.activate_after;
        events::ValidatorRotationQueued { epoch: pending.epoch, activate_after: at, validator: pending.validator.clone() }.publish(&env);
        storage::set_pending_validator(&env, &pending);
        Ok(at)
    }

    pub fn activate_validator_rotation(env: Env) -> Result<u32, HyperionError> {
        let _ = require_admin(&env)?;
        let pending = storage::pending_validator(&env).ok_or(HyperionError::RailNotConfigured)?;
        if env.ledger().timestamp() < pending.activate_after {
            return Err(HyperionError::TimelockNotReady);
        }
        let epoch = ValidatorEpoch { epoch: pending.epoch, validator: pending.validator.clone() };
        storage::set_validator(&env, &pending.validator);
        storage::set_validator_epoch(&env, &epoch);
        storage::clear_pending_validator(&env);
        events::ValidatorRotationActivated { epoch: epoch.epoch, validator: epoch.validator }.publish(&env);
        Ok(epoch.epoch)
    }

    pub fn set_emergency_disabled(env: Env, disabled: bool) -> Result<(), HyperionError> {
        let _ = require_admin(&env)?;
        storage::set_emergency_disabled(&env, disabled);
        events::EmergencyStateChanged { disabled }.publish(&env);
        Ok(())
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

    /// Re-run every admission check for a stored mapping without changing it.
    ///
    /// This is the preflight an operator or route planner calls after a rail-side change. It reads
    /// Allbridge live and returns the pool and precision that would be used; it never writes a
    /// mapping, so a revalidation cannot quietly repoint a live lane.
    pub fn revalidate_asset(
        env: Env,
        token: Address,
        chain: String,
    ) -> Result<rail::AssetAdmission, HyperionError> {
        let cfg = storage::config(&env)?;
        let lane = storage::lane(&env, &chain).ok_or(HyperionError::UnknownChain)?;
        let link = storage::asset(&env, &token, lane.allbridge_chain_id)
            .ok_or(HyperionError::TokenNotMapped)?;
        let bridge_cfg = AllbridgeBridgeClient::new(&env, &cfg.bridge).get_config();
        rail::validate_asset_admission(
            &env,
            &cfg.bridge,
            &bridge_cfg,
            &token,
            lane.allbridge_chain_id,
            &link.receive_token,
        )
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
        Ok(!storage::emergency_disabled(&env) && AllbridgeBridgeClient::new(&env, &cfg.bridge)
            .get_config()
            .can_swap)
    }

    /// Read the registered Allbridge validator public key.
    pub fn get_validator(env: Env) -> Result<BytesN<32>, HyperionError> {
        storage::validator_epoch(&env).map(|v| v.validator).or_else(|| storage::validator(&env)).ok_or(HyperionError::RailNotConfigured)
    }

    pub fn validator_epoch(env: Env) -> Result<ValidatorEpoch, HyperionError> {
        storage::validator_epoch(&env).ok_or(HyperionError::RailNotConfigured)
    }

    pub fn reconcile_outbound(env: Env, nonce: u64, status: ProviderStatus) -> Result<RecoveryDecision, HyperionError> {
        let record = storage::outbound(&env, nonce).ok_or(HyperionError::UnknownChain)?;
        let (retry_allowed, reason) = match status {
            ProviderStatus::Failed => (true, 1),
            ProviderStatus::Unknown => (false, 2),
            ProviderStatus::Submitted => (false, 3),
            ProviderStatus::Unsupported => (false, 4),
        };
        Ok(RecoveryDecision { nonce, retry_allowed, reason, record })
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
