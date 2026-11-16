# Allbridge Activation Evidence Gate

## Purpose

Allbridge Core remains a development-only adapter in Hyperion. Unlike Circle CCTP V2 (institutional burn-and-mint attestation) and Axelar ITS/GMP (decentralized PoS amplifier quorum), Allbridge inbound delivery relies on an adapter-configured Ed25519 validator key and outbound dispatch spends from an adapter-held native gas float into a pooled liquidity contract.

Before any Allbridge lane may be proposed for router activation, operators must run the read-only activation evidence gate across both the Soroban adapter view (`inspect_lane_readiness`) and the offline evidence evaluator (`script/stellar/check-allbridge-activation.mjs`).

## Required Evidence Pillars

1. **Authority (`auth`):** Valid Stellar strkeys (`G`/`C` for admin, `C` for router, adapter, bridge and native SAC), verified administrator initialization authority, `verified-canary` stage and router timelock `>= 3600` seconds.
2. **Pool and Lane (`pool`):** Linked destination lane (`allbridge_chain_id != 7`), live `can_swap == true`, valid Soroban pool contract and non-zero remote `receive_token` mapping.
3. **Liquidity and Gas Float (`liquidity`):** Exact integer pool balance `>= minPoolLiquidity` and native gas float covering `max(relayCost, minGasFloatReserve)`.
4. **Validator Trust (`validator`):** Non-zero 32-byte Ed25519 validator key with `published-allbridge` provenance. Reports explicitly separate this single-key trust model from Circle CCTP V2 and Axelar assurances.
5. **Signed Acceptance Proofs (`acceptanceProofs`):** Both outbound and inbound `verified-canary` transfer proofs with reviewer signature, exact integer amount verification and recipient binding. Absent, simulated or `development-only` proofs fail the gate.

## Non-Mutating Guarantee

Neither `AllbridgeAdapter::inspect_lane_readiness` nor `script/stellar/check-allbridge-activation.mjs` enables a route, queues a router action or broadcasts a transaction. Stellar Testnet outbound ITS/CCTP remains the active deployment.

## Commands

```bash
cd soroban && cargo test -p hyperion-adapter-allbridge --locked
cd ../packages/protocol && npm run check
node script/stellar/check-allbridge-activation.mjs --evidence path/to/evidence.json --json
```
