/**
 * Read-only activation evidence gate for candidate Allbridge Core lanes.
 *
 * Allbridge Core operates under a configured Ed25519 validator trust model and pays relaying from
 * an adapter-held native gas float, unlike Circle CCTP V2 (institutional burn-and-mint attestation)
 * and Axelar ITS/GMP (decentralized PoS amplifier quorum). Evaluating this gate never enables a
 * route or broadcasts transactions; it strictly inspects authority, pool, liquidity, validator and
 * signed acceptance evidence and blocks activation whenever evidence is absent or development-only.
 */
import { AddressKind, tryParseStellarAddress } from "./addresses.js";

export type EvidenceStage = "development-only" | "simulated" | "verified-canary";

export type ValidatorProvenance = "development-only" | "unverified" | "published-allbridge";

export interface AllbridgeAuthorityEvidence {
  readonly admin: string;
  readonly router: string;
  readonly adapter: string;
  readonly bridge: string;
  readonly nativeToken: string;
  readonly adminAuthVerified: boolean;
  readonly routerTimelockDelaySeconds: number;
  readonly stage: EvidenceStage;
}

export interface AllbridgePoolEvidence {
  readonly chain: string;
  readonly allbridgeChainId: number;
  readonly laneLinked: boolean;
  readonly railOpen: boolean;
  readonly localToken: string;
  readonly poolAddress: string;
  readonly receiveTokenHex: string;
  readonly assetMapped: boolean;
}

export interface AllbridgeLiquidityEvidence {
  readonly poolLiquidity: bigint;
  readonly minPoolLiquidity: bigint;
  readonly gasFloat: bigint;
  readonly relayCost: bigint;
  readonly minGasFloatReserve: bigint;
}

export interface AllbridgeValidatorEvidence {
  readonly validatorConfigured: boolean;
  readonly validatorPublicKeyHex: string;
  readonly provenance: ValidatorProvenance;
}

export interface AllbridgeSignedAcceptanceProof {
  readonly direction: "outbound" | "inbound";
  readonly stage: EvidenceStage;
  readonly sourceTxRef: string;
  readonly destinationTxRef: string;
  readonly exactAmount: bigint;
  readonly recipientBound: boolean;
  readonly signedByReviewer: boolean;
  readonly reviewerIdentity: string;
}

export interface AllbridgeCandidateLaneEvidence {
  readonly auth: AllbridgeAuthorityEvidence;
  readonly pool: AllbridgePoolEvidence;
  readonly liquidity: AllbridgeLiquidityEvidence;
  readonly validator: AllbridgeValidatorEvidence;
  readonly acceptanceProofs: readonly AllbridgeSignedAcceptanceProof[];
}

export interface AllbridgeTrustAssumptions {
  readonly rail: "allbridge";
  readonly validatorTrustModel: "configured-ed25519-validator-key";
  readonly reliesOnCircleAttestation: false;
  readonly reliesOnAxelarValidatorSet: false;
  readonly circleAssuranceDistinction: string;
  readonly axelarAssuranceDistinction: string;
}

export type AllbridgeBlockerCode =
  | "invalid-authority-address"
  | "admin-auth-unverified"
  | "development-only-authority"
  | "timelock-below-minimum"
  | "lane-not-linked"
  | "invalid-allbridge-chain-id"
  | "rail-closed"
  | "asset-not-mapped"
  | "invalid-pool-address"
  | "invalid-receive-token"
  | "insufficient-pool-liquidity"
  | "insufficient-gas-float"
  | "validator-not-configured"
  | "invalid-validator-key"
  | "development-only-validator"
  | "missing-acceptance-proofs"
  | "development-only-acceptance-proof"
  | "unsigned-acceptance-proof"
  | "unverified-recipient-or-amount";

export interface AllbridgeGateBlocker {
  readonly code: AllbridgeBlockerCode;
  readonly section: "auth" | "pool" | "liquidity" | "validator" | "acceptance";
  readonly detail: string;
}

export interface AllbridgeActivationReport {
  readonly ready: boolean;
  readonly readOnly: true;
  readonly routeEnabledByGate: false;
  readonly submittedTransactions: 0;
  readonly candidateChain: string;
  readonly allbridgeChainId: number;
  readonly trustAssumptions: AllbridgeTrustAssumptions;
  readonly blockers: readonly AllbridgeGateBlocker[];
}

const STELLAR_ALLBRIDGE_CHAIN_ID = 7;
const MIN_PRODUCTION_TIMELOCK_SECONDS = 3_600;
const ZERO_BYTES32_HEX = `0x${"00".repeat(32)}`;

function isValidContractStrkey(value: string): boolean {
  const parsed = tryParseStellarAddress(value);
  return parsed.ok && parsed.parts.kind === AddressKind.Contract;
}

function isValidAdminStrkey(value: string): boolean {
  const parsed = tryParseStellarAddress(value);
  return (
    parsed.ok &&
    (parsed.parts.kind === AddressKind.Account || parsed.parts.kind === AddressKind.Contract)
  );
}

function isNonZeroBytes32Hex(value: string): boolean {
  const lowered = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(lowered)) return false;
  return lowered !== ZERO_BYTES32_HEX;
}

export const ALLBRIDGE_TRUST_ASSUMPTIONS: AllbridgeTrustAssumptions = {
  rail: "allbridge",
  validatorTrustModel: "configured-ed25519-validator-key",
  reliesOnCircleAttestation: false,
  reliesOnAxelarValidatorSet: false,
  circleAssuranceDistinction:
    "Allbridge relies on an adapter-configured Ed25519 validator key and pooled vUSD liquidity, completely separate from Circle CCTP V2 institutional burn-and-mint attestation.",
  axelarAssuranceDistinction:
    "Allbridge relies on a single configured Ed25519 validator key and native gas float, completely separate from Axelar's decentralized PoS amplifier quorum and ITS token managers.",
};

/**
 * Evaluate required authority, pool, liquidity, validator and signed acceptance evidence for a
 * candidate Allbridge lane without enabling routes or broadcasting transactions.
 */
export function evaluateAllbridgeActivationEvidence(
  evidence: AllbridgeCandidateLaneEvidence,
): AllbridgeActivationReport {
  const blockers: AllbridgeGateBlocker[] = [];

  // 1. Authority checks
  if (
    !isValidAdminStrkey(evidence.auth.admin) ||
    !isValidContractStrkey(evidence.auth.router) ||
    !isValidContractStrkey(evidence.auth.adapter) ||
    !isValidContractStrkey(evidence.auth.bridge) ||
    !isValidContractStrkey(evidence.auth.nativeToken)
  ) {
    blockers.push({
      code: "invalid-authority-address",
      section: "auth",
      detail: "admin must be a G/C strkey and router/adapter/bridge/nativeToken must be C strkeys",
    });
  }
  if (!evidence.auth.adminAuthVerified) {
    blockers.push({
      code: "admin-auth-unverified",
      section: "auth",
      detail: "administrator initialization and ownership authority has not been verified",
    });
  }
  if (evidence.auth.stage !== "verified-canary") {
    blockers.push({
      code: "development-only-authority",
      section: "auth",
      detail: `authority evidence stage "${evidence.auth.stage}" is not eligible for activation`,
    });
  }
  if (evidence.auth.routerTimelockDelaySeconds < MIN_PRODUCTION_TIMELOCK_SECONDS) {
    blockers.push({
      code: "timelock-below-minimum",
      section: "auth",
      detail: `router timelock ${String(evidence.auth.routerTimelockDelaySeconds)}s is below required ${String(MIN_PRODUCTION_TIMELOCK_SECONDS)}s`,
    });
  }

  // 2. Pool and lane checks
  if (!evidence.pool.laneLinked || evidence.pool.chain.trim().length === 0) {
    blockers.push({
      code: "lane-not-linked",
      section: "pool",
      detail: "candidate chain lane is not linked on the Allbridge adapter",
    });
  }
  if (
    evidence.pool.allbridgeChainId <= 0 ||
    evidence.pool.allbridgeChainId === STELLAR_ALLBRIDGE_CHAIN_ID
  ) {
    blockers.push({
      code: "invalid-allbridge-chain-id",
      section: "pool",
      detail: `allbridgeChainId ${String(evidence.pool.allbridgeChainId)} is invalid or points back at Stellar`,
    });
  }
  if (!evidence.pool.railOpen) {
    blockers.push({
      code: "rail-closed",
      section: "pool",
      detail: "Allbridge bridge contract reports can_swap = false",
    });
  }
  if (
    !isValidContractStrkey(evidence.pool.localToken) ||
    !isValidContractStrkey(evidence.pool.poolAddress)
  ) {
    blockers.push({
      code: "invalid-pool-address",
      section: "pool",
      detail: "localToken and poolAddress must be valid Soroban contract strkeys",
    });
  }
  if (!evidence.pool.assetMapped) {
    blockers.push({
      code: "asset-not-mapped",
      section: "pool",
      detail: "asset is not mapped for the candidate Allbridge chain lane",
    });
  }
  if (!isNonZeroBytes32Hex(evidence.pool.receiveTokenHex)) {
    blockers.push({
      code: "invalid-receive-token",
      section: "pool",
      detail: "receiveTokenHex must be a non-zero 32-byte hex identifier",
    });
  }

  // 3. Liquidity and native gas float checks
  if (
    evidence.liquidity.minPoolLiquidity <= 0n ||
    evidence.liquidity.poolLiquidity < evidence.liquidity.minPoolLiquidity
  ) {
    blockers.push({
      code: "insufficient-pool-liquidity",
      section: "liquidity",
      detail: `poolLiquidity ${evidence.liquidity.poolLiquidity.toString()} is below required ${evidence.liquidity.minPoolLiquidity.toString()}`,
    });
  }
  const requiredFloat =
    evidence.liquidity.relayCost > evidence.liquidity.minGasFloatReserve
      ? evidence.liquidity.relayCost
      : evidence.liquidity.minGasFloatReserve;
  if (
    evidence.liquidity.relayCost <= 0n ||
    evidence.liquidity.minGasFloatReserve <= 0n ||
    evidence.liquidity.gasFloat < requiredFloat
  ) {
    blockers.push({
      code: "insufficient-gas-float",
      section: "liquidity",
      detail: `gasFloat ${evidence.liquidity.gasFloat.toString()} does not cover required operational threshold ${requiredFloat.toString()}`,
    });
  }

  // 4. Validator trust checks
  if (!evidence.validator.validatorConfigured) {
    blockers.push({
      code: "validator-not-configured",
      section: "validator",
      detail: "Allbridge inbound validator key is not configured",
    });
  }
  if (!isNonZeroBytes32Hex(evidence.validator.validatorPublicKeyHex)) {
    blockers.push({
      code: "invalid-validator-key",
      section: "validator",
      detail: "validatorPublicKeyHex must be a non-zero 32-byte Ed25519 key",
    });
  }
  if (evidence.validator.provenance !== "published-allbridge") {
    blockers.push({
      code: "development-only-validator",
      section: "validator",
      detail: `validator provenance "${evidence.validator.provenance}" is development-only or unverified`,
    });
  }

  // 5. Signed acceptance proof checks
  const hasOutbound = evidence.acceptanceProofs.some((p) => p.direction === "outbound");
  const hasInbound = evidence.acceptanceProofs.some((p) => p.direction === "inbound");
  if (!hasOutbound || !hasInbound) {
    blockers.push({
      code: "missing-acceptance-proofs",
      section: "acceptance",
      detail: "both outbound and inbound signed acceptance proofs are required before activation",
    });
  }
  for (const proof of evidence.acceptanceProofs) {
    if (proof.stage !== "verified-canary") {
      blockers.push({
        code: "development-only-acceptance-proof",
        section: "acceptance",
        detail: `${proof.direction} proof uses non-production stage "${proof.stage}"`,
      });
    }
    if (!proof.signedByReviewer || proof.reviewerIdentity.trim().length === 0) {
      blockers.push({
        code: "unsigned-acceptance-proof",
        section: "acceptance",
        detail: `${proof.direction} proof lacks signed reviewer attestation`,
      });
    }
    if (
      !proof.recipientBound ||
      proof.exactAmount <= 0n ||
      proof.sourceTxRef.trim().length === 0 ||
      proof.destinationTxRef.trim().length === 0
    ) {
      blockers.push({
        code: "unverified-recipient-or-amount",
        section: "acceptance",
        detail: `${proof.direction} proof is missing recipient binding, positive exactAmount, or tx references`,
      });
    }
  }

  return {
    ready: blockers.length === 0,
    readOnly: true,
    routeEnabledByGate: false,
    submittedTransactions: 0,
    candidateChain: evidence.pool.chain,
    allbridgeChainId: evidence.pool.allbridgeChainId,
    trustAssumptions: ALLBRIDGE_TRUST_ASSUMPTIONS,
    blockers,
  };
}
