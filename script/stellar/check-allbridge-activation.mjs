#!/usr/bin/env node
/**
 * Read-only CLI command evaluating required authority, pool, liquidity, validator and signed
 * acceptance evidence for a candidate Allbridge Core lane.
 *
 * Never enables a route, mutates local deployment records, or broadcasts transactions.
 *
 * Usage:
 *   node script/stellar/check-allbridge-activation.mjs --evidence <file.json> [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "..", "..");
const distIndex = resolve(contractsRoot, "packages/protocol/dist/index.js");

function parseArgs(argv) {
  let evidencePath = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--evidence") {
      evidencePath = argv[i + 1] ?? null;
      i += 1;
    } else if (argv[i] === "--json") {
      json = true;
    }
  }
  if (!evidencePath) {
    throw new Error("usage: check-allbridge-activation.mjs --evidence <file.json> [--json]");
  }
  return { evidencePath: resolve(evidencePath), json };
}

function hydrateEvidence(raw) {
  return {
    auth: raw.auth,
    pool: raw.pool,
    liquidity: {
      poolLiquidity: BigInt(raw.liquidity.poolLiquidity),
      minPoolLiquidity: BigInt(raw.liquidity.minPoolLiquidity),
      gasFloat: BigInt(raw.liquidity.gasFloat),
      relayCost: BigInt(raw.liquidity.relayCost),
      minGasFloatReserve: BigInt(raw.liquidity.minGasFloatReserve),
    },
    validator: raw.validator,
    acceptanceProofs: (raw.acceptanceProofs ?? []).map((p) => ({
      ...p,
      exactAmount: BigInt(p.exactAmount),
    })),
  };
}

function fallbackEvaluate(ev) {
  const blockers = [];
  const isStrkey = (s, prefix) => typeof s === "string" && s.length === 56 && s.startsWith(prefix);
  const isAdmin = (s) => isStrkey(s, "G") || isStrkey(s, "C");
  const isHex32 = (s) =>
    typeof s === "string" && /^0x[0-9a-f]{64}$/iu.test(s) && s.toLowerCase() !== `0x${"00".repeat(32)}`;

  if (
    !isAdmin(ev.auth.admin) ||
    !isStrkey(ev.auth.router, "C") ||
    !isStrkey(ev.auth.adapter, "C") ||
    !isStrkey(ev.auth.bridge, "C") ||
    !isStrkey(ev.auth.nativeToken, "C")
  ) {
    blockers.push({ code: "invalid-authority-address", section: "auth", detail: "invalid strkeys" });
  }
  if (!ev.auth.adminAuthVerified) {
    blockers.push({ code: "admin-auth-unverified", section: "auth", detail: "admin auth unverified" });
  }
  if (ev.auth.stage !== "verified-canary") {
    blockers.push({ code: "development-only-authority", section: "auth", detail: "dev-only stage" });
  }
  if (ev.auth.routerTimelockDelaySeconds < 3600) {
    blockers.push({ code: "timelock-below-minimum", section: "auth", detail: "timelock < 3600s" });
  }
  if (!ev.pool.laneLinked || !ev.pool.chain) {
    blockers.push({ code: "lane-not-linked", section: "pool", detail: "lane not linked" });
  }
  if (ev.pool.allbridgeChainId <= 0 || ev.pool.allbridgeChainId === 7) {
    blockers.push({ code: "invalid-allbridge-chain-id", section: "pool", detail: "invalid chain id" });
  }
  if (!ev.pool.railOpen) {
    blockers.push({ code: "rail-closed", section: "pool", detail: "rail closed" });
  }
  if (!ev.pool.assetMapped || !isHex32(ev.pool.receiveTokenHex)) {
    blockers.push({ code: "asset-not-mapped", section: "pool", detail: "asset not mapped" });
  }
  if (ev.liquidity.minPoolLiquidity <= 0n || ev.liquidity.poolLiquidity < ev.liquidity.minPoolLiquidity) {
    blockers.push({ code: "insufficient-pool-liquidity", section: "liquidity", detail: "low liquidity" });
  }
  const reqFloat =
    ev.liquidity.relayCost > ev.liquidity.minGasFloatReserve
      ? ev.liquidity.relayCost
      : ev.liquidity.minGasFloatReserve;
  if (ev.liquidity.relayCost <= 0n || ev.liquidity.minGasFloatReserve <= 0n || ev.liquidity.gasFloat < reqFloat) {
    blockers.push({ code: "insufficient-gas-float", section: "liquidity", detail: "low gas float" });
  }
  if (!ev.validator.validatorConfigured || !isHex32(ev.validator.validatorPublicKeyHex)) {
    blockers.push({ code: "validator-not-configured", section: "validator", detail: "missing validator" });
  }
  if (ev.validator.provenance !== "published-allbridge") {
    blockers.push({ code: "development-only-validator", section: "validator", detail: "dev validator" });
  }
  const hasOut = ev.acceptanceProofs.some((p) => p.direction === "outbound");
  const hasIn = ev.acceptanceProofs.some((p) => p.direction === "inbound");
  if (!hasOut || !hasIn) {
    blockers.push({ code: "missing-acceptance-proofs", section: "acceptance", detail: "missing proofs" });
  }
  for (const p of ev.acceptanceProofs) {
    if (p.stage !== "verified-canary") {
      blockers.push({ code: "development-only-acceptance-proof", section: "acceptance", detail: "dev proof" });
    }
    if (!p.signedByReviewer || !p.reviewerIdentity) {
      blockers.push({ code: "unsigned-acceptance-proof", section: "acceptance", detail: "unsigned proof" });
    }
    if (!p.recipientBound || p.exactAmount <= 0n || !p.sourceTxRef || !p.destinationTxRef) {
      blockers.push({ code: "unverified-recipient-or-amount", section: "acceptance", detail: "bad proof" });
    }
  }
  return {
    ready: blockers.length === 0,
    readOnly: true,
    routeEnabledByGate: false,
    submittedTransactions: 0,
    candidateChain: ev.pool.chain,
    allbridgeChainId: ev.pool.allbridgeChainId,
    trustAssumptions: {
      rail: "allbridge",
      validatorTrustModel: "configured-ed25519-validator-key",
      reliesOnCircleAttestation: false,
      reliesOnAxelarValidatorSet: false,
      circleAssuranceDistinction:
        "Allbridge relies on an adapter-configured Ed25519 validator key and pooled vUSD liquidity, completely separate from Circle CCTP V2 institutional burn-and-mint attestation.",
      axelarAssuranceDistinction:
        "Allbridge relies on a single configured Ed25519 validator key and native gas float, completely separate from Axelar's decentralized PoS amplifier quorum and ITS token managers.",
    },
    blockers,
  };
}

let evaluateFn = fallbackEvaluate;
if (existsSync(distIndex)) {
  const mod = await import(pathToFileURL(distIndex).href);
  if (typeof mod.evaluateAllbridgeActivationEvidence === "function") {
    evaluateFn = mod.evaluateAllbridgeActivationEvidence;
  }
}

const { evidencePath, json } = parseArgs(process.argv.slice(2));
const raw = JSON.parse(readFileSync(evidencePath, "utf8"));
const report = evaluateFn(hydrateEvidence(raw));

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `Allbridge activation gate [${report.candidateChain} / id=${String(report.allbridgeChainId)}]: ${report.ready ? "READY" : "BLOCKED"}\n`,
  );
  process.stdout.write(
    `  Trust model: ${report.trustAssumptions.validatorTrustModel} (Circle=${String(report.trustAssumptions.reliesOnCircleAttestation)}, Axelar=${String(report.trustAssumptions.reliesOnAxelarValidatorSet)})\n`,
  );
  process.stdout.write(
    `  Read-only guarantees: routeEnabledByGate=${String(report.routeEnabledByGate)}, submittedTransactions=${String(report.submittedTransactions)}\n`,
  );
  for (const blocker of report.blockers) {
    process.stderr.write(`  [blocker:${blocker.section}] ${blocker.code}: ${blocker.detail}\n`);
  }
}

if (!report.ready) {
  process.exitCode = 1;
}
