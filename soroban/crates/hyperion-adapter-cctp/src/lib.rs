//! Hyperion's adapter for Circle's Cross Chain Transfer Protocol, version 2.
//!
//! CCTP is the canonical rail for USDC. A transfer burns on the source chain, Circle's attestation
//! service signs a message saying so, and the destination chain mints the same amount against that
//! signature. There is no pool, no wrapped asset and no liquidity provider, which is why Hyperion
//! treats it as the default route whenever both ends support it.
//!
//! This adapter is the two thin edges of that. On the way out it approves the messenger and calls
//! `deposit_for_burn`, and on the way in it is the mint recipient: a relayer hands it a message and
//! an attestation, it works out where the funds are meant to end up, lets Circle's own transmitter
//! do the verifying and minting, and passes the result to the router.
//!
//! # Why the adapter is the mint recipient
//!
//! A CCTP mint recipient is a single thirty two byte word. That is enough for a Stellar contract
//! id or an account id, but not enough to say which of the two it is, and not enough at all for a
//! muxed account, which needs another eight bytes for the subaccount. Naming a user's account
//! directly as the mint recipient would therefore work for the easy case and quietly lose
//! information in the interesting ones.
//!
//! So the mint recipient is always this contract, and the real destination travels in the hook
//! data, which CCTP v2 lets you make as long as you like. This contract resolves the destination
//! from the hook **before** it asks the transmitter to mint anything, so a destination this route
//! cannot honour is a refusal on an unchanged ledger rather than a pile of freshly minted tokens
//! with nowhere to go.
//!
//! # What this contract does not do
//!
//! It does not check attestations. It does not know what one looks like. Every signature check
//! happens inside `message-transmitter-v2`, which is Circle's contract, audited by Circle's
//! auditors, and Hyperion's security depends on that being true rather than on anything written
//! here.

#![no_std]

mod events;
mod storage;

// Public so that the rail interface this adapter was built against is readable from outside it,
// and so the deploy tooling can generate bindings for the same shapes rather than a second
// transcription of them.
pub mod rail;
pub mod types;

#[cfg(test)]
mod test;

use hyperion_core::{
    address::assert_route_supports,
    cctp::{self, BurnMessage, CctpMessage, HyperionHook},
    codec,
    inbound::{Origin, Recipient, RouterClient},
    HyperionError, RouteKind, BPS_DENOMINATOR,
};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, token, vec, Address, Bytes, BytesN, Env, IntoVal, String, Symbol,
};

use rail::{MessageTransmitterClient, TokenMessengerClient};
use types::{Config, DomainLink};

/// Ceiling on `max_fee_bps`.
///
/// Circle's fast transfer fees live in single digit basis points. A hundred is far above anything
/// the rail would ever ask for, so it is a cheap guard against a fat fingered config change
/// handing Circle a percent of the flow.
const MAX_FEE_BPS_CEILING: u32 = 100;

#[contract]
pub struct CctpAdapter;

#[contractimpl]
impl CctpAdapter {
    /// Wire the adapter to the router and to Circle's two contracts.
    ///
    /// Deliberately starts with no chains linked and no assets mapped. Both legs refuse to move
    /// anything until an admin has said, explicitly, which domain is which chain and which remote
    /// token becomes which local asset.
    pub fn initialize(
        env: Env,
        admin: Address,
        router: Address,
        token_messenger: Address,
        message_transmitter: Address,
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
                token_messenger,
                message_transmitter,
                // Finalized transfers, which Circle attests for free. An operator who wants fast
                // transfers has to ask for them and accept the fee that comes with them.
                max_fee_bps: 0,
                min_finality_threshold: cctp::FINALITY_THRESHOLD_FINALIZED,
            },
        );
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Outbound
    // ---------------------------------------------------------------------------------------

    /// Hand funds the router has already transferred here to Circle for burning.
    ///
    /// The router is the only caller. It has already taken its fee, floored the amount to
    /// something the far side can represent, charged the flow limit and moved the money, so by
    /// the time this runs the adapter is holding exactly what needs to cross.
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
        let domain =
            storage::domain_of(&env, &destination_chain).ok_or(HyperionError::UnknownChain)?;
        // Circle rejects an all zero mint recipient too, with its own error. Catching it here
        // means the refusal names Hyperion's reason rather than surfacing as a panic from two
        // contracts away.
        if destination == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(HyperionError::InvalidDestination);
        }

        let max_fee = amount
            .checked_mul(i128::from(cfg.max_fee_bps))
            .ok_or(HyperionError::DecimalOverflow)?
            / BPS_DENOMINATOR;

        let this = env.current_contract_address();
        let asset = token::Client::new(&env, &token);

        // Circle's `deposit_and_burn` pulls with `transfer_from`, so an allowance has to exist
        // before the call and should not exist after it. The expiration is this ledger and no
        // further: the allowance is consumed inside this same transaction, so there is no reason
        // to leave one lying around that a later ledger could still draw on.
        let this_ledger = env.ledger().sequence();
        asset.approve(&this, &cfg.token_messenger, &amount, &this_ledger);

        TokenMessengerClient::new(&env, &cfg.token_messenger).deposit_for_burn(
            &this,
            &amount,
            &domain,
            &destination,
            &token,
            &storage::destination_caller(&env, domain),
            &max_fee,
            &cfg.min_finality_threshold,
        );

        // Circle strips anything below its own smallest representable unit before burning and
        // leaves the remainder where it found it, so the allowance can come back unspent in part.
        // Closing it is one storage write and removes the question entirely.
        asset.approve(&this, &cfg.token_messenger, &0i128, &this_ledger);

        events::Dispatched {
            token,
            destination_domain: domain,
            amount,
            mint_recipient: destination,
            max_fee,
            min_finality_threshold: cfg.min_finality_threshold,
            router_nonce: nonce,
        }
        .publish(&env);
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Inbound
    // ---------------------------------------------------------------------------------------

    /// Pay Circle's destination forwarding fee from USDC and request automatic minting.
    /// The caller supplies a live fee budget, in Stellar token base units. No persistent
    /// allowance or operator fee policy can widen the amount the user authorized.
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
    ) -> Result<(), HyperionError> {
        caller.require_auth();
        sender.require_auth();
        let cfg = storage::config(&env)?;
        if caller != cfg.router {
            return Err(HyperionError::Unauthorized);
        }
        if amount <= 0 || gas_amount <= 0 || gas_amount >= amount {
            return Err(HyperionError::InvalidAmount);
        }
        let domain =
            storage::domain_of(&env, &destination_chain).ok_or(HyperionError::UnknownChain)?;
        if destination == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(HyperionError::InvalidDestination);
        }
        let destination_caller = storage::destination_caller(&env, domain);
        if destination_caller != BytesN::from_array(&env, &[0u8; 32]) {
            return Err(HyperionError::InvalidDestination);
        }
        let this = env.current_contract_address();
        let asset = token::Client::new(&env, &token);
        asset.transfer(&sender, &this, &amount);
        let ledger = env.ledger().sequence();
        asset.approve(&this, &cfg.token_messenger, &amount, &ledger);
        // Circle's version-zero forwarding hook: 24-byte magic, version 0, payload length 0.
        let mut hook = [0u8; 32];
        hook[..12].copy_from_slice(b"cctp-forward");
        TokenMessengerClient::new(&env, &cfg.token_messenger).deposit_for_burn_with_hook(
            &this,
            &amount,
            &domain,
            &destination,
            &token,
            &destination_caller,
            &gas_amount,
            &cfg.min_finality_threshold,
            &Bytes::from_array(&env, &hook),
        );
        asset.approve(&this, &cfg.token_messenger, &0i128, &ledger);
        events::Dispatched {
            token,
            destination_domain: domain,
            amount,
            mint_recipient: destination,
            max_fee: gas_amount,
            min_finality_threshold: cfg.min_finality_threshold,
            router_nonce: nonce,
        }
        .publish(&env);
        Ok(())
    }

    /// Take an attested CCTP message, have Circle mint against it, and pass the funds on.
    ///
    /// Permissionless, because everything that matters is checked either here or by Circle. The
    /// relayer chooses when to call and pays the fee for doing so, and cannot change where a
    /// single stroop ends up: the destination comes out of the message Circle signed.
    ///
    /// The order of operations is the security property. Every check that can be made from the
    /// message alone is made first, then the transmitter mints, then the balance delta is
    /// measured rather than trusted, then the router pulls. If any step refuses, the whole
    /// transaction unwinds, Circle's nonce is left unused and the relayer can simply try again.
    pub fn receive(
        env: Env,
        relayer: Address,
        message: Bytes,
        attestation: Bytes,
    ) -> Result<u64, HyperionError> {
        relayer.require_auth();
        let cfg = storage::config(&env)?;
        let this = env.current_contract_address();

        let msg = CctpMessage::parse(&env, &message)?;
        if msg.version != cctp::MESSAGE_VERSION {
            return Err(HyperionError::UnsupportedMessageVersion);
        }
        if msg.destination_domain != cctp::STELLAR_DOMAIN {
            return Err(HyperionError::WrongDomain);
        }
        // A burn message names Circle's own minter as its recipient. A message naming anything
        // else is one this contract has no business reasoning about, so it does not get handed to
        // the transmitter on the off chance that it works out.
        if contract_at(&env, &msg.recipient) != cfg.token_messenger {
            return Err(HyperionError::UnexpectedRailContract);
        }

        let body = CctpMessage::body(&message)?;
        let burn = BurnMessage::parse(&env, &body)?;
        if burn.version != cctp::BURN_MESSAGE_VERSION {
            return Err(HyperionError::UnsupportedMessageVersion);
        }
        if contract_at(&env, &burn.mint_recipient) != this {
            return Err(HyperionError::NotMintRecipient);
        }

        let source_chain =
            storage::chain_of(&env, msg.source_domain).ok_or(HyperionError::UnknownChain)?;
        let token = storage::asset(&env, msg.source_domain, &burn.burn_token)
            .ok_or(HyperionError::TokenNotMapped)?;

        // Resolve the destination before anything is minted. A muxed account cannot be delivered
        // to over this route, and finding that out after the mint would mean funds sitting in an
        // adapter that has already burned its counterpart on the far side.
        let hook_data = BurnMessage::hook_data(&body)?;
        let hook = HyperionHook::decode(&env, &hook_data)?;
        assert_route_supports(RouteKind::Cctp, hook.kind())?;
        let recipient = hook.destination.to_address(&env)?;

        // Measure rather than believe. `burn.amount` is what the sender asked to send; what
        // actually arrives is that minus whatever fee Circle took, and reading the balance is the
        // only way to know the difference without reimplementing Circle's fee arithmetic.
        let asset = token::Client::new(&env, &token);
        let before = asset.balance(&this);
        MessageTransmitterClient::new(&env, &cfg.message_transmitter).receive_message(
            &this,
            &message,
            &attestation,
        );
        let minted = asset
            .balance(&this)
            .checked_sub(before)
            .ok_or(HyperionError::DecimalOverflow)?;
        if minted <= 0 {
            return Err(HyperionError::NothingMinted);
        }

        // The router pulls rather than trusts an adapter's word, so say in advance that this one
        // transfer is authorised. Nothing wider: one contract, one function, one exact argument
        // list, and no sub-invocations underneath it.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (this.clone(), cfg.router.clone(), minted).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        let claim_id = RouterClient::new(&env, &cfg.router).bridge_in(
            &this,
            &RouteKind::Cctp,
            &token,
            &minted,
            &Recipient {
                address: recipient.clone(),
                kind: hook.kind(),
                raw: hook_data,
            },
            &Origin {
                chain: source_chain.clone(),
                nonce: msg.display_nonce(),
                message_id: msg.nonce.clone(),
                sender: burn.message_sender,
            },
        );

        events::Received {
            token,
            source_domain: msg.source_domain,
            amount: minted,
            nonce: msg.nonce,
            source_chain,
            recipient,
            claim_id,
            relayer,
        }
        .publish(&env);
        Ok(claim_id)
    }

    // ---------------------------------------------------------------------------------------
    // Housekeeping
    // ---------------------------------------------------------------------------------------

    /// Move any stray balance to the protocol treasury.
    ///
    /// Circle rounds a burn down to its own smallest unit and leaves the remainder behind, so an
    /// adapter can accumulate a few stroops over time. An admin only rescue would be a standing
    /// power to move tokens out of a contract users send tokens to, which is a trust surface
    /// nobody needs for the sake of dust. Instead this is open to anybody and the destination is
    /// read live from the router, so the worst a caller can do is pay a fee to tidy up.
    pub fn sweep(env: Env, caller: Address, token: Address) -> Result<i128, HyperionError> {
        caller.require_auth();
        let cfg = storage::config(&env)?;
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
    pub fn keep_alive(env: Env, domain: u32) -> Result<(), HyperionError> {
        let _ = storage::config(&env)?;
        env.storage()
            .instance()
            .extend_ttl(storage::BUMP_THRESHOLD, storage::BUMP_TO);
        storage::touch_link(&env, domain);
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------------------------

    /// Teach the adapter that a chain name and a Circle domain are the same place.
    pub fn link_domain(
        env: Env,
        chain: String,
        domain: u32,
        destination_caller: BytesN<32>,
    ) -> Result<(), HyperionError> {
        let cfg = require_admin(&env)?;
        let _ = cfg;
        if chain.is_empty() {
            return Err(HyperionError::UnknownChain);
        }
        if domain == cctp::STELLAR_DOMAIN {
            // Linking Stellar to itself would let an outbound transfer name the local domain,
            // which Circle would refuse anyway. Refusing here keeps the reason legible.
            return Err(HyperionError::WrongDomain);
        }
        storage::set_link(&env, &chain, domain, &destination_caller);
        events::LinkSet {
            domain,
            chain,
            destination_caller,
        }
        .publish(&env);
        Ok(())
    }

    /// Record which local asset Circle mints for a given remote token.
    pub fn map_asset(
        env: Env,
        domain: u32,
        burn_token: BytesN<32>,
        local: Address,
    ) -> Result<(), HyperionError> {
        require_admin(&env)?;
        if storage::chain_of(&env, domain).is_none() {
            return Err(HyperionError::UnknownChain);
        }
        storage::set_asset(&env, domain, &burn_token, &local);
        events::AssetMapped {
            domain,
            burn_token,
            local,
        }
        .publish(&env);
        Ok(())
    }

    /// Change how much Circle may charge and how final the source has to be.
    ///
    /// These two move together. A finality threshold below Circle's finalized value is a fast
    /// transfer, and Circle refuses a fast transfer whose max fee is below its own minimum, so
    /// lowering one without raising the other turns every dispatch on that lane into a refusal.
    pub fn set_fee_policy(
        env: Env,
        max_fee_bps: u32,
        min_finality_threshold: u32,
    ) -> Result<(), HyperionError> {
        let mut cfg = require_admin(&env)?;
        if max_fee_bps > MAX_FEE_BPS_CEILING {
            return Err(HyperionError::FeeTooHigh);
        }
        if min_finality_threshold == 0
            || min_finality_threshold > cctp::FINALITY_THRESHOLD_FINALIZED
        {
            return Err(HyperionError::InvalidLimit);
        }
        cfg.max_fee_bps = max_fee_bps;
        cfg.min_finality_threshold = min_finality_threshold;
        storage::set_config(&env, &cfg);
        events::FeePolicySet {
            max_fee_bps,
            min_finality_threshold,
        }
        .publish(&env);
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
    /// Gated on the adapter's own admin, which in production is the router's timelocked multisig.
    /// An adapter is the one place in Hyperion that has to change when a rail changes, so being
    /// able to upgrade it is the difference between shipping a fix and redeploying the world.
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

    pub fn get_link(env: Env, domain: u32) -> Result<DomainLink, HyperionError> {
        let chain = storage::chain_of(&env, domain).ok_or(HyperionError::UnknownChain)?;
        Ok(DomainLink {
            chain,
            domain,
            destination_caller: storage::destination_caller(&env, domain),
        })
    }

    pub fn domain_for(env: Env, chain: String) -> Result<u32, HyperionError> {
        storage::domain_of(&env, &chain).ok_or(HyperionError::UnknownChain)
    }

    pub fn asset_for(
        env: Env,
        domain: u32,
        burn_token: BytesN<32>,
    ) -> Result<Address, HyperionError> {
        storage::asset(&env, domain, &burn_token).ok_or(HyperionError::TokenNotMapped)
    }

    /// What Circle would be allowed to charge for a transfer of this size right now.
    pub fn quote_max_fee(env: Env, amount: i128) -> Result<i128, HyperionError> {
        let cfg = storage::config(&env)?;
        if amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        Ok(amount
            .checked_mul(i128::from(cfg.max_fee_bps))
            .ok_or(HyperionError::DecimalOverflow)?
            / BPS_DENOMINATOR)
    }
}

/// Read the config and insist the admin signed for whatever is about to happen.
fn require_admin(env: &Env) -> Result<Config, HyperionError> {
    let cfg = storage::config(env)?;
    cfg.admin.require_auth();
    Ok(cfg)
}

/// Read a thirty two byte word as the Soroban contract it names.
///
/// CCTP fields have no room for a type tag, and every address this function is used on is one the
/// protocol defines as a contract: the local minter named in a message, and the mint recipient
/// Hyperion itself put there. Encoding it as a C strkey and letting the host parse it back is the
/// cheapest way to compare it against an `Address` without inventing a second address format.
fn contract_at(env: &Env, raw: &BytesN<32>) -> Address {
    Address::from_string(&codec::contract_strkey(env, &raw.to_array()))
}
