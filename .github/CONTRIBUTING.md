# Contributing to Hyperion contracts

This repository holds three things that have to agree with each other: Soroban contracts in Rust,
EVM contracts in Solidity, and a TypeScript package that is the single copy of the facts both
chains encode. Most of the friction in working here comes from that third one, because it means a
change to a route tag or an error number is never a change to one file.

Read the two traps near the bottom before you start. They catch almost everybody once, and both of
them are deliberate.

## Getting set up

Clone with submodules. forge-std and OpenZeppelin live under `evm/lib` as committed git
submodules, pinned to the revisions the test suite was run against, so a clone without them fails
on every Solidity import:

```
git clone --recurse-submodules https://github.com/StellarHyperion/stellarhyperion-contracts.git
cd stellarhyperion-contracts
```

If you already cloned without them:

```
git submodule update --init --recursive
```

Those submodules are not an accident and they are not a migration somebody forgot to finish. A
registry dependency resolves to whatever is published on the day you install it. A submodule
resolves to the same bytes for everybody, which is what you want under a contract that cannot be
edited after it ships.

### The Rust toolchain, for the Stellar half

```
rustup toolchain install stable
cd soroban
rustup show
```

`soroban/rust-toolchain.toml` pins the channel, the `wasm32v1-none` target and the `rustfmt` and
`clippy` components, so running any cargo command inside `soroban/` installs what is needed. You
do not have to add the target by hand. `rust-version = "1.87"` in `Cargo.toml` is the minimum the
crates compile on, not the channel they are built with.

### The Stellar CLI

Pinned to 28.1.0. It decides the target triple, the build profile and the metadata stamped into
the contract, so a different version produces a different artifact from the same source:

```
cargo install --locked stellar-cli@28.1.0
```

Or take the release binary from
`https://github.com/stellar/stellar-cli/releases/tag/v28.1.0`, which is what CI does, and put it
on your `PATH`. The deploy scripts look in `$HOME/.local/bin` first.

### Foundry, for the EVM half

Pinned to 1.5.1, for the same reason: the Foundry version decides the fuzzer, the linter and the
coverage instrumentation.

```
curl -L https://foundry.paradigm.xyz | bash
foundryup --install v1.5.1
```

`evm/foundry.toml` pins solc 0.8.28 and the cancun EVM version, and forge downloads that compiler
itself the first time you build.

### Node, for the protocol package

Node 20.11 or newer. 22 is what CI runs.

```
cd packages/protocol
npm ci
```

If `npm ci` dies with `Cannot read properties of null (reading 'edgesOut')`, you are running it
from somewhere other than `packages/protocol`. That directory has an `.npmrc` setting
`legacy-peer-deps`, and npm only reads it from the working directory. The reason it is needed is
written in the file: viem pulls abitype, whose peer range accepts a TypeScript major that this
package does not pin, and npm's resolver walks that conflict into a null node and dies before it
writes anything. Do not pass the flag on the command line instead. An install flag that only
exists in your shell history is a build that only works on your machine.

The protocol package also needs the Foundry build to exist before its tests pass, because the ABI
modules it exports are generated from `evm/out` and its parity test regenerates them and compares.
So the first time through, build the contracts first:

```
cd evm && forge build
cd ../packages/protocol && npm ci && npm run check
```

## Running the suites

Each of these is exactly what CI runs, which is on purpose. A local command that differs from the
branch gate is a local command nobody trusts.

**The Stellar contracts:**

```
cd soroban
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The adapters test against the real router rather than a stand in for it, so run the workspace
together. A per crate run can pass while the handover between the router and an adapter is broken,
and that handover is the part most worth checking.

**Building the Stellar contracts, with the size check:**

```
script/stellar/build.sh
```

This runs `stellar contract build` and then refuses to finish if any contract's wasm is over 64KB.
That limit is a hard ledger rule, not a guideline, and a contract that clears it today can stop
clearing it after one added branch. The script also warns at two thirds of the limit, which is
where a contract has stopped having room for the next feature. Watch that number; it is the one
budget on the Stellar side that cannot be argued with.

**The EVM contracts:**

```
cd evm
forge fmt --check
npm ci && npm run lint     # solhint, three configs
forge build
forge test                            # 512 fuzz runs, for iterating
FOUNDRY_PROFILE=ci forge test         # 20000 fuzz runs, what CI runs
forge test --gas-report
npm run coverage
```

The `ci` profile raises the fuzzer to 20,000 runs and the invariant depth to 128. Run it before
opening a pull request rather than discovering a counterexample on the branch, because the inputs
it finds are usually in the amount and address codecs and are not obvious once you see them.

**The protocol package:**

```
cd packages/protocol
npm run check     # fmt:check, eslint, tsc --noEmit, vitest, build
```

**The deployment, end to end, on a throwaway chain:**

```
script/anvil-e2e.sh
```

Run this if you touched anything in `evm/script`, the router's admin surface, the timelock, or a
deployment record. It starts its own anvil, needs no configuration and no key, and takes about a
minute after the compile. It deploys stand in rails, runs phase one, proves the timelock refuses an
early phase two, warps past the delay, runs phase two, proves phase two is idempotent, verifies the
chain against the written record, and sends one real transfer through the result.

It is the most valuable check in the repository and it is worth understanding why. The unit and
fuzz suites prove the contracts behave. They do not prove the deployment works, and the things that
break a deployment are not the things a compiler sees: an action queued with a field the router
refuses, lanes set in the wrong order, a record whose keys do not match what phase two reads back,
a hook the far side cannot parse. None of those show up in a build and all of them show up here,
before anything is signed.

## The two things newcomers get wrong

### `forge build` treats warnings as errors

`evm/foundry.toml` sets `deny = "warnings"`, and the Solidity linter runs as part of the build. So
a shadowed variable name, an unreachable branch or an unused parameter is a failed build, not a
note at the bottom of the log. The same is true in CI, which means a warning blocks a merge.

This surprises people and it is not an accident. A warning is the only way the compiler tells you
about a shadowed name or a branch that can never run, and a warning nobody has to clear is a
warning everybody scrolls past. Three months of that and the build output is a wall nobody reads.

Two consequences worth knowing:

- The fix is the code, not the configuration. `[lint] exclude_lints` in `foundry.toml` has exactly
  two entries, `asm-keccak256` and `unsafe-cheatcode`, and each one has a paragraph next to it
  explaining what was weighed. Adding a third is a conversation, not a commit.
- It also means a Solidity warning fails the TypeScript job, because the protocol package's ABI
  modules come out of that same compile. That is correct: an SDK generated from a compile nobody
  trusts is not an SDK anybody should trust.

### The ABI files in the protocol package are generated

`packages/protocol/src/abi/` is produced by `packages/protocol/scripts/gen-artifacts.mjs` from the
Foundry build output. Every file in there opens with a banner saying so. Do not edit them.

If you change anything in `evm/src`, regenerate:

```
cd evm && forge build
cd ../packages/protocol && npm run gen
```

and commit what it writes.

`test/parity.test.ts` regenerates the modules in memory and compares them against the committed
copies, so forgetting this step is a failing test rather than a quiet disagreement, and CI has a
separate step that fails on any diff in `src/abi` after running the generator.

The reason to care is the failure mode. An ABI typed out by a person is a copy of the truth that
starts drifting the moment somebody adds an argument, and the drift does not surface as an error.
It surfaces as a decode that returns a plausible value from the wrong field, which on this codebase
means naming the wrong error to a user or crediting the wrong sub account. The generator emits
nothing that changes between runs, no timestamp and no commit hash, precisely so that the
comparison is possible.

The same logic applies to `src/errors.ts`, which keeps the error list by hand so the human readable
help can live beside it. The parity test checks that list against the Rust enum and against the
declaration order in `HyperionErrors.sol`. Appending an error is fine. Reordering one relabels every
failure the contracts have ever emitted, each one plausibly, which is the worst kind of wrong.

## Commit messages

Plain imperative subjects that say what the change does, sentence case, no trailing full stop.
Optionally a short area prefix when it helps a reader scanning the log. No conventional commit
types, no ticket numbers in the subject.

What the log looks like:

```
Add the router contract, which is where every routing decision actually lives
Teach the core crate strkeys, CCTP wire format and the rail handover
evm: router, rail adapters, shared libraries, and the suite that holds them
Fill in the Axelar chain names from Axelar's own deployment config
Test the Axelar adapter against a faithful stand in for ITS
```

Notice that none of those say "update", "fix" or "refactor" on their own. The subject is the one
line somebody reads a year later when they are trying to work out why a line exists, so it should
carry the point of the change rather than its category.

Use the body for the why. Long bodies are welcome. The comments in this repository are long for the
same reason: the decision is the expensive part and the code is the cheap part.

## Before you open a pull request

Run the suites above. Then read `.github/pull_request_template.md` before you start writing it
rather than after, because two of its questions take thinking rather than typing:

- **What new trust assumption does this introduce.** Hyperion is a router, not a bridge. It never
  decides on its own that a cross chain message is real; it hands transfers to rails that already
  made that decision and keeps the bookkeeping, the limits and the fees. Every line that widens
  that remit moves Hyperion from "routes over trusted things" towards "is a trusted thing". Say so
  when it happens.
- **What happens to a transfer that is already in flight.** A transfer that has left one chain and
  not arrived on the other is in a state no single chain can see. If your change touches a replay
  key, the note layout, decimal conversion, a flow window, an inbound handler or the timelock, say
  what happens to the money that is mid flight when it deploys.

## How CI is arranged

Six workflow files. Five of them are reusable workflows that do one thing: `soroban.yml`,
`evm.yml`, `protocol.yml`, `deploy-rehearsal.yml` and `security.yml`. `ci.yml` is the only one with
triggers, it calls the other five, and it has one final job called `gate` that passes only when all
five passed.

Branch protection points at `gate` and nothing else, which means renaming or splitting a workflow
does not quietly stop protecting the branch.

Three things about them worth knowing if you edit one:

- Every action is pinned to a full commit sha with the version in a trailing comment. A floating
  tag in a workflow that can read the repository is a supply chain hole, because whoever controls
  the tag controls what runs. Keep the style.
- No workflow holds a secret and no deployment workflow exists. A workflow with a signing key in it
  is a workflow that can move funds from a pull request. Deployments are run by a person, from a
  machine with the key, using the same scripts `deploy-rehearsal.yml` rehearses. If that ever
  changes, the key custody story gets written down before the workflow does.
- There are no path filters. The three trees are coupled through the parity test, so "only the Rust
  changed" is rarely true, and a skipped job reports as skipped rather than as success, which
  blocks a merge forever on a required check.

## Reporting a security problem

Not here. See `.github/SECURITY.md`. Short version: use the private advisory form rather than a
public issue, and note that the rails Hyperion routes over are explicitly out of scope, because
Hyperion does not own them.
