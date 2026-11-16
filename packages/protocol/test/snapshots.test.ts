import { describe, expect, it } from "vitest";
import {
  MAX_QUOTE_AMOUNT,
  PERSISTED_SNAPSHOT_FRESHNESS_CLASS,
  RouteKind,
  SNAPSHOT_SERIALIZATION_VERSION,
  SnapshotSerializationError,
  deserializePersistedQuoteBundle,
  deserializeRouterSnapshot,
  parseRouterSnapshotJson,
  planQuotes,
  serializePersistedQuoteBundle,
  serializeRouterSnapshot,
  stringifyRouterSnapshot,
} from "../src/index.js";
import type { RouterSnapshot } from "../src/index.js";
import { G_ADDR } from "./fixtures.js";

describe("protocol snapshot serialization format for bigint-safe persistence", () => {
  it("preserves every wide integer (above 2^53, 2^128 - 1, and 2^256 - 1) across JSON round trips", () => {
    const aboveSafeInt = (1n << 53n) + 1n;
    const maxU128 = MAX_QUOTE_AMOUNT;
    const maxU256 = (1n << 256n) - 1n;

    const snapshot: RouterSnapshot = {
      paused: false,
      feeBps: 30,
      routeEnabled: {
        [RouteKind.Cctp]: true,
        [RouteKind.AxelarIts]: true,
        [RouteKind.AxelarGmp]: false,
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
        [RouteKind.Cctp]: aboveSafeInt,
        [RouteKind.AxelarIts]: maxU128,
        [RouteKind.Allbridge]: maxU256,
        [RouteKind.AxelarGmp]: 0n,
      },
      chainSupported: {
        [RouteKind.Cctp]: true,
        [RouteKind.AxelarIts]: true,
        [RouteKind.Allbridge]: false,
      },
    };

    const jsonText = stringifyRouterSnapshot(snapshot, {
      capturedAt: "2026-10-29T10:17:56.262Z",
      originChain: "stellar-testnet",
      tokenSymbol: "USDC",
    });
    const restored = parseRouterSnapshotJson(jsonText);

    expect(restored.snapshot).toEqual(snapshot);
    expect(restored.snapshot.flowAvailable[RouteKind.Cctp]).toBe(aboveSafeInt);
    expect(restored.snapshot.flowAvailable[RouteKind.AxelarIts]).toBe(maxU128);
    expect(restored.snapshot.flowAvailable[RouteKind.Allbridge]).toBe(maxU256);
    expect(restored.units).toEqual({
      amountEncoding: "base_unit_uint_string",
      tokenDecimals: 7,
      feeUnit: "bps",
    });

    const quotes = planQuotes(
      { amount: maxU128, strkey: G_ADDR, destinationDecimals: 18 },
      snapshot,
    );
    const bundleJson = JSON.stringify(
      serializePersistedQuoteBundle({
        capturedAt: "2026-10-29T10:17:56.262Z",
        destinationDecimals: 18,
        snapshot,
        quotes,
      }),
    );
    const restoredBundle = deserializePersistedQuoteBundle(JSON.parse(bundleJson) as unknown);
    expect(restoredBundle.quotes).toEqual(quotes);
    expect(restoredBundle.units.destinationDecimals).toBe(18);
  });

  it("fails clearly on unknown schema versions and malformed integer strings", () => {
    const valid = serializeRouterSnapshot(
      {
        paused: false,
        feeBps: 10,
        routeEnabled: { [RouteKind.Cctp]: true },
        adapterSet: { [RouteKind.Cctp]: true },
        tokenRegistered: true,
        tokenEnabled: true,
        tokenDecimals: 7,
        flowAvailable: { [RouteKind.Cctp]: 1_000_000n },
        chainSupported: { [RouteKind.Cctp]: true },
      },
      { capturedAt: "2026-10-29T10:17:56.262Z" },
    );

    // 1. Unknown schemaVersion
    try {
      deserializeRouterSnapshot({
        ...valid,
        schemaVersion: SNAPSHOT_SERIALIZATION_VERSION + 1,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotSerializationError);
      expect((error as SnapshotSerializationError).path).toBe("$.schemaVersion");
    }

    // 2. Malformed amount strings (JSON number, decimal, negative, scientific, hex, leading zero)
    for (const badAmount of [1000, "10.5", "-5", "1e18", "0xff", "007", ""] as const) {
      try {
        deserializeRouterSnapshot({
          ...valid,
          state: {
            ...valid.state,
            flowAvailable: {
              cctp: badAmount,
            },
          },
        });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SnapshotSerializationError);
        expect((error as SnapshotSerializationError).path).toBe("$.state.flowAvailable.cctp");
      }
    }
  });

  it("never implies fresh live prices and rejects tampered live-price flags", () => {
    const serialized = serializeRouterSnapshot(
      {
        paused: false,
        feeBps: 30,
        routeEnabled: { [RouteKind.Cctp]: true },
        adapterSet: { [RouteKind.Cctp]: true },
        tokenRegistered: true,
        tokenEnabled: true,
        tokenDecimals: 7,
        flowAvailable: { [RouteKind.Cctp]: 50_000_000n },
        chainSupported: { [RouteKind.Cctp]: true },
      },
      { capturedAt: "2026-10-29T10:17:56.262Z" },
    );

    expect(serialized.freshnessClass).toBe(PERSISTED_SNAPSHOT_FRESHNESS_CLASS);
    expect(serialized.impliesLivePrice).toBe(false);

    const restored = deserializeRouterSnapshot(serialized);
    expect(restored.freshnessClass).toBe("persisted_historical_snapshot");
    expect(restored.impliesLivePrice).toBe(false);
    expect(restored.requiresChainReconfirmation).toBe(true);

    expect(() =>
      deserializeRouterSnapshot({
        ...serialized,
        impliesLivePrice: true,
      }),
    ).toThrow(SnapshotSerializationError);

    expect(() =>
      deserializeRouterSnapshot({
        ...serialized,
        freshnessClass: "live_executable_quote",
      }),
    ).toThrow(SnapshotSerializationError);
  });
});
