# Per-token EVM circuit breaker

The EVM router has a token-wide emergency breaker separate from its ordinary flow limits. It
exists for the case where one asset is behaving in a way that should stop every departure of that
asset, not just the rail that noticed it first.

This surface is development infrastructure. The active deployment remains the Stellar Testnet
router with outbound Axelar ITS and Circle CCTP. Adding this surface does not activate an EVM
deployment, and the EVM surface stays `gated` in `testdata/capabilities/evm-router.cap` until it is
independently validated and separately activated.

## What is different from a flow limit

| Control | Scope | Changing it | Latching it |
| ------- | ----- | ----------- | ----------- |
| Ordinary flow limit | Token and rail, with a token-wide default | Timelocked to raise, immediate to lower | Never latches; it only refuses transfers over its rolling ceiling |
| Emergency breaker threshold | Token-wide across every rail | Timelocked (`SetTokenCircuitBreakerThreshold`) | Automatic when the rolling amount reaches the threshold |

The ordinary limit is throughput policy. The breaker is a tighter catastrophe boundary: it counts
the same net amount that crosses the bridge, across all rails for one token, in the same sliding
flow window. A token can therefore be well inside its per-rail flow limits and still trip its
token-wide breaker.

The breaker has no separate manual-trip entry point. Guardians can immediately pause the router
or individual rails. `lowerTokenFlowLimit(token, 0)` narrows the token's default allowance, but
per-rail overrides can still allow departures; it is not a universal token stop. The breaker adds
an automatic token-wide cumulative trip and a reviewed way to re-arm it.

## Behaviour

- A departure whose net amount would cross the threshold is refused with
  `CircuitBreakerLatched(token, observedAmount, threshold)` before any token or fee movement.
  A reverted crossing attempt does not latch or consume headroom. A smaller transfer can still
  fit, and the rolling observation can decay. Resetting an unlatched breaker is refused.
- The departure that reaches the threshold exactly completes, then latches the breaker and emits
  `CircuitBreakerTripped(token, observedAmount, threshold)`.
- Once latched, every new departure for that token is refused, whichever rail is selected.
- `circuitBreaker(token)` returns `(threshold, tripped)`; the router view reads the immutable
  provenance child that owns the breaker state. The threshold is zero when no breaker has been
  configured for that token.
- `quote` reports `CircuitBreakerTripped` while the breaker is latched, and the
  `CircuitBreakerTripped(token, observedAmount, threshold)` event records the numbers at latch
  time. The event is emitted by the provenance child, which will be the log's address.
- Arrivals are not affected. `bridgeIn` never consults the breaker, because the counterpart has
  already been burned or locked on the far side.
- Parked claims are not affected. `settleClaim` and `settleClaims` pay the recipient fixed when the
  rail signed the message, not the current breaker state.
- Other tokens are unaffected.

## Bounds and reset policy

- A threshold must be greater than zero and no greater than the token's ordinary `flowLimit`. The
  bound is checked when the action is queued (when the token is already registered) and again when
  it executes, because the ordinary limit can move while the action waits.
- `SetTokenCircuitBreakerThreshold` is a timelocked `AdminAction`. Replacing a threshold is
  therefore reviewed and delayed.
- A reset is also a timelocked `AdminAction`, `ResetTokenCircuitBreaker`. It requires that the
  breaker is latched both when queued and when executed, and it never changes the threshold.
- Executing a reset clears the latch and the rolling observation for that token. That is an
  explicit, delayed, logged expansion of risk, not a side effect of raising a number: the queue,
  execution and audit events name the action, its subject and its timestamps, and the last
  `CircuitBreakerTripped` event records what had been observed before the reset.
- Raising a threshold does not clear a latch. Only `ResetTokenCircuitBreaker` re-arms it.
- Re-registering a token with a lower ordinary `flowLimit` is refused while that would leave the
  breaker threshold above the new ceiling. A threshold may be queued before its token exists, but
  the eventual registration enforces the same bound.
- A threshold that lands at or below the amount the current window already carried is violated on
  arrival: it latches immediately, so `circuitBreaker` reports it and a timelocked reset can clear
  the observation without waiting for the window to drain.

## Quote diagnostics

`QuoteBlocker.CircuitBreakerTripped` is appended as value `12`, so every existing blocker integer
keeps its meaning. On-chain `quote`, `quoteAll` and `quoteV2` return it when the breaker is latched
or when the requested net amount would cross the threshold. The TypeScript planner mirrors the
same decision through the optional `RouterSnapshot.circuitBreakerTripped` and
`RouterSnapshot.circuitBreakerAvailable` fields; snapshots that do not provide them behave exactly
as before.

`BLOCKER_COPY` distinguishes a latched stop, which requires a reviewed reset, from a transfer that
does not fit the remaining rolling headroom. The latter may fit after reducing its amount or
waiting for headroom. Both allow arrivals and existing claims. The app should not promise a time.

## Compatibility and migration

- **Additive ABI.** One view is added: `circuitBreaker(address)`. `TokenConfig` and its existing
  getter are unchanged. The rest of the interface change is two action kinds, one quote blocker
  and three error names.
- **No router storage change.** Breaker state lives in the immutable provenance child that the
  router already deploys and trusts for quotes, action validation and outbound records. The router
  storage layout, token configuration and per-route flow records are untouched. Both the router
  and its child are nonupgradeable: an existing deployed child cannot acquire this state through
  a storage-only upgrade. Adopting this implementation requires a separately reviewed deployment
  and migration plan. No upgrade is performed by this change.
- **Additive action kinds.** `SetTokenCircuitBreakerThreshold` and `ResetTokenCircuitBreaker` are
  appended to `ActionKind`. Existing action integers keep their meaning.
- **Additive error names.** `CircuitBreakerLatched`, `CircuitBreakerNotTripped` and
  `InvalidThreshold` are appended to the EVM error vocabulary in declaration order.
- **No wire-format change.** No CCTP message, Axelar payload, note layout, route tag or address
  encoding changes, so no cross-chain parity vectors move.
- **No live activation.** Deployments must queue `SetTokenCircuitBreakerThreshold` and wait out the
  timelock like every other configuration change. `script/Deploy.s.sol` reads
  `HYPERION_TOKEN_BREAKER_THRESHOLD` (default: half the ordinary flow limit) and records
  `tokenBreakerThreshold` in the phase-one record.

## Verification

```bash
cd evm && forge fmt --check
cd evm && forge test --match-path test/unit/RouterCircuitBreaker.t.sol
cd packages/protocol && npm run check
script/anvil-e2e.sh
```

The breaker suite is `evm/test/unit/RouterCircuitBreaker.t.sol`. It covers the configuration
bounds and ordering, a crossing departure being refused with no funds moved, latching at the
threshold, the token-wide scope across rails, inbound delivery and fixed-recipient claim settlement
while tripped, timelocked resets that preserve the threshold, and the new quote diagnostic on all
four rails.
These are local fixtures only; no testnet or mainnet transaction is part of this change.
