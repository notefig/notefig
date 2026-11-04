//! Scratchpads (MET-135): where nameless new files live. A port of
//! `modules/scratchpads/` (`scratchpads.ts` and `landing.ts`).
//!
//! "New File" creates a generated-name markdown file ("sunny-otter.md") in
//! the app-owned `.notefig/scratchpads/`; membership in that folder is what
//! makes a file a scratchpad. Opening a project lands in the most recent
//! one, after an entry-time sweep deletes abandoned empty ones. In every
//! other respect they are ordinary files.

mod names;
mod scratchpads;

pub use names::*;
pub use scratchpads::{ScratchpadsDeps, WorkspaceScratchpads, create_workspace_scratchpads};

use std::rc::Rc;

use futures::FutureExt;
use notefig_core::{Module, ModuleContext, ModuleRef, Subscription, WorkspaceEntered, WorkspacePart};
use notefig_files::FilesModule;
use notefig_files::paths::{normalize, workspace_key};
use notefig_kv::KvModule;
use notefig_layout::{LayoutModule, OpenFileIntent};
use notefig_tabs::{OpenTabOptions, TabsModule, is_file_tab_id};
use notefig_platform::PlatformService;
use notefig_workspaces::WorkspacesModule;

/// The settings namespace and the "scratchpad on startup" key.
pub const SETTINGS_NAMESPACE: &str = "settings";
pub const SCRATCHPAD_ON_STARTUP_KEY: &str = "scratchpadOnStartup";

/// `scratchpadsModule`.
pub struct ScratchpadsModule;

impl Module for ScratchpadsModule {
    const NAME: &'static str = "scratchpads";
    type Api = ();
    type Workspace = WorkspaceScratchpads;

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>(), ModuleRef::of::<TabsModule>(), ModuleRef::of::<KvModule>()]
    }

    fn register(_: &ModuleContext) {}

    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(
            WorkspacePart::new(|ctx, _| {
                let kv = ctx.use_::<KvModule>();
                let tabs = ctx.use_::<TabsModule>();
                Ok(create_workspace_scratchpads(ScratchpadsDeps {
                    workspace_path: normalize(&ctx.workspace().path),
                    files: (*ctx.use_workspace::<FilesModule>()).clone(),
                    fs: ctx.service::<PlatformService>().fs.clone(),
                    lands_on_startup: Rc::new(move || {
                        let read = kv.read::<bool>(SETTINGS_NAMESPACE, SCRATCHPAD_ON_STARTUP_KEY);
                        async move { read.await != Some(false) }.boxed_local()
                    }),
                    // Only once the tab is really in the dock does the
                    // gesture's hand-off apply.
                    open_tab: Rc::new(move |path| {
                        tabs.open(path, OpenTabOptions { intent: OpenFileIntent::Replace, handoff: true, ..Default::default() });
                    }),
                }))
            })
            .needs(vec![ModuleRef::of::<FilesModule>()]),
        )
    }
}

/// `scratchpadLandingModule`: entering a workspace with none of its files
/// open lands on its most recent scratchpad (or a fresh one); either way
/// the entry sweep runs. Only on `workspace:entered`: a boot restore or a
/// focus leaves the dock alone.
pub struct ScratchpadLandingModule;

impl Module for ScratchpadLandingModule {
    const NAME: &'static str = "scratchpad-landing";
    type Api = ();
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        // The registry's focus handler runs first: the workspace is in the
        // open set, its rows seeded, before anything lands in it.
        vec![ModuleRef::of::<LayoutModule>(), ModuleRef::of::<TabsModule>(), ModuleRef::of::<WorkspacesModule>(), ModuleRef::of::<ScratchpadsModule>()]
    }

    fn register(_: &ModuleContext) {}

    fn boot(_: &Rc<()>, ctx: &ModuleContext) -> Option<Subscription> {
        let layout = ctx.use_::<LayoutModule>();
        let registry = ctx.use_::<WorkspacesModule>();
        let tabs = ctx.use_::<TabsModule>();
        let ctx2 = ctx.clone();
        Some(ctx.hooks().on::<WorkspaceEntered, _>(move |ws| {
            let handle = ctx2.workspace_handle(&ws.path);
            let (layout, registry, tabs) = (layout.clone(), registry.clone(), tabs.clone());
            let path = ws.path.clone();
            async move {
                // Closed while the focus steps before this one ran.
                if !handle.is_open() {
                    return Ok(());
                }
                let scratchpads = handle.get::<ScratchpadsModule>()?;
                let open = layout.open_tab_ids();
                let key = workspace_key(&path);
                let has_file_tab = open.iter().any(|id| {
                    is_file_tab_id(id) && registry.workspace_of(id).is_some_and(|owner| workspace_key(&owner) == key)
                });
                if has_file_tab {
                    scratchpads.sweep(open).await;
                } else if let Some(pad) = scratchpads.enter(open).await {
                    tabs.open(&pad, OpenTabOptions { intent: OpenFileIntent::NewTab, ..Default::default() });
                }
                Ok(())
            }
            .boxed_local()
        }))
    }
}

#[cfg(test)]
mod tests;
