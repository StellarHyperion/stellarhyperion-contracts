/**
 * Semantic ABI compatibility policy, diffing and provenance verification.
 *
 * Raw four byte selectors only see canonical Solidity types (`address`, `uint256`, `tuple`), which
 * means two payout critical fields of the same primitive type can swap positions or disappear from
 * an unindexed event log without changing a selector a caller already hardcoded. Worse, flipping
 * `indexed` on an event parameter leaves `topic0` untouched while moving the value between topics
 * and ABI encoded log data, silently scrambling off chain reconciliation.
 *
 * This module compares previous and proposed contract ABIs structurally across function signatures,
 * tuple component layouts, state mutability, return schemas, event schemas and custom errors, and
 * enforces an explicit compatibility policy with mandatory consumer migration assessments for
 * additive changes.
 */

export type AbiEntryKind = "constructor" | "receive" | "fallback" | "function" | "event" | "error";

export type AbiStateMutability = "pure" | "view" | "nonpayable" | "payable";

export interface AbiParameter {
  readonly name?: string | undefined;
  readonly type: string;
  readonly internalType?: string | undefined;
  readonly indexed?: boolean | undefined;
  readonly components?: readonly AbiParameter[] | undefined;
}

export interface AbiEntry {
  readonly type: AbiEntryKind;
  readonly name?: string | undefined;
  readonly inputs?: readonly AbiParameter[] | undefined;
  readonly outputs?: readonly AbiParameter[] | undefined;
  readonly stateMutability?: AbiStateMutability | undefined;
  readonly anonymous?: boolean | undefined;
}

export type ConsumerSurface = "sdk" | "indexer" | "keeper" | "relayer" | "ui" | "contracts";

export interface ConsumerMigrationAssessment {
  readonly changeId: string;
  readonly summary: string;
  readonly consumerSurfaces: readonly ConsumerSurface[];
  readonly backwardCompatible: boolean;
  readonly migrationSteps: readonly string[];
}

export interface AbiCompatibilityPolicy {
  readonly payoutFunctions: readonly string[];
  readonly payoutEvents: readonly string[];
  readonly payoutStructInternalTypes: readonly string[];
  readonly requireMigrationAssessmentForAdditive: boolean;
}

export type AbiChangeClassification = "breaking" | "additive";

export type AbiChangeCode =
  | "removed-entry"
  | "added-entry"
  | "state-mutability-incompatible"
  | "output-count-changed"
  | "output-type-changed"
  | "parameter-type-changed"
  | "tuple-field-removed"
  | "tuple-field-added"
  | "tuple-fields-reordered"
  | "payout-field-renamed"
  | "payout-fields-reordered"
  | "event-anonymous-changed"
  | "event-indexed-changed"
  | "event-field-removed"
  | "event-field-added"
  | "event-field-type-changed"
  | "unassessed-additive-change"
  | "provenance-mismatch";

export interface AbiSemanticChange {
  readonly changeId: string;
  readonly contract: string;
  readonly classification: AbiChangeClassification;
  readonly code: AbiChangeCode;
  readonly entryKind: AbiEntryKind;
  readonly signature: string;
  readonly payoutRelevant: boolean;
  readonly path: string;
  readonly detail: string;
  readonly migrationAssessment?: ConsumerMigrationAssessment | undefined;
}

export type AbiGateVerdict = "identical" | "compatible-with-migration" | "breaking";

export interface AbiProvenanceRecord {
  readonly contract: string;
  readonly artifactFile: string;
  readonly moduleName: string;
  readonly symbolName: string;
  readonly hasConcreteBytecode: boolean;
  readonly compilerVersion?: string | undefined;
  readonly compiledAbi: readonly AbiEntry[];
  readonly exportedAbi: readonly AbiEntry[];
}

export interface AbiProvenanceCheckResult {
  readonly verified: boolean;
  readonly issues: readonly AbiSemanticChange[];
}

export interface AbiCompatibilityReport {
  readonly verdict: AbiGateVerdict;
  readonly passed: boolean;
  readonly provenanceVerified: boolean;
  readonly breakingChanges: readonly AbiSemanticChange[];
  readonly additiveChanges: readonly AbiSemanticChange[];
  readonly unassessedAdditiveChanges: readonly AbiSemanticChange[];
  readonly provenanceIssues: readonly AbiSemanticChange[];
}

/**
 * Default Hyperion ABI compatibility policy.
 *
 * Every entrypoint, struct and event that determines token identity, exact integer amounts,
 * recipient binding, replay message identity or parked claim settlement is marked payout relevant
 * so field removals, field reorderings and same type parameter swaps fail the gate immediately.
 */
export const DEFAULT_ABI_COMPATIBILITY_POLICY: AbiCompatibilityPolicy = {
  payoutFunctions: [
    "bridgeOut",
    "bridgeIn",
    "settleClaim",
    "pendingClaim",
    "quote",
    "quoteAll",
    "dispatch",
    "receiveMessage",
    "execute",
    "executeWithToken",
    "topUpGas",
  ],
  payoutEvents: [
    "BridgeOut",
    "BridgeIn",
    "ClaimParked",
    "ClaimSettled",
    "Dispatched",
    "InboundDelivered",
    "MessageReceived",
    "GasToppedUp",
  ],
  payoutStructInternalTypes: [
    "struct OutboundRequest",
    "struct Destination",
    "struct Origin",
    "struct PendingClaim",
    "struct RouteQuote",
    "struct TokenConfig",
    "struct AdminAction",
    "struct QueuedAction",
  ],
  requireMigrationAssessmentForAdditive: true,
};

/** Canonical Solidity parameter type, expanding tuple components recursively. */
export function canonicalParameterType(param: AbiParameter): string {
  if (param.type.startsWith("tuple")) {
    const suffix = param.type.slice("tuple".length);
    const inner = (param.components ?? []).map(canonicalParameterType).join(",");
    return `(${inner})${suffix}`;
  }
  return param.type;
}

/** Canonical ABI entry signature matching Solidity selector input formatting. */
export function canonicalEntrySignature(entry: AbiEntry): string {
  if (entry.type === "receive" || entry.type === "fallback") {
    return `${entry.type}()`;
  }
  const name = entry.name ?? entry.type;
  const inputs = (entry.inputs ?? []).map(canonicalParameterType).join(",");
  return `${name}(${inputs})`;
}

/** Stable sort matching `scripts/gen-artifacts.mjs` so provenance comparisons are deterministic. */
export function canonicaliseAbi(abi: readonly AbiEntry[]): AbiEntry[] {
  const kindRank: Record<AbiEntryKind, number> = {
    constructor: 0,
    receive: 1,
    fallback: 2,
    function: 3,
    event: 4,
    error: 5,
  };
  return [...abi].sort((a, b) => {
    const byKind = kindRank[a.type] - kindRank[b.type];
    if (byKind !== 0) return byKind;
    return canonicalEntrySignature(a).localeCompare(canonicalEntrySignature(b));
  });
}

function stripStructArraySuffix(internalType: string | undefined): string {
  if (internalType === undefined) return "";
  return internalType.replace(/(\[[0-9]*\])+$/u, "").trim();
}

function parameterTouchesPayoutStruct(
  param: AbiParameter,
  payoutStructs: ReadonlySet<string>,
): boolean {
  const baseInternal = stripStructArraySuffix(param.internalType);
  if (baseInternal.length > 0 && payoutStructs.has(baseInternal)) {
    return true;
  }
  for (const child of param.components ?? []) {
    if (parameterTouchesPayoutStruct(child, payoutStructs)) {
      return true;
    }
  }
  return false;
}

/** Determine whether an ABI entry affects token movement, recipient binding, pricing or claims. */
export function isPayoutRelevantEntry(
  entry: AbiEntry,
  policy: AbiCompatibilityPolicy = DEFAULT_ABI_COMPATIBILITY_POLICY,
): boolean {
  const fnSet = new Set(policy.payoutFunctions);
  const eventSet = new Set(policy.payoutEvents);
  const structSet = new Set(policy.payoutStructInternalTypes);

  if (entry.type === "function" && entry.name !== undefined && fnSet.has(entry.name)) {
    return true;
  }
  if (entry.type === "event" && entry.name !== undefined && eventSet.has(entry.name)) {
    return true;
  }
  for (const input of entry.inputs ?? []) {
    if (parameterTouchesPayoutStruct(input, structSet)) return true;
  }
  for (const output of entry.outputs ?? []) {
    if (parameterTouchesPayoutStruct(output, structSet)) return true;
  }
  return false;
}

function isMutabilityUpgradeCompatible(
  previous: AbiStateMutability | undefined,
  proposed: AbiStateMutability | undefined,
): boolean {
  const prev = previous ?? "nonpayable";
  const next = proposed ?? "nonpayable";
  if (prev === next) return true;
  // A nonpayable function becoming view/pure or pure becoming view does not break existing callers,
  // whereas view -> nonpayable breaks staticcall consumers and payable -> nonpayable breaks ETH
  // value forwarding on rails that collect native gas.
  if (prev === "nonpayable" && (next === "view" || next === "pure")) return true;
  if (prev === "view" && next === "pure") return true;
  return false;
}

function detectReorderedNames(
  previous: readonly AbiParameter[],
  proposed: readonly AbiParameter[],
): { reordered: boolean; detail: string } {
  const prevNames = previous.map((p) => p.name ?? "");
  const nextNames = proposed.map((p) => p.name ?? "");
  if (prevNames.some((n) => n.length === 0) || nextNames.some((n) => n.length === 0)) {
    return { reordered: false, detail: "" };
  }
  const prevShared = prevNames.filter((name) => nextNames.includes(name));
  const nextShared = nextNames.filter((name) => prevNames.includes(name));
  if (prevShared.length !== nextShared.length) {
    return { reordered: false, detail: "" };
  }
  for (let i = 0; i < prevShared.length; i += 1) {
    if (prevShared[i] !== nextShared[i]) {
      return {
        reordered: true,
        detail: `field order changed from [${prevNames.join(", ")}] to [${nextNames.join(", ")}]`,
      };
    }
  }
  return { reordered: false, detail: "" };
}

interface CompareContext {
  readonly contract: string;
  readonly entryKind: AbiEntryKind;
  readonly signature: string;
  readonly payoutRelevant: boolean;
  readonly policy: AbiCompatibilityPolicy;
  readonly out: AbiSemanticChange[];
}

function pushBreaking(
  ctx: CompareContext,
  code: AbiChangeCode,
  path: string,
  detail: string,
  payoutOverride?: boolean,
): void {
  const payoutRelevant = payoutOverride ?? ctx.payoutRelevant;
  ctx.out.push({
    changeId: `${ctx.contract}:${ctx.entryKind}:${ctx.signature}:${code}:${path}`,
    contract: ctx.contract,
    classification: "breaking",
    code,
    entryKind: ctx.entryKind,
    signature: ctx.signature,
    payoutRelevant,
    path,
    detail,
  });
}

function compareTupleComponents(
  ctx: CompareContext,
  previous: readonly AbiParameter[],
  proposed: readonly AbiParameter[],
  basePath: string,
  tuplePayoutRelevant: boolean,
): void {
  const prevByName = new Map<string, { param: AbiParameter; index: number }>();
  const nextByName = new Map<string, { param: AbiParameter; index: number }>();

  for (let i = 0; i < previous.length; i += 1) {
    const param = previous[i];
    if (param?.name !== undefined && param.name.length > 0) {
      prevByName.set(param.name, { param, index: i });
    }
  }
  for (let i = 0; i < proposed.length; i += 1) {
    const param = proposed[i];
    if (param?.name !== undefined && param.name.length > 0) {
      nextByName.set(param.name, { param, index: i });
    }
  }

  for (const [name, prevInfo] of prevByName) {
    if (!nextByName.has(name)) {
      pushBreaking(
        ctx,
        "tuple-field-removed",
        `${basePath}.${name}`,
        `removed tuple component "${name}" (${canonicalParameterType(prevInfo.param)}) at index ${String(prevInfo.index)}`,
        tuplePayoutRelevant,
      );
    }
  }

  for (const [name, nextInfo] of nextByName) {
    if (!prevByName.has(name)) {
      // Adding a field to an ABI tuple changes its static/dynamic head layout and selector in
      // Solidity, so in-place tuple expansion is always breaking on existing call/log consumers.
      pushBreaking(
        ctx,
        "tuple-field-added",
        `${basePath}.${name}`,
        `added in-place tuple component "${name}" (${canonicalParameterType(nextInfo.param)}) at index ${String(nextInfo.index)}; ABI tuple head offsets change`,
        tuplePayoutRelevant,
      );
    }
  }

  const orderCheck = detectReorderedNames(previous, proposed);
  if (orderCheck.reordered) {
    pushBreaking(
      ctx,
      tuplePayoutRelevant ? "payout-fields-reordered" : "tuple-fields-reordered",
      basePath,
      orderCheck.detail,
      tuplePayoutRelevant,
    );
    return;
  }

  const minLen = Math.min(previous.length, proposed.length);
  for (let i = 0; i < minLen; i += 1) {
    const prevParam = previous[i];
    const nextParam = proposed[i];
    if (prevParam === undefined || nextParam === undefined) continue;
    const fieldName = prevParam.name ?? `[${String(i)}]`;
    compareParameterPair(
      ctx,
      prevParam,
      nextParam,
      `${basePath}.${fieldName}`,
      tuplePayoutRelevant,
    );
  }
}

function compareParameterPair(
  ctx: CompareContext,
  previous: AbiParameter,
  proposed: AbiParameter,
  path: string,
  inheritedPayoutRelevant: boolean,
): void {
  const structSet = new Set(ctx.policy.payoutStructInternalTypes);
  const localPayout =
    inheritedPayoutRelevant ||
    parameterTouchesPayoutStruct(previous, structSet) ||
    parameterTouchesPayoutStruct(proposed, structSet);

  const prevIsTuple = previous.type.startsWith("tuple");
  const nextIsTuple = proposed.type.startsWith("tuple");

  if (prevIsTuple && nextIsTuple) {
    const prevSuffix = previous.type.slice("tuple".length);
    const nextSuffix = proposed.type.slice("tuple".length);
    if (prevSuffix !== nextSuffix) {
      pushBreaking(
        ctx,
        "parameter-type-changed",
        path,
        `tuple array suffix changed from "tuple${prevSuffix}" to "tuple${nextSuffix}"`,
        localPayout,
      );
    }
    compareTupleComponents(
      ctx,
      previous.components ?? [],
      proposed.components ?? [],
      path,
      localPayout,
    );
    return;
  }

  const prevCanon = canonicalParameterType(previous);
  const nextCanon = canonicalParameterType(proposed);
  if (prevCanon !== nextCanon) {
    pushBreaking(
      ctx,
      ctx.entryKind === "event" ? "event-field-type-changed" : "parameter-type-changed",
      path,
      `type changed from "${prevCanon}" to "${nextCanon}"`,
      localPayout,
    );
    return;
  }

  const prevInternal = stripStructArraySuffix(previous.internalType);
  const nextInternal = stripStructArraySuffix(proposed.internalType);
  if (
    prevInternal.startsWith("enum ") &&
    nextInternal.startsWith("enum ") &&
    prevInternal !== nextInternal
  ) {
    pushBreaking(
      ctx,
      "parameter-type-changed",
      path,
      `enum semantic type changed from "${prevInternal}" to "${nextInternal}"`,
      localPayout,
    );
  }

  if (
    localPayout &&
    previous.name !== undefined &&
    proposed.name !== undefined &&
    previous.name.length > 0 &&
    proposed.name.length > 0 &&
    previous.name !== proposed.name
  ) {
    pushBreaking(
      ctx,
      "payout-field-renamed",
      path,
      `payout relevant field renamed from "${previous.name}" to "${proposed.name}" at matching ABI slot`,
      true,
    );
  }
}

function compareMatchedFunction(
  contract: string,
  previous: AbiEntry,
  proposed: AbiEntry,
  policy: AbiCompatibilityPolicy,
  out: AbiSemanticChange[],
): void {
  const signature = canonicalEntrySignature(previous);
  const payoutRelevant =
    isPayoutRelevantEntry(previous, policy) || isPayoutRelevantEntry(proposed, policy);
  const ctx: CompareContext = {
    contract,
    entryKind: "function",
    signature,
    payoutRelevant,
    policy,
    out,
  };

  if (!isMutabilityUpgradeCompatible(previous.stateMutability, proposed.stateMutability)) {
    pushBreaking(
      ctx,
      "state-mutability-incompatible",
      "stateMutability",
      `stateMutability changed from "${previous.stateMutability ?? "nonpayable"}" to "${proposed.stateMutability ?? "nonpayable"}"`,
    );
  }

  const prevInputs = previous.inputs ?? [];
  const nextInputs = proposed.inputs ?? [];
  const inputReorder = detectReorderedNames(prevInputs, nextInputs);
  if (payoutRelevant && inputReorder.reordered) {
    pushBreaking(ctx, "payout-fields-reordered", "inputs", inputReorder.detail, true);
  } else {
    const minInputs = Math.min(prevInputs.length, nextInputs.length);
    for (let i = 0; i < minInputs; i += 1) {
      const prevParam = prevInputs[i];
      const nextParam = nextInputs[i];
      if (prevParam === undefined || nextParam === undefined) continue;
      const label = prevParam.name && prevParam.name.length > 0 ? prevParam.name : `[${String(i)}]`;
      compareParameterPair(ctx, prevParam, nextParam, `inputs.${label}`, payoutRelevant);
    }
  }

  const prevOutputs = previous.outputs ?? [];
  const nextOutputs = proposed.outputs ?? [];
  if (prevOutputs.length !== nextOutputs.length) {
    pushBreaking(
      ctx,
      "output-count-changed",
      "outputs",
      `return count changed from ${String(prevOutputs.length)} to ${String(nextOutputs.length)}`,
    );
    return;
  }

  for (let i = 0; i < prevOutputs.length; i += 1) {
    const prevOut = prevOutputs[i];
    const nextOut = nextOutputs[i];
    if (prevOut === undefined || nextOut === undefined) continue;
    const prevType = canonicalParameterType(prevOut);
    const nextType = canonicalParameterType(nextOut);
    const label = prevOut.name && prevOut.name.length > 0 ? prevOut.name : `[${String(i)}]`;
    if (prevOut.type.startsWith("tuple") && nextOut.type.startsWith("tuple")) {
      compareParameterPair(ctx, prevOut, nextOut, `outputs.${label}`, payoutRelevant);
    } else if (prevType !== nextType) {
      pushBreaking(
        ctx,
        "output-type-changed",
        `outputs.${label}`,
        `return type changed from "${prevType}" to "${nextType}"`,
      );
    }
  }
}

function compareMatchedEvent(
  contract: string,
  previous: AbiEntry,
  proposed: AbiEntry,
  policy: AbiCompatibilityPolicy,
  out: AbiSemanticChange[],
): void {
  const signature = canonicalEntrySignature(previous);
  const payoutRelevant =
    isPayoutRelevantEntry(previous, policy) || isPayoutRelevantEntry(proposed, policy);
  const ctx: CompareContext = {
    contract,
    entryKind: "event",
    signature,
    payoutRelevant,
    policy,
    out,
  };

  if (Boolean(previous.anonymous) !== Boolean(proposed.anonymous)) {
    pushBreaking(
      ctx,
      "event-anonymous-changed",
      "anonymous",
      `event anonymous flag changed from ${String(Boolean(previous.anonymous))} to ${String(Boolean(proposed.anonymous))}`,
    );
  }

  const prevInputs = previous.inputs ?? [];
  const nextInputs = proposed.inputs ?? [];

  if (nextInputs.length < prevInputs.length) {
    for (let i = nextInputs.length; i < prevInputs.length; i += 1) {
      const removed = prevInputs[i];
      if (removed === undefined) continue;
      const label = removed.name ?? `[${String(i)}]`;
      pushBreaking(
        ctx,
        "event-field-removed",
        `inputs.${label}`,
        `removed event parameter "${label}" (${canonicalParameterType(removed)})`,
      );
    }
  } else if (nextInputs.length > prevInputs.length) {
    for (let i = prevInputs.length; i < nextInputs.length; i += 1) {
      const added = nextInputs[i];
      if (added === undefined) continue;
      const label = added.name ?? `[${String(i)}]`;
      pushBreaking(
        ctx,
        "event-field-added",
        `inputs.${label}`,
        `appended in-place event parameter "${label}" (${canonicalParameterType(added)}); topic0 changes for existing indexers`,
      );
    }
  }

  const reorder = detectReorderedNames(prevInputs, nextInputs);
  if (reorder.reordered) {
    pushBreaking(
      ctx,
      payoutRelevant ? "payout-fields-reordered" : "tuple-fields-reordered",
      "inputs",
      reorder.detail,
    );
    return;
  }

  const minLen = Math.min(prevInputs.length, nextInputs.length);
  for (let i = 0; i < minLen; i += 1) {
    const prevParam = prevInputs[i];
    const nextParam = nextInputs[i];
    if (prevParam === undefined || nextParam === undefined) continue;
    const label = prevParam.name && prevParam.name.length > 0 ? prevParam.name : `[${String(i)}]`;
    if (Boolean(prevParam.indexed) !== Boolean(nextParam.indexed)) {
      pushBreaking(
        ctx,
        "event-indexed-changed",
        `inputs.${label}.indexed`,
        `event parameter "${label}" indexed flag changed from ${String(Boolean(prevParam.indexed))} to ${String(Boolean(nextParam.indexed))}`,
      );
    }
    compareParameterPair(ctx, prevParam, nextParam, `inputs.${label}`, payoutRelevant);
  }
}

function groupByKindAndName(abi: readonly AbiEntry[]): Map<string, AbiEntry[]> {
  const map = new Map<string, AbiEntry[]>();
  for (const entry of canonicaliseAbi(abi)) {
    // Constructor changes only affect fresh deployments, not live on-chain callers or indexers.
    if (entry.type === "constructor") continue;
    const key = `${entry.type}:${entry.name ?? entry.type}`;
    const existing = map.get(key);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      map.set(key, [entry]);
    }
  }
  return map;
}

/**
 * Compare a single contract's previous and proposed ABIs under the compatibility policy.
 *
 * When a function or event name exists on only one overload in both previous and proposed ABIs,
 * the two entries are paired by `(kind, name)` even if their canonical signature changed, so
 * removed/reordered tuple fields or type changes report the exact broken field path rather than a
 * generic "removed + added" pair.
 */
export function compareContractAbis(
  contract: string,
  previousAbi: readonly AbiEntry[],
  proposedAbi: readonly AbiEntry[],
  options?: {
    readonly policy?: AbiCompatibilityPolicy | undefined;
    readonly migrationAssessments?: readonly ConsumerMigrationAssessment[] | undefined;
  },
): {
  readonly breakingChanges: readonly AbiSemanticChange[];
  readonly additiveChanges: readonly AbiSemanticChange[];
  readonly unassessedAdditiveChanges: readonly AbiSemanticChange[];
} {
  const policy = options?.policy ?? DEFAULT_ABI_COMPATIBILITY_POLICY;
  const assessmentMap = new Map<string, ConsumerMigrationAssessment>();
  for (const assessment of options?.migrationAssessments ?? []) {
    if (
      assessment.summary.trim().length > 0 &&
      assessment.consumerSurfaces.length > 0 &&
      assessment.migrationSteps.length > 0 &&
      assessment.migrationSteps.every((step) => step.trim().length > 0)
    ) {
      assessmentMap.set(assessment.changeId, assessment);
    }
  }

  const breakingChanges: AbiSemanticChange[] = [];
  const additiveChanges: AbiSemanticChange[] = [];
  const unassessedAdditiveChanges: AbiSemanticChange[] = [];

  const prevGroups = groupByKindAndName(previousAbi);
  const nextGroups = groupByKindAndName(proposedAbi);
  const allKeys = new Set([...prevGroups.keys(), ...nextGroups.keys()]);

  for (const key of [...allKeys].sort()) {
    const prevList = prevGroups.get(key) ?? [];
    const nextList = nextGroups.get(key) ?? [];

    if (prevList.length === 1 && nextList.length === 1) {
      const prevEntry = prevList[0];
      const nextEntry = nextList[0];
      if (prevEntry === undefined || nextEntry === undefined) continue;

      if (prevEntry.type === "function") {
        const prevSig = canonicalEntrySignature(prevEntry);
        const nextSig = canonicalEntrySignature(nextEntry);
        if (prevSig !== nextSig) {
          // Compare parameter/tuple layout directly so payout field removals/reorders are pinpointed.
          compareMatchedFunction(contract, prevEntry, nextEntry, policy, breakingChanges);
          // If input arity changed without triggering an inner parameter mismatch, record signature break.
          if ((prevEntry.inputs ?? []).length !== (nextEntry.inputs ?? []).length) {
            const payoutRelevant =
              isPayoutRelevantEntry(prevEntry, policy) || isPayoutRelevantEntry(nextEntry, policy);
            breakingChanges.push({
              changeId: `${contract}:function:${prevSig}:removed-entry:inputs`,
              contract,
              classification: "breaking",
              code: "removed-entry",
              entryKind: "function",
              signature: prevSig,
              payoutRelevant,
              path: "inputs",
              detail: `function signature changed from "${prevSig}" to "${nextSig}"`,
            });
          }
        } else {
          compareMatchedFunction(contract, prevEntry, nextEntry, policy, breakingChanges);
        }
        continue;
      }

      if (prevEntry.type === "event") {
        compareMatchedEvent(contract, prevEntry, nextEntry, policy, breakingChanges);
        continue;
      }

      if (prevEntry.type === "receive" || prevEntry.type === "fallback") {
        if (!isMutabilityUpgradeCompatible(prevEntry.stateMutability, nextEntry.stateMutability)) {
          breakingChanges.push({
            changeId: `${contract}:${prevEntry.type}:${canonicalEntrySignature(prevEntry)}:state-mutability-incompatible:stateMutability`,
            contract,
            classification: "breaking",
            code: "state-mutability-incompatible",
            entryKind: prevEntry.type,
            signature: canonicalEntrySignature(prevEntry),
            payoutRelevant: true,
            path: "stateMutability",
            detail: `${prevEntry.type} stateMutability changed from "${prevEntry.stateMutability ?? "nonpayable"}" to "${nextEntry.stateMutability ?? "nonpayable"}"`,
          });
        }
        continue;
      }

      if (prevEntry.type === "error") {
        const prevSig = canonicalEntrySignature(prevEntry);
        const nextSig = canonicalEntrySignature(nextEntry);
        if (prevSig !== nextSig) {
          breakingChanges.push({
            changeId: `${contract}:error:${prevSig}:removed-entry:signature`,
            contract,
            classification: "breaking",
            code: "removed-entry",
            entryKind: "error",
            signature: prevSig,
            payoutRelevant: false,
            path: "signature",
            detail: `error signature changed from "${prevSig}" to "${nextSig}", altering 4-byte revert selector`,
          });
        }
        continue;
      }
    }

    const prevBySig = new Map(prevList.map((e) => [canonicalEntrySignature(e), e]));
    const nextBySig = new Map(nextList.map((e) => [canonicalEntrySignature(e), e]));

    for (const [sig, prevEntry] of prevBySig) {
      const nextEntry = nextBySig.get(sig);
      if (nextEntry === undefined) {
        const payoutRelevant = isPayoutRelevantEntry(prevEntry, policy);
        breakingChanges.push({
          changeId: `${contract}:${prevEntry.type}:${sig}:removed-entry:entry`,
          contract,
          classification: "breaking",
          code: "removed-entry",
          entryKind: prevEntry.type,
          signature: sig,
          payoutRelevant,
          path: "entry",
          detail: `removed ${prevEntry.type} "${sig}"`,
        });
      } else if (prevEntry.type === "function") {
        compareMatchedFunction(contract, prevEntry, nextEntry, policy, breakingChanges);
      } else if (prevEntry.type === "event") {
        compareMatchedEvent(contract, prevEntry, nextEntry, policy, breakingChanges);
      }
    }

    for (const [sig, nextEntry] of nextBySig) {
      if (!prevBySig.has(sig)) {
        const payoutRelevant = isPayoutRelevantEntry(nextEntry, policy);
        const changeId = `${contract}:${nextEntry.type}:${sig}:added-entry`;
        const assessment = assessmentMap.get(changeId);
        const additiveRecord: AbiSemanticChange = {
          changeId,
          contract,
          classification: "additive",
          code: "added-entry",
          entryKind: nextEntry.type,
          signature: sig,
          payoutRelevant,
          path: "entry",
          detail: `added ${nextEntry.type} "${sig}"`,
          migrationAssessment: assessment,
        };
        additiveChanges.push(additiveRecord);
        if (policy.requireMigrationAssessmentForAdditive && assessment === undefined) {
          unassessedAdditiveChanges.push({
            ...additiveRecord,
            code: "unassessed-additive-change",
            detail: `additive ${nextEntry.type} "${sig}" requires a ConsumerMigrationAssessment for changeId "${changeId}"`,
          });
        }
      }
    }
  }

  return { breakingChanges, additiveChanges, unassessedAdditiveChanges };
}

/**
 * Verify that every generated SDK ABI module matches the canonicalised ABI emitted by Foundry's
 * compiled contract artifact and carries expected compiler/bytecode provenance.
 */
export function verifyAbiProvenance(
  records: readonly AbiProvenanceRecord[],
  options?: {
    readonly expectedCompilerPrefix?: string | undefined;
    readonly concreteContracts?: readonly string[] | undefined;
  },
): AbiProvenanceCheckResult {
  const expectedCompilerPrefix = options?.expectedCompilerPrefix ?? "0.8.28";
  const concreteSet = new Set(
    options?.concreteContracts ?? ["HyperionRouter", "CctpAdapter", "AxelarItsAdapter"],
  );

  const issues: AbiSemanticChange[] = [];

  for (const record of records) {
    if (concreteSet.has(record.contract) && !record.hasConcreteBytecode) {
      issues.push({
        changeId: `${record.contract}:provenance:missing-bytecode`,
        contract: record.contract,
        classification: "breaking",
        code: "provenance-mismatch",
        entryKind: "function",
        signature: record.symbolName,
        payoutRelevant: true,
        path: `${record.artifactFile}:bytecode`,
        detail: `concrete contract "${record.contract}" artifact has empty bytecode`,
      });
    }

    if (
      record.compilerVersion !== undefined &&
      !record.compilerVersion.startsWith(expectedCompilerPrefix)
    ) {
      issues.push({
        changeId: `${record.contract}:provenance:compiler-version`,
        contract: record.contract,
        classification: "breaking",
        code: "provenance-mismatch",
        entryKind: "function",
        signature: record.symbolName,
        payoutRelevant: true,
        path: `${record.artifactFile}:metadata.compiler.version`,
        detail: `expected compiler prefix "${expectedCompilerPrefix}", got "${record.compilerVersion}"`,
      });
    }

    const canonicalCompiled = JSON.stringify(canonicaliseAbi(record.compiledAbi));
    const canonicalExported = JSON.stringify(canonicaliseAbi(record.exportedAbi));
    const rawExported = JSON.stringify(record.exportedAbi);

    if (canonicalCompiled !== canonicalExported || canonicalCompiled !== rawExported) {
      issues.push({
        changeId: `${record.contract}:provenance:abi-drift`,
        contract: record.contract,
        classification: "breaking",
        code: "provenance-mismatch",
        entryKind: "function",
        signature: record.symbolName,
        payoutRelevant: true,
        path: `src/abi/${record.moduleName}.ts`,
        detail: `exported ABI symbol "${record.symbolName}" does not match canonical compiled artifact "${record.artifactFile}"`,
      });
    }
  }

  return {
    verified: issues.length === 0,
    issues,
  };
}

/**
 * Evaluate full multi-contract ABI semantic compatibility and artifact provenance.
 */
export function evaluateAbiCompatibilityGate(params: {
  readonly baselineAbis: Readonly<Record<string, readonly AbiEntry[]>>;
  readonly proposedAbis: Readonly<Record<string, readonly AbiEntry[]>>;
  readonly provenanceRecords?: readonly AbiProvenanceRecord[] | undefined;
  readonly policy?: AbiCompatibilityPolicy | undefined;
  readonly migrationAssessments?: readonly ConsumerMigrationAssessment[] | undefined;
}): AbiCompatibilityReport {
  const policy = params.policy ?? DEFAULT_ABI_COMPATIBILITY_POLICY;
  const contracts = new Set([
    ...Object.keys(params.baselineAbis),
    ...Object.keys(params.proposedAbis),
  ]);

  const breakingChanges: AbiSemanticChange[] = [];
  const additiveChanges: AbiSemanticChange[] = [];
  const unassessedAdditiveChanges: AbiSemanticChange[] = [];

  for (const contract of [...contracts].sort()) {
    const previousAbi = params.baselineAbis[contract];
    const proposedAbi = params.proposedAbis[contract];

    if (previousAbi === undefined) {
      const changeId = `${contract}:function:contract:added-entry`;
      const assessment = (params.migrationAssessments ?? []).find((a) => a.changeId === changeId);
      const record: AbiSemanticChange = {
        changeId,
        contract,
        classification: "additive",
        code: "added-entry",
        entryKind: "function",
        signature: contract,
        payoutRelevant: false,
        path: "contract",
        detail: `added exported contract ABI "${contract}"`,
        migrationAssessment: assessment,
      };
      additiveChanges.push(record);
      if (policy.requireMigrationAssessmentForAdditive && assessment === undefined) {
        unassessedAdditiveChanges.push({
          ...record,
          code: "unassessed-additive-change",
          detail: `new contract ABI "${contract}" requires a ConsumerMigrationAssessment for changeId "${changeId}"`,
        });
      }
      continue;
    }

    if (proposedAbi === undefined) {
      breakingChanges.push({
        changeId: `${contract}:function:contract:removed-entry:contract`,
        contract,
        classification: "breaking",
        code: "removed-entry",
        entryKind: "function",
        signature: contract,
        payoutRelevant: true,
        path: "contract",
        detail: `removed exported contract ABI "${contract}"`,
      });
      continue;
    }

    const diff = compareContractAbis(contract, previousAbi, proposedAbi, {
      policy,
      migrationAssessments: params.migrationAssessments,
    });
    breakingChanges.push(...diff.breakingChanges);
    additiveChanges.push(...diff.additiveChanges);
    unassessedAdditiveChanges.push(...diff.unassessedAdditiveChanges);
  }

  const provenanceCheck =
    params.provenanceRecords !== undefined
      ? verifyAbiProvenance(params.provenanceRecords)
      : { verified: true, issues: [] };

  const passed =
    breakingChanges.length === 0 &&
    unassessedAdditiveChanges.length === 0 &&
    provenanceCheck.verified;

  let verdict: AbiGateVerdict = "identical";
  if (!passed) {
    verdict = "breaking";
  } else if (additiveChanges.length > 0) {
    verdict = "compatible-with-migration";
  }

  return {
    verdict,
    passed,
    provenanceVerified: provenanceCheck.verified,
    breakingChanges,
    additiveChanges,
    unassessedAdditiveChanges,
    provenanceIssues: provenanceCheck.issues,
  };
}
