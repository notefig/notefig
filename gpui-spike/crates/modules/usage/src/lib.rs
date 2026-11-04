//! Usage — what agent turns have spent, kept as an hourly time series, and
//! where each harness account last stood against its limits: a port of
//! `packages/desktop/src/modules/usage/`.
//!
//! The agent subsystem keeps each session's own total on its task row; this
//! module keeps what outlives a session: one bucket per UTC hour, harness
//! and workspace, models inside it. It hears turns only through
//! `"agent:usage"` (harness quirks already resolved), so it never reaches
//! the agent runtime, and deleting a session never touches its history.
//!
//! Every bucket is a `UsageSummary`, kept by the same `add_turn` as the task
//! row's session total, so the levels add up the same way.
//!
//! [`series`] holds the pure views over buckets (per period, the average
//! day, tokens by weekday) — `series.ts`; a view reads the buckets of its
//! range with [`UsageApi::buckets_in`] and groups them there.
//!
//! History only grows, so buckets load on demand, as TS's on-demand
//! collection: nothing at boot; each view's hour range with
//! [`UsageApi::load_buckets`] (the platform db's `load_range`, a SQL
//! filter on `hour` in SQLite), and a write reads just its hour.

pub mod series;
mod usage;

pub use usage::{
    HarnessLimits, USAGE_BUCKETS_COLLECTION_ID, USAGE_LIMITS_COLLECTION_ID, UsageApi, UsageBucket, UsageDeps,
    create_usage, merge_limits, start_of_hour,
};

use std::rc::Rc;

use notefig_core::{Module, ModuleContext, ModuleRef, Subscription};
use notefig_platform::PlatformService;

/// `usageModule`: turns' usage, kept per hour beyond the sessions that
/// spent it.
///
/// TS also needs `harnessAdaptersModule` (the views read what each harness
/// reports); that dependency moves to the view, which asks the harness
/// adapters itself, until `crates/modules/harness-adapters` is ported.
pub struct UsageModule;

impl Module for UsageModule {
    const NAME: &'static str = "usage";
    type Api = UsageApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>()]
    }

    fn register(ctx: &ModuleContext) -> UsageApi {
        create_usage(UsageDeps {
            db: ctx.service::<PlatformService>().db.clone(),
            hooks: ctx.hooks().clone(),
            executor: ctx.executor(),
        })
    }

    fn boot(api: &Rc<UsageApi>, _: &ModuleContext) -> Option<Subscription> {
        Some(api.track())
    }
}

#[cfg(test)]
mod tests;
