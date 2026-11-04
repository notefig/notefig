//! Namespaced key-value storage over the platform's db: a port of
//! `packages/desktop/src/modules/kv/`. This module is the whole KV boundary,
//! as `core.use_::<KvModule>()`.
//!
//! This crate is also the pattern every module crate follows:
//! - the entity is built by a factory from what it is handed ([`create_kv`]),
//!   which is also what its tests build — no module mocks;
//! - the [`KvModule`] marker registers that factory with core, taking the
//!   platform from `ctx.service::<PlatformService>()`;
//! - state a view reads is observable (`subscribe` → [`Subscription`]);
//! - everything not `pub` here is the module's own.

mod kv;
mod persisted;

pub use kv::{KvApi, KvCollection, create_kv};
pub use persisted::PersistedCollection;

use notefig_core::{Module, ModuleContext, ModuleRef};
use notefig_platform::PlatformService;

/// `kvModule`.
pub struct KvModule;

impl Module for KvModule {
    const NAME: &'static str = "kv";
    type Api = KvApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>()]
    }

    fn register(ctx: &ModuleContext) -> KvApi {
        create_kv(ctx.service::<PlatformService>().db.clone())
    }
}

#[cfg(test)]
mod tests;
