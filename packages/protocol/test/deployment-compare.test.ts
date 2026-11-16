import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_SCHEMA_VERSION,
  DeploymentFormatError,
  compareDeploymentManifests,
  compareDeploymentSets,
  parseDeploymentSet,
} from "../src/index.js";
import { C_ADDR, G_ADDR, USDC_MAINNET_ISSUER } from "./fixtures.js";

const STELLAR_ROUTER = "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V";
const STELLAR_ITS = "CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ";
const STELLAR_CCTP = "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT";
const STELLAR_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function makeStellarTestnet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    family: "stellar",
    networkPassphrase: "Test SDF Network ; September 2015",
    router: STELLAR_ROUTER,
    adapters: {
      "axelar-its": STELLAR_ITS,
      cctp: STELLAR_CCTP,
    },
    tokens: {
      USDC: {
        sacId: STELLAR_SAC,
        code: "USDC",
        issuer: USDC_MAINNET_ISSUER,
        decimals: 7,
        flowLimit: "340282366920938463463374607431768211455",
        routes: ["axelar-its", "cctp"],
      },
    },
    treasury: G_ADDR,
    admin: G_ADDR,
    guardian: G_ADDR,
    feeBps: 30,
    flowWindow: 720,
    timelockDelay: 3600,
    wasmHashes: {
      router: "281d946ea78b194c0ef44ad9488ed02b2aa6912fb4f6fbab523ad38f1e0803f1",
      "adapter-axelar": "5f32139554d29edc3501a39ae3d05761101234523dd48b4d9e2d81ebf001f2c3",
    },
    deployedAt: { ledger: 5_433_808, timestamp: "2026-10-28T13:04:40.000Z" },
    commit: "b91c6ca",
    ...overrides,
  };
}

function makeSepolia(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    family: "evm",
    chainId: 11155111,
    router: "0x1111111111111111111111111111111111111111",
    adapters: {
      cctp: "0x2222222222222222222222222222222222222222",
      "axelar-its": "0x3333333333333333333333333333333333333333",
    },
    tokens: {
      USDC: {
        address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        decimals: 6,
        flowLimit: "1000000000000",
        routes: ["cctp", "axelar-its"],
      },
    },
    treasury: "0x4444444444444444444444444444444444444444",
    admin: "0x5555555555555555555555555555555555555555",
    guardian: "0x6666666666666666666666666666666666666666",
    feeBps: 30,
    flowWindow: 3600,
    timelockDelay: 86_400,
    deployedAt: {
      blockNumber: "9007199254740993",
      timestamp: "2026-10-28T12:00:00.000Z",
      txHash: `0x${"ab".repeat(32)}`,
    },
    commit: "b91c6ca",
    ...overrides,
  };
}

function makeManifest(
  networks: Record<string, unknown>,
  generatedAt = "2026-10-29T10:17:56.262Z",
): Record<string, unknown> {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    generatedAt,
    networks,
  };
}

describe("canonical deployment-manifest comparison helpers", () => {
  it("distinguishes metadata-only updates from activation and trust changes", () => {
    const before = parseDeploymentSet(makeManifest({ "stellar-testnet": makeStellarTestnet() }));
    const afterMetadata = parseDeploymentSet(
      makeManifest(
        {
          "stellar-testnet": makeStellarTestnet({
            commit: "f00ba77",
            deployedAt: { ledger: 5_433_900, timestamp: "2026-10-29T11:00:00.000Z" },
          }),
        },
        "2026-10-30T00:00:00.000Z",
      ),
    );

    const metaReport = compareDeploymentSets(before, afterMetadata);
    expect(metaReport.identical).toBe(false);
    expect(metaReport.metadataOnly).toBe(true);
    expect(metaReport.hasTrustChanges).toBe(false);
    expect(metaReport.hasActivationChanges).toBe(false);
    expect(metaReport.highestImpact).toBe("metadata");
    expect(metaReport.laneDiffs).toEqual([]);

    const afterTrust = parseDeploymentSet(
      makeManifest({
        "stellar-testnet": makeStellarTestnet({
          router: C_ADDR,
          feeBps: 25,
          wasmHashes: {
            router: "ff".repeat(32),
            "adapter-axelar": "5f32139554d29edc3501a39ae3d05761101234523dd48b4d9e2d81ebf001f2c3",
          },
        }),
      }),
    );

    const trustReport = compareDeploymentSets(before, afterTrust);
    expect(trustReport.metadataOnly).toBe(false);
    expect(trustReport.hasTrustChanges).toBe(true);
    expect(trustReport.hasActivationChanges).toBe(true);
    expect(trustReport.highestImpact).toBe("trust");
    expect(trustReport.trustChanges.map((c) => c.path)).toEqual([
      "$.networks.stellar-testnet.router",
      "$.networks.stellar-testnet.wasmHashes.router",
    ]);
    expect(trustReport.activationChanges.map((c) => c.path)).toEqual([
      "$.networks.stellar-testnet.feeBps",
    ]);
  });

  it("produces byte-identical reproducible diffs regardless of network, token, or route ordering", () => {
    const baseA = parseDeploymentSet(
      makeManifest({
        "stellar-testnet": makeStellarTestnet({
          tokens: {
            USDC: {
              sacId: STELLAR_SAC,
              code: "USDC",
              issuer: USDC_MAINNET_ISSUER,
              decimals: 7,
              flowLimit: "1000",
              routes: ["axelar-its", "cctp"],
            },
          },
        }),
        sepolia: makeSepolia(),
      }),
    );

    // Reorder networks, adapters, wasmHashes, EVM address casing, and route arrays.
    const baseB = parseDeploymentSet(
      makeManifest({
        sepolia: makeSepolia({
          router: "0x1111111111111111111111111111111111111111",
          tokens: {
            USDC: {
              address: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
              decimals: 6,
              flowLimit: "1000000000000",
              routes: ["axelar-its", "cctp"],
            },
          },
        }),
        "stellar-testnet": makeStellarTestnet({
          adapters: {
            cctp: STELLAR_CCTP,
            "axelar-its": STELLAR_ITS,
          },
          tokens: {
            USDC: {
              sacId: STELLAR_SAC,
              code: "USDC",
              issuer: USDC_MAINNET_ISSUER,
              decimals: 7,
              flowLimit: "1000",
              routes: ["cctp", "axelar-its"],
            },
          },
        }),
      }),
    );

    const identicalCheck = compareDeploymentSets(baseA, baseB);
    expect(identicalCheck.identical).toBe(true);
    expect(identicalCheck.changes).toEqual([]);
    expect(identicalCheck.laneDiffs).toEqual([]);

    const target = parseDeploymentSet(
      makeManifest({
        sepolia: makeSepolia({ feeBps: 20 }),
        "stellar-testnet": makeStellarTestnet({ feeBps: 15 }),
      }),
    );
    expect(compareDeploymentSets(baseA, target)).toEqual(compareDeploymentSets(baseB, target));
  });

  it("represents renamed, deleted, and added token-route lanes explicitly and rejects malformed manifests", () => {
    const beforeRaw = makeManifest({
      sepolia: makeSepolia(),
      "stellar-testnet": makeStellarTestnet(),
    });

    // Rename USDC -> USDC_CIRCLE on Sepolia (same ERC-20 address, drop axelar-its, keep cctp),
    // and remove stellar-testnet's cctp route while adding EURC.
    const afterRaw = makeManifest({
      sepolia: makeSepolia({
        tokens: {
          USDC_CIRCLE: {
            address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            decimals: 6,
            flowLimit: "1000000000000",
            routes: ["cctp"],
          },
        },
      }),
      "stellar-testnet": makeStellarTestnet({
        tokens: {
          USDC: {
            sacId: STELLAR_SAC,
            code: "USDC",
            issuer: USDC_MAINNET_ISSUER,
            decimals: 7,
            flowLimit: "340282366920938463463374607431768211455",
            routes: ["axelar-its"],
          },
          EURC: {
            sacId: C_ADDR,
            code: "EURC",
            issuer: G_ADDR,
            decimals: 7,
            flowLimit: "500000000",
            routes: ["cctp"],
          },
        },
      }),
    });

    const diff = compareDeploymentManifests(beforeRaw, afterRaw);
    const renamed = diff.laneDiffs.filter((l) => l.status === "renamed");
    const deleted = diff.laneDiffs.filter((l) => l.status === "deleted");
    const added = diff.laneDiffs.filter((l) => l.status === "added");

    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({
      chain: "sepolia",
      routeSlug: "cctp",
      previousSymbol: "USDC",
      currentSymbol: "USDC_CIRCLE",
    });

    expect(deleted.map((d) => `${d.chain}:${String(d.previousSymbol)}:${d.routeSlug}`)).toEqual([
      "sepolia:USDC:axelar-its",
      "stellar-testnet:USDC:cctp",
    ]);

    expect(added.map((a) => `${a.chain}:${String(a.currentSymbol)}:${a.routeSlug}`)).toEqual([
      "stellar-testnet:EURC:cctp",
    ]);

    expect(() => compareDeploymentManifests(beforeRaw, { schemaVersion: 99 })).toThrow(
      DeploymentFormatError,
    );
  });
});
