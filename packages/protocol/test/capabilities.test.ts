import { describe, expect, it } from "vitest";
import {
  AddressKind,
  CAPABILITY_REVISION,
  CapabilityFormatError,
  RouteKind,
  STELLAR_TESTNET_PHASE1_CAPABILITIES,
  hasRegistryEntriesForRoute,
  isRecipientSupportedByCapability,
  parseRouteCapabilityManifest,
  resolveRouteCapability,
  resolveRouteCapabilityConservative,
} from "../src/index.js";

describe("SDK route capability records separate from registry presence", () => {
  it("never marks a route activated solely from static registry presence", () => {
    // Mainnet Stellar -> Ethereum CCTP has entries in CHAINS, ASSETS, and RAIL_CONTRACTS, yet
    // must remain gated (activated=false) without a validated capability entry.
    const mainnetCctpQuery = {
      originChain: "stellar" as const,
      destinationChain: "ethereum" as const,
      route: RouteKind.Cctp,
      assetSymbol: "USDC",
    };
    expect(hasRegistryEntriesForRoute(mainnetCctpQuery)).toBe(true);
    const mainnetCapability = resolveRouteCapability(mainnetCctpQuery);
    expect(mainnetCapability.registryPresent).toBe(true);
    expect(mainnetCapability.activated).toBe(false);
    expect(mainnetCapability.activationStatus).toBe("registry_only_not_activated");
    expect(mainnetCapability.paidDispatch).toEqual({ supported: false, feeMechanism: "none" });
    expect(isRecipientSupportedByCapability(mainnetCapability, { family: "evm" })).toBe(false);

    // Inbound Sepolia -> Stellar Testnet is also present in registries, yet EVM origin routers
    // remain explicitly gated in Phase 1.
    const inboundQuery = {
      originChain: "sepolia" as const,
      destinationChain: "stellar-testnet" as const,
      route: RouteKind.Cctp,
      assetSymbol: "USDC",
    };
    expect(hasRegistryEntriesForRoute(inboundQuery)).toBe(true);
    const inboundCapability = resolveRouteCapability(inboundQuery);
    expect(inboundCapability.activated).toBe(false);
    expect(inboundCapability.activationStatus).toBe("registry_only_not_activated");
  });

  it("exposes explicit paid-dispatch and recipient-kind fields on validated Phase 1 capabilities", () => {
    const itsCapability = resolveRouteCapability(
      {
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        route: RouteKind.AxelarIts,
        assetSymbol: "USDC",
      },
      STELLAR_TESTNET_PHASE1_CAPABILITIES,
    );
    expect(itsCapability.activated).toBe(true);
    expect(itsCapability.activationStatus).toBe("validated_active");
    expect(itsCapability.paidDispatch).toEqual({
      supported: true,
      feeMechanism: "adapter_gas_float",
    });
    expect(itsCapability.recipientSupport).toEqual({
      evmAddress: true,
      stellarKinds: [],
    });
    expect(isRecipientSupportedByCapability(itsCapability, { family: "evm" })).toBe(true);
    expect(
      isRecipientSupportedByCapability(itsCapability, {
        family: "stellar",
        kind: AddressKind.Account,
      }),
    ).toBe(false);

    const cctpArc = resolveRouteCapability({
      originChain: "stellar-testnet",
      destinationChain: "arc-testnet",
      route: RouteKind.Cctp,
      assetSymbol: "USDC",
    });
    expect(cctpArc.activated).toBe(true);
    expect(cctpArc.paidDispatch).toEqual({ supported: false, feeMechanism: "none" });

    // Declaring MuxedAccount recipient support on Allbridge (which carries no payload) fails.
    expect(() =>
      parseRouteCapabilityManifest({
        capabilityRevision: CAPABILITY_REVISION,
        generatedAt: "2026-10-29T10:17:56.262Z",
        capabilities: [
          {
            originChain: "ethereum",
            destinationChain: "stellar",
            route: RouteKind.Allbridge,
            assetSymbol: "USDC",
            activated: false,
            paidDispatch: { supported: false, feeMechanism: "none" },
            recipientSupport: {
              evmAddress: false,
              stellarKinds: [AddressKind.Account, AddressKind.MuxedAccount],
            },
            validationEvidence: null,
          },
        ],
      }),
    ).toThrow(CapabilityFormatError);

    // Declaring activated=true without validationEvidence fails.
    expect(() =>
      parseRouteCapabilityManifest({
        capabilityRevision: CAPABILITY_REVISION,
        generatedAt: "2026-10-29T10:17:56.262Z",
        capabilities: [
          {
            originChain: "stellar-testnet",
            destinationChain: "sepolia",
            route: RouteKind.Cctp,
            assetSymbol: "USDC",
            activated: true,
            paidDispatch: { supported: false, feeMechanism: "none" },
            recipientSupport: { evmAddress: true, stellarKinds: [] },
            validationEvidence: null,
          },
        ],
      }),
    ).toThrow(CapabilityFormatError);
  });

  it("fails conservatively on unknown capability revisions", () => {
    const futureManifest = {
      capabilityRevision: 2,
      generatedAt: "2027-01-01T00:00:00.000Z",
      capabilities: [
        {
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          route: "cctp",
          assetSymbol: "USDC",
          activated: true,
          paidDispatch: { supported: false, feeMechanism: "none" },
          recipientSupport: { evmAddress: true, stellarKinds: [] },
          validationEvidence: "evidence/future.json",
        },
      ],
    };

    expect(() => parseRouteCapabilityManifest(futureManifest)).toThrow(CapabilityFormatError);

    const conservative = resolveRouteCapabilityConservative(futureManifest, {
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      route: RouteKind.Cctp,
      assetSymbol: "USDC",
    });
    expect(conservative.record.activated).toBe(false);
    expect(conservative.record.activationStatus).toBe("unsupported_revision");
    expect(conservative.record.capabilityRevision).toBe(2);
    expect(conservative.diagnostic).toContain("unsupported capabilityRevision 2");
  });
});
