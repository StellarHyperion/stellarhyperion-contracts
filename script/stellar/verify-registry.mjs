#!/usr/bin/env node
/**
 * Read-only contract-to-registry verification CLI.
 *
 * Compares live token, provider, and domain observations against an explicitly selected SDK
 * registry revision. Marks inferred defaults separately from primary-source verified fields,
 * rejects changed provider addresses, and keeps unreachable or unsupported reads as unknown
 * (exiting non-zero unless every check matched).
 *
 * Usage:
 *   node script/stellar/verify-registry.mjs --revision <rev> --live <observation.json> [--stellar-cctp <ref.json>] [--json]
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
    "the protocol package is not built, so registry verification cannot run. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const { buildSdkRegistrySnapshot, verifyContractAgainstRegistry, formatRegistryVerificationReport } =
  protocol;

function parseArgs(argv) {
  let revision = "";
  let livePath = "";
  let stellarCctpPath = "";
  let json = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--revision") {
      revision = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--live") {
      livePath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--stellar-cctp") {
      stellarCctpPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }

  if (!revision || !livePath) {
    throw new Error(
      "usage: verify-registry.mjs --revision <rev> --live <observation.json> [--stellar-cctp <ref.json>] [--json]",
    );
  }
  return { revision, livePath, stellarCctpPath, json };
}

const args = parseArgs(process.argv);
const liveObservation = JSON.parse(readFileSync(resolve(args.livePath), "utf8"));
const stellarCctp = args.stellarCctpPath
  ? JSON.parse(readFileSync(resolve(args.stellarCctpPath), "utf8"))
  : undefined;

const snapshot = buildSdkRegistrySnapshot(args.revision, stellarCctp);
const report = verifyContractAgainstRegistry(liveObservation, snapshot);

if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatRegistryVerificationReport(report)}\n`);
}

if (!report.healthy) {
  process.exit(1);
}
