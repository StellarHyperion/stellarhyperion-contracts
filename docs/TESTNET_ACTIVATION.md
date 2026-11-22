# Current Stellar Testnet deployment

> **Status:** Active. This record is the single current Stellar Testnet deployment for outbound ITS/CCTP. Archived deployments are listed under "Deprecated and archived deployments" below; their addresses must not be used for activation or monitoring.

The wallet-owned router and ITS adapter were deployed with the dedicated `hyperion-testnet-20261028` CLI wallet and activated after the normal 3600-second router timelock. This wallet owns the fresh deployment; it does not control the older October 1 router.

| Setting          | Confirmed value                                              |
| ---------------- | ------------------------------------------------------------ |
| Router           | `CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V`   |
| CCTP adapter     | `CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT`   |
| ITS adapter      | `CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ`   |
| Admin / treasury | `GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA`   |
| Stellar USDC SAC | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`   |
| Destination      | `sepolia` / Axelar `ethereum-sepolia`                        |
| Received token   | `0xFd5a146686d16060ef9c595B37C30b248402304c`, seven decimals |
| Activated        | `2026-10-28T17:08:25Z`                                       |

The received asset is the ITS representation of Stellar USDC, not Circle's native Sepolia USDC. Route 1 sends directly to the recipient through ITS and needs no EVM Hyperion adapter.

## Axelar capability admission and upgrade compatibility

The adapter now stores an explicit capability for each `(Hyperion chain, ITS token id)` pair. A
record captures the current Axelar chain name, peer address, and locally reported ITS token-manager
type. The capability is either `DirectItsTransfer` (recipient address, empty metadata) or
`GmpPayload` (Hyperion peer address plus an authenticated note); a route instance cannot use the
other shape. Dispatch and GMP callback acceptance fail closed if the record is missing, the manager
type has changed, or the lane no longer matches the recorded peer. Soroban keeps these records in
instance storage so the existing bounded instance-TTL maintenance keeps admission alive alongside
the adapter configuration. Exact integer amounts,
authenticated ITS calls, router replay protection and recipient-bound claims are unchanged.

The active Sepolia source route is the bare `AxelarIts` shape. Its existing link and token mappings
are not overwritten by admission, but the new capability key does not exist in older adapter state.
When upgrading that adapter, retain the existing trusted link and USDC token mapping, then call
`set_destination_capability` for the `sepolia` / existing ITS-USDC pair with
`DirectItsTransfer`. Until this admission is written, the new implementation refuses dispatch;
perform the upgrade and admission as one planned maintenance window, or configure a replacement
adapter and switch the router through its normal timelock. Do not select `GmpPayload` for the
active direct-transfer lane. CCTP configuration and delivery are unaffected.

GMP instances need their own `GmpPayload` admission for each chain/token pair and still require
the exact peer trust check. Repointing a chain or changing its token-manager type invalidates the
old record and requires a fresh admin admission. The EVM Axelar adapter is separately gated:
`developmentGateOpen` is false by default, and its GMP pair records and nonzero validation evidence
must only be configured after independent EVM/destination validation. The evidence hash is an
operator reference, not an on-chain proof. EVM and other unvalidated rail development must not be
activated as part of the current Stellar Testnet rollout.

## Deployment evidence

`deployments/stellar-testnet-phase1.json` is the canonical app/indexer record, retaining its historical filename. `deployments/evidence/2026-10-28-paid-its.json` records actual transaction hashes, ledgers, artifact hashes, token mapping, lane link, queued actions, execution and transfer acceptance status. Check that evidence for the latest source/destination verification result.

The current router uses WASM `281d946ea78b194c0ef44ad9488ed02b2aa6912fb4f6fbab523ad38f1e0803f1`; the CCTP adapter uses `80f109e7467ace6899f865a4f77079917a2bea8a5def593a4d87c08c09206af4`, built from forwarding implementation `b91c6ca`. The unchanged ITS adapter uses `5f32139554d29edc3501a39ae3d05761101234523dd48b4d9e2d81ebf001f2c3`, built from `60b3310`. Actual deployed code was downloaded and its SHA-256 verified. All initial configuration actions and the later CCTP/router upgrade actions were confirmed after their original 3600-second timelocks matured. No shortened timelock or bootstrap bypass was used.

The older deployment is preserved in `deployments/archive/stellar-testnet-2026-10-01.json`. Its separate admin upgrade instructions are historical in `docs/LEGACY_TESTNET_UPGRADE.md`. Do not run those old-address commands against this fresh deployment.

## Cross-repository copy verification

The canonical record is copied by hand into the backend and frontend repositories, so a stale copy is
silent: an address that parses, builds and points at a contract this deployment no longer monitors.
The comparison is a read-only command rather than a deploy step, because it is asked weeks later
from a machine that never ran the deployment:

```bash
node script/stellar/check-deployment-copies.mjs \
  --canonical deployments/stellar-testnet-phase1.json \
  --copies deployment-copies.json
```

`deployment-copies.json` names each consumer repository, a local clone of it, the exact commit that
built it, and where the copy lives inside that commit:

```json
{
  "copies": [
    {
      "repository": "backend",
      "repo": "../stellarhyperion-backend",
      "revision": "git:<full 40-character commit sha>",
      "path": "deployments/stellar-testnet-phase1.json"
    },
    {
      "repository": "frontend",
      "repo": "../stellarhyperion-frontend",
      "revision": "git:<full 40-character commit sha>",
      "path": "src/deployment.json",
      "pointer": "/deployment"
    }
  ]
}
```

`repo` is resolved relative to the copies file. `pointer` is optional and is an RFC 6901 JSON
pointer to the record inside a consumer document that wraps it. `--canonical` defaults to
`deployments/stellar-testnet-phase1.json`. `--json` prints the machine-readable report.

What the command guarantees:

- It reads each copy out of the committed blob with `git rev-parse`, `git cat-file` and `git show`.
  A consumer working tree is never read, and no file is written: copying a new record into a
  consumer stays a separate, reviewed operation. Exit 0 means every copy matches, 1 means drift,
  and 2 means a usage or read error.
- Revisions are pinned. A short, symbolic or missing commit is refused, and the resolved commit must
  equal the one requested, so a report cannot describe a tree that changed underneath it.
- Every difference is reported as `repository field canonical copy`, with `field` the JSON path in
  the canonical record and `copyField` the path in the consumer's document when a pointer was used.
  The owning repository is the consumer whose copy is stale; `owners` lists them.
- Comparison is exact. `"30"` does not match `30`, an amount stays the string the record wrote, and
  an array is not the object that contains it. Nothing is coerced, because coercion would hide the
  mistakes this check exists to find.
- Archived records are refused as a baseline unless `--allow-archived` is passed, and an allowed
  archived baseline is labelled `active: false` with its `successor` rather than presented as the
  current deployment. Both metadata shapes already in the tree are parsed (`lifecycle.status` and
  the `status`/`successorRouter` fields `write-record.mjs` writes), as is a file under a directory
  named `archive`.

Compatibility and migration implications:

- The command interprets no deployment schema. It compares JSON values field by field, so the EVM
  records under `evm/deployments/` are checked with the same command and the same spec shape; a flat
  EVM record has no `networks` wrapper and is treated as the deployment itself.
- It changes no wire format, no ABI, no note layout and no rail behaviour, so records already
  committed stay valid and consumers need no migration. The only new input is the copies file,
  which is configuration rather than deployment data.
- Adopting it does not freeze the copies at their current revisions: the spec names a commit per
  consumer, and updating that revision is the reviewed moment a new record is accepted. A record
  that must stay archived is still compared as historical evidence, never as an activation target.
- Reading is bounded: one canonical record and at most eight copies, each under 1 MiB. A path that
  is not a regular file, escapes its clone, or does not name a blob in that commit is refused with
  the repository named.

## Deprecated and archived deployments

Deprecation is a status change, not a deletion. Archived records remain in the repository and their transaction evidence is retained in full; only their operational authority is withdrawn.

| Record                                                | Status     | Retired router                                            | Successor                                                  | Successor record                          |
| ----------------------------------------------------- | ---------- | --------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| `deployments/archive/stellar-testnet-2026-10-01.json` | `archived` | Router from the October 1 deployment (historical address) | `CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V` | `deployments/stellar-testnet-phase1.json` |

Parsed metadata contract for tools:

- `status: "active"` marks the only record eligible for activation, proposal generation, verification and monitoring.
- `status: "archived"` marks a record that must be read-only for historical evidence. Consumers must not activate, queue, upgrade or monitor it.
- Every archived record must carry `successor` (the active router address) and `supersededAt` (ISO-8601 timestamp) fields. A missing successor is a hard error.
- Archiving never removes or rewrites `evidence` entries, transaction hashes, ledgers or artifact hashes.

Actionable warnings for consumers:

- If a tool is configured with the retired October 1 router address, it must refuse activation and emit a warning that names the successor router `CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V` and the record `deployments/stellar-testnet-phase1.json`.
- Monitoring and indexing of a retired router is read-only and must be labelled `archived` in output. Do not present archived delivery or balance data as current.
- Do not run the legacy upgrade instructions in `docs/LEGACY_TESTNET_UPGRADE.md` against the successor; they target retired addresses.

Compatibility and migration: existing consumers that read only the active record are unaffected. Consumers that enumerate archive files must parse `status` and `successor` before use. Tools that previously accepted the archived router without checking status must be updated to refuse it; this is a breaking change for those tools and is listed here so it can be planned.

## Verified acceptance transfer

A real CLI wallet signature through the frontend application helpers sent 0.1 USDC. Stellar confirmed source transaction `b95ca748421ea4774dea6a08edebc3ad3a301244034cd10f1209f3cea234862d`. The protocol fee was 0.0003 USDC; 0.0997 USDC arrived on Sepolia in transaction `0x1fdb81fcdec18071adbdf47e359f0b9e4adc6be685c1e3bfcfb39689485037b6`. Independent RPC reads confirmed the recipient token balance and successful receipt; the backend verified matching ITS/payment events and persisted delivered status. The live acceptance test passed.

## Active Circle CCTP and native USDC

CCTP route 0 is active as of `2026-10-29T10:03:44Z`. The adapter uses Circle's published Stellar Testnet messenger and transmitter. Domains 0, 6 and 26 link to Ethereum Sepolia, Base Sepolia and Arc Testnet. Actions 5 through 7 configured and enabled CCTP; action 8 upgraded the router first. All are executed. The existing ITS lane and adapter are preserved.

`deployments/evidence/2026-10-29-cctp.json` retains preparation, upgrade, timelock and activation evidence plus real delivered acceptance transfers on all three destinations. Each test sent 0.3 testnet USDC; the protocol fee was deducted before the remaining 0.2991 USDC was burned, and the forwarding fee was deducted on destination. Confirmed native-USDC payouts were 0.038033 on Sepolia, 0.240087 on Base Sepolia and 0.276441 on Arc Testnet. Forwarding fees vary with destination gas and amount; these are historical observed results. The application displays a live budget and receive minimum before signing. Six-decimal native Circle USDC differs from the seven-decimal ITS representation.

Paid dispatch uses Circle's `cctp-forward` hook and standard finality. The router enforces the minimum destination amount after the full forwarding budget. Circle handles the destination mint without a Hyperion EVM signer. Backend verification binds the attested message to the source transfer and requires matching finalized `MessageReceived` and native-USDC mint events in a successful, confirmed canonical destination receipt. A forwarding API status alone is insufficient.

`script/stellar/enable-cctp.py` provides resumable `queue`, `forwarding` and `activate` stages. This deployment is already active; do not requeue or redeploy it. The tool keeps confirmed steps atomically and never bypasses the timelock.

## Liquid Stellar assets

The frontend discovers classic Stellar assets and finds real Horizon conversion paths into canonical USDC. Asset listing does not guarantee liquidity. Conversion is a separate, capped strict-receive transaction, followed by a fresh bridge review and signature. Converted USDC stays in the user's wallet if bridging cannot proceed. Public checkpoints preserve actual transaction hashes across interruption and prevent blind resubmission.

`deployments/evidence/2026-10-29-conversion.json` records an actual fresh native-XLM wallet, USDC trustline creation and conversion, followed by an independently verified ITS payout of 0.8107937 USDC on Sepolia. The original ITS acceptance remains preserved above. Never repeat any delivered proof transaction.

## Running the application

Use Node 22.13 or newer and a Stellar CLI identity held outside Git. The configured admin identity is named above; private key material must remain in the CLI store. Application users connect their own Stellar Testnet wallets and need testnet XLM for reserves/network fees and a liquid source balance. Direct USDC sends need the canonical trustline/balance; conversion can create that trustline. ITS also needs its displayed XLM relay budget.

Run the backend with PostgreSQL, the canonical deployment record, indexing and rail polling enabled. Redis is required only for an enabled keeper. Start Next with its backend API origin configured. The frontend verifies the live router, mapping, selected destination token and paid-transfer methods before allowing a signature.

The frontend's opt-in `test/live-transfer.test.ts` uses the actual application quote and submission helpers with a named CLI wallet. It spends 0.1 testnet USDC plus relay/network fees, saves the real source hash before broadcast, and checks destination token balance and verified indexer delivery. It is skipped in normal test runs. Set these public/non-secret inputs only when intentionally running a live test:

```bash
HYPERION_LIVE_TESTNET=1 \
HYPERION_TESTNET_IDENTITY=hyperion-testnet-user-20261028 \
HYPERION_TESTNET_RECIPIENT=0x6ef8032ffE4943F27388172549f6700f18BB8b38 \
NEXT_PUBLIC_HYPERION_API_URL=http://127.0.0.1:8080 \
HYPERION_TESTNET_APP_URL=http://127.0.0.1:3100 \
HYPERION_TESTNET_PROOF=/tmp/hyperion-live-transfer-proof.json \
npx vitest run test/live-transfer.test.ts
```

Preserve the proof file across interrupted runs. Never delete a pending source hash and blindly send again. A confirmed Stellar transaction alone does not establish destination delivery. Require the indexer's matching confirmed bridge/token payment and the recipient's actual received-token balance. The additional opt-in `test/live-routes.test.ts` covers native XLM conversion and CCTP destination payouts; see the frontend README for its explicit route/proof settings.

For future contract changes, use the router's existing queue/execute upgrade path with its current admin and timelock. Adapter upgrades require the adapter admin. Mapping/link setters can overwrite configuration; read current values and confirm the intended token/network before signing.

## Configuration-diff proposals

`script/stellar/propose.sh` compares a desired deployment manifest with the live router and prints unsigned proposals. It is the reviewable handover between reading the chain and queueing an action; it is not an admin client.

```bash
# Canonical active manifest; read-only against the testnet RPC.
script/stellar/propose.sh

# A proposed manifest, kept as a handover artifact.
script/stellar/propose.sh path/to/desired-manifest.json --out /tmp/proposals.json

# Offline rehearsal against a local snapshot (no `stellar` binary required).
script/stellar/propose.sh deployments/stellar-testnet-phase1.json \
  --fixture script/stellar/test/fixtures/drift
```

Every chain access is a simulated view call (`--is-view` / `--send no`). There is no signing flag, no `--send yes`, and no `queue_action` call in this path. The source account named by `STELLAR_IDENTITY` (default `hyperion-deploy`) is only the transaction source for simulation. Output on stdout is a JSON object with `differences`, `proposals`, `alreadyQueued`, `guardianActions`, `signed: false`, and `submitted: false`; a matching live state yields empty arrays and a non-zero exit is reserved for a refused generation.

Generation aborts before diffing when the live passphrase is not `Test SDF Network ; September 2015`, when the manifest's passphrase disagrees with the chain, or when the deployed router WASM hash differs from `wasmHashes.router`. Adapter hashes are checked when present too. This is what stops a proposal built from this record being used against the archived October 1 router or a mainnet deployment. Manifests whose `family` is not `stellar` are also refused: EVM and other rail proposal generation stays explicitly gated until that side is independently validated.

Only real differences become proposals: config fields (`admin`, `guardian`, `treasury`, `feeBps`, `flowWindow`, `timelockDelay`), token registration or a flow-limit increase, router-side adapter/receiver/enable wiring, and an optional `routeConfigs` entry with `maxSingleTransfer`. An i128 limit is carried as an exact decimal string throughout; no proposal is produced for a value that already matches, and an identical action already sitting in the queue is reported in `alreadyQueued` rather than emitted again. A flow-limit decrease or route disable is a guardian/immediate action, not a timelocked proposal, because it only narrows what the bridge can do. A changed token decimal count aborts generation instead of proposing a re-registration that would silently overwrite it.

Each proposal carries its `delay` requirement: the desired `delaySeconds` plus the router's `minDelaySeconds`, `maxDelaySeconds` and `gracePeriodSeconds`. The operator still has to queue with `queue_action` under the current admin and execute only after the delay matures, as documented above. The tool never shortens that wait and never bypasses the timelock.

**Compatibility and migration.** The command targets the action variants and integer widths of the deployed router hash recorded above; it does not upgrade or modify that contract. If the router is upgraded, update the manifest's `wasmHashes.router` in the same change that updates this runbook, regenerate proposals, and re-check the wire format against `hyperion-router/src/types.rs` and the protocol parity suite. Adapter `link` setters and adapter ownership remain a separate authority and are intentionally absent from router proposals; they are still performed by their own scripts after reading the live peer/domain settings. Keeping a proposal file is safe after execution: re-running the command against the settled state produces an empty diff and submits nothing.

Offline fixtures for the guards and drift cases live in `script/stellar/test/fixtures`; run the suite with `node --test script/stellar/test/propose.test.mjs`.

The proposal planner refuses unreadable state rather than treating an RPC failure as absent
configuration. Only the router's explicit `TokenNotRegistered`, `AdapterNotSet`, and
`TimelockNotQueued` errors represent missing entries. Reads use `--send=no`, a 30-second
per-command deadline and a 4 MiB response limit. More than 10,000 historical queue IDs
requires a separately reviewed bounded inventory instead of an unbounded scan. The ledger
close timestamp excludes expired actions from deduplication; an expired action must be queued
again. Proposal delays report the current live timelock delay, including when proposing a
change to that delay. All desired router and adapter code hashes are mandatory; the canonical
`adapter-axelar` record supplies the `axelar-its` hash. Numerical JSON amounts above JavaScript's
safe range must be decimal strings, and contract-width limits are checked before output.

## Storage upkeep, restoration planning, schema migration, and action audit

### Archived storage restoration planner (#47)

Restoration is planned off chain. A Soroban guest cannot prove archival from key presence:
allocating a sequence number does not prove a record still exists or is archived. Guest reads of archived entries may reject or restore during
simulation; an archived instance cannot run a guest planner at all. No guest API guesses archive
state. The RPC planner works even when the instance/code itself needs restoration.

Use the RPC planner before upkeep, migration, or settlement:

```sh
node script/stellar/restore-plan.mjs https://soroban-testnet.stellar.org recorded-request.json
```

The request contains `keys` (1–32 canonical base64 `LedgerKey` XDR values from a recorded
footprint) and `transaction` (the original invocation envelope XDR). The planner only calls
`simulateTransaction` and `getLedgerEntries`. It signs and submits nothing. It proves archival
only from `restorePreamble` or CAP-0066 read-write archive indices in transaction data, reports active keys from their ledger TTL, reports a missing key
only when a successful matching simulation touched it without a restore request, and otherwise
reports unknown. For manual restoration it emits the exact complete restore footprint, including required code or
instance dependencies, the original Soroban transaction data XDR and the exact decimal resource
fee. CAP-0066 automatic restoration emits its exact indexed keys and original transaction data,
without fabricating a separate restore operation. Footprints over 32 keys are refused. Review the footprint, restore it, then re-simulate the
original invocation; fee and ledger evidence are estimates for that simulation, not a submission
guarantee. No recipient is inferred from a key, claim number, caller, or supplied metadata.

The local archived-claim snapshot fixture expires a genuine persistent ledger entry, applies a
TTL-only restoration to that recorded entry, reloads its unchanged payload, and settles to the
recorded recipient exactly once. This fixture models the ledger restoration operation; it does
not claim to submit a live network restore transaction.

### Versioned storage schema migration (#46)

`get_migration_status.current_version` reports 3 for new/migrated routers, explicit 2 for the previous migration, implicit 1 for initialized legacy
storage, and 0 for an uninitialized router. Financial record layouts and all amount/recipient
fields are unchanged. Version 2 adds a fixed migration state. Record version is determined from
its family cursor and captured high-water mark: migrated IDs and new IDs above the captured
mark use the target version; remaining legacy IDs use the current version. These cursor values
are metadata, not proof that a missing record exists. This avoids an independently expiring
schema sidecar and an unbounded map in instance storage.

After the ordinary reviewed WASM upgrade, queue and execute `BeginStorageMigration(3)` through
the existing admin timelock. This captures fixed transfer/claim high-water marks and authorizes
bounded work. `migrate_storage(admin, 3, max_steps)` accepts 1–32 steps only after that delayed
authorization. It decodes and rewrites each old typed record exactly and commits its version cursor atomically. Missing or archived records must be restored first: they never
advance the cursor. Readers support old and new records while interrupted. When legacy liability totals are unknown, inbound delivery and settlement reject during the backfill, preserving its claim snapshot; outbound records above the fixed transfer mark remain compatible. Repeated authorization never resets progress, and calls after
completion return the same completed status. This migration never guesses a balance or changes
a payout, fee, flow window, recipient, or replay identifier. Future layout changes need a new
reviewed version and conversion, rather than treating this conversion as a generic migration.

Version 3 recomputes per-token outstanding liabilities from only unsettled claims. Fee balances, outbound balances and custody surplus never enter those totals. `claim_liability(token)` reports `known=false` until the bounded backfill completes; custody remains an independent actual balance and solvency means custody covers outstanding liabilities. Parking and settlement update claim state and exact liabilities in the same transaction, and negative/corrupt subtraction rejects and rolls the payout back. Claim upkeep now refreshes its provenance too, counting two physical keys per supplied claim ID. An authorized but unfinished v2 migration remains resumable with its saved target/cursors; finish it first, then separately queue v3, which scans every claim anew rather than reusing a v2 cursor that never counted liabilities.

### Timelock cancellation reasons and action audit metadata (#44)

Soroban `cancel_action_with_reason` and gated EVM `cancelActionWithReason` accept the six
structured reason codes and at most 128 **printable ASCII bytes (0x20–0x7e)**. Unicode, control
characters and oversized notes reject before any queue mutation. Legacy cancellation signatures
remain and use an empty note with `Unspecified`.

Existing queue/execution/cancellation events keep their original encoding. New Soroban audit
and migration events, and EVM audit events, explicitly carry schema version 1.
Soroban retains the original `QueuedAction` payload and schedule in `ResolvedAction` storage and
exposes `get_action_payload`; cancelled actions leave the executable
queue. Versioned immutable audit events record the actor for each transition. A pre-audit
queuing author remains unknown; the cancellation event identifies only its resolver. EVM retains
the canonical `queuedAction` payload and schedule after cancellation, exposes `actionCancelled`,
and records versioned lifecycle metadata (actor, status, reason and note) in
`ActionAuditUpdated` events. These immutable events are the EVM audit source; there is no second
copy of the dynamic action or note in storage. Consumers combine the retained payload with the
versioned events. Execution and recancellation both reject cancelled actions.

### Adapter upkeep bounds, coverage and exclusions (#49)

Every adapter exposes `key_coverage`. Verification reads the actual registered
adapter and queries its own coverage. Upkeep permits at most 32 persistent key visits in total
(excluding the single instance/instance extension), with conservative duplicate counting and
Cartesian products included. Every input vector is separately bounded; unused families reject
non-empty inputs instead of silently pretending to maintain them. TTL maintenance changes no
mapping values or administration and requires no admin authorization.

| Adapter   | Maintained persistent key families                                                                                                                                                      | Exclusions                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| CCTP      | Domain/Chain/Caller peers; Asset(domain, remote token)                                                                                                                                  | Rail-owned nonce state; local token lists and inbound-message lists are unsupported                                  |
| Axelar    | Link/Source peers; TokenId/Token forward and reverse mappings                                                                                                                           | ITS-owned replay/manager state; numeric domains and inbound-message lists are unsupported                            |
| Allbridge | Lane/Chain peers; Asset(token, chain); Processed(message)                                                                                                                               | Remote-token list unsupported; gated inbound support remains unchanged                                               |
| Router    | Bounded `keep_alive`: route/token configuration, route limits/windows, claim/transfer payloads; existing `was_processed` and the new action view extend the supplied replay/action keys | Call each registered adapter directly for upkeep and `key_coverage`; verification reads the registered address first |

The Soroban contract spec embeds public Rust documentation in the WASM. Public API documentation
uses concise, complete summaries; full explanations remain in ordinary source comments and this
runbook. Guest exports, parameter/result types, event layouts and runtime behavior are preserved.
The same pinned Stellar CLI builds these artifacts locally and in CI under the unchanged 65,536-byte
ledger gate.

The EVM compiler profile is Solidity `0.8.28+commit.7893614a`, Cancun, 200 optimizer runs and
`viaIR=true`. The same profile is used locally and by full CI, with exact gas reports. Deployment
records and read-only verification bind the observed artifacts to this profile. The deployment
size gates are unchanged.

The adapter instance carries configuration, gas settings and the Allbridge validator; extending
it preserves those fields together. External rail contracts need their own restoration/upkeep
and are never implicitly maintained by these entrypoints. Expiration fixtures for all three
adapters verify maintained peer mappings remain usable past their previous expiry with the same
values and admin.

### Compatibility, migration, and rail gating

The active deployment remains **Stellar Testnet outbound ITS/CCTP**. All previous `AdminAction`
variants, error numbers, rail/message formats, `ActionCancelled` events, `keep_alive` and legacy
cancellation signatures remain. `BeginStorageMigration` is an appended Soroban-only variant.
The read-only proposal tool does not generate upgrades or migrations automatically. Verification
requires readable v3 schema/migration/actual-adapter views; unavailable RPC views never silently
prove legacy v1 or completed migration. ABI artifacts
for the additive EVM audit API are regenerated from Forge output. No deployment record changes
and no live activation occur here. EVM, mainnet and non-active rails remain gated pending their
independent acceptance validation. Adapter upgrade authority remains its existing admin; the
router's reviewed timelock does not silently grant control over external adapter admins.

### Host TTL inspection and monotonic discovery (#48, #51)

`restore-plan.mjs` reports `ttlState=live` and exact remaining ledger TTL from RPC `liveUntilLedgerSeq`; proven archived entries carry `ttlState=archived` and null remaining TTL. Missing or unknown evidence carries `ttlState=unavailable` and null, never a fabricated zero or a test-only guest value. Supply persistent token/flow/transfer/replay/claim `LedgerKey` XDR and a matching invocation. All request and simulation footprints are limited to 32 entries. No guest per-key TTL API is shipped because Soroban does not expose that information.

```sh
node script/stellar/discover-keys.mjs ROUTER claim 0 32 testnet
node script/stellar/discover-keys.mjs ROUTER transfer 0 32 testnet
```

Discovery uses the existing rollback-safe monotonic `claim_count` and `last_out_nonce` indexes, so no dense swap-remove list can skip keys after earlier settlements. One high-water-mark read and at most 32 record views form a page. Cursor IDs are exact decimal strings through the entire u64 range. Atomically persist each page (including unavailable record IDs) before its `nextCursor`, resume there as new records arrive, and use RPC footprint inspection/restoration for each unavailable ID. A failed view alone proves neither archival nor deletion. Existing deployments already have these indexes; bounded scanning of the same IDs provides discovery/backfill without creating another expiring guest index. `--is-view` signs and submits nothing.

### Durable replay retention and journal (#50)

Processed tombstones retain their original `Processed(route, message_id) -> bool` storage format and target 3,110,400ledgers (about 180 days at 5 seconds/ledger), clamped to the network maximum; upkeep threshold 518,400ledgers. `keep_alive_replays` accepts at most 32 exact route/32-byte identities and extends only their existing tombstones. Persistent archival makes the original invocation require restoration or reject; it never turns a processed message into a fresh payment. The expired-entry fixture proves reads do not report fresh and TTL-only restoration preserves all 32 bytes and route scoping.

Each successful processing publishes a version 1 `ReplayRecorded` journal event containing the full 32-byte identity, numeric route, processing ledger and exact timestamp. Transaction failure rolls back both tombstone and event.

```sh
node script/stellar/replay-journal.mjs RPC_URL ROUTER ledger:START > replay-page.json
node script/stellar/replay-journal.mjs RPC_URL ROUTER cursor:SAVED > replay-page-next.json
```

The tool exports at most 32 successful events per request, validates contract/route/version/identity, retains raw event XDR and emits each exact persistent `LedgerKey` for restoration planning. Persist the complete page and its cursor atomically in durable operator storage before advancing. Run continuously before the RPC event-retention window expires; if RPC rejects an old cursor/start ledger, recover the gap from trusted archival event history rather than jumping forward. The script prints a page and never marks it durably saved or writes on chain. An event is an identity index, not permission to recreate a tombstone: restore its original ledger entry, then re-simulate. Pre-upgrade tombstones remain protective but lack the new event; retain existing trusted event/footprint history for those identities.

The actual deployable router WASM was loaded into Soroban host29.0.1 and measured with 1 and 32 cold supplied tombstones (4,096 ledger initial TTL). Both batches reached exactly 3,110,400remaining ledgers, and each stored tombstone occupied 144 serialized LedgerEntry bytes. The unchanged ledger size gate also checks all artifacts. Detailed metered resources and native/full-byte archive regressions are in `test/discovery.rs`; fee/rent figures depend on network settings and the observed starting TTL, so re-simulate against the target RPC before signing upkeep.

| Supplied replay keys | Metered WASM instructions | Metered memory bytes | Memory read entries | Persistent rent ledger-bytes | TTL bump entries |
| -------------------- | ------------------------: | -------------------: | ------------------: | ---------------------------: | ---------------: |
| 1                    |                   735,323 |            1,304,496 |                   3 |                  447,307,920 |                1 |
| 32                   |                 3,847,504 |            1,575,777 |                  34 |               14,313,853,440 |               32 |

The router is initialized through its loaded WASM before measurement, so these resources cover upkeep of the supplied cold tombstones without charging the newly loaded code and instance TTL rent to upkeep. They are not a quoted network fee. The final artifact is 65,404 bytes. Reproduce with `HYPERION_MEASURE_ROUTER_WASM=$PWD/target/wasm32v1-none/release/hyperion_router.wasm cargo test -p hyperion-router discovery::measure_bounded_replay_upkeep_resources_and_exact_ttl -- --nocapture` from `soroban` after the strict repository build. CI runs this actual-WASM fixture and all 57 read-only host/CLI regressions, in addition to the complete unchanged application/security gates.

### Versioned debit quotes, archival cleanup and upgrade rehearsal

`quote_routes` on Soroban, `quote`/`quoteAll` on EVM, and the protocol package's
`planQuote`/`quoteBatch` keep their existing `RouteQuote` schemas. New consumers
opt into `quote_routes_v2`, `quoteV2`, or `planQuoteV2`. Each wraps the unchanged
legacy quote and adds the requested amount, fee, representable net, retained dust,
and prospective source debit. For valid integer arithmetic,
`requested = actual_debit + retained_dust` and `actual_debit = fee + net`.
A refused route has no debit: these fields describe the amount that arithmetic
would dispatch if the route were usable. Invalid or unknown arithmetic has an
explicit unavailable breakdown. Near-zero representable net remains a refusal;
its breakdown still conserves all input units. The breakdown excludes separately
funded provider gas; an ITS/GMP adapter using the transfer asset for gas debits
`actual_debit + gas_amount`. CCTP forwarding fees come from the burned net amount,
so the gas-funded entrypoint's post-provider-fee destination minimum remains the
final dispatch authority.

`archive_settled_claims(after, limit)` examines ascending claim IDs, with
`1 <= limit <= 32`, and returns the last examined ID. Save this cursor after each
successful transaction. A failure rolls back the entire batch. Duplicate calls
are harmless. Only settled claims with a recorded settlement timestamp at least
30 days old qualify; creation time is never a substitute for settlement time.
Pre-upgrade settled claims and expired timestamp sidecars are kept until a future
reviewed migration supplies trustworthy settlement evidence. Unsettled claims,
liability balances, token custody, and full-width replay keys are retained.

`claim_history(id)` returns `Live(id)`, `Archived(id)`, or `Unavailable`.
Read a live payload through the compatible `get_claim(id)` method.
Intentional cleanup records a permanent instance bitmap (128 IDs per word) before
removing the claim and settlement-time entries. The bitmap is retained with the
instance and refuses another settlement even if an old claim entry is restored.
`ClaimArchived` records the full settled claim and available source provenance;
operators must journal this event before RPC event retention expires. The legacy
`get_claim` view returns `ClaimNotFound` after cleanup. `Unavailable` requires RPC
inspection/restoration and is never evidence of deliberate deletion. Missing
records are skipped during cleanup; restore them and re-examine that range before
claiming complete cleanup. Keep the cursor and skipped ranges in the operator's
maintenance log. The original claim ID sequence never shrinks or reuses an ID.
Intentional archive markers allow bounded schema backfill to skip only claims
proven already paid; an unknown missing claim still aborts migration.

A local executable rehearsal uses a released router artifact and builds the
candidate from current source with the unchanged 65,536-byte deployment gate:

```sh
CARGO_BUILD_JOBS=1 script/stellar/rehearse-upgrade.sh \
  --old-wasm /path/to/released-hyperion-router.wasm
```

The fixture registers and initializes the released WASM, then creates outbound
transfers/flow windows, queued actions, settled and pending claims, provenance,
liabilities and replay IDs through that executable. A nonexistent upload hash
must leave the original executable and queued action intact. The reviewed
successful upgrade changes only the executable, upgrade queue and lifecycle audit;
all critical public records must match. New versioned views must execute through
the new WASM. The report distinguishes these intentional changes from unexpected
differences. Native re-registration is not evidence of an executable upgrade.
The artifact-dependent executable fixture is explicitly ignored in the ordinary
unit invocation; the runner supplies both artifacts and selects that fixture
with `--ignored`. Its successful real-WASM execution is separate validation.
Full explanatory prose remains in source comments and this runbook; embedded
contract documentation was compacted to preserve deployment headroom without
changing legacy argument/result layouts, executable exports, or size policy.

### Exact recorded storage cost projections

The cost projector accepts recorded ledger key XDR and RPC simulation responses.
It reports instance, persistent, code, archived and unavailable categories, exact
encoded key/data byte lengths for live entries, actual simulation resources and
exact integer resource fees. Archived byte counts remain unknown until restored.
It never multiplies guessed entry sizes by sequence high-watermarks or invents
network rent rates. Instance storage uses persistent durability; its separate
report category does not imply a separate network rent price.

```sh
# Request JSON: assumptions {cycleLedgers, ledgersPerYear}, and scenarios
# [{name, keys: [LedgerKey base64...], transaction: unsigned-envelope-base64}].
node script/stellar/storage-cost.mjs \
  --rpc https://your-rpc.example --request recorded-keysets.json > costs.json
# Replay a bounded record offline with the installed Stellar XDR codec:
node script/stellar/storage-cost.mjs --record recorded-rpc.json
# Deterministic real-XDR codec fixture with growing claim/transfer sets:
node script/stellar/storage-cost.mjs \
  --record script/stellar/fixtures/storage-cost-rpc-v2.json
```

Capture calls only `getNetwork`, `getLedgerEntries` and `simulateTransaction`;
it never signs or broadcasts. Record all footprint keys, splitting operations
into batches of at most 32 keys. Keep the captured network passphrase/protocol,
ledger, operation and declared annual/cycle assumptions with the report. Annual
projection repeats the recorded operation and prices; regenerate simulations as
state grows or network settings change. Restoration preamble fees are reported
separately; automatic restoration is flagged when included in the invocation.
Inclusion bids are excluded. Local mock RPC prices in the checked-in codec fixture
are explicitly labeled and do not describe live network pricing. Current live
production pricing and funded broadcasts require separate operator evidence.

The active deployment remains Stellar Testnet outbound ITS/CCTP. EVM and other
rails remain gated until independently validated; these local fixtures do not
activate them or publish a live deployment.

## Registry verification

Compare a read-only live snapshot with the exact protocol SDK registry revision selected for a
deployment before queueing a change:

```sh
node script/stellar/verify-registry.mjs \
  --live path/to/live-snapshot.json \
  --network stellar-testnet \
  --revision git:<full-40-character-selected-commit>
```

The command checks network identity, token identity, provider addresses and provider names. Each
field is labelled `verified` when its registry entry has primary-source provenance, `inferred` when
the entry is explicitly unconfirmed, and `unknown` when the live provider could not be read. A
mismatched address is `drift` and makes the command fail; an unavailable read is never reported as
healthy. The revision is required so a report cannot silently compare a deployment against
whichever SDK happens to be installed on the operator's machine.

The selected commit must already be available in the local repository. The verifier extracts
that commit's protocol source into a temporary directory, compiles those exact sources, and
records the commit and source digest. It never substitutes the current working tree or installed
SDK distribution. Snapshot `tokens` is an array with explicit `family`, `chain`, `representation`
and address, or Stellar `code`/`issuer`, identity fields. Entries sharing a symbol remain separate.
Provider snapshots use registry field names under `providers.cctp` and `providers.axelar-its`,
including `interchainTokenService`, `gasService`, `gateway`, and `chainName` where present.
Stellar identifiers, issuers, passphrases and provider chain names compare exactly; EVM address
casing compares semantically. Unknown and inferred fields both prevent a healthy ready report.
The input snapshot remains recorded read-only observations, not proof of public-network finality.

## Durable deployment recovery

Phase one and phase two use `deployments/stellar-<network>-operations.json`, overridable with
`HYPERION_JOURNAL`. Every signing CLI command acquires an exclusive journal lock and durably
records its canonical public intent before starting. Intent includes the actual RPC passphrase,
public source address, command arguments and uploaded WASM content hash. Local identity aliases,
object ordering and WASM file paths do not create another intent. Successful CLI completion stores
a public result and receipt digest; repeated calls return that result without signing again.
A CLI receipt is labelled `cli-success`, rather than claiming its digest is a transaction hash.

Interrupted, timed-out and failed commands remain uncertain and cannot be resubmitted. List them
with `node script/stellar/operation-journal.mjs reconcile JOURNAL.json`. After a process crash,
inspect uncertainty before explicitly removing a stale `.lock`; lock deletion never clears an
operation's uncertainty. Existing older journal versions must be preserved and reconciled before
migration. A missing queue entry or failed RPC read never proves execution. Phase two skips only
an execution with a confirmed receipt and simulates readiness as a view before reserving a
signing attempt, so a precise early timelock refusal is safely retryable after maturity.

Read-only transaction reconciliation uses a known transaction hash and the actual envelope:

```sh
node script/stellar/reconcile-transaction.mjs --rpc recovery-request.json
node script/stellar/reconcile-transaction.mjs --recorded recorded-rpc-evidence.json
```

The RPC request contains `rpcUrl`, `contractId`, `expectedHash`, `expectedNetwork` (the exact
passphrase), `expectedSender`, and complete `expectedConfig`. Configuration requires exactly
`admin`, `guardian`, `treasury`, `fee_bps`, `flow_window_ledgers`, `timelock_delay`, and `paused`.
Live mode checks `getNetwork`, retrieves `getTransaction` for that hash, derives hash/source from
its real XDR, and invokes `get_config` as a view. Missing, extra, narrowed or divergent configuration
cannot confirm the operation. Recorded mode additionally requires `observedNetwork`, `transaction`
with `envelopeXdr`, and `liveConfig`, and labels its output as recorded evidence. Asserted transaction
hash, source and network strings never replace decoding. Failed or unknown results never recommend
a replacement transaction. An operator can attach a reviewed positive transaction receipt to the
original intent with the journal's explicit `confirm` command; that command does not broadcast.

## Local activation rehearsal

`STELLAR_NETWORK=local script/stellar/rehearse-activation.sh` runs the native real router and
CCTP/Axelar adapter fixture. It checks the exact `TimelockNotReady` contract error, advances the
controlled ledger clock, executes all seven queued actions in order, links real adapter peers,
verifies token mappings/capability, and repeats phase two without executing an action twice.
The runner requires the unique successful fixture report; an unrelated command failure or zero
selected tests cannot pass the rehearsal. It signs no public-network transaction.

EVM phase two validates provider intent against recorded adapters before signing, then checks
registered token and configured router pointers immediately before enabling each route, after
those queued prerequisites have executed. Its report-only path requires the correct chain/router
and bounded uint64 IDs but starts no broadcast. Verification compares actual artifact metadata
against the deployment record. A zero-guardian policy requires complete role grant/revoke history
from before deployment plus matching live role state; unavailable or excessive history fails closed.
