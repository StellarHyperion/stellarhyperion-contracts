# Stateful Cross-Chain Router Reference Model

This document specifies the independent stateful reference model for `HyperionRouter` across Soroban and EVM, along with its conservation and fixed-recipient liability invariants, explicit chain-specific time semantics, and deterministic failing-sequence shrinker.

## 1. Scope and Surfaces

| Surface | Path | Role |
| --- | --- | --- |
| Protocol SDK model & shrinker | `packages/protocol/src/routerReferenceModel.ts` | Pure `bigint` dual-profile (`"soroban"` / `"evm"`) reference state machine, deterministic sequence generator, invariant checker, and `ddmin` minimal-trace shrinker |
| Protocol SDK test suite | `packages/protocol/test/router-reference-model.test.ts` | Multi-seed sequence verification (`25` seeds x `45` steps per chain), explicit clock decoupling tests, and 1-minimal counterexample shrinking against injected router faults |
| Soroban differential suite | `soroban/crates/hyperion-router/src/test/reference_model.rs` | Step-by-step comparison of `SorobanReferenceModel` against the live Soroban `HyperionRouter` contract (`16` seeds x `40` steps), dual-clock independence proof, and Rust trace shrinker |
| EVM differential suite | `evm/test/unit/RouterReferenceModel.t.sol` | Step-by-step comparison of `EvmModelState` against the live Solidity `HyperionRouter.sol` contract (`16` seeds x `36` steps), `block.timestamp` vs `block.number` proof, and Solidity trace shrinker |

## 2. Modeled Operations and Invariants

Every generated sequence interleaves:

- **Outbound dispatch (`BridgeOut`, `BridgeOutWithGas`):** exact integer basis-point fee calculation (`fee = (amount * feeBps) / 10_000`), destination decimal flooring (`floorToRepresentable`), sender retention of unrepresentable dust (`gross = fee + net`), slippage floor verification, outbound `FlowWindow` consumption on `net`, treasury fee routing, adapter funding, and sequential `outboundNonce` assignment.
- **Emergency narrowing and pause (`Pause`, `Unpause`, `PauseRoute`, `UnpauseRoute`, `DisableRoute`, `DisableToken`, `LowerTokenFlowLimit`):** immediate safety narrowing by `admin` or `guardian` without blocking in-flight inbound arrivals or claim settlements; `unpause` restricted strictly to `admin`.
- **Timelocked administration (`QueueAction`, `ExecuteAction`, `CancelAction`):** `admin`-only queueing, `[eta, eta + GRACE_PERIOD]` execution window, and `admin` or `guardian` cancellation.
- **Authenticated inbound delivery & parked claims (`BridgeIn`, `SettleClaim`):** strict `railReceiver[route]` caller equality, `(route, messageId)` replay table, atomic token pull from `railReceiver`, immediate recipient payout when deliverable, and immutable `PendingClaim` escrow creation when the recipient cannot receive (`AccountFrozen` / missing trustline).

### Checked State Invariants (After Every Step)

1. **Conserved token supply:**
   `sum(actorBalances) + treasuryBalance + routerEscrow + sum(adapterBalances) + sum(railReceiverPools) == initialTotalSupply`.
   Sub-unit dust stripped during `7 -> 6` decimal conversion never enters `router`, `treasury`, or `adapter`; it stays in `sender`'s balance.
2. **Exact router escrow backing:**
   `balances.router == sum(claim.amount for claim in claims if !claim.settled)`.
   The router holds zero residual tokens outside unsettled parked claims.
3. **Immutable fixed-recipient liabilities:**
   Every `PendingClaim` preserves the exact `(recipient, amount, route, sourceChain, sourceNonce, createdAt)` recorded at `BridgeIn`. Calling `SettleClaim` from any third-party account (`stranger`, `guardian`, keeper), even while `paused == true`, debits `router` by `claim.amount` and credits `claim.recipient` by `claim.amount` (`balances.stranger == 0`).
4. **Cumulative fee identity:**
   Total treasury balances equal `cumulativeFeesCollected` across treasury rotations.
5. **Atomic rollback on failure:**
   Any rejected or trapped operation leaves balances, nonces, flow windows, replay markers, and claims identical to pre-step state.

## 3. Chain-Specific Time and Governance Semantics

Soroban and EVM intentionally differ on how flow-limit windows advance because EVM chains with variable or on-demand block production cannot measure rate-limit windows reliably in block counts:

| Mechanism | Soroban (`chain: "soroban"`) | EVM (`chain: "evm"`) |
| --- | --- | --- |
| Outbound `FlowWindow` clock | `ledgerSequence` (`env.ledger().sequence()`, default `720` ledgers) | `timestampSeconds` (`block.timestamp`, default `3,600` seconds) |
| Timelock `eta` / `expiresAt` clock | `timestampSeconds` (`env.ledger().timestamp()`) | `timestampSeconds` (`block.timestamp`) |
| `PendingClaim.createdAt` | `timestampSeconds` | `timestampSeconds` |
| Effect of `AdvanceTime(dt)` alone | Matures/expires timelocks; **zero** `FlowWindow` decay | Matures/expires timelocks **and** decays `FlowWindow` |
| Effect of `AdvanceLedgers(dn)` / `AdvanceBlocks(dn)` alone | Decays `FlowWindow`; **zero** timelock progress | **Zero** `FlowWindow` decay and **zero** timelock progress |
| Per-route emergency stop | `disable_route` (`RouteDisabled`; re-enabled via timelock `EnableRoute`) | `pauseRoute` / `unpauseRoute` (`RouteIsPaused`; separate from `routeEnabled`) |
| Executed timelock record | Cleared from storage (`TimelockNotQueued` on repeat execute) | Marked `executed = true` (`TimelockAlreadyExecuted` on repeat execute) and re-validated at execution time |
| Destination muxed check | Inbound `Cctp` and `Allbridge` reject `MuxedAccount` (`MuxedNotSupported`) | Outbound `Allbridge` rejects `M...` strkeys (`MuxedNotSupported`); `Cctp` V2 carries hook payload |

## 4. Minimal Reproducible Trace Shrinking

When `checkSequence` detects an invariant failure or a model-vs-router divergence on a multi-step sequence, `shrinkFailingRouterSequence(config, operations, checkSequence)` deterministically produces a `MinimalRouterTrace` via three passes:

1. **Prefix truncation:** slices `operations[0 ..= failedStepIndex]`, discarding trailing operations after the first divergence.
2. **Delta-debugging (`ddmin`):** removes contiguous chunks of decreasing size (`N/2`, `N/4`, ..., `1`) whenever the reduced candidate still fails, re-truncating whenever failure shifts earlier.
3. **Adjacent clock coalescing:** merges consecutive `AdvanceTime`, `AdvanceLedgers`, or `AdvanceBlocks` steps when failure is preserved.

Example formatted output from a 38-step sequence reduced to a 4-step minimal trace:

```text
Minimal reproducible router trace [chain=soroban, shrunk 38 -> 4 steps]
Failure at step 3: non-recipient actor received funds: admin=0 guardian=0 stranger=1250000
  [0] SetAccountFrozen(recipient_b, frozen=true) -> ok() | ts=1700000000s, ledger=100000 | escrow=0 treasury=0 unsettled=0
  [1] BridgeIn(caller=rail_its, route=1, amount=1250000, recipient=recipient_b, kind=account, msg="diversion-target") -> ok(1) | ts=1700000000s, ledger=100000 | escrow=1250000 treasury=0 unsettled=1
  [2] SetAccountFrozen(recipient_b, frozen=false) -> ok() | ts=1700000000s, ledger=100000 | escrow=1250000 treasury=0 unsettled=1
  [3] SettleClaim(caller=stranger, claimId=1) -> ok() | ts=1700000000s, ledger=100000 | escrow=0 treasury=0 unsettled=0
```

## 5. Compatibility, Migration, and Operational Gating

- **No wire, ABI, or storage changes:** No deployed Soroban contract storage keys, XDR layouts, note payloads, or Solidity contract bytecode/ABIs (`evm/src/*.sol`, `packages/protocol/src/abi/*`) are modified. Existing indexers, keepers, and SDK consumers require no migration.
- **Active deployment boundary:** Stellar Testnet outbound Axelar ITS and Circle CCTP remain the sole active deployment surface. EVM router execution and non-active rail paths (`AxelarGmp`, `Allbridge`, inbound EVM settlement) are exercised against local deterministic test environments only and remain explicitly gated until independently validated.

## 6. Validation Commands

```bash
# Protocol SDK (formatting, lint, typecheck, reference model & parity suites, build)
cd packages/protocol
npm run fmt:check
npm run lint
npm run typecheck
npx vitest run
npm run build

# Soroban workspace (formatting, clippy, live router differential model suite)
cd ../../soroban
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked

# EVM Foundry suite (formatting, Solc 0.8.28 deny-warnings build, live router differential model suite)
cd ../evm
forge fmt --check
forge test --match-path test/unit/RouterReferenceModel.t.sol -vvv
```
