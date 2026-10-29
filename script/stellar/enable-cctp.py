#!/usr/bin/env python3
"""Add Circle CCTP to the existing testnet router without bypassing its timelock.

Run queue, then activate after the recorded eta. Each confirmed step is recorded
atomically, so an interruption resumes the same adapter and queued actions.
Signing uses a named Stellar CLI identity. No private key is read by this script.
"""

import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MESSENGER = "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP"
TRANSMITTER = "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY"
DOMAINS = {"sepolia": 0, "base-sepolia": 6, "arc-testnet": 26}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["queue", "activate"])
    parser.add_argument("--identity", required=True)
    args = parser.parse_args()
    record_path = ROOT / "deployments/evidence/2026-10-29-cctp.json"
    deployment = json.loads((ROOT / "deployments/stellar-testnet-phase1.json").read_text())
    router = deployment["networks"]["stellar-testnet"]["router"]

    def run(*command):
        result = subprocess.run(["stellar", *command], text=True, capture_output=True, check=True)
        return result.stdout.strip()

    def invoke(contract, method, *fields, view=False):
        options = ["--is-view"] if view else ["--send", "yes"]
        output = run("contract", "invoke", "--id", contract, "--source-account", args.identity,
                     "--network", "testnet", *options, "--", method, *fields)
        return json.loads(output) if output else None

    def save():
        record_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = record_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(record, indent=2) + "\n")
        temporary.replace(record_path)

    admin = run("keys", "address", args.identity)
    config = invoke(router, "get_config", view=True)
    if config["admin"] != admin or int(config["timelock_delay"]) < 3600:
        raise RuntimeError("The identity must own the existing router with its normal timelock.")
    record = json.loads(record_path.read_text()) if record_path.exists() else {
        "network": "testnet", "router": router, "admin": admin,
        "source": "https://developers.circle.com/cctp/references/stellar-contracts",
        "tokenMessenger": MESSENGER, "messageTransmitter": TRANSMITTER,
        "domains": DOMAINS, "status": "preflight", "queuedActions": [],
    }
    if record["router"] != router or record["admin"] != admin:
        raise RuntimeError("The recovery record belongs to a different router or administrator.")

    if args.phase == "queue":
        if invoke(TRANSMITTER, "get_local_domain", view=True) != 27:
            raise RuntimeError("Circle transmitter is on the wrong domain.")
        if invoke(MESSENGER, "get_local_message_transmitter", view=True) != TRANSMITTER:
            raise RuntimeError("Circle messenger points to a different transmitter.")
        if invoke(MESSENGER, "paused", view=True) or invoke(TRANSMITTER, "paused", view=True):
            raise RuntimeError("Circle has paused transfers.")
        for chain, domain in DOMAINS.items():
            if not invoke(MESSENGER, "get_remote_token_messenger", "--domain", str(domain), view=True):
                raise RuntimeError(f"Circle has not linked {chain}.")

        if "adapter" not in record:
            wasm = ROOT / "soroban/target/wasm32v1-none/release/hyperion_adapter_cctp.wasm"
            record["wasmHash"] = hashlib.sha256(wasm.read_bytes()).hexdigest()
            uploaded = run("contract", "upload", "--wasm", str(wasm),
                           "--source-account", args.identity, "--network", "testnet")
            if uploaded != record["wasmHash"]:
                raise RuntimeError("Uploaded code does not match the reviewed artifact.")
            record["adapter"] = run("contract", "deploy", "--wasm-hash", uploaded,
                                    "--source-account", args.identity, "--network", "testnet")
            record["status"] = "deployed"
            save()
        adapter = record["adapter"]
        try:
            adapter_config = invoke(adapter, "get_config", view=True)
        except subprocess.CalledProcessError:
            invoke(adapter, "initialize", "--admin", admin, "--router", router,
                   "--token_messenger", MESSENGER, "--message_transmitter", TRANSMITTER)
            adapter_config = invoke(adapter, "get_config", view=True)
        for field, expected in {"admin": admin, "router": router,
                                "token_messenger": MESSENGER,
                                "message_transmitter": TRANSMITTER,
                                "max_fee_bps": 0, "min_finality_threshold": 2000}.items():
            if adapter_config[field] != expected:
                raise RuntimeError(f"Unexpected CCTP adapter {field}.")
        for chain, domain in DOMAINS.items():
            try:
                link = invoke(adapter, "get_link", "--domain", str(domain), view=True)
            except subprocess.CalledProcessError:
                invoke(adapter, "link_domain", "--chain", chain, "--domain", str(domain),
                       "--destination_caller", "0" * 64)
                link = invoke(adapter, "get_link", "--domain", str(domain), view=True)
            if link["chain"] != chain or link["destination_caller"] != "0" * 64:
                raise RuntimeError(f"Unexpected destination configuration for {chain}.")

        pending = []
        for action_id in range(1, int(invoke(router, "queue_count", view=True)) + 1):
            try:
                pending.append(invoke(router, "get_queued", "--id", str(action_id), view=True))
            except subprocess.CalledProcessError as error:
                if "Error(Contract" not in error.stderr:
                    raise
        actions = [{"SetAdapter": [0, adapter]}, {"SetRailReceiver": [0, adapter]},
                   {"EnableRoute": 0}]
        for action in actions:
            existing = next((item for item in record["queuedActions"] if item["action"] == action), None)
            if existing:
                continue
            queued = next((item for item in pending if item["action"] == action), None)
            if queued is None:
                action_id = invoke(router, "queue_action", "--caller", admin,
                                   "--action", json.dumps(action))
                queued = invoke(router, "get_queued", "--id", str(action_id), view=True)
            record["queuedActions"].append(queued)
            record["status"] = "queued"
            save()
        record["activateAfter"] = max(int(item["eta"]) for item in record["queuedActions"])
        save()
        print(json.dumps({"adapter": adapter, "queuedIds": [item["id"] for item in record["queuedActions"]],
                          "activateAfter": record["activateAfter"]}))
    else:
        if len(record["queuedActions"]) != 3 or time.time() < record["activateAfter"]:
            raise RuntimeError("All three actions must be queued and their original timelock must mature.")
        for queued in record["queuedActions"]:
            if queued.get("executed"):
                continue
            try:
                current = invoke(router, "get_queued", "--id", str(queued["id"]), view=True)
            except subprocess.CalledProcessError:
                action = queued["action"]
                if "SetAdapter" in action:
                    applied = invoke(router, "get_adapter", "--route", "0", view=True) == record["adapter"]
                elif "SetRailReceiver" in action:
                    applied = invoke(router, "get_rail_receiver", "--route", "0", view=True) == record["adapter"]
                else:
                    applied = invoke(router, "is_route_enabled", "--route", "0", view=True) is True
                if not applied:
                    raise
                current = None
            if current:
                if current["action"] != queued["action"]:
                    raise RuntimeError("A queued action changed.")
                invoke(router, "execute_action", "--caller", admin, "--id", str(queued["id"]))
            queued["executed"] = True
            save()
        if invoke(router, "get_adapter", "--route", "0", view=True) != record["adapter"]:
            raise RuntimeError("CCTP adapter was not installed.")
        if invoke(router, "get_rail_receiver", "--route", "0", view=True) != record["adapter"]:
            raise RuntimeError("CCTP receiver was not installed.")
        if not invoke(router, "is_route_enabled", "--route", "0", view=True):
            raise RuntimeError("CCTP route was not enabled.")
        record["status"] = "active"
        record["activatedAt"] = int(time.time())
        save()
        print(json.dumps({"status": record["status"], "adapter": record["adapter"]}))


if __name__ == "__main__":
    main()
