/**
 * Pre-signing snapshot builder and privilege-expansion inspector for nested Soroban Axelar paid
 * ITS dispatches (`HyperionRouter.bridge_out_with_gas` -> `AxelarAdapter.dispatch_from` ->
 * `InterchainTokenService.interchain_transfer` -> `[token burn/lock-transfer, gas_service]`).
 *
 * Operates purely on simulated or expected invocation structures using `bigint` and strings; no
 * private key, wallet signer, or network RPC broadcast is ever required.
 */
import type { Hex } from "./bytes.js";
import { toEvmAddress } from "./notes.js";

export type SorobanTokenManagerKind =
  "NativeInterchainToken" | "MintBurnFrom" | "LockUnlock" | "MintBurn";

export interface PaidDispatchSnapshotIntent {
  readonly sender: string;
  readonly router: string;
  readonly treasury: string;
  readonly adapter: string;
  readonly its: string;
  readonly gasService: string;
  readonly token: string;
  readonly tokenId: Hex;
  readonly tokenManagerKind: SorobanTokenManagerKind;
  /** Required when `tokenManagerKind === "LockUnlock"`. */
  readonly tokenManagerAddress?: string;
  readonly nativeGasToken: string;
  readonly destinationChain: string;
  readonly axelarChain: string;
  /** Either a 20-byte `0x...` EVM address or a 32-byte left-padded destination word. */
  readonly destination: Hex;
  readonly feeAmount: bigint;
  readonly netAmount: bigint;
  readonly gasAmount: bigint;
  readonly routerNonce: bigint;
}

export type AuthArgValue =
  string | bigint | boolean | null | { readonly address: string; readonly amount: bigint };

export interface AuthInvocationNode {
  readonly contract: string;
  readonly fnName: string;
  readonly args: readonly AuthArgValue[];
  readonly subInvocations: readonly AuthInvocationNode[];
}

export type AuthPrivilegeIssueCode =
  | "unexpected_root_call"
  | "unexpected_sub_invocation"
  | "missing_sub_invocation"
  | "changed_spender"
  | "changed_fee_recipient"
  | "changed_fee_amount"
  | "changed_net_amount"
  | "changed_gas_recipient"
  | "changed_gas_token"
  | "changed_gas_amount"
  | "changed_destination"
  | "unexpected_payload_attachment";

export interface AuthPrivilegeFinding {
  readonly code: AuthPrivilegeIssueCode;
  readonly path: string;
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

export interface PaidDispatchAuthInspection {
  readonly safeToSign: boolean;
  readonly normalizedRecipient: Hex;
  readonly totalTokenDebit: bigint;
  readonly totalGasDebit: bigint;
  readonly findings: readonly AuthPrivilegeFinding[];
}

function normalizeEvmRecipient(destination: Hex): Hex {
  if (destination.length === 42) {
    return destination.toLowerCase() as Hex;
  }
  return toEvmAddress(destination);
}

function takesByBurning(kind: SorobanTokenManagerKind): boolean {
  return kind !== "LockUnlock";
}

/**
 * Deterministically generate the canonical nested authorization-tree snapshot for a paid
 * `AxelarIts` outbound transfer without any private key or network broadcast.
 */
export function buildPaidDispatchAuthSnapshot(
  intent: PaidDispatchSnapshotIntent,
): AuthInvocationNode {
  const recipient = normalizeEvmRecipient(intent.destination);
  const burnMode = takesByBurning(intent.tokenManagerKind);
  if (!burnMode && !intent.tokenManagerAddress) {
    throw new Error("LockUnlock paid dispatch snapshot requires tokenManagerAddress");
  }

  const tokenLeaf: AuthInvocationNode = burnMode
    ? {
        contract: intent.token,
        fnName: "burn",
        args: [intent.sender, intent.netAmount],
        subInvocations: [],
      }
    : {
        contract: intent.token,
        fnName: "transfer",
        args: [intent.sender, intent.tokenManagerAddress ?? "", intent.netAmount],
        subInvocations: [],
      };

  const gasTransferLeaf: AuthInvocationNode = {
    contract: intent.nativeGasToken,
    fnName: "transfer",
    args: [intent.sender, intent.gasService, intent.gasAmount],
    subInvocations: [],
  };

  const gasBranch: AuthInvocationNode =
    intent.gasService === intent.its
      ? gasTransferLeaf
      : {
          contract: intent.gasService,
          fnName: "pay_gas",
          args: [
            intent.its,
            intent.axelarChain,
            recipient,
            "0x",
            intent.sender,
            { address: intent.nativeGasToken, amount: intent.gasAmount },
            intent.sender,
          ],
          subInvocations: [gasTransferLeaf],
        };

  return {
    contract: intent.router,
    fnName: "bridge_out_with_gas",
    args: [intent.sender, intent.token, intent.feeAmount + intent.netAmount, intent.gasAmount],
    subInvocations: [
      {
        contract: intent.token,
        fnName: "transfer",
        args: [intent.sender, intent.treasury, intent.feeAmount],
        subInvocations: [],
      },
      {
        contract: intent.adapter,
        fnName: "dispatch_from",
        args: [
          intent.router,
          intent.sender,
          intent.token,
          intent.netAmount,
          intent.destinationChain,
          recipient,
          intent.routerNonce,
          intent.gasAmount,
        ],
        subInvocations: [
          {
            contract: intent.its,
            fnName: "interchain_transfer",
            args: [
              intent.sender,
              intent.tokenId.toLowerCase(),
              intent.axelarChain,
              recipient,
              intent.netAmount,
              null,
              { address: intent.nativeGasToken, amount: intent.gasAmount },
            ],
            subInvocations: [tokenLeaf, gasBranch],
          },
        ],
      },
    ],
  };
}

function stringifyArg(val: AuthArgValue | undefined): string {
  if (val === undefined) return "<missing>";
  if (val === null) return "null";
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "object") return `${val.address}:${val.amount.toString()}`;
  return String(val);
}

/**
 * Compare a simulated Soroban authorization tree against an expected `PaidDispatchSnapshotIntent`
 * and highlight any changed spender, changed gas recipient, changed amount, or unexpected nested
 * privilege expansion before signing.
 */
export function inspectPaidDispatchAuthTree(
  actual: AuthInvocationNode,
  expected: PaidDispatchSnapshotIntent,
): PaidDispatchAuthInspection {
  const findings: AuthPrivilegeFinding[] = [];
  const recipient = normalizeEvmRecipient(expected.destination);

  if (actual.contract !== expected.router || actual.fnName !== "bridge_out_with_gas") {
    findings.push({
      code: "unexpected_root_call",
      path: "root",
      field: "contract/fnName",
      expected: `${expected.router}#bridge_out_with_gas`,
      actual: `${actual.contract}#${actual.fnName}`,
    });
  }
  if (actual.args[3] !== expected.gasAmount) {
    findings.push({
      code: "changed_gas_amount",
      path: "root.args[3]",
      field: "gasAmount",
      expected: expected.gasAmount.toString(),
      actual: stringifyArg(actual.args[3]),
    });
  }

  if (actual.subInvocations.length > 2) {
    findings.push({
      code: "unexpected_sub_invocation",
      path: "root.subInvocations",
      field: "count",
      expected: "2",
      actual: String(actual.subInvocations.length),
    });
  }

  const feeNode = actual.subInvocations[0];
  if (!feeNode) {
    findings.push({
      code: "missing_sub_invocation",
      path: "root.subInvocations[0]",
      field: "feeTransfer",
      expected: `${expected.token}#transfer`,
      actual: "<missing>",
    });
  } else {
    if (feeNode.contract !== expected.token || feeNode.fnName !== "transfer") {
      findings.push({
        code: "changed_spender",
        path: "root.subInvocations[0]",
        field: "feeTokenCall",
        expected: `${expected.token}#transfer`,
        actual: `${feeNode.contract}#${feeNode.fnName}`,
      });
    }
    if (feeNode.args[1] !== expected.treasury) {
      findings.push({
        code: "changed_fee_recipient",
        path: "root.subInvocations[0].args[1]",
        field: "treasury",
        expected: expected.treasury,
        actual: stringifyArg(feeNode.args[1]),
      });
    }
    if (feeNode.args[2] !== expected.feeAmount) {
      findings.push({
        code: "changed_fee_amount",
        path: "root.subInvocations[0].args[2]",
        field: "feeAmount",
        expected: expected.feeAmount.toString(),
        actual: stringifyArg(feeNode.args[2]),
      });
    }
    if (feeNode.subInvocations.length > 0) {
      findings.push({
        code: "unexpected_sub_invocation",
        path: "root.subInvocations[0].subInvocations",
        field: "count",
        expected: "0",
        actual: String(feeNode.subInvocations.length),
      });
    }
  }

  const dispatchNode = actual.subInvocations[1];
  if (!dispatchNode) {
    findings.push({
      code: "missing_sub_invocation",
      path: "root.subInvocations[1]",
      field: "dispatchFrom",
      expected: `${expected.adapter}#dispatch_from`,
      actual: "<missing>",
    });
  } else {
    if (dispatchNode.contract !== expected.adapter || dispatchNode.fnName !== "dispatch_from") {
      findings.push({
        code: "changed_spender",
        path: "root.subInvocations[1]",
        field: "adapter",
        expected: `${expected.adapter}#dispatch_from`,
        actual: `${dispatchNode.contract}#${dispatchNode.fnName}`,
      });
    }
    if (dispatchNode.args[3] !== expected.netAmount) {
      findings.push({
        code: "changed_net_amount",
        path: "root.subInvocations[1].args[3]",
        field: "netAmount",
        expected: expected.netAmount.toString(),
        actual: stringifyArg(dispatchNode.args[3]),
      });
    }
    if (dispatchNode.args[7] !== expected.gasAmount) {
      findings.push({
        code: "changed_gas_amount",
        path: "root.subInvocations[1].args[7]",
        field: "gasAmount",
        expected: expected.gasAmount.toString(),
        actual: stringifyArg(dispatchNode.args[7]),
      });
    }
    if (dispatchNode.subInvocations.length !== 1) {
      findings.push({
        code: "unexpected_sub_invocation",
        path: "root.subInvocations[1].subInvocations",
        field: "count",
        expected: "1",
        actual: String(dispatchNode.subInvocations.length),
      });
    }

    const itsNode = dispatchNode.subInvocations[0];
    if (itsNode) {
      inspectItsSubtree(itsNode, expected, recipient, findings);
    }
  }

  return {
    safeToSign: findings.length === 0,
    normalizedRecipient: recipient,
    totalTokenDebit: expected.feeAmount + expected.netAmount,
    totalGasDebit: expected.gasAmount,
    findings,
  };
}

function inspectItsSubtree(
  itsNode: AuthInvocationNode,
  expected: PaidDispatchSnapshotIntent,
  recipient: Hex,
  findings: AuthPrivilegeFinding[],
): void {
  const basePath = "root.subInvocations[1].subInvocations[0]";
  if (itsNode.contract !== expected.its || itsNode.fnName !== "interchain_transfer") {
    findings.push({
      code: "changed_spender",
      path: basePath,
      field: "its",
      expected: `${expected.its}#interchain_transfer`,
      actual: `${itsNode.contract}#${itsNode.fnName}`,
    });
  }
  const destArg = stringifyArg(itsNode.args[3]).toLowerCase();
  if (destArg !== recipient) {
    findings.push({
      code: "changed_destination",
      path: `${basePath}.args[3]`,
      field: "destinationAddress",
      expected: recipient,
      actual: destArg,
    });
  }
  if (itsNode.args[4] !== expected.netAmount) {
    findings.push({
      code: "changed_net_amount",
      path: `${basePath}.args[4]`,
      field: "netAmount",
      expected: expected.netAmount.toString(),
      actual: stringifyArg(itsNode.args[4]),
    });
  }
  if (itsNode.args[5] !== null) {
    findings.push({
      code: "unexpected_payload_attachment",
      path: `${basePath}.args[5]`,
      field: "metadata",
      expected: "null",
      actual: stringifyArg(itsNode.args[5]),
    });
  }

  if (itsNode.subInvocations.length !== 2) {
    findings.push({
      code: "unexpected_sub_invocation",
      path: `${basePath}.subInvocations`,
      field: "count",
      expected: "2",
      actual: String(itsNode.subInvocations.length),
    });
  }

  const tokenLeaf = itsNode.subInvocations[0];
  if (tokenLeaf) {
    inspectTokenLeaf(tokenLeaf, expected, `${basePath}.subInvocations[0]`, findings);
  }

  const gasNode = itsNode.subInvocations[1];
  if (gasNode) {
    inspectGasBranch(gasNode, expected, `${basePath}.subInvocations[1]`, findings);
  }
}

function inspectTokenLeaf(
  tokenLeaf: AuthInvocationNode,
  expected: PaidDispatchSnapshotIntent,
  path: string,
  findings: AuthPrivilegeFinding[],
): void {
  const burnMode = takesByBurning(expected.tokenManagerKind);
  const expectedFn = burnMode ? "burn" : "transfer";
  if (tokenLeaf.contract !== expected.token || tokenLeaf.fnName !== expectedFn) {
    findings.push({
      code: "changed_spender",
      path,
      field: "tokenMovement",
      expected: `${expected.token}#${expectedFn}`,
      actual: `${tokenLeaf.contract}#${tokenLeaf.fnName}`,
    });
  }
  if (burnMode) {
    if (tokenLeaf.args[1] !== expected.netAmount) {
      findings.push({
        code: "changed_net_amount",
        path: `${path}.args[1]`,
        field: "burnAmount",
        expected: expected.netAmount.toString(),
        actual: stringifyArg(tokenLeaf.args[1]),
      });
    }
  } else {
    const expectedMgr = expected.tokenManagerAddress ?? "";
    if (tokenLeaf.args[1] !== expectedMgr) {
      findings.push({
        code: "changed_spender",
        path: `${path}.args[1]`,
        field: "tokenManager",
        expected: expectedMgr,
        actual: stringifyArg(tokenLeaf.args[1]),
      });
    }
    if (tokenLeaf.args[2] !== expected.netAmount) {
      findings.push({
        code: "changed_net_amount",
        path: `${path}.args[2]`,
        field: "lockAmount",
        expected: expected.netAmount.toString(),
        actual: stringifyArg(tokenLeaf.args[2]),
      });
    }
  }
  if (tokenLeaf.subInvocations.length > 0) {
    findings.push({
      code: "unexpected_sub_invocation",
      path: `${path}.subInvocations`,
      field: "count",
      expected: "0",
      actual: String(tokenLeaf.subInvocations.length),
    });
  }
}

function inspectGasBranch(
  gasNode: AuthInvocationNode,
  expected: PaidDispatchSnapshotIntent,
  path: string,
  findings: AuthPrivilegeFinding[],
): void {
  let transferLeaf = gasNode;
  let leafPath = path;

  if (gasNode.fnName === "pay_gas") {
    if (gasNode.contract !== expected.gasService) {
      findings.push({
        code: "changed_gas_recipient",
        path,
        field: "gasService",
        expected: expected.gasService,
        actual: gasNode.contract,
      });
    }
    if (gasNode.subInvocations.length !== 1 || !gasNode.subInvocations[0]) {
      findings.push({
        code: "unexpected_sub_invocation",
        path: `${path}.subInvocations`,
        field: "count",
        expected: "1",
        actual: String(gasNode.subInvocations.length),
      });
      return;
    }
    transferLeaf = gasNode.subInvocations[0];
    leafPath = `${path}.subInvocations[0]`;
  }

  if (transferLeaf.contract !== expected.nativeGasToken || transferLeaf.fnName !== "transfer") {
    findings.push({
      code: "changed_gas_token",
      path: leafPath,
      field: "nativeGasToken",
      expected: `${expected.nativeGasToken}#transfer`,
      actual: `${transferLeaf.contract}#${transferLeaf.fnName}`,
    });
  }
  if (transferLeaf.args[1] !== expected.gasService) {
    findings.push({
      code: "changed_gas_recipient",
      path: `${leafPath}.args[1]`,
      field: "gasRecipient",
      expected: expected.gasService,
      actual: stringifyArg(transferLeaf.args[1]),
    });
  }
  if (transferLeaf.args[2] !== expected.gasAmount) {
    findings.push({
      code: "changed_gas_amount",
      path: `${leafPath}.args[2]`,
      field: "gasAmount",
      expected: expected.gasAmount.toString(),
      actual: stringifyArg(transferLeaf.args[2]),
    });
  }
  if (transferLeaf.subInvocations.length > 0) {
    findings.push({
      code: "unexpected_sub_invocation",
      path: `${leafPath}.subInvocations`,
      field: "count",
      expected: "0",
      actual: String(transferLeaf.subInvocations.length),
    });
  }
}
