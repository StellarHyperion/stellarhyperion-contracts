# Axelar Source-Note and Destination-Payment Reconciliation

## Overview

Hyperion encodes intended recipient addresses inside Axelar Interchain Token Service (ITS) contract-call payloads (`OutboundNote` from Stellar to EVM and `InboundNote` wrapped in `METADATA_CONTRACT_CALL` from EVM to Stellar). Both payload formats also carry an 8-byte router sequence (`nonce`) for operator display convenience, whereas actual protocol authenticity, replay protection, and settlement accounting depend on full rail identifiers and exact token movements.

`@hyperion/protocol` exports a pure, read-only reconciliation module (`src/axelarReconciliation.ts`), paired with `script/stellar/reconcile-axelar-notes.mjs`, to join encoded source note intent against candidate ITS destination payment events for local and staging development evidence.

## Authoritative Verification Rules

A source note record is marked `verified` if and only if a single executed destination candidate receipt agrees across all four authoritative bindings simultaneously:

1. **Recipient identity**: Decoded note recipient matches the normalized destination receipt recipient (case-normalized 20-byte EVM address on `stellar-to-evm`, or checksummed SEP-23 strkey including muxed sub-account ID on `evm-to-stellar`).
2. **Token ID**: Normalized non-zero 32-byte ITS `tokenId` matches between source and destination.
3. **Exact integer amount**: Destination `amount` equals the exact integer `expectedDestinationAmount` (computed via `convertDecimals` with zero `dust` whenever `sourceDecimals` and `destinationDecimals` differ). Any non-zero decimal remainder fails verification with `inexact_source_amount`.
4. **Full command identity**: Normalized 32-byte `commandId`, full `axelarMessageId`, and `axelarSourceChain` all match between the source reference and destination receipt, with `executed === true`.

Any partial match, unexecuted receipt, missing receipt, malformed source note, or ambiguous duplicate receipt is reported `unverified` with explicit `ReconciliationDiscrepancyCode` diagnostics. Display nonces (`nonce` / `observedDisplayNonce`) are recorded only as non-authoritative metadata and are never used to join or rescue mismatched records. All original source and destination raw transaction/event references are retained verbatim in the output report.

## CLI Usage

Build `@hyperion/protocol` once, then run the read-only CLI against a JSON fixture:

```bash
cd packages/protocol && npm run build
node ../../script/stellar/reconcile-axelar-notes.mjs --input path/to/fixture.json
```

The command prints the structured JSON `AxelarReconciliationBatchReport` to `stdout`, mutates no chain or local state, exits `0` when `allVerified === true`, and exits `1` when one or more entries are `unverified`.

## Compatibility and Gating Implications

- **Wire and ABI compatibility**: No Soroban contract Wasm, XDR storage layout, EVM bytecode, or note wire encoding is modified. Existing `OutboundNote` and `InboundNote` codecs are reused directly.
- **Deployment gating**: Active deployment remains Stellar Testnet outbound ITS/CCTP. EVM and inbound/bidirectional Axelar rail paths remain explicitly gated for development evidence until independently validated.
