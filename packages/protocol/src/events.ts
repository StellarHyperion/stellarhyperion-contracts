/**
 * Version-aware raw contract-event and provider-status inspectors.
 *
 * Indexers, support CLIs, and browser evidence drawers all need to inspect raw Soroban and EVM
 * router event payloads without pulling in a database layer or losing precision on 64-bit nonces
 * and 128/256-bit token amounts. Crucially, external rail status updates (Circle attestation
 * ready, Axelar GMP relayed, Allbridge inflight) are observations from an upstream transport and
 * never constitute proof that the destination Hyperion router paid the recipient.
 */
import { AddressKind, tryParseStellarAddress } from "./addresses.js";
import type { Hex } from "./bytes.js";
import { fromHex, toHex } from "./bytes.js";
import type { RouteKind } from "./routes.js";
import { ROUTE_KINDS, tryRouteFromSlug } from "./routes.js";

/** Supported schema version for raw router event envelopes. */
export const ROUTER_EVENT_SCHEMA_VERSION = 1;

const MAX_U64 = (1n << 64n) - 1n;
const MAX_I128_NON_NEGATIVE = (1n << 127n) - 1n;
const MAX_U256 = (1n << 256n) - 1n;
const DECIMAL_INT_PATTERN = /^\d+$/;
const HEX_INT_PATTERN = /^0x[0-9a-fA-F]+$/;
const BYTES32_HEX_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export type RouterEventChainFamily = "soroban" | "evm";

export type RouterSettlementStage =
  | "dispatched_outbound"
  | "parked_claim"
  | "settled_payout"
  | "governance_notice"
  | "provider_observation";

export type ProviderObservationState =
  "pending" | "attested" | "inflight" | "relayed" | "executed_at_gateway" | "failed" | "unknown";

const VALID_PROVIDER_STATES: ReadonlySet<string> = new Set<ProviderObservationState>([
  "pending",
  "attested",
  "inflight",
  "relayed",
  "executed_at_gateway",
  "failed",
  "unknown",
]);

/** Raised when a raw router event or provider notice fails schema, version, or width validation. */
export class RouterEventFormatError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`invalid router event at ${path}: ${reason}`);
    this.name = "RouterEventFormatError";
  }
}

function failEvent(path: string, reason: string): never {
  throw new RouterEventFormatError(path, reason);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failEvent(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function readSchemaVersion(obj: Record<string, unknown>, path: string): 1 {
  const raw = obj.schemaVersion;
  if (raw === undefined) {
    failEvent(`${path}.schemaVersion`, "missing required schemaVersion");
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    failEvent(`${path}.schemaVersion`, "schemaVersion must be an integer");
  }
  if (raw !== ROUTER_EVENT_SCHEMA_VERSION) {
    failEvent(
      `${path}.schemaVersion`,
      `unsupported router event schemaVersion ${String(raw)}; expected ${String(ROUTER_EVENT_SCHEMA_VERSION)}`,
    );
  }
  return ROUTER_EVENT_SCHEMA_VERSION;
}

function readFamily(obj: Record<string, unknown>, path: string): RouterEventChainFamily {
  const raw = obj.family;
  if (raw === "soroban" || raw === "evm") return raw;
  failEvent(`${path}.family`, 'expected family "soroban" or "evm"');
}

function readNonEmptyString(obj: Record<string, unknown>, key: string, path: string): string {
  const val = obj[key];
  if (typeof val !== "string" || val.trim().length === 0) {
    failEvent(`${path}.${key}`, "expected a non-empty string");
  }
  return val;
}

function readBool(obj: Record<string, unknown>, key: string, path: string): boolean {
  const val = obj[key];
  if (typeof val !== "boolean") {
    failEvent(`${path}.${key}`, "expected a boolean");
  }
  return val;
}

function parseWideUint(value: unknown, max: bigint, path: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      failEvent(
        path,
        "numeric input must be a non-negative safe integer; pass bigint or decimal string for wide values",
      );
    }
    parsed = BigInt(value);
  } else if (typeof value === "string") {
    if (DECIMAL_INT_PATTERN.test(value) || HEX_INT_PATTERN.test(value)) {
      parsed = BigInt(value);
    } else {
      failEvent(path, "expected an unsigned decimal or 0x-hex integer string");
    }
  } else {
    failEvent(path, "expected a bigint, safe integer, or integer string");
  }

  if (parsed < 0n || parsed > max) {
    failEvent(path, `integer out of range 0..${max.toString()}`);
  }
  return parsed;
}

function readU64(obj: Record<string, unknown>, key: string, path: string): bigint {
  return parseWideUint(obj[key], MAX_U64, `${path}.${key}`);
}

function readAmount(
  obj: Record<string, unknown>,
  key: string,
  family: RouterEventChainFamily,
  path: string,
): bigint {
  const ceiling = family === "soroban" ? MAX_I128_NON_NEGATIVE : MAX_U256;
  return parseWideUint(obj[key], ceiling, `${path}.${key}`);
}

function readRoute(obj: Record<string, unknown>, key: string, path: string): RouteKind {
  const raw = obj[key];
  if (typeof raw === "number" && Number.isInteger(raw)) {
    const candidate = raw as RouteKind;
    if (ROUTE_KINDS.includes(candidate)) return candidate;
    failEvent(`${path}.${key}`, `unknown RouteKind tag ${String(raw)}`);
  }
  if (typeof raw === "string") {
    const bySlug = tryRouteFromSlug(raw);
    if (bySlug !== null) return bySlug;
    failEvent(`${path}.${key}`, `unknown route slug "${raw}"`);
  }
  failEvent(`${path}.${key}`, "expected a RouteKind tag (0..3) or canonical route slug");
}

function readBytes32Hex(value: unknown, path: string): Hex {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) {
      failEvent(path, `expected 32 bytes, got ${String(value.length)}`);
    }
    return toHex(value);
  }
  if (typeof value === "string" && BYTES32_HEX_PATTERN.test(value)) {
    return value.toLowerCase() as Hex;
  }
  failEvent(path, "expected a 32-byte 0x-prefixed hex value or 32-byte Uint8Array");
}

function readOptionalBytes32Hex(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): Hex | null {
  const raw = obj[key];
  if (raw === undefined || raw === null) return null;
  return readBytes32Hex(raw, `${path}.${key}`);
}

function readAddressForFamily(
  obj: Record<string, unknown>,
  key: string,
  family: RouterEventChainFamily,
  requireContractOnSoroban: boolean,
  path: string,
): string {
  const val = readNonEmptyString(obj, key, path);
  if (family === "evm") {
    if (!EVM_ADDRESS_PATTERN.test(val)) {
      failEvent(`${path}.${key}`, "expected a 20-byte 0x-prefixed EVM address");
    }
    return val.toLowerCase();
  }
  const parsed = tryParseStellarAddress(val);
  if (!parsed.ok) {
    failEvent(`${path}.${key}`, `invalid Stellar strkey (${parsed.reason})`);
  }
  if (requireContractOnSoroban && parsed.parts.kind !== AddressKind.Contract) {
    failEvent(`${path}.${key}`, "expected a Stellar C-contract strkey");
  }
  return val;
}

function decodeSorobanDestinationWord(wordHex: Hex): string {
  const raw = fromHex(wordHex);
  let leadingZeros = true;
  for (let i = 0; i < 12; i++) {
    if (raw[i] !== 0) {
      leadingZeros = false;
      break;
    }
  }
  if (leadingZeros) {
    return toHex(raw.subarray(12, 32));
  }
  return wordHex;
}

/** Exact outbound amount breakdown carried by `BridgeOut`. */
export interface BridgeOutAmounts {
  readonly grossAmount: bigint;
  readonly fee: bigint;
  readonly netAmount: bigint;
}

/** Cross-chain message and transfer correlation identity for `BridgeOut`. */
export interface BridgeOutMessageIdentity {
  readonly nonce: bigint;
  readonly destinationChain: string;
  readonly destinationRecipient: string;
  readonly destinationWord: Hex | null;
  readonly railRef: Hex | null;
}

/** Cross-chain message and replay identity for `BridgeIn`. */
export interface BridgeInMessageIdentity {
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  readonly messageId: Hex | null;
  readonly claimId: bigint | null;
}

export interface InspectedBridgeOutEvent {
  readonly schemaVersion: 1;
  readonly family: RouterEventChainFamily;
  readonly kind: "BridgeOut";
  readonly route: RouteKind;
  readonly sender: string;
  readonly token: string;
  readonly amounts: BridgeOutAmounts;
  readonly identity: BridgeOutMessageIdentity;
  readonly settlementStage: "dispatched_outbound";
  readonly payoutProven: false;
}

export interface InspectedBridgeInSettledEvent {
  readonly schemaVersion: 1;
  readonly family: RouterEventChainFamily;
  readonly kind: "BridgeIn";
  readonly route: RouteKind;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly delivered: true;
  readonly identity: BridgeInMessageIdentity;
  readonly settlementStage: "settled_payout";
  readonly payoutProven: true;
}

export interface InspectedBridgeInParkedEvent {
  readonly schemaVersion: 1;
  readonly family: "soroban";
  readonly kind: "BridgeIn";
  readonly route: RouteKind;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly delivered: false;
  readonly identity: BridgeInMessageIdentity;
  readonly settlementStage: "parked_claim";
  readonly payoutProven: false;
}

export type InspectedBridgeInEvent = InspectedBridgeInSettledEvent | InspectedBridgeInParkedEvent;

export interface InspectedClaimParkedEvent {
  readonly schemaVersion: 1;
  readonly family: RouterEventChainFamily;
  readonly kind: "ClaimParked";
  readonly claimId: bigint;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly route: RouteKind;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  readonly settlementStage: "parked_claim";
  readonly payoutProven: false;
}

export interface InspectedClaimSettledEvent {
  readonly schemaVersion: 1;
  readonly family: RouterEventChainFamily;
  readonly kind: "ClaimSettled";
  readonly claimId: bigint;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly settledBy: string;
  readonly settlementStage: "settled_payout";
  readonly payoutProven: true;
}

export interface InspectedPauseSetEvent {
  readonly schemaVersion: 1;
  readonly family: RouterEventChainFamily;
  readonly kind: "PauseSet";
  readonly paused: boolean;
  readonly actor: string;
  readonly settlementStage: "governance_notice";
  readonly payoutProven: false;
}

export interface InspectedTimelockEvent {
  readonly schemaVersion: 1;
  readonly family: RouterEventChainFamily;
  readonly kind: "ActionQueued" | "ActionExecuted" | "ActionCancelled";
  readonly actionId: bigint;
  readonly eta: bigint | null;
  readonly expiresAt: bigint | null;
  readonly settlementStage: "governance_notice";
  readonly payoutProven: false;
}

/**
 * Decoded upstream rail/provider observation.
 *
 * Carries `payoutProven: false` unconditionally: an attested CCTP burn or relayed Axelar call
 * never proves that the destination Hyperion router transferred funds to the recipient.
 */
export interface InspectedProviderStatusNotice {
  readonly schemaVersion: 1;
  readonly kind: "ProviderStatus";
  readonly route: RouteKind;
  readonly providerStatus: ProviderObservationState;
  readonly sourceChain: string | null;
  readonly sourceNonce: bigint | null;
  readonly messageId: Hex | null;
  readonly observedAmount: bigint | null;
  readonly settlementStage: "provider_observation";
  readonly evidenceClass: "provider_status_not_payout_proof";
  readonly payoutProven: false;
}

export type InspectedRouterEvent =
  | InspectedBridgeOutEvent
  | InspectedBridgeInEvent
  | InspectedClaimParkedEvent
  | InspectedClaimSettledEvent
  | InspectedPauseSetEvent
  | InspectedTimelockEvent;

export type InspectedTransferEvidence = InspectedRouterEvent | InspectedProviderStatusNotice;

function inspectBridgeOutRecord(
  obj: Record<string, unknown>,
  family: RouterEventChainFamily,
  path: string,
): InspectedBridgeOutEvent {
  const route = readRoute(obj, "route", path);
  const sender = readAddressForFamily(obj, "sender", family, false, path);
  const token = readAddressForFamily(obj, "token", family, true, path);
  const nonce = readU64(obj, "nonce", path);
  const grossAmount = readAmount(obj, "grossAmount", family, path);
  const fee = readAmount(obj, "fee", family, path);
  const netAmount = readAmount(obj, "netAmount", family, path);

  if (grossAmount !== netAmount + fee) {
    failEvent(
      `${path}.grossAmount`,
      `grossAmount (${grossAmount.toString()}) must equal netAmount (${netAmount.toString()}) + fee (${fee.toString()})`,
    );
  }
  if (netAmount === 0n) {
    failEvent(`${path}.netAmount`, "BridgeOut netAmount must be strictly positive");
  }

  const destinationChain = readNonEmptyString(obj, "destinationChain", path);
  let destinationRecipient: string;
  let destinationWord: Hex | null = null;

  if (family === "soroban") {
    destinationWord = readBytes32Hex(obj.destination, `${path}.destination`);
    destinationRecipient = decodeSorobanDestinationWord(destinationWord);
  } else {
    destinationRecipient = readNonEmptyString(obj, "destinationAddress", path);
    const parsedRecipient = tryParseStellarAddress(destinationRecipient);
    if (!parsedRecipient.ok) {
      failEvent(
        `${path}.destinationAddress`,
        `invalid Stellar destinationAddress (${parsedRecipient.reason})`,
      );
    }
  }

  const railRef = readOptionalBytes32Hex(obj, "railRef", path);

  return {
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    family,
    kind: "BridgeOut",
    route,
    sender,
    token,
    amounts: {
      grossAmount,
      fee,
      netAmount,
    },
    identity: {
      nonce,
      destinationChain,
      destinationRecipient,
      destinationWord,
      railRef,
    },
    settlementStage: "dispatched_outbound",
    payoutProven: false,
  };
}

function inspectBridgeInRecord(
  obj: Record<string, unknown>,
  family: RouterEventChainFamily,
  path: string,
): InspectedBridgeInEvent {
  const route = readRoute(obj, "route", path);
  const recipient = readAddressForFamily(obj, "recipient", family, false, path);
  const token = readAddressForFamily(obj, "token", family, true, path);
  const amount = readAmount(obj, "amount", family, path);
  if (amount === 0n) {
    failEvent(`${path}.amount`, "BridgeIn amount must be strictly positive");
  }
  const sourceChain = readNonEmptyString(obj, "sourceChain", path);
  const sourceNonce = readU64(obj, "sourceNonce", path);

  if (family === "evm") {
    const messageId = readBytes32Hex(obj.messageId, `${path}.messageId`);
    return {
      schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
      family: "evm",
      kind: "BridgeIn",
      route,
      recipient,
      token,
      amount,
      delivered: true,
      identity: {
        sourceChain,
        sourceNonce,
        messageId,
        claimId: null,
      },
      settlementStage: "settled_payout",
      payoutProven: true,
    };
  }

  const delivered = readBool(obj, "delivered", path);
  const claimId =
    obj.claimId === undefined || obj.claimId === null ? 0n : readU64(obj, "claimId", path);
  const messageId = readOptionalBytes32Hex(obj, "messageId", path);

  if (delivered) {
    return {
      schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
      family: "soroban",
      kind: "BridgeIn",
      route,
      recipient,
      token,
      amount,
      delivered: true,
      identity: {
        sourceChain,
        sourceNonce,
        messageId,
        claimId,
      },
      settlementStage: "settled_payout",
      payoutProven: true,
    };
  }

  return {
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    family: "soroban",
    kind: "BridgeIn",
    route,
    recipient,
    token,
    amount,
    delivered: false,
    identity: {
      sourceChain,
      sourceNonce,
      messageId,
      claimId,
    },
    settlementStage: "parked_claim",
    payoutProven: false,
  };
}

function inspectClaimParkedRecord(
  obj: Record<string, unknown>,
  family: RouterEventChainFamily,
  path: string,
): InspectedClaimParkedEvent {
  const claimId = readU64(obj, "claimId", path);
  const recipient = readAddressForFamily(obj, "recipient", family, false, path);
  const token = readAddressForFamily(obj, "token", family, true, path);
  const amount = readAmount(obj, "amount", family, path);
  if (amount === 0n) {
    failEvent(`${path}.amount`, "ClaimParked amount must be strictly positive");
  }
  const route = readRoute(obj, "route", path);
  const sourceChain = readNonEmptyString(obj, "sourceChain", path);
  const sourceNonce = readU64(obj, "sourceNonce", path);

  return {
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    family,
    kind: "ClaimParked",
    claimId,
    recipient,
    token,
    amount,
    route,
    sourceChain,
    sourceNonce,
    settlementStage: "parked_claim",
    payoutProven: false,
  };
}

function inspectClaimSettledRecord(
  obj: Record<string, unknown>,
  family: RouterEventChainFamily,
  path: string,
): InspectedClaimSettledEvent {
  const claimId = readU64(obj, "claimId", path);
  const recipient = readAddressForFamily(obj, "recipient", family, false, path);
  const token = readAddressForFamily(obj, "token", family, true, path);
  const amount = readAmount(obj, "amount", family, path);
  if (amount === 0n) {
    failEvent(`${path}.amount`, "ClaimSettled amount must be strictly positive");
  }
  const settledBy = readAddressForFamily(obj, "settledBy", family, false, path);

  return {
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    family,
    kind: "ClaimSettled",
    claimId,
    recipient,
    token,
    amount,
    settledBy,
    settlementStage: "settled_payout",
    payoutProven: true,
  };
}

function inspectPauseSetRecord(
  obj: Record<string, unknown>,
  family: RouterEventChainFamily,
  path: string,
): InspectedPauseSetEvent {
  const paused = readBool(obj, "paused", path);
  const actor = readAddressForFamily(obj, "actor", family, false, path);
  return {
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    family,
    kind: "PauseSet",
    paused,
    actor,
    settlementStage: "governance_notice",
    payoutProven: false,
  };
}

function inspectTimelockRecord(
  obj: Record<string, unknown>,
  family: RouterEventChainFamily,
  kind: "ActionQueued" | "ActionExecuted" | "ActionCancelled",
  path: string,
): InspectedTimelockEvent {
  const actionId = readU64(obj, "actionId", path);
  let eta: bigint | null = null;
  let expiresAt: bigint | null = null;

  if (kind === "ActionQueued") {
    eta = readU64(obj, "eta", path);
    expiresAt = readU64(obj, "expiresAt", path);
    if (expiresAt <= eta) {
      failEvent(`${path}.expiresAt`, "ActionQueued expiresAt must be strictly greater than eta");
    }
  }

  return {
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    family,
    kind,
    actionId,
    eta,
    expiresAt,
    settlementStage: "governance_notice",
    payoutProven: false,
  };
}

/**
 * Inspect and validate a raw Soroban or EVM router event envelope.
 *
 * Rejects unsupported `schemaVersion` values, unsafe JavaScript numbers, malformed addresses,
 * and broken outbound accounting (`grossAmount !== netAmount + fee`). Rejects `"ProviderStatus"`
 * payloads directly so upstream rail statuses can never slip through a router-event path; use
 * `inspectProviderStatusNotice` or `inspectTransferEvidence` when handling provider notices.
 */
export function inspectRouterEvent(value: unknown): InspectedRouterEvent {
  const obj = asRecord(value, "$");
  readSchemaVersion(obj, "$");
  const kind = obj.kind;
  if (typeof kind !== "string") {
    failEvent("$.kind", "expected event kind string");
  }
  if (kind === "ProviderStatus") {
    failEvent(
      "$.kind",
      "ProviderStatus is an upstream rail observation, not a router contract event; call inspectProviderStatusNotice or inspectTransferEvidence",
    );
  }
  const family = readFamily(obj, "$");
  const payload = obj.payload !== undefined ? asRecord(obj.payload, "$.payload") : obj;
  const payloadPath = obj.payload !== undefined ? "$.payload" : "$";

  switch (kind) {
    case "BridgeOut":
      return inspectBridgeOutRecord(payload, family, payloadPath);
    case "BridgeIn":
      return inspectBridgeInRecord(payload, family, payloadPath);
    case "ClaimParked":
      return inspectClaimParkedRecord(payload, family, payloadPath);
    case "ClaimSettled":
      return inspectClaimSettledRecord(payload, family, payloadPath);
    case "PauseSet":
      return inspectPauseSetRecord(payload, family, payloadPath);
    case "ActionQueued":
    case "ActionExecuted":
    case "ActionCancelled":
      return inspectTimelockRecord(payload, family, kind, payloadPath);
    default:
      failEvent("$.kind", `unsupported router event kind "${kind}"`);
  }
}

/**
 * Inspect a provider/rail status notice (CCTP attestation, Axelar GMP relay, Allbridge status).
 *
 * Always marks `payoutProven: false` and rejects any payload that attempts to assert
 * `payoutProven: true`, ensuring upstream transport status is never mislabeled as destination
 * payout proof.
 */
export function inspectProviderStatusNotice(value: unknown): InspectedProviderStatusNotice {
  const obj = asRecord(value, "$");
  readSchemaVersion(obj, "$");
  if (obj.kind !== "ProviderStatus") {
    failEvent("$.kind", 'expected kind "ProviderStatus"');
  }
  if (obj.payoutProven === true) {
    failEvent(
      "$.payoutProven",
      "provider status observations cannot assert payoutProven=true; only settled destination router events prove payout",
    );
  }
  const route = readRoute(obj, "route", "$");
  const statusRaw = readNonEmptyString(obj, "providerStatus", "$");
  if (!VALID_PROVIDER_STATES.has(statusRaw)) {
    failEvent("$.providerStatus", `unknown providerStatus "${statusRaw}"`);
  }
  const sourceChain =
    obj.sourceChain === undefined || obj.sourceChain === null
      ? null
      : readNonEmptyString(obj, "sourceChain", "$");
  const sourceNonce =
    obj.sourceNonce === undefined || obj.sourceNonce === null
      ? null
      : readU64(obj, "sourceNonce", "$");
  const messageId = readOptionalBytes32Hex(obj, "messageId", "$");
  const observedAmount =
    obj.observedAmount === undefined || obj.observedAmount === null
      ? null
      : parseWideUint(obj.observedAmount, MAX_U256, "$.observedAmount");

  return {
    schemaVersion: ROUTER_EVENT_SCHEMA_VERSION,
    kind: "ProviderStatus",
    route,
    providerStatus: statusRaw as ProviderObservationState,
    sourceChain,
    sourceNonce,
    messageId,
    observedAmount,
    settlementStage: "provider_observation",
    evidenceClass: "provider_status_not_payout_proof",
    payoutProven: false,
  };
}

/**
 * Unified entry point that inspects either a router contract event or a provider status notice,
 * keeping `payoutProven` strictly gated to settled destination router deliveries.
 */
export function inspectTransferEvidence(value: unknown): InspectedTransferEvidence {
  const obj = asRecord(value, "$");
  if (obj.kind === "ProviderStatus") {
    return inspectProviderStatusNotice(obj);
  }
  return inspectRouterEvent(obj);
}

/** Type guard narrowing evidence to events that prove funds reached the destination recipient. */
export function isPayoutProofEvent(
  evidence: InspectedTransferEvidence,
): evidence is InspectedBridgeInSettledEvent | InspectedClaimSettledEvent {
  return evidence.payoutProven;
}

/** Non-throwing companion to `inspectTransferEvidence`. */
export function tryInspectTransferEvidence(
  value: unknown,
):
  { ok: true; evidence: InspectedTransferEvidence } | { ok: false; error: RouterEventFormatError } {
  try {
    return { ok: true, evidence: inspectTransferEvidence(value) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RouterEventFormatError
          ? error
          : new RouterEventFormatError(
              "$",
              error instanceof Error ? error.message : "invalid router event",
            ),
    };
  }
}
