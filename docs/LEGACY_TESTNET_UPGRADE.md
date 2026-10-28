> Historical instructions for the October1deployment only. The current wallet-owned deployment is documented in TESTNET_ACTIVATION.md.

# Activate paid Stellar ITS transfers on testnet

This is an operator runbook, not a deployment receipt. No operation below has been submitted by the implementation work. Use the existing admin's named Stellar CLI identity; do not generate a replacement identity for these contracts.

## Scope and verified prerequisites

- Source: Stellar Testnet router `CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF`.
- Adapter: `CBK3TPRQR5A3H2AWESOUX4MVYOP63VNQ5EYHCX26EEJUC5B5FLB4DV5O`, bare ITS route 1.
- Admin: `GCHPVETUL5E4YKDLMRIBFUGFK4PMYOVKPFALVSYMP2QDYAVBA3ITQDAI`.
- Stellar USDC SAC: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`.
- ITS token id: `6fa24fa7ef4c8df79b33d677daca86b3934fc9a8a2fb58cdef14f9840ad91481`.
- Destination: Hyperion key `sepolia`, Axelar name `ethereum-sepolia`, EVM chain 11155111.
- Destination ITS: `0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C`.
- Destination token: `0xFd5a146686d16060ef9c595B37C30b248402304c`, seven decimals. This is the ITS representation of Stellar USDC, not Circle's native Sepolia USDC.

Unsigned RPC reads on 2026-10-28 confirmed the source token registration, destination token and ITS trust for `ethereum-sepolia`. The Hyperion adapter had no token mapping or Sepolia link. The existing router/adapter do not expose the new paid-transfer methods. Recheck network state before writing.

The router upgrade is timelocked (currently 3600 seconds). The adapter upgrade and mapping/linking require adapter admin authorization. This lane sends directly through ITS to the recipient; no EVM Hyperion adapter is required. Its unused peer field is twenty zero bytes.

## Review local artifacts

Run from the contracts repository root:

```bash
cd soroban
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd ..
script/stellar/build.sh
sha256sum soroban/target/wasm32v1-none/release/hyperion_router.wasm
sha256sum soroban/target/wasm32v1-none/release/hyperion_adapter_axelar.wasm
```

The reviewed build from contract commit `60b3310` produced:

| Artifact    | SHA-256                                                            |
| ----------- | ------------------------------------------------------------------ |
| Router      | `072629035ad4e4113d6f7fa0ae3c9c2c0d4d9c44e32eb73e1661526469a2f971` |
| ITS adapter | `5f32139554d29edc3501a39ae3d05761101234523dd48b4d9e2d81ebf001f2c3` |

A different toolchain may produce different bytes; review a changed artifact before installing it. The source-account authorization path was covered by the full 414-test Soroban suite, including exact sender authorization, fee/gas accounting and atomic failure rollback.

## Upload and queue the router upgrade

These commands spend testnet XLM and change on-chain state. Keep the CLI output and action id for crash recovery. The identity must already resolve to the admin above.

```bash
STELLAR_IDENTITY=hyperion-deploy
ROUTER=CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF
ADAPTER=CBK3TPRQR5A3H2AWESOUX4MVYOP63VNQ5EYHCX26EEJUC5B5FLB4DV5O
ADMIN=GCHPVETUL5E4YKDLMRIBFUGFK4PMYOVKPFALVSYMP2QDYAVBA3ITQDAI
TOKEN=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
TOKEN_ID=6fa24fa7ef4c8df79b33d677daca86b3934fc9a8a2fb58cdef14f9840ad91481

# Public-address check only. Stop if this identity is not the current admin.
stellar keys address "$STELLAR_IDENTITY"
stellar contract invoke --id "$ROUTER" --source-account "$STELLAR_IDENTITY" --network testnet --is-view -- get_config
stellar contract invoke --id "$ADAPTER" --source-account "$STELLAR_IDENTITY" --network testnet --is-view -- get_config

# Assign the hashes actually returned by these uploads. Compare them with the reviewed artifacts.
ROUTER_HASH=$(stellar contract upload --wasm soroban/target/wasm32v1-none/release/hyperion_router.wasm --source-account "$STELLAR_IDENTITY" --network testnet)
ADAPTER_HASH=$(stellar contract upload --wasm soroban/target/wasm32v1-none/release/hyperion_adapter_axelar.wasm --source-account "$STELLAR_IDENTITY" --network testnet)

stellar contract invoke --id "$ROUTER" --source-account "$STELLAR_IDENTITY" --network testnet --send yes -- queue_action --caller "$ADMIN" --action "{\"Upgrade\":[\"$ROUTER_HASH\"]}"
```

Record the returned queue id as `UPGRADE_ID`. Do not repeat `queue_action` on restart if the existing action is still pending. Read `get_queued` and preserve its `eta` and `expires_at`.

```bash
# Set UPGRADE_ID to the returned integer, never to a guessed value.
stellar contract invoke --id "$ROUTER" --source-account "$STELLAR_IDENTITY" --network testnet --is-view -- get_queued --id "$UPGRADE_ID"
```

Wait until the ledger timestamp reaches `eta`. The grace period is seven days; an expired action must be queued again. Do not change the timelock to shorten the wait.

## Execute, map and link

Recheck that the pending action contains the reviewed router hash before executing it.

```bash
stellar contract invoke --id "$ADAPTER" --source-account "$STELLAR_IDENTITY" --network testnet --send yes -- upgrade --wasm_hash "$ADAPTER_HASH"
stellar contract invoke --id "$ROUTER" --source-account "$STELLAR_IDENTITY" --network testnet --send yes -- execute_action --caller "$ADMIN" --id "$UPGRADE_ID"
stellar contract invoke --id "$ADAPTER" --source-account "$STELLAR_IDENTITY" --network testnet --send yes -- map_token --token "$TOKEN" --token_id "$TOKEN_ID"
stellar contract invoke --id "$ADAPTER" --source-account "$STELLAR_IDENTITY" --network testnet --send yes -- link_chain --chain sepolia --axelar_chain ethereum-sepolia --peer 0000000000000000000000000000000000000000

stellar contract invoke --id "$ADAPTER" --source-account "$STELLAR_IDENTITY" --network testnet --is-view -- token_id_for --token "$TOKEN"
stellar contract invoke --id "$ADAPTER" --source-account "$STELLAR_IDENTITY" --network testnet --is-view -- get_link --chain sepolia
```

Mapping and linking can overwrite existing configuration; read before retrying and stop on an unexpected value. The old `script/stellar/link.sh` is a general multi-rail helper and is not the acceptance test for this direct ITS lane.

Update the canonical deployment record only after confirmed execution, preserving transaction hashes, action id and artifact hashes. Copy that record to the frontend/backend and commit the deployment evidence separately.

## Acceptance transfer

1. Run the backend migrations, a continuous indexer and rail poller, and the Next application. Configure the frontend API origin. Check backend readiness and RPC retention before interpreting history.
2. Use a Stellar wallet on Testnet with XLM and the recorded USDC asset/trustline. The app links to the Stellar testnet account funder. Obtain the correct test USDC asset from its issuer's faucet; no arbitrary token with the same symbol is accepted.
3. Confirm the app reports the lane ready, then send a small amount to a controlled Sepolia address. Review exact USDC debit/fee and live XLM relay gas in the wallet.
4. Save the actual source transaction hash. Require source confirmation, then a successful sufficiently confirmed destination receipt with the expected ITS/token payment events. Verify the recipient's token balance changed by the expected amount.
5. Restart the backend and verify the same transfer remains indexed once, with the actual destination transaction and received token. Do not call the dapp activated until this passes.

A local unit test, gas estimate, deployment record, source confirmation or Axelar `executed` status alone does not establish a delivered cross-chain transfer. If relay gas becomes insufficient, operator intervention may be needed; this implementation does not advertise automated gas top-ups.
