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
# Deprecation: a record that is archived (status "deprecated" or "retired") or that names a
# successor is NOT an active deployment. verify.sh refuses to monitor it as if it were current,
# prints the successor link, and fails with an actionable warning rather than silently passing.
# Historical transaction evidence in the record is never discarded by this check.
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

# Lifecycle metadata. A record is active unless it declares otherwise. Parsed, not grepped.
LIFECYCLE=$(node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const n=d.networks[process.argv[2]]??{};
const lc=n.lifecycle??d.lifecycle??{};
const status=lc.status??"active";
const successor=lc.successor??lc.successorRecord??"";
const reason=lc.reason??"";
process.stdout.write(JSON.stringify({status,successor,reason}));
' "$RECORD" "$CHAIN_KEY")
LC_STATUS=$(printf '%s' "$LIFECYCLE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).status))')
LC_SUCCESSOR=$(printf '%s' "$LIFECYCLE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).successor))')
LC_REASON=$(printf '%s' "$LIFECYCLE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).reason))')

ROUTER=$(json_get "$RECORD" "networks.$CHAIN_KEY.router")

note "the record"
say "file             $RECORD"
say "network key      $CHAIN_KEY"
say "router           $ROUTER"
say "lifecycle        $LC_STATUS"

if [ "$LC_STATUS" != "active" ]; then
  printf '\033[33mWARNING: this record is %s and is not an active deployment.\033[0m\n' "$LC_STATUS"
  [ -n "$LC_REASON" ] && say "reason           $LC_REASON"
  if [ -n "$LC_SUCCESSOR" ]; then
    say "successor        $LC_SUCCESSOR"
    say "action           monitor the successor record instead: HYPERION_RECORD=$LC_SUCCESSOR script/stellar/verify.sh"
  else
    say "action           no successor is linked; do not activate or monitor this router until one is recorded"
  fi
  say "historical transaction evidence is retained in the record and is not affected by this refusal."
  die "refusing to verify a $LC_STATUS deployment as if it were active"
fi

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

  note "maintenance and reconciliation"
  RECON=$(read_only "$ROUTER" claim_liability --token "$SAC" 2>/dev/null || echo "")
  if [ -z "$RECON" ]; then
    printf '   \033[31mBAD  claim_liability failed for %s\033[0m\n' "$SAC"
    problems=$((problems + 1))
  else
    rfield() { printf '%s' "$RECON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o[process.argv[1]]))})' "$1"; }
    check "claim liability known" "$(rfield known)" "true"
    check "claim custody solvent" "$(rfield solvent)" "true"
    say "outstanding=$(rfield outstanding) custody=$(rfield custody)"
  fi

  if node "$CONTRACTS_ROOT/script/stellar/discover-keys.mjs" "$ROUTER" claim 0 10 "$NETWORK" \
    && node "$CONTRACTS_ROOT/script/stellar/discover-keys.mjs" "$ROUTER" transfer 0 10 "$NETWORK"; then
    printf '   ok   %-24s %s\n' "bounded key discovery" "read-only monotonic pages returned; retain unavailable IDs for RPC inspection"
  else
    printf '   \033[31mBAD  bounded host key discovery failed\033[0m\n'
    problems=$((problems + 1))
  fi
fi

note "storage schema and registered adapter coverage"
if MIG_STATUS=$(read_only "$ROUTER" get_migration_status); then
  SCHEMA_VER=$(printf '%s' "$MIG_STATUS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).current_version;if(!Number.isInteger(n)||n<0||n>3)process.exit(1);process.stdout.write(String(n))})')
  check "schema version" "$SCHEMA_VER" "3"
  mig_pending=$(printf '%s' "$MIG_STATUS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);if(typeof o.migration_pending!=="boolean")process.exit(1);process.stdout.write(String(o.migration_pending))})')
  check "migration pending" "$mig_pending" "false"
  for slug in cctp axelar-its; do
    route=$([ "$slug" = "cctp" ] && echo "$ROUTE_CCTP" || echo "$ROUTE_AXELAR_ITS")
    if registered=$(read_only "$ROUTER" get_adapter --route "$route"); then
      registered=$(printf '%s' "$registered" | tr -d '"[:space:]')
    else
      say "$slug registered adapter unavailable"
      problems=$((problems + 1))
      continue
    fi
    if cov=$(read_only "$registered" key_coverage); then
      coverage=$(printf '%s' "$cov" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);if(typeof o.has_token_mappings!=="boolean"||typeof o.has_peer_trust!=="boolean")process.exit(1);process.stdout.write(String(o.has_token_mappings&&o.has_peer_trust))})')
      check "$slug actual coverage" "$coverage" "true"
    else
      say "$slug registered adapter coverage unavailable; upgrade and verify that adapter"
      problems=$((problems + 1))
    fi
  done
else
  say "schema view unavailable; this does not prove legacy v1 or safe migration completion"
  say "verify legacy executable provenance, then perform a reviewed upgrade and migration"
  problems=$((problems + 1))
fi
say "Archived footprint planning: node script/stellar/restore-plan.mjs RPC_URL recorded-request.json"
say "TTL evidence is host RPC live/archived/unavailable, never a fabricated guest TTL."
say "Replay journal export: node script/stellar/replay-journal.mjs RPC_URL ROUTER ledger:START or cursor:SAVED"
say "Consumer copies: node script/stellar/check-deployment-copies.mjs --copies deployment-copies.json"

printf '\n'
if [ "$problems" -eq 0 ]; then
  printf '\033[32mEverything on chain matches the record.\033[0m\n'
else
  die "$problems mismatch(es) between the chain and the record"
fi

say "Historical cleanup: claim_history distinguishes Live, intentional Archived(id), and Unavailable (restore via RPC)."
say "Cost capture (read-only): node script/stellar/storage-cost.mjs --rpc RPC_URL --request recorded-keysets.json"
say "Cost replay: node script/stellar/storage-cost.mjs --record recorded-rpc.json"

note "rollback feasibility"
say "Read-only report — signs nothing, executes nothing:"
say "  node script/stellar/rollback-report.mjs $RECORD"
say "With network/executable-bound live schema evidence (still requires compatibility review):"
say "  node script/stellar/rollback-report.mjs $RECORD --rpc \$RPC_URL --source-account PUBLIC_G_ADDRESS"
say "Compare two records (old → new upgrade path):"
say "  node script/stellar/rollback-report.mjs --from <archive-record> --to $RECORD"
