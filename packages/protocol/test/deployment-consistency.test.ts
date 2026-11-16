import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AddressKind, encodeStellarAddress } from "../src/addresses.js";
import {
  ConsistencyFormatError,
  compareDeploymentCopies,
  formatDeploymentConsistencyReport,
} from "../src/deployment-consistency.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function contractAt(seed: number): string {
  return encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(seed));
}

function loadCanonical(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(repoRoot, "deployments/stellar-testnet-phase1.json"), "utf8"),
  ) as Record<string, unknown>;
}

function loadArchivedOct1(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(repoRoot, "deployments/archive/stellar-testnet-2026-10-01.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("cross-repository deployment-copy consistency checks", () => {
  it("confirms identical canonical, backend, and frontend copies at explicit revisions while cataloging archives", () => {
    const canonical = loadCanonical();
    const backendCopy = structuredClone(canonical);
    const frontendCopy = structuredClone(canonical);
    const archivedOct1 = loadArchivedOct1();

    const report = compareDeploymentCopies({
      canonical: {
        role: "contracts",
        revision: "b91c6ca",
        path: "deployments/stellar-testnet-phase1.json",
        content: canonical,
      },
      consumers: [
        {
          role: "backend",
          revision: "8f1021a",
          path: "deployments/stellar-testnet-phase1.json",
          content: backendCopy,
        },
        {
          role: "frontend",
          revision: "c9fc17b",
          path: "deployments/stellar-testnet-phase1.json",
          content: frontendCopy,
        },
      ],
      archived: [
        {
          archiveId: "stellar-testnet-2026-10-01.json",
          path: "deployments/archive/stellar-testnet-2026-10-01.json",
          content: archivedOct1,
        },
      ],
    });

    expect(report.readOnly).toBe(true);
    expect(report.consumerRewritePermitted).toBe(false);
    expect(report.consistent).toBe(true);
    expect(report.validationGate).toBe("active-validated");
    expect(report.mismatches).toEqual([]);
    expect(report.archivedCatalog).toHaveLength(1);
    expect(report.archivedCatalog[0]?.classification).toBe("archived");
    expect(report.archivedCatalog[0]?.archiveId).toBe("stellar-testnet-2026-10-01.json");
  });

  it("identifies exact JSON field paths and owning repositories when backend or frontend copies drift", () => {
    const canonical = loadCanonical();
    const staleBackend = structuredClone(canonical) as {
      networks: {
        "stellar-testnet": {
          tokens: { USDC: { flowLimit: string } };
          wasmHashes: { "adapter-cctp"?: string };
        };
      };
    };
    staleBackend.networks["stellar-testnet"].tokens.USDC.flowLimit = "5000000000000";
    delete staleBackend.networks["stellar-testnet"].wasmHashes["adapter-cctp"];

    const staleFrontend = structuredClone(canonical) as {
      networks: {
        "stellar-testnet": {
          router: string;
        };
      };
    };
    staleFrontend.networks["stellar-testnet"].router = contractAt(99);

    const report = compareDeploymentCopies({
      canonical: {
        role: "contracts",
        revision: "b91c6ca",
        path: "deployments/stellar-testnet-phase1.json",
        content: canonical,
      },
      consumers: [
        {
          role: "backend",
          revision: "backend-rev-42",
          path: "src/config/stellar-testnet-phase1.json",
          content: staleBackend,
        },
        {
          role: "frontend",
          revision: "frontend-rev-77",
          path: "public/deployments/stellar-testnet-phase1.json",
          content: staleFrontend,
        },
      ],
    });

    expect(report.consistent).toBe(false);

    const flowMismatch = report.mismatches.find(
      (m) => m.fieldPath === "$.networks.stellar-testnet.tokens.USDC.flowLimit",
    );
    expect(flowMismatch).toBeDefined();
    expect(flowMismatch?.owningRepository).toBe("stellarhyperion-backend");
    expect(flowMismatch?.owningRole).toBe("backend");
    expect(flowMismatch?.consumerRevision).toBe("backend-rev-42");
    expect(flowMismatch?.canonicalValue).toBe("10000000000000");
    expect(flowMismatch?.consumerValue).toBe("5000000000000");

    const missingWasm = report.mismatches.find(
      (m) => m.fieldPath === "$.networks.stellar-testnet.wasmHashes.adapter-cctp",
    );
    expect(missingWasm?.kind).toBe("missing-in-consumer");
    expect(missingWasm?.owningRepository).toBe("stellarhyperion-backend");

    const routerMismatch = report.mismatches.find(
      (m) => m.fieldPath === "$.networks.stellar-testnet.router",
    );
    expect(routerMismatch?.owningRepository).toBe("stellarhyperion-frontend");
    expect(routerMismatch?.consumerRevision).toBe("frontend-rev-77");

    const formatted = formatDeploymentConsistencyReport(report);
    expect(formatted).toContain("owner=stellarhyperion-backend@backend-rev-42");
    expect(formatted).toContain("owner=stellarhyperion-frontend@frontend-rev-77");
  });

  it("distinguishes archived manifests from the active manifest and flags archived copies in consumers", () => {
    const canonical = loadCanonical();
    const archivedOct1 = loadArchivedOct1();

    // Refuses to treat an archived path as the canonical active manifest.
    expect(() => {
      compareDeploymentCopies({
        canonical: {
          role: "contracts",
          revision: "b91c6ca",
          path: "deployments/archive/stellar-testnet-2026-10-01.json",
          content: archivedOct1,
        },
        consumers: [
          {
            role: "backend",
            revision: "rev-1",
            path: "deployments/stellar-testnet-phase1.json",
            content: canonical,
          },
        ],
      });
    }).toThrow(ConsistencyFormatError);

    // Flags a consumer that accidentally copied the archived October 1 manifest into its active slot.
    const report = compareDeploymentCopies({
      canonical: {
        role: "contracts",
        revision: "b91c6ca",
        path: "deployments/stellar-testnet-phase1.json",
        content: canonical,
      },
      consumers: [
        {
          role: "frontend",
          revision: "frontend-stale-oct1",
          path: "deployments/stellar-testnet-phase1.json",
          content: archivedOct1,
        },
      ],
      archived: [
        {
          archiveId: "stellar-testnet-2026-10-01.json",
          path: "deployments/archive/stellar-testnet-2026-10-01.json",
          content: archivedOct1,
        },
      ],
    });

    expect(report.consistent).toBe(false);
    expect(report.consumers[0]?.matchesArchivedId).toBe("stellar-testnet-2026-10-01.json");
    const archiveFinding = report.mismatches.find(
      (m) => m.kind === "archived-manifest-in-consumer",
    );
    expect(archiveFinding).toBeDefined();
    expect(archiveFinding?.matchedArchiveId).toBe("stellar-testnet-2026-10-01.json");
    expect(archiveFinding?.owningRepository).toBe("stellarhyperion-frontend");
  });

  it("never rewrites consumer files, gates unvalidated networks, and rejects secret seeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyperion-copy-check-"));
    try {
      const canonical = loadCanonical();
      const divergent = structuredClone(canonical);
      divergent.generatedAt = "2026-10-20T00:00:00.000Z";
      const consumerFile = join(dir, "consumer.json");
      const initialBytes = `${JSON.stringify(divergent, null, 2)}\n`;
      writeFileSync(consumerFile, initialBytes, "utf8");
      const beforeStat = statSync(consumerFile);

      const loadedConsumer = JSON.parse(readFileSync(consumerFile, "utf8")) as unknown;
      const report = compareDeploymentCopies({
        canonical: {
          role: "contracts",
          revision: "canon-sha",
          path: "deployments/stellar-testnet-phase1.json",
          content: canonical,
        },
        consumers: [
          {
            role: "backend",
            revision: "consumer-sha",
            path: consumerFile,
            content: loadedConsumer,
          },
        ],
      });

      expect(report.consistent).toBe(false);
      expect(report.consumerRewritePermitted).toBe(false);
      // Verify file contents and mtime remain untouched.
      expect(readFileSync(consumerFile, "utf8")).toBe(initialBytes);
      expect(statSync(consumerFile).mtimeMs).toBe(beforeStat.mtimeMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(() => {
      compareDeploymentCopies({
        canonical: {
          role: "contracts",
          revision: "canon-sha",
          path: "deployments/stellar-testnet-phase1.json",
          content: loadCanonical(),
        },
        consumers: [
          {
            role: "backend",
            revision: "bad-sha",
            path: "deployments/stellar-testnet-phase1.json",
            content: { leaked: `S${"A".repeat(55)}` },
          },
        ],
      });
    }).toThrow(ConsistencyFormatError);
  });
});
