use soroban_sdk::contracttype;

use crate::error::HyperionError;

/// Rolling record of how much of a flow limit has been spent.
///
/// A fixed calendar window is the obvious implementation and also the wrong one: it lets an
/// hour's limit go out twice in two minutes if you straddle the boundary. This uses a sliding
/// window counter instead, keeping the previous window's total and decaying it out
/// proportionally as the current one advances. Two numbers, no unbounded list of timestamps,
/// and no boundary to exploit.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FlowWindow {
    /// Which window this record is anchored to, as ledger sequence divided by window length.
    pub epoch: u32,
    /// Spent inside the current window.
    pub consumed: i128,
    /// Spent inside the window immediately before this one. Decays to nothing as the current
    /// window fills.
    pub prev_consumed: i128,
}

impl FlowWindow {
    pub fn empty() -> Self {
        Self {
            epoch: 0,
            consumed: 0,
            prev_consumed: 0,
        }
    }
}

/// Which window a ledger sequence falls into.
pub fn epoch_of(ledger: u32, window_ledgers: u32) -> Result<u32, HyperionError> {
    if window_ledgers == 0 {
        return Err(HyperionError::InvalidWindow);
    }
    Ok(ledger / window_ledgers)
}

/// Advance a window record to `ledger` without spending anything.
///
/// Stepping forward exactly one window keeps the old total as the decaying tail. Skipping two
/// or more windows means nothing recent happened, so both counters reset.
pub fn roll_forward(
    window: &FlowWindow,
    ledger: u32,
    window_ledgers: u32,
) -> Result<FlowWindow, HyperionError> {
    let mut rolled = window.clone();
    roll_forward_in_place(&mut rolled, ledger, window_ledgers)?;
    Ok(rolled)
}

#[inline(never)]
fn roll_forward_in_place(
    window: &mut FlowWindow,
    ledger: u32,
    window_ledgers: u32,
) -> Result<(), HyperionError> {
    let epoch = epoch_of(ledger, window_ledgers)?;
    if epoch != window.epoch {
        window.prev_consumed = if epoch == window.epoch.saturating_add(1) {
            window.consumed
        } else {
            0
        };
        window.epoch = epoch;
        window.consumed = 0;
    }
    Ok(())
}

/// How much of the limit is considered spent right now.
///
/// The previous window contributes in proportion to how much of the current window is left to
/// run, which is what makes the limit slide instead of stepping.
pub fn effective_consumed(
    window: &FlowWindow,
    ledger: u32,
    window_ledgers: u32,
) -> Result<i128, HyperionError> {
    let mut rolled = window.clone();
    roll_forward_in_place(&mut rolled, ledger, window_ledgers)?;
    effective_consumed_rolled(&rolled, ledger, window_ledgers)
}

// Reuse the already advanced window in consume instead of advancing it a second time.
// Both callers first validate the positive window size through roll_forward.
#[inline(never)]
fn effective_consumed_rolled(
    rolled: &FlowWindow,
    ledger: u32,
    window_ledgers: u32,
) -> Result<i128, HyperionError> {
    let elapsed = (ledger % window_ledgers) as i128;
    let span = window_ledgers as i128;
    let remaining = span - elapsed;
    let weighted = crate::numeric::multiply_small(rolled.prev_consumed, remaining as u32)
        .ok_or(HyperionError::DecimalOverflow)?;
    let decayed = crate::numeric::divide_small(weighted, window_ledgers);
    decayed
        .checked_add(rolled.consumed)
        .ok_or(HyperionError::DecimalOverflow)
}

/// Headroom left under `limit` at `ledger`. Never negative.
pub fn available(
    window: &FlowWindow,
    limit: i128,
    ledger: u32,
    window_ledgers: u32,
) -> Result<i128, HyperionError> {
    if limit < 0 {
        return Err(HyperionError::InvalidLimit);
    }
    let used = effective_consumed(window, ledger, window_ledgers)?;
    Ok(if used >= limit { 0 } else { limit - used })
}

/// Charge `amount` against the limit, or refuse.
///
/// Returns the updated window on success. Refusing is the entire point, so this is a
/// `Result` and never a saturating write.
pub fn consume(
    window: &FlowWindow,
    limit: i128,
    amount: i128,
    ledger: u32,
    window_ledgers: u32,
) -> Result<FlowWindow, HyperionError> {
    if amount <= 0 {
        return Err(HyperionError::InvalidAmount);
    }
    if limit < 0 {
        return Err(HyperionError::InvalidLimit);
    }
    let mut rolled = window.clone();
    roll_forward_in_place(&mut rolled, ledger, window_ledgers)?;
    let used = effective_consumed_rolled(&rolled, ledger, window_ledgers)?;
    let would_be = used
        .checked_add(amount)
        .ok_or(HyperionError::DecimalOverflow)?;
    if would_be > limit {
        return Err(HyperionError::FlowLimitExceeded);
    }
    rolled.consumed = rolled
        .consumed
        .checked_add(amount)
        .ok_or(HyperionError::DecimalOverflow)?;
    Ok(rolled)
}

/// Advance a local outbound window once and return its current headroom.
/// The caller keeps this prepared record until both lane limits have been checked.
#[inline(never)]
pub fn prepare_window(
    window: &mut FlowWindow,
    limit: i128,
    ledger: u32,
    window_ledgers: u32,
) -> Result<i128, HyperionError> {
    if limit < 0 {
        return Err(HyperionError::InvalidLimit);
    }
    roll_forward_in_place(window, ledger, window_ledgers)?;
    let used = effective_consumed_rolled(window, ledger, window_ledgers)?;
    Ok(if used >= limit { 0 } else { limit - used })
}

/// Consume a prepared window after a positive amount passed its headroom check.
/// Headroom then retains the exact effective usage, including legacy signed records.
#[inline(never)]
pub fn consume_prepared(
    window: &mut FlowWindow,
    limit: i128,
    amount: i128,
    headroom: i128,
) -> Result<(), HyperionError> {
    if amount <= 0 {
        return Err(HyperionError::InvalidAmount);
    }
    if limit < 0 {
        return Err(HyperionError::InvalidLimit);
    }
    let used = limit
        .checked_sub(headroom)
        .ok_or(HyperionError::DecimalOverflow)?;
    let would_be = used
        .checked_add(amount)
        .ok_or(HyperionError::DecimalOverflow)?;
    if would_be > limit {
        return Err(HyperionError::FlowLimitExceeded);
    }
    window.consumed = window
        .consumed
        .checked_add(amount)
        .ok_or(HyperionError::DecimalOverflow)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DEFAULT_FLOW_WINDOW_LEDGERS as W;
    use proptest::prelude::*;

    #[test]
    fn a_fresh_window_has_the_whole_limit_available() {
        let w = FlowWindow::empty();
        assert_eq!(available(&w, 1_000, 0, W).unwrap(), 1_000);
    }

    #[test]
    fn spending_reduces_headroom_by_exactly_that_much() {
        let w = FlowWindow::empty();
        let w = consume(&w, 1_000, 400, 10, W).unwrap();
        assert_eq!(w.consumed, 400);
        assert_eq!(available(&w, 1_000, 10, W).unwrap(), 600);
    }

    #[test]
    fn spending_the_whole_limit_is_allowed_and_one_more_unit_is_not() {
        let w = FlowWindow::empty();
        let w = consume(&w, 1_000, 1_000, 5, W).unwrap();
        assert_eq!(available(&w, 1_000, 5, W).unwrap(), 0);
        assert_eq!(
            consume(&w, 1_000, 1, 5, W),
            Err(HyperionError::FlowLimitExceeded)
        );
    }

    #[test]
    fn a_single_oversized_transfer_is_refused_outright() {
        let w = FlowWindow::empty();
        assert_eq!(
            consume(&w, 1_000, 1_001, 0, W),
            Err(HyperionError::FlowLimitExceeded)
        );
    }

    #[test]
    fn a_zero_limit_blocks_everything() {
        let w = FlowWindow::empty();
        assert_eq!(
            consume(&w, 0, 1, 0, W),
            Err(HyperionError::FlowLimitExceeded)
        );
    }

    #[test]
    fn straddling_a_window_boundary_does_not_hand_out_double_the_limit() {
        // This is the bug a fixed calendar window has. Fill the limit at the very end of one
        // window, then immediately try again one ledger into the next.
        let w = FlowWindow::empty();
        let end_of_window = W - 1;
        let w = consume(&w, 1_000, 1_000, end_of_window, W).unwrap();

        let start_of_next = W;
        // One ledger in, essentially the entire previous window is still weighted in, so
        // there is no meaningful headroom.
        let head = available(&w, 1_000, start_of_next, W).unwrap();
        assert!(head <= 2, "expected near-zero headroom, got {head}");
        assert_eq!(
            consume(&w, 1_000, 500, start_of_next, W),
            Err(HyperionError::FlowLimitExceeded)
        );
    }

    #[test]
    fn the_previous_window_decays_out_as_the_current_one_runs() {
        let w = FlowWindow::empty();
        let w = consume(&w, 1_000, 1_000, W - 1, W).unwrap();

        // Halfway through the next window, half the old total still counts.
        let halfway = W + W / 2;
        let used = effective_consumed(&w, halfway, W).unwrap();
        assert!(
            (495..=505).contains(&used),
            "expected about 500, got {used}"
        );

        // At the very end of the next window the old total has essentially gone.
        let nearly_done = W + W - 1;
        let used_late = effective_consumed(&w, nearly_done, W).unwrap();
        assert!(used_late <= 2, "expected about 0, got {used_late}");
    }

    #[test]
    fn skipping_two_windows_clears_both_counters() {
        let w = FlowWindow::empty();
        let w = consume(&w, 1_000, 900, 0, W).unwrap();
        let much_later = W * 4;
        assert_eq!(effective_consumed(&w, much_later, W).unwrap(), 0);
        assert_eq!(available(&w, 1_000, much_later, W).unwrap(), 1_000);
    }

    #[test]
    fn rolling_forward_one_window_moves_the_total_to_the_tail() {
        let w = FlowWindow {
            epoch: 3,
            consumed: 700,
            prev_consumed: 200,
        };
        let rolled = roll_forward(&w, 4 * W, W).unwrap();
        assert_eq!(rolled.epoch, 4);
        assert_eq!(rolled.consumed, 0);
        assert_eq!(rolled.prev_consumed, 700);
    }

    #[test]
    fn rolling_forward_inside_the_same_window_changes_nothing() {
        let w = FlowWindow {
            epoch: 0,
            consumed: 42,
            prev_consumed: 7,
        };
        assert_eq!(roll_forward(&w, 100, W).unwrap(), w);
    }

    #[test]
    fn a_zero_length_window_is_a_configuration_error_not_a_divide_by_zero() {
        let w = FlowWindow::empty();
        assert_eq!(epoch_of(10, 0), Err(HyperionError::InvalidWindow));
        assert_eq!(consume(&w, 100, 1, 0, 0), Err(HyperionError::InvalidWindow));
        assert_eq!(
            effective_consumed(&w, 0, 0),
            Err(HyperionError::InvalidWindow)
        );
    }

    #[test]
    fn zero_and_negative_amounts_are_refused() {
        let w = FlowWindow::empty();
        assert_eq!(consume(&w, 100, 0, 0, W), Err(HyperionError::InvalidAmount));
        assert_eq!(
            consume(&w, 100, -5, 0, W),
            Err(HyperionError::InvalidAmount)
        );
    }

    #[test]
    fn a_negative_limit_is_refused() {
        let w = FlowWindow::empty();
        assert_eq!(consume(&w, -1, 10, 0, W), Err(HyperionError::InvalidLimit));
        assert_eq!(available(&w, -1, 0, W), Err(HyperionError::InvalidLimit));
    }

    #[test]
    fn many_small_transfers_cannot_add_up_past_the_limit() {
        let mut w = FlowWindow::empty();
        let mut sent = 0i128;
        for i in 0..250u32 {
            match consume(&w, 1_000, 10, i, W) {
                Ok(next) => {
                    w = next;
                    sent += 10;
                }
                Err(HyperionError::FlowLimitExceeded) => break,
                Err(e) => panic!("unexpected error {e:?}"),
            }
        }
        assert_eq!(sent, 1_000);
    }

    proptest! {
        /// Headroom and spend always add back up to the limit, and neither goes negative.
        #[test]
        fn headroom_and_spend_are_complementary(
            limit in 0i128..1_000_000_000i128,
            spend in 1i128..1_000_000_000i128,
            ledger in 0u32..5_000_000u32,
        ) {
            let w = FlowWindow::empty();
            match consume(&w, limit, spend, ledger, W) {
                Ok(next) => {
                    let used = effective_consumed(&next, ledger, W).unwrap();
                    prop_assert_eq!(used, spend);
                    prop_assert_eq!(available(&next, limit, ledger, W).unwrap(), limit - spend);
                }
                Err(e) => {
                    prop_assert_eq!(e, HyperionError::FlowLimitExceeded);
                    prop_assert!(spend > limit);
                }
            }
        }

        /// No sequence of accepted spends can ever push effective usage past the limit.
        #[test]
        fn the_limit_is_never_breached(
            limit in 1i128..1_000_000i128,
            amounts in proptest::collection::vec(1i128..200_000i128, 1..40),
            start in 0u32..1_000_000u32,
        ) {
            let mut w = FlowWindow::empty();
            for (i, amount) in amounts.iter().enumerate() {
                let ledger = start + i as u32 * 13;
                if let Ok(next) = consume(&w, limit, *amount, ledger, W) {
                    w = next;
                    let used = effective_consumed(&w, ledger, W).unwrap();
                    prop_assert!(used <= limit, "used {} exceeded limit {}", used, limit);
                }
            }
        }
    }
}

#[cfg(test)]
mod prepared_tests {
    use super::*;
    use proptest::prelude::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    // Frozen pre-refactor implementation: independent of the new in-place helper.
    fn original_roll_forward(
        window: &FlowWindow,
        ledger: u32,
        window_ledgers: u32,
    ) -> Result<FlowWindow, HyperionError> {
        let epoch = epoch_of(ledger, window_ledgers)?;
        if epoch == window.epoch {
            return Ok(window.clone());
        }
        if epoch == window.epoch.saturating_add(1) {
            return Ok(FlowWindow {
                epoch,
                consumed: 0,
                prev_consumed: window.consumed,
            });
        }
        Ok(FlowWindow {
            epoch,
            consumed: 0,
            prev_consumed: 0,
        })
    }

    fn compare(window: FlowWindow, limit: i128, ledger: u32, span: u32, seed: u128) {
        assert_eq!(
            roll_forward(&window, ledger, span),
            original_roll_forward(&window, ledger, span)
        );
        let reference = catch_unwind(|| available(&window, limit, ledger, span));
        let mut prepared = window.clone();
        let actual = catch_unwind(AssertUnwindSafe(|| {
            prepare_window(&mut prepared, limit, ledger, span)
        }));
        match (reference, actual) {
            (Err(_), Err(_)) => {}
            (Ok(expected), Ok(actual)) => {
                assert_eq!(actual, expected);
                if let Ok(headroom) = expected {
                    // The router reaches consume only after its positive amount
                    // has passed the route and destination headroom comparisons.
                    if headroom > 0 {
                        let amount = 1 + (seed % headroom as u128) as i128;
                        let expected = consume(&window, limit, amount, ledger, span);
                        let actual = consume_prepared(&mut prepared, limit, amount, headroom)
                            .map(|()| prepared);
                        assert_eq!(actual, expected);
                    }
                }
            }
            _ => panic!("prepared and reference arithmetic disagree on panic behavior"),
        }
    }

    #[test]
    fn prepared_signed_boundaries_and_epoch_saturation_match_reference() {
        for consumed in [i128::MIN, -1, 0, 1, i128::MAX] {
            for previous in [i128::MIN, -1, 0, 1, i128::MAX] {
                for limit in [-1, 0, 1, i128::MAX] {
                    for (epoch, ledger, span) in [
                        (0, 0, 0),
                        (0, 0, 1),
                        (0, 1, 1),
                        (0, 2, 1),
                        (u32::MAX, u32::MAX, 1),
                        (1, u32::MAX, u32::MAX),
                        (0, 17_280, 17_280),
                        (1, 17_281, 17_280),
                    ] {
                        for seed in [0, u128::MAX] {
                            compare(
                                FlowWindow {
                                    epoch,
                                    consumed,
                                    prev_consumed: previous,
                                },
                                limit,
                                ledger,
                                span,
                                seed,
                            );
                        }
                    }
                }
            }
        }
    }

    proptest! {
        #[test]
        fn prepared_full_width_window_and_spend_match_reference(
            consumed in any::<i128>(), previous in -1_000_000_000_000_000_000_000_000i128..=1_000_000_000_000_000_000_000_000i128,
            limit in 0i128..=i128::MAX, ledger in any::<u32>(), span in 1u32..=u32::MAX,
            epoch_offset in 0u32..4, seed in any::<u128>(),
        ) {
            let epoch = (ledger / span).saturating_sub(epoch_offset);
            compare(FlowWindow { epoch, consumed, prev_consumed: previous }, limit, ledger, span, seed);
        }
    }
}
