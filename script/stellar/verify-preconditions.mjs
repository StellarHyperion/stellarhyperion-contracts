#!/usr/bin/env node
/**
 * Verify provider-link and destination-precision preconditions immediately before executing
 * queued router activation proposals.
 *
 * Usage:
 *   node script/stellar/verify-preconditions.mjs --input <preconditions.json> [--json]
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
    "the protocol package is not built, so execution preconditions cannot be verified. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const { verifyExecutionPreconditions, formatPreconditionReport } = protocol;

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
  throw new Error("usage: verify-preconditions.mjs --input <preconditions.json> [--json]");
}

const input = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
const report = verifyExecutionPreconditions(input);

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatPreconditionReport(report)}\n`);
}

if (!report.ready) {
  process.exit(1);
}
