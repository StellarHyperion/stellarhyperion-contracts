# Outbound policy and preconditions

These Soroban router methods add optional quote binding and expiry, atomic batches, and
per-destination flow ceilings. Legacy request fields and entrypoints remain available. The
EVM implementation is unchanged apart from additive error declarations.

## Quote configuration binding

`quote_fingerprint(route, token, destination_decimals)` returns SHA-256 of the Soroban XDR
encoding of `(route as u32, adapter address, fee_bps, source_decimals, destination_decimals)`.
Use that exact value in `OutboundPreconditions.quote_fingerprint`; a mismatch returns
`FingerprintMismatch` (55) before token debit, nonce advancement or flow consumption.

`bridge_out_with_preconditions` and `bridge_out_gas_preconditions` carry these optional
preconditions. Batch items can carry them independently. A changed adapter, fee or precision
invalidates a reviewed fingerprint. An unchanged fingerprint preserves the existing fee,
rounding and provider dispatch behavior. Legacy calls and `quote_fingerprint: None` retain
execution against the current configuration; they do not acquire quote binding automatically.
The fingerprint binds configuration, rather than replacing sender authorization or slippage checks.

## Sender expiry

`OutboundPreconditions.deadline` accepts an optional u64 boundary. Positive values below
1,000,000,000 use the ledger sequence; values at or above that threshold use the ledger timestamp
in Unix seconds. Execution at the boundary is allowed; execution after it returns
`RequestExpired` (56) before nonce, flow or debit changes. `None` and zero disable expiry.
Legacy calls retain their existing behavior without a deadline.

## Atomic batches

`bridge_out_batch(sender, requests, max_total_amount)` uses legacy requests without preconditions
or provider payments. `bridge_out_batch_items(sender, items, max_total_amount)` permits independent
preconditions and optional paid ITS or CCTP dispatch for each item.

Each batch contains one through 20 items. Every requested amount and the caller's aggregate
ceiling must be positive; the checked sum of requested amounts must fit that ceiling before any
dispatch. A count or total-bound violation returns `BatchLimitExceeded` (57). Arithmetic overflow
is rejected. The ceiling covers requested token amounts; provider payments remain separately
authorized per item and are not silently counted as token amounts.

Each successful item retains its exact destination and receives a distinct increasing router
nonce. Any failure in a later item reverts the entire invocation, including earlier token debits,
fees, provider calls, nonces and both flow windows. Batch authorization covers the complete call.

## Destination flow ceilings

Destination policies use `(token, route, exact destination-chain string)` keys. A configured
ceiling is combined with the existing token-route ceiling using their minimum. The destination
window and shared token-route window both consume the representable net amount that crosses
chains; protocol fees do not consume cross-chain exposure. No destination can bypass the shared
route window.

`quote_routes_for_destination` reports the available headroom from both windows and the same
binding refusal as dispatch. If the destination is the tighter exhausted window, the refusal is
`DestinationFlowLimitExceeded` (58); if the shared route window binds, it is `FlowLimitExceeded`.
The legacy destination-free quote remains a view of the shared route limit.

The admin queues `AdminAction::SetDestinationFlowLimit` through the existing timelock to set or
raise a policy. Admin or guardian can lower its effective limit immediately with
`lower_destination_flow_limit`. A configured zero stops dispatch to that destination. An absent
policy inherits the current token-route limit, including later changes to that limit.

## Compatibility and commissioning

Stable existing Soroban error codes 1–54 are retained; these four errors append at 55–58.
Existing request types and storage keys retain their encodings. New destination policy and window
keys are additive. On a reviewed timelocked upgrade, existing lanes without a policy inherit
current token-route limits; their existing shared route window remains authoritative. New
per-destination windows start empty and cannot override that shared history. Operators should
queue any desired destination restrictions through the normal timelock and verify defaults and
headroom before enabling traffic. No upgrade or state migration is performed by this PR.

The active deployment is Stellar Testnet outbound ITS/CCTP as recorded in
[TESTNET_ACTIVATION.md](TESTNET_ACTIVATION.md). EVM and other rails remain subject to their existing
commissioning requirements. Local validation does not change deployed code, balances, trustlines,
provider configuration or live route activation.
