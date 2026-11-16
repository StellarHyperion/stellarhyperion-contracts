/**
 * Canonical deployment-manifest comparison helpers.
 *
 * Compares two parsed `DeploymentSet` manifests across networks, routers, governance authorities,
 * rail adapters, WASM hashes, token identities, and active route lanes.Separating metadata-only
 * refreshes from activation-parameter updates and trust-critical authority/contract changes lets CI
 * and release tooling gate upgrades deterministically.
 */
import type { ChainKey } from "../chains.js";
import type {
  Deployment,
  DeploymentSet,
  EvmTokenDeployment,
  StellarTokenDeployment,
} from "../deployments.js";
import { isEvmDeployment, parseDeploymentSet } from "../deployments.js";
import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS, ROUTE_SLUGS } from "../routes.js";

/** Impact classification of a manifest field difference. */
export type DeploymentChangeCategory = "metadata" | "activation" | "trust";

/** Lifecycle status of an individual `(chain, token, route)` lane between two manifests. */
export type LaneDiffStatus = "added" | "deleted" | "renamed" | "modified";

/** Single field-level difference between two deployment sets. */
export interface DeploymentFieldChange {
  readonly chain: ChainKey | null;
  readonly path: string;
  readonly category: DeploymentChangeCategory;
  readonly before: string | number | null;
  readonly after: string | number | null;
  readonly summary: string;
}

/** Explicit representation of added, deleted, renamed, or modified token-route lanes. */
export interface DeploymentLaneDiff {
  readonly status: LaneDiffStatus;
  readonly chain: ChainKey;
  readonly route: RouteKind;
  readonly routeSlug: string;
  readonly previousSymbol: string | null;
  readonly currentSymbol: string | null;
  readonly tokenIdentity: string;
  readonly detail: string;
}

/** Deterministic diff report between two `DeploymentSet` manifests. */
export interface DeploymentComparisonReport {
  readonly identical: boolean;
  readonly metadataOnly: boolean;
  readonly hasTrustChanges: boolean;
  readonly hasActivationChanges: boolean;
  readonly highestImpact: "none" | DeploymentChangeCategory;
  readonly changes: readonly DeploymentFieldChange[];
  readonly trustChanges: readonly DeploymentFieldChange[];
  readonly activationChanges: readonly DeploymentFieldChange[];
  readonly metadataChanges: readonly DeploymentFieldChange[];
  readonly laneDiffs: readonly DeploymentLaneDiff[];
}

function asciiCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedKeys(record: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(record).sort(asciiCompare);
}

function sortedUniqueRoutes(routes: readonly RouteKind[]): readonly RouteKind[] {
  return [...new Set(routes)].sort((a, b) => a - b);
}

function tokenIdentityFor(
  deployment: Deployment,
  token: EvmTokenDeployment | StellarTokenDeployment,
): string {
  if ("address" in token) {
    return `evm:${deployment.chain}:${token.address.toLowerCase()}`;
  }
  return `stellar:${deployment.chain}:${token.sacId}:${token.code}:${token.issuer}`;
}

function pushIfChanged(
  changes: DeploymentFieldChange[],
  chain: ChainKey | null,
  path: string,
  category: DeploymentChangeCategory,
  before: string | number | null,
  after: string | number | null,
  summary: string,
): void {
  if (before !== after) {
    changes.push({ chain, path, category, before, after, summary });
  }
}

function normalizeEvmAddress(address: string): string {
  return address.toLowerCase();
}

function compareNetworkDeployments(
  chain: ChainKey,
  before: Deployment,
  after: Deployment,
  changes: DeploymentFieldChange[],
  laneDiffs: DeploymentLaneDiff[],
): void {
  const basePath = `$.networks.${chain}`;

  if (before.family !== after.family) {
    changes.push({
      chain,
      path: `${basePath}.family`,
      category: "trust",
      before: before.family,
      after: after.family,
      summary: `network "${chain}" changed chain family from ${before.family} to ${after.family}`,
    });
    return;
  }

  const normAddr = (addr: string): string =>
    before.family === "evm" ? normalizeEvmAddress(addr) : addr;

  if (isEvmDeployment(before) && isEvmDeployment(after)) {
    pushIfChanged(
      changes,
      chain,
      `${basePath}.chainId`,
      "trust",
      before.chainId,
      after.chainId,
      `EVM chainId changed on ${chain}`,
    );
    pushIfChanged(
      changes,
      chain,
      `${basePath}.deployedAt.blockNumber`,
      "metadata",
      before.deployedAt.blockNumber,
      after.deployedAt.blockNumber,
      `recorded deployment blockNumber updated on ${chain}`,
    );
    pushIfChanged(
      changes,
      chain,
      `${basePath}.deployedAt.timestamp`,
      "metadata",
      before.deployedAt.timestamp,
      after.deployedAt.timestamp,
      `recorded deployment timestamp updated on ${chain}`,
    );
    pushIfChanged(
      changes,
      chain,
      `${basePath}.deployedAt.txHash`,
      "metadata",
      before.deployedAt.txHash.toLowerCase(),
      after.deployedAt.txHash.toLowerCase(),
      `recorded deployment txHash updated on ${chain}`,
    );
  } else if (!isEvmDeployment(before) && !isEvmDeployment(after)) {
    pushIfChanged(
      changes,
      chain,
      `${basePath}.networkPassphrase`,
      "trust",
      before.networkPassphrase,
      after.networkPassphrase,
      `Stellar networkPassphrase changed on ${chain}`,
    );
    pushIfChanged(
      changes,
      chain,
      `${basePath}.deployedAt.ledger`,
      "metadata",
      before.deployedAt.ledger,
      after.deployedAt.ledger,
      `recorded deployment ledger updated on ${chain}`,
    );
    pushIfChanged(
      changes,
      chain,
      `${basePath}.deployedAt.timestamp`,
      "metadata",
      before.deployedAt.timestamp,
      after.deployedAt.timestamp,
      `recorded deployment timestamp updated on ${chain}`,
    );

    const wasmKeys = new Set([...sortedKeys(before.wasmHashes), ...sortedKeys(after.wasmHashes)]);
    for (const key of [...wasmKeys].sort(asciiCompare)) {
      const prevHash = before.wasmHashes[key] ?? null;
      const nextHash = after.wasmHashes[key] ?? null;
      pushIfChanged(
        changes,
        chain,
        `${basePath}.wasmHashes.${key}`,
        "trust",
        prevHash,
        nextHash,
        `Soroban WASM hash "${key}" changed on ${chain}`,
      );
    }
  }

  pushIfChanged(
    changes,
    chain,
    `${basePath}.router`,
    "trust",
    normAddr(before.router),
    normAddr(after.router),
    `router contract address changed on ${chain}`,
  );
  pushIfChanged(
    changes,
    chain,
    `${basePath}.admin`,
    "trust",
    normAddr(before.admin),
    normAddr(after.admin),
    `admin authority changed on ${chain}`,
  );
  pushIfChanged(
    changes,
    chain,
    `${basePath}.guardian`,
    "trust",
    normAddr(before.guardian),
    normAddr(after.guardian),
    `guardian authority changed on ${chain}`,
  );
  pushIfChanged(
    changes,
    chain,
    `${basePath}.treasury`,
    "trust",
    normAddr(before.treasury),
    normAddr(after.treasury),
    `treasury recipient changed on ${chain}`,
  );
  pushIfChanged(
    changes,
    chain,
    `${basePath}.timelockDelay`,
    "trust",
    before.timelockDelay,
    after.timelockDelay,
    `timelockDelay changed on ${chain}`,
  );
  pushIfChanged(
    changes,
    chain,
    `${basePath}.feeBps`,
    "activation",
    before.feeBps,
    after.feeBps,
    `protocol feeBps changed on ${chain}`,
  );
  pushIfChanged(
    changes,
    chain,
    `${basePath}.flowWindow`,
    "activation",
    before.flowWindow,
    after.flowWindow,
    `sliding flowWindow changed on ${chain}`,
  );
  pushIfChanged(
    changes,
    chain,
    `${basePath}.commit`,
    "metadata",
    before.commit,
    after.commit,
    `recorded build commit updated on ${chain}`,
  );

  // Compare rail adapters in canonical RouteKind order.
  const changedAdapters = new Set<RouteKind>();
  for (const route of ROUTE_KINDS) {
    const slug = ROUTE_SLUGS[route];
    const prevAdapter =
      before.adapters[route] === undefined ? null : normAddr(before.adapters[route]);
    const nextAdapter =
      after.adapters[route] === undefined ? null : normAddr(after.adapters[route]);
    if (prevAdapter !== nextAdapter) {
      changedAdapters.add(route);
      changes.push({
        chain,
        path: `${basePath}.adapters.${slug}`,
        category: "trust",
        before: prevAdapter,
        after: nextAdapter,
        summary: `adapter for rail "${slug}" changed on ${chain}`,
      });
    }
  }

  // Compare tokens & detect symbol renames where underlying canonical token identity matches.
  const beforeSymbols = sortedKeys(before.tokens);
  const afterSymbols = sortedKeys(after.tokens);
  const beforeSymbolSet = new Set(beforeSymbols);
  const afterSymbolSet = new Set(afterSymbols);

  const removedOnly = beforeSymbols.filter((s) => !afterSymbolSet.has(s));
  const addedOnly = afterSymbols.filter((s) => !beforeSymbolSet.has(s));

  const renamedBeforeToAfter = new Map<string, string>();
  const matchedAfter = new Set<string>();

  for (const prevSym of removedOnly) {
    const prevTok = before.tokens[prevSym];
    if (prevTok === undefined) continue;
    const prevId = tokenIdentityFor(before, prevTok);
    for (const nextSym of addedOnly) {
      if (matchedAfter.has(nextSym)) continue;
      const nextTok = after.tokens[nextSym];
      if (nextTok === undefined) continue;
      if (tokenIdentityFor(after, nextTok) === prevId) {
        renamedBeforeToAfter.set(prevSym, nextSym);
        matchedAfter.add(nextSym);
        break;
      }
    }
  }

  // 1. Renamed token entries.
  for (const [prevSym, nextSym] of renamedBeforeToAfter.entries()) {
    const prevTok = before.tokens[prevSym];
    const nextTok = after.tokens[nextSym];
    if (prevTok === undefined || nextTok === undefined) continue;
    const identity = tokenIdentityFor(after, nextTok);

    changes.push({
      chain,
      path: `${basePath}.tokens.${prevSym}`,
      category: "activation",
      before: prevSym,
      after: nextSym,
      summary: `token "${prevSym}" renamed to "${nextSym}" on ${chain} (${identity})`,
    });

    pushIfChanged(
      changes,
      chain,
      `${basePath}.tokens.${nextSym}.decimals`,
      "trust",
      prevTok.decimals,
      nextTok.decimals,
      `token "${nextSym}" decimals changed on ${chain}`,
    );
    pushIfChanged(
      changes,
      chain,
      `${basePath}.tokens.${nextSym}.flowLimit`,
      "activation",
      prevTok.flowLimit,
      nextTok.flowLimit,
      `token "${nextSym}" flowLimit changed on ${chain}`,
    );

    const prevRoutes = new Set(sortedUniqueRoutes(prevTok.routes));
    const nextRoutes = new Set(sortedUniqueRoutes(nextTok.routes));
    for (const route of ROUTE_KINDS) {
      const slug = ROUTE_SLUGS[route];
      const had = prevRoutes.has(route);
      const has = nextRoutes.has(route);
      if (had && has) {
        laneDiffs.push({
          status: "renamed",
          chain,
          route,
          routeSlug: slug,
          previousSymbol: prevSym,
          currentSymbol: nextSym,
          tokenIdentity: identity,
          detail: `lane ${chain}:${prevSym}->${nextSym} over ${slug} renamed with identical token contract`,
        });
      } else if (had && !has) {
        laneDiffs.push({
          status: "deleted",
          chain,
          route,
          routeSlug: slug,
          previousSymbol: prevSym,
          currentSymbol: null,
          tokenIdentity: identity,
          detail: `lane ${chain}:${prevSym} over ${slug} removed during rename to ${nextSym}`,
        });
      } else if (!had && has) {
        laneDiffs.push({
          status: "added",
          chain,
          route,
          routeSlug: slug,
          previousSymbol: null,
          currentSymbol: nextSym,
          tokenIdentity: identity,
          detail: `lane ${chain}:${nextSym} over ${slug} added during rename from ${prevSym}`,
        });
      }
    }
  }

  // 2. Truly deleted token entries.
  for (const prevSym of removedOnly) {
    if (renamedBeforeToAfter.has(prevSym)) continue;
    const prevTok = before.tokens[prevSym];
    if (prevTok === undefined) continue;
    const identity = tokenIdentityFor(before, prevTok);
    changes.push({
      chain,
      path: `${basePath}.tokens.${prevSym}`,
      category: "trust",
      before: identity,
      after: null,
      summary: `token "${prevSym}" removed from ${chain}`,
    });
    for (const route of sortedUniqueRoutes(prevTok.routes)) {
      const slug = ROUTE_SLUGS[route];
      laneDiffs.push({
        status: "deleted",
        chain,
        route,
        routeSlug: slug,
        previousSymbol: prevSym,
        currentSymbol: null,
        tokenIdentity: identity,
        detail: `lane ${chain}:${prevSym} over ${slug} deleted`,
      });
    }
  }

  // 3. Truly added token entries.
  for (const nextSym of addedOnly) {
    if (matchedAfter.has(nextSym)) continue;
    const nextTok = after.tokens[nextSym];
    if (nextTok === undefined) continue;
    const identity = tokenIdentityFor(after, nextTok);
    changes.push({
      chain,
      path: `${basePath}.tokens.${nextSym}`,
      category: "trust",
      before: null,
      after: identity,
      summary: `token "${nextSym}" registered on ${chain}`,
    });
    for (const route of sortedUniqueRoutes(nextTok.routes)) {
      const slug = ROUTE_SLUGS[route];
      laneDiffs.push({
        status: "added",
        chain,
        route,
        routeSlug: slug,
        previousSymbol: null,
        currentSymbol: nextSym,
        tokenIdentity: identity,
        detail: `lane ${chain}:${nextSym} over ${slug} added`,
      });
    }
  }

  // 4. Retained token symbols.
  const retainedSymbols = beforeSymbols.filter((s) => afterSymbolSet.has(s));
  for (const sym of retainedSymbols) {
    const prevTok = before.tokens[sym];
    const nextTok = after.tokens[sym];
    if (prevTok === undefined || nextTok === undefined) continue;
    const tokPath = `${basePath}.tokens.${sym}`;
    const prevId = tokenIdentityFor(before, prevTok);
    const nextId = tokenIdentityFor(after, nextTok);

    let tokenModified = false;
    if (prevId !== nextId) {
      tokenModified = true;
      changes.push({
        chain,
        path: `${tokPath}.identity`,
        category: "trust",
        before: prevId,
        after: nextId,
        summary: `underlying token identity for "${sym}" changed on ${chain}`,
      });
    }
    if (prevTok.decimals !== nextTok.decimals) {
      tokenModified = true;
      pushIfChanged(
        changes,
        chain,
        `${tokPath}.decimals`,
        "trust",
        prevTok.decimals,
        nextTok.decimals,
        `token "${sym}" decimals changed on ${chain}`,
      );
    }
    if (prevTok.flowLimit !== nextTok.flowLimit) {
      tokenModified = true;
      pushIfChanged(
        changes,
        chain,
        `${tokPath}.flowLimit`,
        "activation",
        prevTok.flowLimit,
        nextTok.flowLimit,
        `token "${sym}" flowLimit changed on ${chain}`,
      );
    }

    const prevRoutes = sortedUniqueRoutes(prevTok.routes);
    const nextRoutes = sortedUniqueRoutes(nextTok.routes);
    const prevRouteText = prevRoutes.map((r) => ROUTE_SLUGS[r]).join(",");
    const nextRouteText = nextRoutes.map((r) => ROUTE_SLUGS[r]).join(",");
    if (prevRouteText !== nextRouteText) {
      changes.push({
        chain,
        path: `${tokPath}.routes`,
        category: "activation",
        before: prevRouteText,
        after: nextRouteText,
        summary: `active routes for "${sym}" updated on ${chain}`,
      });
    }

    const prevSet = new Set(prevRoutes);
    const nextSet = new Set(nextRoutes);
    for (const route of ROUTE_KINDS) {
      const slug = ROUTE_SLUGS[route];
      const had = prevSet.has(route);
      const has = nextSet.has(route);
      if (had && !has) {
        laneDiffs.push({
          status: "deleted",
          chain,
          route,
          routeSlug: slug,
          previousSymbol: sym,
          currentSymbol: null,
          tokenIdentity: prevId,
          detail: `lane ${chain}:${sym} over ${slug} disabled/removed`,
        });
      } else if (!had && has) {
        laneDiffs.push({
          status: "added",
          chain,
          route,
          routeSlug: slug,
          previousSymbol: null,
          currentSymbol: sym,
          tokenIdentity: nextId,
          detail: `lane ${chain}:${sym} over ${slug} enabled/added`,
        });
      } else if (had && has && (tokenModified || changedAdapters.has(route))) {
        laneDiffs.push({
          status: "modified",
          chain,
          route,
          routeSlug: slug,
          previousSymbol: sym,
          currentSymbol: sym,
          tokenIdentity: nextId,
          detail: `lane ${chain}:${sym} over ${slug} modified adapter, identity, decimals, or flowLimit`,
        });
      }
    }
  }
}

/**
 * Compare two parsed `DeploymentSet` manifests deterministically across networks, authorities,
 * adapters, WASM hashes, token identities, and active lanes.
 */
export function compareDeploymentSets(
  before: DeploymentSet,
  after: DeploymentSet,
): DeploymentComparisonReport {
  const changes: DeploymentFieldChange[] = [];
  const laneDiffs: DeploymentLaneDiff[] = [];

  pushIfChanged(
    changes,
    null,
    "$.generatedAt",
    "metadata",
    before.generatedAt,
    after.generatedAt,
    "manifest generatedAt timestamp updated",
  );

  const allChains = [
    ...new Set([
      ...(Object.keys(before.networks) as ChainKey[]),
      ...(Object.keys(after.networks) as ChainKey[]),
    ]),
  ].sort(asciiCompare);

  for (const chain of allChains) {
    const prevNet = before.networks[chain];
    const nextNet = after.networks[chain];

    if (prevNet !== undefined && nextNet === undefined) {
      changes.push({
        chain,
        path: `$.networks.${chain}`,
        category: "trust",
        before: prevNet.router,
        after: null,
        summary: `network deployment "${chain}" was removed`,
      });
      for (const sym of sortedKeys(prevNet.tokens)) {
        const tok = prevNet.tokens[sym];
        if (tok === undefined) continue;
        const identity = tokenIdentityFor(prevNet, tok);
        for (const route of sortedUniqueRoutes(tok.routes)) {
          const slug = ROUTE_SLUGS[route];
          laneDiffs.push({
            status: "deleted",
            chain,
            route,
            routeSlug: slug,
            previousSymbol: sym,
            currentSymbol: null,
            tokenIdentity: identity,
            detail: `network ${chain} removed along with lane ${sym} over ${slug}`,
          });
        }
      }
      continue;
    }

    if (prevNet === undefined && nextNet !== undefined) {
      changes.push({
        chain,
        path: `$.networks.${chain}`,
        category: "trust",
        before: null,
        after: nextNet.router,
        summary: `network deployment "${chain}" was added`,
      });
      for (const sym of sortedKeys(nextNet.tokens)) {
        const tok = nextNet.tokens[sym];
        if (tok === undefined) continue;
        const identity = tokenIdentityFor(nextNet, tok);
        for (const route of sortedUniqueRoutes(tok.routes)) {
          const slug = ROUTE_SLUGS[route];
          laneDiffs.push({
            status: "added",
            chain,
            route,
            routeSlug: slug,
            previousSymbol: null,
            currentSymbol: sym,
            tokenIdentity: identity,
            detail: `network ${chain} added with lane ${sym} over ${slug}`,
          });
        }
      }
      continue;
    }

    if (prevNet !== undefined && nextNet !== undefined) {
      compareNetworkDeployments(chain, prevNet, nextNet, changes, laneDiffs);
    }
  }

  changes.sort((a, b) => {
    const chainCmp = asciiCompare(a.chain ?? "", b.chain ?? "");
    if (chainCmp !== 0) return chainCmp;
    return asciiCompare(a.path, b.path);
  });

  laneDiffs.sort((a, b) => {
    const chainCmp = asciiCompare(a.chain, b.chain);
    if (chainCmp !== 0) return chainCmp;
    const symA = a.currentSymbol ?? a.previousSymbol ?? "";
    const symB = b.currentSymbol ?? b.previousSymbol ?? "";
    const symCmp = asciiCompare(symA, symB);
    if (symCmp !== 0) return symCmp;
    if (a.route !== b.route) return a.route - b.route;
    return asciiCompare(a.status, b.status);
  });

  const trustChanges = changes.filter((c) => c.category === "trust");
  const activationChanges = changes.filter((c) => c.category === "activation");
  const metadataChanges = changes.filter((c) => c.category === "metadata");

  const highestImpact: "none" | DeploymentChangeCategory =
    trustChanges.length > 0
      ? "trust"
      : activationChanges.length > 0
        ? "activation"
        : metadataChanges.length > 0
          ? "metadata"
          : "none";

  return {
    identical: changes.length === 0 && laneDiffs.length === 0,
    metadataOnly: changes.length > 0 && trustChanges.length === 0 && activationChanges.length === 0,
    hasTrustChanges: trustChanges.length > 0,
    hasActivationChanges: activationChanges.length > 0,
    highestImpact,
    changes,
    trustChanges,
    activationChanges,
    metadataChanges,
    laneDiffs,
  };
}

/** Validate and compare two raw JSON deployment manifests in a single call. */
export function compareDeploymentManifests(
  beforeRaw: unknown,
  afterRaw: unknown,
): DeploymentComparisonReport {
  return compareDeploymentSets(parseDeploymentSet(beforeRaw), parseDeploymentSet(afterRaw));
}
