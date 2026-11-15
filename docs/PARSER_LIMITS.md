# Contract and SDK Parser Limits

This document records the exact byte ceilings, error classifications, and resource bounds for Hyperion wire-format and governance payload parsers across Soroban (`hyperion-core`, `hyperion-router`), EVM (`StellarAddress.sol`, `HyperionNotes.sol`, `HyperionRouter.sol`), and the TypeScript SDK (`@hyperion/protocol`).

## Deployment Posture and Compatibility

- **Active deployment:** Stellar Testnet outbound `AxelarIts` and `Cctp` transfers.
- **Explicitly gated surfaces:** Stellar inbound callbacks, `AxelarGmp`, `Allbridge`, and EVM contracts remain disabled or unlinked in live configuration until independently validated.
- **Wire compatibility:** No accepted wire layout changed. `InboundNote::decode` (`hyperion-core::axelar`), `HyperionHook::decode` (`hyperion-core::cctp`), and `decodeInboundNote` (`@hyperion/protocol`) reject invalid lengths before slicing or allocating substrings, turning previously linear intermediate copies on oversized hostile payloads into constant-cost (`O(1)`) early exits while returning identical error codes (`MalformedMessage`, `UnsupportedHookVersion`, `InvalidDestination`) for every byte sequence.
- **Invariants preserved:** Exact integer amounts (`i128` ceiling on Stellar, `uint256` with `uint128` quote guard on EVM), authenticated rail dispatch, full-width 32-byte replay protection, and fixed-recipient parked claims remain unchanged.

## Cross-Stack Parser Limits Matrix

The machine-checked source of truth lives in `packages/protocol/src/parserLimits.ts` (`PARSER_LIMITS_MATRIX`) and is verified against repository sources by `packages/protocol/test/parser-limits.test.ts` and `soroban/crates/hyperion-router/src/test/parser_limits.rs`.

| Surface                                           | Rust (`hyperion-core` / `hyperion-router`)                                                        | Solidity (`evm/src`)                                                                                   | TypeScript SDK (`@hyperion/protocol`)                                                         |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| `OutboundNote` (`[ver][20B][8B]`)                 | Exact `29` B (`MalformedMessage`, `O(1)`)                                                         | Exact `29` B (`MalformedMessage`, `O(1)`)                                                              | Exact `29` B (`MalformedMessage`, `O(1)`)                                                     |
| `InboundNote` (`[ver][kind][len][strkey][8B]`)    | `67` B or `80` B (`< 12` B `MalformedMessage`, else `InvalidDestination`, `O(1)`)                 | `67` B or `80` B (`> 266` B or frame mismatch `MalformedMessage`, strkey `InvalidDestination`, `O(1)`) | `67` B or `80` B (frame mismatch `MalformedMessage`, strkey len `InvalidDestination`, `O(1)`) |
| SEP-23 StrKey (`G` / `C` / `M`)                   | `56` or `69` chars (`InvalidDestination`, `O(1)`)                                                 | `56` or `69` chars (`InvalidDestination`, `O(1)`)                                                      | `56` or `69` chars (`InvalidDestination`, `O(1)`)                                             |
| Framed `StrkeyDestination` (`[kind][len][ascii]`) | `58` B or `71` B (`InvalidDestination`, `O(1)`)                                                   | `58` B or `71` B (`InvalidDestination`, `O(1)`)                                                        | `58` B or `71` B (`InvalidDestination`, `O(1)`)                                               |
| Binary `StellarDestination` (`[kind][32B][8B?]`)  | `33` B or `41` B (`InvalidDestination`, `O(1)`)                                                   | `33` B or `41` B (`InvalidDestination`, `O(1)`)                                                        | `33` B or `41` B (`InvalidDestination`, `O(1)`)                                               |
| CCTP v2 message header                            | Fixed `148` B prefix (`< 148` B `MalformedMessage`, `O(1)`)                                       | Circle `MessageTransmitterV2` (`148` B header)                                                         | Fixed `148` B prefix (`< 148` B `MalformedMessage`, `O(1)`)                                   |
| CCTP v2 burn body fields                          | Fixed `228` B prefix (`> i128::MAX` `DecimalOverflow`, `O(1)`)                                    | Circle `TokenMessengerV2` (`228` B burn body)                                                          | Fixed `228` B prefix (`> i128::MAX` `DecimalOverflow`, `O(1)`)                                |
| CCTP `HyperionHook` (`[ver][tagged]`)             | `34` B or `42` B (`InvalidDestination`, `O(1)`; `Cctp` route gates muxed via `MuxedNotSupported`) | `34` B or `42` B (`HyperionRouter` gates muxed via `MuxedNotSupported`)                                | `34` B or `42` B (`MalformedMessage`, `O(1)`)                                                 |
| Left-padded EVM address word                      | Exact `32` B (`BytesN<32>`, `NotEvmAddress` / `ZeroAddressKey`, `O(1)`)                           | Exact `32` B (`bytes32`, `NotEvmAddress` / `ZeroAddressKey`, `O(1)`)                                   | Exact `32` B (`MalformedMessage` / `NotEvmAddress` / `ZeroAddressKey`, `O(1)`)                |
| Timelocked `AdminAction`                          | Closed 15-variant XDR enum (`16`..`112` B, no `String`/`Bytes`; `FromXdr` rejects trailing bytes) | Fixed 5-slot `160` B ABI tuple (`ActionFieldNotEmpty` on unused fields)                                | Static 5-field `160` B ABI tuple `(uint8,uint8,address,uint256,uint8)`                        |

## Reproducing the Stress Suites

```bash
cd soroban
cargo test --workspace --locked parser_limits

cd ../packages/protocol
npx vitest run test/parser-limits.test.ts
```
