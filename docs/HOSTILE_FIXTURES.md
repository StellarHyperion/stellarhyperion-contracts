# Hostile Soroban token and receiver fixtures

The router accepts tokens and rail receivers that the admin registers. Registration checks
metadata, but it cannot certify how a token or receiver will actually behave (see
`token-behavior.md`). The fixtures described here are test-only contracts that misbehave on
purpose and in configurable ways. They drive the router's real entry points (`bridge_out`,
`bridge_in` and `settle_claim`) so the existing exact-accounting, authentication, replay and
claim checks are tested against the failures they exist to catch.

| Item | Path |
| --- | --- |
| Fixture source | `soroban/crates/hyperion-router/src/test/hostile.rs` |
| Boundary suite | `soroban/crates/hyperion-router/src/test/hostile_boundaries.rs` |
| World helpers | `World::with_hostile_token`, `World::hostile`, `World::with_hostile_receiver` in `test/setup.rs` |

## `HostileToken`

Rules are keyed by the address being **credited**, so a single token can behave differently on
each leg of one router call. On outbound, the legs are user → router, router → treasury and
router → adapter. On inbound, the legs are receiver → router and router → recipient. Claim
settlement has one leg, router → recipient. Any address without a rule is treated as `Honest`.

| `Hostility` | Behaviour | What the router does |
| --- | --- | --- |
| `Honest` | Moves exactly `amount`. | Proceeds normally. |
| `Frozen` | Returns `RecipientCannotReceive` and moves nothing. | Outbound and inbound pull legs revert. A payout leg parks a recipient-bound claim (failure reason 1). Settlement returns `RecipientNotReady`. |
| `ShortCredit(n)` | Returns success, debits `amount` and credits `amount - n`. | Every leg reverts with `InvalidAmount`, including a settlement, which also rolls back the settled flag and the liability decrement it wrote first. |
| `ExtraDebit(n)` | Returns success, debits `amount + n` and credits `amount`. | Same as `ShortCredit`. The sender must hold the extra `n`, otherwise the token refuses with nothing moved. |
| `RequireCosigner(a)` | Calls `a.require_auth()` for an address outside the auth tree, which is a genuine host authentication failure. | Outbound legs revert. A payout leg parks a claim, and the claim stays funded until the failure clears. |
| `Reenter(r)` | Calls `r` (`SettleClaim` or `BridgeOut`) on the router before moving funds, records `CallbackAttempt { to, refused }`, then transfers honestly. | The host's re-entry guard refuses the callback, and the outer operation completes exactly once. |

`attempts()` returns the callback attempts from committed invocations only. A reverted
invocation rolls back its own record.

## `HostileReceiver`

This fixture replaces a route's rail receiver through the timelocked `SetRailReceiver` action.
The suite runs it with `env.set_auths(&[])` and the real Stellar Asset Contract, so the only thing
that can satisfy the router's pull is the receiver's own `authorize_as_current_contract`.

| `ReceiverMode` | Behaviour | What the router does |
| --- | --- | --- |
| `Honest` | Authorises the exact pull, then calls `bridge_in`, the same as `MockRail::deliver`. | Delivers. |
| `SkipAuthorization` | Calls `bridge_in` without pre-authorising the pull. | The whole delivery reverts. No replay mark, no claim and no balance change. |
| `AuthorizeAmount(x)` | Authorises a pull of `x` but declares the delivery amount. | Same as `SkipAuthorization`. |
| `ReplayInSameInvocation` | Authorises two pulls and calls `bridge_in` twice with the same origin. | The second call returns `ReplayedMessage` (stored in `replay_outcome()`), and the recipient is paid once. |

## Invariants the suite asserts

After every refusal, a `Books` snapshot must equal the snapshot taken before the call. The
snapshot covers:

- the user, treasury, router, adapter and recipient balances
- the outbound nonce and the adapter dispatch count
- the CCTP flow window (which meters the net amount)
- the claim count and the outstanding claim liability

After each refusal, the same operation under honest behaviour must succeed exactly once: nonce 1,
one dispatch, the exact fee, net and flow consumption, and a single payout. Replaying it afterwards
must fail. A parked claim keeps its recorded recipient and amount through every failed settlement.
A third-party settler receives nothing.

## Determinism

The fixtures read no ledger time, ledger sequence, PRNG or call counter. Rules are explicit
configuration. `hostile_fixture_outcomes_are_deterministic_across_fresh_worlds` runs one
scripted pass over every token mode twice and requires identical outcomes and `Books` traces.
Seeded provider faults are a separate tool (`ProviderFaultFixture`, `docs/STATEFUL_ROUTER_MODEL.md`).

To run the suite:

```sh
cd soroban && cargo test -p hyperion-router --lib hostile_boundaries
```

## Compatibility and migration

These are test-only contracts compiled under `#[cfg(test)]`. The deployed router WASM, storage
keys, events, wire formats, integer amounts and the Soroban/EVM error vocabularies are all
unchanged. No migration, redeployment or re-registration is required. The active deployment is
still Stellar Testnet outbound ITS/CCTP. These fixtures do not activate EVM, inbound production
or any other rail, which all remain gated on their own independent validation. Like every
balance-delta check, the fixtures cannot model a token whose `balance` lies consistently or that
is later upgraded, and that risk remains part of operator token review.
