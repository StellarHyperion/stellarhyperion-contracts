#!/usr/bin/env node
/**
 * Validate signed acceptance evidence files (and optionally migrate historical v1 files).
 *
 * Ensures explicit recipient, asset, exact-integer amount, and network bindings, and rejects
 * source-only or mock evidence when `--require-delivered` is passed.
 *
 * Usage:
 *   node script/stellar/validate-evidence.mjs --file <evidence.json> [--migrate-legacy] [--require-delivered] [--json]
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
    "the protocol package is not built, so acceptance evidence cannot be validated. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const { validateAcceptanceEvidence, migrateHistoricalAcceptanceEvidence } = protocol;

let filePath = "";
let migrateLegacy = false;
let requireDelivered = false;
let json = false;

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--file") {
    filePath = process.argv[i + 1] ?? "";
    i += 1;
  } else if (arg === "--migrate-legacy") {
    migrateLegacy = true;
  } else if (arg === "--require-delivered") {
    requireDelivered = true;
  } else if (arg === "--json") {
    json = true;
  } else {
    throw new Error(`unknown argument "${arg}"`);
  }
}

if (!filePath) {
  throw new Error(
    "usage: validate-evidence.mjs --file <evidence.json> [--migrate-legacy] [--require-delivered] [--json]",
  );
}

const raw = JSON.parse(readFileSync(resolve(filePath), "utf8"));
let migrationNotes = [];
let target = raw;

if (migrateLegacy) {
  const migrated = migrateHistoricalAcceptanceEvidence(raw);
  target = migrated.migrated;
  migrationNotes = migrated.migrationNotes;
}

const result = validateAcceptanceEvidence(target);
const output = { ...result, migrationNotes };

if (json) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else {
  process.stdout.write(
    `Evidence validation: valid=${String(result.valid)} classification=${result.classification} delivered=${String(result.delivered)}\n`,
  );
  for (const note of migrationNotes) {
    process.stdout.write(`  [migration] ${note}\n`);
  }
  for (const err of result.errors) {
    process.stdout.write(`  [error] ${err}\n`);
  }
}

if (!result.valid || (requireDelivered && !result.delivered)) {
  process.exit(1);
}
