import { describe, expect, it } from "vitest";
import {
  buildSdkRegistrySnapshot,
  formatRegistryVerificationReport,
  observedUnreachable,
  observedUnsupported,
  observedValue,
  verifyContractAgainstRegistry,
  type LiveContractObservation,
  type StellarCctpReference,
} from "../src/index.js";

const STELLAR_TESTNET_CCTP_REF: Record<string, StellarCctpReference> = {
  "stellar-testnet": {
    tokenMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
    source: "https://developers.circle.com/cctp/references/stellar-contracts",
    confirmed: true,
  },
};

function validStellarTestnetObservation(): LiveContractObservation {
  return {
    chain: "stellar-testnet",
    tokens: [
      {
        symbol: "USDC",
        decimals: observedValue(7),
        code: observedValue("USDC"),
        issuer: observedValue("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
        address: observedValue("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"),
      },
    ],
    axelar: {
      chainName: observedValue("stellar-2026-q1-2"),
      interchainTokenService: observedValue(
        "CC7LAC4S7KAPIM26WKWFSOXWLNLSG7EXTC2EVY2H2UPKSTX3Z2A7M5YP",
      ),
      gasService: observedValue("CCLZOCGHHC6F6JCZHEUP53LDQHRBPPCNRYXOVFZFS3O63OGRC47CKCGV"),
      gateway: observedValue("CB2JYOOZPHO43R57TC5PXV22QICKIDC5NKRF62BZG2J6JYFUIQPIAYY3"),
      peerLinks: {
        sepolia: observedValue("ethereum-sepolia"),
        "arc-testnet": observedValue("arc-8"),
      },
    },
    cctp: {
      localDomain: observedValue(27),
      tokenMessenger: observedValue("CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP"),
      messageTransmitter: observedValue("CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY"),
      peerDomains: {
        sepolia: observedValue(0),
        "base-sepolia": observedValue(6),
        "arc-testnet": observedValue(26),
      },
    },
  };
}

describe("verifyContractAgainstRegistry", () => {
  it("requires an explicit non-empty SDK registry revision", () => {
    expect(() => buildSdkRegistrySnapshot("   ")).toThrow(/explicit SDK registry revision/);
    expect(() =>
      verifyContractAgainstRegistry(validStellarTestnetObservation(), { revision: "" }),
    ).toThrow(/explicit SDK registry revision/);
  });

  it("marks inferred registry defaults separately from primary-source verified fields", () => {
    const snapshot = buildSdkRegistrySnapshot("84a6ce3", STELLAR_TESTNET_CCTP_REF);
    const stellarReport = verifyContractAgainstRegistry(validStellarTestnetObservation(), snapshot);

    expect(stellarReport.status).toBe("healthy");
    expect(stellarReport.healthy).toBe(true);
    expect(stellarReport.summary.mismatchCount).toBe(0);
    expect(stellarReport.summary.unknownCount).toBe(0);
    // Stellar USDC, Axelar ITS, Arc Testnet peer, and Circle CCTP ref are primary-source verified;
    // Sepolia and Base Sepolia peer defaults are inferred in RAIL_CONTRACTS.
    expect(stellarReport.summary.matchedVerifiedCount).toBeGreaterThan(0);
    expect(stellarReport.summary.matchedInferredCount).toBe(3);

    const itsFinding = stellarReport.findings.find(
      (f) => f.field === "providers.axelar.interchainTokenService",
    )!;
    expect(itsFinding.provenance).toBe("primary-source-verified");
    expect(itsFinding.status).toBe("matched-verified");

    const sepoliaPeer = stellarReport.findings.find(
      (f) => f.field === "domains.axelar.peerLinks.sepolia",
    )!;
    expect(sepoliaPeer.provenance).toBe("inferred-default");
    expect(sepoliaPeer.status).toBe("matched-inferred");

    const arcPeer = stellarReport.findings.find(
      (f) => f.field === "domains.axelar.peerLinks.arc-testnet",
    )!;
    expect(arcPeer.provenance).toBe("primary-source-verified");
    expect(arcPeer.status).toBe("matched-verified");

    // On an inferred EVM chain (sepolia), all rail and token defaults are marked matched-inferred.
    const sepoliaObs: LiveContractObservation = {
      chain: "sepolia",
      tokens: [
        {
          symbol: "USDC",
          decimals: observedValue(6),
          address: observedValue("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"),
        },
      ],
      axelar: {
        chainName: observedValue("ethereum-sepolia"),
        interchainTokenService: observedValue("0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C"),
      },
      cctp: {
        localDomain: observedValue(0),
        tokenMessenger: observedValue("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"),
        messageTransmitter: observedValue("0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"),
      },
    };
    const sepoliaReport = verifyContractAgainstRegistry(sepoliaObs, snapshot);
    expect(sepoliaReport.status).toBe("healthy");
    expect(sepoliaReport.summary.matchedVerifiedCount).toBe(0);
    expect(sepoliaReport.summary.matchedInferredCount).toBe(sepoliaReport.summary.totalChecks);

    const formatted = formatRegistryVerificationReport(stellarReport);
    expect(formatted).toContain("(primary-source-verified)");
    expect(formatted).toContain("(inferred-default)");
  });

  it("flags changed provider addresses, token settings, and domain mappings as discrepancies", () => {
    const snapshot = buildSdkRegistrySnapshot("84a6ce3", STELLAR_TESTNET_CCTP_REF);
    const base = validStellarTestnetObservation();
    const drifted: LiveContractObservation = {
      ...base,
      axelar: {
        ...base.axelar,
        // Rotated / wrong ITS contract address on Stellar Testnet
        interchainTokenService: observedValue(
          "CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ",
        ),
      },
      cctp: {
        ...base.cctp,
        // Changed Circle TokenMessenger contract address
        tokenMessenger: observedValue("CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT"),
        peerDomains: {
          sepolia: observedValue(99),
        },
      },
    };

    const report = verifyContractAgainstRegistry(drifted, snapshot);
    expect(report.status).toBe("discrepancy");
    expect(report.healthy).toBe(false);
    expect(report.summary.mismatchCount).toBe(3);

    const mismatchedFields = report.findings
      .filter((item) => item.status === "mismatch")
      .map((item) => item.field);
    expect(mismatchedFields).toEqual([
      "providers.axelar.interchainTokenService",
      "providers.cctp.tokenMessenger",
      "domains.cctp.peerDomains.sepolia",
    ]);
  });

  it("keeps unreachable, omitted, or unsupported reads in unknown status rather than healthy", () => {
    const snapshotWithRef = buildSdkRegistrySnapshot("84a6ce3", STELLAR_TESTNET_CCTP_REF);
    const base = validStellarTestnetObservation();

    const unreachableObs: LiveContractObservation = {
      ...base,
      axelar: {
        ...base.axelar,
        interchainTokenService: observedUnreachable("Soroban RPC timeout"),
        gateway: observedUnsupported("adapter does not expose gateway getter"),
      },
    };
    const unreachableReport = verifyContractAgainstRegistry(unreachableObs, snapshotWithRef);
    expect(unreachableReport.status).toBe("unknown");
    expect(unreachableReport.healthy).toBe(false);
    expect(unreachableReport.summary.unknownCount).toBe(2);
    expect(
      unreachableReport.findings.find((f) => f.field === "providers.axelar.interchainTokenService")
        ?.status,
    ).toBe("unknown-unreachable");
    expect(
      unreachableReport.findings.find((f) => f.field === "providers.axelar.gateway")?.status,
    ).toBe("unknown-unsupported");

    // Omitting live provider observations altogether must also report unknown rather than healthy.
    const omittedProvidersReport = verifyContractAgainstRegistry(
      { chain: "stellar-testnet", tokens: base.tokens },
      snapshotWithRef,
    );
    expect(omittedProvidersReport.status).toBe("unknown");
    expect(omittedProvidersReport.healthy).toBe(false);
    expect(omittedProvidersReport.summary.unknownCount).toBeGreaterThanOrEqual(4);

    // Observing Stellar CCTP contracts without supplying an explicit Stellar CCTP reference
    // remains unknown-unsupported because RAIL_CONTRACTS intentionally omits Stellar CCTP defaults.
    const snapshotWithoutStellarCctp = buildSdkRegistrySnapshot("84a6ce3");
    const noRefReport = verifyContractAgainstRegistry(base, snapshotWithoutStellarCctp);
    expect(noRefReport.status).toBe("unknown");
    expect(noRefReport.healthy).toBe(false);
    expect(
      noRefReport.findings.find((f) => f.field === "providers.cctp.stellarReference")?.status,
    ).toBe("unknown-unsupported");
  });
});
