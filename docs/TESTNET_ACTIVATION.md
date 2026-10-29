# Current Stellar Testnet deployment

The paid ITS router and adapter were deployed with the dedicated `hyperion-testnet-20261028` CLI wallet and activated after the normal 3600-second router timelock. This wallet owns the fresh deployment; it does not control the older October 1 router.

| Setting          | Confirmed value                                              |
| ---------------- | ------------------------------------------------------------ |
| Router           | `CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V`   |
| ITS adapter      | `CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ`   |
| Admin / treasury | `GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA`   |
| Stellar USDC SAC | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`   |
| Destination      | `sepolia` / Axelar `ethereum-sepolia`                        |
| Received token   | `0xFd5a146686d16060ef9c595B37C30b248402304c`, seven decimals |
| Activated        | `2026-10-28T17:08:25Z`                                       |

The received asset is the ITS representation of Stellar USDC, not Circle's native Sepolia USDC. Route 1 sends directly to the recipient through ITS and needs no EVM Hyperion adapter.

## Deployment evidence

`deployments/stellar-testnet-phase1.json` is the canonical app/indexer record, retaining its historical filename. `deployments/evidence/2026-10-28-paid-its.json` records actual transaction hashes, ledgers, artifact hashes, token mapping, lane link, queued actions, execution and transfer acceptance status. Check that evidence for the latest source/destination verification result.

The router uses WASM `072629035ad4e4113d6f7fa0ae3c9c2c0d4d9c44e32eb73e1661526469a2f971`; the adapter uses `5f32139554d29edc3501a39ae3d05761101234523dd48b4d9e2d81ebf001f2c3`, built from implementation commit `60b3310`. All four configuration actions were confirmed after their original timelock matured. No shortened timelock or bootstrap bypass was used.

The older deployment is preserved in `deployments/archive/stellar-testnet-2026-10-01.json`. Its separate admin upgrade instructions are historical in `docs/LEGACY_TESTNET_UPGRADE.md`. Do not run those old-address commands against this fresh deployment.

## Verified acceptance transfer

A real CLI wallet signature through the frontend application helpers sent 0.1 USDC. Stellar confirmed source transaction `b95ca748421ea4774dea6a08edebc3ad3a301244034cd10f1209f3cea234862d`. The protocol fee was 0.0003 USDC; 0.0997 USDC arrived on Sepolia in transaction `0x1fdb81fcdec18071adbdf47e359f0b9e4adc6be685c1e3bfcfb39689485037b6`. Independent RPC reads confirmed the recipient token balance and successful receipt; the backend verified matching ITS/payment events and persisted delivered status. The live acceptance test passed.

## Operate and verify

## Adding Circle CCTP

The additional adapter `CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT` is deployed against Circle's published Stellar Testnet messenger and transmitter. Domains 0, 6 and 26 are linked to Sepolia, Base Sepolia and Arc Testnet. Router actions 5, 6 and 7 are queued under the existing 3600-second timelock. Their exact maturity and configuration are recorded in `deployments/evidence/2026-10-29-cctp.json`. The route remains unavailable until activation; deployment alone is not an available lane.

`python3 script/stellar/enable-cctp.py queue --identity hyperion-testnet-20261028` resumes preparation without creating duplicate adapters or pending changes. After the recorded `activateAfter`, run the same command with `activate` in place of `queue`. The tool verifies Circle's domain, messenger pairing, pause state and remote messenger links, records confirmed steps atomically, and checks the installed adapter, receiver and enabled route. It never shortens or bypasses the timelock. The existing ITS lane remains intact.

## Running the application

Use Node 22.13 or newer and a Stellar CLI identity held outside Git. The configured admin identity is named above; private key material must remain in the CLI store. Application users connect their own Stellar Testnet wallets and need the canonical USDC trustline/balance plus testnet XLM for relay and network fees.

Run the backend with PostgreSQL, the canonical deployment record, indexing and rail polling enabled. Redis is required only for an enabled keeper. Start Next with its backend API origin configured. The frontend verifies the live router, mapping, ITS destination token and paid-transfer methods before allowing a signature.

The frontend's opt-in `test/live-transfer.test.ts` uses the actual application quote and submission helpers with a named CLI wallet. It spends 0.1 testnet USDC plus relay/network fees, saves the real source hash before broadcast, and checks destination token balance and verified indexer delivery. It is skipped in normal test runs. Set these public/non-secret inputs only when intentionally running a live test:

```bash
HYPERION_LIVE_TESTNET=1 \
HYPERION_TESTNET_IDENTITY=hyperion-testnet-user-20261028 \
HYPERION_TESTNET_RECIPIENT=0x6ef8032ffE4943F27388172549f6700f18BB8b38 \
NEXT_PUBLIC_HYPERION_API_URL=http://127.0.0.1:8080 \
HYPERION_TESTNET_APP_URL=http://127.0.0.1:3100 \
HYPERION_TESTNET_PROOF=/tmp/hyperion-live-transfer-proof.json \
npx vitest run test/live-transfer.test.ts
```

Preserve the proof file across interrupted runs. Never delete a pending source hash and blindly send again. A confirmed Stellar transaction alone does not establish destination delivery. Require the indexer's matching confirmed ITS/token payment and the recipient's actual received-token balance.

For future contract changes, use the router's existing queue/execute upgrade path with its current admin and timelock. Adapter upgrades require the adapter admin. Mapping/link setters can overwrite configuration; read current values and confirm the intended token/network before signing.
