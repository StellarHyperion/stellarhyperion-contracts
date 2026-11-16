# Hostile Soroban Token and Receiver Fixtures

`soroban/crates/hyperion-router/src/test/hostile_fixtures.rs` provides deterministic, configurable Soroban contract doubles—`HostileToken` and `HostileRail`—paired with `@hyperion/protocol`'s `hostileFixtures.ts` specification catalog to verify `HyperionRouter` boundaries when external tokens or rail contracts misbehave.

## Why Separate Hostile Fixtures Exist

The built-in `soroban-sdk` Stellar Asset Contract test helper opens trustlines automatically, always moves exact integer amounts, and never executes reentrant callbacks. Real-world Soroban SEP-41 tokens and custom rail integrations can deviate in four ways:

1. **Short transfers (fee-on-transfer / haircut tokens)**
2. **Authorization and mid-flight leg failures**
3. **Frozen recipients and frozen protocol accounts**
4. **Callback / reentrancy attempts into `HyperionRouter`**

## Deterministic Fixture Profiles

| Fixture ID | Rust Mode / API | Router Boundary | Expected Disposition |
| --- | --- | --- | --- |
| `token-short-transfer-bps-outbound` | `HostileTokenMode::ShortTransferBps` | `bridge_out` | Atomic rollback (`InsufficientBalance` on adapter leg) |
| `token-short-transfer-flat-paid-outbound` | `HostileTokenMode::ShortTransferFlat` | `bridge_out_with_gas` | Atomic rollback (`UnderfundedDispatch` in `dispatch_from`) |
| `token-short-transfer-inbound-parked` | `HostileTokenMode::ShortTransferFlat` | `bridge_in` | Parks claim (`try_transfer` refuses underfunded payout) |
| `rail-inbound-omit-sub-auth` | `InboundAuthMode::OmitSubAuth` | `bridge_in` | Atomic rollback (sub-contract auth trap; `was_processed = false`) |
| `rail-inbound-under-authorized-amount` | `InboundAuthMode::UnderAuthorizeAmount` | `bridge_in` | Atomic rollback (exact-args sub-auth mismatch) |
| `rail-inbound-wrong-recipient-sub-auth` | `InboundAuthMode::AuthorizeWrongRecipient` | `bridge_in` | Atomic rollback (wrong transfer recipient authorized) |
| `token-selective-leg-failure-outbound` | `HostileTokenMode::FailOnTransferCall` | `bridge_out` | Atomic rollback after `flow::consume` and `next_out_nonce` |
| `token-frozen-recipient-inbound` | `HostileToken::set_frozen` | `bridge_in` | Parks `PendingClaim` (`settled = false`); fees/flow/nonce unchanged |
| `token-frozen-recipient-settle` | `HostileToken::set_frozen` | `settle_claim` | Returns `RecipientNotReady`; claim stays unsettled in escrow |
| `token-frozen-treasury-outbound` | `HostileToken::set_frozen` | `bridge_out` | Atomic rollback when treasury rejects protocol fee credit |
| `token-callback-reenter-settle-claim` | `HostileTokenMode::CallbackSettleClaim` | `settle_claim` | Soroban host traps reentry; `try_transfer` returns `RecipientNotReady` |
| `token-callback-reenter-pause` | `HostileTokenMode::CallbackPause` | `bridge_out` | Soroban host traps reentry; `paused = false`, fees/flow/nonce rolled back |
| `rail-callback-reenter-router` | `HostileRailMode::CallbackBridgeOut` | `bridge_out` | Soroban host traps reentry (`bridge_out`, `bridge_in`, `settle_claim`) |

## Post-Failure State Assertions

`RouterStateSnapshot` (in Rust) and `verifyAtomicRollback` / `verifyParkedClaimTransition` (in `@hyperion/protocol`) check every accounting dimension on each boundary test:

- **Fees:** `treasury` token balance never increases on a rolled-back outbound call and is untouched by inbound claim parking.
- **Flow:** `router.flow_available(token, route)` returns to its exact pre-call value even when failure occurs after `storage::set_flow_window` in `bridge_out_inner`.
- **Nonce:** `router.last_out_nonce()` and `router.get_transfer(next_nonce)` (`UnknownNonce`) show zero leaked nonces on failed departures.
- **Claims and Replay:** Failed inbound pulls roll back `was_processed` and `claim_count` so legitimate retries are not blocked by `ReplayedMessage`; frozen-recipient deliveries park a recipient-bound `PendingClaim` (`settled = false`) that settles exactly once after unfreezing.

## Compatibility and Migration Notes

- **Contract ABI and storage:** No production contract code, storage key, or wire format changed. `HostileToken` and `HostileRail` compile strictly under `#[cfg(test)]` in `hyperion-router`, with deterministic specification helpers exported from `@hyperion/protocol`.
- **Deployment gating:** Stellar Testnet outbound ITS/CCTP remains the active deployment; EVM and additional rail paths remain explicitly gated until independently validated.

## Validation Commands

```bash
cargo test --manifest-path soroban/Cargo.toml -p hyperion-router hostile_fixtures --locked
cd packages/protocol && npx vitest run test/hostile-fixtures.test.ts
```
