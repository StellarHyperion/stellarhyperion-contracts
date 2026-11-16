import { describe, expect, it } from "vitest";
import {
  ALL_ROUTE_SLUGS,
  REPLAY_ID_BYTE_LENGTH,
  bigIntToBytes,
  concatBytes,
  detectTruncatedReplayKeyBug,
  displayNonce,
  encodeXdrStringPair,
  evaluateReplayCollisionCorpus,
  extractDisplayPrefix,
  extractShortenedNonce,
  fromHex,
  generateReplayCollisionCorpus,
  parseCctpMessage,
  toHex,
} from "../src/index.js";
import type { ReplayCollisionFamily } from "../src/index.js";

describe("replay-identity collision corpus", () => {
  it("spans all six collision families and all four routes with full 32-byte identifiers", () => {
    const corpus = generateReplayCollisionCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(24);

    const families = new Set<ReplayCollisionFamily>(corpus.map((v) => v.family));
    expect(families).toEqual(
      new Set<ReplayCollisionFamily>([
        "shared-display-prefix-8b",
        "shared-shortened-u64-nonce",
        "single-bit-hamming-neighbor",
        "zero-vs-nonzero-high-word",
        "axelar-xdr-boundary-shift",
        "cross-route-shared-id",
      ]),
    );

    const routes = new Set(corpus.map((v) => v.route));
    expect(routes).toEqual(new Set(ALL_ROUTE_SLUGS));

    for (const vec of corpus) {
      expect(vec.messageIdBytes.length).toBe(REPLAY_ID_BYTE_LENGTH);
      expect(vec.messageIdHex).toMatch(/^0x[0-9a-f]{64}$/);
      expect(vec.displayPrefixHex).toMatch(/^0x[0-9a-f]{16}$/);
      expect(toHex(vec.messageIdBytes)).toBe(vec.messageIdHex);
      expect(extractDisplayPrefix(vec.messageIdBytes)).toBe(vec.displayPrefixHex);
    }
  });

  it("never merges distinct messages and rejects exact route-scoped replays while preserving all 32 bytes", () => {
    const corpus = generateReplayCollisionCorpus();
    const report = evaluateReplayCollisionCorpus(corpus);

    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.vectorCount).toBe(corpus.length);
    expect(report.distinctRouteScopedKeys).toBe(corpus.length);
    expect(report.decisionCount).toBe(corpus.length * 2);

    const initialDecisions = report.decisions.filter((d) => !d.isReplayProbe);
    const replayDecisions = report.decisions.filter((d) => d.isReplayProbe);
    expect(initialDecisions.length).toBe(corpus.length);
    expect(replayDecisions.length).toBe(corpus.length);

    for (const d of initialDecisions) {
      expect(d.accepted).toBe(true);
      expect(d.error).toBeNull();
      expect(d.wasProcessedBefore).toBe(false);
      expect(d.wasProcessedAfter).toBe(true);
      expect(d.messageIdBytes.length).toBe(32);
      expect(d.messageIdHex).toMatch(/^0x[0-9a-f]{64}$/);
    }

    for (const d of replayDecisions) {
      expect(d.accepted).toBe(false);
      expect(d.error).toBe("ReplayedMessage");
      expect(d.wasProcessedBefore).toBe(true);
      expect(d.wasProcessedAfter).toBe(true);
      expect(d.messageIdBytes.length).toBe(32);
      expect(d.messageIdHex).toMatch(/^0x[0-9a-f]{64}$/);
    }

    // Every single corpus message_id must appear verbatim (all 64 hex chars, zero ellipsis) in formattedSummary.
    expect(report.formattedSummary).not.toContain("...");
    for (const vec of corpus) {
      expect(report.formattedSummary).toContain(`message_id=${vec.messageIdHex}`);
      expect(fromHex(vec.messageIdHex)).toEqual(vec.messageIdBytes);
    }
  });

  it("matches CctpMessage.displayNonce extraction on full-width 256-bit CCTP headers", () => {
    const sharedShort = corpusSharedPrefixPair();
    const [first, second] = sharedShort;

    const buildHeaderWithNonce = (nonceBytes: Uint8Array): Uint8Array => {
      return concatBytes(
        bigIntToBytes(1n, 4), // version = 1
        bigIntToBytes(0n, 4), // sourceDomain = 0
        bigIntToBytes(27n, 4), // destinationDomain = 27 (Stellar)
        nonceBytes, // 32-byte nonce
        new Uint8Array(32), // sender
        new Uint8Array(32), // recipient
        new Uint8Array(32), // destinationCaller
        bigIntToBytes(2000n, 4), // minFinalityThreshold
        bigIntToBytes(2000n, 4), // finalityThresholdExecuted
      );
    };

    const msgA = parseCctpMessage(buildHeaderWithNonce(first));
    const msgB = parseCctpMessage(buildHeaderWithNonce(second));

    expect(displayNonce(msgA)).toBe(extractShortenedNonce(first));
    expect(displayNonce(msgB)).toBe(extractShortenedNonce(second));
    expect(displayNonce(msgA)).toBe(displayNonce(msgB));
    expect(extractDisplayPrefix(first)).toBe(extractDisplayPrefix(second));
    expect(msgA.nonce).not.toBe(msgB.nonce);
  });

  it("catches every truncated or unframed replay-key bug mode with exact full-width evidence", () => {
    expect(detectTruncatedReplayKeyBug("full-route-scoped-32b")).toBeNull();

    const prefixBug = detectTruncatedReplayKeyBug("display-prefix-8b");
    expect(prefixBug).not.toBeNull();
    expect(prefixBug?.firstMessageIdHex).not.toBe(prefixBug?.secondMessageIdHex);
    expect(prefixBug?.firstMessageIdHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prefixBug?.secondMessageIdHex).toMatch(/^0x[0-9a-f]{64}$/);

    const shortNonceBug = detectTruncatedReplayKeyBug("shortened-u64-nonce");
    expect(shortNonceBug).not.toBeNull();
    expect(shortNonceBug?.firstCaseId).toContain("prefix8-");

    const unscopedBug = detectTruncatedReplayKeyBug("route-unscoped-32b");
    expect(unscopedBug).not.toBeNull();
    expect(unscopedBug?.firstCaseId).toContain("cross-route-");
    expect(unscopedBug?.firstMessageIdHex).toBe(unscopedBug?.secondMessageIdHex);

    const axelarConcatBug = detectTruncatedReplayKeyBug("unframed-axelar-concat");
    expect(axelarConcatBug).not.toBeNull();
    expect(axelarConcatBug?.firstCaseId).toBe("axelar-xdr-eth-split-a");
    expect(axelarConcatBug?.secondCaseId).toBe("axelar-xdr-eth-split-b");
    expect(axelarConcatBug?.firstMessageIdHex).not.toBe(axelarConcatBug?.secondMessageIdHex);

    // Confirm RFC 4506 XDR string framing distinguishes ("eth", "ereum-tx-42") from ("ethereum", "-tx-42").
    const xdrA = encodeXdrStringPair("eth", "ereum-tx-42");
    const xdrB = encodeXdrStringPair("ethereum", "-tx-42");
    expect(toHex(xdrA)).not.toBe(toHex(xdrB));
  });
});

function corpusSharedPrefixPair(): readonly [Uint8Array, Uint8Array] {
  const corpus = generateReplayCollisionCorpus().filter(
    (v) => v.family === "shared-display-prefix-8b",
  );
  const first = corpus[0];
  const second = corpus[1];
  if (first === undefined || second === undefined) {
    throw new Error("expected at least two shared-display-prefix-8b corpus vectors");
  }
  return [first.messageIdBytes, second.messageIdBytes];
}
