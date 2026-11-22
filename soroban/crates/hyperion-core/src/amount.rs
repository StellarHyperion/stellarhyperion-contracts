use crate::error::HyperionError;
use crate::{BPS_DENOMINATOR, MAX_FEE_BPS};
use soroban_sdk::xdr::ToXdr;

/// Largest decimal exponent we will scale by. i128 tops out a little above 1.7e38, so 38 is
/// the point past which no useful amount survives a scale-up anyway.
pub const MAX_DECIMALS: u32 = 38;

/// Result of moving an amount between two decimal bases.
///
/// `dust` is the part that could not be represented on the destination side. Hyperion never
/// swallows it. The router rejects a transfer with nonzero dust and the SDK quotes an amount
/// that divides cleanly, so a user is never surprised by a balance that shrank in transit.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct Conversion {
    pub amount: i128,
    pub dust: i128,
}

impl Conversion {
    pub fn is_exact(&self) -> bool {
        self.dust == 0
    }
}

/// 10 raised to `exp`, or `None` if it does not fit in an i128.
#[inline(never)]
pub fn pow10(exp: u32) -> Option<i128> {
    if exp > MAX_DECIMALS {
        return None;
    }
    crate::numeric::multiply_power_of_ten(1, exp)
}

/// Move `amount` from a `from`-decimal base into a `to`-decimal base.
///
/// This is the only place in the codebase allowed to do that arithmetic. USDC is 6 decimals
/// on every EVM chain and 7 on Stellar, so forwarding a raw integer between the two is off by
/// exactly 10x. Every call site goes through here instead.
#[inline(never)]
pub fn convert_decimals(amount: i128, from: u32, to: u32) -> Result<Conversion, HyperionError> {
    if amount < 0 {
        return Err(HyperionError::InvalidAmount);
    }
    if from > MAX_DECIMALS || to > MAX_DECIMALS {
        return Err(HyperionError::InvalidDecimals);
    }

    if from == to {
        return Ok(Conversion { amount, dust: 0 });
    }

    if to > from {
        let scaled = crate::numeric::multiply_power_of_ten(amount, to - from)
            .ok_or(HyperionError::DecimalOverflow)?;
        Ok(Conversion {
            amount: scaled,
            dust: 0,
        })
    } else {
        let quotient = crate::numeric::divide_power_of_ten(amount, from - to);
        let represented = crate::numeric::multiply_power_of_ten(quotient, from - to)
            .ok_or(HyperionError::DecimalOverflow)?;
        Ok(Conversion {
            amount: quotient,
            dust: amount - represented,
        })
    }
}

/// Same as [`convert_decimals`] but refuses to lose anything.
///
/// The router uses this on the outbound leg. If the caller asked to send an amount whose tail
/// digits cannot cross the decimal boundary, that is a quoting bug upstream and the transfer
/// should fail loudly here rather than quietly deliver less.
#[inline(never)]
pub fn convert_decimals_exact(amount: i128, from: u32, to: u32) -> Result<i128, HyperionError> {
    let converted = convert_decimals(amount, from, to)?;
    if !converted.is_exact() {
        return Err(HyperionError::AmountNotRepresentable);
    }
    Ok(converted.amount)
}

/// Convenience helper to scale an amount from a `from`-decimal base into a `to`-decimal base,
/// returning the converted destination amount.
pub fn scale_amount(amount: i128, from: u32, to: u32) -> Result<i128, HyperionError> {
    convert_decimals(amount, from, to).map(|c| c.amount)
}

/// Round `amount` down to the nearest value that survives a `from` to `to` conversion intact.
///
/// This is what the SDK calls to turn "send everything I have" into a number the router will
/// actually accept.
pub fn floor_to_representable(amount: i128, from: u32, to: u32) -> Result<i128, HyperionError> {
    if amount < 0 {
        return Err(HyperionError::InvalidAmount);
    }
    if from > MAX_DECIMALS || to > MAX_DECIMALS {
        return Err(HyperionError::InvalidDecimals);
    }
    if to >= from {
        return Ok(amount);
    }
    let quotient = crate::numeric::divide_power_of_ten(amount, from - to);
    crate::numeric::multiply_power_of_ten(quotient, from - to).ok_or(HyperionError::DecimalOverflow)
}

/// How a gross amount divides between the recipient and the protocol.
///
/// This is a named struct rather than a pair of i128s on purpose. Two same-typed numbers in a
/// tuple are one careless destructuring away from charging a 99.9 percent fee, and the whole
/// reason this module exists is to keep that class of mistake out of the contracts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FeeSplit {
    /// What crosses.
    pub net: i128,
    /// What the protocol keeps.
    pub fee: i128,
}

/// Split `amount` into what the recipient gets and what the protocol keeps.
///
/// The fee is charged on the outbound leg only and denominated in the asset being bridged, so
/// the number a user sees does not drift with an unrelated gas market.
pub fn apply_fee(amount: i128, fee_bps: u32) -> Result<FeeSplit, HyperionError> {
    if amount <= 0 {
        return Err(HyperionError::InvalidAmount);
    }
    if fee_bps > MAX_FEE_BPS {
        return Err(HyperionError::FeeTooHigh);
    }
    let product =
        crate::numeric::multiply_small(amount, fee_bps).ok_or(HyperionError::DecimalOverflow)?;
    let fee = crate::numeric::divide_small(product, BPS_DENOMINATOR as u32);
    let net = amount - fee;
    if net <= 0 {
        return Err(HyperionError::InvalidAmount);
    }
    Ok(FeeSplit { net, fee })
}

/// Charge the protocol fee, then floor only the net amount to destination precision.
/// Shares the same fee and retained-dust policy between execution and both quote versions.
#[inline(never)]
pub fn fee_and_floor(
    amount: i128,
    fee_bps: u32,
    source_decimals: u32,
    destination_decimals: u32,
) -> Result<FeeSplit, HyperionError> {
    let split = apply_fee(amount, fee_bps)?;
    Ok(FeeSplit {
        fee: split.fee,
        net: floor_to_representable(split.net, source_decimals, destination_decimals)?,
    })
}

/// Complete source-debit and dust breakdown for an outbound transfer quote.
///
/// Preserves exact integer accounting across fee rounding and destination decimal flooring:
/// `requested_amount == actual_debit + retained_dust` and `actual_debit == fee + net_amount`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct QuoteBreakdown {
    pub requested_amount: i128,
    pub fee: i128,
    pub net_amount: i128,
    pub retained_dust: i128,
    pub actual_debit: i128,
    pub destination_amount: i128,
}

/// Compute the full source-debit and dust breakdown for `requested_amount`.
pub fn compute_quote_breakdown(
    requested_amount: i128,
    fee_bps: u32,
    source_decimals: u32,
    destination_decimals: u32,
) -> Result<QuoteBreakdown, HyperionError> {
    let split = fee_and_floor(
        requested_amount,
        fee_bps,
        source_decimals,
        destination_decimals,
    )?;
    let net_amount = split.net;
    let retained_dust = requested_amount - split.fee - net_amount;
    let actual_debit = split.fee + net_amount;
    let destination_amount =
        convert_decimals_exact(net_amount, source_decimals, destination_decimals)?;
    Ok(QuoteBreakdown {
        requested_amount,
        fee: split.fee,
        net_amount,
        retained_dust,
        actual_debit,
        destination_amount,
    })
}

/// Check that an actual transferred amount matches the expected exact amount,
/// refusing fee-on-transfer, deflationary, or hostile balance mutations that
/// violate router accounting assumptions.
#[inline(never)]
pub fn assert_exact_transfer(
    balance_before: i128,
    balance_after: i128,
    expected_amount: i128,
) -> Result<(), HyperionError> {
    if expected_amount < 0 || balance_before < 0 || balance_after < 0 {
        return Err(HyperionError::InvalidAmount);
    }
    let diff = balance_after
        .checked_sub(balance_before)
        .ok_or(HyperionError::DecimalOverflow)?;
    if diff != expected_amount {
        return Err(HyperionError::InvalidAmount);
    }
    Ok(())
}

/// Compute a 32-byte deterministic fingerprint binding an outbound quote to its exact
/// route, adapter contract, fee rate, source decimals, and destination decimals.
pub fn compute_quote_fingerprint(
    env: &soroban_sdk::Env,
    route: crate::RouteKind,
    adapter: &soroban_sdk::Address,
    fee_bps: u32,
    source_decimals: u32,
    destination_decimals: u32,
) -> soroban_sdk::BytesN<32> {
    env.crypto()
        .sha256(
            &(
                route as u32,
                adapter.clone(),
                fee_bps,
                source_decimals,
                destination_decimals,
            )
                .to_xdr(env),
        )
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EVM_USDC_DECIMALS, STELLAR_DECIMALS};
    use proptest::prelude::*;

    #[test]
    fn pow10_covers_the_useful_range() {
        assert_eq!(pow10(0), Some(1));
        assert_eq!(pow10(1), Some(10));
        assert_eq!(pow10(6), Some(1_000_000));
        assert_eq!(pow10(7), Some(10_000_000));
        assert_eq!(
            pow10(38),
            Some(100_000_000_000_000_000_000_000_000_000_000_000_000)
        );
        assert_eq!(pow10(39), None);
    }

    #[test]
    fn one_usdc_evm_to_stellar_is_exactly_ten_million_stroops() {
        // 1.000000 USDC on Ethereum is 1_000_000 base units at 6 decimals.
        // The same dollar on Stellar is 10_000_000 base units at 7 decimals.
        let out = convert_decimals(1_000_000, EVM_USDC_DECIMALS, STELLAR_DECIMALS).unwrap();
        assert_eq!(out.amount, 10_000_000);
        assert_eq!(out.dust, 0);
    }

    #[test]
    fn one_usdc_stellar_to_evm_round_trips() {
        let out = convert_decimals(10_000_000, STELLAR_DECIMALS, EVM_USDC_DECIMALS).unwrap();
        assert_eq!(out.amount, 1_000_000);
        assert_eq!(out.dust, 0);
    }

    #[test]
    fn the_seventh_decimal_place_is_dust_going_to_evm() {
        // 1.0000001 USDC expressed on Stellar. That last digit has nowhere to go on an EVM
        // chain, and this is the exact case that silently eats user funds if unhandled.
        let out = convert_decimals(10_000_001, STELLAR_DECIMALS, EVM_USDC_DECIMALS).unwrap();
        assert_eq!(out.amount, 1_000_000);
        assert_eq!(out.dust, 1);
        assert!(!out.is_exact());
    }

    #[test]
    fn exact_conversion_refuses_to_drop_dust() {
        assert_eq!(
            convert_decimals_exact(10_000_001, STELLAR_DECIMALS, EVM_USDC_DECIMALS),
            Err(HyperionError::AmountNotRepresentable)
        );
        assert_eq!(
            convert_decimals_exact(10_000_000, STELLAR_DECIMALS, EVM_USDC_DECIMALS),
            Ok(1_000_000)
        );
    }

    #[test]
    fn floor_to_representable_clears_the_tail() {
        assert_eq!(
            floor_to_representable(10_000_009, STELLAR_DECIMALS, EVM_USDC_DECIMALS),
            Ok(10_000_000)
        );
        // Scaling up never loses anything, so nothing needs clearing.
        assert_eq!(
            floor_to_representable(1_234_567, EVM_USDC_DECIMALS, STELLAR_DECIMALS),
            Ok(1_234_567)
        );
    }

    #[test]
    fn xlm_has_seven_decimals_and_survives_a_same_base_conversion() {
        let out = convert_decimals(12_345_678, STELLAR_DECIMALS, STELLAR_DECIMALS).unwrap();
        assert_eq!(out.amount, 12_345_678);
        assert_eq!(out.dust, 0);
    }

    #[test]
    fn negative_amounts_are_rejected() {
        assert_eq!(
            convert_decimals(-1, 6, 7),
            Err(HyperionError::InvalidAmount)
        );
        assert_eq!(
            floor_to_representable(-1, 7, 6),
            Err(HyperionError::InvalidAmount)
        );
    }

    #[test]
    fn absurd_decimals_are_rejected_rather_than_wrapped() {
        assert_eq!(
            convert_decimals(1, 0, 39),
            Err(HyperionError::InvalidDecimals)
        );
        assert_eq!(
            convert_decimals(1, 39, 0),
            Err(HyperionError::InvalidDecimals)
        );
    }

    #[test]
    fn scaling_up_past_i128_is_an_overflow_not_a_wrap() {
        assert_eq!(
            convert_decimals(i128::MAX / 2, 0, 30),
            Err(HyperionError::DecimalOverflow)
        );
    }

    #[test]
    fn zero_converts_to_zero_in_both_directions() {
        assert_eq!(convert_decimals(0, 6, 7).unwrap().amount, 0);
        assert_eq!(convert_decimals(0, 7, 6).unwrap().amount, 0);
    }

    #[test]
    fn fee_math_matches_the_documented_opening_range() {
        // 1000 USDC at 6 decimals, 10 bps.
        let FeeSplit { net, fee } = apply_fee(1_000_000_000, 10).unwrap();
        assert_eq!(fee, 1_000_000);
        assert_eq!(net, 999_000_000);
        assert_eq!(net + fee, 1_000_000_000);
    }

    #[test]
    fn a_zero_fee_is_allowed_and_takes_nothing() {
        let FeeSplit { net, fee } = apply_fee(500, 0).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(net, 500);
    }

    #[test]
    fn fee_above_the_hard_cap_is_refused() {
        assert_eq!(apply_fee(1_000_000, 101), Err(HyperionError::FeeTooHigh));
        assert!(apply_fee(1_000_000, MAX_FEE_BPS).is_ok());
    }

    #[test]
    fn a_dust_sized_transfer_that_would_round_the_fee_to_zero_still_balances() {
        // 1 base unit at 10 bps rounds the fee down to nothing. The user keeps their unit
        // rather than the call reverting, and the books still add up.
        let FeeSplit { net, fee } = apply_fee(1, 10).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(net, 1);
    }

    #[test]
    fn zero_and_negative_amounts_cannot_be_charged_a_fee() {
        assert_eq!(apply_fee(0, 10), Err(HyperionError::InvalidAmount));
        assert_eq!(apply_fee(-5, 10), Err(HyperionError::InvalidAmount));
    }

    #[test]
    fn exact_transfer_rejects_negative_balances_and_amounts() {
        for (before, after, amount) in [(-1, 0, 1), (0, -1, 1), (0, 0, -1)] {
            assert_eq!(
                assert_exact_transfer(before, after, amount),
                Err(HyperionError::InvalidAmount)
            );
        }
        assert_eq!(assert_exact_transfer(i128::MAX - 1, i128::MAX, 1), Ok(()));
        assert_eq!(
            assert_exact_transfer(i128::MAX, 0, 1),
            Err(HyperionError::InvalidAmount)
        );
    }

    proptest! {
        /// Scaling up then back down is lossless, always.
        #[test]
        fn evm_to_stellar_to_evm_is_lossless(amount in 0i128..1_000_000_000_000_000i128) {
            let up = convert_decimals(amount, EVM_USDC_DECIMALS, STELLAR_DECIMALS).unwrap();
            prop_assert_eq!(up.dust, 0);
            let down = convert_decimals(up.amount, STELLAR_DECIMALS, EVM_USDC_DECIMALS).unwrap();
            prop_assert_eq!(down.amount, amount);
            prop_assert_eq!(down.dust, 0);
        }

        /// Nothing vanishes on the way down: quotient times factor plus remainder is the input.
        #[test]
        fn scaling_down_conserves_value(amount in 0i128..i128::MAX / 2) {
            let out = convert_decimals(amount, STELLAR_DECIMALS, EVM_USDC_DECIMALS).unwrap();
            let factor = pow10(STELLAR_DECIMALS - EVM_USDC_DECIMALS).unwrap();
            prop_assert_eq!(out.amount * factor + out.dust, amount);
            prop_assert!(out.dust >= 0 && out.dust < factor);
        }

        /// Flooring is idempotent and never rounds up.
        #[test]
        fn floor_is_idempotent_and_never_increases(amount in 0i128..i128::MAX / 2) {
            let once = floor_to_representable(amount, STELLAR_DECIMALS, EVM_USDC_DECIMALS).unwrap();
            let twice = floor_to_representable(once, STELLAR_DECIMALS, EVM_USDC_DECIMALS).unwrap();
            prop_assert_eq!(once, twice);
            prop_assert!(once <= amount);
            prop_assert!(convert_decimals_exact(once, STELLAR_DECIMALS, EVM_USDC_DECIMALS).is_ok());
        }

        /// The fee split always adds back up to the input and never exceeds the cap share.
        #[test]
        fn fee_split_conserves_value(
            amount in 1i128..1_000_000_000_000_000_000i128,
            bps in 0u32..=MAX_FEE_BPS,
        ) {
            let FeeSplit { net, fee } = apply_fee(amount, bps).unwrap();
            prop_assert_eq!(net + fee, amount);
            prop_assert!(fee >= 0);
            prop_assert!(net > 0);
            prop_assert!(fee <= amount / 100);
        }

        #[test]
        fn exact_transfer_assertions(
            before in 0i128..1_000_000_000i128,
            transfer in 0i128..1_000_000_000i128,
            fee in 1i128..10_000i128,
        ) {
            // Exact transfer succeeds
            prop_assert!(assert_exact_transfer(before, before + transfer, transfer).is_ok());
            // Fee on transfer (receiving less) fails
            if transfer > fee {
                prop_assert_eq!(
                    assert_exact_transfer(before, before + transfer - fee, transfer),
                    Err(HyperionError::InvalidAmount)
                );
            }
            // Hostile balance inflation (receiving more) fails
            prop_assert_eq!(
                assert_exact_transfer(before, before + transfer + fee, transfer),
                Err(HyperionError::InvalidAmount)
            );
        }

        #[test]
        fn quote_breakdown_conserves_requested_amount(
            amount in 100i128..1_000_000_000_000_000i128,
            bps in 0u32..=MAX_FEE_BPS,
        ) {
            let b = compute_quote_breakdown(amount, bps, STELLAR_DECIMALS, EVM_USDC_DECIMALS).unwrap();
            prop_assert_eq!(b.requested_amount, amount);
            prop_assert_eq!(b.actual_debit, b.fee + b.net_amount);
            prop_assert_eq!(b.actual_debit + b.retained_dust, b.requested_amount);
            prop_assert!(b.retained_dust >= 0 && b.retained_dust < 10);
            prop_assert_eq!(b.destination_amount * 10, b.net_amount);
        }
    }
}
