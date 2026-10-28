use soroban_sdk::{contractclient, Address, BytesN, Env, String};

/// What the router expects from every rail adapter.
///
/// The router hands an adapter the net amount and the destination, and the adapter's job is to
/// speak whichever dialect its rail speaks. That is the whole seam: the router knows about fees,
/// limits and bookkeeping, the adapter knows about Circle's burn call or Axelar's gateway, and
/// neither knows about the other's problems. Retiring a rail means pointing one storage slot
/// somewhere else.
#[contractclient(name = "RailAdapterClient")]
pub trait RailAdapter {
    /// Push `amount` of `token`, already sitting in this adapter's balance, onto the rail.
    ///
    /// `caller` is the router, and the adapter is expected to refuse anyone else.
    fn dispatch(
        env: Env,
        caller: Address,
        token: Address,
        amount: i128,
        destination_chain: String,
        destination: BytesN<32>,
        nonce: u64,
    );
}

#[soroban_sdk::contractclient(name = "PaidRailAdapterClient")]
pub trait PaidRailAdapter {
    fn gas_token(env: Env) -> Address;
    #[allow(clippy::too_many_arguments)]
    fn dispatch_from(
        env: Env,
        caller: Address,
        sender: Address,
        token: Address,
        amount: i128,
        destination_chain: String,
        destination: BytesN<32>,
        nonce: u64,
        gas_amount: i128,
    );
}
