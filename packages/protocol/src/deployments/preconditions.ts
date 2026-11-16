/**
 * Provider-link and destination-precision precondition verification before timelock execution.
 *
 * Validates local and remote TokenMessenger / ITS peer mappings, token bindings, and destination
 * decimal precision immediately before executing queued router activation proposals. Blocks
 * dependent proposals when any peer mapping drifts or destination precision is unsupported, and
 * returns a deterministic, idempotent `ready: true` verdict when active mappings hold.
 */
import { isStellarAddress } from "../addresses.js";
import { CHAINS, isChainKey, type ChainKey } from "../chains.js";
import { RouteKind } from "../routes.js";

export type PreconditionProposalKind =
  "RegisterToken" | "SetAdapter" | "SetRailReceiver" | "EnableRoute" | "Upgrade" | "SetAdmin";

export interface QueuedActivationProposal {
  readonly id: number;
  readonly kind: PreconditionProposalKind;
  readonly route?: RouteKind | undefined;
  readonly tokenSacId?: string | undefined;
  readonly tokenDecimals?: number | undefined;
  readonly adapterAddress?: string | undefined;
}

export interface CctpPeerPreconditionLane {
  readonly peerChain: ChainKey;
  readonly expectedDomain: number;
  readonly observedDomain: number | null;
  readonly expectedDestinationCallerHex32: string;
  readonly observedDestinationCallerHex32: string | null;
  readonly expectedRemoteMessengerHex32: string;
  readonly observedRemoteMessengerHex32: string | null;
  readonly expectedBurnTokenHex32: string;
  readonly observedBurnTokenHex32: string | null;
  readonly expectedDestinationDecimals: number;
  readonly observedDestinationDecimals: number | null;
}

export interface CctpPreconditionBundle {
  readonly expectedAdapter: string;
  readonly observedRouterOnAdapter: string | null;
  readonly expectedTokenMessenger: string;
  readonly observedTokenMessenger: string | null;
  readonly expectedMessageTransmitter: string;
  readonly observedMessageTransmitter: string | null;
  readonly expectedLocalSacId: string;
  readonly observedMappedLocalSacId: string | null;
  readonly lanes: readonly CctpPeerPreconditionLane[];
}

export interface AxelarPeerPreconditionLane {
  readonly peerChain: ChainKey;
  readonly expectedAxelarChainName: string;
  readonly observedAxelarChainName: string | null;
  readonly expectedPeerHex20: string;
  readonly observedPeerHex20: string | null;
  readonly observedTrustedChain: boolean;
  readonly expectedDestinationTokenAddress: string;
  readonly observedDestinationTokenAddress: string | null;
  readonly expectedDestinationDecimals: number;
  readonly observedDestinationDecimals: number | null;
}

export type AxelarRouteKind = (typeof RouteKind)["AxelarIts"] | (typeof RouteKind)["AxelarGmp"];

export interface AxelarPreconditionBundle {
  readonly route: AxelarRouteKind;
  readonly expectedAdapter: string;
  readonly observedRouterOnAdapter: string | null;
  readonly observedRouteOnAdapter: RouteKind | null;
  readonly expectedItsContract: string;
  readonly observedItsContract: string | null;
  readonly expectedLocalSacId: string;
  readonly observedRegisteredLocalSacId: string | null;
  readonly expectedTokenIdHex32: string;
  readonly observedTokenIdHex32: string | null;
  readonly lanes: readonly AxelarPeerPreconditionLane[];
}

export interface ExecutionPreconditionInput {
  readonly sourceChain: ChainKey;
  readonly router: string;
  readonly proposals: readonly QueuedActivationProposal[];
  readonly cctp?: CctpPreconditionBundle | undefined;
  readonly axelar?: AxelarPreconditionBundle | undefined;
}

export type PreconditionFailureReasonCode =
  | "ok"
  | "peer-mapping-changed"
  | "provider-mismatch"
  | "unsupported-destination-precision"
  | "missing-precondition-bundle";

export interface PreconditionFinding {
  readonly route: RouteKind | null;
  readonly check: string;
  readonly passed: boolean;
  readonly reasonCode: PreconditionFailureReasonCode;
  readonly expected: string;
  readonly observed: string;
  readonly detail: string;
}

export interface ExecutionPreconditionReport {
  readonly ready: boolean;
  readonly sourceChain: ChainKey;
  readonly router: string;
  readonly readyProposalIds: readonly number[];
  readonly blockedProposalIds: readonly number[];
  readonly findings: readonly PreconditionFinding[];
}

function normHex(value: string | null, expectedHexChars: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  const clean = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (clean.length !== expectedHexChars || !/^[0-9a-f]+$/.test(clean)) return null;
  return clean;
}

function normAddr(value: string | null, family: "evm" | "stellar"): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (family === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
    return trimmed.toLowerCase();
  }
  if (!isStellarAddress(trimmed)) return null;
  return trimmed;
}

function isSupportedDestinationPrecision(
  route: RouteKind,
  peerChain: ChainKey,
  decimals: number | null,
): boolean {
  if (decimals === null || !Number.isInteger(decimals)) return false;
  const peerEntry = CHAINS[peerChain];
  if (route === RouteKind.Cctp) {
    // Native Circle USDC is 6 decimals on EVM chains and 7 decimals on Stellar SAC.
    return peerEntry.family === "evm" ? decimals === 6 : decimals === 7;
  }
  // Axelar ITS / GMP supports 6-decimal canonical EVM tokens or 7-decimal Stellar-origin ITS representations.
  return peerEntry.family === "evm" ? decimals === 6 || decimals === 7 : decimals === 7;
}

function evaluateCctpBundle(
  sourceFamily: "evm" | "stellar",
  router: string,
  bundle: CctpPreconditionBundle,
  findings: PreconditionFinding[],
): boolean {
  let ok = true;
  const record = (
    check: string,
    passed: boolean,
    reasonCode: PreconditionFailureReasonCode,
    expected: string,
    observed: string,
    detail: string,
  ): void => {
    if (!passed) ok = false;
    findings.push({
      route: RouteKind.Cctp,
      check,
      passed,
      reasonCode: passed ? "ok" : reasonCode,
      expected,
      observed,
      detail,
    });
  };

  const routerMatch =
    normAddr(bundle.observedRouterOnAdapter, sourceFamily) === normAddr(router, sourceFamily);
  record(
    "cctp.adapter.router",
    routerMatch,
    "provider-mismatch",
    router,
    bundle.observedRouterOnAdapter ?? "null",
    routerMatch ? "Adapter router binding matches." : "Adapter points to unexpected router.",
  );

  const tmMatch =
    normAddr(bundle.observedTokenMessenger, sourceFamily) ===
    normAddr(bundle.expectedTokenMessenger, sourceFamily);
  record(
    "cctp.adapter.tokenMessenger",
    tmMatch,
    "provider-mismatch",
    bundle.expectedTokenMessenger,
    bundle.observedTokenMessenger ?? "null",
    tmMatch ? "TokenMessenger matches." : "TokenMessenger address changed or unset.",
  );

  const mtMatch =
    normAddr(bundle.observedMessageTransmitter, sourceFamily) ===
    normAddr(bundle.expectedMessageTransmitter, sourceFamily);
  record(
    "cctp.adapter.messageTransmitter",
    mtMatch,
    "provider-mismatch",
    bundle.expectedMessageTransmitter,
    bundle.observedMessageTransmitter ?? "null",
    mtMatch ? "MessageTransmitter matches." : "MessageTransmitter address changed or unset.",
  );

  const sacMatch =
    normAddr(bundle.observedMappedLocalSacId, sourceFamily) ===
    normAddr(bundle.expectedLocalSacId, sourceFamily);
  record(
    "cctp.adapter.localToken",
    sacMatch,
    "peer-mapping-changed",
    bundle.expectedLocalSacId,
    bundle.observedMappedLocalSacId ?? "null",
    sacMatch ? "Local token mapping matches." : "Local token mapping changed or missing.",
  );

  if (bundle.lanes.length === 0) {
    record(
      "cctp.lanes.nonEmpty",
      false,
      "peer-mapping-changed",
      ">=1 configured lane",
      "0",
      "At least one CCTP peer lane is required before enabling route 0.",
    );
  }

  for (const lane of bundle.lanes) {
    if (!isChainKey(lane.peerChain)) {
      record(
        `cctp.lanes.${String(lane.peerChain)}.chain`,
        false,
        "peer-mapping-changed",
        "known-chain-key",
        String(lane.peerChain),
        "Unknown peer chain key.",
      );
      continue;
    }

    const domainOk = lane.observedDomain === lane.expectedDomain;
    record(
      `cctp.lanes.${lane.peerChain}.domain`,
      domainOk,
      "peer-mapping-changed",
      String(lane.expectedDomain),
      String(lane.observedDomain),
      domainOk ? "CCTP domain matches." : "Peer CCTP domain mapping changed.",
    );

    const expCaller = normHex(lane.expectedDestinationCallerHex32, 64);
    const obsCaller = normHex(lane.observedDestinationCallerHex32, 64);
    const callerOk = expCaller !== null && expCaller === obsCaller;
    record(
      `cctp.lanes.${lane.peerChain}.destinationCaller`,
      callerOk,
      "peer-mapping-changed",
      lane.expectedDestinationCallerHex32,
      lane.observedDestinationCallerHex32 ?? "null",
      callerOk ? "Destination caller matches." : "Destination caller bytes32 changed.",
    );

    const expRemoteMessenger = normHex(lane.expectedRemoteMessengerHex32, 64);
    const obsRemoteMessenger = normHex(lane.observedRemoteMessengerHex32, 64);
    const remoteMessengerOk =
      expRemoteMessenger !== null &&
      expRemoteMessenger !== "0".repeat(64) &&
      expRemoteMessenger === obsRemoteMessenger;
    record(
      `cctp.lanes.${lane.peerChain}.remoteMessenger`,
      remoteMessengerOk,
      "peer-mapping-changed",
      lane.expectedRemoteMessengerHex32,
      lane.observedRemoteMessengerHex32 ?? "null",
      remoteMessengerOk
        ? "Remote TokenMessenger matches."
        : "Remote TokenMessenger peer mapping changed or zero.",
    );

    const expBurn = normHex(lane.expectedBurnTokenHex32, 64);
    const obsBurn = normHex(lane.observedBurnTokenHex32, 64);
    const burnOk = expBurn !== null && expBurn !== "0".repeat(64) && expBurn === obsBurn;
    record(
      `cctp.lanes.${lane.peerChain}.burnToken`,
      burnOk,
      "peer-mapping-changed",
      lane.expectedBurnTokenHex32,
      lane.observedBurnTokenHex32 ?? "null",
      burnOk ? "Mapped burn token matches." : "Mapped burn token changed or zero.",
    );

    const precisionSupported = isSupportedDestinationPrecision(
      RouteKind.Cctp,
      lane.peerChain,
      lane.observedDestinationDecimals,
    );
    const precisionMatches =
      precisionSupported && lane.observedDestinationDecimals === lane.expectedDestinationDecimals;
    record(
      `cctp.lanes.${lane.peerChain}.destinationDecimals`,
      precisionMatches,
      "unsupported-destination-precision",
      String(lane.expectedDestinationDecimals),
      String(lane.observedDestinationDecimals),
      precisionMatches
        ? "Destination precision is supported and matches."
        : `Destination precision ${String(lane.observedDestinationDecimals)} is unsupported or mismatches expected ${String(lane.expectedDestinationDecimals)}.`,
    );
  }

  return ok;
}

function evaluateAxelarBundle(
  sourceFamily: "evm" | "stellar",
  router: string,
  bundle: AxelarPreconditionBundle,
  findings: PreconditionFinding[],
): boolean {
  let ok = true;
  const route = bundle.route;
  const record = (
    check: string,
    passed: boolean,
    reasonCode: PreconditionFailureReasonCode,
    expected: string,
    observed: string,
    detail: string,
  ): void => {
    if (!passed) ok = false;
    findings.push({
      route,
      check,
      passed,
      reasonCode: passed ? "ok" : reasonCode,
      expected,
      observed,
      detail,
    });
  };

  const routerMatch =
    normAddr(bundle.observedRouterOnAdapter, sourceFamily) === normAddr(router, sourceFamily);
  record(
    "axelar.adapter.router",
    routerMatch,
    "provider-mismatch",
    router,
    bundle.observedRouterOnAdapter ?? "null",
    routerMatch ? "Adapter router binding matches." : "Adapter points to unexpected router.",
  );

  const routeMatch = bundle.observedRouteOnAdapter === route;
  record(
    "axelar.adapter.route",
    routeMatch,
    "provider-mismatch",
    String(route),
    String(bundle.observedRouteOnAdapter),
    routeMatch ? "Adapter route shape matches." : "Adapter initialized for a different route.",
  );

  const itsMatch =
    normAddr(bundle.observedItsContract, sourceFamily) ===
    normAddr(bundle.expectedItsContract, sourceFamily);
  record(
    "axelar.adapter.its",
    itsMatch,
    "provider-mismatch",
    bundle.expectedItsContract,
    bundle.observedItsContract ?? "null",
    itsMatch ? "ITS contract matches." : "ITS contract address changed or unset.",
  );

  const localTokenMatch =
    normAddr(bundle.observedRegisteredLocalSacId, sourceFamily) ===
    normAddr(bundle.expectedLocalSacId, sourceFamily);
  record(
    "axelar.its.registeredLocalToken",
    localTokenMatch,
    "peer-mapping-changed",
    bundle.expectedLocalSacId,
    bundle.observedRegisteredLocalSacId ?? "null",
    localTokenMatch
      ? "ITS registered local token matches SAC."
      : "ITS registered local token changed or missing.",
  );

  const expTokenId = normHex(bundle.expectedTokenIdHex32, 64);
  const obsTokenId = normHex(bundle.observedTokenIdHex32, 64);
  const tokenIdMatch = expTokenId !== null && expTokenId === obsTokenId;
  record(
    "axelar.adapter.tokenId",
    tokenIdMatch,
    "peer-mapping-changed",
    bundle.expectedTokenIdHex32,
    bundle.observedTokenIdHex32 ?? "null",
    tokenIdMatch ? "Mapped ITS tokenId matches." : "Mapped ITS tokenId changed or unset.",
  );

  if (bundle.lanes.length === 0) {
    record(
      "axelar.lanes.nonEmpty",
      false,
      "peer-mapping-changed",
      ">=1 configured lane",
      "0",
      "At least one Axelar peer lane is required before enabling route.",
    );
  }

  for (const lane of bundle.lanes) {
    if (!isChainKey(lane.peerChain)) {
      record(
        `axelar.lanes.${String(lane.peerChain)}.chain`,
        false,
        "peer-mapping-changed",
        "known-chain-key",
        String(lane.peerChain),
        "Unknown peer chain key.",
      );
      continue;
    }

    const peerFamily = CHAINS[lane.peerChain].family;
    const chainNameOk =
      lane.observedAxelarChainName !== null &&
      lane.observedAxelarChainName.trim() === lane.expectedAxelarChainName.trim() &&
      lane.expectedAxelarChainName.trim().length > 0;
    record(
      `axelar.lanes.${lane.peerChain}.axelarChainName`,
      chainNameOk,
      "peer-mapping-changed",
      lane.expectedAxelarChainName,
      lane.observedAxelarChainName ?? "null",
      chainNameOk ? "Axelar chain name matches." : "Axelar chain name mapping changed.",
    );

    const expPeer = normHex(lane.expectedPeerHex20, 40);
    const obsPeer = normHex(lane.observedPeerHex20, 40);
    const nonZeroRequired = route === RouteKind.AxelarGmp;
    const peerOk =
      expPeer !== null && expPeer === obsPeer && (!nonZeroRequired || expPeer !== "0".repeat(40));
    record(
      `axelar.lanes.${lane.peerChain}.peerAddress`,
      peerOk,
      "peer-mapping-changed",
      lane.expectedPeerHex20,
      lane.observedPeerHex20 ?? "null",
      peerOk ? "Peer mapping matches." : "Adapter peer address mapping changed.",
    );

    record(
      `axelar.lanes.${lane.peerChain}.trustedChain`,
      lane.observedTrustedChain,
      "peer-mapping-changed",
      "true",
      String(lane.observedTrustedChain),
      lane.observedTrustedChain
        ? "ITS marks destination chain as trusted."
        : "ITS does not trust destination chain.",
    );

    const dstTokOk =
      normAddr(lane.observedDestinationTokenAddress, peerFamily) !== null &&
      normAddr(lane.observedDestinationTokenAddress, peerFamily) ===
        normAddr(lane.expectedDestinationTokenAddress, peerFamily);
    record(
      `axelar.lanes.${lane.peerChain}.destinationToken`,
      dstTokOk,
      "peer-mapping-changed",
      lane.expectedDestinationTokenAddress,
      lane.observedDestinationTokenAddress ?? "null",
      dstTokOk ? "Destination ITS token matches." : "Destination ITS token mapping changed.",
    );

    const precisionSupported = isSupportedDestinationPrecision(
      route,
      lane.peerChain,
      lane.observedDestinationDecimals,
    );
    const precisionMatches =
      precisionSupported && lane.observedDestinationDecimals === lane.expectedDestinationDecimals;
    record(
      `axelar.lanes.${lane.peerChain}.destinationDecimals`,
      precisionMatches,
      "unsupported-destination-precision",
      String(lane.expectedDestinationDecimals),
      String(lane.observedDestinationDecimals),
      precisionMatches
        ? "Destination precision is supported and matches."
        : `Destination precision ${String(lane.observedDestinationDecimals)} is unsupported or mismatches expected ${String(lane.expectedDestinationDecimals)}.`,
    );
  }

  return ok;
}

export function verifyExecutionPreconditions(
  input: ExecutionPreconditionInput,
): ExecutionPreconditionReport {
  if (!isChainKey(input.sourceChain)) {
    throw new Error(`Unknown sourceChain "${String(input.sourceChain)}".`);
  }
  const sourceFamily = CHAINS[input.sourceChain].family;
  if (normAddr(input.router, sourceFamily) === null) {
    throw new Error(`Invalid router address "${input.router}" for ${input.sourceChain}.`);
  }

  const findings: PreconditionFinding[] = [];
  const routeStatus = new Map<RouteKind, boolean>();

  const touchedRoutes = new Set<RouteKind>();
  for (const prop of input.proposals) {
    if (prop.route !== undefined) {
      touchedRoutes.add(prop.route);
    }
  }

  if (touchedRoutes.has(RouteKind.Cctp)) {
    if (input.cctp === undefined) {
      findings.push({
        route: RouteKind.Cctp,
        check: "cctp.bundle",
        passed: false,
        reasonCode: "missing-precondition-bundle",
        expected: "cctp precondition bundle",
        observed: "missing",
        detail: "CCTP activation proposals require live CCTP messenger and domain preconditions.",
      });
      routeStatus.set(RouteKind.Cctp, false);
    } else {
      routeStatus.set(
        RouteKind.Cctp,
        evaluateCctpBundle(sourceFamily, input.router, input.cctp, findings),
      );
    }
  }

  for (const axRoute of [RouteKind.AxelarIts, RouteKind.AxelarGmp] as const) {
    if (touchedRoutes.has(axRoute)) {
      if (input.axelar?.route !== axRoute) {
        findings.push({
          route: axRoute,
          check: "axelar.bundle",
          passed: false,
          reasonCode: "missing-precondition-bundle",
          expected: `axelar bundle for route ${String(axRoute)}`,
          observed: input.axelar === undefined ? "missing" : `route ${String(input.axelar.route)}`,
          detail: "Axelar activation proposals require live ITS and peer link preconditions.",
        });
        routeStatus.set(axRoute, false);
      } else {
        routeStatus.set(
          axRoute,
          evaluateAxelarBundle(sourceFamily, input.router, input.axelar, findings),
        );
      }
    }
  }

  const readyProposalIds: number[] = [];
  const blockedProposalIds: number[] = [];

  for (const prop of input.proposals) {
    if (prop.kind === "RegisterToken") {
      const expectedLocalDecimals = sourceFamily === "stellar" ? 7 : 6;
      const decimalsOk = prop.tokenDecimals === expectedLocalDecimals;
      findings.push({
        route: null,
        check: `proposal.${String(prop.id)}.tokenDecimals`,
        passed: decimalsOk,
        reasonCode: decimalsOk ? "ok" : "unsupported-destination-precision",
        expected: String(expectedLocalDecimals),
        observed: String(prop.tokenDecimals),
        detail: decimalsOk
          ? "Registered source token precision matches canonical chain precision."
          : "Registered source token precision is unsupported.",
      });
      if (decimalsOk) readyProposalIds.push(prop.id);
      else blockedProposalIds.push(prop.id);
      continue;
    }

    if (prop.route !== undefined) {
      const routeOk = routeStatus.get(prop.route) ?? false;
      let adapterMatchesBundle = true;
      if (
        (prop.kind === "SetAdapter" || prop.kind === "SetRailReceiver") &&
        prop.adapterAddress !== undefined
      ) {
        const expectedAdapter =
          prop.route === RouteKind.Cctp
            ? (input.cctp?.expectedAdapter ?? null)
            : (input.axelar?.expectedAdapter ?? null);
        adapterMatchesBundle =
          expectedAdapter !== null &&
          normAddr(prop.adapterAddress, sourceFamily) === normAddr(expectedAdapter, sourceFamily);
        if (!adapterMatchesBundle) {
          findings.push({
            route: prop.route,
            check: `proposal.${String(prop.id)}.adapterAddress`,
            passed: false,
            reasonCode: "provider-mismatch",
            expected: expectedAdapter ?? "configured-adapter",
            observed: prop.adapterAddress,
            detail: "Queued proposal adapter address differs from verified adapter bundle.",
          });
        }
      }

      if (routeOk && adapterMatchesBundle) {
        readyProposalIds.push(prop.id);
      } else {
        blockedProposalIds.push(prop.id);
      }
      continue;
    }

    readyProposalIds.push(prop.id);
  }

  return {
    ready: blockedProposalIds.length === 0 && findings.every((f) => f.passed),
    sourceChain: input.sourceChain,
    router: input.router,
    readyProposalIds,
    blockedProposalIds,
    findings,
  };
}

export function formatPreconditionReport(report: ExecutionPreconditionReport): string {
  const lines: string[] = [
    `Execution preconditions (${report.sourceChain} router ${report.router}): ${report.ready ? "READY" : "BLOCKED"}`,
    `Ready proposals: [${report.readyProposalIds.join(", ")}] | Blocked proposals: [${report.blockedProposalIds.join(", ")}]`,
  ];
  for (const item of report.findings) {
    lines.push(
      `[${item.passed ? "ok" : item.reasonCode}] ${item.check}: observed=${item.observed} expected=${item.expected} - ${item.detail}`,
    );
  }
  return lines.join("\n");
}
