// The one shared copy of the capability snapshot grammar, compiled into each crate's tests.
#[path = "../../../../test-support/capability.rs"]
mod capability;

mod doubles;
mod hostile;
mod setup;

mod admin;
mod benchmarks;
mod capabilities;
mod codec_parity;
mod discovery;
mod event_codec_parity;
mod event_fixtures;
mod hostile_boundaries;
mod inbound;
mod maintenance;
mod operations;
mod outbound;
mod quotes;
mod stateful_model;
mod storage_maintenance;
mod trust_surface;

use hyperion_core::{FaultStage, ProviderFaultController};

/// Fixture-only controller shared by stateful Soroban rehearsals.
///
/// Keeping the seed and attempt counters here makes a failing dispatch/inbound sequence
/// replayable without introducing fault state into the deployed router.
pub(crate) struct ProviderFaultFixture {
    controller: ProviderFaultController,
}

impl ProviderFaultFixture {
    pub(crate) fn from_seed(seed: u64) -> Self {
        Self {
            controller: ProviderFaultController::from_seed(seed),
        }
    }

    pub(crate) fn before_dispatch(&mut self) -> bool {
        self.controller.next(FaultStage::Dispatch)
    }

    pub(crate) fn before_inbound(&mut self) -> bool {
        self.controller.next(FaultStage::Inbound)
    }

    pub(crate) fn reset(&mut self) {
        self.controller.reset();
    }
}

mod outbound_policy_regression;
