/**
 * Deterministic specification and post-failure state invariant evaluator for Hyperion's reusable
 * hostile Soroban token and rail-receiver fixtures.
 *
 * Mirrors `soroban/crates/hyperion-router/src/test/hostile_fixtures.rs` so off-chain test drivers,
 * fault-injection suites and documentation share one canonical vocabulary for router boundary
 * failures across short transfers, authorization failures, frozen recipients and callback attempts.
 */

export const HOSTILE_FIXTURE_CATEGORIES = [
  "short_transfer",
  "auth_failure",
  "frozen_recipient",
  "callback_attempt",
] as const;
export type HostileFixtureCategory = (typeof HOSTILE_FIXTURE_CATEGORIES)[number];

export type HostileRouterBoundary =
  "bridge_out" | "bridge_out_with_gas" | "bridge_in" | "settle_claim";

export type HostileExpectedDisposition =
  "atomic_rollback" | "park_claim" | "settlement_refused_preserving_claim";

export interface HostileFixtureSpec {
  readonly id: string;
  readonly category: HostileFixtureCategory;
  readonly rustVariant: string;
  readonly boundary: HostileRouterBoundary;
  readonly expectedDisposition: HostileExpectedDisposition;
  readonly summary: string;
}

/** Canonical catalog of deterministic hostile Soroban fixtures exercised against `HyperionRouter`. */
export const HOSTILE_SOROBAN_FIXTURES: readonly HostileFixtureSpec[] = Object.freeze([
  {
    id: "token-short-transfer-bps-outbound",
    category: "short_transfer",
    rustVariant: "HostileTokenMode::ShortTransferBps",
    boundary: "bridge_out",
    expectedDisposition: "atomic_rollback",
    summary:
      "Basis-point haircut on sender-to-router transfer leaves router short on the adapter leg, rolling back treasury fee, flow window and outbound nonce.",
  },
  {
    id: "token-short-transfer-flat-paid-outbound",
    category: "short_transfer",
    rustVariant: "HostileTokenMode::ShortTransferFlat",
    boundary: "bridge_out_with_gas",
    expectedDisposition: "atomic_rollback",
    summary:
      "Flat stroop haircut during paid dispatch_from triggers adapter balance-delta rejection and rolls back fee transfer, flow window and nonce.",
  },
  {
    id: "token-short-transfer-inbound-parked",
    category: "short_transfer",
    rustVariant: "HostileTokenMode::ShortTransferFlat",
    boundary: "bridge_in",
    expectedDisposition: "park_claim",
    summary:
      "Short pull into router causes full-amount payout try_transfer to fail with InsufficientBalance, parking a claim instead of underpaying the recipient.",
  },
  {
    id: "rail-inbound-omit-sub-auth",
    category: "auth_failure",
    rustVariant: "InboundAuthMode::OmitSubAuth",
    boundary: "bridge_in",
    expectedDisposition: "atomic_rollback",
    summary:
      "Rail receiver omits authorize_as_current_contract for the router pull, trapping transfer and rolling back was_processed and claim_count.",
  },
  {
    id: "rail-inbound-under-authorized-amount",
    category: "auth_failure",
    rustVariant: "InboundAuthMode::UnderAuthorizeAmount",
    boundary: "bridge_in",
    expectedDisposition: "atomic_rollback",
    summary:
      "Rail receiver pre-authorizes less than the promised inbound amount, trapping the exact-args pull and rolling back replay state.",
  },
  {
    id: "rail-inbound-wrong-recipient-sub-auth",
    category: "auth_failure",
    rustVariant: "InboundAuthMode::AuthorizeWrongRecipient",
    boundary: "bridge_in",
    expectedDisposition: "atomic_rollback",
    summary:
      "Rail receiver pre-authorizes transfer to a non-router address, trapping the pull and leaving replay markers unset.",
  },
  {
    id: "token-selective-leg-failure-outbound",
    category: "auth_failure",
    rustVariant: "HostileTokenMode::FailOnTransferCall",
    boundary: "bridge_out",
    expectedDisposition: "atomic_rollback",
    summary:
      "Deterministic failure on the treasury-fee leg or adapter-push leg unwinds already-mutated flow consumption and outbound nonce.",
  },
  {
    id: "token-frozen-recipient-inbound",
    category: "frozen_recipient",
    rustVariant: "HostileToken::set_frozen",
    boundary: "bridge_in",
    expectedDisposition: "park_claim",
    summary:
      "Frozen recipient rejects try_transfer during bridge_in, parking an uncorrupted recipient-bound PendingClaim while keeping fees, flow and outbound nonce untouched.",
  },
  {
    id: "token-frozen-recipient-settle",
    category: "frozen_recipient",
    rustVariant: "HostileToken::set_frozen",
    boundary: "settle_claim",
    expectedDisposition: "settlement_refused_preserving_claim",
    summary:
      "Settling while recipient remains frozen returns RecipientNotReady without marking the claim settled or moving escrowed funds.",
  },
  {
    id: "token-frozen-treasury-outbound",
    category: "frozen_recipient",
    rustVariant: "HostileToken::set_frozen",
    boundary: "bridge_out",
    expectedDisposition: "atomic_rollback",
    summary:
      "Frozen treasury rejects fee credit during bridge_out, rolling back sender debit, flow consumption and outbound nonce.",
  },
  {
    id: "token-callback-reenter-settle-claim",
    category: "callback_attempt",
    rustVariant: "HostileTokenMode::CallbackSettleClaim",
    boundary: "settle_claim",
    expectedDisposition: "settlement_refused_preserving_claim",
    summary:
      "Token transfer attempting reentrant settle_claim is trapped by the Soroban host reentrancy guard; try_transfer surfaces RecipientNotReady and prevents double payment.",
  },
  {
    id: "token-callback-reenter-pause",
    category: "callback_attempt",
    rustVariant: "HostileTokenMode::CallbackPause",
    boundary: "bridge_out",
    expectedDisposition: "atomic_rollback",
    summary:
      "Token transfer attempting reentrant router pause during bridge_out traps and rolls back router pause state, fees, flow and nonce.",
  },
  {
    id: "rail-callback-reenter-router",
    category: "callback_attempt",
    rustVariant: "HostileRailMode::CallbackBridgeOut",
    boundary: "bridge_out",
    expectedDisposition: "atomic_rollback",
    summary:
      "Adapter dispatch attempting reentrant bridge_out, bridge_in or settle_claim traps and unwinds all outbound state mutations.",
  },
]);

/** Snapshot of router accounting dimensions before and after a hostile boundary call. */
export interface RouterBoundarySnapshot {
  readonly senderBalance: bigint;
  readonly treasuryBalance: bigint;
  readonly routerBalance: bigint;
  readonly railBalance: bigint;
  readonly recipientBalance: bigint;
  readonly flowAvailable: bigint;
  readonly lastOutNonce: bigint;
  readonly claimCount: bigint;
  readonly wasProcessed: boolean;
  readonly claimSettled: boolean | null;
}

export interface RollbackCheckResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

/** Verify that a failed outbound or inbound boundary call rolled back fees, flow, nonce and claims. */
export function verifyAtomicRollback(
  before: RouterBoundarySnapshot,
  after: RouterBoundarySnapshot,
): RollbackCheckResult {
  const violations: string[] = [];

  if (after.treasuryBalance !== before.treasuryBalance) {
    violations.push(
      `treasury fee balance drifted: expected ${before.treasuryBalance.toString()}, got ${after.treasuryBalance.toString()}`,
    );
  }
  if (after.flowAvailable !== before.flowAvailable) {
    violations.push(
      `flow_available drifted: expected ${before.flowAvailable.toString()}, got ${after.flowAvailable.toString()}`,
    );
  }
  if (after.lastOutNonce !== before.lastOutNonce) {
    violations.push(
      `last_out_nonce drifted: expected ${before.lastOutNonce.toString()}, got ${after.lastOutNonce.toString()}`,
    );
  }
  if (after.claimCount !== before.claimCount) {
    violations.push(
      `claim_count drifted: expected ${before.claimCount.toString()}, got ${after.claimCount.toString()}`,
    );
  }
  if (after.wasProcessed !== before.wasProcessed) {
    violations.push(
      `was_processed drifted: expected ${String(before.wasProcessed)}, got ${String(after.wasProcessed)}`,
    );
  }
  if (after.claimSettled !== before.claimSettled) {
    violations.push(
      `claim.settled drifted: expected ${String(before.claimSettled)}, got ${String(after.claimSettled)}`,
    );
  }
  if (
    after.senderBalance !== before.senderBalance ||
    after.routerBalance !== before.routerBalance ||
    after.railBalance !== before.railBalance ||
    after.recipientBalance !== before.recipientBalance
  ) {
    violations.push("token balances drifted across atomic rollback");
  }

  return { ok: violations.length === 0, violations };
}

/** Verify that an inbound delivery refusal parked a recipient-bound claim without touching fees, flow or outbound nonces. */
export function verifyParkedClaimTransition(
  before: RouterBoundarySnapshot,
  after: RouterBoundarySnapshot,
  inboundAmount: bigint,
  haircutOnPull = 0n,
): RollbackCheckResult {
  const violations: string[] = [];
  const expectedRouterDelta = inboundAmount - haircutOnPull;

  if (after.treasuryBalance !== before.treasuryBalance) {
    violations.push("inbound claim parking must not alter treasury fee balance");
  }
  if (after.flowAvailable !== before.flowAvailable) {
    violations.push("inbound claim parking must not consume outbound flow window");
  }
  if (after.lastOutNonce !== before.lastOutNonce) {
    violations.push("inbound claim parking must not advance outbound nonce");
  }
  if (after.recipientBalance !== before.recipientBalance) {
    violations.push("parked claim must not credit recipient before settlement");
  }
  if (after.routerBalance !== before.routerBalance + expectedRouterDelta) {
    violations.push(
      `router escrow mismatch: expected ${(before.routerBalance + expectedRouterDelta).toString()}, got ${after.routerBalance.toString()}`,
    );
  }
  if (after.railBalance !== before.railBalance - inboundAmount) {
    violations.push("rail receiver balance did not decrease by inbound amount");
  }
  if (after.claimCount !== before.claimCount + 1n) {
    violations.push("claim_count must increment by 1 when parking a claim");
  }
  if (!after.wasProcessed) {
    violations.push("was_processed must be true once inbound delivery is parked");
  }
  if (after.claimSettled !== false) {
    violations.push("newly parked claim must record settled = false");
  }

  return { ok: violations.length === 0, violations };
}
