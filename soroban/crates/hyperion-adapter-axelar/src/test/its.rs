//! Stand-ins for Axelar's Interchain Token Service and for a token manager.
//!
//! Axelar's validator set cannot be summoned into a unit test, so the part of ITS that verifies
//! anything is the part that is missing. Everything else is real: the preconditions ITS actually
//! enforces, the two different ways it takes funds from a sender, the fact that it hands the
//! tokens over before it makes the callback, and above all the callback itself, which is looked
//! up by name and argument shape exactly as the real contract looks it up. A stand-in that
//! called the adapter through a typed client would agree with whatever the adapter declared and
//! would prove nothing about whether Axelar can find it.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, vec, Address, Bytes, BytesN, Env,
    IntoVal, String, Symbol, TryFromVal, Val,
};

use crate::rail::{Token, TokenManagerType};

/// The refusals Axelar's ITS actually produces, under the names Axelar gives them.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ItsError {
    InvalidAmount = 1,
    InvalidDestinationAddress = 2,
    InvalidData = 3,
    UntrustedChain = 4,
    InvalidTokenId = 5,
    NotConfigured = 6,
}

/// Everything ITS was told to do on the way out, so a test can check it got told the truth.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferRecord {
    pub caller: Address,
    pub token_id: BytesN<32>,
    pub destination_chain: String,
    pub destination_address: Bytes,
    pub amount: i128,
    pub data: Option<Bytes>,
    /// Whether the caller attached a relayer fee. Hyperion never does, and one test says so out
    /// loud rather than leaving it to be noticed.
    pub gas_attached: bool,
}

#[contracttype]
#[derive(Clone)]
enum ItsKey {
    /// Token id to the local asset behind it.
    Asset(BytesN<32>),
    /// Token id to the manager holding the locked side, where there is one.
    Manager(BytesN<32>),
    /// Token id to how funds are taken for it.
    Kind(BytesN<32>),
    /// Whether Axelar's hub will route to a chain at all.
    Trusted(String),
    Limit(BytesN<32>),
    Last,
    Count,
    Native,
}

#[contract]
pub struct MockIts;

#[contractimpl]
impl MockIts {
    // -------------------------------------------------------------------------------------
    // Test wiring. None of this is part of Axelar's interface.
    // -------------------------------------------------------------------------------------

    /// Teach the stand-in about a token id, the way an ITS deployment script would.
    pub fn register(
        env: Env,
        token_id: BytesN<32>,
        token: Address,
        manager: Address,
        kind: TokenManagerType,
    ) {
        env.storage()
            .instance()
            .set(&ItsKey::Asset(token_id.clone()), &token);
        env.storage()
            .instance()
            .set(&ItsKey::Manager(token_id.clone()), &manager);
        env.storage().instance().set(&ItsKey::Kind(token_id), &kind);
    }

    pub fn set_native(env: Env, token: Address) {
        env.storage().instance().set(&ItsKey::Native, &token);
    }
    pub fn native_token_address(env: Env) -> Address {
        env.storage().instance().get(&ItsKey::Native).unwrap()
    }
    pub fn gas_service(env: Env) -> Address {
        env.current_contract_address()
    }

    pub fn set_trusted(env: Env, chain: String, trusted: bool) {
        env.storage()
            .instance()
            .set(&ItsKey::Trusted(chain), &trusted);
    }

    pub fn set_flow_limit(env: Env, token_id: BytesN<32>, limit: i128) {
        env.storage()
            .instance()
            .set(&ItsKey::Limit(token_id), &limit);
    }

    pub fn last_transfer(env: Env) -> Result<TransferRecord, ItsError> {
        env.storage()
            .instance()
            .get(&ItsKey::Last)
            .ok_or(ItsError::NotConfigured)
    }

    pub fn transfer_count(env: Env) -> u32 {
        env.storage().instance().get(&ItsKey::Count).unwrap_or(0)
    }

    /// Put tokens somewhere so a test has something to send.
    pub fn faucet(env: Env, token: Address, to: Address, amount: i128) {
        token::StellarAssetClient::new(&env, &token).mint(&to, &amount);
    }

    // -------------------------------------------------------------------------------------
    // The outbound half of Axelar's interface
    // -------------------------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn interchain_transfer(
        env: Env,
        caller: Address,
        token_id: BytesN<32>,
        destination_chain: String,
        destination_address: Bytes,
        amount: i128,
        metadata: Option<Bytes>,
        gas_token: Option<Token>,
    ) -> Result<(), ItsError> {
        // Upstream checks all three of these before it asks for a signature, and the third one
        // is easy to get wrong: an empty payload is refused outright rather than treated as no
        // payload at all.
        if amount <= 0 {
            return Err(ItsError::InvalidAmount);
        }
        if destination_address.is_empty() {
            return Err(ItsError::InvalidDestinationAddress);
        }
        if let Some(ref data) = metadata {
            if data.is_empty() {
                return Err(ItsError::InvalidData);
            }
        }
        caller.require_auth();

        let token = Self::asset_of(&env, &token_id)?;
        let asset = token::Client::new(&env, &token);
        match Self::kind_of(&env, &token_id)? {
            // Three of the four manager types burn straight out of the sender's balance.
            TokenManagerType::LockUnlock => {
                let manager: Address = env
                    .storage()
                    .instance()
                    .get(&ItsKey::Manager(token_id.clone()))
                    .ok_or(ItsError::InvalidTokenId)?;
                asset.transfer(&caller, &manager, &amount);
            }
            _ => asset.burn(&caller, &amount),
        }

        // Upstream checks this inside `pay_gas_and_call_contract`, which runs after the funds
        // have already been taken. Same order here, so a refusal unwinds in a test the way it
        // would in production rather than in a tidier way.
        if !Self::is_trusted_chain(env.clone(), destination_chain.clone()) {
            return Err(ItsError::UntrustedChain);
        }
        if let Some(ref gas) = gas_token {
            token::Client::new(&env, &gas.address).transfer(
                &caller,
                env.current_contract_address(),
                &gas.amount,
            );
        }

        env.storage().instance().set(
            &ItsKey::Last,
            &TransferRecord {
                caller,
                token_id,
                destination_chain,
                destination_address,
                amount,
                data: metadata,
                gas_attached: gas_token.is_some(),
            },
        );
        let count: u32 = env.storage().instance().get(&ItsKey::Count).unwrap_or(0);
        env.storage().instance().set(&ItsKey::Count, &(count + 1));
        Ok(())
    }

    // -------------------------------------------------------------------------------------
    // Views Axelar exposes
    // -------------------------------------------------------------------------------------

    pub fn is_trusted_chain(env: Env, chain: String) -> bool {
        env.storage()
            .instance()
            .get(&ItsKey::Trusted(chain))
            .unwrap_or(false)
    }

    pub fn registered_token_address(env: Env, token_id: BytesN<32>) -> Result<Address, ItsError> {
        Self::asset_of(&env, &token_id)
    }

    pub fn deployed_token_manager(env: Env, token_id: BytesN<32>) -> Result<Address, ItsError> {
        env.storage()
            .instance()
            .get(&ItsKey::Manager(token_id))
            .ok_or(ItsError::InvalidTokenId)
    }

    pub fn token_manager_type(
        env: Env,
        token_id: BytesN<32>,
    ) -> Result<TokenManagerType, ItsError> {
        Self::kind_of(&env, &token_id)
    }

    pub fn flow_limit(env: Env, token_id: BytesN<32>) -> Option<i128> {
        env.storage().instance().get(&ItsKey::Limit(token_id))
    }

    // -------------------------------------------------------------------------------------
    // The inbound half
    // -------------------------------------------------------------------------------------

    /// Deliver a transfer that carries a payload, funds first and then the callback.
    ///
    /// The ordering is Axelar's: `give_token` runs before `execute_with_interchain_token`, so by
    /// the time the callback lands the recipient contract is already holding the money. An
    /// adapter written against the opposite assumption would pass every test that funded it
    /// afterwards and fail on the first real transfer.
    #[allow(clippy::too_many_arguments)]
    pub fn deliver(
        env: Env,
        target: Address,
        source_chain: String,
        message_id: String,
        source_address: Bytes,
        payload: Bytes,
        token_id: BytesN<32>,
        amount: i128,
    ) -> Result<u64, ItsError> {
        let token = Self::asset_of(&env, &token_id)?;
        token::StellarAssetClient::new(&env, &token).mint(&target, &amount);
        Self::call_back(
            &env,
            &target,
            source_chain,
            message_id,
            source_address,
            payload,
            token_id,
            token,
            amount,
        )
    }

    /// The same call with the funding step left out.
    ///
    /// Not something Axelar would ever do. It is here because an adapter that takes the rail's
    /// word for the amount rather than reading its own balance would pass every other test in
    /// this file, and this is the one that catches it.
    #[allow(clippy::too_many_arguments)]
    pub fn deliver_empty_handed(
        env: Env,
        target: Address,
        source_chain: String,
        message_id: String,
        source_address: Bytes,
        payload: Bytes,
        token_id: BytesN<32>,
        amount: i128,
    ) -> Result<u64, ItsError> {
        let token = Self::asset_of(&env, &token_id)?;
        Self::call_back(
            &env,
            &target,
            source_chain,
            message_id,
            source_address,
            payload,
            token_id,
            token,
            amount,
        )
    }

    // -------------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------------

    fn asset_of(env: &Env, token_id: &BytesN<32>) -> Result<Address, ItsError> {
        env.storage()
            .instance()
            .get(&ItsKey::Asset(token_id.clone()))
            .ok_or(ItsError::InvalidTokenId)
    }

    fn kind_of(env: &Env, token_id: &BytesN<32>) -> Result<TokenManagerType, ItsError> {
        env.storage()
            .instance()
            .get(&ItsKey::Kind(token_id.clone()))
            .ok_or(ItsError::InvalidTokenId)
    }

    /// Call the recipient the way Axelar calls it: by name, with a loose argument vector.
    #[allow(clippy::too_many_arguments)]
    fn call_back(
        env: &Env,
        target: &Address,
        source_chain: String,
        message_id: String,
        source_address: Bytes,
        payload: Bytes,
        token_id: BytesN<32>,
        token_address: Address,
        amount: i128,
    ) -> Result<u64, ItsError> {
        let returned = env.invoke_contract::<Val>(
            target,
            &Symbol::new(env, "execute_with_interchain_token"),
            vec![
                env,
                source_chain.into_val(env),
                message_id.into_val(env),
                source_address.into_val(env),
                payload.into_val(env),
                token_id.into_val(env),
                token_address.into_val(env),
                amount.into_val(env),
            ],
        );
        // Axelar throws this away. Reading it back is purely so a test can see the claim id
        // without going through the event log; the invocation above is the faithful part.
        Ok(u64::try_from_val(env, &returned).unwrap_or(0))
    }
}

/// Stands in for the manager of a lock and unlock token id.
///
/// It needs to be a real contract at an address of its own and very little else. The whole
/// point of it is that an authorisation naming the manager is visibly a different thing from one
/// naming ITS, which is what makes the two outbound paths worth testing separately. The one view
/// is there so a test can say out loud that the funds ended up here.
#[contract]
pub struct MockTokenManager;

#[contractimpl]
impl MockTokenManager {
    pub fn locked(env: Env, token: Address) -> i128 {
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }
}
