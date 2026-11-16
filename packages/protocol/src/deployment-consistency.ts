/**
 * Read-only cross-repository deployment-copy consistency checks.
 *
 * Hyperion keeps its canonical deployment manifest in `stellarhyperion-contracts` while both
 * `stellarhyperion-backend` and `stellarhyperion-frontend` carry pinned copies so API verification,
 * indexing, and browser route quoting agree on contract IDs, SAC addresses, decimal widths, flow
 * ceilings, and code hashes. Comparing those copies at explicit revisions catches stale syncs,
 * accidental use of archived manifests (`deployments/archive/*`), and unvalidated rail drift
 * without ever rewriting consumer repositories as a side effect.
 */
import type { ChainKey } from "./chains.js";
import { deployedChains, isStellarDeployment, parseDeploymentSet } from "./deployments.js";
import { ROUTE_KINDS, RouteKind } from "./routes.js";

const VALIDATED_ACTIVE_ROUTES: readonly RouteKind[] = [RouteKind.Cctp, RouteKind.AxelarIts];

export type RepositoryRole = "contracts" | "backend" | "frontend";

export const DEFAULT_REPOSITORY_NAMES: Readonly<Record<RepositoryRole, string>> = {
  contracts: "stellarhyperion-contracts",
  backend: "stellarhyperion-backend",
  frontend: "stellarhyperion-frontend",
};

export type ManifestClassification = "active" | "archived";

export interface DeploymentCopySnapshot {
  readonly role: RepositoryRole;
  readonly repository?: string | undefined;
  /** Explicit commit SHA, tag, or revision identifier pinned for this comparison. */
  readonly revision: string;
  readonly path: string;
  readonly classification?: ManifestClassification | undefined;
  readonly content: unknown;
}

export interface ArchivedManifestSnapshot {
  readonly archiveId: string;
  readonly path: string;
  readonly revision?: string | undefined;
  readonly content: unknown;
}

export type CopyMismatchKind =
  | "value-mismatch"
  | "missing-in-consumer"
  | "extra-in-consumer"
  | "invalid-consumer-schema"
  | "archived-manifest-in-consumer"
  | "gated-network-drift";

export interface DeploymentCopyMismatch {
  readonly kind: CopyMismatchKind;
  readonly fieldPath: string;
  readonly canonicalRepository: string;
  readonly canonicalRevision: string;
  /** Consumer repository that owns the divergent copy and needs a separate sync operation. */
  readonly owningRepository: string;
  readonly owningRole: Exclude<RepositoryRole, "contracts">;
  readonly consumerRevision: string;
  readonly consumerPath: string;
  readonly canonicalValue: unknown;
  readonly consumerValue: unknown;
  readonly matchedArchiveId?: string | undefined;
  readonly detail: string;
}

export interface ArchivedRecordSummary {
  readonly archiveId: string;
  readonly path: string;
  readonly classification: "archived";
  readonly generatedAt: string;
  readonly chains: readonly ChainKey[];
  readonly routers: Readonly<Partial<Record<ChainKey, string>>>;
}

export interface ConsumerCopyAssessment {
  readonly role: Exclude<RepositoryRole, "contracts">;
  readonly repository: string;
  readonly revision: string;
  readonly path: string;
  readonly schemaValid: boolean;
  readonly matchesArchivedId: string | null;
  readonly consistent: boolean;
  readonly mismatchCount: number;
  readonly mismatches: readonly DeploymentCopyMismatch[];
}

export interface DeploymentCopyConsistencyReport {
  /** Always true: comparison never modifies canonical or consumer files. */
  readonly readOnly: true;
  /** Always false: consumer updates require a separate explicit sync operation. */
  readonly consumerRewritePermitted: false;
  readonly consistent: boolean;
  readonly validationGate: "active-validated" | "gated-unvalidated";
  readonly canonical: {
    readonly role: "contracts";
    readonly repository: string;
    readonly revision: string;
    readonly path: string;
    readonly classification: "active";
    readonly generatedAt: string;
    readonly chains: readonly ChainKey[];
  };
  readonly archivedCatalog: readonly ArchivedRecordSummary[];
  readonly consumers: readonly ConsumerCopyAssessment[];
  readonly mismatches: readonly DeploymentCopyMismatch[];
}

export interface CompareDeploymentCopiesInput {
  readonly canonical: DeploymentCopySnapshot;
  readonly consumers: readonly DeploymentCopySnapshot[];
  readonly archived?: readonly ArchivedManifestSnapshot[] | undefined;
}

export class ConsistencyFormatError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`invalid deployment consistency input at ${path}: ${detail}`);
    this.name = "ConsistencyFormatError";
    this.path = path;
  }
}

function fail(path: string, detail: string): never {
  throw new ConsistencyFormatError(path, detail);
}

function assertNoSecrets(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (/\bS[A-Z2-7]{55}\b/.test(value)) {
      fail(path, "secret Stellar seed material is forbidden in deployment manifests");
    }
    if (/(?:private[_-]?key|secret[_-]?key|mnemonic)\s*[:=]/i.test(value)) {
      fail(path, "secret key material is forbidden in deployment manifests");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoSecrets(value[i], `${path}[${String(i)}]`);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}

function isArchivedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/archive/") || normalized.startsWith("archive/");
}

function assertRevision(revision: string, path: string): string {
  const trimmed = revision.trim();
  if (trimmed.length === 0) {
    fail(path, "explicit non-empty revision is required");
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatShortValue(value: unknown): string {
  if (value === undefined) return "<missing>";
  const encoded = JSON.stringify(value);
  if (encoded.length <= 96) return encoded;
  return `${encoded.slice(0, 93)}...`;
}

function diffJsonValues(
  canonicalVal: unknown,
  consumerVal: unknown,
  fieldPath: string,
  ctx: {
    readonly canonicalRepository: string;
    readonly canonicalRevision: string;
    readonly owningRepository: string;
    readonly owningRole: Exclude<RepositoryRole, "contracts">;
    readonly consumerRevision: string;
    readonly consumerPath: string;
  },
  out: DeploymentCopyMismatch[],
): void {
  if (Object.is(canonicalVal, consumerVal)) {
    return;
  }

  if (Array.isArray(canonicalVal) && Array.isArray(consumerVal)) {
    const maxLen = Math.max(canonicalVal.length, consumerVal.length);
    for (let i = 0; i < maxLen; i += 1) {
      const elemPath = `${fieldPath}[${String(i)}]`;
      if (i >= consumerVal.length) {
        out.push({
          kind: "missing-in-consumer",
          fieldPath: elemPath,
          canonicalRepository: ctx.canonicalRepository,
          canonicalRevision: ctx.canonicalRevision,
          owningRepository: ctx.owningRepository,
          owningRole: ctx.owningRole,
          consumerRevision: ctx.consumerRevision,
          consumerPath: ctx.consumerPath,
          canonicalValue: canonicalVal[i],
          consumerValue: undefined,
          detail: `${ctx.owningRepository}@${ctx.consumerRevision} is missing ${elemPath} (canonical=${formatShortValue(canonicalVal[i])})`,
        });
      } else if (i >= canonicalVal.length) {
        out.push({
          kind: "extra-in-consumer",
          fieldPath: elemPath,
          canonicalRepository: ctx.canonicalRepository,
          canonicalRevision: ctx.canonicalRevision,
          owningRepository: ctx.owningRepository,
          owningRole: ctx.owningRole,
          consumerRevision: ctx.consumerRevision,
          consumerPath: ctx.consumerPath,
          canonicalValue: undefined,
          consumerValue: consumerVal[i],
          detail: `${ctx.owningRepository}@${ctx.consumerRevision} carries unexpected array element ${elemPath} (${formatShortValue(consumerVal[i])})`,
        });
      } else {
        diffJsonValues(canonicalVal[i], consumerVal[i], elemPath, ctx, out);
      }
    }
    return;
  }

  if (isPlainObject(canonicalVal) && isPlainObject(consumerVal)) {
    const allKeys = [
      ...new Set([...Object.keys(canonicalVal), ...Object.keys(consumerVal)]),
    ].sort();
    for (const key of allKeys) {
      const childPath = `${fieldPath}.${key}`;
      const hasCanon = Object.prototype.hasOwnProperty.call(canonicalVal, key);
      const hasCons = Object.prototype.hasOwnProperty.call(consumerVal, key);
      if (hasCanon && !hasCons) {
        out.push({
          kind: "missing-in-consumer",
          fieldPath: childPath,
          canonicalRepository: ctx.canonicalRepository,
          canonicalRevision: ctx.canonicalRevision,
          owningRepository: ctx.owningRepository,
          owningRole: ctx.owningRole,
          consumerRevision: ctx.consumerRevision,
          consumerPath: ctx.consumerPath,
          canonicalValue: canonicalVal[key],
          consumerValue: undefined,
          detail: `${ctx.owningRepository}@${ctx.consumerRevision} is missing ${childPath} (canonical=${formatShortValue(canonicalVal[key])})`,
        });
      } else if (!hasCanon && hasCons) {
        out.push({
          kind: "extra-in-consumer",
          fieldPath: childPath,
          canonicalRepository: ctx.canonicalRepository,
          canonicalRevision: ctx.canonicalRevision,
          owningRepository: ctx.owningRepository,
          owningRole: ctx.owningRole,
          consumerRevision: ctx.consumerRevision,
          consumerPath: ctx.consumerPath,
          canonicalValue: undefined,
          consumerValue: consumerVal[key],
          detail: `${ctx.owningRepository}@${ctx.consumerRevision} carries unrecorded field ${childPath} (${formatShortValue(consumerVal[key])})`,
        });
      } else {
        diffJsonValues(canonicalVal[key], consumerVal[key], childPath, ctx, out);
      }
    }
    return;
  }

  out.push({
    kind: "value-mismatch",
    fieldPath,
    canonicalRepository: ctx.canonicalRepository,
    canonicalRevision: ctx.canonicalRevision,
    owningRepository: ctx.owningRepository,
    owningRole: ctx.owningRole,
    consumerRevision: ctx.consumerRevision,
    consumerPath: ctx.consumerPath,
    canonicalValue: canonicalVal,
    consumerValue: consumerVal,
    detail: `${ctx.owningRepository}@${ctx.consumerRevision} disagrees at ${fieldPath}: canonical=${formatShortValue(canonicalVal)}, consumer=${formatShortValue(consumerVal)}`,
  });
}

function inspectValidationGate(
  rawSets: readonly unknown[],
): "active-validated" | "gated-unvalidated" {
  for (const candidate of rawSets) {
    try {
      const parsed = parseDeploymentSet(candidate);
      for (const chainKey of deployedChains(parsed)) {
        if (chainKey !== "stellar-testnet") {
          return "gated-unvalidated";
        }
        const dep = parsed.networks[chainKey];
        if (dep !== undefined && isStellarDeployment(dep)) {
          for (const kind of ROUTE_KINDS) {
            if (dep.adapters[kind] !== undefined && !VALIDATED_ACTIVE_ROUTES.includes(kind)) {
              return "gated-unvalidated";
            }
          }
          for (const tok of Object.values(dep.tokens)) {
            for (const r of tok.routes) {
              if (!VALIDATED_ACTIVE_ROUTES.includes(r)) {
                return "gated-unvalidated";
              }
            }
          }
        }
      }
    } catch {
      // Invalid consumer schemas are reported separately as `invalid-consumer-schema`.
    }
  }
  return "active-validated";
}

interface ParsedArchiveInternal {
  readonly summary: ArchivedRecordSummary;
  readonly wasmHashesByChain: Readonly<Partial<Record<ChainKey, Readonly<Record<string, string>>>>>;
}

function buildArchivedCatalog(
  archivedInputs: readonly ArchivedManifestSnapshot[],
  activeRouters: Readonly<Partial<Record<ChainKey, string>>>,
): readonly ParsedArchiveInternal[] {
  const out: ParsedArchiveInternal[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < archivedInputs.length; i += 1) {
    const item = archivedInputs[i];
    if (item === undefined) continue;
    const aPath = `$.archived[${String(i)}]`;
    assertNoSecrets(item.content, `${aPath}.content`);
    if (item.archiveId.trim().length === 0) {
      fail(`${aPath}.archiveId`, "archiveId must be non-empty");
    }
    if (seenIds.has(item.archiveId)) {
      fail(`${aPath}.archiveId`, `duplicate archiveId "${item.archiveId}"`);
    }
    seenIds.add(item.archiveId);

    const parsed = parseDeploymentSet(item.content);
    const chains = deployedChains(parsed);
    const routers: Partial<Record<ChainKey, string>> = {};
    const wasmHashesByChain: Partial<Record<ChainKey, Record<string, string>>> = {};

    for (const key of chains) {
      const dep = parsed.networks[key];
      if (dep === undefined) continue;
      if (activeRouters[key] !== undefined && dep.router === activeRouters[key]) {
        fail(
          `${aPath}.content.networks.${key}.router`,
          `archived record "${item.archiveId}" shares active router ${dep.router} on "${key}"; active manifests do not belong in archive/`,
        );
      }
      routers[key] = dep.router;
      if (isStellarDeployment(dep)) {
        wasmHashesByChain[key] = { ...dep.wasmHashes };
      }
    }

    out.push({
      summary: {
        archiveId: item.archiveId,
        path: item.path,
        classification: "archived",
        generatedAt: parsed.generatedAt,
        chains,
        routers,
      },
      wasmHashesByChain,
    });
  }

  return out;
}

/**
 * Compare canonical `contracts` deployment data with `backend` and `frontend` copies at explicit
 * revisions without mutating any input or consumer file.
 */
export function compareDeploymentCopies(
  input: CompareDeploymentCopiesInput,
): DeploymentCopyConsistencyReport {
  assertNoSecrets(input.canonical.content, "$.canonical.content");
  if (input.canonical.role !== "contracts") {
    fail("$.canonical.role", 'canonical source role must be "contracts"');
  }
  if (input.canonical.classification === "archived" || isArchivedPath(input.canonical.path)) {
    fail(
      "$.canonical.path",
      `archived deployment record "${input.canonical.path}" cannot be used as the active canonical manifest`,
    );
  }
  if (input.consumers.length === 0) {
    fail("$.consumers", "at least one consumer copy (backend or frontend) is required");
  }

  const canonicalRepo = input.canonical.repository ?? DEFAULT_REPOSITORY_NAMES.contracts;
  const canonicalRev = assertRevision(input.canonical.revision, "$.canonical.revision");
  const canonicalSet = parseDeploymentSet(input.canonical.content);
  const canonicalChains = deployedChains(canonicalSet);

  const activeRouters: Partial<Record<ChainKey, string>> = {};
  for (const key of canonicalChains) {
    const dep = canonicalSet.networks[key];
    if (dep !== undefined) {
      activeRouters[key] = dep.router;
    }
  }

  const archivedInternals = buildArchivedCatalog(input.archived ?? [], activeRouters);
  const archivedCatalog = archivedInternals.map((a) => a.summary);

  const consumerAssessments: ConsumerCopyAssessment[] = [];
  const allMismatches: DeploymentCopyMismatch[] = [];

  for (let i = 0; i < input.consumers.length; i += 1) {
    const consumer = input.consumers[i];
    if (consumer === undefined) continue;
    const cPath = `$.consumers[${String(i)}]`;
    if (consumer.role === "contracts") {
      fail(`${cPath}.role`, 'consumer role must be "backend" or "frontend", not "contracts"');
    }
    assertNoSecrets(consumer.content, `${cPath}.content`);
    const owningRole = consumer.role;
    const owningRepository = consumer.repository ?? DEFAULT_REPOSITORY_NAMES[owningRole];
    const consumerRevision = assertRevision(consumer.revision, `${cPath}.revision`);

    const mismatches: DeploymentCopyMismatch[] = [];
    let schemaValid = true;
    let matchesArchivedId: string | null = null;

    if (consumer.classification === "archived" || isArchivedPath(consumer.path)) {
      matchesArchivedId = consumer.path;
      mismatches.push({
        kind: "archived-manifest-in-consumer",
        fieldPath: "$",
        canonicalRepository: canonicalRepo,
        canonicalRevision: canonicalRev,
        owningRepository,
        owningRole,
        consumerRevision,
        consumerPath: consumer.path,
        canonicalValue: input.canonical.path,
        consumerValue: consumer.path,
        matchedArchiveId: consumer.path,
        detail: `${owningRepository}@${consumerRevision} points at an archived manifest path "${consumer.path}" instead of the active deployment manifest`,
      });
    }

    let parsedConsumer: ReturnType<typeof parseDeploymentSet> | undefined;
    try {
      parsedConsumer = parseDeploymentSet(consumer.content);
    } catch (err) {
      schemaValid = false;
      mismatches.push({
        kind: "invalid-consumer-schema",
        fieldPath: "$",
        canonicalRepository: canonicalRepo,
        canonicalRevision: canonicalRev,
        owningRepository,
        owningRole,
        consumerRevision,
        consumerPath: consumer.path,
        canonicalValue: "valid DeploymentSet",
        consumerValue: err instanceof Error ? err.message : String(err),
        detail: `${owningRepository}@${consumerRevision} failed DeploymentSet schema validation: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Check if the consumer copy matches any archived deployment record (router or generatedAt).
    if (parsedConsumer !== undefined) {
      for (const arch of archivedInternals) {
        for (const chainKey of deployedChains(parsedConsumer)) {
          const consDep = parsedConsumer.networks[chainKey];
          const archRouter = arch.summary.routers[chainKey];
          if (consDep !== undefined && archRouter !== undefined && consDep.router === archRouter) {
            matchesArchivedId = arch.summary.archiveId;
            mismatches.push({
              kind: "archived-manifest-in-consumer",
              fieldPath: `$.networks.${chainKey}.router`,
              canonicalRepository: canonicalRepo,
              canonicalRevision: canonicalRev,
              owningRepository,
              owningRole,
              consumerRevision,
              consumerPath: consumer.path,
              canonicalValue: activeRouters[chainKey] ?? null,
              consumerValue: consDep.router,
              matchedArchiveId: arch.summary.archiveId,
              detail: `${owningRepository}@${consumerRevision} carries archived router ${consDep.router} from "${arch.summary.archiveId}" rather than active router ${activeRouters[chainKey] ?? "<none>"}`,
            });
          }
        }
      }

      // Flag any unvalidated/gated network introduced in consumer copy.
      for (const chainKey of deployedChains(parsedConsumer)) {
        if (chainKey !== "stellar-testnet" && canonicalSet.networks[chainKey] === undefined) {
          mismatches.push({
            kind: "gated-network-drift",
            fieldPath: `$.networks.${chainKey}`,
            canonicalRepository: canonicalRepo,
            canonicalRevision: canonicalRev,
            owningRepository,
            owningRole,
            consumerRevision,
            consumerPath: consumer.path,
            canonicalValue: undefined,
            consumerValue: chainKey,
            detail: `${owningRepository}@${consumerRevision} enables gated/unvalidated network "${chainKey}" absent from canonical manifest`,
          });
        }
      }
    }

    // Deep structural diff across every JSON field path.
    diffJsonValues(
      input.canonical.content,
      consumer.content,
      "$",
      {
        canonicalRepository: canonicalRepo,
        canonicalRevision: canonicalRev,
        owningRepository,
        owningRole,
        consumerRevision,
        consumerPath: consumer.path,
      },
      mismatches,
    );

    allMismatches.push(...mismatches);
    consumerAssessments.push({
      role: owningRole,
      repository: owningRepository,
      revision: consumerRevision,
      path: consumer.path,
      schemaValid,
      matchesArchivedId,
      consistent: mismatches.length === 0,
      mismatchCount: mismatches.length,
      mismatches,
    });
  }

  const validationGate = inspectValidationGate([
    input.canonical.content,
    ...input.consumers.map((c) => c.content),
  ]);

  return {
    readOnly: true,
    consumerRewritePermitted: false,
    consistent: allMismatches.length === 0,
    validationGate,
    canonical: {
      role: "contracts",
      repository: canonicalRepo,
      revision: canonicalRev,
      path: input.canonical.path,
      classification: "active",
      generatedAt: canonicalSet.generatedAt,
      chains: canonicalChains,
    },
    archivedCatalog,
    consumers: consumerAssessments,
    mismatches: allMismatches,
  };
}

/**
 * Format a deterministic, secret-free cross-repository deployment consistency report.
 */
export function formatDeploymentConsistencyReport(report: DeploymentCopyConsistencyReport): string {
  const lines: string[] = [
    `Cross-Repository Deployment Consistency Report`,
    `Mode: READ-ONLY (readOnly=${String(report.readOnly)}, consumerRewritePermitted=${String(report.consumerRewritePermitted)}, gate=${report.validationGate})`,
    `Canonical: ${report.canonical.repository}@${report.canonical.revision} (${report.canonical.path}) [classification=${report.canonical.classification}]`,
    `Archived records distinguished: ${String(report.archivedCatalog.length)}${report.archivedCatalog.length > 0 ? ` (${report.archivedCatalog.map((a) => a.archiveId).join(", ")})` : ""}`,
    `Overall status: ${report.consistent ? "CONSISTENT" : `DIVERGENT (${String(report.mismatches.length)} mismatch(es))`}`,
  ];

  for (const cons of report.consumers) {
    lines.push("");
    lines.push(
      `[${cons.consistent ? "OK" : "MISMATCH"}] ${cons.role} -> ${cons.repository}@${cons.revision} (${cons.path})`,
    );
    if (cons.matchesArchivedId !== null) {
      lines.push(`  archived record detected in active consumer: ${cons.matchesArchivedId}`);
    }
    for (const m of cons.mismatches) {
      lines.push(
        `  - [${m.kind}] ${m.fieldPath} (owner=${m.owningRepository}@${m.consumerRevision}): canonical=${formatShortValue(m.canonicalValue)} vs consumer=${formatShortValue(m.consumerValue)}`,
      );
    }
  }

  return lines.join("\n");
}
