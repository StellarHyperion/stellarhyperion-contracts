#!/usr/bin/env bash
#
# Phase two on Stellar: execute what phase one queued, once the timelock has matured.
#
# Walks the queued actions in the order they were queued and stops at the first one that is not
# ready rather than skipping it, because these actions depend on each other. Enabling a route before
# its adapter is set leaves a rail that is on and unreachable.
#
# Safe to run more than once. An action already executed is reported and skipped, so a run
# interrupted by a failed transaction picks up where it left off rather than requiring somebody to
# work out by hand which of eight actions landed.
#
# Usage: script/stellar/execute.sh
source "$(dirname "$0")/lib.sh"
require_tools
require_identity

RECORD="${HYPERION_RECORD:-$RECORD_DIR/stellar-$NETWORK-phase1.json}"
[ -f "$RECORD" ] || die "no record at $RECORD; run script/stellar/deploy.sh first"

CHAIN_KEY=$(node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const keys=Object.keys(d.networks??{});
if(keys.length!==1){console.error("expected exactly one network in the record, found "+keys.length);process.exit(1)}
process.stdout.write(keys[0]);
' "$RECORD")

ROUTER=$(json_get "$RECORD" "networks.$CHAIN_KEY.router")
DEPLOYER=$(json_get "$RECORD" "networks.$CHAIN_KEY.deployer")
CALLER=$(deployer_address)

[ "$CALLER" = "$DEPLOYER" ] || die "this record was queued by $DEPLOYER and $IDENTITY is $CALLER.
  Only the account that holds admin can execute, and phase one left that with the deployer."

note "the record"
say "file             $RECORD"
say "network key      $CHAIN_KEY"
say "router           $ROUTER"
say "caller           $CALLER"

COUNT=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((d.networks[process.argv[2]].queuedActionIds??[]).length))' "$RECORD" "$CHAIN_KEY")
[ "$COUNT" -gt 0 ] || die "the record lists no queued actions"

if [ -n "${HYPERION_PRECONDITIONS_JSON:-}" ]; then
  note "verifying provider-link and precision preconditions"
  node "$(dirname "$0")/verify-preconditions.mjs" --input "$HYPERION_PRECONDITIONS_JSON" \
    || die "provider-link or destination-precision preconditions failed; refusing router execution"
fi

note "executing $COUNT queued actions"
executed=0
skipped=0

for i in $(seq 0 $((COUNT - 1))); do
  id=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.networks[process.argv[2]].queuedActionIds[Number(process.argv[3])]))' "$RECORD" "$CHAIN_KEY" "$i")
  what=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.networks[process.argv[2]].queuedActions?.[Number(process.argv[3])]??"unnamed"))' "$RECORD" "$CHAIN_KEY" "$i")

  # A queued action that has already been taken is gone from storage, so a read that fails is the
  # signal that this one is done rather than an error.
  if ! read_only "$ROUTER" get_queued --id "$id" >/dev/null 2>&1; then
    say "done already  $id  $what"
    skipped=$((skipped + 1))
    continue
  fi

  if out=$(invoke "$ROUTER" execute_action --caller "$CALLER" --id "$id" 2>&1); then
    say "executed      $id  $what"
    executed=$((executed + 1))
  else
    printf '\n%s\n' "$out" | tail -8
    case "$out" in
      *TimelockNotReady*|*"Error(Contract, #23)"*)
        die "action $id ($what) has not matured yet. Wait and run this again." ;;
      *TimelockExpired*|*"Error(Contract, #24)"*)
        die "action $id ($what) expired and has to be queued again." ;;
      *)
        die "action $id ($what) would not execute" ;;
    esac
  fi
done

note "result"
say "executed this run  $executed"
say "already done       $skipped"

note "reading the router back"
say "fee bps      $(read_only "$ROUTER" get_config | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).fee_bps))}catch{process.stdout.write(s.trim())}})')"
say "cctp route   $(read_only "$ROUTER" is_route_enabled --route "$ROUTE_CCTP" | tr -d '[:space:]')"
say "axelar route $(read_only "$ROUTER" is_route_enabled --route "$ROUTE_AXELAR_ITS" | tr -d '[:space:]')"
printf '\n'
say "Verify the whole thing against the record:"
say "  script/stellar/verify.sh"
