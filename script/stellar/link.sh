#!/usr/bin/env bash
#
# Point a deployed Stellar adapter at its counterpart on the other chain.
#
# Linking and asset mapping are admin operations and can overwrite current configuration.
# Read the existing lane before retrying. For the direct Stellar-to-Sepolia ITS testnet lane,
# use docs/TESTNET_ACTIVATION.md; bare ITS does not require a far-side Hyperion peer.
#
# Usage:
#   HYPERION_PEER_CHAIN=arc-testnet \
#   AXELAR_PEER_CHAIN=arc-8 \
#   AXELAR_PEER_ADDRESS=0x... \
#   AXELAR_TOKEN_ID=0x... \
#   script/stellar/link.sh
source "$(dirname "$0")/lib.sh"
require_tools
require_identity

RECORD="${HYPERION_RECORD:-$RECORD_DIR/stellar-$NETWORK-phase1.json}"
[ -f "$RECORD" ] || die "no record at $RECORD; run script/stellar/deploy.sh first"

CHAIN_KEY=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(Object.keys(d.networks??{})[0]??"")' "$RECORD")
[ -n "$CHAIN_KEY" ] || die "the record names no network"

PEER="$(peer_chain)"
SAC=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=d.networks[process.argv[2]].tokens;process.stdout.write(t[Object.keys(t)[0]].sacId)' "$RECORD" "$CHAIN_KEY")

adapter_for() {
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.networks[process.argv[2]].adapters?.[process.argv[3]]??""))' "$RECORD" "$CHAIN_KEY" "$1"
}

CCTP=$(adapter_for cctp)
AXELAR=$(adapter_for axelar-its)

note "linking to $PEER"
say "record           $RECORD"
say "asset contract   $SAC"
say "cctp adapter     ${CCTP:-none deployed}"
say "axelar adapter   ${AXELAR:-none deployed}"

did_any=0

if [ -n "$CCTP" ]; then
  if [ -z "${CCTP_PEER_DOMAIN:-}" ]; then
    note "cctp: nothing to do"
    say "CCTP_PEER_DOMAIN is not set, so the lane to $PEER is left unlinked."
  else
    note "cctp: linking domain $CCTP_PEER_DOMAIN"
    # The destination caller is who is allowed to deliver on the far side. Getting it wrong means a
    # burn here against a mint nobody can claim.
    invoke "$CCTP" link_domain \
      --chain "$PEER" \
      --domain "$CCTP_PEER_DOMAIN" \
      --destination_caller "${CCTP_DESTINATION_CALLER:?set CCTP_DESTINATION_CALLER, Hyperion on $PEER as 32 bytes}" \
      >/dev/null || die "cctp link_domain"
    say "linked $PEER to domain $CCTP_PEER_DOMAIN"

    invoke "$CCTP" map_asset \
      --domain "$CCTP_PEER_DOMAIN" \
      --burn_token "${CCTP_PEER_BURN_TOKEN:?set CCTP_PEER_BURN_TOKEN, the asset on $PEER as 32 bytes}" \
      --local "$SAC" >/dev/null || die "cctp map_asset"
    say "mapped the asset on domain $CCTP_PEER_DOMAIN to $SAC"
    did_any=1
  fi
fi

if [ -n "$AXELAR" ]; then
  if [ -z "${AXELAR_PEER_CHAIN:-}" ]; then
    note "axelar: nothing to do"
    say "AXELAR_PEER_CHAIN is not set, so $PEER is left unlinked."
    say "Axelar's own name for a chain is published in axelar-chains-config/info in"
    say "axelarnetwork/axelar-contract-deployments. It is not guessable: the mainnet id for"
    say "Ethereum is capitalised, Arc's testnet is \"arc-8\", and Stellar's testnet id carries"
    say "a version suffix that moves."
  else
    note "axelar: linking $PEER as $AXELAR_PEER_CHAIN"
    # The peer comparison on an inbound delivery is against these exact bytes. Arriving through ITS
    # proves a message was delivered, not who sent it, so this is the check that turns "a transfer
    # arrived" into "Hyperion sent this".
    invoke "$AXELAR" link_chain \
      --chain "$PEER" \
      --axelar_chain "$AXELAR_PEER_CHAIN" \
      --peer "${AXELAR_PEER_ADDRESS:?set AXELAR_PEER_ADDRESS, the Hyperion adapter on $PEER as 20 bytes}" \
      >/dev/null || die "axelar link_chain"
    say "linked"

    invoke "$AXELAR" map_token \
      --token "$SAC" \
      --token_id "${AXELAR_TOKEN_ID:?set AXELAR_TOKEN_ID, the ITS token id for this asset}" \
      >/dev/null || die "axelar map_token"
    say "mapped $SAC to the ITS token id"
    did_any=1
  fi
fi

printf '\n'
if [ "$did_any" -eq 1 ]; then
  say "Linked. Check it with:"
  say "  script/stellar/verify.sh"
else
  say "Nothing was linked, because nothing was asked for. The adapters still refuse"
  say "every destination with UnknownChain, which is the correct answer for a lane that"
  say "does not exist."
fi
