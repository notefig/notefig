//! `PlatformUpdater` lives on the platform (`platform.updates`); re-exported
//! here so the updater's users keep one import.

pub use notefig_platform::updates::{
    NoopUpdater, PlatformUpdater, UpdateApplyProgress, UpdateCheckResult, UpdateFlow, UpdateRestartResult,
};
