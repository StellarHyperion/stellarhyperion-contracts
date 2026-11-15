# Contract-Interface Capability Snapshots

Hyperion maintains committed capability snapshots for router and adapter contract surfaces so interface drift, accidental paid-method drops, and route-capability mismatches are caught before upgrade proposals are queued.

## Separate Router and Adapter Snapshots

Snapshots are split by contract role rather than merged into one blob:

- **Router snapshot:** `packages/protocol/test/snapshots/router-capabilities.snapshot.json` (`surfaceKind: "router"`) covering Soroban `HyperionRouter`, EVM `HyperionRouter`, and EVM `IHyperionRouter`.
- **Adapter snapshot:** `packages/protocol/test/snapshots/adapter-capabilities.snapshot.json` (`surfaceKind: "adapter"`) covering Soroban `CctpAdapter`, `AxelarAdapter`, `AllbridgeAdapter`, and EVM `CctpAdapter`, `AxelarItsAdapter`, `IRailAdapter`.

Cross-contaminating router and adapter entries fails `verifySnapshotConsistency` with `surface-separation-violation`.

## Active Deployment Posture and Paid-Method Policy

- **Active deployment:** Stellar Testnet outbound `AxelarIts` and `Cctp` (`paidRoutes: ["Cctp", "AxelarIts"]` on Soroban `HyperionRouter`, matching `supports_paid_route` and `bridge_out_with_gas`).
- **Explicitly gated surfaces:** Stellar inbound legs, `AxelarGmp`, `Allbridge`, and EVM router/adapter deployments remain explicitly marked `gated` until independently validated.
- **Paid-method removal gate:** Removing or downgrading any `paid: true` method (`bridge_out_with_gas`, `supports_paid_route`, `dispatch_from`, `gas_token`, `quote_max_fee`, `fund_gas`, `gas_balance`, `quote_gas`, EVM `bridgeOut`, `dispatch`, `quoteFee`, `topUpGas`) or any `paidRoutes` entry fails `compareCapabilitySurface` with `paid-method-removed-without-ack` / `paid-route-removed-without-ack` unless accompanied by a `CompatibilityAcknowledgement` setting `acknowledgePaidRemoval: true`, a non-empty `reason`, a concrete `consumerMigration` plan, and an audit `reference`.

## Compatibility and Migration Implications

- **Zero runtime or wire impact:** Capability snapshots and evolution gates operate purely on source/ABI/client verification in `@hyperion/protocol` and `hyperion-router` test suites, preserving exact integer amounts, authenticated rail dispatch, replay protection, and recipient-bound claims.
- **Intentional upgrade workflow:** Additive methods pass automatically and appear in `additiveMethods`. Breaking signature edits or paid-capability retirements require updating the snapshot alongside a documented `CompatibilityAcknowledgement` before timelock queueing.
