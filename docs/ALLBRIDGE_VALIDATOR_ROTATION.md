# Allbridge Delayed Validator Rotation and Explicit Epochs

## Overview

Allbridge Core on Soroban is a development-only adapter with a configured-validator trust model and
native gas float. The active Hyperion deployment remains Stellar Testnet outbound ITS and CCTP; EVM
and pooled-rail inbound flows remain explicitly gated until independently validated.

Previously, `AllbridgeAdapter::set_validator` immediately overwrote the live Ed25519 validator key
with no timelock, no epoch counter, and no emergency kill switch. If an attestation key was rotated
and later re-used or compromised, undated signatures had no epoch boundary separating old and new
authorization periods.

## Epoch-Bound Signing and Reviewed Rotation

1. **One-Shot Bootstrap (`epoch = 1`):**
   - `set_validator(validator)` initializes `ValidatorState` at `epoch = 1` (rejecting the all-zero
     key with `HyperionError::ZeroAddressKey`).
   - Once `epoch >= 1`, calling `set_validator` again returns `HyperionError::AlreadyConfigured`.
2. **Delayed Rotation Queue (`epoch + 1`):**
   - `set_trust_change_delay(delay_seconds)` configures the rotation wait window within
     `[MIN_TRUST_CHANGE_DELAY (3,600s), MAX_TRUST_CHANGE_DELAY (604,800s)]` (default `86,400s`).
     Delay updates are refused while a rotation is pending so an active countdown cannot be
     shortened retroactively.
   - `queue_validator_rotation(next_validator)` schedules `PendingValidatorRotation` for
     `current_epoch + 1` with `eta = now + delay` and `expires_at = eta + ROTATION_GRACE_PERIOD`
     (`172,800s`).
   - `execute_validator_rotation()` enforces `eta <= now <= expires_at` (`TimelockNotReady` /
     `TimelockExpired`) before activating `next_validator` at `next_epoch`.
   - `cancel_validator_rotation()` clears an unexecuted queued rotation (`TimelockNotQueued` if
     none exists).
3. **Epoch-Bound Signatures:**
   - `rail::hash_epoch_message` hashes `EPOCH_SIGNING_DOMAIN ("HYPERION_ALLBRIDGE_VALIDATOR_EPOCH_V1") || adapter_key || validator_epoch || message_id`.
   - `bridge_in`, `receive`, and `bridge_in_at_epoch` verify Ed25519 signatures exclusively over
     this epoch-bound digest (`epoch_signing_digest` view). Old signatures from epoch `N` cannot be
     reinterpreted under epoch `N + 1`, even if the same validator key is rotated back in at a
     later epoch.
4. **Emergency Validator Disable:**
   - `emergency_disable_validator()` immediately flips `emergency_disabled = true` and clears any
     queued rotation, causing all subsequent `bridge_in` / `receive` / `bridge_in_at_epoch` calls
     to fail with `HyperionError::RouteDisabled`.
   - Deliveries already forwarded and parked as `PendingClaim` entries on `HyperionRouter` live in
     router storage and remain 100% settleable via `HyperionRouter::settle_claim`.
   - Re-enabling inbound acceptance after an emergency disable requires queueing and waiting out a
     reviewed `queue_validator_rotation` into a new epoch.
