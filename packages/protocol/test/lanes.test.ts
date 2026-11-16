import { describe, expect, it } from "vitest";
import {
  LaneValidationError,
  RouteKind,
  createExecutableLaneRecord,
  formatLaneKey,
  parseLaneKey,
  tryParseLaneKey,
} from "../src/index.js";
import { C_ADDR, G_ADDR, USDC_MAINNET_ISSUER } from "./fixtures.js";

const STELLAR_TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const STELLAR_TESTNET_USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SEPOLIA_NATIVE_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const SEPOLIA_ITS_USDC = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

describe("canonical route identifier and lane key API", () => {
  it("produces distinct canonical keys for different USDC representations and Stellar issuers", () => {
    const cctpNativeLane = createExecutableLaneRecord({
      route: RouteKind.Cctp,
      source: {
        family: "stellar",
        chain: "stellar-testnet",
        representation: "classic_sac",
        code: "USDC",
        issuer: STELLAR_TESTNET_USDC_ISSUER,
        sacId: STELLAR_TESTNET_USDC_SAC,
        decimals: 7,
      },
      destination: {
        family: "evm",
        chain: "sepolia",
        representation: "native_erc20",
        symbol: "USDC",
        address: SEPOLIA_NATIVE_USDC,
        decimals: 6,
      },
    });

    const itsRepresentationLane = createExecutableLaneRecord({
      route: RouteKind.AxelarIts,
      source: {
        family: "stellar",
        chain: "stellar-testnet",
        representation: "classic_sac",
        code: "USDC",
        issuer: STELLAR_TESTNET_USDC_ISSUER,
        sacId: STELLAR_TESTNET_USDC_SAC,
        decimals: 7,
      },
      destination: {
        family: "evm",
        chain: "sepolia",
        representation: "axelar_its",
        symbol: "USDC",
        address: SEPOLIA_ITS_USDC,
        decimals: 7,
      },
    });

    const altIssuerLane = createExecutableLaneRecord({
      route: RouteKind.AxelarIts,
      source: {
        family: "stellar",
        chain: "stellar-testnet",
        representation: "classic_sac",
        code: "USDC",
        issuer: G_ADDR,
        sacId: C_ADDR,
        decimals: 7,
      },
      destination: {
        family: "evm",
        chain: "sepolia",
        representation: "axelar_its",
        symbol: "USDC",
        address: SEPOLIA_ITS_USDC,
        decimals: 7,
      },
    });

    const uniqueKeys = new Set([cctpNativeLane.key, itsRepresentationLane.key, altIssuerLane.key]);
    expect(uniqueKeys.size).toBe(3);
  });

  it("survives deterministic lossless serialization, address-case normalization, and parsing", () => {
    const upperRecord = createExecutableLaneRecord({
      route: RouteKind.Cctp,
      source: {
        family: "stellar",
        chain: "stellar",
        representation: "classic_sac",
        code: "USDC",
        issuer: USDC_MAINNET_ISSUER,
        sacId: null,
        decimals: 7,
      },
      destination: {
        family: "evm",
        chain: "base",
        representation: "native_erc20",
        symbol: "USDC",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
      },
    });

    const lowerKey = formatLaneKey({
      route: RouteKind.Cctp,
      source: {
        family: "stellar",
        chain: "stellar",
        representation: "classic_sac",
        code: "USDC",
        issuer: USDC_MAINNET_ISSUER,
        sacId: null,
        decimals: 7,
      },
      destination: {
        family: "evm",
        chain: "base",
        representation: "native_erc20",
        symbol: "USDC",
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        decimals: 6,
      },
    });

    expect(upperRecord.key).toBe(lowerKey);

    const parsed = parseLaneKey(upperRecord.key);
    expect(parsed).toEqual(upperRecord);
    expect(formatLaneKey(parsed)).toBe(upperRecord.key);

    const safeParsed = tryParseLaneKey(upperRecord.key);
    expect(safeParsed.ok).toBe(true);
  });

  it("refuses invalid chain/provider combinations and malformed lane keys", () => {
    // 1. Arc mainnet has axelarName: null, so Axelar ITS cannot form an executable lane.
    expect(() =>
      createExecutableLaneRecord({
        route: RouteKind.AxelarIts,
        source: {
          family: "stellar",
          chain: "stellar",
          representation: "classic_sac",
          code: "USDC",
          issuer: USDC_MAINNET_ISSUER,
          sacId: null,
          decimals: 7,
        },
        destination: {
          family: "evm",
          chain: "arc",
          representation: "native_erc20",
          symbol: "USDC",
          address: "0x3600000000000000000000000000000000000000",
          decimals: 6,
        },
      }),
    ).toThrow(LaneValidationError);

    // 2. Local Anvil has cctpDomain: null, so CCTP cannot form an executable lane.
    expect(() =>
      createExecutableLaneRecord({
        route: RouteKind.Cctp,
        source: {
          family: "stellar",
          chain: "stellar-testnet",
          representation: "classic_sac",
          code: "USDC",
          issuer: STELLAR_TESTNET_USDC_ISSUER,
          sacId: null,
          decimals: 7,
        },
        destination: {
          family: "evm",
          chain: "local",
          representation: "native_erc20",
          symbol: "USDC",
          address: SEPOLIA_NATIVE_USDC,
          decimals: 6,
        },
      }),
    ).toThrow(LaneValidationError);

    // 3. Mixed testnet -> mainnet hop is rejected.
    expect(() =>
      createExecutableLaneRecord({
        route: RouteKind.Cctp,
        source: {
          family: "stellar",
          chain: "stellar-testnet",
          representation: "classic_sac",
          code: "USDC",
          issuer: STELLAR_TESTNET_USDC_ISSUER,
          sacId: null,
          decimals: 7,
        },
        destination: {
          family: "evm",
          chain: "ethereum",
          representation: "native_erc20",
          symbol: "USDC",
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          decimals: 6,
        },
      }),
    ).toThrow(LaneValidationError);

    // 4. Wrapped pool representation on CCTP is rejected.
    expect(() =>
      createExecutableLaneRecord({
        route: RouteKind.Cctp,
        source: {
          family: "stellar",
          chain: "stellar-testnet",
          representation: "wrapped_pool",
          code: "USDC",
          issuer: STELLAR_TESTNET_USDC_ISSUER,
          sacId: null,
          decimals: 7,
        },
        destination: {
          family: "evm",
          chain: "sepolia",
          representation: "native_erc20",
          symbol: "USDC",
          address: SEPOLIA_NATIVE_USDC,
          decimals: 6,
        },
      }),
    ).toThrow(LaneValidationError);

    // 5. Malformed serialized key fails cleanly via tryParseLaneKey.
    const bad = tryParseLaneKey("hyperion-lane:v2|testnet|cctp|bad|bad");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.field).toBe("$.version");
    }
  });
});
