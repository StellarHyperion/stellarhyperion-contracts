/**
 * Dependency provenance verifier for vendored Soroban native host patches.
 *
 * Verifies the pinned upstream `stellar/rs-soroban-env` source revision, permitted zero-context
 * patch set, Apache-2.0 license metadata, full 272-file SHA-256 inventory, exclusion of
 * native-only dependencies from the `wasm32v1-none` runtime graph, and binding of cryptographic
 * vector tests to the verified patch revision.
 *
 * Browser-safe (pure string and object operations; zero Node.js builtins).
 */

export type VendorFileRole =
  | "vendor-doc"
  | "patch-artifact"
  | "upstream-reference"
  | "upstream-patched"
  | "local-addition"
  | "upstream-unchanged";

export interface VendorFileManifestEntry {
  readonly path: string;
  readonly role: VendorFileRole;
  readonly sha256: string;
}

export interface VendorProvenanceManifest {
  readonly schemaVersion: 1;
  readonly crateName: string;
  readonly crateVersion: string;
  readonly cratesIoArchiveSha256: string;
  readonly upstreamRepository: string;
  readonly upstreamGitSha1: string;
  readonly upstreamPathInVcs: string;
  readonly advisoryId: string;
  readonly licenseSpdx: string;
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly cryptoVectorsPath: string;
  readonly permittedPatchedPaths: readonly string[];
  readonly excludedWasmRuntimeCrates: readonly string[];
  readonly files: readonly VendorFileManifestEntry[];
}

export interface ObservedVendorFile {
  readonly path: string;
  readonly sha256: string;
}

export interface VendorProvenanceContents {
  readonly vcsInfoJson: string;
  readonly vendorCargoToml: string;
  readonly vendorCargoTomlOrig: string;
  readonly vendorLicense: string;
  readonly patchDiff: string;
  readonly patchSha256: string;
  readonly cryptoVectorsRust: string;
  readonly workspaceCargoLock: string;
  readonly wasmNormalCrates: readonly string[];
}

export type VendorProvenanceViolationCode =
  | "missing-vendor-file"
  | "unexpected-vendor-file"
  | "modified-vendor-file"
  | "upstream-revision-mismatch"
  | "patch-digest-mismatch"
  | "unpermitted-patched-file"
  | "patch-replay-mismatch"
  | "license-mismatch"
  | "lockfile-advisory-mismatch"
  | "native-dependency-in-wasm-graph"
  | "crypto-vector-revision-mismatch";

export interface VendorProvenanceViolation {
  readonly code: VendorProvenanceViolationCode;
  readonly path: string;
  readonly detail: string;
}

export interface VendorProvenanceReport {
  readonly ok: boolean;
  readonly verifiedFileCount: number;
  readonly upstreamGitSha1: string;
  readonly patchSha256: string;
  readonly violations: readonly VendorProvenanceViolation[];
}

interface ParsedFilePatch {
  readonly relativePath: string;
  readonly hunks: readonly {
    readonly oldStart: number;
    readonly oldCount: number;
    readonly newStart: number;
    readonly newCount: number;
    readonly removedLines: readonly string[];
    readonly addedLines: readonly string[];
  }[];
}

function splitLfLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/**
 * Parse a unified diff (`--unidiff-zero`) into per-file hunk lists.
 */
export function parseUnidiffZeroPatch(patchDiff: string): readonly ParsedFilePatch[] {
  const lines = splitLfLines(patchDiff);
  const files: {
    relativePath: string;
    hunks: {
      oldStart: number;
      oldCount: number;
      newStart: number;
      newCount: number;
      removedLines: string[];
      addedLines: string[];
    }[];
  }[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("--- a/")) {
      const oldRel = line.slice("--- a/".length).trim();
      const plusLine = lines[i + 1] ?? "";
      if (!plusLine.startsWith("+++ b/")) {
        throw new Error(`Malformed unified diff header after '${line}'`);
      }
      const newRel = plusLine.slice("+++ b/".length).trim();
      if (oldRel !== newRel) {
        throw new Error(`Renamed path '${oldRel}' -> '${newRel}' is not permitted in vendor patch`);
      }
      const entry: (typeof files)[number] = { relativePath: newRel, hunks: [] };
      files.push(entry);
      i += 2;
      while (i < lines.length && !(lines[i] ?? "").startsWith("--- a/")) {
        const hunkHeader = lines[i] ?? "";
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(hunkHeader);
        if (match === null) {
          throw new Error(`Malformed unified diff hunk header: '${hunkHeader}'`);
        }
        const oldStart = Number(match[1]);
        const oldCount = match[2] !== undefined ? Number(match[2]) : 1;
        const newStart = Number(match[3]);
        const newCount = match[4] !== undefined ? Number(match[4]) : 1;
        const removedLines: string[] = [];
        const addedLines: string[] = [];
        i += 1;
        while (
          i < lines.length &&
          !(lines[i] ?? "").startsWith("@@ ") &&
          !(lines[i] ?? "").startsWith("--- a/")
        ) {
          const bodyLine = lines[i] ?? "";
          if (bodyLine.startsWith("-")) {
            removedLines.push(bodyLine.slice(1));
          } else if (bodyLine.startsWith("+")) {
            addedLines.push(bodyLine.slice(1));
          }
          i += 1;
        }
        entry.hunks.push({ oldStart, oldCount, newStart, newCount, removedLines, addedLines });
      }
    } else {
      i += 1;
    }
  }
  return files;
}

/**
 * Verify that every `+` line in a parsed zero-context unified diff hunk appears at its exact
 * target line number in the patched file text.
 */
export function verifyPatchedFileHunks(patchedText: string, filePatch: ParsedFilePatch): void {
  const patchedLines = splitLfLines(patchedText);
  for (const hunk of filePatch.hunks) {
    if (hunk.removedLines.length !== hunk.oldCount || hunk.addedLines.length !== hunk.newCount) {
      throw new Error(`Hunk line count mismatch in '${filePatch.relativePath}'`);
    }
    for (let idx = 0; idx < hunk.addedLines.length; idx += 1) {
      const targetLineNumber = hunk.newStart + idx;
      const actualLine = patchedLines[targetLineNumber - 1];
      const expectedAdded = hunk.addedLines[idx];
      if (actualLine !== expectedAdded) {
        throw new Error(
          `Patched line ${String(targetLineNumber)} in '${filePatch.relativePath}' ('${actualLine ?? "<eof>"}') did not match '+${expectedAdded ?? ""}'`,
        );
      }
    }
  }
}

/**
 * Resolve the normal `wasm32v1-none` runtime crate set purely from workspace member `Cargo.toml`
 * `[dependencies]` sections and `soroban/Cargo.lock`, without requiring a local Rust toolchain.
 */
export function resolveWasmRuntimeCratesFromLock(params: {
  readonly memberCargoTomls: Readonly<Record<string, string>>;
  readonly cargoLock: string;
}): readonly string[] {
  const lockPackages = new Map<string, string[]>();
  const blocks = params.cargoLock.split("[[package]]").slice(1);
  for (const block of blocks) {
    const nameMatch = /\bname\s*=\s*"([^"]+)"/.exec(block);
    if (nameMatch?.[1] === undefined) continue;
    const pkgName = nameMatch[1];
    const depsMatch = /\bdependencies\s*=\s*\[([\s\S]*?)\]/.exec(block);
    const deps: string[] = [];
    if (depsMatch?.[1] !== undefined) {
      const itemRegex = /"([^"]+)"/g;
      let item = itemRegex.exec(depsMatch[1]);
      while (item !== null) {
        const token = (item[1] ?? "").split(" ")[0] ?? "";
        if (token.length > 0) deps.push(token);
        item = itemRegex.exec(depsMatch[1]);
      }
    }
    const existing = lockPackages.get(pkgName) ?? [];
    lockPackages.set(pkgName, [...new Set([...existing, ...deps])]);
  }

  // Extract `[dependencies]` (excluding `[dev-dependencies]` and `[build-dependencies]`) from each member.
  const queue: string[] = [];
  let sorobanSdkTestutilsEnabledInNormalDeps = false;

  for (const toml of Object.values(params.memberCargoTomls)) {
    const lines = splitLfLines(toml);
    let inNormalDeps = false;
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("[")) {
        inNormalDeps = trimmed === "[dependencies]";
        continue;
      }
      if (!inNormalDeps) continue;
      const depMatch = /^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/.exec(trimmed);
      if (depMatch?.[1] === undefined || depMatch[2] === undefined) continue;
      const depName = depMatch[1];
      const depSpec = depMatch[2];
      if (depName === "soroban-sdk" && /\btestutils\b/.test(depSpec)) {
        sorobanSdkTestutilsEnabledInNormalDeps = true;
      }
      queue.push(depName);
    }
  }

  // On `wasm32v1-none` without `testutils`, `soroban-sdk` activates guest/runtime & proc-macro
  // edges (`soroban-env-guest`, `soroban-sdk-macros`, `bytes-lit`, `stellar-strkey`, `visibility`)
  // and excludes `soroban-env-host`, `soroban-ledger-snapshot`, and `ed25519-dalek`.
  const sorobanSdkWasmDeps = [
    "bytes-lit",
    "soroban-env-guest",
    "soroban-sdk-macros",
    "stellar-strkey",
    "visibility",
  ];

  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    const children =
      current === "soroban-sdk" && !sorobanSdkTestutilsEnabledInNormalDeps
        ? sorobanSdkWasmDeps
        : (lockPackages.get(current) ?? []);
    for (const child of children) {
      if (!visited.has(child)) {
        queue.push(child);
      }
    }
  }

  return [...visited].sort((a, b) => a.localeCompare(b));
}

/**
 * Verify all vendored host provenance invariants and report exact relative paths for any drift.
 */
export function verifyVendorProvenance(
  manifest: VendorProvenanceManifest,
  observedFiles: readonly ObservedVendorFile[],
  contents: VendorProvenanceContents,
): VendorProvenanceReport {
  const violations: VendorProvenanceViolation[] = [];

  // 1. Exact file inventory & SHA-256 verification.
  const expectedByPath = new Map<string, VendorFileManifestEntry>(
    manifest.files.map((f) => [f.path, f]),
  );
  const observedByPath = new Map<string, string>(observedFiles.map((f) => [f.path, f.sha256]));

  for (const [path, expected] of expectedByPath) {
    const actualSha = observedByPath.get(path);
    if (actualSha === undefined) {
      violations.push({
        code: "missing-vendor-file",
        path,
        detail: `Expected vendored file '${path}' (${expected.role}) is missing.`,
      });
    } else if (actualSha.toLowerCase() !== expected.sha256.toLowerCase()) {
      violations.push({
        code: "modified-vendor-file",
        path,
        detail: `Unexpected modification in '${path}' (${expected.role}): expected sha256 ${expected.sha256}, got ${actualSha.toLowerCase()}.`,
      });
    }
  }

  for (const obs of observedFiles) {
    if (!expectedByPath.has(obs.path)) {
      violations.push({
        code: "unexpected-vendor-file",
        path: obs.path,
        detail: `Unexpected untracked file '${obs.path}' present under soroban/vendor.`,
      });
    }
  }

  // 2. Upstream git revision & VCS path check.
  try {
    const vcs = JSON.parse(contents.vcsInfoJson) as {
      readonly git?: { readonly sha1?: string };
      readonly path_in_vcs?: string;
    };
    if (
      vcs.git?.sha1 !== manifest.upstreamGitSha1 ||
      vcs.path_in_vcs !== manifest.upstreamPathInVcs
    ) {
      violations.push({
        code: "upstream-revision-mismatch",
        path: "soroban/vendor/soroban-env-host/.cargo_vcs_info.json",
        detail: `Expected upstream git sha1 '${manifest.upstreamGitSha1}' (${manifest.upstreamPathInVcs}), got '${vcs.git?.sha1 ?? "<missing>"}' (${vcs.path_in_vcs ?? "<missing>"}).`,
      });
    }
  } catch {
    violations.push({
      code: "upstream-revision-mismatch",
      path: "soroban/vendor/soroban-env-host/.cargo_vcs_info.json",
      detail: "Failed to parse .cargo_vcs_info.json.",
    });
  }

  // 3. Patch SHA-256, permitted patch file set, and `Cargo.toml.orig` -> `Cargo.toml` replay check.
  if (contents.patchSha256.toLowerCase() !== manifest.patchSha256.toLowerCase()) {
    violations.push({
      code: "patch-digest-mismatch",
      path: manifest.patchPath,
      detail: `Patch digest mismatch on '${manifest.patchPath}': expected ${manifest.patchSha256}, got ${contents.patchSha256.toLowerCase()}.`,
    });
  }

  try {
    const parsedPatches = parseUnidiffZeroPatch(contents.patchDiff);
    const permittedSet = new Set<string>(manifest.permittedPatchedPaths);
    for (const filePatch of parsedPatches) {
      const fullPath = `soroban/vendor/soroban-env-host/${filePatch.relativePath}`;
      if (!permittedSet.has(fullPath)) {
        violations.push({
          code: "unpermitted-patched-file",
          path: fullPath,
          detail: `Patch modifies unpermitted upstream file '${fullPath}'.`,
        });
      }
    }

    const cargoPatch = parsedPatches.find((p) => p.relativePath === "Cargo.toml");
    if (cargoPatch === undefined) {
      violations.push({
        code: "patch-replay-mismatch",
        path: "soroban/vendor/soroban-env-host/Cargo.toml",
        detail: "Missing Cargo.toml hunk in soroban-env-host-rustcrypto.patch.",
      });
    } else {
      verifyPatchedFileHunks(contents.vendorCargoToml, cargoPatch);
      if (!contents.vendorCargoTomlOrig.includes('name = "soroban-env-host"')) {
        violations.push({
          code: "patch-replay-mismatch",
          path: "soroban/vendor/soroban-env-host/Cargo.toml.orig",
          detail: "Cargo.toml.orig does not declare upstream package soroban-env-host.",
        });
      }
    }
  } catch (err) {
    violations.push({
      code: "patch-replay-mismatch",
      path: manifest.patchPath,
      detail: err instanceof Error ? err.message : "Failed to parse or replay vendor patch.",
    });
  }

  // 4. License metadata and Apache-2.0 text check.
  const licenseFieldMatch = /\blicense\s*=\s*"([^"]+)"/.exec(contents.vendorCargoToml);
  if (licenseFieldMatch?.[1] !== manifest.licenseSpdx) {
    violations.push({
      code: "license-mismatch",
      path: "soroban/vendor/soroban-env-host/Cargo.toml",
      detail: `Expected Cargo.toml license = "${manifest.licenseSpdx}", got "${licenseFieldMatch?.[1] ?? "<missing>"}".`,
    });
  }
  if (
    !contents.vendorLicense.includes("Apache License") ||
    !contents.vendorLicense.includes("Version 2.0, January 2004")
  ) {
    violations.push({
      code: "license-mismatch",
      path: "soroban/vendor/soroban-env-host/LICENSE",
      detail: "Vendored LICENSE file does not contain the Apache-2.0 license text.",
    });
  }

  // 5. Workspace lockfile advisory posture (`crypto-bigint >= 0.7.6` and local `soroban-env-host`).
  const cryptoBigintMatch = /name = "crypto-bigint"\r?\nversion = "(\d+)\.(\d+)\.(\d+)"/.exec(
    contents.workspaceCargoLock,
  );
  const major = Number(cryptoBigintMatch?.[1] ?? "0");
  const minor = Number(cryptoBigintMatch?.[2] ?? "0");
  const patch = Number(cryptoBigintMatch?.[3] ?? "0");
  const isPatchedCryptoBigint =
    major > 0 || (major === 0 && (minor > 7 || (minor === 7 && patch >= 6)));
  if (!isPatchedCryptoBigint) {
    violations.push({
      code: "lockfile-advisory-mismatch",
      path: "soroban/Cargo.lock",
      detail: "soroban/Cargo.lock does not select crypto-bigint >= 0.7.6 for RUSTSEC-2026-0387.",
    });
  }

  // 6. Native-only crate exclusion from WASM runtime dependency graph.
  const wasmSet = new Set<string>(contents.wasmNormalCrates);
  for (const forbidden of manifest.excludedWasmRuntimeCrates) {
    if (wasmSet.has(forbidden)) {
      violations.push({
        code: "native-dependency-in-wasm-graph",
        path: `wasm32v1-none:${forbidden}`,
        detail: `Native-only dependency '${forbidden}' leaked into the wasm32v1-none contract runtime graph.`,
      });
    }
  }

  // 7. Cryptographic vector test binding to verified upstream revision & patch digest.
  if (
    !contents.cryptoVectorsRust.includes(manifest.upstreamGitSha1) ||
    !contents.cryptoVectorsRust.includes(manifest.patchSha256)
  ) {
    violations.push({
      code: "crypto-vector-revision-mismatch",
      path: manifest.cryptoVectorsPath,
      detail: `Cryptographic vector suite '${manifest.cryptoVectorsPath}' does not reference verified upstream revision '${manifest.upstreamGitSha1}' and patch digest '${manifest.patchSha256}'.`,
    });
  }

  return {
    ok: violations.length === 0,
    verifiedFileCount: manifest.files.length,
    upstreamGitSha1: manifest.upstreamGitSha1,
    patchSha256: manifest.patchSha256,
    violations,
  };
}
