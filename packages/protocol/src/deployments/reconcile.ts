/**
 * Public transaction reconciliation for interrupted two-phase activation.
 *
 * Evaluates known transaction hashes from an interrupted deployment or activation run against
 * public RPC transaction observations and live on-chain contract configuration:
 * - Unknown lookups (`not-found`, `rpc-unreachable`, or missing) never propose duplicate
 *   irreversible operations.
 * - Confirmed transactions are checked against actual live router/adapter configuration.
 * - Hashes originating from a different network (`networkPassphrase` / `chainId`), sender, or
 *   target contract are rejected with `provenance-mismatch` and can never prove an intended step.
 */
import { isStellarAddress } from "../addresses.js";
import { CHAINS, isChainKey, isEvmChain, isStellarChain, type ChainKey } from "../chains.js";
import type { RouteKind } from "../routes.js";

export type ExpectedConfigurationEffect =
  | {
      readonly kind: "router-initialized";
      readonly admin: string;
      readonly timelockDelay: number;
      readonly feeBps: number;
    }
  | {
      readonly kind: "action-queued";
      readonly actionId: number;
    }
  | {
      readonly kind: "action-executed";
      readonly actionId: number;
      readonly tokenSacId?: string | undefined;
      readonly expectedFlowLimit?: string | undefined;
      readonly route?: RouteKind | undefined;
      readonly expectedAdapter?: string | undefined;
      readonly expectedEnabled?: boolean | undefined;
    }
  | {
      readonly kind: "axelar-lane-linked";
      readonly peerChain: ChainKey;
      readonly axelarChainName: string;
      readonly peerHex20: string;
    }
  | {
      readonly kind: "axelar-token-mapped";
      readonly sacId: string;
      readonly tokenIdHex32: string;
    }
  | {
      readonly kind: "cctp-domain-linked";
      readonly peerChain: ChainKey;
      readonly domain: number;
      readonly destinationCallerHex32: string;
    }
  | {
      readonly kind: "cctp-asset-mapped";
      readonly domain: number;
      readonly sacId: string;
      readonly burnTokenHex32: string;
    };

export interface ExpectedActivationTransaction {
  readonly stepId: string;
  readonly hash: string;
  readonly chain: ChainKey;
  readonly expectedNetworkPassphrase?: string | undefined;
  readonly expectedChainId?: number | undefined;
  readonly expectedSender: string;
  readonly expectedTargetContract: string;
  readonly irreversible: boolean;
  readonly expectedEffect: ExpectedConfigurationEffect;
}

export type PublicLookupState = "confirmed" | "failed" | "not-found" | "rpc-unreachable";

export interface PublicTransactionObservation {
  readonly hash: string;
  readonly lookupState: PublicLookupState;
  readonly observedChain?: ChainKey | undefined;
  readonly observedNetworkPassphrase?: string | undefined;
  readonly observedChainId?: number | undefined;
  readonly observedSender?: string | undefined;
  readonly observedTargetContract?: string | undefined;
  readonly ledgerOrBlock?: number | string | undefined;
  readonly diagnostic?: string | undefined;
}

export interface LiveActivationStateSnapshot {
  readonly reachable: boolean;
  readonly router?:
    | {
        readonly initialized: boolean;
        readonly admin: string;
        readonly timelockDelay: number;
        readonly feeBps: number;
        readonly pendingActionIds: readonly number[];
        readonly tokens?:
          | Readonly<
              Record<
                string,
                {
                  readonly enabled: boolean;
                  readonly decimals: number;
                  readonly flowLimit: string;
                }
              >
            >
          | undefined;
        readonly adapters?: Readonly<Partial<Record<RouteKind, string>>> | undefined;
        readonly enabledRoutes?: Readonly<Partial<Record<RouteKind, boolean>>> | undefined;
      }
    | undefined;
  readonly axelarAdapter?:
    | {
        readonly links?:
          | Readonly<
              Record<
                string,
                {
                  readonly axelarChainName: string;
                  readonly peerHex20: string;
                }
              >
            >
          | undefined;
        readonly tokenIds?: Readonly<Record<string, string>> | undefined;
      }
    | undefined;
  readonly cctpAdapter?:
    | {
        readonly domains?:
          | Readonly<
              Record<
                string,
                {
                  readonly domain: number;
                  readonly destinationCallerHex32: string;
                }
              >
            >
          | undefined;
        readonly mappedBurnTokensByDomain?:
          | Readonly<
              Record<
                number,
                {
                  readonly sacId: string;
                  readonly burnTokenHex32: string;
                }
              >
            >
          | undefined;
      }
    | undefined;
}

export type ReconciledStepOutcome =
  | "confirmed-verified"
  | "confirmed-state-drift"
  | "provenance-mismatch"
  | "failed-safe-to-retry"
  | "failed-already-applied"
  | "unknown";

export type ReconciledOperatorProposal =
  | "mark-complete"
  | "halt-and-investigate-drift"
  | "reject-foreign-hash"
  | "safe-to-resubmit"
  | "skip-effect-already-live"
  | "wait-and-query-never-duplicate";

export interface ReconciledTransactionResult {
  readonly stepId: string;
  readonly hash: string;
  readonly outcome: ReconciledStepOutcome;
  readonly provesIntendedAction: boolean;
  readonly liveConfigMatches: boolean | null;
  readonly allowDuplicateSubmission: boolean;
  readonly proposal: ReconciledOperatorProposal;
  readonly detail: string;
}

export interface ActivationReconciliationReport {
  readonly healthy: boolean;
  readonly summary: {
    readonly total: number;
    readonly confirmedVerifiedCount: number;
    readonly stateDriftCount: number;
    readonly provenanceMismatchCount: number;
    readonly failedRetryableCount: number;
    readonly failedAlreadyAppliedCount: number;
    readonly unknownCount: number;
  };
  readonly results: readonly ReconciledTransactionResult[];
}

function normalizeHex(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
}

function normalizeAddress(value: string, family: "evm" | "stellar"): string {
  const trimmed = value.trim();
  return family === "evm" ? trimmed.toLowerCase() : trimmed;
}

function validateIntent(intent: ExpectedActivationTransaction): void {
  if (!isChainKey(intent.chain)) {
    throw new Error(`Unknown chain key "${String(intent.chain)}" in step "${intent.stepId}".`);
  }
  const hashHex = normalizeHex(intent.hash);
  if (!/^[0-9a-f]{64}$/.test(hashHex)) {
    throw new Error(`Invalid 32-byte transaction hash in step "${intent.stepId}".`);
  }
  const chainEntry = CHAINS[intent.chain];
  if (chainEntry.family === "stellar") {
    if (!isStellarAddress(intent.expectedSender)) {
      throw new Error(`Invalid Stellar sender in step "${intent.stepId}".`);
    }
    if (
      !intent.expectedTargetContract.startsWith("C") ||
      !isStellarAddress(intent.expectedTargetContract)
    ) {
      throw new Error(`Invalid Soroban target contract in step "${intent.stepId}".`);
    }
  } else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(intent.expectedSender)) {
      throw new Error(`Invalid EVM sender in step "${intent.stepId}".`);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(intent.expectedTargetContract)) {
      throw new Error(`Invalid EVM target contract in step "${intent.stepId}".`);
    }
  }
}

function checkProvenance(
  intent: ExpectedActivationTransaction,
  obs: PublicTransactionObservation,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (normalizeHex(intent.hash) !== normalizeHex(obs.hash)) {
    return {
      ok: false,
      reason: `Observed hash ${obs.hash} does not match expected hash ${intent.hash}.`,
    };
  }
  const chainEntry = CHAINS[intent.chain];
  if (obs.observedChain !== undefined && obs.observedChain !== intent.chain) {
    return {
      ok: false,
      reason: `Transaction landed on chain "${obs.observedChain}" rather than expected "${intent.chain}".`,
    };
  }
  if (isStellarChain(chainEntry)) {
    const wantPassphrase = intent.expectedNetworkPassphrase ?? chainEntry.networkPassphrase;
    if (obs.observedNetworkPassphrase === undefined) {
      return {
        ok: false,
        reason: "Stellar transaction observation is missing networkPassphrase binding.",
      };
    }
    if (obs.observedNetworkPassphrase !== wantPassphrase) {
      return {
        ok: false,
        reason: `Network passphrase mismatch: observed "${obs.observedNetworkPassphrase}" vs expected "${wantPassphrase}".`,
      };
    }
  } else if (isEvmChain(chainEntry)) {
    const wantChainId = intent.expectedChainId ?? chainEntry.chainId;
    if (obs.observedChainId === undefined) {
      return {
        ok: false,
        reason: "EVM transaction observation is missing chainId binding.",
      };
    }
    if (obs.observedChainId !== wantChainId) {
      return {
        ok: false,
        reason: `Chain ID mismatch: observed ${String(obs.observedChainId)} vs expected ${String(wantChainId)}.`,
      };
    }
  }

  if (obs.observedSender === undefined) {
    return { ok: false, reason: "Transaction observation is missing sender address." };
  }
  if (
    normalizeAddress(obs.observedSender, chainEntry.family) !==
    normalizeAddress(intent.expectedSender, chainEntry.family)
  ) {
    return {
      ok: false,
      reason: `Sender mismatch: observed ${obs.observedSender} vs expected ${intent.expectedSender}.`,
    };
  }

  if (obs.observedTargetContract === undefined) {
    return { ok: false, reason: "Transaction observation is missing target contract address." };
  }
  if (
    normalizeAddress(obs.observedTargetContract, chainEntry.family) !==
    normalizeAddress(intent.expectedTargetContract, chainEntry.family)
  ) {
    return {
      ok: false,
      reason: `Target contract mismatch: observed ${obs.observedTargetContract} vs expected ${intent.expectedTargetContract}.`,
    };
  }

  return { ok: true };
}

function evaluateLiveEffect(
  effect: ExpectedConfigurationEffect,
  family: "evm" | "stellar",
  live: LiveActivationStateSnapshot,
): { readonly matches: boolean | null; readonly reason: string } {
  if (!live.reachable) {
    return { matches: null, reason: "Live contract state snapshot is unreachable." };
  }

  switch (effect.kind) {
    case "router-initialized": {
      if (live.router === undefined) {
        return { matches: null, reason: "Router state missing from live snapshot." };
      }
      if (!live.router.initialized) {
        return { matches: false, reason: "Live router is not initialized." };
      }
      const adminOk =
        normalizeAddress(live.router.admin, family) === normalizeAddress(effect.admin, family);
      const delayOk = live.router.timelockDelay === effect.timelockDelay;
      const feeOk = live.router.feeBps === effect.feeBps;
      if (!adminOk || !delayOk || !feeOk) {
        return {
          matches: false,
          reason: `Live router config (admin=${live.router.admin}, timelock=${String(live.router.timelockDelay)}, feeBps=${String(live.router.feeBps)}) differs from expected.`,
        };
      }
      return { matches: true, reason: "Live router initialization config matches." };
    }
    case "action-queued": {
      if (live.router === undefined) {
        return { matches: null, reason: "Router state missing from live snapshot." };
      }
      if (live.router.pendingActionIds.includes(effect.actionId)) {
        return {
          matches: true,
          reason: `Action ${String(effect.actionId)} is present in live router queue.`,
        };
      }
      return {
        matches: false,
        reason: `Action ${String(effect.actionId)} is absent from live router queue.`,
      };
    }
    case "action-executed": {
      if (live.router === undefined) {
        return { matches: null, reason: "Router state missing from live snapshot." };
      }
      if (live.router.pendingActionIds.includes(effect.actionId)) {
        return {
          matches: false,
          reason: `Action ${String(effect.actionId)} is still pending in live router queue.`,
        };
      }
      if (effect.tokenSacId !== undefined) {
        const tok = live.router.tokens?.[effect.tokenSacId];
        if (!tok?.enabled) {
          return {
            matches: false,
            reason: `Token ${effect.tokenSacId} is not enabled on live router.`,
          };
        }
        if (effect.expectedFlowLimit !== undefined && tok.flowLimit !== effect.expectedFlowLimit) {
          return {
            matches: false,
            reason: `Token flowLimit ${tok.flowLimit} disagrees with expected ${effect.expectedFlowLimit}.`,
          };
        }
      }
      if (effect.route !== undefined) {
        if (effect.expectedAdapter !== undefined) {
          const actualAdapter = live.router.adapters?.[effect.route];
          if (
            actualAdapter === undefined ||
            normalizeAddress(actualAdapter, family) !==
              normalizeAddress(effect.expectedAdapter, family)
          ) {
            return {
              matches: false,
              reason: `Live adapter ${String(actualAdapter)} disagrees with expected ${effect.expectedAdapter}.`,
            };
          }
        }
        if (effect.expectedEnabled !== undefined) {
          const actualEnabled = live.router.enabledRoutes?.[effect.route] ?? false;
          if (actualEnabled !== effect.expectedEnabled) {
            return {
              matches: false,
              reason: `Route ${String(effect.route)} enabled=${String(actualEnabled)} disagrees with expected ${String(effect.expectedEnabled)}.`,
            };
          }
        }
      }
      return {
        matches: true,
        reason: `Executed action ${String(effect.actionId)} matches live router configuration.`,
      };
    }
    case "axelar-lane-linked": {
      const link = live.axelarAdapter?.links?.[effect.peerChain];
      if (link === undefined) {
        return {
          matches: false,
          reason: `No live Axelar link configured for peer "${effect.peerChain}".`,
        };
      }
      if (
        link.axelarChainName !== effect.axelarChainName ||
        normalizeHex(link.peerHex20) !== normalizeHex(effect.peerHex20)
      ) {
        return {
          matches: false,
          reason: `Live Axelar link (${link.axelarChainName}, ${link.peerHex20}) disagrees with expected (${effect.axelarChainName}, ${effect.peerHex20}).`,
        };
      }
      return { matches: true, reason: "Live Axelar peer link matches." };
    }
    case "axelar-token-mapped": {
      const tokenId = live.axelarAdapter?.tokenIds?.[effect.sacId];
      if (tokenId === undefined || normalizeHex(tokenId) !== normalizeHex(effect.tokenIdHex32)) {
        return {
          matches: false,
          reason: `Live Axelar tokenId ${String(tokenId)} disagrees with expected ${effect.tokenIdHex32}.`,
        };
      }
      return { matches: true, reason: "Live Axelar token mapping matches." };
    }
    case "cctp-domain-linked": {
      const dom = live.cctpAdapter?.domains?.[effect.peerChain];
      if (dom === undefined) {
        return {
          matches: false,
          reason: `No live CCTP domain link configured for peer "${effect.peerChain}".`,
        };
      }
      if (
        dom.domain !== effect.domain ||
        normalizeHex(dom.destinationCallerHex32) !== normalizeHex(effect.destinationCallerHex32)
      ) {
        return {
          matches: false,
          reason: `Live CCTP domain link (${String(dom.domain)}, ${dom.destinationCallerHex32}) disagrees with expected.`,
        };
      }
      return { matches: true, reason: "Live CCTP domain link matches." };
    }
    case "cctp-asset-mapped": {
      const mapped = live.cctpAdapter?.mappedBurnTokensByDomain?.[effect.domain];
      if (
        mapped === undefined ||
        normalizeAddress(mapped.sacId, family) !== normalizeAddress(effect.sacId, family) ||
        normalizeHex(mapped.burnTokenHex32) !== normalizeHex(effect.burnTokenHex32)
      ) {
        return {
          matches: false,
          reason: `Live CCTP asset mapping on domain ${String(effect.domain)} disagrees with expected.`,
        };
      }
      return { matches: true, reason: "Live CCTP asset mapping matches." };
    }
  }
}

export function reconcileActivationTransactions(
  intents: readonly ExpectedActivationTransaction[],
  observations: readonly PublicTransactionObservation[],
  liveState: LiveActivationStateSnapshot,
): ActivationReconciliationReport {
  const byHash = new Map<string, PublicTransactionObservation>();
  for (const obs of observations) {
    byHash.set(normalizeHex(obs.hash), obs);
  }

  const results: ReconciledTransactionResult[] = [];

  for (const intent of intents) {
    validateIntent(intent);
    const family = CHAINS[intent.chain].family;
    const obs = byHash.get(normalizeHex(intent.hash));

    if (
      obs === undefined ||
      obs.lookupState === "not-found" ||
      obs.lookupState === "rpc-unreachable"
    ) {
      const why =
        obs === undefined
          ? "No public transaction observation supplied."
          : `Public lookup returned ${obs.lookupState}${obs.diagnostic !== undefined ? ` (${obs.diagnostic})` : ""}.`;
      results.push({
        stepId: intent.stepId,
        hash: intent.hash,
        outcome: "unknown",
        provesIntendedAction: false,
        liveConfigMatches: null,
        allowDuplicateSubmission: false,
        proposal: "wait-and-query-never-duplicate",
        detail: `${why} Outcome is unknown; never resubmit an irreversible activation transaction blindly.`,
      });
      continue;
    }

    const provenance = checkProvenance(intent, obs);
    if (!provenance.ok) {
      results.push({
        stepId: intent.stepId,
        hash: intent.hash,
        outcome: "provenance-mismatch",
        provesIntendedAction: false,
        liveConfigMatches: null,
        allowDuplicateSubmission: false,
        proposal: "reject-foreign-hash",
        detail: provenance.reason,
      });
      continue;
    }

    const liveEval = evaluateLiveEffect(intent.expectedEffect, family, liveState);

    if (obs.lookupState === "confirmed") {
      if (liveEval.matches === true) {
        results.push({
          stepId: intent.stepId,
          hash: intent.hash,
          outcome: "confirmed-verified",
          provesIntendedAction: true,
          liveConfigMatches: true,
          allowDuplicateSubmission: false,
          proposal: "mark-complete",
          detail: `Transaction confirmed with valid provenance and verified against live state: ${liveEval.reason}`,
        });
      } else {
        results.push({
          stepId: intent.stepId,
          hash: intent.hash,
          outcome: "confirmed-state-drift",
          provesIntendedAction: false,
          liveConfigMatches: liveEval.matches,
          allowDuplicateSubmission: false,
          proposal: "halt-and-investigate-drift",
          detail: `Transaction confirmed on chain, but live configuration check did not match: ${liveEval.reason}`,
        });
      }
      continue;
    }

    // obs.lookupState === "failed" with matching provenance
    if (liveEval.matches === null) {
      results.push({
        stepId: intent.stepId,
        hash: intent.hash,
        outcome: "unknown",
        provesIntendedAction: false,
        liveConfigMatches: null,
        allowDuplicateSubmission: false,
        proposal: "wait-and-query-never-duplicate",
        detail: `Transaction failed on chain, but live state could not be verified (${liveEval.reason}); refusing blind duplicate operation.`,
      });
    } else if (liveEval.matches) {
      results.push({
        stepId: intent.stepId,
        hash: intent.hash,
        outcome: "failed-already-applied",
        provesIntendedAction: false,
        liveConfigMatches: true,
        allowDuplicateSubmission: false,
        proposal: "skip-effect-already-live",
        detail: `Transaction failed on chain, and live state already reflects the intended configuration (${liveEval.reason}); do not resubmit.`,
      });
    } else {
      results.push({
        stepId: intent.stepId,
        hash: intent.hash,
        outcome: "failed-safe-to-retry",
        provesIntendedAction: false,
        liveConfigMatches: false,
        allowDuplicateSubmission: true,
        proposal: "safe-to-resubmit",
        detail: `Transaction definitively failed on ${intent.chain} from ${intent.expectedSender} and live state confirms effect is absent (${liveEval.reason}).`,
      });
    }
  }

  let confirmedVerifiedCount = 0;
  let stateDriftCount = 0;
  let provenanceMismatchCount = 0;
  let failedRetryableCount = 0;
  let failedAlreadyAppliedCount = 0;
  let unknownCount = 0;

  for (const r of results) {
    switch (r.outcome) {
      case "confirmed-verified":
        confirmedVerifiedCount += 1;
        break;
      case "confirmed-state-drift":
        stateDriftCount += 1;
        break;
      case "provenance-mismatch":
        provenanceMismatchCount += 1;
        break;
      case "failed-safe-to-retry":
        failedRetryableCount += 1;
        break;
      case "failed-already-applied":
        failedAlreadyAppliedCount += 1;
        break;
      case "unknown":
        unknownCount += 1;
        break;
    }
  }

  const healthy =
    results.length > 0 &&
    stateDriftCount === 0 &&
    provenanceMismatchCount === 0 &&
    failedRetryableCount === 0 &&
    unknownCount === 0;

  return {
    healthy,
    summary: {
      total: results.length,
      confirmedVerifiedCount,
      stateDriftCount,
      provenanceMismatchCount,
      failedRetryableCount,
      failedAlreadyAppliedCount,
      unknownCount,
    },
    results,
  };
}

export function formatReconciliationReport(report: ActivationReconciliationReport): string {
  const lines: string[] = [
    `Activation transaction reconciliation: ${report.healthy ? "CONVERGED" : "ACTION_REQUIRED"}`,
    `Summary: total=${String(report.summary.total)} verified=${String(report.summary.confirmedVerifiedCount)} drift=${String(report.summary.stateDriftCount)} provenanceMismatch=${String(report.summary.provenanceMismatchCount)} retryable=${String(report.summary.failedRetryableCount)} alreadyLive=${String(report.summary.failedAlreadyAppliedCount)} unknown=${String(report.summary.unknownCount)}`,
  ];
  for (const item of report.results) {
    lines.push(
      `[${item.outcome}] step=${item.stepId} hash=${item.hash} proposal=${item.proposal} allowDuplicate=${String(item.allowDuplicateSubmission)} - ${item.detail}`,
    );
  }
  return lines.join("\n");
}
