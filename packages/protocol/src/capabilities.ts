/**
 * Validated deployment route capabilities, modeled independently from static registry catalogs.
 *
 * `CHAINS`, `ASSETS`, and `RAIL_CONTRACTS` record external chain metadata, Circle/Axelar contract
 * addresses, and token identifiers so deploy scripts and indexers share one reference table. That
 * registry presence never means Hyperion has validated or activated a live route on those chains.
 * Only an explicit capability record backed by validation evidence marks a lane activated.
 */
import { AddressKind } from "./addresses.js";
import type { ChainKey } from "./chains.js";
import { CHAINS, isChainKey } from "./chains.js";
import { assetsOn } from "./registry/assets.js";
import { RAIL_CONTRACTS } from "./registry/contracts.js";
import type { RouteSlug } from "./routes.js";
import { ROUTE_KINDS, ROUTE_META, ROUTE_SLUGS, RouteKind, tryRouteFromSlug } from "./routes.js";

/** Schema revision for `RouteCapabilityManifest` payloads. */
export const CAPABILITY_REVISION = 1;

export type RouteActivationStatus =
  "validated_active" | "gated_unvalidated" | "registry_only_not_activated" | "unsupported_revision";

export type PaidDispatchFeeMechanism =
  "none" | "adapter_gas_float" | "caller_native_gas" | "cctp_fast_fee";

const VALID_FEE_MECHANISMS: ReadonlySet<string> = new Set<PaidDispatchFeeMechanism>([
  "none",
  "adapter_gas_float",
  "caller_native_gas",
  "cctp_fast_fee",
]);

const VALID_ADDRESS_KINDS: ReadonlySet<number> = new Set<number>([
  AddressKind.Account,
  AddressKind.MuxedAccount,
  AddressKind.Contract,
]);

/** Explicit paid-dispatch capability declaration for a route. */
export interface PaidDispatchCapability {
  readonly supported: boolean;
  readonly feeMechanism: PaidDispatchFeeMechanism;
}

/** Explicit destination recipient-kind support declaration for a route. */
export interface RecipientKindSupport {
  /** Whether 20-byte EVM recipient addresses are accepted on the destination leg. */
  readonly evmAddress: boolean;
  /** Which Stellar SEP-23 recipient kinds (`G`, `M`, `C`) are accepted on the destination leg. */
  readonly stellarKinds: readonly AddressKind[];
}

/** Validated or gated capability record for an `(originChain, destinationChain, route, asset)` tuple. */
export interface RouteCapabilityRecord {
  readonly capabilityRevision: number;
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly route: RouteKind;
  readonly routeSlug: RouteSlug;
  readonly assetSymbol: string;
  readonly activated: boolean;
  readonly activationStatus: RouteActivationStatus;
  readonly paidDispatch: PaidDispatchCapability;
  readonly recipientSupport: RecipientKindSupport;
  readonly validationEvidence: string | null;
  readonly registryPresent: boolean;
}

export interface RouteCapabilityManifest {
  readonly capabilityRevision: 1;
  readonly generatedAt: string;
  readonly capabilities: readonly RouteCapabilityRecord[];
}

export interface RouteCapabilityQuery {
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly route: RouteKind;
  readonly assetSymbol: string;
}

/** Raised when a capability manifest fails schema, revision, or protocol invariant checks. */
export class CapabilityFormatError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`invalid capability manifest at ${path}: ${reason}`);
    this.name = "CapabilityFormatError";
  }
}

function failCapability(path: string, reason: string): never {
  throw new CapabilityFormatError(path, reason);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failCapability(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

/** Check whether static SDK registries mention both chains, the asset symbol, and the rail family. */
export function hasRegistryEntriesForRoute(query: RouteCapabilityQuery): boolean {
  if (!isChainKey(query.originChain) || !isChainKey(query.destinationChain)) {
    return false;
  }
  const srcAssets = assetsOn(query.originChain);
  const dstAssets = assetsOn(query.destinationChain);
  const hasAssetBothSides =
    srcAssets.some((a) => a.symbol === query.assetSymbol && a.routes.includes(query.route)) &&
    dstAssets.some((a) => a.symbol === query.assetSymbol && a.routes.includes(query.route));
  if (!hasAssetBothSides) return false;

  const srcChain = CHAINS[query.originChain];
  const dstChain = CHAINS[query.destinationChain];
  if (query.route === RouteKind.Cctp) {
    const evmKey = srcChain.family === "evm" ? query.originChain : query.destinationChain;
    const evmContracts = RAIL_CONTRACTS[evmKey];
    return (
      srcChain.cctpDomain !== null && dstChain.cctpDomain !== null && Boolean(evmContracts?.cctp)
    );
  }
  if (query.route === RouteKind.AxelarIts || query.route === RouteKind.AxelarGmp) {
    const srcContracts = RAIL_CONTRACTS[query.originChain];
    const dstContracts = RAIL_CONTRACTS[query.destinationChain];
    return (
      srcChain.axelarName !== null &&
      dstChain.axelarName !== null &&
      Boolean(srcContracts?.axelar ?? dstContracts?.axelar)
    );
  }
  return true;
}

function conservativeClosedRecord(
  query: RouteCapabilityQuery,
  activationStatus: Exclude<RouteActivationStatus, "validated_active">,
  capabilityRevision = CAPABILITY_REVISION,
): RouteCapabilityRecord {
  return {
    capabilityRevision,
    originChain: query.originChain,
    destinationChain: query.destinationChain,
    route: query.route,
    routeSlug: ROUTE_SLUGS[query.route],
    assetSymbol: query.assetSymbol,
    activated: false,
    activationStatus,
    paidDispatch: {
      supported: false,
      feeMechanism: "none",
    },
    recipientSupport: {
      evmAddress: false,
      stellarKinds: [],
    },
    validationEvidence: null,
    registryPresent: hasRegistryEntriesForRoute(query),
  };
}

function parseRouteTagOrSlug(raw: unknown, path: string): RouteKind {
  if (typeof raw === "number" && Number.isInteger(raw)) {
    const kind = raw as RouteKind;
    if (ROUTE_KINDS.includes(kind)) return kind;
    failCapability(path, `unknown RouteKind tag ${String(raw)}`);
  }
  if (typeof raw === "string") {
    const parsed = tryRouteFromSlug(raw);
    if (parsed !== null) return parsed;
    failCapability(path, `unknown route slug "${raw}"`);
  }
  failCapability(path, "expected RouteKind tag or slug");
}

function parsePaidDispatch(raw: unknown, path: string): PaidDispatchCapability {
  const obj = asRecord(raw, path);
  if (typeof obj.supported !== "boolean") {
    failCapability(`${path}.supported`, "expected a boolean");
  }
  if (typeof obj.feeMechanism !== "string" || !VALID_FEE_MECHANISMS.has(obj.feeMechanism)) {
    failCapability(
      `${path}.feeMechanism`,
      'expected feeMechanism in "none" | "adapter_gas_float" | "caller_native_gas" | "cctp_fast_fee"',
    );
  }
  const feeMechanism = obj.feeMechanism as PaidDispatchFeeMechanism;
  if (!obj.supported && feeMechanism !== "none") {
    failCapability(
      `${path}.feeMechanism`,
      'paidDispatch.supported=false requires feeMechanism="none"',
    );
  }
  if (obj.supported && feeMechanism === "none") {
    failCapability(
      `${path}.feeMechanism`,
      "paidDispatch.supported=true requires a concrete non-none feeMechanism",
    );
  }
  return {
    supported: obj.supported,
    feeMechanism,
  };
}

function parseRecipientSupport(
  raw: unknown,
  route: RouteKind,
  destinationChain: ChainKey,
  activated: boolean,
  path: string,
): RecipientKindSupport {
  const obj = asRecord(raw, path);
  if (typeof obj.evmAddress !== "boolean") {
    failCapability(`${path}.evmAddress`, "expected a boolean");
  }
  if (!Array.isArray(obj.stellarKinds)) {
    failCapability(`${path}.stellarKinds`, "expected an array of Stellar AddressKind tags");
  }
  const seen = new Set<AddressKind>();
  const kinds: AddressKind[] = [];
  for (let i = 0; i < obj.stellarKinds.length; i++) {
    const item: unknown = obj.stellarKinds[i];
    if (typeof item !== "number" || !VALID_ADDRESS_KINDS.has(item)) {
      failCapability(
        `${path}.stellarKinds[${String(i)}]`,
        "expected AddressKind tag (0=Account, 1=MuxedAccount, 2=Contract)",
      );
    }
    const kind = item as AddressKind;
    if (!seen.has(kind)) {
      seen.add(kind);
      kinds.push(kind);
    }
  }

  if (seen.has(AddressKind.MuxedAccount) && !ROUTE_META[route].carriesPayload) {
    failCapability(
      `${path}.stellarKinds`,
      `route "${ROUTE_SLUGS[route]}" does not carry payload notes and cannot support MuxedAccount recipients`,
    );
  }

  const dstFamily = CHAINS[destinationChain].family;
  if (dstFamily === "evm" && kinds.length > 0) {
    failCapability(
      `${path}.stellarKinds`,
      `EVM destination "${destinationChain}" cannot accept Stellar strkey recipient kinds`,
    );
  }
  if (dstFamily === "stellar" && obj.evmAddress) {
    failCapability(
      `${path}.evmAddress`,
      `Stellar destination "${destinationChain}" cannot accept raw 20-byte EVM recipient addresses`,
    );
  }
  if (activated) {
    if (dstFamily === "evm" && !obj.evmAddress) {
      failCapability(
        `${path}.evmAddress`,
        `activated outbound capability to EVM chain "${destinationChain}" must explicitly enable evmAddress`,
      );
    }
    if (dstFamily === "stellar" && kinds.length === 0) {
      failCapability(
        `${path}.stellarKinds`,
        `activated inbound capability to Stellar chain "${destinationChain}" must declare at least one AddressKind`,
      );
    }
  }

  kinds.sort((a, b) => a - b);
  return {
    evmAddress: obj.evmAddress,
    stellarKinds: Object.freeze(kinds),
  };
}

function parseCapabilityEntry(raw: unknown, path: string): RouteCapabilityRecord {
  const obj = asRecord(raw, path);
  if (typeof obj.originChain !== "string" || !isChainKey(obj.originChain)) {
    failCapability(`${path}.originChain`, "unknown ChainKey");
  }
  if (typeof obj.destinationChain !== "string" || !isChainKey(obj.destinationChain)) {
    failCapability(`${path}.destinationChain`, "unknown ChainKey");
  }
  if (obj.originChain === obj.destinationChain) {
    failCapability(`${path}.destinationChain`, "originChain and destinationChain must differ");
  }
  if (CHAINS[obj.originChain].network !== CHAINS[obj.destinationChain].network) {
    failCapability(
      `${path}.destinationChain`,
      `cannot pair ${CHAINS[obj.originChain].network} origin with ${CHAINS[obj.destinationChain].network} destination`,
    );
  }

  const route = parseRouteTagOrSlug(obj.route, `${path}.route`);
  if (typeof obj.assetSymbol !== "string" || obj.assetSymbol.trim().length === 0) {
    failCapability(`${path}.assetSymbol`, "expected a non-empty assetSymbol");
  }
  if (typeof obj.activated !== "boolean") {
    failCapability(`${path}.activated`, "expected a boolean");
  }

  const paidDispatch = parsePaidDispatch(obj.paidDispatch, `${path}.paidDispatch`);
  const recipientSupport = parseRecipientSupport(
    obj.recipientSupport,
    route,
    obj.destinationChain,
    obj.activated,
    `${path}.recipientSupport`,
  );

  let validationEvidence: string | null = null;
  if (obj.validationEvidence !== undefined && obj.validationEvidence !== null) {
    if (typeof obj.validationEvidence !== "string" || obj.validationEvidence.trim().length === 0) {
      failCapability(
        `${path}.validationEvidence`,
        "expected a non-empty evidence reference or null",
      );
    }
    validationEvidence = obj.validationEvidence;
  }

  if (obj.activated && validationEvidence === null) {
    failCapability(
      `${path}.validationEvidence`,
      "activated=true requires a concrete validationEvidence reference",
    );
  }

  const query: RouteCapabilityQuery = {
    originChain: obj.originChain,
    destinationChain: obj.destinationChain,
    route,
    assetSymbol: obj.assetSymbol,
  };

  return {
    capabilityRevision: CAPABILITY_REVISION,
    originChain: obj.originChain,
    destinationChain: obj.destinationChain,
    route,
    routeSlug: ROUTE_SLUGS[route],
    assetSymbol: obj.assetSymbol,
    activated: obj.activated,
    activationStatus: obj.activated ? "validated_active" : "gated_unvalidated",
    paidDispatch,
    recipientSupport,
    validationEvidence,
    registryPresent: hasRegistryEntriesForRoute(query),
  };
}

/**
 * Parse and validate a `RouteCapabilityManifest`.
 *
 * Throws `CapabilityFormatError` on unknown `capabilityRevision` values or missing explicit
 * `paidDispatch` / `recipientSupport` / `validationEvidence` fields.
 */
export function parseRouteCapabilityManifest(value: unknown): RouteCapabilityManifest {
  const root = asRecord(value, "$");
  if (typeof root.capabilityRevision !== "number" || !Number.isInteger(root.capabilityRevision)) {
    failCapability("$.capabilityRevision", "capabilityRevision must be an integer");
  }
  if (root.capabilityRevision !== CAPABILITY_REVISION) {
    failCapability(
      "$.capabilityRevision",
      `unsupported capabilityRevision ${String(root.capabilityRevision)}; expected ${String(CAPABILITY_REVISION)}`,
    );
  }
  if (typeof root.generatedAt !== "string" || Number.isNaN(Date.parse(root.generatedAt))) {
    failCapability("$.generatedAt", "expected an ISO-8601 timestamp string");
  }
  if (!Array.isArray(root.capabilities)) {
    failCapability("$.capabilities", "expected an array of capability records");
  }

  const seenSlots = new Set<string>();
  const capabilities: RouteCapabilityRecord[] = [];
  for (let i = 0; i < root.capabilities.length; i++) {
    const entryPath = `$.capabilities[${String(i)}]`;
    const record = parseCapabilityEntry(root.capabilities[i], entryPath);
    const slotKey = `${record.originChain}|${record.destinationChain}|${record.routeSlug}|${record.assetSymbol}`;
    if (seenSlots.has(slotKey)) {
      failCapability(entryPath, `duplicate capability entry for ${slotKey}`);
    }
    seenSlots.add(slotKey);
    capabilities.push(record);
  }

  return {
    capabilityRevision: CAPABILITY_REVISION,
    generatedAt: root.generatedAt,
    capabilities: Object.freeze(capabilities),
  };
}

/**
 * Built-in Phase 1 capability manifest reflecting the independently validated Stellar Testnet
 * outbound ITS and CCTP lanes. EVM origin routers and `axelar-gmp` / `allbridge` remain gated.
 */
export const STELLAR_TESTNET_PHASE1_CAPABILITIES: RouteCapabilityManifest =
  parseRouteCapabilityManifest({
    capabilityRevision: CAPABILITY_REVISION,
    generatedAt: "2026-10-29T10:17:56.262Z",
    capabilities: [
      {
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        route: RouteKind.AxelarIts,
        assetSymbol: "USDC",
        activated: true,
        paidDispatch: {
          supported: true,
          feeMechanism: "adapter_gas_float",
        },
        recipientSupport: {
          evmAddress: true,
          stellarKinds: [],
        },
        validationEvidence: "evidence/2026-10-28-paid-its.json",
      },
      {
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        route: RouteKind.Cctp,
        assetSymbol: "USDC",
        activated: true,
        paidDispatch: {
          supported: false,
          feeMechanism: "none",
        },
        recipientSupport: {
          evmAddress: true,
          stellarKinds: [],
        },
        validationEvidence: "evidence/2026-10-29-cctp.json",
      },
      {
        originChain: "stellar-testnet",
        destinationChain: "base-sepolia",
        route: RouteKind.Cctp,
        assetSymbol: "USDC",
        activated: true,
        paidDispatch: {
          supported: false,
          feeMechanism: "none",
        },
        recipientSupport: {
          evmAddress: true,
          stellarKinds: [],
        },
        validationEvidence: "evidence/2026-10-29-cctp.json",
      },
      {
        originChain: "stellar-testnet",
        destinationChain: "arc-testnet",
        route: RouteKind.Cctp,
        assetSymbol: "USDC",
        activated: true,
        paidDispatch: {
          supported: false,
          feeMechanism: "none",
        },
        recipientSupport: {
          evmAddress: true,
          stellarKinds: [],
        },
        validationEvidence: "evidence/2026-10-29-cctp.json",
      },
    ],
  });

/**
 * Resolve the effective capability record for a lane query against a validated manifest.
 *
 * Routes present in `CHAINS` / `ASSETS` / `RAIL_CONTRACTS` without an explicit capability entry
 * resolve to `activated: false` (`activationStatus: "registry_only_not_activated"`), ensuring
 * registry presence alone never activates a route.
 */
export function resolveRouteCapability(
  query: RouteCapabilityQuery,
  manifest: RouteCapabilityManifest = STELLAR_TESTNET_PHASE1_CAPABILITIES,
): RouteCapabilityRecord {
  const matched = manifest.capabilities.find(
    (entry) =>
      entry.originChain === query.originChain &&
      entry.destinationChain === query.destinationChain &&
      entry.route === query.route &&
      entry.assetSymbol === query.assetSymbol,
  );
  if (matched !== undefined) {
    return matched;
  }
  const status: Exclude<RouteActivationStatus, "validated_active"> = hasRegistryEntriesForRoute(
    query,
  )
    ? "registry_only_not_activated"
    : "gated_unvalidated";
  return conservativeClosedRecord(query, status, manifest.capabilityRevision);
}

/**
 * Resolve a route capability from raw untrusted manifest JSON, failing closed (`activated: false`)
 * when `capabilityRevision` is unknown or the payload is malformed.
 */
export function resolveRouteCapabilityConservative(
  rawManifest: unknown,
  query: RouteCapabilityQuery,
): {
  readonly record: RouteCapabilityRecord;
  readonly diagnostic: string | null;
} {
  try {
    const parsed = parseRouteCapabilityManifest(rawManifest);
    return {
      record: resolveRouteCapability(query, parsed),
      diagnostic: null,
    };
  } catch (error) {
    const rawRev =
      typeof rawManifest === "object" &&
      rawManifest !== null &&
      !Array.isArray(rawManifest) &&
      typeof (rawManifest as Record<string, unknown>).capabilityRevision === "number"
        ? ((rawManifest as Record<string, unknown>).capabilityRevision as number)
        : -1;
    return {
      record: conservativeClosedRecord(query, "unsupported_revision", rawRev),
      diagnostic: error instanceof Error ? error.message : "invalid capability manifest",
    };
  }
}

/** Check whether a resolved capability record permits dispatching to a specific recipient kind. */
export function isRecipientSupportedByCapability(
  capability: RouteCapabilityRecord,
  recipient:
    { readonly family: "evm" } | { readonly family: "stellar"; readonly kind: AddressKind },
): boolean {
  if (!capability.activated) return false;
  if (recipient.family === "evm") {
    return capability.recipientSupport.evmAddress;
  }
  return capability.recipientSupport.stellarKinds.includes(recipient.kind);
}
