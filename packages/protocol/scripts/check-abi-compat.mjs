#!/usr/bin/env node
/**
 * CLI gate for semantic ABI compatibility and compiled contract provenance.
 *
 * Usage:
 *   node scripts/check-abi-compat.mjs [--baseline <file.json>] [--proposed <file.json>]
 *                                     [--assessments <file.json>] [--json]
 *
 * With no flags, verifies that every generated module in `packages/protocol/src/abi/` remains
 * linked to its compiled Foundry artifact in `evm/out/` and satisfies the Hyperion semantic ABI
 * compatibility policy.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const evmRoot = resolve(packageRoot, "..", "..", "evm");
const artifactRoot = process.env.FOUNDRY_OUT
  ? resolve(process.env.FOUNDRY_OUT)
  : join(evmRoot, "out");
const abiDir = join(packageRoot, "src", "abi");

const TARGETS = [
  {
    contract: "HyperionRouter",
    file: "HyperionRouter.sol",
    module: "router",
    symbol: "hyperionRouterAbi",
    concrete: true,
  },
  {
    contract: "IHyperionRouter",
    file: "IHyperionRouter.sol",
    module: "routerInterface",
    symbol: "hyperionRouterInterfaceAbi",
    concrete: false,
  },
  {
    contract: "CctpAdapter",
    file: "CctpAdapter.sol",
    module: "cctpAdapter",
    symbol: "cctpAdapterAbi",
    concrete: true,
  },
  {
    contract: "AxelarItsAdapter",
    file: "AxelarItsAdapter.sol",
    module: "axelarItsAdapter",
    symbol: "axelarItsAdapterAbi",
    concrete: true,
  },
  {
    contract: "IRailAdapter",
    file: "IRailAdapter.sol",
    module: "railAdapter",
    symbol: "railAdapterAbi",
    concrete: false,
  },
  {
    contract: "IERC20",
    file: "IERC20.sol",
    module: "erc20",
    symbol: "erc20Abi",
    concrete: false,
  },
];

const PAYOUT_FUNCTIONS = new Set([
  "bridgeOut",
  "bridgeIn",
  "settleClaim",
  "pendingClaim",
  "quote",
  "quoteAll",
  "dispatch",
  "receiveMessage",
  "execute",
  "executeWithToken",
  "topUpGas",
]);

const PAYOUT_EVENTS = new Set([
  "BridgeOut",
  "BridgeIn",
  "ClaimParked",
  "ClaimSettled",
  "Dispatched",
  "InboundDelivered",
  "MessageReceived",
  "GasToppedUp",
]);

const PAYOUT_STRUCTS = new Set([
  "struct OutboundRequest",
  "struct Destination",
  "struct Origin",
  "struct PendingClaim",
  "struct RouteQuote",
  "struct TokenConfig",
  "struct AdminAction",
  "struct QueuedAction",
]);

function parseExportedAbiModule(modulePath, symbol) {
  const source = readFileSync(modulePath, "utf8");
  const marker = `export const ${symbol} = `;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`symbol ${symbol} not found in ${modulePath}`);
  }
  const jsonStart = start + marker.length;
  const end = source.lastIndexOf(" as const;");
  if (end === -1 || end <= jsonStart) {
    throw new Error(`missing "as const;" terminator in ${modulePath}`);
  }
  return JSON.parse(source.slice(jsonStart, end));
}

function readCompiledArtifact(target) {
  const fullPath = join(artifactRoot, target.file, `${target.contract}.json`);
  const parsed = JSON.parse(readFileSync(fullPath, "utf8"));
  const bytecodeHex = parsed?.bytecode?.object ?? "";
  const hasConcreteBytecode =
    typeof bytecodeHex === "string" && bytecodeHex !== "0x" && bytecodeHex.length > 2;
  const compilerVersion = parsed?.metadata?.compiler?.version;
  return {
    abi: parsed.abi,
    hasConcreteBytecode,
    compilerVersion,
  };
}

function canonicalType(param) {
  if (param.type.startsWith("tuple")) {
    const suffix = param.type.slice("tuple".length);
    const inner = (param.components ?? []).map(canonicalType).join(",");
    return `(${inner})${suffix}`;
  }
  return param.type;
}

function signatureOf(entry) {
  if (entry.type === "receive" || entry.type === "fallback") {
    return `${entry.type}()`;
  }
  const name = entry.name ?? entry.type;
  const inputs = (entry.inputs ?? []).map(canonicalType).join(",");
  return `${name}(${inputs})`;
}

function canonicalise(abi) {
  const rank = { constructor: 0, receive: 1, fallback: 2, function: 3, event: 4, error: 5 };
  return [...abi].sort((a, b) => {
    const byKind = (rank[a.type] ?? 9) - (rank[b.type] ?? 9);
    if (byKind !== 0) return byKind;
    return signatureOf(a).localeCompare(signatureOf(b));
  });
}

function touchesPayoutStruct(param) {
  const raw = (param.internalType ?? "").replace(/(\[[0-9]*\])+$/u, "").trim();
  if (PAYOUT_STRUCTS.has(raw)) return true;
  for (const child of param.components ?? []) {
    if (touchesPayoutStruct(child)) return true;
  }
  return false;
}

function isPayoutRelevant(entry) {
  if (entry.type === "function" && PAYOUT_FUNCTIONS.has(entry.name)) return true;
  if (entry.type === "event" && PAYOUT_EVENTS.has(entry.name)) return true;
  for (const param of [...(entry.inputs ?? []), ...(entry.outputs ?? [])]) {
    if (touchesPayoutStruct(param)) return true;
  }
  return false;
}

function parseArgs(argv) {
  const out = { baseline: null, proposed: null, assessments: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline") {
      out.baseline = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--proposed") {
      out.proposed = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--assessments") {
      out.assessments = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--json") {
      out.json = true;
    }
  }
  return out;
}

function compareSimpleBundles(baselineMap, proposedMap, assessments) {
  const assessmentMap = new Map();
  for (const item of assessments) {
    if (
      item &&
      typeof item.changeId === "string" &&
      typeof item.summary === "string" &&
      item.summary.trim().length > 0 &&
      Array.isArray(item.consumerSurfaces) &&
      item.consumerSurfaces.length > 0 &&
      Array.isArray(item.migrationSteps) &&
      item.migrationSteps.length > 0
    ) {
      assessmentMap.set(item.changeId, item);
    }
  }

  const breaking = [];
  const additive = [];
  const unassessed = [];
  const contracts = new Set([...Object.keys(baselineMap), ...Object.keys(proposedMap)]);

  for (const contract of [...contracts].sort()) {
    const prevAbi = baselineMap[contract];
    const nextAbi = proposedMap[contract];
    if (!prevAbi) {
      const changeId = `${contract}:function:contract:added-entry`;
      const record = { changeId, contract, detail: `added contract ABI ${contract}` };
      additive.push(record);
      if (!assessmentMap.has(changeId)) unassessed.push(record);
      continue;
    }
    if (!nextAbi) {
      breaking.push({ contract, detail: `removed contract ABI ${contract}`, payoutRelevant: true });
      continue;
    }

    const prevNonCtor = canonicalise(prevAbi).filter((e) => e.type !== "constructor");
    const nextNonCtor = canonicalise(nextAbi).filter((e) => e.type !== "constructor");
    const prevBySig = new Map(prevNonCtor.map((e) => [`${e.type}:${signatureOf(e)}`, e]));
    const nextBySig = new Map(nextNonCtor.map((e) => [`${e.type}:${signatureOf(e)}`, e]));

    for (const [key, prevEntry] of prevBySig) {
      const nextEntry = nextBySig.get(key);
      if (!nextEntry) {
        breaking.push({
          contract,
          signature: signatureOf(prevEntry),
          payoutRelevant: isPayoutRelevant(prevEntry),
          detail: `removed or incompatibly altered ${prevEntry.type} ${signatureOf(prevEntry)}`,
        });
        continue;
      }
      if (JSON.stringify(prevEntry) !== JSON.stringify(nextEntry)) {
        breaking.push({
          contract,
          signature: signatureOf(prevEntry),
          payoutRelevant: isPayoutRelevant(prevEntry) || isPayoutRelevant(nextEntry),
          detail: `schema layout changed within ${prevEntry.type} ${signatureOf(prevEntry)}`,
        });
      }
    }

    for (const [key, nextEntry] of nextBySig) {
      if (!prevBySig.has(key)) {
        const sig = signatureOf(nextEntry);
        const changeId = `${contract}:${nextEntry.type}:${sig}:added-entry`;
        const record = {
          changeId,
          contract,
          signature: sig,
          detail: `added ${nextEntry.type} ${sig}`,
        };
        additive.push(record);
        if (!assessmentMap.has(changeId)) {
          unassessed.push(record);
        }
      }
    }
  }

  return { breaking, additive, unassessed };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const provenanceIssues = [];

  const exportedMap = {};
  const compiledMap = {};

  for (const target of TARGETS) {
    const exportedAbi = parseExportedAbiModule(join(abiDir, `${target.module}.ts`), target.symbol);
    exportedMap[target.contract] = exportedAbi;

    const compiled = readCompiledArtifact(target);
    compiledMap[target.contract] = canonicalise(compiled.abi);

    if (target.concrete && !compiled.hasConcreteBytecode) {
      provenanceIssues.push(
        `${target.contract}: missing concrete bytecode in ${target.file}/${target.contract}.json`,
      );
    }
    if (compiled.compilerVersion && !String(compiled.compilerVersion).startsWith("0.8.28")) {
      provenanceIssues.push(
        `${target.contract}: compiler version ${String(compiled.compilerVersion)} does not match 0.8.28`,
      );
    }
    if (JSON.stringify(canonicalise(compiled.abi)) !== JSON.stringify(exportedAbi)) {
      provenanceIssues.push(
        `${target.contract}: exported src/abi/${target.module}.ts drifted from compiled ${target.file}`,
      );
    }
  }

  const baselineMap = args.baseline
    ? JSON.parse(readFileSync(resolve(args.baseline), "utf8"))
    : exportedMap;
  const proposedMap = args.proposed
    ? JSON.parse(readFileSync(resolve(args.proposed), "utf8"))
    : compiledMap;
  const assessments = args.assessments
    ? JSON.parse(readFileSync(resolve(args.assessments), "utf8"))
    : [];

  const diff = compareSimpleBundles(baselineMap, proposedMap, assessments);
  const passed =
    provenanceIssues.length === 0 && diff.breaking.length === 0 && diff.unassessed.length === 0;

  const summary = {
    passed,
    provenanceVerified: provenanceIssues.length === 0,
    contractsChecked: Object.keys(proposedMap).length,
    breakingCount: diff.breaking.length,
    additiveCount: diff.additive.length,
    unassessedAdditiveCount: diff.unassessed.length,
    provenanceIssues,
    breaking: diff.breaking,
    unassessedAdditive: diff.unassessed,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(
      `ABI semantic compatibility gate: ${passed ? "PASS" : "FAIL"} (${String(summary.contractsChecked)} contracts, provenance=${String(summary.provenanceVerified)}, breaking=${String(summary.breakingCount)}, additive=${String(summary.additiveCount)}, unassessed=${String(summary.unassessedAdditiveCount)})\n`,
    );
    for (const issue of provenanceIssues) {
      process.stderr.write(`  [provenance] ${issue}\n`);
    }
    for (const item of diff.breaking) {
      process.stderr.write(
        `  [breaking${item.payoutRelevant ? ":payout" : ""}] ${item.contract}: ${item.detail}\n`,
      );
    }
    for (const item of diff.unassessed) {
      process.stderr.write(
        `  [unassessed-additive] ${item.contract}: ${item.detail} (missing assessment for ${item.changeId})\n`,
      );
    }
  }

  if (!passed) {
    process.exitCode = 1;
  }
}

main();
