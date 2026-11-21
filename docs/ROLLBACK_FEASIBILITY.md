# Upgrade Rollback Feasibility Reports

`script/stellar/rollback-report.mjs` produces read-only reports that show whether a previous
Stellar Hyperion WASM and storage layout remain compatible for a reviewed rollback after an
upgrade.

The report signs nothing, submits nothing, and executes nothing.

---

## Usage

```sh
# Single record — reports feasibility for the current deployment.
node script/stellar/rollback-report.mjs deployments/stellar-testnet-phase1.json

# Compare two records — old → new upgrade path, shows hash diffs.
node script/stellar/rollback-report.mjs \
  --from deployments/archive/stellar-testnet-2026-10-01.json \
  --to   deployments/stellar-testnet-phase1.json

# Include live schema version from chain (read-only RPC call).
node script/stellar/rollback-report.mjs deployments/stellar-testnet-phase1.json \
  --rpc https://soroban-testnet.stellar.org

# JSON output for tooling.
node script/stellar/rollback-report.mjs deployments/stellar-testnet-phase1.json --json
```

`verify.sh` prints the equivalent commands at the end of every verification run.

---

## What the report covers

| Section | Contents |
|---|---|
| `codeHashes` | Current and previous WASM hash for `router`, `adapter-cctp`, `adapter-axelar`. Flags when changed between records. |
| `storageMigration` | Live or recorded schema version; whether rollback is structurally supported; reason if not. |
| `steps` | Per-component rollback feasibility, required authority, mechanism and notes. |
| `activeProtections` | Invariants preserved regardless of WASM version: exact integer amounts, authenticated rail dispatch, replay protection, recipient-bound claims. |
| `evmGatingNote` | Reminder that EVM adapters remain gated and are unaffected by Stellar rollback actions. |

`readOnly: true` and `autoExecutes: false` are present in every report as explicit machine-readable
assertions.

---

## Authority

| Component | Required authority | Timelocked |
|---|---|---|
| Router WASM rollback | `admin` via `queue_action({UpgradeRouter: previous_hash})` + `execute_action` | Yes (`timelockDelay`) |
| Adapter WASM rollback | Adapter admin key; `upgrade_wasm` on the adapter | No |
| Storage migration | `admin` via `queue_action({BeginStorageMigration: version})` + `execute_action`, then `migrate_storage` in bounded steps | Yes |

Adapter admin and router admin are separate roles. Rolling back an adapter does not require the
router admin and does not go through the router timelock.

---

## Storage migration compatibility

The storage schema version determines whether a WASM rollback is safe.

| Schema version | Rollback supported | Reason |
|---|---|---|
| v0 | Yes | No migration has run. |
| v1 (legacy) | Yes | No migration has run. |
| v2 | **No** | Adds a fixed migration-state cursor that pre-v2 WASM cannot recognise. |
| v3+ | **No** | Rewrites per-token outstanding liabilities. Pre-migration WASM would compute incorrect liability totals. |

When `rollbackSupported: false`, the report includes an explicit reason and recommends deploying a
corrected WASM **forward** through the normal admin timelock rather than reverting.

### Recording a one-way migration in the deployment record

After completing a migration, record it in the deployment record so the rollback report can reason
about feasibility without a live RPC call:

```sh
HYPERION_SCHEMA_VERSION=3 \
HYPERION_ROLLBACK_SUPPORTED=false \
HYPERION_ROLLBACK_REASON="v3 storage migration completed 2026-11-01; liability layout is incompatible with pre-migration WASM" \
  node script/stellar/write-record.mjs deployments/stellar-testnet-phase1.json
```

The record gains a `storageMigration` field:

```json
"storageMigration": {
  "schemaVersion": 3,
  "rollbackSupported": false,
  "reason": "v3 storage migration completed 2026-11-01; ..."
}
```

An archived record retains this field. The rollback report reads it as the best available static
evidence; `--rpc` always takes precedence when a live schema version is available.

---

## Invariants preserved across upgrade and rollback

These are unaffected by WASM version changes:

- **Exact integer amounts.** No amount field is rewritten by upgrade or rollback. The seven-decimal
  Stellar USDC precision and the six-decimal EVM USDC precision are stored separately and never
  converted automatically.
- **Authenticated rail dispatch.** ITS and CCTP dispatch use per-adapter trust records keyed by
  `(chain, peer)`. A WASM rollback cannot retroactively forge dispatch from an untrusted peer.
- **Replay protection.** Per-route monotonic nonces are stored independently of WASM version.
  Reverting the WASM does not reset or reuse a nonce.
- **Recipient-bound claims.** Claims are stored by claim ID with an exact recipient address. A WASM
  rollback does not alter claim payloads, recipients, or settled amounts.

---

## EVM gating

EVM adapters and non-active rail development remain explicitly gated (`developmentGateOpen=false`).
Stellar rollback actions do not affect EVM gating. If an EVM rollback is ever needed, it requires
independent Foundry validation and its own reviewed report.

---

## Running the tests

```sh
node --test script/stellar/test/rollback-report.test.mjs
```

The test suite uses local fixtures only (the existing deployment record files in `deployments/`).
No network access is required.
