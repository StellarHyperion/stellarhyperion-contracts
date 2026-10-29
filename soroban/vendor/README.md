# Native Soroban host security patch

`soroban-env-host/` is the complete published `soroban-env-host` 28.0.2 crate,
with a local RustCrypto compatibility patch for RUSTSEC-2026-0387. Upstream:
https://github.com/stellar/rs-soroban-env/tree/5061e9c40ce6fc74ade9b9b3b49465b0cf7fdccb/soroban-env-host

The crates.io archive SHA-256 is
`36d7e5920c200939164cc58038224e2d90d7e2fabbfa505d6e2129d648dce7e2`,
matching the original Cargo.lock checksum. `.cargo_vcs_info.json` is preserved.
`LICENSE` is the Apache-2.0 license fetched from the same upstream commit.
No upstream host source or cryptographic functionality is removed.

## Changes

`soroban-env-host-rustcrypto.patch` records the manifest and existing-source diff
against that archive (zero context; use `git apply --unidiff-zero` when replaying). k256/p256 move to 0.14, ecdsa to 0.17, elliptic-curve to
0.14.3 and sec1 to 0.8.1. The workspace lockfile selects crypto-bigint 0.7.10
(the advisory fix is >=0.7.6). Native host builds require Rust >=1.87.

The host adopts the replacement EcdsaCurve bounds and `to_sec1_point` API.
Signature byte parsing, low-S rejection, prehash verification, recovery IDs,
uncompressed SEC1 output and budget charging remain in place. The benchmark
helper uses the same new SEC1 API. The existing P-256 tests use the replacement
point/normalization APIs; their published NIST and Wycheproof vectors are retained.
`Cargo.toml.orig` remains the unmodified upstream manifest for reference.

The vendored lockfile records the standalone test dependencies.
`tests/hyperion_crypto_compatibility.rs` adds public upstream secp256k1 recovery
and P-256 vectors with invalid sizes, recovery IDs, zero/corrupted signatures and
explicit high-S rejection. These complement the upstream suites, which normalize
S before verification.

## Verification and maintenance

From `soroban/`:

```sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --manifest-path vendor/soroban-env-host/Cargo.toml --locked \
  --features testutils --test secp256r1_sig_ver --test ed25519_edge_cases \
  --test hyperion_crypto_compatibility
cargo audit --file Cargo.lock
cargo audit --file vendor/soroban-env-host/Cargo.lock
```

The host is used for native execution/testing and is absent from the normal
`wasm32v1-none` contract dependency graph. Compare rebuilt contract WASM hashes
against saved artifacts before any release; this dependency fix requires no
on-chain contract upgrade. Passing tests and dependency audits is not a formal
cryptographic audit.

Keep this patch narrow. Replace it with an official compatible Soroban host
release once available, rerun these vectors and the owned contract suite, then
remove the crates.io patch and vendor directory together. Do not suppress the
advisory or substitute an unrelated crypto-bigint major without adapting callers.
