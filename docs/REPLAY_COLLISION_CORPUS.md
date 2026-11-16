# Replay-Identity Collision Corpus

## Overview

Provider bridges attach full-width 32-byte message identifiers to inbound transfers (`BytesN<32>` CCTP V2 nonces, Allbridge Core 32-byte message hashes, and Axelar XDR-framed `(source_chain, message_id)` digests) while also surfacing shortened 64-bit `display_nonce` values (`bytes[24..32]`) or 8-byte explorer prefixes (`bytes[0..8]`) for UI and indexer display.

This corpus generates adversarial full-width replay identifiers across six collision families and exercises `HyperionRouter` replay storage (`DataKey::Processed(RouteKind, BytesN<32>)`) alongside `@hyperion/protocol`:

1. `shared-display-prefix-8b`: Distinct 32-byte IDs sharing identical leading 8 bytes (`bytes[0..8]`) and identical trailing 8-byte `display_nonce` (`bytes[24..32]`), differing only in interior bytes `bytes[8..24]`.
2. `shared-shortened-u64-nonce`: Distinct 256-bit CCTP and Allbridge identifiers sharing identical `u64` tail nonces under distinct high-order epoch/pool prefixes.
3. `zero-vs-nonzero-high-word`: Full-width IDs with zero vs non-zero upper 192 bits above a shared `2^53 + 1` low `u64` word.
4. `single-bit-hamming-neighbor`: Single-bit flips across byte positions `0`, `7`, `8`, `15`, `23`, `24`, and `31`.
5. `axelar-xdr-boundary-shift`: Length-prefixed XDR string pairs such as `("eth", "ereum-tx-42")` vs `("ethereum", "-tx-42")` and `("arbitrum", "10")` vs `("arbitrum1", "0")` sharing identical `InboundNote` nonces.
6. `cross-route-shared-id`: Identical 32-byte `message_id` values delivered independently across `Cctp`, `AxelarIts`, `AxelarGmp`, and `Allbridge`.

## Acceptance Guarantees

- Distinct `(route, message_id)` pairs never overwrite or merge `DataKey::Processed` replay entries or parked `PendingClaim` liabilities, even when `Origin.nonce` and 8-byte display prefixes match.
- Exact `(route, message_id)` replays are deterministically rejected with `ReplayedMessage` and zero token movement.
- Every report line in both TypeScript (`packages/protocol/src/replayCorpus.ts`) and Rust (`soroban/crates/hyperion-router/src/test/replay_collision_corpus.rs`) preserves all 32 identifier bytes (`0x` + 64 lowercase hex digits) without ellipsis truncation.

## Compatibility and Migration Implications

- Additive verification modules and test suites only; no contract entrypoints, XDR storage keys, or wire formats change.
- Preserves exact integer amounts, authenticated rail dispatch, route-scoped 32-byte replay protection, and recipient-bound parked claims.
- Stellar Testnet outbound ITS/CCTP operations remain unchanged, and EVM/non-active rail paths remain explicitly gated behind existing deployment checks.
- Indexers and support tooling must treat `source_nonce` (`u64`) strictly as a human display aid and always index deduplication state by `(route, full_32_byte_message_id)`.

## Validation Commands

```bash
cd packages/protocol
npm run fmt:check
npm run lint
npm run typecheck
npx vitest run --maxWorkers=2
npm run build

cd ../../soroban
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```
