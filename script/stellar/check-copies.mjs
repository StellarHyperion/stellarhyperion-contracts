#!/usr/bin/env node
/**
 * Read-only CLI comparing the canonical deployment manifest in `stellarhyperion-contracts` against
 * `stellarhyperion-backend` and `stellarhyperion-frontend` copies at explicit revisions.
 *
 * Supports reading consumer copies either from explicit JSON files (`--backend path/to/file.json
 * --backend-rev <sha>`) or directly out of a local Git repository clone without checking out or
 * mutating its working tree (`--backend /path/to/backend-repo --backend-rev <sha> --backend-path
 * deployments/stellar-testnet-phase1.json`).
 *
 * Never modifies consumer files: `--write`, `--sync`, `--fix`, `--update`, and signing flags are
 * rejected immediately.
 *
 * Usage:
 *   node script/stellar/check-copies.mjs \
 *     --canonical deployments/stellar-testnet-phase1.json --canonical-rev <rev> \
 *     --backend /path/to/backend --backend-rev <rev> \
 *     --frontend /path/to/frontend --frontend-rev <rev> \
 *     [--archive-dir deployments/archive] [--json]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "..", "..");

const FORBIDDEN_REWRITE_FLAGS = new Set([
  "--write",
  "--rewrite",
  "--sync",
  "--fix",
  "--update",
  "--in-place",
  "--identity",
  "--secret-key",
]);

function parseArgs(argv) {
  let canonical = resolve(
    contractsRoot,
    "deployments/stellar-testnet-phase1.json",
  );
  let canonicalRev;
  let canonicalPathInRepo = "deployments/stellar-testnet-phase1.json";
  let backend;
  let backendRev;
  let backendRepo = "stellarhyperion-backend";
  let backendPathInRepo = "deployments/stellar-testnet-phase1.json";
  let frontend;
  let frontendRev;
  let frontendRepo = "stellarhyperion-frontend";
  let frontendPathInRepo = "deployments/stellar-testnet-phase1.json";
  let archiveDir = resolve(contractsRoot, "deployments/archive");
  let json = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FORBIDDEN_REWRITE_FLAGS.has(arg)) {
      throw new Error(
        `refusing "${arg}": check-copies is strictly read-only and never rewrites consumer copies without a separate operation`,
      );
    }
    if (arg === "--canonical") canonical = resolve(argv[++i] ?? "");
    else if (arg === "--canonical-rev") canonicalRev = argv[++i];
    else if (arg === "--canonical-path") canonicalPathInRepo = argv[++i] ?? "";
    else if (arg === "--backend") backend = resolve(argv[++i] ?? "");
    else if (arg === "--backend-rev") backendRev = argv[++i];
    else if (arg === "--backend-repo") backendRepo = argv[++i] ?? backendRepo;
    else if (arg === "--backend-path") backendPathInRepo = argv[++i] ?? "";
    else if (arg === "--frontend") frontend = resolve(argv[++i] ?? "");
    else if (arg === "--frontend-rev") frontendRev = argv[++i];
    else if (arg === "--frontend-repo")
      frontendRepo = argv[++i] ?? frontendRepo;
    else if (arg === "--frontend-path") frontendPathInRepo = argv[++i] ?? "";
    else if (arg === "--archive-dir") archiveDir = resolve(argv[++i] ?? "");
    else if (arg === "--json") json = true;
    else throw new Error(`unknown argument "${String(arg)}"`);
  }

  if (!backend && !frontend) {
    throw new Error(
      "usage: check-copies.mjs [--canonical <file|repo> --canonical-rev <rev>] [--backend <file|repo> --backend-rev <rev>] [--frontend <file|repo> --frontend-rev <rev>] [--archive-dir <dir>] [--json]",
    );
  }
  if (backend && (!backendRev || backendRev.trim() === "")) {
    throw new Error(
      "--backend-rev <explicit-revision> is required when --backend is provided",
    );
  }
  if (frontend && (!frontendRev || frontendRev.trim() === "")) {
    throw new Error(
      "--frontend-rev <explicit-revision> is required when --frontend is provided",
    );
  }

  return {
    canonical,
    canonicalRev,
    canonicalPathInRepo,
    backend,
    backendRev,
    backendRepo,
    backendPathInRepo,
    frontend,
    frontendRev,
    frontendRepo,
    frontendPathInRepo,
    archiveDir,
    json,
  };
}

function resolveDefaultGitHead(repoDir) {
  return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function loadManifestReadOnly(targetPath, explicitRev, pathInRepo) {
  if (!existsSync(targetPath)) {
    throw new Error(`manifest source does not exist: ${targetPath}`);
  }
  const st = statSync(targetPath);
  if (st.isDirectory()) {
    const rev = explicitRev || resolveDefaultGitHead(targetPath);
    const resolvedCommit = execFileSync(
      "git",
      ["-C", targetPath, "rev-parse", "--verify", `${rev}^{commit}`],
      { encoding: "utf8" },
    ).trim();
    const rawText = execFileSync(
      "git",
      ["-C", targetPath, "show", `${resolvedCommit}:${pathInRepo}`],
      { encoding: "utf8" },
    );
    return {
      revision:
        rev === resolvedCommit
          ? resolvedCommit
          : `${rev} (${resolvedCommit.slice(0, 7)})`,
      displayPath: pathInRepo,
      content: JSON.parse(rawText),
    };
  }

  const rev = explicitRev || resolveDefaultGitHead(contractsRoot);
  return {
    revision: rev,
    displayPath: targetPath,
    content: JSON.parse(readFileSync(targetPath, "utf8")),
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

const { compareDeploymentCopies, formatDeploymentConsistencyReport } = protocol;
const opts = parseArgs(process.argv);

const canonLoaded = loadManifestReadOnly(
  opts.canonical,
  opts.canonicalRev,
  opts.canonicalPathInRepo,
);

const consumers = [];
if (opts.backend) {
  const bLoaded = loadManifestReadOnly(
    opts.backend,
    opts.backendRev,
    opts.backendPathInRepo,
  );
  consumers.push({
    role: "backend",
    repository: opts.backendRepo,
    revision: bLoaded.revision,
    path: bLoaded.displayPath,
    content: bLoaded.content,
  });
}
if (opts.frontend) {
  const fLoaded = loadManifestReadOnly(
    opts.frontend,
    opts.frontendRev,
    opts.frontendPathInRepo,
  );
  consumers.push({
    role: "frontend",
    repository: opts.frontendRepo,
    revision: fLoaded.revision,
    path: fLoaded.displayPath,
    content: fLoaded.content,
  });
}

const archived = [];
if (opts.archiveDir && existsSync(opts.archiveDir)) {
  const entries = readdirSync(opts.archiveDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of entries) {
    const full = resolve(opts.archiveDir, name);
    archived.push({
      archiveId: basename(name),
      path: `deployments/archive/${basename(name)}`,
      content: JSON.parse(readFileSync(full, "utf8")),
    });
  }
}

const report = compareDeploymentCopies({
  canonical: {
    role: "contracts",
    repository: "stellarhyperion-contracts",
    revision: canonLoaded.revision,
    path: canonLoaded.displayPath,
    classification: "active",
    content: canonLoaded.content,
  },
  consumers,
  archived,
});

if (opts.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatDeploymentConsistencyReport(report)}\n`);
}

if (!report.consistent) {
  process.exit(1);
}
