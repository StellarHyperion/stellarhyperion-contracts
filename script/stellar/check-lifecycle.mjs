#!/usr/bin/env node
/**
 * Guard operational scripts against accidentally activating, linking, or monitoring a deprecated
 * or archived deployment manifest.
 *
 * Usage:
 *   node script/stellar/check-lifecycle.mjs --record <path> [--operation <name>] [--allow-retired]
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
    "the protocol package is not built, so deployment lifecycle cannot be checked. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const { parseDeploymentSet, assertActiveDeployment, warningForDeployment } = protocol;

let recordPath = "";
let operation = "operational command";
let allowRetired = false;

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--record") {
    recordPath = process.argv[i + 1] ?? "";
    i += 1;
  } else if (arg === "--operation") {
    operation = process.argv[i + 1] ?? operation;
    i += 1;
  } else if (arg === "--allow-retired") {
    allowRetired = true;
  } else {
    throw new Error(`unknown argument "${arg}"`);
  }
}

if (!recordPath) {
  throw new Error(
    "usage: check-lifecycle.mjs --record <path> [--operation <name>] [--allow-retired]",
  );
}

const parsed = parseDeploymentSet(JSON.parse(readFileSync(resolve(recordPath), "utf8")));
for (const dep of Object.values(parsed.networks)) {
  if (!dep) continue;
  const warning = warningForDeployment(dep);
  if (warning !== null) {
    if (allowRetired) {
      process.stderr.write(`WARNING: ${warning.message}\n`);
    } else {
      assertActiveDeployment(dep, operation);
    }
  }
}
