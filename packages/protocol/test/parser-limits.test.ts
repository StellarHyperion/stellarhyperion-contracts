import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hyperionRouterAbi } from "../src/abi/index.js";
import {
  AddressKind,
  STRKEY_LEN_MUXED,
  STRKEY_LEN_PLAIN,
  TAGGED_LEN_MUXED,
  TAGGED_LEN_PLAIN,
  encodeStellarAddress,
  parseStellarAddress,
  strkeyDestination,
  taggedDestination,
} from "../src/addresses.js";
import { concatBytes, fromHex } from "../src/bytes.js";
import {
  BURN_HOOK_DATA,
  BURN_MESSAGE_VERSION,
  FINALITY_THRESHOLD_FINALIZED,
  MESSAGE_VERSION,
  MSG_BODY,
  STELLAR_DOMAIN,
  cctpBody,
  cctpHookData,
  parseCctpBurnMessage,
  parseCctpMessage,
} from "../src/cctp.js";
import {
  HOOK_LEN_MUXED,
  HOOK_LEN_PLAIN,
  HOOK_MAX_LEN,
  INBOUND_NOTE_MAX_LEN,
  INBOUND_NOTE_MIN,
  INBOUND_NOTE_MUXED_LEN,
  INBOUND_NOTE_PLAIN_LEN,
  NOTE_VERSION,
  OUTBOUND_NOTE_LEN,
  decodeCctpHook,
  decodeInboundNote,
  decodeOutboundNote,
  encodeCctpHook,
  encodeInboundNote,
  encodeOutboundNote,
  toEvmAddress,
  toWord,
} from "../src/notes.js";
import {
  PARSER_LIMITS_MATRIX,
  PARSER_STRESS_SIZES,
  formatParserLimitsReport,
} from "../src/parserLimits.js";
import { C_ADDR, G_ADDR, M_ADDR } from "./fixtures.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MAX_SOROBAN_I128 = (1n << 127n) - 1n;
const MAX_EVM_RECIPIENT = "0xffffffffffffffffffffffffffffffffffffffff" as const;

function writeU32Be(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function writeI128Word(buf: Uint8Array, offset: number, value: bigint): void {
  let rem = value;
  for (let i = 31; i >= 16; i -= 1) {
    buf[offset + i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
}

function maxValidCctpMessage(hook: Uint8Array): Uint8Array {
  const header = new Uint8Array(MSG_BODY);
  writeU32Be(header, 0, MESSAGE_VERSION);
  writeU32Be(header, 4, 0);
  writeU32Be(header, 8, STELLAR_DOMAIN);
  header.fill(0xab, 12, 44);
  header.fill(0xe1, 44, 76);
  header.fill(0xc1, 76, 108);
  header.fill(0xd1, 108, 140);
  writeU32Be(header, 140, FINALITY_THRESHOLD_FINALIZED);
  writeU32Be(header, 144, FINALITY_THRESHOLD_FINALIZED);

  const burn = new Uint8Array(BURN_HOOK_DATA);
  writeU32Be(burn, 0, BURN_MESSAGE_VERSION);
  burn.fill(0xb0, 4, 36);
  burn.fill(0xa5, 36, 68);
  writeI128Word(burn, 68, MAX_SOROBAN_I128);
  burn.fill(0x5e, 100, 132);
  writeI128Word(burn, 132, MAX_SOROBAN_I128);
  writeI128Word(burn, 164, MAX_SOROBAN_I128);
  writeI128Word(burn, 196, MAX_SOROBAN_I128);

  return concatBytes(header, burn, hook);
}

describe("bounded large-input stress fixtures and cross-stack parser limits", () => {
  it("accepts valid maximum-size inputs consistently across notes, StrKeys, and CCTP hooks", () => {
    // 1. OutboundNote at max EVM recipient and max u64 nonce (29 bytes).
    const outbound = encodeOutboundNote(MAX_EVM_RECIPIENT, MAX_U64);
    expect(outbound.length).toBe(OUTBOUND_NOTE_LEN);
    expect(decodeOutboundNote(outbound)).toEqual({
      recipient: MAX_EVM_RECIPIENT,
      nonce: MAX_U64,
    });
    expect(toEvmAddress(toWord(MAX_EVM_RECIPIENT))).toBe(MAX_EVM_RECIPIENT);

    // 2. StrKeys at max 32-byte key + max u64 muxed id (56 and 69 characters).
    const maxKey = new Uint8Array(32).fill(0xff);
    const maxAccount = encodeStellarAddress(AddressKind.Account, maxKey);
    const maxContract = encodeStellarAddress(AddressKind.Contract, maxKey);
    const maxMuxed = encodeStellarAddress(AddressKind.MuxedAccount, maxKey, MAX_U64);
    expect(maxAccount.length).toBe(STRKEY_LEN_PLAIN);
    expect(maxContract.length).toBe(STRKEY_LEN_PLAIN);
    expect(maxMuxed.length).toBe(STRKEY_LEN_MUXED);

    for (const [addr, expectedNoteLen, expectedWireLen, expectedTaggedLen, expectedHookLen] of [
      [G_ADDR, INBOUND_NOTE_PLAIN_LEN, STRKEY_LEN_PLAIN + 2, TAGGED_LEN_PLAIN, HOOK_LEN_PLAIN],
      [C_ADDR, INBOUND_NOTE_PLAIN_LEN, STRKEY_LEN_PLAIN + 2, TAGGED_LEN_PLAIN, HOOK_LEN_PLAIN],
      [M_ADDR, INBOUND_NOTE_MUXED_LEN, STRKEY_LEN_MUXED + 2, TAGGED_LEN_MUXED, HOOK_LEN_MUXED],
      [maxMuxed, INBOUND_NOTE_MAX_LEN, STRKEY_LEN_MUXED + 2, TAGGED_LEN_MUXED, HOOK_MAX_LEN],
    ] as const) {
      const parts = parseStellarAddress(addr);
      const wire = strkeyDestination(addr);
      expect(wire.length).toBe(expectedWireLen);

      const tagged = taggedDestination(parts);
      expect(tagged.length).toBe(expectedTaggedLen);

      const inbound = encodeInboundNote(addr, MAX_U64);
      expect(inbound.length).toBe(expectedNoteLen);
      const decodedInbound = decodeInboundNote(inbound);
      expect(decodedInbound.strkey).toBe(addr);
      expect(decodedInbound.nonce).toBe(MAX_U64);

      const hook = encodeCctpHook(addr);
      expect(hook.length).toBe(expectedHookLen);
      const decodedHook = decodeCctpHook(hook);
      expect(decodedHook.kind).toBe(parts.kind);
      expect(decodedHook.key).toBe(parts.key);
      expect(decodedHook.muxedId).toBe(parts.muxedId);

      const fullCctp = maxValidCctpMessage(hook);
      expect(fullCctp.length).toBe(MSG_BODY + BURN_HOOK_DATA + expectedHookLen);
      const msg = parseCctpMessage(fullCctp);
      expect(msg.destinationDomain).toBe(STELLAR_DOMAIN);
      const body = cctpBody(fullCctp);
      const burn = parseCctpBurnMessage(body);
      expect(burn.amount).toBe(MAX_SOROBAN_I128);
      expect(burn.maxFee).toBe(MAX_SOROBAN_I128);
      expect(decodeCctpHook(cctpHookData(body))).toEqual(decodedHook);
    }
  });

  it("rejects oversized inputs up to 256 KiB cleanly with bounded execution time", () => {
    const sizes = [...PARSER_STRESS_SIZES, 262_144];

    for (const size of sizes) {
      const oversizedOutbound = new Uint8Array(size).fill(0x11);
      oversizedOutbound[0] = NOTE_VERSION;

      const oversizedInbound = new Uint8Array(size).fill(0x41);
      oversizedInbound[0] = NOTE_VERSION;
      oversizedInbound[1] = AddressKind.MuxedAccount;
      oversizedInbound[2] = STRKEY_LEN_MUXED;

      const oversizedHook = new Uint8Array(size).fill(0x22);
      oversizedHook[0] = NOTE_VERSION;
      oversizedHook[1] = AddressKind.Account;

      const oversizedWord = new Uint8Array(size).fill(0x00);
      oversizedWord[size - 1] = 0x01;

      const oversizedStrkey = `M${"A".repeat(size - 1)}`;

      const start = performance.now();
      expect(() => decodeOutboundNote(oversizedOutbound)).toThrow(/MalformedMessage/);
      expect(() => decodeInboundNote(oversizedInbound)).toThrow(/MalformedMessage/);
      expect(() => decodeCctpHook(oversizedHook)).toThrow(/MalformedMessage/);
      expect(() => toEvmAddress(oversizedWord)).toThrow(/MalformedMessage/);
      expect(() => parseStellarAddress(oversizedStrkey)).toThrow(/InvalidDestination/);
      const elapsedMs = performance.now() - start;

      // Five O(1) length-guarded rejections must finish well under a generous CI jitter bound.
      expect(elapsedMs).toBeLessThan(100);
    }

    // Also cover the framed InboundNote window (`12..=266` bytes) where `3 + len + 8 === bytes.length`
    // holds for an invalid `uint8` strkey length (`200`), ensuring InvalidDestination is raised before
    // ASCII conversion or checksum loops.
    const framedInvalidLen = new Uint8Array(3 + 200 + 8).fill(0x41);
    framedInvalidLen[0] = NOTE_VERSION;
    framedInvalidLen[1] = AddressKind.Account;
    framedInvalidLen[2] = 200;
    expect(() => decodeInboundNote(framedInvalidLen)).toThrow(/InvalidDestination/);

    // Burn amount one unit above Soroban i128::MAX fails closed with DecimalOverflow.
    const overflowBurn = new Uint8Array(BURN_HOOK_DATA);
    writeU32Be(overflowBurn, 0, BURN_MESSAGE_VERSION);
    overflowBurn[68 + 16] = 0x80;
    expect(() => parseCctpBurnMessage(overflowBurn)).toThrow(/DecimalOverflow/);
  });

  it("compares Rust, Solidity, and SDK parser limits against live repository sources", () => {
    const rustAxelar = readFileSync(
      resolve(REPO_ROOT, "soroban/crates/hyperion-core/src/axelar.rs"),
      "utf8",
    );
    const rustCctp = readFileSync(
      resolve(REPO_ROOT, "soroban/crates/hyperion-core/src/cctp.rs"),
      "utf8",
    );
    const rustStrkey = readFileSync(
      resolve(REPO_ROOT, "soroban/crates/hyperion-core/src/strkey.rs"),
      "utf8",
    );
    const rustAddress = readFileSync(
      resolve(REPO_ROOT, "soroban/crates/hyperion-core/src/address.rs"),
      "utf8",
    );
    const rustRouterTypes = readFileSync(
      resolve(REPO_ROOT, "soroban/crates/hyperion-router/src/types.rs"),
      "utf8",
    );
    const solNotes = readFileSync(
      resolve(REPO_ROOT, "evm/src/libraries/HyperionNotes.sol"),
      "utf8",
    );
    const solAddress = readFileSync(
      resolve(REPO_ROOT, "evm/src/libraries/StellarAddress.sol"),
      "utf8",
    );
    const solTypes = readFileSync(resolve(REPO_ROOT, "evm/src/HyperionTypes.sol"), "utf8");

    // Verify wire constants align across Rust, Solidity, and SDK.
    expect(INBOUND_NOTE_MIN).toBe(12);
    expect(INBOUND_NOTE_PLAIN_LEN).toBe(67);
    expect(INBOUND_NOTE_MUXED_LEN).toBe(80);
    expect(HOOK_LEN_PLAIN).toBe(34);
    expect(HOOK_LEN_MUXED).toBe(42);

    expect(rustAxelar).toContain("pub const OUTBOUND_NOTE_LEN: u32 = 29;");
    expect(rustAxelar).toContain("pub const INBOUND_NOTE_MIN: u32 = 1 + 3 + 8;");
    expect(rustAxelar).toContain("INBOUND_NOTE_PLAIN_LEN");
    expect(rustAxelar).toContain("INBOUND_NOTE_MUXED_LEN");
    expect(rustCctp).toContain("pub const MSG_BODY: u32 = 148;");
    expect(rustCctp).toContain("pub const BURN_HOOK_DATA: u32 = 228;");
    expect(rustCctp).toContain("HOOK_LEN_PLAIN");
    expect(rustCctp).toContain("HOOK_LEN_MUXED");
    expect(rustStrkey).toContain("pub const STRKEY_LEN_PLAIN: u32 = 56;");
    expect(rustStrkey).toContain("pub const STRKEY_LEN_MUXED: u32 = 69;");
    expect(rustAddress).toContain("pub const TAGGED_LEN_PLAIN: u32 = 33;");
    expect(rustAddress).toContain("pub const TAGGED_LEN_MUXED: u32 = 41;");

    expect(solNotes).toContain("uint256 internal constant OUTBOUND_NOTE_LEN = 29;");
    expect(solNotes).toContain("uint256 private constant INBOUND_NOTE_MIN = 1 + 3 + 8;");
    expect(solAddress).toContain("uint256 internal constant STRKEY_LEN_PLAIN = 56;");
    expect(solAddress).toContain("uint256 internal constant STRKEY_LEN_MUXED = 69;");
    expect(solAddress).toContain("uint256 internal constant TAGGED_LEN_PLAIN = 33;");
    expect(solAddress).toContain("uint256 internal constant TAGGED_LEN_MUXED = 41;");

    // Verify AdminAction queued payload structure in Rust (no String/Bytes variants) and EVM ABI (5 static slots = 160B).
    const adminEnumBlock = /pub enum AdminAction \{([\s\S]*?)\}/.exec(rustRouterTypes)?.[1] ?? "";
    expect(adminEnumBlock.length).toBeGreaterThan(0);
    expect(adminEnumBlock).not.toContain("String");
    expect(adminEnumBlock).not.toContain("Bytes,");
    expect(adminEnumBlock).not.toContain("Bytes)");

    expect(solTypes).toContain("struct AdminAction {");
    const queueActionFn = hyperionRouterAbi.find(
      (
        item,
      ): item is Extract<(typeof hyperionRouterAbi)[number], { readonly name: "queueAction" }> =>
        "name" in item && item.name === "queueAction",
    );
    expect(queueActionFn).toBeDefined();
    if (!queueActionFn) {
      throw new Error("missing queueAction ABI entry");
    }
    const tupleComponents = queueActionFn.inputs[0].components;
    expect(tupleComponents.map((c) => c.type)).toEqual([
      "uint8",
      "uint8",
      "address",
      "uint256",
      "uint8",
    ]);
    // 5 static ABI head slots * 32 bytes = 160 bytes.
    expect(tupleComponents.length * 32).toBe(160);

    // Ensure the rendered comparison report includes every surface and all three stacks.
    const report = formatParserLimitsReport();
    expect(PARSER_LIMITS_MATRIX.length).toBe(10);
    for (const entry of PARSER_LIMITS_MATRIX) {
      expect(report).toContain(entry.title);
      expect(entry.rust.maxAcceptedBytes).toBeGreaterThan(0);
      expect(entry.solidity.maxAcceptedBytes).toBeGreaterThan(0);
      expect(entry.sdk.maxAcceptedBytes).toBeGreaterThan(0);
    }
    // Hex-encoded oversized inputs also reject deterministically.
    const hexOversized = `0x01${"aa".repeat(512)}` as const;
    expect(fromHex(hexOversized).length).toBe(513);
    expect(() => decodeOutboundNote(hexOversized)).toThrow(/MalformedMessage/);
  });
});
