#!/usr/bin/env bash
#
# Read a live Stellar deployment back and check it against the record.
#
# Signs nothing and sends nothing. Every value is read off the chain and compared against the file,
# and the script fails if any of them disagree.
#
# Its own script rather than a tail on the deploy, because "is the thing on chain still what we
# wrote down" is a question somebody asks weeks later, during an incident, from a machine that never
# ran the deployment. It should not require reading nine invoke commands off a wiki.
#
# Usage: script/stellar/verify.sh
source "$(dirname "$0")/lib.sh"
require_tools

RECORD="${HYPERION_RECORD:-$RECORD_DIR/stellar-$NETWORK-phase1.json}"
[ -f "$RECORD" ] || die "no record at $RECORD"

CHAIN_KEY=$(node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
process.stdout.write(Object.keys(d.networks??{})[0]??"");
' "$RECORD")
[ -n "$CHAIN_KEY" ] || die "the record names no network"

ROUTER=$(json_get "$RECORD" "networks.$CHAIN_KEY.router")

note "the record"
say "file             $RECORD"
say "network key      $CHAIN_KEY"
say "router           $ROUTER"

problems=0
check() {
  local what="$1" found="$2" want="$3"
  if [ "$found" = "$want" ]; then
    printf '   ok   %-24s %s\n' "$what" "$found"
  else
    printf '   \033[31mBAD  %-24s found %s, want %s\033[0m\n' "$what" "$found" "$want"
    problems=$((problems + 1))
  fi
}

note "the record is still valid as written"
# `node -e` runs as CommonJS, where top level await is a syntax error, so the dynamic import is
# chained rather than awaited. Stderr is not suppressed: the validator names the field it choked
# on and that message is the entire reason to run it.
node -e '
const fs = require("fs");
import(process.argv[2])
  .then(({ parseDeploymentSet }) => {
    parseDeploymentSet(JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
    process.stdout.write("   ok   schema\n");
  })
  .catch((error) => {
    process.stderr.write(String(error && error.message ? error.message : error) + "\n");
    process.exit(1);
  });
' "$RECORD" "$CONTRACTS_ROOT/packages/protocol/dist/index.js" \
  || die "the record does not validate. If the error above is about a missing module, build the
  protocol package first: cd packages/protocol && npm install && npm run build"

note "the router"
CONFIG=$(read_only "$ROUTER" get_config)
field() { printf '%s' "$CONFIG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o[process.argv[1]]))})' "$1"; }

check "treasury"  "$(field treasury)"            "$(json_get "$RECORD" "networks.$CHAIN_KEY.treasury")"
check "admin"     "$(field admin)"               "$(json_get "$RECORD" "networks.$CHAIN_KEY.admin")"
check "guardian"  "$(field guardian)"            "$(json_get "$RECORD" "networks.$CHAIN_KEY.guardian")"
check "fee bps"   "$(field fee_bps)"             "$(json_get "$RECORD" "networks.$CHAIN_KEY.feeBps")"
check "flow window" "$(field flow_window_ledgers)" "$(json_get "$RECORD" "networks.$CHAIN_KEY.flowWindow")"
check "timelock"  "$(field timelock_delay)"      "$(json_get "$RECORD" "networks.$CHAIN_KEY.timelockDelay")"
check "paused"    "$(field paused)"              "false"

note "the rails"
for slug in cctp axelar-its; do
  recorded=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.networks[process.argv[2]].adapters?.[process.argv[3]]??""))' "$RECORD" "$CHAIN_KEY" "$slug")
  [ -n "$recorded" ] || { say "$slug not in the record, so nothing to check"; continue; }
  route=$([ "$slug" = "cctp" ] && echo "$ROUTE_CCTP" || echo "$ROUTE_AXELAR_ITS")
  check "$slug adapter"  "$(read_only "$ROUTER" get_adapter --route "$route" | tr -d '"[:space:]')" "$recorded"
  check "$slug receiver" "$(read_only "$ROUTER" get_rail_receiver --route "$route" | tr -d '"[:space:]')" "$recorded"
  check "$slug enabled"  "$(read_only "$ROUTER" is_route_enabled --route "$route" | tr -d '[:space:]')" "true"
done

note "the asset"
SAC=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=d.networks[process.argv[2]].tokens;const k=Object.keys(t)[0];process.stdout.write(t[k].sacId)' "$RECORD" "$CHAIN_KEY")
TOKEN=$(read_only "$ROUTER" get_token --token "$SAC" 2>/dev/null || echo "")
if [ -z "$TOKEN" ]; then
  printf '   \033[31mBAD  the router does not know about %s\033[0m\n' "$SAC"
  problems=$((problems + 1))
else
  tfield() { printf '%s' "$TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o[process.argv[1]]))})' "$1"; }
  # Registration is presence on this side, not a flag. The Soroban `TokenConfig` carries only
  # decimals, a flow ceiling and an enabled bool, and `get_token` returns `TokenNotRegistered`
  # for an asset the router has never been told about. So the read above succeeding is the check,
  # and there is no `registered` field to compare. The EVM struct does carry one, which is
  # exactly the kind of difference worth writing down rather than discovering twice.
  printf '   ok   %-24s %s\n' "token registered" "the router answered for it"
  check "token enabled"    "$(tfield enabled)"    "true"
  check "token decimals"   "$(tfield decimals)"   "7"
  check "token flow limit" "$(tfield flow_limit)" "$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=d.networks[process.argv[2]].tokens;process.stdout.write(t[Object.keys(t)[0]].flowLimit)' "$RECORD" "$CHAIN_KEY")"
fi

if [ -n "${HYPERION_BACKEND_COPY:-}" ] || [ -n "${HYPERION_FRONTEND_COPY:-}" ]; then
  note "cross-repository deployment copies (read-only)"
  COPY_ARGS=(--canonical "$RECORD")
  if [ -n "${HYPERION_CANONICAL_REV:-}" ]; then
    COPY_ARGS+=(--canonical-rev "$HYPERION_CANONICAL_REV")
  fi
  if [ -n "${HYPERION_BACKEND_COPY:-}" ]; then
    COPY_ARGS+=(--backend "$HYPERION_BACKEND_COPY" --backend-rev "${HYPERION_BACKEND_REV:-working-tree}")
  fi
  if [ -n "${HYPERION_FRONTEND_COPY:-}" ]; then
    COPY_ARGS+=(--frontend "$HYPERION_FRONTEND_COPY" --frontend-rev "${HYPERION_FRONTEND_REV:-working-tree}")
  fi
  if ! node "$SCRIPT_DIR/check-copies.mjs" "${COPY_ARGS[@]}"; then
    problems=$((problems + 1))
  fi
fi

printf '\n'
if [ "$problems" -eq 0 ]; then
  printf '\033[32mEverything on chain matches the record.\033[0m\n'
else
  die "$problems mismatch(es) between the chain and the record"
fi
