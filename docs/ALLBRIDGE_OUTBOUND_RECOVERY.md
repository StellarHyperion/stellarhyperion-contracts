# Allbridge Outbound Recovery Workflow

Allbridge Core on Soroban remains a development-only adapter outside the active Stellar Testnet
outbound Axelar ITS and Circle CCTP deployment. Because Allbridge combines pool swapping and
messenger payment inside a single `swap_and_bridge` call, interrupted RPC calls or delayed
relayer indexing require explicit reconciliation before an operator takes any follow-up action.

## Invariants

1. **No second token debit on unknown outcomes**
   - Every successful `dispatch` writes an immutable `DataKey::Outbound(nonce)` record keyed by
     the router's monotonic `u64` nonce. Any duplicate `dispatch` for an already recorded `nonce`
     fails immediately with `HyperionError::ReplayedMessage` before authorizing pool or native gas
     transfers.
   - Both `inspect_outbound_recovery` and `reconcile_outbound` classify
     `ProviderObservation::Unknown` as `OutboundStatus::OutcomeUnknown` with
     `RecoveryAction::HoldDoNotDebit` and `second_debit_permitted = false`.
   - `attempt_provider_recovery` rejects `Dispatched` and `OutcomeUnknown` records with
     `HyperionError::ReplayedMessage`.

2. **Preserved recipient and full 32-byte message identity**
   - `OutboundRecord` retains the original 32-byte destination `recipient`, `receive_token`,
     `source_chain_id` (`7`), `allbridge_chain_id`, and full 256-bit `rail_nonce`.
   - `inspect_outbound_recovery` rejects mismatched `expected_recipient` values with
     `HyperionError::InvalidDestination` and mismatched token, amount, or chain fields with
     `HyperionError::MalformedMessage`.
   - `reconcile_outbound` recomputes `rail::hash_message` over `(v_usd, recipient, source_chain_id,
     allbridge_chain_id, receive_token, rail_nonce)` (including the two chain-ID bytes stamped into
     bytes `0..2`) and rejects any tampered digest with `HyperionError::MalformedMessage`.

3. **Explicit reporting of unsupported provider recovery**
   - Unlike Axelar (`add_gas`), Allbridge Core's Soroban bridge and messenger contracts expose no
     standalone post-dispatch gas top-up or message replay entrypoint that avoids a second pool
     sale.
   - Once `ProviderObservation::MessageSent(v_usd, message_id)` is reconciled, the adapter returns
     `RecoveryAction::UnsupportedProviderRecovery`, and `attempt_provider_recovery` fails
     explicitly with `HyperionError::UnsupportedRoute` without simulating a resend or moving funds.

## Compatibility and Migration

- Adds `DataKey::Outbound(u64)` in persistent storage along with `reconcile_outbound`,
  `attempt_provider_recovery`, `get_outbound`, `inspect_outbound_recovery`, and
  `keep_alive_outbound` on `AllbridgeAdapter`.
- Existing `initialize`, `dispatch`, `bridge_in`, and gas-float call signatures are unchanged, so
  router and test harnesses continue calling `dispatch` without migration steps.
