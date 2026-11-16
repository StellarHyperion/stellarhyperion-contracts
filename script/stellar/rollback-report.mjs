#!/usr/bin/env node
/**
 * Generate a strictly read-only upgrade rollback feasibility report.
 *
 * Compares the active deployment manifest against a previous manifest, evidence file, or migration
 * descriptor and checks storage schema migrations, persistent key compatibility, safety invariants,
 * active route entrypoints, old/new WASM hashes, and required governance authorities.
 *
 * Never signs, queues, or broadcasts an upgrade or rollback transaction.
 *
 * Usage:
 *   node script/stellar/rollback-report.mjs \
 *     --current deployments/stellar-testnet-phase1.json \
 *     --previous deployments/evidence/2026-10-28-paid-its.json \
 *     [--spec path/to/migrations.json] [--chain stellar-testnet] [--json] [--allow-unsupported]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "..", "..");

const FORBIDDEN_EXECUTION_FLAGS = new Set([
  "--execute",
  "--broadcast",
  "--send",
  "--sign",
  "--identity",
  "--secret-key",
  "--source-account",
]);

function parseArgs(argv) {
  let currentPath;
  let previousPath;
  let specPath;
  let chainKey = "stellar-testnet";
  let json = false;
  let allowUnsupported = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FORBIDDEN_EXECUTION_FLAGS.has(arg)) {
      throw new Error(
        `refusing "${arg}": rollback-report is strictly read-only and never signs or executes upgrades`,
      );
    }
    if (arg === "--current") {
      currentPath = argv[++i];
    } else if (arg === "--previous") {
      previousPath = argv[++i];
    } else if (arg === "--spec") {
      specPath = argv[++i];
    } else if (arg === "--chain") {
      chainKey = argv[++i] ?? "";
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--allow-unsupported") {
      allowUnsupported = true;
    } else {
      throw new Error(`unknown argument "${String(arg)}"`);
    }
  }

  if (!currentPath || (!previousPath && !specPath)) {
    throw new Error(
      "usage: rollback-report.mjs --current <manifest.json> --previous <record-or-evidence.json> [--spec <migrations.json>] [--chain <chain>] [--json]",
    );
  }

  return {
    currentPath: resolve(currentPath),
    previousPath: previousPath ? resolve(previousPath) : undefined,
    specPath: specPath ? resolve(specPath) : undefined,
    chainKey,
    json,
    allowUnsupported,
  };
}

let protocol;
try {
  protocol = await import(
    pathToFileURL(resolve(contractsRoot, "packages/protocol/dist/index.js"))
      .href
  );
} catch (cause) {
  throw new Error(
    "the protocol package is not built. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const {
  evaluateRollbackFeasibility,
  formatRollbackFeasibilityReport,
  isChainKey,
  parseRollbackReference,
} = protocol;

const opts = parseArgs(process.argv);
if (!isChainKey(opts.chainKey)) {
  throw new Error(`unknown Hyperion chain key "${opts.chainKey}"`);
}

const currentDeploymentSet = JSON.parse(readFileSync(opts.currentPath, "utf8"));
const prevRef = opts.previousPath
  ? parseRollbackReference(JSON.parse(readFileSync(opts.previousPath, "utf8")))
  : {};
const specRef = opts.specPath
  ? parseRollbackReference(JSON.parse(readFileSync(opts.specPath, "utf8")))
  : {};

const mergedTargetBuilds = {
  ...(prevRef.targetBuilds ?? {}),
  ...(specRef.targetBuilds ?? {}),
};
const mergedCurrentBuilds = {
  ...(prevRef.currentBuilds ?? {}),
  ...(specRef.currentBuilds ?? {}),
};
const mergedAdapterAdmins = {
  ...(prevRef.adapterAdmins ?? {}),
  ...(specRef.adapterAdmins ?? {}),
};

const report = evaluateRollbackFeasibility({
  chain: opts.chainKey,
  currentDeploymentSet,
  previousDeploymentSet:
    specRef.previousDeploymentSet ?? prevRef.previousDeploymentSet,
  currentBuilds:
    Object.keys(mergedCurrentBuilds).length > 0
      ? mergedCurrentBuilds
      : undefined,
  targetBuilds:
    Object.keys(mergedTargetBuilds).length > 0 ? mergedTargetBuilds : undefined,
  adapterAdmins:
    Object.keys(mergedAdapterAdmins).length > 0
      ? mergedAdapterAdmins
      : undefined,
  enabledRoutes: specRef.enabledRoutes ?? prevRef.enabledRoutes,
});

if (opts.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatRollbackFeasibilityReport(report)}\n`);
}

if (!report.overallFeasible && !opts.allowUnsupported) {
  process.exit(1);
}
