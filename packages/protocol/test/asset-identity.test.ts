import { describe, expect, it } from "vitest";
import {
  AssetIdentityAmbiguityError,
  ROUTE_ASSET_IDENTITIES,
  RouteKind,
  assetOn,
  listMatchingAssetIdentities,
  resolveAssetIdentity,
  resolveRouteAssetPair,
} from "../src/index.js";
import type { AssetIdentity } from "../src/index.js";
import { G_ADDR, USDC_MAINNET_ISSUER } from "./fixtures.js";

describe("route-specific asset identity resolution", () => {
  it("keeps native Circle USDC and Axelar ITS representation as distinct identities", () => {
    const sepoliaMatches = listMatchingAssetIdentities({
      chain: "sepolia",
      symbol: "USDC",
    });
    expect(sepoliaMatches.length).toBe(2);

    const cctpPair = resolveRouteAssetPair({
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      route: RouteKind.Cctp,
      symbol: "USDC",
    });
    const itsPair = resolveRouteAssetPair({
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      route: RouteKind.AxelarIts,
      symbol: "USDC",
    });

    expect(cctpPair).not.toBeNull();
    expect(itsPair).not.toBeNull();
    if (cctpPair !== null && itsPair !== null) {
      expect(cctpPair.destination.representation).toBe("native_erc20");
      expect(cctpPair.destination.decimals).toBe(6);
      expect(itsPair.destination.representation).toBe("axelar_its");
      expect(itsPair.destination.decimals).toBe(7);
      expect(cctpPair.destination.identityKey).not.toBe(itsPair.destination.identityKey);
    }
  });

  it("refuses to silently resolve duplicate symbols to the first entry", () => {
    // Default catalog on Sepolia has both native_erc20 and axelar_its USDC.
    expect(() =>
      resolveAssetIdentity({
        chain: "sepolia",
        symbol: "USDC",
      }),
    ).toThrow(AssetIdentityAmbiguityError);

    // Custom catalog with two Stellar USDC issuers on the same chain must also throw unless issuer
    // is provided.
    const multiIssuerCatalog: readonly AssetIdentity[] = [
      ...ROUTE_ASSET_IDENTITIES,
      {
        family: "stellar",
        identityKey: `stellar:classic_sac:${G_ADDR}:USDC`,
        chain: "stellar",
        symbol: "USDC",
        name: "Alt Issuer USD Coin",
        code: "USDC",
        issuer: G_ADDR,
        sacId: null,
        representation: "classic_sac",
        decimals: 7,
        routes: [RouteKind.AxelarIts],
        source: "test fixture",
        confirmed: false,
      },
    ];

    expect(() =>
      resolveAssetIdentity(
        {
          chain: "stellar",
          symbol: "USDC",
        },
        multiIssuerCatalog,
      ),
    ).toThrow(AssetIdentityAmbiguityError);

    // Disambiguating by issuer resolves deterministically without ambiguity.
    const canonicalStellar = resolveAssetIdentity(
      {
        chain: "stellar",
        code: "USDC",
        issuer: USDC_MAINNET_ISSUER,
      },
      multiIssuerCatalog,
    );
    expect(canonicalStellar?.identityKey).toBe(`stellar:classic_sac:${USDC_MAINNET_ISSUER}:USDC`);

    const altStellar = resolveAssetIdentity(
      {
        chain: "stellar",
        code: "USDC",
        issuer: G_ADDR,
      },
      multiIssuerCatalog,
    );
    expect(altStellar?.identityKey).toBe(`stellar:classic_sac:${G_ADDR}:USDC`);
  });

  it("preserves legacy assetOn behavior for backward compatibility while new APIs disambiguate by address", () => {
    const legacySepolia = assetOn("sepolia", "USDC");
    expect(legacySepolia).not.toBeNull();
    expect(legacySepolia?.decimals).toBe(6);

    const byAddress = resolveAssetIdentity({
      chain: "sepolia",
      symbol: "USDC",
      address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    });
    expect(byAddress?.representation).toBe("native_erc20");
    expect(byAddress?.decimals).toBe(6);
  });
});
