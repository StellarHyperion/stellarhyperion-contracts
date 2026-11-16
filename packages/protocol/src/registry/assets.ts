/**
 * The assets Hyperion carries, per chain.
 *
 * The same dollar has a different address, a different precision and a different way of being held
 * on every chain it exists on, and a bridge that treats those as interchangeable is a bridge that
 * eventually sends six decimals of something into a seven decimal slot. So each side is described
 * on its own terms and the two are tied together by a symbol rather than by an assumption.
 *
 * Provenance works the same way it does for the rail contracts: `confirmed` means a primary source
 * was read for that exact entry during this build. The deploy script reads `symbol()` and
 * `decimals()` on chain before registering anything regardless, because an address that is correct
 * today and a token that behaves as expected are two different claims.
 */
import type { ChainKey } from "../chains.js";
import type { Hex } from "../bytes.js";
import { RouteKind } from "../routes.js";

/** What every asset entry says about itself, whichever chain it lives on. */
interface AssetBase {
  readonly chain: ChainKey;
  /** The ticker, and the key that ties the two sides of a hop together. */
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Which rails can carry this asset out of this chain. */
  readonly routes: readonly RouteKind[];
  readonly source: string;
  readonly confirmed: boolean;
}

export interface EvmAsset extends AssetBase {
  readonly family: "evm";
  readonly address: Hex;
}

export interface StellarAsset extends AssetBase {
  readonly family: "stellar";
  /** The classic asset code, four or twelve characters. */
  readonly code: string;
  /** The issuing account. Half of what makes a Stellar asset unique; the code is the other half. */
  readonly issuer: string;
  /**
   * The Stellar Asset Contract id, which Soroban actually calls into.
   *
   * Null here on purpose. It is derived from the code, the issuer and the network passphrase, so
   * the deploy script computes it with `stellar contract id asset` and writes it into the
   * deployment record rather than anybody typing it.
   */
  readonly sacId: string | null;
  readonly decimals: 7;
}

export type Asset = EvmAsset | StellarAsset;

const STELLAR_DOCS = "developers.stellar.org, read during this build";
const ARC_DOCS = "docs.arc.io, read during this build";
const CIRCLE_PUBLISHED =
  "Circle's published USDC deployment for this chain. The deploy script reads symbol and decimals on chain before registering it.";

/** Everything Hyperion can move. USDC first, because USDC is why CCTP exists. */
export const ASSETS: readonly Asset[] = [
  {
    family: "stellar",
    chain: "stellar",
    symbol: "USDC",
    name: "USD Coin",
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sacId: null,
    decimals: 7,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts, RouteKind.Allbridge],
    source: STELLAR_DOCS,
    confirmed: true,
  },
  {
    family: "stellar",
    chain: "stellar-testnet",
    symbol: "USDC",
    name: "USD Coin",
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sacId: null,
    decimals: 7,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts],
    source: STELLAR_DOCS,
    confirmed: true,
  },
  {
    family: "evm",
    chain: "arc",
    symbol: "USDC",
    name: "USD Coin",
    // Arc's USDC lives at a fixed system address rather than a deployed contract, and it is also
    // the gas token. Six decimals on the ERC-20 even though the chain accounts for gas in
    // eighteen, which is the single most expensive detail on this chain to get wrong.
    address: "0x3600000000000000000000000000000000000000",
    decimals: 6,
    routes: [RouteKind.Cctp],
    source: ARC_DOCS,
    confirmed: true,
  },
  {
    family: "evm",
    chain: "arc-testnet",
    symbol: "USDC",
    name: "USD Coin",
    address: "0x3600000000000000000000000000000000000000",
    decimals: 6,
    routes: [RouteKind.Cctp],
    source: ARC_DOCS,
    confirmed: true,
  },
  {
    family: "evm",
    chain: "arc",
    symbol: "EURC",
    name: "Euro Coin",
    address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
    decimals: 6,
    routes: [RouteKind.AxelarIts],
    source: ARC_DOCS,
    confirmed: true,
  },
  {
    family: "evm",
    chain: "arc-testnet",
    symbol: "EURC",
    name: "Euro Coin",
    address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    decimals: 6,
    routes: [RouteKind.AxelarIts],
    source: ARC_DOCS,
    confirmed: true,
  },
  {
    family: "evm",
    chain: "ethereum",
    symbol: "USDC",
    name: "USD Coin",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts, RouteKind.Allbridge],
    source: CIRCLE_PUBLISHED,
    confirmed: false,
  },
  {
    family: "evm",
    chain: "sepolia",
    symbol: "USDC",
    name: "USD Coin",
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    decimals: 6,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts],
    source: CIRCLE_PUBLISHED,
    confirmed: false,
  },
  {
    family: "evm",
    chain: "base",
    symbol: "USDC",
    name: "USD Coin",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts, RouteKind.Allbridge],
    source: CIRCLE_PUBLISHED,
    confirmed: false,
  },
  {
    family: "evm",
    chain: "base-sepolia",
    symbol: "USDC",
    name: "USD Coin",
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts],
    source: CIRCLE_PUBLISHED,
    confirmed: false,
  },
];

export function assetsOn(chainKey: ChainKey): readonly Asset[] {
  return ASSETS.filter((asset) => asset.chain === chainKey);
}

/**
 * Legacy symbol-only lookup over the single-symbol `ASSETS` table.
 *
 * Ambiguity behavior: `assetOn` matches only `(chainKey, symbol)` using `Array.prototype.find` and
 * returns the first matching entry. It cannot distinguish native Circle ERC-20 USDC from an Axelar
 * ITS representation or distinguish two Stellar assets that share a ticker under different
 * issuers. New callers must use `resolveAssetIdentity` or `resolveRouteAssetPair`, which require
 * explicit representation, route, or issuer/address disambiguation whenever multiple identities
 * share a symbol on a chain.
 */
export function assetOn(chainKey: ChainKey, symbol: string): Asset | null {
  return ASSETS.find((asset) => asset.chain === chainKey && asset.symbol === symbol) ?? null;
}

export function isEvmAsset(asset: Asset): asset is EvmAsset {
  return asset.family === "evm";
}

export function isStellarAsset(asset: Asset): asset is StellarAsset {
  return asset.family === "stellar";
}

/**
 * Legacy symbol-only check for whether a ticker exists in `ASSETS` on both ends of a hop.
 * Shares `assetOn`'s symbol-only semantics; use `resolveRouteAssetPair` for representation-exact
 * resolution.
 */
export function pairExists(from: ChainKey, to: ChainKey, symbol: string): boolean {
  return assetOn(from, symbol) !== null && assetOn(to, symbol) !== null;
}

/**
 * Legacy symbol-only route intersection across `ASSETS`.
 * Shares `assetOn`'s symbol-only semantics; use `resolveRouteAssetPair` when resolving distinct
 * token representations per route.
 */
export function routesForPair(from: ChainKey, to: ChainKey, symbol: string): readonly RouteKind[] {
  const source = assetOn(from, symbol);
  const destination = assetOn(to, symbol);
  if (source === null || destination === null) return [];
  return source.routes.filter((route) => destination.routes.includes(route));
}

/** Canonical token representation class on a specific chain and bridge rail. */
export type AssetRepresentation = "classic_sac" | "native_erc20" | "axelar_its" | "wrapped_pool";

export const ASSET_REPRESENTATIONS: readonly AssetRepresentation[] = Object.freeze([
  "classic_sac",
  "native_erc20",
  "axelar_its",
  "wrapped_pool",
]);

interface AssetIdentityBase {
  /** Deterministic collision-free identity key (`<chain>:<representation>:<issuerOrAddress>:<symbol>`). */
  readonly identityKey: string;
  readonly chain: ChainKey;
  readonly symbol: string;
  readonly name: string;
  readonly representation: AssetRepresentation;
  readonly decimals: number;
  readonly routes: readonly RouteKind[];
  readonly source: string;
  readonly confirmed: boolean;
}

export interface EvmAssetIdentity extends AssetIdentityBase {
  readonly family: "evm";
  /**
   * Lowercase 20-byte ERC-20 contract address when statically published, or null when an ITS/pool
   * representation address must come from the validated deployment manifest.
   */
  readonly address: Hex | null;
}

export interface StellarAssetIdentity extends AssetIdentityBase {
  readonly family: "stellar";
  readonly code: string;
  readonly issuer: string;
  readonly sacId: string | null;
  readonly decimals: 7;
}

export type AssetIdentity = EvmAssetIdentity | StellarAssetIdentity;

/** Selector used to resolve a unique `AssetIdentity` without silent symbol-only fallback. */
export interface AssetIdentitySelector {
  readonly chain: ChainKey;
  readonly symbol?: string;
  readonly representation?: AssetRepresentation;
  readonly route?: RouteKind;
  /** EVM 20-byte contract address filter (case-insensitive). */
  readonly address?: Hex;
  /** Classic Stellar asset code filter. */
  readonly code?: string;
  /** Classic Stellar G-account issuer filter. */
  readonly issuer?: string;
  /** Soroban SAC contract ID filter. */
  readonly sacId?: string;
}

/** Raised when a selector matches multiple distinct `AssetIdentity` records on the same chain. */
export class AssetIdentityAmbiguityError extends Error {
  constructor(
    readonly selector: AssetIdentitySelector,
    readonly candidates: readonly string[],
  ) {
    super(
      `ambiguous asset lookup on chain "${selector.chain}": matched ${String(candidates.length)} identities (${candidates.join(", ")}); specify representation, route, or issuer/address`,
    );
    this.name = "AssetIdentityAmbiguityError";
  }
}

const AXELAR_ITS_REPRESENTATION_NOTE =
  "Axelar ITS token representation distinct from Circle native ERC-20; contract address and decimals must match the validated ITS deployment rather than assuming native Circle USDC.";

function buildCanonicalIdentityKey(
  entry:
    | {
        readonly family: "evm";
        readonly chain: ChainKey;
        readonly representation: AssetRepresentation;
        readonly symbol: string;
        readonly address: Hex | null;
      }
    | {
        readonly family: "stellar";
        readonly chain: ChainKey;
        readonly representation: AssetRepresentation;
        readonly code: string;
        readonly issuer: string;
      },
): string {
  if (entry.family === "stellar") {
    return `${entry.chain}:${entry.representation}:${entry.issuer}:${entry.code}`;
  }
  const addrToken = entry.address !== null ? entry.address.toLowerCase() : "deployment-bound";
  return `${entry.chain}:${entry.representation}:${addrToken}:${entry.symbol}`;
}

function deriveDefaultAssetIdentities(): readonly AssetIdentity[] {
  const out: AssetIdentity[] = [];

  for (const asset of ASSETS) {
    if (asset.family === "stellar") {
      out.push({
        family: "stellar",
        identityKey: buildCanonicalIdentityKey({
          family: "stellar",
          chain: asset.chain,
          representation: "classic_sac",
          code: asset.code,
          issuer: asset.issuer,
        }),
        chain: asset.chain,
        symbol: asset.symbol,
        name: asset.name,
        code: asset.code,
        issuer: asset.issuer,
        sacId: asset.sacId,
        representation: "classic_sac",
        decimals: 7,
        routes: asset.routes,
        source: asset.source,
        confirmed: asset.confirmed,
      });
      continue;
    }

    const nativeRoutes = asset.routes.filter(
      (r) => r === RouteKind.Cctp || r === RouteKind.Allbridge,
    );
    if (nativeRoutes.length > 0) {
      const normalizedAddress = asset.address.toLowerCase() as Hex;
      out.push({
        family: "evm",
        identityKey: buildCanonicalIdentityKey({
          family: "evm",
          chain: asset.chain,
          representation: "native_erc20",
          symbol: asset.symbol,
          address: normalizedAddress,
        }),
        chain: asset.chain,
        symbol: asset.symbol,
        name: asset.name,
        address: normalizedAddress,
        representation: "native_erc20",
        decimals: asset.decimals,
        routes: nativeRoutes,
        source: asset.source,
        confirmed: asset.confirmed,
      });
    }

    if (asset.routes.includes(RouteKind.AxelarIts)) {
      const isNativeOnlyIts = nativeRoutes.length === 0;
      const itsAddress = isNativeOnlyIts ? (asset.address.toLowerCase() as Hex) : null;
      const itsDecimals = isNativeOnlyIts ? asset.decimals : 7;
      out.push({
        family: "evm",
        identityKey: buildCanonicalIdentityKey({
          family: "evm",
          chain: asset.chain,
          representation: "axelar_its",
          symbol: asset.symbol,
          address: itsAddress,
        }),
        chain: asset.chain,
        symbol: asset.symbol,
        name: isNativeOnlyIts ? asset.name : `${asset.name} (Axelar ITS)`,
        address: itsAddress,
        representation: "axelar_its",
        decimals: itsDecimals,
        routes: [RouteKind.AxelarIts],
        source: isNativeOnlyIts ? asset.source : AXELAR_ITS_REPRESENTATION_NOTE,
        confirmed: isNativeOnlyIts ? asset.confirmed : false,
      });
    }
  }

  return Object.freeze(out);
}

/**
 * Route-specific asset identity catalog where Circle native USDC (`native_erc20`) and Axelar ITS
 * representations (`axelar_its`) remain separate records on EVM chains.
 */
export const ROUTE_ASSET_IDENTITIES: readonly AssetIdentity[] = deriveDefaultAssetIdentities();

function matchesIdentitySelector(entry: AssetIdentity, selector: AssetIdentitySelector): boolean {
  if (entry.chain !== selector.chain) return false;
  if (selector.symbol !== undefined && entry.symbol !== selector.symbol) return false;
  if (selector.representation !== undefined && entry.representation !== selector.representation) {
    return false;
  }
  if (selector.route !== undefined && !entry.routes.includes(selector.route)) {
    return false;
  }

  if (
    selector.address !== undefined ||
    selector.issuer !== undefined ||
    selector.code !== undefined ||
    selector.sacId !== undefined
  ) {
    if (entry.family === "evm") {
      if (
        selector.issuer !== undefined ||
        selector.code !== undefined ||
        selector.sacId !== undefined
      ) {
        return false;
      }
      if (selector.address !== undefined) {
        if (entry.address === null) return false;
        if (entry.address.toLowerCase() !== selector.address.toLowerCase()) return false;
      }
    } else {
      if (selector.address !== undefined) return false;
      if (selector.issuer !== undefined && entry.issuer !== selector.issuer) return false;
      if (selector.code !== undefined && entry.code !== selector.code) return false;
      if (selector.sacId !== undefined && entry.sacId !== selector.sacId) return false;
    }
  }

  return true;
}

/** List every matching `AssetIdentity` in `catalog` without collapsing duplicates. */
export function listMatchingAssetIdentities(
  selector: AssetIdentitySelector,
  catalog: readonly AssetIdentity[] = ROUTE_ASSET_IDENTITIES,
): readonly AssetIdentity[] {
  return catalog.filter((entry) => matchesIdentitySelector(entry, selector));
}

/**
 * Resolve a single `AssetIdentity` from `selector`.
 *
 * Returns `null` when nothing matches, and throws `AssetIdentityAmbiguityError` whenever two or
 * more distinct identities match (for example, querying `{ chain: "sepolia", symbol: "USDC" }`
 * without specifying `representation`, `route`, or `address`, or querying a duplicate symbol on a
 * custom catalog without `issuer` / `address`).
 */
export function resolveAssetIdentity(
  selector: AssetIdentitySelector,
  catalog: readonly AssetIdentity[] = ROUTE_ASSET_IDENTITIES,
): AssetIdentity | null {
  const matches = listMatchingAssetIdentities(selector, catalog);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new AssetIdentityAmbiguityError(
      selector,
      matches.map((m) => m.identityKey),
    );
  }
  return matches[0] ?? null;
}

export interface ResolveRouteAssetPairInput {
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly route: RouteKind;
  readonly symbol: string;
  readonly sourceDisambiguator?: Omit<AssetIdentitySelector, "chain" | "route">;
  readonly destinationDisambiguator?: Omit<AssetIdentitySelector, "chain" | "route">;
}

export interface ResolvedRouteAssetPair {
  readonly route: RouteKind;
  readonly source: AssetIdentity;
  readonly destination: AssetIdentity;
}

/**
 * Resolve the route-specific `(source, destination)` asset identity pair for a transfer leg.
 *
 * Automatically scopes each side by `(chain, symbol, route)` plus any caller-supplied issuer,
 * address, or representation disambiguator, throwing `AssetIdentityAmbiguityError` if either side
 * still matches multiple identities.
 */
export function resolveRouteAssetPair(
  input: ResolveRouteAssetPairInput,
  catalog: readonly AssetIdentity[] = ROUTE_ASSET_IDENTITIES,
): ResolvedRouteAssetPair | null {
  const source = resolveAssetIdentity(
    {
      chain: input.originChain,
      symbol: input.symbol,
      route: input.route,
      ...input.sourceDisambiguator,
    },
    catalog,
  );
  if (source === null) return null;

  const destination = resolveAssetIdentity(
    {
      chain: input.destinationChain,
      symbol: input.symbol,
      route: input.route,
      ...input.destinationDisambiguator,
    },
    catalog,
  );
  if (destination === null) return null;

  return {
    route: input.route,
    source,
    destination,
  };
}
