# ABI Semantic Compatibility Gate

## Overview

`@hyperion/protocol` exports generated contract ABIs (`HyperionRouter`, `IHyperionRouter`, `CctpAdapter`, `AxelarItsAdapter`, `IRailAdapter` and `IERC20`) consumed by the web app, indexer, keeper and deployment verification scripts. Raw four-byte function selectors and event `topic0` hashes only commit to primitive Solidity types, so two fields of the same primitive type (for example `recipient` and `token` in `PendingClaim`, or `grossAmount`, `fee` and `netAmount` in `BridgeOut`) can swap positions without changing selectors while corrupting payout accounting.

`packages/protocol/src/abiCompatibility.ts` and `packages/protocol/scripts/check-abi-compat.mjs` enforce semantic ABI compatibility and compiled-artifact provenance before changes ship.

## Compatibility Policy

1. **Payout-relevant surfaces (`payoutRelevant: true`):**
   - Functions: `bridgeOut`, `bridgeIn`, `settleClaim`, `pendingClaim`, `quote`, `quoteAll`, `dispatch`, `receiveMessage`, `execute`, `executeWithToken`, `topUpGas`.
   - Events: `BridgeOut`, `BridgeIn`, `ClaimParked`, `ClaimSettled`, `Dispatched`, `InboundDelivered`, `MessageReceived`, `GasToppedUp`.
   - Tuple structs: `OutboundRequest`, `Destination`, `Origin`, `PendingClaim`, `RouteQuote`, `TokenConfig`, `AdminAction`, `QueuedAction`.
2. **Breaking changes (immediate gate failure):**
   - Removing any function, event, error, `receive` or `fallback` entry.
   - Removing, adding in-place or reordering tuple components (`tuple-field-removed`, `tuple-field-added`, `tuple-fields-reordered`, `payout-fields-reordered`).
   - Renaming or swapping same-type parameters on payout-relevant functions, structs or events (`payout-field-renamed`, `payout-fields-reordered`).
   - Flipping `indexed` or `anonymous` on any event parameter (`event-indexed-changed`, `event-anonymous-changed`).
   - Incompatible `stateMutability` transitions such as `view -> nonpayable` or `payable -> nonpayable` (`state-mutability-incompatible`).
3. **Additive changes (consumer migration assessment required):**
   - New functions, new overloads, new events and new custom errors are classified as `additive`.
   - Under `requireMigrationAssessmentForAdditive: true` (the default policy), every additive `changeId` must have a `ConsumerMigrationAssessment` recording affected `consumerSurfaces` (`sdk`, `indexer`, `keeper`, `relayer`, `ui`, `contracts`), `backwardCompatible` status, `summary` and explicit `migrationSteps`. Undocumented additive changes fail with `unassessed-additive-change`.
4. **Compiled contract provenance:**
   - Every module in `packages/protocol/src/abi/` must match the canonicalised ABI emitted by Foundry (`evm/out/<File>/<Contract>.json`) under `Solc 0.8.28`, and concrete contracts (`HyperionRouter`, `CctpAdapter`, `AxelarItsAdapter`) must carry non-empty compiled bytecode.

## Operational Scope and Deployment Posture

The active deployment remains Stellar Testnet outbound ITS/CCTP. EVM router and rail adapters remain explicitly gated behind this compatibility check and independent deployment rehearsal (`script/anvil-e2e.sh`) until validated. Exact integer amounts, authenticated rail dispatch, full-width replay protection and recipient-bound claims remain unchanged.

## Commands

```bash
cd packages/protocol
npm run abi:gate
npm run check
```

To evaluate a proposed ABI bundle with documented consumer migration assessments:

```bash
node packages/protocol/scripts/check-abi-compat.mjs \
  --baseline baseline-abi.json \
  --proposed proposed-abi.json \
  --assessments migration-assessments.json \
  --json
```
