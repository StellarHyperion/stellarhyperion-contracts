/**
 * Contract-to-registry verification for Hyperion operational checks.
 *
 * Compares live token, provider, and domain observations against an explicitly selected SDK
 * registry revision. Separates primary-source verified entries from inferred registry defaults,
 * flags any provider/token/domain drift, and keeps unreachable or unsupported reads in an
 * explicit unknown state rather than reporting healthy.
 */
import { CHAINS, isChainKey, isEvmChain, isStellarChain, type ChainKey } from "../chains.js";
import { isStellarAddress } from "../addresses.js";
import { ASSETS, isEvmAsset, isStellarAsset, type Asset } from "../registry/assets.js";
import { RAIL_CONTRACTS, type RailContracts } from "../registry/contracts.js";

export type RegistryFieldProvenance = "primary-source-verified" | "inferred-default";

export type ObservedRead<T> =
  | { readonly state: "value"; readonly value: T }
  | { readonly state: "unreachable"; readonly reason: string }
  | { readonly state: "unsupported"; readonly reason: string };

export type RegistryCheckStatus =
  | "matched-verified"
  | "matched-inferred"
  | "mismatch"
  | "unknown-unreachable"
  | "unknown-unsupported";

export type RegistryReportStatus = "healthy" | "discrepancy" | "unknown";

export interface StellarCctpReference {
  readonly tokenMessenger: string;
  readonly messageTransmitter: string;
  readonly source: string;
  readonly confirmed: boolean;
}

export interface RegistryRevisionSnapshot {
  /** Explicit revision identifier (for example git commit SHA or SDK tag). Required. */
  readonly revision: string;
  readonly chains?: Readonly<Partial<Record<ChainKey, (typeof CHAINS)[ChainKey]>>> | undefined;
  readonly assets?: readonly Asset[] | undefined;
  readonly railContracts?: Readonly<Partial<Record<ChainKey, RailContracts>>> | undefined;
  readonly stellarCctp?: Readonly<Partial<Record<ChainKey, StellarCctpReference>>> | undefined;
}

export interface LiveTokenObservation {
  readonly symbol: string;
  readonly decimals?: ObservedRead<number> | undefined;
  /** EVM ERC-20 address or Stellar SAC contract id when applicable. */
  readonly address?: ObservedRead<string> | undefined;
  readonly code?: ObservedRead<string> | undefined;
  readonly issuer?: ObservedRead<string> | undefined;
}

export interface LiveAxelarObservation {
  readonly chainName?: ObservedRead<string> | undefined;
  readonly interchainTokenService?: ObservedRead<string> | undefined;
  readonly gasService?: ObservedRead<string> | undefined;
  readonly gateway?: ObservedRead<string | null> | undefined;
  /** Peer chain keys mapped to the Axelar chain names configured on the adapter. */
  readonly peerLinks?: Readonly<Record<string, ObservedRead<string>>> | undefined;
}

export interface LiveCctpObservation {
  readonly localDomain?: ObservedRead<number> | undefined;
  readonly tokenMessenger?: ObservedRead<string> | undefined;
  readonly messageTransmitter?: ObservedRead<string> | undefined;
  readonly tokenMinter?: ObservedRead<string> | undefined;
  /** Peer chain keys mapped to the CCTP domain numbers configured on the adapter. */
  readonly peerDomains?: Readonly<Record<string, ObservedRead<number>>> | undefined;
}

export interface LiveContractObservation {
  readonly chain: ChainKey;
  readonly tokens?: readonly LiveTokenObservation[] | undefined;
  readonly axelar?: LiveAxelarObservation | undefined;
  readonly cctp?: LiveCctpObservation | undefined;
}

export interface RegistryFieldFinding {
  readonly field: string;
  readonly category: "token" | "provider" | "domain";
  readonly expected: string;
  readonly observed: string | null;
  readonly provenance: RegistryFieldProvenance;
  readonly source: string;
  readonly status: RegistryCheckStatus;
  readonly detail: string;
}

export interface RegistryVerificationSummary {
  readonly totalChecks: number;
  readonly matchedVerifiedCount: number;
  readonly matchedInferredCount: number;
  readonly mismatchCount: number;
  readonly unknownCount: number;
}

export interface RegistryVerificationReport {
  readonly revision: string;
  readonly chain: ChainKey;
  readonly status: RegistryReportStatus;
  readonly healthy: boolean;
  readonly summary: RegistryVerificationSummary;
  readonly findings: readonly RegistryFieldFinding[];
}

export function observedValue<T>(value: T): ObservedRead<T> {
  return { state: "value", value };
}

export function observedUnreachable(reason: string): ObservedRead<never> {
  return { state: "unreachable", reason: reason.trim() || "RPC read unreachable" };
}

export function observedUnsupported(reason: string): ObservedRead<never> {
  return { state: "unsupported", reason: reason.trim() || "Contract read unsupported" };
}

export function buildSdkRegistrySnapshot(
  revision: string,
  stellarCctp?: Readonly<Partial<Record<ChainKey, StellarCctpReference>>>,
): RegistryRevisionSnapshot {
  const trimmed = revision.trim();
  if (trimmed.length === 0) {
    throw new Error("An explicit SDK registry revision is required for contract verification.");
  }
  return {
    revision: trimmed,
    chains: CHAINS,
    assets: ASSETS,
    railContracts: RAIL_CONTRACTS,
    ...(stellarCctp !== undefined ? { stellarCctp } : {}),
  };
}

function normalizeAddressForFamily(value: string, family: "evm" | "stellar"): string {
  const trimmed = value.trim();
  return family === "evm" ? trimmed.toLowerCase() : trimmed;
}

function provenanceFor(confirmed: boolean): RegistryFieldProvenance {
  return confirmed ? "primary-source-verified" : "inferred-default";
}

function evaluateRead<T>(
  field: string,
  category: "token" | "provider" | "domain",
  expectedDisplay: string,
  read: ObservedRead<T> | undefined,
  equals: (actual: T) => boolean,
  formatActual: (actual: T) => string,
  confirmed: boolean,
  source: string,
): RegistryFieldFinding {
  const provenance = provenanceFor(confirmed);
  if (read === undefined) {
    return {
      field,
      category,
      expected: expectedDisplay,
      observed: null,
      provenance,
      source,
      status: "unknown-unreachable",
      detail: "Live value was not supplied; state remains unknown.",
    };
  }
  if (read.state === "unreachable") {
    return {
      field,
      category,
      expected: expectedDisplay,
      observed: null,
      provenance,
      source,
      status: "unknown-unreachable",
      detail: `Unreachable live read: ${read.reason}`,
    };
  }
  if (read.state === "unsupported") {
    return {
      field,
      category,
      expected: expectedDisplay,
      observed: null,
      provenance,
      source,
      status: "unknown-unsupported",
      detail: `Unsupported live read: ${read.reason}`,
    };
  }
  const actualDisplay = formatActual(read.value);
  if (!equals(read.value)) {
    return {
      field,
      category,
      expected: expectedDisplay,
      observed: actualDisplay,
      provenance,
      source,
      status: "mismatch",
      detail: `Live value ${actualDisplay} disagrees with registry ${expectedDisplay}.`,
    };
  }
  return {
    field,
    category,
    expected: expectedDisplay,
    observed: actualDisplay,
    provenance,
    source,
    status: confirmed ? "matched-verified" : "matched-inferred",
    detail: confirmed
      ? "Matches primary-source verified registry entry."
      : "Matches inferred registry default; confirm against primary chain state before mainnet activation.",
  };
}

export function verifyContractAgainstRegistry(
  observation: LiveContractObservation,
  snapshot: RegistryRevisionSnapshot,
): RegistryVerificationReport {
  const revision = snapshot.revision.trim();
  if (revision.length === 0) {
    throw new Error("An explicit SDK registry revision is required for contract verification.");
  }
  if (!isChainKey(observation.chain)) {
    throw new Error(`Unknown chain key "${String(observation.chain)}" in contract verification.`);
  }

  const chainMap = snapshot.chains ?? CHAINS;
  const chainEntry = chainMap[observation.chain];
  if (chainEntry === undefined) {
    throw new Error(`Chain "${observation.chain}" is absent from registry revision "${revision}".`);
  }

  const assets = snapshot.assets ?? ASSETS;
  const railMap = snapshot.railContracts ?? RAIL_CONTRACTS;
  const rails = railMap[observation.chain] ?? null;
  const findings: RegistryFieldFinding[] = [];

  const chainAssets = assets.filter((entry) => entry.chain === observation.chain);
  for (const regAsset of chainAssets) {
    const liveToken = observation.tokens?.find((item) => item.symbol === regAsset.symbol);
    const prefix = `tokens.${regAsset.symbol}`;

    findings.push(
      evaluateRead(
        `${prefix}.decimals`,
        "token",
        String(regAsset.decimals),
        liveToken?.decimals,
        (actual) => actual === regAsset.decimals,
        (actual) => String(actual),
        regAsset.confirmed,
        regAsset.source,
      ),
    );

    if (isEvmAsset(regAsset)) {
      findings.push(
        evaluateRead(
          `${prefix}.address`,
          "token",
          regAsset.address,
          liveToken?.address,
          (actual) =>
            normalizeAddressForFamily(actual, "evm") ===
            normalizeAddressForFamily(regAsset.address, "evm"),
          (actual) => actual.trim(),
          regAsset.confirmed,
          regAsset.source,
        ),
      );
    } else if (isStellarAsset(regAsset)) {
      findings.push(
        evaluateRead(
          `${prefix}.code`,
          "token",
          regAsset.code,
          liveToken?.code,
          (actual) => actual.trim() === regAsset.code,
          (actual) => actual.trim(),
          regAsset.confirmed,
          regAsset.source,
        ),
      );
      findings.push(
        evaluateRead(
          `${prefix}.issuer`,
          "token",
          regAsset.issuer,
          liveToken?.issuer,
          (actual) =>
            normalizeAddressForFamily(actual, "stellar") ===
            normalizeAddressForFamily(regAsset.issuer, "stellar"),
          (actual) => actual.trim(),
          regAsset.confirmed,
          regAsset.source,
        ),
      );
      if (liveToken?.address !== undefined) {
        findings.push(
          evaluateRead(
            `${prefix}.sacId`,
            "token",
            regAsset.sacId ?? "derived-stellar-sac",
            liveToken.address,
            (actual) => {
              const trimmed = actual.trim();
              if (!trimmed.startsWith("C") || !isStellarAddress(trimmed)) return false;
              return regAsset.sacId === null || trimmed === regAsset.sacId;
            },
            (actual) => actual.trim(),
            regAsset.confirmed,
            regAsset.source,
          ),
        );
      }
    }
  }

  if (rails?.axelar !== null && rails?.axelar !== undefined) {
    const axelarReg = rails.axelar;
    const axelarObs = observation.axelar;
    findings.push(
      evaluateRead(
        "providers.axelar.chainName",
        "domain",
        axelarReg.chainName,
        axelarObs?.chainName,
        (actual) => actual.trim() === axelarReg.chainName,
        (actual) => actual.trim(),
        rails.confirmed,
        rails.source,
      ),
    );
    findings.push(
      evaluateRead(
        "providers.axelar.interchainTokenService",
        "provider",
        axelarReg.interchainTokenService,
        axelarObs?.interchainTokenService,
        (actual) =>
          normalizeAddressForFamily(actual, chainEntry.family) ===
          normalizeAddressForFamily(axelarReg.interchainTokenService, chainEntry.family),
        (actual) => actual.trim(),
        rails.confirmed,
        rails.source,
      ),
    );
    if (axelarObs?.gasService !== undefined) {
      findings.push(
        evaluateRead(
          "providers.axelar.gasService",
          "provider",
          axelarReg.gasService,
          axelarObs.gasService,
          (actual) =>
            normalizeAddressForFamily(actual, chainEntry.family) ===
            normalizeAddressForFamily(axelarReg.gasService, chainEntry.family),
          (actual) => actual.trim(),
          rails.confirmed,
          rails.source,
        ),
      );
    }
    if (axelarReg.gateway !== null && axelarObs?.gateway !== undefined) {
      const expectedGateway = axelarReg.gateway;
      findings.push(
        evaluateRead(
          "providers.axelar.gateway",
          "provider",
          expectedGateway,
          axelarObs.gateway,
          (actual) =>
            actual !== null &&
            normalizeAddressForFamily(actual, chainEntry.family) ===
              normalizeAddressForFamily(expectedGateway, chainEntry.family),
          (actual) => actual ?? "null",
          rails.confirmed,
          rails.source,
        ),
      );
    }

    if (axelarObs?.peerLinks !== undefined) {
      for (const [peerKey, peerRead] of Object.entries(axelarObs.peerLinks)) {
        if (!isChainKey(peerKey)) {
          findings.push({
            field: `domains.axelar.peerLinks.${peerKey}`,
            category: "domain",
            expected: "known-chain-key",
            observed: peerKey,
            provenance: "primary-source-verified",
            source: "CHAINS registry",
            status: "mismatch",
            detail: `Peer chain "${peerKey}" is not present in the selected registry revision.`,
          });
          continue;
        }
        const peerChain = chainMap[peerKey];
        const peerRails = railMap[peerKey] ?? null;
        const expectedName = peerRails?.axelar?.chainName ?? peerChain?.axelarName ?? null;
        if (expectedName === null) {
          findings.push({
            field: `domains.axelar.peerLinks.${peerKey}`,
            category: "domain",
            expected: "unconfigured",
            observed: peerRead.state === "value" ? peerRead.value : null,
            provenance: provenanceFor(peerRails?.confirmed ?? false),
            source: peerRails?.source ?? "CHAINS registry",
            status: peerRead.state === "value" ? "mismatch" : "unknown-unsupported",
            detail: `Registry revision "${revision}" defines no Axelar chain name for "${peerKey}".`,
          });
          continue;
        }
        findings.push(
          evaluateRead(
            `domains.axelar.peerLinks.${peerKey}`,
            "domain",
            expectedName,
            peerRead,
            (actual) => actual.trim() === expectedName,
            (actual) => actual.trim(),
            peerRails?.confirmed ?? false,
            peerRails?.source ?? "CHAINS registry",
          ),
        );
      }
    }
  }

  const cctpObs = observation.cctp;
  const stellarRef = isStellarChain(chainEntry)
    ? snapshot.stellarCctp?.[observation.chain]
    : undefined;
  const hasCctpExpectation =
    (isEvmChain(chainEntry) && rails?.cctp !== null && rails?.cctp !== undefined) ||
    stellarRef !== undefined ||
    cctpObs !== undefined;

  if (hasCctpExpectation) {
    if (chainEntry.cctpDomain !== null && cctpObs?.localDomain !== undefined) {
      const expectedDomain = chainEntry.cctpDomain;
      findings.push(
        evaluateRead(
          "domains.cctp.localDomain",
          "domain",
          String(expectedDomain),
          cctpObs.localDomain,
          (actual) => actual === expectedDomain,
          (actual) => String(actual),
          stellarRef?.confirmed ?? rails?.confirmed ?? false,
          stellarRef?.source ?? rails?.source ?? "Circle CCTP V2 domain table",
        ),
      );
    }

    if (isEvmChain(chainEntry) && rails?.cctp !== null && rails?.cctp !== undefined) {
      const cctpReg = rails.cctp;
      findings.push(
        evaluateRead(
          "providers.cctp.tokenMessengerV2",
          "provider",
          cctpReg.tokenMessengerV2,
          cctpObs?.tokenMessenger,
          (actual) =>
            normalizeAddressForFamily(actual, "evm") ===
            normalizeAddressForFamily(cctpReg.tokenMessengerV2, "evm"),
          (actual) => actual.trim(),
          rails.confirmed,
          rails.source,
        ),
      );
      findings.push(
        evaluateRead(
          "providers.cctp.messageTransmitterV2",
          "provider",
          cctpReg.messageTransmitterV2,
          cctpObs?.messageTransmitter,
          (actual) =>
            normalizeAddressForFamily(actual, "evm") ===
            normalizeAddressForFamily(cctpReg.messageTransmitterV2, "evm"),
          (actual) => actual.trim(),
          rails.confirmed,
          rails.source,
        ),
      );
      if (cctpObs?.tokenMinter !== undefined) {
        findings.push(
          evaluateRead(
            "providers.cctp.tokenMinterV2",
            "provider",
            cctpReg.tokenMinterV2,
            cctpObs.tokenMinter,
            (actual) =>
              normalizeAddressForFamily(actual, "evm") ===
              normalizeAddressForFamily(cctpReg.tokenMinterV2, "evm"),
            (actual) => actual.trim(),
            rails.confirmed,
            rails.source,
          ),
        );
      }
    } else if (isStellarChain(chainEntry)) {
      if (stellarRef !== undefined) {
        findings.push(
          evaluateRead(
            "providers.cctp.tokenMessenger",
            "provider",
            stellarRef.tokenMessenger,
            cctpObs?.tokenMessenger,
            (actual) =>
              normalizeAddressForFamily(actual, "stellar") ===
              normalizeAddressForFamily(stellarRef.tokenMessenger, "stellar"),
            (actual) => actual.trim(),
            stellarRef.confirmed,
            stellarRef.source,
          ),
        );
        findings.push(
          evaluateRead(
            "providers.cctp.messageTransmitter",
            "provider",
            stellarRef.messageTransmitter,
            cctpObs?.messageTransmitter,
            (actual) =>
              normalizeAddressForFamily(actual, "stellar") ===
              normalizeAddressForFamily(stellarRef.messageTransmitter, "stellar"),
            (actual) => actual.trim(),
            stellarRef.confirmed,
            stellarRef.source,
          ),
        );
      } else if (
        cctpObs?.tokenMessenger !== undefined ||
        cctpObs?.messageTransmitter !== undefined
      ) {
        findings.push({
          field: "providers.cctp.stellarReference",
          category: "provider",
          expected: "explicit-stellar-cctp-reference",
          observed: null,
          provenance: "inferred-default",
          source: "circlefin/stellar-cctp reference required",
          status: "unknown-unsupported",
          detail:
            "Stellar CCTP contracts are not hardcoded in RAIL_CONTRACTS; supply stellarCctp reference in the selected registry snapshot.",
        });
      }
    }

    if (cctpObs?.peerDomains !== undefined) {
      for (const [peerKey, domainRead] of Object.entries(cctpObs.peerDomains)) {
        if (!isChainKey(peerKey)) {
          findings.push({
            field: `domains.cctp.peerDomains.${peerKey}`,
            category: "domain",
            expected: "known-chain-key",
            observed: peerKey,
            provenance: "primary-source-verified",
            source: "CHAINS registry",
            status: "mismatch",
            detail: `Peer chain "${peerKey}" is not present in the selected registry revision.`,
          });
          continue;
        }
        const peerChain = chainMap[peerKey];
        const peerRails = railMap[peerKey] ?? null;
        const expectedDomain = peerChain?.cctpDomain ?? null;
        if (expectedDomain === null) {
          findings.push({
            field: `domains.cctp.peerDomains.${peerKey}`,
            category: "domain",
            expected: "unsupported-cctp-domain",
            observed: domainRead.state === "value" ? String(domainRead.value) : null,
            provenance: provenanceFor(peerRails?.confirmed ?? false),
            source: peerRails?.source ?? "Circle CCTP V2 domain table",
            status: domainRead.state === "value" ? "mismatch" : "unknown-unsupported",
            detail: `Chain "${peerKey}" has no published CCTP domain in registry revision "${revision}".`,
          });
          continue;
        }
        findings.push(
          evaluateRead(
            `domains.cctp.peerDomains.${peerKey}`,
            "domain",
            String(expectedDomain),
            domainRead,
            (actual) => actual === expectedDomain,
            (actual) => String(actual),
            peerRails?.confirmed ?? false,
            peerRails?.source ?? "Circle CCTP V2 domain table",
          ),
        );
      }
    }
  }

  let matchedVerifiedCount = 0;
  let matchedInferredCount = 0;
  let mismatchCount = 0;
  let unknownCount = 0;

  for (const item of findings) {
    if (item.status === "matched-verified") matchedVerifiedCount += 1;
    else if (item.status === "matched-inferred") matchedInferredCount += 1;
    else if (item.status === "mismatch") mismatchCount += 1;
    else unknownCount += 1;
  }

  const status: RegistryReportStatus =
    mismatchCount > 0
      ? "discrepancy"
      : unknownCount > 0 || findings.length === 0
        ? "unknown"
        : "healthy";

  return {
    revision,
    chain: observation.chain,
    status,
    healthy: status === "healthy",
    summary: {
      totalChecks: findings.length,
      matchedVerifiedCount,
      matchedInferredCount,
      mismatchCount,
      unknownCount,
    },
    findings,
  };
}

export function formatRegistryVerificationReport(report: RegistryVerificationReport): string {
  const lines: string[] = [
    `Registry verification (${report.chain} against revision ${report.revision}): ${report.status.toUpperCase()}`,
    `Summary: total=${String(report.summary.totalChecks)} verified=${String(report.summary.matchedVerifiedCount)} inferred=${String(report.summary.matchedInferredCount)} mismatch=${String(report.summary.mismatchCount)} unknown=${String(report.summary.unknownCount)}`,
  ];
  for (const item of report.findings) {
    const obsText = item.observed ?? "unknown";
    lines.push(
      `[${item.status}] (${item.provenance}) ${item.field}: observed=${obsText} expected=${item.expected} - ${item.detail}`,
    );
  }
  return lines.join("\n");
}
