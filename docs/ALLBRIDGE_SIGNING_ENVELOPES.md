# Allbridge Domain-Separated Inbound Signing Envelopes

## Overview

Allbridge Core on Soroban is a development-only adapter gated behind a configured validator trust
model and native gas float. The active Hyperion deployment remains Stellar Testnet outbound ITS and
CCTP; EVM and pooled-rail inbound flows stay gated until independently validated.

Previously, `AllbridgeAdapter::bridge_in` verified an Ed25519 validator signature directly over
Allbridge's raw `rail::hash_message` digest. Because that digest omits the Stellar `network_id`,
the target `AllbridgeAdapter` contract address, the bound `HyperionRouter`, the `RouteKind`, the
configured remote `receive_token` mapping, and the recipient's `AddressKind` (`Account` vs
`Contract` for a 32-byte payload), a raw v1 signature could be replayed across networks, replayed
against a second adapter sharing the same validator key, or reinterpreted across classic account
and contract recipients sharing a 32-byte key.

## V2 Signing Envelope Specification

`rail::hash_inbound_envelope_v2` computes `keccak256` over the deterministic concatenation of:

1. `INBOUND_ENVELOPE_DOMAIN_V2` (`"HYPERION_ALLBRIDGE_INBOUND_V2"`, 29 ASCII bytes)
2. `INBOUND_ENVELOPE_VERSION_V2` (`2u8`, 1 byte)
3. `network_id` (`BytesN<32>` from `env.ledger().network_id()`)
4. `adapter_key` (`[u8; 32]` contract key of `env.current_contract_address()`)
5. `router_key` (`[u8; 32]` contract key of `cfg.router`)
6. `route` (`RouteKind::Allbridge as u32`, 4 big-endian bytes)
7. `token_key` (`[u8; 32]` contract key of the local SEP-41 payout asset)
8. `remote_receive_token` (`BytesN<32>` from the lane's configured `AssetLink`)
9. `amount` (`u128`, 16 big-endian bytes, exact integer payout amount)
10. `recipient_kind` (`AddressKind::tag()`, 1 byte distinguishing `Account` vs `Contract`)
11. `recipient_key` (`[u8; 32]` recipient payload)
12. `source_chain_id` (`u32`, 4 big-endian bytes)
13. `destination_chain_id` (`STELLAR_CHAIN_ID = 7u32`, 4 big-endian bytes)
14. `nonce` (`U256`, 32 big-endian bytes)
15. `message_id` (`BytesN<32>`, canonical `rail::hash_message` digest)

Off-chain signers and diagnostic tools can read the exact expected digest via the read-only
`inbound_signing_digest(token, amount, recipient, source_chain_id, nonce)` view without mutating
state.

## Compatibility and Constrained V1 Migration

- **Default rejection of legacy v1 signatures:** `bridge_in` (and its `receive` alias) exclusively
  verifies `envelope_v2`. Legacy v1 acceptance is disabled by default (`enabled = false`,
  `max_ledger = 0`, `remaining_deliveries = 0`).
- **Explicitly bounded legacy drain window:** During a controlled upgrade with pre-signed in-flight
  development attestations, the administrator may call
  `configure_legacy_v1_window(max_ledger, max_deliveries)` subject to hard ceilings:
  - `now < max_ledger <= now + MAX_LEGACY_MIGRATION_LEDGERS` (`17,280` ledgers, ~24 hours)
  - `1 <= max_deliveries <= MAX_LEGACY_DELIVERIES` (`64` deliveries)
  In-flight v1 signatures can then be submitted only through `bridge_in_legacy_v1`, which decrements
  `remaining_deliveries` on each delivery, auto-disables when quota hits zero, rejects calls past
  `max_ledger` with `HyperionError::UnsupportedMessageVersion`, and can be closed immediately via
  `disable_legacy_v1_window()`.
- **Dual-digest replay protection:** Both `bridge_in` and `bridge_in_legacy_v1` mark both
  `message_id` and `envelope_v2` in `DataKey::Processed`, preventing cross-version v1/v2 replay
  while keeping `is_processed(message_id)`, `Origin.message_id`, and `events::Received` compatible
  with existing router claims and indexers.
