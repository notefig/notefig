//! Workspaces: the open set and its lifetime (MET-177), a port of
//! `modules/workspaces/`. A workspace is open from first open until an
//! explicit close; the open set is persisted, so a restart restores every
//! workspace the user left open ([`RestoreWorkspacesModule`]). One of them
//! is focused: the most recent `focused_at`.
//!
//! `core.use_::<WorkspacesModule>()` is `core.workspaceRegistry`.

mod registry;

pub use registry::{OPEN_WORKSPACES_COLLECTION_ID, OpenWorkspaceRow, WorkspaceRegistry, create_workspace_registry, most_recently_focused, workspace_of_path_in};

use std::rc::Rc;

use futures::FutureExt;
use notefig_core::{Module, ModuleContext, ModuleRef, Subscription, WorkspaceClosing, WorkspaceFocused};
use notefig_platform::PlatformService;

/// `workspacesModule` (named "workspaceRegistry", as in TS): persists what
/// core opens through a handle, and drops it when core closes it.
pub struct WorkspacesModule;

impl Module for WorkspacesModule {
    const NAME: &'static str = "workspaceRegistry";
    type Api = WorkspaceRegistry;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>()]
    }

    fn register(ctx: &ModuleContext) -> WorkspaceRegistry {
        create_workspace_registry(ctx.service::<PlatformService>().db.clone(), ctx.executor(), Rc::new(registry::now_ms))
    }

    fn boot(registry: &Rc<WorkspaceRegistry>, ctx: &ModuleContext) -> Option<Subscription> {
        let mirror = registry.mirror(ctx.workspaces());
        let r = registry.clone();
        let focus = ctx.hooks().on::<WorkspaceFocused, _>(move |ws| {
            let done = r.record_focus(&ws.path);
            async move { done.await }.boxed_local()
        });
        // Synchronously, first thing in the close: the switcher row goes.
        let r = registry.clone();
        let closing = ctx.hooks().on::<WorkspaceClosing, _>(move |ws| r.forget(&ws.key));
        Some(Subscription::join(vec![mirror, focus, closing]))
    }
}

/// `restoreWorkspacesModule`: reopen the workspaces the user left open.
/// The desktop root lists it; a root that seeds its own workspace does not.
pub struct RestoreWorkspacesModule;

impl Module for RestoreWorkspacesModule {
    const NAME: &'static str = "restore-workspaces";
    type Api = ();
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<WorkspacesModule>()]
    }

    fn register(_: &ModuleContext) {}

    fn boot(_: &Rc<()>, ctx: &ModuleContext) -> Option<Subscription> {
        let restore = ctx.use_::<WorkspacesModule>().restore();
        ctx.executor().spawn(restore);
        None
    }
}

#[cfg(test)]
mod tests;
