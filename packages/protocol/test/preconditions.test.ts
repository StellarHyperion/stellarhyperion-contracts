import { describe, expect, it } from "vitest";
import {
  formatPreconditionReport,
  RouteKind,
  verifyExecutionPreconditions,
  type ExecutionPreconditionInput,
} from "../src/index.js";

const ROUTER = "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V";
const SAC_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AXELAR_ADAPTER = "CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ";
const CCTP_ADAPTER = "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT";
const AXELAR_ITS = "CC7LAC4S7KAPIM26WKWFSOXWLNLSG7EXTC2EVY2H2UPKSTX3Z2A7M5YP";
const CCTP_TM = "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP";
const CCTP_MT = "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY";
const SEPOLIA_ITS_TOKEN = "0xFd5a146686d16060ef9c595B37C30b248402304c";
const SEPOLIA_USDC_HEX32 = `${"0".repeat(24)}1c7d4b196cb0c7b01d743fbc6116a902379c7238`;
const SEPOLIA_TM_HEX32 = `${"0".repeat(24)}8fe6b999dc680ccfdd5bf7eb0974218be2542daa`;
const ITS_TOKEN_ID = "ab".repeat(32);

function validPreconditionInput(): ExecutionPreconditionInput {
  return {
    sourceChain: "stellar-testnet",
    router: ROUTER,
    proposals: [
      { id: 1, kind: "RegisterToken", tokenSacId: SAC_ID, tokenDecimals: 7 },
      { id: 2, kind: "SetAdapter", route: RouteKind.AxelarIts, adapterAddress: AXELAR_ADAPTER },
      {
        id: 3,
        kind: "SetRailReceiver",
        route: RouteKind.AxelarIts,
        adapterAddress: AXELAR_ADAPTER,
      },
      { id: 4, kind: "EnableRoute", route: RouteKind.AxelarIts },
      { id: 5, kind: "SetAdapter", route: RouteKind.Cctp, adapterAddress: CCTP_ADAPTER },
      { id: 6, kind: "SetRailReceiver", route: RouteKind.Cctp, adapterAddress: CCTP_ADAPTER },
      { id: 7, kind: "EnableRoute", route: RouteKind.Cctp },
    ],
    axelar: {
      route: RouteKind.AxelarIts,
      expectedAdapter: AXELAR_ADAPTER,
      observedRouterOnAdapter: ROUTER,
      observedRouteOnAdapter: RouteKind.AxelarIts,
      expectedItsContract: AXELAR_ITS,
      observedItsContract: AXELAR_ITS,
      expectedLocalSacId: SAC_ID,
      observedRegisteredLocalSacId: SAC_ID,
      expectedTokenIdHex32: ITS_TOKEN_ID,
      observedTokenIdHex32: ITS_TOKEN_ID,
      lanes: [
        {
          peerChain: "sepolia",
          expectedAxelarChainName: "ethereum-sepolia",
          observedAxelarChainName: "ethereum-sepolia",
          expectedPeerHex20: "0".repeat(40),
          observedPeerHex20: "0".repeat(40),
          observedTrustedChain: true,
          expectedDestinationTokenAddress: SEPOLIA_ITS_TOKEN,
          observedDestinationTokenAddress: SEPOLIA_ITS_TOKEN,
          expectedDestinationDecimals: 7,
          observedDestinationDecimals: 7,
        },
      ],
    },
    cctp: {
      expectedAdapter: CCTP_ADAPTER,
      observedRouterOnAdapter: ROUTER,
      expectedTokenMessenger: CCTP_TM,
      observedTokenMessenger: CCTP_TM,
      expectedMessageTransmitter: CCTP_MT,
      observedMessageTransmitter: CCTP_MT,
      expectedLocalSacId: SAC_ID,
      observedMappedLocalSacId: SAC_ID,
      lanes: [
        {
          peerChain: "sepolia",
          expectedDomain: 0,
          observedDomain: 0,
          expectedDestinationCallerHex32: "0".repeat(64),
          observedDestinationCallerHex32: "0".repeat(64),
          expectedRemoteMessengerHex32: SEPOLIA_TM_HEX32,
          observedRemoteMessengerHex32: SEPOLIA_TM_HEX32,
          expectedBurnTokenHex32: SEPOLIA_USDC_HEX32,
          observedBurnTokenHex32: SEPOLIA_USDC_HEX32,
          expectedDestinationDecimals: 6,
          observedDestinationDecimals: 6,
        },
      ],
    },
  };
}

describe("verifyExecutionPreconditions", () => {
  it("blocks dependent activation proposals when a local or remote peer mapping changes", () => {
    const base = validPreconditionInput();
    const drifted: ExecutionPreconditionInput = {
      ...base,
      axelar: {
        ...base.axelar!,
        lanes: [
          {
            ...base.axelar!.lanes[0]!,
            // Peer chain name was overwritten on adapter before timelock matured
            observedAxelarChainName: "Ethereum",
          },
        ],
      },
    };

    const report = verifyExecutionPreconditions(drifted);
    expect(report.ready).toBe(false);
    // Axelar proposals 2, 3, 4 are blocked; RegisterToken (1) and CCTP (5, 6, 7) remain ready.
    expect(report.blockedProposalIds).toEqual([2, 3, 4]);
    expect(report.readyProposalIds).toEqual([1, 5, 6, 7]);
    expect(
      report.findings.find((f) => f.check === "axelar.lanes.sepolia.axelarChainName")?.reasonCode,
    ).toBe("peer-mapping-changed");

    const formatted = formatPreconditionReport(report);
    expect(formatted).toContain("BLOCKED");
    expect(formatted).toContain("[peer-mapping-changed]");
  });

  it("rejects unsupported or mismatched destination token precision", () => {
    const base = validPreconditionInput();

    // 18-decimal token on CCTP EVM destination (must be 6) and 18-decimal token on Axelar ITS.
    const badPrecision: ExecutionPreconditionInput = {
      ...base,
      axelar: {
        ...base.axelar!,
        lanes: [
          {
            ...base.axelar!.lanes[0]!,
            expectedDestinationDecimals: 18,
            observedDestinationDecimals: 18,
          },
        ],
      },
      cctp: {
        ...base.cctp!,
        lanes: [
          {
            ...base.cctp!.lanes[0]!,
            observedDestinationDecimals: 7,
          },
        ],
      },
    };

    const report = verifyExecutionPreconditions(badPrecision);
    expect(report.ready).toBe(false);
    expect(report.blockedProposalIds).toEqual([2, 3, 4, 5, 6, 7]);
    const precisionFailures = report.findings.filter(
      (f) => f.reasonCode === "unsupported-destination-precision",
    );
    expect(precisionFailures).toHaveLength(2);
  });

  it("produces an idempotent ready result for valid active mappings without mutating input", () => {
    const input = validPreconditionInput();
    const snapshotBefore = JSON.stringify(input);

    const first = verifyExecutionPreconditions(input);
    const second = verifyExecutionPreconditions(input);
    const third = verifyExecutionPreconditions(input);

    expect(first.ready).toBe(true);
    expect(first.blockedProposalIds).toEqual([]);
    expect(first.readyProposalIds).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(JSON.stringify(input)).toBe(snapshotBefore);
  });
});
