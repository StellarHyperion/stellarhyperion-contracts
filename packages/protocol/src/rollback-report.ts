/**
 * Read-only upgrade rollback feasibility analysis for Hyperion deployments.
 *
 * Soroban contracts swap executable WASM in place (`update_current_contract_wasm`) while keeping
 * existing instance and persistent ledger entries untouched. Rolling a router or rail adapter back
 * to an earlier code hash is therefore safe only when the target WASM still understands every
 * storage key, schema version, replay-protection marker, pending claim shape, exact-integer flow
 * counter, and active rail entrypoint already live on the ledger.
 *
 * Everything in this module is pure, deterministic, and strictly advisory (`readOnly: true`,
 * `executionPermitted: false`). No helper here constructs, signs, queues, or broadcasts an upgrade
 * or rollback transaction.
 */
import { AddressKind, isStellarAddress, parseStellarAddress } from "./addresses.js";
import type { ChainKey } from "./chains.js";
import { chain, isChainKey, isStellarChain } from "./chains.js";
import {
  type Deployment,
  deployedChains,
  isStellarDeployment,
  parseDeploymentSet,
} from "./deployments.js";
import { ROUTE_KINDS, ROUTE_SLUGS, RouteKind, tryRouteFromSlug } from "./routes.js";

/** Minimum router timelock delay enforced by protocol governance (seconds). */
export const MIN_ROLLBACK_TIMELOCK_SECONDS = 3600;

const VALIDATED_ACTIVE_ROUTES: readonly RouteKind[] = [RouteKind.Cctp, RouteKind.AxelarIts];

/** Canonical storage keys maintained by the Soroban Hyperion router (`storage.rs`). */
export const ROUTER_BASELINE_STORAGE_KEYS: readonly string[] = [
  "Config",
  "OutNonce",
  "Adapter",
  "RailReceiver",
  "RouteEnabled",
  "RouteConfig",
  "Token",
  "RouteFlowLimit",
  "Flow",
  "Transfer",
  "Processed",
  "Claim",
  "ClaimSeq",
  "Queued",
  "QueueSeq",
];

/** Canonical storage keys maintained by Soroban rail adapters. */
export const ADAPTER_BASELINE_STORAGE_KEYS: readonly string[] = [
  "Config",
  "DomainOrChainLink",
  "AssetOrTokenMap",
];

/** Critical safety invariants that any rollback target must preserve. */
export type SafetyInvariantName =
  | "exact-integer-amounts"
  | "authenticated-rail-dispatch"
  | "replay-protection"
  | "recipient-bound-claims";

export const REQUIRED_SAFETY_INVARIANTS: readonly SafetyInvariantName[] = [
  "exact-integer-amounts",
  "authenticated-rail-dispatch",
  "replay-protection",
  "recipient-bound-claims",
];

export type RollbackContractArtifact = "router" | "adapter-cctp" | "adapter-axelar";

export type RollbackBlockerCode =
  | "no-prior-build"
  | "already-at-target"
  | "contract-address-mismatch"
  | "storage-migration-irreversible"
  | "storage-schema-downgrade"
  | "storage-key-incompatible"
  | "safety-invariant-regression"
  | "active-route-entrypoint-missing"
  | "missing-required-authority"
  | "timelock-below-minimum"
  | "gated-unvalidated-scope";

export interface RollbackBlocker {
  readonly code: RollbackBlockerCode;
  readonly reason: string;
  readonly migrationId?: string | undefined;
}

export interface StorageMigrationRecord {
  readonly id: string;
  readonly fromSchemaVersion: number;
  readonly toSchemaVersion: number;
  readonly reversible: boolean;
  readonly reason: string;
  readonly affectedKeys?: readonly string[] | undefined;
}

export interface ContractBuildMetadata {
  readonly codeHash: string;
  readonly contractAddress?: string | undefined;
  readonly schemaVersion?: number | undefined;
  readonly storageKeys?: readonly string[] | undefined;
  readonly supportedRoutes?: readonly RouteKind[] | undefined;
  readonly entrypoints?: readonly string[] | undefined;
  readonly preservedInvariants?: readonly SafetyInvariantName[] | undefined;
  readonly migrations?: readonly StorageMigrationRecord[] | undefined;
  readonly sourceCommit?: string | undefined;
}

export type UpgradeAuthorityMechanism =
  "router-timelock" | "adapter-direct-admin" | "evm-gated-governance";

export interface RollbackAuthorityRequirement {
  readonly mechanism: UpgradeAuthorityMechanism;
  readonly authorityRole: "router-admin" | "adapter-admin" | "evm-governance";
  readonly requiredAuthority: string | null;
  readonly emergencyPauseGuardian?: string | null | undefined;
  readonly treasuryAddress?: string | null | undefined;
  readonly timelockDelaySeconds: number;
  readonly reviewSteps: readonly string[];
}

export interface ContractRollbackAssessment {
  readonly artifact: RollbackContractArtifact;
  readonly contractAddress: string | null;
  /** Currently deployed WASM hash ("new" / active code). */
  readonly currentCodeHash: string | null;
  /** Candidate previous WASM hash ("old" / rollback target code). */
  readonly targetCodeHash: string | null;
  readonly currentSchemaVersion: number;
  readonly targetSchemaVersion: number;
  readonly feasible: boolean;
  readonly status: "compatible" | "unsupported";
  readonly authority: RollbackAuthorityRequirement;
  readonly blockers: readonly RollbackBlocker[];
  readonly warnings: readonly string[];
}

export interface RollbackFeasibilityReport {
  readonly chain: ChainKey;
  readonly family: "stellar" | "evm";
  readonly validationGate: "active-validated" | "gated-unvalidated";
  /** Always true: reports are strictly advisory and never execute state changes. */
  readonly readOnly: true;
  /** Always false: no report may trigger an automatic upgrade or rollback. */
  readonly executionPermitted: false;
  readonly overallFeasible: boolean;
  readonly evaluatedAt: string;
  readonly contracts: readonly ContractRollbackAssessment[];
}

export interface EvaluateRollbackInput {
  readonly chain: ChainKey;
  readonly currentDeploymentSet: unknown;
  readonly previousDeploymentSet?: unknown;
  readonly currentBuilds?:
    Partial<Record<RollbackContractArtifact, ContractBuildMetadata>> | undefined;
  readonly targetBuilds?:
    Partial<Record<RollbackContractArtifact, ContractBuildMetadata>> | undefined;
  readonly adapterAdmins?: Partial<Record<RouteKind, string>> | undefined;
  readonly enabledRoutes?: readonly RouteKind[] | undefined;
  readonly evaluatedAt?: string | undefined;
}

export class RollbackFormatError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`invalid rollback specification at ${path}: ${detail}`);
    this.name = "RollbackFormatError";
    this.path = path;
  }
}

function fail(path: string, detail: string): never {
  throw new RollbackFormatError(path, detail);
}

function assertNoSecrets(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (/\bS[A-Z2-7]{55}\b/.test(value)) {
      fail(path, "secret Stellar seed material is forbidden in rollback specifications");
    }
    if (/(?:private[_-]?key|secret[_-]?key|mnemonic)\s*[:=]/i.test(value)) {
      fail(path, "secret key material is forbidden in rollback specifications");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoSecrets(value[i], `${path}[${String(i)}]`);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}

function assertWasmHash(value: string, path: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    fail(path, `expected 64 lowercase hex characters, got "${value}"`);
  }
  return value;
}

function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function validateStellarPrincipal(value: string, path: string): string {
  if (!isStellarAddress(value)) {
    fail(path, `expected valid Stellar address, got "${value}"`);
  }
  const parsed = parseStellarAddress(value);
  if (parsed.kind === AddressKind.MuxedAccount) {
    fail(path, "upgrade authority cannot be a muxed M address");
  }
  return value;
}

function artifactForRoute(kind: RouteKind): RollbackContractArtifact | null {
  if (kind === RouteKind.Cctp) return "adapter-cctp";
  if (kind === RouteKind.AxelarIts) return "adapter-axelar";
  return null;
}

function routeForArtifact(artifact: RollbackContractArtifact): RouteKind | null {
  if (artifact === "adapter-cctp") return RouteKind.Cctp;
  if (artifact === "adapter-axelar") return RouteKind.AxelarIts;
  return null;
}

function defaultStorageKeys(artifact: RollbackContractArtifact): readonly string[] {
  return artifact === "router" ? ROUTER_BASELINE_STORAGE_KEYS : ADAPTER_BASELINE_STORAGE_KEYS;
}

function defaultEntrypoints(
  artifact: RollbackContractArtifact,
  routes: readonly RouteKind[],
): readonly string[] {
  if (artifact === "router") {
    const base = [
      "initialize",
      "bridge_out",
      "bridge_in",
      "claim",
      "pause",
      "unpause",
      "queue_action",
      "execute_action",
      "cancel_action",
      "get_config",
    ];
    if (routes.includes(RouteKind.Cctp) || routes.includes(RouteKind.AxelarIts)) {
      return [...base, "bridge_out_paid"];
    }
    return base;
  }
  if (artifact === "adapter-cctp") {
    return ["initialize", "bridge_out", "receive_message", "link_domain", "map_asset", "upgrade"];
  }
  return ["initialize", "bridge_out", "execute", "link_chain", "map_token", "upgrade"];
}

function activeRoutesInStellarDeployment(
  deployment: Extract<Deployment, { family: "stellar" }>,
): readonly RouteKind[] {
  const found = new Set<RouteKind>();
  for (const token of Object.values(deployment.tokens)) {
    for (const r of token.routes) {
      found.add(r);
    }
  }
  return [...found];
}

function computeValidationGate(
  chainKey: ChainKey,
  deployment: Deployment,
): "active-validated" | "gated-unvalidated" {
  if (chainKey !== "stellar-testnet" || !isStellarDeployment(deployment)) {
    return "gated-unvalidated";
  }
  for (const kind of ROUTE_KINDS) {
    if (deployment.adapters[kind] !== undefined && !VALIDATED_ACTIVE_ROUTES.includes(kind)) {
      return "gated-unvalidated";
    }
  }
  for (const r of activeRoutesInStellarDeployment(deployment)) {
    if (!VALIDATED_ACTIVE_ROUTES.includes(r)) {
      return "gated-unvalidated";
    }
  }
  return "active-validated";
}

/**
 * Parse a JSON rollback migration/build specification file into typed current/target build maps.
 *
 * Accepts either a previous `DeploymentSet` manifest, an evidence JSON record (such as
 * `deployments/evidence/2026-10-28-paid-its.json` or `2026-10-29-cctp.json`), or an explicit
 * `{ currentBuilds, targetBuilds, adapterAdmins, enabledRoutes }` descriptor object.
 */
export function parseRollbackReference(raw: unknown): {
  readonly previousDeploymentSet?: unknown;
  readonly currentBuilds?: Partial<Record<RollbackContractArtifact, ContractBuildMetadata>>;
  readonly targetBuilds?: Partial<Record<RollbackContractArtifact, ContractBuildMetadata>>;
  readonly adapterAdmins?: Partial<Record<RouteKind, string>>;
  readonly enabledRoutes?: readonly RouteKind[];
} {
  assertNoSecrets(raw, "$");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("$", "expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  // Case 1: Full DeploymentSet (canonical or archive manifest).
  if (
    typeof obj.schemaVersion === "number" &&
    typeof obj.networks === "object" &&
    obj.networks !== null
  ) {
    parseDeploymentSet(obj);
    return { previousDeploymentSet: obj };
  }

  // Case 2: Evidence files (`2026-10-28-paid-its.json` or `2026-10-29-cctp.json`).
  if (typeof obj.wasmHashes === "object" && obj.wasmHashes !== null && !("targetBuilds" in obj)) {
    const hashes = obj.wasmHashes as Record<string, unknown>;
    const targetBuilds: Partial<Record<RollbackContractArtifact, ContractBuildMetadata>> = {};
    if (typeof hashes.router === "string") {
      // Evidence from 2026-10-28-paid-its predates CCTP paid forwarding on the router.
      const hasCctp = typeof hashes["adapter-cctp"] === "string" || typeof hashes.cctp === "string";
      targetBuilds.router = {
        codeHash: assertWasmHash(hashes.router, "$.wasmHashes.router"),
        supportedRoutes: hasCctp ? [RouteKind.AxelarIts, RouteKind.Cctp] : [RouteKind.AxelarIts],
        entrypoints: [
          "initialize",
          "bridge_out",
          "bridge_out_paid",
          "bridge_in",
          "claim",
          "pause",
          "unpause",
          "queue_action",
          "execute_action",
          "cancel_action",
          "get_config",
        ],
        ...(typeof obj.implementationCommit === "string"
          ? { sourceCommit: obj.implementationCommit }
          : {}),
      };
    }
    const axelarHash = hashes["adapter-axelar"] ?? hashes.axelar;
    if (typeof axelarHash === "string") {
      targetBuilds["adapter-axelar"] = {
        codeHash: assertWasmHash(axelarHash, "$.wasmHashes.axelar"),
      };
    }
    const cctpHash = hashes["adapter-cctp"] ?? hashes.cctp;
    if (typeof cctpHash === "string") {
      targetBuilds["adapter-cctp"] = {
        codeHash: assertWasmHash(cctpHash, "$.wasmHashes.cctp"),
      };
    }
    return { targetBuilds };
  }

  if (typeof obj.wasmHash === "string" && typeof obj.forwardingWasmHash === "string") {
    const targetBuilds: Partial<Record<RollbackContractArtifact, ContractBuildMetadata>> = {
      "adapter-cctp": {
        codeHash: assertWasmHash(obj.wasmHash, "$.wasmHash"),
        ...(typeof obj.adapter === "string" ? { contractAddress: obj.adapter } : {}),
        entrypoints: [
          "initialize",
          "bridge_out",
          "receive_message",
          "link_domain",
          "map_asset",
          "upgrade",
        ],
      },
    };
    return { targetBuilds };
  }

  // Case 3: Explicit rollback descriptor object.
  const currentBuilds =
    obj.currentBuilds !== undefined
      ? parseBuildMap(obj.currentBuilds, "$.currentBuilds")
      : undefined;
  const targetBuilds =
    obj.targetBuilds !== undefined ? parseBuildMap(obj.targetBuilds, "$.targetBuilds") : undefined;

  let adapterAdmins: Partial<Record<RouteKind, string>> | undefined;
  if (obj.adapterAdmins !== undefined) {
    if (
      typeof obj.adapterAdmins !== "object" ||
      obj.adapterAdmins === null ||
      Array.isArray(obj.adapterAdmins)
    ) {
      fail("$.adapterAdmins", "expected an object mapping route slugs to addresses");
    }
    adapterAdmins = {};
    for (const [slug, addr] of Object.entries(obj.adapterAdmins as Record<string, unknown>)) {
      const route = tryRouteFromSlug(slug);
      if (route === null) fail(`$.adapterAdmins.${slug}`, `unknown route slug "${slug}"`);
      if (typeof addr !== "string") fail(`$.adapterAdmins.${slug}`, "expected address string");
      adapterAdmins[route] = validateStellarPrincipal(addr, `$.adapterAdmins.${slug}`);
    }
  }

  let enabledRoutes: RouteKind[] | undefined;
  if (obj.enabledRoutes !== undefined) {
    if (!Array.isArray(obj.enabledRoutes)) {
      fail("$.enabledRoutes", "expected an array of route slugs");
    }
    enabledRoutes = obj.enabledRoutes.map((slug, idx) => {
      if (typeof slug !== "string") {
        fail(`$.enabledRoutes[${String(idx)}]`, "expected route slug string");
      }
      const route = tryRouteFromSlug(slug);
      if (route === null) {
        fail(`$.enabledRoutes[${String(idx)}]`, `unknown route slug "${slug}"`);
      }
      return route;
    });
  }

  return {
    ...(currentBuilds !== undefined ? { currentBuilds } : {}),
    ...(targetBuilds !== undefined ? { targetBuilds } : {}),
    ...(adapterAdmins !== undefined ? { adapterAdmins } : {}),
    ...(enabledRoutes !== undefined ? { enabledRoutes } : {}),
  };
}

function parseBuildMap(
  raw: unknown,
  path: string,
): Partial<Record<RollbackContractArtifact, ContractBuildMetadata>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(path, "expected an object keyed by artifact name");
  }
  const result: Partial<Record<RollbackContractArtifact, ContractBuildMetadata>> = {};
  const allowed: readonly RollbackContractArtifact[] = ["router", "adapter-cctp", "adapter-axelar"];
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(key as RollbackContractArtifact)) {
      fail(`${path}.${key}`, `unknown contract artifact "${key}"`);
    }
    result[key as RollbackContractArtifact] = parseSingleBuild(val, `${path}.${key}`);
  }
  return result;
}

function parseSingleBuild(raw: unknown, path: string): ContractBuildMetadata {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(path, "expected a build metadata object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.codeHash !== "string") {
    fail(`${path}.codeHash`, "expected 64-char hex codeHash");
  }
  const codeHash = assertWasmHash(obj.codeHash, `${path}.codeHash`);

  let schemaVersion: number | undefined;
  if (obj.schemaVersion !== undefined) {
    if (
      typeof obj.schemaVersion !== "number" ||
      !Number.isInteger(obj.schemaVersion) ||
      obj.schemaVersion < 1
    ) {
      fail(`${path}.schemaVersion`, "expected a positive integer schemaVersion");
    }
    schemaVersion = obj.schemaVersion;
  }

  let contractAddress: string | undefined;
  if (obj.contractAddress !== undefined) {
    if (typeof obj.contractAddress !== "string") {
      fail(`${path}.contractAddress`, "expected contract address string");
    }
    contractAddress = validateStellarPrincipal(obj.contractAddress, `${path}.contractAddress`);
  }

  let storageKeys: string[] | undefined;
  if (obj.storageKeys !== undefined) {
    if (
      !Array.isArray(obj.storageKeys) ||
      !obj.storageKeys.every((k) => typeof k === "string" && k.length > 0)
    ) {
      fail(`${path}.storageKeys`, "expected an array of non-empty storage key names");
    }
    storageKeys = [...(obj.storageKeys as string[])];
  }

  let supportedRoutes: RouteKind[] | undefined;
  if (obj.supportedRoutes !== undefined) {
    if (!Array.isArray(obj.supportedRoutes)) {
      fail(`${path}.supportedRoutes`, "expected an array of route slugs");
    }
    supportedRoutes = obj.supportedRoutes.map((slug, idx) => {
      if (typeof slug !== "string") {
        fail(`${path}.supportedRoutes[${String(idx)}]`, "expected route slug string");
      }
      const r = tryRouteFromSlug(slug);
      if (r === null) {
        fail(`${path}.supportedRoutes[${String(idx)}]`, `unknown route slug "${slug}"`);
      }
      return r;
    });
  }

  let entrypoints: string[] | undefined;
  if (obj.entrypoints !== undefined) {
    if (
      !Array.isArray(obj.entrypoints) ||
      !obj.entrypoints.every((e) => typeof e === "string" && e.length > 0)
    ) {
      fail(`${path}.entrypoints`, "expected an array of entrypoint names");
    }
    entrypoints = [...(obj.entrypoints as string[])];
  }

  let preservedInvariants: SafetyInvariantName[] | undefined;
  if (obj.preservedInvariants !== undefined) {
    if (!Array.isArray(obj.preservedInvariants)) {
      fail(`${path}.preservedInvariants`, "expected an array of safety invariant names");
    }
    preservedInvariants = obj.preservedInvariants.map((inv, idx) => {
      if (
        typeof inv !== "string" ||
        !REQUIRED_SAFETY_INVARIANTS.includes(inv as SafetyInvariantName)
      ) {
        fail(`${path}.preservedInvariants[${String(idx)}]`, `unknown invariant "${String(inv)}"`);
      }
      return inv as SafetyInvariantName;
    });
  }

  let migrations: StorageMigrationRecord[] | undefined;
  if (obj.migrations !== undefined) {
    if (!Array.isArray(obj.migrations)) {
      fail(`${path}.migrations`, "expected an array of migration descriptors");
    }
    migrations = obj.migrations.map((mig, idx) => {
      const mPath = `${path}.migrations[${String(idx)}]`;
      if (typeof mig !== "object" || mig === null || Array.isArray(mig)) {
        fail(mPath, "expected migration object");
      }
      const m = mig as Record<string, unknown>;
      if (typeof m.id !== "string" || m.id.length === 0)
        fail(`${mPath}.id`, "expected migration id");
      if (typeof m.fromSchemaVersion !== "number" || !Number.isInteger(m.fromSchemaVersion)) {
        fail(`${mPath}.fromSchemaVersion`, "expected integer fromSchemaVersion");
      }
      if (typeof m.toSchemaVersion !== "number" || !Number.isInteger(m.toSchemaVersion)) {
        fail(`${mPath}.toSchemaVersion`, "expected integer toSchemaVersion");
      }
      if (typeof m.reversible !== "boolean") {
        fail(`${mPath}.reversible`, "expected boolean reversible");
      }
      if (typeof m.reason !== "string" || m.reason.length === 0) {
        fail(`${mPath}.reason`, "expected non-empty migration reason");
      }
      let affectedKeys: string[] | undefined;
      if (m.affectedKeys !== undefined) {
        if (!Array.isArray(m.affectedKeys) || !m.affectedKeys.every((k) => typeof k === "string")) {
          fail(`${mPath}.affectedKeys`, "expected string array");
        }
        affectedKeys = [...m.affectedKeys];
      }
      return {
        id: m.id,
        fromSchemaVersion: m.fromSchemaVersion,
        toSchemaVersion: m.toSchemaVersion,
        reversible: m.reversible,
        reason: m.reason,
        ...(affectedKeys !== undefined ? { affectedKeys } : {}),
      };
    });
  }

  return {
    codeHash,
    ...(contractAddress !== undefined ? { contractAddress } : {}),
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    ...(storageKeys !== undefined ? { storageKeys } : {}),
    ...(supportedRoutes !== undefined ? { supportedRoutes } : {}),
    ...(entrypoints !== undefined ? { entrypoints } : {}),
    ...(preservedInvariants !== undefined ? { preservedInvariants } : {}),
    ...(migrations !== undefined ? { migrations } : {}),
    ...(typeof obj.sourceCommit === "string" ? { sourceCommit: obj.sourceCommit } : {}),
  };
}

/**
 * Evaluate read-only rollback feasibility across router and rail adapters for a target network.
 */
export function evaluateRollbackFeasibility(
  input: EvaluateRollbackInput,
): RollbackFeasibilityReport {
  assertNoSecrets(input, "$");
  if (!isChainKey(input.chain)) {
    fail("$.chain", `unknown chain key "${String(input.chain)}"`);
  }

  const currentSet = parseDeploymentSet(input.currentDeploymentSet);
  const currentDep = currentSet.networks[input.chain];
  if (currentDep === undefined) {
    fail(
      `$.currentDeploymentSet.networks.${input.chain}`,
      `chain "${input.chain}" is absent from current deployment set (present: ${deployedChains(currentSet).join(", ") || "none"})`,
    );
  }

  const evaluatedAt = input.evaluatedAt ?? currentSet.generatedAt;
  const chainMeta = chain(input.chain);

  // EVM chains remain explicitly gated until independently validated.
  if (!isStellarChain(chainMeta) || !isStellarDeployment(currentDep)) {
    const adminAddr = isEvmAddress(currentDep.admin) ? currentDep.admin : null;
    return {
      chain: input.chain,
      family: "evm",
      validationGate: "gated-unvalidated",
      readOnly: true,
      executionPermitted: false,
      overallFeasible: false,
      evaluatedAt,
      contracts: [
        {
          artifact: "router",
          contractAddress: currentDep.router,
          currentCodeHash: null,
          targetCodeHash: null,
          currentSchemaVersion: 1,
          targetSchemaVersion: 1,
          feasible: false,
          status: "unsupported",
          authority: {
            mechanism: "evm-gated-governance",
            authorityRole: "evm-governance",
            requiredAuthority: adminAddr,
            emergencyPauseGuardian: currentDep.guardian,
            treasuryAddress: currentDep.treasury,
            timelockDelaySeconds: currentDep.timelockDelay,
            reviewSteps: ["EVM deployments are gated until independent rail validation completes"],
          },
          blockers: [
            {
              code: "gated-unvalidated-scope",
              reason: `chain "${input.chain}" is gated until independent validation completes`,
            },
          ],
          warnings: [],
        },
      ],
    };
  }

  const prevSet =
    input.previousDeploymentSet !== undefined
      ? parseDeploymentSet(input.previousDeploymentSet)
      : undefined;
  const prevDepRaw = prevSet?.networks[input.chain];
  const prevDep =
    prevDepRaw !== undefined && isStellarDeployment(prevDepRaw) ? prevDepRaw : undefined;

  const validationGate = computeValidationGate(input.chain, currentDep);
  const enabledRoutes = input.enabledRoutes ?? activeRoutesInStellarDeployment(currentDep);

  const artifacts: RollbackContractArtifact[] = ["router"];
  for (const kind of [RouteKind.Cctp, RouteKind.AxelarIts]) {
    if (
      currentDep.adapters[kind] !== undefined ||
      prevDep?.adapters[kind] !== undefined ||
      input.currentBuilds?.[artifactForRoute(kind) ?? "router"] !== undefined ||
      input.targetBuilds?.[artifactForRoute(kind) ?? "router"] !== undefined
    ) {
      const art = artifactForRoute(kind);
      if (art !== null && !artifacts.includes(art)) {
        artifacts.push(art);
      }
    }
  }

  const assessments: ContractRollbackAssessment[] = [];

  for (const artifact of artifacts) {
    const blockers: RollbackBlocker[] = [];
    const warnings: string[] = [];

    if (validationGate === "gated-unvalidated") {
      blockers.push({
        code: "gated-unvalidated-scope",
        reason: `chain "${input.chain}" or one of its configured rails is gated pending independent validation`,
      });
    }

    const routeKind = routeForArtifact(artifact);
    const currentContractAddress =
      artifact === "router"
        ? currentDep.router
        : routeKind !== null
          ? (currentDep.adapters[routeKind] ?? null)
          : null;

    const prevContractAddress =
      input.targetBuilds?.[artifact]?.contractAddress ??
      (artifact === "router"
        ? prevDep?.router
        : routeKind !== null
          ? prevDep?.adapters[routeKind]
          : undefined);

    if (
      prevContractAddress !== undefined &&
      currentContractAddress !== null &&
      prevContractAddress !== currentContractAddress
    ) {
      blockers.push({
        code: "contract-address-mismatch",
        reason: `previous record targets contract ${prevContractAddress}, which differs from active ${artifact} ${currentContractAddress}; cross-instance rollback is impossible`,
      });
    }

    const currentBuild = input.currentBuilds?.[artifact];
    const targetBuild = input.targetBuilds?.[artifact];

    const currentCodeHashRaw = currentBuild?.codeHash ?? currentDep.wasmHashes[artifact] ?? null;
    const targetCodeHashRaw = targetBuild?.codeHash ?? prevDep?.wasmHashes[artifact] ?? null;

    const currentCodeHash =
      currentCodeHashRaw !== null
        ? assertWasmHash(currentCodeHashRaw, `$.current.${artifact}.codeHash`)
        : null;
    const targetCodeHash =
      targetCodeHashRaw !== null
        ? assertWasmHash(targetCodeHashRaw, `$.target.${artifact}.codeHash`)
        : null;

    if (currentCodeHash === null || targetCodeHash === null) {
      blockers.push({
        code: "no-prior-build",
        reason:
          targetCodeHash === null
            ? `no previous WASM code hash is recorded for ${artifact}`
            : `no active WASM code hash is recorded for ${artifact}`,
      });
    } else if (currentCodeHash === targetCodeHash) {
      blockers.push({
        code: "already-at-target",
        reason: `${artifact} is already running WASM ${currentCodeHash}; no rollback code change exists`,
      });
    }

    const currentSchemaVersion = currentBuild?.schemaVersion ?? 1;
    const targetSchemaVersion = targetBuild?.schemaVersion ?? 1;

    // Storage migrations check: irreversible migrations or schema downgrades block rollback.
    const migrations = currentBuild?.migrations ?? [];
    for (const mig of migrations) {
      if (mig.toSchemaVersion > targetSchemaVersion && !mig.reversible) {
        blockers.push({
          code: "storage-migration-irreversible",
          migrationId: mig.id,
          reason: `migration "${mig.id}" (v${String(mig.fromSchemaVersion)} -> v${String(mig.toSchemaVersion)}) is irreversible: ${mig.reason}`,
        });
      } else if (mig.toSchemaVersion > targetSchemaVersion && mig.reversible) {
        warnings.push(
          `migration "${mig.id}" (v${String(mig.fromSchemaVersion)} -> v${String(mig.toSchemaVersion)}) requires manual pre-rollback state verification: ${mig.reason}`,
        );
      }
    }

    if (
      currentSchemaVersion > targetSchemaVersion &&
      !migrations.some((m) => m.toSchemaVersion >= currentSchemaVersion && m.reversible)
    ) {
      blockers.push({
        code: "storage-schema-downgrade",
        reason: `active storage schema v${String(currentSchemaVersion)} cannot roll back to target schema v${String(targetSchemaVersion)} without an explicitly verified reversible migration`,
      });
    }

    // Storage keys check: every live persistent/instance key must remain readable by target code.
    const currentKeys = currentBuild?.storageKeys ?? defaultStorageKeys(artifact);
    const targetKeys = targetBuild?.storageKeys ?? defaultStorageKeys(artifact);
    const missingKeys = currentKeys.filter((k) => !targetKeys.includes(k));
    if (missingKeys.length > 0) {
      blockers.push({
        code: "storage-key-incompatible",
        reason: `target WASM lacks live storage key support for: ${missingKeys.join(", ")}`,
      });
    }

    // Safety invariant check: exact integer amounts, authenticated dispatch, replay protection, recipient-bound claims.
    const targetInvariants = targetBuild?.preservedInvariants ?? REQUIRED_SAFETY_INVARIANTS;
    const missingInvariants = REQUIRED_SAFETY_INVARIANTS.filter(
      (inv) => !targetInvariants.includes(inv),
    );
    if (missingInvariants.length > 0) {
      blockers.push({
        code: "safety-invariant-regression",
        reason: `target WASM does not preserve mandatory protocol invariants: ${missingInvariants.join(", ")}`,
      });
    }

    // Active rail and entrypoint check.
    if (artifact === "router") {
      const targetRoutes = targetBuild?.supportedRoutes ?? enabledRoutes;
      for (const activeRoute of enabledRoutes) {
        if (!targetRoutes.includes(activeRoute)) {
          blockers.push({
            code: "active-route-entrypoint-missing",
            reason: `active route "${ROUTE_SLUGS[activeRoute]}" is enabled on-chain, but target router WASM does not support it; disable route via timelock before rolling back`,
          });
        }
      }
    }

    const requiredEntrypoints = defaultEntrypoints(artifact, enabledRoutes);
    const targetEntrypoints =
      targetBuild?.entrypoints ?? defaultEntrypoints(artifact, enabledRoutes);
    const missingEntrypoints = requiredEntrypoints.filter((fn) => !targetEntrypoints.includes(fn));
    if (missingEntrypoints.length > 0) {
      blockers.push({
        code: "active-route-entrypoint-missing",
        reason: `target ${artifact} WASM omits required live entrypoints: ${missingEntrypoints.join(", ")}`,
      });
    }

    // Authority & timelock governance requirements.
    let authority: RollbackAuthorityRequirement;
    if (artifact === "router") {
      const routerAdmin = isStellarAddress(currentDep.admin) ? currentDep.admin : null;
      if (routerAdmin === null) {
        blockers.push({
          code: "missing-required-authority",
          reason: "router admin authority address is missing or invalid",
        });
      }
      if (currentDep.timelockDelay < MIN_ROLLBACK_TIMELOCK_SECONDS) {
        blockers.push({
          code: "timelock-below-minimum",
          reason: `router timelockDelay ${String(currentDep.timelockDelay)}s is below the mandatory ${String(MIN_ROLLBACK_TIMELOCK_SECONDS)}s floor`,
        });
      }
      if (currentDep.treasury !== currentDep.admin) {
        warnings.push(
          `router admin (${currentDep.admin}) is distinct from treasury (${currentDep.treasury}); sign rollback queue/execute with router admin, never treasury`,
        );
      }
      authority = {
        mechanism: "router-timelock",
        authorityRole: "router-admin",
        requiredAuthority: routerAdmin,
        emergencyPauseGuardian: currentDep.guardian,
        treasuryAddress: currentDep.treasury,
        timelockDelaySeconds: currentDep.timelockDelay,
        reviewSteps: [
          `verify target WASM ${targetCodeHash ?? "<unknown>"} remains uploaded and unarchived on ${input.chain}`,
          `optionally pause router via guardian (${currentDep.guardian}) if mitigating an active incident`,
          `invoke router queue_action(Upgrade(${targetCodeHash ?? "<unknown>"})) signed by router admin (${currentDep.admin})`,
          `wait full router timelock (${String(currentDep.timelockDelay)}s) with zero bypass`,
          `invoke router execute_action(action_id) signed by router admin (${currentDep.admin}) and re-run verify.sh`,
        ],
      };
    } else {
      const explicitAdapterAdmin =
        routeKind !== null ? input.adapterAdmins?.[routeKind] : undefined;
      const adapterAdmin = explicitAdapterAdmin ?? currentDep.admin;
      if (!isStellarAddress(adapterAdmin)) {
        blockers.push({
          code: "missing-required-authority",
          reason: `${artifact} admin authority address is missing or invalid`,
        });
      }
      if (explicitAdapterAdmin === undefined) {
        warnings.push(
          `${artifact} admin defaulted to manifest admin (${currentDep.admin}); confirm live get_config().admin before manual review`,
        );
      }
      authority = {
        mechanism: "adapter-direct-admin",
        authorityRole: "adapter-admin",
        requiredAuthority: isStellarAddress(adapterAdmin) ? adapterAdmin : null,
        emergencyPauseGuardian: currentDep.guardian,
        treasuryAddress: currentDep.treasury,
        timelockDelaySeconds: 0,
        reviewSteps: [
          `confirm live ${artifact}.get_config().admin equals ${adapterAdmin}`,
          `verify target WASM ${targetCodeHash ?? "<unknown>"} remains uploaded on ${input.chain}`,
          `invoke ${artifact}.upgrade(${targetCodeHash ?? "<unknown>"}) signed by adapter admin (${adapterAdmin}) after human review`,
        ],
      };
    }

    const feasible = blockers.length === 0;
    assessments.push({
      artifact,
      contractAddress: currentContractAddress,
      currentCodeHash,
      targetCodeHash,
      currentSchemaVersion,
      targetSchemaVersion,
      feasible,
      status: feasible ? "compatible" : "unsupported",
      authority,
      blockers,
      warnings,
    });
  }

  return {
    chain: input.chain,
    family: "stellar",
    validationGate,
    readOnly: true,
    executionPermitted: false,
    overallFeasible: assessments.length > 0 && assessments.every((a) => a.feasible),
    evaluatedAt,
    contracts: assessments,
  };
}

/**
 * Render a deterministic, secret-free human-readable rollback feasibility report.
 */
export function formatRollbackFeasibilityReport(report: RollbackFeasibilityReport): string {
  const lines: string[] = [
    `Rollback Feasibility Report (${report.chain}, ${report.family})`,
    `Mode: READ-ONLY ADVISORY (readOnly=${String(report.readOnly)}, executionPermitted=${String(report.executionPermitted)})`,
    `Validation gate: ${report.validationGate}`,
    `Overall rollback feasible: ${report.overallFeasible ? "YES (human-reviewed manual governance required)" : "NO (unsupported)"}`,
  ];

  for (const item of report.contracts) {
    lines.push("");
    lines.push(
      `[${item.feasible ? "COMPATIBLE" : "UNSUPPORTED"}] ${item.artifact} (${item.contractAddress ?? "unassigned"})`,
    );
    lines.push(`  current (new) code hash: ${item.currentCodeHash ?? "<none>"}`);
    lines.push(`  target  (old) code hash: ${item.targetCodeHash ?? "<none>"}`);
    lines.push(
      `  storage schema:          v${String(item.currentSchemaVersion)} -> v${String(item.targetSchemaVersion)}`,
    );
    lines.push(
      `  required authority:      ${item.authority.authorityRole} = ${item.authority.requiredAuthority ?? "<missing>"} (${item.authority.mechanism}, timelock=${String(item.authority.timelockDelaySeconds)}s)`,
    );
    for (const blocker of item.blockers) {
      lines.push(`  blocker [${blocker.code}]: ${blocker.reason}`);
    }
    for (const warning of item.warnings) {
      lines.push(`  note: ${warning}`);
    }
  }

  return lines.join("\n");
}
