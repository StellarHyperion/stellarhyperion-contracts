# Current Stellar Testnet deployment

The wallet-owned router and ITS adapter were deployed with the dedicated `hyperion-testnet-20261028` CLI wallet and activated after the normal 3600-second router timelock. This wallet owns the fresh deployment; it does not control the older October 1 router.

| Setting          | Confirmed value                                              |
| ---------------- | ------------------------------------------------------------ |
| Router           | `CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V`   |
| CCTP adapter     | `CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT`   |
| ITS adapter      | `CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ`   |
| Admin / treasury | `GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA`   |
| Stellar USDC SAC | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`   |
| Destination      | `sepolia` / Axelar `ethereum-sepolia`                        |
| Received token   | `0xFd5a146686d16060ef9c595B37C30b248402304c`, seven decimals |
| Activated        | `2026-10-28T17:08:25Z`                                       |

The received asset is the ITS representation of Stellar USDC, not Circle's native Sepolia USDC. Route 1 sends directly to the recipient through ITS and needs no EVM Hyperion adapter.

## Deployment evidence

`deployments/stellar-testnet-phase1.json` is the canonical app/indexer record, retaining its historical filename. `deployments/evidence/2026-10-28-paid-its.json` records actual transaction hashes, ledgers, artifact hashes, token mapping, lane link, queued actions, execution and transfer acceptance status. Check that evidence for the latest source/destination verification result.

The current router uses WASM `281d946ea78b194c0ef44ad9488ed02b2aa6912fb4f6fbab523ad38f1e0803f1`; the CCTP adapter uses `80f109e7467ace6899f865a4f77079917a2bea8a5def593a4d87c08c09206af4`, built from forwarding implementation `b91c6ca`. The unchanged ITS adapter uses `5f32139554d29edc3501a39ae3d05761101234523dd48b4d9e2d81ebf001f2c3`, built from `60b3310`. Actual deployed code was downloaded and its SHA-256 verified. All initial configuration actions and the later CCTP/router upgrade actions were confirmed after their original 3600-second timelocks matured. No shortened timelock or bootstrap bypass was used.

The older deployment is preserved in `deployments/archive/stellar-testnet-2026-10-01.json`. Its separate admin upgrade instructions are historical in `docs/LEGACY_TESTNET_UPGRADE.md`. Do not run those old-address commands against this fresh deployment.

## Verified acceptance transfer

A real CLI wallet signature through the frontend application helpers sent 0.1 USDC. Stellar confirmed source transaction `b95ca748421ea4774dea6a08edebc3ad3a301244034cd10f1209f3cea234862d`. The protocol fee was 0.0003 USDC; 0.0997 USDC arrived on Sepolia in transaction `0x1fdb81fcdec18071adbdf47e359f0b9e4adc6be685c1e3bfcfb39689485037b6`. Independent RPC reads confirmed the recipient token balance and successful receipt; the backend verified matching ITS/payment events and persisted delivered status. The live acceptance test passed.

## Active Circle CCTP and native USDC

CCTP route 0 is active as of `2026-10-29T10:03:44Z`. The adapter uses Circle's published Stellar Testnet messenger and transmitter. Domains 0, 6 and 26 link to Ethereum Sepolia, Base Sepolia and Arc Testnet. Actions 5 through 7 configured and enabled CCTP; action 8 upgraded the router first. All are executed. The existing ITS lane and adapter are preserved.

`deployments/evidence/2026-10-29-cctp.json` retains preparation, upgrade, timelock and activation evidence plus real delivered acceptance transfers on all three destinations. Each test sent 0.3 testnet USDC; the protocol fee was deducted before the remaining 0.2991 USDC was burned, and the forwarding fee was deducted on destination. Confirmed native-USDC payouts were 0.038033 on Sepolia, 0.240087 on Base Sepolia and 0.276441 on Arc Testnet. Forwarding fees vary with destination gas and amount; these are historical observed results. The application displays a live budget and receive minimum before signing. Six-decimal native Circle USDC differs from the seven-decimal ITS representation.

Paid dispatch uses Circle's `cctp-forward` hook and standard finality. The router enforces the minimum destination amount after the full forwarding budget. Circle handles the destination mint without a Hyperion EVM signer. Backend verification binds the attested message to the source transfer and requires matching finalized `MessageReceived` and native-USDC mint events in a successful, confirmed canonical destination receipt. A forwarding API status alone is insufficient.

`script/stellar/enable-cctp.py` provides resumable `queue`, `forwarding` and `activate` stages. This deployment is already active; do not requeue or redeploy it. The tool keeps confirmed steps atomically and never bypasses the timelock.

## Liquid Stellar assets

The frontend discovers classic Stellar assets and finds real Horizon conversion paths into canonical USDC. Asset listing does not guarantee liquidity. Conversion is a separate, capped strict-receive transaction, followed by a fresh bridge review and signature. Converted USDC stays in the user's wallet if bridging cannot proceed. Public checkpoints preserve actual transaction hashes across interruption and prevent blind resubmission.

`deployments/evidence/2026-10-29-conversion.json` records an actual fresh native-XLM wallet, USDC trustline creation and conversion, followed by an independently verified ITS payout of 0.8107937 USDC on Sepolia. The original ITS acceptance remains preserved above. Never repeat any delivered proof transaction.

## Running the application

Use Node 22.13 or newer and a Stellar CLI identity held outside Git. The configured admin identity is named above; private key material must remain in the CLI store. Application users connect their own Stellar Testnet wallets and need testnet XLM for reserves/network fees and a liquid source balance. Direct USDC sends need the canonical trustline/balance; conversion can create that trustline. ITS also needs its displayed XLM relay budget.

Run the backend with PostgreSQL, the canonical deployment record, indexing and rail polling enabled. Redis is required only for an enabled keeper. Start Next with its backend API origin configured. The frontend verifies the live router, mapping, selected destination token and paid-transfer methods before allowing a signature.

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

Preserve the proof file across interrupted runs. Never delete a pending source hash and blindly send again. A confirmed Stellar transaction alone does not establish destination delivery. Require the indexer's matching confirmed bridge/token payment and the recipient's actual received-token balance. The additional opt-in `test/live-routes.test.ts` covers native XLM conversion and CCTP destination payouts; see the frontend README for its explicit route/proof settings.

For future contract changes, use the router's existing queue/execute upgrade path with its current admin and timelock. Adapter upgrades require the adapter admin. Mapping/link setters can overwrite configuration; read current values and confirm the intended token/network before signing.
