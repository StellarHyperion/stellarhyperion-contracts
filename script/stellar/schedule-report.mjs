#!/usr/bin/env node
/**
 * Print a read-only, deterministic timelock scheduling and activation sequence report.
 *
 * Accepts either:
 *   1. An offline schedule or evidence snapshot:
 *        node script/stellar/schedule-report.mjs --input <snapshot.json> [--chain-time <seconds>] [--json]
 *   2. A phase-one Stellar deployment record, reading the latest closed ledger timestamp and
 *      queued router entries via unsigned read-only queries (`--send=no`):
 *        node script/stellar/schedule-report.mjs --record <deployments/stellar-testnet-phase1.json> [--json]
 *
 * Never reads local wall-clock time (`Date.now()`), never touches signing keys, and never writes
 * to disk or broadcasts transactions.
 */
import { execFileSync } from "node:child_process";
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
    "the protocol package is not built, so the timelock report cannot run. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const {
  buildTimelockScheduleReport,
  formatTimelockScheduleReport,
  parseTimelockScheduleInput,
  chain,
  isStellarChain,
} = protocol;

function usage() {
  return (
    "usage:\n" +
    "  node script/stellar/schedule-report.mjs --input <snapshot.json> [--chain-time <seconds>] [--json]\n" +
    "  node script/stellar/schedule-report.mjs --record <record.json> [--rpc-url <url>] [--horizon-url <url>] [--json]"
  );
}

function parseArgs(argv) {
  let inputPath = null;
  let recordPath = null;
  let chainTimeOverride;
  let rpcUrl = null;
  let horizonUrl = null;
  let jsonOutput = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      inputPath = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--record") {
      recordPath = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--chain-time") {
      const raw = argv[i + 1];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw new Error("--chain-time requires a non-negative integer timestamp in seconds");
      }
      chainTimeOverride = Number(raw);
      i += 1;
    } else if (arg === "--rpc-url") {
      rpcUrl = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--horizon-url") {
      horizonUrl = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${String(arg)}"\n${usage()}`);
    }
  }

  if ((inputPath === null && recordPath === null) || (inputPath !== null && recordPath !== null)) {
    throw new Error(`specify exactly one of --input or --record\n${usage()}`);
  }

  return { inputPath, recordPath, chainTimeOverride, rpcUrl, horizonUrl, jsonOutput };
}

async function fetchClosedLedgerTimestampSeconds(stellarChain, rpcOverride, horizonOverride) {
  const rpcEndpoint = rpcOverride ?? stellarChain.defaultRpcUrl;
  const horizonEndpoint = (horizonOverride ?? stellarChain.horizonUrl).replace(/\/+$/, "");

  const latestResp = await fetch(rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  if (!latestResp.ok) {
    throw new Error(`Soroban RPC ${rpcEndpoint} returned HTTP ${String(latestResp.status)}`);
  }
  const latestBody = await latestResp.json();
  const sequence = latestBody?.result?.sequence;
  if (typeof sequence !== "number" || !Number.isInteger(sequence)) {
    throw new Error("Soroban RPC getLatestLedger did not return an integer sequence");
  }

  const closeTime = latestBody?.result?.closeTime;
  if (typeof closeTime === "number" && Number.isSafeInteger(closeTime) && closeTime >= 0) {
    return closeTime;
  }
  if (typeof closeTime === "string" && /^\d+$/.test(closeTime)) {
    return Number(closeTime);
  }

  const ledgerResp = await fetch(`${horizonEndpoint}/ledgers/${String(sequence)}`);
  if (!ledgerResp.ok) {
    throw new Error(
      `Horizon ${horizonEndpoint}/ledgers/${String(sequence)} returned HTTP ${String(ledgerResp.status)}`,
    );
  }
  const ledgerBody = await ledgerResp.json();
  const closedAt = ledgerBody?.closed_at;
  if (typeof closedAt !== "string") {
    throw new Error("Horizon ledger response missing closed_at timestamp");
  }
  const parsedMs = Date.parse(closedAt);
  if (Number.isNaN(parsedMs)) {
    throw new Error(`invalid Horizon closed_at timestamp "${closedAt}"`);
  }
  return Math.floor(parsedMs / 1000);
}

function readOnlyStellarInvoke(router, networkFlag, rpcUrl, fnName, extraArgs = []) {
  const cliArgs = [
    "contract",
    "invoke",
    "--id",
    router,
    "--network",
    networkFlag,
    "--send=no",
  ];
  if (rpcUrl !== null) {
    cliArgs.push("--rpc-url", rpcUrl);
  }
  cliArgs.push("--", fnName, ...extraArgs);
  const raw = execFileSync("stellar", cliArgs, {
    cwd: contractsRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return JSON.parse(raw);
}

async function loadFromLiveRecord(recordPath, chainTimeOverride, rpcOverride, horizonOverride) {
  const rawRecord = JSON.parse(readFileSync(resolve(recordPath), "utf8"));
  const networkKeys = Object.keys(rawRecord?.networks ?? {});
  if (networkKeys.length !== 1) {
    throw new Error(
      `expected exactly one network in ${recordPath}, found ${String(networkKeys.length)}`,
    );
  }
  const chainKey = networkKeys[0];
  const networkRecord = rawRecord.networks[chainKey];
  const chainMeta = chain(chainKey);
  if (!isStellarChain(chainMeta)) {
    throw new Error(`--record live querying supports Stellar records, got "${chainKey}"`);
  }

  const networkFlag = chainKey === "stellar-testnet" ? "testnet" : "mainnet";
  const chainTimestampSeconds =
    chainTimeOverride !== undefined
      ? chainTimeOverride
      : await fetchClosedLedgerTimestampSeconds(chainMeta, rpcOverride, horizonOverride);

  const countRaw = readOnlyStellarInvoke(
    networkRecord.router,
    networkFlag,
    rpcOverride,
    "queue_count",
  );
  const count = Number(countRaw);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`unexpected queue_count response: ${String(countRaw)}`);
  }

  const entries = [];
  for (let id = 1; id <= count; id += 1) {
    try {
      const queued = readOnlyStellarInvoke(
        networkRecord.router,
        networkFlag,
        rpcOverride,
        "get_queued",
        ["--id", String(id)],
      );
      if (queued !== null && typeof queued === "object") {
        entries.push(queued);
      }
    } catch {
      // Cleared from Soroban router storage once executed or cancelled.
    }
  }

  return parseTimelockScheduleInput({
    chain: chainKey,
    router: networkRecord.router,
    chainTimestampSeconds,
    timelockDelaySeconds: networkRecord.timelockDelay,
    entries,
  });
}

const opts = parseArgs(process.argv.slice(2));
const scheduleInput =
  opts.inputPath !== null
    ? parseTimelockScheduleInput(
        JSON.parse(readFileSync(resolve(opts.inputPath), "utf8")),
        opts.chainTimeOverride,
      )
    : await loadFromLiveRecord(
        opts.recordPath,
        opts.chainTimeOverride,
        opts.rpcUrl,
        opts.horizonUrl,
      );

const report = buildTimelockScheduleReport(scheduleInput);
if (opts.jsonOutput) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(formatTimelockScheduleReport(report));
}
