#!/usr/bin/env node
/**
 * Pre-signing deployment artifact WASM size, headroom, and simulated resource admission CLI.
 *
 * Inspects candidate WASM binaries (or a candidate manifest fixture), compares every contract
 * against its previous recorded deployment build, records active ledger protocol assumptions
 * explicitly, and fails with exit code 1 BEFORE any signing or upload step if any artifact is
 * oversized, invalid, or exceeds simulated resource budgets.
 *
 * Usage:
 *   node script/stellar/admission-report.mjs \
 *     --wasm-dir soroban/target/wasm32v1-none/release \
 *     [--previous deployments/stellar-testnet-phase1.json] \
 *     [--simulation path/to/sim.json] \
 *     [--assumptions path/to/assumptions.json] \
 *     [--chain stellar-testnet] [--out report.json] [--json]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "..", "..");

const FORBIDDEN_SIGNING_FLAGS = new Set([
  "--identity",
  "--secret-key",
  "--sign",
  "--broadcast",
]);

function parseArgs(argv) {
  let wasmDir;
  let candidatesPath;
  let previousPath;
  let simulationPath;
  let assumptionsPath;
  let outPath;
  let chainKey = "stellar-testnet";
  let json = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FORBIDDEN_SIGNING_FLAGS.has(arg)) {
      throw new Error(
        `refusing "${arg}": admission-report runs strictly pre-signing and never accesses keys`,
      );
    }
    if (arg === "--wasm-dir") {
      wasmDir = argv[++i];
    } else if (arg === "--candidates") {
      candidatesPath = argv[++i];
    } else if (arg === "--previous") {
      previousPath = argv[++i];
    } else if (arg === "--simulation") {
      simulationPath = argv[++i];
    } else if (arg === "--assumptions") {
      assumptionsPath = argv[++i];
    } else if (arg === "--out") {
      outPath = argv[++i];
    } else if (arg === "--chain") {
      chainKey = argv[++i] ?? "";
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`unknown argument "${String(arg)}"`);
    }
  }

  if (!wasmDir && !candidatesPath) {
    throw new Error(
      "usage: admission-report.mjs (--wasm-dir <dir> | --candidates <json>) [--previous <manifest.json>] [--simulation <sim.json>] [--assumptions <json>] [--chain <chain>] [--out <file>] [--json]",
    );
  }

  return {
    wasmDir: wasmDir ? resolve(wasmDir) : undefined,
    candidatesPath: candidatesPath ? resolve(candidatesPath) : undefined,
    previousPath: previousPath ? resolve(previousPath) : undefined,
    simulationPath: simulationPath ? resolve(simulationPath) : undefined,
    assumptionsPath: assumptionsPath ? resolve(assumptionsPath) : undefined,
    outPath: outPath ? resolve(outPath) : undefined,
    chainKey,
    json,
  };
}

let protocol;
try {
  protocol = await import(
    pathToFileURL(resolve(contractsRoot, "packages/protocol/dist/index.js"))
      .href
  );
} catch (cause) {
  throw new Error(
    "the protocol package is not built. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const {
  ADMISSION_ARTIFACT_FILENAMES,
  buildResourceAdmissionReport,
  formatResourceAdmissionReport,
  isChainKey,
} = protocol;

const opts = parseArgs(process.argv);
if (!isChainKey(opts.chainKey)) {
  throw new Error(`unknown Hyperion chain key "${opts.chainKey}"`);
}

const simulations = opts.simulationPath
  ? JSON.parse(readFileSync(opts.simulationPath, "utf8"))
  : {};
const assumptionsPayload = opts.assumptionsPath
  ? JSON.parse(readFileSync(opts.assumptionsPath, "utf8"))
  : undefined;

let candidates;
if (opts.candidatesPath) {
  candidates = JSON.parse(readFileSync(opts.candidatesPath, "utf8"));
} else {
  candidates = [];
  for (const [artifactName, fileName] of Object.entries(
    ADMISSION_ARTIFACT_FILENAMES,
  )) {
    const fullPath = resolve(opts.wasmDir, fileName);
    if (!existsSync(fullPath)) {
      throw new Error(
        `missing required deployment WASM artifact before signing: ${fullPath}`,
      );
    }
    const rawBuf = readFileSync(fullPath);
    const wasmBytes = new Uint8Array(
      rawBuf.buffer,
      rawBuf.byteOffset,
      rawBuf.byteLength,
    );
    const codeHash = createHash("sha256").update(rawBuf).digest("hex");
    candidates.push({
      name: artifactName,
      fileName,
      sizeBytes: wasmBytes.byteLength,
      codeHash,
      wasmBytes,
      simulatedResources: simulations[artifactName],
    });
  }
}

let previousDeploymentSet;
let previousArtifactSizes;
if (opts.previousPath && existsSync(opts.previousPath)) {
  const parsedPrev = JSON.parse(readFileSync(opts.previousPath, "utf8"));
  previousDeploymentSet = parsedPrev;
  const netPrev = parsedPrev?.networks?.[opts.chainKey];
  if (netPrev?.artifactSizes && typeof netPrev.artifactSizes === "object") {
    previousArtifactSizes = netPrev.artifactSizes;
  }
}

const report = buildResourceAdmissionReport({
  chain: opts.chainKey,
  candidates,
  previousDeploymentSet,
  previousArtifactSizes,
  protocolAssumptions: assumptionsPayload,
  recordedAt:
    process.env.HYPERION_ADMISSION_TIMESTAMP || new Date().toISOString(),
});

if (opts.outPath) {
  mkdirSync(dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (opts.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatResourceAdmissionReport(report)}\n`);
}

if (!report.admitted) {
  process.exit(1);
}
