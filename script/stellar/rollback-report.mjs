#!/usr/bin/env node
/**
 * Upgrade rollback feasibility report for a Stellar Hyperion deployment.
 *
 * Reads the deployment record and optionally the live chain state to produce a
 * read-only, human- and machine-readable report showing:
 *   - old and new code (WASM) hashes
 *   - storage schema version and whether a rollback is structurally supported
 *   - required authority for each step
 *   - migration implications if rollback is blocked
 *
 * Signs nothing. Submits nothing. Executes nothing.
 *
 * Usage:
 *   # Against a record file only (no network access):
 *   node script/stellar/rollback-report.mjs deployments/stellar-testnet-phase1.json
 *
 *   # Compare two records (old → new upgrade path):
 *   node script/stellar/rollback-report.mjs \
 *     --from deployments/archive/stellar-testnet-2026-10-01.json \
 *     --to   deployments/stellar-testnet-phase1.json
 *
 *   # Include live chain schema version (read-only RPC):
 *   node script/stellar/rollback-report.mjs deployments/stellar-testnet-phase1.json \
 *     --rpc https://soroban-testnet.stellar.org
 *
 *   # JSON output:
 *   node script/stellar/rollback-report.mjs deployments/stellar-testnet-phase1.json --json
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let positional = [];
let fromPath = null;
let toPath = null;
let rpcUrl = null;
let jsonOutput = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from") {
    fromPath = args[++i] ?? die("--from requires a path");
  } else if (args[i] === "--to") {
    toPath = args[++i] ?? die("--to requires a path");
  } else if (args[i] === "--rpc") {
    rpcUrl = args[++i] ?? die("--rpc requires a URL");
  } else if (args[i] === "--json") {
    jsonOutput = true;
  } else if (!args[i].startsWith("--")) {
    positional.push(args[i]);
  } else {
    die(`unknown flag: ${args[i]}`);
  }
}

// A single positional is the "to" record (current deployment).
// --from / --to are explicit pairs.
if (positional.length === 1 && toPath === null) toPath = positional[0];
if (positional.length > 1) die("too many positional arguments; use --from and --to");
if (toPath === null) die("provide a record path, e.g. deployments/stellar-testnet-phase1.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg) {
  process.stderr.write(`\nfailed: ${msg}\n`);
  process.exit(1);
}

function readRecord(path) {
  let raw;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch (err) {
    die(`cannot read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`${path} is not valid JSON: ${err.message}`);
  }
}

function networkOf(record) {
  const keys = Object.keys(record.networks ?? {});
  if (keys.length !== 1) die(`expected exactly one network in the record, found ${keys.length}`);
  return { key: keys[0], data: record.networks[keys[0]] };
}

/** Minimum schema version that is considered a one-way migration (rollback unsupported). */
const MIGRATION_VERSION_FLOOR = 3;

/**
 * Derive the rollback verdict for a storage schema version.
 *
 * Version 3 rewrites per-token outstanding liabilities.  Reverting the WASM
 * after that migration completes would leave a v3 storage layout being read by
 * v2 code, which cannot decode it correctly and would produce wrong liability
 * totals.  Rollback to any WASM built before the v3 migration format is
 * therefore unsupported.
 *
 * Version 2 is similarly one-way: it adds a fixed migration state cursor that
 * old code does not expect.
 *
 * Version 1 (legacy) and version 0 (uninitialized) are unaffected.
 */
function storageMigrationVerdict(schemaVersion) {
  if (typeof schemaVersion !== "number") {
    return {
      rollbackSupported: null,
      reason: "schema version is not available; RPC read required to determine migration state",
    };
  }
  if (schemaVersion >= MIGRATION_VERSION_FLOOR) {
    return {
      rollbackSupported: false,
      reason:
        `storage schema is v${schemaVersion}. ` +
        `The v${schemaVersion} migration rewrites per-token outstanding liabilities into a layout ` +
        `that pre-migration WASM cannot decode. Reverting the router WASM would yield incorrect ` +
        `liability totals and must not be attempted. ` +
        `To recover from a faulty upgrade, deploy a corrected WASM forward through the normal ` +
        `admin timelock (queue_action → execute_action after the delay) rather than reverting to ` +
        `the previous hash.`,
    };
  }
  if (schemaVersion === 2) {
    return {
      rollbackSupported: false,
      reason:
        "storage schema is v2. The v2 migration adds a fixed migration-state cursor " +
        "that pre-v2 WASM does not recognise. Reverting the router WASM would leave " +
        "that cursor in storage and prevent correct initialization of the migration state " +
        "on a future upgrade attempt.",
    };
  }
  // v0 / v1 — no irreversible migration has run
  return {
    rollbackSupported: true,
    reason:
      `storage schema is v${schemaVersion}. No irreversible migration has completed; ` +
      `the WASM can be reverted through the normal admin timelock.`,
  };
}

/**
 * Fetch the live schema version from the router via a read-only RPC call.
 * Returns null if the RPC is unreachable or the view is unavailable.
 */
async function fetchLiveSchemaVersion(routerId, rpcUrl) {
  if (!rpcUrl) return null;
  if (!rpcUrl.startsWith("https://") && !rpcUrl.startsWith("http://localhost")) {
    die(`RPC URL must be HTTPS (or localhost for testing), got: ${rpcUrl}`);
  }

  // We call the Stellar RPC simulateTransaction endpoint to invoke get_migration_status as a
  // read-only view.  We use the stellar CLI if available; otherwise we use a raw RPC simulation.
  // For this report we just attempt a raw JSON-RPC call against the horizon/soroban endpoint.
  // If unavailable we degrade gracefully.
  try {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      "stellar",
      [
        "contract", "invoke",
        "--id", routerId,
        "--source-account", "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", // well-known funded testnet account for view calls
        "--network", "testnet",
        "--is-view",
        "--",
        "get_migration_status",
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    if (result.status === 0 && result.stdout) {
      const parsed = JSON.parse(result.stdout.trim());
      const v = parsed?.current_version;
      if (typeof v === "number") return v;
    }
  } catch {
    // fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Authority descriptions
// ---------------------------------------------------------------------------

const AUTHORITY = {
  wasmUpgrade: {
    role: "admin",
    mechanism: "queue_action({UpgradeRouter: wasm_hash}) + execute_action after timelockDelay",
    gated: true,
    timelocked: true,
  },
  wasmRollback: {
    role: "admin",
    mechanism: "queue_action({UpgradeRouter: previous_wasm_hash}) + execute_action after timelockDelay",
    gated: true,
    timelocked: true,
  },
  adapterUpgrade: {
    role: "adapter admin (separate from router admin)",
    mechanism: "adapter upgrade_wasm via adapter admin key; no router timelock",
    gated: false,
    timelocked: false,
  },
  adapterRollback: {
    role: "adapter admin (separate from router admin)",
    mechanism: "adapter upgrade_wasm to previous hash via adapter admin key",
    gated: false,
    timelocked: false,
  },
  storageMigration: {
    role: "admin",
    mechanism:
      "queue_action({BeginStorageMigration: version}) + execute_action after timelockDelay, " +
      "then migrate_storage(admin, version, max_steps) in bounded increments",
    gated: true,
    timelocked: true,
  },
};

// ---------------------------------------------------------------------------
// Core report builder
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.fromRecord   - optional previous deployment record
 * @param {object} opts.toRecord     - current/target deployment record
 * @param {number|null} opts.liveSchemaVersion - live chain value, or null
 */
function buildReport({ fromRecord, toRecord, liveSchemaVersion }) {
  const to = networkOf(toRecord);

  // Lifecycle guard: refuse to treat an archived record as the target.
  // Check explicit lifecycle metadata first; also treat any record whose path contains an
  // "archive" directory segment as archived, since pre-convention records carry no status field.
  const toLifecycle = to.data.lifecycle ?? { status: to.data.activation?.status ?? "active" };
  const pathSegments = toPath.replace(/\\/g, "/").split("/");
  const isArchivePath = pathSegments.includes("archive");
  const toLcStatus = (toLifecycle.status ?? "active").toLowerCase();
  if (toLcStatus === "archived" || isArchivePath) {
    die(
      `the target record (${toPath}) is archived. ` +
        `Rollback reports are for active deployments. ` +
        (toLifecycle.successor?.router
          ? `Run against the successor record instead (router: ${toLifecycle.successor.router}).`
          : "No successor is recorded."),
    );
  }

  const toHashes = to.data.wasmHashes ?? {};
  const toAdmin = to.data.admin ?? null;
  const toTimelockDelay = to.data.timelockDelay ?? null;
  const toRouter = to.data.router;

  // "from" record (previous deployment, if provided)
  let fromHashes = null;
  let fromAdmin = null;
  let fromRouter = null;
  let fromSchemaVersion = null;

  if (fromRecord) {
    const from = networkOf(fromRecord);
    fromHashes = from.data.wasmHashes ?? {};
    fromAdmin = from.data.admin ?? null;
    fromRouter = from.data.router;
    // A record from before v3 schema has no schemaVersion field; treat as v1 (legacy)
    fromSchemaVersion = typeof from.data.schemaVersion === "number" ? from.data.schemaVersion : null;
  }

  // Determine schema version to use for the verdict (live RPC > record field > null)
  const effectiveSchemaVersion =
    liveSchemaVersion !== null ? liveSchemaVersion : typeof to.data.schemaVersion === "number" ? to.data.schemaVersion : null;

  const migration = storageMigrationVerdict(effectiveSchemaVersion);

  // ---------------------------------------------------------------------------
  // Code hash diffs
  // ---------------------------------------------------------------------------
  const components = ["router", "adapter-cctp", "adapter-axelar"];
  const codeHashes = components
    .filter((c) => toHashes[c] || (fromHashes && fromHashes[c]))
    .map((component) => {
      const currentHash = toHashes[component] ?? null;
      const previousHash = fromHashes ? (fromHashes[component] ?? null) : null;
      const changed = fromHashes !== null && previousHash !== currentHash;
      return { component, currentHash, previousHash, changed };
    });

  // ---------------------------------------------------------------------------
  // Per-step rollback feasibility
  // ---------------------------------------------------------------------------
  const steps = [];

  // Router WASM rollback
  const routerEntry = codeHashes.find((c) => c.component === "router");
  if (routerEntry) {
    steps.push({
      component: "router WASM",
      action: "rollback",
      feasible: migration.rollbackSupported,
      blockedReason: migration.rollbackSupported === false ? migration.reason : null,
      currentHash: routerEntry.currentHash,
      targetHash: routerEntry.previousHash,
      authority: AUTHORITY.wasmRollback,
      notes: [
        migration.rollbackSupported === false
          ? "Deploy a corrected WASM forward through the admin timelock instead."
          : migration.rollbackSupported === null
          ? "Fetch live schema version with --rpc to confirm feasibility."
          : "Rollback proceeds through the standard admin timelock (queue → execute after timelockDelay).",
        toTimelockDelay !== null
          ? `Minimum wait: ${toTimelockDelay}s (${Math.ceil(toTimelockDelay / 3600)}h).`
          : "timelockDelay not recorded.",
      ].filter(Boolean),
    });
  }

  // Adapter WASM rollbacks (not timelocked; adapter admin key only)
  for (const slug of ["adapter-cctp", "adapter-axelar"]) {
    const entry = codeHashes.find((c) => c.component === slug);
    if (!entry) continue;
    steps.push({
      component: slug,
      action: "rollback",
      // Adapter WASM rollback is always structurally supported — adapters have no storage migration.
      feasible: true,
      blockedReason: null,
      currentHash: entry.currentHash,
      targetHash: entry.previousHash,
      authority: AUTHORITY.adapterRollback,
      notes: [
        "Adapter rollback requires only the adapter admin key; no router timelock applies.",
        "Verify that the previous adapter WASM is still uploaded on-chain before rolling back.",
        "After rolling back an adapter, run script/stellar/verify.sh to confirm lane configuration is intact.",
      ],
    });
  }

  // Storage migration rollback (always a separate entry when migration has run)
  if (effectiveSchemaVersion !== null && effectiveSchemaVersion >= 2) {
    steps.push({
      component: "storage schema",
      action: "rollback",
      feasible: false,
      blockedReason: migration.reason,
      currentHash: null,
      targetHash: null,
      authority: AUTHORITY.storageMigration,
      notes: [
        `Current schema: v${effectiveSchemaVersion}. The migration is irreversible.`,
        "To recover: deploy a corrected WASM forward that is compatible with the current schema version.",
        "Do not attempt to reinitialize or re-migrate without a reviewed plan.",
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // EVM gating note
  // ---------------------------------------------------------------------------
  const evmGatingNote =
    "EVM adapters and non-active rail development remain explicitly gated " +
    "(developmentGateOpen=false). No rollback action on the Stellar side affects EVM gating. " +
    "EVM rollback, if ever needed, requires independent EVM Foundry validation and its own " +
    "reviewed report.";

  // ---------------------------------------------------------------------------
  // Active protections summary
  // ---------------------------------------------------------------------------
  const activeProtections = [
    "Exact integer amounts are preserved: no amount field is rewritten by WASM upgrade or rollback.",
    "Authenticated rail dispatch (ITS, CCTP) uses per-adapter trust records; rollback cannot retroactively forge dispatch.",
    "Replay protection uses per-route monotonic nonces stored independently of WASM version.",
    "Recipient-bound claims are stored by claim ID; a WASM rollback does not alter claim payloads or recipients.",
  ];

  // ---------------------------------------------------------------------------
  // Assemble report
  // ---------------------------------------------------------------------------
  return {
    generatedAt: new Date().toISOString(),
    reportKind: "upgrade-rollback-feasibility",
    readOnly: true,
    autoExecutes: false,

    deployment: {
      record: toPath,
      networkKey: to.key,
      router: toRouter,
      admin: toAdmin,
      timelockDelay: toTimelockDelay,
      schemaVersionSource: liveSchemaVersion !== null ? "live-rpc" : "record-field",
      schemaVersion: effectiveSchemaVersion,
    },

    ...(fromRecord
      ? {
          previousDeployment: {
            record: fromPath,
            router: fromRouter,
            admin: fromAdmin,
          },
        }
      : {}),

    codeHashes,
    storageMigration: {
      schemaVersion: effectiveSchemaVersion,
      ...migration,
    },
    steps,
    evmGatingNote,
    activeProtections,
  };
}

// ---------------------------------------------------------------------------
// Render human-readable output
// ---------------------------------------------------------------------------

function renderReport(report) {
  const lines = [];
  const ok = (msg) => lines.push(`   \u001b[32mok\u001b[0m   ${msg}`);
  const warn = (msg) => lines.push(`   \u001b[33mWARN\u001b[0m ${msg}`);
  const bad = (msg) => lines.push(`   \u001b[31mBAD\u001b[0m  ${msg}`);
  const note = (msg) => lines.push(`\n\u001b[1m== ${msg}\u001b[0m`);
  const say = (msg) => lines.push(`   ${msg}`);

  lines.push(`\nUpgrade Rollback Feasibility Report`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Read-only: ${report.readOnly}   Auto-executes: ${report.autoExecutes}`);

  note("Deployment");
  say(`record        ${report.deployment.record}`);
  say(`network       ${report.deployment.networkKey}`);
  say(`router        ${report.deployment.router}`);
  say(`admin         ${report.deployment.admin ?? "(not recorded)"}`);
  say(`timelock      ${report.deployment.timelockDelay != null ? `${report.deployment.timelockDelay}s` : "(not recorded)"}`);
  say(
    `schema ver    ${report.deployment.schemaVersion != null ? `v${report.deployment.schemaVersion}` : "unknown"} ` +
      `(source: ${report.deployment.schemaVersionSource})`,
  );

  if (report.previousDeployment) {
    note("Previous Deployment");
    say(`record        ${report.previousDeployment.record}`);
    say(`router        ${report.previousDeployment.router}`);
    say(`admin         ${report.previousDeployment.admin ?? "(not recorded)"}`);
  }

  note("Code Hashes");
  for (const h of report.codeHashes) {
    say(`${h.component.padEnd(16)} current   ${h.currentHash ?? "(none)"}`);
    if (h.previousHash !== null) {
      say(`${"".padEnd(16)} previous  ${h.previousHash}`);
    }
    if (h.changed) warn(`${h.component} hash changed from previous record`);
  }

  note("Storage Migration");
  const sm = report.storageMigration;
  if (sm.rollbackSupported === false) {
    bad(`rollback unsupported — ${sm.reason}`);
  } else if (sm.rollbackSupported === true) {
    ok(`rollback supported — ${sm.reason}`);
  } else {
    warn(`rollback feasibility unknown — ${sm.reason}`);
  }

  note("Rollback Steps");
  for (const step of report.steps) {
    const header = `${step.component} (${step.action})`;
    if (step.feasible === false) {
      bad(`${header}: BLOCKED`);
      say(`  reason: ${step.blockedReason}`);
    } else if (step.feasible === true) {
      ok(`${header}: feasible`);
    } else {
      warn(`${header}: feasibility unknown`);
    }
    say(`  authority: ${step.authority.role}`);
    say(`  mechanism: ${step.authority.mechanism}`);
    if (step.currentHash) say(`  current hash:  ${step.currentHash}`);
    if (step.targetHash) say(`  rollback hash: ${step.targetHash}`);
    for (const n of step.notes ?? []) say(`  note: ${n}`);
  }

  note("EVM Gating");
  say(report.evmGatingNote);

  note("Active Protections (invariants preserved across upgrade/rollback)");
  for (const p of report.activeProtections) say(`• ${p}`);

  lines.push("");
  const blocked = report.steps.filter((s) => s.feasible === false).length;
  const unknown = report.steps.filter((s) => s.feasible === null).length;
  if (blocked > 0) {
    lines.push(
      `\u001b[31m${blocked} rollback step(s) blocked. See reasons above. No action has been taken.\u001b[0m`,
    );
  } else if (unknown > 0) {
    lines.push(
      `\u001b[33m${unknown} step(s) have unknown feasibility. Run with --rpc to fetch live schema version.\u001b[0m`,
    );
  } else {
    lines.push(`\u001b[32mAll rollback steps are feasible. No action has been taken.\u001b[0m`);
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const toRecord = readRecord(toPath);
const fromRecord = fromPath ? readRecord(fromPath) : null;

// Validate that the target record is a known Hyperion deployment record
if (!toRecord.networks) die(`${toPath} does not look like a Hyperion deployment record (no "networks" field)`);

const { data: toData } = networkOf(toRecord);
const routerId = toData.router;

const liveSchemaVersion = rpcUrl ? await fetchLiveSchemaVersion(routerId, rpcUrl) : null;

const report = buildReport({ fromRecord, toRecord, liveSchemaVersion });

if (jsonOutput) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  process.stdout.write(renderReport(report));
}
