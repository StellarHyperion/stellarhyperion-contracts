# CCTP approval diagnostics

Both Soroban burn entrypoints (`dispatch` and paid `dispatch_from`) and EVM `dispatch` approve exactly the requested token amount immediately before calling Circle. Soroban approvals expire in the current ledger. Each entrypoint reads back the opened allowance, clears it after the burn, and requires the observed residual allowance to be zero. A failed read, failed approval, inconsistent opened amount or nonzero cleanup aborts the transaction. Inconsistent allowance amounts use the existing `InvalidAmount` error. There is no standing approval between successful burns.

The read-only `audit_allowance(token)` and EVM `auditAllowance()` / `auditAllowance(token)` inspect the adapter's allowance to its configured messenger. They require no administrator authorization and never approve, revoke, move tokens, change fee policy or reconcile state. The version-1 result reports expected allowance zero and these stable findings:

| Finding            | Value | Interpretation                                                                      |
| ------------------ | ----- | ----------------------------------------------------------------------------------- |
| Clean              | 0     | A readable allowance equals zero.                                                   |
| UnexpectedResidual | 1     | A readable allowance is positive.                                                   |
| Unavailable        | 2     | The read failed, its return was malformed, or the token reported an invalid amount. |

For `Unavailable`, allowance zero is a placeholder and `is_clean` / `isClean` is false. Consumers must inspect the finding before treating the numeric value as a measurement. EVM accepts only exactly 32 return bytes and preserves the entire uint256 value. Soroban preserves nonnegative i128 values. The protocol package's `auditCctpAllowance` accepts a bigint reading or null for a failed read, with the same findings and uint256 bounds. Negative values are unavailable, never residual or clean.

`ApprovalAudited` records the preexisting and final allowance for successful burns, including paid forwarding. Its final allowance is always zero and cleanliness is true; failed transactions do not produce committed lifecycle events. A residual audit remains observational. Operators investigate the token/provider and choose a separately authorized recovery action; the auditor never clears a finding itself.

Existing dispatch signatures, burn parameters, storage keys, and error numbers remain unchanged. Finality is lane-specific on Soroban: missing policy entries default to finalized threshold 2000, and fast threshold 1000 requires explicit lane configuration and a nonzero fee budget. The legacy global fee setter rejects weaker thresholds. The EVM development adapter remains finalized-only and reports its policy through `quoteFinalityPolicy` and `FinalityPolicyUsed`. See [CCTP finality policy](./CCTP_FINALITY_POLICY.md) for compatibility and migration details.

These checks do not authorize deployment or replace Circle's attestation verification. Activation and upgrade rehearsal remain subject to the existing testnet gates. The hostile fixtures test messenger failure after token movement and record mutation, inconsistent approvals, failed/nonzero cleanup, unchanged source balances and router fees/flow/nonce, and retry after the fault is removed. They do not claim production Circle integration.

## Inbound compatibility and migration

Inbound CCTP is a separately commissioned boundary, not activation of the active Stellar Testnet outbound route. A receiving adapter must verify CCTP wire version, destination domain, source-domain lane, remote peer sender, TokenMessenger recipient, burn version, burn token, mint recipient, exact minted amount and hook shape before router delivery. The full 32-byte CCTP nonce remains the replay identity; a u64 display nonce is informational only.

The EVM receiver expects an explicit message-transmitter and a configured source lane. Remote sender words are set independently of outbound lane configuration and must be rotated through owner-controlled configuration plus independent validation. Existing CCTP lane storage and outbound dispatch signatures are not proof that an inbound peer is valid. Failed recipient payouts are not returned as attestation failures: the router parks a fixed-recipient claim and the attested delivery remains replay-protected.

Provider upgrades must preserve the CCTP v2 offsets and exact uint256/int128 amount conversion documented in `hyperion-core::cctp`. Any provider change that alters those offsets, recipient semantics, replay nonce identity or transmitter interface requires a wire-format fixture, parity test and deployment migration. It must not silently reuse the active outbound lane as authorization for inbound receipt.
