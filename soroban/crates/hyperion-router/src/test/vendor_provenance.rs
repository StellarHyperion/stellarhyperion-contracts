//! Vendored Soroban native host provenance and WASM runtime graph isolation tests.

extern crate std;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::string::{String as StdString, ToString};
use std::vec::Vec as StdVec;

use soroban_sdk::{Bytes, Env};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("canonical repo root")
}

fn hex_lower(bytes: &[u8]) -> StdString {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = StdString::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> StdString {
    let env = Env::default();
    let digest = env.crypto().sha256(&Bytes::from_slice(&env, bytes));
    hex_lower(&digest.to_array())
}

fn collect_vendor_files(root: &Path, dir: &Path, out: &mut BTreeMap<StdString, StdString>) {
    for entry in fs::read_dir(dir).expect("read vendor directory") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().and_then(|n| n.to_str()) == Some("target") {
                continue;
            }
            collect_vendor_files(root, &path, out);
        } else if path.is_file() {
            let rel = path
                .strip_prefix(root)
                .expect("strip repo root")
                .to_string_lossy()
                .replace('\\', "/");
            let data = fs::read(&path).expect("read vendor file bytes");
            out.insert(rel, sha256_hex(&data));
        }
    }
}

#[derive(Clone, Debug)]
struct ManifestExpectations {
    upstream_git_sha1: StdString,
    patch_path: StdString,
    patch_sha256: StdString,
    crypto_vectors_path: StdString,
    excluded_wasm_crates: StdVec<StdString>,
    files: BTreeMap<StdString, StdString>,
}

fn extract_json_string(raw: &str, key: &str) -> StdString {
    let needle = std::format!("\"{key}\"");
    let pos = raw.find(&needle).expect("find json key") + needle.len();
    let colon = pos + raw[pos..].find(':').expect("colon");
    let first_quote = colon + 1 + raw[colon + 1..].find('"').expect("opening quote");
    let end_quote = first_quote + 1 + raw[first_quote + 1..].find('"').expect("closing quote");
    raw[first_quote + 1..end_quote].to_string()
}

fn extract_json_string_array(raw: &str, key: &str) -> StdVec<StdString> {
    let needle = std::format!("\"{key}\"");
    let pos = raw.find(&needle).expect("find json array key") + needle.len();
    let open = pos + raw[pos..].find('[').expect("open bracket");
    let close = open + raw[open..].find(']').expect("close bracket");
    let segment = &raw[open + 1..close];
    let mut out = StdVec::new();
    let mut cursor = 0usize;
    while let Some(q1_rel) = segment[cursor..].find('"') {
        let q1 = cursor + q1_rel + 1;
        let q2 = q1 + segment[q1..].find('"').expect("closing item quote");
        out.push(segment[q1..q2].to_string());
        cursor = q2 + 1;
    }
    out
}

fn load_manifest() -> ManifestExpectations {
    let raw = fs::read_to_string(
        repo_root().join("packages/protocol/test/fixtures/vendor-provenance-manifest.json"),
    )
    .expect("read vendor-provenance-manifest.json");

    let files_pos = raw.find("\"files\"").expect("files section");
    let files_slice = &raw[files_pos..];
    let mut files = BTreeMap::new();
    let mut cursor = 0usize;
    while let Some(path_key_rel) = files_slice[cursor..].find("\"path\"") {
        let obj_slice = &files_slice[cursor + path_key_rel..];
        let close_brace = obj_slice.find('}').expect("file entry brace");
        let entry_raw = &obj_slice[..close_brace];
        let path = extract_json_string(entry_raw, "path");
        let sha256 = extract_json_string(entry_raw, "sha256");
        files.insert(path, sha256);
        cursor += path_key_rel + close_brace + 1;
    }

    ManifestExpectations {
        upstream_git_sha1: extract_json_string(&raw, "upstreamGitSha1"),
        patch_path: extract_json_string(&raw, "patchPath"),
        patch_sha256: extract_json_string(&raw, "patchSha256"),
        crypto_vectors_path: extract_json_string(&raw, "cryptoVectorsPath"),
        excluded_wasm_crates: extract_json_string_array(&raw, "excludedWasmRuntimeCrates"),
        files,
    }
}

fn diff_vendor_tree(
    expected: &BTreeMap<StdString, StdString>,
    observed: &BTreeMap<StdString, StdString>,
) -> StdVec<StdString> {
    let mut violations = StdVec::new();
    for (path, exp_sha) in expected {
        match observed.get(path) {
            None => violations.push(std::format!("missing-vendor-file:{path}")),
            Some(act_sha) if act_sha != exp_sha => {
                violations.push(std::format!("modified-vendor-file:{path}"))
            }
            Some(_) => {}
        }
    }
    for path in observed.keys() {
        if !expected.contains_key(path) {
            violations.push(std::format!("unexpected-vendor-file:{path}"));
        }
    }
    violations
}

#[test]
fn vendored_host_files_patch_revision_and_crypto_vectors_match_provenance_manifest() {
    let root = repo_root();
    let manifest = load_manifest();
    assert_eq!(manifest.files.len(), 272);

    let mut observed = BTreeMap::new();
    collect_vendor_files(&root, &root.join("soroban/vendor"), &mut observed);
    let violations = diff_vendor_tree(&manifest.files, &observed);
    assert!(
        violations.is_empty(),
        "unexpected vendored host provenance drift: {violations:?}"
    );

    // Verify `.cargo_vcs_info.json`, patch digest, and crypto vector revision references.
    let vcs_raw =
        fs::read_to_string(root.join("soroban/vendor/soroban-env-host/.cargo_vcs_info.json"))
            .unwrap();
    assert!(vcs_raw.contains(&manifest.upstream_git_sha1));

    let patch_bytes = fs::read(root.join(&manifest.patch_path)).unwrap();
    assert_eq!(sha256_hex(&patch_bytes), manifest.patch_sha256);

    let crypto_vectors = fs::read_to_string(root.join(&manifest.crypto_vectors_path)).unwrap();
    assert!(crypto_vectors.contains(&manifest.upstream_git_sha1));
    assert!(crypto_vectors.contains(&manifest.patch_sha256));

    // Verify local failure fixtures report exact relative paths.
    let mut modified_obs = observed.clone();
    modified_obs.insert(
        "soroban/vendor/soroban-env-host/src/crypto/mod.rs".to_string(),
        "00".repeat(32),
    );
    assert_eq!(
        diff_vendor_tree(&manifest.files, &modified_obs),
        StdVec::from([
            "modified-vendor-file:soroban/vendor/soroban-env-host/src/crypto/mod.rs".to_string()
        ])
    );

    let mut added_obs = observed.clone();
    added_obs.insert(
        "soroban/vendor/soroban-env-host/src/unexpected_helper.rs".to_string(),
        "11".repeat(32),
    );
    assert_eq!(
        diff_vendor_tree(&manifest.files, &added_obs),
        StdVec::from([
            "unexpected-vendor-file:soroban/vendor/soroban-env-host/src/unexpected_helper.rs"
                .to_string()
        ])
    );

    let mut deleted_obs = observed;
    deleted_obs.remove("soroban/vendor/soroban-env-host/LICENSE");
    assert_eq!(
        diff_vendor_tree(&manifest.files, &deleted_obs),
        StdVec::from(["missing-vendor-file:soroban/vendor/soroban-env-host/LICENSE".to_string()])
    );
}

#[test]
fn native_only_host_dependencies_are_excluded_from_wasm32v1_none_runtime_graph() {
    let root = repo_root();
    let manifest = load_manifest();

    let output = Command::new("cargo")
        .args([
            "tree",
            "--manifest-path",
            root.join("soroban/Cargo.toml").to_str().unwrap(),
            "--target",
            "wasm32v1-none",
            "-e",
            "normal",
            "--locked",
            "--prefix",
            "none",
        ])
        .output()
        .expect("run cargo tree --target wasm32v1-none -e normal --locked");

    assert!(
        output.status.success(),
        "cargo tree failed: {}",
        StdString::from_utf8_lossy(&output.stderr)
    );

    let stdout = StdString::from_utf8(output.stdout).expect("utf8 cargo tree stdout");
    let wasm_crates: BTreeSet<&str> = stdout
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .collect();

    assert!(wasm_crates.contains("soroban-env-guest"));
    assert!(wasm_crates.contains("hyperion-router"));
    for forbidden in &manifest.excluded_wasm_crates {
        assert!(
            !wasm_crates.contains(forbidden.as_str()),
            "native-only crate '{forbidden}' leaked into wasm32v1-none runtime dependency graph"
        );
    }
}
