/**
 * Replay-identity collision corpus and full-width identifier audit harness.
 *
 * Provider rails expose 32-byte message identifiers (such as Circle CCTP V2 256-bit nonces,
 * Allbridge Core 32-byte message hashes, and Axelar XDR-framed `(source_chain, message_id)`
 * digests) alongside shortened 64-bit display nonces (`bytes[24..32]`) or 8-byte explorer
 * prefixes (`bytes[0..8]`). Hyperion routers key replay protection on `(route, message_id)` using
 * all 32 bytes. This module generates adversarial collision families and verifies that:
 *
 * 1. Distinct 32-byte messages sharing display prefixes, shortened `u64` nonces, single-bit
 *    neighbors, or string-concatenation boundaries never overwrite or merge replay state.
 * 2. Exact `(route, message_id)` replays are deterministically refused with `ReplayedMessage`.
 * 3. Audit reports preserve all 32 identifier bytes (`0x` + 64 lowercase hex digits) end to end.
 */
import {
  asciiToBytes,
  bigIntToBytes,
  bytesToBigInt,
  concatBytes,
  fromHex,
  slice,
  toHex,
} from "./bytes.js";
import type { Hex } from "./bytes.js";
import type { SorobanErrorName } from "./errors.js";
import { ROUTE_KINDS, ROUTE_SLUGS } from "./routes.js";
import type { RouteSlug } from "./routes.js";

export const REPLAY_ID_BYTE_LENGTH = 32;
export const ALL_ROUTE_SLUGS: readonly RouteSlug[] = ROUTE_KINDS.map((kind) => ROUTE_SLUGS[kind]);

export type ReplayCollisionFamily =
  | "shared-display-prefix-8b"
  | "shared-shortened-u64-nonce"
  | "single-bit-hamming-neighbor"
  | "zero-vs-nonzero-high-word"
  | "axelar-xdr-boundary-shift"
  | "cross-route-shared-id";

export type TruncatedReplayKeyMode =
  | "full-route-scoped-32b"
  | "display-prefix-8b"
  | "shortened-u64-nonce"
  | "route-unscoped-32b"
  | "unframed-axelar-concat";

export interface ReplayCorpusVector {
  readonly caseId: string;
  readonly family: ReplayCollisionFamily;
  readonly route: RouteSlug;
  readonly sourceChain: string;
  readonly messageIdBytes: Uint8Array;
  readonly messageIdHex: Hex;
  readonly displayPrefixHex: Hex;
  readonly shortenedNonce: bigint;
  readonly providerLabel: string;
  /** Optional raw `(sourceChain, messageId)` components for Axelar boundary-shift cases. */
  readonly axelarParts?: {
    readonly rawChain: string;
    readonly rawMessageId: string;
    readonly xdrFramedHex: Hex;
  };
}

export interface ReplayDecisionRecord {
  readonly step: number;
  readonly caseId: string;
  readonly family: ReplayCollisionFamily;
  readonly isReplayProbe: boolean;
  readonly route: RouteSlug;
  readonly sourceChain: string;
  readonly messageIdBytes: Uint8Array;
  readonly messageIdHex: Hex;
  readonly displayPrefixHex: Hex;
  readonly shortenedNonce: bigint;
  readonly accepted: boolean;
  readonly error: SorobanErrorName | null;
  readonly wasProcessedBefore: boolean;
  readonly wasProcessedAfter: boolean;
}

export interface ReplayCorpusAuditReport {
  readonly passed: boolean;
  readonly vectorCount: number;
  readonly decisionCount: number;
  readonly distinctRouteScopedKeys: number;
  readonly decisions: readonly ReplayDecisionRecord[];
  readonly violations: readonly string[];
  readonly formattedSummary: string;
}

export interface TruncatedKeyCollisionFinding {
  readonly mode: TruncatedReplayKeyMode;
  readonly collidedKey: string;
  readonly firstCaseId: string;
  readonly firstMessageIdHex: Hex;
  readonly secondCaseId: string;
  readonly secondMessageIdHex: Hex;
}

function assertReplayIdWidth(bytes: Uint8Array): void {
  if (bytes.length !== REPLAY_ID_BYTE_LENGTH) {
    throw new RangeError(
      `replay message_id must be ${String(REPLAY_ID_BYTE_LENGTH)} bytes, got ${String(bytes.length)}`,
    );
  }
}

/** Extract the 8-byte leading explorer prefix (`bytes[0..8]`) without mutating the 32-byte ID. */
export function extractDisplayPrefix(messageId: Uint8Array): Hex {
  assertReplayIdWidth(messageId);
  return toHex(slice(messageId, 0, 8));
}

/**
 * Extract the bottom 8 bytes (`bytes[24..32]`) as an unsigned 64-bit integer, matching
 * `hyperion_core::cctp::CctpMessage::display_nonce` and `AllbridgeAdapter::bridge_in`.
 */
export function extractShortenedNonce(messageId: Uint8Array): bigint {
  assertReplayIdWidth(messageId);
  return bytesToBigInt(slice(messageId, 24, 32));
}

/**
 * Encode an ASCII string pair using RFC 4506 XDR length-prefixed framing (4-byte big-endian
 * length + payload + zero padding to 4-byte alignment per string), matching Soroban's
 * `(String, String).to_xdr(&env)` layout used by `hyperion-adapter-axelar`.
 */
export function encodeXdrStringPair(first: string, second: string): Uint8Array {
  const encodeOne = (value: string): Uint8Array => {
    const raw = asciiToBytes(value);
    const lenPrefix = bigIntToBytes(BigInt(raw.length), 4);
    const padLen = (4 - (raw.length % 4)) % 4;
    const pad = new Uint8Array(padLen);
    return concatBytes(lenPrefix, raw, pad);
  };
  return concatBytes(encodeOne(first), encodeOne(second));
}

/**
 * Deterministic 256-bit mixing function over XDR-framed bytes for offline TypeScript corpus ID
 * derivation (4 independent 64-bit FNV-1a lanes with cross-lane avalanche). Preserves strict
 * domain separation over length-prefixed XDR frames with zero external runtime dependencies.
 */
function deriveDeterministic32Bytes(seedBytes: Uint8Array): Uint8Array {
  const mask64 = (1n << 64n) - 1n;
  const prime = 0x100000001b3n;
  const states: [bigint, bigint, bigint, bigint] = [
    0xcbf29ce484222325n,
    0x84222325cbf29ce4n,
    0x9e3779b97f4a7c15n,
    0xbf58476d1ce4e5b9n,
  ];
  for (let i = 0; i < seedBytes.length; i += 1) {
    const b = BigInt(seedBytes[i] ?? 0);
    const pos = BigInt(i + 1);
    states[0] = ((states[0] ^ (b + pos)) * prime) & mask64;
    states[1] = ((states[1] ^ ((b << 8n) ^ pos)) * prime) & mask64;
    states[2] = ((states[2] ^ ((b << 16n) ^ (pos * 131n))) * prime) & mask64;
    states[3] = ((states[3] ^ ((b << 24n) ^ (pos * 257n))) * prime) & mask64;
  }
  const mix64 = (x: bigint): bigint => {
    let z = x & mask64;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask64;
    return (z ^ (z >> 31n)) & mask64;
  };
  const cross = mix64(states[0] ^ states[1] ^ states[2] ^ states[3]);
  return concatBytes(
    bigIntToBytes(mix64(states[0] ^ cross), 8),
    bigIntToBytes(mix64(states[1] ^ (cross << 1n)), 8),
    bigIntToBytes(mix64(states[2] ^ (cross >> 1n)), 8),
    bigIntToBytes(mix64(states[3] ^ 0x517cc1b727220a95n), 8),
  );
}

function makeVector(params: {
  caseId: string;
  family: ReplayCollisionFamily;
  route: RouteSlug;
  sourceChain: string;
  bytes: Uint8Array;
  shortenedNonceOverride?: bigint;
  providerLabel: string;
  axelarParts?: ReplayCorpusVector["axelarParts"];
}): ReplayCorpusVector {
  assertReplayIdWidth(params.bytes);
  const copy = params.bytes.slice();
  const base: ReplayCorpusVector = {
    caseId: params.caseId,
    family: params.family,
    route: params.route,
    sourceChain: params.sourceChain,
    messageIdBytes: copy,
    messageIdHex: toHex(copy),
    displayPrefixHex: extractDisplayPrefix(copy),
    shortenedNonce: params.shortenedNonceOverride ?? extractShortenedNonce(copy),
    providerLabel: params.providerLabel,
  };
  if (params.axelarParts !== undefined) {
    return { ...base, axelarParts: params.axelarParts };
  }
  return base;
}

/**
 * Build the canonical adversarial replay-identity collision corpus spanning all six collision
 * families and all four supported Hyperion routes.
 */
export function generateReplayCollisionCorpus(): readonly ReplayCorpusVector[] {
  const vectors: ReplayCorpusVector[] = [];

  // 1. Shared 8-byte display prefix AND shared 8-byte shortened u64 suffix; only interior bytes[8..24] differ.
  const sharedPrefix = bigIntToBytes(0x48595052_20261116n, 8);
  const sharedTail = bigIntToBytes(0x00000000_00c0ffeen, 8);
  const interiorVariants: readonly [string, bigint, bigint][] = [
    ["interior-a", 0x00000000_00000001n, 0x00000000_00000000n],
    ["interior-b", 0x00000000_00000001n, 0x00000000_00000001n],
    ["interior-c", 0x80000000_00000000n, 0x00000000_00000000n],
  ];
  for (const [suffixLabel, midHi, midLo] of interiorVariants) {
    vectors.push(
      makeVector({
        caseId: `prefix8-${suffixLabel}`,
        family: "shared-display-prefix-8b",
        route: "cctp",
        sourceChain: "ethereum",
        bytes: concatBytes(
          sharedPrefix,
          bigIntToBytes(midHi, 8),
          bigIntToBytes(midLo, 8),
          sharedTail,
        ),
        providerLabel: `cctp:shared-prefix-and-tail/${suffixLabel}`,
      }),
    );
  }

  // 2. Shared shortened u64 nonce across CCTP and Allbridge full-width 256-bit identifiers.
  const commonShortNonce = 42_000_000_777n;
  const commonShortTail = bigIntToBytes(commonShortNonce, 8);
  const highEpochHeaders: readonly [string, RouteSlug, string, bigint][] = [
    ["cctp-epoch-1", "cctp", "base", 0x0001_0000_0000_0001n],
    ["cctp-epoch-2", "cctp", "base", 0x0001_0000_0000_0002n],
    ["allbridge-pool-1", "allbridge", "arbitrum", 0x00ab_0000_0000_0001n],
    ["allbridge-pool-2", "allbridge", "arbitrum", 0x00ab_0000_0000_0002n],
  ];
  for (const [label, route, sourceChain, hiWord] of highEpochHeaders) {
    vectors.push(
      makeVector({
        caseId: `short-u64-${label}`,
        family: "shared-shortened-u64-nonce",
        route,
        sourceChain,
        bytes: concatBytes(bigIntToBytes(hiWord, 8), new Uint8Array(16), commonShortTail),
        providerLabel: `${route}:shared-u64/${label}`,
      }),
    );
  }

  // 3. Zero vs non-zero high 192-bit prefix with identical low u64 word.
  const lowWordNonce = 9_007_199_254_740_993n; // 2^53 + 1
  const lowWordBytes = bigIntToBytes(lowWordNonce, 8);
  const highWordCases: readonly [string, Uint8Array][] = [
    ["zero-high", new Uint8Array(24)],
    ["lsb-byte23", concatBytes(new Uint8Array(23), Uint8Array.of(0x01))],
    ["msb-byte0", concatBytes(Uint8Array.of(0x80), new Uint8Array(23))],
  ];
  for (const [tag, high24] of highWordCases) {
    vectors.push(
      makeVector({
        caseId: `highword-${tag}`,
        family: "zero-vs-nonzero-high-word",
        route: "cctp",
        sourceChain: "optimism",
        bytes: concatBytes(high24, lowWordBytes),
        providerLabel: `cctp:high-word/${tag}`,
      }),
    );
  }

  // 4. Single-bit Hamming-distance-1 neighbors around a baseline 32-byte digest.
  const baseDigest = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    baseDigest[i] = (i * 17 + 0x23) & 0xff;
  }
  vectors.push(
    makeVector({
      caseId: "hamming-base",
      family: "single-bit-hamming-neighbor",
      route: "axelar-its",
      sourceChain: "ethereum",
      bytes: baseDigest,
      providerLabel: "its:hamming/base",
    }),
  );
  const bitFlipTargets: readonly [string, number, number][] = [
    ["byte0-msb", 0, 0x80],
    ["byte7-lsb", 7, 0x01],
    ["byte15-mid", 15, 0x08],
    ["byte23-lsb", 23, 0x01],
    ["byte24-msb", 24, 0x80],
    ["byte31-lsb", 31, 0x01],
  ];
  for (const [label, byteIndex, bitMask] of bitFlipTargets) {
    const flipped = baseDigest.slice();
    flipped[byteIndex] = (flipped[byteIndex] ?? 0) ^ bitMask;
    vectors.push(
      makeVector({
        caseId: `hamming-${label}`,
        family: "single-bit-hamming-neighbor",
        route: "axelar-its",
        sourceChain: "ethereum",
        bytes: flipped,
        providerLabel: `its:hamming/${label}`,
      }),
    );
  }

  // 5. Axelar `(source_chain, message_id)` XDR boundary shifts sharing identical note nonce.
  const axelarBoundaryPairs: readonly [string, string, string][] = [
    ["eth-split-a", "eth", "ereum-tx-42"],
    ["eth-split-b", "ethereum", "-tx-42"],
    ["arb-split-a", "arbitrum", "10"],
    ["arb-split-b", "arbitrum1", "0"],
  ];
  const sharedNoteNonce = 777n;
  for (const [label, rawChain, rawMessageId] of axelarBoundaryPairs) {
    const xdrFrame = encodeXdrStringPair(rawChain, rawMessageId);
    const derived = deriveDeterministic32Bytes(xdrFrame);
    vectors.push(
      makeVector({
        caseId: `axelar-xdr-${label}`,
        family: "axelar-xdr-boundary-shift",
        route: "axelar-gmp",
        sourceChain: "ethereum",
        bytes: derived,
        shortenedNonceOverride: sharedNoteNonce,
        providerLabel: `axelar:${rawChain}|${rawMessageId}`,
        axelarParts: {
          rawChain,
          rawMessageId,
          xdrFramedHex: toHex(xdrFrame),
        },
      }),
    );
  }

  // 6. Cross-route shared 32-byte identifier delivered once on every supported route.
  const crossRouteBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    crossRouteBytes[i] = (0xa0 + i) & 0xff;
  }
  for (const route of ALL_ROUTE_SLUGS) {
    vectors.push(
      makeVector({
        caseId: `cross-route-${route}`,
        family: "cross-route-shared-id",
        route,
        sourceChain: "ethereum",
        bytes: crossRouteBytes,
        providerLabel: `shared-32b:${route}`,
      }),
    );
  }

  return vectors;
}

function routeScopedKey(route: RouteSlug, messageIdHex: Hex): string {
  return `${route}:${messageIdHex}`;
}

/**
 * Format a deterministic, truncation-free audit summary preserving every byte (`0x` + 64 hex
 * characters) of every `message_id` in the corpus run.
 */
export function formatReplayCorpusReport(
  decisions: readonly ReplayDecisionRecord[],
  violations: readonly string[],
): string {
  const lines: string[] = [
    `decisions=${String(decisions.length)} violations=${String(violations.length)}`,
  ];
  for (const d of decisions) {
    lines.push(
      [
        `step=${String(d.step)}`,
        `case=${d.caseId}`,
        `probe=${d.isReplayProbe ? "replay" : "initial"}`,
        `route=${d.route}`,
        `family=${d.family}`,
        `message_id=${d.messageIdHex}`,
        `prefix8=${d.displayPrefixHex}`,
        `short_nonce=${d.shortenedNonce.toString()}`,
        `accepted=${String(d.accepted)}`,
        `error=${d.error ?? "none"}`,
      ].join(" "),
    );
  }
  for (const v of violations) {
    lines.push(`violation: ${v}`);
  }
  return lines.join("\n");
}

/**
 * Execute the replay collision corpus against Hyperion's route-scoped 32-byte replay model:
 * - Phase 1 delivers every distinct `(route, message_id)` vector and verifies none collide.
 * - Phase 2 re-submits every vector on its exact `(route, message_id)` and verifies deterministic
 *   `ReplayedMessage` rejection while preserving full 32-byte identifiers in every record.
 */
export function evaluateReplayCollisionCorpus(
  vectors: readonly ReplayCorpusVector[] = generateReplayCollisionCorpus(),
): ReplayCorpusAuditReport {
  const processed = new Set<string>();
  const decisions: ReplayDecisionRecord[] = [];
  const violations: string[] = [];

  const applyOne = (vec: ReplayCorpusVector, isReplayProbe: boolean): void => {
    if (vec.messageIdBytes.length !== REPLAY_ID_BYTE_LENGTH) {
      violations.push(
        `case ${vec.caseId}: invalid byte width ${String(vec.messageIdBytes.length)}`,
      );
    }
    const roundTrip = fromHex(vec.messageIdHex);
    if (toHex(roundTrip) !== vec.messageIdHex || vec.messageIdHex.length !== 66) {
      violations.push(`case ${vec.caseId}: messageIdHex did not preserve all 32 bytes`);
    }

    const key = routeScopedKey(vec.route, vec.messageIdHex);
    const wasProcessedBefore = processed.has(key);
    let accepted = false;
    let error: SorobanErrorName | null = null;

    if (wasProcessedBefore) {
      accepted = false;
      error = "ReplayedMessage";
    } else {
      processed.add(key);
      accepted = true;
    }
    const wasProcessedAfter = processed.has(key);

    if (!isReplayProbe && !accepted) {
      violations.push(
        `case ${vec.caseId}: distinct vector (${vec.route}, ${vec.messageIdHex}) falsely rejected as replay`,
      );
    }
    if (isReplayProbe && (accepted || error !== "ReplayedMessage")) {
      violations.push(
        `case ${vec.caseId}: exact replay (${vec.route}, ${vec.messageIdHex}) was not rejected with ReplayedMessage`,
      );
    }

    decisions.push({
      step: decisions.length + 1,
      caseId: vec.caseId,
      family: vec.family,
      isReplayProbe,
      route: vec.route,
      sourceChain: vec.sourceChain,
      messageIdBytes: vec.messageIdBytes.slice(),
      messageIdHex: vec.messageIdHex,
      displayPrefixHex: vec.displayPrefixHex,
      shortenedNonce: vec.shortenedNonce,
      accepted,
      error,
      wasProcessedBefore,
      wasProcessedAfter,
    });
  };

  for (const vec of vectors) {
    applyOne(vec, false);
  }
  for (const vec of vectors) {
    applyOne(vec, true);
  }

  const formattedSummary = formatReplayCorpusReport(decisions, violations);
  return {
    passed: violations.length === 0,
    vectorCount: vectors.length,
    decisionCount: decisions.length,
    distinctRouteScopedKeys: processed.size,
    decisions,
    violations,
    formattedSummary,
  };
}

/**
 * Demonstrate which corpus pair catches a broken replay storage key implementation (8-byte
 * prefix truncation, shortened `u64` nonce keying, route-unscoped 32-byte keying, or unframed
 * Axelar string concatenation).
 */
export function detectTruncatedReplayKeyBug(
  mode: TruncatedReplayKeyMode,
  vectors: readonly ReplayCorpusVector[] = generateReplayCollisionCorpus(),
): TruncatedKeyCollisionFinding | null {
  const seen = new Map<string, ReplayCorpusVector>();

  const computeKey = (v: ReplayCorpusVector): string => {
    switch (mode) {
      case "full-route-scoped-32b":
        return routeScopedKey(v.route, v.messageIdHex);
      case "display-prefix-8b":
        return `${v.route}:${v.displayPrefixHex}`;
      case "shortened-u64-nonce":
        return `${v.route}:${v.shortenedNonce.toString()}`;
      case "route-unscoped-32b":
        return v.messageIdHex;
      case "unframed-axelar-concat":
        if (v.axelarParts !== undefined) {
          return `${v.route}:${v.axelarParts.rawChain}${v.axelarParts.rawMessageId}`;
        }
        return routeScopedKey(v.route, v.messageIdHex);
    }
  };

  for (const vec of vectors) {
    const key = computeKey(vec);
    const prior = seen.get(key);
    if (prior !== undefined) {
      return {
        mode,
        collidedKey: key,
        firstCaseId: prior.caseId,
        firstMessageIdHex: prior.messageIdHex,
        secondCaseId: vec.caseId,
        secondMessageIdHex: vec.messageIdHex,
      };
    }
    seen.set(key, vec);
  }
  return null;
}
