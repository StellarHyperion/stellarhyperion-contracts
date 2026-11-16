import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  HOSTILE_FIXTURE_CATEGORIES,
  HOSTILE_SOROBAN_FIXTURES,
  verifyAtomicRollback,
  verifyParkedClaimTransition,
} from "../src/hostileFixtures.js";
import type { RouterBoundarySnapshot } from "../src/hostileFixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const rustFixturesPath = join(
  repoRoot,
  "soroban",
  "crates",
  "hyperion-router",
  "src",
  "test",
  "hostile_fixtures.rs",
);
const docsPath = join(repoRoot, "docs", "HOSTILE_SOROBAN_FIXTURES.md");

const BASE_SNAPSHOT: RouterBoundarySnapshot = {
  senderBalance: 10_000_000_000n,
  treasuryBalance: 0n,
  routerBalance: 0n,
  railBalance: 1_000_000_000n,
  recipientBalance: 0n,
  flowAvailable: 10_000_000_000n,
  lastOutNonce: 0n,
  claimCount: 0n,
  wasProcessed: false,
  claimSettled: null,
};

describe("hostile Soroban token and receiver fixtures", () => {
  it("covers short transfers, auth failures, frozen recipients and callback attempts", () => {
    for (const category of HOSTILE_FIXTURE_CATEGORIES) {
      const matching = HOSTILE_SOROBAN_FIXTURES.filter((item) => item.category === category);
      expect(matching.length, `missing fixtures for ${category}`).toBeGreaterThanOrEqual(2);
    }

    const uniqueIds = new Set(HOSTILE_SOROBAN_FIXTURES.map((item) => item.id));
    expect(uniqueIds.size).toBe(HOSTILE_SOROBAN_FIXTURES.length);
  });

  it("stays synchronized with the Rust fixture contract variants and independent docs", () => {
    const rustSource = readFileSync(rustFixturesPath, "utf8");
    const docText = readFileSync(docsPath, "utf8");

    for (const spec of HOSTILE_SOROBAN_FIXTURES) {
      const symbol = spec.rustVariant.split("::")[1]!;
      expect(rustSource.includes(symbol), `hostile_fixtures.rs missing ${spec.rustVariant}`).toBe(
        true,
      );
      expect(docText.includes(spec.id), `docs missing fixture id ${spec.id}`).toBe(true);
    }
  });

  it("verifies fees, flow, nonce, replay markers and claims across atomic rollbacks", () => {
    expect(verifyAtomicRollback(BASE_SNAPSHOT, { ...BASE_SNAPSHOT })).toEqual({
      ok: true,
      violations: [],
    });

    const drifted = verifyAtomicRollback(BASE_SNAPSHOT, {
      ...BASE_SNAPSHOT,
      treasuryBalance: 1_000_000n,
      flowAvailable: 9_001_000_000n,
      lastOutNonce: 1n,
      claimCount: 1n,
      wasProcessed: true,
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.violations).toHaveLength(5);
  });

  it("verifies parked-claim accounting for frozen recipients and inbound short pulls", () => {
    const frozenParked: RouterBoundarySnapshot = {
      ...BASE_SNAPSHOT,
      routerBalance: 1_000_000_000n,
      railBalance: 0n,
      claimCount: 1n,
      wasProcessed: true,
      claimSettled: false,
    };
    expect(verifyParkedClaimTransition(BASE_SNAPSHOT, frozenParked, 1_000_000_000n)).toEqual({
      ok: true,
      violations: [],
    });

    const shortPullParked: RouterBoundarySnapshot = {
      ...frozenParked,
      routerBalance: 999_999_990n,
    };
    expect(
      verifyParkedClaimTransition(BASE_SNAPSHOT, shortPullParked, 1_000_000_000n, 10n),
    ).toEqual({
      ok: true,
      violations: [],
    });

    const corruptedFlow = verifyParkedClaimTransition(
      BASE_SNAPSHOT,
      { ...frozenParked, flowAvailable: 9_000_000_000n, lastOutNonce: 1n },
      1_000_000_000n,
    );
    expect(corruptedFlow.ok).toBe(false);
    expect(corruptedFlow.violations).toContain(
      "inbound claim parking must not consume outbound flow window",
    );
    expect(corruptedFlow.violations).toContain(
      "inbound claim parking must not advance outbound nonce",
    );
  });
});
