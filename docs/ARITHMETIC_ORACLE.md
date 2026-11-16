# Rational-Number Arithmetic Oracle

Hyperion validates `@hyperion/protocol` exact `bigint` math (`applyFee`, `convertDecimals`, `convertDecimalsExact`, `floorToRepresentable`, `planSourceForTarget`, `planQuote`, `planInverseQuote`, `quoteBatch`, and `minimumFromTolerance`) differentially against an independent exact rational-number oracle over $\mathbb{Q}$.

## Independent Rational Model

Rather than duplicating production integer division formulas, `packages/protocol/test/rational-oracle.test.ts` models token values as reduced fractions `num / den` (`gcd(|num|, den) = 1`, `den > 0`) in canonical whole-token units:

1. **Inequality-verified floor and ceiling:** `rationalFloor(q)` and `rationalCeil(q)` verify the defining inequalities $m \cdot \text{den} \le \text{num} < (m + 1) \cdot \text{den}$ and $(c - 1) \cdot \text{den} < \text{num} \le c \cdot \text{den}$ on every evaluation.
2. **Fee convention:** Protocol fee is projected onto the source base-unit lattice $10^{-d_s}$ using floor rounding, never charging more than `feeBps / 10_000` of the input.
3. **Decimal narrowing and unpulled dust:** Remaining whole-token value $q_{\text{net}}$ is projected onto the destination base-unit lattice $10^{-d_d}$ via floor rounding. The exact difference $q_{\text{net}} - q_{\text{dest}}$ maps back to source base units as unpulled sender dust (`grossAmount = fee + netAmount <= inputAmount`).
4. **Independent inverse planning:** Given a target `DestinationUnits` quantity $T_d$, the oracle solves for the minimal `SourceUnits` input by bracketing in $\mathbb{Q}$ and executing monotone binary search over its own forward oracle, asserting both feasibility at $A_{\min}$ and strict insufficiency at $A_{\min} - 1$.

## Source and Destination Unit Separation

Oracle quantities carry compile-time TypeScript brands (`SourceUnits` vs `DestinationUnits`) and runtime `{ unit: "source" | "destination", decimals }` metadata. Mixing `source` and `destination` base units without explicit whole-token rational conversion fails both TypeScript compilation and runtime assertions (`UnitMismatchError`).

## Active Deployment Posture and Compatibility Implications

- **Active deployment:** Stellar Testnet outbound `AxelarIts` and `Cctp` (`7` Stellar decimals to `6` EVM USDC decimals and inverse planning) are directly covered alongside general `0..=38` precision pairs; EVM and other rail surfaces remain gated until independently validated.
- **Compatibility and migration:** `planSourceForTarget` and `planInverseQuote` are purely additive exports on `@hyperion/protocol` with zero changes to existing function signatures, wire formats, or on-chain contract behavior.
