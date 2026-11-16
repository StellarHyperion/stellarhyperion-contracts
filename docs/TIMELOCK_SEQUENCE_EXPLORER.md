# Timelock Boundary and Authority Sequence Explorer

## Overview

Privileged configuration changes on `HyperionRouter` wait out a mandatory timelock (`MIN_TIMELOCK_DELAY = 3,600` seconds up to `MAX_TIMELOCK_DELAY = 2,592,000` seconds) and expire if left unexecuted past `GRACE_PERIOD` (`604,800` seconds). Emergency contractions (`pause`, `disable_route`, `disable_token`, `lower_token_flow_limit`, and `cancel_action`) take effect immediately when invoked by either `admin` or `guardian`.

This explorer generates and verifies deterministic multi-actor administration sequences across both `@hyperion/protocol` (`packages/protocol/src/timelockExplorer.ts`) and the Soroban router test suite (`soroban/crates/hyperion-router/src/test/timelock_explorer.rs`):

1. **Exact boundary verification**: Exercises `eta - 1` (`TimelockNotReady`), exact `eta` (succeeds), exact `expires_at` (succeeds), `expires_at + 1` (`TimelockExpired`), duplicate execution races (`TimelockNotQueued`), and dynamic `SetTimelockDelay` changes that must never retroactively shorten an already-queued action's `eta`.
2. **Authority nomination and handover races**: Verifies that once `SetAdmin` or `SetGuardian` executes, superseded actors lose every administrative and emergency power immediately (`Unauthorized`), including the ability to execute actions they queued prior to handover.
3. **Rich failure traces**: Every violation record captures chain time (`timestamp` and `ledger_sequence`), active role bindings, queued maturity window metadata, and the complete serialized `AdminAction` payload (canonical JSON in TypeScript and both structured debug + full XDR hex in Soroban).

## Compatibility and Migration Implications

- Additive verification modules and test suites only; no Soroban contract entrypoints, XDR storage keys, or EVM contract ABIs are modified.
- Preserves exact integer amounts, authenticated rail dispatch, replay protection, and recipient-bound parked claims.
- Stellar Testnet outbound ITS/CCTP operations remain unchanged, and EVM/non-active rail surfaces remain explicitly gated behind existing deployment checks.

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
