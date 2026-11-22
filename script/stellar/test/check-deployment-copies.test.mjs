import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolve } from "node:path";
import {
  buildReport,
  canonicalLifecycle,
  compareDeploymentCopies,
  loadCopySpec,
  readCopyAtRevision,
} from "../check-deployment-copies.mjs";

const ACTIVE = resolve("deployments/stellar-testnet-phase1.json");
const ARCHIVED = resolve("deployments/archive/stellar-testnet-2026-10-01.json");
const SCRIPT = resolve("script/stellar/check-deployment-copies.mjs");
const active = JSON.parse(readFileSync(ACTIVE, "utf8"));
const record = () => structuredClone(active);

function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** A throwaway clone-shaped repository, committed the way a consumer's history would be. */
function makeRepo(t, files) {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperion-copies-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, ["init", "-q"]);
  for (const [name, contents] of Object.entries(files)) {
    const filename = path.join(directory, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, JSON.stringify(contents, null, 2) + "\n");
  }
  git(directory, ["add", "-A"]);
  git(directory, [
    "-c",
    "user.name=Copy Fixture",
    "-c",
    "user.email=fixtures@example.invalid",
    "commit",
    "-q",
    "-m",
    "deployment copy",
  ]);
  return {
    directory,
    commit: git(directory, ["rev-parse", "HEAD"]).trim(),
    file: (name) => path.join(directory, name),
  };
}

function writeSpec(t, copies, name = "deployment-copies.json") {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperion-spec-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, name);
  writeFileSync(filename, JSON.stringify({ copies }, null, 2) + "\n");
  return filename;
}

const copyEntry = (repository, repo, commit, file, extra = {}) => ({
  repository,
  repo,
  revision: `git:${commit}`,
  path: file,
  ...extra,
});

const cli = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 4194304,
  });

test("identical copies at pinned revisions are healthy, including a pointer-wrapped consumer", (t) => {
  const backend = makeRepo(t, { "deployment.json": record() });
  const frontend = makeRepo(t, {
    "src/deployment.json": { deployment: record(), unrelated: true },
  });
  const spec = writeSpec(t, [
    copyEntry("backend", backend.directory, backend.commit, "deployment.json"),
    copyEntry("frontend", frontend.directory, frontend.commit, "src/deployment.json", {
      pointer: "/deployment",
    }),
  ]);
  const report = buildReport({ canonicalPath: ACTIVE, copiesPath: spec });
  assert.equal(report.healthy, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.canonical.active, true);
  assert.equal(report.canonical.network, "stellar-testnet");
  assert.equal(report.counts.drift, 0);
  assert.equal(report.counts.missing, 0);
  assert.equal(report.counts.extra, 0);
  assert.ok(report.counts.match > 50);
  assert.deepEqual(report.owners, []);
  assert.deepEqual(
    report.repositories.map((entry) => entry.revision),
    [`git:${backend.commit}`, `git:${frontend.commit}`],
  );
  const result = cli(["--copies", spec]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nothing differs/);
  // The wrapper's unrelated field is outside the pointed-at record and is not compared.
  assert.doesNotMatch(result.stdout, /unrelated/);
});

test("drift names the exact field path and the owning repository", (t) => {
  const stale = record();
  stale.networks["stellar-testnet"].router = "C" + "Z".repeat(55);
  const backend = makeRepo(t, { "deployment.json": stale });
  const mismatched = record();
  mismatched.networks["stellar-testnet"].feeBps = "30";
  delete mismatched.networks["stellar-testnet"].guardian;
  const frontend = makeRepo(t, {
    "src/deployment.json": { deployment: mismatched },
  });
  const spec = writeSpec(t, [
    copyEntry("backend", backend.directory, backend.commit, "deployment.json"),
    copyEntry("frontend", frontend.directory, frontend.commit, "src/deployment.json", {
      pointer: "/deployment",
    }),
  ]);
  const report = buildReport({ canonicalPath: ACTIVE, copiesPath: spec });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.owners, ["backend", "frontend"]);
  const router = report.results.find((entry) => entry.field === "networks.stellar-testnet.router");
  assert.equal(router.repository, "backend");
  assert.equal(router.state, "drift");
  assert.equal(router.copy, stale.networks["stellar-testnet"].router);
  assert.equal(router.canonical, active.networks["stellar-testnet"].router);
  // A JSON string is not the integer it looks like, and the report says which side is which.
  const fee = report.results.find((entry) => entry.field === "networks.stellar-testnet.feeBps");
  assert.equal(fee.repository, "frontend");
  assert.equal(fee.state, "drift");
  assert.equal(fee.canonical, 30);
  assert.equal(fee.copy, "30");
  assert.equal(fee.copyField, "/deployment/networks/stellar-testnet/feeBps");
  const guardian = report.results.find(
    (entry) => entry.field === "networks.stellar-testnet.guardian",
  );
  assert.equal(guardian.repository, "frontend");
  assert.equal(guardian.state, "missing");
  const result = cli(["--copies", spec]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /DIFFERS {2}backend {2}networks\.stellar-testnet\.router/);
  assert.match(result.stdout, /Owning repositories: backend, frontend/);
});

test("a field only the consumer has is reported as extra and owned by that consumer", (t) => {
  const extended = record();
  extended.networks["stellar-testnet"].unreviewed = "0xdeadbeef";
  const backend = makeRepo(t, { "deployment.json": extended });
  const spec = writeSpec(t, [
    copyEntry("backend", backend.directory, backend.commit, "deployment.json"),
  ]);
  const report = buildReport({ canonicalPath: ACTIVE, copiesPath: spec });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.owners, ["backend"]);
  assert.equal(report.counts.extra, 1);
  assert.equal(report.results[0].field, "networks.stellar-testnet.unreviewed");
  assert.equal(report.results[0].state, "extra");
});

test("archived baselines are refused by default and labelled when allowed", (t) => {
  const backend = makeRepo(t, { "deployment.json": record() });
  const spec = writeSpec(t, [
    copyEntry("backend", backend.directory, backend.commit, "deployment.json"),
  ]);
  assert.throws(
    () => buildReport({ canonicalPath: ARCHIVED, copiesPath: spec }),
    /not the active deployment .*active manifest is deployments\/stellar-testnet-phase1\.json/,
  );
  const archived = buildReport({
    canonicalPath: ARCHIVED,
    copiesPath: spec,
    allowArchived: true,
  });
  assert.equal(archived.canonical.active, false);
  assert.equal(archived.canonical.archivedLocation, true);
  // An old record still compares; it just cannot be presented as the current deployment.
  assert.ok(archived.repositories[0].counts.match > 0);

  // The status field is parsed, not inferred from the file name.
  const marked = record();
  marked.networks["stellar-testnet"].status = "archived";
  marked.networks["stellar-testnet"].successorRouter = active.networks["stellar-testnet"].router;
  const directory = mkdtempSync(path.join(tmpdir(), "hyperion-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const markedPath = path.join(directory, "retired.json");
  writeFileSync(markedPath, JSON.stringify(marked) + "\n");
  const lifecycle = canonicalLifecycle(marked, markedPath);
  assert.equal(lifecycle.status, "archived");
  assert.equal(lifecycle.active, false);
  assert.equal(lifecycle.successor, active.networks["stellar-testnet"].router);
  assert.throws(
    () => buildReport({ canonicalPath: markedPath, copiesPath: spec }),
    /not the active deployment/,
  );
  const allowed = buildReport({
    canonicalPath: markedPath,
    copiesPath: spec,
    allowArchived: true,
  });
  assert.equal(allowed.canonical.status, "archived");
  assert.equal(allowed.canonical.active, false);
  assert.equal(allowed.canonical.successor, active.networks["stellar-testnet"].router);
});

test("consumer revisions must resolve exactly and copy paths cannot escape the clone", (t) => {
  const backend = makeRepo(t, { "deployment.json": record() });
  const specFor = (copy) => writeSpec(t, [copy]);
  const base = copyEntry("backend", backend.directory, backend.commit, "deployment.json");
  assert.throws(
    () =>
      buildReport({
        canonicalPath: ACTIVE,
        copiesPath: specFor({ ...base, revision: "git:HEAD" }),
      }),
    /full 40-character/,
  );
  assert.throws(
    () =>
      buildReport({
        canonicalPath: ACTIVE,
        copiesPath: specFor({ ...base, revision: `git:${"0".repeat(40)}` }),
      }),
    /is not a commit in/,
  );
  for (const unsafe of [
    "../outside.json",
    "/etc/passwd",
    "-deployment.json",
    "deployments/../../outside.json",
    "deployment.json/",
  ])
    assert.throws(
      () =>
        buildReport({
          canonicalPath: ACTIVE,
          copiesPath: specFor({ ...base, path: unsafe }),
        }),
      /repository-relative/,
    );
  assert.throws(
    () =>
      buildReport({
        canonicalPath: ACTIVE,
        copiesPath: specFor({ ...base, path: "missing.json" }),
      }),
    /does not exist/,
  );
  assert.throws(
    () =>
      buildReport({
        canonicalPath: ACTIVE,
        copiesPath: specFor({ ...base, pointer: "/not/the/deployment" }),
      }),
    /pointer .* does not resolve/,
  );
  assert.throws(
    () =>
      buildReport({
        canonicalPath: ACTIVE,
        copiesPath: specFor({ ...base, path: "/abs/deployment.json" }),
      }),
    /repository-relative/,
  );
});

test("the command reads committed blobs and leaves both repositories untouched", (t) => {
  const backend = makeRepo(t, { "deployment.json": record() });
  const spec = writeSpec(t, [
    copyEntry("backend", backend.directory, backend.commit, "deployment.json"),
  ]);
  const before = readFileSync(backend.file("deployment.json"));
  // A dirty working tree is invisible to the comparison: the committed blob is what is read.
  writeFileSync(backend.file("deployment.json"), JSON.stringify({ tampered: true }) + "\n");
  const dirty = readFileSync(backend.file("deployment.json"));
  const report = buildReport({ canonicalPath: ACTIVE, copiesPath: spec });
  assert.equal(report.healthy, true);
  assert.deepEqual(readFileSync(backend.file("deployment.json")), dirty);
  assert.notDeepEqual(before, dirty);
  const status = git(backend.directory, ["status", "--porcelain"]);
  assert.equal(
    status.trim(),
    "M deployment.json",
    "the command must not stage, commit or revert anything",
  );
  const result = cli(["--copies", spec, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.readOnly, true);
  assert.equal(parsed.healthy, true);
  assert.deepEqual(
    readFileSync(backend.file("deployment.json")),
    dirty,
    "running the command changed the consumer working tree",
  );
});

test("the active EVM record compares with the same command and no schema assumptions", (t) => {
  const evmRecord = JSON.parse(readFileSync("evm/deployments/evm-31337-phase1.json", "utf8"));
  const consumer = makeRepo(t, { "deployment.json": evmRecord });
  const spec = writeSpec(t, [
    copyEntry("backend", consumer.directory, consumer.commit, "deployment.json"),
  ]);
  const report = buildReport({
    canonicalPath: "evm/deployments/evm-31337-phase1.json",
    copiesPath: spec,
  });
  assert.equal(report.healthy, true);
  assert.equal(report.canonical.network, null);
  assert.equal(report.canonical.active, true);
});

test("spec shape is validated before anything is read out of a commit", (t) => {
  const backend = makeRepo(t, { "deployment.json": record() });
  const one = copyEntry("backend", backend.directory, backend.commit, "deployment.json");
  assert.throws(() => loadCopySpec(writeSpec(t, [one, { ...one }])), /named more than once/);
  assert.throws(() => loadCopySpec(writeSpec(t, [])), /between 1 and 8/);
  assert.throws(
    () => loadCopySpec(writeSpec(t, [{ ...one, repository: "Backend Repo" }], "spec.json")),
    /repository name/,
  );
  assert.throws(
    () => buildReport({ canonicalPath: ACTIVE, copiesPath: "no-such-spec.json" }),
    /does not exist/,
  );
  const directory = mkdtempSync(path.join(tmpdir(), "hyperion-spec-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const malformed = path.join(directory, "spec.json");
  writeFileSync(malformed, '{"copies": "backend"}\n');
  assert.throws(
    () => buildReport({ canonicalPath: ACTIVE, copiesPath: malformed }),
    /"copies" array/,
  );
  assert.throws(() =>
    readCopyAtRevision({
      ...one,
      repo: path.join(directory, "nope"),
      sha: one.revision.slice(4),
      path: "deployment.json",
    }),
  );
});

test("pure comparison is exact and does not coerce numbers or strings", () => {
  const canonical = { value: { amount: "10000000000000", feeBps: 30, rails: ["cctp"] } };
  const base = {
    repository: "backend",
    revision: `git:${"a".repeat(40)}`,
    path: "deployment.json",
    pointer: "",
    sha256: "0".repeat(64),
  };
  const same = compareDeploymentCopies(canonical, [
    { ...base, value: { amount: "10000000000000", feeBps: 30, rails: ["cctp"] } },
  ]);
  assert.equal(same.healthy, true);
  assert.equal(same.counts.match, 3);
  const coerced = compareDeploymentCopies(canonical, [
    { ...base, value: { amount: 10000000000000, feeBps: 30, rails: "cctp" } },
  ]);
  assert.equal(coerced.healthy, false);
  assert.deepEqual(coerced.results.map((entry) => `${entry.field}:${entry.state}`).sort(), [
    "amount:drift",
    "rails:drift",
  ]);
  const shape = compareDeploymentCopies(canonical, [
    { ...base, value: [{ amount: "10000000000000", feeBps: 30, rails: ["cctp"] }] },
  ]);
  assert.equal(shape.healthy, false);
  assert.ok(shape.counts.drift > 0 || shape.counts.missing > 0);
});
