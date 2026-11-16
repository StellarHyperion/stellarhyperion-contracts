/**
 * Multi-currency token conservation invariant harness for paid ITS and CCTP transfers.
 *
 * Tracks `sender`, `treasury`, `adapter`, `router`, `recipient`, and rail-sink (`its` /
 * `tokenMessenger` / `tokenManager`) balances across successful and failed paid transfers while
 * accounting separately for:
 *
 * 1. Principal bridged asset balances and 7-to-6 decimal `sourceDust` retained in the sender's
 *    wallet (`requestedAmount - grossDebited`), plus optional sub-unit rail dust retained in the
 *    adapter prior to `sweep()`.
 * 2. Relay gas currency:
 *    - `axelar-its`: separate native gas asset (`XLM` / native token) transferred from `sender` to
 *      ITS (`senderGasDelta = -gasAmount`, `railGasSinkDelta = +gasAmount`).
 *    - `cctp`: in-band forwarding fee budget carved out of burned principal (`net = deliverable +
 *      inBandRelayBudget`), with zero separate native gas token movement.
 * 3. Rollback atomicity on failed operations (`0n` delta across every tracked account and asset).
 */
import { applyFee, floorToRepresentable } from "./amounts.js";
import type { SorobanErrorName } from "./errors.js";

export type PaidConservationRoute = "axelar-its" | "cctp";

export type ConservationAccountRole =
  "sender" | "treasury" | "adapter" | "router" | "recipient" | "railSink";

export type ConservationLedgerLeg = "principal" | "source-dust" | "relay-currency";

export interface BalanceSheet {
  readonly sender: bigint;
  readonly treasury: bigint;
  readonly adapter: bigint;
  readonly router: bigint;
  readonly recipient: bigint;
  /** Burned or locked principal on the rail side (or collected gas in `its` for relay currency). */
  readonly railSink: bigint;
}

export interface PaidTransferSnapshotPair {
  readonly principalBefore: BalanceSheet;
  readonly principalAfter: BalanceSheet;
  readonly relayGasBefore: BalanceSheet;
  readonly relayGasAfter: BalanceSheet;
}

export type ConservationOperationSpec =
  | {
      readonly kind: "paid-outbound";
      readonly operation: string;
      readonly route: PaidConservationRoute;
      readonly requestedAmount: bigint;
      readonly feeBps: number;
      readonly sourceDecimals: number;
      readonly destinationDecimals: number;
      readonly relayGasAmount: bigint;
      /** Optional Circle sub-unit burn dust left in adapter before sweep (default `0n`). */
      readonly railSubUnitDust?: bigint;
      readonly succeeded: boolean;
      readonly error?: SorobanErrorName;
    }
  | {
      readonly kind: "inbound-delivery";
      readonly operation: string;
      readonly route: PaidConservationRoute;
      readonly mintedAmount: bigint;
      readonly parkedAsClaim: boolean;
      readonly succeeded: boolean;
      readonly error?: SorobanErrorName;
    }
  | {
      readonly kind: "claim-settlement";
      readonly operation: string;
      readonly route: PaidConservationRoute;
      readonly claimAmount: bigint;
      readonly succeeded: boolean;
      readonly error?: SorobanErrorName;
    }
  | {
      readonly kind: "adapter-dust-sweep";
      readonly operation: string;
      readonly route: PaidConservationRoute;
      readonly sweptAmount: bigint;
      readonly succeeded: boolean;
    };

export interface ConservationStepEntry {
  readonly spec: ConservationOperationSpec;
  readonly snapshots: PaidTransferSnapshotPair;
}

export interface ConservationViolation {
  readonly stepIndex: number;
  readonly operation: string;
  readonly route: PaidConservationRoute;
  readonly ledgerLeg: ConservationLedgerLeg;
  readonly account: ConservationAccountRole | "aggregate";
  readonly expectedDelta: bigint;
  readonly actualDelta: bigint;
  /** Signed discrepancy (`actualDelta - expectedDelta`). */
  readonly balanceDeltaDiscrepancy: bigint;
  readonly message: string;
}

export interface DecomposedPaidAccounting {
  readonly requestedAmount: bigint;
  readonly grossDebited: bigint;
  readonly protocolFee: bigint;
  readonly netPrincipalToRail: bigint;
  readonly sourceDustRetainedBySender: bigint;
  readonly railSubUnitDustInAdapter: bigint;
  readonly separateRelayGasDebited: bigint;
  readonly inBandPrincipalRelayBudget: bigint;
  readonly deliverablePrincipalAfterRelay: bigint;
}

export interface ConservationAuditReport {
  readonly passed: boolean;
  readonly stepCount: number;
  readonly violations: readonly ConservationViolation[];
}

const ALL_ACCOUNTS: readonly ConservationAccountRole[] = [
  "sender",
  "treasury",
  "adapter",
  "router",
  "recipient",
  "railSink",
];

function zeroSheetDeltas(): Record<ConservationAccountRole, bigint> {
  return {
    sender: 0n,
    treasury: 0n,
    adapter: 0n,
    router: 0n,
    recipient: 0n,
    railSink: 0n,
  };
}

function totalSheet(sheet: BalanceSheet): bigint {
  return (
    sheet.sender + sheet.treasury + sheet.adapter + sheet.router + sheet.recipient + sheet.railSink
  );
}

/**
 * Compute exact decomposed source dust, protocol fee, rail burn/lock net principal, and relay
 * currency obligation for a successful paid outbound transfer on `axelar-its` or `cctp`.
 */
export function decomposePaidOutboundAccounting(params: {
  readonly route: PaidConservationRoute;
  readonly requestedAmount: bigint;
  readonly feeBps: number;
  readonly sourceDecimals: number;
  readonly destinationDecimals: number;
  readonly relayGasAmount: bigint;
  readonly railSubUnitDust?: bigint;
}): DecomposedPaidAccounting {
  const split = applyFee(params.requestedAmount, params.feeBps);
  const net = floorToRepresentable(split.net, params.sourceDecimals, params.destinationDecimals);
  const gross = split.fee + net;
  const sourceDust = params.requestedAmount - gross;
  const railDust = params.railSubUnitDust ?? 0n;

  if (params.route === "axelar-its") {
    return {
      requestedAmount: params.requestedAmount,
      grossDebited: gross,
      protocolFee: split.fee,
      netPrincipalToRail: net - railDust,
      sourceDustRetainedBySender: sourceDust,
      railSubUnitDustInAdapter: railDust,
      separateRelayGasDebited: params.relayGasAmount,
      inBandPrincipalRelayBudget: 0n,
      deliverablePrincipalAfterRelay: net - railDust,
    };
  }

  return {
    requestedAmount: params.requestedAmount,
    grossDebited: gross,
    protocolFee: split.fee,
    netPrincipalToRail: net - railDust,
    sourceDustRetainedBySender: sourceDust,
    railSubUnitDustInAdapter: railDust,
    separateRelayGasDebited: 0n,
    inBandPrincipalRelayBudget: params.relayGasAmount,
    deliverablePrincipalAfterRelay: net - railDust - params.relayGasAmount,
  };
}

export function formatConservationViolation(v: ConservationViolation): string {
  return [
    `step=${String(v.stepIndex)}`,
    `op=${v.operation}`,
    `route=${v.route}`,
    `leg=${v.ledgerLeg}`,
    `account=${v.account}`,
    `expectedDelta=${v.expectedDelta.toString()}`,
    `actualDelta=${v.actualDelta.toString()}`,
    `discrepancy=${v.balanceDeltaDiscrepancy.toString()}`,
    `msg=${v.message}`,
  ].join(" | ");
}

/**
 * Audit a sequence of successful and failed paid-transfer, inbound, claim-settlement, and dust
 * sweep steps across both principal and relay-currency balance sheets.
 */
export function auditPaidTransferConservation(
  entries: readonly ConservationStepEntry[],
): ConservationAuditReport {
  const violations: ConservationViolation[] = [];

  for (let idx = 0; idx < entries.length; idx += 1) {
    const entry = entries[idx];
    if (entry === undefined) continue;
    const stepIndex = idx + 1;
    const { spec, snapshots } = entry;

    const expectedPrincipal = zeroSheetDeltas();
    const expectedGas = zeroSheetDeltas();

    if (spec.succeeded) {
      switch (spec.kind) {
        case "paid-outbound": {
          const dec = decomposePaidOutboundAccounting(spec);
          expectedPrincipal.sender = -dec.grossDebited;
          expectedPrincipal.treasury = dec.protocolFee;
          expectedPrincipal.adapter = dec.railSubUnitDustInAdapter;
          expectedPrincipal.railSink = dec.netPrincipalToRail;

          // Verify source-dust identity explicitly (`senderDelta === -(requested - sourceDust)`).
          const actualSenderDebit =
            snapshots.principalBefore.sender - snapshots.principalAfter.sender;
          const impliedRetainedDust = spec.requestedAmount - actualSenderDebit;
          if (impliedRetainedDust !== dec.sourceDustRetainedBySender) {
            const actualDustDelta = impliedRetainedDust;
            const expectedDustDelta = dec.sourceDustRetainedBySender;
            violations.push({
              stepIndex,
              operation: spec.operation,
              route: spec.route,
              ledgerLeg: "source-dust",
              account: "sender",
              expectedDelta: expectedDustDelta,
              actualDelta: actualDustDelta,
              balanceDeltaDiscrepancy: actualDustDelta - expectedDustDelta,
              message: `sender retained source dust ${actualDustDelta.toString()}, expected ${expectedDustDelta.toString()}`,
            });
          }

          if (spec.route === "axelar-its") {
            expectedGas.sender = -dec.separateRelayGasDebited;
            expectedGas.railSink = dec.separateRelayGasDebited;
          }
          break;
        }

        case "inbound-delivery": {
          // Inbound mints freshly onto Stellar (increasing closed-system supply by `mintedAmount`
          // unless `railSink` started pre-funded; here `railSink` tracks net cross-chain burn-mint
          // flow as `-mintedAmount` so closed-loop sum stays zero).
          expectedPrincipal.railSink = -spec.mintedAmount;
          if (spec.parkedAsClaim) {
            expectedPrincipal.router = spec.mintedAmount;
          } else {
            expectedPrincipal.recipient = spec.mintedAmount;
          }
          break;
        }

        case "claim-settlement": {
          expectedPrincipal.router = -spec.claimAmount;
          expectedPrincipal.recipient = spec.claimAmount;
          break;
        }

        case "adapter-dust-sweep": {
          expectedPrincipal.adapter = -spec.sweptAmount;
          expectedPrincipal.treasury = spec.sweptAmount;
          break;
        }
      }
    }

    // Check per-account principal deltas.
    for (const role of ALL_ACCOUNTS) {
      const actual = snapshots.principalAfter[role] - snapshots.principalBefore[role];
      const expected = expectedPrincipal[role];
      if (actual !== expected) {
        violations.push({
          stepIndex,
          operation: spec.operation,
          route: spec.route,
          ledgerLeg: "principal",
          account: role,
          expectedDelta: expected,
          actualDelta: actual,
          balanceDeltaDiscrepancy: actual - expected,
          message: `principal delta mismatch on ${role} during ${spec.operation}`,
        });
      }
    }

    // Check aggregate closed-system principal conservation.
    const principalTotalDelta =
      totalSheet(snapshots.principalAfter) - totalSheet(snapshots.principalBefore);
    if (principalTotalDelta !== 0n) {
      violations.push({
        stepIndex,
        operation: spec.operation,
        route: spec.route,
        ledgerLeg: "principal",
        account: "aggregate",
        expectedDelta: 0n,
        actualDelta: principalTotalDelta,
        balanceDeltaDiscrepancy: principalTotalDelta,
        message: `closed-system principal supply drifted by ${principalTotalDelta.toString()} during ${spec.operation}`,
      });
    }

    // Check per-account relay-currency deltas.
    for (const role of ALL_ACCOUNTS) {
      const actualGas = snapshots.relayGasAfter[role] - snapshots.relayGasBefore[role];
      const expectedG = expectedGas[role];
      if (actualGas !== expectedG) {
        violations.push({
          stepIndex,
          operation: spec.operation,
          route: spec.route,
          ledgerLeg: "relay-currency",
          account: role,
          expectedDelta: expectedG,
          actualDelta: actualGas,
          balanceDeltaDiscrepancy: actualGas - expectedG,
          message: `relay-currency delta mismatch on ${role} during ${spec.operation}`,
        });
      }
    }

    // Check aggregate closed-system relay-currency conservation.
    const gasTotalDelta =
      totalSheet(snapshots.relayGasAfter) - totalSheet(snapshots.relayGasBefore);
    if (gasTotalDelta !== 0n) {
      violations.push({
        stepIndex,
        operation: spec.operation,
        route: spec.route,
        ledgerLeg: "relay-currency",
        account: "aggregate",
        expectedDelta: 0n,
        actualDelta: gasTotalDelta,
        balanceDeltaDiscrepancy: gasTotalDelta,
        message: `closed-system relay-currency supply drifted by ${gasTotalDelta.toString()} during ${spec.operation}`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    stepCount: entries.length,
    violations,
  };
}
