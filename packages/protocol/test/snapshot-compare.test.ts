import { describe, expect, it } from "vitest";
import { QuoteBlocker, RouteKind, compareRouteSnapshots } from "../src/index.js";
import type {
  DatedRouteSnapshotCandidate,
  RouterSnapshot,
  SnapshotComparisonTarget,
  SnapshotTokenDescriptor,
} from "../src/index.js";
import { G_ADDR, USDC_MAINNET_ISSUER } from "./fixtures.js";

const STELLAR_TESTNET_USDC: SnapshotTokenDescriptor = {
  chain: "stellar-testnet",
  symbol: "USDC",
  decimals: 7,
  representation: "classic_sac",
  issuerOrAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

const SEPOLIA_NATIVE_USDC: SnapshotTokenDescriptor = {
  chain: "sepolia",
  symbol: "USDC",
  decimals: 6,
  representation: "native_erc20",
  issuerOrAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
};

const SEPOLIA_ITS_USDC: SnapshotTokenDescriptor = {
  chain: "sepolia",
  symbol: "USDC",
  decimals: 7,
  representation: "axelar_its",
  issuerOrAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
};

function makeSnapshot(overrides: Partial<RouterSnapshot> = {}): RouterSnapshot {
  return {
    paused: false,
    feeBps: 30,
    routeEnabled: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.Allbridge]: true,
    },
    adapterSet: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.Allbridge]: true,
    },
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals: 7,
    flowAvailable: {
      [RouteKind.Cctp]: 500_000_000n,
      [RouteKind.AxelarIts]: 500_000_000n,
      [RouteKind.Allbridge]: 500_000_000n,
    },
    chainSupported: {
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.Allbridge]: true,
    },
    ...overrides,
  };
}

const TARGET: SnapshotComparisonTarget = {
  network: "testnet",
  originChain: "stellar-testnet",
  destinationChain: "sepolia",
  amount: 100_000_000n,
  strkey: G_ADDR,
  sourceToken: STELLAR_TESTNET_USDC,
  destinationToken: SEPOLIA_NATIVE_USDC,
  freshnessPolicy: {
    referenceTime: "2026-10-29T12:00:00.000Z",
    maxAgeMs: 30_000,
    maxFutureSkewMs: 2_000,
  },
};

describe("multi-snapshot route comparison API", () => {
  it("rejects mixed networks and distinct token representations from equivalent ranking", () => {
    const candidates: readonly DatedRouteSnapshotCandidate[] = [
      {
        id: "valid-cctp",
        observedAt: "2026-10-29T11:59:50.000Z",
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        sourceToken: STELLAR_TESTNET_USDC,
        destinationToken: SEPOLIA_NATIVE_USDC,
        snapshot: makeSnapshot(),
      },
      {
        id: "its-representation-mismatch",
        observedAt: "2026-10-29T11:59:55.000Z",
        route: RouteKind.AxelarIts,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        sourceToken: STELLAR_TESTNET_USDC,
        destinationToken: SEPOLIA_ITS_USDC,
        snapshot: makeSnapshot({ feeBps: 0 }),
      },
      {
        id: "mainnet-network-mismatch",
        observedAt: "2026-10-29T11:59:58.000Z",
        route: RouteKind.Cctp,
        originChain: "stellar",
        destinationChain: "ethereum",
        sourceToken: {
          chain: "stellar",
          symbol: "USDC",
          decimals: 7,
          representation: "classic_sac",
          issuerOrAddress: USDC_MAINNET_ISSUER,
        },
        destinationToken: {
          chain: "ethereum",
          symbol: "USDC",
          decimals: 6,
          representation: "native_erc20",
          issuerOrAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        },
        snapshot: makeSnapshot({ feeBps: 0 }),
      },
    ];

    const result = compareRouteSnapshots(TARGET, candidates);
    expect(result.rankedEligible.map((c) => c.id)).toEqual(["valid-cctp"]);
    expect(result.incompatible.map((c) => [c.id, c.incompatibilityReason])).toEqual([
      ["its-representation-mismatch", "destination_token_mismatch"],
      ["mainnet-network-mismatch", "network_mismatch"],
    ]);
  });

  it("distinguishes stale snapshots from fresh unavailable routes under the timestamp policy", () => {
    const candidates: readonly DatedRouteSnapshotCandidate[] = [
      {
        id: "stale-expired",
        observedAt: "2026-10-29T11:58:00.000Z",
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        sourceToken: STELLAR_TESTNET_USDC,
        destinationToken: SEPOLIA_NATIVE_USDC,
        snapshot: makeSnapshot(),
      },
      {
        id: "stale-future-skew",
        observedAt: "2026-10-29T12:00:10.000Z",
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        sourceToken: STELLAR_TESTNET_USDC,
        destinationToken: SEPOLIA_NATIVE_USDC,
        snapshot: makeSnapshot(),
      },
      {
        id: "fresh-paused",
        observedAt: "2026-10-29T11:59:55.000Z",
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        sourceToken: STELLAR_TESTNET_USDC,
        destinationToken: SEPOLIA_NATIVE_USDC,
        snapshot: makeSnapshot({ paused: true }),
      },
      {
        id: "fresh-over-flow",
        observedAt: "2026-10-29T11:59:56.000Z",
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        sourceToken: STELLAR_TESTNET_USDC,
        destinationToken: SEPOLIA_NATIVE_USDC,
        snapshot: makeSnapshot({
          flowAvailable: { [RouteKind.Cctp]: 1_000_000n },
        }),
      },
    ];

    const result = compareRouteSnapshots(TARGET, candidates);
    expect(result.winner).toBeNull();
    expect(result.stale.map((c) => [c.id, c.staleReason])).toEqual([
      ["stale-expired", "expired_snapshot"],
      ["stale-future-skew", "future_clock_skew"],
    ]);
    expect(result.unavailable.map((c) => [c.id, c.blocker])).toEqual([
      ["fresh-paused", QuoteBlocker.Paused],
      ["fresh-over-flow", QuoteBlocker.FlowLimitExceeded],
    ]);
  });

  it("produces identical deterministic ranking regardless of candidate input order", () => {
    const a: DatedRouteSnapshotCandidate = {
      id: "cctp-older",
      observedAt: "2026-10-29T11:59:40.000Z",
      route: RouteKind.Cctp,
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      sourceToken: STELLAR_TESTNET_USDC,
      destinationToken: SEPOLIA_NATIVE_USDC,
      snapshot: makeSnapshot({ feeBps: 30 }),
    };
    const b: DatedRouteSnapshotCandidate = {
      id: "cctp-fresher",
      observedAt: "2026-10-29T11:59:58.000Z",
      route: RouteKind.Cctp,
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      sourceToken: STELLAR_TESTNET_USDC,
      destinationToken: SEPOLIA_NATIVE_USDC,
      snapshot: makeSnapshot({ feeBps: 30 }),
    };
    const c: DatedRouteSnapshotCandidate = {
      id: "cctp-lower-fee",
      observedAt: "2026-10-29T11:59:45.000Z",
      route: RouteKind.Cctp,
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      sourceToken: STELLAR_TESTNET_USDC,
      destinationToken: SEPOLIA_NATIVE_USDC,
      snapshot: makeSnapshot({ feeBps: 10 }),
    };

    const forward = compareRouteSnapshots(TARGET, [a, b, c]);
    const reverse = compareRouteSnapshots(TARGET, [c, b, a]);
    const rotated = compareRouteSnapshots(TARGET, [b, a, c]);

    const expectedOrder = ["cctp-lower-fee", "cctp-fresher", "cctp-older"];
    expect(forward.rankedEligible.map((e) => e.id)).toEqual(expectedOrder);
    expect(reverse.rankedEligible.map((e) => e.id)).toEqual(expectedOrder);
    expect(rotated.rankedEligible.map((e) => e.id)).toEqual(expectedOrder);
    expect(forward.winner?.id).toBe("cctp-lower-fee");
  });
});
