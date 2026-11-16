// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {
    InvalidDestination,
    MalformedMessage,
    NotEvmAddress,
    UnsupportedHookVersion,
    ZeroAddressKey
} from "../../src/HyperionErrors.sol";
import {AddressKind} from "../../src/HyperionTypes.sol";
import {NotesHarness, StellarAddressHarness} from "../harness/LibHarness.sol";

/// @title Cross-language malformed-message corpus v1 (Solidity side)
/// @notice Executes the shared malformed-message-corpus.v1.json vectors against
/// HyperionNotes and StellarAddress.
contract MalformedCorpusTest is Test {
    NotesHarness internal notes;
    StellarAddressHarness internal addr;

    function setUp() public {
        notes = new NotesHarness();
        addr = new StellarAddressHarness();
    }

    function test_corpus_outbound_notes() public {
        // case: outbound-v1-legacy-basic
        {
            bytes memory raw = hex"0100000000000000000000000000000000000beef10000000000000001";
            (address recipient, uint64 nonce) = notes.decodeOutboundNote(raw);
            assertEq(recipient, address(uint160(0x00000000000000000000000000000000000bEEf1)));
            assertEq(nonce, uint64(1));
        }
        // case: outbound-v1-wide-nonce-js-unsafe
        {
            bytes memory raw = hex"0111111111111111111111111111111111111111110020000000000001";
            (address recipient, uint64 nonce) = notes.decodeOutboundNote(raw);
            assertEq(recipient, address(uint160(0x1111111111111111111111111111111111111111)));
            assertEq(nonce, uint64(9_007_199_254_740_993));
        }
        // case: outbound-v1-wide-nonce-u64-max
        {
            bytes memory raw = hex"012222222222222222222222222222222222222222ffffffffffffffff";
            (address recipient, uint64 nonce) = notes.decodeOutboundNote(raw);
            assertEq(recipient, address(uint160(0x2222222222222222222222222222222222222222)));
            assertEq(nonce, uint64(18_446_744_073_709_551_615));
        }
        // case: outbound-empty
        vm.expectRevert(MalformedMessage.selector);
        notes.decodeOutboundNote(hex"");
        // case: outbound-truncated-28b
        vm.expectRevert(MalformedMessage.selector);
        notes.decodeOutboundNote(hex"0100000000000000000000000000000000000beef100000000000000");
        // case: outbound-trailing-30b
        vm.expectRevert(MalformedMessage.selector);
        notes.decodeOutboundNote(hex"0100000000000000000000000000000000000beef1000000000000000100");
        // case: outbound-unsupported-version-0
        vm.expectRevert(UnsupportedHookVersion.selector);
        notes.decodeOutboundNote(hex"0000000000000000000000000000000000000beef10000000000000001");
        // case: outbound-unsupported-version-2
        vm.expectRevert(UnsupportedHookVersion.selector);
        notes.decodeOutboundNote(hex"0200000000000000000000000000000000000beef10000000000000001");
        // case: outbound-zero-recipient
        vm.expectRevert(ZeroAddressKey.selector);
        notes.decodeOutboundNote(hex"0100000000000000000000000000000000000000000000000000000007");
    }

    function test_corpus_inbound_notes_accepted() public view {
        // case: inbound-v1-legacy-account
        {
            bytes memory raw = hex"0100384741495243454952434549524345495243454952434549524345495243"
                hex"45495243454952434549524345495243454952434549524346364d0000000000" hex"00002a";
            (AddressKind kind, string memory strkey, uint64 nonce) = notes.decodeInboundNote(raw);
            assertEq(uint8(kind), uint8(AddressKind.Account));
            assertEq(strkey, "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M");
            assertEq(nonce, uint64(42));
        }
        // case: inbound-v1-legacy-contract
        {
            bytes memory raw = hex"0101384341524345495243454952434549524345495243454952434549524345"
                hex"49524345495243454952434549524345495243454952434556514f0000000000" hex"000063";
            (AddressKind kind, string memory strkey, uint64 nonce) = notes.decodeInboundNote(raw);
            assertEq(uint8(kind), uint8(AddressKind.Contract));
            assertEq(strkey, "CARCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEVQO");
            assertEq(nonce, uint64(99));
        }
        // case: inbound-v1-wide-muxed-js-unsafe
        {
            bytes memory raw = hex"0102454d415743594c424d46515743594c424d46515743594c424d4651574359"
                hex"4c424d46515743594c424d46515743594c424d46515743594142414141414141"
                hex"4141414147424d590020000000000001";
            (AddressKind kind, string memory strkey, uint64 nonce) = notes.decodeInboundNote(raw);
            assertEq(uint8(kind), uint8(AddressKind.MuxedAccount));
            assertEq(strkey, "MAWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYABAAAAAAAAAAGBMY");
            assertEq(nonce, uint64(9_007_199_254_740_993));
        }
        // case: inbound-v1-wide-muxed-u64-max
        {
            bytes memory raw = hex"0102454d415743594c424d46515743594c424d46515743594c424d4651574359"
                hex"4c424d46515743594c424d46515743594c424d465157435a3737373737373737"
                hex"3737373736324249ffffffffffffffff";
            (AddressKind kind, string memory strkey, uint64 nonce) = notes.decodeInboundNote(raw);
            assertEq(uint8(kind), uint8(AddressKind.MuxedAccount));
            assertEq(strkey, "MAWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCZ77777777777762BI");
            assertEq(nonce, uint64(18_446_744_073_709_551_615));
        }
        // case: inbound-kind-prefix-mismatch
        {
            bytes memory raw = hex"0101384741495243454952434549524345495243454952434549524345495243"
                hex"45495243454952434549524345495243454952434549524346364d0000000000" hex"000001";
            (AddressKind kind, string memory strkey, uint64 nonce) = notes.decodeInboundNote(raw);
            assertEq(uint8(kind), uint8(AddressKind.Contract));
            assertEq(strkey, "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M");
            assertEq(nonce, uint64(1));
        }
    }

    function test_corpus_inbound_notes_rejected() public {
        // case: inbound-truncated-header-3b
        vm.expectRevert(MalformedMessage.selector);
        notes.decodeInboundNote(hex"010038");
        // case: inbound-truncated-body-short
        vm.expectRevert(MalformedMessage.selector);
        notes.decodeInboundNote(
            hex"0100384741495243454952434549524345495243454952434549524345495243"
            hex"45495243454952434549524345495243454952434549524346364d0000000000" hex"0000"
        );
        // case: inbound-trailing-extra-byte
        vm.expectRevert(MalformedMessage.selector);
        notes.decodeInboundNote(
            hex"0100384741495243454952434549524345495243454952434549524345495243"
            hex"45495243454952434549524345495243454952434549524346364d0000000000" hex"00002aff"
        );
        // case: inbound-unsupported-version-0
        vm.expectRevert(UnsupportedHookVersion.selector);
        notes.decodeInboundNote(
            hex"0000384741495243454952434549524345495243454952434549524345495243"
            hex"45495243454952434549524345495243454952434549524346364d0000000000" hex"00002a"
        );
        // case: inbound-unsupported-version-9
        vm.expectRevert(UnsupportedHookVersion.selector);
        notes.decodeInboundNote(
            hex"0900384741495243454952434549524345495243454952434549524345495243"
            hex"45495243454952434549524345495243454952434549524346364d0000000000" hex"00002a"
        );
    }

    function test_corpus_stellar_strkeys() public {
        // case: strkey-legacy-account
        {
            bytes memory raw = hex"4741495243454952434549524345495243454952434549524345495243454952"
                hex"43454952434549524345495243454952434549524346364d";
            (AddressKind kind, bytes32 key, uint64 muxedId) = addr.parse(string(raw));
            assertEq(uint8(kind), uint8(AddressKind.Account));
            assertEq(key, bytes32(0x1111111111111111111111111111111111111111111111111111111111111111));
            assertEq(muxedId, uint64(0));
        }
        // case: strkey-legacy-contract
        {
            bytes memory raw = hex"4341524345495243454952434549524345495243454952434549524345495243"
                hex"45495243454952434549524345495243454952434556514f";
            (AddressKind kind, bytes32 key, uint64 muxedId) = addr.parse(string(raw));
            assertEq(uint8(kind), uint8(AddressKind.Contract));
            assertEq(key, bytes32(0x2222222222222222222222222222222222222222222222222222222222222222));
            assertEq(muxedId, uint64(0));
        }
        // case: strkey-wide-muxed-u64-max
        {
            bytes memory raw = hex"4d415743594c424d46515743594c424d46515743594c424d46515743594c424d"
                hex"46515743594c424d46515743594c424d465157435a3737373737373737373737" hex"3736324249";
            (AddressKind kind, bytes32 key, uint64 muxedId) = addr.parse(string(raw));
            assertEq(uint8(kind), uint8(AddressKind.MuxedAccount));
            assertEq(key, bytes32(0x2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c));
            assertEq(muxedId, uint64(18_446_744_073_709_551_615));
        }
        // case: strkey-truncated-55c
        {
            bytes memory raw = hex"4741495243454952434549524345495243454952434549524345495243454952"
                hex"4345495243454952434549524345495243454952434636";
            vm.expectRevert(InvalidDestination.selector);
            addr.parse(string(raw));
        }
        // case: strkey-trailing-57c
        {
            bytes memory raw = hex"4741495243454952434549524345495243454952434549524345495243454952"
                hex"43454952434549524345495243454952434549524346364d41";
            vm.expectRevert(InvalidDestination.selector);
            addr.parse(string(raw));
        }
        // case: strkey-bad-crc16
        {
            bytes memory raw = hex"4741495243454952434549524345495243454952434549524345495243454952"
                hex"434549524345495243454952434549524345495243463641";
            vm.expectRevert(InvalidDestination.selector);
            addr.parse(string(raw));
        }
        // case: strkey-muxed-nonzero-spare-bit
        {
            bytes memory raw = hex"4d415743594c424d46515743594c424d46515743594c424d46515743594c424d"
                hex"46515743594c424d46515743594c424d46515743594142414141414141414141" hex"4147424d5a";
            vm.expectRevert(InvalidDestination.selector);
            addr.parse(string(raw));
        }
    }

    function test_corpus_evm_words_and_cctp_hooks() public {
        // case: evm-word-legacy-clean
        assertEq(
            notes.toEvmAddress(bytes32(0x00000000000000000000000000000000000000000000000000000000000beef1)),
            address(uint160(0x00000000000000000000000000000000000bEEf1))
        );
        // case: evm-word-dirty-high-byte
        vm.expectRevert(NotEvmAddress.selector);
        notes.toEvmAddress(bytes32(0x0000000000000000000000011111111111111111111111111111111111111111));
        // case: evm-word-right-padded
        vm.expectRevert(NotEvmAddress.selector);
        notes.toEvmAddress(bytes32(0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd000000000000000000000000));
        // case: evm-word-all-zero
        vm.expectRevert(ZeroAddressKey.selector);
        notes.toEvmAddress(bytes32(0x0000000000000000000000000000000000000000000000000000000000000000));
        // case: cctp-hook-v1-legacy-account
        {
            bytes memory expected = hex"0100111111111111111111111111111111111111111111111111111111111111"
                hex"1111";
            bytes memory actual = notes.encodeCctpHook(
                AddressKind.Account,
                bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
                uint64(0)
            );
            assertEq(actual, expected);
        }
        // case: cctp-hook-v1-legacy-contract
        {
            bytes memory expected = hex"0101222222222222222222222222222222222222222222222222222222222222"
                hex"2222";
            bytes memory actual = notes.encodeCctpHook(
                AddressKind.Contract,
                bytes32(0x2222222222222222222222222222222222222222222222222222222222222222),
                uint64(0)
            );
            assertEq(actual, expected);
        }
        // case: cctp-hook-v1-wide-muxed-u64-max
        {
            bytes memory expected = hex"01022c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c"
                hex"2c2cffffffffffffffff";
            bytes memory actual = notes.encodeCctpHook(
                AddressKind.MuxedAccount,
                bytes32(0x2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c),
                uint64(18_446_744_073_709_551_615)
            );
            assertEq(actual, expected);
        }
    }
}
