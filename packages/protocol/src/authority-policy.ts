/**
 * Activation authority policy and live consistency verification.
 *
 * A deployment record says what was intended when phase one ran. Activation readiness asks a
 * stricter question: do the live router treasury, router guardian, router administrator, and
 * per-rail adapter administrators match a reviewed manifest policy right now, without assuming
 * treasury and administrator are the same account, and without requiring any signing secret to
 * inspect the chain?
 *
 * The active deployment scope is Stellar Testnet outbound Axelar ITS and Circle CCTP. EVM
 * deployments and unvalidated rails remain explicitly gated until independently validated, so a
 * verifier cannot report an unreviewed surface as ready by accident.
 */
import { AddressKind, parseStellarAddress } from "./addresses.js";
import type { Hex } from "./bytes.js";
import type { ChainKey } from "./chains.js";
import { isChainKey } from "./chains.js";
import {
  DeploymentFormatError,
  type Deployment,
  type DeploymentSet,
  deployedChains,
  isEvmDeployment,
  isStellarDeployment,
  parseDeploymentSet,
} from "./deployments.js";
import { ROUTE_KINDS, ROUTE_SLUGS, RouteKind, type RouteSlug, tryRouteFromSlug } from "./routes.js";

export const AUTHORITY_POLICY_SCHEMA_VERSION = 1;

/** Chains whose outbound activation path has been independently validated in this repository. */
export const ACTIVE_VALIDATED_CHAINS: readonly ChainKey[] = ["stellar-testnet"];

/** Rails independently validated on Stellar Testnet outbound activation. */
export const ACTIVE_VALIDATED_ROUTES: readonly RouteKind[] = [RouteKind.Cctp, RouteKind.AxelarIts];

export interface AuthorityRoleSeparationPolicy {
  /**
   * Whether the reviewed manifest permits `treasury` and `admin` to name the same address.
   *
   * Defaults to true so single-operator testnet deployments continue to validate cleanly, while
   * production or staged multisig manifests can set this to false without changing code. Even when
   * true, checks always compare `treasury` against the policy's `treasury` and `admin` against the
   * policy's `admin` independently.
   */
  readonly allowSharedAdminAndTreasury: boolean;
  /** Whether `guardian` must differ from both `admin` and `treasury`. */
  readonly requireDistinctGuardian: boolean;
}

export interface AuthorityValidationGate {
  /**
   * Explicit reviewer attestation for chains or rails outside the default active Stellar Testnet
   * ITS/CCTP deployment scope. False by default so EVM and unvalidated rails remain gated.
   */
  readonly independentlyValidated: boolean;
  /** Allowed rail set for this manifest entry. */
  readonly allowedRoutes: readonly RouteKind[];
}

export interface ReviewedNetworkAuthorityPolicy {
  readonly family: "stellar" | "evm";
  readonly chain: ChainKey;
  readonly router: string;
  readonly treasury: string;
  readonly admin: string;
  readonly guardian: string;
  /**
   * Expected administrator per configured rail adapter.
   *
   * Keyed by `RouteKind`. Adapters need not share the router's administrator or the treasury
   * address during staged handovers or split custody.
   */
  readonly adapterAdmins: Readonly<Partial<Record<RouteKind, string>>>;
  /** Expected adapter contract address per configured rail. */
  readonly adapters: Readonly<Partial<Record<RouteKind, string>>>;
  readonly roleSeparation: AuthorityRoleSeparationPolicy;
  readonly validationGate: AuthorityValidationGate;
}

export interface AuthorityManifestPolicy {
  readonly schemaVersion: number;
  readonly networks: Readonly<Partial<Record<ChainKey, ReviewedNetworkAuthorityPolicy>>>;
}

export interface QueuedAuthorityChange {
  readonly id: number;
  readonly kind: "SetAdmin" | "SetGuardian" | "SetTreasury";
  readonly target: string;
}

export interface LiveStellarAdapterAuthority {
  readonly address: string;
  readonly admin: string;
  readonly router: string;
}

export interface LiveStellarAuthoritySnapshot {
  readonly family: "stellar";
  readonly chain: ChainKey;
  readonly router: string;
  readonly routerConfig: {
    readonly admin: string;
    readonly guardian: string;
    readonly treasury: string;
    readonly paused?: boolean | undefined;
  };
  /** Optional result of the standalone `router.treasury()` view for cross-checking `get_config`. */
  readonly routerTreasuryView?: string | undefined;
  /** Live `get_config` observations per configured adapter. */
  readonly adapters?: Readonly<Partial<Record<RouteKind, LiveStellarAdapterAuthority>>> | undefined;
  /** Optional read-only snapshot of pending timelock authority actions on the router. */
  readonly pendingAuthorityActions?: readonly QueuedAuthorityChange[] | undefined;
}

export interface LiveEvmAdapterAuthority {
  readonly address: Hex;
  readonly adminHolders: readonly Hex[];
  readonly router: Hex;
}

export interface LiveEvmAuthoritySnapshot {
  readonly family: "evm";
  readonly chain: ChainKey;
  readonly router: Hex;
  readonly treasury: Hex;
  /** Addresses confirmed to hold `DEFAULT_ADMIN_ROLE` on the router. */
  readonly adminHolders: readonly Hex[];
  /** Addresses confirmed to hold `GUARDIAN_ROLE` on the router. */
  readonly guardianHolders: readonly Hex[];
  readonly paused?: boolean | undefined;
  readonly adapters?: Readonly<Partial<Record<RouteKind, LiveEvmAdapterAuthority>>> | undefined;
}

export type LiveAuthoritySnapshot = LiveStellarAuthoritySnapshot | LiveEvmAuthoritySnapshot;

export type AuthorityRoleKind =
  | "treasury"
  | "admin"
  | "guardian"
  | "adapter-admin"
  | "adapter-router"
  | "router-binding"
  | "timelock-queue"
  | "role-separation"
  | "validation-gate";

export type AuthorityMismatchCode =
  | "unexpected-address"
  | "manifest-policy-drift"
  | "role-separation-violation"
  | "pending-handover"
  | "unexpected-queued-change"
  | "missing-observation"
  | "router-paused"
  | "unvalidated-scope-gated";

export interface AuthorityCheckEntry {
  readonly scope: string;
  readonly role: AuthorityRoleKind;
  readonly expected: string;
  readonly observed: string;
  readonly ok: boolean;
}

export interface AuthorityMismatch {
  readonly scope: string;
  readonly role: AuthorityRoleKind;
  readonly code: AuthorityMismatchCode;
  readonly expected: string;
  readonly observed: string;
  readonly message: string;
}

export interface AuthorityConsistencyReport {
  readonly chain: ChainKey;
  readonly family: "stellar" | "evm";
  readonly router: string;
  /** True only when zero mismatches exist and the deployment scope is not gated. */
  readonly ready: boolean;
  readonly gated: boolean;
  readonly gateReasons: readonly string[];
  readonly checks: readonly AuthorityCheckEntry[];
  readonly mismatches: readonly AuthorityMismatch[];
}

function failPolicy(path: string, reason: string): never {
  throw new DeploymentFormatError(path, reason);
}

/**
 * Refuse strings carrying secret key shapes so verification inputs and reports stay secret-free.
 *
 * Checks for SEP-23 secret seeds (`S` followed by 55 base32 characters) and raw 32-byte hex keys
 * passed where public addresses belong.
 */
export function containsSecretMaterial(value: string): boolean {
  if (/\bS[A-Z2-7]{55}\b/.test(value)) return true;
  if (/(?:private[_-]?key|secret[_-]?key|mnemonic)\s*[:=]/i.test(value)) return true;
  return false;
}

export function assertNoSecretMaterial(value: string, label = "input"): void {
  if (containsSecretMaterial(value)) {
    throw new DeploymentFormatError(
      label,
      "secret material is not permitted in authority policy or verification inputs",
    );
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failPolicy(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    failPolicy(path, "expected a non empty string");
  }
  assertNoSecretMaterial(value, path);
  return value;
}

function asBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") failPolicy(path, "expected a boolean");
  return value;
}

function normalizeEvmAuthority(value: unknown, path: string): Hex {
  const text = asNonEmptyString(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
    failPolicy(path, "expected a 20 byte hex address");
  }
  if (/^0x0{40}$/.test(text)) {
    failPolicy(path, "zero address cannot hold an authority or treasury role");
  }
  return text.toLowerCase() as Hex;
}

function parseStellarAuthorityAddress(value: unknown, path: string): string {
  const text = asNonEmptyString(value, path);
  let parts;
  try {
    parts = parseStellarAddress(text);
  } catch {
    failPolicy(path, "expected a valid non-zero Stellar account or contract address");
  }
  if (parts.kind !== AddressKind.Account && parts.kind !== AddressKind.Contract) {
    failPolicy(path, "muxed addresses cannot hold Soroban authority or treasury roles");
  }
  return text;
}

function parseStellarContractId(value: unknown, path: string): string {
  const text = parseStellarAuthorityAddress(value, path);
  if (!text.startsWith("C")) {
    failPolicy(path, "expected a Soroban contract id starting with C");
  }
  return text;
}

function parseAllowedRoutes(
  value: unknown,
  path: string,
  fallback: readonly RouteKind[],
): readonly RouteKind[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) failPolicy(path, "expected an array of rail slugs");
  return value.map((item, index) => {
    const slug = asNonEmptyString(item, `${path}[${String(index)}]`);
    const route = tryRouteFromSlug(slug);
    if (route === null) {
      failPolicy(
        `${path}[${String(index)}]`,
        `unknown rail "${slug}", expected one of ${ROUTE_KINDS.map((kind) => ROUTE_SLUGS[kind]).join(", ")}`,
      );
    }
    return route;
  });
}

function parseAdapterMap(
  value: unknown,
  path: string,
  readAddress: (raw: unknown, entryPath: string) => string,
): Partial<Record<RouteKind, string>> {
  if (value === undefined) return {};
  const record = asObject(value, path);
  const out: Partial<Record<RouteKind, string>> = {};
  for (const [slug, rawEntry] of Object.entries(record)) {
    const route = tryRouteFromSlug(slug);
    if (route === null) failPolicy(`${path}.${slug}`, "unknown rail slug");
    out[route] = readAddress(rawEntry, `${path}.${slug}`);
  }
  return out;
}

function defaultIndependentlyValidated(chain: ChainKey, family: "stellar" | "evm"): boolean {
  return family === "stellar" && ACTIVE_VALIDATED_CHAINS.includes(chain);
}

/**
 * Build a reviewed network authority policy from a validated `Deployment` and any optional
 * `authorityPolicy` block embedded on the network record.
 */
export function deriveNetworkAuthorityPolicy(
  deployment: Deployment,
  rawPolicyOverride?: unknown,
  path = `$.networks.${deployment.chain}.authorityPolicy`,
): ReviewedNetworkAuthorityPolicy {
  const overrideObj =
    rawPolicyOverride === undefined ? undefined : asObject(rawPolicyOverride, path);

  const readAuthority =
    deployment.family === "stellar" ? parseStellarAuthorityAddress : normalizeEvmAuthority;
  const readContract =
    deployment.family === "stellar" ? parseStellarContractId : normalizeEvmAuthority;

  const router =
    overrideObj?.router !== undefined
      ? readContract(overrideObj.router, `${path}.router`)
      : isEvmDeployment(deployment)
        ? deployment.router.toLowerCase()
        : deployment.router;

  const treasury =
    overrideObj?.treasury !== undefined
      ? readAuthority(overrideObj.treasury, `${path}.treasury`)
      : isEvmDeployment(deployment)
        ? deployment.treasury.toLowerCase()
        : deployment.treasury;

  const admin =
    overrideObj?.admin !== undefined
      ? readAuthority(overrideObj.admin, `${path}.admin`)
      : isEvmDeployment(deployment)
        ? deployment.admin.toLowerCase()
        : deployment.admin;

  const guardian =
    overrideObj?.guardian !== undefined
      ? readAuthority(overrideObj.guardian, `${path}.guardian`)
      : isEvmDeployment(deployment)
        ? deployment.guardian.toLowerCase()
        : deployment.guardian;

  const adapters: Partial<Record<RouteKind, string>> = {};
  for (const kind of ROUTE_KINDS) {
    const addr = deployment.adapters[kind];
    if (addr !== undefined) {
      adapters[kind] = isEvmDeployment(deployment) ? addr.toLowerCase() : addr;
    }
  }
  if (overrideObj?.adapters !== undefined) {
    const overrideAdapters = parseAdapterMap(
      overrideObj.adapters,
      `${path}.adapters`,
      readContract,
    );
    for (const kind of ROUTE_KINDS) {
      const overrideAddr = overrideAdapters[kind];
      if (overrideAddr !== undefined) {
        adapters[kind] = overrideAddr;
      }
    }
  }

  const explicitAdapterAdmins = parseAdapterMap(
    overrideObj?.adapterAdmins,
    `${path}.adapterAdmins`,
    readAuthority,
  );
  const adapterAdmins: Partial<Record<RouteKind, string>> = {};
  for (const kind of ROUTE_KINDS) {
    if (adapters[kind] !== undefined) {
      adapterAdmins[kind] = explicitAdapterAdmins[kind] ?? admin;
    } else if (explicitAdapterAdmins[kind] !== undefined) {
      adapterAdmins[kind] = explicitAdapterAdmins[kind];
    }
  }

  const separationRaw =
    overrideObj?.roleSeparation === undefined
      ? undefined
      : asObject(overrideObj.roleSeparation, `${path}.roleSeparation`);
  const roleSeparation: AuthorityRoleSeparationPolicy = {
    allowSharedAdminAndTreasury: asBoolean(
      separationRaw?.allowSharedAdminAndTreasury,
      `${path}.roleSeparation.allowSharedAdminAndTreasury`,
      true,
    ),
    requireDistinctGuardian: asBoolean(
      separationRaw?.requireDistinctGuardian,
      `${path}.roleSeparation.requireDistinctGuardian`,
      false,
    ),
  };

  const gateRaw =
    overrideObj?.validationGate === undefined
      ? undefined
      : asObject(overrideObj.validationGate, `${path}.validationGate`);
  const validationGate: AuthorityValidationGate = {
    independentlyValidated: asBoolean(
      gateRaw?.independentlyValidated,
      `${path}.validationGate.independentlyValidated`,
      defaultIndependentlyValidated(deployment.chain, deployment.family),
    ),
    allowedRoutes: parseAllowedRoutes(
      gateRaw?.allowedRoutes,
      `${path}.validationGate.allowedRoutes`,
      ACTIVE_VALIDATED_ROUTES,
    ),
  };

  return {
    family: deployment.family,
    chain: deployment.chain,
    router,
    treasury,
    admin,
    guardian,
    adapterAdmins,
    adapters,
    roleSeparation,
    validationGate,
  };
}

/**
 * Parse a standalone reviewed authority manifest policy JSON object, or derive one from a
 * canonical deployment record (including any embedded `authorityPolicy` blocks).
 */
export function parseAuthorityManifestPolicy(
  policyOrManifest: unknown,
  baseDeploymentSet?: DeploymentSet,
): AuthorityManifestPolicy {
  const root = asObject(policyOrManifest, "$");

  // If handed a full deployment manifest without a separate policy file, validate the deployment
  // set first and extract embedded per-network `authorityPolicy` overrides when present.
  if (baseDeploymentSet === undefined && root.generatedAt !== undefined) {
    const parsedSet = parseDeploymentSet(policyOrManifest);
    const rawNetworks = asObject(root.networks, "$.networks");
    const networks: Partial<Record<ChainKey, ReviewedNetworkAuthorityPolicy>> = {};
    for (const key of deployedChains(parsedSet)) {
      const deployment = parsedSet.networks[key];
      if (deployment === undefined) continue;
      const rawEntry = asObject(rawNetworks[key], `$.networks.${key}`);
      networks[key] = deriveNetworkAuthorityPolicy(
        deployment,
        rawEntry.authorityPolicy,
        `$.networks.${key}.authorityPolicy`,
      );
    }
    return {
      schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
      networks,
    };
  }

  const schemaVersion = root.schemaVersion;
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion !== AUTHORITY_POLICY_SCHEMA_VERSION
  ) {
    failPolicy(
      "$.schemaVersion",
      `expected ${String(AUTHORITY_POLICY_SCHEMA_VERSION)}, found ${String(schemaVersion)}`,
    );
  }

  const rawNetworks = asObject(root.networks, "$.networks");
  const networks: Partial<Record<ChainKey, ReviewedNetworkAuthorityPolicy>> = {};

  for (const [key, entry] of Object.entries(rawNetworks)) {
    const netPath = `$.networks.${key}`;
    if (!isChainKey(key)) failPolicy(netPath, "unknown chain key");
    const baseDeployment = baseDeploymentSet?.networks[key];
    if (baseDeployment !== undefined) {
      networks[key] = deriveNetworkAuthorityPolicy(baseDeployment, entry, netPath);
      continue;
    }

    const netObj = asObject(entry, netPath);
    const familyRaw = asNonEmptyString(netObj.family, `${netPath}.family`);
    if (familyRaw !== "stellar" && familyRaw !== "evm") {
      failPolicy(`${netPath}.family`, `expected "stellar" or "evm", found "${familyRaw}"`);
    }
    const readAuthority =
      familyRaw === "stellar" ? parseStellarAuthorityAddress : normalizeEvmAuthority;
    const readContract = familyRaw === "stellar" ? parseStellarContractId : normalizeEvmAuthority;

    const router = readContract(netObj.router, `${netPath}.router`);
    const treasury = readAuthority(netObj.treasury, `${netPath}.treasury`);
    const admin = readAuthority(netObj.admin, `${netPath}.admin`);
    const guardian = readAuthority(netObj.guardian, `${netPath}.guardian`);
    const adapters = parseAdapterMap(netObj.adapters, `${netPath}.adapters`, readContract);
    const explicitAdapterAdmins = parseAdapterMap(
      netObj.adapterAdmins,
      `${netPath}.adapterAdmins`,
      readAuthority,
    );
    const adapterAdmins: Partial<Record<RouteKind, string>> = {};
    for (const kind of ROUTE_KINDS) {
      if (adapters[kind] !== undefined) {
        adapterAdmins[kind] = explicitAdapterAdmins[kind] ?? admin;
      } else if (explicitAdapterAdmins[kind] !== undefined) {
        adapterAdmins[kind] = explicitAdapterAdmins[kind];
      }
    }

    const separationRaw =
      netObj.roleSeparation === undefined
        ? undefined
        : asObject(netObj.roleSeparation, `${netPath}.roleSeparation`);
    const gateRaw =
      netObj.validationGate === undefined
        ? undefined
        : asObject(netObj.validationGate, `${netPath}.validationGate`);

    networks[key] = {
      family: familyRaw,
      chain: key,
      router,
      treasury,
      admin,
      guardian,
      adapterAdmins,
      adapters,
      roleSeparation: {
        allowSharedAdminAndTreasury: asBoolean(
          separationRaw?.allowSharedAdminAndTreasury,
          `${netPath}.roleSeparation.allowSharedAdminAndTreasury`,
          true,
        ),
        requireDistinctGuardian: asBoolean(
          separationRaw?.requireDistinctGuardian,
          `${netPath}.roleSeparation.requireDistinctGuardian`,
          false,
        ),
      },
      validationGate: {
        independentlyValidated: asBoolean(
          gateRaw?.independentlyValidated,
          `${netPath}.validationGate.independentlyValidated`,
          defaultIndependentlyValidated(key, familyRaw),
        ),
        allowedRoutes: parseAllowedRoutes(
          gateRaw?.allowedRoutes,
          `${netPath}.validationGate.allowedRoutes`,
          ACTIVE_VALIDATED_ROUTES,
        ),
      },
    };
  }

  return {
    schemaVersion: AUTHORITY_POLICY_SCHEMA_VERSION,
    networks,
  };
}

function normalizeAddressForFamily(address: string, family: "stellar" | "evm"): string {
  assertNoSecretMaterial(address, "address");
  return family === "evm" ? address.toLowerCase() : address;
}

function checkManifestAgainstPolicy(
  deployment: Deployment,
  policy: ReviewedNetworkAuthorityPolicy,
  checks: AuthorityCheckEntry[],
  mismatches: AuthorityMismatch[],
): void {
  const family = policy.family;
  const manifestRouter = normalizeAddressForFamily(deployment.router, family);
  const manifestTreasury = normalizeAddressForFamily(deployment.treasury, family);
  const manifestAdmin = normalizeAddressForFamily(deployment.admin, family);
  const manifestGuardian = normalizeAddressForFamily(deployment.guardian, family);

  const pairs: readonly {
    scope: string;
    role: AuthorityRoleKind;
    manifestValue: string;
    policyValue: string;
  }[] = [
    {
      scope: "manifest.router",
      role: "router-binding",
      manifestValue: manifestRouter,
      policyValue: policy.router,
    },
    {
      scope: "manifest.treasury",
      role: "treasury",
      manifestValue: manifestTreasury,
      policyValue: policy.treasury,
    },
    {
      scope: "manifest.admin",
      role: "admin",
      manifestValue: manifestAdmin,
      policyValue: policy.admin,
    },
    {
      scope: "manifest.guardian",
      role: "guardian",
      manifestValue: manifestGuardian,
      policyValue: policy.guardian,
    },
  ];

  for (const pair of pairs) {
    const ok = pair.manifestValue === pair.policyValue;
    checks.push({
      scope: pair.scope,
      role: pair.role,
      expected: pair.policyValue,
      observed: pair.manifestValue,
      ok,
    });
    if (!ok) {
      mismatches.push({
        scope: pair.scope,
        role: pair.role,
        code: "manifest-policy-drift",
        expected: pair.policyValue,
        observed: pair.manifestValue,
        message: `${pair.scope} in deployment record (${pair.manifestValue}) disagrees with reviewed manifest policy (${pair.policyValue})`,
      });
    }
  }

  for (const kind of ROUTE_KINDS) {
    const slug: RouteSlug = ROUTE_SLUGS[kind];
    const manifestAdapter = deployment.adapters[kind];
    const policyAdapter = policy.adapters[kind];
    if (manifestAdapter === undefined && policyAdapter === undefined) continue;
    const normalizedManifest =
      manifestAdapter === undefined
        ? "<unset>"
        : normalizeAddressForFamily(manifestAdapter, family);
    const normalizedPolicy = policyAdapter ?? "<unset>";
    const ok = normalizedManifest === normalizedPolicy;
    checks.push({
      scope: `manifest.adapters.${slug}`,
      role: "router-binding",
      expected: normalizedPolicy,
      observed: normalizedManifest,
      ok,
    });
    if (!ok) {
      mismatches.push({
        scope: `manifest.adapters.${slug}`,
        role: "router-binding",
        code: "manifest-policy-drift",
        expected: normalizedPolicy,
        observed: normalizedManifest,
        message: `manifest adapter for ${slug} (${normalizedManifest}) disagrees with reviewed policy (${normalizedPolicy})`,
      });
    }
  }
}

function checkRoleSeparation(
  policy: ReviewedNetworkAuthorityPolicy,
  checks: AuthorityCheckEntry[],
  mismatches: AuthorityMismatch[],
): void {
  if (!policy.roleSeparation.allowSharedAdminAndTreasury) {
    const distinct = policy.treasury !== policy.admin;
    checks.push({
      scope: "policy.roleSeparation.treasuryAdmin",
      role: "role-separation",
      expected: `treasury != ${policy.admin}`,
      observed: policy.treasury,
      ok: distinct,
    });
    if (!distinct) {
      mismatches.push({
        scope: "policy.roleSeparation.treasuryAdmin",
        role: "role-separation",
        code: "role-separation-violation",
        expected: `distinct treasury and admin addresses`,
        observed: `${policy.treasury} shared by treasury and admin`,
        message:
          "reviewed policy requires treasury and administrator to be distinct addresses, but both name the same account",
      });
    }
  }

  if (policy.roleSeparation.requireDistinctGuardian) {
    const distinctFromAdmin = policy.guardian !== policy.admin;
    const distinctFromTreasury = policy.guardian !== policy.treasury;
    const ok = distinctFromAdmin && distinctFromTreasury;
    checks.push({
      scope: "policy.roleSeparation.guardian",
      role: "role-separation",
      expected: "guardian distinct from admin and treasury",
      observed: policy.guardian,
      ok,
    });
    if (!ok) {
      mismatches.push({
        scope: "policy.roleSeparation.guardian",
        role: "role-separation",
        code: "role-separation-violation",
        expected: "guardian distinct from admin and treasury",
        observed: policy.guardian,
        message: "reviewed policy requires guardian to be distinct from administrator and treasury",
      });
    }
  }
}

function evaluateValidationGate(
  policy: ReviewedNetworkAuthorityPolicy,
  deployment: Deployment | undefined,
  gateReasons: string[],
  checks: AuthorityCheckEntry[],
  mismatches: AuthorityMismatch[],
): void {
  if (!policy.validationGate.independentlyValidated) {
    const reason =
      policy.family === "evm"
        ? `EVM chain "${policy.chain}" remains gated until independently validated`
        : `Stellar chain "${policy.chain}" is outside the validated Stellar Testnet scope and lacks independent validation attestation`;
    gateReasons.push(reason);
    checks.push({
      scope: `gate.chain.${policy.chain}`,
      role: "validation-gate",
      expected: "independentlyValidated=true",
      observed: "independentlyValidated=false",
      ok: false,
    });
    mismatches.push({
      scope: `gate.chain.${policy.chain}`,
      role: "validation-gate",
      code: "unvalidated-scope-gated",
      expected: "independentlyValidated=true",
      observed: "independentlyValidated=false",
      message: reason,
    });
  }

  const configuredRoutes = new Set<RouteKind>();
  for (const kind of ROUTE_KINDS) {
    if (policy.adapters[kind] !== undefined || policy.adapterAdmins[kind] !== undefined) {
      configuredRoutes.add(kind);
    }
  }
  if (deployment !== undefined) {
    const tokens = isStellarDeployment(deployment)
      ? Object.values(deployment.tokens)
      : Object.values(deployment.tokens);
    for (const token of tokens) {
      for (const route of token.routes) {
        configuredRoutes.add(route);
      }
    }
  }

  for (const route of configuredRoutes) {
    const slug = ROUTE_SLUGS[route];
    const allowed = policy.validationGate.allowedRoutes.includes(route);
    checks.push({
      scope: `gate.route.${slug}`,
      role: "validation-gate",
      expected: `route in [${policy.validationGate.allowedRoutes.map((kind) => ROUTE_SLUGS[kind]).join(", ")}]`,
      observed: slug,
      ok: allowed,
    });
    if (!allowed) {
      const reason = `rail "${slug}" on ${policy.chain} remains gated until independently validated`;
      gateReasons.push(reason);
      mismatches.push({
        scope: `gate.route.${slug}`,
        role: "validation-gate",
        code: "unvalidated-scope-gated",
        expected: "validated rail",
        observed: slug,
        message: reason,
      });
    }
  }
}

/**
 * Compare live on-chain treasury, guardian, router administrator, and per-adapter administrators
 * against a reviewed manifest policy (and optional deployment record).
 *
 * Does not assume `treasury` and `admin` are identical: each role is verified strictly against its
 * own policy expectation.
 */
export function verifyAuthorityConsistency(options: {
  readonly policy: ReviewedNetworkAuthorityPolicy;
  readonly live: LiveAuthoritySnapshot;
  readonly deployment?: Deployment | undefined;
  readonly deployer?: string | undefined;
}): AuthorityConsistencyReport {
  const { policy, live, deployment, deployer } = options;

  if (deployer !== undefined) {
    assertNoSecretMaterial(deployer, "deployer");
  }

  if (policy.chain !== live.chain || policy.family !== live.family) {
    throw new DeploymentFormatError(
      `$.networks.${live.chain}`,
      `live snapshot (${live.family}:${live.chain}) does not match policy (${policy.family}:${policy.chain})`,
    );
  }
  if (
    deployment !== undefined &&
    (deployment.chain !== policy.chain || deployment.family !== policy.family)
  ) {
    throw new DeploymentFormatError(
      `$.networks.${deployment.chain}`,
      `deployment record (${deployment.family}:${deployment.chain}) does not match policy (${policy.family}:${policy.chain})`,
    );
  }

  const checks: AuthorityCheckEntry[] = [];
  const mismatches: AuthorityMismatch[] = [];
  const gateReasons: string[] = [];

  if (
    deployment !== undefined &&
    (isStellarDeployment(deployment) || isEvmDeployment(deployment))
  ) {
    checkManifestAgainstPolicy(deployment, policy, checks, mismatches);
  }

  checkRoleSeparation(policy, checks, mismatches);
  evaluateValidationGate(policy, deployment, gateReasons, checks, mismatches);

  if (live.family === "stellar") {
    verifyStellarLiveAuthorities(policy, live, deployer, checks, mismatches);
  } else {
    verifyEvmLiveAuthorities(policy, live, deployer, checks, mismatches);
  }

  const gated = gateReasons.length > 0;
  return {
    chain: policy.chain,
    family: policy.family,
    router: policy.router,
    ready: !gated && mismatches.length === 0,
    gated,
    gateReasons,
    checks,
    mismatches,
  };
}

function verifyStellarLiveAuthorities(
  policy: ReviewedNetworkAuthorityPolicy,
  live: LiveStellarAuthoritySnapshot,
  deployer: string | undefined,
  checks: AuthorityCheckEntry[],
  mismatches: AuthorityMismatch[],
): void {
  assertNoSecretMaterial(live.router, "live.router");
  assertNoSecretMaterial(live.routerConfig.treasury, "live.routerConfig.treasury");
  assertNoSecretMaterial(live.routerConfig.admin, "live.routerConfig.admin");
  assertNoSecretMaterial(live.routerConfig.guardian, "live.routerConfig.guardian");

  const routerMatches = live.router === policy.router;
  checks.push({
    scope: "router.address",
    role: "router-binding",
    expected: policy.router,
    observed: live.router,
    ok: routerMatches,
  });
  if (!routerMatches) {
    mismatches.push({
      scope: "router.address",
      role: "router-binding",
      code: "unexpected-address",
      expected: policy.router,
      observed: live.router,
      message: `live router address ${live.router} does not match reviewed policy router ${policy.router}`,
    });
  }

  // Treasury is checked exclusively against `policy.treasury`, never against `policy.admin`.
  const treasuryOk = live.routerConfig.treasury === policy.treasury;
  checks.push({
    scope: "router.treasury",
    role: "treasury",
    expected: policy.treasury,
    observed: live.routerConfig.treasury,
    ok: treasuryOk,
  });
  if (!treasuryOk) {
    mismatches.push({
      scope: "router.treasury",
      role: "treasury",
      code: "unexpected-address",
      expected: policy.treasury,
      observed: live.routerConfig.treasury,
      message: `live router treasury ${live.routerConfig.treasury} does not match expected treasury ${policy.treasury}`,
    });
  }

  if (live.routerTreasuryView !== undefined) {
    assertNoSecretMaterial(live.routerTreasuryView, "live.routerTreasuryView");
    const viewOk = live.routerTreasuryView === policy.treasury;
    checks.push({
      scope: "router.treasury_view",
      role: "treasury",
      expected: policy.treasury,
      observed: live.routerTreasuryView,
      ok: viewOk,
    });
    if (!viewOk) {
      mismatches.push({
        scope: "router.treasury_view",
        role: "treasury",
        code: "unexpected-address",
        expected: policy.treasury,
        observed: live.routerTreasuryView,
        message: `router.treasury() view returned ${live.routerTreasuryView}, expected ${policy.treasury}`,
      });
    }
  }

  const adminOk = live.routerConfig.admin === policy.admin;
  checks.push({
    scope: "router.admin",
    role: "admin",
    expected: policy.admin,
    observed: live.routerConfig.admin,
    ok: adminOk,
  });
  if (!adminOk) {
    const isPendingHandover =
      deployer !== undefined && deployer !== policy.admin && live.routerConfig.admin === deployer;
    mismatches.push({
      scope: "router.admin",
      role: "admin",
      code: isPendingHandover ? "pending-handover" : "unexpected-address",
      expected: policy.admin,
      observed: live.routerConfig.admin,
      message: isPendingHandover
        ? `router admin is still held by phase-1 deployer ${deployer}; execute the matured SetAdmin handover to ${policy.admin}`
        : `live router admin ${live.routerConfig.admin} does not match expected admin ${policy.admin}`,
    });
  }

  const guardianOk = live.routerConfig.guardian === policy.guardian;
  checks.push({
    scope: "router.guardian",
    role: "guardian",
    expected: policy.guardian,
    observed: live.routerConfig.guardian,
    ok: guardianOk,
  });
  if (!guardianOk) {
    mismatches.push({
      scope: "router.guardian",
      role: "guardian",
      code: "unexpected-address",
      expected: policy.guardian,
      observed: live.routerConfig.guardian,
      message: `live router guardian ${live.routerConfig.guardian} does not match expected guardian ${policy.guardian}`,
    });
  }

  if (live.routerConfig.paused === true) {
    checks.push({
      scope: "router.paused",
      role: "validation-gate",
      expected: "false",
      observed: "true",
      ok: false,
    });
    mismatches.push({
      scope: "router.paused",
      role: "validation-gate",
      code: "router-paused",
      expected: "false",
      observed: "true",
      message: "router is currently paused on chain",
    });
  }

  // Per-rail adapter admin and router back-pointer checks.
  for (const kind of ROUTE_KINDS) {
    const slug = ROUTE_SLUGS[kind];
    const expectedAdapter = policy.adapters[kind];
    const expectedAdapterAdmin = policy.adapterAdmins[kind];
    if (expectedAdapter === undefined && expectedAdapterAdmin === undefined) continue;

    const observedAdapter = live.adapters?.[kind];
    if (observedAdapter === undefined) {
      const target = expectedAdapterAdmin ?? policy.admin;
      checks.push({
        scope: `adapter.${slug}.admin`,
        role: "adapter-admin",
        expected: target,
        observed: "<missing>",
        ok: false,
      });
      mismatches.push({
        scope: `adapter.${slug}.admin`,
        role: "adapter-admin",
        code: "missing-observation",
        expected: target,
        observed: "<missing>",
        message: `missing live get_config observation for configured ${slug} adapter`,
      });
      continue;
    }

    assertNoSecretMaterial(observedAdapter.address, `live.adapters.${slug}.address`);
    assertNoSecretMaterial(observedAdapter.admin, `live.adapters.${slug}.admin`);
    assertNoSecretMaterial(observedAdapter.router, `live.adapters.${slug}.router`);

    if (expectedAdapter !== undefined) {
      const addrOk = observedAdapter.address === expectedAdapter;
      checks.push({
        scope: `adapter.${slug}.address`,
        role: "router-binding",
        expected: expectedAdapter,
        observed: observedAdapter.address,
        ok: addrOk,
      });
      if (!addrOk) {
        mismatches.push({
          scope: `adapter.${slug}.address`,
          role: "router-binding",
          code: "unexpected-address",
          expected: expectedAdapter,
          observed: observedAdapter.address,
          message: `live ${slug} adapter address ${observedAdapter.address} does not match expected ${expectedAdapter}`,
        });
      }
    }

    const wantAdmin = expectedAdapterAdmin ?? policy.admin;
    const adapterAdminOk = observedAdapter.admin === wantAdmin;
    checks.push({
      scope: `adapter.${slug}.admin`,
      role: "adapter-admin",
      expected: wantAdmin,
      observed: observedAdapter.admin,
      ok: adapterAdminOk,
    });
    if (!adapterAdminOk) {
      mismatches.push({
        scope: `adapter.${slug}.admin`,
        role: "adapter-admin",
        code: "unexpected-address",
        expected: wantAdmin,
        observed: observedAdapter.admin,
        message: `live ${slug} adapter admin ${observedAdapter.admin} does not match expected adapter admin ${wantAdmin}`,
      });
    }

    const routerBindOk = observedAdapter.router === policy.router;
    checks.push({
      scope: `adapter.${slug}.router`,
      role: "adapter-router",
      expected: policy.router,
      observed: observedAdapter.router,
      ok: routerBindOk,
    });
    if (!routerBindOk) {
      mismatches.push({
        scope: `adapter.${slug}.router`,
        role: "adapter-router",
        code: "unexpected-address",
        expected: policy.router,
        observed: observedAdapter.router,
        message: `live ${slug} adapter points to router ${observedAdapter.router}, expected ${policy.router}`,
      });
    }
  }

  // Pending timelock actions affecting authorities must align with policy or be absent on a
  // settled active deployment.
  if (live.pendingAuthorityActions !== undefined) {
    for (const item of live.pendingAuthorityActions) {
      assertNoSecretMaterial(item.target, `pendingAuthorityActions[${String(item.id)}]`);
      const expectedTarget =
        item.kind === "SetAdmin"
          ? policy.admin
          : item.kind === "SetGuardian"
            ? policy.guardian
            : policy.treasury;
      const scope = `timelock.queue[${String(item.id)}].${item.kind}`;
      const matchesPolicy = item.target === expectedTarget;
      checks.push({
        scope,
        role: "timelock-queue",
        expected: expectedTarget,
        observed: item.target,
        ok: matchesPolicy,
      });
      if (!matchesPolicy) {
        mismatches.push({
          scope,
          role: "timelock-queue",
          code: "unexpected-queued-change",
          expected: expectedTarget,
          observed: item.target,
          message: `queued timelock action #${String(item.id)} (${item.kind}) targets unexpected address ${item.target} instead of policy address ${expectedTarget}`,
        });
      }
    }
  }
}

function verifyEvmLiveAuthorities(
  policy: ReviewedNetworkAuthorityPolicy,
  live: LiveEvmAuthoritySnapshot,
  deployer: string | undefined,
  checks: AuthorityCheckEntry[],
  mismatches: AuthorityMismatch[],
): void {
  const liveRouter = normalizeAddressForFamily(live.router, "evm");
  const liveTreasury = normalizeAddressForFamily(live.treasury, "evm");
  const liveAdmins = live.adminHolders.map((addr) => normalizeAddressForFamily(addr, "evm"));
  const liveGuardians = live.guardianHolders.map((addr) => normalizeAddressForFamily(addr, "evm"));
  const normalizedDeployer =
    deployer === undefined ? undefined : normalizeAddressForFamily(deployer, "evm");

  const routerOk = liveRouter === policy.router;
  checks.push({
    scope: "router.address",
    role: "router-binding",
    expected: policy.router,
    observed: liveRouter,
    ok: routerOk,
  });
  if (!routerOk) {
    mismatches.push({
      scope: "router.address",
      role: "router-binding",
      code: "unexpected-address",
      expected: policy.router,
      observed: liveRouter,
      message: `live EVM router ${liveRouter} does not match expected router ${policy.router}`,
    });
  }

  const treasuryOk = liveTreasury === policy.treasury;
  checks.push({
    scope: "router.treasury",
    role: "treasury",
    expected: policy.treasury,
    observed: liveTreasury,
    ok: treasuryOk,
  });
  if (!treasuryOk) {
    mismatches.push({
      scope: "router.treasury",
      role: "treasury",
      code: "unexpected-address",
      expected: policy.treasury,
      observed: liveTreasury,
      message: `live EVM router treasury ${liveTreasury} does not match expected treasury ${policy.treasury}`,
    });
  }

  const exactAdminSet = liveAdmins.length === 1 && liveAdmins[0] === policy.admin;
  const observedAdminsLabel = liveAdmins.length === 0 ? "<none>" : liveAdmins.join(", ");
  checks.push({
    scope: "router.admin",
    role: "admin",
    expected: policy.admin,
    observed: observedAdminsLabel,
    ok: exactAdminSet,
  });
  if (!exactAdminSet) {
    const isPendingHandover =
      normalizedDeployer !== undefined &&
      normalizedDeployer !== policy.admin &&
      liveAdmins.includes(normalizedDeployer);
    mismatches.push({
      scope: "router.admin",
      role: "admin",
      code: isPendingHandover ? "pending-handover" : "unexpected-address",
      expected: policy.admin,
      observed: observedAdminsLabel,
      message: isPendingHandover
        ? `router DEFAULT_ADMIN_ROLE still includes deployer ${normalizedDeployer}; complete handover so only ${policy.admin} holds admin`
        : `router DEFAULT_ADMIN_ROLE holders [${observedAdminsLabel}] do not match expected sole admin ${policy.admin}`,
    });
  }

  const exactGuardianSet = liveGuardians.length === 1 && liveGuardians[0] === policy.guardian;
  const observedGuardiansLabel = liveGuardians.length === 0 ? "<none>" : liveGuardians.join(", ");
  checks.push({
    scope: "router.guardian",
    role: "guardian",
    expected: policy.guardian,
    observed: observedGuardiansLabel,
    ok: exactGuardianSet,
  });
  if (!exactGuardianSet) {
    mismatches.push({
      scope: "router.guardian",
      role: "guardian",
      code: "unexpected-address",
      expected: policy.guardian,
      observed: observedGuardiansLabel,
      message: `router GUARDIAN_ROLE holders [${observedGuardiansLabel}] do not match expected sole guardian ${policy.guardian}`,
    });
  }

  if (live.paused === true) {
    checks.push({
      scope: "router.paused",
      role: "validation-gate",
      expected: "false",
      observed: "true",
      ok: false,
    });
    mismatches.push({
      scope: "router.paused",
      role: "validation-gate",
      code: "router-paused",
      expected: "false",
      observed: "true",
      message: "EVM router is currently paused on chain",
    });
  }

  for (const kind of ROUTE_KINDS) {
    const slug = ROUTE_SLUGS[kind];
    const expectedAdapter = policy.adapters[kind];
    const expectedAdapterAdmin = policy.adapterAdmins[kind];
    if (expectedAdapter === undefined && expectedAdapterAdmin === undefined) continue;

    const observed = live.adapters?.[kind];
    const wantAdmin = expectedAdapterAdmin ?? policy.admin;
    if (observed === undefined) {
      checks.push({
        scope: `adapter.${slug}.admin`,
        role: "adapter-admin",
        expected: wantAdmin,
        observed: "<missing>",
        ok: false,
      });
      mismatches.push({
        scope: `adapter.${slug}.admin`,
        role: "adapter-admin",
        code: "missing-observation",
        expected: wantAdmin,
        observed: "<missing>",
        message: `missing live role observation for configured ${slug} EVM adapter`,
      });
      continue;
    }

    const adapterAdmins = observed.adminHolders.map((addr) =>
      normalizeAddressForFamily(addr, "evm"),
    );
    const adapterAdminOk = adapterAdmins.length === 1 && adapterAdmins[0] === wantAdmin;
    const adapterAdminsLabel = adapterAdmins.length === 0 ? "<none>" : adapterAdmins.join(", ");
    checks.push({
      scope: `adapter.${slug}.admin`,
      role: "adapter-admin",
      expected: wantAdmin,
      observed: adapterAdminsLabel,
      ok: adapterAdminOk,
    });
    if (!adapterAdminOk) {
      mismatches.push({
        scope: `adapter.${slug}.admin`,
        role: "adapter-admin",
        code: "unexpected-address",
        expected: wantAdmin,
        observed: adapterAdminsLabel,
        message: `${slug} EVM adapter admin holders [${adapterAdminsLabel}] do not match expected ${wantAdmin}`,
      });
    }
  }
}

/**
 * Extract pending router authority changes (`SetAdmin`, `SetGuardian`, `SetTreasury`) from raw
 * `get_queued` JSON entries returned by the Stellar CLI or stored in deployment evidence.
 */
export function extractQueuedAuthorityChanges(
  queuedItems: readonly unknown[],
): readonly QueuedAuthorityChange[] {
  const out: QueuedAuthorityChange[] = [];
  for (let index = 0; index < queuedItems.length; index += 1) {
    const raw = queuedItems[index];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "number" ? item.id : Number(item.id);
    if (!Number.isInteger(id) || id < 1) continue;
    const action = item.action;
    if (Array.isArray(action) && typeof action[0] === "string" && typeof action[1] === "string") {
      const kind = action[0];
      const target = action[1];
      if (kind === "SetAdmin" || kind === "SetGuardian" || kind === "SetTreasury") {
        assertNoSecretMaterial(target, `queuedActions[${String(index)}].target`);
        out.push({ id, kind, target });
      }
    } else if (typeof action === "object" && action !== null && !Array.isArray(action)) {
      const actionObj = action as Record<string, unknown>;
      for (const kind of ["SetAdmin", "SetGuardian", "SetTreasury"] as const) {
        const target = actionObj[kind];
        if (typeof target === "string" && target.length > 0) {
          assertNoSecretMaterial(target, `queuedActions[${String(index)}].${kind}`);
          out.push({ id, kind, target });
        }
      }
    }
  }
  return out;
}

/**
 * Validate and normalize an offline or RPC-collected Stellar authority snapshot JSON payload.
 */
export function parseStellarAuthoritySnapshot(
  rawValue: unknown,
  chain: ChainKey,
  defaultRouter: string,
): LiveStellarAuthoritySnapshot {
  const raw = asObject(rawValue, "$");
  const router =
    raw.router === undefined ? defaultRouter : parseStellarContractId(raw.router, "$.router");
  const cfg = asObject(raw.routerConfig, "$.routerConfig");
  const admin = parseStellarAuthorityAddress(cfg.admin, "$.routerConfig.admin");
  const guardian = parseStellarAuthorityAddress(cfg.guardian, "$.routerConfig.guardian");
  const treasury = parseStellarAuthorityAddress(cfg.treasury, "$.routerConfig.treasury");
  const paused =
    cfg.paused === undefined ? undefined : asBoolean(cfg.paused, "$.routerConfig.paused", false);

  const routerTreasuryView =
    raw.routerTreasuryView === undefined
      ? undefined
      : parseStellarAuthorityAddress(raw.routerTreasuryView, "$.routerTreasuryView");

  const adapters: Partial<Record<RouteKind, LiveStellarAdapterAuthority>> = {};
  if (raw.adapters !== undefined) {
    const rawAdapters = asObject(raw.adapters, "$.adapters");
    for (const [slug, value] of Object.entries(rawAdapters)) {
      const route = tryRouteFromSlug(slug);
      if (route === null) failPolicy(`$.adapters.${slug}`, "unknown rail slug");
      const adapterObj = asObject(value, `$.adapters.${slug}`);
      adapters[route] = {
        address: parseStellarContractId(adapterObj.address, `$.adapters.${slug}.address`),
        admin: parseStellarAuthorityAddress(adapterObj.admin, `$.adapters.${slug}.admin`),
        router: parseStellarContractId(adapterObj.router, `$.adapters.${slug}.router`),
      };
    }
  }

  let pendingAuthorityActions: readonly QueuedAuthorityChange[] | undefined;
  if (Array.isArray(raw.pendingAuthorityActions)) {
    pendingAuthorityActions = raw.pendingAuthorityActions.map((entry, idx) => {
      const item = asObject(entry, `$.pendingAuthorityActions[${String(idx)}]`);
      const id = Number(item.id);
      if (!Number.isInteger(id) || id < 1) {
        failPolicy(`$.pendingAuthorityActions[${String(idx)}].id`, "expected a positive integer");
      }
      const kind = asNonEmptyString(item.kind, `$.pendingAuthorityActions[${String(idx)}].kind`);
      if (kind !== "SetAdmin" && kind !== "SetGuardian" && kind !== "SetTreasury") {
        failPolicy(
          `$.pendingAuthorityActions[${String(idx)}].kind`,
          'expected "SetAdmin", "SetGuardian", or "SetTreasury"',
        );
      }
      const target = parseStellarAuthorityAddress(
        item.target,
        `$.pendingAuthorityActions[${String(idx)}].target`,
      );
      return { id, kind, target };
    });
  } else if (Array.isArray(raw.queuedActions)) {
    pendingAuthorityActions = extractQueuedAuthorityChanges(raw.queuedActions);
  }

  return {
    family: "stellar",
    chain,
    router,
    routerConfig: {
      admin,
      guardian,
      treasury,
      ...(paused !== undefined ? { paused } : {}),
    },
    ...(routerTreasuryView !== undefined ? { routerTreasuryView } : {}),
    adapters,
    ...(pendingAuthorityActions !== undefined ? { pendingAuthorityActions } : {}),
  };
}

/**
 * Format a deterministic, secret-free authority consistency report suitable for operator review
 * and CI logs.
 */
export function formatAuthorityConsistencyReport(report: AuthorityConsistencyReport): string {
  const lines: string[] = [
    `Authority consistency report: ${report.chain} (${report.family})`,
    `Router: ${report.router}`,
    `Status: ${report.ready ? "READY" : report.gated ? "GATED (NOT READY)" : "FAILED (NOT READY)"}`,
  ];

  if (report.gateReasons.length > 0) {
    lines.push("Validation gates:");
    for (const reason of report.gateReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  lines.push("Checked roles:");
  for (const check of report.checks) {
    const verdict = check.ok ? "ok" : "MISMATCH";
    lines.push(
      `  [${verdict}] ${check.scope} (${check.role}): observed=${check.observed} expected=${check.expected}`,
    );
  }

  if (report.mismatches.length > 0) {
    lines.push(`Mismatches (${String(report.mismatches.length)}):`);
    for (const mismatch of report.mismatches) {
      lines.push(
        `  - [${mismatch.code}] ${mismatch.scope}: ${mismatch.message} (expected ${mismatch.expected}, observed ${mismatch.observed})`,
      );
    }
  } else {
    lines.push(
      "Mismatches (0): all live treasury, guardian, and administrator addresses match policy.",
    );
  }

  return lines.join("\n");
}
