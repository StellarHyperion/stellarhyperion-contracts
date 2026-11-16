/**
 * Network-bound deployment record assembly, verification, and legacy evidence inspection.
 *
 * A deployment record shared across contracts, backend, and frontend is only trustworthy if two
 * invariants hold when it is written and read back:
 *
 * 1. Every observed contract address, uploaded code hash, ledger or block number, and public
 *    transaction hash was observed on the exact network passphrase or EVM chain id named by the
 *    target `ChainKey`. Wrong-network observations are rejected before a record can be assembled.
 * 2. Phase-one initialization and phase-two timelocked activation keep distinct chain positions
 *    (ledger or block, timestamp, and public transaction evidence), while older records written
 *    before network binding still parse with explicit evidence limitations rather than silent
 *    assumptions.
 */
import type { Hex } from "./bytes.js";
import type { ChainKey } from "./chains.js";
import { chain, isChainKey, isEvmChain, isStellarChain } from "./chains.js";
import {
  DEPLOYMENT_SCHEMA_VERSION,
  DeploymentFormatError,
  type Deployment,
  deployedChains,
  isEvmDeployment,
  isStellarDeployment,
  parseDeploymentSet,
} from "./deployments.js";
import { ROUTE_KINDS, ROUTE_SLUGS, RouteKind, tryRouteFromSlug } from "./routes.js";

/** Validation gate status attached to network-bound records. */
export type NetworkValidationScopeStatus = "active-validated" | "gated-unvalidated";

export type DeploymentEvidenceStatus = "network-bound" | "legacy-limited";

export type EvidenceLimitationCode =
  | "missing-network-binding"
  | "missing-initialization-tx"
  | "missing-activation-position"
  | "missing-activation-ledger"
  | "missing-activation-tx"
  | "missing-artifact-tx";

export interface EvidenceLimitation {
  readonly code: EvidenceLimitationCode;
  readonly path: string;
  readonly message: string;
}

export interface StellarChainPosition {
  readonly ledger: number;
  readonly timestamp: string;
  readonly txHash?: string | undefined;
  readonly actionTxHashes?: readonly string[] | undefined;
}

export interface EvmChainPosition {
  readonly blockNumber: string;
  readonly timestamp: string;
  readonly txHash: Hex;
}

export interface StellarLifecyclePositions {
  readonly initialization: StellarChainPosition;
  readonly activation: StellarChainPosition | null;
  readonly railActivations?: Readonly<Partial<Record<RouteKind, StellarChainPosition>>> | undefined;
}

export interface EvmLifecyclePositions {
  readonly initialization: EvmChainPosition;
  readonly activation: EvmChainPosition | null;
}

export interface BoundArtifactEvidence {
  readonly codeHash: string;
  readonly uploadTxHash?: string | undefined;
  readonly deployTxHash?: string | undefined;
}

export interface StellarNetworkBinding {
  readonly observedNetworkPassphrase: string;
  readonly observedChain?: ChainKey | undefined;
  readonly rpcProtocolVersion?: number | undefined;
  readonly verifiedAt: string;
  readonly artifacts: Readonly<Record<string, BoundArtifactEvidence>>;
}

export interface EvmNetworkBinding {
  readonly observedChainId: number;
  readonly observedChain?: ChainKey | undefined;
  readonly verifiedAt: string;
  readonly artifacts: Readonly<Record<string, BoundArtifactEvidence>>;
}

export interface BoundStellarNetworkRecord {
  readonly family: "stellar";
  readonly chain: ChainKey;
  readonly deployment: Extract<Deployment, { family: "stellar" }>;
  readonly validationStatus: NetworkValidationScopeStatus;
  readonly evidenceStatus: DeploymentEvidenceStatus;
  readonly evidenceLimitations: readonly EvidenceLimitation[];
  readonly networkBinding: StellarNetworkBinding | null;
  readonly positions: StellarLifecyclePositions;
}

export interface BoundEvmNetworkRecord {
  readonly family: "evm";
  readonly chain: ChainKey;
  readonly deployment: Extract<Deployment, { family: "evm" }>;
  readonly validationStatus: NetworkValidationScopeStatus;
  readonly evidenceStatus: DeploymentEvidenceStatus;
  readonly evidenceLimitations: readonly EvidenceLimitation[];
  readonly networkBinding: EvmNetworkBinding | null;
  readonly positions: EvmLifecyclePositions;
}

export type BoundNetworkRecord = BoundStellarNetworkRecord | BoundEvmNetworkRecord;

export interface BoundDeploymentSet {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly networks: Readonly<Partial<Record<ChainKey, BoundNetworkRecord>>>;
}

export interface ObservedArtifactInput {
  readonly name: string;
  readonly codeHash: string;
  readonly observedNetworkPassphrase?: string | undefined;
  readonly observedChainId?: number | undefined;
  readonly uploadTxHash?: string | undefined;
  readonly deployTxHash?: string | undefined;
}

export interface ObservedTransactionEvidence {
  readonly txHash: string;
  readonly ledger: number;
  readonly timestamp?: string | undefined;
  readonly observedNetworkPassphrase?: string | undefined;
}

export interface BuildNetworkBoundStellarInput {
  readonly targetChain: ChainKey;
  readonly observedNetworkPassphrase: string;
  readonly observedRpcChain?: ChainKey | undefined;
  readonly rpcProtocolVersion?: number | undefined;
  readonly verifiedAt: string;
  readonly generatedAt: string;
  readonly router: string;
  readonly adapters: Readonly<Partial<Record<RouteKind, string>>>;
  readonly tokens: Readonly<
    Record<
      string,
      {
        readonly sacId: string;
        readonly code: string;
        readonly issuer: string;
        readonly decimals: number;
        readonly flowLimit: string;
        readonly routes: readonly RouteKind[];
      }
    >
  >;
  readonly treasury: string;
  readonly admin: string;
  readonly guardian: string;
  readonly feeBps: number;
  readonly flowWindow: number;
  readonly timelockDelay: number;
  readonly commit: string;
  readonly deployer: string;
  readonly peerChain: ChainKey;
  readonly queuedActionIds: readonly number[];
  readonly queuedActions: readonly string[];
  readonly artifacts: readonly ObservedArtifactInput[];
  readonly initialization: {
    readonly ledger: number;
    readonly timestamp: string;
    readonly txHash?: string | undefined;
    readonly observedNetworkPassphrase?: string | undefined;
  };
  readonly activation?:
    | {
        readonly ledger: number;
        readonly timestamp: string;
        readonly txHash?: string | undefined;
        readonly actionTxHashes?: readonly string[] | undefined;
        readonly observedNetworkPassphrase?: string | undefined;
      }
    | null
    | undefined;
}

const VALIDATED_ACTIVE_ROUTES: readonly RouteKind[] = [RouteKind.Cctp, RouteKind.AxelarIts];

function failBound(path: string, reason: string): never {
  throw new DeploymentFormatError(path, reason);
}

function assertPublicOnly(value: string, path: string): void {
  if (/\bS[A-Z2-7]{55}\b/.test(value)) {
    failBound(path, "secret Stellar seed material cannot enter a deployment record");
  }
  if (/(?:private[_-]?key|secret[_-]?key|mnemonic)\s*[:=]/i.test(value)) {
    failBound(path, "secret key material cannot enter a deployment record");
  }
}

function assertTreePublicOnly(value: unknown, path: string): void {
  if (typeof value === "string") {
    assertPublicOnly(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertTreePublicOnly(value[i], `${path}[${String(i)}]`);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertTreePublicOnly(child, `${path}.${key}`);
    }
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failBound(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    failBound(path, "expected a non empty string");
  }
  assertPublicOnly(value, path);
  return value;
}

function asPositiveInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    failBound(path, "expected a positive integer");
  }
  return value;
}

function asIsoTimestamp(value: unknown, path: string): string {
  const text = asText(value, path);
  if (Number.isNaN(Date.parse(text))) {
    failBound(path, "expected an ISO 8601 timestamp");
  }
  return text;
}

function asStellarTxHash(value: unknown, path: string): string {
  const text = asText(value, path);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    failBound(path, "expected a 64 lowercase hex Stellar transaction hash");
  }
  return text;
}

function asEvmTxHash(value: unknown, path: string): Hex {
  const text = asText(value, path);
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) {
    failBound(path, "expected a 32 byte 0x-prefixed hex transaction hash");
  }
  return text as Hex;
}

function asWasmHash(value: unknown, path: string): string {
  const text = asText(value, path);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    failBound(path, "expected 64 lowercase hex characters");
  }
  return text;
}

function expectedEvmChainIds(key: ChainKey): readonly number[] {
  const meta = chain(key);
  if (!isEvmChain(meta)) return [];
  if (key === "local") return [31_337, 1337];
  return [meta.chainId];
}

function computeStellarValidationStatus(
  chainKey: ChainKey,
  deployment: Extract<Deployment, { family: "stellar" }>,
): NetworkValidationScopeStatus {
  if (chainKey !== "stellar-testnet") return "gated-unvalidated";
  for (const kind of ROUTE_KINDS) {
    if (deployment.adapters[kind] !== undefined && !VALIDATED_ACTIVE_ROUTES.includes(kind)) {
      return "gated-unvalidated";
    }
  }
  for (const token of Object.values(deployment.tokens)) {
    for (const route of token.routes) {
      if (!VALIDATED_ACTIVE_ROUTES.includes(route)) {
        return "gated-unvalidated";
      }
    }
  }
  return "active-validated";
}

/**
 * Verify that an observed Stellar network passphrase (and optional chain tag) matches the desired
 * `ChainKey` before any artifact or transaction evidence enters a deployment record.
 */
export function assertStellarNetworkMatch(
  targetChain: ChainKey,
  observedPassphrase: string,
  path: string,
  observedChain?: ChainKey,
): void {
  assertPublicOnly(observedPassphrase, path);
  const expected = chain(targetChain);
  if (!isStellarChain(expected)) {
    failBound(path, `target chain "${targetChain}" is not a Stellar chain`);
  }
  if (observedChain !== undefined && observedChain !== targetChain) {
    failBound(
      path,
      `observed chain "${observedChain}" does not match target chain "${targetChain}"`,
    );
  }
  if (observedPassphrase !== expected.networkPassphrase) {
    failBound(
      path,
      `observed network passphrase "${observedPassphrase}" does not match "${expected.networkPassphrase}" for ${targetChain}`,
    );
  }
}

/**
 * Verify that an observed EVM chain id matches the desired `ChainKey`.
 */
export function assertEvmNetworkMatch(
  targetChain: ChainKey,
  observedChainId: number,
  path: string,
  observedChain?: ChainKey,
): void {
  const expected = chain(targetChain);
  if (!isEvmChain(expected)) {
    failBound(path, `target chain "${targetChain}" is not an EVM chain`);
  }
  if (observedChain !== undefined && observedChain !== targetChain) {
    failBound(
      path,
      `observed chain "${observedChain}" does not match target chain "${targetChain}"`,
    );
  }
  const allowedIds = expectedEvmChainIds(targetChain);
  if (!allowedIds.includes(observedChainId)) {
    failBound(
      path,
      `observed chainId ${String(observedChainId)} does not match expected chainId ${String(expected.chainId)} for ${targetChain}`,
    );
  }
}

function parseStellarPosition(
  rawValue: unknown,
  path: string,
  expectedPassphrase: string,
): StellarChainPosition {
  const obj = asObject(rawValue, path);
  if (obj.networkPassphrase !== undefined) {
    const pass = asText(obj.networkPassphrase, `${path}.networkPassphrase`);
    if (pass !== expectedPassphrase) {
      failBound(
        `${path}.networkPassphrase`,
        `position passphrase "${pass}" does not match "${expectedPassphrase}"`,
      );
    }
  }
  const ledger = asPositiveInt(obj.ledger, `${path}.ledger`);
  const timestamp = asIsoTimestamp(obj.timestamp, `${path}.timestamp`);
  const txHash =
    obj.txHash === undefined ? undefined : asStellarTxHash(obj.txHash, `${path}.txHash`);
  let actionTxHashes: readonly string[] | undefined;
  if (obj.actionTxHashes !== undefined) {
    if (!Array.isArray(obj.actionTxHashes)) {
      failBound(`${path}.actionTxHashes`, "expected an array of transaction hashes");
    }
    actionTxHashes = obj.actionTxHashes.map((entry, idx) =>
      asStellarTxHash(entry, `${path}.actionTxHashes[${String(idx)}]`),
    );
  }
  return {
    ledger,
    timestamp,
    ...(txHash !== undefined ? { txHash } : {}),
    ...(actionTxHashes !== undefined ? { actionTxHashes } : {}),
  };
}

function parseBoundArtifacts(
  rawValue: unknown,
  path: string,
  family: "stellar" | "evm",
  expectedWasmHashes?: Readonly<Record<string, string>>,
): Readonly<Record<string, BoundArtifactEvidence>> {
  const obj = asObject(rawValue, path);
  const out: Record<string, BoundArtifactEvidence> = {};
  const readTx = family === "stellar" ? asStellarTxHash : asEvmTxHash;
  for (const [name, entry] of Object.entries(obj)) {
    const itemPath = `${path}.${name}`;
    const item = asObject(entry, itemPath);
    const codeHash = asWasmHash(item.codeHash, `${itemPath}.codeHash`);
    if (expectedWasmHashes?.[name] !== undefined && expectedWasmHashes[name] !== codeHash) {
      failBound(
        `${itemPath}.codeHash`,
        `artifact hash ${codeHash} disagrees with wasmHashes.${name} (${expectedWasmHashes[name]})`,
      );
    }
    const uploadTxHash =
      item.uploadTxHash === undefined
        ? undefined
        : readTx(item.uploadTxHash, `${itemPath}.uploadTxHash`);
    const deployTxHash =
      item.deployTxHash === undefined
        ? undefined
        : readTx(item.deployTxHash, `${itemPath}.deployTxHash`);
    out[name] = {
      codeHash,
      ...(uploadTxHash !== undefined ? { uploadTxHash } : {}),
      ...(deployTxHash !== undefined ? { deployTxHash } : {}),
    };
  }
  return out;
}

/**
 * Parse a deployment set while enforcing network identity on every network entry, keeping
 * initialization and activation positions distinct, and reporting explicit evidence limitations
 * for legacy records.
 */
export function parseNetworkBoundDeploymentSet(value: unknown): BoundDeploymentSet {
  assertTreePublicOnly(value, "$");
  const parsed = parseDeploymentSet(value);
  const rawRoot = asObject(value, "$");
  const rawNetworks = asObject(rawRoot.networks, "$.networks");
  const networks: Partial<Record<ChainKey, BoundNetworkRecord>> = {};

  for (const key of deployedChains(parsed)) {
    const deployment = parsed.networks[key];
    if (deployment === undefined) continue;
    const netPath = `$.networks.${key}`;
    const rawNet = asObject(rawNetworks[key], netPath);

    if (isStellarDeployment(deployment)) {
      networks[key] = inspectStellarNetworkRecord(key, deployment, rawNet, netPath);
    } else if (isEvmDeployment(deployment)) {
      networks[key] = inspectEvmNetworkRecord(key, deployment, rawNet, netPath);
    }
  }

  return {
    schemaVersion: parsed.schemaVersion,
    generatedAt: parsed.generatedAt,
    networks,
  };
}

function inspectStellarNetworkRecord(
  chainKey: ChainKey,
  deployment: Extract<Deployment, { family: "stellar" }>,
  rawNet: Record<string, unknown>,
  netPath: string,
): BoundStellarNetworkRecord {
  assertStellarNetworkMatch(chainKey, deployment.networkPassphrase, `${netPath}.networkPassphrase`);

  if (rawNet.peerChain !== undefined) {
    const peerKey = asText(rawNet.peerChain, `${netPath}.peerChain`);
    if (!isChainKey(peerKey)) {
      failBound(`${netPath}.peerChain`, `unknown peer chain "${peerKey}"`);
    }
    const localChain = chain(chainKey);
    const peerMeta = chain(peerKey);
    if (localChain.network !== peerMeta.network) {
      failBound(
        `${netPath}.peerChain`,
        `peer chain "${peerKey}" (${peerMeta.network}) cannot pair with "${chainKey}" (${localChain.network})`,
      );
    }
  }

  const limitations: EvidenceLimitation[] = [];
  let networkBinding: StellarNetworkBinding | null = null;

  if (rawNet.networkBinding !== undefined) {
    const bindPath = `${netPath}.networkBinding`;
    const bindObj = asObject(rawNet.networkBinding, bindPath);
    const observedPassphrase = asText(
      bindObj.observedNetworkPassphrase,
      `${bindPath}.observedNetworkPassphrase`,
    );
    let observedChain: ChainKey | undefined;
    if (bindObj.observedChain !== undefined) {
      const rawChain = asText(bindObj.observedChain, `${bindPath}.observedChain`);
      if (!isChainKey(rawChain)) {
        failBound(`${bindPath}.observedChain`, `unknown chain key "${rawChain}"`);
      }
      observedChain = rawChain;
    }
    assertStellarNetworkMatch(
      chainKey,
      observedPassphrase,
      `${bindPath}.observedNetworkPassphrase`,
      observedChain,
    );
    const rpcProtocolVersion =
      bindObj.rpcProtocolVersion === undefined
        ? undefined
        : asPositiveInt(bindObj.rpcProtocolVersion, `${bindPath}.rpcProtocolVersion`);
    const verifiedAt = asIsoTimestamp(bindObj.verifiedAt, `${bindPath}.verifiedAt`);
    const artifacts =
      bindObj.artifacts === undefined
        ? {}
        : parseBoundArtifacts(
            bindObj.artifacts,
            `${bindPath}.artifacts`,
            "stellar",
            deployment.wasmHashes,
          );

    for (const wasmName of Object.keys(deployment.wasmHashes)) {
      const boundArt = artifacts[wasmName];
      if (boundArt?.uploadTxHash === undefined && boundArt?.deployTxHash === undefined) {
        limitations.push({
          code: "missing-artifact-tx",
          path: `${bindPath}.artifacts.${wasmName}`,
          message: `artifact "${wasmName}" has no bound public upload or deploy transaction hash`,
        });
      }
    }

    networkBinding = {
      observedNetworkPassphrase: observedPassphrase,
      ...(observedChain !== undefined ? { observedChain } : {}),
      ...(rpcProtocolVersion !== undefined ? { rpcProtocolVersion } : {}),
      verifiedAt,
      artifacts,
    };
  } else {
    limitations.push({
      code: "missing-network-binding",
      path: `${netPath}.networkBinding`,
      message:
        "legacy record lacks explicit observed RPC network passphrase and artifact provenance binding",
    });
  }

  let initialization: StellarChainPosition;
  let activation: StellarChainPosition | null = null;
  let railActivations: Partial<Record<RouteKind, StellarChainPosition>> | undefined;

  if (rawNet.positions !== undefined) {
    const posPath = `${netPath}.positions`;
    const posObj = asObject(rawNet.positions, posPath);
    initialization = parseStellarPosition(
      posObj.initialization,
      `${posPath}.initialization`,
      deployment.networkPassphrase,
    );
    if (initialization.ledger !== deployment.deployedAt.ledger) {
      failBound(
        `${posPath}.initialization.ledger`,
        `initialization ledger ${String(initialization.ledger)} disagrees with deployedAt.ledger ${String(deployment.deployedAt.ledger)}`,
      );
    }
    if (initialization.txHash === undefined) {
      limitations.push({
        code: "missing-initialization-tx",
        path: `${posPath}.initialization.txHash`,
        message: "initialization position lacks a public router initialization transaction hash",
      });
    }

    if (posObj.activation !== undefined && posObj.activation !== null) {
      activation = parseStellarPosition(
        posObj.activation,
        `${posPath}.activation`,
        deployment.networkPassphrase,
      );
      if (activation.ledger < initialization.ledger) {
        failBound(
          `${posPath}.activation.ledger`,
          `activation ledger ${String(activation.ledger)} cannot precede initialization ledger ${String(initialization.ledger)}`,
        );
      }
      if (
        activation.txHash === undefined &&
        (activation.actionTxHashes === undefined || activation.actionTxHashes.length === 0)
      ) {
        limitations.push({
          code: "missing-activation-tx",
          path: `${posPath}.activation`,
          message: "activation position lacks public timelock execution transaction hashes",
        });
      }
    }

    if (posObj.railActivations !== undefined) {
      const railObj = asObject(posObj.railActivations, `${posPath}.railActivations`);
      railActivations = {};
      for (const [slug, entry] of Object.entries(railObj)) {
        const route = tryRouteFromSlug(slug);
        if (route === null) failBound(`${posPath}.railActivations.${slug}`, "unknown rail slug");
        const railPos = parseStellarPosition(
          entry,
          `${posPath}.railActivations.${slug}`,
          deployment.networkPassphrase,
        );
        if (railPos.ledger < initialization.ledger) {
          failBound(
            `${posPath}.railActivations.${slug}.ledger`,
            `rail activation ledger ${String(railPos.ledger)} cannot precede initialization ledger ${String(initialization.ledger)}`,
          );
        }
        railActivations[route] = railPos;
      }
    }
  } else {
    // Legacy record fallback: `deployedAt` captures initialization ledger/timestamp, while any
    // legacy `activation` summary carries `activatedAt` and optional `sourceHash` without a
    // distinct activation ledger inside the manifest.
    const rawDeployedAt = asObject(rawNet.deployedAt, `${netPath}.deployedAt`);
    const legacyInitTx =
      rawDeployedAt.txHash === undefined
        ? undefined
        : asStellarTxHash(rawDeployedAt.txHash, `${netPath}.deployedAt.txHash`);

    initialization = {
      ledger: deployment.deployedAt.ledger,
      timestamp: deployment.deployedAt.timestamp,
      ...(legacyInitTx !== undefined ? { txHash: legacyInitTx } : {}),
    };
    if (legacyInitTx === undefined) {
      limitations.push({
        code: "missing-initialization-tx",
        path: `${netPath}.deployedAt.txHash`,
        message:
          "legacy deployedAt entry records ledger and timestamp without an initialization txHash",
      });
    }

    if (rawNet.activation !== undefined && rawNet.activation !== null) {
      const legacyAct = asObject(rawNet.activation, `${netPath}.activation`);
      if (typeof legacyAct.ledger === "number") {
        const actLedger = asPositiveInt(legacyAct.ledger, `${netPath}.activation.ledger`);
        const actTime = asIsoTimestamp(legacyAct.activatedAt, `${netPath}.activation.activatedAt`);
        const actTx =
          legacyAct.txHash === undefined
            ? undefined
            : asStellarTxHash(legacyAct.txHash, `${netPath}.activation.txHash`);
        activation = {
          ledger: actLedger,
          timestamp: actTime,
          ...(actTx !== undefined ? { txHash: actTx } : {}),
        };
      } else {
        limitations.push({
          code: "missing-activation-ledger",
          path: `${netPath}.activation`,
          message:
            "legacy activation block records timestamp and external evidence file without an inline activation ledger position",
        });
      }
    } else {
      limitations.push({
        code: "missing-activation-position",
        path: `${netPath}.positions.activation`,
        message:
          "legacy record has no inline activation position (phase-one only or pre-activation archive)",
      });
    }
  }

  const evidenceStatus: DeploymentEvidenceStatus =
    networkBinding !== null && limitations.length === 0 ? "network-bound" : "legacy-limited";

  return {
    family: "stellar",
    chain: chainKey,
    deployment,
    validationStatus: computeStellarValidationStatus(chainKey, deployment),
    evidenceStatus,
    evidenceLimitations: limitations,
    networkBinding,
    positions: {
      initialization,
      activation,
      ...(railActivations !== undefined ? { railActivations } : {}),
    },
  };
}

function inspectEvmNetworkRecord(
  chainKey: ChainKey,
  deployment: Extract<Deployment, { family: "evm" }>,
  rawNet: Record<string, unknown>,
  netPath: string,
): BoundEvmNetworkRecord {
  assertEvmNetworkMatch(chainKey, deployment.chainId, `${netPath}.chainId`);

  const limitations: EvidenceLimitation[] = [];
  let networkBinding: EvmNetworkBinding | null = null;

  if (rawNet.networkBinding !== undefined) {
    const bindPath = `${netPath}.networkBinding`;
    const bindObj = asObject(rawNet.networkBinding, bindPath);
    const observedChainId = asPositiveInt(bindObj.observedChainId, `${bindPath}.observedChainId`);
    let observedChain: ChainKey | undefined;
    if (bindObj.observedChain !== undefined) {
      const rawChain = asText(bindObj.observedChain, `${bindPath}.observedChain`);
      if (!isChainKey(rawChain)) {
        failBound(`${bindPath}.observedChain`, `unknown chain key "${rawChain}"`);
      }
      observedChain = rawChain;
    }
    assertEvmNetworkMatch(chainKey, observedChainId, `${bindPath}.observedChainId`, observedChain);
    const verifiedAt = asIsoTimestamp(bindObj.verifiedAt, `${bindPath}.verifiedAt`);
    const artifacts =
      bindObj.artifacts === undefined
        ? {}
        : parseBoundArtifacts(bindObj.artifacts, `${bindPath}.artifacts`, "evm");
    networkBinding = {
      observedChainId,
      ...(observedChain !== undefined ? { observedChain } : {}),
      verifiedAt,
      artifacts,
    };
  } else {
    limitations.push({
      code: "missing-network-binding",
      path: `${netPath}.networkBinding`,
      message: "legacy EVM record lacks explicit observed chainId and artifact provenance binding",
    });
  }

  const initialization: EvmChainPosition = {
    blockNumber: deployment.deployedAt.blockNumber,
    timestamp: deployment.deployedAt.timestamp,
    txHash: deployment.deployedAt.txHash,
  };
  let activation: EvmChainPosition | null = null;

  if (rawNet.positions !== undefined) {
    const posPath = `${netPath}.positions`;
    const posObj = asObject(rawNet.positions, posPath);
    if (posObj.activation !== undefined && posObj.activation !== null) {
      const actObj = asObject(posObj.activation, `${posPath}.activation`);
      if (actObj.chainId !== undefined) {
        assertEvmNetworkMatch(
          chainKey,
          asPositiveInt(actObj.chainId, `${posPath}.activation.chainId`),
          `${posPath}.activation.chainId`,
        );
      }
      const blockNumber = asText(actObj.blockNumber, `${posPath}.activation.blockNumber`);
      if (!/^\d+$/.test(blockNumber)) {
        failBound(`${posPath}.activation.blockNumber`, "expected a decimal block number string");
      }
      if (BigInt(blockNumber) < BigInt(initialization.blockNumber)) {
        failBound(
          `${posPath}.activation.blockNumber`,
          `activation block ${blockNumber} cannot precede initialization block ${initialization.blockNumber}`,
        );
      }
      activation = {
        blockNumber,
        timestamp: asIsoTimestamp(actObj.timestamp, `${posPath}.activation.timestamp`),
        txHash: asEvmTxHash(actObj.txHash, `${posPath}.activation.txHash`),
      };
    }
  } else {
    limitations.push({
      code: "missing-activation-position",
      path: `${netPath}.positions.activation`,
      message: "legacy EVM record lacks a separate activation block position",
    });
  }

  const evidenceStatus: DeploymentEvidenceStatus =
    networkBinding !== null && limitations.length === 0 ? "network-bound" : "legacy-limited";

  return {
    family: "evm",
    chain: chainKey,
    deployment,
    // EVM remains explicitly gated until independently validated.
    validationStatus: "gated-unvalidated",
    evidenceStatus,
    evidenceLimitations: limitations,
    networkBinding,
    positions: {
      initialization,
      activation,
    },
  };
}

/**
 * Assemble a validated, network-bound Stellar deployment record JSON object ready to serialize.
 *
 * Refuses any observation whose passphrase or chain key disagrees with `targetChain`, refuses
 * cross-network peer chains, keeps initialization and activation positions separate, and passes
 * the assembled JSON through `parseNetworkBoundDeploymentSet` before returning it.
 */
export function buildNetworkBoundStellarRecord(
  input: BuildNetworkBoundStellarInput,
): Record<string, unknown> {
  const targetMeta = chain(input.targetChain);
  if (!isStellarChain(targetMeta)) {
    failBound("$.targetChain", `"${input.targetChain}" is not a Stellar chain`);
  }

  assertStellarNetworkMatch(
    input.targetChain,
    input.observedNetworkPassphrase,
    "$.networkBinding.observedNetworkPassphrase",
    input.observedRpcChain,
  );

  const peerMeta = chain(input.peerChain);
  if (peerMeta.network !== targetMeta.network) {
    failBound(
      `$.networks.${input.targetChain}.peerChain`,
      `peer chain "${input.peerChain}" (${peerMeta.network}) cannot pair with "${input.targetChain}" (${targetMeta.network})`,
    );
  }

  if (input.initialization.observedNetworkPassphrase !== undefined) {
    assertStellarNetworkMatch(
      input.targetChain,
      input.initialization.observedNetworkPassphrase,
      `$.networks.${input.targetChain}.positions.initialization.networkPassphrase`,
    );
  }

  if (input.activation?.observedNetworkPassphrase !== undefined) {
    assertStellarNetworkMatch(
      input.targetChain,
      input.activation.observedNetworkPassphrase,
      `$.networks.${input.targetChain}.positions.activation.networkPassphrase`,
    );
  }

  const wasmHashes: Record<string, string> = {};
  const boundArtifacts: Record<string, Record<string, unknown>> = {};
  for (const artifact of input.artifacts) {
    const artPath = `$.networks.${input.targetChain}.networkBinding.artifacts.${artifact.name}`;
    if (artifact.observedNetworkPassphrase !== undefined) {
      assertStellarNetworkMatch(
        input.targetChain,
        artifact.observedNetworkPassphrase,
        `${artPath}.observedNetworkPassphrase`,
      );
    }
    if (artifact.observedChainId !== undefined) {
      failBound(
        `${artPath}.observedChainId`,
        "EVM chainId observation cannot enter a Stellar deployment record",
      );
    }
    const hash = asWasmHash(artifact.codeHash, `${artPath}.codeHash`);
    wasmHashes[artifact.name] = hash;
    boundArtifacts[artifact.name] = {
      codeHash: hash,
      ...(artifact.uploadTxHash !== undefined
        ? { uploadTxHash: asStellarTxHash(artifact.uploadTxHash, `${artPath}.uploadTxHash`) }
        : {}),
      ...(artifact.deployTxHash !== undefined
        ? { deployTxHash: asStellarTxHash(artifact.deployTxHash, `${artPath}.deployTxHash`) }
        : {}),
    };
  }

  const adaptersJson: Record<string, string> = {};
  for (const kind of ROUTE_KINDS) {
    const addr = input.adapters[kind];
    if (addr !== undefined) {
      adaptersJson[ROUTE_SLUGS[kind]] = addr;
    }
  }

  const tokensJson: Record<string, Record<string, unknown>> = {};
  for (const [symbol, tok] of Object.entries(input.tokens)) {
    tokensJson[symbol] = {
      sacId: tok.sacId,
      code: tok.code,
      issuer: tok.issuer,
      decimals: tok.decimals,
      flowLimit: tok.flowLimit,
      routes: tok.routes.map((r) => ROUTE_SLUGS[r]),
    };
  }

  const initPosition: Record<string, unknown> = {
    networkPassphrase: targetMeta.networkPassphrase,
    ledger: input.initialization.ledger,
    timestamp: input.initialization.timestamp,
    ...(input.initialization.txHash !== undefined ? { txHash: input.initialization.txHash } : {}),
  };

  let actPosition: Record<string, unknown> | null = null;
  if (input.activation !== undefined && input.activation !== null) {
    actPosition = {
      networkPassphrase: targetMeta.networkPassphrase,
      ledger: input.activation.ledger,
      timestamp: input.activation.timestamp,
      ...(input.activation.txHash !== undefined ? { txHash: input.activation.txHash } : {}),
      ...(input.activation.actionTxHashes !== undefined
        ? { actionTxHashes: [...input.activation.actionTxHashes] }
        : {}),
    };
  }

  const record: Record<string, unknown> = {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    networks: {
      [input.targetChain]: {
        family: "stellar",
        networkPassphrase: targetMeta.networkPassphrase,
        router: input.router,
        adapters: adaptersJson,
        tokens: tokensJson,
        treasury: input.treasury,
        admin: input.admin,
        guardian: input.guardian,
        feeBps: input.feeBps,
        flowWindow: input.flowWindow,
        timelockDelay: input.timelockDelay,
        wasmHashes,
        deployedAt: {
          ledger: input.initialization.ledger,
          timestamp: input.initialization.timestamp,
          ...(input.initialization.txHash !== undefined
            ? { txHash: input.initialization.txHash }
            : {}),
        },
        commit: input.commit,
        deployer: input.deployer,
        peerChain: input.peerChain,
        queuedActionIds: [...input.queuedActionIds],
        queuedActions: [...input.queuedActions],
        networkBinding: {
          observedNetworkPassphrase: input.observedNetworkPassphrase,
          ...(input.observedRpcChain !== undefined
            ? { observedChain: input.observedRpcChain }
            : {}),
          ...(input.rpcProtocolVersion !== undefined
            ? { rpcProtocolVersion: input.rpcProtocolVersion }
            : {}),
          verifiedAt: input.verifiedAt,
          artifacts: boundArtifacts,
        },
        positions: {
          initialization: initPosition,
          activation: actPosition,
        },
      },
    },
  };

  // Validate both canonical DeploymentSet compatibility and strict network-binding invariants.
  parseNetworkBoundDeploymentSet(record);
  return record;
}

/**
 * Attach a phase-two activation position to an existing Stellar deployment record without
 * overwriting or collapsing its phase-one initialization position.
 */
export function recordStellarActivationPosition(
  existingRecord: unknown,
  options: {
    readonly targetChain: ChainKey;
    readonly observedNetworkPassphrase: string;
    readonly ledger: number;
    readonly timestamp: string;
    readonly txHash?: string | undefined;
    readonly actionTxHashes?: readonly string[] | undefined;
    readonly rail?: RouteKind | undefined;
  },
): Record<string, unknown> {
  const bound = parseNetworkBoundDeploymentSet(existingRecord);
  const net = bound.networks[options.targetChain];
  if (net?.family !== "stellar") {
    failBound(
      `$.networks.${options.targetChain}`,
      `no Stellar network record found for "${options.targetChain}"`,
    );
  }

  assertStellarNetworkMatch(
    options.targetChain,
    options.observedNetworkPassphrase,
    `$.networks.${options.targetChain}.positions.activation.networkPassphrase`,
  );

  const init = net.positions.initialization;
  if (options.ledger < init.ledger) {
    failBound(
      `$.networks.${options.targetChain}.positions.activation.ledger`,
      `activation ledger ${String(options.ledger)} cannot precede initialization ledger ${String(init.ledger)}`,
    );
  }

  const rawClone = JSON.parse(JSON.stringify(existingRecord)) as Record<string, unknown>;
  rawClone.generatedAt = options.timestamp;
  const networksObj = asObject(rawClone.networks, "$.networks");
  const netObj = asObject(networksObj[options.targetChain], `$.networks.${options.targetChain}`);

  const existingPositions =
    netObj.positions !== undefined &&
    typeof netObj.positions === "object" &&
    netObj.positions !== null
      ? (netObj.positions as Record<string, unknown>)
      : {};

  const activationEntry: Record<string, unknown> = {
    networkPassphrase: net.deployment.networkPassphrase,
    ledger: options.ledger,
    timestamp: options.timestamp,
    ...(options.txHash !== undefined ? { txHash: options.txHash } : {}),
    ...(options.actionTxHashes !== undefined
      ? { actionTxHashes: [...options.actionTxHashes] }
      : {}),
  };

  const nextPositions: Record<string, unknown> = {
    ...existingPositions,
    initialization: existingPositions.initialization ?? {
      networkPassphrase: net.deployment.networkPassphrase,
      ledger: init.ledger,
      timestamp: init.timestamp,
      ...(init.txHash !== undefined ? { txHash: init.txHash } : {}),
    },
    activation:
      options.rail === undefined
        ? activationEntry
        : (existingPositions.activation ?? activationEntry),
  };

  if (options.rail !== undefined) {
    const slug = ROUTE_SLUGS[options.rail];
    const existingRails =
      existingPositions.railActivations !== undefined &&
      typeof existingPositions.railActivations === "object" &&
      existingPositions.railActivations !== null
        ? (existingPositions.railActivations as Record<string, unknown>)
        : {};
    nextPositions.railActivations = {
      ...existingRails,
      [slug]: activationEntry,
    };
  }

  netObj.positions = nextPositions;
  parseNetworkBoundDeploymentSet(rawClone);
  return rawClone;
}

/**
 * Render a concise, secret-free summary of a network-bound or legacy deployment record.
 */
export function formatNetworkBoundSummary(boundSet: BoundDeploymentSet): string {
  const lines: string[] = [];
  for (const key of Object.keys(boundSet.networks)) {
    if (!isChainKey(key)) continue;
    const entry = boundSet.networks[key];
    if (entry === undefined) continue;
    lines.push(
      `Network record: ${entry.chain} (${entry.family}) [${entry.evidenceStatus}, ${entry.validationStatus}]`,
    );
    if (entry.family === "stellar") {
      lines.push(
        `  initialization: ledger=${String(entry.positions.initialization.ledger)} timestamp=${entry.positions.initialization.timestamp} tx=${entry.positions.initialization.txHash ?? "<unrecorded>"}`,
      );
      if (entry.positions.activation !== null) {
        lines.push(
          `  activation:     ledger=${String(entry.positions.activation.ledger)} timestamp=${entry.positions.activation.timestamp} tx=${entry.positions.activation.txHash ?? entry.positions.activation.actionTxHashes?.join(",") ?? "<unrecorded>"}`,
        );
      } else {
        lines.push("  activation:     <pending or not recorded inline>");
      }
    } else {
      lines.push(
        `  initialization: block=${entry.positions.initialization.blockNumber} timestamp=${entry.positions.initialization.timestamp} tx=${entry.positions.initialization.txHash}`,
      );
      if (entry.positions.activation !== null) {
        lines.push(
          `  activation:     block=${entry.positions.activation.blockNumber} timestamp=${entry.positions.activation.timestamp} tx=${entry.positions.activation.txHash}`,
        );
      } else {
        lines.push("  activation:     <pending or not recorded inline>");
      }
    }
    if (entry.evidenceLimitations.length > 0) {
      lines.push(`  evidence limitations (${String(entry.evidenceLimitations.length)}):`);
      for (const lim of entry.evidenceLimitations) {
        lines.push(`    - [${lim.code}] ${lim.path}: ${lim.message}`);
      }
    }
  }
  return lines.join("\n");
}
