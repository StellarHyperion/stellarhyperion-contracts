//! Executable Rust check for `docs/SECURITY_ASSUMPTIONS.md`.
//!
//! Ensures Soroban CI independently catches broken file/symbol/guard/test references,
//! conflated adapter vs router authority regimes, missing active rail evidence providers,
//! and undocumented Soroban trust surfaces.

extern crate std;

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    string::{String, ToString},
    vec::Vec,
};

const ACTIVE_SOROBAN_RAILS: [&str; 2] = ["Cctp", "AxelarIts"];

const MONITORED_SOROBAN_FILES: [&str; 4] = [
    "soroban/crates/hyperion-router/src/lib.rs",
    "soroban/crates/hyperion-adapter-cctp/src/lib.rs",
    "soroban/crates/hyperion-adapter-axelar/src/lib.rs",
    "soroban/crates/hyperion-adapter-allbridge/src/lib.rs",
];

#[derive(Clone, Debug, PartialEq, Eq)]
struct InboundRow {
    id: String,
    rail: String,
    stack: String,
    posture: String,
    provider: String,
    contract_file: String,
    entrypoint_symbol: String,
    auth_guard: String,
    test_file: String,
    test_symbol: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AuthorityRow {
    id: String,
    surface: String,
    stack: String,
    contract_name: String,
    regime: String,
    setter_symbol: String,
    contract_file: String,
    auth_guard: String,
    test_file: String,
    test_symbol: String,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("canonicalize repository root")
}

fn parse_section_table(markdown: &str, heading: &str) -> Option<Vec<Vec<String>>> {
    let target = std::format!("## {heading}");
    let mut in_section = false;
    let mut table_lines: Vec<&str> = Vec::new();

    for raw in markdown.lines() {
        let trimmed = raw.trim();
        if trimmed.starts_with("## ") {
            if in_section {
                break;
            }
            if trimmed == target {
                in_section = true;
            }
            continue;
        }
        if !in_section {
            continue;
        }
        if trimmed.starts_with('|') && trimmed.ends_with('|') {
            table_lines.push(trimmed);
        } else if !table_lines.is_empty() {
            break;
        }
    }

    if table_lines.len() < 3 {
        return None;
    }

    Some(
        table_lines[2..]
            .iter()
            .map(|line| {
                line[1..line.len() - 1]
                    .split('|')
                    .map(|cell| cell.trim().to_string())
                    .collect::<Vec<_>>()
            })
            .collect(),
    )
}

fn extract_function_block<'a>(source: &'a str, decl_prefix: &str) -> Option<&'a str> {
    let start = source.find(decl_prefix)?;
    let bytes = source.as_bytes();
    let mut i = start;
    let mut depth: i32 = 0;
    let mut opened = false;

    while i < bytes.len() {
        let ch = bytes[i];
        let next = bytes.get(i + 1).copied();

        if ch == b'/' && next == Some(b'/') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if ch == b'/' && next == Some(b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        if ch == b'"' {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }

        if ch == b'{' {
            depth += 1;
            opened = true;
        } else if ch == b'}' {
            depth -= 1;
            if opened && depth == 0 {
                return Some(&source[start..=i]);
            }
        }
        i += 1;
    }
    None
}

fn discover_rust_pub_fns(source: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let needle = "pub fn ";
    let mut offset = 0usize;
    while let Some(rel) = source[offset..].find(needle) {
        let pos = offset + rel;
        let after = &source[pos + needle.len()..];
        if let Some(paren) = after.find('(') {
            let fn_name = after[..paren].trim();
            if !fn_name.is_empty()
                && fn_name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                let symbol = std::format!("pub fn {fn_name}(");
                if let Some(block) = extract_function_block(&source[pos..], &symbol) {
                    out.push((symbol, block.to_string()));
                }
            }
        }
        offset = pos + needle.len();
    }
    out
}

fn check_security_assumptions(markdown: &str, files: &BTreeMap<String, String>) -> Vec<String> {
    let mut errors = Vec::new();

    let Some(inbound_raw) = parse_section_table(markdown, "Inbound Evidence Authentication Matrix")
    else {
        errors.push("missing Inbound Evidence Authentication Matrix".to_string());
        return errors;
    };
    let Some(auth_raw) = parse_section_table(markdown, "Authority and Timelock Separation Matrix")
    else {
        errors.push("missing Authority and Timelock Separation Matrix".to_string());
        return errors;
    };

    let mut inbound_rows = Vec::new();
    for cells in inbound_raw {
        if cells.len() != 10 {
            errors.push(std::format!(
                "inbound row column count {} != 10",
                cells.len()
            ));
            continue;
        }
        inbound_rows.push(InboundRow {
            id: cells[0].clone(),
            rail: cells[1].clone(),
            stack: cells[2].clone(),
            posture: cells[3].clone(),
            provider: cells[4].clone(),
            contract_file: cells[5].clone(),
            entrypoint_symbol: cells[6].clone(),
            auth_guard: cells[7].clone(),
            test_file: cells[8].clone(),
            test_symbol: cells[9].clone(),
        });
    }

    let mut auth_rows = Vec::new();
    for cells in auth_raw {
        if cells.len() != 10 {
            errors.push(std::format!(
                "authority row column count {} != 10",
                cells.len()
            ));
            continue;
        }
        auth_rows.push(AuthorityRow {
            id: cells[0].clone(),
            surface: cells[1].clone(),
            stack: cells[2].clone(),
            contract_name: cells[3].clone(),
            regime: cells[4].clone(),
            setter_symbol: cells[5].clone(),
            contract_file: cells[6].clone(),
            auth_guard: cells[7].clone(),
            test_file: cells[8].clone(),
            test_symbol: cells[9].clone(),
        });
    }

    for active_rail in ACTIVE_SOROBAN_RAILS {
        let present = inbound_rows
            .iter()
            .any(|r| r.rail == active_rail && r.stack == "soroban");
        if !present {
            errors.push(std::format!(
                "active rail {active_rail} missing soroban inbound evidence entry"
            ));
        }
    }

    for row in &inbound_rows {
        let lower_provider = row.provider.trim().to_ascii_lowercase();
        if lower_provider.len() < 8
            || matches!(
                lower_provider.as_str(),
                "none" | "tbd" | "todo" | "unknown" | "-" | "n/a"
            )
        {
            errors.push(std::format!(
                "row {} missing concrete inbound evidence provider",
                row.id
            ));
        }
        let permitted_active =
            row.stack == "soroban" && ACTIVE_SOROBAN_RAILS.contains(&row.rail.as_str());
        if row.posture == "active-testnet-outbound" && !permitted_active {
            errors.push(std::format!(
                "row {} marks non-active surface {}/{} as active",
                row.id,
                row.rail,
                row.stack
            ));
        }

        match files.get(&row.contract_file) {
            None => errors.push(std::format!(
                "row {} missing contract file {}",
                row.id,
                row.contract_file
            )),
            Some(src) => match extract_function_block(src, &row.entrypoint_symbol) {
                None => errors.push(std::format!(
                    "row {} missing entrypoint {} in {}",
                    row.id,
                    row.entrypoint_symbol,
                    row.contract_file
                )),
                Some(block) => {
                    if row.auth_guard.is_empty() || !block.contains(&row.auth_guard) {
                        errors.push(std::format!(
                            "row {} missing guard '{}' inside {}",
                            row.id,
                            row.auth_guard,
                            row.entrypoint_symbol
                        ));
                    }
                }
            },
        }

        match files.get(&row.test_file) {
            None => errors.push(std::format!(
                "row {} missing test file {}",
                row.id,
                row.test_file
            )),
            Some(test_src) => {
                if row.test_symbol.is_empty() || !test_src.contains(&row.test_symbol) {
                    errors.push(std::format!(
                        "row {} missing test symbol {} in {}",
                        row.id,
                        row.test_symbol,
                        row.test_file
                    ));
                }
            }
        }
    }

    for row in &auth_rows {
        if row.surface == "adapter"
            && !matches!(
                row.regime.as_str(),
                "one-time-init" | "adapter-direct-admin" | "adapter-direct-owner"
            )
        {
            errors.push(std::format!(
                "adapter row {} uses router authority regime {}",
                row.id,
                row.regime
            ));
        }
        if row.surface == "router"
            && matches!(
                row.regime.as_str(),
                "adapter-direct-admin" | "adapter-direct-owner"
            )
        {
            errors.push(std::format!(
                "router row {} uses adapter authority regime {}",
                row.id,
                row.regime
            ));
        }

        match files.get(&row.contract_file) {
            None => errors.push(std::format!(
                "row {} missing contract file {}",
                row.id,
                row.contract_file
            )),
            Some(src) => match extract_function_block(src, &row.setter_symbol) {
                None => errors.push(std::format!(
                    "row {} missing setter {} in {}",
                    row.id,
                    row.setter_symbol,
                    row.contract_file
                )),
                Some(block) => {
                    if row.auth_guard.is_empty() || !block.contains(&row.auth_guard) {
                        errors.push(std::format!(
                            "row {} missing guard '{}' inside {}",
                            row.id,
                            row.auth_guard,
                            row.setter_symbol
                        ));
                    }
                }
            },
        }

        match files.get(&row.test_file) {
            None => errors.push(std::format!(
                "row {} missing test file {}",
                row.id,
                row.test_file
            )),
            Some(test_src) => {
                if row.test_symbol.is_empty() || !test_src.contains(&row.test_symbol) {
                    errors.push(std::format!(
                        "row {} missing test symbol {} in {}",
                        row.id,
                        row.test_symbol,
                        row.test_file
                    ));
                }
            }
        }
    }

    let mut auth_by_file: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for row in &auth_rows {
        auth_by_file
            .entry(row.contract_file.as_str())
            .or_default()
            .insert(row.setter_symbol.as_str());
    }
    let mut inbound_by_file: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for row in &inbound_rows {
        inbound_by_file
            .entry(row.contract_file.as_str())
            .or_default()
            .insert(row.entrypoint_symbol.as_str());
    }

    for monitored in MONITORED_SOROBAN_FILES {
        let Some(src) = files.get(monitored) else {
            errors.push(std::format!("missing monitored file {monitored}"));
            continue;
        };
        let is_router = monitored == "soroban/crates/hyperion-router/src/lib.rs";
        let known_auth = auth_by_file.get(monitored);
        let known_inbound = inbound_by_file.get(monitored);

        for (symbol, block) in discover_rust_pub_fns(src) {
            let touches_auth = if is_router {
                block.contains("storage::is_initialized")
                    || block.contains("cfg.admin")
                    || block.contains("cfg.guardian")
                    || block.contains("timelock::")
            } else {
                block.contains("storage::is_initialized")
                    || block.contains("require_admin")
                    || block.contains("cfg.admin.require_auth")
            };
            if touches_auth && !known_auth.is_some_and(|s| s.contains(symbol.as_str())) {
                errors.push(std::format!(
                    "undocumented authority surface {symbol} in {monitored}"
                ));
            }

            let touches_inbound = if is_router {
                block.contains("storage::mark_processed")
                    || block.contains("HyperionError::NotRailReceiver")
            } else {
                block.contains(".bridge_in(")
                    || block.contains("Self::bridge_in(")
                    || block.contains(".receive_message(")
                    || block.contains("cfg.its.require_auth")
                    || block.contains("ed25519_verify(")
            };
            if touches_inbound && !known_inbound.is_some_and(|s| s.contains(symbol.as_str())) {
                errors.push(std::format!(
                    "undocumented inbound surface {symbol} in {monitored}"
                ));
            }
        }
    }

    errors
}

fn load_live_snapshot() -> (String, BTreeMap<String, String>) {
    let root = repo_root();
    let markdown = fs::read_to_string(root.join("docs/SECURITY_ASSUMPTIONS.md"))
        .expect("read docs/SECURITY_ASSUMPTIONS.md");

    let mut paths: BTreeSet<String> = MONITORED_SOROBAN_FILES
        .iter()
        .map(|p| (*p).to_string())
        .collect();
    for table_name in [
        "Inbound Evidence Authentication Matrix",
        "Authority and Timelock Separation Matrix",
    ] {
        for row in parse_section_table(&markdown, table_name).expect("parse section table") {
            if table_name == "Inbound Evidence Authentication Matrix" {
                paths.insert(row[5].clone());
                paths.insert(row[8].clone());
            } else {
                paths.insert(row[6].clone());
                paths.insert(row[8].clone());
            }
        }
    }

    let mut files = BTreeMap::new();
    for rel in paths {
        let content = fs::read_to_string(root.join(&rel))
            .unwrap_or_else(|e| panic!("failed reading {rel}: {e}"));
        files.insert(rel, content);
    }
    (markdown, files)
}

#[test]
fn live_security_assumptions_doc_matches_contracts_and_tests() {
    let (markdown, files) = load_live_snapshot();
    let errors = check_security_assumptions(&markdown, &files);
    assert!(
        errors.is_empty(),
        "security assumption verification failed: {errors:#?}"
    );
}

fn replace_row_cell(markdown: &str, row_id: &str, col_idx: usize, next_val: &str) -> String {
    let mut replaced = false;
    let lines: Vec<String> = markdown
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if !trimmed.starts_with('|') || !trimmed.ends_with('|') {
                return line.to_string();
            }
            let mut cells: Vec<String> = trimmed[1..trimmed.len() - 1]
                .split('|')
                .map(|c| c.trim().to_string())
                .collect();
            if cells.first().map(String::as_str) != Some(row_id) {
                return line.to_string();
            }
            cells[col_idx] = next_val.to_string();
            replaced = true;
            std::format!("| {} |", cells.join(" | "))
        })
        .collect();
    assert!(replaced, "row {row_id} should exist in markdown");
    lines.join("\n")
}

#[test]
fn mutated_references_and_undocumented_trust_surfaces_fail_verification() {
    let (markdown, files) = load_live_snapshot();

    // 1. Conflating adapter admin authority with router timelock fails.
    let conflated = replace_row_cell(
        &markdown,
        "auth-soroban-axelar-link-chain",
        4,
        "router-timelock",
    );
    let errs_conflated = check_security_assumptions(&conflated, &files);
    assert!(errs_conflated
        .iter()
        .any(|e| e.contains("auth-soroban-axelar-link-chain")));

    // 2. Broken test symbol fails.
    let broken_test = replace_row_cell(
        &markdown,
        "inbound-soroban-cctp",
        9,
        "fn vanished_attestation_test(",
    );
    let errs_test = check_security_assumptions(&broken_test, &files);
    assert!(errs_test
        .iter()
        .any(|e| e.contains("inbound-soroban-cctp") && e.contains("vanished_attestation_test")));

    // 3. Undocumented Soroban router admin/guardian entrypoint fails.
    let mut extra_surface = files.clone();
    let router_src = extra_surface
        .get_mut("soroban/crates/hyperion-router/src/lib.rs")
        .expect("router source");
    *router_src = router_src.replace(
        "pub fn pause(",
        "pub fn silent_admin_override(env: Env, caller: Address) -> Result<(), HyperionError> { let cfg = storage::config(&env)?; if caller != cfg.admin { return Err(HyperionError::Unauthorized); } Ok(()) }\n\n    pub fn pause(",
    );
    let errs_extra = check_security_assumptions(&markdown, &extra_surface);
    assert!(errs_extra
        .iter()
        .any(|e| e.contains("undocumented authority surface pub fn silent_admin_override(")));
}
