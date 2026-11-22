# Hyperion contracts

[Use Hyperion on Testnet](https://stellarhyperion.vercel.app/) | [Frontend](https://github.com/StellarHyperion/stellarhyperion-frontend) | [Backend](https://github.com/StellarHyperion/stellarhyperion-backend)

Soroban and EVM routing contracts, rail adapters and the shared `@hyperion/protocol` TypeScript SDK for Hyperion. The public app uses the active Stellar Testnet deployment.

Hyperion routes transfers through chain-specific adapters and keeps protocol fees, limits and claims.
CCTP and Axelar paths delegate authenticity checks to their underlying rail contracts. The Allbridge
inbound adapter verifies a configured Ed25519 validator signature itself; that path has a different
trust assumption and is not offered by the current testnet app.

The active app sends canonical Stellar USDC through Axelar ITS to its seven-decimal representation on Ethereum Sepolia, or through Circle CCTP to six-decimal native USDC on Ethereum Sepolia, Base Sepolia and Arc Testnet. The frontend can first convert other liquid classic Stellar assets into USDC. ITS's representation differs from Circle's native USDC. Both active rails have real signed source/destination acceptance evidence. EVM router and Allbridge implementations are included for development; they are outside the active app's deployment scope.

Axelar dispatch now requires an explicit chain/token capability admission bound to the current
ITS token-manager type and peer. Bare ITS transfers and GMP payload transfers are distinct
capabilities. Existing chain links and token mappings are retained, but a Soroban adapter upgrade
must admit its existing Sepolia ITS pair before dispatch resumes. The EVM Axelar adapter is
development-only: its global activation gate is closed by default and must remain closed until the
EVM lane has been independently validated.

## Changes since October 12, 2026

- Implemented authenticated paid dispatch through Axelar ITS and Circle CCTP, retaining atomic protocol fees, precision checks, flow limits and failure rollback.
- Activated the Stellar router and adapters after the original one-hour timelocks, and recorded signed ITS, XLM conversion and native-USDC CCTP acceptance on all three destination testnets.
- Expanded contract/protocol regression coverage and remediated npm and native Rust cryptography dependencies, preserving the host patch's upstream source, license, provenance and cryptographic validation.

## Paid Stellar transfers

`HyperionRouter.bridge_out_with_gas(sender, request, gas_amount)` applies the same protocol fee,
precision, pause and flow controls as `bridge_out`. It then charges only the protocol fee itself and
calls `AxelarAdapter.dispatch_from`. ITS takes the net token amount and native XLM gas payment
directly from the user's authenticated account. The wallet signs the simulated authorization tree,
including ITS's real nested gas-service call. No Hyperion copy of the ITS message payload is needed.
All token movements, fees, gas and the router nonce unwind together if any call fails.

For CCTP route 0, the same paid router entry point calls the CCTP adapter's `dispatch_from` with the USDC forwarding budget. The adapter uses Circle's `cctp-forward` hook and standard finality; Circle performs the destination mint. The router checks the minimum destination amount after the full forwarding budget. ITS gas is paid in XLM, while CCTP forwarding is deducted from the USDC payout.

The legacy `bridge_out` and `dispatch` interfaces remain compatible and do not attach relay gas. The current app checks the deployed paid-entry methods before signing. A successful source transaction establishes dispatch; destination delivery requires a matching confirmed receipt and token payment.

The current wallet-owned router and adapter expose the paid entry point. Their activation and actual source/destination transactions are recorded in `deployments/evidence/2026-10-28-paid-its.json`. Future router upgrades use the existing timelock; adapter upgrades require its admin.
See [the exact activation runbook](docs/TESTNET_ACTIVATION.md) for reviewed artifacts, admin commands and the live acceptance test.

## Claim operations and API compatibility

The additive EVM `settleClaims` and Soroban `settle_claims` process 1–50 claim IDs and return
one confirmed outcome per input, retaining the stored token, amount and recipient. Ordinary
recipient refusals retain unrelated progress; the exact rollback limits differ by host and are
explained in [claim operations](docs/claim-operations.md). Archived claim markers and repeated
IDs cannot permit another payment. Version 1 failure sidecars/events distinguish refusal,
custody shortage and unavailable token reads; EVM also records isolated inexact token payouts.
Successful retries clear diagnostics. Legacy single-claim calls still revert on failure and
therefore cannot persist a new failure event.

`bridge_out_bounded` adds an explicit Soroban provider cap: ITS gas-token base units (XLM on the
active deployment), or CCTP burned-token base units (USDC), with no cross-rail unit mixing.
`bridgeOutBounded` caps EVM native provider payment in wei; EVM CCTP retains finalized delivery
with a zero token forwarding fee. `explain_outbound` / `explainOutbound` check the same local
budget, destination and adapter prerequisites as their bounded dispatch path without moving
funds. Missing validation methods are explicitly unavailable; legacy quotes never substitute
for them. Existing request and quote schemas remain compatible. The active deployment remains
Stellar Testnet outbound ITS/CCTP; new entrypoints require reviewed router/adapter upgrades,
and these source changes do not activate additional deployments.

The EVM governance and parked-claim gas budgets, including their Foundry reproduction command
and compiler profile, are documented in [EVM gas budgets](docs/EVM_GAS_BUDGETS.md).

## Organization overview

The StellarHyperion organization divides cross-chain routing across three dedicated repositories:

| Repository                                                                                | Purpose                                                        | Core Technologies                                                  |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| [stellarhyperion-contracts](https://github.com/StellarHyperion/stellarhyperion-contracts) | On-chain routers, adapters and shared protocol SDK             | Soroban/Rust, EVM/Solidity/Foundry, TypeScript                     |
| [stellarhyperion-backend](https://github.com/StellarHyperion/stellarhyperion-backend)     | Event indexing, verified payouts, optional keeper and REST API | Fastify, PostgreSQL/Neon, viem, Stellar SDK; optional Redis/BullMQ |
| [stellarhyperion-frontend](https://github.com/StellarHyperion/stellarhyperion-frontend)   | Stellar asset conversion, paid transfers and verified status   | Next.js 16, React 19, TypeScript, direct Stellar wallet SDKs       |

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

## CCTP message compatibility inspection

Before a provider message is considered for execution, inspect its raw bytes without signing or
broadcasting anything:

```bash
node script/stellar/inspect-cctp-message.mjs --message 0x...
```

The JSON report preserves the full 32-byte message nonce and complete hook bytes. It reports the
message, burn, and Hyperion hook versions, domains, burn fields, destination kind, finality
requirements, and byte offsets for truncated, oversized, or shape-incompatible fields. Unknown
versions retain their raw bytes, with decoded fields labeled as observations of the known layout.
`structurallyCompatible` describes supported shape only; `executable` is always `false`. Execution
requires separate attestation, domain, token, finality, expiry, authorization, and replay checks.
Hex input is bounded to 64 KiB of decoded bytes (256 KiB of text).

## The test suites

| Tree             | Tests | Run it with                               |
| ---------------- | ----- | ----------------------------------------- |
| Soroban          | 419   | `cd soroban && cargo test --workspace`    |
| EVM              | 382   | `cd evm && FOUNDRY_PROFILE=ci forge test` |
| Protocol package | 311   | `cd packages/protocol && npm run check`   |

These counts reflect the verified October 29 suites: 419 owned Soroban tests, 382 EVM tests and 311 protocol tests. The [successful contracts CI run](https://github.com/StellarHyperion/stellarhyperion-contracts/actions/runs/40881361908) includes the EVM suite, protocol/ABI parity, native host cryptographic vectors, Slither, dependency audits and the Anvil deployment rehearsal. EVM tests and generated-ABI parity require Foundry, initialized submodules and a fresh EVM build. Signed testnet acceptance is documented separately below.

The number worth more than the total is in the protocol package: `test/parity.test.ts` reads the
Rust and the Solidity off disk and fails if the error numbering, the route tags, the address kinds,
the quote blockers, the CCTP offsets, the SEP-23 version bytes, the note layout or the fee and
decimal ceilings have drifted apart. Three implementations of one wire format is the actual risk in
this design, and that test is what turns drift into a red branch rather than a transfer that
arrives somewhere unexpected.

Every contract surface also has a committed capability snapshot under `testdata/capabilities/`:
the public methods it exports and the routes it advertises, recorded separately for each router and
adapter. The Rust and Foundry suites compare their own surfaces with those files and the protocol
suite compares the EVM surfaces with the generated ABIs. A paid entry point cannot disappear
without an explicit compatibility acknowledgement. See
[interface capabilities](docs/INTERFACE_CAPABILITIES.md) for the format and the upgrade rules.

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
script/stellar/propose.sh                     # unsigned config-diff proposals, read only
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

`deployments/stellar-testnet-phase1.json` is the canonical active deployment. Its historical filename is retained. Identical copies supply the frontend and backend. `node script/stellar/check-deployment-copies.mjs --copies deployment-copies.json` is the read-only check that those committed copies still match, at pinned revisions; see [the activation runbook](docs/TESTNET_ACTIVATION.md#cross-repository-copy-verification).

| Setting             | Active contract                                            |
| ------------------- | ---------------------------------------------------------- |
| Router              | `CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V` |
| Axelar ITS adapter  | `CDFYEPIXO676W6E6Z4GOOR33JMRUC6DGUBGO4OWYKTO7HOGRJ6ARNOSJ` |
| Circle CCTP adapter | `CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT` |
| USDC asset contract | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

ITS route 1 delivers the seven-decimal Stellar USDC representation to Ethereum Sepolia. CCTP route 0 delivers six-decimal native Circle USDC to Ethereum Sepolia, Base Sepolia and Arc Testnet using paid automatic forwarding. Both routes are active. Signed source transactions and confirmed destination payments are published in [paid ITS evidence](deployments/evidence/2026-10-28-paid-its.json), [XLM conversion evidence](deployments/evidence/2026-10-29-conversion.json) and [CCTP evidence](deployments/evidence/2026-10-29-cctp.json). A fresh XLM-only wallet also completed actual conversion into USDC followed by an ITS payout. Details and receipt-verification requirements are in [the activation runbook](docs/TESTNET_ACTIVATION.md).

The older October 1 deployment is archived under `deployments/archive/`. It is not the current app router. Records are validated with the protocol package's `parseDeploymentSet`; activation also reads deployed methods and code hashes rather than treating a JSON address as proof of availability.

Provider token addresses can be recorded separately from an asset's canonical `address`/`sacId` and `decimals`. An optional token-level `providerAddresses` map in a deployment record is keyed by rail slug; its values are validated against that chain's address format, the token's enabled rails, and configured adapters. Existing canonical records need no changes. `providerAddressOverridesFromDeploymentSet` exposes those records in the endpoint-independent form; `parseProviderAddressOverrides` validates external chain → symbol → rail maps, and `resolveProviderAddressPair` requires an explicit address on both same-network endpoints with that provider capability. Quote helpers `planQuoteWithProviderAddresses` and `quoteBatchWithProviderAddresses` return the address metadata separately from quote amounts, so provider overrides never alter a declared chain or token precision. The protocol package continues to have zero runtime dependencies.

## Active fee routing and recovery

The active Stellar router charges 30 basis points (0.3%) on outbound USDC and transfers the protocol fee to its configured treasury atomically with dispatch. Bridge forwarding, relay and Stellar network fees are separate provider/network costs. Other liquid Stellar assets are converted into canonical USDC by a separate frontend-signed transaction before bridging.

The current testnet treasury is `GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA`, also the deployment admin and guardian. Treasury and fee changes use the existing one-hour admin timelock. Testnet balances have no cash value.

Inbound funds that cannot be paid to their recorded recipient are retained as a numbered claim. `get_claim` reads the record and `settle_claim` retries payment to that same recipient. Anyone may fund settlement, and an already settled claim cannot pay twice. Successful transfers and ordinary outbound bridge delays do not create Stellar recovery claims.

The frontend and backend deploy separately on Vercel. The backend needs persistent PostgreSQL and regular indexer execution; see the linked repositories for hosting configuration. Contract deployment is independent of website deployment. This documentation update and Git push do not redeploy or upgrade the already verified on-chain contracts.

## Contract sizes

Soroban has a hard 64KB ceiling per contract, enforced by the ledger rather than by politeness.

| Contract                          | Size         | Of the limit |
| --------------------------------- | ------------ | ------------ |
| `hyperion_router.wasm`            | 56,031 bytes | 85.5%        |
| `hyperion_adapter_cctp.wasm`      | 27,357 bytes | 41.7%        |
| `hyperion_adapter_axelar.wasm`    | 27,287 bytes | 41.6%        |
| `hyperion_adapter_allbridge.wasm` | 30,135 bytes | 46.0%        |

These are the October 29 local build sizes against the 65,536-byte limit. They describe the current source build; active deployed code hashes are recorded in the activation runbook. The router at about eighty-five percent is worth watching. `script/stellar/build.sh` warns past two thirds and
fails past the limit, so this stops being a surprise.

## Working on it

```bash
cd soroban && cargo test --workspace
cd evm && forge build && FOUNDRY_PROFILE=ci forge test
cd packages/protocol && npm install && npm run check
node --test script/stellar/test/propose.test.mjs
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

As of October 29, 2026, local verification passes all 419 Soroban tests, clippy, protocol tests/build/ABI parity and the patched host cryptographic suites. Protocol and Solidity tooling `npm audit` checks report zero known vulnerabilities. Both Rust lockfile audits report zero vulnerabilities, with the existing unmaintained `paste` warning still visible.

The native Soroban host uses a narrowly scoped RustCrypto compatibility patch to resolve [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html), selecting `crypto-bigint` 0.7.10. Its complete upstream source, license, provenance, source diff and NIST/Wycheproof/Ed25519 plus recovery/malleability regression tests are retained in [soroban/vendor](soroban/vendor/README.md). Native builds require Rust 1.87 or later. The host is absent from the normal contract WASM graph; all four rebuilt WASM artifacts are byte-identical to the saved baseline, including the deployed router and CCTP adapter. The dependency fix requires no on-chain upgrade.

Security gates remain enforced without advisory suppression. See the [CI reports](https://github.com/StellarHyperion/stellarhyperion-contracts/actions/workflows/ci.yml) for hosted results. These checks are dependency and regression validation, not a formal security audit. The deployed contracts remain the separately verified testnet artifacts recorded above.

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

Read-only Axelar note/payment tooling and its evidence boundary are documented in [Axelar reconciliation](docs/AXELAR_RECONCILIATION.md).
