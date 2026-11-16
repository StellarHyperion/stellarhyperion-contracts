import { describe, expect, it } from "vitest";
import {
  executeQueuedActionAtTimestamp,
  formatRehearsalReport,
  isLocalRehearsalEvidence,
  MIN_ROUTER_TIMELOCK_DELAY_SECONDS,
  ROUTER_TIMELOCK_GRACE_PERIOD_SECONDS,
  runLocalStellarActivationRehearsal,
  type StellarActivationRehearsalInput,
} from "../src/index.js";
import { C_ADDR, G_ADDR, USDC_MAINNET_ISSUER } from "./fixtures.js";

function buildBaseRehearsalInput(): StellarActivationRehearsalInput {
  return {
    chain: "stellar-testnet",
    router: "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V",
    routerWasmHash: "a".repeat(64),
    deployer: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
    finalAdmin: G_ADDR,
    guardian: G_ADDR,
    treasury: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
    feeBps: 30,
    flowWindowLedgers: 720,
    timelockDelaySeconds: MIN_ROUTER_TIMELOCK_DELAY_SECONDS,
    token: {
      code: "USDC",
      issuer: USDC_MAINNET_ISSUER,
      sacId: C_ADDR,
      decimals: 7,
      // Above 2^53 to verify exact decimal-string integer preservation.
      flowLimit: "90071992547409930000",
    },
    axelar: {
      adapter: "CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ",
      itsContract: "CC7LAC4S7KAPIM26WKWFSOXWLNLSG7EXTC2EVY2H2UPKSTX3Z2A7M5YP",
      wasmHash: "b".repeat(64),
      peerChain: "sepolia",
      axelarChainName: "ethereum-sepolia",
      peerHex20: "0".repeat(40),
      tokenIdHex32: "c".repeat(64),
    },
    cctp: {
      adapter: "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT",
      tokenMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
      messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
      wasmHash: "d".repeat(64),
      peerChain: "sepolia",
      peerDomain: 0,
      destinationCallerHex32: "0".repeat(64),
      peerBurnTokenHex32: "0000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238",
    },
    interruptPhaseTwoAfterCount: 3,
  };
}

describe("runLocalStellarActivationRehearsal", () => {
  it("proves early execution rejection without bootstrap exemptions", () => {
    // Any attempt to configure a timelock below the 3600s floor is refused immediately.
    expect(() =>
      runLocalStellarActivationRehearsal({
        ...buildBaseRehearsalInput(),
        timelockDelaySeconds: 0,
      }),
    ).toThrow(/TimelockDelayOutOfRange/);
    expect(() =>
      runLocalStellarActivationRehearsal({
        ...buildBaseRehearsalInput(),
        timelockDelaySeconds: 3_599,
      }),
    ).toThrow(/bootstrap exemptions are forbidden/);

    const report = runLocalStellarActivationRehearsal(buildBaseRehearsalInput());
    expect(report.healthy).toBe(true);
    expect(report.bootstrapExemptionAllowed).toBe(false);
    expect(report.earlyExecutionRejected).toBe(true);
    expect(report.earlyExecutionProbes).toHaveLength(2);
    for (const probe of report.earlyExecutionProbes) {
      expect(probe.rejected).toBe(true);
      expect(probe.attemptedAtSeconds).toBeLessThan(probe.etaSeconds);
      expect(probe.errorCode).toBe("TimelockNotReady");
      expect(probe.contractError).toBe("Error(Contract, #23)");
    }

    // Also verify post-grace-period expiry semantics match timelock.rs (`now > expires_at`).
    const sampleQueued = report.queuedActions[0]!;
    expect(executeQueuedActionAtTimestamp(sampleQueued, sampleQueued.eta).ok).toBe(true);
    expect(executeQueuedActionAtTimestamp(sampleQueued, sampleQueued.expiresAt).ok).toBe(true);
    const expired = executeQueuedActionAtTimestamp(sampleQueued, sampleQueued.expiresAt + 1);
    expect(expired).toEqual({ ok: false, code: "TimelockExpired" });
    expect(sampleQueued.expiresAt - sampleQueued.eta).toBe(ROUTER_TIMELOCK_GRACE_PERIOD_SECONDS);
  });

  it("preserves intended configuration across interrupted and repeated phase-two operations", () => {
    const report = runLocalStellarActivationRehearsal(buildBaseRehearsalInput());

    // 1 token + 3 CCTP + 3 Axelar + 1 SetAdmin handover = 8 queued actions.
    expect(report.queuedActions).toHaveLength(8);
    expect(report.duplicateQueueProbePreservedIds).toBe(true);

    // Pass 1 stopped after 3 actions, Pass 2 finished the remaining 5 (including SetAdmin to G_ADDR),
    // and Pass 3 repeated phase-two and skipped all 8 without mutating router state.
    expect(report.phaseTwoPasses).toHaveLength(3);
    const [partialPass, completionPass, repeatPass] = report.phaseTwoPasses;
    expect(partialPass!.executedIds).toEqual([1, 2, 3]);
    expect(partialPass!.remainingQueuedIds).toEqual([4, 5, 6, 7, 8]);

    expect(completionPass!.skippedIds).toEqual([1, 2, 3]);
    expect(completionPass!.executedIds).toEqual([4, 5, 6, 7, 8]);
    expect(completionPass!.remainingQueuedIds).toEqual([]);

    expect(repeatPass!.executedIds).toEqual([]);
    expect(repeatPass!.skippedIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(repeatPass!.routerSnapshot).toEqual(completionPass!.routerSnapshot);
    expect(report.configurationPreservedOnRepeat).toBe(true);

    // Exact integer flowLimit above 2^53 and finalAdmin handover are preserved verbatim.
    expect(repeatPass!.routerSnapshot.admin).toBe(G_ADDR);
    expect(repeatPass!.routerSnapshot.tokens[C_ADDR]?.flowLimit).toBe("90071992547409930000");
    expect(report.verificationPassed).toBe(true);
  });

  it("identifies local fixture rehearsal reports separately from signed testnet acceptance", () => {
    const report = runLocalStellarActivationRehearsal(buildBaseRehearsalInput());

    expect(report.environment).toBe("local-soroban-rehearsal");
    expect(report.evidenceKind).toBe("local-fixture-rehearsal");
    expect(report.signedTestnetAcceptance).toBe(false);
    expect(report.countsAsPublicTestnetDelivery).toBe(false);
    expect(report.evmRailsGated).toBe(true);
    expect(isLocalRehearsalEvidence(report)).toBe(true);
    expect(
      isLocalRehearsalEvidence({
        status: "active-acceptance-verified",
        acceptance: { status: "delivered" },
      }),
    ).toBe(false);

    const formatted = formatRehearsalReport(report);
    expect(formatted).toContain("LOCAL FIXTURE REHEARSAL REPORT (NOT SIGNED TESTNET ACCEPTANCE)");
    expect(formatted).toContain("signedTestnetAcceptance=false");
  });
});
