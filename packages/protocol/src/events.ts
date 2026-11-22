/**
 * Raw router event inspection.
 *
 * An indexer, a keeper and a support tool all start from the same raw material: the base64 XDR
 * that Stellar RPC `getEvents` returns, and the `topics`/`data` of an EVM log. This module turns
 * one raw router event into a typed record, or into a list of precise diagnostics saying why it
 * could not. It needs no database, no XDR library and no ABI decoder, and it does not keep
 * state between calls.
 *
 * Three properties matter more than convenience:
 *
 * - **Exact integers.** Every nonce, claim id and amount comes back as a `bigint` at the full
 *   width the contract declared (`u64`, `i128`, `uint256`). Nothing is narrowed to `number`.
 * - **Versioned refusals.** An event whose name or version field this inspector does not know
 *   is reported as `UnsupportedEventVersion` or `UnknownEvent`. It is never decoded on a best
 *   guess. A field that is missing, extra or of the wrong type is `SchemaMismatch`.
 * - **No false payouts.** `payout` reports evidence of a payout only when the router itself
 *   says it paid the recipient (Soroban `BridgeIn` with `delivered`, or `ClaimSettled` on either
 *   chain), and only when the caller has confirmed the emitter is the router. Dispatching to a
 *   rail, recording a replay key, parking a claim, a payout failure, and the EVM `BridgeIn`
 *   (which the EVM router emits for parked deliveries too) are each labelled as not a payout.
 *   Even a positive result is only what the router reported in a successful call. Finality is
 *   still the caller's to check.
 */
import { toHex } from "./bytes.js";
import type { Hex } from "./bytes.js";
import { AddressKind, encodeStellarAddress } from "./addresses.js";
import { isRouteKind } from "./routes.js";
import type { RouteKind } from "./routes.js";

/** The inspector's own schema version. Bumped when a decoded field changes meaning. */
export const ROUTER_EVENT_INSPECTOR_VERSION = 1 as const;

// ------------------------------------------------------------------------------------------------
// Results and diagnostics
// ------------------------------------------------------------------------------------------------

/** Why a raw event was not turned into a typed record. */
export type EventDiagnosticCode =
  /** Base64, XDR or ABI bytes that do not parse, with the byte offset in `detail`. */
  | "MalformedEncoding"
  /** Not a router contract event: wrong namespace topic, a diagnostic/system event, or no topics. */
  | "NotRouterEvent"
  /** A Hyperion event name or EVM selector this inspector does not know. */
  | "UnknownEvent"
  /** A known Hyperion event that is outside the inspected transfer lifecycle. */
  | "UninspectedEvent"
  /** A versioned event (`claim_failure_vN`, a `version` field) at a version this inspector lacks. */
  | "UnsupportedEventVersion"
  /** A field that is missing, extra or of the wrong type, or the wrong number of topics. */
  | "SchemaMismatch"
  /** A well-typed value outside its domain: an unknown route tag, a negative amount, a reason code. */
  | "ValueOutOfRange"
  /** Fields that the router always writes consistently, but which disagree here. */
  | "InconsistentRecord"
  /** The event was not emitted by the router address the caller expected. */
  | "UnexpectedEmitter"
  /** The provider says this event is not final: an EVM log removed by a reorg, or a Soroban event
   * from a failed contract call. */
  | "NotCommitted";

export interface EventDiagnostic {
  readonly code: EventDiagnosticCode;
  /** Where in the input, e.g. `topic[2]`, `value.transfer.gross_amount` or `data[0x40]`. */
  readonly path: string;
  readonly detail: string;
}

/** Why an inspected event is not evidence that a recipient was paid. */
export type NotPayoutReason =
  /** Funds left on a rail. The rail delivering them is a separate, later fact. */
  | "outbound-dispatch"
  /** The delivery arrived but is being held for the recipient. */
  | "claim-parked"
  /** A payout attempt failed and the claim is still outstanding. */
  | "payout-failed"
  /** A replay key was recorded. That shows the message was processed, not that it was paid. */
  | "replay-recorded"
  /** The EVM router emits `BridgeIn` for paid and parked deliveries alike. The outcome is
   * whether a `ClaimParked` with the same identity sits in the same transaction. */
  | "inbound-outcome-in-sibling-events";

export type PayoutEvidence =
  | {
      readonly kind: "router-paid-recipient";
      readonly recipient: string;
      readonly token: string;
      readonly amount: bigint;
    }
  | { readonly kind: "not-a-payout"; readonly reason: NotPayoutReason }
  /** The event would be payout evidence, but no expected router address was supplied. */
  | { readonly kind: "unverified-emitter" };

interface EventBase {
  readonly chain: "soroban" | "evm";
  readonly inspectorVersion: typeof ROUTER_EVENT_INSPECTOR_VERSION;
  /** The contract that emitted the event, as given by the provider, or null if it was not given. */
  readonly emitter: string | null;
  /** True only when the caller supplied a router address and the emitter matched it. */
  readonly emitterVerified: boolean;
  readonly payout: PayoutEvidence;
}

/** Soroban carries the destination as a 32 byte word. EVM carries the recipient's strkey text. */
export type EventDestination =
  | { readonly kind: "word"; readonly value: Hex }
  | { readonly kind: "text"; readonly value: string };

export interface BridgeOutEvent extends EventBase {
  readonly name: "BridgeOut";
  readonly route: RouteKind;
  readonly sender: string;
  readonly token: string;
  readonly nonce: bigint;
  readonly grossAmount: bigint;
  readonly fee: bigint;
  readonly netAmount: bigint;
  readonly destinationChain: string;
  readonly destination: EventDestination;
  /** EVM only: the rail's reference for the transfer, or zero. */
  readonly railRef: Hex | null;
  /** Soroban only. */
  readonly createdLedger: number | null;
  /** Soroban only, in seconds. */
  readonly createdAt: bigint | null;
}

export interface BridgeInEvent extends EventBase {
  readonly name: "BridgeIn";
  readonly route: RouteKind;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  /** EVM only. On Soroban the message id is in the `ReplayRecorded` event of the same call. */
  readonly messageId: Hex | null;
  /** Soroban only: the router's own statement that the recipient was paid directly. */
  readonly delivered: boolean | null;
  /** Soroban only: zero when delivered, otherwise the parked claim's id. */
  readonly claimId: bigint | null;
  /** Soroban only. */
  readonly ledger: number | null;
}

export interface ClaimParkedEvent extends EventBase {
  readonly name: "ClaimParked";
  readonly claimId: bigint;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly route: RouteKind;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  /** Soroban only, in seconds. */
  readonly createdAt: bigint | null;
}

export interface ClaimSettledEvent extends EventBase {
  readonly name: "ClaimSettled";
  readonly claimId: bigint;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly settledBy: string;
}

/** Version 1 payout reasons. Soroban uses 1 to 3. The EVM router adds 4. */
export const PAYOUT_FAILURE_REASONS_V1 = {
  1: "refused-unchanged",
  2: "custody-short",
  3: "token-unreadable",
  4: "inexact-payout",
} as const;
export type PayoutFailureReasonV1 =
  (typeof PAYOUT_FAILURE_REASONS_V1)[keyof typeof PAYOUT_FAILURE_REASONS_V1];

export interface ClaimPayoutFailureEvent extends EventBase {
  readonly name: "ClaimPayoutFailure";
  readonly version: 1;
  readonly claimId: bigint;
  readonly reasonCode: number;
  readonly reason: PayoutFailureReasonV1;
  readonly outstandingAmount: bigint;
  readonly recipient: string;
}

export interface ReplayRecordedEvent extends EventBase {
  readonly name: "ReplayRecorded";
  readonly version: 1;
  readonly route: RouteKind;
  readonly messageId: Hex;
  readonly ledger: number;
  readonly timestamp: bigint;
}

export type RouterEvent =
  | BridgeOutEvent
  | BridgeInEvent
  | ClaimParkedEvent
  | ClaimSettledEvent
  | ClaimPayoutFailureEvent
  | ReplayRecordedEvent;

export type RouterEventInspection =
  | { readonly ok: true; readonly event: RouterEvent }
  | {
      readonly ok: false;
      /** The event name, when it got far enough to read one. */
      readonly name: string | null;
      readonly diagnostics: readonly EventDiagnostic[];
    };

export interface InspectOptions {
  /** The router address the caller trusts: a C strkey for Soroban, a 0x address for EVM. */
  readonly router?: string;
}

class Refusal extends Error {
  constructor(readonly diagnostic: EventDiagnostic) {
    super(`${diagnostic.code} at ${diagnostic.path}: ${diagnostic.detail}`);
  }
}

function refuse(code: EventDiagnosticCode, path: string, detail: string): never {
  throw new Refusal({ code, path, detail });
}

// ------------------------------------------------------------------------------------------------
// Base64 and XDR
// ------------------------------------------------------------------------------------------------

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Strict, canonical base64. Rejects bad characters, bad padding and nonzero padding bits. */
export function decodeBase64(text: string, path = "input"): Uint8Array {
  if (text.length % 4 !== 0) {
    refuse(
      "MalformedEncoding",
      path,
      `base64 length ${String(text.length)} is not a multiple of 4`,
    );
  }
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j += 1) {
      const index = i + j;
      const ch = text.charAt(index);
      if (ch === "=" && index >= text.length - pad) {
        n <<= 6;
        continue;
      }
      const v = BASE64.indexOf(ch);
      if (v < 0) {
        refuse("MalformedEncoding", path, `invalid base64 character at ${String(index)}`);
      }
      n = (n << 6) | v;
    }
    if (
      i + 4 === text.length &&
      ((pad === 1 && (n & 0xff) !== 0) || (pad === 2 && (n & 0xffff) !== 0))
    ) {
      refuse("MalformedEncoding", path, "base64 padding bits are not zero");
    }
    for (const byte of [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]) {
      if (o < out.length) out[o++] = byte;
    }
  }
  return out;
}

/** The `ScVal` integer types wider than 32 bits, all decoded to `bigint`. */
export type ScWideType =
  "u64" | "i64" | "timepoint" | "duration" | "u128" | "i128" | "u256" | "i256";

/** A decoded Soroban `ScVal`. Wide integers are `bigint`. Strings stay raw bytes until a field asks. */
export type ScValue =
  | { readonly type: "bool"; readonly value: boolean }
  | { readonly type: "void" }
  | { readonly type: "error"; readonly errorType: number; readonly code: number }
  | { readonly [K in "u32" | "i32"]: { readonly type: K; readonly value: number } }["u32" | "i32"]
  | { readonly [K in ScWideType]: { readonly type: K; readonly value: bigint } }[ScWideType]
  | {
      readonly [K in "bytes" | "string"]: { readonly type: K; readonly value: Uint8Array };
    }["bytes" | "string"]
  | { readonly type: "symbol"; readonly value: string }
  | { readonly type: "vec"; readonly value: readonly ScValue[] | null }
  | {
      readonly type: "map";
      readonly value: readonly { readonly key: ScValue; readonly val: ScValue }[] | null;
    }
  | {
      readonly type: "address";
      readonly kind: "account" | "contract" | "muxed" | "claimable-balance" | "liquidity-pool";
      /** G, C or M strkey. Null for claimable balance and liquidity pool addresses. */
      readonly strkey: string | null;
    };

const MAX_XDR_DEPTH = 64;
const SYMBOL_CHARS = /^[A-Za-z0-9_]*$/;

class XdrReader {
  offset = 0;
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly path: string,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  fail(detail: string): never {
    refuse("MalformedEncoding", this.path, `${detail} at byte ${String(this.offset)}`);
  }

  remaining(): number {
    return this.bytes.length - this.offset;
  }

  private need(n: number, what: string): void {
    if (this.remaining() < n) {
      this.fail(`${what} needs ${String(n)} bytes but ${String(this.remaining())} remain`);
    }
  }

  u32(what: string): number {
    this.need(4, what);
    const v = this.view.getUint32(this.offset);
    this.offset += 4;
    return v;
  }

  i32(what: string): number {
    this.need(4, what);
    const v = this.view.getInt32(this.offset);
    this.offset += 4;
    return v;
  }

  u64(what: string): bigint {
    this.need(8, what);
    const v = this.view.getBigUint64(this.offset);
    this.offset += 8;
    return v;
  }

  i64(what: string): bigint {
    this.need(8, what);
    const v = this.view.getBigInt64(this.offset);
    this.offset += 8;
    return v;
  }

  fixed(n: number, what: string): Uint8Array {
    this.need(n, what);
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  variable(what: string, max: number = Number.MAX_SAFE_INTEGER): Uint8Array {
    const length = this.u32(`${what} length`);
    if (length > max) this.fail(`${what} length ${String(length)} exceeds ${String(max)}`);
    const padded = Math.ceil(length / 4) * 4;
    this.need(padded, what);
    const out = this.fixed(length, what);
    for (let i = length; i < padded; i += 1) {
      if (this.u8()) this.fail(`${what} padding is not zero`);
    }
    return out;
  }

  private u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  bool(what: string): boolean {
    const v = this.u32(what);
    if (v > 1) this.fail(`${what} is ${String(v)}, not a boolean`);
    return v === 1;
  }

  done(): void {
    if (this.remaining() !== 0) this.fail(`${String(this.remaining())} trailing bytes`);
  }
}

function readScVal(r: XdrReader, depth: number): ScValue {
  if (depth > MAX_XDR_DEPTH) r.fail(`nesting deeper than ${String(MAX_XDR_DEPTH)}`);
  const tag = r.u32("ScVal type");
  switch (tag) {
    case 0:
      return { type: "bool", value: r.bool("bool") };
    case 1:
      return { type: "void" };
    case 2: {
      const errorType = r.u32("error type");
      if (errorType > 9) r.fail(`unknown error type ${String(errorType)}`);
      return { type: "error", errorType, code: r.u32("error code") };
    }
    case 3:
      return { type: "u32", value: r.u32("u32") };
    case 4:
      return { type: "i32", value: r.i32("i32") };
    case 5:
      return { type: "u64", value: r.u64("u64") };
    case 6:
      return { type: "i64", value: r.i64("i64") };
    case 7:
      return { type: "timepoint", value: r.u64("timepoint") };
    case 8:
      return { type: "duration", value: r.u64("duration") };
    case 9: {
      const hi = r.u64("u128 hi");
      return { type: "u128", value: (hi << 64n) | r.u64("u128 lo") };
    }
    case 10: {
      const hi = r.i64("i128 hi");
      return { type: "i128", value: (hi << 64n) | r.u64("i128 lo") };
    }
    case 11:
    case 12: {
      const signed = tag === 12;
      let value = signed ? r.i64("256 bit word") : r.u64("256 bit word");
      for (let i = 0; i < 3; i += 1) value = (value << 64n) | r.u64("256 bit word");
      return { type: signed ? "i256" : "u256", value };
    }
    case 13:
      return { type: "bytes", value: r.variable("bytes") };
    case 14:
      return { type: "string", value: r.variable("string") };
    case 15: {
      const raw = r.variable("symbol", 32);
      let text = "";
      for (const byte of raw) text += String.fromCharCode(byte);
      if (!SYMBOL_CHARS.test(text)) r.fail("symbol has a character outside [A-Za-z0-9_]");
      return { type: "symbol", value: text };
    }
    case 16: {
      if (!r.bool("vec presence")) return { type: "vec", value: null };
      const count = r.u32("vec length");
      if (count * 4 > r.remaining()) r.fail(`vec claims ${String(count)} elements`);
      const items: ScValue[] = [];
      for (let i = 0; i < count; i += 1) items.push(readScVal(r, depth + 1));
      return { type: "vec", value: items };
    }
    case 17: {
      if (!r.bool("map presence")) return { type: "map", value: null };
      const count = r.u32("map length");
      if (count * 8 > r.remaining()) r.fail(`map claims ${String(count)} entries`);
      const entries: { key: ScValue; val: ScValue }[] = [];
      for (let i = 0; i < count; i += 1) {
        const key = readScVal(r, depth + 1);
        entries.push({ key, val: readScVal(r, depth + 1) });
      }
      return { type: "map", value: entries };
    }
    case 18:
      return readScAddress(r);
    default:
      return r.fail(`ScVal type ${String(tag)} is not one a router event carries`);
  }
}

function readScAddress(r: XdrReader): ScValue {
  const kind = r.u32("address type");
  switch (kind) {
    case 0: {
      const keyType = r.u32("public key type");
      if (keyType !== 0) r.fail(`public key type ${String(keyType)} is not ed25519`);
      const key = r.fixed(32, "account key");
      return {
        type: "address",
        kind: "account",
        strkey: encodeStellarAddress(AddressKind.Account, key),
      };
    }
    case 1: {
      const key = r.fixed(32, "contract id");
      return {
        type: "address",
        kind: "contract",
        strkey: encodeStellarAddress(AddressKind.Contract, key),
      };
    }
    case 2: {
      const id = r.u64("muxed id");
      const key = r.fixed(32, "muxed key");
      return {
        type: "address",
        kind: "muxed",
        strkey: encodeStellarAddress(AddressKind.MuxedAccount, key, id),
      };
    }
    case 3: {
      const balanceType = r.u32("claimable balance id type");
      if (balanceType !== 0) r.fail(`claimable balance id type ${String(balanceType)}`);
      r.fixed(32, "claimable balance id");
      return { type: "address", kind: "claimable-balance", strkey: null };
    }
    case 4:
      r.fixed(32, "liquidity pool id");
      return { type: "address", kind: "liquidity-pool", strkey: null };
    default:
      return r.fail(`address type ${String(kind)} is unknown`);
  }
}

/** Decode one base64 (or raw) XDR `ScVal`, consuming every byte. */
export function decodeScVal(input: string | Uint8Array, path = "input"): ScValue {
  const bytes = typeof input === "string" ? decodeBase64(input, path) : input;
  const reader = new XdrReader(bytes, path);
  const value = readScVal(reader, 0);
  reader.done();
  return value;
}

// ------------------------------------------------------------------------------------------------
// Field readers shared by both chains
// ------------------------------------------------------------------------------------------------

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function utf8(bytes: Uint8Array, path: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return refuse("SchemaMismatch", path, "string is not valid UTF-8");
  }
}

function routeTag(tag: number | bigint, path: string): RouteKind {
  const n = Number(tag);
  if (!isRouteKind(n)) refuse("ValueOutOfRange", path, `route tag ${String(tag)} is unknown`);
  return n;
}

function nonNegative(value: bigint, path: string): bigint {
  if (value < 0n) refuse("ValueOutOfRange", path, `amount ${String(value)} is negative`);
  return value;
}

function payoutReason(code: number, path: string, chain: "soroban" | "evm"): PayoutFailureReasonV1 {
  const max = chain === "soroban" ? 3 : 4;
  if (!Number.isInteger(code) || code < 1 || code > max) {
    refuse(
      "ValueOutOfRange",
      path,
      `version 1 payout reason ${String(code)} is not 1..${String(max)}`,
    );
  }
  return PAYOUT_FAILURE_REASONS_V1[code as 1 | 2 | 3 | 4];
}

function consistent(ok: boolean, path: string, detail: string): void {
  if (!ok) refuse("InconsistentRecord", path, detail);
}

// ------------------------------------------------------------------------------------------------
// Soroban
// ------------------------------------------------------------------------------------------------

/** One entry of a Stellar RPC `getEvents` response, as returned with the default base64 format. */
export interface SorobanRawEvent {
  /** `contract`, `system` or `diagnostic`. Only contract events are router events. */
  readonly type?: string;
  readonly contractId?: string;
  readonly topic: readonly (string | Uint8Array)[];
  readonly value: string | Uint8Array;
  /** Present on RPC responses. A `false` here means the call that emitted it failed. */
  readonly inSuccessfulContractCall?: boolean;
}

type ScType = ScValue["type"];
type OfType<T extends ScType> = Extract<ScValue, { type: T }>;

function expectType<T extends ScType>(
  value: ScValue | undefined,
  type: T,
  path: string,
): OfType<T> {
  if (value === undefined) refuse("SchemaMismatch", path, `missing, expected ${type}`);
  if (value.type !== type) refuse("SchemaMismatch", path, `is ${value.type}, expected ${type}`);
  return value as OfType<T>;
}

/** A symbol-keyed map with exactly `names`, the way `#[contracttype]` structs encode. */
function struct(value: ScValue | undefined, path: string, names: readonly string[]) {
  const map = expectType(value, "map", path);
  if (map.value === null) refuse("SchemaMismatch", path, "map is absent");
  const fields = new Map<string, ScValue>();
  for (const { key, val } of map.value) {
    const name = expectType(key, "symbol", `${path}.<key>`).value;
    if (fields.has(name)) refuse("SchemaMismatch", `${path}.${name}`, "duplicate key");
    if (!names.includes(name)) refuse("SchemaMismatch", `${path}.${name}`, "unexpected field");
    fields.set(name, val);
  }
  for (const name of names) {
    if (!fields.has(name)) refuse("SchemaMismatch", `${path}.${name}`, "missing field");
  }
  const at = (name: string) => `${path}.${name}`;
  return {
    u32: (name: string) => expectType(fields.get(name), "u32", at(name)).value,
    u64: (name: string) => expectType(fields.get(name), "u64", at(name)).value,
    bool: (name: string) => expectType(fields.get(name), "bool", at(name)).value,
    amount: (name: string) =>
      nonNegative(expectType(fields.get(name), "i128", at(name)).value, at(name)),
    route: (name: string) =>
      routeTag(expectType(fields.get(name), "u32", at(name)).value, at(name)),
    string: (name: string) =>
      utf8(expectType(fields.get(name), "string", at(name)).value, at(name)),
    word: (name: string) => word(fields.get(name), at(name)),
    address: (name: string) => address(fields.get(name), at(name)),
    raw: (name: string) => fields.get(name),
  };
}

function word(value: ScValue | undefined, path: string): Hex {
  const bytes = expectType(value, "bytes", path).value;
  if (bytes.length !== 32) {
    refuse("SchemaMismatch", path, `is ${String(bytes.length)} bytes, expected 32`);
  }
  return toHex(bytes);
}

function address(value: ScValue | undefined, path: string): string {
  const a = expectType(value, "address", path);
  if (a.strkey === null || a.kind === "muxed") {
    refuse("ValueOutOfRange", path, `a ${a.kind} address is not a router participant`);
  }
  return a.strkey;
}

const SOROBAN_UNINSPECTED = new Set([
  "pause",
  "queued",
  "executed",
  "cancelled",
  "audit",
  "migrated",
  "config",
  "token",
  "route",
  "flow",
  "claim_archived",
]);

/**
 * Inspect one router event from Stellar RPC `getEvents`.
 *
 * Pass `options.router` (the router's C strkey) to verify the emitter. Without it, the event
 * still decodes, but `payout` can be at most `unverified-emitter`.
 */
export function inspectSorobanRouterEvent(
  event: SorobanRawEvent,
  options: InspectOptions = {},
): RouterEventInspection {
  let name: string | null = null;
  try {
    if (event.type !== undefined && event.type !== "contract") {
      refuse("NotRouterEvent", "type", `a ${event.type} event is not a router contract event`);
    }
    if (event.inSuccessfulContractCall === false) {
      refuse("NotCommitted", "inSuccessfulContractCall", "the emitting call failed");
    }
    const emitter = event.contractId ?? null;
    if (options.router !== undefined && emitter !== options.router) {
      refuse(
        "UnexpectedEmitter",
        "contractId",
        `emitted by ${emitter ?? "an unknown contract"}, expected ${options.router}`,
      );
    }
    const topics = event.topic.map((t, i) => decodeScVal(t, `topic[${String(i)}]`));
    const namespace = topics[0];
    if (namespace?.type !== "symbol" || namespace.value !== "hyperion") {
      refuse("NotRouterEvent", "topic[0]", "the first topic is not the symbol `hyperion`");
    }
    const eventName = expectType(topics[1], "symbol", "topic[1]").value;
    name = eventName;
    const value = decodeScVal(event.value, "value");
    const base = {
      chain: "soroban" as const,
      inspectorVersion: ROUTER_EVENT_INSPECTOR_VERSION,
      emitter,
      emitterVerified: options.router !== undefined,
    };
    const paid = (recipient: string, token: string, amount: bigint): PayoutEvidence =>
      base.emitterVerified
        ? { kind: "router-paid-recipient", recipient, token, amount }
        : { kind: "unverified-emitter" };
    const expectTopics = (count: number) => {
      if (topics.length !== count) {
        refuse(
          "SchemaMismatch",
          "topic",
          `${eventName} has ${String(topics.length)} topics, expected ${String(count)}`,
        );
      }
    };

    switch (eventName) {
      case "out": {
        expectTopics(4);
        const topicRoute = routeTag(expectType(topics[2], "u32", "topic[2]").value, "topic[2]");
        const topicSender = address(topics[3], "topic[3]");
        const t = struct(struct(value, "value", ["transfer"]).raw("transfer"), "value.transfer", [
          "created_at",
          "created_ledger",
          "destination",
          "destination_chain",
          "fee",
          "gross_amount",
          "net_amount",
          "nonce",
          "route",
          "sender",
          "token",
        ]);
        const record: BridgeOutEvent = {
          ...base,
          name: "BridgeOut",
          route: t.route("route"),
          sender: t.address("sender"),
          token: t.address("token"),
          nonce: t.u64("nonce"),
          grossAmount: t.amount("gross_amount"),
          fee: t.amount("fee"),
          netAmount: t.amount("net_amount"),
          destinationChain: t.string("destination_chain"),
          destination: { kind: "word", value: t.word("destination") },
          railRef: null,
          createdLedger: t.u32("created_ledger"),
          createdAt: t.u64("created_at"),
          payout: { kind: "not-a-payout", reason: "outbound-dispatch" },
        };
        consistent(
          record.route === topicRoute,
          "topic[2]",
          "route topic differs from transfer.route",
        );
        consistent(
          record.sender === topicSender,
          "topic[3]",
          "sender topic differs from transfer.sender",
        );
        consistent(
          record.fee + record.netAmount === record.grossAmount,
          "value.transfer",
          "fee + net_amount does not equal gross_amount",
        );
        return { ok: true, event: record };
      }
      case "in": {
        expectTopics(4);
        const topicRoute = routeTag(expectType(topics[2], "u32", "topic[2]").value, "topic[2]");
        const topicRecipient = address(topics[3], "topic[3]");
        const r = struct(struct(value, "value", ["inbound"]).raw("inbound"), "value.inbound", [
          "amount",
          "claim_id",
          "delivered",
          "ledger",
          "recipient",
          "route",
          "source_chain",
          "source_nonce",
          "token",
        ]);
        const recipient = r.address("recipient");
        const token = r.address("token");
        const amount = r.amount("amount");
        const delivered = r.bool("delivered");
        const claimId = r.u64("claim_id");
        consistent(
          delivered === (claimId === 0n),
          "value.inbound",
          delivered ? "a delivered record names a claim" : "a parked record has claim_id 0",
        );
        const record: BridgeInEvent = {
          ...base,
          name: "BridgeIn",
          route: r.route("route"),
          recipient,
          token,
          amount,
          sourceChain: r.string("source_chain"),
          sourceNonce: r.u64("source_nonce"),
          messageId: null,
          delivered,
          claimId,
          ledger: r.u32("ledger"),
          payout: delivered
            ? paid(recipient, token, amount)
            : { kind: "not-a-payout", reason: "claim-parked" },
        };
        consistent(
          record.route === topicRoute,
          "topic[2]",
          "route topic differs from inbound.route",
        );
        consistent(
          recipient === topicRecipient,
          "topic[3]",
          "recipient topic differs from inbound.recipient",
        );
        return { ok: true, event: record };
      }
      case "park": {
        expectTopics(4);
        const topicRecipient = address(topics[2], "topic[2]");
        const topicToken = address(topics[3], "topic[3]");
        const c = struct(struct(value, "value", ["claim"]).raw("claim"), "value.claim", [
          "amount",
          "created_at",
          "id",
          "recipient",
          "route",
          "settled",
          "source_chain",
          "source_nonce",
          "token",
        ]);
        const record: ClaimParkedEvent = {
          ...base,
          name: "ClaimParked",
          claimId: c.u64("id"),
          recipient: c.address("recipient"),
          token: c.address("token"),
          amount: c.amount("amount"),
          route: c.route("route"),
          sourceChain: c.string("source_chain"),
          sourceNonce: c.u64("source_nonce"),
          createdAt: c.u64("created_at"),
          payout: { kind: "not-a-payout", reason: "claim-parked" },
        };
        consistent(!c.bool("settled"), "value.claim.settled", "a newly parked claim is settled");
        consistent(
          record.recipient === topicRecipient,
          "topic[2]",
          "recipient topic differs from claim.recipient",
        );
        consistent(record.token === topicToken, "topic[3]", "token topic differs from claim.token");
        return { ok: true, event: record };
      }
      case "settled": {
        expectTopics(3);
        const recipient = address(topics[2], "topic[2]");
        const s = struct(value, "value", ["amount", "claim_id", "settled_by", "token"]);
        const token = s.address("token");
        const amount = s.amount("amount");
        const record: ClaimSettledEvent = {
          ...base,
          name: "ClaimSettled",
          claimId: s.u64("claim_id"),
          recipient,
          token,
          amount,
          settledBy: s.address("settled_by"),
          payout: paid(recipient, token, amount),
        };
        return { ok: true, event: record };
      }
      case "replay": {
        expectTopics(4);
        const route = routeTag(expectType(topics[2], "u32", "topic[2]").value, "topic[2]");
        const messageId = word(topics[3], "topic[3]");
        const v = struct(value, "value", ["ledger", "timestamp", "version"]);
        const version = v.u32("version");
        if (version !== 1) {
          refuse(
            "UnsupportedEventVersion",
            "value.version",
            `replay record version ${String(version)}; this inspector reads 1`,
          );
        }
        const record: ReplayRecordedEvent = {
          ...base,
          name: "ReplayRecorded",
          version: 1,
          route,
          messageId,
          ledger: v.u32("ledger"),
          timestamp: v.u64("timestamp"),
          payout: { kind: "not-a-payout", reason: "replay-recorded" },
        };
        return { ok: true, event: record };
      }
      case "claim_failure_v1": {
        expectTopics(3);
        const claimId = expectType(topics[2], "u64", "topic[2]").value;
        const f = struct(value, "value", ["outstanding_amount", "reason", "recipient"]);
        const reasonCode = f.u32("reason");
        const record: ClaimPayoutFailureEvent = {
          ...base,
          name: "ClaimPayoutFailure",
          version: 1,
          claimId,
          reasonCode,
          reason: payoutReason(reasonCode, "value.reason", "soroban"),
          outstandingAmount: f.amount("outstanding_amount"),
          recipient: f.address("recipient"),
          payout: { kind: "not-a-payout", reason: "payout-failed" },
        };
        return { ok: true, event: record };
      }
      default: {
        if (/^claim_failure_v\d+$/.test(name)) {
          refuse(
            "UnsupportedEventVersion",
            "topic[1]",
            `${eventName}; this inspector reads claim_failure_v1`,
          );
        }
        if (SOROBAN_UNINSPECTED.has(eventName)) {
          refuse(
            "UninspectedEvent",
            "topic[1]",
            `${eventName} is a router event outside the transfer lifecycle`,
          );
        }
        return refuse("UnknownEvent", "topic[1]", `${eventName} is not a known router event`);
      }
    }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, name, diagnostics: [error.diagnostic] };
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------
// EVM
// ------------------------------------------------------------------------------------------------

/** One log as `eth_getLogs`, viem and ethers return it. */
export interface EvmRawLog {
  readonly address?: string;
  readonly topics: readonly string[];
  readonly data: string;
  /** True when a reorg removed the log. */
  readonly removed?: boolean;
}

type AbiType = "address" | "uint8" | "uint64" | "uint256" | "bytes32" | "string";

interface EvmEventSpec {
  readonly name: Exclude<RouterEvent["name"], "ReplayRecorded">;
  readonly signature: string;
  readonly indexed: readonly AbiType[];
  readonly data: readonly AbiType[];
}

/**
 * The inspected EVM router events, keyed by topic0. The protocol parity suite recomputes each
 * selector from its signature and checks the signature against the generated ABI.
 */
export const EVM_ROUTER_EVENT_SELECTORS = {
  "0x24b2432427e448c4d36c16b2e9e47baf906cd08c1a48aa4d8ce584ccfb1ad1b1": {
    name: "BridgeOut",
    signature:
      "BridgeOut(uint8,address,uint64,address,uint256,uint256,uint256,string,string,bytes32)",
    indexed: ["uint8", "address", "uint64"],
    data: ["address", "uint256", "uint256", "uint256", "string", "string", "bytes32"],
  },
  "0x64877ff17e5aff12c7a2104a0daa37790b470d826b90f8c29d20407d5487e10d": {
    name: "BridgeIn",
    signature: "BridgeIn(uint8,address,address,uint256,string,uint64,bytes32)",
    indexed: ["uint8", "address", "address"],
    data: ["uint256", "string", "uint64", "bytes32"],
  },
  "0x84889ef0f9abef60c24bcaa16c99f5fd2856b52c074fca4a0266702ac56a38c0": {
    name: "ClaimParked",
    signature: "ClaimParked(uint64,address,address,uint256,uint8,string,uint64)",
    indexed: ["uint64", "address", "address"],
    data: ["uint256", "uint8", "string", "uint64"],
  },
  "0xc41915f8406e23e62a2cdad2236d7828f77e8e719d6ee093e65af784af991bea": {
    name: "ClaimSettled",
    signature: "ClaimSettled(uint64,address,address,uint256,address)",
    indexed: ["uint64", "address"],
    data: ["address", "uint256", "address"],
  },
  "0x0d3ea3635d9f75d8d093175fb6a9d9e5bf9857c13967ebe0501284d803dbf2cb": {
    name: "ClaimPayoutFailure",
    signature: "ClaimPayoutFailureV1(uint64,uint8,uint256,address)",
    indexed: ["uint64"],
    data: ["uint8", "uint256", "address"],
  },
} as const satisfies Record<string, EvmEventSpec>;

type EvmValue = bigint | string;

function hexBytes(value: string, path: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    refuse("MalformedEncoding", path, "is not even-length 0x-prefixed hex");
  }
  const out = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return out;
}

function wordToBigInt(word: Uint8Array): bigint {
  let v = 0n;
  for (const byte of word) v = (v << 8n) | BigInt(byte);
  return v;
}

function staticValue(word: Uint8Array, type: Exclude<AbiType, "string">, path: string): EvmValue {
  const v = wordToBigInt(word);
  const bits = { address: 160n, uint8: 8n, uint64: 64n, uint256: 256n, bytes32: 256n }[type];
  if (v >> bits !== 0n) refuse("MalformedEncoding", path, `${type} word has nonzero high bits`);
  if (type === "address") return toHex(word.slice(12));
  if (type === "bytes32") return toHex(word);
  return v;
}

function decodeEvmData(data: Uint8Array, types: readonly AbiType[]): EvmValue[] {
  if (data.length % 32 !== 0) {
    refuse("MalformedEncoding", "data", `length ${String(data.length)} is not a multiple of 32`);
  }
  const head = types.length * 32;
  if (data.length < head) {
    refuse(
      "MalformedEncoding",
      "data",
      `needs ${String(head)} head bytes, has ${String(data.length)}`,
    );
  }
  const at = (offset: number) => `data[0x${offset.toString(16)}]`;
  return types.map((type, i) => {
    const word = data.slice(i * 32, i * 32 + 32);
    if (type !== "string") return staticValue(word, type, at(i * 32));
    const offset = wordToBigInt(word);
    if (offset % 32n !== 0n || offset < BigInt(head) || offset + 32n > BigInt(data.length)) {
      refuse("MalformedEncoding", at(i * 32), `string offset ${String(offset)} is out of bounds`);
    }
    const start = Number(offset);
    const length = wordToBigInt(data.slice(start, start + 32));
    const end = BigInt(start + 32) + length;
    const padded = BigInt(start + 32) + ((length + 31n) / 32n) * 32n;
    if (padded > BigInt(data.length)) {
      refuse("MalformedEncoding", at(start), `string length ${String(length)} runs past the data`);
    }
    for (let p = Number(end); p < Number(padded); p += 1) {
      if (data[p] !== 0) refuse("MalformedEncoding", at(p), "string padding is not zero");
    }
    return utf8(data.slice(start + 32, Number(end)), at(start));
  });
}

/**
 * Inspect one EVM router log.
 *
 * Pass `options.router` (the router's 0x address) to verify the emitter. Addresses come back as
 * lowercase 0x hex, not checksummed, because checksumming needs keccak and this package has no
 * runtime dependencies.
 */
export function inspectEvmRouterEvent(
  log: EvmRawLog,
  options: InspectOptions = {},
): RouterEventInspection {
  let name: string | null = null;
  try {
    if (log.removed === true) refuse("NotCommitted", "removed", "the log was removed by a reorg");
    const emitter = log.address?.toLowerCase() ?? null;
    const expected = options.router?.toLowerCase();
    if (expected !== undefined && emitter !== expected) {
      refuse(
        "UnexpectedEmitter",
        "address",
        `emitted by ${emitter ?? "an unknown contract"}, expected ${expected}`,
      );
    }
    const topic0 = log.topics[0];
    if (topic0 === undefined)
      refuse("NotRouterEvent", "topics", "an anonymous log has no selector");
    const topics = log.topics.map((t, i) => {
      const bytes = hexBytes(t, `topics[${String(i)}]`);
      if (bytes.length !== 32)
        refuse("MalformedEncoding", `topics[${String(i)}]`, "is not 32 bytes");
      return bytes;
    });
    const spec: EvmEventSpec | undefined = (
      EVM_ROUTER_EVENT_SELECTORS as Record<string, EvmEventSpec>
    )[topic0.toLowerCase()];
    if (spec === undefined) {
      refuse("UnknownEvent", "topics[0]", `${topic0} is not an inspected router event selector`);
    }
    name = spec.name;
    if (topics.length !== spec.indexed.length + 1) {
      refuse(
        "SchemaMismatch",
        "topics",
        `${spec.signature} has ${String(spec.indexed.length + 1)} topics, got ${String(topics.length)}`,
      );
    }
    const indexed = spec.indexed.map((type, i) => {
      const word = topics[i + 1] ?? new Uint8Array(32);
      if (type === "string")
        return refuse("SchemaMismatch", "topics", "indexed strings are hashed");
      return staticValue(word, type, `topics[${String(i + 1)}]`);
    });
    const data = decodeEvmData(hexBytes(log.data, "data"), spec.data);
    const base = {
      chain: "evm" as const,
      inspectorVersion: ROUTER_EVENT_INSPECTOR_VERSION,
      emitter,
      emitterVerified: expected !== undefined,
    };
    const big = (v: EvmValue | undefined) => v as bigint;
    const str = (v: EvmValue | undefined) => v as string;
    const hex = (v: EvmValue | undefined) => v as Hex;

    switch (spec.name) {
      case "BridgeOut": {
        const [route, sender, nonce] = indexed;
        const [token, gross, fee, net, chain, destination, railRef] = data;
        const record: BridgeOutEvent = {
          ...base,
          name: "BridgeOut",
          route: routeTag(big(route), "topics[1]"),
          sender: str(sender),
          token: str(token),
          nonce: big(nonce),
          grossAmount: big(gross),
          fee: big(fee),
          netAmount: big(net),
          destinationChain: str(chain),
          destination: { kind: "text", value: str(destination) },
          railRef: hex(railRef),
          createdLedger: null,
          createdAt: null,
          payout: { kind: "not-a-payout", reason: "outbound-dispatch" },
        };
        consistent(
          record.fee + record.netAmount === record.grossAmount,
          "data",
          "fee + netAmount does not equal grossAmount",
        );
        return { ok: true, event: record };
      }
      case "BridgeIn": {
        const [route, recipient, token] = indexed;
        const [amount, chain, sourceNonce, messageId] = data;
        const record: BridgeInEvent = {
          ...base,
          name: "BridgeIn",
          route: routeTag(big(route), "topics[1]"),
          recipient: str(recipient),
          token: str(token),
          amount: big(amount),
          sourceChain: str(chain),
          sourceNonce: big(sourceNonce),
          messageId: hex(messageId),
          delivered: null,
          claimId: null,
          ledger: null,
          payout: { kind: "not-a-payout", reason: "inbound-outcome-in-sibling-events" },
        };
        return { ok: true, event: record };
      }
      case "ClaimParked": {
        const [id, recipient, token] = indexed;
        const [amount, route, chain, sourceNonce] = data;
        const record: ClaimParkedEvent = {
          ...base,
          name: "ClaimParked",
          claimId: big(id),
          recipient: str(recipient),
          token: str(token),
          amount: big(amount),
          route: routeTag(big(route), "data[0x20]"),
          sourceChain: str(chain),
          sourceNonce: big(sourceNonce),
          createdAt: null,
          payout: { kind: "not-a-payout", reason: "claim-parked" },
        };
        return { ok: true, event: record };
      }
      case "ClaimSettled": {
        const [id, recipient] = indexed;
        const [token, amount, settledBy] = data;
        const record: ClaimSettledEvent = {
          ...base,
          name: "ClaimSettled",
          claimId: big(id),
          recipient: str(recipient),
          token: str(token),
          amount: big(amount),
          settledBy: str(settledBy),
          payout: base.emitterVerified
            ? {
                kind: "router-paid-recipient",
                recipient: str(recipient),
                token: str(token),
                amount: big(amount),
              }
            : { kind: "unverified-emitter" },
        };
        return { ok: true, event: record };
      }
      case "ClaimPayoutFailure": {
        const [id] = indexed;
        const [reason, outstanding, recipient] = data;
        const reasonCode = Number(big(reason));
        const record: ClaimPayoutFailureEvent = {
          ...base,
          name: "ClaimPayoutFailure",
          version: 1,
          claimId: big(id),
          reasonCode,
          reason: payoutReason(reasonCode, "data[0x0]", "evm"),
          outstandingAmount: big(outstanding),
          recipient: str(recipient),
          payout: { kind: "not-a-payout", reason: "payout-failed" },
        };
        return { ok: true, event: record };
      }
    }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, name, diagnostics: [error.diagnostic] };
    throw error;
  }
}
