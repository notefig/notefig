//! The `tabs` module — `core.tabs`: a port of
//! `packages/desktop/src/modules/tabs/`. The one way the app changes tabs:
//! open, select, focus, close, reveal a location in, and rename a tab, and
//! which tab is active. Also the tab-id scheme ([`tab_id`]), the controller
//! registry ([`TabControllers`]), the window in front ([`FocusedWindow`])
//! and [`TabsApi::tab`], the handle over one open tab.
//!
//! The layout itself is the `layout` module; this one owns what happens to
//! tabs in it. What a tab of each kind *shows* (the TS `tab-types.tsx`
//! render registry) is the dock view's, in `views/workspace`.

mod controllers;
pub mod tab_id;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::{Listeners, Module, ModuleContext, ModuleRef, Subscription};
use notefig_documents::{DocumentsApi, DocumentsModule};
use notefig_editors::{EditorHandle, EditorTarget, EditorsApi, EditorsModule, SearchTarget};
use notefig_layout::{
    LayoutApi, LayoutModule, LayoutNode, LayoutUpdateOptions, OpenFileInLayoutOptions, SearchParams,
    WindowNode, extract_tab_ids, find_first_window, find_window_by_id, find_window_containing_tab, open_file_in_layout,
    remove_tab_from_layout, rename_tab_in_layout, select_tab_in_layout,
};

pub use notefig_layout::OpenFileIntent;
pub use controllers::{FocusTiming, TabController, TabControllers, TabSearchOptions};
pub use tab_id::{
    AGENT_TAB_PREFIX, RELEASE_NOTES_TAB_ID, TabKind, TabRef, agent_tab_id, agent_task_id_from_tab_id, file_tab_path,
    is_agent_tab_id, is_file_tab_id, is_release_notes_tab_id, parse_tab_id, tab_kind,
};

// ---------------------------------------------------------------------------
// The window in front.
// ---------------------------------------------------------------------------

/// A dock window's bounds on screen, as the dock view last laid it out.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct WindowRect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

/// `FocusedWindow`: the dock window that last held focus, or whose tab was
/// last opened or selected — kept after focus leaves the dock. The dock
/// view calls [`FocusedWindow::set`] when a window takes focus (TS tracks
/// `focusin` on the document) and [`FocusedWindow::set_rects`] after layout
/// (TS reads the DOM's rects).
#[derive(Default)]
pub struct FocusedWindow {
    window_id: RefCell<Option<String>>,
    rects: RefCell<Vec<(String, WindowRect)>>,
    listeners: Listeners<()>,
}

impl FocusedWindow {
    pub fn get(&self) -> Option<String> {
        self.window_id.borrow().clone()
    }

    pub fn set(&self, window_id: &str) {
        if self.window_id.borrow().as_deref() == Some(window_id) {
            return;
        }
        *self.window_id.borrow_mut() = Some(window_id.to_string());
        self.listeners.emit();
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.listeners.subscribe(move |_| listener())
    }

    /// Every window's bounds, in dock order.
    pub fn set_rects(&self, rects: Vec<(String, WindowRect)>) {
        *self.rects.borrow_mut() = rects;
    }

    fn rects(&self) -> Vec<(String, WindowRect)> {
        self.rects.borrow().clone()
    }
}

/// `focusedWindowModule`.
pub struct FocusedWindowModule;

impl Module for FocusedWindowModule {
    const NAME: &'static str = "focusedWindow";
    type Api = FocusedWindow;
    type Workspace = ();

    fn register(_: &ModuleContext) -> FocusedWindow {
        FocusedWindow::default()
    }
}

/// `WindowStep`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowStep {
    Next,
    Prev,
    Up,
    Down,
    Left,
    Right,
}

/// The nearest window past `from`'s edge towards `to` that shares some of
/// its span, so up and down never jump sideways.
fn nearest_toward(from: WindowRect, windows: &[(String, WindowRect)], to: WindowStep) -> Option<String> {
    let mut best: Option<(String, f32)> = None;
    for (id, r) in windows {
        let gap = match to {
            WindowStep::Up => from.top - r.bottom,
            WindowStep::Down => r.top - from.bottom,
            WindowStep::Left => from.left - r.right,
            WindowStep::Right => r.left - from.right,
            _ => return None,
        };
        let overlap = match to {
            WindowStep::Left | WindowStep::Right => from.bottom.min(r.bottom) - from.top.max(r.top),
            _ => from.right.min(r.right) - from.left.max(r.left),
        };
        if gap < -1. || overlap <= 0. {
            continue;
        }
        if best.as_ref().is_none_or(|(_, g)| gap < *g) {
            best = Some((id.clone(), gap));
        }
    }
    best.map(|(id, _)| id)
}

fn window_at(windows: &[(String, WindowRect)], from_id: &str, to: WindowStep) -> Option<String> {
    let index = windows.iter().position(|(id, _)| id == from_id)?;
    if windows.len() < 2 {
        return None;
    }
    match to {
        WindowStep::Next | WindowStep::Prev => {
            let n = windows.len() as isize;
            let step = if to == WindowStep::Next { 1 } else { -1 };
            Some(windows[((index as isize + step + n) % n) as usize].0.clone())
        }
        _ => nearest_toward(windows[index].1, windows, to),
    }
}

// ---------------------------------------------------------------------------
// The tab handle.
// ---------------------------------------------------------------------------

/// The handle over one open tab, mounted or not (`tab(id)`). An unmounted
/// tab reports `is_mounted() == false` and its controls no-op. A file tab
/// carries its editor handle; an agent tab its task id — the agent
/// controls are `core.agents.task(id)` (the agents crate depends on this
/// one, so the handle cannot carry its facade).
#[derive(Clone)]
pub struct TabHandle {
    pub tab_id: String,
    pub kind: TabHandleKind,
    controllers: Rc<TabControllers>,
}

#[derive(Clone)]
pub enum TabHandleKind {
    File { path: String, editor: EditorHandle },
    Agent { task_id: String },
    ReleaseNotes,
}

impl TabHandle {
    pub fn is_mounted(&self) -> bool {
        self.controllers.has(&self.tab_id)
    }
    pub fn is_focusable(&self) -> bool {
        self.controllers.is_focusable(&self.tab_id)
    }
    pub fn focus(&self) -> bool {
        self.controllers.focus_tab(&self.tab_id)
    }
    pub fn selected_text(&self) -> Option<String> {
        self.controllers.selected_text(&self.tab_id)
    }
    pub fn search(&self, query: &str, options: TabSearchOptions) -> LocalBoxFuture<'static, Vec<SearchTarget>> {
        self.controllers.search(&self.tab_id, query, options)
    }
    pub fn reveal_match(&self, target: SearchTarget) -> LocalBoxFuture<'static, bool> {
        self.controllers.reveal_match(&self.tab_id, target)
    }
    pub fn editor(&self) -> Option<&EditorHandle> {
        match &self.kind {
            TabHandleKind::File { editor, .. } => Some(editor),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// core.tabs
// ---------------------------------------------------------------------------

/// `OpenTabOptions`.
#[derive(Default)]
pub struct OpenTabOptions {
    /// `Replace` (default) swaps out the target window's selected tab.
    pub intent: OpenFileIntent,
    /// Defaults to the active window.
    pub target_window_id: Option<String>,
    /// Move the tab to the target window when it is open elsewhere.
    pub move_if_open: bool,
    /// The gesture opened this tab as the thing to type into next.
    pub handoff: bool,
    /// Change other URL params in the same navigation.
    pub params: Option<Box<dyn FnOnce(&mut SearchParams)>>,
}

/// `TabFocusRequest`.
#[derive(Clone, Copy, Debug, Default)]
pub struct TabFocusRequest {
    /// `None` = now (reports whether focus landed).
    pub when: Option<FocusTiming>,
    pub steal: bool,
}

/// What tabs are built from (`TabsDeps`).
pub struct TabsDeps {
    pub layout: Rc<LayoutApi>,
    pub focused_window: Rc<FocusedWindow>,
    /// The editor's format gate.
    pub can_open_file: fn(&str) -> bool,
    pub editors: Rc<EditorsApi>,
    pub documents: Rc<DocumentsApi>,
}

/// `core.tabs`.
pub struct TabsApi {
    deps: TabsDeps,
    controllers: Rc<TabControllers>,
    renaming: Rc<RefCell<HashMap<String, String>>>,
    rename_watch: Rc<RefCell<Option<Subscription>>>,
}

pub fn create_tabs(deps: TabsDeps) -> TabsApi {
    TabsApi {
        deps,
        controllers: Rc::new(TabControllers::default()),
        renaming: Rc::default(),
        rename_watch: Rc::default(),
    }
}

impl TabsApi {
    /// The registry tab surfaces register their controllers with.
    pub fn controllers(&self) -> &Rc<TabControllers> {
        &self.controllers
    }

    pub fn layout(&self) -> &Rc<LayoutApi> {
        &self.deps.layout
    }

    pub fn focused_window(&self) -> &Rc<FocusedWindow> {
        &self.deps.focused_window
    }

    /// The window brought forward last, then the layout's selection, then
    /// the first window.
    fn active_window(&self) -> Option<WindowNode> {
        let current = self.deps.layout.read();
        if let Some(id) = self.deps.focused_window.get()
            && let Some(w) = find_window_by_id(&current, &id)
        {
            return Some(w.clone());
        }
        if let Some(selected) = self.deps.layout.selected_tab_id()
            && let Some(w) = current.iter().find_map(|n| match n {
                LayoutNode::Window(w) if w.selected == selected => Some(w),
                _ => None,
            })
        {
            return Some(w.clone());
        }
        find_first_window(&current).cloned()
    }

    fn bring_forward(&self, tab_id: &str) {
        let window = find_window_containing_tab(&self.deps.layout.read(), tab_id).map(|w| w.id.clone());
        if let Some(id) = window {
            self.deps.focused_window.set(&id);
        }
    }

    /// Open a tab, or select it if open. False for a file the editor cannot
    /// open. A tab the open replaces is disposed.
    pub fn open(&self, tab_id: &str, options: OpenTabOptions) -> bool {
        if tab_kind(tab_id) == TabKind::File && !(self.deps.can_open_file)(tab_id) {
            return false;
        }
        let target = options.target_window_id.clone().or_else(|| self.active_window().map(|w| w.id));
        let current = self.deps.layout.read();
        let next = open_file_in_layout(
            &current,
            OpenFileInLayoutOptions {
                tab_id,
                intent: options.intent,
                target_window_id: target.as_deref(),
                move_if_open: options.move_if_open,
            },
        );
        let next_ids = extract_tab_ids(&next);
        for id in extract_tab_ids(&current) {
            if !next_ids.contains(&id) {
                self.controllers.dispose_tab(&id);
            }
        }
        self.deps.layout.update(next, LayoutUpdateOptions { replace: false, params: options.params });
        self.bring_forward(tab_id);
        if options.handoff {
            self.controllers.grant_focus_handoff(tab_id);
        }
        true
    }

    /// Open (or select) a session's chat tab, always as a new tab.
    pub fn open_agent(&self, task_id: &str) {
        self.open(&agent_tab_id(task_id), OpenTabOptions { intent: OpenFileIntent::NewTab, ..Default::default() });
    }

    /// Make an open tab its window's selected tab.
    pub fn select(&self, tab_id: &str) {
        if !self.deps.layout.open_tab_ids().iter().any(|t| t == tab_id) {
            return;
        }
        self.deps.layout.update_with(|c| select_tab_in_layout(c, tab_id), Default::default());
        self.bring_forward(tab_id);
    }

    /// Move keyboard focus into a tab.
    pub fn focus(&self, tab_id: &str, request: TabFocusRequest) -> bool {
        match request.when {
            None => self.controllers.focus_tab(tab_id),
            Some(when) => {
                self.controllers.request_focus(tab_id, when, request.steal);
                false
            }
        }
    }

    pub fn close(&self, tab_id: &str) {
        if !self.deps.layout.open_tab_ids().iter().any(|t| t == tab_id) {
            return;
        }
        self.controllers.dispose_tab(tab_id);
        self.deps.layout.update_with(|c| remove_tab_from_layout(c, tab_id), Default::default());
    }

    /// Open the file and move its editor to `target` once mounted.
    pub fn reveal(&self, file_path: &str, target: EditorTarget, options: OpenTabOptions) -> LocalBoxFuture<'static, bool> {
        if !self.open(file_path, options) {
            return futures::future::ready(false).boxed_local();
        }
        self.deps.editors.go_to(file_path, target)
    }

    /// Swap a tab id in place, without disposing.
    pub fn rename(&self, old_id: &str, new_id: &str) {
        self.deps.layout.update_with(|c| rename_tab_in_layout(c, old_id, new_id), Default::default());
    }

    fn begin_rename(&self, old: &str, new: &str) {
        self.renaming.borrow_mut().insert(old.into(), new.into());
        if self.rename_watch.borrow().is_none() {
            let layout = self.deps.layout.clone();
            let renaming = self.renaming.clone();
            let watch = self.rename_watch.clone();
            let sub = self.deps.layout.subscribe(move || end_settled_renames(&layout, &renaming, &watch));
            *self.rename_watch.borrow_mut() = Some(sub);
        }
    }

    /// Rename/move an open file tab by closing and reopening it in place:
    /// edits are flushed and the save pipeline drained, the file moved by
    /// `move_file`, the editor disposed and the id swapped in its window
    /// slot. A failed move leaves the tab intact and returns the error.
    pub fn rename_open_file(
        self: &Rc<Self>,
        old_path: &str,
        new_path: &str,
        move_file: impl FnOnce() -> LocalBoxFuture<'static, anyhow::Result<()>> + 'static,
    ) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        if self.renaming.borrow().contains_key(old_path) {
            let msg = format!("A rename of \"{old_path}\" is already in progress");
            return futures::future::ready(Err(anyhow::anyhow!(msg))).boxed_local();
        }
        self.begin_rename(old_path, new_path);
        let mv = match self.deps.documents.begin_move(old_path) {
            Ok(m) => m,
            Err(e) => return futures::future::ready(Err(e)).boxed_local(),
        };
        let live = self.deps.editors.markdown_editor(old_path);
        if let Some(e) = &live {
            e.set_editable(false);
        }
        let this = self.clone();
        let (old, new) = (old_path.to_string(), new_path.to_string());
        async move {
            this.deps.documents.flush(&old);
            this.deps.documents.when_clean(&old).await;
            this.deps.documents.when_writes_settled(&old).await;
            if let Err(err) = move_file().await {
                if let Some(e) = live.filter(|e| !e.is_destroyed()) {
                    e.set_editable(true);
                }
                mv.settle(&old);
                this.renaming.borrow_mut().remove(&old);
                end_settled_renames(&this.deps.layout, &this.renaming, &this.rename_watch);
                return Err(err);
            }
            mv.settle(&new);
            this.controllers.dispose_tab(&old);
            this.rename(&old, &new);
            Ok(())
        }
        .boxed_local()
    }

    /// Tab ids mid-rename (old → new): stale-tab pruning must not close them.
    pub fn renaming(&self) -> HashMap<String, String> {
        self.renaming.borrow().clone()
    }

    /// Take a layout the dock produced (drag, close), disposing removed tabs.
    pub fn apply_layout(&self, next: Vec<LayoutNode>) {
        let next_ids = extract_tab_ids(&next);
        for id in self.deps.layout.open_tab_ids() {
            if !next_ids.contains(&id) {
                self.controllers.dispose_tab(&id);
            }
        }
        self.deps.layout.update(next, Default::default());
    }

    /// The selected tab of the active window.
    pub fn active_tab_id(&self) -> Option<String> {
        self.active_window()
            .map(|w| w.selected)
            .filter(|s| !s.is_empty())
            .or_else(|| self.deps.layout.selected_tab_id())
    }

    pub fn active_window_id(&self) -> Option<String> {
        self.active_window().map(|w| w.id)
    }

    pub fn active_window_tabs(&self) -> Vec<String> {
        self.active_window().map(|w| w.children).unwrap_or_default()
    }

    /// Bring another window forward and focus its selected tab.
    pub fn focus_window(&self, to: WindowStep) {
        let Some(current) = self.active_window() else { return };
        let Some(target_id) = window_at(&self.deps.focused_window.rects(), &current.id, to) else { return };
        let Some(target) = find_window_by_id(&self.deps.layout.read(), &target_id).cloned() else { return };
        self.deps.focused_window.set(&target.id);
        if target.selected.is_empty() {
            return;
        }
        self.controllers.set_active_tab(Some(&target.selected));
        self.controllers.request_focus(&target.selected, FocusTiming::Immediate, true);
    }

    /// The handle over one tab.
    pub fn tab(&self, tab_id: &str) -> TabHandle {
        let kind = match parse_tab_id(tab_id) {
            TabRef::File { path, .. } => TabHandleKind::File { editor: self.deps.editors.get(&path), path },
            TabRef::Agent { task_id, .. } => TabHandleKind::Agent { task_id },
            TabRef::ReleaseNotes { .. } => TabHandleKind::ReleaseNotes,
        };
        TabHandle { tab_id: tab_id.into(), kind, controllers: self.controllers.clone() }
    }

    /// Called when the layout or the focused window changes.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        let listener = Rc::new(listener);
        let l = listener.clone();
        Subscription::join(vec![
            self.deps.layout.subscribe(move || l()),
            self.deps.focused_window.subscribe(move || listener()),
        ])
    }
}

fn end_settled_renames(layout: &LayoutApi, renaming: &RefCell<HashMap<String, String>>, watch: &RefCell<Option<Subscription>>) {
    let ids = layout.open_tab_ids();
    renaming.borrow_mut().retain(|old, _| ids.contains(old));
    if renaming.borrow().is_empty() {
        // Dropping the subscription from inside its own callback is fine:
        // Listeners snapshot the list before notifying.
        let sub = watch.borrow_mut().take();
        drop(sub);
    }
}

/// `tabsModule`.
pub struct TabsModule;

impl Module for TabsModule {
    const NAME: &'static str = "tabs";
    type Api = TabsApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![
            ModuleRef::of::<LayoutModule>(),
            ModuleRef::of::<EditorsModule>(),
            ModuleRef::of::<DocumentsModule>(),
            ModuleRef::of::<FocusedWindowModule>(),
        ]
    }

    fn register(ctx: &ModuleContext) -> TabsApi {
        create_tabs(TabsDeps {
            layout: ctx.use_::<LayoutModule>(),
            focused_window: ctx.use_::<FocusedWindowModule>(),
            can_open_file: notefig_editors::can_open_file,
            editors: ctx.use_::<EditorsModule>(),
            documents: ctx.use_::<DocumentsModule>(),
        })
    }
}

#[cfg(test)]
mod tests;
