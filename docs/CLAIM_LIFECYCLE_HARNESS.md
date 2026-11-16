# Claim Lifecycle Crash-and-Upgrade Harness

## Overview

Inbound deliveries on Stellar cannot safely revert when a recipient account lacks a trustline or temporarily rejects token transfers, because the source-chain burn or lock has already completed. `HyperionRouter::bridge_in` escrows those funds inside the router and records a recipient-bound `PendingClaim`.

This harness exercises the full parked-claim lifecycle across controlled operational interruptions, process crashes, timelocked contract code upgrades, Soroban archival TTL restoration, and final permissionless settlement:

1. **Soroban stateful harness** (`soroban/crates/hyperion-router/src/test/claim_lifecycle_harness.rs`):
   - Deploys `HyperionRouter`, `FailableToken`, and `MockRail` via explicit Wasm executable hashes so ledger state survives snapshot serialization (`Env::to_snapshot` / `Env::from_snapshot`).
   - Exercises multi-claim parking, failed settlement (`RecipientNotReady`), guardian emergency actions (`pause`, `disable_route`, `disable_token`, `lower_token_flow_limit`), replay rejection (`ReplayedMessage`), abrupt host crash and snapshot reload, guardian cancellation of a rogue upgrade, live timelocked upgrade to `UpgradedHyperionRouterV2` (and subsequent upgrade to `V3`), proactive `keep_alive` TTL extension, persistent entry expiry and Expired State Store (ESS) restoration, partial settlement while paused, and repeated-settlement rejection (`ClaimAlreadySettled`).
2. **Protocol transition verifier and rehearsal model** (`packages/protocol/src/claimLifecycle.ts`, `packages/protocol/test/claim-lifecycle.test.ts`):
   - Captures structured `before` and `after` public state snapshots for every transition (`PublicRouterLifecycleSnapshot`) and audits strict continuity, token supply conservation, router solvency (`routerBalance >= outstandingLiability`), immutable recipient binding, replay-guard retention, and zero double-payment.

## Verified Invariants

| Invariant | Enforcement |
| --- | --- |
| Liability survival | Unsettled `PendingClaim` records and escrowed router balances remain equal across `pause`, `disable_route`, `disable_token`, treasury/role rotation, host snapshot reloads, timelocked `Upgrade`, and TTL restoration. |
| Single settlement | Once `settled == true`, repeated calls to `settle_claim` by any caller before or after upgrades return `ClaimAlreadySettled` with zero balance delta. |
| Public state continuity | Every transition records complete `before` and `after` snapshots where `transition[i].before == transition[i - 1].after`. |

## Compatibility and Migration Implications

- No Soroban contract entrypoints, XDR storage layouts, or EVM contract ABIs are modified.
- Stellar Testnet outbound ITS/CCTP operations remain unchanged, and EVM/non-active rail surfaces stay explicitly gated behind existing deployment checks.
- Operators upgrading `HyperionRouter` via `AdminAction::Upgrade` must preserve `DataKey::Claim(u64)`, `DataKey::ClaimSeq`, and `DataKey::Processed(RouteKind, BytesN<32>)` variants, and keeper jobs must continue running `keep_alive` ahead of `BUMP_THRESHOLD` (`17,280` ledgers) or restore expired persistent entries prior to `settle_claim`.

## Validation Commands

```bash
cd packages/protocol
npm run fmt:check
npm run lint
npm run typecheck
npx vitest run --maxWorkers=2
npm run build

cd ../../soroban
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```
