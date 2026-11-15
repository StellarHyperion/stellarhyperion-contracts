/**
 * Contract-interface capability regression snapshots and upgrade evolution checks.
 *
 * Keeps router surfaces and adapter surfaces in strictly separate snapshots across Soroban and
 * EVM, derives live method and route capabilities from Rust `#[contractimpl]` blocks and
 * generated EVM ABIs, and enforces explicit compatibility acknowledgements whenever a paid
 * method or paid-route capability is removed or narrowed across an upgrade.
 *
 * Browser-safe (`Uint8Array` / plain objects / strings only; no Node.js builtins).
 */

import { ROUTE_KINDS, type RouteKind } from "./routes.js";

export type CapabilityRouteName = keyof typeof RouteKind;

export const CAPABILITY_ROUTE_NAMES: readonly CapabilityRouteName[] = [
  "Cctp",
  "AxelarIts",
  "AxelarGmp",
  "Allbridge",
] as const;

export type CapabilitySurfaceKind = "router" | "adapter";
export type CapabilityStack = "soroban" | "evm";
export type CapabilityDeploymentStatus = "active-testnet-outbound" | "gated";

export interface MethodCapability {
  readonly name: string;
  readonly signature: string;
  readonly paid: boolean;
  readonly mutability?: "pure" | "view" | "nonpayable" | "payable";
}

export interface ContractCapabilityRecord {
  readonly contractName: string;
  readonly surfaceKind: CapabilitySurfaceKind;
  readonly stack: CapabilityStack;
  readonly sourceRef: string;
  readonly deploymentStatus: CapabilityDeploymentStatus;
  readonly supportedRoutes: readonly CapabilityRouteName[];
  readonly paidRoutes: readonly CapabilityRouteName[];
  readonly methods: readonly MethodCapability[];
}

export interface RouterCapabilitySnapshot {
  readonly schemaVersion: 1;
  readonly surfaceKind: "router";
  readonly contracts: readonly ContractCapabilityRecord[];
}

export interface AdapterCapabilitySnapshot {
  readonly schemaVersion: 1;
  readonly surfaceKind: "adapter";
  readonly contracts: readonly ContractCapabilityRecord[];
}

export interface CompatibilityAcknowledgement {
  readonly surfaceKind: CapabilitySurfaceKind;
  readonly contractName: string;
  readonly target: string;
  readonly acknowledgePaidRemoval: boolean;
  readonly reason: string;
  readonly consumerMigration: string;
  readonly reference: string;
}

export interface CompatibilityPolicy {
  readonly acknowledgements: readonly CompatibilityAcknowledgement[];
}

export type CapabilityViolationCode =
  | "surface-separation-violation"
  | "contract-removed"
  | "paid-method-removed-without-ack"
  | "paid-route-removed-without-ack"
  | "method-removed-without-ack"
  | "method-signature-changed"
  | "supported-route-removed-without-ack"
  | "capability-method-mismatch";

export interface CapabilityViolation {
  readonly code: CapabilityViolationCode;
  readonly surfaceKind: CapabilitySurfaceKind;
  readonly contractName: string;
  readonly target: string;
  readonly message: string;
}

export interface CapabilityEvolutionReport {
  readonly ok: boolean;
  readonly surfaceKind: CapabilitySurfaceKind;
  readonly additiveMethods: readonly { readonly contractName: string; readonly method: string }[];
  readonly additiveRoutes: readonly { readonly contractName: string; readonly route: string }[];
  readonly acknowledgedRemovals: readonly CompatibilityAcknowledgement[];
  readonly violations: readonly CapabilityViolation[];
}

/** Minimal structural shape of a generated Solidity ABI entry. */
export interface AbiParameterLike {
  readonly name?: string;
  readonly type: string;
  readonly components?: readonly AbiParameterLike[];
}

export interface AbiItemLike {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly AbiParameterLike[];
  readonly outputs?: readonly AbiParameterLike[];
  readonly stateMutability?: "pure" | "view" | "nonpayable" | "payable";
}

const SOROBAN_PAID_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
  HyperionRouter: new Set(["bridge_out_with_gas", "supports_paid_route"]),
  CctpAdapter: new Set(["dispatch_from", "quote_max_fee"]),
  AxelarAdapter: new Set(["dispatch_from", "gas_token"]),
  AllbridgeAdapter: new Set(["fund_gas", "gas_balance", "quote_gas"]),
};

const EVM_PAID_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
  HyperionRouter: new Set(["bridgeOut"]),
  IHyperionRouter: new Set(["bridgeOut"]),
  CctpAdapter: new Set(["dispatch", "quoteFee"]),
  AxelarItsAdapter: new Set(["dispatch", "quoteFee", "topUpGas"]),
  IRailAdapter: new Set(["dispatch", "quoteFee"]),
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitTopLevelComma(input: string): string[] {
  const parts: string[] = [];
  let depthAngle = 0;
  let depthParen = 0;
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "<") depthAngle += 1;
    else if (ch === ">") depthAngle = Math.max(0, depthAngle - 1);
    else if (ch === "(") depthParen += 1;
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
    else if (ch === "," && depthAngle === 0 && depthParen === 0) {
      const piece = input.slice(start, i).trim();
      if (piece.length > 0) parts.push(piece);
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

/**
 * Extract sorted public `#[contractimpl]` methods from a Soroban contract `lib.rs` file.
 */
export function extractSorobanContractMethods(
  contractName: string,
  rustSource: string,
): readonly MethodCapability[] {
  if (CAPABILITY_ROUTE_NAMES.length !== ROUTE_KINDS.length) {
    throw new Error("CAPABILITY_ROUTE_NAMES drifted from ROUTE_KINDS");
  }
  const implIndex = rustSource.indexOf("#[contractimpl]");
  const implSource = implIndex >= 0 ? rustSource.slice(implIndex) : rustSource;
  const paidSet = SOROBAN_PAID_METHODS[contractName] ?? new Set<string>();
  const regex = /\bpub\s+fn\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)(?:\s*->\s*([^{]+))?\s*\{/g;
  const methods: MethodCapability[] = [];

  let match = regex.exec(implSource);
  while (match !== null) {
    const name = match[1] ?? "";
    const rawParams = splitTopLevelComma(match[2] ?? "");
    const userParams = rawParams.filter((param) => !/^_?env\s*:/.test(param));
    const paramTypes = userParams.map((param) => {
      const colon = param.indexOf(":");
      return colon === -1
        ? normalizeWhitespace(param)
        : normalizeWhitespace(param.slice(colon + 1));
    });
    const returnType = normalizeWhitespace(match[3] ?? "()");
    const signature = `${name}(${paramTypes.join(", ")}) -> ${returnType}`;
    methods.push({
      name,
      signature,
      paid: paidSet.has(name),
    });
    match = regex.exec(implSource);
  }

  return methods.sort((a, b) => a.name.localeCompare(b.name));
}

function formatAbiParam(param: AbiParameterLike): string {
  if (param.type.startsWith("tuple") && param.components !== undefined) {
    const suffix = param.type.slice("tuple".length);
    return `(${param.components.map(formatAbiParam).join(",")})${suffix}`;
  }
  return param.type;
}

/**
 * Extract sorted public/external ABI function capabilities from a compiled Solidity ABI.
 */
export function extractEvmAbiMethods(
  contractName: string,
  abi: readonly AbiItemLike[],
): readonly MethodCapability[] {
  const paidSet = EVM_PAID_METHODS[contractName] ?? new Set<string>();
  const methods: MethodCapability[] = [];

  for (const item of abi) {
    if (item.type !== "function" || item.name === undefined) continue;
    const inputs = (item.inputs ?? []).map(formatAbiParam).join(",");
    const outputs = (item.outputs ?? []).map(formatAbiParam).join(",");
    const mutability = item.stateMutability ?? "nonpayable";
    const signature = `${item.name}(${inputs})->(${outputs}) [${mutability}]`;
    const isPaid = mutability === "payable" || paidSet.has(item.name);
    methods.push({
      name: item.name,
      signature,
      paid: isPaid,
      mutability,
    });
  }

  return methods.sort((a, b) => a.signature.localeCompare(b.signature));
}

export interface LiveCapabilityInputs {
  readonly sorobanRouterSource: string;
  readonly sorobanCctpSource: string;
  readonly sorobanAxelarSource: string;
  readonly sorobanAllbridgeSource: string;
  readonly evmRouterAbi: readonly AbiItemLike[];
  readonly evmRouterInterfaceAbi: readonly AbiItemLike[];
  readonly evmCctpAdapterAbi: readonly AbiItemLike[];
  readonly evmAxelarItsAdapterAbi: readonly AbiItemLike[];
  readonly evmRailAdapterAbi: readonly AbiItemLike[];
}

/**
 * Build the live router-only capability snapshot (Soroban `HyperionRouter`, EVM `HyperionRouter`,
 * and EVM `IHyperionRouter`).
 */
export function buildLiveRouterCapabilitySnapshot(
  inputs: Pick<
    LiveCapabilityInputs,
    "sorobanRouterSource" | "evmRouterAbi" | "evmRouterInterfaceAbi"
  >,
): RouterCapabilitySnapshot {
  return {
    schemaVersion: 1,
    surfaceKind: "router",
    contracts: [
      {
        contractName: "HyperionRouter",
        surfaceKind: "router",
        stack: "soroban",
        sourceRef: "soroban/crates/hyperion-router/src/lib.rs",
        deploymentStatus: "active-testnet-outbound",
        supportedRoutes: ["Cctp", "AxelarIts", "AxelarGmp", "Allbridge"],
        paidRoutes: ["Cctp", "AxelarIts"],
        methods: extractSorobanContractMethods("HyperionRouter", inputs.sorobanRouterSource),
      },
      {
        contractName: "HyperionRouter",
        surfaceKind: "router",
        stack: "evm",
        sourceRef: "packages/protocol/src/abi/router.ts",
        deploymentStatus: "gated",
        supportedRoutes: ["Cctp", "AxelarIts", "AxelarGmp", "Allbridge"],
        paidRoutes: ["Cctp", "AxelarIts", "AxelarGmp", "Allbridge"],
        methods: extractEvmAbiMethods("HyperionRouter", inputs.evmRouterAbi),
      },
      {
        contractName: "IHyperionRouter",
        surfaceKind: "router",
        stack: "evm",
        sourceRef: "packages/protocol/src/abi/routerInterface.ts",
        deploymentStatus: "gated",
        supportedRoutes: ["Cctp", "AxelarIts", "AxelarGmp", "Allbridge"],
        paidRoutes: ["Cctp", "AxelarIts", "AxelarGmp", "Allbridge"],
        methods: extractEvmAbiMethods("IHyperionRouter", inputs.evmRouterInterfaceAbi),
      },
    ],
  };
}

/**
 * Build the live adapter-only capability snapshot (Soroban `CctpAdapter`, `AxelarAdapter`,
 * `AllbridgeAdapter` and EVM `CctpAdapter`, `AxelarItsAdapter`, `IRailAdapter`).
 */
export function buildLiveAdapterCapabilitySnapshot(
  inputs: Pick<
    LiveCapabilityInputs,
    | "sorobanCctpSource"
    | "sorobanAxelarSource"
    | "sorobanAllbridgeSource"
    | "evmCctpAdapterAbi"
    | "evmAxelarItsAdapterAbi"
    | "evmRailAdapterAbi"
  >,
): AdapterCapabilitySnapshot {
  return {
    schemaVersion: 1,
    surfaceKind: "adapter",
    contracts: [
      {
        contractName: "CctpAdapter",
        surfaceKind: "adapter",
        stack: "soroban",
        sourceRef: "soroban/crates/hyperion-adapter-cctp/src/lib.rs",
        deploymentStatus: "active-testnet-outbound",
        supportedRoutes: ["Cctp"],
        paidRoutes: ["Cctp"],
        methods: extractSorobanContractMethods("CctpAdapter", inputs.sorobanCctpSource),
      },
      {
        contractName: "AxelarAdapter",
        surfaceKind: "adapter",
        stack: "soroban",
        sourceRef: "soroban/crates/hyperion-adapter-axelar/src/lib.rs",
        deploymentStatus: "active-testnet-outbound",
        supportedRoutes: ["AxelarIts", "AxelarGmp"],
        paidRoutes: ["AxelarIts"],
        methods: extractSorobanContractMethods("AxelarAdapter", inputs.sorobanAxelarSource),
      },
      {
        contractName: "AllbridgeAdapter",
        surfaceKind: "adapter",
        stack: "soroban",
        sourceRef: "soroban/crates/hyperion-adapter-allbridge/src/lib.rs",
        deploymentStatus: "gated",
        supportedRoutes: ["Allbridge"],
        paidRoutes: [],
        methods: extractSorobanContractMethods("AllbridgeAdapter", inputs.sorobanAllbridgeSource),
      },
      {
        contractName: "CctpAdapter",
        surfaceKind: "adapter",
        stack: "evm",
        sourceRef: "packages/protocol/src/abi/cctpAdapter.ts",
        deploymentStatus: "gated",
        supportedRoutes: ["Cctp"],
        paidRoutes: ["Cctp"],
        methods: extractEvmAbiMethods("CctpAdapter", inputs.evmCctpAdapterAbi),
      },
      {
        contractName: "AxelarItsAdapter",
        surfaceKind: "adapter",
        stack: "evm",
        sourceRef: "packages/protocol/src/abi/axelarItsAdapter.ts",
        deploymentStatus: "gated",
        supportedRoutes: ["AxelarIts"],
        paidRoutes: ["AxelarIts"],
        methods: extractEvmAbiMethods("AxelarItsAdapter", inputs.evmAxelarItsAdapterAbi),
      },
      {
        contractName: "IRailAdapter",
        surfaceKind: "adapter",
        stack: "evm",
        sourceRef: "packages/protocol/src/abi/railAdapter.ts",
        deploymentStatus: "gated",
        supportedRoutes: ["Cctp", "AxelarIts", "AxelarGmp", "Allbridge"],
        paidRoutes: ["Cctp", "AxelarIts", "AxelarGmp", "Allbridge"],
        methods: extractEvmAbiMethods("IRailAdapter", inputs.evmRailAdapterAbi),
      },
    ],
  };
}

function findAcknowledgement(
  policy: CompatibilityPolicy | undefined,
  surfaceKind: CapabilitySurfaceKind,
  contractKey: string,
  contractName: string,
  target: string,
): CompatibilityAcknowledgement | undefined {
  if (policy === undefined) return undefined;
  return policy.acknowledgements.find(
    (ack) =>
      ack.surfaceKind === surfaceKind &&
      (ack.contractName === contractKey || ack.contractName === contractName) &&
      ack.target === target &&
      ack.reason.trim().length > 0 &&
      ack.consumerMigration.trim().length > 0 &&
      ack.reference.trim().length > 0,
  );
}

/**
 * Verify internal consistency of a router or adapter snapshot:
 *   1. No surface cross-contamination (`router` snapshot holds only `router` contracts, etc.).
 *   2. Every contract advertising non-empty `paidRoutes` exposes at least one callable `paid`
 *      method (`bridge_out_with_gas` / `dispatch_from` / `payable bridgeOut` / `payable dispatch`).
 *   3. `paidRoutes` is always a subset of `supportedRoutes`.
 */
export function verifySnapshotConsistency(
  snapshot: RouterCapabilitySnapshot | AdapterCapabilitySnapshot,
): readonly CapabilityViolation[] {
  const violations: CapabilityViolation[] = [];
  for (const contract of snapshot.contracts) {
    if (contract.surfaceKind !== snapshot.surfaceKind) {
      violations.push({
        code: "surface-separation-violation",
        surfaceKind: snapshot.surfaceKind,
        contractName: contract.contractName,
        target: contract.contractName,
        message: `Contract '${contract.contractName}' has surfaceKind '${contract.surfaceKind}' inside '${snapshot.surfaceKind}' snapshot.`,
      });
    }

    const supportedSet = new Set<string>(contract.supportedRoutes);
    for (const paidRoute of contract.paidRoutes) {
      if (!supportedSet.has(paidRoute)) {
        violations.push({
          code: "capability-method-mismatch",
          surfaceKind: snapshot.surfaceKind,
          contractName: contract.contractName,
          target: paidRoute,
          message: `Contract '${contract.contractName}' (${contract.stack}) advertises paid route '${paidRoute}' outside supportedRoutes.`,
        });
      }
    }

    if (contract.paidRoutes.length > 0) {
      const hasCallablePaidEntry = contract.methods.some(
        (m) =>
          m.paid &&
          (m.name === "bridge_out_with_gas" ||
            m.name === "dispatch_from" ||
            m.name === "bridgeOut" ||
            m.name === "dispatch"),
      );
      if (!hasCallablePaidEntry) {
        violations.push({
          code: "capability-method-mismatch",
          surfaceKind: snapshot.surfaceKind,
          contractName: contract.contractName,
          target: "paidRoutes",
          message: `Contract '${contract.contractName}' (${contract.stack}) advertises paidRoutes [${contract.paidRoutes.join(", ")}] without a callable paid dispatch/bridge method.`,
        });
      }
    }
  }
  return violations;
}

/**
 * Compare baseline and proposed capability snapshots for a single surface (`router` or `adapter`),
 * requiring explicit paid-removal acknowledgement whenever any `paid: true` method or paid route
 * is removed or downgraded.
 */
export function compareCapabilitySurface(
  baseline: RouterCapabilitySnapshot | AdapterCapabilitySnapshot,
  proposed: RouterCapabilitySnapshot | AdapterCapabilitySnapshot,
  policy?: CompatibilityPolicy,
): CapabilityEvolutionReport {
  const violations: CapabilityViolation[] = [
    ...verifySnapshotConsistency(baseline),
    ...verifySnapshotConsistency(proposed),
  ];
  const additiveMethods: { readonly contractName: string; readonly method: string }[] = [];
  const additiveRoutes: { readonly contractName: string; readonly route: string }[] = [];
  const acknowledgedRemovals: CompatibilityAcknowledgement[] = [];

  if (baseline.surfaceKind !== proposed.surfaceKind) {
    violations.push({
      code: "surface-separation-violation",
      surfaceKind: baseline.surfaceKind,
      contractName: "<snapshot>",
      target: proposed.surfaceKind,
      message: `Cannot compare '${baseline.surfaceKind}' snapshot against '${proposed.surfaceKind}' snapshot.`,
    });
    return {
      ok: false,
      surfaceKind: baseline.surfaceKind,
      additiveMethods,
      additiveRoutes,
      acknowledgedRemovals,
      violations,
    };
  }

  const keyOf = (c: ContractCapabilityRecord): string => `${c.stack}:${c.contractName}`;
  const proposedMap = new Map<string, ContractCapabilityRecord>(
    proposed.contracts.map((c) => [keyOf(c), c]),
  );

  for (const baseContract of baseline.contracts) {
    const contractKey = keyOf(baseContract);
    const nextContract = proposedMap.get(contractKey);
    if (nextContract === undefined) {
      violations.push({
        code: "contract-removed",
        surfaceKind: baseline.surfaceKind,
        contractName: contractKey,
        target: baseContract.contractName,
        message: `Contract '${contractKey}' was removed from the ${baseline.surfaceKind} snapshot.`,
      });
      continue;
    }

    const nextMethodsByName = new Map<string, MethodCapability>(
      nextContract.methods.map((m) => [m.name, m]),
    );

    for (const baseMethod of baseContract.methods) {
      const nextMethod = nextMethodsByName.get(baseMethod.name);
      if (nextMethod === undefined || (baseMethod.paid && !nextMethod.paid)) {
        const ack = findAcknowledgement(
          policy,
          baseline.surfaceKind,
          contractKey,
          baseContract.contractName,
          baseMethod.name,
        );
        if (baseMethod.paid) {
          if (ack?.acknowledgePaidRemoval === true) {
            acknowledgedRemovals.push(ack);
          } else {
            violations.push({
              code: "paid-method-removed-without-ack",
              surfaceKind: baseline.surfaceKind,
              contractName: contractKey,
              target: baseMethod.name,
              message: `Paid method '${baseMethod.name}' on '${contractKey}' was removed or downgraded without an explicit paid compatibility acknowledgement.`,
            });
          }
        } else if (ack !== undefined) {
          acknowledgedRemovals.push(ack);
        } else {
          violations.push({
            code: "method-removed-without-ack",
            surfaceKind: baseline.surfaceKind,
            contractName: contractKey,
            target: baseMethod.name,
            message: `Public method '${baseMethod.name}' on '${contractKey}' was removed without a compatibility acknowledgement.`,
          });
        }
        continue;
      }

      if (baseMethod.signature !== nextMethod.signature) {
        const ack = findAcknowledgement(
          policy,
          baseline.surfaceKind,
          contractKey,
          baseContract.contractName,
          baseMethod.name,
        );
        if (ack !== undefined && (!baseMethod.paid || ack.acknowledgePaidRemoval)) {
          acknowledgedRemovals.push(ack);
        } else {
          violations.push({
            code: "method-signature-changed",
            surfaceKind: baseline.surfaceKind,
            contractName: contractKey,
            target: baseMethod.name,
            message: `Signature of '${baseMethod.name}' on '${contractKey}' changed from '${baseMethod.signature}' to '${nextMethod.signature}'.`,
          });
        }
      }
    }

    const baseMethodNames = new Set(baseContract.methods.map((m) => m.name));
    for (const nextMethod of nextContract.methods) {
      if (!baseMethodNames.has(nextMethod.name)) {
        additiveMethods.push({ contractName: contractKey, method: nextMethod.name });
      }
    }

    const nextSupported = new Set<string>(nextContract.supportedRoutes);
    for (const route of baseContract.supportedRoutes) {
      if (!nextSupported.has(route)) {
        const ack = findAcknowledgement(
          policy,
          baseline.surfaceKind,
          contractKey,
          baseContract.contractName,
          `route:${route}`,
        );
        if (ack !== undefined) {
          acknowledgedRemovals.push(ack);
        } else {
          violations.push({
            code: "supported-route-removed-without-ack",
            surfaceKind: baseline.surfaceKind,
            contractName: contractKey,
            target: `route:${route}`,
            message: `Supported route '${route}' on '${contractKey}' was removed without acknowledgement.`,
          });
        }
      }
    }

    const baseSupported = new Set<string>(baseContract.supportedRoutes);
    for (const route of nextContract.supportedRoutes) {
      if (!baseSupported.has(route)) {
        additiveRoutes.push({ contractName: contractKey, route });
      }
    }

    const nextPaidRoutes = new Set<string>(nextContract.paidRoutes);
    for (const paidRoute of baseContract.paidRoutes) {
      if (!nextPaidRoutes.has(paidRoute)) {
        const ack = findAcknowledgement(
          policy,
          baseline.surfaceKind,
          contractKey,
          baseContract.contractName,
          `paidRoute:${paidRoute}`,
        );
        if (ack?.acknowledgePaidRemoval === true) {
          acknowledgedRemovals.push(ack);
        } else {
          violations.push({
            code: "paid-route-removed-without-ack",
            surfaceKind: baseline.surfaceKind,
            contractName: contractKey,
            target: `paidRoute:${paidRoute}`,
            message: `Paid route capability '${paidRoute}' on '${contractKey}' was removed without explicit paid compatibility acknowledgement.`,
          });
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    surfaceKind: baseline.surfaceKind,
    additiveMethods,
    additiveRoutes,
    acknowledgedRemovals,
    violations,
  };
}
