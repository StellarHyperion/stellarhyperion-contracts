# Shared plumbing for the Stellar deploy scripts.
#
# Sourced, not run. Everything here is either a wrapper that fails loudly or a reader that pulls a
# value out of a JSON record without needing jq installed.

set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

CONTRACTS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOROBAN_DIR="$CONTRACTS_ROOT/soroban"
WASM_DIR="$SOROBAN_DIR/target/wasm32v1-none/release"
RECORD_DIR="$CONTRACTS_ROOT/deployments"

NETWORK="${STELLAR_NETWORK:-testnet}"
# A named identity from `stellar keys`, never a secret in the environment. The CLI keeps these in
# the user's config directory, which is outside this repository and outside any image built from
# it. A deploy script that reads a secret key out of a variable is a deploy script that eventually
# reads it out of CI logs.
IDENTITY="${STELLAR_IDENTITY:-hyperion-deploy}"

# All three write to stderr, deliberately. Several of the helpers below are called inside a
# command substitution so their stdout is a value the caller is about to use, and a progress line
# printed there becomes part of that value. That exact mistake turned a reused contract id into a
# string with a sentence in front of it, and the CLI rejected it as an invalid name. Human output
# and machine output do not share a channel in this file.
note() { printf '\n\033[1m== %s\033[0m\n' "$*" >&2; }
say()  { printf '   %s\n' "$*" >&2; }
die()  { printf '\n\033[31mfailed: %s\033[0m\n' "$*" >&2; exit 1; }

require_tools() {
  for tool in stellar node; do
    command -v "$tool" >/dev/null || die "$tool is not on PATH"
  done
}

require_identity() {
  stellar keys address "$IDENTITY" >/dev/null 2>&1 \
    || die "no identity called $IDENTITY. Create one with:
    stellar keys generate $IDENTITY --network $NETWORK --fund
  On mainnet, add it from a hardware wallet or a secure store instead:
    stellar keys add $IDENTITY --secure-store"
}

deployer_address() { stellar keys address "$IDENTITY"; }

# Upload a wasm and echo its hash. Idempotent on chain: uploading the same bytes twice costs a fee
# and yields the same hash, which is why the hash is what gets written down rather than a receipt.
upload() {
  local wasm="$1"
  [ -f "$wasm" ] || die "missing $wasm; run script/stellar/build.sh first"
  stellar contract upload --wasm "$wasm" --source-account "$IDENTITY" --network "$NETWORK" 2>/dev/null \
    | tr -d '[:space:]'
}

deploy_from_hash() {
  local hash="$1"
  stellar contract deploy --wasm-hash "$hash" --source-account "$IDENTITY" --network "$NETWORK" 2>/dev/null \
    | tr -d '[:space:]'
}

# Invoke and send. Stderr is kept because a failed invoke puts the contract error there and that is
# the only thing worth reading when a deployment stops.
invoke() {
  local id="$1"; shift
  stellar contract invoke --id "$id" --source-account "$IDENTITY" --network "$NETWORK" --send yes -- "$@"
}

# Invoke read only. No fee, no signature, no state change.
# Uses STELLAR_PUBLIC_SOURCE (any public G-account) when set so verification needs no stored key.
read_only() {
  local id="$1"; shift
  local source_ref="${STELLAR_PUBLIC_SOURCE:-$IDENTITY}"
  case "$source_ref" in
    S???????????????????????????????????????????????????????)
      die "refusing secret seed in read_only source reference" ;;
  esac
  stellar contract invoke --id "$id" --source-account "$source_ref" --network "$NETWORK" --is-view -- "$@" 2>/dev/null
}

# Read one top level key out of a JSON file. node rather than jq, because jq is not installed
# everywhere and node already is, since the protocol package needs it.
json_get() {
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],d);if(v===undefined){process.stderr.write("missing key "+process.argv[2]+"\n");process.exit(1)}process.stdout.write(String(v))' "$1" "$2"
}

# The Stellar Asset Contract id for a classic asset. Derived from the code, the issuer and the
# network passphrase, so it is computed rather than looked up and never typed by a person.
sac_id() {
  local asset="$1"
  stellar contract id asset --asset "$asset" --network "$NETWORK" 2>/dev/null | tr -d '[:space:]'
}

# Rail tags, as the integers that actually go on the wire.
#
# `RouteKind` is `#[contracttype]` with `#[repr(u32)]` and explicit discriminants, which makes it a
# u32 on the wire rather than a tagged union. So the CLI wants `0`, not `Cctp` and not `"Cctp"`.
# Both of those were tried first and both were refused, the second one by the type checker rather
# than the JSON parser, which is a useful thing to have found out on a testnet.
#
# These are the same integers the Solidity enum and the TypeScript const object carry, and
# `parity.test.ts` in the protocol package is what keeps all four in agreement.
ROUTE_CCTP=0
ROUTE_AXELAR_ITS=1
ROUTE_AXELAR_GMP=2
ROUTE_ALLBRIDGE=3

# Whether a contract has been initialized already.
#
# Deployment is not atomic. An upload can succeed and a deploy fail, or a deploy succeed and an
# initialize fail on an argument the CLI would not accept, which is exactly what happened the
# first time this ran. Re-running from the top would then abandon a deployed contract and pay to
# deploy another one, so every step here asks the chain what it already did.
is_initialized() {
  local id="$1"
  read_only "$id" get_config >/dev/null 2>&1
}

# Reuse a contract id if one was handed in, otherwise deploy from a hash.
#
# The caller passes the name of an environment variable rather than its value, so an empty
# variable and an unset one behave the same way.
reuse_or_deploy() {
  local var="$1" hash="$2" label="$3"
  local existing="${!var:-}"
  if [ -n "$existing" ]; then
    say "$label reusing $existing (from $var)"
    printf '%s' "$existing"
    return
  fi
  deploy_from_hash "$hash"
}

# Hyperion's own name for the EVM chain this deployment is paired with.
peer_chain() { echo "${HYPERION_PEER_CHAIN:?set HYPERION_PEER_CHAIN, for example arc-testnet}"; }
