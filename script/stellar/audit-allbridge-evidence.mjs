#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditAllbridgeInboundEvidence } from "../../packages/protocol/dist/index.js";

function usage() {
  process.stderr.write(
    "Usage: node script/stellar/audit-allbridge-evidence.mjs --bundle <path.json>\n",
  );
}

const args = process.argv.slice(2);
let bundlePath = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--bundle" && args[i + 1]) {
    bundlePath = args[i + 1];
    i += 1;
  } else if (args[i] === "--help" || args[i] === "-h") {
    usage();
    process.exit(0);
  }
}

if (!bundlePath) {
  usage();
  process.exit(2);
}

const raw = JSON.parse(readFileSync(resolve(bundlePath), "utf8"));
const report = auditAllbridgeInboundEvidence(raw);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.verified ? 0 : 1);
