import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACTIVE_TESTNET_RAILS,
  MONITORED_CONTRACT_FILES,
  parseSecurityAssumptionsMarkdown,
  verifySecurityAssumptions,
} from "../src/securityAssumptions.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../..");

function readRepoText(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function replaceRowCell(
  markdown: string,
  rowId: string,
  columnIndex: number,
  nextValue: string,
): string {
  let replaced = false;
  const updated = markdown
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return line;
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      if (cells[0] !== rowId) return line;
      cells[columnIndex] = nextValue;
      replaced = true;
      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
  expect(replaced).toBe(true);
  return updated;
}

function loadLiveSecuritySnapshot(): {
  readonly markdown: string;
  readonly repoFiles: Record<string, string>;
} {
  const markdown = readRepoText("docs/SECURITY_ASSUMPTIONS.md");
  const { parsed, violations } = parseSecurityAssumptionsMarkdown(markdown);
  expect(violations).toEqual([]);

  const paths = new Set<string>(MONITORED_CONTRACT_FILES);
  for (const row of parsed.inboundEvidence) {
    paths.add(row.contractFile);
    paths.add(row.testFile);
  }
  for (const row of parsed.authoritySeparation) {
    paths.add(row.contractFile);
    paths.add(row.testFile);
  }

  const repoFiles: Record<string, string> = {};
  for (const relPath of paths) {
    repoFiles[relPath] = readRepoText(relPath);
  }
  return { markdown, repoFiles };
}

describe("protocol security assumption documentation checks", () => {
  it("passes cleanly against live docs/SECURITY_ASSUMPTIONS.md and repository sources", () => {
    const { markdown, repoFiles } = loadLiveSecuritySnapshot();
    const result = verifySecurityAssumptions(markdown, repoFiles);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.inboundRowCount).toBeGreaterThanOrEqual(11);
    expect(result.authorityRowCount).toBeGreaterThanOrEqual(42);
  });

  it("ensures each active Stellar Testnet rail states a concrete inbound evidence provider", () => {
    const { markdown, repoFiles } = loadLiveSecuritySnapshot();
    const { parsed } = parseSecurityAssumptionsMarkdown(markdown);

    for (const activeRail of ACTIVE_TESTNET_RAILS) {
      const sorobanRows = parsed.inboundEvidence.filter(
        (row) => row.rail === activeRail && row.stack === "soroban",
      );
      expect(sorobanRows.length).toBeGreaterThan(0);
      for (const row of sorobanRows) {
        expect(row.deploymentPosture).toBe("active-testnet-outbound");
        expect(row.evidenceProvider.length).toBeGreaterThan(15);
      }
    }

    // Mutated fixture: blanking out the provider on active Cctp must fail.
    const blanked = replaceRowCell(markdown, "inbound-soroban-cctp", 4, "TBD");
    const failed = verifySecurityAssumptions(blanked, repoFiles);
    expect(failed.ok).toBe(false);
    expect(failed.violations.map((v) => v.code)).toContain("active-rail-missing-provider");

    // Mutated fixture: promoting a gated EVM surface to active without independent validation fails.
    const ungatedEvm = replaceRowCell(markdown, "inbound-evm-cctp", 3, "active-testnet-outbound");
    const ungatedResult = verifySecurityAssumptions(ungatedEvm, repoFiles);
    expect(ungatedResult.ok).toBe(false);
    expect(ungatedResult.violations.map((v) => v.code)).toContain("ungated-non-active-surface");
  });

  it("strictly distinguishes adapter direct authority from router timelocks", () => {
    const { markdown, repoFiles } = loadLiveSecuritySnapshot();
    const { parsed } = parseSecurityAssumptionsMarkdown(markdown);

    const adapterRows = parsed.authoritySeparation.filter((row) => row.surface === "adapter");
    const routerTimelockRows = parsed.authoritySeparation.filter(
      (row) => row.authorityRegime === "router-timelock",
    );
    expect(adapterRows.length).toBeGreaterThan(0);
    expect(routerTimelockRows.length).toBe(4);

    for (const row of adapterRows) {
      expect(["one-time-init", "adapter-direct-admin", "adapter-direct-owner"]).toContain(
        row.authorityRegime,
      );
    }

    // Mutated fixture 1: claiming an adapter direct setter runs behind a router timelock fails.
    const conflatedAdapter = replaceRowCell(
      markdown,
      "auth-soroban-cctp-link-domain",
      4,
      "router-timelock",
    );
    const adapterFailure = verifySecurityAssumptions(conflatedAdapter, repoFiles);
    expect(adapterFailure.ok).toBe(false);
    expect(adapterFailure.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "authority-regime-mismatch",
          rowId: "auth-soroban-cctp-link-domain",
        }),
      ]),
    );

    // Mutated fixture 2: reclassifying router queue_action as direct adapter admin fails.
    const conflatedRouter = replaceRowCell(
      markdown,
      "auth-soroban-router-queue",
      4,
      "adapter-direct-admin",
    );
    const routerFailure = verifySecurityAssumptions(conflatedRouter, repoFiles);
    expect(routerFailure.ok).toBe(false);
    expect(routerFailure.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "authority-regime-mismatch",
          rowId: "auth-soroban-router-queue",
        }),
      ]),
    );
  });

  it("fails on broken file, symbol, in-body guard and test assertion references", () => {
    const { markdown, repoFiles } = loadLiveSecuritySnapshot();

    // 1. Broken file path
    const brokenPathMd = replaceRowCell(
      markdown,
      "inbound-soroban-cctp",
      8,
      "soroban/crates/hyperion-adapter-cctp/src/test/does_not_exist.rs",
    );
    const brokenPathRes = verifySecurityAssumptions(brokenPathMd, repoFiles);
    expect(brokenPathRes.ok).toBe(false);
    expect(brokenPathRes.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-file",
          file: "soroban/crates/hyperion-adapter-cctp/src/test/does_not_exist.rs",
        }),
      ]),
    );

    // 2. Renamed contract entrypoint symbol
    const brokenSymbolMd = replaceRowCell(
      markdown,
      "inbound-evm-router",
      6,
      "function bridgeArrival(",
    );
    const brokenSymbolRes = verifySecurityAssumptions(brokenSymbolMd, repoFiles);
    expect(brokenSymbolRes.ok).toBe(false);
    expect(brokenSymbolRes.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-symbol",
          rowId: "inbound-evm-router",
          symbol: "function bridgeArrival(",
        }),
      ]),
    );

    // 3. Removed in-body authorization guard inside contract source
    const axelarPath = "soroban/crates/hyperion-adapter-axelar/src/lib.rs";
    const axelarSource = repoFiles[axelarPath] ?? "";
    const weakenedFiles = {
      ...repoFiles,
      [axelarPath]: axelarSource.replace("cfg.its.require_auth();", "// auth dropped"),
    };
    const weakenedRes = verifySecurityAssumptions(markdown, weakenedFiles);
    expect(weakenedRes.ok).toBe(false);
    expect(weakenedRes.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-auth-guard",
          rowId: "inbound-soroban-axelar-gmp-invoker",
          file: axelarPath,
        }),
      ]),
    );

    // 4. Renamed test assertion symbol
    const brokenTestMd = replaceRowCell(
      markdown,
      "inbound-soroban-router",
      9,
      "fn deleted_rail_receiver_test(",
    );
    const brokenTestRes = verifySecurityAssumptions(brokenTestMd, repoFiles);
    expect(brokenTestRes.ok).toBe(false);
    expect(brokenTestRes.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-test-assertion",
          rowId: "inbound-soroban-router",
          symbol: "fn deleted_rail_receiver_test(",
        }),
      ]),
    );
  });

  it("fails when undocumented authority or inbound trust surfaces are added to Soroban or EVM contracts", () => {
    const { markdown, repoFiles } = loadLiveSecuritySnapshot();

    // 1. Undocumented Soroban adapter admin setter
    const cctpRustPath = "soroban/crates/hyperion-adapter-cctp/src/lib.rs";
    const cctpRustSource = repoFiles[cctpRustPath] ?? "";
    const withExtraSorobanAdmin = {
      ...repoFiles,
      [cctpRustPath]: cctpRustSource.replace(
        "pub fn set_admin(",
        "pub fn bypass_lane(env: Env) -> Result<(), HyperionError> { require_admin(&env)?; Ok(()) }\n\n    pub fn set_admin(",
      ),
    };
    const sorobanAdminRes = verifySecurityAssumptions(markdown, withExtraSorobanAdmin);
    expect(sorobanAdminRes.ok).toBe(false);
    expect(sorobanAdminRes.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "undocumented-trust-surface",
          file: cctpRustPath,
          symbol: "pub fn bypass_lane(",
        }),
      ]),
    );

    // 2. Undocumented EVM adapter onlyOwner setter
    const cctpSolPath = "evm/src/adapters/CctpAdapter.sol";
    const cctpSolSource = repoFiles[cctpSolPath] ?? "";
    const withExtraEvmOwner = {
      ...repoFiles,
      [cctpSolPath]: cctpSolSource.replace(
        "function setLaneEnabled(",
        "function repointLane(string calldata chain, bytes32 recipient) external onlyOwner { _lanes[chain].mintRecipient = recipient; }\n\n    function setLaneEnabled(",
      ),
    };
    const evmOwnerRes = verifySecurityAssumptions(markdown, withExtraEvmOwner);
    expect(evmOwnerRes.ok).toBe(false);
    expect(evmOwnerRes.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "undocumented-trust-surface",
          file: cctpSolPath,
          symbol: "function repointLane(",
        }),
      ]),
    );

    // 3. Undocumented EVM inbound router delivery surface
    const axelarSolPath = "evm/src/adapters/AxelarItsAdapter.sol";
    const axelarSolSource = repoFiles[axelarSolPath] ?? "";
    const withExtraInbound = {
      ...repoFiles,
      [axelarSolPath]: axelarSolSource.replace(
        "function topUpGas(",
        "function unauthenticatedDeliver(address token, uint256 amount, address recipient, Origin calldata origin) external { IHyperionRouter(ROUTER).bridgeIn(RouteKind.AxelarIts, token, amount, recipient, origin); }\n\n    function topUpGas(",
      ),
    };
    const inboundRes = verifySecurityAssumptions(markdown, withExtraInbound);
    expect(inboundRes.ok).toBe(false);
    expect(inboundRes.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "undocumented-trust-surface",
          file: axelarSolPath,
          symbol: "function unauthenticatedDeliver(",
        }),
      ]),
    );
  });
});
