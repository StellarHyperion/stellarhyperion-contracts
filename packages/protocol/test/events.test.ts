/**
 * The raw router event inspector, checked against encoders it does not share code with.
 *
 * Soroban inputs are the real host's encodings, captured by
 * `soroban/crates/hyperion-router/src/test/event_fixtures.rs`. Variants of them are built with
 * the small re-encoder below, which must first round-trip every captured event byte for byte.
 * EVM inputs are encoded by viem from the generated router ABI.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  pad,
  toEventSelector,
  type AbiEvent,
  type Hex as ViemHex,
} from "viem";

import { hyperionRouterAbi } from "../src/abi/index.js";
import { AddressKind, encodeStellarAddress, parseStellarAddress } from "../src/addresses.js";
import { fromHex } from "../src/bytes.js";
import {
  EVM_ROUTER_EVENT_SELECTORS,
  ROUTER_EVENT_INSPECTOR_VERSION,
  decodeBase64,
  decodeScVal,
  inspectEvmRouterEvent,
  inspectSorobanRouterEvent,
} from "../src/events.js";
import type {
  EventDiagnosticCode,
  EvmRawLog,
  RouterEvent,
  RouterEventInspection,
  ScValue,
  SorobanRawEvent,
} from "../src/events.js";
import { RouteKind } from "../src/routes.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

interface Fixture extends SorobanRawEvent {
  readonly label: string;
  readonly contractId: string;
  readonly topic: readonly string[];
  readonly value: string;
}
const fixtures = (
  JSON.parse(readFileSync(join(repoRoot, "testdata", "router-events-soroban.json"), "utf8")) as {
    events: Fixture[];
  }
).events;
const ROUTER = fixtures[0]!.contractId;
const HUNDRED = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const I128_MAX = (1n << 127n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

function ok(result: RouterEventInspection): RouterEvent {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.event;
}

function refused(result: RouterEventInspection, code: EventDiagnosticCode, path?: string) {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.code).toBe(code);
  if (path !== undefined) expect(result.diagnostics[0]!.path).toBe(path);
}

function byLabel(label: string): RouterEvent[] {
  return fixtures
    .filter((f) => f.label === label)
    .map((f) => ok(inspectSorobanRouterEvent(f, { router: ROUTER })));
}

// ------------------------------------------------------------------------------------------------
// A test-only ScVal encoder, the inverse of `decodeScVal`
// ------------------------------------------------------------------------------------------------

class Writer {
  private readonly parts: number[] = [];
  u32(v: number) {
    this.parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  u64(v: bigint) {
    const masked = BigInt.asUintN(64, v);
    for (let s = 56n; s >= 0n; s -= 8n) this.parts.push(Number((masked >> s) & 0xffn));
  }
  raw(bytes: Uint8Array) {
    this.parts.push(...bytes);
  }
  variable(bytes: Uint8Array) {
    this.u32(bytes.length);
    this.raw(bytes);
    while (this.parts.length % 4 !== 0) this.parts.push(0);
  }
  bytes() {
    return Uint8Array.from(this.parts);
  }
}

const TAGS: Record<ScValue["type"], number> = {
  bool: 0,
  void: 1,
  error: 2,
  u32: 3,
  i32: 4,
  u64: 5,
  i64: 6,
  timepoint: 7,
  duration: 8,
  u128: 9,
  i128: 10,
  u256: 11,
  i256: 12,
  bytes: 13,
  string: 14,
  symbol: 15,
  vec: 16,
  map: 17,
  address: 18,
};

function strkeyKey(strkey: string): Uint8Array {
  return fromHex(parseStellarAddress(strkey).key);
}

function writeScVal(w: Writer, v: ScValue) {
  w.u32(TAGS[v.type]);
  switch (v.type) {
    case "bool":
      w.u32(v.value ? 1 : 0);
      return;
    case "void":
      return;
    case "error":
      w.u32(v.errorType);
      w.u32(v.code);
      return;
    case "u32":
    case "i32":
      w.u32(v.value >>> 0);
      return;
    case "u64":
    case "i64":
    case "timepoint":
    case "duration":
      w.u64(v.value);
      return;
    case "u128":
    case "i128":
      w.u64(v.value >> 64n);
      w.u64(v.value);
      return;
    case "u256":
    case "i256":
      for (let s = 192n; s >= 0n; s -= 64n) w.u64(v.value >> s);
      return;
    case "bytes":
    case "string":
      w.variable(v.value);
      return;
    case "symbol":
      w.variable(new TextEncoder().encode(v.value));
      return;
    case "vec":
      w.u32(v.value === null ? 0 : 1);
      if (v.value !== null) {
        w.u32(v.value.length);
        for (const item of v.value) writeScVal(w, item);
      }
      return;
    case "map":
      w.u32(v.value === null ? 0 : 1);
      if (v.value !== null) {
        w.u32(v.value.length);
        for (const { key, val } of v.value) {
          writeScVal(w, key);
          writeScVal(w, val);
        }
      }
      return;
    case "address":
      if (v.kind === "account") {
        w.u32(0);
        w.u32(0);
        w.raw(strkeyKey(v.strkey!));
      } else if (v.kind === "contract") {
        w.u32(1);
        w.raw(strkeyKey(v.strkey!));
      } else if (v.kind === "muxed") {
        w.u32(2);
        w.u64(7n);
        w.raw(strkeyKey(v.strkey!));
      } else {
        throw new Error(`test encoder does not write ${v.kind}`);
      }
      return;
  }
}

function encode(v: ScValue): string {
  const w = new Writer();
  writeScVal(w, v);
  return Buffer.from(w.bytes()).toString("base64");
}

const sym = (value: string): ScValue => ({ type: "symbol", value });

/** Rewrite one field of a symbol-keyed map, at `path` like `["transfer", "fee"]`. */
function setField(v: ScValue, path: readonly string[], next: ScValue | null): ScValue {
  if (v.type !== "map" || v.value === null) throw new Error("not a map");
  const [head, ...rest] = path;
  const entries = v.value.flatMap(({ key, val }) => {
    if (key.type !== "symbol" || key.value !== head) return [{ key, val }];
    if (rest.length > 0) return [{ key, val: setField(val, rest, next) }];
    return next === null ? [] : [{ key, val: next }];
  });
  if (!v.value.some(({ key }) => key.type === "symbol" && key.value === head) && next !== null) {
    entries.push({ key: sym(head!), val: next });
  }
  return { type: "map", value: entries };
}

function variant(
  label: string,
  index: number,
  edit: (topics: ScValue[], value: ScValue) => { topic?: ScValue[]; value?: ScValue },
): Fixture {
  const base = fixtures.filter((f) => f.label === label)[index]!;
  const topics = base.topic.map((t) => decodeScVal(t));
  const value = decodeScVal(base.value);
  const next = edit(topics, value);
  return {
    ...base,
    topic: (next.topic ?? topics).map(encode),
    value: encode(next.value ?? value),
  };
}

// ------------------------------------------------------------------------------------------------
// Soroban
// ------------------------------------------------------------------------------------------------

describe("the Soroban router event fixtures", () => {
  it("are the real host's bytes, and the test encoder reproduces every one exactly", () => {
    expect(fixtures).toHaveLength(14);
    for (const f of fixtures) {
      for (const topic of f.topic) expect(encode(decodeScVal(topic))).toBe(topic);
      expect(encode(decodeScVal(f.value))).toBe(f.value);
    }
  });

  it("decodes an outbound dispatch as a dispatch, never as a payout", () => {
    const [out] = byLabel("outbound");
    expect(out).toMatchObject({
      chain: "soroban",
      inspectorVersion: ROUTER_EVENT_INSPECTOR_VERSION,
      name: "BridgeOut",
      route: RouteKind.Cctp,
      nonce: 1n,
      grossAmount: HUNDRED,
      fee: 1_000_000n,
      netAmount: 999_000_000n,
      destinationChain: "ethereum",
      destination: {
        kind: "word",
        value: `0x${"00".repeat(12)}${"ab".repeat(19)}01`,
      },
      railRef: null,
      emitter: ROUTER,
      emitterVerified: true,
      payout: { kind: "not-a-payout", reason: "outbound-dispatch" },
    });
  });

  it("joins a direct payout to its replay key and reports it as a router payout", () => {
    const [replay, inbound] = byLabel("inbound-paid");
    expect(replay).toMatchObject({
      name: "ReplayRecorded",
      version: 1,
      route: RouteKind.Cctp,
      messageId: `0x${"00".repeat(31)}2a`,
      payout: { kind: "not-a-payout", reason: "replay-recorded" },
    });
    expect(inbound).toMatchObject({
      name: "BridgeIn",
      amount: HUNDRED,
      sourceChain: "ethereum",
      sourceNonce: 42n,
      delivered: true,
      claimId: 0n,
      messageId: null,
    });
    if (inbound?.name !== "BridgeIn") throw new Error("expected BridgeIn");
    expect(inbound.payout).toEqual({
      kind: "router-paid-recipient",
      recipient: inbound.recipient,
      token: inbound.token,
      amount: HUNDRED,
    });
  });

  it("keeps a parked delivery, its claim and its failure reason recipient-bound and unpaid", () => {
    const events = byLabel("inbound-parked");
    expect(events.map((e) => e.name)).toEqual([
      "ReplayRecorded",
      "ClaimParked",
      "ClaimPayoutFailure",
      "BridgeIn",
    ]);
    const [replay, parked, failure, inbound] = events;
    expect(replay).toMatchObject({
      route: RouteKind.AxelarIts,
      messageId: `0x${"00".repeat(31)}2b`,
    });
    expect(parked).toMatchObject({
      claimId: 1n,
      amount: HUNDRED,
      route: RouteKind.AxelarIts,
      sourceNonce: 43n,
      payout: { kind: "not-a-payout", reason: "claim-parked" },
    });
    expect(failure).toMatchObject({
      version: 1,
      claimId: 1n,
      reasonCode: 1,
      reason: "refused-unchanged",
      outstandingAmount: HUNDRED,
      payout: { kind: "not-a-payout", reason: "payout-failed" },
    });
    expect(inbound).toMatchObject({
      delivered: false,
      claimId: 1n,
      payout: { kind: "not-a-payout", reason: "claim-parked" },
    });
    if (parked?.name !== "ClaimParked" || failure?.name !== "ClaimPayoutFailure") throw new Error();
    expect(failure.recipient).toBe(parked.recipient);
  });

  it("reports a settled claim as a router payout to the recorded recipient", () => {
    const [parked] = byLabel("inbound-parked").filter((e) => e.name === "ClaimParked");
    const [settled] = byLabel("claim-settled");
    if (parked?.name !== "ClaimParked" || settled?.name !== "ClaimSettled") throw new Error();
    expect(settled).toMatchObject({ claimId: 1n, amount: HUNDRED, recipient: parked.recipient });
    expect(settled.payout).toEqual({
      kind: "router-paid-recipient",
      recipient: parked.recipient,
      token: parked.token,
      amount: HUNDRED,
    });
  });

  it("carries every full-width nonce, id, ledger and amount exactly", () => {
    const [out, inbound, parked, failure, settled, replay] = byLabel("full-width");
    expect(out).toMatchObject({
      name: "BridgeOut",
      route: RouteKind.Allbridge,
      nonce: U64_MAX,
      grossAmount: I128_MAX,
      fee: I128_MAX - 1n,
      netAmount: 1n,
      createdLedger: 0xffff_ffff,
      createdAt: U64_MAX,
      destination: { kind: "word", value: `0x${"ff".repeat(32)}` },
    });
    expect(inbound).toMatchObject({
      route: RouteKind.AxelarGmp,
      amount: I128_MAX,
      sourceNonce: U64_MAX,
    });
    expect(parked).toMatchObject({ claimId: U64_MAX, amount: I128_MAX, createdAt: U64_MAX });
    expect(failure).toMatchObject({
      claimId: U64_MAX,
      reason: "token-unreadable",
      outstandingAmount: I128_MAX,
    });
    expect(settled).toMatchObject({ claimId: U64_MAX, amount: I128_MAX });
    expect(replay).toMatchObject({ messageId: `0x${"ff".repeat(32)}` });
  });

  it("only ever calls a delivered BridgeIn or a ClaimSettled a payout, and only with a verified emitter", () => {
    for (const f of fixtures) {
      const verified = ok(inspectSorobanRouterEvent(f, { router: ROUTER }));
      const unverified = ok(inspectSorobanRouterEvent(f));
      const paysOut =
        verified.name === "ClaimSettled" ||
        (verified.name === "BridgeIn" && verified.delivered === true);
      expect(verified.payout.kind, f.label).toBe(
        paysOut ? "router-paid-recipient" : "not-a-payout",
      );
      expect(unverified.emitterVerified).toBe(false);
      expect(unverified.payout.kind).toBe(paysOut ? "unverified-emitter" : "not-a-payout");
    }
  });

  it("refuses a different emitter, a non-contract event and a failed call", () => {
    const f = fixtures[0]!;
    const other = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(9));
    refused(inspectSorobanRouterEvent(f, { router: other }), "UnexpectedEmitter", "contractId");
    refused(inspectSorobanRouterEvent({ ...f, type: "diagnostic" }), "NotRouterEvent", "type");
    refused(
      inspectSorobanRouterEvent({ ...f, inSuccessfulContractCall: false }),
      "NotCommitted",
      "inSuccessfulContractCall",
    );
  });

  it("names unsupported versions precisely instead of guessing", () => {
    refused(
      inspectSorobanRouterEvent(
        variant("inbound-paid", 0, (_, v) => ({
          value: setField(v, ["version"], { type: "u32", value: 2 }),
        })),
      ),
      "UnsupportedEventVersion",
      "value.version",
    );
    const v2 = variant("inbound-parked", 2, (t) => ({
      topic: [t[0]!, sym("claim_failure_v2"), t[2]!],
    }));
    const result = inspectSorobanRouterEvent(v2);
    refused(result, "UnsupportedEventVersion", "topic[1]");
    expect(result.ok ? null : result.name).toBe("claim_failure_v2");
  });

  it("separates foreign, unknown and out-of-scope event names", () => {
    refused(
      inspectSorobanRouterEvent(
        variant("outbound", 0, (t) => ({ topic: [sym("other"), ...t.slice(1)] })),
      ),
      "NotRouterEvent",
      "topic[0]",
    );
    refused(
      inspectSorobanRouterEvent(variant("outbound", 0, (t) => ({ topic: [t[0]!, sym("pause")] }))),
      "UninspectedEvent",
    );
    refused(
      inspectSorobanRouterEvent(
        variant("outbound", 0, (t) => ({ topic: [t[0]!, sym("teleport")] })),
      ),
      "UnknownEvent",
    );
    refused(
      inspectSorobanRouterEvent(variant("outbound", 0, (t) => ({ topic: t.slice(0, 3) }))),
      "SchemaMismatch",
      "topic",
    );
  });

  it("reports missing, extra and mistyped fields at their exact path", () => {
    const edit = (path: string[], next: ScValue | null) =>
      inspectSorobanRouterEvent(
        variant("outbound", 0, (_, v) => ({ value: setField(v, path, next) })),
      );
    refused(edit(["transfer", "fee"], null), "SchemaMismatch", "value.transfer.fee");
    refused(
      edit(["transfer", "memo"], { type: "u32", value: 1 }),
      "SchemaMismatch",
      "value.transfer.memo",
    );
    refused(
      edit(["transfer", "nonce"], { type: "u32", value: 1 }),
      "SchemaMismatch",
      "value.transfer.nonce",
    );
    refused(
      edit(["transfer", "destination"], { type: "bytes", value: new Uint8Array(31) }),
      "SchemaMismatch",
      "value.transfer.destination",
    );
    refused(
      edit(["transfer", "destination_chain"], { type: "string", value: Uint8Array.of(0xc3, 0x28) }),
      "SchemaMismatch",
      "value.transfer.destination_chain",
    );
  });

  it("refuses out-of-range values and records that disagree with themselves", () => {
    const out = (path: string[], next: ScValue) =>
      inspectSorobanRouterEvent(
        variant("outbound", 0, (_, v) => ({ value: setField(v, path, next) })),
      );
    refused(
      out(["transfer", "route"], { type: "u32", value: 9 }),
      "ValueOutOfRange",
      "value.transfer.route",
    );
    refused(
      out(["transfer", "fee"], { type: "i128", value: -1n }),
      "ValueOutOfRange",
      "value.transfer.fee",
    );
    refused(
      out(["transfer", "fee"], { type: "i128", value: 7n }),
      "InconsistentRecord",
      "value.transfer",
    );
    refused(
      out(["transfer", "route"], { type: "u32", value: RouteKind.AxelarIts }),
      "InconsistentRecord",
      "topic[2]",
    );
    refused(
      inspectSorobanRouterEvent(
        variant("inbound-paid", 1, (_, v) => ({
          value: setField(v, ["inbound", "claim_id"], { type: "u64", value: 5n }),
        })),
      ),
      "InconsistentRecord",
      "value.inbound",
    );
    refused(
      inspectSorobanRouterEvent(
        variant("inbound-parked", 2, (_, v) => ({
          value: setField(v, ["reason"], { type: "u32", value: 4 }),
        })),
      ),
      "ValueOutOfRange",
      "value.reason",
    );
    const muxed: ScValue = {
      type: "address",
      kind: "muxed",
      strkey: encodeStellarAddress(AddressKind.MuxedAccount, new Uint8Array(32).fill(1), 7n),
    };
    refused(
      inspectSorobanRouterEvent(
        variant("claim-settled", 0, (_, v) => ({ value: setField(v, ["settled_by"], muxed) })),
      ),
      "ValueOutOfRange",
      "value.settled_by",
    );
  });

  it("names the byte where malformed XDR or base64 breaks", () => {
    const f = fixtures[0]!;
    const bytes = decodeBase64(f.value);
    const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
    const at = (value: string) => {
      const r = inspectSorobanRouterEvent({ ...f, value });
      refused(r, "MalformedEncoding", "value");
      return r.ok ? "" : r.diagnostics[0]!.detail;
    };
    expect(at(b64(bytes.slice(0, bytes.length - 3)))).toMatch(
      /needs \d+ bytes but \d+ remain at byte \d+/,
    );
    expect(at(b64(Uint8Array.from([...bytes, 0, 0, 0, 0])))).toMatch(/4 trailing bytes/);
    expect(at(`${f.value.slice(0, -4)}!!!!`)).toMatch(/invalid base64 character/);
    expect(at("AAAAAQ=")).toMatch(/not a multiple of 4/);
    expect(at("AAAAAR==")).toMatch(/padding bits are not zero/);
    expect(at(b64(Uint8Array.of(0, 0, 0, 99)))).toMatch(/ScVal type 99/);
    expect(at(b64(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 2)))).toMatch(/not a boolean/);
    expect(at(b64(Uint8Array.of(0, 0, 0, 16, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff)))).toMatch(
      /vec claims/,
    );
    // A symbol with a nonzero pad byte, and one past the 32 character limit.
    expect(at(b64(Uint8Array.of(0, 0, 0, 15, 0, 0, 0, 1, 0x61, 1, 0, 0)))).toMatch(
      /padding is not zero/,
    );
    const long = new Writer();
    long.u32(15);
    long.variable(new TextEncoder().encode("a".repeat(33)));
    expect(at(b64(long.bytes()))).toMatch(/exceeds 32/);
    // Nesting beyond the depth bound fails cleanly rather than exhausting the stack.
    const deep = new Writer();
    for (let i = 0; i < 70; i += 1) {
      deep.u32(16);
      deep.u32(1);
      deep.u32(1);
    }
    deep.u32(1);
    expect(at(b64(deep.bytes()))).toMatch(/nesting deeper than 64/);
  });
});

// ------------------------------------------------------------------------------------------------
// EVM
// ------------------------------------------------------------------------------------------------

const EVM_ROUTER = "0x00000000000000000000000000000000000000aa";
const SENDER = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function abiEvent(name: string): AbiEvent {
  const event = hyperionRouterAbi.find((e) => e.type === "event" && e.name === name);
  if (event?.type !== "event") throw new Error(`no ${name} in the router ABI`);
  return event;
}

function log(name: string, args: Record<string, unknown>, address: string = EVM_ROUTER): EvmRawLog {
  const event = abiEvent(name);
  const topics = encodeEventTopics({ abi: [event], eventName: name, args }) as ViemHex[];
  const dataInputs = event.inputs.filter((i) => i.indexed !== true);
  const data = encodeAbiParameters(
    dataInputs,
    dataInputs.map((i) => args[i.name!]),
  );
  return { address, topics, data };
}

const bridgeOut = (overrides: Record<string, unknown> = {}) =>
  log("BridgeOut", {
    route: RouteKind.Cctp,
    sender: SENDER,
    nonce: U64_MAX,
    token: TOKEN,
    grossAmount: U256_MAX,
    fee: U256_MAX - 1n,
    netAmount: 1n,
    destinationChain: "stellar",
    destinationAddress: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    railRef: `0x${"cd".repeat(32)}`,
    ...overrides,
  });

describe("the EVM router event selectors", () => {
  it("are the keccak selectors of signatures that match the generated router ABI", () => {
    for (const [selector, spec] of Object.entries(EVM_ROUTER_EVENT_SELECTORS)) {
      expect(toEventSelector(spec.signature)).toBe(selector);
      const event = abiEvent(spec.signature.slice(0, spec.signature.indexOf("(")));
      expect(`${event.name}(${event.inputs.map((i) => i.type).join(",")})`).toBe(spec.signature);
      expect(event.inputs.filter((i) => i.indexed === true).map((i) => i.type)).toEqual(
        spec.indexed,
      );
      expect(event.inputs.filter((i) => i.indexed !== true).map((i) => i.type)).toEqual(spec.data);
    }
  });
});

describe("the EVM router event inspector", () => {
  it("decodes a full-width outbound dispatch as a dispatch", () => {
    expect(ok(inspectEvmRouterEvent(bridgeOut(), { router: EVM_ROUTER }))).toMatchObject({
      chain: "evm",
      name: "BridgeOut",
      route: RouteKind.Cctp,
      sender: SENDER,
      token: TOKEN,
      nonce: U64_MAX,
      grossAmount: U256_MAX,
      fee: U256_MAX - 1n,
      netAmount: 1n,
      destinationChain: "stellar",
      destination: {
        kind: "text",
        value: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
      },
      railRef: `0x${"cd".repeat(32)}`,
      emitterVerified: true,
      payout: { kind: "not-a-payout", reason: "outbound-dispatch" },
    });
  });

  it("never treats an EVM BridgeIn as proof of payout, because parked deliveries emit one too", () => {
    const inbound = log("BridgeIn", {
      route: RouteKind.AxelarIts,
      recipient: RECIPIENT,
      token: TOKEN,
      amount: U256_MAX,
      sourceChain: "stellar",
      sourceNonce: U64_MAX,
      messageId: `0x${"ee".repeat(32)}`,
    });
    expect(ok(inspectEvmRouterEvent(inbound, { router: EVM_ROUTER }))).toMatchObject({
      amount: U256_MAX,
      sourceNonce: U64_MAX,
      messageId: `0x${"ee".repeat(32)}`,
      delivered: null,
      payout: { kind: "not-a-payout", reason: "inbound-outcome-in-sibling-events" },
    });
  });

  it("decodes claims, failures and settlements with their full-width ids", () => {
    const parked = log("ClaimParked", {
      id: U64_MAX,
      recipient: RECIPIENT,
      token: TOKEN,
      amount: U256_MAX,
      route: RouteKind.Cctp,
      sourceChain: "stellar",
      sourceNonce: 7n,
    });
    expect(ok(inspectEvmRouterEvent(parked, { router: EVM_ROUTER }))).toMatchObject({
      claimId: U64_MAX,
      amount: U256_MAX,
      payout: { kind: "not-a-payout", reason: "claim-parked" },
    });
    const failure = (reason: number) =>
      log("ClaimPayoutFailureV1", { id: 3n, reason, outstandingAmount: 5n, recipient: RECIPIENT });
    expect(ok(inspectEvmRouterEvent(failure(4)))).toMatchObject({
      name: "ClaimPayoutFailure",
      version: 1,
      reason: "inexact-payout",
      payout: { kind: "not-a-payout", reason: "payout-failed" },
    });
    refused(inspectEvmRouterEvent(failure(5)), "ValueOutOfRange", "data[0x0]");
    refused(inspectEvmRouterEvent(failure(0)), "ValueOutOfRange", "data[0x0]");

    const settled = log("ClaimSettled", {
      id: U64_MAX,
      recipient: RECIPIENT,
      token: TOKEN,
      amount: U256_MAX,
      settledBy: SENDER,
    });
    expect(ok(inspectEvmRouterEvent(settled, { router: EVM_ROUTER })).payout).toEqual({
      kind: "router-paid-recipient",
      recipient: RECIPIENT,
      token: TOKEN,
      amount: U256_MAX,
    });
    expect(ok(inspectEvmRouterEvent(settled)).payout).toEqual({ kind: "unverified-emitter" });
    refused(
      inspectEvmRouterEvent({ ...settled, address: SENDER }, { router: EVM_ROUTER }),
      "UnexpectedEmitter",
      "address",
    );
    expect(
      ok(inspectEvmRouterEvent(settled, { router: EVM_ROUTER.toUpperCase().replace("0X", "0x") })),
    ).toBeTruthy();
  });

  it("refuses removed, anonymous, unknown and miscounted logs", () => {
    const base = bridgeOut();
    refused(inspectEvmRouterEvent({ ...base, removed: true }), "NotCommitted", "removed");
    refused(inspectEvmRouterEvent({ ...base, topics: [] }), "NotRouterEvent", "topics");
    refused(
      inspectEvmRouterEvent({ ...base, topics: [pad("0x01"), ...base.topics.slice(1)] }),
      "UnknownEvent",
      "topics[0]",
    );
    refused(
      inspectEvmRouterEvent({ ...base, topics: base.topics.slice(0, 3) }),
      "SchemaMismatch",
      "topics",
    );
    refused(inspectEvmRouterEvent({ ...base, data: "0x123" }), "MalformedEncoding", "data");
  });

  it("refuses dirty high bits, out-of-range routes and inconsistent amounts", () => {
    const base = bridgeOut();
    const dirty = (i: number, word: string) =>
      inspectEvmRouterEvent({ ...base, topics: base.topics.map((t, j) => (j === i ? word : t)) });
    refused(dirty(2, `0x01${"00".repeat(11)}${SENDER.slice(2)}`), "MalformedEncoding", "topics[2]");
    refused(dirty(3, `0x${"00".repeat(23)}01${"ff".repeat(8)}`), "MalformedEncoding", "topics[3]");
    refused(dirty(1, pad("0x04")), "ValueOutOfRange", "topics[1]");
    refused(inspectEvmRouterEvent(bridgeOut({ fee: 1n })), "InconsistentRecord", "data");
  });

  it("names the byte where a dynamic string breaks", () => {
    const data = bridgeOut().data;
    const words = data.slice(2).match(/.{64}/g)!;
    const rebuild = (w: string[]) => `0x${w.join("")}`;
    const at = (next: string) => {
      const r = inspectEvmRouterEvent({ ...bridgeOut(), data: next });
      expect(r.ok).toBe(false);
      return r.ok ? null : r.diagnostics[0]!;
    };
    // destinationChain's offset (head word 4) pointing past the data.
    const offset = [...words];
    offset[4] = BigInt(0x10000).toString(16).padStart(64, "0");
    expect(at(rebuild(offset))).toMatchObject({ code: "MalformedEncoding", path: "data[0x80]" });
    // A misaligned offset.
    offset[4] = BigInt(0xe1).toString(16).padStart(64, "0");
    expect(at(rebuild(offset))?.detail).toMatch(/out of bounds/);
    // Garbage after "stellar" inside its padded word, and invalid UTF-8 inside it.
    const start = Number.parseInt(words[4]!, 16) / 32;
    const pads = [...words];
    pads[start + 1] = `${pads[start + 1]!.slice(0, 14)}ff${pads[start + 1]!.slice(16)}`;
    expect(at(rebuild(pads))?.detail).toMatch(/padding is not zero/);
    const utf = [...words];
    utf[start + 1] = `c328${utf[start + 1]!.slice(4)}`;
    expect(at(rebuild(utf))).toMatchObject({ code: "SchemaMismatch" });
  });
});
