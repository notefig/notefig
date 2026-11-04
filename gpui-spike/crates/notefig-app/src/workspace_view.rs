//! One open workspace: the sidebar (rail + Files/Sessions views), the dock
//! of panes and tabs, documents, the watcher, and the palette overlay.

use std::collections::HashMap;
use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement, IntoElement, KeyDownEvent, ParentElement,
    PromptLevel, Render, ScrollStrategy, SharedString, StatefulInteractiveElement as _, Styled,
    Subscription, Task, UniformListScrollHandle, Window, div, prelude::FluentBuilder as _, px,
    uniform_list,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenuItem};
use gpui_kit::component::{
    ActiveTheme as _, Icon, IconName, Sizable as _, WindowExt as _, h_flex, h_resizable,
    resizable_panel, v_flex, v_resizable,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use notefig_workspace::{FsEvent, Tree, WatchHandle, Workspace, file_name, join_rel, parent_rel};

use crate::actions::*;
use crate::agents::chat::{ChatEvent, ChatView};
use crate::agents::sessions::{SessionsEvent, SessionsPanel};
use crate::agents::settings::SettingsView;
use crate::agents::widget::{WidgetEvent, WidgetHost, WidgetRegistry};
use crate::agents::Agents;
use crate::app_state::AppState;
use crate::document::{Document, DocumentEvent};
use crate::layout::{Layout, Node, OpenMode, Pane, PaneId, SplitDirection, Tab, renamed};
use crate::palette::{Palette, PaletteEvent, PaletteMode};
use crate::search_view::{SearchEvent, SearchView};
use crate::tree_model::TreeModel;
use notefig_workspace::scratchpads;

const WATCH_DEBOUNCE: Duration = Duration::from_millis(100);
const ROW_HEIGHT: f32 = 26.;
const RAIL_WIDTH: f32 = 44.;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SidebarView {
    Files,
    Search,
    History,
    Sessions,
}

impl SidebarView {
    fn key(self) -> &'static str {
        match self {
            SidebarView::Files => "files",
            SidebarView::Search => "search",
            SidebarView::History => "history",
            SidebarView::Sessions => "sessions",
        }
    }
    fn from_key(key: Option<&str>) -> Self {
        match key {
            Some("sessions") => SidebarView::Sessions,
            Some("search") => SidebarView::Search,
            Some("history") => SidebarView::History,
            _ => SidebarView::Files,
        }
    }
}

enum TreeEditMode {
    Rename { rel: String },
    Create { parent: String, is_dir: bool },
}

struct TreeEdit {
    mode: TreeEditMode,
    input: Entity<InputState>,
    _sub: Subscription,
}

/// A row being dragged from the tree.
#[derive(Clone)]
pub struct DraggedPath {
    pub rel: String,
}

/// A tab being dragged.
#[derive(Clone)]
pub struct DraggedTab {
    pub pane: PaneId,
    pub tab: Tab,
    pub label: SharedString,
}

struct DragPreview(SharedString);

impl Render for DragPreview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .px_2()
            .py_1()
            .rounded_md()
            .text_sm()
            .bg(cx.theme().popover)
            .border_1()
            .border_color(cx.theme().border)
            .child(self.0.clone())
    }
}

pub enum WorkspaceEvent {
    /// The title (active file, dirty state) may have changed.
    TitleChanged,
}

pub struct WorkspaceView {
    pub ws: Workspace,
    app_state: Entity<AppState>,
    tree: Tree,
    pub tree_model: TreeModel,
    tree_scroll: UniformListScrollHandle,
    selected: Option<String>,
    tree_edit: Option<TreeEdit>,
    pub layout: Layout,
    docs: HashMap<String, Entity<Document>>,
    chats: HashMap<String, Entity<ChatView>>,
    sessions: Option<Entity<SessionsPanel>>,
    pub history: Entity<crate::history::WorkspaceHistory>,
    settings: Option<Entity<SettingsView>>,
    /// Files offered for `@` mentions, shared with widget composers.
    mention_files: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
    pub sidebar_view: SidebarView,
    pub sidebar_collapsed: bool,
    sidebar_width: f32,
    palette: Option<Entity<Palette>>,
    search: Option<Entity<SearchView>>,
    focus: FocusHandle,
    _watch: Option<WatchHandle>,
    scan_task: Option<Task<()>>,
    _tasks: Vec<Task<()>>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<WorkspaceEvent> for WorkspaceView {}

impl WorkspaceView {
    pub fn new(
        ws: Workspace,
        app_state: Entity<AppState>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let session = app_state.read(cx).data().session(ws.root());
        let tree = ws.scan().unwrap_or_default();
        let mut tree_model = TreeModel::new(session.expanded.clone());
        tree_model.set_tree(&tree);

        let mut layout: Layout = session
            .layout
            .clone()
            .and_then(|v| serde_json::from_value::<Layout>(v).ok())
            .map(Layout::sanitize)
            .unwrap_or_default();
        // Drop tabs whose files are gone.
        for tab in layout.all_tabs() {
            if let Some(rel) = tab.rel() {
                if !ws.exists(rel) {
                    layout.close_everywhere(&tab);
                }
            }
        }

        let mut tasks = Vec::new();
        let watch_files = app_state.read(cx).watch_files;
        let watch = match watch_files.then(|| ws.watch(WATCH_DEBOUNCE)) {
            None => None,
            Some(Ok(handle)) => {
                let events = handle.events.clone();
                tasks.push(cx.spawn_in(window, async move |this, cx| {
                    while let Ok(batch) = events.recv().await {
                        if this
                            .update_in(cx, |this, window, cx| this.handle_fs_events(batch, window, cx))
                            .is_err()
                        {
                            break;
                        }
                    }
                }));
                Some(handle)
            }
            Some(Err(err)) => {
                log::error!("watcher failed to start: {err:#}");
                None
            }
        };

        let root = ws.root().to_path_buf();
        let repo: std::sync::Arc<dyn notefig_history::HistoryRepo> =
            std::sync::Arc::new(notefig_history::GixHistoryRepo::new(root.clone()));
        let history = cx.new(|cx| crate::history::WorkspaceHistory::new(&root, repo, cx));
        let subs = vec![cx.on_app_quit(|this: &mut Self, cx| {
            this.flush(cx);
            async {}
        })];

        let mut this = Self {
            ws,
            app_state,
            tree,
            tree_model,
            tree_scroll: UniformListScrollHandle::new(),
            selected: None,
            tree_edit: None,
            layout,
            docs: HashMap::new(),
            chats: HashMap::new(),
            sessions: None,
            history,
            settings: None,
            mention_files: Default::default(),
            sidebar_view: SidebarView::from_key(session.sidebar_view.as_deref()),
            sidebar_collapsed: session.sidebar_collapsed,
            sidebar_width: session.sidebar_width.unwrap_or(260.),
            palette: None,
            search: None,
            focus: cx.focus_handle(),
            _watch: watch,
            scan_task: None,
            _tasks: tasks,
            _subs: subs,
        };
        for tab in this.layout.all_tabs() {
            this.ensure_tab_view(&tab, window, cx);
        }
        if let Some(Tab::File { rel }) = this.layout.active_tab().cloned() {
            this.selected = Some(rel);
        }
        if let Some(agents) = Agents::global(cx) {
            let weak = cx.entity().downgrade();
            let handle = window.window_handle();
            agents.update(cx, |a, _| a.register_workspace(weak, handle));
            this.refresh_mention_files();
        }
        this
    }

    fn refresh_mention_files(&mut self) {
        *self.mention_files.borrow_mut() = self
            .tree
            .values()
            .filter(|e| !e.is_dir())
            .map(|e| e.rel.clone())
            .collect();
    }

    // ---- queries ------------------------------------------------------

    pub fn name(&self) -> String {
        self.ws.name()
    }

    pub fn doc(&self, rel: &str) -> Option<&Entity<Document>> {
        self.docs.get(rel)
    }

    pub fn tree(&self) -> &Tree {
        &self.tree
    }

    pub fn active_doc(&self) -> Option<Entity<Document>> {
        match self.layout.active_tab()? {
            Tab::File { rel } => self.docs.get(rel).cloned(),
            _ => None,
        }
    }

    pub fn chat(&self, task_id: &str) -> Option<Entity<ChatView>> {
        self.chats.get(task_id).cloned()
    }

    pub fn palette(&self) -> Option<&Entity<Palette>> {
        self.palette.as_ref()
    }

    /// Window title: workspace — active tab.
    pub fn title(&self, cx: &App) -> String {
        match self.layout.active_tab() {
            Some(tab) => format!("{} — {}", self.tab_label(tab, cx), self.name()),
            None => self.name(),
        }
    }

    fn tab_label(&self, tab: &Tab, cx: &App) -> String {
        match tab {
            Tab::File { rel } => file_name(rel).to_string(),
            Tab::Chat { task_id } => self
                .chats
                .get(task_id)
                .map(|c| c.read(cx).title(cx).to_string())
                .unwrap_or_else(|| format!("Session {task_id}")),
            Tab::Settings => "Settings".into(),
        }
    }

    // ---- persistence --------------------------------------------------

    fn persist(&mut self, cx: &mut Context<Self>) {
        let root = self.ws.root().to_path_buf();
        let layout = serde_json::to_value(&self.layout).ok();
        let expanded = self.tree_model.expanded_sorted();
        let view = self.sidebar_view.key().to_string();
        let collapsed = self.sidebar_collapsed;
        let width = self.sidebar_width;
        self.app_state.update(cx, |state, cx| {
            state.update_data(cx, |data| {
                let session = data.session_mut(&root);
                session.layout = layout;
                session.expanded = expanded;
                session.sidebar_view = Some(view);
                session.sidebar_collapsed = collapsed;
                session.sidebar_width = Some(width);
            })
        });
    }

    /// Persist and re-render after any layout/tree/sidebar change.
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.persist(cx);
        cx.emit(WorkspaceEvent::TitleChanged);
        cx.notify();
    }

    /// Write every unsaved document now (quit, workspace close).
    pub fn flush(&mut self, cx: &mut App) {
        for doc in self.docs.values() {
            doc.update(cx, |doc, cx| doc.save_blocking(cx));
        }
    }

    // ---- tabs ---------------------------------------------------------

    fn ensure_tab_view(&mut self, tab: &Tab, window: &mut Window, cx: &mut Context<Self>) {
        match tab {
            Tab::File { rel } => {
                self.ensure_doc(rel, window, cx);
            }
            Tab::Chat { task_id } => {
                if self.chats.contains_key(task_id) {
                    return;
                }
                let Some(agents) = Agents::global(cx) else { return };
                let root = self.ws.root().to_path_buf();
                let files = self.mention_files.borrow().clone();
                let id = task_id.clone();
                let chat = cx.new(|cx| ChatView::new(id, agents, root, files, window, cx));
                self._subs.push(cx.subscribe_in(&chat, window, |this, _, event, window, cx| match event {
                    ChatEvent::OpenFile(abs) => {
                        if let Some(rel) = this.ws.rel_of(abs) {
                            this.open_file(&rel, OpenMode::Pinned, window, cx);
                        }
                    }
                }));
                self.chats.insert(task_id.clone(), chat);
            }
            Tab::Settings => {
                if self.settings.is_none() {
                    if let Some(agents) = Agents::global(cx) {
                        self.settings = Some(cx.new(|cx| SettingsView::new(agents, cx)));
                    }
                }
            }
        }
    }

    /// The editor's widget renderer for a markdown document, bound to this
    /// workspace and the agent runtime.
    fn attach_widgets(&mut self, doc: &Entity<Document>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(agents) = Agents::global(cx) else { return };
        let Some(editor) = doc.read(cx).markdown_editor().cloned() else { return };
        let host = WidgetHost {
            agents,
            root: self.ws.root().to_path_buf(),
            rel: std::rc::Rc::new(std::cell::RefCell::new(doc.read(cx).rel().to_string())),
            files: self.mention_files.clone(),
        };
        let registry = WidgetRegistry::new(host);
        let weak = cx.entity().downgrade();
        let window_handle = window.window_handle();
        *registry.on_new.borrow_mut() = Some(Box::new(move |view, _, cx| {
            let weak = weak.clone();
            cx.subscribe(view, move |_, event: &WidgetEvent, cx| {
                let WidgetEvent::OpenChanges { abs, round } = event;
                let (abs, round) = (abs.clone(), *round);
                let weak = weak.clone();
                let _ = window_handle.update(cx, move |_, window, cx| {
                    let _ = weak.update(cx, |this, cx| this.open_changes(&abs, round, window, cx));
                });
            })
            .detach();
        }));
        editor.update(cx, |e, cx| e.set_node_view_renderer(registry.renderer(), cx));
        doc.update(cx, |d, _| d.widgets = Some(registry));
    }

    /// A widget's file chip: open the file and step to the round's first
    /// change (the review navigator).
    pub fn open_changes(&mut self, abs: &std::path::Path, round: markdown_editor::RoundId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(rel) = self.ws.rel_of(abs) else { return };
        self.open_file(&rel, OpenMode::Pinned, window, cx);
        if let Some(editor) = self.docs.get(&rel).and_then(|d| d.read(cx).markdown_editor().cloned()) {
            let brand = crate::theme::BrandColors::get(cx).brand;
            editor.update(cx, |e, cx| {
                e.set_change_gutter(Some((round, brand)), cx);
                e.step_change(round, true, cx);
            });
        }
        if let Some(doc) = self.docs.get(&rel) {
            doc.update(cx, |d, _| d.last_round = Some(round));
        }
    }

    /// "Next change": step the active document's latest agent round.
    pub fn step_change(&mut self, forward: bool, cx: &mut Context<Self>) {
        let Some(doc) = self.active_doc() else { return };
        let Some(round) = doc.read(cx).last_round else { return };
        if let Some(editor) = doc.read(cx).markdown_editor().cloned() {
            editor.update(cx, |e, cx| {
                e.step_change(round, forward, cx);
            });
        }
    }

    /// `/` in an empty paragraph: replace it with a prompt widget and focus
    /// the widget's composer.
    fn insert_widget(&mut self, doc: &Entity<Document>, block: markdown_editor::BlockId, cx: &mut Context<Self>) {
        let Some(editor) = doc.read(cx).markdown_editor().cloned() else { return };
        if doc.read(cx).widgets.is_none() {
            return;
        }
        let id = markdown_editor::new_prompt_widget_id();
        if let Some(reg) = &doc.read(cx).widgets {
            *reg.focus_next.borrow_mut() = Some(id.clone());
        }
        editor.update(cx, |e, cx| {
            let _ = e.insert_prompt_widget(
                markdown_editor::PromptWidget { id: id.clone(), task: None },
                markdown_editor::WidgetPlacement::Replace(block),
                cx,
            );
        });
    }

    fn ensure_doc(&mut self, rel: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<Document> {
        if let Some(doc) = self.docs.get(rel) {
            return doc.clone();
        }
        let ws = self.ws.clone();
        let doc = cx.new(|cx| Document::open(ws, rel, window, cx));
        self.attach_widgets(&doc, window, cx);
        self._subs.push(cx.subscribe_in(&doc, window, |this, doc, event, window, cx| match event {
            DocumentEvent::SlashTrigger(block) => this.insert_widget(doc, *block, cx),
            DocumentEvent::FilesDropped(paths) => {
                // Workspace files dropped on a document become mentions.
                if let Some(editor) = doc.read(cx).markdown_editor().cloned() {
                    for path in paths {
                        if let Some(rel) = this.ws.rel_of(path) {
                            editor.update(cx, |e, cx| {
                                let _ = e.insert_mention(&rel, cx);
                            });
                        }
                    }
                }
            }
            DocumentEvent::LinkClicked(url) => {
                let base = notefig_workspace::parent_rel(doc.read(cx).rel()).to_string();
                let target = notefig_workspace::join_rel(&base, url.trim_start_matches("./"));
                if !url.contains("://") && this.ws.exists(&target) {
                    this.open_file(&target, OpenMode::Pinned, window, cx);
                } else {
                    cx.open_url(url);
                }
            }
            DocumentEvent::RoundAdopted(round) => {
                doc.update(cx, |d, _| d.last_round = Some(*round));
            }

            DocumentEvent::Edited => {
                let tab = Tab::file(doc.read(cx).rel().to_string());
                let was_preview = this
                    .layout
                    .panes()
                    .iter()
                    .any(|p| p.tabs.iter().any(|t| t.tab == tab && t.preview));
                if was_preview {
                    this.layout.pin(&tab);
                    this.changed(cx);
                } else {
                    cx.notify();
                }
            }
            DocumentEvent::SaveStateChanged => {
                this.history.update(cx, |h, cx| h.mark_stale(cx));
                cx.emit(WorkspaceEvent::TitleChanged);
                cx.notify();
            }
        }));
        self.docs.insert(rel.to_string(), doc.clone());
        doc
    }

    pub fn open_tab(&mut self, tab: Tab, mode: OpenMode, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_tab_view(&tab, window, cx);
        self.layout.open(tab.clone(), mode);
        self.after_tab_change(window, cx);
    }

    pub fn open_file(&mut self, rel: &str, mode: OpenMode, window: &mut Window, cx: &mut Context<Self>) {
        self.selected = Some(rel.to_string());
        self.open_tab(Tab::file(rel), mode, window, cx);
        if let Some(doc) = self.docs.get(rel) {
            Document::focus_editor(&doc, window, cx);
        }
    }

    fn after_tab_change(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.gc_views(cx);
        self.changed(cx);
    }

    /// Drop document/chat views no tab shows any more (saving first).
    fn gc_views(&mut self, cx: &mut Context<Self>) {
        let open = self.layout.all_tabs();
        let dead: Vec<String> = self
            .docs
            .keys()
            .filter(|rel| !open.contains(&Tab::file(rel.as_str())))
            .cloned()
            .collect();
        for rel in dead {
            if let Some(doc) = self.docs.remove(&rel) {
                doc.update(cx, |doc, cx| doc.save(cx));
            }
        }
        self.chats
            .retain(|id, _| open.contains(&Tab::Chat { task_id: id.clone() }));
        if !open.contains(&Tab::Settings) {
            self.settings = None;
        }
    }

    pub fn close_tab_in(&mut self, pane: PaneId, tab: &Tab, window: &mut Window, cx: &mut Context<Self>) {
        self.layout.close(pane, tab);
        self.after_tab_change(window, cx);
        self.focus_active(window, cx);
    }

    fn focus_active(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(doc) = self.active_doc() {
            Document::focus_editor(&doc, window, cx);
        } else {
            window.focus(&self.focus, cx);
        }
    }

    pub fn split(&mut self, direction: SplitDirection, window: &mut Window, cx: &mut Context<Self>) {
        let focused = self.layout.focused;
        self.layout.split(focused, direction);
        self.after_tab_change(window, cx);
        self.focus_active(window, cx);
    }

    // ---- file operations ----------------------------------------------

    /// Rescan on the background executor.
    pub fn rescan(&mut self, cx: &mut Context<Self>) {
        let ws = self.ws.clone();
        self.scan_task = Some(cx.spawn(async move |this, cx| {
            let tree = cx.background_executor().spawn(async move { ws.scan() }).await;
            if let Ok(tree) = tree {
                let _ = this.update(cx, |this, cx| this.set_tree(tree, cx));
            }
        }));
    }

    fn rescan_now(&mut self, cx: &mut Context<Self>) {
        if let Ok(tree) = self.ws.scan() {
            self.set_tree(tree, cx);
        }
    }

    fn set_tree(&mut self, tree: Tree, cx: &mut Context<Self>) {
        self.tree = tree;
        self.tree_model.set_tree(&self.tree);
        self.refresh_mention_files();
        let files = self.mention_files.borrow().clone();
        for chat in self.chats.values() {
            chat.update(cx, |c, cx| c.set_files(files.clone(), cx));
        }
        cx.notify();
    }

    /// Bookkeeping after `from` was renamed to `to` (by us or on disk).
    pub fn apply_rename(&mut self, from: &str, to: &str, cx: &mut Context<Self>) {
        self.layout.rename_path(from, to);
        let moved: Vec<String> = self
            .docs
            .keys()
            .filter(|rel| renamed(rel, from, to).is_some())
            .cloned()
            .collect();
        for old in moved {
            let new = renamed(&old, from, to).unwrap();
            if let Some(doc) = self.docs.remove(&old) {
                doc.update(cx, |doc, cx| doc.set_rel(new.clone(), cx));
                self.docs.insert(new, doc);
            }
        }
        let expanded: Vec<String> = self.tree_model.expanded.iter().cloned().collect();
        for rel in expanded {
            if let Some(new) = renamed(&rel, from, to) {
                self.tree_model.expanded.remove(&rel);
                self.tree_model.expanded.insert(new);
            }
        }
        if let Some(sel) = &self.selected {
            if let Some(new) = renamed(sel, from, to) {
                self.selected = Some(new);
            }
        }
        self.rescan_now(cx);
        self.changed(cx);
    }

    /// Bookkeeping after `rel` (file or folder) disappeared.
    pub fn apply_removed(&mut self, rel: &str, cx: &mut Context<Self>) {
        self.layout.remove_path(rel);
        self.docs
            .retain(|r, _| r != rel && !r.starts_with(&format!("{rel}/")));
        self.rescan_now(cx);
        self.changed(cx);
    }

    /// Watcher events: renames and deletions update tabs; content changes
    /// reload open editors.
    pub fn handle_fs_events(&mut self, batch: Vec<FsEvent>, window: &mut Window, cx: &mut Context<Self>) {
        for event in batch {
            match event {
                FsEvent::Renamed { from, to } => self.apply_rename(&from, &to, cx),
                FsEvent::Removed { rel } => {
                    let affected = self.layout.all_tabs().iter().any(|t| {
                        t.rel()
                            .is_some_and(|r| r == rel || r.starts_with(&format!("{rel}/")))
                    });
                    if affected {
                        self.apply_removed(&rel, cx);
                    }
                }
                FsEvent::Upserted { rel, is_dir: false, .. } => {
                    if let Some(doc) = self.docs.get(&rel).cloned() {
                        doc.update(cx, |doc, cx| doc.reload_from_disk(window, cx));
                    }
                }
                FsEvent::Upserted { .. } => {}
            }
        }
        self.rescan(cx);
        self.history.update(cx, |h, cx| h.mark_stale(cx));
    }

    /// "New note" (Cmd+N): a fresh scratchpad in `.notefig/scratchpads`.
    pub fn create_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.ws.create_scratchpad() {
            Ok(rel) => {
                self.rescan_now(cx);
                self.open_file(&rel, OpenMode::Pinned, window, cx);
            }
            Err(err) => self.notify_error(format!("{err:#}"), window, cx),
        }
    }

    fn open_file_tabs(&self) -> Vec<String> {
        self.layout
            .all_tabs()
            .iter()
            .filter_map(|t| t.rel().map(String::from))
            .collect()
    }

    /// The user entered this workspace (open folder, recent, CLI path; not a
    /// restore at launch): sweep abandoned empty scratchpads, and with no
    /// file open, land on the most recent scratchpad or a fresh one.
    pub fn enter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open = self.open_file_tabs();
        if open.is_empty() {
            match self.ws.enter_scratchpad(&open) {
                Ok(rel) => {
                    self.rescan_now(cx);
                    self.open_file(&rel, OpenMode::Pinned, window, cx);
                }
                Err(err) => log::warn!("scratchpad landing failed: {err:#}"),
            }
        } else {
            self.ws.sweep_scratchpads(&open);
            self.rescan_now(cx);
        }
    }

    // ---- search -------------------------------------------------------

    pub fn search_view(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<SearchView> {
        if let Some(search) = &self.search {
            return search.clone();
        }
        let ws = self.ws.clone();
        let search = cx.new(|cx| SearchView::new(ws, window, cx));
        self._subs.push(cx.subscribe_in(&search, window, |this, _, event, window, cx| {
            let SearchEvent::OpenMatch(m) = event;
            let m = m.clone();
            this.open_file(&m.rel, OpenMode::Preview, window, cx);
            if let Some(doc) = this.docs.get(&m.rel).cloned() {
                Document::go_to_match(&doc, &m, window, cx);
            }
        }));
        self.search = Some(search.clone());
        search
    }

    pub fn show_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_view = SidebarView::Search;
        self.sidebar_collapsed = false;
        let search = self.search_view(window, cx);
        search.update(cx, |s, cx| s.focus(window, cx));
        self.changed(cx);
    }

    fn notify_error(&self, message: String, window: &mut Window, cx: &mut Context<Self>) {
        log::error!("{message}");
        window.push_notification(gpui_kit::component::notification::Notification::error(message), cx);
    }

    /// Folder a "new file/folder" from `rel` goes into.
    fn container_of(&self, rel: Option<&str>) -> String {
        match rel {
            None => String::new(),
            Some(rel) if self.tree.get(rel).is_some_and(|e| e.is_dir()) => rel.to_string(),
            Some(rel) => parent_rel(rel).to_string(),
        }
    }

    pub fn start_create(&mut self, parent: String, is_dir: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !parent.is_empty() {
            self.tree_model.set_expanded(&parent, true);
        }
        self.sidebar_view = SidebarView::Files;
        self.sidebar_collapsed = false;
        let input = self.edit_input(String::new(), window, cx);
        self.tree_edit = Some(TreeEdit {
            mode: TreeEditMode::Create { parent, is_dir },
            _sub: self.edit_subscription(&input, window, cx),
            input,
        });
        cx.notify();
    }

    pub fn start_rename(&mut self, rel: String, window: &mut Window, cx: &mut Context<Self>) {
        if scratchpads::is_protected(&rel) {
            return;
        }
        let input = self.edit_input(file_name(&rel).to_string(), window, cx);
        self.tree_edit = Some(TreeEdit {
            mode: TreeEditMode::Rename { rel },
            _sub: self.edit_subscription(&input, window, cx),
            input,
        });
        cx.notify();
    }

    fn edit_input(&self, value: String, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        let input = cx.new(|cx| InputState::new(window, cx).default_value(value));
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        input
    }

    /// Enter or blur commits the inline edit (Escape cancels, see `render_tree`).
    fn edit_subscription(
        &self,
        input: &Entity<InputState>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Subscription {
        cx.subscribe_in(input, window, |this, _, event: &InputEvent, window, cx| {
            if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                this.commit_edit(window, cx);
            }
        })
    }

    /// Commit the inline rename/create. Returns the resulting path.
    pub fn commit_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<String> {
        let edit = self.tree_edit.take()?;
        let name = edit.input.read(cx).value().trim().to_string();
        cx.notify();
        if name.is_empty() || name.contains('/') || name == "." || name == ".." {
            return None;
        }
        match edit.mode {
            TreeEditMode::Create { parent, is_dir } => {
                let mut rel = join_rel(&parent, &name);
                if !is_dir && !name.contains('.') {
                    rel.push_str(".md");
                }
                let result = if is_dir {
                    self.ws.create_dir(&rel)
                } else {
                    self.ws.create_file(&rel, "")
                };
                match result {
                    Ok(()) => {
                        self.rescan_now(cx);
                        if is_dir {
                            self.selected = Some(rel.clone());
                            self.changed(cx);
                        } else {
                            self.open_file(&rel, OpenMode::Pinned, window, cx);
                        }
                        Some(rel)
                    }
                    Err(err) => {
                        self.notify_error(format!("{err:#}"), window, cx);
                        None
                    }
                }
            }
            TreeEditMode::Rename { rel } => {
                let to = join_rel(parent_rel(&rel), &name);
                if to == rel {
                    return Some(rel);
                }
                match self.ws.rename(&rel, &to) {
                    Ok(()) => {
                        self.apply_rename(&rel, &to, cx);
                        Some(to)
                    }
                    Err(err) => {
                        self.notify_error(format!("{err:#}"), window, cx);
                        None
                    }
                }
            }
        }
    }

    pub fn cancel_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.tree_edit.take().is_some() {
            window.focus(&self.focus, cx);
            cx.notify();
        }
    }

    pub fn rename_path(&mut self, from: &str, to: &str, window: &mut Window, cx: &mut Context<Self>) {
        if scratchpads::is_protected(from) {
            return;
        }
        match self.ws.rename(from, to) {
            Ok(()) => self.apply_rename(from, to, cx),
            Err(err) => self.notify_error(format!("{err:#}"), window, cx),
        }
    }

    pub fn confirm_delete(&mut self, rel: String, window: &mut Window, cx: &mut Context<Self>) {
        let answer = window.prompt(
            PromptLevel::Warning,
            &format!("Delete “{}”?", file_name(&rel)),
            Some("It will be moved to the Trash."),
            &["Move to Trash", "Cancel"],
            cx,
        );
        cx.spawn_in(window, async move |this, cx| {
            if answer.await.ok() == Some(0) {
                let _ = this.update_in(cx, |this, window, cx| this.delete_path(&rel, window, cx));
            }
        })
        .detach();
    }

    pub fn delete_path(&mut self, rel: &str, window: &mut Window, cx: &mut Context<Self>) {
        if scratchpads::is_protected(rel) {
            return;
        }
        match self.ws.delete(rel) {
            Ok(()) => self.apply_removed(rel, cx),
            Err(err) => self.notify_error(format!("{err:#}"), window, cx),
        }
    }

    pub fn reveal(&mut self, rel: &str, cx: &mut Context<Self>) {
        self.sidebar_view = SidebarView::Files;
        self.sidebar_collapsed = false;
        if let Some(ix) = self.tree_model.reveal(rel) {
            self.tree_scroll.scroll_to_item(ix, ScrollStrategy::Center);
        }
        self.selected = Some(rel.to_string());
        self.changed(cx);
    }

    // ---- palette ------------------------------------------------------

    pub fn open_palette(&mut self, mode: PaletteMode, window: &mut Window, cx: &mut Context<Self>) {
        let palette = cx.new(|cx| Palette::new(mode, window, cx));
        self._subs.push(cx.subscribe_in(&palette, window, |this, _, event, window, cx| {
            this.palette = None;
            match event {
                PaletteEvent::OpenFile(rel) => {
                    let rel = rel.clone();
                    this.open_file(&rel, OpenMode::Pinned, window, cx);
                }
                PaletteEvent::Run(action) => {
                    this.focus_active(window, cx);
                    window.dispatch_action(action.boxed_clone(), cx);
                }
                PaletteEvent::Dismissed => this.focus_active(window, cx),
            }
            cx.notify();
        }));
        self.palette = Some(palette);
        cx.notify();
    }

    fn file_list(&self) -> Vec<String> {
        let mut files: Vec<String> = self
            .tree
            .values()
            .filter(|e| !e.is_dir())
            .map(|e| e.rel.clone())
            .collect();
        // Recently open tabs first, then the rest in path order.
        let open: Vec<String> = self
            .layout
            .all_tabs()
            .iter()
            .filter_map(|t| t.rel().map(String::from))
            .collect();
        files.sort_by_key(|f| !open.contains(f));
        files
    }

    /// A new chat session with the default harness (trust gate included).
    pub fn new_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_view = SidebarView::Sessions;
        self.sidebar_collapsed = false;
        let Some(panel) = self.sessions_panel(window, cx) else {
            self.notify_error("Agents are not available.".into(), window, cx);
            return;
        };
        panel.update(cx, |p, cx| match p.default_harness(cx) {
            Some(h) => p.start(h, window, cx),
            None => log::warn!("no agent harness found"),
        });
        self.changed(cx);
    }

    pub fn sessions_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Entity<SessionsPanel>> {
        if let Some(p) = &self.sessions {
            return Some(p.clone());
        }
        let agents = Agents::global(cx)?;
        let ws = self.ws.root().to_string_lossy().into_owned();
        let panel = cx.new(|cx| SessionsPanel::new(agents, ws, cx));
        self._subs.push(cx.subscribe_in(&panel, window, |this, _, event, window, cx| {
            let SessionsEvent::Open(task_id) = event;
            this.open_tab(Tab::Chat { task_id: task_id.clone() }, OpenMode::Pinned, window, cx);
        }));
        self.sessions = Some(panel.clone());
        Some(panel)
    }

    pub fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_tab(Tab::Settings, OpenMode::Pinned, window, cx);
    }

    // ---- actions ------------------------------------------------------

    fn register_actions(&self, el: gpui::Stateful<gpui::Div>, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        el.on_action(cx.listener(|this, _: &NewNote, window, cx| this.create_note(window, cx)))
            .on_action(cx.listener(|this, _: &NewFolder, window, cx| {
                let parent = this.container_of(this.selected.clone().as_deref());
                this.start_create(parent, true, window, cx)
            }))
            .on_action(cx.listener(|this, _: &Save, _, cx| {
                if let Some(doc) = this.active_doc() {
                    doc.update(cx, |doc, cx| doc.save(cx));
                }
            }))
            .on_action(cx.listener(|this, _: &CloseTab, window, cx| {
                if this.palette.take().is_some() {
                    cx.notify();
                    return;
                }
                let pane = this.layout.focused;
                if let Some(tab) = this.layout.active_tab().cloned() {
                    this.close_tab_in(pane, &tab, window, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &SplitRight, window, cx| {
                this.split(SplitDirection::Right, window, cx)
            }))
            .on_action(cx.listener(|this, _: &SplitDown, window, cx| {
                this.split(SplitDirection::Down, window, cx)
            }))
            .on_action(cx.listener(|this, _: &QuickOpen, window, cx| {
                let files = this.file_list();
                this.open_palette(PaletteMode::Files(files), window, cx)
            }))
            .on_action(cx.listener(|this, _: &CommandPalette, window, cx| {
                this.open_palette(PaletteMode::Commands(palette_commands()), window, cx)
            }))
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| {
                this.sidebar_collapsed = !this.sidebar_collapsed;
                this.changed(cx);
            }))
            .on_action(cx.listener(|this, _: &ShowFiles, _, cx| {
                this.sidebar_view = SidebarView::Files;
                this.sidebar_collapsed = false;
                this.changed(cx);
            }))
            .on_action(cx.listener(|this, _: &ShowSearch, window, cx| this.show_search(window, cx)))
            .on_action(cx.listener(|this, _: &ShowSessions, _, cx| {
                this.sidebar_view = SidebarView::Sessions;
                this.sidebar_collapsed = false;
                this.changed(cx);
            }))
            .on_action(cx.listener(|this, _: &NewSession, window, cx| this.new_session(window, cx)))
            .on_action(cx.listener(|this, _: &OpenSettings, window, cx| this.open_settings(window, cx)))
            .on_action(cx.listener(|this, _: &NextChange, _, cx| this.step_change(true, cx)))
            .on_action(cx.listener(|this, _: &PreviousChange, _, cx| this.step_change(false, cx)))
            .on_action(cx.listener(|this, _: &RevealActiveFile, _, cx| {
                if let Some(Tab::File { rel }) = this.layout.active_tab().cloned() {
                    this.reveal(&rel, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &NextTab, window, cx| {
                this.layout.cycle_tab(1);
                this.after_tab_change(window, cx);
                this.focus_active(window, cx);
            }))
            .on_action(cx.listener(|this, _: &PreviousTab, window, cx| {
                this.layout.cycle_tab(-1);
                this.after_tab_change(window, cx);
                this.focus_active(window, cx);
            }))
            .on_action(cx.listener(|this, _: &FocusNextPane, window, cx| {
                this.layout.focus_offset(1);
                this.changed(cx);
                this.focus_active(window, cx);
            }))
            .on_action(cx.listener(|this, _: &FocusPreviousPane, window, cx| {
                this.layout.focus_offset(-1);
                this.changed(cx);
                this.focus_active(window, cx);
            }))
    }

    // ---- rendering ----------------------------------------------------

    fn render_rail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let view = self.sidebar_view;
        let is_dark = theme.is_dark();
        let button = |id: &'static str, icon: IconName, tip: &'static str, active: bool| {
            Button::new(id)
                .icon(icon)
                .ghost()
                .small()
                .tooltip(tip)
                .toggled(active)
        };
        v_flex()
            .w(px(RAIL_WIDTH))
            .h_full()
            .py_2()
            .gap_1()
            .items_center()
            .border_r_1()
            .border_color(theme.sidebar_border)
            .bg(theme.sidebar)
            .child(
                button("rail-files", IconName::Folder, "Files", view == SidebarView::Files && !self.sidebar_collapsed)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_view(SidebarView::Files, cx))),
            )
            .child(
                button("rail-search", IconName::Search, "Search", view == SidebarView::Search && !self.sidebar_collapsed)
                    .on_click(cx.listener(|this, _, window, cx| {
                        if this.sidebar_view == SidebarView::Search && !this.sidebar_collapsed {
                            this.toggle_view(SidebarView::Search, cx)
                        } else {
                            this.show_search(window, cx)
                        }
                    })),
            )
            .child(
                button("rail-history", IconName::GalleryVerticalEnd, "History", view == SidebarView::History && !self.sidebar_collapsed)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_view(SidebarView::History, cx))),
            )
            .child(
                button("rail-sessions", IconName::Bot, "Sessions", view == SidebarView::Sessions && !self.sidebar_collapsed)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_view(SidebarView::Sessions, cx))),
            )
            .child(div().flex_1())
            .child(
                button(
                    "rail-theme",
                    if is_dark { IconName::Sun } else { IconName::Moon },
                    "Toggle theme",
                    false,
                )
                .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleTheme), cx)),
            )
    }

    fn toggle_view(&mut self, view: SidebarView, cx: &mut Context<Self>) {
        if self.sidebar_view == view {
            self.sidebar_collapsed = !self.sidebar_collapsed;
        } else {
            self.sidebar_view = view;
            self.sidebar_collapsed = false;
        }
        self.changed(cx);
    }

    fn render_sidebar_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let search = (self.sidebar_view == SidebarView::Search).then(|| self.search_view(window, cx));
        let sessions = (self.sidebar_view == SidebarView::Sessions)
            .then(|| self.sessions_panel(window, cx))
            .flatten();
        if self.sidebar_view == SidebarView::Sessions && sessions.is_none() {
            return div()
                .p_3()
                .text_sm()
                .child("Agents are not available in this build.")
                .into_any_element();
        }
        let theme = cx.theme();
        let header = |title: &'static str| {
            h_flex()
                .h(px(34.))
                .px_3()
                .gap_1()
                .text_xs()
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted_foreground)
                .child(div().flex_1().child(title.to_uppercase()))
        };
        match self.sidebar_view {
            SidebarView::Files => v_flex()
                .size_full()
                .bg(theme.sidebar)
                .text_color(theme.sidebar_foreground)
                .child(
                    header("Files")
                        .child(
                            Button::new("tree-new-file")
                                .icon(IconName::Plus)
                                .ghost()
                                .xsmall()
                                .tooltip("New file")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    let parent = this.container_of(this.selected.clone().as_deref());
                                    this.start_create(parent, false, window, cx)
                                })),
                        )
                        .child(
                            Button::new("tree-new-folder")
                                .icon(IconName::FolderClosed)
                                .ghost()
                                .xsmall()
                                .tooltip("New folder")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    let parent = this.container_of(this.selected.clone().as_deref());
                                    this.start_create(parent, true, window, cx)
                                })),
                        ),
                )
                .child(self.render_tree(window, cx))
                .into_any_element(),
            SidebarView::Search => {
                let search = search.expect("created above");
                v_flex()
                    .size_full()
                    .bg(theme.sidebar)
                    .text_color(theme.sidebar_foreground)
                    .child(header("Search"))
                    .child(div().flex_1().min_h_0().child(search))
                    .into_any_element()
            }
            SidebarView::History => v_flex()
                .size_full()
                .bg(theme.sidebar)
                .text_color(theme.sidebar_foreground)
                .child(header("History"))
                .child(div().flex_1().min_h_0().child(self.history.clone()))
                .into_any_element(),
            SidebarView::Sessions => {
                let panel = sessions.expect("created above");
                let active = match self.layout.active_tab() {
                    Some(Tab::Chat { task_id }) => Some(task_id.clone()),
                    _ => None,
                };
                panel.update(cx, |p, _| p.active = active);
                let theme = cx.theme();
                v_flex()
                    .size_full()
                    .bg(theme.sidebar)
                    .text_color(theme.sidebar_foreground)
                    .child(header_el("Sessions", theme.muted_foreground))
                    .child(div().flex_1().min_h_0().child(panel))
                    .into_any_element()
            }
        }
    }

    /// Tree rows plus the inline "create" row while one is open.
    fn display_rows(&self) -> Vec<DisplayRow> {
        let mut rows: Vec<DisplayRow> = (0..self.tree_model.rows().len()).map(DisplayRow::Entry).collect();
        if let Some(TreeEdit {
            mode: TreeEditMode::Create { parent, .. },
            ..
        }) = &self.tree_edit
        {
            let (at, depth) = if parent.is_empty() {
                (0, 0)
            } else {
                match self.tree_model.index_of(parent) {
                    Some(ix) => (ix + 1, self.tree_model.rows()[ix].depth + 1),
                    None => (0, 0),
                }
            };
            rows.insert(at, DisplayRow::Create { depth });
        }
        rows
    }

    fn render_tree(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let count = self.display_rows().len();
        div()
            .id("file-tree")
            .key_context("FileTree")
            .flex_1()
            .min_h_0()
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if this.tree_edit.is_some() && event.keystroke.key == "escape" {
                    this.cancel_edit(window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_drop(cx.listener(|this, dragged: &DraggedPath, window, cx| {
                // Dropped on empty space: move to the root.
                let to = file_name(&dragged.rel).to_string();
                if to != dragged.rel {
                    this.rename_path(&dragged.rel.clone(), &to, window, cx);
                }
            }))
            .child(
                uniform_list(
                    "file-tree-list",
                    count,
                    cx.processor(|this, range: std::ops::Range<usize>, window, cx| {
                        let rows = this.display_rows();
                        range
                            .filter_map(|ix| rows.get(ix).cloned())
                            .map(|row| this.render_row(row, window, cx))
                            .collect::<Vec<_>>()
                    }),
                )
                .size_full()
                .track_scroll(&self.tree_scroll),
            )
    }

    fn render_row(&mut self, row: DisplayRow, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let indent = |depth: usize| px(8. + depth as f32 * 14.);
        match row {
            DisplayRow::Create { depth } => {
                let input = self.tree_edit.as_ref().map(|e| e.input.clone());
                h_flex()
                    .id("tree-create-row")
                    .h(px(ROW_HEIGHT))
                    .pl(indent(depth))
                    .pr_2()
                    .when_some(input, |this, input| this.child(Input::new(&input).xsmall()))
                    .into_any_element()
            }
            DisplayRow::Entry(ix) => {
                let r = self.tree_model.rows()[ix].clone();
                let rel = r.rel.clone();
                let is_selected = self.selected.as_deref() == Some(rel.as_str());
                let is_active = self.layout.active_tab() == Some(&Tab::file(rel.clone()));
                let renaming = match &self.tree_edit {
                    Some(TreeEdit {
                        mode: TreeEditMode::Rename { rel: r2 },
                        input,
                        ..
                    }) if *r2 == rel => Some(input.clone()),
                    _ => None,
                };
                let icon = if r.is_dir {
                    if r.expanded { IconName::FolderOpen } else { IconName::Folder }
                } else if crate::document::is_markdown(&rel) {
                    IconName::FileText
                } else {
                    IconName::File
                };
                let chevron = if r.is_dir {
                    Icon::new(if r.expanded { IconName::ChevronDown } else { IconName::ChevronRight })
                        .xsmall()
                        .into_any_element()
                } else {
                    div().w(px(12.)).into_any_element()
                };
                let name: SharedString = r.name.clone().into();
                let menu_rel = rel.clone();
                let menu_is_dir = r.is_dir;
                // The app dir and the scratchpads folder stay put.
                let protected = scratchpads::is_protected(&rel);
                let weak = cx.entity().downgrade();
                let drag_rel = rel.clone();
                let drop_rel = rel.clone();
                h_flex()
                    .id(SharedString::from(format!("tree:{rel}")))
                    .h(px(ROW_HEIGHT))
                    .pl(indent(r.depth))
                    .pr_2()
                    .gap_1()
                    .text_sm()
                    .cursor_pointer()
                    .when(is_active, |this| this.bg(theme.sidebar_accent))
                    .when(is_selected && !is_active, |this| this.bg(theme.list_hover))
                    .hover(|this| this.bg(theme.list_hover))
                    .child(chevron)
                    .child(Icon::new(icon).small().text_color(theme.muted_foreground))
                    .map(|this| match renaming {
                        Some(input) => this.child(div().flex_1().child(Input::new(&input).xsmall())),
                        None => this.child(div().flex_1().truncate().child(name.clone())),
                    })
                    .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                        this.on_row_click(&rel, r.is_dir, event, window, cx)
                    }))
                    .when(!r.is_dir && !protected, |this| {
                        this.on_drag(DraggedPath { rel: drag_rel.clone() }, move |_, _, _, cx| {
                            cx.new(|_| DragPreview(name.clone()))
                        })
                    })
                    .when(r.is_dir, |this| {
                        this.drag_over::<DraggedPath>(move |style, _, _, cx| style.bg(cx.theme().drop_target))
                            .on_drop(cx.listener(move |this, dragged: &DraggedPath, window, cx| {
                                let to = join_rel(&drop_rel, file_name(&dragged.rel));
                                if to != dragged.rel {
                                    this.rename_path(&dragged.rel.clone(), &to, window, cx);
                                }
                                cx.stop_propagation();
                            }))
                    })
                    .context_menu(move |menu, _, _| {
                        let w = weak.clone();
                        let item = |label: &'static str, f: fn(&mut WorkspaceView, &str, bool, &mut Window, &mut Context<WorkspaceView>)| {
                            let w = w.clone();
                            let rel = menu_rel.clone();
                            PopupMenuItem::new(label).on_click(move |_, window, cx| {
                                let _ = w.update(cx, |this, cx| f(this, &rel, menu_is_dir, window, cx));
                            })
                        };
                        let mut menu = menu;
                        if !menu_is_dir {
                            menu = menu
                                .item(item("Open", |this, rel, _, window, cx| {
                                    this.open_file(rel, OpenMode::Pinned, window, cx)
                                }))
                                .item(item("Open to the Side", |this, rel, _, window, cx| {
                                    this.split(SplitDirection::Right, window, cx);
                                    this.open_file(rel, OpenMode::Pinned, window, cx)
                                }))
                                .separator();
                        }
                        menu.item(item("New File…", |this, rel, _, window, cx| {
                            let parent = this.container_of(Some(rel));
                            this.start_create(parent, false, window, cx)
                        }))
                        .item(item("New Folder…", |this, rel, _, window, cx| {
                            let parent = this.container_of(Some(rel));
                            this.start_create(parent, true, window, cx)
                        }))
                        .separator()
                        .item(item("Rename…", |this, rel, _, window, cx| {
                            this.start_rename(rel.to_string(), window, cx)
                        }).disabled(protected))
                        .item(item("Delete", |this, rel, _, window, cx| {
                            this.confirm_delete(rel.to_string(), window, cx)
                        }).disabled(protected))
                        .separator()
                        .item(item("Reveal in Finder", |this, rel, _, _, cx| {
                            if let Ok(abs) = this.ws.abs(rel) {
                                cx.reveal_path(&abs);
                            }
                        }))
                    })
                    .into_any_element()
            }
        }
    }

    fn on_row_click(&mut self, rel: &str, is_dir: bool, event: &ClickEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.tree_edit.is_some() {
            self.commit_edit(window, cx);
        }
        self.selected = Some(rel.to_string());
        if is_dir {
            self.tree_model.toggle(rel);
            self.changed(cx);
            return;
        }
        let clicks = match event {
            ClickEvent::Mouse(m) => m.up.click_count,
            _ => 1,
        };
        let mode = if clicks >= 2 || event.modifiers().platform {
            OpenMode::Pinned
        } else {
            OpenMode::Preview
        };
        self.open_file(rel, mode, window, cx);
    }

    fn render_node(&mut self, node: &Node, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        match node {
            Node::Pane(pane) => self.render_pane(pane, window, cx),
            Node::Split {
                axis,
                children,
                sizes,
            } => {
                let row = *axis == crate::layout::Axis::Row;
                let key: Vec<PaneId> = children.iter().map(Node::first_pane).collect();
                // Keyed by the axis and its children: a reshaped split
                // starts from its stored (or equal) sizes again.
                let id = SharedString::from(format!(
                    "split-{}-{}",
                    if row { "row" } else { "col" },
                    key.iter().map(|k| k.to_string()).collect::<Vec<_>>().join("-")
                ));
                let weak = cx.entity().downgrade();
                let on_resize_key = key.clone();
                let group = if row { h_resizable(id) } else { v_resizable(id) };
                let mut group = group.on_resize(move |state, _, cx| {
                    let sizes: Vec<f32> = state.read(cx).sizes().iter().map(|s| f32::from(*s)).collect();
                    let key = on_resize_key.clone();
                    let _ = weak.update(cx, |this, cx| {
                        this.layout.set_split_sizes(&key, sizes);
                        this.persist(cx);
                    });
                });
                for (i, child) in children.iter().enumerate() {
                    let child_el = self.render_node(child, window, cx);
                    let mut panel = resizable_panel().child(child_el);
                    if let Some(size) = sizes.get(i) {
                        panel = panel.size(px(*size));
                    }
                    group = group.child(panel);
                }
                div().size_full().min_w_0().min_h_0().child(group).into_any_element()
            }
        }
    }

    fn render_pane(&mut self, pane: &Pane, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let pane_id = pane.id;
        let focused = self.layout.focused == pane_id;
        let tabs: Vec<AnyElement> = pane
            .tabs
            .iter()
            .enumerate()
            .map(|(ix, entry)| {
                let tab = entry.tab.clone();
                let label: SharedString = self.tab_label(&tab, cx).into();
                let is_active = ix == pane.active;
                let dirty = match &tab {
                    Tab::File { rel } => self.docs.get(rel).is_some_and(|d| d.read(cx).is_dirty()),
                    _ => false,
                };
                let close_tab = tab.clone();
                let click_tab = tab.clone();
                let drop_tab_ix = ix;
                h_flex()
                    .id(SharedString::from(format!("tab-{pane_id}-{ix}")))
                    .h_full()
                    .px_3()
                    .gap_1()
                    .text_sm()
                    .border_r_1()
                    .border_color(theme.border)
                    .cursor_pointer()
                    .when(is_active, |this| {
                        this.bg(theme.tab_active)
                            .text_color(theme.tab_active_foreground)
                            .when(focused, |this| this.border_t_2().border_color(theme.primary))
                    })
                    .when(!is_active, |this| this.bg(theme.tab).text_color(theme.tab_foreground))
                    .when(entry.preview, |this| this.italic())
                    .when(matches!(tab, Tab::Chat { .. }), |this| {
                        this.child(Icon::new(IconName::Bot).xsmall())
                    })
                    .child(label.clone())
                    .child(
                        div()
                            .id(SharedString::from(format!("tab-close-{pane_id}-{ix}")))
                            .w(px(16.))
                            .h(px(16.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_sm()
                            .hover(|this| this.bg(theme.list_hover))
                            .map(|this| {
                                if dirty {
                                    this.child(div().w(px(7.)).h(px(7.)).rounded_full().bg(theme.foreground))
                                } else {
                                    this.child(Icon::new(IconName::Close).xsmall())
                                }
                            })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.close_tab_in(pane_id, &close_tab, window, cx);
                            })),
                    )
                    .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                        if event.is_middle_click() {
                            this.close_tab_in(pane_id, &click_tab, window, cx);
                            return;
                        }
                        this.layout.select(pane_id, ix);
                        if let Some(rel) = click_tab.rel() {
                            this.selected = Some(rel.to_string());
                        }
                        this.changed(cx);
                        this.focus_active(window, cx);
                    }))
                    .on_drag(
                        DraggedTab {
                            pane: pane_id,
                            tab: tab.clone(),
                            label: label.clone(),
                        },
                        |dragged, _, _, cx| cx.new(|_| DragPreview(dragged.label.clone())),
                    )
                    .drag_over::<DraggedTab>(|style, _, _, cx| style.bg(cx.theme().drop_target))
                    .on_drop(cx.listener(move |this, dragged: &DraggedTab, window, cx| {
                        this.layout.move_tab(dragged.pane, &dragged.tab, pane_id, Some(drop_tab_ix));
                        this.after_tab_change(window, cx);
                    }))
                    .into_any_element()
            })
            .collect();

        let content: AnyElement = match pane.active_tab() {
            Some(Tab::File { rel }) => match self.docs.get(rel) {
                Some(doc) => doc.clone().into_any_element(),
                None => div().into_any_element(),
            },
            Some(Tab::Chat { task_id }) => match self.chats.get(task_id) {
                Some(chat) => chat.clone().into_any_element(),
                None => div().p_4().child("Agents are not available.").into_any_element(),
            },
            Some(Tab::Settings) => match &self.settings {
                Some(settings) => settings.clone().into_any_element(),
                None => div().p_4().child("Agents are not available.").into_any_element(),
            },
            None => v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_1()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child("No open files")
                .child("⌘P to open a file · ⌘N for a new note")
                .into_any_element(),
        };

        v_flex()
            .id(SharedString::from(format!("pane-{pane_id}")))
            .size_full()
            .min_w_0()
            .min_h_0()
            .on_any_mouse_down(cx.listener(move |this, _, _, cx| {
                if this.layout.focused != pane_id {
                    this.layout.focus(pane_id);
                    this.changed(cx);
                }
            }))
            .child(
                h_flex()
                    .id(SharedString::from(format!("tab-bar-{pane_id}")))
                    .h(px(34.))
                    .flex_none()
                    .w_full()
                    .overflow_x_scroll()
                    .bg(theme.tab_bar)
                    .border_b_1()
                    .border_color(theme.border)
                    .children(tabs)
                    .child(
                        div()
                            .id(SharedString::from(format!("tab-bar-tail-{pane_id}")))
                            .flex_1()
                            .h_full()
                            .drag_over::<DraggedTab>(|style, _, _, cx| style.bg(cx.theme().drop_target))
                            .drag_over::<DraggedPath>(|style, _, _, cx| style.bg(cx.theme().drop_target))
                            .on_drop(cx.listener(move |this, dragged: &DraggedTab, window, cx| {
                                this.layout.move_tab(dragged.pane, &dragged.tab, pane_id, None);
                                this.after_tab_change(window, cx);
                            }))
                            .on_drop(cx.listener(move |this, dragged: &DraggedPath, window, cx| {
                                this.layout.focus(pane_id);
                                this.open_file(&dragged.rel.clone(), OpenMode::Pinned, window, cx);
                            })),
                    ),
            )
            .child(div().flex_1().min_h_0().child(content))
            .into_any_element()
    }
}

fn header_el(title: &'static str, color: gpui::Hsla) -> gpui::Div {
    h_flex()
        .h(px(34.))
        .px_3()
        .gap_1()
        .text_xs()
        .font_weight(gpui::FontWeight::SEMIBOLD)
        .text_color(color)
        .child(div().flex_1().child(title.to_uppercase()))
}

#[derive(Clone, Copy, Debug)]
enum DisplayRow {
    Entry(usize),
    Create { depth: usize },
}

impl Focusable for WorkspaceView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for WorkspaceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Keep app actions reachable: with nothing focused, key bindings
        // would only reach the window root.
        if window.focused(cx).is_none() {
            window.focus(&self.focus, cx);
        }
        let theme = cx.theme().clone();
        let root = self.layout.root.clone();
        let main = div()
            .size_full()
            .bg(theme.background)
            .child(self.render_node(&root, window, cx));
        let body: AnyElement = if self.sidebar_collapsed {
            h_flex()
                .size_full()
                .child(self.render_rail(cx))
                .child(main)
                .into_any_element()
        } else {
            let panel = self.render_sidebar_panel(window, cx);
            let weak = cx.entity().downgrade();
            h_flex()
                .size_full()
                .child(self.render_rail(cx))
                .child(
                    h_resizable("workspace-split")
                        .on_resize(move |state, _, cx| {
                            let width = state.read(cx).sizes().first().map(|w| f32::from(*w));
                            if let Some(width) = width {
                                let _ = weak.update(cx, |this, cx| {
                                    this.sidebar_width = width;
                                    this.persist(cx);
                                });
                            }
                        })
                        .child(
                            resizable_panel()
                                .size(px(self.sidebar_width))
                                .size_range(px(160.)..px(520.))
                                .child(panel),
                        )
                        .child(resizable_panel().child(main)),
                )
                .into_any_element()
        };
        let el = div()
            .id("workspace")
            .key_context("Workspace")
            .track_focus(&self.focus)
            .relative()
            .size_full()
            .text_color(theme.foreground);
        self.register_actions(el, cx)
            .child(body)
            .when_some(self.palette.clone(), |this, palette| this.child(palette))
    }
}
