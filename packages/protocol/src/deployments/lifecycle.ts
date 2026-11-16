/**
 * Deployment manifest deprecation, successor links, and historical evidence preservation.
 *
 * Models active versus deprecated/archived deployment records so operational tools, keepers, and
 * frontends cannot accidentally activate or monitor a retired router, while guaranteeing that
 * deprecating a manifest never strips historical transaction hashes or evidence references.
 */
import { isStellarAddress } from "../addresses.js";
import { CHAINS, isChainKey, type ChainKey } from "../chains.js";

export type DeploymentLifecycleStatus = "active" | "deprecated" | "archived";

export interface DeploymentSuccessorLink {
  readonly chain: ChainKey;
  readonly router: string;
  readonly manifest?: string | undefined;
}

export interface DeploymentHistoricalEvidence {
  readonly txHashes: readonly string[];
  readonly evidenceFiles: readonly string[];
  readonly queuedActionIds: readonly number[];
  readonly queuedActions: readonly string[];
}

export interface DeploymentLifecycle {
  readonly status: DeploymentLifecycleStatus;
  readonly deprecatedAt?: string | undefined;
  readonly reason?: string | undefined;
  readonly successor?: DeploymentSuccessorLink | undefined;
}

export interface RouterLifecycleWarning {
  readonly status: "deprecated" | "archived";
  readonly chain: ChainKey;
  readonly retiredRouter: string;
  readonly deprecatedAt: string;
  readonly reason: string;
  readonly successor: DeploymentSuccessorLink | null;
  readonly message: string;
}

export class RetiredDeploymentError extends Error {
  constructor(
    readonly chain: ChainKey,
    readonly router: string,
    readonly status: "deprecated" | "archived",
    readonly successor: DeploymentSuccessorLink | null,
    message: string,
  ) {
    super(message);
    this.name = "RetiredDeploymentError";
  }
}

export interface DeprecateManifestOptions {
  readonly chain: ChainKey;
  readonly status?: "deprecated" | "archived" | undefined;
  readonly deprecatedAt: string;
  readonly reason: string;
  readonly successor?: DeploymentSuccessorLink | undefined;
}

function isTxHashString(value: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(value);
}

function normalizeRouterCompare(router: string, family: "evm" | "stellar"): string {
  return family === "evm" ? router.trim().toLowerCase() : router.trim();
}

export function validateRouterForChain(
  router: unknown,
  chainKey: ChainKey,
  path: string,
  onFail: (fieldPath: string, reason: string) => never,
): string {
  if (typeof router !== "string" || router.length === 0) {
    onFail(path, "expected a non empty string");
  }
  const chainEntry = CHAINS[chainKey];
  if (chainEntry.family === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(router)) {
      onFail(path, "expected a 20 byte hex address");
    }
    return router;
  }
  if (!router.startsWith("C") || !isStellarAddress(router)) {
    onFail(path, "expected a Stellar contract id starting with C");
  }
  return router;
}

export function parseDeploymentLifecycle(
  rawLifecycle: unknown,
  currentChain: ChainKey,
  currentRouter: string,
  path: string,
  onFail: (fieldPath: string, reason: string) => never,
): DeploymentLifecycle {
  if (rawLifecycle === undefined) {
    return { status: "active" };
  }
  if (typeof rawLifecycle !== "object" || rawLifecycle === null || Array.isArray(rawLifecycle)) {
    onFail(path, "expected an object");
  }
  const rec = rawLifecycle as Record<string, unknown>;
  const status = rec.status;
  if (status !== "active" && status !== "deprecated" && status !== "archived") {
    onFail(`${path}.status`, 'expected "active", "deprecated", or "archived"');
  }

  if (status === "active") {
    if (rec.successor !== undefined) {
      onFail(`${path}.successor`, "an active deployment cannot declare a successor router");
    }
    return { status: "active" };
  }

  if (typeof rec.deprecatedAt !== "string" || Number.isNaN(Date.parse(rec.deprecatedAt))) {
    onFail(`${path}.deprecatedAt`, "expected an ISO 8601 timestamp for retired deployment");
  }
  if (typeof rec.reason !== "string" || rec.reason.trim().length === 0) {
    onFail(`${path}.reason`, "expected a non empty deprecation reason");
  }

  let successor: DeploymentSuccessorLink | undefined;
  if (rec.successor !== undefined) {
    const succPath = `${path}.successor`;
    if (
      typeof rec.successor !== "object" ||
      rec.successor === null ||
      Array.isArray(rec.successor)
    ) {
      onFail(succPath, "expected an object");
    }
    const succRec = rec.successor as Record<string, unknown>;
    if (typeof succRec.chain !== "string" || !isChainKey(succRec.chain)) {
      onFail(`${succPath}.chain`, "unknown successor chain key");
    }
    const succRouter = validateRouterForChain(
      succRec.router,
      succRec.chain,
      `${succPath}.router`,
      onFail,
    );
    const currentFamily = CHAINS[currentChain].family;
    const succFamily = CHAINS[succRec.chain].family;
    if (
      succRec.chain === currentChain &&
      currentFamily === succFamily &&
      normalizeRouterCompare(succRouter, currentFamily) ===
        normalizeRouterCompare(currentRouter, currentFamily)
    ) {
      onFail(`${succPath}.router`, "successor router must differ from the retired router");
    }
    let manifest: string | undefined;
    if (succRec.manifest !== undefined) {
      if (typeof succRec.manifest !== "string" || succRec.manifest.trim().length === 0) {
        onFail(`${succPath}.manifest`, "expected a non empty manifest path");
      }
      manifest = succRec.manifest.trim();
    }
    successor = {
      chain: succRec.chain,
      router: succRouter,
      ...(manifest !== undefined ? { manifest } : {}),
    };
  }

  return {
    status,
    deprecatedAt: rec.deprecatedAt,
    reason: rec.reason.trim(),
    ...(successor !== undefined ? { successor } : {}),
  };
}

export function extractHistoricalEvidence(
  rawNetworkRecord: Record<string, unknown>,
  path: string,
  onFail: (fieldPath: string, reason: string) => never,
): DeploymentHistoricalEvidence {
  const txSet = new Set<string>();
  const evidenceSet = new Set<string>();

  const deployedAt = rawNetworkRecord.deployedAt;
  if (typeof deployedAt === "object" && deployedAt !== null && !Array.isArray(deployedAt)) {
    const depTx = (deployedAt as Record<string, unknown>).txHash;
    if (typeof depTx === "string" && isTxHashString(depTx)) {
      txSet.add(depTx);
    }
  }

  const activation = rawNetworkRecord.activation;
  if (typeof activation === "object" && activation !== null && !Array.isArray(activation)) {
    const actRec = activation as Record<string, unknown>;
    if (typeof actRec.sourceHash === "string" && isTxHashString(actRec.sourceHash)) {
      txSet.add(actRec.sourceHash);
    }
    if (typeof actRec.destinationHash === "string" && isTxHashString(actRec.destinationHash)) {
      txSet.add(actRec.destinationHash);
    }
    if (typeof actRec.evidence === "string" && actRec.evidence.trim().length > 0) {
      evidenceSet.add(actRec.evidence.trim());
    }
    const cctp = actRec.cctp;
    if (typeof cctp === "object" && cctp !== null && !Array.isArray(cctp)) {
      const cctpRec = cctp as Record<string, unknown>;
      if (typeof cctpRec.evidence === "string" && cctpRec.evidence.trim().length > 0) {
        evidenceSet.add(cctpRec.evidence.trim());
      }
      if (Array.isArray(cctpRec.transfers)) {
        for (const item of cctpRec.transfers) {
          if (typeof item === "object" && item !== null && !Array.isArray(item)) {
            const tr = item as Record<string, unknown>;
            if (typeof tr.sourceHash === "string" && isTxHashString(tr.sourceHash)) {
              txSet.add(tr.sourceHash);
            }
            if (typeof tr.destinationHash === "string" && isTxHashString(tr.destinationHash)) {
              txSet.add(tr.destinationHash);
            }
          }
        }
      }
    }
  }

  if (rawNetworkRecord.historicalEvidence !== undefined) {
    const histPath = `${path}.historicalEvidence`;
    if (
      typeof rawNetworkRecord.historicalEvidence !== "object" ||
      rawNetworkRecord.historicalEvidence === null ||
      Array.isArray(rawNetworkRecord.historicalEvidence)
    ) {
      onFail(histPath, "expected an object");
    }
    const histRec = rawNetworkRecord.historicalEvidence as Record<string, unknown>;
    if (histRec.txHashes !== undefined) {
      if (!Array.isArray(histRec.txHashes)) {
        onFail(`${histPath}.txHashes`, "expected an array of transaction hashes");
      }
      const hashes = histRec.txHashes as readonly unknown[];
      for (let i = 0; i < hashes.length; i += 1) {
        const entry = hashes[i];
        if (typeof entry !== "string" || !isTxHashString(entry)) {
          onFail(`${histPath}.txHashes[${String(i)}]`, "expected a 32 byte hex transaction hash");
        }
        txSet.add(entry);
      }
    }
    if (histRec.evidenceFiles !== undefined) {
      if (!Array.isArray(histRec.evidenceFiles)) {
        onFail(`${histPath}.evidenceFiles`, "expected an array of evidence file paths");
      }
      const files = histRec.evidenceFiles as readonly unknown[];
      for (let i = 0; i < files.length; i += 1) {
        const entry = files[i];
        if (typeof entry !== "string" || entry.trim().length === 0) {
          onFail(`${histPath}.evidenceFiles[${String(i)}]`, "expected a non empty path");
        }
        evidenceSet.add(entry.trim());
      }
    }
  }

  const queuedActionIds: number[] = [];
  if (Array.isArray(rawNetworkRecord.queuedActionIds)) {
    for (const item of rawNetworkRecord.queuedActionIds) {
      if (typeof item === "number" && Number.isInteger(item) && item >= 0) {
        queuedActionIds.push(item);
      }
    }
  }

  const queuedActions: string[] = [];
  if (Array.isArray(rawNetworkRecord.queuedActions)) {
    for (const item of rawNetworkRecord.queuedActions) {
      if (typeof item === "string" && item.length > 0) {
        queuedActions.push(item);
      }
    }
  }

  return {
    txHashes: Array.from(txSet),
    evidenceFiles: Array.from(evidenceSet),
    queuedActionIds,
    queuedActions,
  };
}

export function buildRetiredRouterWarning(
  chainKey: ChainKey,
  router: string,
  lifecycle: DeploymentLifecycle,
): RouterLifecycleWarning | null {
  if (lifecycle.status === "active") return null;
  const deprecatedAt = lifecycle.deprecatedAt ?? "unknown";
  const reason = lifecycle.reason ?? "Deployment has been retired.";
  const successor = lifecycle.successor ?? null;

  const successorGuidance =
    successor !== null
      ? successor.manifest !== undefined
        ? `Use successor router ${successor.router} on ${successor.chain} (manifest: ${successor.manifest}).`
        : `Use successor router ${successor.router} on ${successor.chain}.`
      : "No successor deployment is linked yet; halt activation and consult operator documentation.";

  return {
    status: lifecycle.status,
    chain: chainKey,
    retiredRouter: router,
    deprecatedAt,
    reason,
    successor,
    message: `Router ${router} on ${chainKey} is ${lifecycle.status} since ${deprecatedAt}: ${reason} ${successorGuidance}`,
  };
}

/**
 * Mark a network record inside a raw deployment manifest as `deprecated` or `archived` while
 * preserving every existing field, `activation` proof, transaction hash, and queued action entry.
 */
export function deprecateDeploymentManifest(
  rawManifest: Record<string, unknown>,
  options: DeprecateManifestOptions,
  onFail: (fieldPath: string, reason: string) => never,
): Record<string, unknown> {
  if (
    typeof rawManifest.networks !== "object" ||
    rawManifest.networks === null ||
    Array.isArray(rawManifest.networks)
  ) {
    onFail("$.networks", "expected an object");
  }
  const networks = rawManifest.networks as Record<string, unknown>;
  const targetRaw = networks[options.chain];
  if (typeof targetRaw !== "object" || targetRaw === null || Array.isArray(targetRaw)) {
    onFail(`$.networks.${options.chain}`, "network entry not found in manifest");
  }
  const targetRec = targetRaw as Record<string, unknown>;
  const router = validateRouterForChain(
    targetRec.router,
    options.chain,
    `$.networks.${options.chain}.router`,
    onFail,
  );

  const beforeEvidence = extractHistoricalEvidence(
    targetRec,
    `$.networks.${options.chain}`,
    onFail,
  );

  const nextStatus = options.status ?? "archived";
  const lifecycleInput: Record<string, unknown> = {
    status: nextStatus,
    deprecatedAt: options.deprecatedAt,
    reason: options.reason,
    ...(options.successor !== undefined ? { successor: options.successor } : {}),
  };
  const validatedLifecycle = parseDeploymentLifecycle(
    lifecycleInput,
    options.chain,
    router,
    `$.networks.${options.chain}.lifecycle`,
    onFail,
  );

  const updatedNetwork: Record<string, unknown> = {
    ...targetRec,
    lifecycle: validatedLifecycle,
    historicalEvidence: {
      txHashes: beforeEvidence.txHashes,
      evidenceFiles: beforeEvidence.evidenceFiles,
    },
  };

  const afterEvidence = extractHistoricalEvidence(
    updatedNetwork,
    `$.networks.${options.chain}`,
    onFail,
  );
  if (
    afterEvidence.txHashes.length < beforeEvidence.txHashes.length ||
    afterEvidence.evidenceFiles.length < beforeEvidence.evidenceFiles.length
  ) {
    onFail(
      `$.networks.${options.chain}.historicalEvidence`,
      "deprecation must never discard historical transaction evidence",
    );
  }

  return {
    ...rawManifest,
    networks: {
      ...networks,
      [options.chain]: updatedNetwork,
    },
  };
}
