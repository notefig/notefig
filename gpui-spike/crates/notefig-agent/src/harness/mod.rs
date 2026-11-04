//! Harness registry: definitions, overrides, custom entries and install
//! discovery (`packages/shared/src/agent/harness-config.ts`). The
//! per-harness adapters live in `notefig-harness-adapters`.

pub mod config;
pub mod discovery;

pub use config::*;
