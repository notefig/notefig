//! Notefig's kernel: module registration, boot order, workspace lifetime and
//! hooks — a port of `@notefig/core` (`packages/core`). No GPUI: modules
//! built on it run in the app, in tests over fakes, and later on the web.
//!
//! The shape follows the TS core one to one:
//! - [`Module`] is `defineModule`; [`Service`] is `defineService`.
//! - [`Core::new`] is `createCore`: it orders modules by `needs`, then
//!   registers every API. [`Core::boot`] runs each `boot`.
//! - [`Core::workspace`] hands a [`WorkspaceHandle`]: `open`, `focus`,
//!   `close`, and `get::<M>()` for a module's per-workspace instance.
//! - [`Hooks`] is the one event bus; a module declares its moments as
//!   [`Hook`] types.

mod context;
mod core;
mod executor;
mod hooks;
mod module;
mod order;
mod subscription;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
#[cfg(test)]
mod tests;

pub use crate::context::{ModuleContext, WorkspaceContext};
pub use crate::core::{
    Core, CoreBooted, CoreShutdown, CreateCoreOptions, OpenWorkspaces, WorkspaceClosedError,
    WorkspaceClosing, WorkspaceEntered, WorkspaceFocused, WorkspaceHandle, WorkspaceLifecycle,
    WorkspaceOpenError, WorkspaceOpened,
};
pub use crate::executor::{Executor, ExecutorExt};
pub use crate::hooks::{Hook, HookResult, Hooks};
pub use crate::module::{Module, ModuleRef, Service, Services, WorkspacePart};
pub use crate::subscription::{Listeners, Subscription};

pub use futures;

/// A workspace as core tracks it: `key` identifies it, `path` is native.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkspaceRef {
    pub key: String,
    pub path: String,
}

/// A configuration error: fails startup, naming the module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreConfigError(pub String);

impl std::fmt::Display for CoreConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CoreConfigError {}
