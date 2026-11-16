#!/usr/bin/env node
/**
 * Read-only activation check comparing live Stellar treasury, guardian, router administrator, and
 * rail adapter administrators against a reviewed manifest policy.
 *
 * Requires no signing secrets and no stored CLI key: `--is-view` simulation uses a public Stellar
 * account address from the deployment record (or an offline `--snapshot` JSON fixture). Exits
 * non-zero whenever any authority disagrees with policy or when the target chain/rail is gated.
 *
 * Usage:
 *   node script/stellar/verify-authorities.mjs [--record <path>] [--policy <path>] [--snapshot <path>] [--json]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
    "the protocol package is not built, so authority policy checks cannot run. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}

const {
  ROUTE_KINDS,
  ROUTE_SLUGS,
  assertNoSecretMaterial,
  deriveNetworkAuthorityPolicy,
  extractQueuedAuthorityChanges,
  formatAuthorityConsistencyReport,
  isChainKey,
  parseAuthorityManifestPolicy,
  parseDeploymentSet,
  parseStellarAuthoritySnapshot,
  verifyAuthorityConsistency,
} = protocol;

function parseArgs(argv) {
  const network = process.env.STELLAR_NETWORK || "testnet";
  const opts = {
    network,
    recordPath:
      process.env.HYPERION_RECORD ||
      resolve(contractsRoot, "deployments", `stellar-${network}-phase1.json`),
    policyPath: process.env.HYPERION_AUTHORITY_POLICY || null,
    snapshotPath: process.env.HYPERION_AUTHORITY_SNAPSHOT || null,
    json: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--record") {
      opts.recordPath = argv[++i] ?? "";
    } else if (arg === "--policy") {
      opts.policyPath = argv[++i] ?? null;
    } else if (arg === "--snapshot") {
      opts.snapshotPath = argv[++i] ?? null;
    } else if (arg === "--network") {
      opts.network = argv[++i] ?? opts.network;
    } else if (arg === "--json") {
      opts.json = true;
    } else {
      throw new Error(`unknown argument "${String(arg)}"`);
    }
  }
  return opts;
}

function readJsonFile(filePath, label) {
  const content = readFileSync(resolve(filePath), "utf8");
  assertNoSecretMaterial(content, label);
  return JSON.parse(content);
}

function selectPublicSimulationAccount(rawNetworkRecord, policy) {
  const candidates = [
    process.env.STELLAR_PUBLIC_SOURCE,
    rawNetworkRecord?.deployer,
    policy.admin,
    policy.treasury,
    policy.guardian,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      assertNoSecretMaterial(candidate, "STELLAR_PUBLIC_SOURCE");
      if (candidate.startsWith("G")) return candidate;
    }
  }
  throw new Error(
    "could not find a public G-account in the deployment record to run secret-free --is-view simulation; set STELLAR_PUBLIC_SOURCE to any funded public G-account",
  );
}

function invokeStellarView(contractId, network, sourceAccount, fnArgs) {
  const out = execFileSync(
    "stellar",
    [
      "contract",
      "invoke",
      "--id",
      contractId,
      "--source-account",
      sourceAccount,
      "--network",
      network,
      "--is-view",
      "--",
      ...fnArgs,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out.trim());
}

function readLiveStellarSnapshot(policy, rawNetworkRecord, network) {
  const sourceAccount = selectPublicSimulationAccount(rawNetworkRecord, policy);
  const routerCfg = invokeStellarView(policy.router, network, sourceAccount, [
    "get_config",
  ]);
  const routerTreasuryView = String(
    invokeStellarView(policy.router, network, sourceAccount, ["treasury"]),
  );

  const adapters = {};
  for (const kind of ROUTE_KINDS) {
    const adapterAddress = policy.adapters[kind];
    if (adapterAddress === undefined) continue;
    const adapterCfg = invokeStellarView(
      adapterAddress,
      network,
      sourceAccount,
      ["get_config"],
    );
    adapters[kind] = {
      address: adapterAddress,
      admin: String(adapterCfg.admin),
      router: String(adapterCfg.router),
    };
  }

  const queueCount = Number(
    invokeStellarView(policy.router, network, sourceAccount, ["queue_count"]),
  );
  const queuedRaw = [];
  for (let id = 1; id <= queueCount; id += 1) {
    try {
      const entry = invokeStellarView(policy.router, network, sourceAccount, [
        "get_queued",
        "--id",
        String(id),
      ]);
      if (entry) queuedRaw.push(entry);
    } catch {
      // Executed or cancelled actions are removed from persistent storage.
    }
  }

  return {
    family: "stellar",
    chain: policy.chain,
    router: policy.router,
    routerConfig: {
      admin: String(routerCfg.admin),
      guardian: String(routerCfg.guardian),
      treasury: String(routerCfg.treasury),
      paused: Boolean(routerCfg.paused),
    },
    routerTreasuryView,
    adapters,
    pendingAuthorityActions: extractQueuedAuthorityChanges(queuedRaw),
  };
}

const opts = parseArgs(process.argv);
if (process.env.STELLAR_IDENTITY) {
  assertNoSecretMaterial(process.env.STELLAR_IDENTITY, "STELLAR_IDENTITY");
}

const rawManifest = readJsonFile(opts.recordPath, opts.recordPath);
const deploymentSet = parseDeploymentSet(rawManifest);
const chainKeys = Object.keys(deploymentSet.networks).filter(isChainKey);
if (chainKeys.length !== 1) {
  throw new Error(
    `expected exactly 1 network in ${opts.recordPath}, found ${String(chainKeys.length)}`,
  );
}
const chainKey = chainKeys[0];
const deployment = deploymentSet.networks[chainKey];
const rawNetworkRecord = rawManifest.networks?.[chainKey] ?? {};

const policySet =
  opts.policyPath !== null
    ? parseAuthorityManifestPolicy(
        readJsonFile(opts.policyPath, opts.policyPath),
        deploymentSet,
      )
    : {
        networks: {
          [chainKey]: deriveNetworkAuthorityPolicy(
            deployment,
            rawNetworkRecord.authorityPolicy,
            `$.networks.${chainKey}.authorityPolicy`,
          ),
        },
      };

const policy = policySet.networks[chainKey];
if (!policy) {
  throw new Error(`no authority policy entry found for chain "${chainKey}"`);
}

const live =
  opts.snapshotPath !== null
    ? parseStellarAuthoritySnapshot(
        readJsonFile(opts.snapshotPath, opts.snapshotPath),
        chainKey,
        policy.router,
      )
    : readLiveStellarSnapshot(policy, rawNetworkRecord, opts.network);

const report = verifyAuthorityConsistency({
  policy,
  live,
  deployment,
  deployer:
    typeof rawNetworkRecord.deployer === "string"
      ? rawNetworkRecord.deployer
      : undefined,
});

if (opts.json) {
  const adapterSlugSummary = {};
  for (const kind of ROUTE_KINDS) {
    if (policy.adapterAdmins[kind] !== undefined) {
      adapterSlugSummary[ROUTE_SLUGS[kind]] = policy.adapterAdmins[kind];
    }
  }
  process.stdout.write(
    `${JSON.stringify({ ...report, adapterAdmins: adapterSlugSummary }, null, 2)}\n`,
  );
} else {
  process.stdout.write(`${formatAuthorityConsistencyReport(report)}\n`);
}

if (!report.ready) {
  process.exit(1);
}
