//! The `sidebar-view` module: a port of
//! `packages/desktop/src/modules/sidebar-view/`. The `?sidebarView` param —
//! which view the sidebar shows — and [`SidebarViewModule`], which moves a
//! sidebar on the Everything view to the files of a workspace the user
//! enters. [`LastToolModule`] is `core.workspace(ws).lastTool`: the tool a
//! workspace was last on, so returning to it from the rail lands there.

use std::cell::Cell;
use std::rc::Rc;

use notefig_core::{Module, ModuleContext, ModuleRef, Subscription, WorkspaceEntered, WorkspacePart};
use notefig_layout::{SearchParams, UrlService, UrlState};

/// `WorkspaceTool`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WorkspaceTool {
    Files,
    Search,
    Git,
    Sessions,
}

/// `WORKSPACE_TOOLS`, in tab order.
pub const WORKSPACE_TOOLS: [WorkspaceTool; 4] =
    [WorkspaceTool::Files, WorkspaceTool::Search, WorkspaceTool::Git, WorkspaceTool::Sessions];

impl WorkspaceTool {
    pub fn key(self) -> &'static str {
        match self {
            WorkspaceTool::Files => "files",
            WorkspaceTool::Search => "search",
            WorkspaceTool::Git => "git",
            WorkspaceTool::Sessions => "sessions",
        }
    }
    /// The tab's label (`TOOL_LABEL_KEYS`, English).
    pub fn label(self) -> &'static str {
        match self {
            WorkspaceTool::Files => "Files",
            WorkspaceTool::Search => "Search",
            WorkspaceTool::Git => "Git",
            WorkspaceTool::Sessions => "Sessions",
        }
    }
    /// The Lucide icon (`TOOL_ICONS`).
    pub fn icon(self) -> &'static str {
        match self {
            WorkspaceTool::Files => "file-text",
            WorkspaceTool::Search => "search",
            WorkspaceTool::Git => "git-branch",
            WorkspaceTool::Sessions => "sparkles",
        }
    }
}

/// `SidebarView`: the Everything overview, or one workspace tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SidebarView {
    Everything,
    Tool(WorkspaceTool),
}

pub const SIDEBAR_VIEW_PARAM: &str = "sidebarView";
/// The `?sidebar` param: present (`closed`) while the sidebar is collapsed.
pub const SIDEBAR_COLLAPSED_PARAM: &str = "sidebar";

fn parse_view(value: Option<&str>) -> SidebarView {
    match value {
        Some(v) => WORKSPACE_TOOLS
            .iter()
            .find(|t| t.key() == v)
            .map(|t| SidebarView::Tool(*t))
            .unwrap_or(SidebarView::Everything),
        None => SidebarView::Everything,
    }
}

/// The view the URL names, defaulting past anything unrecognised.
pub fn read_sidebar_view(params: &SearchParams) -> SidebarView {
    parse_view(params.get(SIDEBAR_VIEW_PARAM))
}

/// Name `view` in the params (the default view is the absent param) and
/// expand the sidebar to show it.
pub fn with_sidebar_view(prev: &SearchParams, view: SidebarView) -> SearchParams {
    let mut next = prev.clone();
    match view {
        SidebarView::Everything => next.delete(SIDEBAR_VIEW_PARAM),
        SidebarView::Tool(t) => next.set(SIDEBAR_VIEW_PARAM, t.key()),
    }
    next.delete(SIDEBAR_COLLAPSED_PARAM);
    next
}

/// `sidebarViewModule`: entering a workspace from the Everything view moves
/// the sidebar to that workspace's files; a sidebar on a tool stays.
pub struct SidebarViewModule;

impl Module for SidebarViewModule {
    const NAME: &'static str = "sidebar-view";
    type Api = ();
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<UrlService>()]
    }

    fn register(_: &ModuleContext) {}

    fn boot(_: &Rc<()>, ctx: &ModuleContext) -> Option<Subscription> {
        let url: Rc<dyn UrlState> = ctx.service::<UrlService>();
        Some(ctx.hooks().on::<WorkspaceEntered, _>(move |_| {
            let live = SearchParams::parse(&url.search());
            if read_sidebar_view(&live) != SidebarView::Everything {
                return;
            }
            url.set_search(&with_sidebar_view(&live, SidebarView::Tool(WorkspaceTool::Files)).to_search(), true);
        }))
    }
}

/// `LastTool`: the tool a workspace was last using.
pub struct LastTool {
    tool: Cell<WorkspaceTool>,
}

impl LastTool {
    pub fn get(&self) -> WorkspaceTool {
        self.tool.get()
    }
    pub fn set(&self, tool: WorkspaceTool) {
        self.tool.set(tool);
    }
}

/// `lastToolModule`.
pub struct LastToolModule;

impl Module for LastToolModule {
    const NAME: &'static str = "lastTool";
    type Api = ();
    type Workspace = LastTool;

    fn register(_: &ModuleContext) {}

    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(WorkspacePart::new(|_, _| Ok(LastTool { tool: Cell::new(WorkspaceTool::Files) })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_core::testing::TestExecutor;
    use notefig_core::{Core, CreateCoreOptions, Services};
    use notefig_layout::MemoryUrl;

    #[test]
    fn reads_and_writes_the_param() {
        assert_eq!(read_sidebar_view(&SearchParams::parse("")), SidebarView::Everything);
        assert_eq!(read_sidebar_view(&SearchParams::parse("?sidebarView=git")), SidebarView::Tool(WorkspaceTool::Git));
        assert_eq!(read_sidebar_view(&SearchParams::parse("?sidebarView=bogus")), SidebarView::Everything);
        let next = with_sidebar_view(&SearchParams::parse("?sidebar=closed&x=1"), SidebarView::Tool(WorkspaceTool::Search));
        assert_eq!(next.to_search(), "?x=1&sidebarView=search");
        assert_eq!(with_sidebar_view(&next, SidebarView::Everything).to_search(), "?x=1");
    }

    fn core_over(search: &str) -> (Rc<TestExecutor>, Rc<MemoryUrl>, Core) {
        let exec = TestExecutor::new();
        let url = MemoryUrl::new(search);
        let core = Core::new(
            CreateCoreOptions::new(exec.clone())
                .services(Services::new().with::<UrlService>(url.clone() as Rc<dyn UrlState>))
                .modules(vec![ModuleRef::of::<SidebarViewModule>(), ModuleRef::of::<LastToolModule>()]),
        )
        .unwrap();
        core.boot();
        (exec, url, core)
    }

    #[test]
    fn entering_a_workspace_from_everything_shows_its_files() {
        let (exec, url, core) = core_over("");
        exec.block_on(core.workspace("/ws").open()).unwrap();
        assert_eq!(url.search(), "?sidebarView=files");
        assert_eq!(core.workspace("/ws").get::<LastToolModule>().unwrap().get(), WorkspaceTool::Files);
    }

    #[test]
    fn a_sidebar_on_a_tool_stays_on_it() {
        let (exec, url, core) = core_over("?sidebarView=git");
        exec.block_on(core.workspace("/ws").open()).unwrap();
        assert_eq!(url.search(), "?sidebarView=git");
    }
}
