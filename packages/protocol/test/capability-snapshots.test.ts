import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  axelarItsAdapterAbi,
  cctpAdapterAbi,
  hyperionRouterAbi,
  hyperionRouterInterfaceAbi,
  railAdapterAbi,
} from "../src/abi/index.js";
import {
  type AdapterCapabilitySnapshot,
  buildLiveAdapterCapabilitySnapshot,
  buildLiveRouterCapabilitySnapshot,
  compareCapabilitySurface,
  type RouterCapabilitySnapshot,
  verifySnapshotConsistency,
} from "../src/capabilitySnapshots.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function loadCommittedSnapshots(): {
  readonly routerSnapshot: RouterCapabilitySnapshot;
  readonly adapterSnapshot: AdapterCapabilitySnapshot;
} {
  const routerSnapshot = JSON.parse(
    readFileSync(resolve(TEST_DIR, "snapshots/router-capabilities.snapshot.json"), "utf8"),
  ) as RouterCapabilitySnapshot;
  const adapterSnapshot = JSON.parse(
    readFileSync(resolve(TEST_DIR, "snapshots/adapter-capabilities.snapshot.json"), "utf8"),
  ) as AdapterCapabilitySnapshot;
  return { routerSnapshot, adapterSnapshot };
}

function buildLiveSnapshots(): {
  readonly liveRouter: RouterCapabilitySnapshot;
  readonly liveAdapter: AdapterCapabilitySnapshot;
} {
  const liveRouter = buildLiveRouterCapabilitySnapshot({
    sorobanRouterSource: readRepoFile("soroban/crates/hyperion-router/src/lib.rs"),
    evmRouterAbi: hyperionRouterAbi,
    evmRouterInterfaceAbi: hyperionRouterInterfaceAbi,
  });
  const liveAdapter = buildLiveAdapterCapabilitySnapshot({
    sorobanCctpSource: readRepoFile("soroban/crates/hyperion-adapter-cctp/src/lib.rs"),
    sorobanAxelarSource: readRepoFile("soroban/crates/hyperion-adapter-axelar/src/lib.rs"),
    sorobanAllbridgeSource: readRepoFile("soroban/crates/hyperion-adapter-allbridge/src/lib.rs"),
    evmCctpAdapterAbi: cctpAdapterAbi,
    evmAxelarItsAdapterAbi: axelarItsAdapterAbi,
    evmRailAdapterAbi: railAdapterAbi,
  });
  return { liveRouter, liveAdapter };
}

describe("contract-interface capability regression snapshots", () => {
  it("stores router and adapter surfaces separately and matches live contract interfaces", () => {
    const { routerSnapshot, adapterSnapshot } = loadCommittedSnapshots();
    const { liveRouter, liveAdapter } = buildLiveSnapshots();

    expect(routerSnapshot.surfaceKind).toBe("router");
    expect(adapterSnapshot.surfaceKind).toBe("adapter");
    expect(routerSnapshot).toEqual(liveRouter);
    expect(adapterSnapshot).toEqual(liveAdapter);

    expect(verifySnapshotConsistency(routerSnapshot)).toEqual([]);
    expect(verifySnapshotConsistency(adapterSnapshot)).toEqual([]);

    const routerEvolution = compareCapabilitySurface(routerSnapshot, liveRouter);
    const adapterEvolution = compareCapabilitySurface(adapterSnapshot, liveAdapter);
    expect(routerEvolution.ok).toBe(true);
    expect(adapterEvolution.ok).toBe(true);

    // Mixing an adapter contract into a router snapshot fails surface separation.
    const firstAdapter = adapterSnapshot.contracts[0];
    expect(firstAdapter).toBeDefined();
    if (firstAdapter !== undefined) {
      const contaminated: RouterCapabilitySnapshot = {
        ...routerSnapshot,
        contracts: [...routerSnapshot.contracts, firstAdapter],
      };
      expect(verifySnapshotConsistency(contaminated).map((v) => v.code)).toContain(
        "surface-separation-violation",
      );
    }
  });

  it("verifies advertised paid capabilities match callable ABI and Soroban methods", () => {
    const { liveRouter, liveAdapter } = buildLiveSnapshots();

    const sorobanRouter = liveRouter.contracts.find(
      (c) => c.stack === "soroban" && c.contractName === "HyperionRouter",
    );
    expect(sorobanRouter).toBeDefined();
    expect(sorobanRouter?.paidRoutes).toEqual(["Cctp", "AxelarIts"]);
    expect(sorobanRouter?.methods.filter((m) => m.paid).map((m) => m.name)).toEqual([
      "bridge_out_with_gas",
      "supports_paid_route",
    ]);

    const evmRouter = liveRouter.contracts.find(
      (c) => c.stack === "evm" && c.contractName === "HyperionRouter",
    );
    const evmBridgeOut = evmRouter?.methods.find((m) => m.name === "bridgeOut");
    expect(evmBridgeOut?.paid).toBe(true);
    expect(evmBridgeOut?.mutability).toBe("payable");

    const sorobanCctp = liveAdapter.contracts.find(
      (c) => c.stack === "soroban" && c.contractName === "CctpAdapter",
    );
    expect(sorobanCctp?.paidRoutes).toEqual(["Cctp"]);
    expect(sorobanCctp?.methods.filter((m) => m.paid).map((m) => m.name)).toEqual([
      "dispatch_from",
      "quote_max_fee",
    ]);

    const sorobanAxelar = liveAdapter.contracts.find(
      (c) => c.stack === "soroban" && c.contractName === "AxelarAdapter",
    );
    expect(sorobanAxelar?.paidRoutes).toEqual(["AxelarIts"]);
    expect(sorobanAxelar?.methods.filter((m) => m.paid).map((m) => m.name)).toEqual([
      "dispatch_from",
      "gas_token",
    ]);

    // Advertising a paid route without any callable paid method fails consistency verification.
    if (sorobanCctp !== undefined) {
      const brokenPaidMismatch: AdapterCapabilitySnapshot = {
        ...liveAdapter,
        contracts: liveAdapter.contracts.map((c) =>
          c === sorobanCctp
            ? { ...c, methods: c.methods.filter((m) => m.name !== "dispatch_from") }
            : c,
        ),
      };
      expect(verifySnapshotConsistency(brokenPaidMismatch).map((v) => v.code)).toContain(
        "capability-method-mismatch",
      );
    }
  });

  it("requires explicit paid compatibility acknowledgement when paid methods or paid routes are removed", () => {
    const { liveRouter, liveAdapter } = buildLiveSnapshots();

    // 1. Remove `bridge_out_with_gas` (and clear `paidRoutes` so we test evolution rule directly).
    const strippedRouter: RouterCapabilitySnapshot = {
      ...liveRouter,
      contracts: liveRouter.contracts.map((c) =>
        c.stack === "soroban" && c.contractName === "HyperionRouter"
          ? {
              ...c,
              paidRoutes: [],
              methods: c.methods.filter((m) => m.name !== "bridge_out_with_gas"),
            }
          : c,
      ),
    };

    const unacknowledged = compareCapabilitySurface(liveRouter, strippedRouter);
    expect(unacknowledged.ok).toBe(false);
    expect(unacknowledged.violations.map((v) => v.code)).toContain(
      "paid-method-removed-without-ack",
    );
    expect(unacknowledged.violations.map((v) => v.code)).toContain(
      "paid-route-removed-without-ack",
    );

    // 2. Non-paid acknowledgement (`acknowledgePaidRemoval: false`) is insufficient for paid surfaces.
    const weakAck = compareCapabilitySurface(liveRouter, strippedRouter, {
      acknowledgements: [
        {
          surfaceKind: "router",
          contractName: "soroban:HyperionRouter",
          target: "bridge_out_with_gas",
          acknowledgePaidRemoval: false,
          reason: "Removing paid bridge entrypoint",
          consumerMigration: "Switch callers to bridge_out",
          reference: "COMPAT-001",
        },
      ],
    });
    expect(weakAck.ok).toBe(false);
    expect(weakAck.violations.map((v) => v.code)).toContain("paid-method-removed-without-ack");

    // 3. Explicit paid acknowledgements for both the paid method and paid routes pass and record audit trail.
    const explicitAck = compareCapabilitySurface(liveRouter, strippedRouter, {
      acknowledgements: [
        {
          surfaceKind: "router",
          contractName: "soroban:HyperionRouter",
          target: "bridge_out_with_gas",
          acknowledgePaidRemoval: true,
          reason: "Replacing Soroban paid router entrypoint in major upgrade rehearsal",
          consumerMigration: "Migrate SDK callers to v2 paid router client before upgrade ETA",
          reference: "COMPAT-PAID-ROUTER-1",
        },
        {
          surfaceKind: "router",
          contractName: "soroban:HyperionRouter",
          target: "paidRoute:Cctp",
          acknowledgePaidRemoval: true,
          reason: "Retiring v1 paid Cctp route on old router instance",
          consumerMigration: "Route Cctp forwarding transfers via v2 router",
          reference: "COMPAT-PAID-ROUTER-2",
        },
        {
          surfaceKind: "router",
          contractName: "soroban:HyperionRouter",
          target: "paidRoute:AxelarIts",
          acknowledgePaidRemoval: true,
          reason: "Retiring v1 paid AxelarIts route on old router instance",
          consumerMigration: "Route AxelarIts native-gas transfers via v2 router",
          reference: "COMPAT-PAID-ROUTER-3",
        },
      ],
    });
    expect(explicitAck.ok).toBe(true);
    expect(explicitAck.acknowledgedRemovals).toHaveLength(3);

    // 4. Removing `topUpGas` on EVM AxelarItsAdapter without paid acknowledgement fails.
    const strippedAdapter: AdapterCapabilitySnapshot = {
      ...liveAdapter,
      contracts: liveAdapter.contracts.map((c) =>
        c.stack === "evm" && c.contractName === "AxelarItsAdapter"
          ? { ...c, methods: c.methods.filter((m) => m.name !== "topUpGas") }
          : c,
      ),
    };
    const adapterUnacked = compareCapabilitySurface(liveAdapter, strippedAdapter);
    expect(adapterUnacked.ok).toBe(false);
    expect(adapterUnacked.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "paid-method-removed-without-ack",
          contractName: "evm:AxelarItsAdapter",
          target: "topUpGas",
        }),
      ]),
    );
  });

  it("permits additive method evolution while rejecting silent signature mutations", () => {
    const { liveAdapter } = buildLiveSnapshots();

    const withAdditiveView: AdapterCapabilitySnapshot = {
      ...liveAdapter,
      contracts: liveAdapter.contracts.map((c) =>
        c.stack === "soroban" && c.contractName === "AxelarAdapter"
          ? {
              ...c,
              methods: [
                ...c.methods,
                {
                  name: "quote_its_gas_estimate",
                  signature: "quote_its_gas_estimate(String) -> Result<i128, HyperionError>",
                  paid: true,
                },
              ].sort((a, b) => a.name.localeCompare(b.name)),
            }
          : c,
      ),
    };
    const additiveReport = compareCapabilitySurface(liveAdapter, withAdditiveView);
    expect(additiveReport.ok).toBe(true);
    expect(additiveReport.additiveMethods).toEqual([
      { contractName: "soroban:AxelarAdapter", method: "quote_its_gas_estimate" },
    ]);

    // Mutating an existing method signature fails without acknowledgement.
    const mutatedSignature: AdapterCapabilitySnapshot = {
      ...liveAdapter,
      contracts: liveAdapter.contracts.map((c) =>
        c.stack === "soroban" && c.contractName === "CctpAdapter"
          ? {
              ...c,
              methods: c.methods.map((m) =>
                m.name === "dispatch_from"
                  ? { ...m, signature: "dispatch_from(Address, Address, i128) -> ()" }
                  : m,
              ),
            }
          : c,
      ),
    };
    const sigReport = compareCapabilitySurface(liveAdapter, mutatedSignature);
    expect(sigReport.ok).toBe(false);
    expect(sigReport.violations.map((v) => v.code)).toContain("method-signature-changed");
  });
});
