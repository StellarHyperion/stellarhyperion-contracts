# Cross-Language Malformed-Message Corpus

Hyperion decodes shared cross-chain wire formats in three separate implementations:

1. **Rust (`soroban/crates/hyperion-core`)** — Soroban on-chain codecs (`OutboundNote::decode`, `InboundNote::decode`, `StrkeyDestination` + host SEP-23 address resolution, `bytes32_to_evm`, `HyperionHook::decode`, `CctpMessage::parse`, and `BurnMessage::parse`).
2. **Solidity (`evm/src/libraries`)** — EVM on-chain codecs (`HyperionNotes.decodeOutboundNote`, `HyperionNotes.decodeInboundNote`, `HyperionNotes.toEvmAddress`, `HyperionNotes.encodeCctpHook`, and `StellarAddress.parse`).
3. **TypeScript (`packages/protocol`)** — Off-chain SDK, keeper, and UI codecs (`decodeOutboundNote`, `decodeInboundNote`, `parseStellarAddress`, `toEvmAddress`, `decodeCctpHook`, `parseCctpMessage`, and `parseCctpBurnMessage`).

## Canonical Manifest

- **Path:** `packages/protocol/test/fixtures/malformed-message-corpus.v1.json`
- **Schema version:** `1` (`MALFORMED_CORPUS_SCHEMA_VERSION`)
- **Formats covered:** `outbound_note`, `inbound_note`, `stellar_strkey`, `evm_word`, `cctp_hook`, and `cctp_burn_envelope`.
- **Categories covered:** `accepted_legacy`, `truncation`, `trailing_bytes`, `unsupported_version`, `wide_id`, and `semantic_edge`.

Every accepted legacy/v1 vector (`legacyAccepted: true`)—including raw empty-hook CCTP v2 burn messages, Hyperion v1 hook-bearing burn messages, classic `G` accounts, `C` contracts, `M` muxed accounts, `2^53 + 1` IDs above IEEE-754 safe integer precision, `u64::MAX` nonces/subaccount IDs, and `i128::MAX` token amounts—must decode to identical canonical semantic fields across every participating implementation.

## Documented Standalone-Helper Differences

The differential runner (`evaluateMalformedCorpus` in `packages/protocol/src/malformedCorpus.ts`) records implementation-level differences with `{ implementation, caseId, format, hexBytes }`. Known standalone-helper differences are explicitly declared under `acknowledgedDifferences`:

- **Frame-length error granularity (`InvalidDestination` vs `MalformedMessage`):** On inner-length mismatches in `inbound_note` and `cctp_hook`, Solidity and TypeScript reject at the outer frame check with `MalformedMessage`, whereas Rust delegates the body slice to `StrkeyDestination::decode` / `StellarDestination::decode` and rejects with `InvalidDestination`. Both sides reject all truncated and trailing-byte payloads.
- **Test-only EVM inbound-note reader (`inbound-kind-prefix-mismatch`):** EVM contracts never consume `InboundNote` on-chain (`AxelarItsAdapter.sol` validates destinations via `StellarAddress.parse` before encoding outbound notes to Stellar). `HyperionNotes.decodeInboundNote` is a framing-only round-trip helper in Solidity, whereas Rust `InboundNote::decode` and TypeScript `decodeInboundNote` enforce prefix/kind agreement.

Any unacknowledged verdict, error-code, or semantic discrepancy fails `evaluateMalformedCorpus` and prints the exact diverging implementation and hex byte vector.

## Compatibility and Migration Notes

- **Wire compatibility:** Purely additive verification and SDK reporting surface (`@hyperion/protocol` exports `malformedCorpus.ts`). No on-chain wire layout, Soroban error tag, or EVM ABI changed.
- **Deployment gating:** Stellar Testnet outbound ITS/CCTP remains the active deployment surface; EVM and additional rail paths remain explicitly gated until independently validated.

## Running All Three Suites

```bash
# 1. Rust / Soroban corpus runner
cargo test --manifest-path soroban/Cargo.toml -p hyperion-core malformed_corpus_test --locked

# 2. Solidity / Foundry corpus runner
cd evm && forge test --match-path test/unit/MalformedCorpus.t.sol -vv

# 3. TypeScript / Protocol differential runner and cross-repo sync check
cd packages/protocol && npx vitest run test/malformed-corpus.test.ts
```
