# Allbridge Native Gas-Float Solvency View

Allbridge Core on Soroban charges native relay fees up front during `swap_and_bridge`. Because this
adapter remains development-only outside the active Stellar Testnet outbound Axelar ITS and Circle
CCTP deployment, operators and route planners need a bounded solvency view before submitting
transfers.

## Accounting Model

- `gas_solvency(chain: Option<String>) -> Result<GasFloatSolvency, HyperionError>` reports:
  - `current_float`: live SEP-41 balance of `cfg.native` held by the adapter (`i128`).
  - `committed_spending`: cumulative native gas spent across completed outbound provider dispatches
    (`u128`), incremented only after `bridge.swap_and_bridge` succeeds.
  - `min_operational_reserve`: admin-configured native gas floor (`set_min_gas_reserve`, default
    `0`) bounded to `<= i128::MAX`.
  - `next_relay_cost`: live sum of `bridge.get_transaction_cost` and
    `messenger.get_transaction_cost` when `chain` is supplied (`0` when inspecting reserve-only
    solvency).
  - `required_float`: `min_operational_reserve + next_relay_cost` computed with checked arithmetic.
  - `headroom` and `solvent`: signed surplus/deficit (`current_float - required_float`) and
    pre-dispatch eligibility flag.

## Safety Guarantees

1. **Pre-dispatch reporting and enforcement:** `gas_solvency(Some(chain))` surfaces deficits
   before signing, and `dispatch` enforces `current_float >= min_operational_reserve + cost`
   before authorizing pool or token transfers.
2. **Liability separation:** Bridged SEP-41 token balances, sweeps, and inbound claims never enter
   native gas-float solvency calculations.
3. **Rollback safety:** Failed provider `swap_and_bridge` calls roll back atomically and never
   increment `committed_spending` or deduct from `current_float`.

## Compatibility and Migration

- Adds `DataKey::MinGasReserve` and `DataKey::CommittedGasSpent` in instance storage (both
  defaulting to `0`) plus `set_min_gas_reserve`, `min_gas_reserve`, `committed_gas_spending`, and
  `gas_solvency` on `AllbridgeAdapter`.
- Existing callers with default `min_operational_reserve = 0` observe identical `dispatch`,
  `fund_gas`, `withdraw_gas`, and `quote_gas` behavior.
