//! The `telemetry` module: a port of `packages/desktop/src/modules/telemetry/`
//! and the client it drives (`src/telemetry/telemetry.ts`).
//!
//! `core.use_::<TelemetryModule>()` says whether the first-run consent is
//! still owed and records the user's answer, in the `settings` kv namespace
//! with the TS keys. The client buffers events until consent resolves, then
//! filters them by tier, exactly as the TS one does.
//!
//! **Sends nothing.** The TS client loads posthog-js only in builds with a
//! key; this port has no key and no network sink, so
//! [`telemetry_available`] is `false`, the consent dialog is never owed, and
//! every event is dropped once consent resolves. A [`TelemetrySink`] can be
//! handed to [`create_telemetry_client`] (tests do), but the module never
//! hands one.

mod client;
mod telemetry;

pub use client::{
    TelemetryClient, TelemetryConsent, TelemetrySink, create_telemetry_client,
    telemetry_available,
};
pub use telemetry::{TelemetryAnswer, TelemetryApi, create_telemetry, new_install_id};

use notefig_core::{Module, ModuleContext, ModuleRef, Subscription};
use notefig_kv::KvModule;
use std::rc::Rc;

/// The kv namespace app settings live in (`SETTINGS_NAMESPACE` in
/// `hooks/use-app-settings.ts`).
pub const SETTINGS_NAMESPACE: &str = "settings";

/// Bumped when the telemetry policy changes enough that existing users
/// should be re-prompted. Consent is "answered" when the stored
/// `telemetryConsentVersion` is at least this.
pub const CURRENT_TELEMETRY_CONSENT_VERSION: u32 = 1;

/// `telemetryModule`.
pub struct TelemetryModule;

impl Module for TelemetryModule {
    const NAME: &'static str = "telemetry";
    type Api = TelemetryApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<KvModule>()]
    }

    fn register(ctx: &ModuleContext) -> TelemetryApi {
        // No sink: this port never sends (see the crate docs).
        create_telemetry(ctx.use_::<KvModule>(), create_telemetry_client(false, None), ctx.executor())
    }

    /// Configured from stored consent at boot, once.
    fn boot(api: &Rc<TelemetryApi>, _ctx: &ModuleContext) -> Option<Subscription> {
        api.start();
        None
    }
}

#[cfg(test)]
mod tests;
