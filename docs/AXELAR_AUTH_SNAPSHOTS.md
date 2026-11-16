# Axelar Paid-Dispatch Authorization-Tree Snapshots

## Overview

In Soroban paid ITS outbound transfers (`HyperionRouter::bridge_out_with_gas` ->
`AxelarAdapter::dispatch_from` -> `InterchainTokenService::interchain_transfer`), the sender signs a
single nested `SorobanAuthorizationEntry` tree that simultaneously authorizes:

1. Router protocol fee transfer (`token.transfer(sender, treasury, fee)`).
2. Adapter `dispatch_from` forwarding into `its.interchain_transfer`.
3. Token debit (`token.burn(sender, net_amount)` for `MintBurn` / `NativeInterchainToken` /
   `MintBurnFrom`, or `token.transfer(sender, token_manager, net_amount)` for `LockUnlock`).
4. Relayer gas payment (`gas_service.pay_gas` -> `native_token.transfer(sender, gas_service, gas_amount)`).

Because wallets often render nested sub-invocations compactly, an unexpected spender, swapped gas
recipient, inflated fee/gas/token amount, or injected sub-invocation must be caught before signing.

## Surface Added

- **On-Chain View (`AxelarAdapter::expected_paid_auth_plan`):** Read-only Soroban entrypoint
  returning `PaidDispatchAuthPlan` (`router`, `adapter`, `its`, `gas_service`, `token`, `token_id`,
  `token_manager_type`, `token_spender`, `native_gas_token`, `axelar_chain`, `destination_address`,
  `net_amount`, `gas_amount`) with zero signatures and zero state writes.
- **SDK Snapshot Builder & Inspector (`@hyperion/protocol`):**
  - `buildPaidDispatchAuthSnapshot(intent)` builds the canonical nested `AuthInvocationNode` tree
    offline without any private key or network RPC call.
  - `inspectPaidDispatchAuthTree(actualTree, expectedIntent)` compares a simulated authorization
    tree against the expected intent and flags `changed_spender`, `changed_fee_recipient`,
    `changed_fee_amount`, `changed_net_amount`, `changed_gas_recipient`, `changed_gas_token`,
    `changed_gas_amount`, `changed_destination`, `unexpected_payload_attachment`, and
    `unexpected_sub_invocation` before signing.
- **Offline CLI (`script/stellar/inspect-axelar-auth-snapshot.mjs`):** Read-only JSON fixture
  inspector exiting non-zero whenever `safeToSign` is `false`.

## Compatibility Note

`expected_paid_auth_plan` and the `@hyperion/protocol` snapshot helpers are additive and read-only.
Existing Stellar Testnet outbound ITS and CCTP wire formats and settlement paths are unchanged.
