#!/usr/bin/env node
/**
 * Read-only CLI joining encoded Hyperion Axelar notes with candidate ITS payment receipts.
 *
 * Reads local fixture or indexer JSON snapshots, evaluates recipient, token id, exact integer
 * amount, and full command identity without relying on display nonces, emits the structured JSON
 * reconciliation report to stdout, and exits non-zero whenever any record remains unverified.
 *
 * Usage:
 *   node script/stellar/reconcile-axelar-notes.mjs --input <fixture.json>
 *   node script/stellar/reconcile-axelar-notes.mjs <fixture.json>
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "..", "..");

function parseInputArg(argv) {
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node script/stellar/reconcile-axelar-notes.mjs [--input] <fixture.json>\n",
      );
      process.exit(0);
    }
    if (arg === "--input") {
      const next = argv[i + 1];
      if (next === undefined || next === "") {
        throw new Error("--input requires a path to a JSON fixture file");
      }
      return next;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  throw new Error("usage: reconcile-axelar-notes.mjs [--input] <fixture.json>");
}

function toBigIntField(value, fieldName) {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return BigInt(value);
  throw new Error(`${fieldName} must be a base-10 integer string`);
}

function normalizePair(rawPair, index) {
  if (rawPair === null || typeof rawPair !== "object") {
    throw new Error(`pairs[${String(index)}] must be an object`);
  }
  const rawSource = rawPair.source;
  if (rawSource === null || typeof rawSource !== "object") {
    throw new Error(`pairs[${String(index)}].source must be an object`);
  }

  const source = {
    recordId: String(rawSource.recordId ?? `record-${String(index)}`),
    direction: rawSource.direction,
    rawReferences: rawSource.rawReferences,
    tokenId: rawSource.tokenId,
    sourceAmount: toBigIntField(
      rawSource.sourceAmount,
      `pairs[${String(index)}].source.sourceAmount`,
    ),
    ...(rawSource.sourceDecimals !== undefined
      ? { sourceDecimals: rawSource.sourceDecimals }
      : {}),
    ...(rawSource.destinationDecimals !== undefined
      ? { destinationDecimals: rawSource.destinationDecimals }
      : {}),
    ...(rawSource.expectedDestinationAmount !== undefined
      ? {
          expectedDestinationAmount: toBigIntField(
            rawSource.expectedDestinationAmount,
            `pairs[${String(index)}].source.expectedDestinationAmount`,
          ),
        }
      : {}),
  };

  const rawCandidates = Array.isArray(rawPair.candidates)
    ? rawPair.candidates
    : [];
  const candidates = rawCandidates.map((item, candidateIndex) => ({
    receiptId: String(item.receiptId ?? `receipt-${String(candidateIndex)}`),
    rawReferences: item.rawReferences,
    tokenId: item.tokenId,
    recipient: String(item.recipient ?? ""),
    amount: toBigIntField(
      item.amount,
      `pairs[${String(index)}].candidates[${String(candidateIndex)}].amount`,
    ),
    executed: Boolean(item.executed),
    ...(item.observedDisplayNonce !== undefined
      ? {
          observedDisplayNonce: toBigIntField(
            item.observedDisplayNonce,
            `pairs[${String(index)}].candidates[${String(candidateIndex)}].observedDisplayNonce`,
          ),
        }
      : {}),
  }));

  return { source, candidates };
}

const inputPath = parseInputArg(process.argv);

let protocol;
try {
  protocol = await import(
    pathToFileURL(resolve(contractsRoot, "packages/protocol/dist/index.js"))
      .href
  );
} catch (cause) {
  throw new Error(
    "the protocol package is not built, so notes cannot be reconciled. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const rawJson = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
const rawPairs = Array.isArray(rawJson) ? rawJson : rawJson?.pairs;
if (!Array.isArray(rawPairs)) {
  throw new Error(
    "fixture JSON must be an array of pairs or an object with a `pairs` array",
  );
}

const normalizedPairs = rawPairs.map((pair, index) =>
  normalizePair(pair, index),
);
const report = protocol.reconcileAxelarBatch(normalizedPairs);

const serialized = JSON.stringify(
  report,
  (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  2,
);
process.stdout.write(`${serialized}\n`);
process.exit(report.allVerified ? 0 : 1);
