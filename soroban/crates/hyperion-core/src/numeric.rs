//! Full-width division by the small denominators used by fees and rolling windows.
//! Four base-2^32 limbs use native WASM u64 division and retain i128 truncation.

const SMALL_POWERS: [u32; 9] = [
    1,
    10,
    100,
    1_000,
    10_000,
    100_000,
    1_000_000,
    10_000_000,
    100_000_000,
];

#[inline(never)]
pub(crate) fn divide_small(value: i128, divisor: u32) -> i128 {
    assert!(divisor != 0);
    let magnitude = value.unsigned_abs();
    let divisor = u64::from(divisor);
    let high = (magnitude >> 64) as u64;
    let high_quotient = high / divisor;
    let remainder = high % divisor;
    let partial2 = (remainder << 32) | u64::from((magnitude >> 32) as u32);
    let digit2 = partial2 / divisor;
    let remainder = partial2 % divisor;
    let partial3 = (remainder << 32) | u64::from(magnitude as u32);
    let digit3 = partial3 / divisor;
    let quotient =
        (u128::from(high_quotient) << 64) | (u128::from(digit2) << 32) | u128::from(digit3);
    if value < 0 {
        (quotient as i128).wrapping_neg()
    } else {
        quotient as i128
    }
}

#[inline(never)]
pub(crate) fn divide_power_of_ten(mut value: i128, mut exponent: u32) -> i128 {
    while exponent >= 9 {
        value = divide_small(value, 1_000_000_000);
        exponent -= 9;
    }
    let divisor = SMALL_POWERS[exponent as usize];
    divide_small(value, divisor)
}

#[inline(never)]
pub(crate) fn multiply_small(value: i128, factor: u32) -> Option<i128> {
    let mut magnitude = value.unsigned_abs();
    let mut product = 0u128;
    let mut carry = 0u64;
    for _ in 0..4 {
        let limb = magnitude as u32;
        magnitude >>= 32;
        let partial = u64::from(limb) * u64::from(factor) + carry;
        // Shift prior low-to-high digits down as each new high digit arrives.
        product = (product >> 32) | (u128::from(partial as u32) << 96);
        carry = partial >> 32;
    }
    let signed_product = product as i128;
    if carry != 0 || (signed_product < 0 && (value >= 0 || signed_product != i128::MIN)) {
        return None;
    }
    Some(if value < 0 {
        (product as i128).wrapping_neg()
    } else {
        product as i128
    })
}

#[inline(never)]
pub(crate) fn multiply_power_of_ten(mut value: i128, mut exponent: u32) -> Option<i128> {
    while exponent >= 9 {
        value = multiply_small(value, 1_000_000_000)?;
        exponent -= 9;
    }
    multiply_small(value, SMALL_POWERS[exponent as usize])
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn signed_boundaries_match_native_division() {
        for value in [i128::MIN, i128::MIN + 1, -1, 0, 1, i128::MAX] {
            for divisor in [1, 2, 10, 10_000, 1_000_000_000, u32::MAX] {
                assert_eq!(divide_small(value, divisor), value / i128::from(divisor));
            }
            for factor in [0, 1, 2, 10, 10_000, 1_000_000_000, u32::MAX] {
                assert_eq!(
                    multiply_small(value, factor),
                    value.checked_mul(i128::from(factor))
                );
            }
            for exponent in 0..=38 {
                assert_eq!(
                    divide_power_of_ten(value, exponent),
                    value / 10i128.pow(exponent)
                );
                assert_eq!(
                    multiply_power_of_ten(value, exponent),
                    value.checked_mul(10i128.pow(exponent))
                );
            }
        }
    }

    proptest! {
        #[test]
        fn full_width_small_factors_match_native(value in any::<i128>(), factor in any::<u32>()) {
            prop_assert_eq!(multiply_small(value, factor), value.checked_mul(i128::from(factor)));
        }

        #[test]
        fn all_supported_decimal_factors_match_native(value in any::<i128>(), exponent in 0u32..=38) {
            prop_assert_eq!(multiply_power_of_ten(value, exponent), value.checked_mul(10i128.pow(exponent)));
        }

        #[test]
        fn full_width_small_divisors_match_native(value in any::<i128>(), divisor in 1u32..=u32::MAX) {
            prop_assert_eq!(divide_small(value, divisor), value / i128::from(divisor));
        }

        #[test]
        fn all_supported_decimal_divisors_match_native(value in any::<i128>(), exponent in 0u32..=38) {
            prop_assert_eq!(divide_power_of_ten(value, exponent), value / 10i128.pow(exponent));
        }
    }
}
