# Sender-Bound Gas Top-Up Intents in the EVM Axelar Adapter

## Overview

When an outbound Interchain Token Service (ITS) transfer stalls in Axelar's queue due to destination gas movement, callers can fund additional execution gas through `IAxelarGasService.addNativeGas`. In `evm/src/adapters/AxelarItsAdapter.sol`, `topUpGasWithIntent` extends the adapter's gas top-up surface with explicit sender-bound intent metadata, immutable transfer verification, native spending ceilings, and domain-separated replay protection.

## Immutable Outbound Binding

During `dispatch(token, amount, destination, nonce)`, `AxelarItsAdapter` records an `OutboundDispatchBinding` keyed by `dispatchBindingKey(destination.chain, nonce)`:

- `token` and `tokenId`
- `amount` (exact original integer transfer amount)
- `destinationChainHash` and `axelarChainHash`
- `recipientStrkeyHash` and `noteHash`

`topUpGasWithIntent` only forwards native currency to `GAS_SERVICE.addNativeGas` after verifying that every field of `GasTopUpIntent` matches the recorded `OutboundDispatchBinding`. Top-ups never touch ERC-20 balances, ITS token parameters, or the recorded recipient/amount bindings:

- Altered `recipientStrkey` or `axelarChain` reverts `InvalidDestination`.
- Altered `token` or `tokenId` reverts `TokenNotMapped`.
- Altered `originalAmount` reverts `InvalidAmount`.
- Unrecorded `transferNonce`, zero `txHash`, or inconsistent `(txHash, logIndex)` source-event bindings revert `MalformedMessage`.
- Unknown or disabled peer chains revert `UnknownChain` or `RailNotConfigured`.

## Native Spending Caps and Replay Semantics

1. **Sender binding**: `msg.sender` must equal `intent.sender` (`Unauthorized` otherwise), and both `intent.sender` and `intent.refundAddress` must be non-zero (`ZeroAddress`).
2. **Expiry**: `block.timestamp > intent.deadline` reverts `TimelockExpired(intent.deadline)`.
3. **Three-tier native gas caps**:
   - Intent cap: `msg.value <= intent.maxNativeGas` (`InvalidLimit`).
   - Per-call adapter cap: `msg.value <= maxGasTopUpPerCall` (defaults to `DEFAULT_MAX_GAS_TOP_UP_PER_CALL = 1 ether`; also enforced on `topUpGas`).
   - Cumulative per-transfer cap: `cumulativeGasTopUpOf[dispatchKey] + msg.value <= maxTotalGasTopUpPerTransfer` (defaults to `DEFAULT_MAX_TOTAL_GAS_TOP_UP = 5 ether`).
   - Adapter owner can adjust caps via `setGasTopUpCaps(maxPerCall, maxPerTransfer)` (`maxPerCall > 0 && maxPerTransfer >= maxPerCall`).
4. **Domain-separated replay protection**: `computeTopUpIntentId(intent)` hashes `(block.chainid, address(this), intent...)`. Executed intent IDs are marked in `topUpIntentUsed[intentId]` before the external `GAS_SERVICE.addNativeGas` call; any duplicate submission reverts `ReplayedMessage`. Additional top-ups for the same transfer use a distinct `intentNonce` while keeping the bound `(txHash, logIndex)` pair and staying within `maxTotalGasTopUpPerTransfer`.

## Compatibility and Gating Implications

- **Backwards compatibility**: Existing 3-argument `topUpGas(txHash, logIndex, refundAddress)` remains available for permissionless top-ups within `maxGasTopUpPerCall` and non-zero `txHash`. `@hyperion/protocol` ABI exports (`src/abi/axelarItsAdapter.ts` and `src/abi/errors.ts`) are regenerated via `npm run gen`.
- **Deployment gating**: Active deployment remains Stellar Testnet outbound ITS/CCTP; the EVM `AxelarItsAdapter` remains a gated development adapter until independently validated.
