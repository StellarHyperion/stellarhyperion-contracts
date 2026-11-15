/**
 * Executable verification for `docs/SECURITY_ASSUMPTIONS.md`.
 *
 * Parses the markdown matrices that tie each rail's inbound evidence provider and each
 * contract's authority regime to concrete source files, function declarations, in-body
 * authorization guards and unit test assertions, then checks both directions:
 *   1. Every documented reference resolves against the live repository sources.
 *   2. Every privileged setter or inbound delivery surface in the monitored Soroban and EVM
 *      contracts is registered under the matching authority or inbound evidence matrix.
 *
 * Pure string processing with zero Node.js builtins so `@hyperion/protocol` stays browser-safe.
 */

import { ROUTE_KINDS, type RouteKind } from "./routes.js";

/** Canonical variant names of `RouteKind` across Rust, Solidity and TypeScript. */
export type RouteVariantName = keyof typeof RouteKind;

export const ROUTE_VARIANT_NAMES: readonly RouteVariantName[] = [
  "Cctp",
  "AxelarIts",
  "AxelarGmp",
  "Allbridge",
] as const;

/** Rails enabled on the active Stellar Testnet outbound deployment. */
export const ACTIVE_TESTNET_RAILS: readonly RouteVariantName[] = ["Cctp", "AxelarIts"] as const;

/** Rail column values permitted in the Inbound Evidence Authentication Matrix. */
export type DocumentedRail = RouteVariantName | "RouterAllRails";

/** Stack identifier in the security assumption matrices. */
export type AssumptionStack = "soroban" | "evm";

/** Deployment gating posture recorded per rail surface. */
export type DeploymentPosture = "active-testnet-outbound" | "gated";

/** Authority regimes distinguishing router timelocks from immediate brakes and direct adapter admin. */
export type AuthorityRegime =
  | "one-time-init"
  | "router-timelock"
  | "router-immediate-narrowing"
  | "router-immediate-recovery"
  | "router-blocked-bypass"
  | "adapter-direct-admin"
  | "adapter-direct-owner";

export interface InboundEvidenceRow {
  readonly id: string;
  readonly rail: DocumentedRail;
  readonly stack: AssumptionStack;
  readonly deploymentPosture: DeploymentPosture;
  readonly evidenceProvider: string;
  readonly contractFile: string;
  readonly entrypointSymbol: string;
  readonly authGuard: string;
  readonly testFile: string;
  readonly testSymbol: string;
}

export interface AuthoritySeparationRow {
  readonly id: string;
  readonly surface: "router" | "adapter";
  readonly stack: AssumptionStack;
  readonly contractName: string;
  readonly authorityRegime: AuthorityRegime;
  readonly setterSymbol: string;
  readonly contractFile: string;
  readonly authGuard: string;
  readonly testFile: string;
  readonly testSymbol: string;
}

export interface ParsedSecurityAssumptions {
  readonly inboundEvidence: readonly InboundEvidenceRow[];
  readonly authoritySeparation: readonly AuthoritySeparationRow[];
}

export type SecurityViolationCode =
  | "markdown-structure-error"
  | "duplicate-row-id"
  | "missing-file"
  | "missing-symbol"
  | "missing-auth-guard"
  | "missing-test-assertion"
  | "active-rail-missing-provider"
  | "rail-coverage-gap"
  | "ungated-non-active-surface"
  | "authority-regime-mismatch"
  | "undocumented-trust-surface";

export interface SecurityAssumptionViolation {
  readonly code: SecurityViolationCode;
  readonly rowId?: string;
  readonly file?: string;
  readonly symbol?: string;
  readonly message: string;
}

export interface SecurityAssumptionCheckResult {
  readonly ok: boolean;
  readonly inboundRowCount: number;
  readonly authorityRowCount: number;
  readonly verifiedFiles: readonly string[];
  readonly violations: readonly SecurityAssumptionViolation[];
}

/** Monitored contract implementation files scanned for undocumented trust surfaces. */
export const MONITORED_CONTRACT_FILES = [
  "soroban/crates/hyperion-router/src/lib.rs",
  "soroban/crates/hyperion-adapter-cctp/src/lib.rs",
  "soroban/crates/hyperion-adapter-axelar/src/lib.rs",
  "soroban/crates/hyperion-adapter-allbridge/src/lib.rs",
  "evm/src/HyperionRouter.sol",
  "evm/src/adapters/CctpAdapter.sol",
  "evm/src/adapters/AxelarItsAdapter.sol",
] as const;

const VALID_RAILS = new Set<string>([...ROUTE_VARIANT_NAMES, "RouterAllRails"]);
const VALID_STACKS = new Set<string>(["soroban", "evm"]);
const VALID_POSTURES = new Set<string>(["active-testnet-outbound", "gated"]);
const VALID_SURFACES = new Set<string>(["router", "adapter"]);
const VALID_REGIMES = new Set<string>([
  "one-time-init",
  "router-timelock",
  "router-immediate-narrowing",
  "router-immediate-recovery",
  "router-blocked-bypass",
  "adapter-direct-admin",
  "adapter-direct-owner",
]);

const PLACEHOLDER_PROVIDERS = new Set(["", "-", "none", "n/a", "na", "tbd", "todo", "unknown"]);

function cellAt(cells: readonly string[], index: number): string {
  return (cells[index] ?? "").trim();
}

function parseMarkdownSectionTable(
  markdown: string,
  heading: string,
): { readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] } | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headingLine = `## ${heading}`;
  let inSection = false;
  const tableLines: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("## ")) {
      if (inSection) break;
      if (trimmed === headingLine) {
        inSection = true;
      }
      continue;
    }
    if (!inSection) continue;
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      tableLines.push(trimmed);
    } else if (tableLines.length > 0) {
      break;
    }
  }

  if (tableLines.length < 3) return null;
  const splitRow = (line: string): string[] =>
    line
      .slice(1, -1)
      .split("|")
      .map((part) => part.trim());

  const headerLine = tableLines[0];
  if (headerLine === undefined) return null;
  const headers = splitRow(headerLine);
  const rows = tableLines.slice(2).map(splitRow);
  return { headers, rows };
}

/**
 * Parse `docs/SECURITY_ASSUMPTIONS.md` into typed inbound-evidence and authority matrices,
 * collecting structural errors rather than throwing so callers receive actionable diagnostics.
 */
export function parseSecurityAssumptionsMarkdown(markdown: string): {
  readonly parsed: ParsedSecurityAssumptions;
  readonly violations: readonly SecurityAssumptionViolation[];
} {
  const violations: SecurityAssumptionViolation[] = [];
  const inboundEvidence: InboundEvidenceRow[] = [];
  const authoritySeparation: AuthoritySeparationRow[] = [];
  const seenIds = new Set<string>();

  const inboundTable = parseMarkdownSectionTable(
    markdown,
    "Inbound Evidence Authentication Matrix",
  );
  if (inboundTable === null) {
    violations.push({
      code: "markdown-structure-error",
      message: "Missing or malformed '## Inbound Evidence Authentication Matrix' markdown table.",
    });
  } else {
    const expectedHeaders = [
      "id",
      "rail",
      "stack",
      "deployment_posture",
      "evidence_provider",
      "contract_file",
      "entrypoint_symbol",
      "auth_guard",
      "test_file",
      "test_symbol",
    ];
    if (inboundTable.headers.join(",") !== expectedHeaders.join(",")) {
      violations.push({
        code: "markdown-structure-error",
        message: `Inbound matrix headers must be [${expectedHeaders.join(", ")}], got [${inboundTable.headers.join(", ")}].`,
      });
    }
    for (const cells of inboundTable.rows) {
      if (cells.length !== 10) {
        violations.push({
          code: "markdown-structure-error",
          message: `Inbound matrix row has ${String(cells.length)} columns; expected 10.`,
        });
        continue;
      }
      const id = cellAt(cells, 0);
      const rail = cellAt(cells, 1);
      const stack = cellAt(cells, 2);
      const posture = cellAt(cells, 3);
      if (seenIds.has(id)) {
        violations.push({
          code: "duplicate-row-id",
          rowId: id,
          message: `Duplicate security assumption row id '${id}'.`,
        });
      }
      seenIds.add(id);

      if (!VALID_RAILS.has(rail) || !VALID_STACKS.has(stack) || !VALID_POSTURES.has(posture)) {
        violations.push({
          code: "markdown-structure-error",
          rowId: id,
          message: `Invalid enum value in inbound row '${id}' (rail='${rail}', stack='${stack}', posture='${posture}').`,
        });
        continue;
      }

      inboundEvidence.push({
        id,
        rail: rail as DocumentedRail,
        stack: stack as AssumptionStack,
        deploymentPosture: posture as DeploymentPosture,
        evidenceProvider: cellAt(cells, 4),
        contractFile: cellAt(cells, 5),
        entrypointSymbol: cellAt(cells, 6),
        authGuard: cellAt(cells, 7),
        testFile: cellAt(cells, 8),
        testSymbol: cellAt(cells, 9),
      });
    }
  }

  const authorityTable = parseMarkdownSectionTable(
    markdown,
    "Authority and Timelock Separation Matrix",
  );
  if (authorityTable === null) {
    violations.push({
      code: "markdown-structure-error",
      message: "Missing or malformed '## Authority and Timelock Separation Matrix' markdown table.",
    });
  } else {
    const expectedHeaders = [
      "id",
      "surface",
      "stack",
      "contract_name",
      "authority_regime",
      "setter_symbol",
      "contract_file",
      "auth_guard",
      "test_file",
      "test_symbol",
    ];
    if (authorityTable.headers.join(",") !== expectedHeaders.join(",")) {
      violations.push({
        code: "markdown-structure-error",
        message: `Authority matrix headers must be [${expectedHeaders.join(", ")}], got [${authorityTable.headers.join(", ")}].`,
      });
    }
    for (const cells of authorityTable.rows) {
      if (cells.length !== 10) {
        violations.push({
          code: "markdown-structure-error",
          message: `Authority matrix row has ${String(cells.length)} columns; expected 10.`,
        });
        continue;
      }
      const id = cellAt(cells, 0);
      const surface = cellAt(cells, 1);
      const stack = cellAt(cells, 2);
      const regime = cellAt(cells, 4);
      if (seenIds.has(id)) {
        violations.push({
          code: "duplicate-row-id",
          rowId: id,
          message: `Duplicate security assumption row id '${id}'.`,
        });
      }
      seenIds.add(id);

      if (!VALID_SURFACES.has(surface) || !VALID_STACKS.has(stack) || !VALID_REGIMES.has(regime)) {
        violations.push({
          code: "markdown-structure-error",
          rowId: id,
          message: `Invalid enum value in authority row '${id}' (surface='${surface}', stack='${stack}', regime='${regime}').`,
        });
        continue;
      }

      authoritySeparation.push({
        id,
        surface: surface as "router" | "adapter",
        stack: stack as AssumptionStack,
        contractName: cellAt(cells, 3),
        authorityRegime: regime as AuthorityRegime,
        setterSymbol: cellAt(cells, 5),
        contractFile: cellAt(cells, 6),
        authGuard: cellAt(cells, 7),
        testFile: cellAt(cells, 8),
        testSymbol: cellAt(cells, 9),
      });
    }
  }

  return {
    parsed: { inboundEvidence, authoritySeparation },
    violations,
  };
}

/**
 * Extract the full declaration + body block starting at `declarationPrefix` (e.g. `pub fn receive(`
 * or `function executeAction(`) through the matching closing brace `}` of its body.
 */
export function extractFunctionBlock(source: string, declarationPrefix: string): string | null {
  const start = source.indexOf(declarationPrefix);
  if (start === -1) return null;

  let depth = 0;
  let opened = false;
  let i = start;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      const newline = source.indexOf("\n", i + 2);
      if (newline === -1) break;
      i = newline + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 2;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === "{") {
      depth += 1;
      opened = true;
    } else if (ch === "}") {
      depth -= 1;
      if (opened && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
    i += 1;
  }

  return null;
}

interface DiscoveredFunction {
  readonly name: string;
  readonly symbol: string;
  readonly header: string;
  readonly block: string;
}

function discoverRustPubFunctions(source: string): readonly DiscoveredFunction[] {
  const results: DiscoveredFunction[] = [];
  const regex = /\bpub\s+fn\s+([A-Za-z0-9_]+)\s*\(/g;
  let match = regex.exec(source);
  while (match !== null) {
    const name = match[1] ?? "";
    const symbol = `pub fn ${name}(`;
    const block = extractFunctionBlock(source.slice(match.index), symbol);
    if (block !== null) {
      const braceIdx = block.indexOf("{");
      const header = braceIdx === -1 ? block : block.slice(0, braceIdx);
      results.push({ name, symbol, header, block });
    }
    match = regex.exec(source);
  }
  return results;
}

function discoverSolidityFunctions(source: string): readonly DiscoveredFunction[] {
  const results: DiscoveredFunction[] = [];
  const regex = /\bfunction\s+([A-Za-z0-9_]+)\s*\(/g;
  let match = regex.exec(source);
  while (match !== null) {
    const name = match[1] ?? "";
    const symbol = `function ${name}(`;
    const block = extractFunctionBlock(source.slice(match.index), symbol);
    if (block !== null) {
      const braceIdx = block.indexOf("{");
      const header = braceIdx === -1 ? block : block.slice(0, braceIdx);
      results.push({ name, symbol, header, block });
    }
    match = regex.exec(source);
  }
  return results;
}

function validateAuthorityRegimeConsistency(
  row: AuthoritySeparationRow,
  functionBlock: string,
  violations: SecurityAssumptionViolation[],
): void {
  if (row.surface === "adapter") {
    if (
      row.authorityRegime === "router-timelock" ||
      row.authorityRegime === "router-immediate-narrowing" ||
      row.authorityRegime === "router-immediate-recovery" ||
      row.authorityRegime === "router-blocked-bypass"
    ) {
      violations.push({
        code: "authority-regime-mismatch",
        rowId: row.id,
        file: row.contractFile,
        symbol: row.setterSymbol,
        message: `Adapter row '${row.id}' cannot claim router authority regime '${row.authorityRegime}'; adapters execute immediately without an internal timelock.`,
      });
      return;
    }
    if (row.stack === "soroban" && row.authorityRegime === "adapter-direct-admin") {
      if (
        !functionBlock.includes("require_admin") &&
        !functionBlock.includes("admin.require_auth")
      ) {
        violations.push({
          code: "authority-regime-mismatch",
          rowId: row.id,
          file: row.contractFile,
          symbol: row.setterSymbol,
          message: `Soroban adapter-direct-admin row '${row.id}' must enforce 'require_admin' or 'admin.require_auth'.`,
        });
      }
    }
    if (row.stack === "evm" && row.authorityRegime === "adapter-direct-owner") {
      if (!functionBlock.includes("onlyOwner")) {
        violations.push({
          code: "authority-regime-mismatch",
          rowId: row.id,
          file: row.contractFile,
          symbol: row.setterSymbol,
          message: `EVM adapter-direct-owner row '${row.id}' must enforce 'onlyOwner'.`,
        });
      }
    }
  } else {
    if (
      row.authorityRegime === "adapter-direct-admin" ||
      row.authorityRegime === "adapter-direct-owner"
    ) {
      violations.push({
        code: "authority-regime-mismatch",
        rowId: row.id,
        file: row.contractFile,
        symbol: row.setterSymbol,
        message: `Router row '${row.id}' cannot use adapter authority regime '${row.authorityRegime}'.`,
      });
      return;
    }
    const isTimelockEntry =
      row.setterSymbol === "pub fn queue_action(" ||
      row.setterSymbol === "pub fn execute_action(" ||
      row.setterSymbol === "function queueAction(" ||
      row.setterSymbol === "function executeAction(";
    if (isTimelockEntry && row.authorityRegime !== "router-timelock") {
      violations.push({
        code: "authority-regime-mismatch",
        rowId: row.id,
        file: row.contractFile,
        symbol: row.setterSymbol,
        message: `Router timelock entrypoint '${row.setterSymbol}' must use regime 'router-timelock', got '${row.authorityRegime}'.`,
      });
    }
    if (row.authorityRegime === "router-timelock") {
      const hasTimelockMechanism =
        functionBlock.includes("timelock::") ||
        functionBlock.includes("timelockDelay") ||
        functionBlock.includes("queued.eta");
      if (!hasTimelockMechanism) {
        violations.push({
          code: "authority-regime-mismatch",
          rowId: row.id,
          file: row.contractFile,
          symbol: row.setterSymbol,
          message: `Router row '${row.id}' claims 'router-timelock' without referencing timelock queue or ETA enforcement.`,
        });
      }
    }
  }
}

/**
 * Verify `docs/SECURITY_ASSUMPTIONS.md` against a map of repository file paths (POSIX relative
 * paths from repo root) to their UTF-8 contents.
 */
export function verifySecurityAssumptions(
  markdown: string,
  repoFiles: Readonly<Record<string, string>>,
): SecurityAssumptionCheckResult {
  const { parsed, violations: parseViolations } = parseSecurityAssumptionsMarkdown(markdown);
  const violations: SecurityAssumptionViolation[] = [...parseViolations];
  const touchedFiles = new Set<string>(MONITORED_CONTRACT_FILES);

  // 1. Check active testnet rail coverage & explicit gating on non-active surfaces.
  for (const activeRail of ACTIVE_TESTNET_RAILS) {
    const matching = parsed.inboundEvidence.filter(
      (row) => row.rail === activeRail && row.stack === "soroban",
    );
    if (matching.length === 0) {
      violations.push({
        code: "rail-coverage-gap",
        message: `Active Stellar Testnet rail '${activeRail}' has no Soroban inbound evidence entry.`,
      });
    }
  }

  if (ROUTE_VARIANT_NAMES.length !== ROUTE_KINDS.length) {
    violations.push({
      code: "rail-coverage-gap",
      message: "ROUTE_VARIANT_NAMES drifted from ROUTE_KINDS.",
    });
  }

  for (const route of ROUTE_VARIANT_NAMES) {
    const anyRow = parsed.inboundEvidence.some((row) => row.rail === route);
    if (!anyRow) {
      violations.push({
        code: "rail-coverage-gap",
        message: `Protocol route '${route}' is missing from the Inbound Evidence Authentication Matrix.`,
      });
    }
  }

  for (const stack of ["soroban", "evm"] as const) {
    if (
      !parsed.inboundEvidence.some((row) => row.rail === "RouterAllRails" && row.stack === stack)
    ) {
      violations.push({
        code: "rail-coverage-gap",
        message: `Router inbound receiver guard ('RouterAllRails') is missing for stack '${stack}'.`,
      });
    }
  }

  // 2. Verify every inbound evidence row against source and test files.
  for (const row of parsed.inboundEvidence) {
    touchedFiles.add(row.contractFile);
    touchedFiles.add(row.testFile);

    const normalizedProvider = row.evidenceProvider.trim().toLowerCase();
    if (PLACEHOLDER_PROVIDERS.has(normalizedProvider) || normalizedProvider.length < 8) {
      violations.push({
        code: "active-rail-missing-provider",
        rowId: row.id,
        file: row.contractFile,
        symbol: row.entrypointSymbol,
        message: `Inbound evidence row '${row.id}' (${row.rail}/${row.stack}) must name a concrete authenticating provider.`,
      });
    }

    const isPermittedActive =
      row.stack === "soroban" &&
      row.rail !== "RouterAllRails" &&
      ACTIVE_TESTNET_RAILS.includes(row.rail);
    if (row.deploymentPosture === "active-testnet-outbound" && !isPermittedActive) {
      violations.push({
        code: "ungated-non-active-surface",
        rowId: row.id,
        file: row.contractFile,
        message: `Row '${row.id}' (${row.rail}/${row.stack}) is marked '${row.deploymentPosture}', but only Soroban [${ACTIVE_TESTNET_RAILS.join(", ")}] are active; EVM and non-active rails must remain 'gated'.`,
      });
    }

    const contractSource = repoFiles[row.contractFile];
    if (contractSource === undefined) {
      violations.push({
        code: "missing-file",
        rowId: row.id,
        file: row.contractFile,
        message: `Referenced contract file '${row.contractFile}' does not exist.`,
      });
    } else {
      const fnBlock = extractFunctionBlock(contractSource, row.entrypointSymbol);
      if (fnBlock === null) {
        violations.push({
          code: "missing-symbol",
          rowId: row.id,
          file: row.contractFile,
          symbol: row.entrypointSymbol,
          message: `Entrypoint '${row.entrypointSymbol}' was not found in '${row.contractFile}'.`,
        });
      } else if (row.authGuard.length === 0 || !fnBlock.includes(row.authGuard)) {
        violations.push({
          code: "missing-auth-guard",
          rowId: row.id,
          file: row.contractFile,
          symbol: row.entrypointSymbol,
          message: `Guard snippet '${row.authGuard}' was not found inside '${row.entrypointSymbol}' in '${row.contractFile}'.`,
        });
      }
    }

    const testSource = repoFiles[row.testFile];
    if (testSource === undefined) {
      violations.push({
        code: "missing-file",
        rowId: row.id,
        file: row.testFile,
        message: `Referenced test file '${row.testFile}' does not exist.`,
      });
    } else if (row.testSymbol.length === 0 || !testSource.includes(row.testSymbol)) {
      violations.push({
        code: "missing-test-assertion",
        rowId: row.id,
        file: row.testFile,
        symbol: row.testSymbol,
        message: `Representative test '${row.testSymbol}' was not found in '${row.testFile}'.`,
      });
    }
  }

  // 3. Verify every authority separation row against source, guard and test files.
  for (const row of parsed.authoritySeparation) {
    touchedFiles.add(row.contractFile);
    touchedFiles.add(row.testFile);

    const contractSource = repoFiles[row.contractFile];
    if (contractSource === undefined) {
      violations.push({
        code: "missing-file",
        rowId: row.id,
        file: row.contractFile,
        message: `Referenced contract file '${row.contractFile}' does not exist.`,
      });
    } else {
      const fnBlock = extractFunctionBlock(contractSource, row.setterSymbol);
      if (fnBlock === null) {
        violations.push({
          code: "missing-symbol",
          rowId: row.id,
          file: row.contractFile,
          symbol: row.setterSymbol,
          message: `Authority entrypoint '${row.setterSymbol}' was not found in '${row.contractFile}'.`,
        });
      } else {
        if (row.authGuard.length === 0 || !fnBlock.includes(row.authGuard)) {
          violations.push({
            code: "missing-auth-guard",
            rowId: row.id,
            file: row.contractFile,
            symbol: row.setterSymbol,
            message: `Authority guard '${row.authGuard}' was not found inside '${row.setterSymbol}' in '${row.contractFile}'.`,
          });
        }
        validateAuthorityRegimeConsistency(row, fnBlock, violations);
      }
    }

    const testSource = repoFiles[row.testFile];
    if (testSource === undefined) {
      violations.push({
        code: "missing-file",
        rowId: row.id,
        file: row.testFile,
        message: `Referenced test file '${row.testFile}' does not exist.`,
      });
    } else if (row.testSymbol.length === 0 || !testSource.includes(row.testSymbol)) {
      violations.push({
        code: "missing-test-assertion",
        rowId: row.id,
        file: row.testFile,
        symbol: row.testSymbol,
        message: `Representative test '${row.testSymbol}' was not found in '${row.testFile}'.`,
      });
    }
  }

  // 4. Reverse completeness scan: detect undocumented trust surfaces across monitored contracts.
  const documentedAuthorityByFile = new Map<string, Set<string>>();
  for (const row of parsed.authoritySeparation) {
    let set = documentedAuthorityByFile.get(row.contractFile);
    if (set === undefined) {
      set = new Set<string>();
      documentedAuthorityByFile.set(row.contractFile, set);
    }
    set.add(row.setterSymbol);
  }

  const documentedInboundByFile = new Map<string, Set<string>>();
  for (const row of parsed.inboundEvidence) {
    let set = documentedInboundByFile.get(row.contractFile);
    if (set === undefined) {
      set = new Set<string>();
      documentedInboundByFile.set(row.contractFile, set);
    }
    set.add(row.entrypointSymbol);
  }

  for (const monitoredPath of MONITORED_CONTRACT_FILES) {
    const source = repoFiles[monitoredPath];
    if (source === undefined) {
      violations.push({
        code: "missing-file",
        file: monitoredPath,
        message: `Monitored contract file '${monitoredPath}' is missing from repository snapshot.`,
      });
      continue;
    }

    const authSymbols = documentedAuthorityByFile.get(monitoredPath) ?? new Set<string>();
    const inboundSymbols = documentedInboundByFile.get(monitoredPath) ?? new Set<string>();

    if (monitoredPath.endsWith(".rs")) {
      const fns = discoverRustPubFunctions(source);
      const isRouter = monitoredPath === "soroban/crates/hyperion-router/src/lib.rs";
      for (const fn of fns) {
        const touchesAuthority = isRouter
          ? fn.block.includes("storage::is_initialized") ||
            fn.block.includes("cfg.admin") ||
            fn.block.includes("cfg.guardian") ||
            fn.block.includes("timelock::")
          : fn.block.includes("storage::is_initialized") ||
            fn.block.includes("require_admin") ||
            fn.block.includes("cfg.admin.require_auth");

        if (touchesAuthority && !authSymbols.has(fn.symbol)) {
          violations.push({
            code: "undocumented-trust-surface",
            file: monitoredPath,
            symbol: fn.symbol,
            message: `Undocumented Soroban authority entrypoint '${fn.symbol}' in '${monitoredPath}'.`,
          });
        }

        const touchesInbound = isRouter
          ? fn.block.includes("storage::mark_processed") ||
            fn.block.includes("HyperionError::NotRailReceiver")
          : fn.block.includes(".bridge_in(") ||
            fn.block.includes("Self::bridge_in(") ||
            fn.block.includes(".receive_message(") ||
            fn.block.includes("cfg.its.require_auth") ||
            fn.block.includes("ed25519_verify(");

        if (touchesInbound && !inboundSymbols.has(fn.symbol)) {
          violations.push({
            code: "undocumented-trust-surface",
            file: monitoredPath,
            symbol: fn.symbol,
            message: `Undocumented Soroban inbound trust entrypoint '${fn.symbol}' in '${monitoredPath}'.`,
          });
        }
      }
    } else if (monitoredPath.endsWith(".sol")) {
      const fns = discoverSolidityFunctions(source);
      const isRouter = monitoredPath === "evm/src/HyperionRouter.sol";
      for (const fn of fns) {
        if (!/\b(external|public)\b/.test(fn.header)) continue;
        const isViewOrPure = /\b(view|pure)\b/.test(fn.header);
        const isRoleOverride = isRouter && (fn.name === "grantRole" || fn.name === "revokeRole");

        const touchesAuthority = isRouter
          ? isRoleOverride ||
            fn.header.includes("onlyRole(") ||
            fn.block.includes("GUARDIAN_ROLE") ||
            fn.block.includes("DEFAULT_ADMIN_ROLE")
          : fn.header.includes("onlyOwner");

        if (touchesAuthority && !authSymbols.has(fn.symbol)) {
          violations.push({
            code: "undocumented-trust-surface",
            file: monitoredPath,
            symbol: fn.symbol,
            message: `Undocumented EVM authority entrypoint '${fn.symbol}' in '${monitoredPath}'.`,
          });
        }

        const touchesInbound =
          !isViewOrPure &&
          (isRouter
            ? fn.block.includes("NotRailReceiver") || fn.block.includes("processed[replayKey]")
            : fn.block.includes(".bridgeIn(") || fn.name === "executeWithInterchainToken");

        if (touchesInbound && !inboundSymbols.has(fn.symbol)) {
          violations.push({
            code: "undocumented-trust-surface",
            file: monitoredPath,
            symbol: fn.symbol,
            message: `Undocumented EVM inbound trust entrypoint '${fn.symbol}' in '${monitoredPath}'.`,
          });
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    inboundRowCount: parsed.inboundEvidence.length,
    authorityRowCount: parsed.authoritySeparation.length,
    verifiedFiles: [...touchedFiles].sort(),
    violations,
  };
}
