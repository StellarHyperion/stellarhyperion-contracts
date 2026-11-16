# Vendored Host Dependency Provenance Verification

Hyperion vendors `soroban-env-host` `28.0.2` (`stellar/rs-soroban-env` commit `5061e9c40ce6fc74ade9b9b3b49465b0cf7fdccb`) with a narrow zero-context RustCrypto compatibility patch (`RUSTSEC-2026-0387`, `crypto-bigint >= 0.7.6`) for native host test execution.

## Verified Provenance Invariants

`packages/protocol/src/vendorProvenance.ts` and `soroban/crates/hyperion-router/src/test/vendor_provenance.rs` enforce seven deterministic checks against `packages/protocol/test/fixtures/vendor-provenance-manifest.json`:

1. **Exact 272-file SHA-256 inventory:** Every file under `soroban/vendor/` is classified (`vendor-doc`, `patch-artifact`, `upstream-reference`, `upstream-patched`, `local-addition`, or `upstream-unchanged`) and hashed. Any modified, missing, or unexpected file fails with its exact repository-relative path.
2. **Upstream git revision:** `soroban/vendor/soroban-env-host/.cargo_vcs_info.json` must match `5061e9c40ce6fc74ade9b9b3b49465b0cf7fdccb` and `path_in_vcs: "soroban-env-host"`.
3. **Permitted patch set and hunk alignment:** `soroban/vendor/soroban-env-host-rustcrypto.patch` (`sha256: 48a21c883fafa443d1df73c3d58ba147415b12fe2f2cd2e923619d2e9e97ef0d`) may touch only the four permitted upstream files (`Cargo.toml`, `src/crypto/mod.rs`, `src/cost_runner/util.rs`, `tests/secp256r1_sig_ver.rs`), every `+` line in its hunks must align with `Cargo.toml`, and `Cargo.toml.orig` remains preserved unchanged as the upstream workspace manifest reference.
4. **Apache-2.0 license preservation:** `Cargo.toml` and `LICENSE` preserve upstream Apache-2.0 licensing.
5. **Advisory lockfile posture:** `soroban/Cargo.lock` resolves `crypto-bigint >= 0.7.6` (`0.7.10`).
6. **WASM runtime graph isolation:** Normal `wasm32v1-none` contract dependencies resolve to `soroban-env-guest` and exclude native-only crates (`soroban-env-host`, `k256`, `p256`, `ecdsa`, `elliptic-curve`, `sec1`, `crypto-bigint`, `ed25519-dalek`, `curve25519-dalek`).
7. **Cryptographic vector binding:** `soroban/vendor/soroban-env-host/tests/hyperion_crypto_compatibility.rs` asserts both the upstream commit SHA-1 and the patch SHA-256 digest during vector execution.

## Active Deployment Posture and Migration Implications

- **Active deployment:** Stellar Testnet outbound `AxelarIts` and `Cctp` contract WASM binaries are completely unaffected because `soroban-env-host` is excluded from `wasm32v1-none` runtime builds; EVM and other rail surfaces remain explicitly gated.
- **Upgrade and retirement:** When an official `soroban-sdk` / `soroban-env-host` release incorporates the RustCrypto bump, remove `[patch.crates-io]`, `soroban/vendor/`, and the provenance manifest together after rerunning the workspace and cryptographic suites.
