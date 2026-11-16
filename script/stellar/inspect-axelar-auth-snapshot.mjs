#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  buildPaidDispatchAuthSnapshot,
  inspectPaidDispatchAuthTree,
} from "../../packages/protocol/dist/index.js";

function reviveBigInts(value) {
  if (typeof value === "string" && /^[0-9]+n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  if (Array.isArray(value)) return value.map(reviveBigInts);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reviveBigInts(v)]));
  }
  return value;
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node script/stellar/inspect-axelar-auth-snapshot.mjs <fixture.json>");
  process.exit(2);
}

const parsed = reviveBigInts(JSON.parse(readFileSync(inputPath, "utf8")));
const tree = parsed.actualTree ?? buildPaidDispatchAuthSnapshot(parsed.intent);
const result = inspectPaidDispatchAuthTree(tree, parsed.intent);
console.log(
  JSON.stringify(
    result,
    (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v),
    2,
  ),
);
process.exit(result.safeToSign ? 0 : 1);
