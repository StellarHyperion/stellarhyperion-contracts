//! Hyperion's adapter for Axelar, covering both shapes Stellar's Interchain Token Service
//! offers.
//!
//! Axelar is the general purpose rail. A validator set watches the source chain, signs off on
//! what it saw, and a gateway on the destination chain replays it. The Interchain Token Service
//! sits on top of that and knows about tokens: a token id has a manager on each chain, and a
//! transfer either burns and mints or locks and unlocks depending on how that manager was set
//! up. None of that is Hyperion's to verify. This adapter is the two thin edges.
//!
//! # One WASM, two shapes
//!
//! An instance is wired at `initialize` for exactly one route and never changes its mind.
//!
//! `AxelarIts` is the bare shape. A transfer goes out naming the recipient on the far side
//! directly, and Axelar delivers it there with nothing else attached. Nothing comes back the
//! other way, because a bare transfer arriving on Stellar is delivered by ITS straight to the
//! address it names and Hyperion is never in the path at all. The router's inbound receiver for
//! this route stays unset, so `bridge_in` fails closed on it.
//!
//! `AxelarGmp` is the shape that carries a note. Outbound, the transfer is addressed to
//! Hyperion's own contract on the far side and the real recipient travels in the payload.
//! Inbound, ITS calls `execute_with_interchain_token` here and this contract hands the funds to
//! the router.
//!
//! That second shape is worth its extra moving parts for one reason. A bare ITS transfer to a
//! Stellar account with no trustline for the asset reverts the whole Axelar execution and
//! strands the message; there is no partial success and no retry that will ever work. Routing
//! through Hyperion instead lets the router park the delivery as a claim that the recipient can
//! settle themselves once they have opened the trustline. The same argument covers muxed
//! accounts, which the bare shape has nowhere to put and this one carries fine.
//!
//! # Relay gas
//!
//! `dispatch_from` takes gas and net tokens from the user's authenticated account through ITS.
//! The source wallet signs the simulated authorization tree; no copy of Axelar's payload is
//! needed to authorize its gas service. The legacy `dispatch` interface carries no gas payment.
//!
//! # What this contract does not do
//!
//! It does not verify anything Axelar signed. It never sees a signature. On the way in it is
//! called by ITS and its entire claim to trust is that ITS is the direct invoker, which the
//! host proves rather than this code.

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
    address::{assert_route_supports, bytes32_to_evm, evm_to_bytes32},
    axelar::{InboundNote, OutboundNote},
    inbound::{Origin, Recipient, RouterClient},
    HyperionError, RouteKind,
};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, token, vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, String, Symbol,
};

use rail::{InterchainTokenServiceClient, Token, TokenManagerType};
use types::{ChainLink, Config};

#[contract]
pub struct AxelarAdapter;

#[contractimpl]
impl AxelarAdapter {
    /// Wire the adapter up and fix which of the two shapes this instance speaks.
    ///
    /// Starts with no lane linked and no token mapped, so a half finished deploy script leaves
    /// something that refuses every transfer rather than something that guesses.
    pub fn initialize(
        env: Env,
        admin: Address,
        router: Address,
        its: Address,
        route: RouteKind,
    ) -> Result<(), HyperionError> {
        if storage::is_initialized(&env) {
            return Err(HyperionError::AlreadyInitialized);
        }
        // The same code backs both Axelar routes and nothing else. Handing it `Cctp` is a
        // deployment mistake, and one that would otherwise sit quiet until the router refused
        // to talk to it.
        if !matches!(route, RouteKind::AxelarIts | RouteKind::AxelarGmp) {
            return Err(HyperionError::UnsupportedRoute);
        }
        admin.require_auth();
        storage::set_config(
            &env,
            &Config {
                admin,
                router,
                its,
                route,
            },
        );
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Outbound
    // ---------------------------------------------------------------------------------------

    /// Hand funds the router has already moved here over to ITS.
    ///
    /// The router transfers the net amount in before calling, so by the time this runs the
    /// money is already sitting in this contract's balance and the only question is how ITS
    /// wants to take it.
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
        let link = storage::link(&env, &destination_chain).ok_or(HyperionError::UnknownChain)?;
        let token_id = storage::token_id(&env, &token).ok_or(HyperionError::TokenNotMapped)?;
        let recipient = bytes32_to_evm(&env, &destination)?;

        let this = env.current_contract_address();
        let its = InterchainTokenServiceClient::new(&env, &cfg.its);

        // Ask ITS how it intends to take the funds rather than authorising every way it might.
        // Three of the four manager types burn straight out of this balance and only
        // `LockUnlock` moves them somewhere, so one read here buys an authorisation that names
        // exactly one call instead of a pair covering both.
        let manager_type = its.token_manager_type(&token_id);
        let context = if manager_type.takes_by_burning() {
            ContractContext {
                contract: token.clone(),
                fn_name: Symbol::new(&env, "burn"),
                args: (this.clone(), amount).into_val(&env),
            }
        } else {
            ContractContext {
                contract: token.clone(),
                fn_name: Symbol::new(&env, "transfer"),
                args: (this.clone(), its.deployed_token_manager(&token_id), amount).into_val(&env),
            }
        };
        // Nothing wider than that. One contract, one function, one exact argument list, and no
        // sub-invocations underneath it.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context,
                sub_invocations: vec![&env],
            }),
        ]);

        // On the bare shape ITS delivers to the recipient itself. On the shape that carries a
        // note it delivers to Hyperion's contract over there, and the recipient rides along in
        // the payload with the router's nonce for company.
        let (destination_address, note) = match cfg.route {
            RouteKind::AxelarGmp => (
                Bytes::from_array(&env, &link.peer.to_array()),
                Some(OutboundNote::new(recipient, nonce).encode(&env)?),
            ),
            _ => (Bytes::from_array(&env, &recipient.to_array()), None),
        };

        its.interchain_transfer(
            &this,
            &token_id,
            &link.axelar_chain,
            &destination_address,
            &amount,
            &note,
            // No gas token. See the note at the top of this file: the keeper pays for the
            // message once the gateway has emitted it.
            &None,
        );

        events::Dispatched {
            token,
            destination_chain,
            amount,
            token_id,
            axelar_chain: link.axelar_chain,
            destination_address,
            token_manager_type: manager_type,
            note,
            router_nonce: nonce,
        }
        .publish(&env);
        Ok(())
    }

    /// The native token ITS accepts for relay gas.
    pub fn gas_token(env: Env) -> Result<Address, HyperionError> {
        let cfg = storage::config(&env)?;
        Ok(InterchainTokenServiceClient::new(&env, &cfg.its).native_token_address())
    }

    /// ITS takes net tokens and gas directly from the authenticated sender. This lets the
    /// source account authorize ITS's actual nested gas call, without duplicating its payload.
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
        if cfg.route != RouteKind::AxelarIts {
            return Err(HyperionError::UnsupportedRoute);
        }
        if amount <= 0 || gas_amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        let link = storage::link(&env, &destination_chain).ok_or(HyperionError::UnknownChain)?;
        let token_id = storage::token_id(&env, &token).ok_or(HyperionError::TokenNotMapped)?;
        let recipient = bytes32_to_evm(&env, &destination)?;
        let its = InterchainTokenServiceClient::new(&env, &cfg.its);
        let destination_address = Bytes::from_array(&env, &recipient.to_array());
        its.interchain_transfer(
            &sender,
            &token_id,
            &link.axelar_chain,
            &destination_address,
            &amount,
            &None,
            &Some(Token {
                address: its.native_token_address(),
                amount: gas_amount,
            }),
        );
        events::Dispatched {
            token,
            destination_chain,
            amount,
            token_id: token_id.clone(),
            axelar_chain: link.axelar_chain,
            destination_address,
            token_manager_type: its.token_manager_type(&token_id),
            note: None,
            router_nonce: nonce,
        }
        .publish(&env);
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Inbound
    // ---------------------------------------------------------------------------------------

    /// ITS's callback for a transfer that arrived carrying a payload.
    ///
    /// The name and the argument list are Axelar's, not Hyperion's: ITS looks this up by name
    /// on the address the transfer was addressed to. Returning the router's claim id rather
    /// than nothing is harmless, because ITS discards whatever comes back, and it means the
    /// same value an indexer needs is in the return as well as the event.
    ///
    /// # Authorisation
    ///
    /// Only ITS can get here. The `require_auth` below is satisfied implicitly because ITS is
    /// the direct invoker, and there is no other way to satisfy it: an account cannot sign for
    /// a contract address. Anybody else calling this is refused before a single check runs.
    ///
    /// ITS gives the tokens to this contract *before* it makes this call, so the funds are
    /// already here. That ordering is Axelar's and this contract checks it rather than assuming
    /// it, because a callback that hands the router a number its balance does not back would
    /// park a claim against money nobody holds.
    #[allow(clippy::too_many_arguments)]
    pub fn execute_with_interchain_token(
        env: Env,
        source_chain: String,
        message_id: String,
        source_address: Bytes,
        payload: Bytes,
        token_id: BytesN<32>,
        token_address: Address,
        amount: i128,
    ) -> Result<u64, HyperionError> {
        let cfg = storage::config(&env)?;
        cfg.its.require_auth();
        // The bare shape has no inbound leg to speak of. An instance wired for it that somehow
        // finds itself being called back is misconfigured, and saying so is better than
        // quietly growing a second personality.
        if cfg.route != RouteKind::AxelarGmp {
            return Err(HyperionError::UnsupportedRoute);
        }
        if amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }

        // Axelar's name for the chain, back to Hyperion's. An unrecognised source is refused
        // here, which is what happens on the day somebody deploys a Hyperion peer on a chain
        // this instance has never been told about.
        let chain = storage::chain_of(&env, &source_chain).ok_or(HyperionError::UnknownChain)?;
        let link = storage::link(&env, &chain).ok_or(HyperionError::UnknownChain)?;

        // ITS will deliver a payload from anybody who pays for one. Only Hyperion's own
        // contract on that chain is allowed to send instructions here.
        let peer = Bytes::from_array(&env, &link.peer.to_array());
        if source_address != peer {
            return Err(HyperionError::UnexpectedRailContract);
        }

        // Two names for one asset, and they have to agree. The mapping is also the allowlist,
        // so a token id nobody registered here stops at this line.
        let mapped = storage::token_of(&env, &token_id).ok_or(HyperionError::TokenNotMapped)?;
        if mapped != token_address {
            return Err(HyperionError::TokenNotMapped);
        }

        let note = InboundNote::decode(&env, &payload)?;
        assert_route_supports(cfg.route, note.destination.kind)?;
        let recipient = note.destination.to_address(&env)?;

        // Measure rather than believe. ITS says it gave this contract the funds; the balance is
        // what decides whether it did.
        let this = env.current_contract_address();
        let asset = token::Client::new(&env, &token_address);
        if asset.balance(&this) < amount {
            return Err(HyperionError::NothingMinted);
        }

        // The router pulls rather than trusts an adapter's word, so say in advance that this
        // one transfer is authorised. Nothing wider: one contract, one function, one exact
        // argument list, and no sub-invocations underneath it.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token_address.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (this.clone(), cfg.router.clone(), amount).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        let claim_id = RouterClient::new(&env, &cfg.router).bridge_in(
            &this,
            &cfg.route,
            &token_address,
            &amount,
            &Recipient {
                address: recipient.clone(),
                kind: note.destination.kind,
                raw: payload,
            },
            &Origin {
                chain,
                nonce: note.nonce,
                message_id: replay_key(&env, &source_chain, &message_id),
                sender: evm_to_bytes32(&env, &link.peer),
            },
        );

        events::Received {
            token: token_address,
            source_chain,
            amount,
            token_id,
            message_id,
            recipient,
            nonce: note.nonce,
            claim_id,
        }
        .publish(&env);
        Ok(claim_id)
    }

    // ---------------------------------------------------------------------------------------
    // Housekeeping
    // ---------------------------------------------------------------------------------------

    /// Move any stray balance to the protocol treasury.
    ///
    /// An adapter should hold nothing between transactions, but rounding on a lock and unlock
    /// token, or a transfer somebody sent here by hand, can leave a residue. An admin only
    /// rescue would be a standing power to move tokens out of a contract users send tokens to,
    /// which is a trust surface nobody needs for the sake of dust. Instead this is open to
    /// anybody and the destination is read live from the router, so the worst a caller can do
    /// is pay a fee to tidy up.
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
    pub fn keep_alive(env: Env, chain: String) -> Result<(), HyperionError> {
        let _ = storage::config(&env)?;
        env.storage()
            .instance()
            .extend_ttl(storage::BUMP_THRESHOLD, storage::BUMP_TO);
        storage::touch_link(&env, &chain);
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------------------------

    /// Teach the adapter that a chain Hyperion names one way is the chain Axelar names another.
    ///
    /// The two names agree often enough to be tempting and differ often enough to be a bug, so
    /// both are written down and the pair is checked against Axelar itself before it is saved.
    pub fn link_chain(
        env: Env,
        chain: String,
        axelar_chain: String,
        peer: BytesN<20>,
    ) -> Result<(), HyperionError> {
        let cfg = require_admin(&env)?;
        if chain.is_empty() || axelar_chain.is_empty() {
            return Err(HyperionError::UnknownChain);
        }
        // Axelar's hub will not route to a chain it does not trust, so a lane pointing at one
        // is a lane whose first transfer would fail. Better to find out while an admin is
        // watching.
        if !InterchainTokenServiceClient::new(&env, &cfg.its).is_trusted_chain(&axelar_chain) {
            return Err(HyperionError::UnknownChain);
        }
        // The shape that carries a note has to know who is allowed to send it one, and that is
        // the same address it addresses its own transfers to. The bare shape never reads the
        // peer, so it does not have to have one.
        if cfg.route == RouteKind::AxelarGmp && peer == BytesN::from_array(&env, &[0u8; 20]) {
            return Err(HyperionError::ZeroAddressKey);
        }
        let link = ChainLink {
            chain,
            axelar_chain,
            peer,
        };
        storage::set_link(&env, &link);
        events::LinkSet {
            chain: link.chain,
            axelar_chain: link.axelar_chain,
            peer: link.peer,
        }
        .publish(&env);
        Ok(())
    }

    /// Map a local asset to the Axelar token id that carries it.
    ///
    /// Checked against ITS rather than taken on trust. A token id that resolves to a different
    /// asset, or to nothing at all, is a configuration error, and catching it once here means
    /// it surfaces as a legible Hyperion refusal instead of a panic from two contracts away on
    /// somebody's transfer.
    pub fn map_token(env: Env, token: Address, token_id: BytesN<32>) -> Result<(), HyperionError> {
        let cfg = require_admin(&env)?;
        let registered = InterchainTokenServiceClient::new(&env, &cfg.its)
            .try_registered_token_address(&token_id)
            .map_err(|_| HyperionError::TokenNotMapped)?
            .map_err(|_| HyperionError::TokenNotMapped)?;
        if registered != token {
            return Err(HyperionError::TokenNotMapped);
        }
        storage::set_token(&env, &token, &token_id);
        events::TokenMapped { token, token_id }.publish(&env);
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
    /// Gated on the adapter's own admin, which in production is the router's timelocked
    /// multisig. An adapter is the one place in Hyperion that has to change when a rail
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

    pub fn get_link(env: Env, chain: String) -> Result<ChainLink, HyperionError> {
        storage::link(&env, &chain).ok_or(HyperionError::UnknownChain)
    }

    /// Hyperion's name for the chain Axelar calls this.
    pub fn chain_for(env: Env, axelar_chain: String) -> Result<String, HyperionError> {
        storage::chain_of(&env, &axelar_chain).ok_or(HyperionError::UnknownChain)
    }

    pub fn token_id_for(env: Env, token: Address) -> Result<BytesN<32>, HyperionError> {
        storage::token_id(&env, &token).ok_or(HyperionError::TokenNotMapped)
    }

    pub fn token_for(env: Env, token_id: BytesN<32>) -> Result<Address, HyperionError> {
        storage::token_of(&env, &token_id).ok_or(HyperionError::TokenNotMapped)
    }

    /// How ITS will take the funds for this asset, which is the one call this adapter
    /// authorises on the way out.
    pub fn manager_type_for(env: Env, token: Address) -> Result<TokenManagerType, HyperionError> {
        let cfg = storage::config(&env)?;
        let token_id = storage::token_id(&env, &token).ok_or(HyperionError::TokenNotMapped)?;
        Ok(InterchainTokenServiceClient::new(&env, &cfg.its).token_manager_type(&token_id))
    }

    /// Axelar's own flow limit on this asset, if its operator set one.
    ///
    /// Hyperion has a flow limit of its own in the router, and the tighter of the two is what
    /// actually binds. Reading Axelar's here lets the route planner say which one a transfer is
    /// about to run into, rather than letting a user find out from a refusal.
    pub fn rail_flow_limit(env: Env, token: Address) -> Result<Option<i128>, HyperionError> {
        let cfg = storage::config(&env)?;
        let token_id = storage::token_id(&env, &token).ok_or(HyperionError::TokenNotMapped)?;
        Ok(InterchainTokenServiceClient::new(&env, &cfg.its).flow_limit(&token_id))
    }
}

/// Read the config and insist the admin signed for whatever is about to happen.
fn require_admin(env: &Env) -> Result<Config, HyperionError> {
    let cfg = storage::config(env)?;
    cfg.admin.require_auth();
    Ok(cfg)
}

/// The key the router keys replay protection on.
///
/// Axelar identifies a message by a chain name and a message id, and neither is unique on its
/// own. Hashing the pair as XDR rather than as concatenated text matters: XDR carries a length
/// in front of each string, so `("eth", "ereum1")` and `("ethereum", "1")` hash differently,
/// which is exactly the collision a naive join would hand an attacker.
fn replay_key(env: &Env, source_chain: &String, message_id: &String) -> BytesN<32> {
    env.crypto()
        .keccak256(&(source_chain.clone(), message_id.clone()).to_xdr(env))
        .into()
}
