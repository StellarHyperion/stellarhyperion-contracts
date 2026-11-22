# @hyperion/protocol

The facts both halves of Hyperion have to agree on.

Hyperion is a router, not a bridge. It never decides on its own that a cross chain message is real;
it hands transfers to rails that already made that decision and were audited for it, and it keeps
the bookkeeping, the limits and the fees. That split is the reason this package exists. Two
contracts, an indexer, a keeper and a web app all need the same answer to the same questions: what
a rail is called, how a Stellar address is encoded, how many decimal places survive a hop, how a
flow window decays, and what a revert actually meant. Four implementations of those answers is
three too many, and the three that drift are the ones nobody notices until somebody's money is in
the wrong place.

So this package holds one copy, and a test suite that checks it against the contracts rather than
against itself.

## What is in here

| Module        | What it is for                                                                         |
| ------------- | -------------------------------------------------------------------------------------- |
| `bytes`       | Hex, big endian integers, ascii, slicing that refuses a short read instead of clamping |
| `routes`      | The four rails, their tag values, and what is true about each one                      |
| `errors`      | Both chains' error vocabularies with a sentence of help per error                      |
| `addresses`   | Stellar strkeys: parse, encode, and the two wire forms the rails want                  |
| `notes`       | The notes Hyperion writes into a rail's payload so a delivery knows who it is for      |
| `amounts`     | Fees, decimal conversion, and formatting that never touches a float                    |
| `flow`        | Sliding flow windows, the same arithmetic both routers run                             |
| `cctp`        | Reading CCTP V2 messages, which is all this side ever does with them                   |
| `events`      | Typed, versioned inspection of one raw router event, Soroban XDR or EVM log            |
| `wire-compat` | Wire layouts and error tables as data, and a breaking/compatible report between sets   |
| `chains`      | Chains, rpc endpoints, explorers, CCTP domains, finality                               |
| `quotes`      | Pricing a rail locally, so an app can render four of them while somebody types         |
| `deployments` | Deployment records, and a loader that checks them instead of casting them              |
| `registry`    | Assets and rail contracts per chain, with provenance attached                          |
| `abi`         | Generated from the Foundry build, behind its own entry point                           |

```ts
import { parseStellarAddress, planQuotes, formatUnits } from "@hyperion/protocol";
import { hyperionRouterAbi } from "@hyperion/protocol/abi";
```

The ABIs sit behind `@hyperion/protocol/abi` so an app that only wants to format an amount does not
pull forty kilobytes of JSON into its bundle to get it.

## Destination minimum planning

`planForwardQuote` applies a caller-supplied forwarding reserve to an ordinary route quote, and
`planInverseQuote` finds the smallest source amount that meets a requested destination minimum
after that reserve. `quoteMinimumBatch` performs the same inversion for a list of minimums. These
APIs use bigint end to end and the exact protocol-fee and representability floors used by
`planQuote`; the inverse result includes the achieved minimum, rounding overshoot and its bound.

The reserve is explicitly denominated in `destination-token-base-units` and is subtracted from the
bridged amount before comparing the recipient minimum. It is not a provider gas estimate or a
conversion from native gas to the bridged asset. Callers must supply a reserve appropriate to their
provider and denomination; no provider pricing or exchange rate is assumed.

These are planning primitives, not authorization to dispatch. The only independently validated
outbound scope is Stellar Testnet USDC over CCTP to Sepolia, Base Sepolia or Arc Testnet, and over
ITS to Sepolia. Consumers should gate outbound use with
`validatedOutboundRoutesForPair` and `hasValidatedOutboundQuoteWiring`; generic `routesForPair`
and `planQuote` describe configured/math capabilities, not launch validation. EVM-source routes
and other rails remain gated until separately validated. This adds SDK APIs only: no wire format,
ABI, authenticated rail dispatch, replay protection, or recipient-bound claim behavior changes.
Existing `QuoteRequest` and quote results remain compatible; consumers opting into inverse plans
must provide the explicit reserve unit and migrate UI copy to distinguish a destination-token
reserve from gas units.

## Quote explanation tree

`explainQuote(request, snapshot)` returns the quote `planQuote` would return, plus a
machine-readable account of why it came out that way. `explainQuotes(request, snapshot)` does this
for every rail and adds the ranking `bestQuote` applied.

```ts
const { quote, blockedBy, groups } = explainQuote(request, snapshot);
if (blockedBy !== null) {
  // e.g. { id: "flow.headroom", kind: "router-policy", source: "snapshot.flowAvailable[route]", ... }
}
```

**Checks.** The tree lists every check in the router's own order, grouped as `route`,
`destination`, `token`, `amount`, `breaker` and `flow`. Each check is `pass`, `blocked` or
`not-reached`, and records the value it read. A blocked rail points at its `QUOTE_POLICIES` entry.
That entry gives the `QuoteBlocker`, the kind of owner (`router-policy`, `rail-capability`,
`sender-input` or `protocol-bound`), the exact source field (for example
`snapshot.routeEnabled[route]` or `ROUTE_META[route].carriesPayload`), how it changes on chain, and
who can fix it (`fixableBy`, which is the same as `BLOCKER_COPY`).

The `breaker` group mirrors the token-wide emergency circuit breaker. `breaker.latched` reads
`snapshot.circuitBreakerTripped`, and `breaker.headroom` compares the net amount with
`snapshot.circuitBreakerAvailable`. Both fields are optional, and an absent field passes, which is
how `planQuote` reads them. When a field is present, it must be a boolean or a non-negative
`uint256` respectively.

**Derivations.** Each derivation has a formula, exact `bigint` inputs and a value:

- `amount.fee`
- `amount.net-before-precision`
- `amount.precision-floor`, with its divisor
- `amount.dust`, which stays with the sender
- `flow.available` and `flow.remaining`
- `settlement.gross`, `settlement.retained` and `settlement.destination`

**Exactness.** The explanation recomputes every value and then compares itself with `planQuote`
field by field. It throws rather than describe a different quote. The tests hold it to
`fee + netBeforePrecision = amount`, `net + dust = netBeforePrecision` and `gross + retained = amount`
across a seeded sweep and at `MAX_QUOTE_AMOUNT` with precisions from 0 to 38.

**Ranking.** The ranking marks each rail as the winner, blocked (with its policy), lower on
destination amount, or a tie broken by the canonical asset, by attestation wait, or by keeping the
earlier rail.

**Determinism.** The explanation reads only its arguments, with no network, clock or randomness.
`serializeQuoteExplanation` writes stable JSON with bigints as decimal strings. A malformed request,
or a snapshot outside the bounded planners' limits, throws a `TypeError` or `RangeError` that names
the field.

**Compatibility and migration.** This adds new exports only: `RouteQuote`, `planQuote` and the
other planners are unchanged, so existing callers need nothing. The explanation describes local
arithmetic and configured capability. It is not a live price, a chain confirmation or permission to
dispatch. The active deployment is still Stellar Testnet outbound ITS/CCTP. EVM-source and other
rails remain gated until they are independently validated, whatever their explanation says.

## Snapshot persistence and bounded planning

`serializeQuoteSnapshot` and `parseQuoteSnapshot` preserve bigint amounts as canonical decimal
strings with schema version 1, explicit source and destination units, and capture time in Unix
seconds. The source label is always `router-snapshot`. Parsing validates booleans, route keys,
fee and precision bounds, integer widths and optional token identity before returning typed data.
Consumers should treat these values as historical observations and refresh chain state before
signing. Unsupported versions and malformed fields fail with a field path.

`maximumSend` finds the largest source request within the supplied balance, rounded net flow
allowance and protocol amount bound. Its search takes at most 128 integer steps, even for balances
wider than a machine word. `requestAmount` is the input to dispatch; `quote.grossAmount` is the
actual debit after precision flooring. `precisionDust` stays with the sender and `balanceDust`
reports the balance beyond the request. A blocked result has `executable: false`, with no quote.
`searchBoundedQuotes` adds a source maximum, destination minimum and explicit allowed routes,
returning a reason for every excluded rail in enum order.

`quoteBatchWithSharedFlow` plans transfers in input order against one virtual budget. Only a
successful winning rail consumes its net amount; excluded items consume nothing. The result
includes consumed and remaining amounts per rail, and does not mutate the caller's snapshot.
`quoteBatch` continues to price independent tiers against the original headroom.

`parseRouteHealthSnapshot` accepts external measurement records with explicit scope, provider
and Unix-second timestamps. `applyRouteHealth` can only restrict existing chain support; healthy
records cannot activate an unsupported route. Missing, unknown, degraded or unavailable records
block a rail. Supply `{ scope, provider, now, maxAge }` to require a matching, fresh measurement.
Without that context, every supplied provider for a route must be healthy. These measurements
describe provider observations, not live prices, transfer authorization or deployment readiness.

These additions preserve existing quote APIs and carry no runtime dependencies. Snapshot and
health schemas are newly versioned; consumers adopting them must supply units and time explicitly.
The active deployment remains Stellar Testnet outbound ITS/CCTP. EVM-source and other rail use
still require separately validated activation evidence.

## Asset identity, and why a symbol is not one

A ticker names an asset the way a surname names a person. `USDC` on Base can be Circle's native
issuance or an Axelar Interchain Token Service representation of it, and those are two contracts
with two addresses, sometimes two precisions and two different sets of rails. Picking the first
entry that matches a symbol is how a transfer leaves as the wrong token.

So the identity of an asset is everything that distinguishes it on its chain:

- the chain key (`base`, `stellar-testnet`, …)
- the representation, `native` or `its`
- the on-chain handle: an EVM contract address, or a Stellar code and issuer

The registry and the deployment loader both expose identity-first lookups:

```ts
import {
  assetIdentity,
  assetOn,
  assetByIdentity,
  resolveAsset,
  resolveAssetForRoute,
  resolveToken,
  tokenByIdentity,
  planQuoteForAsset,
} from "@hyperion/protocol";

resolveAsset({ chain: "base", symbol: "USDC" });
// → { ok: false, reason: "ambiguous", candidates: [native, its] }

resolveAsset({ chain: "base", symbol: "USDC", representation: "its" });
// → { ok: true, asset: the ITS entry }

resolveAssetForRoute("base", RouteKind.Cctp, "USDC");
// → { ok: true, asset: native USDC }, because the ITS entry does not list CCTP
```

`resolveAsset`, `resolveAssetForRoute` and `resolveToken` either name exactly one entry or return a
reason (`not-found` or `ambiguous`) and the candidates, so a picker can show the choice instead of
hiding it. `assetByIdentity` and `tokenByIdentity` take an identity and answer a single asset or
null; they never approximate. `planQuoteForAsset` and `planQuotesForAsset` price a named identity,
and an identity the registry does not carry, or a rail the representation is not registered for,
comes back `TokenNotRegistered` rather than priced against whatever token the snapshot held.

Identity-scoped quotes require `snapshot.tokenIdentity` to name the token whose registration,
decimals and flow limits were read, and require its decimals to match the resolved registry asset.
An unqualified or mismatched snapshot is blocked. Legacy quotes without a requested identity
remain available. Supply the token identity when migrating to the new quote APIs; registry
membership alone cannot establish which token an arbitrary snapshot describes.

### Legacy symbol lookup

`assetOn(chain, symbol)` and `tokenFor(set, chain, symbol)` remain, because plenty of code only
knows a ticker and a chain. Their ambiguity behaviour is now explicit and the same in both:

- exactly one match returns it
- no match returns null
- **more than one match returns null**

A duplicate symbol never silently resolves to the first entry. `pairExists` and `routesForPair`
follow `assetOn`, so an ambiguous end makes them answer `false` and `[]` rather than guess.
Migration is mechanical: if a call site can see two representations of one ticker, switch it to
`resolveAsset({ chain, symbol, representation })`, `resolveAssetForRoute` or `assetByIdentity`.

### Deployment records

Deployment token entries may now carry two optional fields:

```json
"tokens": {
  "USDC": { "address": "0x8335…2913", "representation": "native", … },
  "USDC.its": {
    "symbol": "USDC",
    "representation": "its",
    "address": "0x…",
    "routes": ["axelar-its"],
    …
  }
}
```

`symbol` defaults to the map key and `representation` defaults to `native`, so every file written
before this change loads unchanged and keeps its current meaning. The map key is now free to be a
stable identity key (`USDC.its`) rather than a ticker, which is what allows two representations of
one asset in one record. Unknown representation values are refused by the loader with the field
path, because a typo must not quietly promote an ITS representation to native.

Compatibility is additive: no existing exported name changed its parameters or return type, and
`quoteBatch` results grew one field (`asset`, null when no identity was supplied). The one
behavioural change is the ambiguity rule above, which only differs for a registry or record that
actually lists a duplicate symbol.

### Current deployment scope

The active deployment is **Stellar Testnet, outbound ITS/CCTP**. EVM and other rail development
remains explicitly gated until it is independently validated; the EVM entries in `registry` are
reference data for those rails and are not evidence that a route is live. Identity resolution
does not change that gate: a resolved asset says what token a rail would use, not that the rail is
enabled on chain.

## Three decisions worth knowing about

**No runtime dependencies.** Everything works on `Uint8Array` and `bigint`. No `Buffer`, no viem at
runtime, nothing that assumes Node. The same module is imported by a browser bundle and by a
Fastify process, and neither should be paying for the other's conveniences.

**`bigint` wherever money or an identifier appears.** A `uint256` does not fit in a double, and
neither does a muxed sub account id. The test suite uses two to the fifty three plus one as a
fixture precisely because that is the first integer a `number` gets wrong, and getting it wrong
means crediting the wrong sub account rather than throwing.

**Formatting is canonical, not localised.** `formatUnits` emits no thousands separators, and
`parseUnits` refuses a comma rather than guessing what it meant. A comma is a decimal point across
most of Europe, so a package that grouped digits here would be handing somebody a figure out by a
factor of a thousand. Grouping is a presentation decision; `Intl.NumberFormat` in the app already
knows whose conventions to use. What comes out of `formatUnits` goes straight back into
`parseUnits` unchanged, which is what makes it safe to put in an input field.

## The parity test

`test/parity.test.ts` is the reason to trust the rest. It reads the Rust and the Solidity off disk
and checks that:

- `SOROBAN_ERROR_NAMES` matches `HyperionError` name for name and number for number, and that the
  numbering really does start at one. Reordering that enum would relabel every failure the Stellar
  side has ever emitted, each one plausibly, which is the worst kind of wrong.
- `EVM_ERROR_NAMES` matches the declaration order in `HyperionErrors.sol`.
- Every error selector equals `keccak256` of its signature, so no selector is ever typed by hand.
- `describeError` and `HyperionProtocolError` expose a stable `recovery` class: `transient`,
  `user_correctable`, `operator_action`, or `unknown_outcome`. Unknown names and submission
  uncertainty use `unknown_outcome` and are never automatic retry recommendations.
- `RouteKind`, `AddressKind` and `QuoteBlocker` carry the same integers in all three languages.
- `laneKey` includes network, both chain keys, exact source and destination asset identities, and
  the canonical provider slug. `parseLaneKey` validates the network and provider before a caller
  treats the lane as executable, so two USDC representations never share a key.
- The CCTP offsets, the SEP-23 version bytes, the note layout and the fee and decimal ceilings
  match the constants the contracts actually use.
- Regenerating `src/abi` produces byte for byte what is committed.

The address fixtures are lifted from `evm/test/unit/StellarAddress.t.sol`, which already passes
against a Solidity implementation, and most of them also appear in the Rust suite. A codec checked
only against its own encoder proves the pair agree with each other and nothing else. The one number
in the suite that comes from outside this repository is the CRC16 of a known body, `0xB1D5`,
because a checksum that only agrees with itself is not a checksum.

## Working on it

```bash
npm install          # the committed lockfile is what CI installs
npm run gen          # regenerate src/abi from ../../evm/out, after a forge build
npm run check        # format, lint, typecheck, test, build
```

`npm run gen` needs `forge build` to have run in `../../evm` first. It reads what the compiler
produced rather than guessing, and says so if the artifacts are missing.

`.npmrc` sets `legacy-peer-deps`, and that is deliberate rather than lazy. viem pulls `abitype`,
whose peer range is `typescript >=5.0.4`; TypeScript 7 satisfies that while this package pins the
5.x line `typescript-eslint` supports, and npm's peer resolver walks that conflict into a null node
and dies before writing a single file. Every dependency here is a dev dependency, the package ships
with none at runtime, and `package-lock.json` is committed, so what CI installs is what was tested.
The flag lives in the repository rather than in somebody's shell history because an install flag
that only exists on one machine is a build that only works on one machine.

## Provenance

Addresses in `registry/contracts.ts` and `registry/assets.ts` carry a `source` and a `confirmed`
flag. `confirmed: true` means a primary source was read for that exact entry while this was being
written. Circle's CCTP V2 contracts are address identical across EVM chains, so the Ethereum, Base
and Sepolia entries ship as defaults and are marked `confirmed: false`, because "it is the same
everywhere else" is a reasonable inference and not a reading. Stellar's CCTP addresses are absent
entirely rather than guessed; they come from the deployment record. Shipping a plausible address as
if it were verified is how somebody loses money to a deploy script that looked fine.

## Compare dated router snapshots

`compareSnapshots` compares an explicitly dated collection using one source amount and destination.
Each row includes a deterministic all-rail ladder and its best available quote. Rows sort by timestamp
and ID; ties between rails use the existing canonical-asset/attestation policy in route enum order.
Supply `route` only when comparing the same single rail over time; the complete ladder remains available.
All amounts stay `bigint` throughout the comparison.

```ts
import { compareSnapshots } from "@hyperion/protocol";

const representation = {
  tokenDecimals: 6,
  destinationNetwork: "stellar-testnet",
  destinationTokenId: destinationSacId,
  destinationDecimals: 7,
};
const comparisons = compareSnapshots(
  { amount: 1_000_000n, strkey: recipient, destinationDecimals: 7 },
  observations.map(({ id, takenAt, snapshot }) => ({
    id,
    takenAt,
    snapshot,
    network: "sepolia",
    tokenId: sourceTokenAddress,
    representation,
  })),
  { now: observedUnixSeconds, network: "sepolia", tokenId: sourceTokenAddress, representation },
  60,
);
```

Snapshot timestamps, the reference clock and maximum age are non-negative safe integer Unix seconds.
The exact maximum-age boundary is fresh; future observations and malformed/duplicate IDs are separate
statuses. An old observation is `stale`; a fresh snapshot whose rails refuse the request is `unavailable`.
Invalid fee/precision/flow data is reported as `invalid`, rather than used in arithmetic.

Compatibility binds source chain, source token contract and precision, destination chain, destination
SAC/token contract and precision. Chain keys must be known and both ends must use the same network mode.
EVM contract IDs normalize address case; Stellar SAC IDs require valid checksums. Tickers such as `USDC`
are insufficient. Older unqualified `DatedSnapshot` inputs return `incompatible`; migrate by adding the
concrete `representation` to both each observation and the reference. The existing quote, amount and
SDK deployment lookup APIs remain intact.

Every result is `planningOnly: true`. Caller-supplied snapshots are read-only planning evidence, not
verified live state or an activation decision. This existing local quote engine accepts Stellar recipient
strkeys and is suitable for EVM-to-Stellar development comparisons; it does not implement the active
Stellar-to-EVM outbound quote interface. The active deployment remains Stellar Testnet outbound ITS/CCTP;
EVM and other rail execution stays gated until independently validated. Confirm actual router quotes,
network/token identities and provider costs through the applicable chain integration before execution.

## Provider token addresses

Deployment token records may include an optional `providerAddresses` object keyed by rail slug.
These addresses are kept separate from the canonical token address and its declared decimals:

```json
{
  "address": "0x...",
  "decimals": 6,
  "flowLimit": "1000000000",
  "routes": ["cctp"],
  "providerAddresses": { "cctp": "0x..." }
}
```

`parseProviderAddressOverrides` validates external override data against known chains, asset
capabilities, provider slugs, and the address format for each chain. Quote callers can use
`resolveProviderAddressPair`, `planQuoteWithProviderAddresses`, or
`quoteBatchWithProviderAddresses` to require both ends of a same-network route explicitly. Missing
pairs and malformed values raise `ProviderAddressError` with the failing field path; canonical
token addresses, chain identities, and precision are never inferred from or replaced by provider
overrides. Older deployment records remain valid because the field is optional. Adding overrides
is therefore data-only and requires no schema-version change.

## Inspecting raw router events

`inspectSorobanRouterEvent` takes one entry of a Stellar RPC `getEvents` response: base64 XDR
`topic` and `value`, plus `type`, `contractId` and `inSuccessfulContractCall` when present.
`inspectEvmRouterEvent` takes one log in the `eth_getLogs`/viem shape (`address`, `topics`, `data`,
`removed`). Both return `{ ok: true, event }` or `{ ok: false, name, diagnostics }`. They need no
database, no XDR library and no ABI decoder, and keep no state between calls.

```ts
const result = inspectSorobanRouterEvent(rpcEvent, { router: ROUTER_CONTRACT_ID });
if (result.ok && result.event.payout.kind === "router-paid-recipient") {
  // The router reported paying this recipient in a successful call. Finality is still yours to check.
}
```

The inspected events are `BridgeOut`, `BridgeIn`, `ClaimParked`, `ClaimSettled`,
`ClaimPayoutFailure` (version 1) and, on Soroban, `ReplayRecorded` (version 1).

- **Integers stay exact.** Nonces, claim ids and amounts are `bigint` at the declared width: `u64`,
  `i128` and `uint256`. The fixtures cover `u64::MAX`, `i128::MAX` and `2^256 - 1`.
- **Diagnostics are precise.** Each refusal has a `code` (`MalformedEncoding`, `NotRouterEvent`,
  `UnknownEvent`, `UninspectedEvent`, `UnsupportedEventVersion`, `SchemaMismatch`,
  `ValueOutOfRange`, `InconsistentRecord`, `UnexpectedEmitter` or `NotCommitted`), a `path`
  (`topic[2]`, `value.transfer.fee`, `data[0x80]`) and a `detail`. Byte-level failures include the
  offset. A `claim_failure_v2` topic or a replay record `version` other than 1 is
  `UnsupportedEventVersion` and is never decoded on a guess. Unknown, missing or mistyped fields
  are refused rather than ignored.
- **Nothing is mislabelled as a payout.** `payout` is `router-paid-recipient` only for a Soroban
  `BridgeIn` with `delivered: true` or a `ClaimSettled` on either chain, and only when
  `options.router` was supplied and matched the emitter. Otherwise it is `unverified-emitter`.
  `BridgeOut` is a rail dispatch, `ReplayRecorded` is a processed message id, and `ClaimParked` and
  `ClaimPayoutFailure` are outstanding claims. None of these is a payout. An **EVM `BridgeIn` is
  never payout evidence**, because the EVM router emits it for parked deliveries as well. The
  outcome is the presence or absence of a `ClaimParked` in the same transaction. A Soroban
  `BridgeIn` carries no message id; join it to the `ReplayRecorded` from the same call. A removed
  EVM log or an event from a failed Soroban call is `NotCommitted`.

EVM addresses are returned as lowercase hex, because checksumming needs keccak and the package has
no runtime dependencies. Event selectors are fixed constants (`EVM_ROUTER_EVENT_SELECTORS`). The
test suite recomputes them with viem and checks each signature against the generated router ABI.
The Soroban fixtures in `testdata/router-events-soroban.json` are the real host's encodings. They
are captured by a router test that fails if the committed file drifts.

**Compatibility and migration.** This adds new exports only. No contract, event layout, ABI, wire
format or deployment record changes, and no migration is needed. Because the inspector is strict, a
future event layout or version shows up as a named refusal rather than a silently wrong record.
Supporting it means a new inspector version. Inspection reads history and does not activate any
route. The active deployment is still Stellar Testnet outbound ITS/CCTP. EVM and other rails remain
gated until they are independently validated, and decoding an EVM log is not evidence that an EVM
route is live.

## Wire-format compatibility report

`WIRE_SCHEMAS` registers every wire layout and error table this package implements, as plain data:

| Schema              | What it is                                       |
| ------------------- | ------------------------------------------------ |
| `note.outbound@1`   | Stellar to EVM note                              |
| `note.inbound@1`    | EVM to Stellar note                              |
| `cctp.hook@1`       | CCTP hook data with its address-kind tag         |
| `cctp.header@1`     | CCTP V2 message header                           |
| `cctp.burn@1`       | CCTP V2 burn body                                |
| `axelar.metadata@1` | Axelar ITS metadata envelope                     |
| `address.strkey@1`  | SEP-23 version bytes, key, muxed id and checksum |
| `errors.soroban@1`  | Soroban error numbers                            |
| `errors.evm@1`      | EVM error selectors                              |

`compareWireSchemaSets(baseline, candidate)` returns a report whose `result` is `identical`,
`compatible` or `breaking`. Each decision in it names its rule, the `id@version` schema, the field
or error, a path to the exact property (for example `note.outbound@1/fields/nonce/offset`), and
the baseline and candidate values as canonical JSON. `formatCompatibilityReport` renders one line
per decision for a PR description or a CI log.

```ts
const baseline = parseWireSchemaSet(
  JSON.parse(readFileSync("testdata/wire-schemas-v1.json", "utf8")),
);
const report = compareWireSchemaSets(baseline, WIRE_SCHEMAS);
if (report.result === "breaking") throw new Error(formatCompatibilityReport(report));
```

Within one schema version, any change a decoder can observe is **breaking**:

- a changed field offset, length, encoding, constant (such as a version byte) or presence condition
- a changed message size
- an added or removed field
- an added, removed or renumbered tag value, which includes address-kind tags and strkey version bytes
- a removed schema
- a Soroban error inserted, renumbered, removed or reassigned
- an EVM selector or signature that changed or was removed

The **compatible** changes are:

- a new schema, or a new version of an existing one alongside the old (the note required version
  is a floor, so adding a version never downgrades a peer)
- a field or tag relabelled with identical bytes
- an appended Soroban error number
- a new EVM selector

`parseWireSchemaSet` validates external schema-set JSON strictly. It throws a
`WireSchemaFormatError` with the failing path for:

- unknown properties
- duplicate schemas, fields, labels or codes
- references to later or non-integer fields
- overlapping fixed fields
- offsets and lengths outside `0..65535`
- constants and tag values wider than their field
- Soroban codes outside `1..2^32-1`
- malformed selectors

`readWireMessage(schema, bytes)` decodes bytes against one layout. Every `uint` comes back as a
`bigint` at full width (up to `uint256`), and a refusal names the failing field. The tests use it
to check that the registry matches the real codecs and returns the verdicts the shared
version-one corpus records. The parity suite pins the registered CCTP and note offsets to the Rust
constants.

**Compatibility and migration.** This adds new exports only. No note, message, address or error
encoding changes, so no contract or stored data needs migrating. `testdata/wire-schemas-v1.json` is
the frozen version-one baseline, and it must keep comparing as `identical`. After a reviewed
compatible change such as an appended error, regenerate it with
`HYPERION_WRITE_WIRE_BASELINE=1 npx vitest run test/wire-compat.test.ts` and commit the result
alongside the change. A breaking change needs a new schema version and a coordinated rollout
across the contracts and the SDK. The active deployment is still Stellar Testnet outbound ITS/CCTP,
and EVM and other rail schemas stay reference data until those rails are independently validated.
