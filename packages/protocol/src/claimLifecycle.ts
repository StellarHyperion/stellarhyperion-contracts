import type { SorobanErrorName } from "./errors.js";
import type { RouteSlug } from "./routes.js";

/**
 * Deterministic claim lifecycle state, transition snapshots, and invariant
 * verification for crash, interruption, upgrade, archival restoration, and
 * final settlement rehearsals.
 *
 * Designed with zero Node or browser-specific dependencies so both protocol
 * tests and operational rehearsal tooling share the same invariant checks.
 */

export type ClaimLifecyclePhase =
  | "parking"
  | "failed_settlement"
  | "interruption"
  | "upgrade"
  | "restoration"
  | "final_settlement"
  | "duplicate_settlement";

export interface PublicPendingClaimSnapshot {
  readonly id: bigint;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly route: RouteSlug;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  readonly messageIdHex: string;
  readonly createdAt: bigint;
  readonly settled: boolean;
  readonly replayProcessed: boolean;
  readonly persistentTtlLedgers: number;
  readonly archived: boolean;
}

export interface PublicActorBalancesSnapshot {
  readonly rail: bigint;
  readonly router: bigint;
  readonly treasury: bigint;
  readonly settler: bigint;
  readonly recipients: Readonly<Record<string, bigint>>;
}

export interface PublicRouterLifecycleSnapshot {
  readonly ledgerSequence: number;
  readonly ledgerTimestamp: bigint;
  readonly executableHashHex: string;
  readonly runtimeVersion: number;
  readonly paused: boolean;
  readonly enabledRoutes: readonly RouteSlug[];
  readonly tokenEnabled: boolean;
  readonly tokenFlowLimit: bigint;
  readonly treasuryAddress: string;
  readonly claimCount: bigint;
  readonly queueCount: bigint;
  readonly outstandingLiability: bigint;
  readonly settledTotal: bigint;
  readonly balances: PublicActorBalancesSnapshot;
  readonly claims: readonly PublicPendingClaimSnapshot[];
}

export interface ClaimLifecycleTransition {
  readonly stepIndex: number;
  readonly phase: ClaimLifecyclePhase;
  readonly operation: string;
  readonly outcome: "ok" | SorobanErrorName | "ArchivedEntryInaccessible";
  readonly before: PublicRouterLifecycleSnapshot;
  readonly after: PublicRouterLifecycleSnapshot;
}

export interface ClaimLifecycleViolation {
  readonly stepIndex: number;
  readonly code:
    | "EMPTY_TRACE"
    | "SNAPSHOT_CONTINUITY_BROKEN"
    | "SUPPLY_NOT_CONSERVED"
    | "ROUTER_INSOLVENT"
    | "LIABILITY_MISMATCH"
    | "CLAIM_MUTATED_ACROSS_INTERRUPTION"
    | "SETTLED_CLAIM_REOPENED"
    | "DOUBLE_SETTLEMENT_PAID"
    | "REPLAY_GUARD_LOST"
    | "THIRD_PARTY_GAINED_FUNDS";
  readonly detail: string;
}

export interface ClaimLifecycleAuditResult {
  readonly valid: boolean;
  readonly transitionCount: number;
  readonly mintedSupply: bigint;
  readonly finalOutstandingLiability: bigint;
  readonly finalSettledTotal: bigint;
  readonly violations: readonly ClaimLifecycleViolation[];
}

export type ClaimRehearsalOperation =
  | {
      readonly kind: "deliver_inbound";
      readonly route: RouteSlug;
      readonly amount: bigint;
      readonly recipient: string;
      readonly sourceChain: string;
      readonly sourceNonce: bigint;
      readonly messageIdHex: string;
    }
  | {
      readonly kind: "set_recipient_blocked";
      readonly recipient: string;
      readonly blocked: boolean;
    }
  | {
      readonly kind: "settle_claim";
      readonly caller: "settler" | "recipient" | "admin";
      readonly claimId: bigint;
    }
  | {
      readonly kind: "pause";
    }
  | {
      readonly kind: "unpause";
    }
  | {
      readonly kind: "set_route_enabled";
      readonly route: RouteSlug;
      readonly enabled: boolean;
    }
  | {
      readonly kind: "set_token_enabled";
      readonly enabled: boolean;
    }
  | {
      readonly kind: "lower_flow_limit";
      readonly limit: bigint;
    }
  | {
      readonly kind: "rotate_treasury";
      readonly treasuryAddress: string;
    }
  | {
      readonly kind: "host_crash_reload";
    }
  | {
      readonly kind: "cancel_queued_upgrade";
      readonly candidateExecutableHashHex: string;
    }
  | {
      readonly kind: "execute_upgrade";
      readonly executableHashHex: string;
      readonly runtimeVersion: number;
      readonly timelockDelaySeconds: bigint;
    }
  | {
      readonly kind: "advance_ledgers";
      readonly ledgers: number;
      readonly seconds: bigint;
    }
  | {
      readonly kind: "keep_alive";
      readonly claimIds: readonly bigint[];
    }
  | {
      readonly kind: "restore_archived_claims";
      readonly claimIds: readonly bigint[];
    };

export interface ClaimRehearsalConfig {
  readonly initialLedgerSequence?: number;
  readonly initialTimestamp?: bigint;
  readonly initialExecutableHashHex?: string;
  readonly initialTreasuryAddress?: string;
  readonly tokenAddress?: string;
  readonly initialRailBalance: bigint;
  readonly recipientAddresses: readonly string[];
  readonly initialBlockedRecipients?: readonly string[];
  readonly initialTokenFlowLimit?: bigint;
  readonly bumpThresholdLedgers?: number;
  readonly bumpToLedgers?: number;
}

const DEFAULT_BUMP_THRESHOLD = 17_280;
const DEFAULT_BUMP_TO = 518_400;
const DEFAULT_ROUTES: readonly RouteSlug[] = ["cctp", "axelar-its", "axelar-gmp", "allbridge"];

function sumBalances(balances: PublicActorBalancesSnapshot): bigint {
  let recipientTotal = 0n;
  for (const key of Object.keys(balances.recipients).sort()) {
    recipientTotal += balances.recipients[key] ?? 0n;
  }
  return balances.rail + balances.router + balances.treasury + balances.settler + recipientTotal;
}

export function serializePublicSnapshot(snapshot: PublicRouterLifecycleSnapshot): string {
  const sortedRecipientEntries = Object.keys(snapshot.balances.recipients)
    .sort()
    .map((addr) => `${addr}:${snapshot.balances.recipients[addr]?.toString() ?? "0"}`)
    .join(",");

  const claimEntries = snapshot.claims
    .map(
      (c) =>
        `#${c.id.toString()}[recipient=${c.recipient},amount=${c.amount.toString()},route=${c.route},` +
        `chain=${c.sourceChain},nonce=${c.sourceNonce.toString()},msg=${c.messageIdHex},` +
        `settled=${String(c.settled)},replay=${String(c.replayProcessed)},ttl=${String(c.persistentTtlLedgers)},` +
        `archived=${String(c.archived)}]`,
    )
    .join(";");

  return [
    `ledger=${String(snapshot.ledgerSequence)}`,
    `ts=${snapshot.ledgerTimestamp.toString()}`,
    `exec=${snapshot.executableHashHex}@v${String(snapshot.runtimeVersion)}`,
    `paused=${String(snapshot.paused)}`,
    `routes=${[...snapshot.enabledRoutes].join(",")}`,
    `tokenEnabled=${String(snapshot.tokenEnabled)}`,
    `flowLimit=${snapshot.tokenFlowLimit.toString()}`,
    `treasury=${snapshot.treasuryAddress}`,
    `claimCount=${snapshot.claimCount.toString()}`,
    `queueCount=${snapshot.queueCount.toString()}`,
    `liability=${snapshot.outstandingLiability.toString()}`,
    `settledTotal=${snapshot.settledTotal.toString()}`,
    `rail=${snapshot.balances.rail.toString()}`,
    `router=${snapshot.balances.router.toString()}`,
    `treasuryBal=${snapshot.balances.treasury.toString()}`,
    `settlerBal=${snapshot.balances.settler.toString()}`,
    `recipients={${sortedRecipientEntries}}`,
    `claims=[${claimEntries}]`,
  ].join("|");
}

export function snapshotsEqual(
  left: PublicRouterLifecycleSnapshot,
  right: PublicRouterLifecycleSnapshot,
): boolean {
  return serializePublicSnapshot(left) === serializePublicSnapshot(right);
}

/**
 * Independently verify a sequence of before/after claim lifecycle transitions.
 */
export function verifyClaimLifecycleTrace(
  transitions: readonly ClaimLifecycleTransition[],
): ClaimLifecycleAuditResult {
  const firstStep = transitions[0];
  const lastStep = transitions[transitions.length - 1];
  if (!firstStep || !lastStep) {
    return {
      valid: false,
      transitionCount: 0,
      mintedSupply: 0n,
      finalOutstandingLiability: 0n,
      finalSettledTotal: 0n,
      violations: [
        {
          stepIndex: 0,
          code: "EMPTY_TRACE",
          detail: "Lifecycle trace contained zero transitions.",
        },
      ],
    };
  }

  const violations: ClaimLifecycleViolation[] = [];
  const firstBefore = firstStep.before;
  const mintedSupply = sumBalances(firstBefore.balances);

  const checkSnapshotInvariants = (
    stepIndex: number,
    side: "before" | "after",
    snap: PublicRouterLifecycleSnapshot,
  ): void => {
    const supply = sumBalances(snap.balances);
    if (supply !== mintedSupply) {
      violations.push({
        stepIndex,
        code: "SUPPLY_NOT_CONSERVED",
        detail: `${side} snapshot supply ${supply.toString()} diverged from initial minted supply ${mintedSupply.toString()}.`,
      });
    }

    let expectedLiability = 0n;
    let expectedSettled = 0n;
    for (const claim of snap.claims) {
      if (claim.settled) {
        expectedSettled += claim.amount;
      } else {
        expectedLiability += claim.amount;
      }
      if (!claim.replayProcessed) {
        violations.push({
          stepIndex,
          code: "REPLAY_GUARD_LOST",
          detail: `${side} snapshot lost replay guard for claim #${claim.id.toString()} (${claim.messageIdHex}).`,
        });
      }
    }

    if (snap.outstandingLiability !== expectedLiability) {
      violations.push({
        stepIndex,
        code: "LIABILITY_MISMATCH",
        detail: `${side} outstandingLiability ${snap.outstandingLiability.toString()} != unsettled sum ${expectedLiability.toString()}.`,
      });
    }

    if (snap.settledTotal !== expectedSettled) {
      violations.push({
        stepIndex,
        code: "LIABILITY_MISMATCH",
        detail: `${side} settledTotal ${snap.settledTotal.toString()} != settled sum ${expectedSettled.toString()}.`,
      });
    }

    if (snap.balances.router < expectedLiability) {
      violations.push({
        stepIndex,
        code: "ROUTER_INSOLVENT",
        detail: `${side} router balance ${snap.balances.router.toString()} < unsettled claim liability ${expectedLiability.toString()}.`,
      });
    }

    if (snap.balances.settler !== firstBefore.balances.settler) {
      violations.push({
        stepIndex,
        code: "THIRD_PARTY_GAINED_FUNDS",
        detail: `${side} permissionless settler balance changed from ${firstBefore.balances.settler.toString()} to ${snap.balances.settler.toString()}.`,
      });
    }
  };

  for (let i = 0; i < transitions.length; i += 1) {
    const step = transitions[i];
    if (!step) continue;
    if (i > 0) {
      const prevStep = transitions[i - 1];
      if (prevStep && !snapshotsEqual(prevStep.after, step.before)) {
        violations.push({
          stepIndex: step.stepIndex,
          code: "SNAPSHOT_CONTINUITY_BROKEN",
          detail: `Transition ${String(step.stepIndex)} (${step.operation}) before-state did not match previous transition after-state.`,
        });
      }
    }

    checkSnapshotInvariants(step.stepIndex, "before", step.before);
    checkSnapshotInvariants(step.stepIndex, "after", step.after);

    const beforeById = new Map<bigint, PublicPendingClaimSnapshot>();
    for (const c of step.before.claims) {
      beforeById.set(c.id, c);
    }
    const afterById = new Map<bigint, PublicPendingClaimSnapshot>();
    for (const c of step.after.claims) {
      afterById.set(c.id, c);
    }

    for (const [id, prev] of beforeById.entries()) {
      const next = afterById.get(id);
      if (!next) {
        violations.push({
          stepIndex: step.stepIndex,
          code: "CLAIM_MUTATED_ACROSS_INTERRUPTION",
          detail: `Claim #${id.toString()} disappeared during ${step.operation}.`,
        });
        continue;
      }

      const immutableChanged =
        prev.recipient !== next.recipient ||
        prev.token !== next.token ||
        prev.amount !== next.amount ||
        prev.route !== next.route ||
        prev.sourceChain !== next.sourceChain ||
        prev.sourceNonce !== next.sourceNonce ||
        prev.messageIdHex !== next.messageIdHex ||
        prev.createdAt !== next.createdAt;
      if (immutableChanged) {
        violations.push({
          stepIndex: step.stepIndex,
          code: "CLAIM_MUTATED_ACROSS_INTERRUPTION",
          detail: `Immutable fields of claim #${id.toString()} changed during ${step.operation}.`,
        });
      }

      if (prev.settled && !next.settled) {
        violations.push({
          stepIndex: step.stepIndex,
          code: "SETTLED_CLAIM_REOPENED",
          detail: `Settled claim #${id.toString()} reverted to unsettled during ${step.operation}.`,
        });
      }

      if (prev.settled && next.settled && step.phase === "duplicate_settlement") {
        const beforeRecipientBal = step.before.balances.recipients[prev.recipient] ?? 0n;
        const afterRecipientBal = step.after.balances.recipients[prev.recipient] ?? 0n;
        if (afterRecipientBal !== beforeRecipientBal || step.outcome !== "ClaimAlreadySettled") {
          violations.push({
            stepIndex: step.stepIndex,
            code: "DOUBLE_SETTLEMENT_PAID",
            detail: `Duplicate settlement on claim #${id.toString()} produced outcome ${step.outcome} and recipient delta ${(afterRecipientBal - beforeRecipientBal).toString()}.`,
          });
        }
      }
    }

    if (
      step.phase === "interruption" ||
      step.phase === "upgrade" ||
      step.phase === "restoration" ||
      step.phase === "failed_settlement"
    ) {
      if (step.before.outstandingLiability !== step.after.outstandingLiability) {
        violations.push({
          stepIndex: step.stepIndex,
          code: "CLAIM_MUTATED_ACROSS_INTERRUPTION",
          detail: `Outstanding liability changed from ${step.before.outstandingLiability.toString()} to ${step.after.outstandingLiability.toString()} during ${step.phase} (${step.operation}).`,
        });
      }
    }
  }

  const lastAfter = lastStep.after;
  return {
    valid: violations.length === 0,
    transitionCount: transitions.length,
    mintedSupply,
    finalOutstandingLiability: lastAfter.outstandingLiability,
    finalSettledTotal: lastAfter.settledTotal,
    violations,
  };
}

/**
 * Execute a deterministic claim lifecycle rehearsal and record public state
 * before and after every transition.
 */
export function runClaimLifecycleRehearsal(
  config: ClaimRehearsalConfig,
  operations: readonly ClaimRehearsalOperation[],
): readonly ClaimLifecycleTransition[] {
  const bumpThreshold = config.bumpThresholdLedgers ?? DEFAULT_BUMP_THRESHOLD;
  const bumpTo = config.bumpToLedgers ?? DEFAULT_BUMP_TO;
  const tokenAddress = config.tokenAddress ?? "CTOKEN_FAILABLE_TEST";

  let ledgerSequence = config.initialLedgerSequence ?? 100_000;
  let ledgerTimestamp = config.initialTimestamp ?? 1_700_000_000n;
  let executableHashHex =
    config.initialExecutableHashHex ??
    "0x5151515151515151515151515151515151515151515151515151515151515151";
  let runtimeVersion = 1;
  let paused = false;
  let enabledRoutes: RouteSlug[] = [...DEFAULT_ROUTES];
  let tokenEnabled = true;
  let tokenFlowLimit = config.initialTokenFlowLimit ?? 10_000_000_000n;
  let treasuryAddress = config.initialTreasuryAddress ?? "GTREASURY_INITIAL";
  let claimCount = 0n;
  let queueCount = 0n;
  let railBalance = config.initialRailBalance;
  let routerBalance = 0n;
  const treasuryBalance = 0n;
  const settlerBalance = 0n;

  const recipientBalances = new Map<string, bigint>();
  for (const addr of config.recipientAddresses) {
    recipientBalances.set(addr, 0n);
  }
  const blockedRecipients = new Set<string>(config.initialBlockedRecipients ?? []);
  const processedKeys = new Set<string>();

  interface MutableClaim {
    id: bigint;
    recipient: string;
    token: string;
    amount: bigint;
    route: RouteSlug;
    sourceChain: string;
    sourceNonce: bigint;
    messageIdHex: string;
    createdAt: bigint;
    settled: boolean;
    liveUntilLedger: number;
  }

  const claims: MutableClaim[] = [];

  const snapshotNow = (): PublicRouterLifecycleSnapshot => {
    const recipientsObj: Record<string, bigint> = {};
    for (const key of [...recipientBalances.keys()].sort()) {
      recipientsObj[key] = recipientBalances.get(key) ?? 0n;
    }

    let outstandingLiability = 0n;
    let settledTotal = 0n;
    const publicClaims: PublicPendingClaimSnapshot[] = claims.map((c) => {
      if (c.settled) {
        settledTotal += c.amount;
      } else {
        outstandingLiability += c.amount;
      }
      const archived = ledgerSequence > c.liveUntilLedger;
      const ttl = archived ? 0 : c.liveUntilLedger - ledgerSequence;
      return {
        id: c.id,
        recipient: c.recipient,
        token: c.token,
        amount: c.amount,
        route: c.route,
        sourceChain: c.sourceChain,
        sourceNonce: c.sourceNonce,
        messageIdHex: c.messageIdHex,
        createdAt: c.createdAt,
        settled: c.settled,
        replayProcessed: processedKeys.has(`${c.route}:${c.messageIdHex}`),
        persistentTtlLedgers: ttl,
        archived,
      };
    });

    return {
      ledgerSequence,
      ledgerTimestamp,
      executableHashHex,
      runtimeVersion,
      paused,
      enabledRoutes: [...enabledRoutes],
      tokenEnabled,
      tokenFlowLimit,
      treasuryAddress,
      claimCount,
      queueCount,
      outstandingLiability,
      settledTotal,
      balances: {
        rail: railBalance,
        router: routerBalance,
        treasury: treasuryBalance,
        settler: settlerBalance,
        recipients: recipientsObj,
      },
      claims: publicClaims,
    };
  };

  const transitions: ClaimLifecycleTransition[] = [];

  operations.forEach((op, idx) => {
    const before = snapshotNow();
    let phase: ClaimLifecyclePhase = "interruption";
    let operationLabel: string = op.kind;
    let outcome: ClaimLifecycleTransition["outcome"] = "ok";

    switch (op.kind) {
      case "deliver_inbound": {
        operationLabel = `deliver_inbound(${op.route}, nonce=${op.sourceNonce.toString()})`;
        const replayKey = `${op.route}:${op.messageIdHex}`;
        if (op.amount <= 0n) {
          phase = "interruption";
          outcome = "InvalidAmount";
          break;
        }
        if (processedKeys.has(replayKey)) {
          phase = "interruption";
          outcome = "ReplayedMessage";
          break;
        }
        processedKeys.add(replayKey);
        railBalance -= op.amount;
        if (blockedRecipients.has(op.recipient)) {
          phase = "parking";
          routerBalance += op.amount;
          claimCount += 1n;
          claims.push({
            id: claimCount,
            recipient: op.recipient,
            token: tokenAddress,
            amount: op.amount,
            route: op.route,
            sourceChain: op.sourceChain,
            sourceNonce: op.sourceNonce,
            messageIdHex: op.messageIdHex,
            createdAt: ledgerTimestamp,
            settled: false,
            liveUntilLedger: ledgerSequence + bumpTo,
          });
        } else {
          phase = "final_settlement";
          recipientBalances.set(
            op.recipient,
            (recipientBalances.get(op.recipient) ?? 0n) + op.amount,
          );
        }
        break;
      }

      case "set_recipient_blocked": {
        phase = "interruption";
        operationLabel = `set_recipient_blocked(${op.recipient}, ${String(op.blocked)})`;
        if (op.blocked) {
          blockedRecipients.add(op.recipient);
        } else {
          blockedRecipients.delete(op.recipient);
        }
        break;
      }

      case "settle_claim": {
        operationLabel = `settle_claim(caller=${op.caller}, id=${op.claimId.toString()})`;
        const found = claims.find((c) => c.id === op.claimId);
        if (!found) {
          phase = "failed_settlement";
          outcome = "ClaimNotFound";
          break;
        }
        if (ledgerSequence > found.liveUntilLedger) {
          phase = "failed_settlement";
          outcome = "ArchivedEntryInaccessible";
          break;
        }
        const currentTtl = found.liveUntilLedger - ledgerSequence;
        if (currentTtl < bumpThreshold) {
          found.liveUntilLedger = ledgerSequence + bumpTo;
        }
        if (found.settled) {
          phase = "duplicate_settlement";
          outcome = "ClaimAlreadySettled";
          break;
        }
        if (blockedRecipients.has(found.recipient)) {
          phase = "failed_settlement";
          outcome = "RecipientNotReady";
          break;
        }
        phase = "final_settlement";
        routerBalance -= found.amount;
        recipientBalances.set(
          found.recipient,
          (recipientBalances.get(found.recipient) ?? 0n) + found.amount,
        );
        found.settled = true;
        found.liveUntilLedger = ledgerSequence + bumpTo;
        break;
      }

      case "pause": {
        phase = "interruption";
        paused = true;
        break;
      }

      case "unpause": {
        phase = "interruption";
        paused = false;
        break;
      }

      case "set_route_enabled": {
        phase = "interruption";
        operationLabel = `set_route_enabled(${op.route}, ${String(op.enabled)})`;
        if (op.enabled) {
          queueCount += 1n;
          if (!enabledRoutes.includes(op.route)) {
            enabledRoutes = [...enabledRoutes, op.route];
          }
        } else {
          enabledRoutes = enabledRoutes.filter((r) => r !== op.route);
        }
        break;
      }

      case "set_token_enabled": {
        phase = "interruption";
        operationLabel = `set_token_enabled(${String(op.enabled)})`;
        if (op.enabled) {
          queueCount += 1n;
        }
        tokenEnabled = op.enabled;
        break;
      }

      case "lower_flow_limit": {
        phase = "interruption";
        operationLabel = `lower_flow_limit(${op.limit.toString()})`;
        tokenFlowLimit = op.limit;
        break;
      }

      case "rotate_treasury": {
        phase = "interruption";
        operationLabel = `rotate_treasury(${op.treasuryAddress})`;
        queueCount += 1n;
        treasuryAddress = op.treasuryAddress;
        break;
      }

      case "host_crash_reload": {
        phase = "interruption";
        operationLabel = "host_crash_reload(ledger_snapshot)";
        break;
      }

      case "cancel_queued_upgrade": {
        phase = "interruption";
        operationLabel = `cancel_queued_upgrade(${op.candidateExecutableHashHex})`;
        queueCount += 1n;
        break;
      }

      case "execute_upgrade": {
        phase = "upgrade";
        operationLabel = `execute_upgrade(v${String(op.runtimeVersion)}, ${op.executableHashHex})`;
        queueCount += 1n;
        ledgerTimestamp += op.timelockDelaySeconds + 1n;
        executableHashHex = op.executableHashHex;
        runtimeVersion = op.runtimeVersion;
        break;
      }

      case "advance_ledgers": {
        phase = "interruption";
        operationLabel = `advance_ledgers(+${String(op.ledgers)})`;
        ledgerSequence += op.ledgers;
        ledgerTimestamp += op.seconds;
        break;
      }

      case "keep_alive": {
        phase = "restoration";
        operationLabel = `keep_alive([${op.claimIds.map((id) => id.toString()).join(",")}])`;
        for (const id of op.claimIds) {
          const found = claims.find((c) => c.id === id);
          if (found && ledgerSequence <= found.liveUntilLedger) {
            const ttl = found.liveUntilLedger - ledgerSequence;
            if (ttl < bumpThreshold) {
              found.liveUntilLedger = ledgerSequence + bumpTo;
            }
          }
        }
        break;
      }

      case "restore_archived_claims": {
        phase = "restoration";
        operationLabel = `restore_archived_claims([${op.claimIds.map((id) => id.toString()).join(",")}])`;
        for (const id of op.claimIds) {
          const found = claims.find((c) => c.id === id);
          if (found && ledgerSequence > found.liveUntilLedger) {
            found.liveUntilLedger = ledgerSequence + bumpTo;
          }
        }
        break;
      }
    }

    const after = snapshotNow();
    transitions.push({
      stepIndex: idx + 1,
      phase,
      operation: operationLabel,
      outcome,
      before,
      after,
    });
  });

  return transitions;
}

/**
 * Format a deterministic line-oriented transition log showing public state
 * before and after each step.
 */
export function formatClaimLifecycleReport(
  transitions: readonly ClaimLifecycleTransition[],
): string {
  const audit = verifyClaimLifecycleTrace(transitions);
  const lines: string[] = [
    `claim_lifecycle_report transitions=${String(audit.transitionCount)} valid=${String(audit.valid)} ` +
      `supply=${audit.mintedSupply.toString()} final_liability=${audit.finalOutstandingLiability.toString()} ` +
      `final_settled=${audit.finalSettledTotal.toString()}`,
  ];

  for (const step of transitions) {
    lines.push(
      `step=${String(step.stepIndex)} phase=${step.phase} op=${step.operation} outcome=${step.outcome}`,
    );
    lines.push(`  before: ${serializePublicSnapshot(step.before)}`);
    lines.push(`  after:  ${serializePublicSnapshot(step.after)}`);
  }

  for (const violation of audit.violations) {
    lines.push(
      `violation step=${String(violation.stepIndex)} code=${violation.code} detail=${violation.detail}`,
    );
  }

  return lines.join("\n");
}
