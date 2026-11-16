#!/usr/bin/env node
/**
 * Read-only public transaction reconciliation CLI for interrupted activation runs.
 *
 * Reads an input bundle containing `intents`, `observations`, and `liveState`, evaluates
 * confirmed/failed/unknown outcomes without signing or broadcasting anything, and exits non-zero
 * whenever drift, foreign hashes, unknown transactions, or unapplied failures remain.
 *
 * Usage:
 *   node script/stellar/reconcile.mjs --input <reconcile-bundle.json> [--json]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "..", "..");

let protocol;
try {
  protocol = await import(resolve(contractsRoot, "packages/protocol/dist/index.js"));
} catch (cause) {
  throw new Error(
    "the protocol package is not built, so transaction reconciliation cannot run. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const { reconcileActivationTransactions, formatReconciliationReport } = protocol;

let inputPath = "";
let json = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--input") {
    inputPath = process.argv[i + 1] ?? "";
    i += 1;
  } else if (arg === "--json") {
    json = true;
  } else {
    throw new Error(`unknown argument "${arg}"`);
  }
}

if (!inputPath) {
  throw new Error("usage: reconcile.mjs --input <reconcile-bundle.json> [--json]");
}

const bundle = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
const report = reconcileActivationTransactions(
  bundle.intents ?? [],
  bundle.observations ?? [],
  bundle.liveState ?? { reachable: false },
);

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatReconciliationReport(report)}\n`);
}

if (!report.healthy) {
  process.exit(1);
}
