//! The `diff-blocks` module: a port of
//! `packages/desktop/src/modules/diff-blocks/`. Diff fences (a `ts diff`
//! code fence) draw as diff cards wherever rendered markdown holds one; what only
//! the app knows — which workspace file a block's path names, and how to
//! open it — is this module's [`DiffBlocksApi::resolve_file`]. TS defines a
//! custom element with this host; here the markdown renderers call the API.
//!
//! Divergence: TS resolves the owning workspace with the workspaces
//! registry and checks the files module's metadata row is a file. Until
//! those crates land, the owner is the deepest open workspace containing
//! the path, and any path is taken to be a file.

use std::rc::Rc;

use notefig_core::{Module, ModuleContext, ModuleRef, WorkspaceLifecycle};
use notefig_editors::is_in_tree;
use notefig_layout::OpenFileIntent;
use notefig_tabs::{OpenTabOptions, TabsApi, TabsModule};

/// `DiffFile`: what a diff card's header shows and does.
pub struct DiffFile {
    /// The path relative to its workspace (or as written).
    pub label: String,
    /// Opens the file as a new tab; `None` when it is not a workspace file.
    pub open: Option<Rc<dyn Fn()>>,
}

/// `core["diff-blocks"]`.
pub struct DiffBlocksApi {
    tabs: Rc<TabsApi>,
    workspaces: WorkspaceLifecycle,
}

impl DiffBlocksApi {
    /// The workspace file a diff block's `path` names (absolute, or
    /// relative to `workspace_path`).
    pub fn resolve_file(&self, workspace_path: Option<&str>, path: &str) -> DiffFile {
        let native = path.replace('/', std::path::MAIN_SEPARATOR_STR);
        let absolute = if std::path::Path::new(&native).is_absolute() {
            Some(native)
        } else {
            workspace_path.map(|ws| std::path::Path::new(ws).join(&native).to_string_lossy().into_owned())
        };
        let Some(absolute) = absolute else { return DiffFile { label: path.into(), open: None } };
        let owner = self
            .workspaces
            .list()
            .into_iter()
            .map(|w| w.path)
            .filter(|ws| is_in_tree(ws, &absolute))
            .max_by_key(|ws| ws.len());
        let Some(owner) = owner else { return DiffFile { label: path.into(), open: None } };
        let label = absolute[owner.len()..].trim_start_matches(['/', '\\']).replace('\\', "/");
        let tabs = self.tabs.clone();
        DiffFile {
            label,
            open: Some(Rc::new(move || {
                tabs.open(&absolute, OpenTabOptions { intent: OpenFileIntent::NewTab, ..Default::default() });
            })),
        }
    }
}

/// `diffBlocksModule`.
pub struct DiffBlocksModule;

impl Module for DiffBlocksModule {
    const NAME: &'static str = "diff-blocks";
    type Api = DiffBlocksApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<TabsModule>()]
    }

    fn register(ctx: &ModuleContext) -> DiffBlocksApi {
        DiffBlocksApi { tabs: ctx.use_::<TabsModule>(), workspaces: ctx.workspaces() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_core::testing::TestExecutor;
    use notefig_core::{Core, CreateCoreOptions, Services};
    use notefig_layout::{MemoryUrl, UrlService, UrlState};
    use notefig_platform::PlatformService;
    use notefig_platform::fake::FakePlatform;

    #[test]
    fn resolves_a_relative_path_to_a_workspace_file_that_opens_as_a_tab() {
        let exec = TestExecutor::new();
        let fake = FakePlatform::new();
        let url = MemoryUrl::new("");
        let core = Core::new(
            CreateCoreOptions::new(exec.clone())
                .services(
                    Services::new()
                        .with::<PlatformService>(fake.platform.clone())
                        .with::<UrlService>(url.clone() as Rc<dyn UrlState>),
                )
                .modules(vec![ModuleRef::of::<DiffBlocksModule>()]),
        )
        .unwrap();
        core.boot();
        exec.block_on(core.workspace("/ws").open()).unwrap();
        let api = core.use_::<DiffBlocksModule>();
        let f = api.resolve_file(Some("/ws"), "docs/a.md");
        assert_eq!(f.label, "docs/a.md");
        (f.open.unwrap())();
        assert_eq!(core.use_::<TabsModule>().layout().open_tab_ids(), ["/ws/docs/a.md"]);
        assert!(api.resolve_file(None, "/elsewhere/x.md").open.is_none());
    }
}
