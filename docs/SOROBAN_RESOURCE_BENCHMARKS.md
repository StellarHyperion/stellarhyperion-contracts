# Reproducible Soroban CPU and Memory Budget Benchmarks

## Overview

`HyperionRouter` CPU instruction and memory byte consumption is measured deterministically against
the pinned local Soroban host cost model across representative quote, outbound dispatch, paid
dispatch, inbound direct delivery, parked claim creation, claim settlement, and batched keeper
paths.

## Pinned Toolchain and Resource Assumptions

| Parameter | Pinned Value |
| --- | --- |
| Rust workspace MSRV | `1.87` (`soroban/Cargo.toml`) |
| `soroban-sdk` | `28.0.0` |
| `soroban-env-host` | `28.0.2` (vendored in `soroban/vendor/soroban-env-host`) |
| Ledger protocol version | `28` |
| Transaction CPU instruction limit | `100,000,000` instructions (`BudgetImpl::default()`) |
| Transaction memory limit | `41,943,040` bytes (`40 MiB`) |
| Execution mode | `native-testutils-metered-host` (`env.cost_estimate().budget()`) |

Native host metering charges deterministic XDR serialization/deserialization, host object visits,
persistent/instance storage reads/writes, TTL extensions, and sub-contract auth/invocation frames.

## Benchmark Fixtures and Large Stored Records

`soroban/crates/hyperion-router/src/test/resource_benchmarks.rs` seeds both a compact world and a
populated world containing large-but-valid stored records:

- `4` registered tokens with active `RouteConfig` (`max_single_transfer`) and per-route
  `RouteFlowLimit` overrides across all `4` routes (`Cctp`, `AxelarIts`, `AxelarGmp`, `Allbridge`).
- `16` stored `TransferRecord` entries with 64-byte destination chain identifiers and populated
  sliding `FlowWindow` entries across every route.
- `16` stored `PendingClaim` entries with 64-byte source chain identifiers, wide `u64` nonces, and
  128-byte muxed raw recipient payloads.

| Operation | Input XDR (`B`) | Stored Record (`B` / keys) | Baseline CPU (`insns`) | Baseline Memory (`B`) | Tolerance |
| --- | ---: | ---: | ---: | ---: | ---: |
| `quote_routes_compact` | `80` | `1,436` | `620,116` | `202,387` | `+5.00%` (`500 bps`) |
| `bridge_out_compact` | `388` | `456` | `755,523` | `297,851` | `+5.00%` (`500 bps`) |
| `quote_routes_large_stored_state` | `80` | `1,436` | `788,236` | `277,323` | `+5.00%` (`500 bps`) |
| `bridge_out_large_stored_record` | `444` | `512` | `1,237,119` | `512,686` | `+5.00%` (`500 bps`) |
| `bridge_out_with_gas_large_stored_record` | `464` | `512` | `1,140,072` | `472,095` | `+5.00%` (`500 bps`) |
| `bridge_in_direct_large_payload` | `600` | `32` | `635,239` | `301,125` | `+5.00%` (`500 bps`) |
| `bridge_in_park_large_claim_record` | `600` | `392` | `873,442` | `395,871` | `+5.00%` (`500 bps`) |
| `settle_claim_large_stored_record` | `64` | `392` | `548,632` | `270,626` | `+5.00%` (`500 bps`) |
| `keep_alive_large_batch` | `636` | `68` keys | `4,025,009` | `1,486,695` | `+5.00%` (`500 bps`) |

## Actionable Regression Delta Reporting

Both `evaluate_benchmark_delta()` in Rust and `compareSorobanBenchmarkSuite()` in
`packages/protocol/src/sorobanBenchmarks.ts` report structured deltas rather than raw totals:

- Signed CPU instruction delta (`actual - baseline`), basis-point change, tolerance ceiling overrun,
  and remaining Soroban transaction CPU headroom (`100,000,000 - actual`).
- Signed memory byte delta (`actual - baseline`), basis-point change, tolerance ceiling overrun,
  and remaining Soroban transaction memory headroom (`41,943,040 - actual`).
- Explicit input XDR size, stored-record XDR size, and protocol/host version drift flags.

## Compatibility and Migration Implications

- **No contract ABI or storage changes:** Benchmarks live in `#[cfg(test)]` router tests and
  additive `@hyperion/protocol` exports; deployed WASM artifacts are unchanged.
- **Deployment gating preserved:** Stellar Testnet outbound ITS/CCTP posture is unchanged; EVM and
  other rails remain gated.
