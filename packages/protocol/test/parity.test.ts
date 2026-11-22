/**
 * The test that makes this package worth having.
 *
 * Everything else here checks that the TypeScript does what the TypeScript meant to do. This file
 * checks it against the contracts, by reading the Rust and the Solidity and the compiled artifacts
 * off disk. Drift between the SDK and the chain becomes a failing test rather than a support
 * ticket written by somebody whose transfer went somewhere unexpected.
 *
 * Reads sources rather than importing anything, so adding a route or an error to a contract and
 * forgetting the SDK is caught here, at the only moment it is cheap.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";

import { EVM_ERROR_NAMES, SOROBAN_ERROR_NAMES } from "../src/errors.js";
import {
  EVM_ERROR_SELECTORS,
  GENERATED_EVM_ERROR_NAMES,
  errorNameFromRevert,
} from "../src/abi/errors.js";
import { ROUTE_KINDS, ROUTE_SLUGS, RouteKind } from "../src/routes.js";
import { QuoteBlocker } from "../src/quotes.js";
import { TokenMappingConflict } from "../src/tokenMapping.js";
import { AddressKind } from "../src/addresses.js";
import {
  BURN_MESSAGE_VERSION,
  FINALITY_THRESHOLD_FINALIZED,
  HOOK_VERSION,
  MESSAGE_VERSION,
  STELLAR_DOMAIN,
} from "../src/cctp.js";
import { MAX_DECIMALS, MAX_FEE_BPS } from "../src/amounts.js";
import { NOTE_VERSION, OUTBOUND_NOTE_LEN } from "../src/notes.js";
import { WIRE_SCHEMAS } from "../src/wire-compat.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const evmRoot = resolve(packageRoot, "..", "..", "evm");
const sorobanRoot = resolve(packageRoot, "..", "..", "soroban");
const coreSrc = join(sorobanRoot, "crates", "hyperion-core", "src");
const repoRoot = resolve(evmRoot, "..");
const malformedCorpus = join(repoRoot, "testdata", "malformed-message-corpus.tsv");
const sorobanRouterSrc = join(sorobanRoot, "crates", "hyperion-router", "src");
const sorobanCctpSrc = join(sorobanRoot, "crates", "hyperion-adapter-cctp", "src");
const sorobanAxelarSrc = join(sorobanRoot, "crates", "hyperion-adapter-axelar", "src");
const evmTest = join(evmRoot, "test");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("the versioned malformed-message corpus", () => {
  it("has unique cases for truncation, trailing bytes, versions and wide values", () => {
    const rows = read(malformedCorpus)
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("|"));
    const ids = rows.map(([id]) => id);
    expect(new Set(ids).size).toBe(rows.length);
    expect(rows.map(([id]) => id)).toEqual([
      "outbound-valid",
      "outbound-wide-nonce",
      "outbound-truncated",
      "outbound-trailing-byte",
      "outbound-unsupported-version",
    ]);
    expect(
      rows.every(
        ([, direction, payload, expected]) =>
          direction === "outbound" && /^0x(?:[0-9a-f]{2})+$/i.test(payload ?? "") && expected,
      ),
    ).toBe(true);
  });
});

function bracedBlock(source: string, anchor: RegExp, label: string): string {
  const match = anchor.exec(source);
  expect(match, `${label} reference is missing`).not.toBeNull();
  const open = source.indexOf("{", match!.index);
  expect(open, `${label} body is missing`).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(match!.index, index + 1);
      }
    }
  }
  throw new Error(`${label} body is not closed`);
}

function rustFunction(source: string, name: string): string {
  return bracedBlock(source, new RegExp(`\\bfn\\s+${name}\\s*\\(`), `Rust function ${name}`);
}

function solidityFunction(source: string, name: string): string {
  return bracedBlock(
    source,
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`),
    `Solidity function ${name}`,
  );
}

function requireEvidence(source: string, pattern: RegExp, label: string): void {
  if (!pattern.test(source)) {
    throw new Error(`${label} trust-surface evidence changed`);
  }
}

/** Pull `Name = <n>,` out of a Rust enum body, in declaration order. */
function rustEnumVariants(source: string, enumName: string): { name: string; value: number }[] {
  const start = source.indexOf(`pub enum ${enumName}`);
  expect(start, `${enumName} not found in the Rust source`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n}", open);
  const body = source.slice(open + 1, close);
  const out: { name: string; value: number }[] = [];
  for (const match of body.matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*=\s*(\d+)\s*,/gm)) {
    out.push({ name: match[1]!, value: Number(match[2]) });
  }
  expect(out.length, `no variants parsed out of ${enumName}`).toBeGreaterThan(0);
  return out;
}

/** Pull `error Name(` out of Solidity, in declaration order. */
function solidityErrors(source: string): string[] {
  return [...source.matchAll(/^error\s+([A-Za-z0-9_]+)\s*\(/gm)].map((match) => match[1]!);
}

/**
 * Pull the variant names out of a Rust enum that carries data, in declaration order.
 *
 * `rustEnumVariants` above wants `Name = <n>,` because Soroban's error enum is numbered by hand.
 * A `contracttype` enum with tuple variants has no numbers to read, and its order is the wire
 * order, so this reads names only and leaves the numbering to the shape of the enum itself.
 */
function rustDataEnumVariants(source: string, enumName: string): string[] {
  const start = source.indexOf(`pub enum ${enumName}`);
  expect(start, `${enumName} not found in the Rust source`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n}", open);
  const body = source.slice(open + 1, close);
  const out: string[] = [];
  for (const match of body.matchAll(/^\s{4}([A-Z][A-Za-z0-9]*)\s*[({,]/gm)) {
    out.push(match[1]!);
  }
  expect(out.length, `no variants parsed out of ${enumName}`).toBeGreaterThan(0);
  return out;
}

/** Pull a Solidity struct's member names, in declaration order. */
function solidityStructFields(source: string, structName: string): string[] {
  const start = source.indexOf(`struct ${structName} {`);
  expect(start, `${structName} not found in the Solidity source`).toBeGreaterThan(-1);
  const close = source.indexOf("\n}", start);
  const body = source.slice(start, close);
  const out: string[] = [];
  for (const match of body.matchAll(/^\s{4}[A-Za-z0-9_\[\]]+\s+([A-Za-z0-9_]+)\s*;/gm)) {
    out.push(match[1]!);
  }
  return out;
}

/** Pull a TypeScript interface's property names, in declaration order. */
function tsInterfaceFields(source: string, interfaceName: string): string[] {
  const start = source.indexOf(`export interface ${interfaceName} {`);
  expect(start, `${interfaceName} not found in the TypeScript source`).toBeGreaterThan(-1);
  const close = source.indexOf("\n}", start);
  const body = source.slice(start, close);
  const out: string[] = [];
  for (const match of body.matchAll(/^\s{2}readonly\s+([A-Za-z0-9_]+)\??\s*:/gm)) {
    out.push(match[1]!);
  }
  expect(out.length, `no fields parsed out of ${interfaceName}`).toBeGreaterThan(0);
  return out;
}

/** Pull a Solidity enum's members, in declaration order. */
function solidityEnum(source: string, enumName: string): string[] {
  const start = source.indexOf(`enum ${enumName}`);
  expect(start, `${enumName} not found in the Solidity source`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source
    .slice(open + 1, close)
    .split(",")
    .map((line) => line.replace(/\/\/.*$/gm, "").trim())
    .filter((line) => line.length > 0);
}

describe("the error vocabularies", () => {
  it("matches the Soroban enum name for name and number for number", () => {
    // Index aligned and append only. Reordering `HyperionError` would relabel every failure the
    // Stellar side has ever emitted, each one plausibly, which is the worst kind of wrong.
    const variants = rustEnumVariants(read(join(coreSrc, "error.rs")), "HyperionError");
    expect(SOROBAN_ERROR_NAMES.length).toBe(variants.length);
    variants.forEach((variant, index) => {
      expect(SOROBAN_ERROR_NAMES[index]).toBe(variant.name);
      expect(variant.value).toBe(index + 1);
    });
  });

  it("matches the Solidity declaration order", () => {
    const declared = solidityErrors(read(join(evmRoot, "src", "HyperionErrors.sol")));
    expect([...EVM_ERROR_NAMES]).toEqual(declared);
  });

  it("matches what the generator last wrote, so the committed ABI is not stale", () => {
    expect([...EVM_ERROR_NAMES]).toEqual([...GENERATED_EVM_ERROR_NAMES]);
  });

  it("has a selector for every declared error that a contract can actually revert with", () => {
    // Computed from the signature rather than copied from anywhere, and checked against the
    // generated table, so a selector nobody typed cannot be a selector nobody noticed.
    const known = new Map(
      Object.entries(EVM_ERROR_SELECTORS).map(([selector, meta]) => [meta.signature, selector]),
    );
    for (const [signature, selector] of known) {
      expect(toFunctionSelector(signature)).toBe(selector);
    }
  });

  it("decodes compiled immutable helper errors that bubble through router calls", () => {
    const artifact = JSON.parse(
      read(join(evmRoot, "out", "OutboundProvenance.sol", "OutboundProvenance.json")),
    ) as { abi: { type: string; name?: string; inputs?: { type: string }[] }[] };
    const declared = new Set<string>(EVM_ERROR_NAMES);
    const errors = artifact.abi.filter(
      (entry) => entry.type === "error" && declared.has(entry.name ?? ""),
    );
    expect(errors.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "FeeTokenNotSupported",
        "IntentNonceMismatch",
        "IntentDomainMismatch",
      ]),
    );
    for (const error of errors) {
      const name = error.name ?? "";
      const signature = `${name}(${(error.inputs ?? []).map((input) => input.type).join(",")})`;
      expect(errorNameFromRevert(toFunctionSelector(signature)), signature).toBe(name);
    }
  });

  it("names an error from revert data the way a wallet hands it over", () => {
    const paused = toFunctionSelector("AdapterNotSet()");
    expect(errorNameFromRevert(paused)).toBe("AdapterNotSet");
    expect(errorNameFromRevert(`${paused}${"00".repeat(32)}`)).toBe("AdapterNotSet");
    expect(errorNameFromRevert("0x")).toBeNull();
    expect(errorNameFromRevert("0xdeadbeef")).toBeNull();
  });

  it("does not claim an EVM Paused, because OpenZeppelin supplies that one", () => {
    const declared = solidityErrors(read(join(evmRoot, "src", "HyperionErrors.sol")));
    expect(declared).not.toContain("Paused");
  });
});

describe("the route tags", () => {
  it("matches the Rust enum", () => {
    const variants = rustEnumVariants(read(join(coreSrc, "route.rs")), "RouteKind");
    expect(variants.map((v) => v.name)).toEqual(["Cctp", "AxelarIts", "AxelarGmp", "Allbridge"]);
    variants.forEach((variant, index) => {
      expect(variant.value).toBe(index);
      expect(ROUTE_KINDS[index]).toBe(variant.value);
    });
  });

  it("matches the Solidity enum, which carries the same integers", () => {
    const members = solidityEnum(read(join(evmRoot, "src", "HyperionTypes.sol")), "RouteKind");
    expect(members).toEqual(["Cctp", "AxelarIts", "AxelarGmp", "Allbridge"]);
    expect(members.length).toBe(ROUTE_KINDS.length);
    expect(members.indexOf("Allbridge")).toBe(RouteKind.Allbridge);
  });

  it("has a slug for every rail and no duplicates, because slugs end up in urls", () => {
    const slugs = ROUTE_KINDS.map((kind) => ROUTE_SLUGS[kind]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("the address kinds", () => {
  it("matches the Solidity enum", () => {
    const members = solidityEnum(read(join(evmRoot, "src", "HyperionTypes.sol")), "AddressKind");
    expect(members).toEqual(["Account", "Contract", "MuxedAccount"]);
    expect(members.indexOf("Account")).toBe(AddressKind.Account);
    expect(members.indexOf("Contract")).toBe(AddressKind.Contract);
    expect(members.indexOf("MuxedAccount")).toBe(AddressKind.MuxedAccount);
  });

  it("matches the Rust enum", () => {
    const source = read(join(coreSrc, "address.rs"));
    const variants = rustEnumVariants(source, "AddressKind");
    expect(variants.map((v) => v.name)).toEqual(["Account", "Contract", "MuxedAccount"]);
    variants.forEach((variant, index) => {
      expect(variant.value).toBe(index);
    });
  });
});

describe("the documented inbound trust surface", () => {
  it("keeps the active deployment gate and the interface references executable", () => {
    const docs = read(join(coreSrc, "lib.rs"));
    requireEvidence(
      docs,
      /active deployment is Stellar Testnet outbound ITS\/CCTP/i,
      "active deployment gate",
    );
    requireEvidence(
      docs,
      /hyperion-adapter-cctp::rail::Receiver/,
      "CCTP provider interface reference",
    );
    requireEvidence(docs, /inbound::Router/, "router inbound interface reference");
    requireEvidence(docs, /packages\/protocol\/test\/parity\.test\.ts/, "trust check reference");
    requireEvidence(
      docs,
      /do not execute through the\s+\/\/! router's timelock/,
      "adapter authority distinction",
    );
    requireEvidence(
      read(resolve(packageRoot, "..", "..", "script", "anvil-e2e.sh")),
      /This local harness is not activation evidence/,
      "local EVM harness activation gate",
    );
    const fixture = read(join(evmTest, "Fixture.sol"));
    requireEvidence(
      fixture,
      /router\.adapter\(RouteKind\.Cctp\)/,
      "fixture outbound adapter assertion",
    );
    requireEvidence(
      fixture,
      /router\.railReceiver\(RouteKind\.Cctp\)/,
      "fixture inbound receiver assertion",
    );

    const routerInterface = bracedBlock(
      read(join(coreSrc, "inbound.rs")),
      /pub trait Router\s*\{/,
      "Soroban inbound Router interface",
    );
    const methods = [...routerInterface.matchAll(/^\s*fn\s+([A-Za-z0-9_]+)\s*\(/gm)].map(
      (item) => item[1],
    );
    expect(methods).toEqual(["is_paused", "bridge_in", "treasury"]);
  });

  it("binds inbound provider authentication to each active Soroban adapter", () => {
    const cctpRail = read(join(sorobanCctpSrc, "rail.rs"));
    const cctpReceiver = bracedBlock(
      cctpRail,
      /pub trait Receiver\s*\{/,
      "CCTP Receiver interface",
    );
    requireEvidence(cctpReceiver, /fn receive_message\s*\(/, "CCTP transmitter call interface");

    const cctpReceive = rustFunction(read(join(sorobanCctpSrc, "lib.rs")), "receive");
    requireEvidence(cctpReceive, /relayer\.require_auth\(\)/, "CCTP relayer authentication");
    requireEvidence(
      cctpReceive,
      /MessageTransmitterClient::new\(&env,\s*&cfg\.message_transmitter\)\.receive_message\(/,
      "Circle message-transmitter authentication",
    );

    const axelarInbound = rustFunction(
      read(join(sorobanAxelarSrc, "lib.rs")),
      "execute_with_interchain_token",
    );
    requireEvidence(axelarInbound, /cfg\.its\.require_auth\(\)/, "ITS callback authentication");
    requireEvidence(
      axelarInbound,
      /source_address\s*!=\s*peer/,
      "configured Axelar remote-peer check",
    );
    requireEvidence(
      axelarInbound,
      /storage::token_of\(&env,\s*&token_id\)/,
      "Axelar token mapping",
    );

    const bridgeIn = rustFunction(read(join(sorobanRouterSrc, "lib.rs")), "bridge_in");
    requireEvidence(bridgeIn, /caller\.require_auth\(\)/, "router inbound caller authorization");
    requireEvidence(
      bridgeIn,
      /storage::rail_receiver\(&env,\s*route\)/,
      "configured rail receiver lookup",
    );
    requireEvidence(bridgeIn, /caller\s*!=\s*expected/, "router receiver equality check");
  });

  it("distinguishes direct adapter authority from router timelocks", () => {
    for (const sourceRoot of [sorobanCctpSrc, sorobanAxelarSrc]) {
      const source = read(join(sourceRoot, "lib.rs"));
      requireEvidence(
        rustFunction(source, "set_admin"),
        /require_admin\(&env\)/,
        "direct adapter admin setter",
      );
      requireEvidence(
        rustFunction(source, "require_admin"),
        /cfg\.admin\.require_auth\(\)/,
        "adapter admin auth",
      );
    }
    requireEvidence(
      rustFunction(read(join(sorobanCctpSrc, "lib.rs")), "set_fee_policy"),
      /require_admin\(&env\)/,
      "CCTP direct policy setter",
    );
    requireEvidence(
      rustFunction(read(join(sorobanAxelarSrc, "lib.rs")), "set_chain_enabled"),
      /require_admin\(&env\)/,
      "Axelar direct chain setter",
    );

    const router = read(join(sorobanRouterSrc, "lib.rs"));
    requireEvidence(
      rustFunction(router, "queue_action"),
      /timelock::queue\(/,
      "Soroban queue path",
    );
    requireEvidence(
      rustFunction(router, "execute_action"),
      /timelock::take_matured\(/,
      "Soroban matured execution",
    );

    const cctpEvm = read(join(evmRoot, "src", "adapters", "CctpAdapter.sol"));
    requireEvidence(
      solidityFunction(cctpEvm, "setLane"),
      /external\s+onlyOwner/,
      "direct EVM adapter owner setter",
    );
    requireEvidence(
      solidityFunction(cctpEvm, "dispatch"),
      /msg\.sender\s*!=\s*ROUTER/,
      "EVM adapter's immutable router authority",
    );
    const axelarEvm = read(join(evmRoot, "src", "adapters", "AxelarItsAdapter.sol"));
    requireEvidence(
      solidityFunction(axelarEvm, "setPeer"),
      /external\s+onlyOwner/,
      "direct ITS owner setter",
    );
    requireEvidence(
      solidityFunction(axelarEvm, "dispatch"),
      /msg\.sender\s*!=\s*ROUTER/,
      "ITS adapter's immutable router authority",
    );

    const evmRouter = read(join(evmRoot, "src", "HyperionRouter.sol"));
    requireEvidence(
      solidityFunction(evmRouter, "queueAction"),
      /onlyRole\(DEFAULT_ADMIN_ROLE\)/,
      "EVM queue authority",
    );
    requireEvidence(
      solidityFunction(evmRouter, "executeAction"),
      /block\.timestamp\s*<\s*queued\.eta/,
      "EVM timelock delay",
    );
    requireEvidence(
      read(join(evmTest, "Fixture.sol")),
      /target\.executeAction\(id\)/,
      "EVM fixture timelock path",
    );
  });

  it("fails closed when a local interface or trust check is absent", () => {
    expect(() => {
      requireEvidence(
        "interface with no receiver",
        /MessageTransmitter/,
        "fixture provider interface",
      );
    }).toThrow("fixture provider interface trust-surface evidence changed");
    expect(() => {
      requireEvidence("function setLane() external", /onlyOwner/, "fixture authority setter");
    }).toThrow("fixture authority setter trust-surface evidence changed");
  });
});

describe("the deterministic provider fault fixtures", () => {
  it("matches the shared exact-width schedule vectors used by Rust and Solidity", () => {
    const mask = (1n << 64n) - 1n;
    const mix = (input: bigint) => {
      let value = input ^ (input >> 30n);
      value = (value * 0xbf58476d1ce4e5b9n) & mask;
      value ^= value >> 27n;
      value = (value * 0x94d049bb133111ebn) & mask;
      return value ^ (value >> 31n);
    };
    const rows = read(join(repoRoot, "testdata", "provider-fault-vectors.tsv"))
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const [seed, dispatch, inbound] = row.split("|");
      expect(mix(BigInt(seed!) ^ 0x4453504154434848n), row).toBe(BigInt(dispatch!));
      expect(mix(BigInt(seed!) ^ 0x494e424f554e4448n), row).toBe(BigInt(inbound!));
    }
  });
  it("keeps dispatch and inbound stages explicit on both local harnesses", () => {
    const rust = read(join(coreSrc, "fault.rs"));
    const routerTests = read(join(sorobanRouterSrc, "test", "mod.rs"));
    const solidity = read(join(evmTest, "Fixture.sol"));
    const rehearsal = read(resolve(packageRoot, "..", "..", "script", "anvil-e2e.sh"));

    expect(rust).toMatch(/pub enum FaultStage\s*\{\s*Dispatch\s*=\s*0,\s*Inbound\s*=\s*1/s);
    expect(rust).toMatch(/pub const fn from_seed\(seed: u64\)/);
    expect(rust).toMatch(/pub fn next\(&mut self, stage: FaultStage\)/);
    expect(routerTests).toMatch(/before_dispatch\(&mut self\)/);
    expect(routerTests).toMatch(/before_inbound\(&mut self\)/);
    expect(solidity).toMatch(/PROVIDER_STAGE_DISPATCH\s*=\s*0/);
    expect(solidity).toMatch(/PROVIDER_STAGE_INBOUND\s*=\s*1/);
    expect(solidity).toMatch(/function _nextProviderFault\(uint8 stage\)/);
    expect(rehearsal).toMatch(/HYPERION_FAULT_SEED=\"\$\{HYPERION_FAULT_SEED:-156\}\"/);
    expect(rehearsal).toMatch(/deterministic provider fault schedule/);
  });
});

describe("the hostile Soroban token and receiver fixtures", () => {
  const variants = (source: string, name: string): string[] => {
    const body = new RegExp(`pub enum ${name}\\s*\\{([^}]*)\\}`, "s").exec(source)?.[1] ?? "";
    return [...body.matchAll(/^\s*([A-Z]\w*)\s*[,(]/gm)].map((m) => m[1]!);
  };

  it("documents every fixture mode the Soroban source declares, and no others", () => {
    const fixtures = read(join(sorobanRouterSrc, "test", "hostile.rs"));
    const doc = read(join(repoRoot, "docs", "HOSTILE_FIXTURES.md"));
    for (const [name, expected] of [
      [
        "Hostility",
        ["Honest", "Frozen", "ShortCredit", "ExtraDebit", "RequireCosigner", "Reenter"],
      ],
      [
        "ReceiverMode",
        ["Honest", "SkipAuthorization", "AuthorizeAmount", "ReplayInSameInvocation"],
      ],
      ["Reentry", ["SettleClaim", "BridgeOut"]],
    ] as const) {
      expect(variants(fixtures, name), name).toEqual(expected);
      for (const variant of expected) expect(doc, `${name}::${variant}`).toContain(`\`${variant}`);
    }
    // Determinism is a documented property; the fixture must not consult ledger time or a PRNG.
    expect(fixtures).not.toMatch(/ledger\(\)|prng\(\)/);
    expect(read(join(repoRoot, "docs", "README.md"))).toContain("HOSTILE_FIXTURES.md");
  });

  it("keeps the boundary suite on the real router entry points and the shared rollback books", () => {
    const suite = read(join(sorobanRouterSrc, "test", "hostile_boundaries.rs"));
    const modules = read(join(sorobanRouterSrc, "test", "mod.rs"));
    expect(modules).toMatch(/^mod hostile;$/m);
    expect(modules).toMatch(/^mod hostile_boundaries;$/m);
    for (const call of ["try_bridge_out(", "try_deliver(", "try_settle_claim(", "set_auths(&[])"]) {
      expect(suite, call).toContain(call);
    }
    for (const field of ["treasury", "nonce", "dispatches", "flow", "claims", "outstanding"]) {
      expect(suite, field).toMatch(new RegExp(`^\\s*${field}: `, "m"));
    }
  });
});

describe("the stateful router reference model parity", () => {
  it("shares operation words across chains while conserving balances and fixed-recipient liabilities", () => {
    const root = resolve(evmRoot, "..");
    const rows = ["soroban", "evm"].map((chain) =>
      read(join(root, "testdata", `router-model-${chain}.csv`))
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.split(",").map(BigInt)),
    );
    expect(rows[0]!.length).toBe(64);
    expect(rows[1]!.map((row) => row[0])).toEqual(rows[0]!.map((row) => row[0]));
    const operations = new Set<bigint>();
    for (const chain of rows) {
      for (const row of chain) {
        expect(row.length).toBe(20);
        operations.add((row[0]! & 255n) % 10n);
        expect(row.slice(3, 9).reduce((sum, value) => sum + value, 0n)).toBe(20_000_000_000_000n);
        expect(row[18]! + row[19]!).toBe(row[6]);
        expect(row.slice(14, 18).every((value) => value >= 0n && value <= 1_000_000_000n)).toBe(
          true,
        );
      }
    }
    expect([...operations].sort()).toEqual([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
    // Step8 matures the Soroban proposal after3600seconds; EVM still requires2days.
    expect(rows[0]![8]![1]).toBe(1n);
    expect(rows[1]![8]![1]).toBe(0n);
    // The same outbound request retains Soroban decimal dust; EVM expands6→7decimals.
    expect(rows[0]![18]![3]).not.toBe(rows[1]![18]![3]);
  });
});

describe("the quote blockers", () => {
  it("matches the Solidity enum, in order", () => {
    // These travel in a struct an app reads over eth_call, so a reordering would relabel every
    // refusal on the screen.
    const members = solidityEnum(read(join(evmRoot, "src", "HyperionTypes.sol")), "QuoteBlocker");
    const mine = Object.entries(QuoteBlocker)
      .sort(([, a], [, b]) => a - b)
      .map(([name]) => name);
    expect(mine).toEqual(members);
  });
});

describe("the token registration diagnostics", () => {
  it("matches the Solidity enum, in order, with None first", () => {
    // These travel in a struct an app reads over `eth_call`, so a reordering would relabel every
    // finding on the screen while leaving the shape valid.
    const members = solidityEnum(
      read(join(evmRoot, "src", "HyperionTypes.sol")),
      "TokenMappingConflict",
    );
    const mine = Object.entries(TokenMappingConflict)
      .sort(([, a], [, b]) => a - b)
      .map(([name]) => name);
    expect(mine).toEqual(members);
  });

  it("has the same report fields, in the same order, as the Solidity struct", () => {
    // The report is read over `eth_call` and decoded by position, so a field added on one side
    // and not the other does not fail the call: it silently shifts every field after it, and an
    // app then renders one field's value under another field's name.
    const solidity = solidityStructFields(
      read(join(evmRoot, "src", "HyperionTypes.sol")),
      "TokenMappingReport",
    );
    const typescript = tsInterfaceFields(
      read(join(packageRoot, "src", "tokenMapping.ts")),
      "TokenMappingReport",
    );
    expect(typescript).toEqual(solidity);
  });

  it("matches the Soroban enum, minus the None the Rust side does not need", () => {
    // Soroban's `contracttype` needs no zero value, so its list starts at `TokenId`. Everything
    // after that has to line up, because an operator reads one diagnostic and a keeper reads the
    // other and they are describing the same fault.
    const variants = rustDataEnumVariants(read(join(coreSrc, "axelar.rs")), "TokenMappingConflict");
    const mine = Object.keys(TokenMappingConflict).filter((name) => name !== "None");
    expect(mine).toEqual(variants);
  });
});

describe("the constants both chains agree on", () => {
  it("has the same SEP-23 version bytes in the Rust", () => {
    const source = read(join(coreSrc, "codec.rs"));
    expect(source).toMatch(/VERSION_ACCOUNT[^=]*=\s*6\s*<<\s*3/);
    expect(source).toMatch(/VERSION_CONTRACT[^=]*=\s*2\s*<<\s*3/);
    expect(source).toMatch(/VERSION_MUXED[^=]*=\s*12\s*<<\s*3/);
  });

  it("has the same CCTP offsets and constants in the Rust", () => {
    const source = read(join(coreSrc, "cctp.rs"));
    const expectConst = (name: string, value: number): void => {
      const match = new RegExp(`${name}\\s*:\\s*[a-z0-9]+\\s*=\\s*(\\d+)`).exec(source);
      expect(match, `${name} not found in cctp.rs`).not.toBeNull();
      expect(Number(match?.[1])).toBe(value);
    };
    expectConst("STELLAR_DOMAIN", STELLAR_DOMAIN);
    expectConst("MESSAGE_VERSION", MESSAGE_VERSION);
    expectConst("BURN_MESSAGE_VERSION", BURN_MESSAGE_VERSION);
    expectConst("FINALITY_THRESHOLD_FINALIZED", FINALITY_THRESHOLD_FINALIZED);
    expectConst("HOOK_VERSION", HOOK_VERSION);
    expectConst("MSG_BODY", 148);
    expectConst("BURN_HOOK_DATA", 228);
  });

  it("registers the same CCTP and note offsets as the Rust, field for field", () => {
    // The compatibility report is only as good as the registry it compares, so the registry's
    // offsets are pinned to the Rust constants rather than to the TypeScript parsers alone.
    const cctp = read(join(coreSrc, "cctp.rs"));
    const axelar = read(join(coreSrc, "axelar.rs"));
    const rustConst = (source: string, name: string): number => {
      const match = new RegExp(`const ${name}\\s*:\\s*[a-z0-9]+\\s*=\\s*(\\d+)`).exec(source);
      expect(match, `${name} not found`).not.toBeNull();
      return Number(match?.[1]);
    };
    const offsets = (id: string): Record<string, number> => {
      const schema = WIRE_SCHEMAS.schemas.find((s) => s.id === id);
      if (schema?.kind !== "message") throw new Error(`no ${id} schema`);
      return Object.fromEntries(
        schema.fields.flatMap((f) => (typeof f.offset === "number" ? [[f.name, f.offset]] : [])),
      );
    };
    const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
    const header = offsets("cctp.header");
    const headerNames: Record<string, string> = {
      minFinalityThreshold: "MIN_FINALITY",
      finalityThresholdExecuted: "FINALITY_EXECUTED",
    };
    for (const [name, offset] of Object.entries(header)) {
      expect(offset, name).toBe(rustConst(cctp, `MSG_${headerNames[name] ?? snake(name)}`));
    }
    const burnNames: Record<string, string> = { burnToken: "TOKEN", hookData: "HOOK_DATA" };
    for (const [name, offset] of Object.entries(offsets("cctp.burn"))) {
      expect(offset, name).toBe(rustConst(cctp, `BURN_${burnNames[name] ?? snake(name)}`));
    }
    const outbound = WIRE_SCHEMAS.schemas.find((s) => s.id === "note.outbound");
    expect(outbound?.kind === "message" ? outbound.size : null).toEqual({
      kind: "fixed",
      bytes: rustConst(axelar, "OUTBOUND_NOTE_LEN"),
    });
  });

  it("has the same note layout in the Rust", () => {
    const source = read(join(coreSrc, "axelar.rs"));
    expect(source).toMatch(new RegExp(`NOTE_VERSION\\s*:\\s*u8\\s*=\\s*${String(NOTE_VERSION)}`));
    expect(source).toMatch(
      new RegExp(`OUTBOUND_NOTE_LEN\\s*:\\s*u32\\s*=\\s*${String(OUTBOUND_NOTE_LEN)}`),
    );
  });

  it("has the same fee and decimal ceilings in the Solidity", () => {
    const source = read(join(evmRoot, "src", "libraries", "AmountMath.sol"));
    expect(source).toMatch(new RegExp(`MAX_DECIMALS\\s*=\\s*${String(MAX_DECIMALS)}`));
    expect(source).toMatch(new RegExp(`MAX_FEE_BPS\\s*=\\s*${String(MAX_FEE_BPS)}`));
    expect(source).toMatch(/BPS_DENOMINATOR\s*=\s*10_?000/);
  });

  it("has the same ceilings in the Rust", () => {
    // `MAX_DECIMALS` lives with the arithmetic; the fee cap and the basis point denominator sit
    // in the crate root, because the router needs them and the amount module only enforces them.
    expect(read(join(coreSrc, "amount.rs"))).toMatch(
      new RegExp(`pub const MAX_DECIMALS\\s*:\\s*u32\\s*=\\s*${String(MAX_DECIMALS)}`),
    );
    const root = read(join(coreSrc, "lib.rs"));
    expect(root).toMatch(
      new RegExp(`pub const MAX_FEE_BPS\\s*:\\s*u32\\s*=\\s*${String(MAX_FEE_BPS)}`),
    );
    expect(root).toMatch(/pub const BPS_DENOMINATOR\s*:\s*i128\s*=\s*10_?000/);
  });
});

describe("the generated ABI modules", () => {
  it("is exactly what the generator produces right now", () => {
    // Regenerate and compare, rather than trusting that somebody ran it. Editing a generated
    // file by hand, or changing a contract and forgetting, both land here.
    const before = snapshotAbiDir();
    execFileSync(process.execPath, [join(packageRoot, "scripts", "gen-artifacts.mjs")], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    expect(snapshotAbiDir()).toEqual(before);
  });

  it("exports an ABI for every contract the app has to talk to", () => {
    const abiDir = join(packageRoot, "src", "abi");
    for (const name of [
      "router",
      "cctpAdapter",
      "axelarItsAdapter",
      "railAdapter",
      "erc20",
      "errors",
    ]) {
      expect(existsSync(join(abiDir, `${name}.ts`))).toBe(true);
    }
  });
});

function snapshotAbiDir(): Record<string, string> {
  const abiDir = join(packageRoot, "src", "abi");
  const out: Record<string, string> = {};
  for (const name of readdirSync(abiDir).sort()) {
    if (name.endsWith(".ts")) out[name] = read(join(abiDir, name));
  }
  return out;
}
