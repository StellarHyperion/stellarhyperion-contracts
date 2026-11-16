# Token Conservation Invariant Harness

## Overview

The token conservation invariant harness tracks multi-account balance sheets (`sender`, `treasury`,
`adapter`, `router`, `recipient`, and `railSink`) across successful and failed paid transfers,
inbound deliveries, parked claims, claim settlements, and adapter dust sweeps on both local Axelar
ITS (`axelar-its`) and Circle CCTP (`cctp`) paths.

## Harness Surfaces

- **Protocol SDK auditor (`packages/protocol/src/conservation.ts`):**
  - `decomposePaidOutboundAccounting()` separates protocol fee, net principal routed to the rail,
    7-to-6 decimal `sourceDustRetainedBySender`, optional Circle `railSubUnitDustInAdapter`,
    separate ITS native relay currency (`separateRelayGasDebited`), and in-band CCTP forwarding fee
    budgets (`inBandPrincipalRelayBudget`).
  - `auditPaidTransferConservation()` verifies per-account and closed-system aggregate deltas
    across both `principal` and `relay-currency` balance sheets, emitting structured
    `ConservationViolation` diagnostics (`operation`, `ledgerLeg`, `account`, `expectedDelta`,
    `actualDelta`, `balanceDeltaDiscrepancy`).
- **Soroban CCTP local harness (`soroban/crates/hyperion-adapter-cctp/src/test/conservation.rs`):**
  - Exercises `HyperionRouter::bridge_out_with_gas`, `CctpAdapter::dispatch_from`,
    `CctpAdapter::sweep`, `CctpAdapter::receive`, and `HyperionRouter::try_settle_claim` against
    real Stellar Asset Contracts (`token_id` USDC + dedicated `gas_token_id` XLM stand-in).
- **Soroban Axelar ITS local harness (`soroban/crates/hyperion-adapter-axelar/src/test/conservation.rs`):**
  - Exercises both `MintBurn` (`token_id`) and `LockUnlock` (`lock_asset` + `MockTokenManager`)
    alongside a dedicated third Stellar Asset Contract (`gas_sac`) registered as the ITS native gas
    token, plus inbound GMP note deliveries, parked claims, and callback unwinds.

## Accounting Invariants

1. **Source dust vs. principal debit:**
   - Given `split = applyFee(requestedAmount, feeBps)` and
     `net = floorToRepresentable(split.net, sourceDecimals, destinationDecimals)`, the router pulls
     only `gross = split.fee + net` from `sender`.
   - `sourceDust = requestedAmount - gross` remains untouched in `sender`'s wallet rather than
     accumulating in `router` or `adapter`.
2. **Relay currency separation:**
   - On `axelar-its`, relay gas is debited in a separate native asset (`senderGasDelta = -gasAmount`,
     `itsGasSinkDelta = +gasAmount`) with zero gas residual in `bare_id` or `router_id`.
   - On `cctp`, forwarding fees are budgeted in-band from burned USDC (`max_fee = gasAmount < net`),
     requiring zero movement in any separate native gas asset.
3. **Rollback atomicity:**
   - Failed paid dispatches (insufficient relay gas after burn/lock, untrusted destination chain,
     slippage exceeded, paused router, invalid gas budget, restricted `destination_caller`), failed
     inbound callbacks, and failed `settle_claim` calls leave `0` net delta across every account on
     both principal and relay-currency balance sheets.

## Compatibility and Migration Implications

- **Zero wire/storage/ABI mutations:** No deployed Soroban contract storage layouts, entrypoints,
  error codes, or Solidity contracts were modified.
- **Deployment gating preserved:** Active Stellar Testnet outbound ITS/CCTP posture is unchanged;
  EVM and unvalidated rails remain explicitly gated.
