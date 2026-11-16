import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildTimelockScheduleReport,
  formatTimelockScheduleReport,
  parseQueuedAdminAction,
  parseTimelockScheduleInput,
  RouteKind,
  TIMELOCK_GRACE_PERIOD_SECONDS,
  TIMELOCK_MIN_DELAY_SECONDS,
  TimelockScheduleFormatError,
  type TimelockScheduleInput,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const ROUTER = "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V";
const TOKEN_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const CCTP_ADAPTER = "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT";
const ITS_ADAPTER = "CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ";
const ADMIN_COLD = "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA";
const ROUTER_WASM_HASH = "ab".repeat(32);

describe("timelock schedule reports", () => {
  it("evaluates earliest execution and expiry strictly from on-chain timestamp boundaries", () => {
    const queuedAt = 1_793_200_000;
    const eta = queuedAt + TIMELOCK_MIN_DELAY_SECONDS;
    const expiresAt = eta + TIMELOCK_GRACE_PERIOD_SECONDS;

    const makeInput = (chainTimestampSeconds: number): TimelockScheduleInput => ({
      chain: "stellar-testnet",
      router: ROUTER,
      chainTimestampSeconds,
      timelockDelaySeconds: TIMELOCK_MIN_DELAY_SECONDS,
      entries: [
        {
          id: 1,
          queuedAtSeconds: queuedAt,
          action: {
            kind: "RegisterToken",
            token: TOKEN_SAC,
            decimals: 7,
            flowLimit: "1000000000000000000000000",
          },
        },
      ],
    });

    // 1 second before eta -> waiting (TimelockNotReady)
    const beforeEta = buildTimelockScheduleReport(makeInput(eta - 1));
    expect(beforeEta.actionWindows[0]?.windowState).toBe("waiting");
    expect(beforeEta.actionWindows[0]?.earliestExecutionSeconds).toBe(eta);
    expect(beforeEta.actionWindows[0]?.expiresAtSeconds).toBe(expiresAt);
    expect(beforeEta.actionWindows[0]?.secondsUntilEarliestExecution).toBe(1);
    expect(beforeEta.actionWindows[0]?.secondsUntilExpiry).toBe(TIMELOCK_GRACE_PERIOD_SECONDS + 1);
    expect(beforeEta.runnableOperations).toHaveLength(0);

    // Exact eta -> runnable (inclusive lower bound)
    const atEta = buildTimelockScheduleReport(makeInput(eta));
    expect(atEta.actionWindows[0]?.windowState).toBe("runnable");
    expect(atEta.actionWindows[0]?.secondsUntilEarliestExecution).toBe(0);
    expect(atEta.actionWindows[0]?.secondsUntilExpiry).toBe(TIMELOCK_GRACE_PERIOD_SECONDS);
    expect(atEta.runnableOperations.map((op) => op.id)).toEqual([1]);

    // Exact expiresAt -> runnable (inclusive upper bound)
    const atExpiry = buildTimelockScheduleReport(makeInput(expiresAt));
    expect(atExpiry.actionWindows[0]?.windowState).toBe("runnable");
    expect(atExpiry.actionWindows[0]?.secondsUntilExpiry).toBe(0);
    expect(atExpiry.runnableOperations.map((op) => op.id)).toEqual([1]);

    // 1 second after expiresAt -> expired (TimelockExpired)
    const afterExpiry = buildTimelockScheduleReport(makeInput(expiresAt + 1));
    expect(afterExpiry.actionWindows[0]?.windowState).toBe("expired");
    expect(afterExpiry.actionWindows[0]?.secondsUntilExpiry).toBe(0);
    expect(afterExpiry.runnableOperations).toHaveLength(0);
    expect(afterExpiry.excludedOperations.map((op) => ({ id: op.id, reason: op.reason }))).toEqual([
      { id: 1, reason: "expired" },
    ]);
  });

  it("excludes expired, cancelled and executed actions from runnable operations and blocks dependents", () => {
    const baseTime = 1_793_300_000;

    const report = buildTimelockScheduleReport({
      chain: "stellar-testnet",
      router: ROUTER,
      chainTimestampSeconds: baseTime + 10_000,
      entries: [
        {
          // Already executed earlier
          id: 1,
          queuedAtSeconds: baseTime - 20_000,
          etaSeconds: baseTime - 16_400,
          expiresAtSeconds: baseTime + 588_400,
          executed: true,
          action: {
            kind: "RegisterToken",
            token: TOKEN_SAC,
            decimals: 7,
            flowLimit: "10000000000000",
          },
        },
        {
          // Expired adapter setup for CCTP -> excluded AND blocks CCTP EnableRoute (id 4) + SetAdmin (id 7)
          id: 2,
          queuedAtSeconds: baseTime - 700_000,
          etaSeconds: baseTime - 696_400,
          expiresAtSeconds: baseTime - 91_600,
          action: {
            kind: "SetAdapter",
            route: RouteKind.Cctp,
            adapter: CCTP_ADAPTER,
          },
        },
        {
          // Cancelled receiver setup for CCTP -> excluded
          id: 3,
          queuedAtSeconds: baseTime,
          etaSeconds: baseTime + 3_600,
          expiresAtSeconds: baseTime + 608_400,
          cancelled: true,
          action: {
            kind: "SetRailReceiver",
            route: RouteKind.Cctp,
            receiver: CCTP_ADAPTER,
          },
        },
        {
          // Matured window, but its CCTP adapter/receiver prerequisites are expired/cancelled!
          id: 4,
          queuedAtSeconds: baseTime,
          etaSeconds: baseTime + 3_600,
          expiresAtSeconds: baseTime + 608_400,
          action: {
            kind: "EnableRoute",
            route: RouteKind.Cctp,
            enabled: true,
          },
        },
        {
          // Matured ITS adapter -> runnable
          id: 5,
          queuedAtSeconds: baseTime,
          etaSeconds: baseTime + 3_600,
          expiresAtSeconds: baseTime + 608_400,
          action: {
            kind: "SetAdapter",
            route: RouteKind.AxelarIts,
            adapter: ITS_ADAPTER,
          },
        },
        {
          // Matured ITS enablement (RegisterToken id 1 executed, SetAdapter id 5 runnable) -> runnable after id 5
          id: 6,
          queuedAtSeconds: baseTime,
          etaSeconds: baseTime + 3_610,
          expiresAtSeconds: baseTime + 608_410,
          action: {
            kind: "EnableRoute",
            route: RouteKind.AxelarIts,
            enabled: true,
          },
        },
        {
          // Matured SetAdmin -> held back because CCTP prerequisites (ids 2, 3) need requeueing
          id: 7,
          queuedAtSeconds: baseTime,
          etaSeconds: baseTime + 3_620,
          expiresAtSeconds: baseTime + 608_420,
          action: {
            kind: "SetAdmin",
            admin: ADMIN_COLD,
          },
        },
      ],
    });

    expect(report.excludedOperations.map((op) => ({ id: op.id, reason: op.reason }))).toEqual([
      { id: 1, reason: "executed" },
      { id: 2, reason: "expired" },
      { id: 3, reason: "cancelled" },
    ]);

    // Only ITS SetAdapter (5) and ITS EnableRoute (6) are runnable right now, in sequence order.
    expect(report.runnableOperations.map((op) => op.id)).toEqual([5, 6]);

    const cctpEnableStep = report.requiredSequence.find((step) => step.id === 4);
    expect(cctpEnableStep?.runnableNow).toBe(false);
    expect(cctpEnableStep?.requeueRequired).toBe(true);
    expect(cctpEnableStep?.blockingPrerequisiteIds).toEqual([2, 3]);

    const setAdminStep = report.requiredSequence.find((step) => step.id === 7);
    expect(setAdminStep?.runnableNow).toBe(false);
    expect(setAdminStep?.requeueRequired).toBe(true);
    expect(report.allPendingExecutableAtSeconds).toBeNull();
  });

  it("orders router Upgrade first and SetAdmin last regardless of queued id or input order", () => {
    const baseTime = 1_793_263_750;

    // Mirrors 2026-10-29-cctp.json where Upgrade (id 8) was queued AFTER SetAdapter/SetRailReceiver/EnableRoute (ids 5..7).
    const waitingUpgradeReport = buildTimelockScheduleReport({
      chain: "stellar-testnet",
      router: ROUTER,
      chainTimestampSeconds: baseTime + 3_750,
      entries: [
        {
          id: 9,
          queuedAtSeconds: baseTime,
          etaSeconds: baseTime + 3_600,
          action: { kind: "SetAdmin", admin: ADMIN_COLD },
        },
        {
          id: 7,
          queuedAtSeconds: baseTime + 20,
          etaSeconds: baseTime + 3_620,
          action: { kind: "EnableRoute", route: RouteKind.Cctp, enabled: true },
        },
        {
          id: 6,
          queuedAtSeconds: baseTime + 10,
          etaSeconds: baseTime + 3_610,
          action: { kind: "SetRailReceiver", route: RouteKind.Cctp, receiver: CCTP_ADAPTER },
        },
        {
          id: 5,
          queuedAtSeconds: baseTime,
          etaSeconds: baseTime + 3_600,
          action: { kind: "SetAdapter", route: RouteKind.Cctp, adapter: CCTP_ADAPTER },
        },
        {
          id: 8,
          queuedAtSeconds: baseTime + 765,
          etaSeconds: baseTime + 4_365,
          action: { kind: "Upgrade", target: ROUTER_WASM_HASH },
        },
      ],
    });

    // Sequence strictly orders: Upgrade (8) -> SetAdapter (5) -> SetRailReceiver (6) -> EnableRoute (7) -> SetAdmin (9)
    expect(waitingUpgradeReport.requiredSequence.map((step) => step.id)).toEqual([8, 5, 6, 7, 9]);
    expect(waitingUpgradeReport.allPendingExecutableAtSeconds).toBe(baseTime + 4_365);
    // While Upgrade (8) is still waiting, none of 5, 6, 7, 9 are runnable yet!
    expect(waitingUpgradeReport.runnableOperations).toHaveLength(0);

    // Once chain timestamp reaches Upgrade eta, all 5 become runnable in exact sequence order.
    const maturedReport = buildTimelockScheduleReport({
      chain: "stellar-testnet",
      router: ROUTER,
      chainTimestampSeconds: baseTime + 4_365,
      entries: waitingUpgradeReport.actionWindows.map((win) => ({
        id: win.id,
        queuedAtSeconds: win.queuedAtSeconds,
        etaSeconds: win.earliestExecutionSeconds,
        expiresAtSeconds: win.expiresAtSeconds,
        action: win.action,
      })),
    });
    expect(maturedReport.runnableOperations.map((op) => op.id)).toEqual([8, 5, 6, 7, 9]);
  });

  it("is strictly read-only and deterministic across repeated calls and historical evidence snapshots", () => {
    const rawItsEvidence: unknown = JSON.parse(
      readFileSync(resolve(repoRoot, "deployments/evidence/2026-10-28-paid-its.json"), "utf8"),
    );
    const snapshotBefore = JSON.stringify(rawItsEvidence);

    const parsedForward = parseTimelockScheduleInput(rawItsEvidence, 1_793_196_425);
    const reversedInput: TimelockScheduleInput = {
      ...parsedForward,
      entries: [...parsedForward.entries].reverse(),
    };

    const reportA = buildTimelockScheduleReport(parsedForward);
    const reportB = buildTimelockScheduleReport(parsedForward);
    const reportReversed = buildTimelockScheduleReport(reversedInput);

    // Zero mutation of caller objects
    expect(JSON.stringify(rawItsEvidence)).toBe(snapshotBefore);

    // Byte-for-byte deterministic output across repeated calls and shuffled entry order
    expect(reportA).toEqual(reportB);
    expect(reportA).toEqual(reportReversed);
    expect(formatTimelockScheduleReport(reportA)).toBe(
      formatTimelockScheduleReport(reportReversed),
    );
    expect(reportA.runnableOperations.map((op) => op.id)).toEqual([1, 2, 3, 4]);
    expect(reportA.scopeNotice).toBeNull();

    // Also parse 2026-10-29-cctp.json (which combines queuedActions + routerUpgrade with executed: true)
    const rawCctpEvidence: unknown = JSON.parse(
      readFileSync(resolve(repoRoot, "deployments/evidence/2026-10-29-cctp.json"), "utf8"),
    );
    const cctpParsed = parseTimelockScheduleInput(rawCctpEvidence, 1_793_268_224);
    const cctpReport = buildTimelockScheduleReport(cctpParsed);
    expect(cctpReport.counts.executed).toBe(4);
    expect(cctpReport.runnableOperations).toHaveLength(0);
  });

  it("preserves exact integer strings, flags gated EVM/rail scopes, and rejects invalid inputs", () => {
    const action = parseQueuedAdminAction(
      {
        RegisterToken: [
          "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          18,
          "340282366920938463463374607431768211455",
        ],
      },
      "evm",
    );
    expect(action).toEqual({
      kind: "RegisterToken",
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 18,
      flowLimit: "340282366920938463463374607431768211455",
    });

    const evmReport = buildTimelockScheduleReport({
      chain: "sepolia",
      router: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      chainTimestampSeconds: 1_800_005_000,
      entries: [
        {
          id: 1,
          queuedAtSeconds: 1_800_000_000,
          action,
        },
      ],
    });
    expect(evmReport.scopeNotice).toContain("gated");
    expect(formatTimelockScheduleReport(evmReport)).toContain(
      "340282366920938463463374607431768211455",
    );

    // Reject numeric (non-string) flowLimit so precision cannot silently degrade
    expect(() => {
      parseQueuedAdminAction(["RegisterToken", TOKEN_SAC, 7, 10_000_000], "stellar");
    }).toThrow(TimelockScheduleFormatError);

    // Reject missing chainTimestampSeconds (never fall back to wall-clock Date.now())
    expect(() => {
      parseTimelockScheduleInput({
        chain: "stellar-testnet",
        router: ROUTER,
        entries: [],
      });
    }).toThrow(TimelockScheduleFormatError);
  });
});
