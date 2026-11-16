import { describe, expect, it } from "vitest";
import {
  QuoteBlocker,
  ROUTE_HEALTH_SCHEMA_VERSION,
  RouteHealthFormatError,
  RouteKind,
  applyRouteHealthToSnapshot,
  isUsableForLiveQuote,
  parseRouteHealthRecord,
  parseRouteHealthSnapshot,
  planQuote,
} from "../src/index.js";
import type { RouterSnapshot } from "../src/index.js";
import { G_ADDR } from "./fixtures.js";

function baseSnapshot(): RouterSnapshot {
  return Object.freeze({
    paused: false,
    feeBps: 10,
    routeEnabled: Object.freeze({
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
      [RouteKind.AxelarGmp]: false,
      [RouteKind.Allbridge]: false,
    }),
    adapterSet: Object.freeze({
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
    }),
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals: 7,
    flowAvailable: Object.freeze({
      [RouteKind.Cctp]: 500_000_000n,
      [RouteKind.AxelarIts]: 500_000_000n,
    }),
    chainSupported: Object.freeze({
      [RouteKind.Cctp]: true,
      [RouteKind.AxelarIts]: true,
    }),
  });
}

describe("external route-health snapshot validation", () => {
  it("prevents event-driven configuration samples from masquerading as live quotes", () => {
    const sample = parseRouteHealthRecord({
      route: "cctp",
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      measuredAt: "2026-04-12T10:00:00Z",
      scope: "event_config_sample",
      routeState: "enabled",
      providerHealth: "healthy",
    });

    expect(sample.usableForLiveQuote).toBe(false);
    expect(isUsableForLiveQuote(sample)).toBe(false);

    // Event samples claiming live flowAvailable or usableForLiveQuote=true fail at the bad field.
    expect(() =>
      parseRouteHealthRecord(
        {
          route: "cctp",
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          measuredAt: "2026-04-12T10:00:00Z",
          scope: "event_config_sample",
          routeState: "enabled",
          providerHealth: "healthy",
          flowAvailable: "1000000",
        },
        "$.records[0]",
      ),
    ).toThrow(
      new RouteHealthFormatError(
        "$.records[0].flowAvailable",
        'scope "event_config_sample" cannot assert live flowAvailable; only "live_quote" records may carry live headroom',
      ),
    );

    expect(() =>
      parseRouteHealthRecord(
        {
          route: "axelar-its",
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          measuredAt: "2026-04-12T10:00:00Z",
          scope: "event_config_sample",
          routeState: "enabled",
          providerHealth: "healthy",
          usableForLiveQuote: true,
        },
        "$.records[1]",
      ),
    ).toThrow(/route health invalid at \$\.records\[1\]\.usableForLiveQuote/);

    // Overlaying an event sample conservatively blocks live quoting on that rail.
    const overlaid = applyRouteHealthToSnapshot(baseSnapshot(), [sample]);
    expect(overlaid.decisions[RouteKind.Cctp]?.allowed).toBe(false);
    expect(overlaid.decisions[RouteKind.Cctp]?.reason).toBe("non_live_scope");
    const quote = planQuote(
      { route: RouteKind.Cctp, amount: 10_000_000n, strkey: G_ADDR, destinationDecimals: 6 },
      overlaid.snapshot,
    );
    expect(quote.available).toBe(false);
    expect(quote.reason).toBe(QuoteBlocker.RouteDisabled);
  });

  it("reports exact field paths for malformed status, timestamp, chain, and integer fields", () => {
    const validRecord = {
      route: "cctp",
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      measuredAt: "2026-04-12T10:00:00.250Z",
      scope: "live_quote",
      routeState: "enabled",
      providerHealth: "healthy",
      flowAvailable: "250000000",
    };

    const badCases: readonly { mut: Record<string, unknown>; expectedPath: string }[] = [
      {
        mut: { ...validRecord, measuredAt: "not-a-timestamp" },
        expectedPath: "$.records[0].measuredAt",
      },
      {
        mut: { ...validRecord, measuredAt: "2026-02-30T10:00:00Z" },
        expectedPath: "$.records[0].measuredAt",
      },
      {
        mut: { ...validRecord, measuredAt: 1712916000000 },
        expectedPath: "$.records[0].measuredAt",
      },
      {
        mut: { ...validRecord, providerHealth: "optimistic" },
        expectedPath: "$.records[0].providerHealth",
      },
      { mut: { ...validRecord, routeState: "ready" }, expectedPath: "$.records[0].routeState" },
      { mut: { ...validRecord, scope: "cached" }, expectedPath: "$.records[0].scope" },
      { mut: { ...validRecord, route: "wormhole" }, expectedPath: "$.records[0].route" },
      { mut: { ...validRecord, originChain: "solana" }, expectedPath: "$.records[0].originChain" },
      {
        mut: { ...validRecord, destinationChain: "stellar-testnet" },
        expectedPath: "$.records[0].destinationChain",
      },
      {
        mut: { ...validRecord, flowAvailable: 250000000 },
        expectedPath: "$.records[0].flowAvailable",
      },
      { mut: { ...validRecord, flowAvailable: "-5" }, expectedPath: "$.records[0].flowAvailable" },
    ];

    for (const { mut, expectedPath } of badCases) {
      try {
        parseRouteHealthSnapshot({
          schemaVersion: ROUTE_HEALTH_SCHEMA_VERSION,
          capturedAt: "2026-04-12T10:00:01Z",
          records: [mut],
        });
        expect.unreachable(`expected failure at ${expectedPath}`);
      } catch (error) {
        expect(error).toBeInstanceOf(RouteHealthFormatError);
        expect((error as RouteHealthFormatError).path).toBe(expectedPath);
      }
    }

    expect(() =>
      parseRouteHealthSnapshot({
        schemaVersion: 99,
        capturedAt: "2026-04-12T10:00:01Z",
        records: [],
      }),
    ).toThrow(/route health invalid at \$\.schemaVersion/);
  });

  it("preserves conservative planning when provider health is unknown or stale and keeps wide bigints exact", () => {
    const maxUint128 = (1n << 128n) - 1n;
    const healthSnapshot = parseRouteHealthSnapshot({
      schemaVersion: 1,
      capturedAt: "2026-04-12T12:00:10Z",
      records: [
        {
          route: "cctp",
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          measuredAt: "2026-04-12T12:00:05Z",
          scope: "live_quote",
          routeState: "enabled",
          providerHealth: "unknown",
          flowAvailable: maxUint128.toString(),
        },
        {
          route: "axelar-its",
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          measuredAt: "2026-04-12T12:00:08Z",
          scope: "live_quote",
          routeState: "enabled",
          providerHealth: "healthy",
          flowAvailable: "120000000",
        },
      ],
    });

    expect(healthSnapshot.records[0]?.flowAvailable).toBe(maxUint128);
    expect(healthSnapshot.records[0]?.usableForLiveQuote).toBe(false);
    expect(healthSnapshot.records[1]?.usableForLiveQuote).toBe(true);

    const frozenRouter = baseSnapshot();
    const overlaid = applyRouteHealthToSnapshot(frozenRouter, healthSnapshot, {
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      referenceTime: "2026-04-12T12:00:10Z",
      maxAgeMs: 30_000,
    });

    // Unknown provider health disables CCTP conservatively without mutating frozenRouter.
    expect(frozenRouter.routeEnabled[RouteKind.Cctp]).toBe(true);
    expect(overlaid.decisions[RouteKind.Cctp]?.reason).toBe("provider_health_unknown");
    expect(overlaid.snapshot.routeEnabled[RouteKind.Cctp]).toBe(false);

    // Healthy live_quote ITS stays enabled and caps flowAvailable to min(500M, 120M) = 120M.
    expect(overlaid.decisions[RouteKind.AxelarIts]?.reason).toBe("eligible_live");
    expect(overlaid.snapshot.routeEnabled[RouteKind.AxelarIts]).toBe(true);
    expect(overlaid.snapshot.flowAvailable[RouteKind.AxelarIts]).toBe(120_000_000n);

    // If referenceTime advances past maxAgeMs, the live_quote record becomes stale and conservative.
    const staleOverlay = applyRouteHealthToSnapshot(frozenRouter, healthSnapshot, {
      referenceTime: "2026-04-12T12:05:00Z",
      maxAgeMs: 30_000,
    });
    expect(staleOverlay.decisions[RouteKind.AxelarIts]?.reason).toBe("stale_measurement");
    expect(staleOverlay.snapshot.routeEnabled[RouteKind.AxelarIts]).toBe(false);
  });
});
