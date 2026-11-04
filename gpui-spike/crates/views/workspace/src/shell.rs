//! `WorkspaceShell` (workspace.tsx): the sidebar showing the focused
//! workspace, the dock over every open workspace's tabs, the status bar
//! pinned to the window's corner, and the overlays.

use gpui::{
    AnyView, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, ParentElement,
    Render, Styled, Window, div, prelude::FluentBuilder as _,
};
use notefig_core::Subscription;
use notefig_layout::{DockAction, LayoutApi, SearchParams, SplitDirection, reduce, windows};
use notefig_sidebar_view::{
    SIDEBAR_COLLAPSED_PARAM, SidebarView, WorkspaceTool, read_sidebar_view, with_sidebar_view, LastToolModule,
};
use notefig_tabs::{TabsModule, WindowStep};
use notefig_ui::{CoreExt as _, observe, tokens};
use std::rc::Rc;

use crate::dialogs::CloseWorkspaceDialog;
use crate::dock::DockView;
use crate::sidebar::Sidebar;
use crate::status_bar::StatusBar;
use crate::*;

pub struct WorkspaceShell {
    workspace_path: String,
    sidebar: Entity<Sidebar>,
    dock: Entity<DockView>,
    status: Entity<StatusBar>,
    close_dialog: Entity<CloseWorkspaceDialog>,
    overlays: Vec<AnyView>,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

/// The URL the shell's chrome state lives in.
pub(crate) fn url_params(layout: &LayoutApi) -> SearchParams {
    SearchParams::parse(&layout.url().search())
}

pub(crate) fn set_url_params(layout: &LayoutApi, params: &SearchParams, replace: bool) {
    layout.url().set_search(&params.to_search(), replace);
}

/// Whether the sidebar is collapsed (`?sidebar=closed`).
pub(crate) fn sidebar_collapsed(layout: &LayoutApi) -> bool {
    url_params(layout).get(SIDEBAR_COLLAPSED_PARAM).is_some()
}

/// Show a sidebar view (`showSidebarView`), remembering the tool per
/// workspace (`lastTool`).
pub(crate) fn show_view(view: SidebarView, workspace_path: &str, cx: &mut gpui::App) {
    let core = cx.core();
    let layout = core.use_::<TabsModule>().layout().clone();
    let params = with_sidebar_view(&url_params(&layout), view);
    set_url_params(&layout, &params, false);
    if let SidebarView::Tool(tool) = view
        && let Ok(last) = core.workspace(workspace_path).get::<LastToolModule>()
    {
        last.set(tool);
    }
}

/// The live shell, for actions dispatched where the shell's element is not
/// on the dispatch path (the command palette lives in the kit's overlay
/// layer, so its `workspace::*` actions bubble to the app, not the shell).
struct LiveShell(gpui::WeakEntity<WorkspaceShell>, gpui::AnyWindowHandle);
impl gpui::Global for LiveShell {}

/// Run `f` on the live shell in its window.
fn with_shell(cx: &mut gpui::App, f: impl FnOnce(&mut WorkspaceShell, &mut Window, &mut Context<WorkspaceShell>) + 'static) {
    let Some(LiveShell(shell, window)) = cx.try_global::<LiveShell>().map(|g| LiveShell(g.0.clone(), g.1)) else { return };
    // On the next frame: the dispatching view (the palette) is mid-update,
    // and closing restores focus, which would blur an inline field the
    // action opens.
    cx.defer(move |cx| {
        let _ = window.update(cx, |_, window, _| {
            window.on_next_frame(move |window, cx| {
                let _ = shell.update(cx, |s, cx| f(s, window, cx));
            });
            window.refresh();
        });
    });
}

/// App-level handlers for every `workspace::*` action, so one dispatched
/// from outside the shell's element (the palette, a menu) still lands.
/// The shell's own element handlers take precedence when it is focused.
pub(crate) fn init_global_actions(cx: &mut gpui::App) {
    cx.on_action(|_: &ToggleSidebar, cx| with_shell(cx, |s, _, cx| s.toggle_sidebar(cx)));
    cx.on_action(|_: &CloseTab, cx| {
        let tabs = cx.core().use_::<TabsModule>();
        if let Some(tab) = tabs.active_tab_id() {
            tabs.close(&tab);
        }
    });
    cx.on_action(|_: &NewScratchpad, cx| with_shell(cx, |s, _, cx| s.new_scratchpad(cx)));
    cx.on_action(|_: &NewFile, cx| with_shell(cx, |s, w, cx| s.start_create(false, w, cx)));
    cx.on_action(|_: &NewFolder, cx| with_shell(cx, |s, w, cx| s.start_create(true, w, cx)));
    cx.on_action(|_: &SearchInFile, cx| with_shell(cx, |s, w, cx| s.open_search(true, w, cx)));
    cx.on_action(|_: &SearchInFiles, cx| with_shell(cx, |s, w, cx| s.open_search(false, w, cx)));
    cx.on_action(|_: &Undo, cx| run_history(false, cx));
    cx.on_action(|_: &Redo, cx| run_history(true, cx));
    cx.on_action(|a: &OpenFile, cx| {
        cx.core().use_::<TabsModule>().open(&a.path, Default::default());
    });
    cx.on_action(|_: &OpenReleaseNotes, cx| {
        cx.core().use_::<TabsModule>().open(
            notefig_tabs::RELEASE_NOTES_TAB_ID,
            notefig_tabs::OpenTabOptions { intent: notefig_tabs::OpenFileIntent::NewTab, ..Default::default() },
        );
    });
    cx.on_action(|_: &OpenFolder, cx| crate::root::open_folder(cx));
    cx.on_action(|_: &CloseWorkspace, cx| {
        with_shell(cx, |s, w, cx| {
            let ws = s.workspace_path.clone();
            crate::dialogs::request_close_workspace(&ws, w, cx);
        })
    });
    cx.on_action(|a: &SetTextDirection, cx| {
        let dir = a.direction.clone();
        with_shell(cx, move |s, _, cx| s.set_direction(&dir, cx))
    });
    for (tool, f) in [
        (Some(WorkspaceTool::Files), 0),
        (Some(WorkspaceTool::Search), 1),
        (Some(WorkspaceTool::Git), 2),
        (Some(WorkspaceTool::Sessions), 3),
        (None, 4),
    ] {
        let view = tool.map(SidebarView::Tool).unwrap_or(SidebarView::Everything);
        let show = move |cx: &mut gpui::App| with_shell(cx, move |s, _, cx| show_view(view, &s.workspace_path, cx));
        match f {
            0 => cx.on_action(move |_: &ShowFiles, cx| show(cx)),
            1 => cx.on_action(move |_: &ShowSearch, cx| show(cx)),
            2 => cx.on_action(move |_: &ShowGit, cx| show(cx)),
            3 => cx.on_action(move |_: &ShowSessions, cx| show(cx)),
            _ => cx.on_action(move |_: &ShowEverything, cx| show(cx)),
        };
    }
}

impl WorkspaceShell {
    /// Persist the workspace's text direction (TS project settings).
    /// GPUI lays text left to right regardless (no RTL layout yet).
    fn set_direction(&mut self, direction: &str, cx: &mut Context<Self>) {
        let api = cx.core().use_::<notefig_project_settings::ProjectSettingsModule>();
        let mut patch = notefig_project_settings::ProjectSettings::new();
        patch.insert("settings".into(), serde_json::json!({ "direction": direction }));
        let fut = api.update(&self.workspace_path, patch);
        cx.foreground_executor().spawn(async move { let _ = fut.await; }).detach();
    }

    pub fn new(workspace_path: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let live = LiveShell(cx.entity().downgrade(), window.window_handle());
        cx.set_global(live);
        let core = cx.core();
        let tabs = core.use_::<TabsModule>();
        let t = tabs.clone();
        let sub = observe(cx, move |notify| t.layout().url().subscribe(Box::new(move || notify())));
        let settings = core.use_::<notefig_project_settings::ProjectSettingsModule>();
        let sub_dir = observe(cx, move |notify| settings.subscribe(move || notify()));
        let mut overlays = Vec::new();
        for ctor in panels(cx).overlays {
            overlays.push(ctor(window, cx));
        }
        let path = workspace_path.to_string();
        // Actions dispatch along the focus path: the shell must be on it.
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            sidebar: cx.new(|cx| Sidebar::new(&path, window, cx)),
            dock: cx.new(|cx| DockView::new(&path, window, cx)),
            status: cx.new(|cx| StatusBar::new(window, cx)),
            close_dialog: cx.new(|cx| CloseWorkspaceDialog::new(window, cx)),
            overlays,
            focus,
            workspace_path: path,
            _subs: vec![sub, sub_dir],
        }
    }

    pub fn set_workspace(&mut self, path: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.workspace_path == path {
            return;
        }
        self.workspace_path = path.to_string();
        self.sidebar.update(cx, |s, cx| s.set_workspace(path, window, cx));
        self.dock.update(cx, |d, _| d.set_workspace(path));
    }

    fn layout(&self, cx: &gpui::App) -> Rc<LayoutApi> {
        cx.core().use_::<TabsModule>().layout().clone()
    }

    fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        let layout = self.layout(cx);
        let mut params = url_params(&layout);
        if params.get(SIDEBAR_COLLAPSED_PARAM).is_some() {
            params.delete(SIDEBAR_COLLAPSED_PARAM);
        } else {
            params.set(SIDEBAR_COLLAPSED_PARAM, "closed");
        }
        set_url_params(&layout, &params, false);
        cx.notify();
    }

    fn split_active(&mut self, direction: SplitDirection, cx: &mut Context<Self>) {
        let tabs = cx.core().use_::<TabsModule>();
        let Some(tab) = tabs.active_tab_id() else { return };
        let Some(window_id) = tabs.active_window_id() else { return };
        let layout = tabs.layout().read();
        let Some((address, orientation)) = crate::dock::address_of_window(&layout, &window_id) else { return };
        let next = reduce(
            &layout,
            DockAction::SplitWindow {
                tab_id: tab,
                source_window_address: address.clone(),
                target_window_address: address,
                direction,
                orientation,
            },
        );
        tabs.apply_layout(next);
    }

    fn step_tab(&mut self, forward: bool, cx: &mut Context<Self>) {
        let tabs = cx.core().use_::<TabsModule>();
        let list = tabs.active_window_tabs();
        let Some(active) = tabs.active_tab_id() else { return };
        let Some(i) = list.iter().position(|t| *t == active) else { return };
        let n = list.len();
        let next = if forward { (i + 1) % n } else { (i + n - 1) % n };
        tabs.select(&list[next]);
    }
}

/// Whether a workspace's text direction is right-to-left (project settings
/// `settings.direction`).
pub(crate) fn is_rtl(workspace_path: &str, cx: &gpui::App) -> bool {
    cx.core().use_::<notefig_project_settings::ProjectSettingsModule>().settings(workspace_path).direction
        == notefig_project_settings::Direction::Rtl
}

/// Undo or redo in the active tab (`runHistoryAction`).
fn run_history(redo: bool, cx: &mut gpui::App) {
    let tabs = cx.core().use_::<TabsModule>();
    if let Some(tab) = tabs.active_tab_id() {
        tabs.controllers().run_history(&tab, redo);
    }
}

impl WorkspaceShell {
    /// `handleNewScratchpad`.
    fn new_scratchpad(&mut self, cx: &mut Context<Self>) {
        if let Ok(pads) = cx.core().workspace(&self.workspace_path).get::<notefig_scratchpads::ScratchpadsModule>() {
            cx.foreground_executor().spawn(pads.create_and_open()).detach();
        }
    }

    /// New File / New Folder: show the Files tool, then its inline naming
    /// at the workspace root (`fileTreeMode = creating`).
    fn start_create(&mut self, is_dir: bool, window: &mut Window, cx: &mut Context<Self>) {
        show_view(SidebarView::Tool(WorkspaceTool::Files), &self.workspace_path, cx);
        let view = self.sidebar.update(cx, |s, cx| s.tool_view(WorkspaceTool::Files, window, cx));
        if let Some(start) = panels(cx).files_start_create {
            // The tree's parent is tree-relative: "" is the workspace root.
            start(&view, "", is_dir, window, cx);
        }
    }

    /// Search in the active file (`in_file`) or in every file, seeded with
    /// the selection (`openSearchPanel`).
    fn open_search(&mut self, in_file: bool, window: &mut Window, cx: &mut Context<Self>) {
        let tabs = cx.core().use_::<TabsModule>();
        let active = tabs.active_tab_id();
        let selected = active.as_deref().and_then(|t| tabs.controllers().selected_text(t)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let pattern = if in_file {
            notefig_tabs::file_tab_path(active.as_deref()).and_then(|p| std::path::Path::new(p).file_name()).map(|n| n.to_string_lossy().into_owned())
        } else {
            None
        };
        show_view(SidebarView::Tool(WorkspaceTool::Search), &self.workspace_path, cx);
        let view = self.sidebar.update(cx, |s, cx| s.tool_view(WorkspaceTool::Search, window, cx));
        if let Some(focus) = panels(cx).search_focus {
            focus(&view, pattern.as_deref(), selected.as_deref(), window, cx);
        }
    }
}

impl Focusable for WorkspaceShell {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for WorkspaceShell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let layout = self.layout(cx);
        let collapsed = sidebar_collapsed(&layout);
        let view = read_sidebar_view(&url_params(&layout));
        let ws = self.workspace_path.clone();
        self.dock.update(cx, |d, _| d.set_sidebar_collapsed(collapsed));
        // `dir={direction}` on the shell root: RTL mirrors the layout.
        let rtl = is_rtl(&self.workspace_path, cx);
        self.dock.update(cx, |d, _| d.set_rtl(rtl));
        self.sidebar.update(cx, |s, _| s.set_rtl(rtl));
        self.status.update(cx, |s, _| s.set_rtl(rtl));
        let _ = view;
        div()
            .id("workspace-shell")
            .key_context("Workspace")
            .track_focus(&self.focus)
            .relative()
            .flex()
            .size_full()
            .overflow_hidden()
            .p(t.shell_gap)
            .gap(t.shell_gap)
            .bg(t.background)
            .when(rtl, |d| d.flex_row_reverse())
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| this.toggle_sidebar(cx)))
            .on_action(cx.listener(|_, _: &CloseTab, _, cx| {
                let tabs = cx.core().use_::<TabsModule>();
                if let Some(tab) = tabs.active_tab_id() {
                    tabs.close(&tab);
                }
            }))
            .on_action(cx.listener(|_, _: &SaveActive, _, cx| {
                let core = cx.core();
                if let Some(tab) = core.use_::<TabsModule>().active_tab_id() {
                    core.use_::<notefig_documents::DocumentsModule>().flush(&tab);
                }
            }))
            .on_action({
                let ws = ws.clone();
                move |_: &ShowFiles, _, cx| show_view(SidebarView::Tool(WorkspaceTool::Files), &ws, cx)
            })
            .on_action({
                let ws = ws.clone();
                move |_: &ShowSearch, _, cx| show_view(SidebarView::Tool(WorkspaceTool::Search), &ws, cx)
            })
            .on_action({
                let ws = ws.clone();
                move |_: &ShowGit, _, cx| show_view(SidebarView::Tool(WorkspaceTool::Git), &ws, cx)
            })
            .on_action({
                let ws = ws.clone();
                move |_: &ShowSessions, _, cx| show_view(SidebarView::Tool(WorkspaceTool::Sessions), &ws, cx)
            })
            .on_action({
                let ws = ws.clone();
                move |_: &ShowEverything, _, cx| show_view(SidebarView::Everything, &ws, cx)
            })
            .on_action(cx.listener(|_, _: &FocusNextWindow, _, cx| cx.core().use_::<TabsModule>().focus_window(WindowStep::Next)))
            .on_action(cx.listener(|_, _: &FocusPrevWindow, _, cx| cx.core().use_::<TabsModule>().focus_window(WindowStep::Prev)))
            .on_action(cx.listener(|this, _: &SplitRight, _, cx| this.split_active(SplitDirection::Right, cx)))
            .on_action(cx.listener(|this, _: &SplitDown, _, cx| this.split_active(SplitDirection::Bottom, cx)))
            .on_action(cx.listener(|this, _: &NextTab, _, cx| this.step_tab(true, cx)))
            .on_action(cx.listener(|this, _: &PrevTab, _, cx| this.step_tab(false, cx)))
            .on_action(cx.listener(|this, _: &NewScratchpad, _, cx| this.new_scratchpad(cx)))
            .on_action(cx.listener(|this, _: &NewFile, window, cx| this.start_create(false, window, cx)))
            .on_action(cx.listener(|this, _: &NewFolder, window, cx| this.start_create(true, window, cx)))
            .on_action(cx.listener(|this, _: &SearchInFile, window, cx| this.open_search(true, window, cx)))
            .on_action(cx.listener(|this, _: &SearchInFiles, window, cx| this.open_search(false, window, cx)))
            .on_action(cx.listener(|_, _: &Undo, _, cx| run_history(false, cx)))
            .on_action(cx.listener(|_, _: &Redo, _, cx| run_history(true, cx)))
            .on_action(cx.listener(|_, action: &OpenFile, _, cx| {
                cx.core().use_::<TabsModule>().open(&action.path, Default::default());
            }))
            .on_action(cx.listener(|_, _: &OpenReleaseNotes, _, cx| {
                cx.core().use_::<TabsModule>().open(
                    notefig_tabs::RELEASE_NOTES_TAB_ID,
                    notefig_tabs::OpenTabOptions { intent: notefig_tabs::OpenFileIntent::NewTab, ..Default::default() },
                );
            }))
            .on_action(cx.listener(|this, action: &SetTextDirection, _, cx| this.set_direction(&action.direction, cx)))
            .on_action(cx.listener(|this, _: &CloseWorkspace, window, cx| {
                let ws = this.workspace_path.clone();
                this.close_dialog.update(cx, |d, cx| d.request(&ws, window, cx));
            }))
            .on_action(|_: &OpenSettings, window, cx| {
                if let Some(open) = panels(cx).open_settings {
                    open(None, window, cx);
                }
            })
            .on_action(|_: &ToggleFullscreen, window, _| window.toggle_fullscreen())
            .when(!collapsed, |d| d.child(self.sidebar.clone()))
            .child(div().flex().flex_col().flex_1().min_w_0().min_h_0().overflow_hidden().child(self.dock.clone()))
            .child(self.status.clone())
            // Overlays (pair dialog, dictation, update toasts, consent) on a
            // layer of their own: as flex children each would add a gap.
            .child(div().absolute().inset_0().children(self.overlays.iter().cloned()))
    }
}

/// Every window's id, for tests and the script driver.
#[allow(dead_code)]
pub(crate) fn window_ids(layout: &LayoutApi) -> Vec<String> {
    windows(&layout.read()).into_iter().map(|w| w.id.clone()).collect()
}
