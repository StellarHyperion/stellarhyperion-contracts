#!/usr/bin/env node
/**
 * Assemble a Stellar deployment record and refuse to write it if it does not hold together.
 *
 * The validation is the point. A deployment record is read later by the keeper, the indexer and the
 * frontend, and an address with a transposed character parses fine as a string, survives a cast
 * without complaint, and becomes a transfer to nobody. So the record is built here and handed to
 * the same `parseDeploymentSet` those three use, which checks every contract id against the real
 * strkey codec, checks every rail name against the real route list, and names the field it choked
 * on. A malformed record never reaches disk.
 *
 * Deprecation: a record may be marked archived by setting HYPERION_STATUS=archived together with
 * HYPERION_SUCCESSOR_ROUTER (the router that replaces it) and HYPERION_ARCHIVE_REASON. An archived
 * record keeps every historical field, including queued actions and deployedAt, so the evidence of
 * what happened is never discarded. Its status is recorded in parsed metadata (`status`,
 * `successor`), so consumers can tell active and archived records apart without string matching,
 * and an archived record is refused as an activation target by the caller of this script.
 *
 * Reads its inputs from the environment because its caller is a shell script and marshalling two
 * dozen values through argv would be worse. Writes nothing but the file it was asked for, and
 * nothing it writes came from a secret: only the deployer's public address appears.
 *
 * Usage: node write-record.mjs <path>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "..", "..");

let protocol;
try {
  protocol = await import(resolve(contractsRoot, "packages/protocol/dist/index.js"));
} catch (cause) {
  throw new Error(
    "the protocol package is not built, so the record cannot be validated. Run:\n" +
      "  cd packages/protocol && npm install && npm run build\n" +
      `(${String(cause)})`,
  );
}
const { parseDeploymentSet, DEPLOYMENT_SCHEMA_VERSION, chain, isStellarChain } = protocol;

const out = process.argv[2];
if (out === undefined) throw new Error("usage: write-record.mjs <path>");

function need(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** Hyperion's key for the network the CLI was pointed at. */
function chainKeyFor(network) {
  if (network === "testnet" || network === "futurenet") return "stellar-testnet";
  if (network === "mainnet" || network === "public") return "stellar";
  throw new Error(`no Hyperion chain key for the network "${network}"`);
}

const network = need("STELLAR_NETWORK");
const chainKey = chainKeyFor(network);
const entry = chain(chainKey);
if (!isStellarChain(entry)) throw new Error(`${chainKey} is not a Stellar chain`);

/**
 * The ledger the deployment landed in, asked of the network rather than guessed.
 *
 * Worth a round trip: it is the only value in the record that lets somebody line the deployment up
 * against the chain's own history, and a wrong one makes an indexer start from the wrong place.
 */
async function latestLedger() {
  const response = await fetch(entry.defaultRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  if (!response.ok) throw new Error(`the rpc at ${entry.defaultRpcUrl} answered ${String(response.status)}`);
  const body = await response.json();
  const sequence = body?.result?.sequence;
  if (typeof sequence !== "number") throw new Error("the rpc did not return a ledger sequence");
  return sequence;
}

/** The commit the wasm was built from. The only thing tying a contract id to a source tree. */
function commit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: contractsRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Storage migration status for rollback feasibility.
 *
 * Written into the record so rollback-report.mjs can reason about schema compatibility without
 * a live RPC call. The live chain value always takes precedence when --rpc is supplied; this
 * field is the best available static evidence.
 *
 * HYPERION_SCHEMA_VERSION: integer (0–N) from get_migration_status.current_version after the
 *   deployment has completed and been verified. Leave unset during initial deployment; the record
 *   will carry an unknown schema version and rollback-report.mjs will request an --rpc fetch.
 *
 * HYPERION_ROLLBACK_SUPPORTED: "true" / "false" / unset. Set to "false" with
 *   HYPERION_ROLLBACK_REASON when recording a one-way migration. If unset, the report tool
 *   determines feasibility from the schema version. Explicit "false" always wins.
 *
 * HYPERION_ROLLBACK_REASON: required when HYPERION_ROLLBACK_SUPPORTED=false. Must describe
 *   why rollback is not supported (e.g. "v3 storage migration completed").
 */
function storageMigration() {
  const rawVersion = process.env.HYPERION_SCHEMA_VERSION;
  const rawSupported = process.env.HYPERION_ROLLBACK_SUPPORTED;
  const reason = process.env.HYPERION_ROLLBACK_REASON ?? null;

  const schemaVersion = rawVersion !== undefined && rawVersion !== "" ? Number(rawVersion) : null;
  if (schemaVersion !== null && (!Number.isInteger(schemaVersion) || schemaVersion < 0)) {
    throw new Error(`HYPERION_SCHEMA_VERSION must be a non-negative integer, got "${rawVersion}"`);
  }

  if (rawSupported === "false") {
    if (!reason) {
      throw new Error(
        "HYPERION_ROLLBACK_REASON is required when HYPERION_ROLLBACK_SUPPORTED=false",
      );
    }
    return { schemaVersion, rollbackSupported: false, reason };
  }
  if (rawSupported === "true") {
    return { schemaVersion, rollbackSupported: true };
  }
  if (rawSupported !== undefined && rawSupported !== "") {
    throw new Error(
      `HYPERION_ROLLBACK_SUPPORTED must be "true", "false", or unset, got "${rawSupported}"`,
    );
  }
  // Not set — omit the boolean so rollback-report.mjs derives it from the schema version.
  return schemaVersion !== null ? { schemaVersion } : null;
}

/**
 * Lifecycle status of the record. Only two values exist on purpose: a record is either the live
 * deployment or a retired one that points at its successor. Anything else is a typo we refuse.
 */
function lifecycle() {
  const status = process.env.HYPERION_STATUS || "active";
  if (status === "active") {
    if (process.env.HYPERION_SUCCESSOR_ROUTER || process.env.HYPERION_ARCHIVE_REASON) {
      throw new Error("an active record must not carry a successor or archive reason");
    }
    return { status: "active" };
  }
  if (status === "archived") {
    const successorRouter = need("HYPERION_SUCCESSOR_ROUTER");
    const reason = need("HYPERION_ARCHIVE_REASON");
    if (successorRouter === need("HYPERION_ROUTER")) {
      throw new Error("an archived record cannot name its own router as the successor");
    }
    return {
      status: "archived",
      archivedAt: new Date().toISOString(),
      archiveReason: reason,
      successor: { router: successorRouter },
    };
  }
  throw new Error(`HYPERION_STATUS must be "active" or "archived", got "${status}"`);
}

const asset = need("HYPERION_ASSET");
const [code, issuer] = asset.split(":");
if (code === undefined || issuer === undefined) {
  throw new Error(`HYPERION_ASSET should read CODE:ISSUER, got "${asset}"`);
}

const adapters = {};
if (process.env.HYPERION_CCTP) adapters.cctp = process.env.HYPERION_CCTP;
if (process.env.HYPERION_AXELAR) adapters["axelar-its"] = process.env.HYPERION_AXELAR;

const routes = Object.keys(adapters);

const wasmHashes = {};
if (process.env.ROUTER_HASH) wasmHashes.router = process.env.ROUTER_HASH;
if (process.env.CCTP_HASH && process.env.HYPERION_CCTP) wasmHashes["adapter-cctp"] = process.env.CCTP_HASH;
if (process.env.AXELAR_HASH && process.env.HYPERION_AXELAR) {
  wasmHashes["adapter-axelar"] = process.env.AXELAR_HASH;
}

const deployment = {
  family: "stellar",
  networkPassphrase: entry.networkPassphrase,
  router: need("HYPERION_ROUTER"),
  adapters,
  tokens: {
    [code]: {
      sacId: need("HYPERION_SAC"),
      code,
      issuer,
      // Stellar's native precision, and the source of the one digit mismatch with USDC on EVM.
      decimals: 7,
      flowLimit: need("HYPERION_TOKEN_FLOW_LIMIT"),
      routes,
    },
  },
  treasury: need("HYPERION_TREASURY"),
  admin: need("HYPERION_ADMIN"),
  guardian: need("HYPERION_GUARDIAN"),
  feeBps: Number(need("HYPERION_FEE_BPS")),
  // Ledgers on this side, seconds on the EVM side. The field name is the same and the unit is not,
  // which is worth remembering every single time.
  flowWindow: Number(need("HYPERION_FLOW_WINDOW_LEDGERS")),
  timelockDelay: Number(need("HYPERION_TIMELOCK_DELAY")),
  wasmHashes,
  deployedAt: {
    ledger:
      process.env.HYPERION_ROUTER_LEDGER || process.env.ROUTER_LEDGER || process.env.STELLAR_START_LEDGER
        ? Number(
            process.env.HYPERION_ROUTER_LEDGER ||
              process.env.ROUTER_LEDGER ||
              process.env.STELLAR_START_LEDGER,
          )
        : await latestLedger(),
    timestamp: new Date().toISOString(),
  },
  commit: commit(),
  ...lifecycle(),
  ...(storageMigration() !== null ? { storageMigration: storageMigration() } : {}),

  // Phase two reads these, and a reviewer checks them against the chain. The validator ignores
  // fields it does not know about, which is what lets a record carry handover state as well as
  // addresses. Queued actions are kept on archived records too: they are historical evidence.
  deployer: need("HYPERION_DEPLOYER"),
  peerChain: need("HYPERION_PEER_CHAIN"),
  queuedActionIds: JSON.parse(process.env.QUEUE_IDS_JSON ?? "[]"),
  queuedActions: JSON.parse(process.env.QUEUE_WHAT_JSON ?? "[]"),
};

const record = {
  schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  networks: { [chainKey]: deployment },
};

// The whole reason this file exists rather than a heredoc in the shell script.
parseDeploymentSet(record);

mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`validated and written: ${out}\n`);
