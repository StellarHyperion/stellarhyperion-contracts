/**
 * Canonical route identifiers and collision-free lane keys.
 *
 * Symbol-only or `(chain, routeTag)` lookups collide whenever two representations of the same
 * ticker coexist on a chain (for example, Circle native 6-decimal USDC alongside a 7-decimal Axelar
 * ITS representation on Sepolia, or two classic Stellar assets sharing the code `USDC` under
 * different issuers). Encoding network mode, provider rail, and full source/destination asset
 * identities into a deterministic `v1` lane key eliminates collisions and prevents unsupported
 * chain/provider pairs from forming executable lane records.
 */
import { AddressKind, tryParseStellarAddress } from "./addresses.js";
import type { Hex } from "./bytes.js";
import { bytesToBigInt, fromHex } from "./bytes.js";
import { MAX_DECIMALS } from "./amounts.js";
import type { ChainKey, NetworkMode } from "./chains.js";
import { CHAINS, isChainKey } from "./chains.js";
import type { RouteKind, RouteSlug } from "./routes.js";
import { ROUTE_KINDS, ROUTE_SLUGS, tryRouteFromSlug } from "./routes.js";

/** Serialization format prefix for canonical v1 lane keys. */
export const LANE_KEY_PREFIX = "hyperion-lane:v1";

/** How an asset is represented on a specific chain and rail. */
export type LaneAssetRepresentation =
  "classic_sac" | "native_erc20" | "axelar_its" | "wrapped_pool";

export const LANE_ASSET_REPRESENTATIONS: readonly LaneAssetRepresentation[] = Object.freeze([
  "classic_sac",
  "native_erc20",
  "axelar_its",
  "wrapped_pool",
]);

/** Stellar endpoint asset identity (classic code + G-address issuer + optional SAC id). */
export interface StellarLaneAsset {
  readonly family: "stellar";
  readonly chain: ChainKey;
  readonly representation: LaneAssetRepresentation;
  readonly code: string;
  readonly issuer: string;
  readonly sacId: string | null;
  readonly decimals: number;
}

/** EVM endpoint asset identity (symbol + normalized lowercase 20-byte contract address). */
export interface EvmLaneAsset {
  readonly family: "evm";
  readonly chain: ChainKey;
  readonly representation: LaneAssetRepresentation;
  readonly symbol: string;
  readonly address: Hex;
  readonly decimals: number;
}

export type LaneAssetEndpoint = StellarLaneAsset | EvmLaneAsset;

/** Branded string type representing a canonical serialized `hyperion-lane:v1|...` key. */
export type CanonicalLaneKey = `${typeof LANE_KEY_PREFIX}|${string}`;

/** Validated executable cross-chain lane record. */
export interface ExecutableLaneRecord {
  readonly key: CanonicalLaneKey;
  readonly network: NetworkMode;
  readonly route: RouteKind;
  readonly routeSlug: RouteSlug;
  readonly source: LaneAssetEndpoint;
  readonly destination: LaneAssetEndpoint;
}

/** Input descriptor passed to `createExecutableLaneRecord`. */
export interface CreateExecutableLaneInput {
  readonly network?: NetworkMode;
  readonly route: RouteKind;
  readonly source: LaneAssetEndpoint;
  readonly destination: LaneAssetEndpoint;
}

/** Raised when a lane descriptor or serialized lane key violates chain, asset, or provider invariants. */
export class LaneValidationError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`invalid lane at ${field}: ${reason}`);
    this.name = "LaneValidationError";
  }
}

function failLane(field: string, reason: string): never {
  throw new LaneValidationError(field, reason);
}

const VALID_REPRESENTATIONS: ReadonlySet<string> = new Set(LANE_ASSET_REPRESENTATIONS);
const ASSET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;
const STELLAR_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;
const ALLBRIDGE_UNSUPPORTED_CHAINS: ReadonlySet<ChainKey> = new Set([
  "arc",
  "arc-testnet",
  "local",
]);

function validateDecimals(decimals: number, field: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    failLane(field, `decimals must be an integer in 0..${String(MAX_DECIMALS)}`);
  }
}

function normalizeEndpoint(endpoint: LaneAssetEndpoint, field: string): LaneAssetEndpoint {
  if (!isChainKey(endpoint.chain)) {
    failLane(`${field}.chain`, `unknown chain "${String(endpoint.chain)}"`);
  }
  const chainMeta = CHAINS[endpoint.chain];
  if (!VALID_REPRESENTATIONS.has(endpoint.representation)) {
    failLane(
      `${field}.representation`,
      `unknown asset representation "${endpoint.representation}"`,
    );
  }
  validateDecimals(endpoint.decimals, `${field}.decimals`);

  if (endpoint.family === "stellar") {
    if (chainMeta.family !== "stellar") {
      failLane(
        `${field}.chain`,
        `Stellar asset endpoint cannot sit on EVM chain "${endpoint.chain}"`,
      );
    }
    if (endpoint.representation === "native_erc20") {
      failLane(
        `${field}.representation`,
        `Stellar asset cannot use EVM representation "native_erc20"`,
      );
    }
    if (!STELLAR_CODE_PATTERN.test(endpoint.code)) {
      failLane(`${field}.code`, "expected 1..12 ASCII alphanumeric asset code characters");
    }
    const parsedIssuer = tryParseStellarAddress(endpoint.issuer);
    if (!parsedIssuer.ok || parsedIssuer.parts.kind !== AddressKind.Account) {
      failLane(`${field}.issuer`, "expected a valid Stellar G-account issuer strkey");
    }
    if (endpoint.sacId !== null) {
      const parsedSac = tryParseStellarAddress(endpoint.sacId);
      if (!parsedSac.ok || parsedSac.parts.kind !== AddressKind.Contract) {
        failLane(`${field}.sacId`, "expected a valid Stellar C-contract strkey or null");
      }
    }
    return {
      family: "stellar",
      chain: endpoint.chain,
      representation: endpoint.representation,
      code: endpoint.code,
      issuer: endpoint.issuer,
      sacId: endpoint.sacId,
      decimals: endpoint.decimals,
    };
  }

  if (chainMeta.family !== "evm") {
    failLane(
      `${field}.chain`,
      `EVM asset endpoint cannot sit on Stellar chain "${endpoint.chain}"`,
    );
  }
  if (endpoint.representation === "classic_sac") {
    failLane(
      `${field}.representation`,
      `EVM asset cannot use Stellar representation "classic_sac"`,
    );
  }
  if (!ASSET_TOKEN_PATTERN.test(endpoint.symbol)) {
    failLane(`${field}.symbol`, "expected 1..24 ASCII symbol characters ([A-Za-z0-9_-])");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(endpoint.address)) {
    failLane(`${field}.address`, "expected a 20-byte 0x-prefixed EVM token address");
  }
  const normalizedAddr = endpoint.address.toLowerCase() as Hex;
  if (bytesToBigInt(fromHex(normalizedAddr)) === 0n) {
    failLane(`${field}.address`, "EVM token address cannot be the zero address");
  }

  return {
    family: "evm",
    chain: endpoint.chain,
    representation: endpoint.representation,
    symbol: endpoint.symbol,
    address: normalizedAddr,
    decimals: endpoint.decimals,
  };
}

function validateChainProviderCompatibility(
  route: RouteKind,
  source: LaneAssetEndpoint,
  destination: LaneAssetEndpoint,
): void {
  const srcChain = CHAINS[source.chain];
  const dstChain = CHAINS[destination.chain];

  if (source.chain === destination.chain) {
    failLane("destination.chain", `cross-chain lane cannot route "${source.chain}" to itself`);
  }
  if (srcChain.network !== dstChain.network) {
    failLane(
      "destination.chain",
      `cannot mix ${srcChain.network} chain "${source.chain}" with ${dstChain.network} chain "${destination.chain}"`,
    );
  }
  if (srcChain.family !== "stellar" && dstChain.family !== "stellar") {
    failLane(
      "route",
      `Hyperion lanes require a Stellar chain on at least one endpoint (got ${source.chain} -> ${destination.chain})`,
    );
  }

  if (route === 0) {
    // RouteKind.Cctp
    if (srcChain.cctpDomain === null) {
      failLane("source.chain", `Circle CCTP V2 has no domain configured on "${source.chain}"`);
    }
    if (dstChain.cctpDomain === null) {
      failLane(
        "destination.chain",
        `Circle CCTP V2 has no domain configured on "${destination.chain}"`,
      );
    }
    if (srcChain.cctpDomain === dstChain.cctpDomain) {
      failLane("destination.chain", "CCTP source and destination domains must differ");
    }
    if (
      source.representation === "axelar_its" ||
      source.representation === "wrapped_pool" ||
      destination.representation === "axelar_its" ||
      destination.representation === "wrapped_pool"
    ) {
      failLane(
        "route",
        "CCTP lanes only carry canonical Circle representations (classic_sac or native_erc20)",
      );
    }
    return;
  }

  if (route === 1 || route === 2) {
    // RouteKind.AxelarIts or RouteKind.AxelarGmp
    if (srcChain.axelarName === null) {
      failLane("source.chain", `Axelar has no chain identifier configured on "${source.chain}"`);
    }
    if (dstChain.axelarName === null) {
      failLane(
        "destination.chain",
        `Axelar has no chain identifier configured on "${destination.chain}"`,
      );
    }
    if (
      route === 1 &&
      (source.representation === "wrapped_pool" || destination.representation === "wrapped_pool")
    ) {
      failLane("route", "Axelar ITS lanes cannot use wrapped_pool asset representations");
    }
    return;
  }

  // RouteKind.Allbridge
  if (ALLBRIDGE_UNSUPPORTED_CHAINS.has(source.chain)) {
    failLane("source.chain", `Allbridge Core is not supported on "${source.chain}"`);
  }
  if (ALLBRIDGE_UNSUPPORTED_CHAINS.has(destination.chain)) {
    failLane("destination.chain", `Allbridge Core is not supported on "${destination.chain}"`);
  }
  if (source.representation === "axelar_its" || destination.representation === "axelar_its") {
    failLane("route", "Allbridge Core lanes cannot carry axelar_its representations");
  }
}

function serializeEndpoint(endpoint: LaneAssetEndpoint): string {
  if (endpoint.family === "stellar") {
    return [
      "stellar",
      endpoint.chain,
      endpoint.representation,
      endpoint.code,
      endpoint.issuer,
      endpoint.sacId ?? "-",
      String(endpoint.decimals),
    ].join(":");
  }
  return [
    "evm",
    endpoint.chain,
    endpoint.representation,
    endpoint.symbol,
    endpoint.address.toLowerCase(),
    String(endpoint.decimals),
  ].join(":");
}

function deserializeEndpoint(segment: string, field: string): LaneAssetEndpoint {
  const parts = segment.split(":");
  const family = parts[0];

  if (family === "stellar") {
    if (parts.length !== 7) {
      failLane(
        field,
        `expected 7 colon-separated Stellar endpoint fields, got ${String(parts.length)}`,
      );
    }
    const [, chainRaw = "", repRaw = "", code = "", issuer = "", sacRaw = "", decRaw = ""] = parts;
    if (!/^\d+$/.test(decRaw)) {
      failLane(`${field}.decimals`, "expected unsigned integer decimals");
    }
    return normalizeEndpoint(
      {
        family: "stellar",
        chain: chainRaw as ChainKey,
        representation: repRaw as LaneAssetRepresentation,
        code,
        issuer,
        sacId: sacRaw === "-" ? null : sacRaw,
        decimals: Number(decRaw),
      },
      field,
    );
  }

  if (family === "evm") {
    if (parts.length !== 6) {
      failLane(
        field,
        `expected 6 colon-separated EVM endpoint fields, got ${String(parts.length)}`,
      );
    }
    const [, chainRaw = "", repRaw = "", symbol = "", addressRaw = "", decRaw = ""] = parts;
    if (!/^\d+$/.test(decRaw)) {
      failLane(`${field}.decimals`, "expected unsigned integer decimals");
    }
    return normalizeEndpoint(
      {
        family: "evm",
        chain: chainRaw as ChainKey,
        representation: repRaw as LaneAssetRepresentation,
        symbol,
        address: addressRaw as Hex,
        decimals: Number(decRaw),
      },
      field,
    );
  }

  failLane(field, `expected endpoint family "stellar" or "evm", got "${String(family)}"`);
}

/** Validate and construct an executable lane record with its canonical `v1` key. */
export function createExecutableLaneRecord(input: CreateExecutableLaneInput): ExecutableLaneRecord {
  if (!ROUTE_KINDS.includes(input.route)) {
    failLane("route", `unknown RouteKind ${String(input.route)}`);
  }

  const source = normalizeEndpoint(input.source, "source");
  const destination = normalizeEndpoint(input.destination, "destination");
  validateChainProviderCompatibility(input.route, source, destination);

  const inferredNetwork = CHAINS[source.chain].network;
  if (input.network !== undefined && input.network !== inferredNetwork) {
    failLane(
      "network",
      `declared network "${input.network}" disagrees with endpoint network "${inferredNetwork}"`,
    );
  }

  const routeSlug = ROUTE_SLUGS[input.route];
  const key: CanonicalLaneKey = `${LANE_KEY_PREFIX}|${inferredNetwork}|${routeSlug}|${serializeEndpoint(source)}|${serializeEndpoint(destination)}`;

  return {
    key,
    network: inferredNetwork,
    route: input.route,
    routeSlug,
    source,
    destination,
  };
}

/** Deterministic string serializer for a validated `ExecutableLaneRecord` or input descriptor. */
export function formatLaneKey(
  lane: ExecutableLaneRecord | CreateExecutableLaneInput,
): CanonicalLaneKey {
  if ("key" in lane) {
    // Re-validate so forged or mutated objects cannot bypass canonical formatting.
    return createExecutableLaneRecord({
      network: lane.network,
      route: lane.route,
      source: lane.source,
      destination: lane.destination,
    }).key;
  }
  return createExecutableLaneRecord(lane).key;
}

/** Parse and validate a canonical `hyperion-lane:v1|...` string back into an `ExecutableLaneRecord`. */
export function parseLaneKey(value: string): ExecutableLaneRecord {
  const sections = value.split("|");
  if (sections.length !== 5) {
    failLane("$", `expected 5 pipe-delimited lane sections, got ${String(sections.length)}`);
  }
  const [prefix = "", networkRaw = "", routeSlugRaw = "", srcRaw = "", dstRaw = ""] = sections;
  if (prefix !== LANE_KEY_PREFIX) {
    failLane("$.version", `expected prefix "${LANE_KEY_PREFIX}", got "${prefix}"`);
  }
  if (networkRaw !== "mainnet" && networkRaw !== "testnet") {
    failLane("$.network", `expected network "mainnet" or "testnet", got "${networkRaw}"`);
  }
  const route = tryRouteFromSlug(routeSlugRaw);
  if (route === null) {
    failLane("$.route", `unknown route slug "${routeSlugRaw}"`);
  }

  const source = deserializeEndpoint(srcRaw, "$.source");
  const destination = deserializeEndpoint(dstRaw, "$.destination");

  return createExecutableLaneRecord({
    network: networkRaw,
    route,
    source,
    destination,
  });
}

/** Non-throwing companion to `parseLaneKey`. */
export function tryParseLaneKey(
  value: string,
): { ok: true; record: ExecutableLaneRecord } | { ok: false; error: LaneValidationError } {
  try {
    return { ok: true, record: parseLaneKey(value) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof LaneValidationError
          ? error
          : new LaneValidationError("$", error instanceof Error ? error.message : "invalid lane"),
    };
  }
}
