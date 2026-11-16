# EVM Gas Budgets for Governance and Recovery Paths

## Pinned Compiler Profile

All EVM gas baselines are reproducible under the repository's pinned Foundry compiler configuration in `evm/foundry.toml`:

- `solc = "0.8.28"`
- `evm_version = "cancun"`
- `via_ir = true`
- `optimizer = true`
- `optimizer_runs = 20000`

Changing any of these compiler settings invalidates gas comparisons and fails `evaluateEvmGasBudgets` with `compilerProfileMatched: false`.

## Representative State Growth

`evm/test/unit/RouterGasBudgets.t.sol` pre-populates the router before measuring warm governance, claim-parking and claim-settlement gas:

- `128` queued governance actions in `_actions`
- `128` full-width route-scoped replay keys in `processed`
- `128` parked `PendingClaim` entries in `_claims`

In addition to ceiling enforcement, the test asserts `O(1)` storage scaling (`<= 500` gas drift between `1` entry and `129` entries once escrow balance slots are warm).

## Pinned Baselines and Documented Tolerances

SSTORE-dominated paths carry a `10%` (`1000` bps) tolerance ceiling; compact warm storage paths carry a `15%` (`1500` bps) tolerance ceiling.

| Metric ID | Category | Storage | Recipient Class | Baseline Gas | Tolerance | Ceiling Gas |
| --- | --- | --- | --- | ---: | ---: | ---: |
| `gov.queue.cold` | Governance batch | Cold | N/A | `91,989` | `10%` | `101,187` |
| `gov.queue.warm` | Governance batch | Warm | N/A | `78,798` | `10%` | `86,677` |
| `gov.queue.batch5` | Governance batch | Warm | N/A | `393,990` | `10%` | `433,389` |
| `gov.execute.cold` | Governance batch | Cold | N/A | `11,102` | `15%` | `12,767` |
| `gov.execute.warm` | Governance batch | Warm | N/A | `8,302` | `15%` | `9,547` |
| `gov.execute.batch5` | Governance batch | Warm | N/A | `44,310` | `15%` | `50,956` |
| `gov.cancel.warm` | Governance batch | Warm | N/A | `6,087` | `15%` | `6,999` |
| `gov.emergency.pauseCold` | Governance emergency | Cold | N/A | `25,163` | `10%` | `27,679` |
| `gov.emergency.lowerLimit` | Governance emergency | Warm | N/A | `15,047` | `15%` | `17,304` |
| `inbound.normal.cold` | Direct inbound | Cold | Normal | `113,898` | `10%` | `125,287` |
| `inbound.normal.warm` | Direct inbound | Warm | Normal | `40,485` | `10%` | `44,533` |
| `inbound.park.frozenCold` | Claim parking | Cold | Hostile frozen revert | `185,518` | `10%` | `204,069` |
| `inbound.park.frozenWarm` | Claim parking | Warm | Hostile frozen revert | `159,036` | `10%` | `174,939` |
| `inbound.park.silentFalse` | Claim parking | Warm | Hostile silent false | `156,769` | `10%` | `172,445` |
| `inbound.park.hostileHook` | Claim parking | Warm | Hostile malformed hook | `204,538` | `10%` | `224,991` |
| `recovery.settle.cold` | Claim settlement | Cold | Normal | `35,520` | `15%` | `40,848` |
| `recovery.settle.warm` | Claim settlement | Warm | Normal | `11,620` | `15%` | `13,363` |
| `recovery.settle.hostileRevert` | Claim settlement | Warm | Hostile frozen revert | `8,282` | `15%` | `9,524` |

## Compatibility and Deployment Scope

No EVM router storage layout, ABI signature or wire format changed. Exact integer amounts, authenticated rail dispatch, full-width replay protection and recipient-bound claims are unchanged. Stellar Testnet outbound ITS/CCTP remains the active deployment while EVM paths remain gated behind local verification.

## Reproduction Commands

```bash
cd evm && forge test --match-contract RouterGasBudgetsTest -vv
cd ../packages/protocol && npm run check
```
