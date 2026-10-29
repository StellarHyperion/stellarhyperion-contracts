//! Stand-ins for `token-messenger-minter-v2` and `message-transmitter-v2`.

use hyperion_core::cctp::{BurnMessage, CctpMessage};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Bytes, BytesN, Env,
};

// ------------------------------------------------------------------------------------------
// Shared failure vocabulary
// ------------------------------------------------------------------------------------------

/// The refusals Circle's contracts actually produce, under the names Circle gives them.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CircleError {
    AmountMustBeNonzero = 1,
    MintRecipientMustBeNonzero = 2,
    MaxFeeMustBeLessThanAmount = 3,
    /// Circle refuses a fast transfer whose max fee is below its own floor.
    InsufficientMaxFee = 4,
    InvalidAttestation = 5,
    NonceAlreadyUsed = 6,
    Malformed = 7,
    NotConfigured = 8,
}

// ------------------------------------------------------------------------------------------
// The burn side
// ------------------------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BurnRecord {
    pub caller: Address,
    pub amount: i128,
    pub burned: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub burn_token: Address,
    pub destination_caller: BytesN<32>,
    pub max_fee: i128,
    pub min_finality_threshold: u32,
    pub had_hook: bool,
}

#[contracttype]
#[derive(Clone)]
enum MessengerKey {
    Hook,
    /// Stroops the messenger leaves behind, standing in for Circle's dust stripping.
    Dust,
    /// Floor on the fee for a fast transfer, in absolute units.
    MinFee,
    Last,
    Count,
}

/// Plays Circle's messenger and minter.
///
/// The parts that matter are the preconditions and the pull. Circle takes funds with
/// `transfer_from`, which means an allowance has to be sitting there when the call lands, and it
/// normalises the amount downward before burning so the caller can be left holding a remainder.
/// Both behaviours are reproduced, because both are things Hyperion has to get right.
#[contract]
pub struct MockMessenger;

#[contractimpl]
impl MockMessenger {
    pub fn init(env: Env, dust: i128, min_fee: i128) {
        env.storage().instance().set(&MessengerKey::Dust, &dust);
        env.storage()
            .instance()
            .set(&MessengerKey::MinFee, &min_fee);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn deposit_for_burn(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    ) -> Result<(), CircleError> {
        Self::burn(
            &env,
            caller,
            amount,
            destination_domain,
            mint_recipient,
            burn_token,
            destination_caller,
            max_fee,
            min_finality_threshold,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn deposit_for_burn_with_hook(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
        hook_data: Bytes,
    ) -> Result<(), CircleError> {
        env.storage()
            .instance()
            .set(&MessengerKey::Hook, &hook_data);
        Self::burn(
            &env,
            caller,
            amount,
            destination_domain,
            mint_recipient,
            burn_token,
            destination_caller,
            max_fee,
            min_finality_threshold,
            true,
        )
    }

    pub fn last_burn(env: Env) -> Result<BurnRecord, CircleError> {
        env.storage()
            .instance()
            .get(&MessengerKey::Last)
            .ok_or(CircleError::NotConfigured)
    }

    pub fn burn_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&MessengerKey::Count)
            .unwrap_or(0)
    }

    pub fn last_hook(env: Env) -> Bytes {
        env.storage()
            .instance()
            .get(&MessengerKey::Hook)
            .unwrap_or(Bytes::new(&env))
    }

    #[allow(clippy::too_many_arguments)]
    fn burn(
        env: &Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
        had_hook: bool,
    ) -> Result<(), CircleError> {
        caller.require_auth();
        if amount <= 0 {
            return Err(CircleError::AmountMustBeNonzero);
        }
        if mint_recipient == BytesN::from_array(env, &[0u8; 32]) {
            return Err(CircleError::MintRecipientMustBeNonzero);
        }
        if max_fee >= amount {
            return Err(CircleError::MaxFeeMustBeLessThanAmount);
        }
        let min_fee: i128 = env
            .storage()
            .instance()
            .get(&MessengerKey::MinFee)
            .unwrap_or(0);
        // A fast transfer costs money. Asking for one without budgeting for it is refused.
        if min_finality_threshold < hyperion_core::cctp::FINALITY_THRESHOLD_FINALIZED
            && max_fee < min_fee
        {
            return Err(CircleError::InsufficientMaxFee);
        }

        let dust: i128 = env
            .storage()
            .instance()
            .get(&MessengerKey::Dust)
            .unwrap_or(0);
        let burned = amount - dust;
        // `transfer_from`, not `transfer`. This is the line that fails if the caller forgot to
        // approve, or approved too little.
        token::Client::new(env, &burn_token).burn_from(
            &env.current_contract_address(),
            &caller,
            &burned,
        );

        env.storage().instance().set(
            &MessengerKey::Last,
            &BurnRecord {
                caller,
                amount,
                burned,
                destination_domain,
                mint_recipient,
                burn_token,
                destination_caller,
                max_fee,
                min_finality_threshold,
                had_hook,
            },
        );
        let count: u32 = env
            .storage()
            .instance()
            .get(&MessengerKey::Count)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&MessengerKey::Count, &(count + 1));
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------
// The mint side
// ------------------------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum TransmitterKey {
    Token,
    /// What this stand-in charges, so the adapter cannot get away with trusting `burn.amount`.
    Fee,
    /// Set to mint nothing at all, which is what a token pair Circle does not recognise looks
    /// like from the outside.
    Mute,
    Used(BytesN<32>),
}

/// Plays Circle's transmitter.
///
/// It is the admin of the asset in every test, which is how it can mint and how the adapter's own
/// auth story can be checked with no mocked signatures at all.
#[contract]
pub struct MockTransmitter;

#[contractimpl]
impl MockTransmitter {
    pub fn init(env: Env, token: Address) {
        env.storage().instance().set(&TransmitterKey::Token, &token);
    }

    pub fn set_fee(env: Env, fee: i128) {
        env.storage().instance().set(&TransmitterKey::Fee, &fee);
    }

    pub fn set_mute(env: Env, mute: bool) {
        env.storage().instance().set(&TransmitterKey::Mute, &mute);
    }

    /// Put tokens somewhere so a test has something to send. Not part of Circle's interface.
    pub fn faucet(env: Env, to: Address, amount: i128) -> Result<(), CircleError> {
        let token: Address = env
            .storage()
            .instance()
            .get(&TransmitterKey::Token)
            .ok_or(CircleError::NotConfigured)?;
        token::StellarAssetClient::new(&env, &token).mint(&to, &amount);
        Ok(())
    }

    /// Verify an attestation and mint. The verifying is where the pretending happens.
    pub fn receive_message(
        env: Env,
        caller: Address,
        message: Bytes,
        signature: Bytes,
    ) -> Result<bool, CircleError> {
        caller.require_auth();
        // Stands in for signature recovery. An empty attestation is the one thing this can
        // meaningfully refuse, and it is enough to prove the adapter is not minting on its own
        // authority.
        if signature.is_empty() {
            return Err(CircleError::InvalidAttestation);
        }
        let token: Address = env
            .storage()
            .instance()
            .get(&TransmitterKey::Token)
            .ok_or(CircleError::NotConfigured)?;

        let msg = CctpMessage::parse(&env, &message).map_err(|_| CircleError::Malformed)?;
        let body = CctpMessage::body(&message).map_err(|_| CircleError::Malformed)?;
        let burn = BurnMessage::parse(&env, &body).map_err(|_| CircleError::Malformed)?;

        // The real transmitter will not process the same nonce twice, and neither will this one.
        // It is the outermost of the two replay guards on the inbound path.
        if env
            .storage()
            .persistent()
            .has(&TransmitterKey::Used(msg.nonce.clone()))
        {
            return Err(CircleError::NonceAlreadyUsed);
        }
        env.storage()
            .persistent()
            .set(&TransmitterKey::Used(msg.nonce), &true);

        let mute: bool = env
            .storage()
            .instance()
            .get(&TransmitterKey::Mute)
            .unwrap_or(false);
        if mute {
            return Ok(true);
        }
        let fee: i128 = env
            .storage()
            .instance()
            .get(&TransmitterKey::Fee)
            .unwrap_or(0);
        let minted = burn.amount - fee;
        if minted > 0 {
            let to = Address::from_string(&hyperion_core::codec::contract_strkey(
                &env,
                &burn.mint_recipient.to_array(),
            ));
            token::StellarAssetClient::new(&env, &token).mint(&to, &minted);
        }
        Ok(true)
    }
}
