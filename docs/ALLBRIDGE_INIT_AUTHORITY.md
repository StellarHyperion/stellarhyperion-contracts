# Allbridge Initialization Authorization and Deployment Authority Verification

## Overview

Allbridge Core on Soroban is a development-only adapter with a configured-validator trust model and
native gas float. The active Hyperion deployment remains Stellar Testnet outbound ITS and CCTP; EVM
and pooled-rail capabilities stay gated until independently validated.

Previously, `AllbridgeAdapter::initialize(admin, router, bridge, native)` wrote `Config` without
calling `admin.require_auth()` or checking contract role separation. An unauthenticated caller
watching a two-step deployment could submit `initialize(intended_admin, attacker_router, ...)`
before the deployer's initialization transaction landed, framing `intended_admin` while binding the
immutable `router`, `bridge`, or `native` slots to attacker-controlled contracts.

## Hardened Initialization Transition

1. **One-Time Guard First (`AlreadyInitialized`):**
   - `initialize` checks `storage::is_initialized(&env)` before any other work so repeated calls
     return `HyperionError::AlreadyInitialized` without replacing the live `admin`, `router`,
     `bridge`, or `native` configuration.
2. **Administrator Signature Requirement (`admin.require_auth()`):**
   - `initialize` requires `admin.require_auth()`, preventing any unauthenticated caller or third
     party from binding `admin` to arbitrary contract wiring.
3. **Contract Role Validation:**
   - `router`, `bridge`, and `native` must decode as Soroban contract addresses (`C...`) via
     `codec::contract_key`.
   - Self-wiring (`== current_contract_address()`) and duplicate role assignments (`router == bridge`,
     `router == native`, `bridge == native`) fail with `HyperionError::UnexpectedRailContract`.
4. **Deployment-Time Authority Verification (`verify_admin_authority` / `confirm_admin_authority`):**
   - `verify_admin_authority(expected_admin, expected_router, expected_bridge, expected_native)`
     returns `InitAuthorityRecord` only when the adapter is initialized (`NotInitialized`),
     `cfg.admin == expected_admin` (`Unauthorized`), and all three contract addresses match the
     deployment manifest (`UnexpectedRailContract`).
   - `confirm_admin_authority(...)` additionally enforces `expected_admin.require_auth()` during
     deployment rehearsal before the router ever queues `AdminAction::SetAdapter`.

## Compatibility and Migration Notes

- Deployment scripts invoking `AllbridgeAdapter::initialize` must include the `admin` account or
  multisig authorization on the initialization transaction, and run `verify_admin_authority` /
  `confirm_admin_authority` prior to queueing `SetAdapter` on `HyperionRouter`.
- Existing initialized instances preserve `get_config()` compatibility; `verify_admin_authority`
  falls back cleanly with zeroed ledger/timestamp metadata if queried on a pre-upgrade instance.
