import { describe, expect, it } from "vitest";

import {
  buildPaidDispatchAuthSnapshot,
  inspectPaidDispatchAuthTree,
} from "../src/axelarAuthSnapshots.js";
import type { AuthInvocationNode, PaidDispatchSnapshotIntent } from "../src/axelarAuthSnapshots.js";
import { C_ADDR, EVM_RECIPIENT, G_ADDR } from "./fixtures.js";

const ROUTER_ID = "CCROUTER000000000000000000000000000000000000000000000001";
const TREASURY_ID = "CCTREASURY0000000000000000000000000000000000000000000002";
const ADAPTER_ID = "CCAXELARITS000000000000000000000000000000000000000000003";
const ITS_ID = "CCAXELARHUB000000000000000000000000000000000000000000004";
const GAS_SERVICE_ID = "CCAXELARGAS000000000000000000000000000000000000000000005";
const TOKEN_MANAGER_ID = "CCTOKENMGR0000000000000000000000000000000000000000000006";
const NATIVE_XLM_SAC = "CCNATIVEGAS000000000000000000000000000000000000000000007";
const ATTACKEE_ROGUE = "CCROGUE0000000000000000000000000000000000000000000000008";
const TOKEN_ID_HEX = `0x${"7a".repeat(32)}` as const;

function baseIntent(
  overrides: Partial<PaidDispatchSnapshotIntent> = {},
): PaidDispatchSnapshotIntent {
  return {
    sender: G_ADDR,
    router: ROUTER_ID,
    treasury: TREASURY_ID,
    adapter: ADAPTER_ID,
    its: ITS_ID,
    gasService: GAS_SERVICE_ID,
    token: C_ADDR,
    tokenId: TOKEN_ID_HEX,
    tokenManagerKind: "MintBurn",
    nativeGasToken: NATIVE_XLM_SAC,
    destinationChain: "sepolia",
    axelarChain: "ethereum-sepolia",
    destination: EVM_RECIPIENT,
    feeAmount: 1_000_000n,
    netAmount: 999_000_000n,
    gasAmount: 2_500_000n,
    routerNonce: 1n,
    ...overrides,
  };
}

describe("Axelar paid-dispatch authorization-tree snapshots", () => {
  it("generates the actual nested paid call structure offline with no private key", () => {
    const intent = baseIntent();
    const snapshot = buildPaidDispatchAuthSnapshot(intent);

    expect(snapshot.contract).toBe(ROUTER_ID);
    expect(snapshot.fnName).toBe("bridge_out_with_gas");
    expect(snapshot.subInvocations).toHaveLength(2);
    expect(snapshot.subInvocations[0]?.fnName).toBe("transfer");
    expect(snapshot.subInvocations[1]?.fnName).toBe("dispatch_from");

    const itsCall = snapshot.subInvocations[1]?.subInvocations[0];
    expect(itsCall?.contract).toBe(ITS_ID);
    expect(itsCall?.fnName).toBe("interchain_transfer");
    expect(itsCall?.subInvocations[0]?.fnName).toBe("burn");
    expect(itsCall?.subInvocations[1]?.fnName).toBe("pay_gas");
    expect(itsCall?.subInvocations[1]?.subInvocations[0]?.fnName).toBe("transfer");

    const report = inspectPaidDispatchAuthTree(snapshot, intent);
    expect(report.safeToSign).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.totalTokenDebit).toBe(1_000_000_000n);
    expect(report.totalGasDebit).toBe(2_500_000n);
  });

  it("supports LockUnlock token managers and validates exact manager spender", () => {
    const intent = baseIntent({
      tokenManagerKind: "LockUnlock",
      tokenManagerAddress: TOKEN_MANAGER_ID,
    });
    const snapshot = buildPaidDispatchAuthSnapshot(intent);
    expect(inspectPaidDispatchAuthTree(snapshot, intent).safeToSign).toBe(true);

    // Mutate LockUnlock manager spender to a rogue contract.
    const itsNode = snapshot.subInvocations[1]?.subInvocations[0];
    const dispatchNode = snapshot.subInvocations[1];
    if (!itsNode || !dispatchNode) throw new Error("missing nodes");

    const tamperedTokenLeaf: AuthInvocationNode = {
      contract: C_ADDR,
      fnName: "transfer",
      args: [G_ADDR, ATTACKEE_ROGUE, intent.netAmount],
      subInvocations: [],
    };
    const tampered: AuthInvocationNode = {
      ...snapshot,
      subInvocations: [
        snapshot.subInvocations[0] ?? tamperedTokenLeaf,
        {
          ...dispatchNode,
          subInvocations: [
            {
              ...itsNode,
              subInvocations: [tamperedTokenLeaf, itsNode.subInvocations[1] ?? tamperedTokenLeaf],
            },
          ],
        },
      ],
    };

    const report = inspectPaidDispatchAuthTree(tampered, intent);
    expect(report.safeToSign).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain("changed_spender");
  });

  it("highlights changed gas recipient, changed amounts, and unexpected sub-invocations before signing", () => {
    const intent = baseIntent();
    const snapshot = buildPaidDispatchAuthSnapshot(intent);
    const feeNode = snapshot.subInvocations[0];
    const dispatchNode = snapshot.subInvocations[1];
    const itsNode = dispatchNode?.subInvocations[0];
    const burnLeaf = itsNode?.subInvocations[0];
    const payGasNode = itsNode?.subInvocations[1];
    if (!feeNode || !dispatchNode || !itsNode || !burnLeaf || !payGasNode) {
      throw new Error("missing fixture branches");
    }

    const rogueGasLeaf: AuthInvocationNode = {
      contract: NATIVE_XLM_SAC,
      fnName: "transfer",
      args: [G_ADDR, ATTACKEE_ROGUE, intent.gasAmount + 500_000n],
      subInvocations: [],
    };
    const extraApprove: AuthInvocationNode = {
      contract: C_ADDR,
      fnName: "approve",
      args: [G_ADDR, ATTACKEE_ROGUE, 9_999_999_999n],
      subInvocations: [],
    };

    const tampered: AuthInvocationNode = {
      ...snapshot,
      subInvocations: [
        {
          ...feeNode,
          args: [G_ADDR, ATTACKEE_ROGUE, intent.feeAmount + 1n],
        },
        {
          ...dispatchNode,
          subInvocations: [
            {
              ...itsNode,
              args: [
                G_ADDR,
                TOKEN_ID_HEX,
                "ethereum-sepolia",
                EVM_RECIPIENT,
                intent.netAmount,
                "0x01deadbeef",
                { address: NATIVE_XLM_SAC, amount: intent.gasAmount },
              ],
              subInvocations: [
                burnLeaf,
                {
                  ...payGasNode,
                  contract: ATTACKEE_ROGUE,
                  subInvocations: [rogueGasLeaf],
                },
              ],
            },
          ],
        },
        extraApprove,
      ],
    };

    const report = inspectPaidDispatchAuthTree(tampered, intent);
    expect(report.safeToSign).toBe(false);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("changed_fee_recipient");
    expect(codes).toContain("changed_fee_amount");
    expect(codes).toContain("changed_gas_recipient");
    expect(codes).toContain("changed_gas_amount");
    expect(codes).toContain("unexpected_payload_attachment");
    expect(codes).toContain("unexpected_sub_invocation");
  });
});
