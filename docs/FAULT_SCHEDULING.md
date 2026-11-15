# Deterministic Provider Fault Scheduling

Hyperion provides a seed-driven provider fault scheduler across `@hyperion/protocol` and the Soroban router rehearsal suite so local testing can inject reproducible failures at selected outbound dispatch and inbound delivery stages.

## Seed Reproducibility and Cross-Harness Parity

- **PRNG algorithm:** 64-bit `SplitMix64` (`0x9e3779b97f4a7c15` gamma increment and Stafford Mix13 constants) shared bit-for-bit between `packages/protocol/src/faultScheduling.ts` and `soroban/crates/hyperion-router/src/test/fault_scheduler.rs`.
- **Saved seed replay:** Any failing run prints a canonical 16-hex-digit seed (`0x...`). Passing that seed back to `buildFaultSchedule` or `FaultSchedule::from_seed` reproduces the exact `(step, stage, injectFault, rollBps)` sequence.

## Injected Provider Stages and Atomic Invariants

1. `outbound-dispatch`: Provider `dispatch` reverts after router fee and net token transfers. Soroban rolls back sender, treasury, router, and adapter balances, `last_out_nonce`, and sliding `flow_available` headroom.
2. `outbound-paid-asset-pull`: Paid `dispatch_from` reverts after router fee transfer and adapter asset pull, before relay gas pull. All token movements, nonces, and flow window charges roll back atomically.
3. `outbound-paid-relay-gas`: Paid `dispatch_from` reverts after pulling both the bridged asset and separate relay gas token (for example, upstream Circle burn or Axelar ITS submission error). Both currencies and router bookkeeping revert atomically.
4. `inbound-provider-verify`: Provider attestation/signature check rejects prior to `bridge_in`. `was_processed` remains `false`, `claim_count` is unchanged, and rail liquidity stays intact.
5. `inbound-pull`: Rail calls `bridge_in` without sufficient escrowed liquidity/authorization. Token pull abort rolls back `mark_processed` so legitimate retries are never poisoned as replays.
6. `inbound-recipient-blocked`: Recipient lacks a trustline or refuses transfer (`FailableToken`). `bridge_in` parks a recipient-bound `PendingClaim` holding exact tokens in the router until `settle_claim` succeeds once.

## Recovery and Single-Debit Guarantee

Retrying an outbound transfer after one or more injected dispatch faults debits the sender's bridged asset (`gross = fee + net`, leaving unpulled 7-to-6 decimal dust untouched) and separate relay gas token at most once, increments `last_out_nonce` by exactly `1`, and consumes `flow_available` once.

## Active Deployment Posture and Compatibility Implications

- **Active deployment:** Stellar Testnet outbound `AxelarIts` and `Cctp` are exercised across both unpaid and paid (`bridge_out_with_gas`) paths; Stellar inbound legs, `AxelarGmp`, `Allbridge`, and EVM surfaces remain explicitly gated until independently validated.
- **Zero production wire or storage impact:** Fault scheduling lives purely in SDK rehearsal helpers and Soroban test fixtures, preserving exact integer amounts, authenticated rail dispatch, replay protection, and recipient-bound claims.
