# Axelar Destination Capability Admission Records

## Overview

Axelar's Interchain Token Service (ITS) exposes two distinct cross-chain execution surfaces:

1. **Direct ITS Token Transfer (`RouteKind::AxelarIts`):** Transfers tokens directly to a 20-byte
   recipient address with `metadata = None`, optionally attaching sender-authorized native gas via
   `dispatch_from`.
2. **GMP Contract-Call Payload (`RouteKind::AxelarGmp`):** Addresses the transfer to a trusted
   20-byte Hyperion peer contract on the destination chain with an `OutboundNote` payload.

Previously, `AxelarAdapter` checked only chain trust (`is_trusted_chain`) and local `token_id`
registration without recording whether a `(chain, token_id)` pair actually supports direct ITS
transfers, GMP contract-call payloads, paid sender-authorized gas, or a consistent local token
manager type.

## Capability Admission Specification

- `admit_capability(chain, token, remote_manager_type, supports_direct_its, supports_gmp_payload, supports_paid_dispatch, max_transfer_amount)`
  validates against live ITS state before storing `DestinationCapability`:
  - `chain` is linked (`UnknownChain`) and `its.is_trusted_chain(&link.axelar_chain)` holds.
  - `token` maps to `token_id` and `its.registered_token_address(&token_id) == token`
    (`TokenNotMapped`).
  - `local_manager_type` is snapshotted from `its.token_manager_type(&token_id)` (and
    `deployed_token_manager` is verified when `LockUnlock`).
  - At least one of `supports_direct_its` or `supports_gmp_payload` must be enabled
    (`UnsupportedRoute`), `supports_paid_dispatch` requires `supports_direct_its`
    (`UnsupportedRoute`), and `supports_gmp_payload` requires a non-zero destination `peer`
    (`ZeroAddressKey`).
- `dispatch` and `dispatch_from` run `check_dispatch_capability` **before** authorizing any burn,
  token-manager lock transfer, or native gas debit:
  - Disabled records fail with `HyperionError::RouteDisabled`.
  - Unsupported route/paid modes fail with `HyperionError::UnsupportedRoute`.
  - Underlying chain or token-manager drift fails with `HyperionError::UnexpectedRailContract`.
  - Transfers above `max_transfer_amount` (when non-zero) fail with
    `HyperionError::ExceedsRouteLimit`.
- `validate_dispatch_capability(token, amount, destination_chain, paid)` exposes the exact same
  preflight check as a read-only view.

## Compatibility and Active Sepolia ITS Preservation

- `strict_capabilities_required` defaults to `false` on initialization and across contract upgrades
  so existing active Stellar Testnet -> Sepolia `AxelarIts` lanes continue operating without
  interruption.
- Capability records are keyed per `(chain, token_id)`: admitting, updating, or disabling records
  on development lanes (or enabling `set_strict_capabilities(true)` once Sepolia's ITS record is
  admitted) preserves active Sepolia `dispatch` and `dispatch_from` behavior.
