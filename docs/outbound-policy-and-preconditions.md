# Outbound Policy, Preconditions, and Rail Gating

This document describes the outbound precondition protections, atomic batching mechanisms, and destination flow controls introduced to Hyperion router contracts, along with migration and compatibility implications.

---

## 1. Explicit Quote Fingerprint Binding (#57)

### Motivation & Behavior
To prevent front-running, unexpected parameter updates, or stale execution under modified fee or routing configurations, callers may bind outbound dispatch requests to an explicit configuration fingerprint:
$$\text{Fingerprint} = \text{SHA-256}(\text{route}, \text{adapter}, \text{fee\_bps}, \text{source\_decimals}, \text{destination\_decimals})$$

- **Pre-Debit Enforcement:** If `preconditions.quote_fingerprint` is provided, the contract validates the expected hash against the currently active configuration *before* debiting the sender or triggering adapter dispatch.
- **Fingerprint Mismatch Refusal:** If an admin updates the adapter address, alters the fee in basis points, or if decimals do not match the expected quote configuration, the transfer reverts immediately with `HyperionError::FingerprintMismatch` (error code 48).
- **Legacy Compatibility:** Senders invoking legacy entrypoints (`bridge_out`, `bridge_out_with_gas`) or omitting the fingerprint (`quote_fingerprint: None`) remain fully functional.

---

## 2. Sender-Specified Expiry Deadlines (#58)

### Motivation & Behavior
Senders may attach an execution deadline to outbound bridge requests to guard against delayed block inclusion or stale relay execution:
- **Ledger Sequence Deadlines:** Numerical values `< 1_000_000_000` are evaluated against `env.ledger().sequence()`.
- **Timestamp Deadlines:** Numerical values `≥ 1_000_000_000` are evaluated against unix timestamp `env.ledger().timestamp()`.
- **Fail-Fast Invariant:** Expired requests fail immediately with `HyperionError::RequestExpired` (error code 49) *before* outbound nonces are incremented, *before* flow windows are consumed, and *before* tokens are debited.

---

## 3. Atomic Bounded Batch Dispatch (#59)

### Motivation & Behavior
Institutional and algorithmic users requiring atomic multi-transfer dispatch can execute grouped requests via:
- `bridge_out_batch(sender, requests, max_total_amount)`
- `bridge_out_batch_items(sender, items, max_total_amount)`

### Invariants:
1. **Bounded Cardinality & Value:** Batch sizes are constrained to $1 \le N \le 20$ items, and the sum of item amounts must not exceed `max_total_amount`, returning `HyperionError::BatchLimitExceeded` (error code 50) if violated.
2. **Sequential Unique Nonces:** Each transfer within the batch receives its own distinct, incrementing router nonce.
3. **Atomic Rollback:** If any provider or downstream transfer in the batch encounters slippage, flow limitation, or token debit failure, the entire transaction reverts atomically with zero funds debited.

---

## 4. Per-Destination Outbound Flow Policy (#60)

### Motivation & Behavior
In addition to global token and per-route flow limits, Hyperion supports fine-grained destination chain policies (`DestinationFlowLimit`):
- **Bounded Hierarchy:** A destination limit cannot bypass existing route or token bounds. The effective limit is strictly computed as:
  $$\text{effective\_limit} = \min(\text{route\_limit}, \text{destination\_limit})$$
- **Quote & Dispatch Parity:** Both `quote_routes_for_destination` and `bridge_out` report the same binding limit. When a transfer exceeds available destination headroom, both report `HyperionError::DestinationFlowLimitExceeded` (error code 51) and state the exact headroom available.
- **Timelocked Governance & Emergency Lowering:**
  - Raising a destination limit requires standard timelocked governance (`AdminAction::SetDestinationFlowLimit`).
  - Lowering a destination limit can be executed immediately by the admin or guardian without a timelock delay via `lower_destination_flow_limit`.

---

## 5. Deployment Architecture & Rail Gating Policy

Hyperion's production deployment strategy separates production-active rails from rails under validation:
- **Active Deployment:** Stellar Testnet outbound Axelar ITS and Circle CCTP are active and independently verified as documented in [`TESTNET_ACTIVATION.md`](file:///home/kaycee/projects/makuo/stellarhyperion-contracts/docs/TESTNET_ACTIVATION.md).
- **Gated Rails:** EVM inbound routing, Allbridge, and non-validated rail adapters remain explicitly gated until live contract verification and audit sign-off are complete. Automated tests mock or simulate these subsystems locally without exposing live network risk.
- **Migration Path:** Contract upgrades preserve deployed storage keys and account trustlines without state migration or nonce resets.
