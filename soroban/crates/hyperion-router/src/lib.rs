//! Hyperion's Soroban router.
//!
//! The router is deliberately not a bridge. It never verifies a cross-chain message itself and
//! it never holds a validator set. What it does is own the accounting that sits either side of
//! somebody else's rail: fees, decimal conversion, flow limits, replay bookkeeping, and the
//! awkward cases that show up when an EVM chain and a Stellar account disagree about what an
//! address is.
//!
//! Outbound, the sender authorises once, the router takes its fee, floors the remainder to
//! something the destination can actually represent, charges the flow limit and hands the funds
//! to a rail adapter. Inbound, the rail's own receiver contract calls in, the router pulls the
//! funds it was promised, and either delivers them or writes down who they belong to.
#![no_std]

#[cfg(any(target_family = "wasm", test))]
mod action_codec;
mod adapter;
mod events;
#[cfg(any(target_family = "wasm", test))]
mod key_codec;
mod storage;
mod timelock;
mod types;

#[cfg(test)]
mod test;

pub use adapter::{PaidRailAdapter, PaidRailAdapterClient, RailAdapter, RailAdapterClient};
pub use storage::DataKey;
pub use timelock::{GRACE_PERIOD, MAX_TIMELOCK_DELAY, MIN_TIMELOCK_DELAY};
pub use types::{
    ActionAuditStatus, AdminAction, BatchOutboundItem, CancelReason, ClaimHistory, ClaimLiability,
    ClaimProvenance, ClaimSettlementResult, Config, DebitBreakdown, Destination, InboundRecord,
    MigrationStatus, Origin, OutboundPreconditions, OutboundRequest, PendingClaim, QueuedAction,
    Recipient, RecipientEligibility, RouteConfig, RouteQuote, RouteQuoteV2, SourceDebit,
    TokenConfig, TransferRecord, CURRENT_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION,
    MAX_MAINTENANCE_BATCH, MAX_REASON_LEN,
};

use hyperion_core::{
    address::{assert_route_supports, validated_evm_word},
    amount::{assert_exact_transfer, convert_decimals_exact, fee_and_floor},
    flow, HyperionError, RouteKind, MAX_FEE_BPS,
};
use soroban_sdk::{
    contract, contractimpl, token, vec, Address, BytesN, Env, EnvBase, IntoVal, String, TryFromVal,
    Vec,
};

// Every rail Hyperion knows how to speak, in the order the app shows them.
const ALL_ROUTES: [RouteKind; 4] = [
    RouteKind::Cctp,
    RouteKind::AxelarIts,
    RouteKind::AxelarGmp,
    RouteKind::Allbridge,
];
const MAX_CLAIMS_PER_BATCH: u32 = 50;

#[contract]
pub struct HyperionRouter;

#[contractimpl]
impl HyperionRouter {
    // Stand the router up. Callable exactly once.
    pub fn initialize(
        env: Env,
        admin: Address,
        guardian: Address,
        treasury: Address,
        fee_bps: u32,
        flow_window_ledgers: u32,
        timelock_delay: u64,
    ) -> Result<(), HyperionError> {
        if storage::is_initialized(&env) {
            return Err(HyperionError::AlreadyInitialized);
        }
        admin.require_auth();
        if fee_bps > MAX_FEE_BPS {
            return Err(HyperionError::FeeTooHigh);
        }
        if flow_window_ledgers == 0 {
            return Err(HyperionError::InvalidWindow);
        }
        if !(MIN_TIMELOCK_DELAY..=MAX_TIMELOCK_DELAY).contains(&timelock_delay) {
            return Err(HyperionError::TimelockDelayOutOfRange);
        }
        let cfg = Config {
            admin,
            guardian,
            treasury,
            fee_bps,
            flow_window_ledgers,
            timelock_delay,
            paused: false,
        };
        let encoded = storage::set_config(&env, &cfg);
        storage::set_schema_version(&env, CURRENT_SCHEMA_VERSION);
        storage::set_liability_tracking(&env);
        events::config_changed_encoded(&env, encoded);
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Outbound
    // ---------------------------------------------------------------------------------------

    // Send `amount` of `token` to an EVM chain over `route`.
    // Send `amount` of `token` to an EVM chain over `route`.
    //
    // `destination_decimals` is what the asset uses on the far side, six for USDC on every
    // EVM chain Hyperion targets against seven here. The router floors the transfer to
    // something that base can represent and never pulls the remainder from the sender at all,
    // which is cheaper for everyone than taking dust and then owing it back.
    //
    // Returns the outbound nonce, which is what the app and the indexer follow the transfer by.
    pub fn bridge_out(
        env: Env,
        sender: Address,
        request: OutboundRequest,
    ) -> Result<u64, HyperionError> {
        sender.require_auth();
        let plan = plan_outbound(&env, &request, None, None)?;
        bridge_out_inner(env, sender, request, None, plan)
    }

    pub fn bridge_out_with_gas(
        env: Env,
        sender: Address,
        request: OutboundRequest,
        gas_amount: i128,
    ) -> Result<u64, HyperionError> {
        sender.require_auth();
        if request.route != RouteKind::AxelarIts && request.route != RouteKind::Cctp {
            return Err(HyperionError::UnsupportedRoute);
        }
        if gas_amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        let plan = plan_outbound(&env, &request, Some(gas_amount), None)?;
        bridge_out_inner(env, sender, request, Some(gas_amount), plan)
    }

    pub fn bridge_out_with_preconditions(
        env: Env,
        sender: Address,
        request: OutboundRequest,
        preconditions: OutboundPreconditions,
    ) -> Result<u64, HyperionError> {
        sender.require_auth();
        let plan = plan_outbound(&env, &request, None, Some(&preconditions))?;
        bridge_out_inner(env, sender, request, None, plan)
    }

    pub fn bridge_out_gas_preconditions(
        env: Env,
        sender: Address,
        request: OutboundRequest,
        gas_amount: i128,
        preconditions: OutboundPreconditions,
    ) -> Result<u64, HyperionError> {
        sender.require_auth();
        if request.route != RouteKind::AxelarIts && request.route != RouteKind::Cctp {
            return Err(HyperionError::UnsupportedRoute);
        }
        if gas_amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        let plan = plan_outbound(&env, &request, Some(gas_amount), Some(&preconditions))?;
        bridge_out_inner(env, sender, request, Some(gas_amount), plan)
    }

    // Rail-specific provider cap: ITS gas-token base units, or CCTP burned-token base units.
    // The existing entry points and request record keep their ABI and authorization behavior.
    pub fn bridge_out_bounded(
        env: Env,
        sender: Address,
        request: OutboundRequest,
        gas_amount: i128,
        max_provider_budget: i128,
    ) -> Result<u64, HyperionError> {
        let plan = bounded_plan(&env, &request, Some(gas_amount), max_provider_budget)?;
        sender.require_auth();
        bridge_out_inner(env, sender, request, Some(gas_amount), plan)
    }

    // Returns the earliest bounded dispatch rejection, or zero, without moving funds.
    // Unknown adapter methods are unavailable; an amount-only quote never substitutes for them.
    pub fn explain_outbound(
        env: Env,
        request: OutboundRequest,
        gas_amount: Option<i128>,
        max_provider_budget: i128,
    ) -> u32 {
        match bounded_plan(&env, &request, gas_amount, max_provider_budget) {
            Ok(_) => 0,
            Err(error) => error as u32,
        }
    }

    pub fn bridge_out_batch(
        env: Env,
        sender: Address,
        requests: Vec<OutboundRequest>,
        max_total_amount: i128,
    ) -> Result<Vec<u64>, HyperionError> {
        bridge_out_batch_inner(
            env,
            sender,
            BatchSource::Requests(requests),
            max_total_amount,
        )
    }

    pub fn bridge_out_batch_items(
        env: Env,
        sender: Address,
        items: Vec<BatchOutboundItem>,
        max_total_amount: i128,
    ) -> Result<Vec<u64>, HyperionError> {
        bridge_out_batch_inner(env, sender, BatchSource::Items(items), max_total_amount)
    }

    pub fn supports_paid_route(_env: Env, route: RouteKind) -> bool {
        route == RouteKind::AxelarIts || route == RouteKind::Cctp
    }

    pub fn bridge_in(
        env: Env,
        caller: Address,
        route: RouteKind,
        token: Address,
        amount: i128,
        recipient: Recipient,
        origin: Origin,
    ) -> Result<u64, HyperionError> {
        caller.require_auth();
        let expected = storage::rail_receiver(&env, route)?;
        if caller != expected {
            return Err(HyperionError::NotRailReceiver);
        }
        if amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        storage::assert_liability_migration_not_running(&env)?;
        if storage::is_processed(&env, route, &origin.message_id) {
            return Err(HyperionError::ReplayedMessage);
        }
        assert_route_supports(route, recipient.kind)?;
        storage::mark_processed(&env, route, &origin.message_id);

        let this = env.current_contract_address();
        let client = token::Client::new(&env, &token);

        // Pull rather than trust. The receiver pre-authorises this transfer before calling in,
        // so if the funds are not actually there the whole delivery reverts here instead of
        // writing down a claim against money nobody holds.
        transfer_exact(&client, &caller, &this, amount, false)?;
        let delivered = transfer_exact(&client, &this, &recipient.address, amount, true)?;

        let claim_id = if delivered {
            0u64
        } else {
            // Almost always a missing trustline. Reverting would strand funds that have already
            // been burned on the far side, so the router keeps them and writes down whose they
            // are.
            let id = storage::next_claim_id(&env);
            let claim = PendingClaim {
                id,
                recipient: recipient.address.clone(),
                token: token.clone(),
                amount,
                route,
                source_chain: origin.chain.clone(),
                source_nonce: origin.nonce,
                created_at: env.ledger().timestamp(),
                settled: false,
            };
            let encoded_claim = storage::set_claim(&env, &claim);
            let reason = payout_failure_reason(&client, &this, amount);
            storage::set_claim_failure(&env, id, reason);
            if storage::liability_tracking(&env) {
                storage::increase_claim_liability(&env, &token, amount)?;
            }
            storage::set_claim_provenance(
                &env,
                id,
                &ClaimProvenance {
                    route,
                    source_chain: origin.chain.clone(),
                    message_id: origin.message_id.clone(),
                },
            );
            events::claim_parked_encoded(&env, &claim.recipient, &claim.token, encoded_claim);
            events::claim_payout_failure_v1(&env, &claim, reason);
            id
        };

        let record = InboundRecord {
            route,
            recipient: recipient.address,
            token,
            amount,
            source_chain: origin.chain,
            source_nonce: origin.nonce,
            delivered,
            claim_id,
            ledger: env.ledger().sequence(),
        };
        events::bridge_in(&env, &record);
        Ok(claim_id)
    }

    // Hand a parked claim to the recipient it was always going to.
    // Hand a parked claim to the recipient it was always going to.
    //
    // Permissionless on purpose. The funds can only move to the address recorded at delivery
    // time, so there is nothing to gain by calling this for somebody else and no reason to
    // make a user who just opened a trustline also work out how to call a contract.
    pub fn settle_claim(env: Env, settler: Address, id: u64) -> Result<(), HyperionError> {
        settler.require_auth();
        storage::assert_liability_migration_not_running(&env)?;
        settle_claim_inner(&env, &settler, id)
    }

    // Attempt a bounded list. Ordinary refusals preserve unrelated progress;
    // a nonconforming token mutation reverts the entire batch to preserve custody.
    pub fn settle_claims(
        env: Env,
        settler: Address,
        ids: Vec<u64>,
    ) -> Result<Vec<ClaimSettlementResult>, HyperionError> {
        settler.require_auth();
        storage::assert_liability_migration_not_running(&env)?;
        if ids.is_empty() || ids.len() > MAX_CLAIMS_PER_BATCH {
            return Err(HyperionError::InvalidAmount);
        }
        let this = env.current_contract_address();
        let mut results = vec![&env];
        for id in ids.iter() {
            let status = if storage::is_claim_archived(&env, id) {
                2
            } else if let Some(mut claim) = storage::claim(&env, id) {
                if claim.settled {
                    2
                } else {
                    let client = token::Client::new(&env, &claim.token);
                    let reason = attempt_payout(&client, &this, &claim.recipient, claim.amount)?;
                    if reason == 0 {
                        mark_claim_settled(&env, &mut claim)?;
                        record_claim_settlement(&env, &claim, &settler);
                        0
                    } else {
                        storage::set_claim_failure(&env, id, reason);
                        events::claim_payout_failure_v1(&env, &claim, reason);
                        match reason {
                            1 => 3,
                            2 => 4,
                            _ => 5,
                        }
                    }
                }
            } else {
                1
            };
            results.push_back(ClaimSettlementResult { id, status });
        }
        Ok(results)
    }

    pub fn claim_failure_reason(env: Env, id: u64) -> Result<u32, HyperionError> {
        if storage::claim(&env, id).is_none() {
            return Err(HyperionError::ClaimNotFound);
        }
        Ok(storage::claim_failure(&env, id))
    }

    // ---------------------------------------------------------------------------------------
    // Quoting
    // ---------------------------------------------------------------------------------------

    // Price `amount` across every rail at once, losers included.
    // Price `amount` across every rail at once, losers included.
    //
    // The app draws all four and says why the three it did not pick lost, so this returns a
    // quote per route with a reason code rather than filtering down to the winner. Reason is
    // zero when the route is available and otherwise the same error code the router would have
    // thrown had you tried it.
    pub fn quote_routes(
        env: Env,
        token: Address,
        amount: i128,
        destination_decimals: u32,
    ) -> Vec<RouteQuote> {
        quote_routes_inner(&env, &token, amount, destination_decimals, None)
    }

    pub fn quote_routes_for_destination(
        env: Env,
        token: Address,
        amount: i128,
        destination_decimals: u32,
        destination_chain: Option<String>,
    ) -> Vec<RouteQuote> {
        quote_routes_inner(
            &env,
            &token,
            amount,
            destination_decimals,
            destination_chain.as_ref(),
        )
    }

    pub fn quote_fingerprint(
        env: Env,
        route: RouteKind,
        token: Address,
        destination_decimals: u32,
    ) -> Result<BytesN<32>, HyperionError> {
        let cfg = storage::config(&env)?;
        let token_cfg = storage::token_config(&env, &token)?;
        let adapter_addr = storage::adapter(&env, route)?;
        Ok(hyperion_core::compute_quote_fingerprint(
            &env,
            route,
            &adapter_addr,
            cfg.fee_bps,
            token_cfg.decimals,
            destination_decimals,
        ))
    }

    // Versioned quote wrapper; legacy quote_routes retains its exact schema.
    pub fn quote_routes_v2(
        env: Env,
        token: Address,
        amount: i128,
        destination_decimals: u32,
    ) -> Vec<RouteQuoteV2> {
        let cfg = storage::config(&env);
        let token_cfg = cfg
            .as_ref()
            .ok()
            .and_then(|_| storage::token_config_opt(&env, &token));
        let breakdown_val =
            quote_breakdown_value(&env, &cfg, token_cfg.as_ref(), amount, destination_decimals);
        let mut out: Vec<soroban_sdk::Val> = vec![&env];
        let ledger = env.ledger().sequence();
        for route in ALL_ROUTES {
            let quote = match &cfg {
                Ok(cfg) => quote_one(
                    &env,
                    cfg,
                    &token,
                    token_cfg.as_ref(),
                    route,
                    amount,
                    destination_decimals,
                    ledger,
                    None,
                ),
                Err(error) => unavailable(&env, route, amount, *error),
            };
            let quote_val: soroban_sdk::Val = quote;
            let encoded: soroban_sdk::Val = env
                .map_new_from_slices(&["breakdown", "quote"], &[breakdown_val, quote_val])
                .unwrap()
                .into();
            out.push_back(encoded);
        }
        Vec::try_from_val(&env, &&out).unwrap()
    }

    // ---------------------------------------------------------------------------------------
    // Circuit breakers
    // ---------------------------------------------------------------------------------------

    // Stop new departures. Either key can do it, immediately, with no delay to sit through.
    pub fn pause(env: Env, caller: Address) -> Result<(), HyperionError> {
        set_pause_state(&env, &caller, true)
    }

    // Start again. Admin only, because deciding an incident is over is not a safety action.
    pub fn unpause(env: Env, caller: Address) -> Result<(), HyperionError> {
        set_pause_state(&env, &caller, false)
    }

    // Turn a rail off. No timelock: closing a lane only ever narrows what the bridge will do.
    pub fn disable_route(env: Env, caller: Address, route: RouteKind) -> Result<(), HyperionError> {
        require_authority(&env, &caller, true)?;
        storage::set_route_enabled(&env, route, false);
        events::route_configured(&env, route, false);
        Ok(())
    }

    // Stop a token dead without touching any other token.
    // Stop a token dead without touching any other token. No timelock, same reasoning as
    // pausing: if an asset turns out to be doing something it should not, waiting out a delay
    // to stop routing it is not a policy, it is a countdown.
    //
    // Re registering it through the timelock is what turns it back on, so this cannot be used
    // to quietly flip a token's decimals or limit on the way past.
    pub fn disable_token(env: Env, caller: Address, token: Address) -> Result<(), HyperionError> {
        require_authority(&env, &caller, true)?;
        let mut token_cfg = storage::token_config(&env, &token)?;
        token_cfg.enabled = false;
        let encoded = storage::set_token_config(&env, &token, &token_cfg);
        events::token_registered_encoded(&env, &token, encoded);
        Ok(())
    }

    // Tighten a flow limit immediately.
    // Tighten a flow limit immediately. Raising one goes through the timelock; lowering one
    // does not, for the same reason pausing does not.
    pub fn lower_token_flow_limit(
        env: Env,
        caller: Address,
        token: Address,
        limit: i128,
    ) -> Result<(), HyperionError> {
        require_authority(&env, &caller, true)?;
        if limit < 0 {
            return Err(HyperionError::InvalidLimit);
        }
        let mut token_cfg = storage::token_config(&env, &token)?;
        if limit >= token_cfg.flow_limit {
            return Err(HyperionError::InvalidLimit);
        }
        token_cfg.flow_limit = limit;
        storage::set_token_config(&env, &token, &token_cfg);
        events::flow_limit_lowered(&env, &token, limit, &caller);
        Ok(())
    }

    /// Tighten a destination-specific flow limit immediately. Raising one goes through the timelock;
    /// lowering one does not.
    pub fn lower_destination_flow_limit(
        env: Env,
        caller: Address,
        token: Address,
        route: RouteKind,
        chain: String,
        limit: i128,
    ) -> Result<(), HyperionError> {
        require_authority(&env, &caller, true)?;
        if limit < 0 {
            return Err(HyperionError::InvalidLimit);
        }
        let current_limit = storage::effective_destination_flow_limit(&env, &token, route, &chain)?;
        if limit >= current_limit {
            return Err(HyperionError::InvalidLimit);
        }
        storage::set_destination_flow_limit(&env, &token, route, &chain, limit);
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Timelocked administration
    // ---------------------------------------------------------------------------------------

    pub fn queue_action(
        env: Env,
        caller: Address,
        action: AdminAction,
    ) -> Result<u64, HyperionError> {
        let cfg = require_authority(&env, &caller, false)?;
        let queued = timelock::queue(&env, &cfg, &caller, action)?;
        let id = queued.id;
        events::action_queued(&env, queued);
        Ok(id)
    }

    pub fn execute_action(env: Env, caller: Address, id: u64) -> Result<(), HyperionError> {
        require_authority(&env, &caller, false)?;
        let queued = timelock::take_matured(&env, &caller, id)?;
        timelock::apply(&env, &queued.action)?;
        events::action_executed(&env, queued);
        Ok(())
    }

    // Throw away a queued change.
    // Throw away a queued change. The guardian can do this too, which is the point: noticing
    // something wrong in the queue should not require the key that put it there.
    pub fn cancel_action(env: Env, caller: Address, id: u64) -> Result<(), HyperionError> {
        Self::cancel_action_with_reason(
            env.clone(),
            caller,
            id,
            CancelReason::Unspecified,
            String::from_str(&env, ""),
        )
    }

    // Cancel a queued change with a structured reason code and bounded audit note (#44).
    pub fn cancel_action_with_reason(
        env: Env,
        caller: Address,
        id: u64,
        reason: CancelReason,
        note: String,
    ) -> Result<(), HyperionError> {
        require_authority(&env, &caller, true)?;
        timelock::cancel(&env, &caller, id, reason, note)?;
        Ok(())
    }

    // ---------------------------------------------------------------------------------------
    // Keeper, restoration planner, and schema migration
    // ---------------------------------------------------------------------------------------

    // Push archival dates back on entries nobody has touched lately.
    // Push archival dates back on entries nobody has touched lately.
    //
    // Soroban storage expires, which is a genuine difference from every EVM chain on the other
    // end of this bridge. A flow counter that archives quietly resets a limit, and a parked
    // claim that archives is somebody's money gone. Anyone can call this, it costs them a fee
    // and gains them nothing, and the backend runs it on a schedule so nobody has to.
    pub fn keep_alive(
        env: Env,
        tokens: Vec<Address>,
        routes: Vec<RouteKind>,
        claims: Vec<u64>,
        transfers: Vec<u64>,
    ) {
        if tokens
            .len()
            .saturating_add(routes.len())
            .saturating_add(tokens.len().saturating_mul(routes.len()).saturating_mul(2))
            .saturating_add(claims.len().saturating_mul(2))
            .saturating_add(transfers.len())
            > MAX_MAINTENANCE_BATCH
        {
            soroban_sdk::panic_with_error!(&env, HyperionError::InvalidLimit);
        }
        env.storage()
            .instance()
            .extend_ttl(storage::BUMP_THRESHOLD, storage::BUMP_TO);
        for route in routes.iter() {
            let _ = storage::route_config(&env, route);
        }
        for token in tokens.iter() {
            let _ = storage::token_config(&env, &token);
            for route in routes.iter() {
                let _ = storage::route_flow_limit(&env, &token, route);
                storage::touch_flow(&env, &token, route);
            }
        }
        for id in claims.iter() {
            let _ = storage::claim(&env, id);
            storage::touch_persistent_key(&env, &DataKey::ClaimProvenance(id));
            storage::touch_persistent_key(&env, &DataKey::ClaimSettledAt(id));
        }
        for nonce in transfers.iter() {
            let _ = storage::transfer(&env, nonce);
        }
    }

    // Bounded storage schema migration entrypoint, callable only by the reviewed upgrade authority (`cfg.admin`) (#46).
    // Bounded storage schema migration entrypoint, callable only by the reviewed upgrade
    // authority (`cfg.admin`) (#46).
    pub fn migrate_storage(
        env: Env,
        caller: Address,
        target_version: u32,
        max_steps: u32,
    ) -> Result<MigrationStatus, HyperionError> {
        require_authority(&env, &caller, false)?;
        if max_steps == 0 || max_steps > MAX_MAINTENANCE_BATCH {
            return Err(HyperionError::InvalidLimit);
        }
        let state = storage::migration_state(&env);
        // An already authorized v2 snapshot may be completed after upgrading to v3.
        // Its earlier claim cursor did not count liabilities; v3 must scan all claims anew.
        if target_version != CURRENT_SCHEMA_VERSION
            && !(target_version == 2
                && state
                    .as_ref()
                    .map(|s| s.target_version == 2)
                    .unwrap_or(false))
        {
            return Err(HyperionError::InvalidLimit);
        }
        let current = storage::schema_version(&env);
        if current == target_version {
            return Ok(Self::get_migration_status(env));
        }
        let mut status = state.ok_or(HyperionError::TimelockNotQueued)?;
        if status.target_version != target_version {
            return Err(HyperionError::InvalidLimit);
        }
        let mut remaining = max_steps;
        while remaining > 0 && status.migrated_transfers < status.total_transfers {
            let nonce = status.migrated_transfers + 1;
            let record = storage::transfer(&env, nonce).ok_or(HyperionError::UnknownNonce)?;
            // Typed read/write canonicalizes the legacy payload; fixed cursors record its version.
            // A missing/archived record aborts this transaction: restoration must precede migration.
            storage::set_transfer(&env, &record);
            status.migrated_transfers = nonce;
            remaining -= 1;
        }
        while remaining > 0 && status.migrated_claims < status.total_claims {
            let id = status.migrated_claims + 1;
            if storage::is_claim_archived(&env, id) {
                status.migrated_claims = id;
                remaining -= 1;
                continue;
            }
            let record = storage::claim(&env, id).ok_or(HyperionError::ClaimNotFound)?;
            if target_version == CURRENT_SCHEMA_VERSION
                && !storage::liability_tracking(&env)
                && !record.settled
            {
                if record.amount <= 0 {
                    return Err(HyperionError::InvalidAmount);
                }
                storage::increase_claim_liability(&env, &record.token, record.amount)?;
            }
            storage::set_claim(&env, &record);
            status.migrated_claims = id;
            remaining -= 1;
        }
        status.migration_pending = status.migrated_transfers < status.total_transfers
            || status.migrated_claims < status.total_claims;
        if !status.migration_pending {
            if target_version == CURRENT_SCHEMA_VERSION {
                storage::set_liability_tracking(&env);
            }
            storage::set_schema_version(&env, target_version);
            status.current_version = target_version;
        }
        storage::set_migration_state(&env, &status);
        events::storage_migrated(&env, &caller, &status);
        Ok(status)
    }

    // Extend the long retention policy for at most 32 exact, route-scoped replay keys.
    pub fn keep_alive_replays(env: Env, replays: Vec<(RouteKind, BytesN<32>)>) {
        if replays.len() > MAX_MAINTENANCE_BATCH {
            soroban_sdk::panic_with_error!(&env, HyperionError::InvalidLimit);
        }
        env.storage()
            .instance()
            .extend_ttl(storage::BUMP_THRESHOLD, storage::BUMP_TO);
        for (route, message_id) in replays.iter() {
            storage::touch_replay(&env, route, &message_id);
        }
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    // Where the protocol's cut goes.
    // Where the protocol's cut goes.
    //
    // Broken out of `get_config` because the rail adapters read it on their sweep path and
    // deserialising the whole config to pull one address out of it is wasted work on a call
    // anybody is allowed to make.
    pub fn treasury(env: Env) -> Result<Address, HyperionError> {
        Ok(storage::config(&env)?.treasury)
    }

    pub fn get_config(env: Env) -> Result<Config, HyperionError> {
        storage::config(&env)
    }

    pub fn is_paused(env: Env) -> bool {
        storage::config(&env).map(|cfg| cfg.paused).unwrap_or(true)
    }

    pub fn get_transfer(env: Env, nonce: u64) -> Result<TransferRecord, HyperionError> {
        storage::transfer(&env, nonce).ok_or(HyperionError::UnknownNonce)
    }

    pub fn get_claim(env: Env, id: u64) -> Result<PendingClaim, HyperionError> {
        storage::claim(&env, id).ok_or(HyperionError::ClaimNotFound)
    }

    // Historical lookup: archived is permanent; unavailable requires RPC restoration.
    pub fn claim_history(env: Env, id: u64) -> ClaimHistory {
        if storage::is_claim_archived(&env, id) {
            ClaimHistory::Archived(id)
        } else if storage::claim(&env, id).is_some() {
            ClaimHistory::Live(id)
        } else {
            ClaimHistory::Unavailable
        }
    }

    // Ascending cursor, at most 32 IDs; only timestamped settled records are removed.
    pub fn archive_settled_claims(env: Env, after: u64, limit: u32) -> Result<u64, HyperionError> {
        if limit == 0 || limit > MAX_MAINTENANCE_BATCH {
            return Err(HyperionError::InvalidLimit);
        }
        storage::assert_liability_migration_not_running(&env)?;
        let end = after
            .saturating_add(limit as u64)
            .min(storage::claim_count(&env));
        let now = env.ledger().timestamp();
        for id in after.saturating_add(1)..=end {
            if storage::is_claim_archived(&env, id) {
                continue;
            }
            let Some(claim) = storage::claim(&env, id) else {
                continue;
            };
            if !claim.settled {
                continue;
            }
            let Some(at) = storage::claim_settled_at(&env, id) else {
                continue;
            };
            if now.saturating_sub(at) < storage::MIN_CLAIM_RETENTION_SECONDS {
                continue;
            }
            events::claim_archived(&env, &claim, at, now);
            storage::archive_claim(&env, id);
        }
        Ok(end.max(after))
    }

    // Full source provenance for claims created after this view was introduced.
    // Full source provenance for claims created after this view was introduced. `None` means
    // the claim predates the provenance sidecar; its legacy nonce and route remain available.
    pub fn get_claim_provenance(env: Env, id: u64) -> Option<ClaimProvenance> {
        storage::claim_provenance(&env, id)
    }

    // Sum unsettled liabilities for a token and compare them with router custody.
    // Sum unsettled liabilities for a token and compare them with router custody. A missing
    // record or failed balance read makes the result explicitly unknown.
    pub fn claim_liability(env: Env, token: Address) -> ClaimLiability {
        let outstanding = storage::claim_liability(&env, &token);
        // An upgraded instance without this marker may contain pre-counter claims. Keep the
        // result explicitly unknown until a reviewed migration has accounted for them.
        let mut known = storage::liability_tracking(&env);
        let client = token::Client::new(&env, &token);
        let custody = match client.try_balance(&env.current_contract_address()) {
            Ok(Ok(balance)) if balance >= 0 => balance,
            _ => {
                known = false;
                0
            }
        };
        ClaimLiability {
            token,
            outstanding,
            custody,
            known,
            solvent: known && custody >= outstanding,
        }
    }

    // Best-effort payout preview. This is diagnostic only and never affects settlement.
    pub fn preview_claim_recipient(
        env: Env,
        id: u64,
    ) -> Result<RecipientEligibility, HyperionError> {
        let claim = storage::claim(&env, id).ok_or(HyperionError::ClaimNotFound)?;
        let client = token::Client::new(&env, &claim.token);
        match client.try_balance(&claim.recipient) {
            Ok(Ok(_))
                if client.address.executable() == Some(soroban_sdk::Executable::StellarAsset) =>
            {
                if token::StellarAssetClient::new(&env, &claim.token).authorized(&claim.recipient) {
                    Ok(RecipientEligibility::Eligible)
                } else {
                    Ok(RecipientEligibility::Unauthorized)
                }
            }
            Err(Ok(error)) if is_missing_trustline(&client, error) => {
                Ok(RecipientEligibility::MissingTrustline)
            }
            _ => Ok(RecipientEligibility::Unknown),
        }
    }

    pub fn get_queued(env: Env, id: u64) -> Result<QueuedAction, HyperionError> {
        storage::queued(&env, id).ok_or(HyperionError::TimelockNotQueued)
    }

    pub fn get_action_payload(env: Env, id: u64) -> Result<QueuedAction, HyperionError> {
        storage::action_payload(&env, id).ok_or(HyperionError::TimelockNotQueued)
    }

    pub fn get_migration_status(env: Env) -> MigrationStatus {
        storage::migration_state(&env).unwrap_or(MigrationStatus {
            current_version: storage::schema_version(&env),
            target_version: CURRENT_SCHEMA_VERSION,
            migration_pending: storage::schema_version(&env) < CURRENT_SCHEMA_VERSION,
            migrated_transfers: 0,
            migrated_claims: 0,
            total_transfers: storage::out_nonce(&env),
            total_claims: storage::claim_count(&env),
        })
    }

    pub fn get_token(env: Env, token: Address) -> Result<TokenConfig, HyperionError> {
        storage::token_config(&env, &token)
    }

    pub fn get_adapter(env: Env, route: RouteKind) -> Result<Address, HyperionError> {
        storage::adapter(&env, route)
    }

    pub fn get_rail_receiver(env: Env, route: RouteKind) -> Result<Address, HyperionError> {
        storage::rail_receiver(&env, route)
    }

    pub fn is_route_enabled(env: Env, route: RouteKind) -> bool {
        storage::route_enabled(&env, route)
    }

    pub fn get_route_config(env: Env, route: RouteKind) -> Option<RouteConfig> {
        storage::route_config(&env, route)
    }

    pub fn flow_available(
        env: Env,
        token: Address,
        route: RouteKind,
    ) -> Result<i128, HyperionError> {
        let cfg = storage::config(&env)?;
        let limit = storage::effective_flow_limit(&env, &token, route)?;
        let window = storage::flow_window(&env, &token, route);
        flow::available(
            &window,
            limit,
            env.ledger().sequence(),
            cfg.flow_window_ledgers,
        )
    }

    pub fn destination_flow_limit(
        env: Env,
        token: Address,
        route: RouteKind,
        chain: String,
    ) -> Option<i128> {
        storage::destination_flow_limit(&env, &token, route, &chain)
    }

    pub fn effective_destination_flow_limit(
        env: Env,
        token: Address,
        route: RouteKind,
        chain: String,
    ) -> Result<i128, HyperionError> {
        storage::effective_destination_flow_limit(&env, &token, route, &chain)
    }

    pub fn destination_flow_available(
        env: Env,
        token: Address,
        route: RouteKind,
        chain: String,
    ) -> Result<i128, HyperionError> {
        let cfg = storage::config(&env)?;
        let limit = storage::effective_destination_flow_limit(&env, &token, route, &chain)?;
        let window = storage::destination_flow_window(&env, &token, route, &chain);
        flow::available(
            &window,
            limit,
            env.ledger().sequence(),
            cfg.flow_window_ledgers,
        )
    }

    pub fn was_processed(env: Env, route: RouteKind, message_id: BytesN<32>) -> bool {
        storage::is_processed(&env, route, &message_id)
    }

    pub fn last_out_nonce(env: Env) -> u64 {
        storage::out_nonce(&env)
    }

    pub fn claim_count(env: Env) -> u64 {
        storage::claim_count(&env)
    }

    pub fn queue_count(env: Env) -> u64 {
        storage::queue_count(&env)
    }

    // Check token metadata; success classifies transfer behavior as unverified.
    // Check token metadata; success classifies transfer behavior as unverified.
    // Runtime balance invariants and operator token review are still required.
    //
    // Verifies that the token contract exists, correctly implements SEP-41 decimals matching
    // `expected_decimals`, does not exceed `MAX_DECIMALS`, and responds to standard balance checks.
    pub fn check_token_behavior(
        env: Env,
        token: Address,
        expected_decimals: u32,
    ) -> Result<(), HyperionError> {
        timelock::validate_token_behavior(&env, &token, expected_decimals)
    }
}

// Centralize the existing caller authentication and admin/guardian role checks.
#[inline(never)]
fn require_authority(
    env: &Env,
    caller: &Address,
    guardian_allowed: bool,
) -> Result<Config, HyperionError> {
    caller.require_auth();
    let cfg = storage::config(env)?;
    if caller != &cfg.admin && (!guardian_allowed || caller != &cfg.guardian) {
        return Err(HyperionError::Unauthorized);
    }
    Ok(cfg)
}

fn set_pause_state(env: &Env, caller: &Address, state: bool) -> Result<(), HyperionError> {
    let mut cfg = require_authority(env, caller, state)?;
    cfg.paused = state;
    storage::set_config(env, &cfg);
    events::paused(env, caller, state);
    Ok(())
}

#[inline(never)]
fn quote_routes_inner(
    env: &Env,
    token: &Address,
    amount: i128,
    destination_decimals: u32,
    destination_chain: Option<&String>,
) -> Vec<RouteQuote> {
    let mut out: Vec<soroban_sdk::Val> = vec![env];
    let cfg = match storage::config(env) {
        Ok(cfg) => cfg,
        Err(e) => {
            for route in ALL_ROUTES {
                out.push_back(unavailable(env, route, amount, e));
            }
            return Vec::try_from_val(env, &&out).unwrap();
        }
    };
    let token_cfg = storage::token_config_opt(env, token);
    let ledger = env.ledger().sequence();

    for route in ALL_ROUTES {
        out.push_back(quote_one(
            env,
            &cfg,
            token,
            token_cfg.as_ref(),
            route,
            amount,
            destination_decimals,
            ledger,
            destination_chain,
        ));
    }
    Vec::try_from_val(env, &&out).unwrap()
}

#[inline(never)]
fn quote_breakdown_value(
    env: &Env,
    cfg: &Result<Config, HyperionError>,
    token_cfg: Option<&TokenConfig>,
    amount: i128,
    destination_decimals: u32,
) -> soroban_sdk::Val {
    let breakdown = match (cfg, token_cfg) {
        (Ok(cfg), Some(token_cfg)) => hyperion_core::amount::compute_quote_breakdown(
            amount,
            cfg.fee_bps,
            token_cfg.decimals,
            destination_decimals,
        )
        .ok(),
        _ => None,
    };
    match breakdown {
        Some(b) => {
            let encoded: soroban_sdk::Val = env
                .map_new_from_slices(
                    &[
                        "actual_debit",
                        "destination_amount",
                        "fee",
                        "net_amount",
                        "requested_amount",
                        "retained_dust",
                    ],
                    &[
                        b.actual_debit.into_val(env),
                        b.destination_amount.into_val(env),
                        b.fee.into_val(env),
                        b.net_amount.into_val(env),
                        b.requested_amount.into_val(env),
                        b.retained_dust.into_val(env),
                    ],
                )
                .unwrap()
                .into();
            let tag: soroban_sdk::Val = soroban_sdk::symbol_short!("Known").into_val(env);
            env.vec_new_from_slice(&[tag, encoded]).unwrap().into()
        }
        None => {
            let tag: soroban_sdk::Val = soroban_sdk::Symbol::new(env, "Unavailable").into_val(env);
            env.vec_new_from_slice(&[tag]).unwrap().into()
        }
    }
}

// A quote for a route that cannot be used, carrying the reason it cannot.
#[inline(always)]
fn unavailable(
    env: &Env,
    route: RouteKind,
    amount: i128,
    reason: HyperionError,
) -> soroban_sdk::Val {
    encode_quote(
        env,
        route,
        amount,
        QuoteDetails {
            reason: reason as u32,
            fee: 0,
            net: 0,
            destination_amount: 0,
            flow_available: 0,
        },
    )
}

struct QuoteDetails {
    reason: u32,
    fee: i128,
    net: i128,
    destination_amount: i128,
    flow_available: i128,
}

#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn quote_one(
    env: &Env,
    cfg: &Config,
    token: &Address,
    token_cfg: Option<&TokenConfig>,
    route: RouteKind,
    amount: i128,
    destination_decimals: u32,
    ledger: u32,
    destination_chain: Option<&String>,
) -> soroban_sdk::Val {
    match quote_details(
        env,
        cfg,
        token,
        token_cfg,
        route,
        amount,
        destination_decimals,
        ledger,
        destination_chain,
    ) {
        Ok(details) => encode_quote(env, route, amount, details),
        Err(error) => unavailable(env, route, amount, error),
    }
}

#[inline(never)]
fn encode_quote(
    env: &Env,
    route: RouteKind,
    amount: i128,
    details: QuoteDetails,
) -> soroban_sdk::Val {
    let available = details.reason == 0;
    let gross_amount = if available {
        details.fee + details.net
    } else {
        amount
    };
    env.map_new_from_slices(
        &[
            "available",
            "destination_amount",
            "fee",
            "flow_available",
            "gross_amount",
            "is_canonical",
            "net_amount",
            "reason",
            "route",
            "waits_on_attestation",
        ],
        &[
            available.into_val(env),
            details.destination_amount.into_val(env),
            details.fee.into_val(env),
            details.flow_available.into_val(env),
            gross_amount.into_val(env),
            route.is_canonical().into_val(env),
            details.net.into_val(env),
            details.reason.into_val(env),
            route.into_val(env),
            route.waits_on_attestation().into_val(env),
        ],
    )
    .unwrap()
    .into()
}

#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn quote_details(
    env: &Env,
    cfg: &Config,
    token: &Address,
    token_cfg: Option<&TokenConfig>,
    route: RouteKind,
    amount: i128,
    destination_decimals: u32,
    ledger: u32,
    destination_chain: Option<&String>,
) -> Result<QuoteDetails, HyperionError> {
    let token_cfg = match token_cfg {
        Some(c) if c.enabled => c,
        Some(_) | None => return Err(HyperionError::TokenNotRegistered),
    };
    if amount <= 0 {
        return Err(HyperionError::InvalidAmount);
    }
    if cfg.paused {
        return Err(HyperionError::Paused);
    }
    if !storage::route_enabled(env, route) {
        return Err(HyperionError::RouteDisabled);
    }
    if storage::adapter(env, route).is_err() {
        return Err(HyperionError::AdapterNotSet);
    }
    if let Some(route_cfg) = storage::route_config(env, route) {
        if route_cfg.max_single_transfer > 0 && amount > route_cfg.max_single_transfer {
            return Err(HyperionError::ExceedsRouteLimit);
        }
    }

    let split = fee_and_floor(
        amount,
        cfg.fee_bps,
        token_cfg.decimals,
        destination_decimals,
    )?;
    let fee = split.fee;
    let net = split.net;
    if net <= 0 {
        return Err(HyperionError::AmountNotRepresentable);
    }
    let destination_amount = convert_decimals_exact(net, token_cfg.decimals, destination_decimals)?;

    let limit = storage::effective_flow_limit(env, token, route)?;
    let window = storage::flow_window(env, token, route);
    let route_headroom =
        flow::available(&window, limit, ledger, cfg.flow_window_ledgers).unwrap_or(0);

    let (effective_headroom, bound_by_dest) = if let Some(chain) = destination_chain {
        let dest_limit = storage::effective_destination_flow_limit(env, token, route, chain)?;
        let dest_window = storage::destination_flow_window(env, token, route, chain);
        let dest_headroom =
            flow::available(&dest_window, dest_limit, ledger, cfg.flow_window_ledgers).unwrap_or(0);
        if dest_headroom < route_headroom {
            (dest_headroom, true)
        } else {
            (route_headroom, false)
        }
    } else {
        (route_headroom, false)
    };

    let reason = if net > effective_headroom {
        if bound_by_dest {
            HyperionError::DestinationFlowLimitExceeded as u32
        } else {
            HyperionError::FlowLimitExceeded as u32
        }
    } else {
        0
    };
    Ok(QuoteDetails {
        reason,
        fee,
        net,
        destination_amount,
        flow_available: effective_headroom,
    })
}

// Both public batch formats share validation and dispatch without an intermediate
// Soroban vector that would encode and then decode every legacy request again.
enum BatchSource {
    Requests(Vec<OutboundRequest>),
    Items(Vec<BatchOutboundItem>),
}

impl BatchSource {
    fn len(&self) -> u32 {
        match self {
            Self::Requests(requests) => requests.len(),
            Self::Items(items) => items.len(),
        }
    }

    fn item(&self, index: u32) -> BatchOutboundItem {
        match self {
            Self::Requests(requests) => BatchOutboundItem {
                request: requests.get_unchecked(index),
                preconditions: OutboundPreconditions::default(),
                gas_amount: None,
            },
            Self::Items(items) => items.get_unchecked(index),
        }
    }
}

#[inline(never)]
fn bridge_out_batch_inner(
    env: Env,
    sender: Address,
    source: BatchSource,
    max_total_amount: i128,
) -> Result<Vec<u64>, HyperionError> {
    // The legacy wrapper decoded its inputs before requesting sender authority.
    // Preserve that error order while avoiding the temporary encoded item records.
    if let BatchSource::Requests(requests) = &source {
        for request in requests.iter() {
            let _ = request;
        }
    }
    sender.require_auth();
    let count = source.len();
    if count == 0 || count > 20 {
        return Err(HyperionError::BatchLimitExceeded);
    }
    if max_total_amount <= 0 {
        return Err(HyperionError::InvalidAmount);
    }
    let mut total_amount: i128 = 0;
    for index in 0..count {
        let item = source.item(index);
        if item.request.amount <= 0 {
            return Err(HyperionError::InvalidAmount);
        }
        total_amount = total_amount
            .checked_add(item.request.amount)
            .ok_or(HyperionError::DecimalOverflow)?;
    }
    if total_amount > max_total_amount {
        return Err(HyperionError::BatchLimitExceeded);
    }
    let mut nonces = vec![&env];
    for index in 0..count {
        let item = source.item(index);
        if let Some(gas) = item.gas_amount {
            if item.request.route != RouteKind::AxelarIts && item.request.route != RouteKind::Cctp {
                return Err(HyperionError::UnsupportedRoute);
            }
            if gas <= 0 {
                return Err(HyperionError::InvalidAmount);
            }
        }
        let plan = plan_outbound(
            &env,
            &item.request,
            item.gas_amount,
            Some(&item.preconditions),
        )?;
        let nonce = bridge_out_inner(
            env.clone(),
            sender.clone(),
            item.request,
            item.gas_amount,
            plan,
        )?;
        nonces.push_back(nonce);
    }
    Ok(nonces)
}

struct OutboundPlan {
    treasury: Address,
    fee: i128,
    net: i128,
    gross: i128,
    updated: hyperion_core::FlowWindow,
    updated_dest: hyperion_core::FlowWindow,
    adapter_addr: Address,
}

fn plan_outbound(
    env: &Env,
    request: &OutboundRequest,
    gas_amount: Option<i128>,
    preconditions: Option<&OutboundPreconditions>,
) -> Result<OutboundPlan, HyperionError> {
    let OutboundRequest {
        token,
        amount,
        route,
        destination,
        destination_decimals,
        min_destination_amount,
    } = request;

    // Issue #58: Sender-specified expiry. Expired requests fail before nonce or flow allowance changes.
    if let Some(pre) = preconditions {
        if let Some(deadline) = pre.deadline {
            if deadline > 0 {
                let is_expired = if deadline < 1_000_000_000 {
                    (env.ledger().sequence() as u64) > deadline
                } else {
                    env.ledger().timestamp() > deadline
                };
                if is_expired {
                    return Err(HyperionError::RequestExpired);
                }
            }
        }
    }

    let (amount, route, destination_decimals, min_destination_amount) = (
        *amount,
        *route,
        *destination_decimals,
        *min_destination_amount,
    );
    let cfg = storage::config(env)?;
    if cfg.paused {
        return Err(HyperionError::Paused);
    }
    if amount <= 0 {
        return Err(HyperionError::InvalidAmount);
    }
    if !storage::route_enabled(env, route) {
        return Err(HyperionError::RouteDisabled);
    }
    if let Some(route_cfg) = storage::route_config(env, route) {
        if route_cfg.max_single_transfer > 0 && amount > route_cfg.max_single_transfer {
            return Err(HyperionError::ExceedsRouteLimit);
        }
    }

    // A destination that is not a left-padded EVM word is refused rather than truncated.
    // Chopping the front off a Stellar key produces twenty bytes that look like a perfectly
    // ordinary address, and funds sent there are simply gone.
    validated_evm_word(&destination.address)?;
    if destination.chain.is_empty() {
        return Err(HyperionError::UnknownChain);
    }

    let token_cfg = storage::token_config(env, token)?;
    if !token_cfg.enabled {
        return Err(HyperionError::TokenNotRegistered);
    }

    // Issue #57: Bind paid dispatch to explicit quote configuration fingerprint.
    // Rejection before debit on changed adapter or fee.
    let adapter_addr = storage::adapter(env, route)?;
    if let Some(pre) = preconditions {
        if let Some(ref expected_fingerprint) = pre.quote_fingerprint {
            let actual_fingerprint = hyperion_core::compute_quote_fingerprint(
                env,
                route,
                &adapter_addr,
                cfg.fee_bps,
                token_cfg.decimals,
                destination_decimals,
            );
            if actual_fingerprint != *expected_fingerprint {
                return Err(HyperionError::FingerprintMismatch);
            }
        }
    }

    let split = fee_and_floor(
        amount,
        cfg.fee_bps,
        token_cfg.decimals,
        destination_decimals,
    )?;
    let fee = split.fee;
    let net = split.net;
    if net <= 0 {
        return Err(HyperionError::AmountNotRepresentable);
    }
    // Circle's forwarding fee is paid from the burned USDC. Protect the user's minimum
    // after that entire fee budget, rather than comparing against the pre-fee burn.
    let minimum_net = match (route, gas_amount) {
        (RouteKind::Cctp, Some(max_fee)) => {
            if max_fee <= 0 || max_fee >= net {
                return Err(HyperionError::InvalidAmount);
            }
            net - max_fee
        }
        _ => net,
    };
    let destination_amount =
        convert_decimals_exact(minimum_net, token_cfg.decimals, destination_decimals)?;
    if destination_amount < min_destination_amount {
        return Err(HyperionError::SlippageExceeded);
    }
    let gross = fee + net;

    // Issue #60: Check and consume both global route flow limit and destination flow limit.
    // Charge the flow limit against what actually crosses, not against what the sender
    // handed over. The fee never leaves Stellar, so it is not cross-chain exposure.
    let limit = storage::effective_flow_limit(env, token, route)?;
    let mut window = storage::flow_window(env, token, route);
    let ledger = env.ledger().sequence();
    let route_headroom = flow::prepare_window(&mut window, limit, ledger, cfg.flow_window_ledgers)?;

    let dest_limit =
        storage::effective_destination_flow_limit(env, token, route, &destination.chain)?;
    let mut dest_window = storage::destination_flow_window(env, token, route, &destination.chain);
    let dest_headroom = flow::prepare_window(
        &mut dest_window,
        dest_limit,
        ledger,
        cfg.flow_window_ledgers,
    )?;

    if dest_headroom < route_headroom && net > dest_headroom {
        return Err(HyperionError::DestinationFlowLimitExceeded);
    }
    if net > route_headroom {
        return Err(HyperionError::FlowLimitExceeded);
    }
    if net > dest_headroom {
        return Err(HyperionError::DestinationFlowLimitExceeded);
    }

    flow::consume_prepared(&mut window, limit, net, route_headroom)?;
    flow::consume_prepared(&mut dest_window, dest_limit, net, dest_headroom)?;

    Ok(OutboundPlan {
        treasury: cfg.treasury,
        fee,
        net,
        gross,
        updated: window,
        updated_dest: dest_window,
        adapter_addr,
    })
}

fn bounded_plan(
    env: &Env,
    request: &OutboundRequest,
    gas_amount: Option<i128>,
    max_provider_budget: i128,
) -> Result<OutboundPlan, HyperionError> {
    if let Some(gas) = gas_amount {
        if request.route != RouteKind::AxelarIts && request.route != RouteKind::Cctp {
            return Err(HyperionError::UnsupportedRoute);
        }
        if gas <= 0 || max_provider_budget < 0 {
            return Err(HyperionError::InvalidAmount);
        }
        if gas > max_provider_budget {
            return Err(HyperionError::ProviderBudgetExceeded);
        }
    } else if max_provider_budget != 0 {
        return Err(HyperionError::InvalidAmount);
    }
    let plan = plan_outbound(env, request, gas_amount, None)?;
    match RailAdapterClient::new(env, &plan.adapter_addr).try_check_dispatch(
        &env.current_contract_address(),
        &request.token,
        &plan.net,
        &request.destination.chain,
        &request.destination.address,
        &gas_amount,
    ) {
        Ok(Ok(())) => Ok(plan),
        Err(Ok(error)) if error.is_type(soroban_sdk::xdr::ScErrorType::Contract) => {
            match error.get_code() {
                2 => Err(HyperionError::NotInitialized),
                3 => Err(HyperionError::Unauthorized),
                9 => Err(HyperionError::InvalidAmount),
                11 => Err(HyperionError::DecimalOverflow),
                15 => Err(HyperionError::InvalidDestination),
                16 => Err(HyperionError::ZeroAddressKey),
                18 => Err(HyperionError::NotEvmAddress),
                19 => Err(HyperionError::UnknownChain),
                39 => Err(HyperionError::TokenNotMapped),
                44 => Err(HyperionError::UnsupportedRoute),
                _ => Err(HyperionError::AdapterMethodUnavailable),
            }
        }
        _ => Err(HyperionError::AdapterMethodUnavailable),
    }
}

fn bridge_out_inner(
    env: Env,
    sender: Address,
    request: OutboundRequest,
    gas_amount: Option<i128>,
    plan: OutboundPlan,
) -> Result<u64, HyperionError> {
    let OutboundPlan {
        treasury,
        fee,
        net,
        gross,
        updated,
        updated_dest,
        adapter_addr,
    } = plan;
    let OutboundRequest {
        token,
        route,
        destination,
        ..
    } = request;
    storage::set_flow_window(&env, &token, route, &updated);
    storage::set_destination_flow_window(&env, &token, route, &destination.chain, &updated_dest);

    let this = env.current_contract_address();
    let client = token::Client::new(&env, &token);

    let nonce = storage::next_out_nonce(&env);
    let sender_before = client.balance(&sender);
    let mut expected_debit = gross;
    if let Some(gas) = gas_amount {
        if route == RouteKind::AxelarIts
            && adapter::PaidRailAdapterClient::new(&env, &adapter_addr).gas_token() == token
        {
            expected_debit = gross
                .checked_add(gas)
                .ok_or(HyperionError::DecimalOverflow)?;
        }
        if fee > 0 {
            transfer_exact(&client, &sender, &treasury, fee, false)?;
        }
        adapter::PaidRailAdapterClient::new(&env, &adapter_addr).dispatch_from(
            &this,
            &sender,
            &token,
            &net,
            &destination.chain,
            &destination.address,
            &nonce,
            &gas,
        );
    } else {
        let before_this = client.balance(&this);
        transfer_exact(&client, &sender, &this, gross, false)?;

        if fee > 0 {
            transfer_exact(&client, &this, &treasury, fee, false)?;
        }

        transfer_exact(&client, &this, &adapter_addr, net, false)?;
        if client.balance(&this) != before_this {
            return Err(HyperionError::InvalidAmount);
        }

        RailAdapterClient::new(&env, &adapter_addr).dispatch(
            &this,
            &token,
            &net,
            &destination.chain,
            &destination.address,
            &nonce,
        );
    }

    assert_exact_transfer(client.balance(&sender), sender_before, expected_debit)?;

    let record = TransferRecord {
        nonce,
        sender,
        token,
        gross_amount: gross,
        fee,
        net_amount: net,
        destination_chain: destination.chain,
        destination: destination.address,
        route,
        created_ledger: env.ledger().sequence(),
        created_at: env.ledger().timestamp(),
    };
    let encoded = storage::set_transfer(&env, &record);
    events::bridge_out_encoded(&env, record.route, &record.sender, encoded);
    Ok(nonce)
}

fn settle_claim_inner(env: &Env, settler: &Address, id: u64) -> Result<(), HyperionError> {
    if storage::is_claim_archived(env, id) {
        return Err(HyperionError::ClaimAlreadySettled);
    }
    let mut claim = storage::claim(env, id).ok_or(HyperionError::ClaimNotFound)?;
    if claim.settled {
        return Err(HyperionError::ClaimAlreadySettled);
    }
    // Effects precede external token calls; a failed payout reverts these within its invocation.
    mark_claim_settled(env, &mut claim)?;
    let this = env.current_contract_address();
    if !transfer_exact(
        &token::Client::new(env, &claim.token),
        &this,
        &claim.recipient,
        claim.amount,
        true,
    )? {
        return Err(HyperionError::RecipientNotReady);
    }
    record_claim_settlement(env, &claim, settler);
    Ok(())
}

fn mark_claim_settled(env: &Env, claim: &mut PendingClaim) -> Result<(), HyperionError> {
    claim.settled = true;
    storage::set_claim(env, claim);
    if storage::liability_tracking(env) {
        storage::decrease_claim_liability(env, &claim.token, claim.amount)?;
    }
    Ok(())
}

fn record_claim_settlement(env: &Env, claim: &PendingClaim, settler: &Address) {
    storage::set_claim_settled_at(env, claim.id, env.ledger().timestamp());
    storage::set_claim_failure(env, claim.id, 0);
    events::claim_settled(env, claim, settler);
}

// Recipient refusals are safe to park only when no token balance moved.
fn transfer_exact(
    client: &token::Client,
    from: &Address,
    to: &Address,
    amount: i128,
    allow_refusal: bool,
) -> Result<bool, HyperionError> {
    let from_before = payout_balance(client, from)?;
    let to_before = payout_balance(client, to)?;
    transfer_from_snapshot(
        client,
        from,
        to,
        amount,
        (from_before, to_before),
        allow_refusal,
    )
}

// Batch preflight and ordinary transfers share the same exact post-transfer checks.
// A successful inexact transfer or unreadable post-transfer balance reverts the invocation.
fn transfer_from_snapshot(
    client: &token::Client,
    from: &Address,
    to: &Address,
    amount: i128,
    before: (i128, i128),
    allow_refusal: bool,
) -> Result<bool, HyperionError> {
    let (from_before, to_before) = before;
    let delivered = if allow_refusal {
        matches!(client.try_transfer(from, to, &amount), Ok(Ok(())))
    } else {
        client.transfer(from, to, &amount);
        true
    };
    let from_after = payout_balance(client, from)?;
    let to_after = payout_balance(client, to)?;
    if delivered {
        assert_exact_transfer(from_after, from_before, amount)?;
        assert_exact_transfer(to_before, to_after, amount)?;
    } else if from_before != from_after || to_before != to_after {
        return Err(HyperionError::InvalidAmount);
    }
    Ok(delivered)
}

// V1 codes: 0 delivered, 1 refused unchanged payout, 2 custody short, 3 unreadable.
fn attempt_payout(
    client: &token::Client,
    from: &Address,
    to: &Address,
    amount: i128,
) -> Result<u32, HyperionError> {
    let before = match (payout_balance(client, from), payout_balance(client, to)) {
        (Ok(balance), Ok(_)) if balance < amount => return Ok(2),
        (Ok(from), Ok(to)) => (from, to),
        _ => return Ok(3),
    };
    if transfer_from_snapshot(client, from, to, amount, before, true)? {
        Ok(0)
    } else {
        Ok(1)
    }
}

// V1 codes: 1 refused unchanged payout, 2 custody short, 3 token/accounting unavailable.
fn payout_failure_reason(client: &token::Client, router: &Address, amount: i128) -> u32 {
    match client.try_balance(router) {
        Ok(Ok(balance)) if balance >= amount => 1,
        Ok(Ok(balance)) if balance >= 0 => 2,
        _ => 3,
    }
}

fn is_missing_trustline(client: &token::Client, error: soroban_sdk::Error) -> bool {
    error == soroban_sdk::Error::from_contract_error(13)
        && client.address.executable() == Some(soroban_sdk::Executable::StellarAsset)
}

// A built-in SAC reports contract error 13 for an absent account trustline.
// Its balance is zero; arbitrary token balance errors are not trusted as zero.
fn payout_balance(client: &token::Client, to: &Address) -> Result<i128, HyperionError> {
    match client.try_balance(to) {
        Ok(Ok(balance)) if balance >= 0 => Ok(balance),
        Err(Ok(error)) if is_missing_trustline(client, error) => Ok(0),
        _ => Err(HyperionError::InvalidAmount),
    }
}
