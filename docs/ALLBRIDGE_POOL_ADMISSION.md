# Allbridge Token-Pool Admission Validation

Allbridge Core remains a development-only adapter outside the active Stellar Testnet outbound
Axelar ITS and Circle CCTP deployment. Before a candidate lane can be considered eligible, both
administrative registration and runtime `dispatch` enforce explicit admission checks over the
local SEP-41 asset, live Allbridge pool contract identity, decimal precision, and remote token
acceptance.

## Validation Rules

1. **Local token and precision**
   - The local `token` must be a valid Soroban contract (`AddressKind::Contract`) distinct from the
     protected native gas-float asset (`ProtectedAsset`), router, Allbridge bridge, and adapter
     itself (`UnexpectedRailContract`).
   - `decimals()` is queried live from the SEP-41 token contract and must not exceed
     `hyperion_core::amount::MAX_DECIMALS` (`38`). When `admit_asset` or
     `validate_asset_admission` supplies `expected_decimals`, any mismatch fails with
     `HyperionError::InvalidDecimals`.

2. **Pool identity and pre-movement safety**
   - `bridge.try_get_pool_address` must resolve to a contract distinct from `token`, `bridge`,
     `router`, `native`, and the adapter (`UnexpectedRailContract`).
   - `admit_asset` pins `expected_pool` in `DataKey::Admission(token, allbridge_chain_id)`. On
     every `dispatch`, `validate_admission_invariants` runs before `authorize_as_current_contract`
     or `swap_and_bridge`, ensuring unpooled assets, rogue pool repointings, or delisted remote
     tokens fail before user assets or gas float move.

3. **Recipient capacity and non-overwriting revalidation**
   - `validate_asset_admission` and `bridge_in` reject `AddressKind::MuxedAccount` with
     `HyperionError::MuxedNotSupported` because Allbridge's fixed 32-byte recipient slot cannot
     carry a 64-bit muxed sub-account ID.
   - `revalidate_asset` verifies live rail invariants without mutating storage, and calling
     `link_asset` or `admit_asset` on an already mapped `(token, chain)` with a different
     `receive_token`, decimal count, or pinned pool fails with `HyperionError::AlreadyConfigured`.
     Replacing a live mapping requires an explicit `unlink_asset` call first.

## Compatibility and Migration

- Adds `DataKey::Admission(Address, u32)` in persistent storage plus `admit_asset`,
  `unlink_asset`, `get_admission`, `revalidate_asset`, and `validate_asset_admission` on
  `AllbridgeAdapter`.
- Existing `link_asset(token, chain, receive_token)` calls remain compatible for unmapped lanes and
  idempotent re-runs of identical mappings while blocking silent conflicting overwrites.
