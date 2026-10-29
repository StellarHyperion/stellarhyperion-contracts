use soroban_env_host::{budget::AsBudget, Env, EnvBase, Host, HostError, U32Val};

// Public go-ethereum secp256k1 vector retained by upstream src/test/crypto.rs.
#[test]
fn secp256k1_recovery_and_invalid_inputs() -> Result<(), HostError> {
    let host = Host::test_host();
    let digest =
        hex::decode("ce0677bb30baa8cf067c88db9811f4333d131bf8bcf12fe7065d211dce971008").unwrap();
    let signature = hex::decode("90f27b8b488db00b00606796d2987f6a5f59ae62ea05effe84fef5b8b0e549984a691139ad57a3f0b906637673aa2f63d1f55cb1a69199d4009eea23ceaddc93").unwrap();
    let recover = |digest: &[u8], signature: &[u8], recovery_id: u32| {
        host.as_budget().reset_default()?;
        host.recover_key_ecdsa_secp256k1(
            host.bytes_new_from_slice(digest)?,
            host.bytes_new_from_slice(signature)?,
            U32Val::from(recovery_id),
        )
    };
    let key = recover(&digest, &signature, 1)?;
    let mut bytes = [0u8; 65];
    host.bytes_copy_to_slice(key, U32Val::from(0), &mut bytes)?;
    assert_eq!(hex::encode(bytes), "04e32df42865e97135acfb65f3bae71bdc86f4d49150ad6a440b6f15878109880a0a2b2667f7e725ceea70c673093bf67663e0312623c8e091b13cf2c0f11ef652");
    assert!(recover(&digest, &signature, 5).is_err());
    assert!(recover(&digest, &signature, u32::MAX).is_err());
    assert!(recover(&digest[..31], &signature, 1).is_err());
    assert!(recover(&digest, &signature[..63], 1).is_err());
    assert!(recover(&digest, &[0; 64], 1).is_err());
    let high_s = hex::decode("90f27b8b488db00b00606796d2987f6a5f59ae62ea05effe84fef5b8b0e54998b596eec652a85c0f46f99c898c55d09ae8b9803508b70667bf337469018864ae").unwrap();
    assert!(recover(&digest, &high_s, 1).is_err());
    Ok(())
}

// NIST P-256/SHA-256 vector retained by upstream src/test/crypto.rs. Test high-S
// rejection directly: the NIST/Wycheproof suites intentionally normalize S.
#[test]
fn secp256r1_preserves_low_s_and_rejects_malleability() -> Result<(), HostError> {
    let host = Host::test_host();
    let public_key = hex::decode("04e424dc61d4bb3cb7ef4344a7f8957a0c5134e16f7a67c074f82e6e12f49abf3c970eed7aa2bc48651545949de1dddaf0127e5965ac85d1243d6f60e7dfaee927").unwrap();
    let digest =
        hex::decode("d1b8ef21eb4182ee270638061063a3f3c16c114e33937f69fb232cc833965a94").unwrap();
    let signature = hex::decode("bf96b99aa49c705c910be33142017c642ff540c76349b9dab72f981fd9347f4f17c55095819089c2e03b9cd415abdf12444e323075d98f31920b9e0f57ec871c").unwrap();
    let verify = |key: &[u8], digest: &[u8], sig: &[u8]| {
        host.as_budget().reset_default()?;
        host.verify_sig_ecdsa_secp256r1(
            host.bytes_new_from_slice(key)?,
            host.bytes_new_from_slice(digest)?,
            host.bytes_new_from_slice(sig)?,
        )
    };
    assert!(verify(&public_key, &digest, &signature).is_ok());
    assert!(verify(&public_key, &digest, &hex::decode("bf96b99aa49c705c910be33142017c642ff540c76349b9dab72f981fd9347f4fe83aaf697e6f763e1fc4632bea5420ed7898c87d313e0f5361ae2cb3a4769e35").unwrap()).is_err());
    assert!(verify(&public_key, &digest, &[0; 64]).is_err());
    assert!(verify(&public_key[..64], &digest, &signature).is_err());
    assert!(verify(&public_key, &digest[..31], &signature).is_err());
    let mut corrupted = signature.clone();
    corrupted[63] ^= 1;
    assert!(verify(&public_key, &digest, &corrupted).is_err());
    Ok(())
}
