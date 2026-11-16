#!/usr/bin/env node
/**
 * Assemble or update a network-bound Stellar deployment record and refuse to write it if any
 * observation disagrees with the target network.
 *
 * Every artifact hash, contract id, initialization position, and timelocked activation position is
 * bound to the network passphrase actually observed on the RPC endpoint (or supplied explicitly in
 * offline rehearsals), rather than copied blindly from static chain metadata. Wrong-network
 * observations fail before touching disk, initialization and activation positions remain separate,
 * and atomic rename prevents half-written manifests.
 *
 * Usage:
 *   node write-record.mjs <path> [--phase init|activate]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "..", "..");

let protocol;
try {
  protocol = await import(
    pathToFileURL(resolve(contractsRoot, "packages/protocol/dist/index.js"))
      .href
  );
} catch (cause) {
  throw new Error(
    "the protocol package is not built, so the record cannot be validated. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const {
  RouteKind,
  assertStellarNetworkMatch,
  buildNetworkBoundStellarRecord,
  chain,
  isChainKey,
  isStellarChain,
  parseNetworkBoundDeploymentSet,
  recordStellarActivationPosition,
  tryRouteFromSlug,
} = protocol;

function parseArgs(argv) {
  let outPath;
  let phase = process.env.HYPERION_RECORD_PHASE || "init";
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--phase") {
      phase = argv[++i] ?? "";
    } else if (!arg.startsWith("-") && outPath === undefined) {
      outPath = arg;
    } else {
      throw new Error(`unknown argument "${String(arg)}"`);
    }
  }
  if (!outPath)
    throw new Error("usage: write-record.mjs <path> [--phase init|activate]");
  if (phase !== "init" && phase !== "activate") {
    throw new Error(`expected --phase init or activate, got "${phase}"`);
  }
  return { outPath: resolve(outPath), phase };
}

function need(name) {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`${name} is not set`);
  return value;
}

/** Hyperion's key for the network the CLI was pointed at. */
function chainKeyFor(network) {
  if (network === "testnet") return "stellar-testnet";
  if (network === "mainnet" || network === "public") return "stellar";
  throw new Error(`no Hyperion chain key for the network "${network}"`);
}

const { outPath, phase } = parseArgs(process.argv);
const network = need("STELLAR_NETWORK");
const chainKey = chainKeyFor(network);
const entry = chain(chainKey);
if (!isStellarChain(entry))
  throw new Error(`${chainKey} is not a Stellar chain`);

const rpcUrl = process.env.STELLAR_RPC_URL || entry.defaultRpcUrl;

async function rpcCall(method) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  });
  if (!response.ok) {
    throw new Error(
      `the rpc at ${rpcUrl} answered ${String(response.status)} for ${method}`,
    );
  }
  const body = await response.json();
  if (!body?.result || typeof body.result !== "object") {
    throw new Error(`the rpc at ${rpcUrl} returned no result for ${method}`);
  }
  return body.result;
}

async function observeNetworkIdentity() {
  if (process.env.HYPERION_OFFLINE_OBSERVATION === "1") {
    const offlinePassphrase = need("OBSERVED_NETWORK_PASSPHRASE");
    const offlineChainRaw = process.env.OBSERVED_CHAIN_KEY;
    if (
      offlineChainRaw !== undefined &&
      offlineChainRaw !== "" &&
      !isChainKey(offlineChainRaw)
    ) {
      throw new Error(
        `OBSERVED_CHAIN_KEY "${offlineChainRaw}" is not a known Hyperion chain key`,
      );
    }
    const protoVer = process.env.OBSERVED_PROTOCOL_VERSION
      ? Number(process.env.OBSERVED_PROTOCOL_VERSION)
      : undefined;
    return {
      observedNetworkPassphrase: offlinePassphrase,
      observedRpcChain: offlineChainRaw || undefined,
      rpcProtocolVersion: protoVer,
    };
  }

  const netResult = await rpcCall("getNetwork");
  if (
    typeof netResult.passphrase !== "string" ||
    netResult.passphrase.length === 0
  ) {
    throw new Error(`the rpc at ${rpcUrl} did not report a network passphrase`);
  }
  if (
    process.env.OBSERVED_NETWORK_PASSPHRASE &&
    process.env.OBSERVED_NETWORK_PASSPHRASE !== netResult.passphrase
  ) {
    throw new Error(
      `OBSERVED_NETWORK_PASSPHRASE "${process.env.OBSERVED_NETWORK_PASSPHRASE}" disagrees with RPC getNetwork passphrase "${netResult.passphrase}"`,
    );
  }
  return {
    observedNetworkPassphrase: netResult.passphrase,
    observedRpcChain: undefined,
    rpcProtocolVersion:
      typeof netResult.protocolVersion === "number"
        ? netResult.protocolVersion
        : undefined,
  };
}

async function resolveLedger(explicitEnvNames) {
  for (const name of explicitEnvNames) {
    if (process.env[name]) return Number(process.env[name]);
  }
  const latest = await rpcCall("getLatestLedger");
  if (typeof latest.sequence !== "number") {
    throw new Error("the rpc did not return a ledger sequence");
  }
  return latest.sequence;
}

function commit() {
  if (process.env.HYPERION_COMMIT) return process.env.HYPERION_COMMIT;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: contractsRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function writeAtomically(targetPath, record) {
  parseNetworkBoundDeploymentSet(record);
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${String(process.pid)}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tempPath, targetPath);
}

const netObs = await observeNetworkIdentity();
assertStellarNetworkMatch(
  chainKey,
  netObs.observedNetworkPassphrase,
  "$.networkBinding.observedNetworkPassphrase",
  netObs.observedRpcChain,
);

const nowIso =
  process.env.HYPERION_RECORD_TIMESTAMP || new Date().toISOString();

if (phase === "activate") {
  const existing = JSON.parse(readFileSync(outPath, "utf8"));
  const activationLedger = await resolveLedger([
    "HYPERION_ACTIVATION_LEDGER",
    "ACTIVATION_LEDGER",
  ]);
  const actionTxHashes = JSON.parse(
    process.env.ACTIVATION_TX_HASHES_JSON ?? "[]",
  );
  const railSlug = process.env.HYPERION_ACTIVATION_RAIL;
  const rail = railSlug ? tryRouteFromSlug(railSlug) : undefined;
  if (railSlug && rail === null) {
    throw new Error(
      `unknown rail slug "${railSlug}" in HYPERION_ACTIVATION_RAIL`,
    );
  }

  const updated = recordStellarActivationPosition(existing, {
    targetChain: chainKey,
    observedNetworkPassphrase: netObs.observedNetworkPassphrase,
    ledger: activationLedger,
    timestamp: nowIso,
    txHash: process.env.HYPERION_ACTIVATION_TX_HASH || undefined,
    actionTxHashes: actionTxHashes.length > 0 ? actionTxHashes : undefined,
    rail: rail ?? undefined,
  });

  writeAtomically(outPath, updated);
  process.stdout.write(
    `validated and updated activation position: ${outPath}\n`,
  );
  process.exit(0);
}

const asset = need("HYPERION_ASSET");
const [code, issuer] = asset.split(":");
if (code === undefined || issuer === undefined) {
  throw new Error(`HYPERION_ASSET should read CODE:ISSUER, got "${asset}"`);
}

const peerChainRaw = need("HYPERION_PEER_CHAIN");
if (!isChainKey(peerChainRaw)) {
  throw new Error(
    `HYPERION_PEER_CHAIN "${peerChainRaw}" is not a known Hyperion chain key`,
  );
}

const adapters = {};
const routeKinds = [];
if (process.env.HYPERION_CCTP) {
  adapters[RouteKind.Cctp] = process.env.HYPERION_CCTP;
  routeKinds.push(RouteKind.Cctp);
}
if (process.env.HYPERION_AXELAR) {
  adapters[RouteKind.AxelarIts] = process.env.HYPERION_AXELAR;
  routeKinds.push(RouteKind.AxelarIts);
}

const artifacts = [];
if (process.env.ROUTER_HASH) {
  artifacts.push({
    name: "router",
    codeHash: process.env.ROUTER_HASH,
    observedNetworkPassphrase:
      process.env.ROUTER_OBSERVED_PASSPHRASE ||
      netObs.observedNetworkPassphrase,
    uploadTxHash: process.env.ROUTER_UPLOAD_TX_HASH || undefined,
    deployTxHash: process.env.ROUTER_DEPLOY_TX_HASH || undefined,
  });
}
if (process.env.CCTP_HASH && process.env.HYPERION_CCTP) {
  artifacts.push({
    name: "adapter-cctp",
    codeHash: process.env.CCTP_HASH,
    observedNetworkPassphrase:
      process.env.CCTP_OBSERVED_PASSPHRASE || netObs.observedNetworkPassphrase,
    uploadTxHash: process.env.CCTP_UPLOAD_TX_HASH || undefined,
    deployTxHash: process.env.CCTP_DEPLOY_TX_HASH || undefined,
  });
}
if (process.env.AXELAR_HASH && process.env.HYPERION_AXELAR) {
  artifacts.push({
    name: "adapter-axelar",
    codeHash: process.env.AXELAR_HASH,
    observedNetworkPassphrase:
      process.env.AXELAR_OBSERVED_PASSPHRASE ||
      netObs.observedNetworkPassphrase,
    uploadTxHash: process.env.AXELAR_UPLOAD_TX_HASH || undefined,
    deployTxHash: process.env.AXELAR_DEPLOY_TX_HASH || undefined,
  });
}

const initLedger = await resolveLedger([
  "HYPERION_ROUTER_LEDGER",
  "ROUTER_LEDGER",
  "STELLAR_START_LEDGER",
]);

const record = buildNetworkBoundStellarRecord({
  targetChain: chainKey,
  observedNetworkPassphrase: netObs.observedNetworkPassphrase,
  observedRpcChain: netObs.observedRpcChain,
  rpcProtocolVersion: netObs.rpcProtocolVersion,
  verifiedAt: nowIso,
  generatedAt: nowIso,
  router: need("HYPERION_ROUTER"),
  adapters,
  tokens: {
    [code]: {
      sacId: need("HYPERION_SAC"),
      code,
      issuer,
      decimals: 7,
      flowLimit: need("HYPERION_TOKEN_FLOW_LIMIT"),
      routes: routeKinds,
    },
  },
  treasury: need("HYPERION_TREASURY"),
  admin: need("HYPERION_ADMIN"),
  guardian: need("HYPERION_GUARDIAN"),
  feeBps: Number(need("HYPERION_FEE_BPS")),
  flowWindow: Number(need("HYPERION_FLOW_WINDOW_LEDGERS")),
  timelockDelay: Number(need("HYPERION_TIMELOCK_DELAY")),
  commit: commit(),
  deployer: need("HYPERION_DEPLOYER"),
  peerChain: peerChainRaw,
  queuedActionIds: JSON.parse(process.env.QUEUE_IDS_JSON ?? "[]"),
  queuedActions: JSON.parse(process.env.QUEUE_WHAT_JSON ?? "[]"),
  artifacts,
  initialization: {
    ledger: initLedger,
    timestamp: nowIso,
    txHash: process.env.ROUTER_INIT_TX_HASH || undefined,
    observedNetworkPassphrase:
      process.env.ROUTER_INIT_OBSERVED_PASSPHRASE ||
      netObs.observedNetworkPassphrase,
  },
  activation: null,
});

writeAtomically(outPath, record);
process.stdout.write(`validated and written: ${outPath}\n`);
