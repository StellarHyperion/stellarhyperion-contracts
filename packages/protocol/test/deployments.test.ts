import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_SCHEMA_VERSION,
  DeploymentFormatError,
  RetiredDeploymentError,
  activeDeployedChains,
  adapterFor,
  assertActiveDeployment,
  deprecateDeploymentSet,
  deployedChains,
  deploymentFor,
  inspectRouterLifecycle,
  isActiveDeployment,
  isEvmDeployment,
  isRetiredDeployment,
  isStellarDeployment,
  parseDeploymentSet,
  tokenFor,
  warningForDeployment,
} from "../src/deployments.js";
import { RouteKind } from "../src/routes.js";
import { C_ADDR, G_ADDR } from "./fixtures.js";

const ROUTER_C = "CAGR5KFYMZYI7WWQ6TWYYZ346T7GNZLKER4DOJTAG3SOB46QLR5RAPSN";

function evmRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    family: "evm",
    chainId: 8453,
    router: "0x1111111111111111111111111111111111111111",
    adapters: { cctp: "0x2222222222222222222222222222222222222222" },
    tokens: {
      USDC: {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
        flowLimit: "1000000000000",
        routes: ["cctp", "axelar-its"],
      },
    },
    treasury: "0x3333333333333333333333333333333333333333",
    admin: "0x4444444444444444444444444444444444444444",
    guardian: "0x5555555555555555555555555555555555555555",
    feeBps: 30,
    flowWindow: 3600,
    timelockDelay: 172_800,
    deployedAt: {
      blockNumber: "21000000",
      timestamp: "2026-09-30T12:00:00.000Z",
      txHash: `0x${"ab".repeat(32)}`,
    },
    commit: "0123456789abcdef0123456789abcdef01234567",
    ...overrides,
  };
}

function stellarRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    family: "stellar",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    router: ROUTER_C,
    adapters: { cctp: ROUTER_C },
    tokens: {
      USDC: {
        sacId: ROUTER_C,
        code: "USDC",
        issuer: G_ADDR,
        decimals: 7,
        flowLimit: "10000000000000",
        routes: ["cctp"],
      },
    },
    treasury: G_ADDR,
    admin: G_ADDR,
    guardian: G_ADDR,
    feeBps: 30,
    flowWindow: 720,
    timelockDelay: 34_560,
    wasmHashes: { router: "a".repeat(64) },
    deployedAt: { ledger: 55_000_000, timestamp: "2026-09-30T12:00:00.000Z" },
    commit: "0123456789abcdef0123456789abcdef01234567",
    ...overrides,
  };
}

function set(networks: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    generatedAt: "2026-09-30T12:00:00.000Z",
    networks,
  };
}

describe("reading a record that holds together", () => {
  it("reads an EVM deployment", () => {
    const parsed = parseDeploymentSet(set({ base: evmRecord() }));
    const base = deploymentFor(parsed, "base");
    expect(base).not.toBeNull();
    if (base !== null && isEvmDeployment(base)) {
      expect(base.chainId).toBe(8453);
      expect(base.feeBps).toBe(30);
      expect(base.tokens.USDC?.routes).toEqual([RouteKind.Cctp, RouteKind.AxelarIts]);
    }
  });

  it("reads a Stellar deployment", () => {
    const parsed = parseDeploymentSet(set({ stellar: stellarRecord() }));
    const stellar = deploymentFor(parsed, "stellar");
    expect(stellar).not.toBeNull();
    if (stellar !== null && isStellarDeployment(stellar)) {
      expect(stellar.router).toBe(ROUTER_C);
      expect(stellar.wasmHashes.router).toBe("a".repeat(64));
      expect(stellar.deployedAt.ledger).toBe(55_000_000);
    }
  });

  it("holds both families in one set", () => {
    const parsed = parseDeploymentSet(set({ base: evmRecord(), stellar: stellarRecord() }));
    expect([...deployedChains(parsed)].sort()).toEqual(["base", "stellar"]);
  });

  it("finds an adapter by rail, and answers null where a rail is not wired up", () => {
    const parsed = parseDeploymentSet(set({ base: evmRecord() }));
    expect(adapterFor(parsed, "base", RouteKind.Cctp)).toBe(
      "0x2222222222222222222222222222222222222222",
    );
    expect(adapterFor(parsed, "base", RouteKind.Allbridge)).toBeNull();
    expect(adapterFor(parsed, "arc", RouteKind.Cctp)).toBeNull();
  });

  it("finds a token by symbol", () => {
    const parsed = parseDeploymentSet(set({ base: evmRecord() }));
    expect(tokenFor(parsed, "base", "USDC")?.decimals).toBe(6);
    expect(tokenFor(parsed, "base", "EURC")).toBeNull();
  });

  it("keeps a flow ceiling as a string, because a big one does not survive a double", () => {
    const parsed = parseDeploymentSet(
      set({
        base: evmRecord({
          tokens: {
            USDC: {
              address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              decimals: 6,
              flowLimit:
                "115792089237316195423570985008687907853269984665640564039457584007913129639935",
              routes: ["cctp"],
            },
          },
        }),
      }),
    );
    const token = tokenFor(parsed, "base", "USDC");
    expect(BigInt(token?.flowLimit ?? "0")).toBe((1n << 256n) - 1n);
  });
});

describe("refusing a record that does not", () => {
  it("names the field it choked on", () => {
    try {
      parseDeploymentSet(set({ base: evmRecord({ router: "0xnope" }) }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentFormatError);
      expect((error as DeploymentFormatError).path).toBe("$.networks.base.router");
    }
  });

  it("refuses an address with a transposed character rather than casting it", () => {
    // The whole reason this file validates instead of casting. A short address parses fine as a
    // string, passes a cast without complaint, and becomes a transfer to nobody.
    expect(() => parseDeploymentSet(set({ base: evmRecord({ treasury: "0x1234" }) }))).toThrow(
      DeploymentFormatError,
    );
  });

  it("refuses a Stellar router that is not a contract id", () => {
    // A G address where a C address belongs. Both are valid strkeys; only one can be invoked.
    expect(() => parseDeploymentSet(set({ stellar: stellarRecord({ router: G_ADDR }) }))).toThrow(
      /router/,
    );
  });

  it("accepts a contract id for the router and refuses nonsense", () => {
    expect(() =>
      parseDeploymentSet(set({ stellar: stellarRecord({ router: C_ADDR }) })),
    ).not.toThrow();
    expect(() =>
      parseDeploymentSet(set({ stellar: stellarRecord({ router: "CNOPE" }) })),
    ).toThrow();
  });

  it("refuses an unknown chain key", () => {
    expect(() => parseDeploymentSet(set({ solana: evmRecord() }))).toThrow(/unknown chain key/);
  });

  it("refuses an unknown rail slug", () => {
    expect(() =>
      parseDeploymentSet(
        set({ base: evmRecord({ adapters: { teleport: "0x" + "1".repeat(40) } }) }),
      ),
    ).toThrow(/unknown rail/);
  });

  it("lists the rails it does know when a token names one it does not", () => {
    // An error that says what is allowed saves a round trip through the source.
    expect(() =>
      parseDeploymentSet(
        set({
          base: evmRecord({
            tokens: {
              USDC: {
                address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                decimals: 6,
                flowLimit: "1",
                routes: ["wormhole"],
              },
            },
          }),
        }),
      ),
    ).toThrow(/cctp, axelar-its, axelar-gmp, allbridge/);
  });

  it("refuses a flow ceiling written as a number instead of a string", () => {
    expect(() =>
      parseDeploymentSet(
        set({
          base: evmRecord({
            tokens: {
              USDC: {
                address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                decimals: 6,
                flowLimit: 1_000_000,
                routes: ["cctp"],
              },
            },
          }),
        }),
      ),
    ).toThrow(/decimal integer written as a string/);
  });

  it("refuses a schema version it was not written for", () => {
    expect(() =>
      parseDeploymentSet({ ...set({}), schemaVersion: DEPLOYMENT_SCHEMA_VERSION + 1 }),
    ).toThrow(/schemaVersion/);
  });

  it("refuses a timestamp that is not a timestamp", () => {
    expect(() => parseDeploymentSet({ ...set({}), generatedAt: "last tuesday" })).toThrow(
      /ISO 8601/,
    );
  });

  it("refuses a family it does not know", () => {
    expect(() => parseDeploymentSet(set({ base: evmRecord({ family: "solana" }) }))).toThrow(
      /"evm" or "stellar"/,
    );
  });

  it("refuses a wasm hash that is not sixty four hex characters", () => {
    expect(() =>
      parseDeploymentSet(set({ stellar: stellarRecord({ wasmHashes: { router: "abc" } }) })),
    ).toThrow(/64 lowercase hex/);
  });

  it("refuses something that is not an object at all", () => {
    for (const bad of [null, 42, "a string", [], undefined]) {
      expect(() => parseDeploymentSet(bad)).toThrow(DeploymentFormatError);
    }
  });

  it("refuses a missing networks map rather than defaulting to empty", () => {
    expect(() =>
      parseDeploymentSet({
        schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
        generatedAt: "2026-09-30T12:00:00.000Z",
      }),
    ).toThrow(/networks/);
  });
});

describe("deployment manifest deprecation, successor links, and historical evidence", () => {
  const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
  const activeManifestRaw = JSON.parse(
    readFileSync(resolve(repoRoot, "deployments/stellar-testnet-phase1.json"), "utf8"),
  ) as Record<string, unknown>;
  const archivedManifestRaw = JSON.parse(
    readFileSync(resolve(repoRoot, "deployments/archive/stellar-testnet-2026-10-01.json"), "utf8"),
  ) as Record<string, unknown>;

  it("distinguishes active and archived repository records through parsed metadata", () => {
    const activeSet = parseDeploymentSet(activeManifestRaw);
    const archivedSet = parseDeploymentSet(archivedManifestRaw);

    const activeDep = deploymentFor(activeSet, "stellar-testnet")!;
    const archivedDep = deploymentFor(archivedSet, "stellar-testnet")!;

    expect(isActiveDeployment(activeDep)).toBe(true);
    expect(isRetiredDeployment(activeDep)).toBe(false);
    expect(activeDep.lifecycle).toEqual({ status: "active" });
    expect(activeDeployedChains(activeSet)).toEqual(["stellar-testnet"]);
    expect(() => {
      assertActiveDeployment(activeDep, "verify");
    }).not.toThrow();

    expect(isActiveDeployment(archivedDep)).toBe(false);
    expect(isRetiredDeployment(archivedDep)).toBe(true);
    expect(archivedDep.lifecycle.status).toBe("archived");
    expect(archivedDep.lifecycle.successor).toEqual({
      chain: "stellar-testnet",
      router: activeDep.router,
      manifest: "deployments/stellar-testnet-phase1.json",
    });
    expect(activeDeployedChains(archivedSet)).toEqual([]);
  });

  it("preserves all historical transaction evidence when deprecating a manifest", () => {
    const beforeSet = parseDeploymentSet(activeManifestRaw);
    const beforeDep = deploymentFor(beforeSet, "stellar-testnet")!;
    expect(beforeDep.historicalEvidence.txHashes).toHaveLength(8);
    expect(beforeDep.historicalEvidence.evidenceFiles).toEqual([
      "evidence/2026-10-28-paid-its.json",
      "evidence/2026-10-29-cctp.json",
    ]);

    const { raw, parsed } = deprecateDeploymentSet(activeManifestRaw, {
      chain: "stellar-testnet",
      status: "deprecated",
      deprecatedAt: "2026-11-15T00:00:00.000Z",
      reason: "Rotated router admin to multisig governance deployment.",
      successor: {
        chain: "stellar-testnet",
        router: C_ADDR,
        manifest: "deployments/stellar-testnet-phase2.json",
      },
    });

    const afterDep = deploymentFor(parsed, "stellar-testnet")!;
    expect(afterDep.lifecycle.status).toBe("deprecated");
    expect(afterDep.historicalEvidence.txHashes).toEqual(beforeDep.historicalEvidence.txHashes);
    expect(afterDep.historicalEvidence.evidenceFiles).toEqual(
      beforeDep.historicalEvidence.evidenceFiles,
    );
    expect(afterDep.historicalEvidence.queuedActionIds).toEqual([1, 2, 3, 4]);

    // Raw activation block and hashes remain intact in serialized output.
    const rawNet = (raw.networks as Record<string, Record<string, unknown>>)["stellar-testnet"]!;
    expect(rawNet.activation).toEqual(
      (activeManifestRaw.networks as Record<string, Record<string, unknown>>)["stellar-testnet"]!
        .activation,
    );
  });

  it("emits actionable retired-router warnings and blocks accidental operational execution", () => {
    const activeSet = parseDeploymentSet(activeManifestRaw);
    const archivedSet = parseDeploymentSet(archivedManifestRaw);
    const archivedDep = deploymentFor(archivedSet, "stellar-testnet")!;

    const warning = inspectRouterLifecycle(
      [activeSet, archivedSet],
      "stellar-testnet",
      archivedDep.router,
    );
    expect(warning).not.toBeNull();
    expect(warning?.retiredRouter).toBe("CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF");
    expect(warning?.successor?.router).toBe(
      "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V",
    );
    expect(warning?.message).toContain("deployments/stellar-testnet-phase1.json");
    expect(warningForDeployment(archivedDep)).toEqual(warning);

    expect(
      inspectRouterLifecycle(
        [activeSet, archivedSet],
        "stellar-testnet",
        "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V",
      ),
    ).toBeNull();

    expect(() => {
      assertActiveDeployment(archivedDep, "phase-two execute");
    }).toThrow(RetiredDeploymentError);
    expect(() => {
      assertActiveDeployment(archivedDep, "phase-two execute");
    }).toThrow(/Use successor router CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V/);
  });

  it("rejects self-referential or malformed successor links", () => {
    expect(() =>
      parseDeploymentSet(
        set({
          stellar: stellarRecord({
            lifecycle: {
              status: "deprecated",
              deprecatedAt: "2026-10-28T17:08:25.000Z",
              reason: "Retired",
              successor: {
                chain: "stellar",
                router: ROUTER_C,
              },
            },
          }),
        }),
      ),
    ).toThrow(/successor router must differ from the retired router/);

    expect(() =>
      parseDeploymentSet(
        set({
          base: evmRecord({
            lifecycle: {
              status: "active",
              successor: {
                chain: "base",
                router: `0x${"9".repeat(40)}`,
              },
            },
          }),
        }),
      ),
    ).toThrow(/active deployment cannot declare a successor/);
  });
});
