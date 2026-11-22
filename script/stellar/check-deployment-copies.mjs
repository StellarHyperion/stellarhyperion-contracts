#!/usr/bin/env node
/**
 * Compare the canonical deployment record with the copies the backend and frontend ship.
 *
 * A deployment record is copied into two other repositories by hand, and nothing in this repository
 * can notice those copies drifting. A stale copy is not a loud failure: a frontend that still names
 * the previous router parses fine, builds fine and sends a user's transfer to a contract this
 * deployment no longer monitors. So the comparison is its own read-only command rather than a step
 * inside the deploy script, because "do the three repositories still agree" is a question asked
 * weeks later, from a machine that never ran a deployment.
 *
 * Read-only by construction. It reads JSON from disk and from committed Git blobs with `rev-parse`,
 * `cat-file` and `show`, and writes nothing at all: not the copies, not the canonical record, not a
 * cache. Copying a record into a consumer repository stays a separate, reviewed operation.
 *
 * Why pinned revisions instead of the consumer's working tree. A copy is only meaningful next to
 * the commit that built it; comparing against an uncommitted checkout answers a question nobody
 * asked and can change while you read it. Every copy therefore names `git:<full 40-character sha>`,
 * resolved inside that consumer's own local clone, and the resolved commit must be exactly the
 * requested one.
 *
 * Usage:
 *   node script/stellar/check-deployment-copies.mjs \
 *     [--canonical deployments/stellar-testnet-phase1.json] \
 *     --copies deployment-copies.json [--json] [--allow-archived]
 *
 * The copies file names each consumer repository:
 *   {
 *     "copies": [
 *       {
 *         "repository": "backend",
 *         "repo": "../stellarhyperion-backend",
 *         "revision": "git:<full sha>",
 *         "path": "deployments/stellar-testnet-phase1.json"
 *       },
 *       {
 *         "repository": "frontend",
 *         "repo": "../stellarhyperion-frontend",
 *         "revision": "git:<full sha>",
 *         "path": "src/deployment.json",
 *         "pointer": "/deployment"
 *       }
 *     ]
 *   }
 *
 * `repo` is resolved relative to the copies file. `pointer` is optional and is an RFC 6901 JSON
 * pointer to where the record sits inside a copy document that wraps it.
 *
 * Exit codes: 0 every copy matches, 1 at least one field differs, 2 usage or read error.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ACTIVE_MANIFEST = "deployments/stellar-testnet-phase1.json";
/** A record is small. The bound keeps a malformed or hostile argument from being read whole. */
const MAX_BYTES = 1048576;
const MAX_COPIES = 8;
const REVISION = /^git:[a-f0-9]{40}$/;
const REPOSITORY = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Repo-relative, no leading dash, no `..` segment, no backslashes, no `:`. */
const REPO_PATH = /^(?!-)(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}$/;
/** Records that are not the active manifest, parsed rather than string matched. */
const INACTIVE_STATUS = new Set(["archived", "deprecated", "retired"]);

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function boundedRead(filename, label) {
  let stat;
  try {
    stat = lstatSync(filename);
  } catch {
    throw new Error(`${label} does not exist: ${filename}`);
  }
  // A symlink is refused rather than followed: the command is meant to compare the file that was
  // named, and a link could be repointed between a review and a run.
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${filename}`);
  if (stat.size > MAX_BYTES) throw new Error(`${label} exceeds ${MAX_BYTES} bytes: ${filename}`);
  const bytes = readFileSync(filename);
  return {
    text: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function parseJson(filename, label) {
  const { text, sha256 } = boundedRead(filename, label);
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON: ${filename}`);
  }
  return { document, sha256 };
}

/**
 * Which record is being used as the baseline, and whether it is allowed to be one.
 *
 * Both shapes the repository already writes are accepted: the `lifecycle` block `verify.sh` reads,
 * and the `status` / `successorRouter` fields `write-record.mjs` puts on the network entry. The
 * docs' older `successor` / `supersededAt` spelling is accepted too. A path under a directory named
 * `archive` is also inert evidence, whatever the file happens to say about itself.
 */
export function canonicalLifecycle(record, filename) {
  if (!plain(record)) throw new Error("canonical record must be a JSON object");
  // A deployment set names one network; a flat EVM record is itself the deployment. Both are
  // compared the same way, because the comparison never interprets the fields it walks.
  const networks = record.networks;
  let network = null;
  let entry = record;
  if (plain(networks)) {
    const keys = Object.keys(networks);
    if (keys.length !== 1) throw new Error("canonical record must contain exactly one network");
    [network] = keys;
    entry = plain(networks[network]) ? networks[network] : {};
  } else if (typeof record.network === "string") {
    network = record.network;
  }
  const declared = plain(entry.lifecycle)
    ? entry.lifecycle
    : plain(record.lifecycle)
      ? record.lifecycle
      : {};
  const status =
    typeof declared.status === "string"
      ? declared.status
      : typeof entry.status === "string"
        ? entry.status
        : typeof record.status === "string"
          ? record.status
          : "active";
  const successor =
    declared.successor ??
    declared.successorRecord ??
    entry.successor ??
    entry.successorRouter ??
    record.successor ??
    null;
  const archivedLocation = path.resolve(filename).split(path.sep).includes("archive");
  return {
    network,
    status,
    successor: typeof successor === "string" && successor ? successor : null,
    archivedLocation,
    active: !INACTIVE_STATUS.has(status) && !archivedLocation,
  };
}

function validRevision(revision, repository) {
  if (typeof revision !== "string" || !REVISION.test(revision))
    throw new Error(`copy ${repository}: revision must be "git:<full 40-character commit sha>"`);
  return revision.slice(4);
}

function validCopyPath(value, repository) {
  if (typeof value !== "string" || !REPO_PATH.test(value) || value.endsWith("/"))
    throw new Error(`copy ${repository}: path must be a bounded repository-relative file path`);
  return value;
}

function validPointer(value, repository) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 512)
    throw new Error(`copy ${repository}: pointer must be short text`);
  if (value === "") return "";
  if (!value.startsWith("/")) throw new Error(`copy ${repository}: pointer must start with "/"`);
  for (const token of value.slice(1).split("/"))
    if (token === "") throw new Error(`copy ${repository}: pointer has an empty token`);
  return value;
}

/** Read and validate the list of consumer copies. Repo paths are relative to the copies file. */
export function loadCopySpec(filename) {
  const { document } = parseJson(filename, "copies file");
  if (!plain(document) || !Array.isArray(document.copies))
    throw new Error('copies file must be an object with a "copies" array');
  if (document.copies.length === 0 || document.copies.length > MAX_COPIES)
    throw new Error(`copies must name between 1 and ${MAX_COPIES} repositories`);
  const seen = new Set();
  const base = path.dirname(path.resolve(filename));
  return document.copies.map((copy) => {
    if (!plain(copy)) throw new Error("every copy must be an object");
    const { repository, repo, revision, path: file, pointer } = copy;
    if (typeof repository !== "string" || !REPOSITORY.test(repository))
      throw new Error(
        "every copy needs a repository name of lowercase letters, digits and hyphens",
      );
    if (seen.has(repository)) throw new Error(`copy ${repository}: named more than once`);
    seen.add(repository);
    if (typeof repo !== "string" || repo.length === 0 || repo.length > 4096)
      throw new Error(`copy ${repository}: repo must be a directory path`);
    const directory = path.resolve(base, repo);
    let stat;
    try {
      stat = lstatSync(directory);
    } catch {
      throw new Error(`copy ${repository}: no local clone at ${directory}`);
    }
    if (!stat.isDirectory()) throw new Error(`copy ${repository}: ${directory} is not a directory`);
    return {
      repository,
      repo: directory,
      revision,
      sha: validRevision(revision, repository),
      path: validCopyPath(file, repository),
      pointer: validPointer(pointer, repository),
    };
  });
}

function git(directory, args, maxBuffer = 65536) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function resolvePointer(document, pointer, repository) {
  if (pointer === "") return { value: document, tokens: [] };
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?![01])/.test(token))
        throw new Error(`copy ${repository}: pointer has an invalid escape`);
      return token.replace(/~1/g, "/").replace(/~0/g, "~");
    });
  let value = document;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]{0,8})$/.test(token) || Number(token) >= value.length)
        throw new Error(`copy ${repository}: pointer ${pointer} does not resolve at ${token}`);
      value = value[Number(token)];
    } else if (plain(value) && Object.hasOwn(value, token)) {
      value = value[token];
    } else {
      throw new Error(`copy ${repository}: pointer ${pointer} does not resolve at ${token}`);
    }
  }
  return { value, tokens };
}

/**
 * Read one copy out of the commit that built it, never out of a working tree.
 *
 * `cat-file -t` and `cat-file -s` run before `show` so a missing path and an oversized blob are
 * named as such instead of arriving as a truncated parse or an opaque Git error.
 */
export function readCopyAtRevision(copy) {
  let commit;
  try {
    commit = git(copy.repo, ["rev-parse", "--verify", `${copy.sha}^{commit}`]).trim();
  } catch {
    throw new Error(`copy ${copy.repository}: ${copy.revision} is not a commit in ${copy.repo}`);
  }
  if (commit !== copy.sha)
    throw new Error(`copy ${copy.repository}: ${copy.revision} did not resolve exactly`);
  let type;
  try {
    type = git(copy.repo, ["cat-file", "-t", `${commit}:${copy.path}`]).trim();
  } catch {
    throw new Error(`copy ${copy.repository}: ${copy.path} does not exist in ${copy.revision}`);
  }
  if (type !== "blob")
    throw new Error(`copy ${copy.repository}: ${copy.path} is a ${type}, not a file`);
  const size = Number(git(copy.repo, ["cat-file", "-s", `${commit}:${copy.path}`]).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES)
    throw new Error(
      `copy ${copy.repository}: ${copy.path} is not a bounded file at ${copy.revision}`,
    );
  const text = git(copy.repo, ["show", `${commit}:${copy.path}`], MAX_BYTES * 2);
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`copy ${copy.repository}: ${copy.path} is not valid JSON at ${copy.revision}`);
  }
  const { value } = resolvePointer(document, copy.pointer, copy.repository);
  return {
    repository: copy.repository,
    revision: `git:${commit}`,
    path: copy.path,
    pointer: copy.pointer,
    sha256: createHash("sha256").update(text).digest("hex"),
    value,
  };
}

function joinPointer(pointer, tokens) {
  const suffix = tokens
    .map((token) => String(token).replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/");
  if (!suffix) return pointer;
  return pointer === "" ? `/${suffix}` : `${pointer}/${suffix}`;
}

/**
 * Walk two JSON values and report every difference by field path.
 *
 * Every comparison is exact: a string `"30"` does not match the number `30`, and an amount stays
 * the string it was written as. Coercing here would hide exactly the class of mistake this command
 * exists to catch, because a record that parsed is not a record that agrees.
 */
function walk(canonical, copy, tokens, emit) {
  if (plain(canonical) && plain(copy)) {
    const keys = [...new Set([...Object.keys(canonical), ...Object.keys(copy)])].sort();
    for (const key of keys) {
      const next = tokens.concat(key);
      if (!Object.hasOwn(copy, key))
        emit({ state: "missing", tokens: next, canonical: canonical[key], copy: null });
      else if (!Object.hasOwn(canonical, key))
        emit({ state: "extra", tokens: next, canonical: null, copy: copy[key] });
      else walk(canonical[key], copy[key], next, emit);
    }
    return;
  }
  if (Array.isArray(canonical) && Array.isArray(copy)) {
    const length = Math.max(canonical.length, copy.length);
    for (let index = 0; index < length; index += 1) {
      const next = tokens.concat(index);
      if (index >= copy.length)
        emit({ state: "missing", tokens: next, canonical: canonical[index], copy: null });
      else if (index >= canonical.length)
        emit({ state: "extra", tokens: next, canonical: null, copy: copy[index] });
      else walk(canonical[index], copy[index], next, emit);
    }
    return;
  }
  if (
    typeof canonical !== typeof copy ||
    Array.isArray(canonical) !== Array.isArray(copy) ||
    plain(canonical) !== plain(copy)
  ) {
    emit({ state: "drift", tokens, canonical, copy });
    return;
  }
  emit({
    state: canonical === copy ? "match" : "drift",
    tokens,
    canonical,
    copy,
  });
}

/** Pure comparison: the canonical descriptor plus already-read copies become the report. */
export function compareDeploymentCopies(canonical, copies) {
  const results = [];
  const repositories = copies.map((copy) => {
    const counts = { match: 0, drift: 0, missing: 0, extra: 0 };
    walk(canonical.value, copy.value, [], (result) => {
      counts[result.state] += 1;
      if (result.state === "match") return;
      results.push({
        repository: copy.repository,
        field: result.tokens.join("."),
        copyField: joinPointer(copy.pointer, result.tokens),
        state: result.state,
        canonical: result.canonical,
        copy: result.copy,
      });
    });
    return {
      repository: copy.repository,
      revision: copy.revision,
      path: copy.path,
      pointer: copy.pointer,
      sha256: copy.sha256,
      counts,
      healthy: counts.drift + counts.missing + counts.extra === 0,
    };
  });
  const counts = repositories.reduce(
    (total, entry) => {
      for (const state of ["match", "drift", "missing", "extra"])
        total[state] += entry.counts[state];
      return total;
    },
    { match: 0, drift: 0, missing: 0, extra: 0 },
  );
  const owners = [...new Set(results.map((result) => result.repository))].sort();
  return {
    readOnly: true,
    canonical: {
      path: canonical.path,
      sha256: canonical.sha256,
      network: canonical.network,
      status: canonical.status,
      active: canonical.active,
      archivedLocation: canonical.archivedLocation,
      successor: canonical.successor,
    },
    repositories,
    results,
    owners,
    counts,
    healthy: copies.length > 0 && results.length === 0,
  };
}

/** Load the baseline and every copy, refusing an archived baseline unless asked for it. */
export function buildReport(options) {
  const canonicalPath = path.resolve(options.canonicalPath ?? path.join(ROOT, ACTIVE_MANIFEST));
  const { document, sha256 } = parseJson(canonicalPath, "canonical record");
  const lifecycle = canonicalLifecycle(document, canonicalPath);
  if (!lifecycle.active && options.allowArchived !== true)
    throw new Error(
      `${canonicalPath} is not the active deployment (status ${lifecycle.status}` +
        `${lifecycle.archivedLocation ? ", archived location" : ""}). ` +
        `The active manifest is ${ACTIVE_MANIFEST}; pass --allow-archived to compare historical evidence`,
    );
  const copies = loadCopySpec(options.copiesPath).map(readCopyAtRevision);
  return compareDeploymentCopies(
    {
      value: document,
      path: canonicalPath,
      sha256,
      network: lifecycle.network,
      status: lifecycle.status,
      active: lifecycle.active,
      archivedLocation: lifecycle.archivedLocation,
      successor: lifecycle.successor,
    },
    copies,
  );
}

function describe(value) {
  if (value === null) return "null";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

export function formatReport(report) {
  const lines = [
    `canonical  ${report.canonical.path}`,
    `           ${report.canonical.network ? `network ${report.canonical.network}, ` : ""}status ${report.canonical.status}` +
      (report.canonical.active ? "" : ", NOT the active deployment") +
      (report.canonical.successor ? `, successor ${report.canonical.successor}` : ""),
  ];
  for (const repository of report.repositories)
    lines.push(
      `copy       ${repository.repository}  ${repository.revision}  ${repository.path}` +
        (repository.pointer ? `  pointer ${repository.pointer}` : ""),
    );
  lines.push("");
  if (report.healthy) {
    lines.push(`${report.counts.match} fields match in every copy. Nothing differs.`);
    return lines.join("\n");
  }
  for (const result of report.results) {
    const label =
      result.state === "missing" ? "MISSING" : result.state === "extra" ? "EXTRA  " : "DIFFERS";
    const detail =
      result.state === "missing"
        ? `the copy does not have it; canonical is ${describe(result.canonical)}`
        : result.state === "extra"
          ? `the canonical record does not have it; the copy is ${describe(result.copy)}`
          : `canonical ${describe(result.canonical)}, copy ${describe(result.copy)}`;
    lines.push(
      `${label}  ${result.repository}  ${result.field}${result.copyField && result.copyField !== result.field ? `  (${result.copyField})` : ""}`,
    );
    lines.push(`         ${detail}`);
  }
  lines.push("");
  lines.push(
    `${report.counts.match} fields match, ${report.counts.drift} differ, ` +
      `${report.counts.missing} missing from a copy, ${report.counts.extra} only in a copy.`,
  );
  lines.push(
    `Owning repositories: ${report.owners.join(", ")}. This command wrote nothing; ` +
      "copying a record into a consumer is a separate reviewed operation.",
  );
  return lines.join("\n");
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--allow-archived") options.allowArchived = true;
    else if (arg === "--canonical" || arg === "--copies") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      options[arg === "--canonical" ? "canonicalPath" : "copiesPath"] = value;
      index += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.copiesPath)
    throw new Error(
      "usage: check-deployment-copies.mjs [--canonical RECORD.json] --copies COPIES.json [--json] [--allow-archived]",
    );
  return options;
}

export function runCli(argv = process.argv.slice(2)) {
  let options;
  let report;
  try {
    options = parseArgs(argv);
    report = buildReport(options);
  } catch (error) {
    process.stderr.write(`check-deployment-copies: ${error.message}\n`);
    process.exitCode = 2;
    return null;
  }
  process.stdout.write(
    `${options.json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`,
  );
  if (!report.healthy) process.exitCode = 1;
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
