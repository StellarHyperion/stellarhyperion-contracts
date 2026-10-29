# Hyperion contracts

[Use Hyperion on Testnet](https://stellarhyperion.vercel.app/) | [Frontend](https://github.com/StellarHyperion/stellarhyperion-frontend) | [Backend](https://github.com/StellarHyperion/stellarhyperion-backend)

The on-chain half of Hyperion: a router on Stellar, a router on the EVM side, and one adapter per
rail they route over.

Hyperion routes transfers through chain-specific adapters and keeps protocol fees, limits and claims.
CCTP and Axelar paths delegate authenticity checks to their underlying rail contracts. The Allbridge
inbound adapter verifies a configured Ed25519 validator signature itself; that path has a different
trust assumption and is not offered by the current testnet app.

The testnet app is scoped to Stellar USDC to its seven-decimal ITS representation on Ethereum
Sepolia. That representation is not Circle's native Sepolia USDC. A route is usable only after the
operator links the lane and token and deploys the paid-transfer contract changes described below. The current deployment is active and has passed a real wallet-to-Sepolia acceptance transfer.

## Paid Stellar transfers

`HyperionRouter.bridge_out_with_gas(sender, request, gas_amount)` applies the same protocol fee,
precision, pause and flow controls as `bridge_out`. It then charges only the protocol fee itself and
calls `AxelarAdapter.dispatch_from`. ITS takes the net token amount and native XLM gas payment
directly from the user's authenticated account. The wallet signs the simulated authorization tree,
including ITS's real nested gas-service call. No Hyperion copy of the ITS message payload is needed.
All token movements, fees, gas and the router nonce unwind together if any call fails.

The legacy `bridge_out` and `dispatch` interfaces remain compatible and do not attach relay gas.
The current app uses the paid entry point and refuses a deployment missing either new method.
A successful source transaction is a dispatch, not proof of destination delivery.

The current wallet-owned router and adapter expose the paid entry point. Their activation and actual source/destination transactions are recorded in `deployments/evidence/2026-10-28-paid-its.json`. Future router upgrades use the existing timelock; adapter upgrades require its admin.
See [the exact activation runbook](docs/TESTNET_ACTIVATION.md) for reviewed artifacts, admin commands and the live acceptance test.

## Organization overview

The StellarHyperion organization divides cross-chain routing across three dedicated repositories:

| Repository                  | Purpose                                                  | Core Technologies                                      |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `stellarhyperion-contracts` | On-chain routers, adapters, and shared protocol SDK      | Soroban (Rust), EVM (Solidity, Foundry), TypeScript    |
| `stellarhyperion-backend`   | Event indexer, rail pollers, keeper upkeep, and REST API | Fastify, Postgres, Redis, BullMQ, viem, stellar-sdk    |
| `stellarhyperion-frontend`  | Stellar testnet transfers and verified status            | Next.js 16, React 19, CSS modules, Stellar Wallets Kit |

Each repository maintains independent continuous integration, dependency definitions, and issue governance while sharing protocol constants and wire codecs from `@hyperion/protocol`.

## What is in the box

```
soroban/              Rust workspace, five crates, compiled to wasm32v1-none
  hyperion-core         amounts, addresses, flow windows, strkey, codecs, CCTP parsing
  hyperion-router       the router: fees, limits, claims, timelock, adapter dispatch
  hyperion-adapter-cctp      Circle CCTP V2
  hyperion-adapter-axelar    Axelar ITS and GMP
  hyperion-adapter-allbridge Allbridge pool outbound and configured-validator inbound

evm/                  Foundry project, solc 0.8.28, via_ir
  src/HyperionRouter.sol        the same router, in the shape this chain wants
  src/adapters/                 CCTP and Axelar ITS
  src/libraries/                AmountMath, FlowGuard, StellarAddress, HyperionNotes, RouteMeta
  test/                         unit and fuzz suites
  script/                       two phase deployment, verification, a smoke transfer

packages/protocol/    TypeScript: the one copy of what both chains agree on
script/               deployment drivers for both halves
deployments/          deployment records, written by the scripts and validated on write
docs/                 the architecture document this was built from
```

## The test suites

| Tree             | Tests | Run it with                               |
| ---------------- | ----- | ----------------------------------------- |
| Soroban          | 414   | `cd soroban && cargo test --workspace`    |
| EVM              | 365   | `cd evm && FOUNDRY_PROFILE=ci forge test` |
| Protocol package | 300   | `cd packages/protocol && npm run check`   |

The current local Soroban suite passes 414 tests. EVM tests and generated-ABI parity require
Foundry, initialized submodules, and a fresh EVM build. Test counts in other trees should be read
from a current run rather than treated as deployment evidence.

The number worth more than the total is in the protocol package: `test/parity.test.ts` reads the
Rust and the Solidity off disk and fails if the error numbering, the route tags, the address kinds,
the quote blockers, the CCTP offsets, the SEP-23 version bytes, the note layout or the fee and
decimal ceilings have drifted apart. Three implementations of one wire format is the actual risk in
this design, and that test is what turns drift into a red branch rather than a transfer that
arrives somewhere unexpected.

## Things that are easy to get wrong, and what was done about them

**A Stellar address is not a 32 byte key.** It is a string with a CRC16 over its own contents, and
a bridge is the one place where an undetected flipped bit means funds delivered to an address
nobody on earth holds a secret for. So the string travels all the way to the contract and the
checksum is verified there, before anything moves, while the money is still in the sender's wallet.
Three things catch everybody implementing SEP-23 for the first time, and all three have tests:
the checksum goes on the wire little endian, a muxed address has one spare bit in its sixty ninth
character that has to be zero, and the ed25519 key comes first with the eight byte sub account id
last.

**Token representations can have different decimals.** Stellar USDC and its current Sepolia ITS representation use seven; native EVM USDC commonly uses six. A hop across a precision boundary either
loses a digit or refuses to. This code refuses: the fee is taken on the whole amount, the remainder
is floored to something the destination can represent, and a transfer whose remainder floors to
nothing is rejected by name rather than rounded to zero. The fee is charged against the gross and
the flow limit against the net, because the fee never leaves the chain and counting it would
tighten the limit by a number nobody picked.

**A muxed address cannot be paid on every rail.** The sub account id needs somewhere to travel, so
a rail that carries no payload cannot deliver to an M address. Allbridge is that rail. The router
refuses the combination up front rather than delivering to the underlying G account, because those
are different recipients and one of them is an exchange that will not credit anybody.

**A frozen recipient must not be able to wedge a delivery.** USDC can freeze an account, and by the
time a message is attested the counterpart is already burned on the far side, so reverting would
destroy the money rather than delay it. A delivery that cannot be handed over parks as a claim that
anybody may settle later, which needs no privileges because the rail fixed the recipient when it
signed.

**Pause stops departures and not arrivals.** Deliberately absent from `bridge_in`. Once a rail has
attested, refusing the message on this side does not undo anything; it only strands somebody's
money.

**Every configuration change waits.** There is no bootstrap exemption on either chain, which makes
a fresh deployment genuinely two phase and is covered below. An exemption would be a second code
path that configures a router without waiting, and that is the path an attacker wants and the path
nobody tests after week one.

## Deploying

Both routers put every configuration change through a timelock with a one hour floor. So a
deployment is: deploy, configure the adapters, queue the router changes, wait, execute. The scripts
are built around that rather than against it, and phase two is safe to run twice so a run
interrupted by a gas spike picks up where it left off.

Linking an adapter to the trusted rail or remote messenger is a separate configuration step. Read the deployed token, domain and peer settings before signing. Mapping and link setters can overwrite existing configuration, so changing a live lane changes its trust assumptions. CCTP uses Circle's published messenger/transmitter pairing; direct ITS sends use the registered ITS token and destination token manager. See `docs/TESTNET_ACTIVATION.md` for the verified active testnet deployment.

```bash
# EVM, end to end on a throwaway chain. Deploys stand in rails, runs phase one, proves the
# timelock refuses an early execution, warps past it, runs phase two, checks it is idempotent,
# verifies the chain against the record, and sends one real transfer.
script/anvil-e2e.sh

# Stellar
script/stellar/build.sh                       # fails if any wasm exceeds the 64KB ledger limit
stellar keys generate hyperion-deploy --network testnet --fund
HYPERION_PEER_CHAIN=arc-testnet script/stellar/deploy.sh
script/stellar/execute.sh                     # once the hour is up
script/stellar/link.sh                        # once the far side exists
script/stellar/verify.sh
```

`anvil-e2e.sh` is the highest value check in the repository, and it is in CI for that reason. The
things that break a deployment are not syntax errors. They are an action queued with a field the
router refuses, a lane set in the wrong order, a record whose keys do not match what phase two
reads back, and a hook the far side cannot parse. None of those show up in a compile and all four
show up there, from a cold start, in under a minute.

The smoke step is worth singling out. It sends a real transfer and then reads the burn the rail
recorded, checking the mint recipient and the hook bytes, because those two values are exactly the
ones a misconfiguration gets wrong without reverting.

### Secrets

No signing key is ever read from the environment or written to a record. The Stellar scripts take a
named identity from `stellar keys`, held in the CLI's own config directory outside this repository.
The EVM scripts take whatever Foundry was given on the command line.

There is no private key anywhere in this repository, not even a throwaway one. The local end to end
driver signs through anvil's unlocked accounts and names only a public address, so the usual
well known development key never had to appear. Grepping the tracked tree for sixty four hex
characters returns wasm hashes and a tarball checksum and nothing else.

## Recorded Stellar testnet contracts

`deployments/stellar-testnet-phase1.json` is the canonical active deployment. Its historical filename is retained. Identical copies supply the frontend and backend.

| Setting             | Active contract                                            |
| ------------------- | ---------------------------------------------------------- |
| Router              | `CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V` |
| Axelar ITS adapter  | `CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ` |
| Circle CCTP adapter | `CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT` |
| USDC asset contract | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

ITS route 1 delivers the seven-decimal Stellar USDC representation to Ethereum Sepolia. CCTP route 0 delivers six-decimal native Circle USDC to Ethereum Sepolia, Base Sepolia and Arc Testnet using paid automatic forwarding. Both routes are active, and real source/destination acceptance is recorded under `deployments/evidence/`. A fresh XLM-only wallet also completed actual conversion into USDC followed by an ITS payout. Details and receipt-verification requirements are in [the activation runbook](docs/TESTNET_ACTIVATION.md).

The older October 1 deployment is archived under `deployments/archive/`. It is not the current app router. Records are validated with the protocol package's `parseDeploymentSet`; activation also reads deployed methods and code hashes rather than treating a JSON address as proof of availability.

## Active fee routing and recovery

The active Stellar router charges 30 basis points (0.3%) on outbound USDC and transfers the protocol fee to its configured treasury atomically with dispatch. Bridge forwarding, relay and Stellar network fees are separate provider/network costs. Other liquid Stellar assets are converted into canonical USDC by a separate frontend-signed transaction before bridging.

The current testnet treasury is `GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA`, also the deployment admin and guardian. Treasury and fee changes use the existing one-hour admin timelock. Testnet balances have no cash value.

Inbound funds that cannot be paid to their recorded recipient are retained as a numbered claim. `get_claim` reads the record and `settle_claim` retries payment to that same recipient. Anyone may fund settlement, and an already settled claim cannot pay twice. Successful transfers and ordinary outbound bridge delays do not create Stellar recovery claims.

The frontend and backend deploy separately on Vercel. The backend needs persistent PostgreSQL and regular indexer execution; see the linked repositories for hosting configuration. Contract deployment is independent of website deployment. This documentation update and Git push do not redeploy or upgrade the already verified on-chain contracts.

## Contract sizes

Soroban has a hard 64KB ceiling per contract, enforced by the ledger rather than by politeness.

| Contract                          | Size         | Of the limit |
| --------------------------------- | ------------ | ------------ |
| `hyperion_router.wasm`            | 56,031 bytes | 86%          |
| `hyperion_adapter_cctp.wasm`      | 27,357 bytes | 42%          |
| `hyperion_adapter_axelar.wasm`    | 24.8 KB      | 38%          |
| `hyperion_adapter_allbridge.wasm` | 23.7 KB      | 37%          |

The router at eighty-six percent is worth watching. `script/stellar/build.sh` warns past two thirds and
fails past the limit, so this stops being a surprise.

## Working on it

```bash
cd soroban && cargo test --workspace
cd evm && forge build && FOUNDRY_PROFILE=ci forge test
cd packages/protocol && npm install && npm run check
```

Three things a newcomer gets wrong, in the order they will hit them.

`forge build` runs the linter and `deny = "warnings"` makes every compiler warning fatal, including
"state mutability can be restricted to view". A fuzz test that only calls view and pure helpers has
to be declared `view`; one that calls `expectRevert` or `warp` must not be.

The ABI files under `packages/protocol/src/abi` are generated from the Foundry build. Run
`npm run gen` after changing anything in `evm/src`. Editing them by hand is a failing test, because
the parity suite regenerates them in memory and compares byte for byte.

`packages/protocol/.npmrc` sets `legacy-peer-deps` and that is deliberate rather than lazy. viem
pulls `abitype`, whose peer range admits TypeScript 7 while the package pins the 5.x line
`typescript-eslint` supports, and npm's peer resolver walks that conflict into a null node and dies
before writing a single file. Every dependency there is a dev dependency, the lockfile is
committed, and the flag lives in the repository because an install flag that only exists on one
machine is a build that only works on one machine.

## Verification status

As of October 29, 2026, the published implementation passed Soroban, EVM, ABI parity and Anvil transfer checks in CI. Dependency security checks remain enforced and currently fail for the transitive `crypto-bigint` 0.5.5 timing advisory [RUSTSEC-2026-0387](https://github.com/RustCrypto/crypto-bigint/pull/1365), plus Vite and Vitest development-tool advisories. These findings have not been suppressed or resolved by the website deployment. See the [CI reports](https://github.com/StellarHyperion/stellarhyperion-contracts/actions/workflows/ci.yml) for details. The deployed contracts remain the separately verified testnet artifacts recorded above.

## Contributing

`.github/CONTRIBUTING.md` covers the toolchains. The pull request template asks what changed, which
chains and rails it touches, what new trust assumption it introduces if any, whether a committed
ABI or deployment record moved, and whether it touches funds in flight. The last two are the
questions whose answers are expensive to discover after a merge.

CI runs five checks behind one required status called `gate`. Every action is pinned to a full
commit SHA, because a floating tag in a workflow that can read secrets is a supply chain hole.

Security reports go through GitHub private advisories. `.github/SECURITY.md` says what is in scope
and, more usefully, what is not: the rails themselves are out, because Hyperion routes over them
and does not own them.

## License

Apache-2.0 for the contracts, MIT for the protocol package.
