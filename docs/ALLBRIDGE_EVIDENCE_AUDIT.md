# Allbridge Validator-Independent Evidence Auditing

Allbridge Core inbound delivery relies on a configured Ed25519 validator key rather than Circle
attestation quorums or Axelar gateway verifier sets. Before treating any development rehearsal or
candidate lane evidence as corroborated, operators must compare the signed inbound validator intent
against independent source-chain provider records and on-chain Hyperion router payout or
parked-claim records.

## Read-Only Audit Surfaces

1. **On-chain view (`AllbridgeAdapter::audit_inbound_evidence`)**
   - Compares `SignedInboundIntent`, optional `SourceProviderEvidence`, and `PayoutObservation`
     (`DirectPayout` or live `RouterAuditClient::get_claim` on `HyperionRouter`).
   - Read-only: never invokes `bridge_in`, never moves funds, never writes `Processed`, and never
     mutates validator keys.
   - Returns `EvidenceAuditStatus::UnresolvedTrustAssumption` (`verified = false`) whenever
     `source_evidence` is `None`.
   - Returns `AmountMismatch`, `RecipientMismatch`, or `MetadataMismatch` (`verified = false`) when
     source or payout records disagree with the signed intent.

2. **SDK & CLI auditor (`auditAllbridgeInboundEvidence` and `script/stellar/audit-allbridge-evidence.mjs`)**
   - Zero-runtime-dependency TypeScript comparison in `@hyperion/protocol` preserving exact
     `int128` amounts and full 256-bit `uint256` wire nonces.
   - Exits non-zero when `verified` is `false` (including `unresolved-trust-assumption`).

## Compatibility and Migration

- Adds the read-only `audit_inbound_evidence` view and audit structs on `AllbridgeAdapter` plus
  additive exports in `@hyperion/protocol` without altering existing storage keys or entrypoints.
