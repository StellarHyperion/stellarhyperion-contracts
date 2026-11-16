import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type ObservedVendorFile,
  resolveWasmRuntimeCratesFromLock,
  type VendorProvenanceContents,
  type VendorProvenanceManifest,
  verifyVendorProvenance,
} from "../src/vendorProvenance.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../..");

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function collectObservedVendorFiles(dirPath: string): ObservedVendorFile[] {
  const out: ObservedVendorFile[] = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === "target") {
      continue;
    }
    const full = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectObservedVendorFiles(full));
    } else if (entry.isFile()) {
      const rel = relative(REPO_ROOT, full).replace(/\\/g, "/");
      out.push({
        path: rel,
        sha256: sha256Hex(readFileSync(full)),
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function readRepoUtf8(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

function loadLiveProvenanceFixture(): {
  readonly manifest: VendorProvenanceManifest;
  readonly observedFiles: readonly ObservedVendorFile[];
  readonly contents: VendorProvenanceContents;
} {
  const manifest = JSON.parse(
    readFileSync(resolve(TEST_DIR, "fixtures/vendor-provenance-manifest.json"), "utf8"),
  ) as VendorProvenanceManifest;

  const observedFiles = collectObservedVendorFiles(resolve(REPO_ROOT, "soroban/vendor"));
  const patchBytes = readFileSync(resolve(REPO_ROOT, manifest.patchPath));
  const workspaceCargoLock = readRepoUtf8("soroban/Cargo.lock");

  const memberCargoTomls: Record<string, string> = {
    "hyperion-core": readRepoUtf8("soroban/crates/hyperion-core/Cargo.toml"),
    "hyperion-router": readRepoUtf8("soroban/crates/hyperion-router/Cargo.toml"),
    "hyperion-adapter-cctp": readRepoUtf8("soroban/crates/hyperion-adapter-cctp/Cargo.toml"),
    "hyperion-adapter-axelar": readRepoUtf8("soroban/crates/hyperion-adapter-axelar/Cargo.toml"),
    "hyperion-adapter-allbridge": readRepoUtf8(
      "soroban/crates/hyperion-adapter-allbridge/Cargo.toml",
    ),
  };

  const wasmNormalCrates = resolveWasmRuntimeCratesFromLock({
    memberCargoTomls,
    cargoLock: workspaceCargoLock,
  });

  return {
    manifest,
    observedFiles,
    contents: {
      vcsInfoJson: readRepoUtf8("soroban/vendor/soroban-env-host/.cargo_vcs_info.json"),
      vendorCargoToml: readRepoUtf8("soroban/vendor/soroban-env-host/Cargo.toml"),
      vendorCargoTomlOrig: readRepoUtf8("soroban/vendor/soroban-env-host/Cargo.toml.orig"),
      vendorLicense: readRepoUtf8("soroban/vendor/soroban-env-host/LICENSE"),
      patchDiff: patchBytes.toString("utf8"),
      patchSha256: sha256Hex(patchBytes),
      cryptoVectorsRust: readRepoUtf8(manifest.cryptoVectorsPath),
      workspaceCargoLock,
      wasmNormalCrates,
    },
  };
}

describe("vendored Soroban host dependency provenance verifier", () => {
  it("verifies live upstream revision, permitted patch replay, Apache-2.0 license, and 272-file digests", () => {
    const { manifest, observedFiles, contents } = loadLiveProvenanceFixture();
    const report = verifyVendorProvenance(manifest, observedFiles, contents);

    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.verifiedFileCount).toBe(272);
    expect(report.upstreamGitSha1).toBe("5061e9c40ce6fc74ade9b9b3b49465b0cf7fdccb");
    expect(report.patchSha256).toBe(
      "48a21c883fafa443d1df73c3d58ba147415b12fe2f2cd2e923619d2e9e97ef0d",
    );
  });

  it("fails with exact relative paths when vendored files are modified, added, deleted, or unpermitted", () => {
    const { manifest, observedFiles, contents } = loadLiveProvenanceFixture();

    // 1. Unexpected modification to an unchanged upstream source file.
    const targetModified = "soroban/vendor/soroban-env-host/src/host.rs";
    const mutatedObserved = observedFiles.map((f) =>
      f.path === targetModified ? { ...f, sha256: "ff".repeat(32) } : f,
    );
    const modifiedReport = verifyVendorProvenance(manifest, mutatedObserved, contents);
    expect(modifiedReport.ok).toBe(false);
    expect(modifiedReport.violations).toEqual([
      expect.objectContaining({
        code: "modified-vendor-file",
        path: targetModified,
      }),
    ]);

    // 2. Unexpected untracked file inside soroban/vendor.
    const roguePath = "soroban/vendor/soroban-env-host/src/rogue_backdoor.rs";
    const addedReport = verifyVendorProvenance(
      manifest,
      [...observedFiles, { path: roguePath, sha256: "aa".repeat(32) }],
      contents,
    );
    expect(addedReport.ok).toBe(false);
    expect(addedReport.violations).toEqual([
      expect.objectContaining({
        code: "unexpected-vendor-file",
        path: roguePath,
      }),
    ]);

    // 3. Missing vendored file.
    const deletedPath = "soroban/vendor/soroban-env-host/LICENSE";
    const missingReport = verifyVendorProvenance(
      manifest,
      observedFiles.filter((f) => f.path !== deletedPath),
      contents,
    );
    expect(missingReport.ok).toBe(false);
    expect(missingReport.violations).toEqual([
      expect.objectContaining({
        code: "missing-vendor-file",
        path: deletedPath,
      }),
    ]);

    // 4. Unpermitted upstream file added to the patch diff.
    const unpermittedDiff = `${contents.patchDiff}\n--- a/src/host.rs\n+++ b/src/host.rs\n@@ -1 +1 @@\n-// old\n+// new\n`;
    const unpermittedReport = verifyVendorProvenance(manifest, observedFiles, {
      ...contents,
      patchDiff: unpermittedDiff,
    });
    expect(unpermittedReport.ok).toBe(false);
    expect(unpermittedReport.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unpermitted-patched-file",
          path: "soroban/vendor/soroban-env-host/src/host.rs",
        }),
      ]),
    );
  });

  it("ensures native-only dependencies stay excluded from wasm32v1-none and crypto vectors reference the patch", () => {
    const { manifest, observedFiles, contents } = loadLiveProvenanceFixture();

    expect(contents.wasmNormalCrates).toContain("soroban-env-guest");
    for (const forbidden of manifest.excludedWasmRuntimeCrates) {
      expect(contents.wasmNormalCrates).not.toContain(forbidden);
    }

    // Enabling `testutils` in normal `[dependencies]` leaks `soroban-env-host` & `ed25519-dalek` and fails.
    const leakedWasmCrates = resolveWasmRuntimeCratesFromLock({
      memberCargoTomls: {
        "hyperion-router": `[package]\nname = "hyperion-router"\n[dependencies]\nsoroban-sdk = { workspace = true, features = ["testutils"] }\n`,
      },
      cargoLock: contents.workspaceCargoLock,
    });
    const leakedReport = verifyVendorProvenance(manifest, observedFiles, {
      ...contents,
      wasmNormalCrates: leakedWasmCrates,
    });
    expect(leakedReport.ok).toBe(false);
    expect(leakedReport.violations.map((v) => v.path)).toEqual(
      expect.arrayContaining([
        "wasm32v1-none:soroban-env-host",
        "wasm32v1-none:k256",
        "wasm32v1-none:p256",
        "wasm32v1-none:ed25519-dalek",
      ]),
    );

    // Stripping the verified patch SHA-256 from `hyperion_crypto_compatibility.rs` fails provenance.
    const unpinnedCryptoReport = verifyVendorProvenance(manifest, observedFiles, {
      ...contents,
      cryptoVectorsRust: contents.cryptoVectorsRust.replace(manifest.patchSha256, "00".repeat(32)),
    });
    expect(unpinnedCryptoReport.ok).toBe(false);
    expect(unpinnedCryptoReport.violations).toEqual([
      expect.objectContaining({
        code: "crypto-vector-revision-mismatch",
        path: "soroban/vendor/soroban-env-host/tests/hyperion_crypto_compatibility.rs",
      }),
    ]);
  });
});
