# Local Axelar GMP delivery rehearsal

The adapter fixture now includes one end-to-end rehearsal for the development-only GMP path:

1. The real router funds the real `AxelarItsAdapter`, which hands custody to the local ITS stand-in.
2. A callback carrying a forged source peer is rejected before it can reach the router.
3. A callback from the configured peer reaches the router with its command id and source nonce.
4. A temporarily blocked recipient produces a recipient-bound pending claim instead of losing the
   delivery; unblocking the recipient lets the claim settle once.
5. Replaying the same Axelar command id is rejected.

Run it on a local checkout with:

```sh
cd evm
forge test --match-path test/unit/AxelarItsAdapter.t.sol \\
  --match-test test_authenticated_gmp_rehearsal_preserves_custody_and_parks_a_claim
```

This is development evidence only. It uses the committed local ITS and ERC-20 stand-ins, does not
provide live Axelar validation evidence, and does not open the adapter's production deployment
gate. The active deployment remains Stellar Testnet outbound ITS/CCTP.
