import { describe, expect, it } from "vitest";
import {
  formatClaimLifecycleReport,
  runClaimLifecycleRehearsal,
  serializePublicSnapshot,
  verifyClaimLifecycleTrace,
  type ClaimLifecycleTransition,
  type ClaimRehearsalOperation,
} from "../src/index.js";

function stepAt(
  transitions: readonly ClaimLifecycleTransition[],
  index: number,
): ClaimLifecycleTransition {
  const step = transitions[index];
  if (!step) {
    throw new Error(`Expected transition at index ${String(index)}`);
  }
  return step;
}

const RECIPIENT_ONE = "GA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RLVNR";
const RECIPIENT_TWO = "GB3JDWCQJCWMJ3I6W5PFV7W3N2X52L2U63W2B7W33B6B7P5C2K7S43X2";
const V1_HASH = "0x5151515151515151515151515151515151515151515151515151515151515151";
const V2_HASH = "0x5252525252525252525252525252525252525252525252525252525252525252";
const V3_HASH = "0x5353535353535353535353535353535353535353535353535353535353535353";
const ROGUE_HASH = "0x9999999999999999999999999999999999999999999999999999999999999999";

const MSG_ONE = "0x000000000000000000000000000000000000000000000000000000000000000b";
const MSG_TWO = "0x000000000000000000000000000000000000000000000000000000000000000c";

const HUNDRED = 1_000_000_000n;

function buildFullCrashAndUpgradeSequence(): readonly ClaimRehearsalOperation[] {
  return [
    {
      kind: "deliver_inbound",
      route: "cctp",
      amount: HUNDRED,
      recipient: RECIPIENT_ONE,
      sourceChain: "ethereum",
      sourceNonce: 11n,
      messageIdHex: MSG_ONE,
    },
    {
      kind: "deliver_inbound",
      route: "axelar-gmp",
      amount: HUNDRED * 2n,
      recipient: RECIPIENT_TWO,
      sourceChain: "base",
      sourceNonce: 12n,
      messageIdHex: MSG_TWO,
    },
    {
      kind: "settle_claim",
      caller: "settler",
      claimId: 1n,
    },
    {
      kind: "settle_claim",
      caller: "settler",
      claimId: 99n,
    },
    {
      kind: "pause",
    },
    {
      kind: "set_route_enabled",
      route: "cctp",
      enabled: false,
    },
    {
      kind: "set_token_enabled",
      enabled: false,
    },
    {
      kind: "lower_flow_limit",
      limit: 500_000n,
    },
    {
      kind: "rotate_treasury",
      treasuryAddress: "GTREASURY_ROTATED",
    },
    {
      kind: "deliver_inbound",
      route: "cctp",
      amount: HUNDRED,
      recipient: RECIPIENT_ONE,
      sourceChain: "ethereum",
      sourceNonce: 11n,
      messageIdHex: MSG_ONE,
    },
    {
      kind: "host_crash_reload",
    },
    {
      kind: "cancel_queued_upgrade",
      candidateExecutableHashHex: ROGUE_HASH,
    },
    {
      kind: "execute_upgrade",
      executableHashHex: V2_HASH,
      runtimeVersion: 2,
      timelockDelaySeconds: 3_600n,
    },
    {
      kind: "advance_ledgers",
      ledgers: 505_000,
      seconds: 2_525_000n,
    },
    {
      kind: "keep_alive",
      claimIds: [1n, 2n],
    },
    {
      kind: "advance_ledgers",
      ledgers: 520_000,
      seconds: 2_600_000n,
    },
    {
      kind: "settle_claim",
      caller: "settler",
      claimId: 1n,
    },
    {
      kind: "restore_archived_claims",
      claimIds: [1n, 2n],
    },
    {
      kind: "set_recipient_blocked",
      recipient: RECIPIENT_ONE,
      blocked: false,
    },
    {
      kind: "settle_claim",
      caller: "settler",
      claimId: 1n,
    },
    {
      kind: "settle_claim",
      caller: "settler",
      claimId: 1n,
    },
    {
      kind: "settle_claim",
      caller: "recipient",
      claimId: 1n,
    },
    {
      kind: "execute_upgrade",
      executableHashHex: V3_HASH,
      runtimeVersion: 3,
      timelockDelaySeconds: 3_600n,
    },
    {
      kind: "unpause",
    },
    {
      kind: "settle_claim",
      caller: "admin",
      claimId: 1n,
    },
    {
      kind: "set_recipient_blocked",
      recipient: RECIPIENT_TWO,
      blocked: false,
    },
    {
      kind: "settle_claim",
      caller: "settler",
      claimId: 2n,
    },
    {
      kind: "settle_claim",
      caller: "settler",
      claimId: 2n,
    },
  ];
}

describe("claim lifecycle crash-and-upgrade harness", () => {
  it("preserves outstanding liabilities across parking, failed settlement, interruptions, upgrades, and restorations", () => {
    const transitions = runClaimLifecycleRehearsal(
      {
        initialExecutableHashHex: V1_HASH,
        initialRailBalance: HUNDRED * 3n,
        recipientAddresses: [RECIPIENT_ONE, RECIPIENT_TWO],
        initialBlockedRecipients: [RECIPIENT_ONE, RECIPIENT_TWO],
      },
      buildFullCrashAndUpgradeSequence(),
    );

    const audit = verifyClaimLifecycleTrace(transitions);
    expect(audit.valid).toBe(true);
    expect(audit.violations).toEqual([]);
    expect(audit.mintedSupply).toBe(HUNDRED * 3n);
    expect(audit.finalOutstandingLiability).toBe(0n);
    expect(audit.finalSettledTotal).toBe(HUNDRED * 3n);

    // Step 2: both claims parked, router holds 300 units.
    expect(stepAt(transitions, 1).after.claimCount).toBe(2n);
    expect(stepAt(transitions, 1).after.outstandingLiability).toBe(HUNDRED * 3n);
    expect(stepAt(transitions, 1).after.balances.router).toBe(HUNDRED * 3n);

    // Step 3: failed settlement leaves liability untouched.
    expect(stepAt(transitions, 2).outcome).toBe("RecipientNotReady");
    expect(stepAt(transitions, 2).after.outstandingLiability).toBe(HUNDRED * 3n);

    // Step 10: replay attempt during pause/disable is rejected without creating claim #3.
    expect(stepAt(transitions, 9).outcome).toBe("ReplayedMessage");
    expect(stepAt(transitions, 9).after.claimCount).toBe(2n);

    // Step 13: live upgrade to v2 preserves all claims and router custody.
    expect(stepAt(transitions, 12).phase).toBe("upgrade");
    expect(stepAt(transitions, 12).after.runtimeVersion).toBe(2);
    expect(stepAt(transitions, 12).after.executableHashHex).toBe(V2_HASH);
    expect(stepAt(transitions, 12).after.outstandingLiability).toBe(HUNDRED * 3n);

    // Step 14 & 15: TTL drops into danger zone (13_400 < 17_280) and keep_alive restores to 518_400.
    expect(stepAt(transitions, 13).after.claims[0]?.persistentTtlLedgers).toBe(13_400);
    expect(stepAt(transitions, 14).after.claims[0]?.persistentTtlLedgers).toBe(518_400);

    // Step 16..18: archival past liveUntilLedger fails cleanly, then restoration recovers full TTL.
    expect(stepAt(transitions, 15).after.claims[0]?.archived).toBe(true);
    expect(stepAt(transitions, 16).outcome).toBe("ArchivedEntryInaccessible");
    expect(stepAt(transitions, 17).after.claims[0]?.archived).toBe(false);
    expect(stepAt(transitions, 17).after.claims[0]?.persistentTtlLedgers).toBe(518_400);

    // Step 20: claim #1 settles while bridge is still paused and route/token disabled; claim #2 stays escrowed.
    expect(stepAt(transitions, 19).before.paused).toBe(true);
    expect(stepAt(transitions, 19).outcome).toBe("ok");
    expect(stepAt(transitions, 19).after.balances.recipients[RECIPIENT_ONE]).toBe(HUNDRED);
    expect(stepAt(transitions, 19).after.outstandingLiability).toBe(HUNDRED * 2n);
    expect(stepAt(transitions, 19).after.balances.router).toBe(HUNDRED * 2n);
  });

  it("rejects repeated settlement attempts across callers, upgrades, and unpause transitions", () => {
    const transitions = runClaimLifecycleRehearsal(
      {
        initialExecutableHashHex: V1_HASH,
        initialRailBalance: HUNDRED * 3n,
        recipientAddresses: [RECIPIENT_ONE, RECIPIENT_TWO],
        initialBlockedRecipients: [RECIPIENT_ONE, RECIPIENT_TWO],
      },
      buildFullCrashAndUpgradeSequence(),
    );

    const duplicateSteps = transitions.filter((t) => t.phase === "duplicate_settlement");
    expect(duplicateSteps.length).toBe(4);
    for (const step of duplicateSteps) {
      expect(step.outcome).toBe("ClaimAlreadySettled");
      expect(step.after.balances.router).toBe(step.before.balances.router);
      expect(step.after.balances.recipients).toEqual(step.before.balances.recipients);
    }

    const finalState = stepAt(transitions, transitions.length - 1).after;
    expect(finalState.balances.recipients[RECIPIENT_ONE]).toBe(HUNDRED);
    expect(finalState.balances.recipients[RECIPIENT_TWO]).toBe(HUNDRED * 2n);
    expect(finalState.balances.settler).toBe(0n);
    expect(finalState.balances.treasury).toBe(0n);
  });

  it("captures deterministic public state before and after every transition and flags injected faults", () => {
    const transitions = runClaimLifecycleRehearsal(
      {
        initialExecutableHashHex: V1_HASH,
        initialRailBalance: HUNDRED * 3n,
        recipientAddresses: [RECIPIENT_ONE, RECIPIENT_TWO],
        initialBlockedRecipients: [RECIPIENT_ONE, RECIPIENT_TWO],
      },
      buildFullCrashAndUpgradeSequence(),
    );

    for (let i = 1; i < transitions.length; i += 1) {
      expect(serializePublicSnapshot(stepAt(transitions, i).before)).toBe(
        serializePublicSnapshot(stepAt(transitions, i - 1).after),
      );
    }

    const report = formatClaimLifecycleReport(transitions);
    expect(report).toContain("claim_lifecycle_report transitions=28 valid=true");
    expect(report).toContain("phase=parking op=deliver_inbound(cctp, nonce=11) outcome=ok");
    expect(report).toContain("phase=upgrade op=execute_upgrade(v2,");
    expect(report).toContain("phase=restoration op=restore_archived_claims([1,2]) outcome=ok");
    expect(report).toContain("  before: ledger=");
    expect(report).toContain("  after:  ledger=");

    // Inject a double-pay fault on a duplicate settlement transition and prove detection.
    const corrupted: ClaimLifecycleTransition[] = transitions.map((step, idx) => {
      if (idx !== 20) return step;
      return {
        ...step,
        outcome: "ok",
        after: {
          ...step.after,
          balances: {
            ...step.after.balances,
            router: step.after.balances.router - HUNDRED,
            recipients: {
              ...step.after.balances.recipients,
              [RECIPIENT_ONE]: (step.after.balances.recipients[RECIPIENT_ONE] ?? 0n) + HUNDRED,
            },
          },
        },
      };
    });

    const corruptedAudit = verifyClaimLifecycleTrace(corrupted);
    expect(corruptedAudit.valid).toBe(false);
    expect(corruptedAudit.violations.some((v) => v.code === "DOUBLE_SETTLEMENT_PAID")).toBe(true);
    expect(corruptedAudit.violations.some((v) => v.code === "ROUTER_INSOLVENT")).toBe(true);
    expect(corruptedAudit.violations.some((v) => v.code === "SNAPSHOT_CONTINUITY_BROKEN")).toBe(
      true,
    );
  });
});
