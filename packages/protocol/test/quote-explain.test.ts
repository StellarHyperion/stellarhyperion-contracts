/**
 * The quote explanation tree, checked against `planQuote` rather than against itself.
 */
import { describe, expect, it } from "vitest";

import { MAX_DECIMALS } from "../src/amounts.js";
import {
  BLOCKER_COPY,
  MAX_QUOTE_AMOUNT,
  QuoteBlocker,
  bestQuote,
  parseQuoteSnapshot,
  planQuote,
  serializeQuoteSnapshot,
  planQuotes,
} from "../src/quotes.js";
import type { QuoteRequest, RouterSnapshot } from "../src/quotes.js";
import {
  QUOTE_CHECK_IDS,
  QUOTE_EXPLANATION_VERSION,
  QUOTE_POLICIES,
  explainQuote,
  explainQuotes,
  serializeQuoteExplanation,
} from "../src/quotes/explain.js";
import type {
  CheckNode,
  DerivationId,
  DerivationNode,
  QuoteExplanation,
} from "../src/quotes/explain.js";
import { ROUTE_KINDS, RouteKind } from "../src/routes.js";
import { C_ADDR, G_ADDR, M_ADDR } from "./fixtures.js";

const all = <T>(value: T): Record<RouteKind, T> => ({
  [RouteKind.Cctp]: value,
  [RouteKind.AxelarIts]: value,
  [RouteKind.AxelarGmp]: value,
  [RouteKind.Allbridge]: value,
});

/** Everything open, thirty basis points, seven decimals in and six out (Stellar USDC to EVM). */
function snapshot(overrides: Partial<RouterSnapshot> = {}): RouterSnapshot {
  return {
    paused: false,
    feeBps: 30,
    routeEnabled: all(true),
    adapterSet: all(true),
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals: 7,
    flowAvailable: all(10_000_000_000n),
    chainSupported: all(true),
    ...overrides,
  };
}

const request = (overrides: Partial<QuoteRequest> = {}): QuoteRequest => ({
  route: RouteKind.Cctp,
  amount: 1_000_000_123n,
  strkey: G_ADDR,
  destinationDecimals: 6,
  ...overrides,
});

function nodes(e: QuoteExplanation): (CheckNode | DerivationNode)[] {
  return e.groups.flatMap((g) => g.children);
}

function derivation(e: QuoteExplanation, id: DerivationId): DerivationNode {
  const node = nodes(e).find((n) => n.kind === "derivation" && n.id === id);
  if (node?.kind !== "derivation") throw new Error(`no ${id}`);
  return node;
}

function value(e: QuoteExplanation, id: DerivationId): bigint {
  const v = derivation(e, id).value;
  if (v === null) throw new Error(`${id} was not reached`);
  return v;
}

/** The invariants every explanation must satisfy against its own quote. */
function assertExact(e: QuoteExplanation, req: QuoteRequest, snap: RouterSnapshot) {
  expect(e.quote).toEqual(planQuote(req, snap));
  const checks = nodes(e).filter((n): n is CheckNode => n.kind === "check");
  expect(checks.map((c) => c.id)).toEqual([...QUOTE_CHECK_IDS]);
  const blocked = checks.filter((c) => c.status === "blocked");
  expect(blocked.length).toBeLessThanOrEqual(1);
  const firstBlocked = checks.findIndex((c) => c.status === "blocked");
  if (firstBlocked >= 0) {
    // Everything after the failing check is marked not reached, in the router's order.
    for (const c of checks.slice(firstBlocked + 1)) expect(c.status).toBe("not-reached");
    expect(e.blockedBy).toBe(checks[firstBlocked]!.policy);
    expect(e.quote.reason).toBe(e.blockedBy?.blocker);
    expect(e.quote.available).toBe(false);
    return;
  }
  expect(e.blockedBy).toBeNull();
  expect(e.quote.available).toBe(true);
  const fee = value(e, "amount.fee");
  const before = value(e, "amount.net-before-precision");
  const net = value(e, "amount.precision-floor");
  const dust = value(e, "amount.dust");
  const gross = value(e, "settlement.gross");
  expect(fee).toBe(e.quote.fee);
  expect(net).toBe(e.quote.netAmount);
  expect(gross).toBe(e.quote.grossAmount);
  expect(value(e, "settlement.destination")).toBe(e.quote.destinationAmount);
  expect(value(e, "flow.available")).toBe(e.quote.flowAvailable);
  expect(value(e, "flow.remaining")).toBe(e.quote.flowAvailable - e.quote.netAmount);
  expect(fee + before).toBe(req.amount);
  expect(net + dust).toBe(before);
  expect(gross + value(e, "settlement.retained")).toBe(req.amount);
  expect(value(e, "settlement.retained")).toBe(dust);
}

describe("explaining an available quote", () => {
  it("derives fee, dust, flow and the destination amount exactly", () => {
    const req = request();
    const snap = snapshot();
    const e = explainQuote(req, snap);
    assertExact(e, req, snap);
    expect(e.version).toBe(QUOTE_EXPLANATION_VERSION);
    expect(derivation(e, "amount.fee")).toEqual({
      kind: "derivation",
      id: "amount.fee",
      status: "computed",
      formula: "floor(amount * feeBps / 10000)",
      inputs: { amount: 1_000_000_123n, feeBps: 30n, denominator: 10_000n },
      value: 3_000_000n,
    });
    // 1_000_000_123 - 3_000_000 = 997_000_123; seven to six decimals floors off the last digit.
    expect(derivation(e, "amount.precision-floor").inputs).toEqual({
      netBeforePrecision: 997_000_123n,
      sourceDecimals: 7n,
      destinationDecimals: 6n,
      divisor: 10n,
    });
    expect(value(e, "amount.precision-floor")).toBe(997_000_120n);
    expect(value(e, "amount.dust")).toBe(3n);
    expect(value(e, "settlement.gross")).toBe(1_000_000_120n);
    expect(value(e, "settlement.destination")).toBe(99_700_012n);
    expect(value(e, "flow.remaining")).toBe(10_000_000_000n - 997_000_120n);
    expect(e.groups.map((g) => [g.id, g.status])).toEqual([
      ["route", "pass"],
      ["destination", "pass"],
      ["token", "pass"],
      ["amount", "computed"],
      ["breaker", "pass"],
      ["flow", "computed"],
      ["settlement", "computed"],
    ]);
  });

  it("widens without dust when the destination keeps more decimals", () => {
    const req = request({ amount: 1_000_000n, destinationDecimals: 18 });
    const snap = snapshot({ tokenDecimals: 6 });
    const e = explainQuote(req, snap);
    assertExact(e, req, snap);
    expect(value(e, "amount.dust")).toBe(0n);
    expect(value(e, "settlement.destination")).toBe(997_000n * 10n ** 12n);
  });

  it("stays exact at the largest amount the router prices", () => {
    for (const [tokenDecimals, destinationDecimals] of [
      [7, 6],
      [6, 6],
      [0, MAX_DECIMALS],
      [MAX_DECIMALS, 0],
    ] as const) {
      const req = request({ amount: MAX_QUOTE_AMOUNT, destinationDecimals });
      const snap = snapshot({ tokenDecimals, flowAvailable: all((1n << 256n) - 1n) });
      const e = explainQuote(req, snap);
      assertExact(e, req, snap);
    }
  });
});

describe("explaining a blocked quote", () => {
  const cases: [
    string,
    Partial<QuoteRequest>,
    Partial<RouterSnapshot>,
    (typeof QUOTE_CHECK_IDS)[number],
  ][] = [
    ["paused", {}, { paused: true }, "route.paused"],
    ["route disabled", {}, { routeEnabled: {} }, "route.enabled"],
    ["no adapter", {}, { adapterSet: { [RouteKind.Cctp]: false } }, "route.adapter"],
    ["bad strkey", { strkey: `${G_ADDR.slice(0, -1)}A` }, {}, "destination.strkey"],
    [
      "muxed on allbridge",
      { strkey: M_ADDR, route: RouteKind.Allbridge },
      {},
      "destination.muxed-payload",
    ],
    ["unsupported chain", {}, { chainSupported: {} }, "destination.chain"],
    ["unregistered token", {}, { tokenRegistered: false }, "token.registered"],
    ["disabled token", {}, { tokenEnabled: false }, "token.enabled"],
    ["zero amount", { amount: 0n }, {}, "amount.positive"],
    ["negative amount", { amount: -1n }, {}, "amount.positive"],
    ["over the max", { amount: MAX_QUOTE_AMOUNT + 1n }, {}, "amount.max"],
    [
      "destination decimals over 38",
      { destinationDecimals: MAX_DECIMALS + 1 },
      {},
      "amount.decimals",
    ],
    ["floors to zero", { amount: 9n }, { feeBps: 0 }, "amount.representable"],
    ["breaker latched", {}, { circuitBreakerTripped: true }, "breaker.latched"],
    [
      "over the breaker threshold",
      {},
      { circuitBreakerAvailable: 997_000_119n },
      "breaker.headroom",
    ],
    ["over the flow window", {}, { flowAvailable: all(997_000_119n) }, "flow.headroom"],
    ["flow absent from snapshot", {}, { flowAvailable: {} }, "flow.headroom"],
  ];

  for (const [name, req, snap, check] of cases) {
    it(`names the owning policy for ${name}`, () => {
      const r = request(req);
      const s = snapshot(snap);
      const e = explainQuote(r, s);
      assertExact(e, r, s);
      expect(e.blockedBy?.id).toBe(check);
      expect(e.blockedBy).toBe(QUOTE_POLICIES[check]);
    });
  }

  it("records the exact headroom a flow block compared against", () => {
    const s = snapshot({ flowAvailable: all(997_000_119n) });
    const e = explainQuote(request(), s);
    const flow = nodes(e).find((n) => n.id === "flow.headroom");
    expect(flow).toMatchObject({ status: "blocked", observed: 997_000_119n });
    expect(value(e, "flow.available")).toBe(997_000_119n);
    expect(value(e, "amount.precision-floor")).toBe(997_000_120n);
    expect(derivation(e, "flow.remaining")).toMatchObject({
      status: "not-reached",
      value: null,
      inputs: {},
    });
    expect(e.quote.flowAvailable).toBe(997_000_119n);
  });

  it("attributes every blocker to a policy kind, a source field and the app's owner", () => {
    expect(Object.keys(QUOTE_POLICIES)).toEqual([...QUOTE_CHECK_IDS]);
    for (const p of Object.values(QUOTE_POLICIES)) {
      expect(p.fixableBy).toBe(BLOCKER_COPY[p.blocker].owner);
      expect(p.source.length).toBeGreaterThan(0);
      expect(p.blocker).not.toBe(QuoteBlocker.None);
    }
    const kinds = (kind: string) =>
      Object.values(QUOTE_POLICIES)
        .filter((p) => p.kind === kind)
        .map((p) => p.id);
    expect(kinds("router-policy")).toEqual([
      "route.paused",
      "route.enabled",
      "route.adapter",
      "token.registered",
      "token.enabled",
      "breaker.latched",
      "breaker.headroom",
      "flow.headroom",
    ]);
    expect(kinds("rail-capability")).toEqual(["destination.muxed-payload", "destination.chain"]);
    // Every blocker the ladder can return is owned by at least one check.
    const owned = new Set(Object.values(QUOTE_POLICIES).map((p) => p.blocker));
    for (const blocker of Object.values(QuoteBlocker)) {
      if (blocker !== QuoteBlocker.None) expect(owned.has(blocker), String(blocker)).toBe(true);
    }
  });
});

describe("explaining the ranking", () => {
  it("names the winner bestQuote picks and why each other rail lost", () => {
    const s = snapshot({
      flowAvailable: { ...all(10_000_000_000n), [RouteKind.AxelarGmp]: 0n },
      routeEnabled: { ...all(true), [RouteKind.Allbridge]: false },
    });
    const req = { amount: 1_000_000_123n, strkey: G_ADDR, destinationDecimals: 6 };
    const e = explainQuotes(req, s);
    expect(e.winner).toBe(bestQuote(planQuotes(req, s))?.route);
    expect(e.explanations.map((x) => x.quote)).toEqual(planQuotes(req, s));
    expect(e.ranking.map((r) => [r.route, r.reason, r.blockedBy?.id ?? null])).toEqual([
      [RouteKind.Cctp, "winner", null],
      // Both canonical and both attested, so the earlier rail keeps the lead.
      [RouteKind.AxelarIts, "tie-earlier-rail-kept", null],
      [RouteKind.AxelarGmp, "blocked", "flow.headroom"],
      [RouteKind.Allbridge, "blocked", "route.enabled"],
    ]);
  });

  it("explains an M address that only payload rails can carry", () => {
    const e = explainQuotes(
      { amount: 1_000_000_123n, strkey: M_ADDR, destinationDecimals: 6 },
      snapshot(),
    );
    for (const entry of e.ranking) {
      const quote = e.explanations.find((x) => x.route === entry.route)!.quote;
      if (!quote.available) expect(entry.blockedBy?.kind).toBe("rail-capability");
    }
    expect(e.winner).toBe(bestQuote(e.explanations.map((x) => x.quote))?.route ?? null);
  });

  it("returns no winner when every rail is blocked", () => {
    const e = explainQuotes(
      { amount: 1n, strkey: C_ADDR, destinationDecimals: 6 },
      snapshot({ paused: true }),
    );
    expect(e.winner).toBeNull();
    expect(
      e.ranking.every((r) => r.reason === "blocked" && r.blockedBy?.id === "route.paused"),
    ).toBe(true);
  });
});

describe("determinism and parity with planQuote", () => {
  it("matches planQuote exactly over a seeded sweep of amounts, fees, precisions and states", () => {
    let seed = 0x9e3779b97f4a7c15n;
    const next = (bits: bigint): bigint => {
      seed ^= (seed << 13n) & ((1n << 64n) - 1n);
      seed ^= seed >> 7n;
      seed ^= (seed << 17n) & ((1n << 64n) - 1n);
      return seed & ((1n << bits) - 1n);
    };
    const strkeys = [G_ADDR, C_ADDR, M_ADDR, "not an address"];
    for (let i = 0; i < 2_000; i += 1) {
      const widths = [8n, 32n, 64n, 128n, 129n];
      const amount = next(widths[Number(next(3n)) % widths.length]!) - (next(4n) === 0n ? 1n : 0n);
      const route = ROUTE_KINDS[Number(next(2n))]!;
      const req = {
        route,
        amount,
        strkey: strkeys[Number(next(2n))]!,
        destinationDecimals: Number(next(6n)) % (MAX_DECIMALS + 2),
      };
      const snap = snapshot({
        paused: next(5n) === 0n,
        feeBps: Number(next(7n)) % 101,
        tokenDecimals: Number(next(6n)) % (MAX_DECIMALS + 1),
        tokenEnabled: next(6n) !== 0n,
        flowAvailable: all(next(next(1n) === 0n ? 40n : 130n)),
        ...(next(4n) === 0n ? { circuitBreakerTripped: true } : {}),
        ...(next(2n) === 0n ? { circuitBreakerAvailable: next(next(1n) === 0n ? 40n : 130n) } : {}),
      });
      assertExact(explainQuote(req, snap), req, snap);
    }
  });

  it("serialises to the same text every time, with bigints as decimal strings", () => {
    const text = serializeQuoteExplanation(explainQuote(request(), snapshot()));
    expect(serializeQuoteExplanation(explainQuote(request(), snapshot()))).toBe(text);
    const parsed = JSON.parse(text) as { quote: { netAmount: string }; groups: unknown[] };
    expect(parsed.quote.netAmount).toBe("997000120");
    expect(parsed.groups).toHaveLength(7);
    expect(text).not.toMatch(/\d+n\b/);
  });

  it("explains a snapshot loaded from persisted external data, matching its recorded quotes", () => {
    const router = snapshot({ flowAvailable: all((1n << 256n) - 1n) });
    const input = { amount: MAX_QUOTE_AMOUNT, strkey: G_ADDR, destinationDecimals: 6 };
    const serialized = serializeQuoteSnapshot({
      capturedAt: 1_700_000_000n,
      amountUnit: "source-token-base-units",
      destinationUnit: "destination-token-base-units",
      router,
      request: input,
      quotes: planQuotes(input, router),
    });
    const loaded = parseQuoteSnapshot(serialized);
    const e = explainQuotes(loaded.request, loaded.router);
    expect(e.explanations.map((x) => x.quote)).toEqual(loaded.quotes);
    for (const x of e.explanations)
      assertExact(x, { ...loaded.request, route: x.route }, loaded.router);
  });
});

describe("refusing malformed input", () => {
  it("names the bad request field", () => {
    const bad = (r: unknown, message: RegExp) => {
      expect(() => explainQuote(r as QuoteRequest, snapshot())).toThrow(message);
    };
    bad(null, /request must be an object/);
    bad({ ...request(), route: 9 }, /request.route/);
    bad({ ...request(), amount: 10 }, /request.amount must be a bigint/);
    bad({ ...request(), strkey: 7 }, /request.strkey/);
    bad({ ...request(), destinationDecimals: -1 }, /request.destinationDecimals/);
    bad({ ...request(), destinationDecimals: 6.5 }, /request.destinationDecimals/);
  });

  it("names the bad snapshot field, using the planners' own bounds", () => {
    const bad = (s: unknown, message: RegExp) => {
      expect(() => explainQuote(request(), s as RouterSnapshot)).toThrow(message);
    };
    bad({ ...snapshot(), feeBps: 101 }, /snapshot.feeBps/);
    bad({ ...snapshot(), feeBps: 1.5 }, /snapshot.feeBps/);
    bad({ ...snapshot(), tokenDecimals: MAX_DECIMALS + 1 }, /snapshot.tokenDecimals/);
    bad({ ...snapshot(), paused: "no" }, /snapshot.paused/);
    bad({ ...snapshot(), routeEnabled: { "9": true } }, /snapshot.routeEnabled.9/);
    bad({ ...snapshot(), flowAvailable: { "0": -1n } }, /snapshot.flowAvailable.0/);
    bad({ ...snapshot(), flowAvailable: { "0": 1 << 30 } }, /snapshot.flowAvailable.0/);
    bad({ ...snapshot(), flowAvailable: { "0": 1n << 256n } }, /snapshot.flowAvailable.0/);
    bad({ ...snapshot(), circuitBreakerTripped: "yes" }, /snapshot.circuitBreakerTripped/);
    bad({ ...snapshot(), circuitBreakerAvailable: 5 }, /snapshot.circuitBreakerAvailable/);
    bad({ ...snapshot(), circuitBreakerAvailable: -1n }, /snapshot.circuitBreakerAvailable/);
  });
});
