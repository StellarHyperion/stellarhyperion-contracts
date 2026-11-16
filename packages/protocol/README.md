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
| `chains`      | Chains, rpc endpoints, explorers, CCTP domains, finality                               |
| `quotes`      | Pricing a rail locally, so an app can render four of them while somebody types         |
| `deployments` | Deployment records, and a loader that checks them instead of casting them              |
| `registry`    | Route-specific asset identities and rail contracts per chain, with provenance          |
| `abi`         | Generated from the Foundry build, behind its own entry point                           |

```ts
import { parseStellarAddress, planQuotes, formatUnits } from "@hyperion/protocol";
import { hyperionRouterAbi } from "@hyperion/protocol/abi";
```

The ABIs sit behind `@hyperion/protocol/abi` so an app that only wants to format an amount does not
pull forty kilobytes of JSON into its bundle to get it.

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
- `RouteKind`, `AddressKind` and `QuoteBlocker` carry the same integers in all three languages.
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

## Route-specific asset identity resolution

`ROUTE_ASSET_IDENTITIES`, `resolveAssetIdentity`, `listMatchingAssetIdentities`, and
`resolveRouteAssetPair` replace ambiguous symbol-only lookups in new APIs with explicit
`(chain, representation, issuer/address)` identities:

- Circle native ERC-20 USDC (`representation: "native_erc20"`, 6 decimals on `cctp`) and Axelar ITS
  representations (`representation: "axelar_its"` on `axelar-its`) carry distinct `identityKey`
  records rather than sharing one collapsed EVM entry.
- Whenever a selector matches multiple records on a chain (for example, querying
  `{ chain: "sepolia", symbol: "USDC" }` without `representation`, `route`, or `address`, or
  querying duplicate Stellar symbols across two issuers), `resolveAssetIdentity` throws
  `AssetIdentityAmbiguityError` instead of returning the first array match.
- Legacy symbol-only helpers (`assetOn`, `pairExists`, `routesForPair`) remain unchanged over
  `ASSETS` for backward compatibility and explicitly document their first-match symbol-only
  ambiguity behavior.
