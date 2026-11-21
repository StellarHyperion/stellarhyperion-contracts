#!/usr/bin/env node
/**
 * Read-only CCTP v2 compatibility inspector.
 *
 * This command deliberately separates inspection from execution. Unknown message and hook
 * versions remain visible in the report, but can never be reported as executable. The parser
 * also keeps the complete nonce and hook bytes so operators can compare a provider message
 * without narrowing either value.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CCTP_LAYOUT = Object.freeze({
  header: 148,
  burnHeader: 228,
  hook: 376,
  hookMax: 42,
  messageVersion: 1,
  burnVersion: 1,
  hookVersion: 1,
});

const HOOK_KINDS = Object.freeze({ 0: "account", 1: "contract", 2: "muxed_account" });

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function readU32(bytes, offset) {
  if (offset + 4 > bytes.length) return null;
  return bytes.readUInt32BE(offset);
}

function readWord(bytes, offset) {
  if (offset + 32 > bytes.length) return null;
  return hex(bytes.subarray(offset, offset + 32));
}

function readUint256(bytes, offset) {
  const word = readWord(bytes, offset);
  return word === null ? null : BigInt(`0x${word}`).toString(10);
}

function addDiagnostic(diagnostics, code, offset, message, details = {}) {
  diagnostics.push({ code, offset, message, ...details });
}

function field(report, name, offset, reader, width, label) {
  const value = reader(report.raw, offset);
  if (value === null) {
    addDiagnostic(
      report.diagnostics,
      "TRUNCATED_FIELD",
      offset,
      `${label} is truncated at byte offset ${offset}`,
      { field: name, expectedBytes: width, availableBytes: Math.max(0, report.raw.length - offset) },
    );
  }
  report.fields[name] = value;
  return value;
}

function inspectHook(report) {
  if (report.raw.length < CCTP_LAYOUT.hook) {
    addDiagnostic(
      report.diagnostics,
      "TRUNCATED_BURN_HEADER",
      CCTP_LAYOUT.header,
      `burn message is truncated before hook offset ${CCTP_LAYOUT.hook}`,
      { expectedBytes: CCTP_LAYOUT.hook, actualBytes: report.raw.length },
    );
    return;
  }

  const hook = report.raw.subarray(CCTP_LAYOUT.hook);
  report.hook = { bytes: hex(hook), length: hook.length };
  if (hook.length < 34) {
    addDiagnostic(
      report.diagnostics,
      "TRUNCATED_HOOK",
      CCTP_LAYOUT.hook,
      `hook is ${hook.length} bytes; a supported hook is 34 or 42 bytes`,
      { expectedBytes: [34, 42], actualBytes: hook.length },
    );
    return;
  }
  if (hook.length > CCTP_LAYOUT.hookMax) {
    addDiagnostic(
      report.diagnostics,
      "OVERSIZED_HOOK",
      CCTP_LAYOUT.hook + CCTP_LAYOUT.hookMax,
      `hook exceeds the supported 42-byte maximum`,
      { expectedBytes: CCTP_LAYOUT.hookMax, actualBytes: hook.length },
    );
  } else if (hook.length !== 34 && hook.length !== 42) {
    addDiagnostic(
      report.diagnostics,
      "INVALID_HOOK_LENGTH",
      CCTP_LAYOUT.hook,
      `hook length ${hook.length} is neither 34 nor 42 bytes`,
      { expectedBytes: [34, 42], actualBytes: hook.length },
    );
  }

  report.hook.version = hook[0];
  report.hook.kindTag = hook[1];
  report.hook.kind = HOOK_KINDS[hook[1]] ?? "unknown";
  report.hook.key = hex(hook.subarray(2, 34));
  report.hook.muxedId = hook.length >= 42 ? BigInt(`0x${hex(hook.subarray(34, 42))}`).toString(10) : null;

  if (hook[0] !== CCTP_LAYOUT.hookVersion) {
    addDiagnostic(
      report.diagnostics,
      "UNSUPPORTED_HOOK_VERSION",
      CCTP_LAYOUT.hook,
      `hook version ${hook[0]} is inspectable but not executable`,
      { supported: CCTP_LAYOUT.hookVersion, actual: hook[0] },
    );
  }
  if (!(hook[1] in HOOK_KINDS)) {
    addDiagnostic(
      report.diagnostics,
      "UNKNOWN_HOOK_KIND",
      CCTP_LAYOUT.hook + 1,
      `hook kind tag ${hook[1]} is not supported`,
      { supported: Object.keys(HOOK_KINDS).map(Number), actual: hook[1] },
    );
  }
  if (hook[1] === 2 && hook.length !== 42) {
    addDiagnostic(
      report.diagnostics,
      "HOOK_KIND_LENGTH_MISMATCH",
      CCTP_LAYOUT.hook + 1,
      "muxed_account hooks must be exactly 42 bytes",
      { expectedBytes: 42, actualBytes: hook.length },
    );
  }
  if (hook[1] !== 2 && hook.length === 42) {
    addDiagnostic(
      report.diagnostics,
      "HOOK_KIND_LENGTH_MISMATCH",
      CCTP_LAYOUT.hook + 1,
      "account and contract hooks must be exactly 34 bytes",
      { expectedBytes: 34, actualBytes: hook.length },
    );
  }
  if (/^0+$/.test(report.hook.key)) {
    addDiagnostic(report.diagnostics, "ZERO_HOOK_KEY", CCTP_LAYOUT.hook + 2, "hook destination key is all zero");
  }
}

export function inspectCctpMessage(input) {
  const raw = Buffer.isBuffer(input) ? input : parseHex(input);
  const report = {
    format: "hyperion.cctp-message-inspection.v1",
    executable: true,
    rawBytes: hex(raw),
    byteLength: raw.length,
    fields: {},
    hook: null,
    diagnostics: [],
    executionRequirements: {
      messageVersion: CCTP_LAYOUT.messageVersion,
      burnVersion: CCTP_LAYOUT.burnVersion,
      hookVersion: CCTP_LAYOUT.hookVersion,
      hookLengths: [34, 42],
      finalityThresholds: [1000, 2000],
    },
    raw,
  };

  field(report, "version", 0, readU32, 4, "message version");
  field(report, "sourceDomain", 4, readU32, 4, "source domain");
  field(report, "destinationDomain", 8, readU32, 4, "destination domain");
  field(report, "nonce", 12, readWord, 32, "message nonce");
  field(report, "sender", 44, readWord, 32, "message sender");
  field(report, "recipient", 76, readWord, 32, "message recipient");
  field(report, "destinationCaller", 108, readWord, 32, "destination caller");
  field(report, "minFinalityThreshold", 140, readU32, 4, "minimum finality threshold");
  field(report, "finalityThresholdExecuted", 144, readU32, 4, "executed finality threshold");

  field(report, "burnVersion", 148, readU32, 4, "burn message version");
  field(report, "burnToken", 152, readWord, 32, "burn token");
  field(report, "mintRecipient", 184, readWord, 32, "mint recipient");
  field(report, "amount", 216, readUint256, 32, "burn amount");
  field(report, "messageSender", 248, readWord, 32, "burn message sender");
  field(report, "maxFee", 280, readUint256, 32, "maximum fee");
  field(report, "feeExecuted", 312, readUint256, 32, "executed fee");
  field(report, "expirationBlock", 344, readUint256, 32, "expiration block");
  inspectHook(report);

  if (report.fields.version !== CCTP_LAYOUT.messageVersion) {
    addDiagnostic(report.diagnostics, "UNSUPPORTED_MESSAGE_VERSION", 0, "message version is inspectable but not executable", {
      supported: CCTP_LAYOUT.messageVersion,
      actual: report.fields.version,
    });
  }
  if (report.fields.burnVersion !== CCTP_LAYOUT.burnVersion) {
    addDiagnostic(report.diagnostics, "UNSUPPORTED_BURN_VERSION", 148, "burn version is inspectable but not executable", {
      supported: CCTP_LAYOUT.burnVersion,
      actual: report.fields.burnVersion,
    });
  }
  if (report.fields.minFinalityThreshold !== null && ![1000, 2000].includes(report.fields.minFinalityThreshold)) {
    addDiagnostic(report.diagnostics, "UNSUPPORTED_MIN_FINALITY", 140, "minimum finality threshold is not supported", {
      supported: [1000, 2000],
      actual: report.fields.minFinalityThreshold,
    });
  }
  if (report.fields.finalityThresholdExecuted !== null && ![1000, 2000].includes(report.fields.finalityThresholdExecuted)) {
    addDiagnostic(report.diagnostics, "UNSUPPORTED_EXECUTED_FINALITY", 144, "executed finality threshold is not supported", {
      supported: [1000, 2000],
      actual: report.fields.finalityThresholdExecuted,
    });
  }

  report.executable = report.diagnostics.length === 0;
  delete report.raw;
  return report;
}

export function parseHex(value) {
  const text = String(value ?? "").trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (!text || !/^[0-9a-f]+$/i.test(text) || text.length % 2 !== 0) {
    throw new Error("message must be a non-empty even-length hexadecimal string");
  }
  return Buffer.from(text, "hex");
}

function usage() {
  console.log(`CCTP Message Compatibility Inspector

Usage:
  node script/stellar/inspect-cctp-message.mjs --message <hex>
  node script/stellar/inspect-cctp-message.mjs --file <path>
  cat message.hex | node script/stellar/inspect-cctp-message.mjs

Options:
  --message <hex>  Raw CCTP message bytes, with optional 0x prefix
  --file <path>    File containing raw hex (whitespace is ignored)
  --compact        Emit one-line JSON
  -h, --help       Show this help
`);
}

export function runCli(argv = process.argv) {
  let message = null;
  let file = null;
  let compact = false;
  for (let i = 2; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--message": message = argv[++i]; break;
      case "--file": file = argv[++i]; break;
      case "--compact": compact = true; break;
      case "--help": case "-h": usage(); return null;
      default: throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  if (message === null && file !== null) message = readFileSync(resolve(file), "utf8");
  if (message === null && !process.stdin.isTTY) message = readFileSync(0, "utf8");
  if (message === null) { usage(); process.exitCode = 1; return null; }
  const report = inspectCctpMessage(message);
  console.log(JSON.stringify(report, null, compact ? 0 : 2));
  if (!report.executable) process.exitCode = 1;
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli();
