//! The sidebar's Files tool: the control row (`file-controls.tsx`) over the
//! tree (`file-tree.tsx`), with the wiring `sidebar.tsx`'s `FilesTool`
//! gives it (create, rename, delete, sort in the URL).
//!
//! The model is the workspace's ([`notefig_tree_model`]) and outlives this
//! view, so expansion, selection and scroll survive a sidebar switch. The
//! view feeds it the workspace's file rows, mirrors the active tab into its
//! selection, and turns gestures into calls on files and tabs.

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, DragMoveEvent, Entity, ExternalPaths, FocusHandle,
    Focusable, InteractiveElement, IntoElement, KeyDownEvent, MouseButton, ParentElement, Render,
    ScrollStrategy, SharedString, StatefulInteractiveElement as _, Styled, UniformListScrollHandle, Window,
    anchored, deferred, div, point, prelude::FluentBuilder as _, px, uniform_list,
};
use gpui_kit::component::WindowExt as _;
use gpui_kit::component::button::ButtonVariant;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenuItem};
use gpui_kit::component::{Icon, Sizable as _};
use notefig_core::{Subscription, WorkspaceHandle};
use notefig_files::paths::{basename, dirname, join, relative_tree_path};
use notefig_files::{FilesModule, WorkspaceFiles};
use notefig_layout::{LayoutModule, OpenFileIntent, SearchParams};
use notefig_scratchpads::{SCRATCHPADS_REL_PATH, ScratchpadsModule, is_protected_tree_path};
use notefig_tabs::{OpenTabOptions, TabsApi, TabsModule};
use notefig_tree_expansion::{ExpansionMemory, TreeExpansionModule};
use notefig_tree_inline_edit::{TreeInlineEditApi, TreeInlineEditModule};
use notefig_tree_model::{
    SortOrder, TreeModelEntry, TreeModelInit, TreeModelModule, TreePath, TreeRow, can_move, drop_destination,
};
use notefig_ui::{CoreExt as _, IconButton, icon, rem, sp, tokens};

use crate::icons::{file_type_icon, glyph, scratchpads_mark};
use crate::*;

/// Row height: `text-sm` line height (1.25rem) + `py-1` (`ROW_HEIGHT_REM`).
const ROW_HEIGHT_REM: f32 = 1.75;
/// The icon/chevron lane (0.9375rem glyphs) and the gap to the label.
const LANE_REM: f32 = 0.9375;
const GAP_REM: f32 = 0.28;
const ROW_PAD_REM: f32 = 0.35;

/// A tree row being dragged (trees' native drag): every selected row when
/// the dragged one is selected, else just it.
#[derive(Clone)]
pub struct DraggedTreeRows {
    pub workspace: String,
    /// Tree-domain paths.
    pub paths: Vec<String>,
    pub label: SharedString,
}

struct DragPreview(SharedString);

impl Render for DragPreview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        div()
            .px(sp(2.))
            .py(sp(1.))
            .rounded(t.radius_md)
            .bg(t.popover)
            .border_1()
            .border_color(t.border)
            .text_size(t.text_sm)
            .text_color(t.foreground)
            .child(self.0.clone())
    }
}

struct InlineEdit {
    input: Entity<InputState>,
    token: u64,
    _sub: gpui::Subscription,
}

/// `FilesTool`: the Files view of one workspace's sidebar.
pub struct FileTreePanel {
    ws: WorkspaceHandle,
    files: WorkspaceFiles,
    entry: Rc<RefCell<TreeModelEntry>>,
    expansion: Rc<ExpansionMemory>,
    inline: Rc<TreeInlineEditApi>,
    tabs: Rc<TabsApi>,
    focus: FocusHandle,
    scroll: UniformListScrollHandle,
    edit: Option<InlineEdit>,
    sort_menu: bool,
    /// The metadata version (and sort) the model was last fed.
    fed: Option<(u64, SortOrder)>,
    last_hovered: Option<String>,
    drop_target: Option<String>,
    last_active: Option<String>,
    _subs: Vec<Subscription>,
}

impl Focusable for FileTreePanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The sort order from the URL (`?sort=`; absent means name-asc).
fn url_sort(cx: &App) -> SortOrder {
    let layout = cx.core().use_::<LayoutModule>();
    let search = layout.url().search();
    SearchParams::parse(&search).get("sort").map(SortOrder::from_key).unwrap_or_default()
}

fn set_url_sort(order: SortOrder, cx: &App) {
    let layout = cx.core().use_::<LayoutModule>();
    let mut params = SearchParams::parse(&layout.url().search());
    if order == SortOrder::NameAsc {
        params.delete("sort");
    } else {
        params.set("sort", order.key());
    }
    layout.url().set_search(&params.to_search(), false);
}

/// `ensureNewFileNameHasDefaultMarkdownExtension`.
pub fn with_default_markdown_extension(name: &str) -> String {
    if name.is_empty() {
        return name.to_string();
    }
    if name.ends_with('.') {
        let trimmed = name.trim_end_matches('.');
        return if trimmed.is_empty() { name.to_string() } else { format!("{trimmed}.md") };
    }
    match name.rfind('.') {
        Some(i) if i < name.len() - 1 => name.to_string(),
        _ => format!("{name}.md"),
    }
}

impl FileTreePanel {
    /// The Files view of `ws`. The workspace must be open.
    pub fn new(ws: WorkspaceHandle, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let core = cx.core();
        let files = (*ws.get::<FilesModule>().expect("files of an open workspace")).clone();
        let expansion = ws.get::<TreeExpansionModule>().expect("treeExpansion of an open workspace");
        let tree = ws.get::<TreeModelModule>().expect("treeModel of an open workspace");
        let tabs = core.use_::<TabsModule>();
        let inline = core.use_::<TreeInlineEditModule>();
        let active = tabs.active_tab_id();
        let entry = tree.acquire(TreeModelInit {
            order: url_sort(cx),
            initial_selected: active.as_deref().and_then(|a| relative_tree_path(files.workspace_path(), a)),
            initial_expanded: expansion.paths(),
        });
        let focus = cx.focus_handle();
        let subs = vec![
            notefig_ui::observe(cx, |notify| files.subscribe(move || notify())),
            notefig_ui::observe(cx, |notify| tabs.subscribe(move || notify())),
            notefig_ui::observe(cx, |notify| core.use_::<LayoutModule>().url().subscribe(Box::new(move || notify()))),
        ];
        let scroll = UniformListScrollHandle::new();
        let mut this = Self {
            ws,
            files,
            entry,
            expansion,
            inline,
            tabs,
            focus,
            scroll,
            edit: None,
            sort_menu: false,
            fed: None,
            last_hovered: None,
            drop_target: None,
            last_active: None,
            _subs: subs,
        };
        this.sync(window, cx);
        this
    }

    pub fn workspace(&self) -> &WorkspaceHandle {
        &self.ws
    }

    fn root(&self) -> &str {
        self.files.workspace_path()
    }

    fn to_abs(&self, rel: &str) -> String {
        self.files.absolute(rel)
    }

    fn to_rel(&self, abs: &str) -> Option<String> {
        relative_tree_path(self.root(), abs).filter(|r| !r.is_empty())
    }

    fn open_tabs(&self, cx: &App) -> Vec<String> {
        cx.core().use_::<LayoutModule>().open_tab_ids()
    }

    /// A DIRECTORY with open tabs inside: moving it would orphan them. An
    /// open file itself moves fine (the close-and-reopen rename).
    fn contains_open_tab(&self, rel: &str, cx: &App) -> bool {
        let abs = self.to_abs(rel);
        self.open_tabs(cx).iter().any(|tab| tab != &abs && relative_tree_path(&abs, tab).is_some())
    }

    // -- feeding the model ---------------------------------------------------

    /// The data effects of `file-tree.tsx`: reset the model when the paths
    /// (or, date-sorted, their stats) changed, apply the one-shot default
    /// expansions, mirror the active tab, hydrate visible folders' stats
    /// and record the expansion.
    fn sync(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let sort = url_sort(cx);
        let version = self.files.metadata().version();
        let mut entry = self.entry.borrow_mut();
        if entry.model.sort() != sort {
            entry.model.set_sort(sort);
        }
        if self.fed != Some((version, sort)) && entry.model.rename_session().is_none() {
            let rows = self.files.metadata().rows();
            let paths: Vec<TreePath> = rows
                .iter()
                .filter_map(|r| {
                    let rel = r.relative_path.as_ref().filter(|p| !p.is_empty())?;
                    Some(TreePath { path: rel.replace("//", "/"), is_dir: r.is_dir(), modified_ms: r.modified_ms.unwrap_or(0) })
                })
                .collect();
            let mut keys: Vec<String> = paths
                .iter()
                .map(|p| if sort == SortOrder::DateModified { format!("{}:{}", p.path, p.modified_ms) } else { p.path.clone() })
                .collect();
            keys.sort();
            let signature = keys.join("\n");
            self.fed = Some((version, sort));
            if entry.paths_signature.as_deref() != Some(signature.as_str()) {
                entry.paths_signature = Some(signature);
                let mut extra: Vec<String> = Vec::new();
                if entry.needs_default_expansion && !paths.is_empty() {
                    entry.needs_default_expansion = false;
                    extra.extend(paths.iter().filter(|p| p.is_dir && !p.path.contains('/')).map(|p| p.path.clone()));
                }
                let has_scratchpads = paths.iter().any(|p| p.path == SCRATCHPADS_REL_PATH);
                if has_scratchpads && entry.needs_scratchpads_expansion {
                    entry.needs_scratchpads_expansion = false;
                    extra.push(SCRATCHPADS_REL_PATH.to_string());
                }
                let mut expanded = self.expansion.paths().unwrap_or_else(|| entry.model.expanded_paths());
                expanded.extend(extra);
                entry.model.reset_paths(paths);
                entry.model.set_expanded_paths(expanded);
                // Re-apply the selection after a reset.
                self.last_active = None;
            }
        }
        // Keep the tree's selection on the active tab.
        let active = self.tabs.active_tab_id();
        if active != self.last_active {
            self.last_active = active.clone();
            if let Some(rel) = active.as_deref().and_then(|a| self.to_rel(a))
                && entry.model.contains(&rel)
            {
                entry.model.select_only(&rel);
            }
        }
        // Lazy stat hydration (MET-99): the root and every open folder.
        let mut dirs = vec![self.root().to_string()];
        let mut visible_dirs: Vec<(String, bool)> = Vec::new();
        for row in entry.model.rows() {
            if row.is_dir {
                visible_dirs.push((row.path.clone(), row.expanded));
                if row.expanded {
                    dirs.push(self.files.absolute(&row.path));
                }
            }
        }
        self.expansion.record(visible_dirs.iter().map(|(p, e)| (p.as_str(), *e)));
        drop(entry);
        cx.core().executor().spawn(Box::pin(self.files.hydrate_directory_stats(dirs)));
    }

    fn update_model(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut notefig_tree_model::TreeModel)) {
        f(&mut self.entry.borrow_mut().model);
        cx.notify();
    }

    // -- gestures ------------------------------------------------------------

    /// Open from an explicit gesture (click, Enter); never from selection.
    fn open_file(&self, rel: &str, intent: Option<OpenFileIntent>) {
        let abs = self.to_abs(rel);
        if intent.is_none() && self.tabs.active_tab_id().as_deref() == Some(abs.as_str()) {
            return;
        }
        self.tabs.open(&abs, OpenTabOptions { intent: intent.unwrap_or_default(), ..Default::default() });
    }

    fn on_row_click(&mut self, row: &TreeRow, event: &ClickEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let m = event.modifiers();
        // Our convention: Mod+click opens in a new tab; a modified click on
        // a folder toggles it. Trees' mod/shift multi-select never sees it.
        if m.platform || m.control || m.shift {
            if row.is_dir {
                self.update_model(cx, |model| model.toggle(&row.path));
            } else {
                let new_tab = m.platform || m.control;
                self.update_model(cx, |model| model.select_only(&row.path));
                self.open_file(&row.path, new_tab.then_some(OpenFileIntent::NewTab));
            }
            return;
        }
        if row.is_dir {
            self.update_model(cx, |model| {
                model.select_only(&row.path);
                model.toggle(&row.path);
            });
        } else {
            self.update_model(cx, |model| model.select_only(&row.path));
            self.open_file(&row.path, None);
        }
    }

    /// Hover prefetch, as the TS tree's `mouseover`.
    fn on_row_hover(&mut self, rel: &str, is_dir: bool, cx: &mut Context<Self>) {
        if is_dir || self.last_hovered.as_deref() == Some(rel) {
            return;
        }
        self.last_hovered = Some(rel.to_string());
        let prefetch = self.files.file(&self.to_abs(rel)).prefetch();
        cx.core().executor().spawn(prefetch);
    }

    /// `onModeChange({ type: "creating", … })`: a placeholder and its name
    /// field in `parent` (tree-domain, `""` for the root).
    pub fn start_create(&mut self, parent: &str, is_dir: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.commit_edit(window, cx);
        let placeholder = self.entry.borrow_mut().model.start_creating(parent, is_dir);
        self.begin_edit(basename(&placeholder).to_string(), window, cx);
        self.scroll_to(&placeholder);
    }

    pub fn start_rename(&mut self, rel: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !can_move(rel, |p| self.contains_open_tab(p, cx)) {
            return;
        }
        self.commit_edit(window, cx);
        if self.entry.borrow_mut().model.start_renaming(rel) {
            let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
            self.begin_edit(name, window, cx);
            self.scroll_to(rel);
        }
    }

    fn begin_edit(&mut self, value: String, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| InputState::new(window, cx).default_value(value.clone()));
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        let sub = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
            if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                this.commit_edit(window, cx);
            }
        });
        // The app-wide slot names the open entry; this tree's own
        // `on_mouse_down_out` commits it (GPUI hands that handler the
        // window, which the slot's callback cannot reach).
        let token = self.inline.begin(|| {});
        self.edit = Some(InlineEdit { input, token, _sub: sub });
        cx.notify();
    }

    /// End the inline entry with what was typed (Enter, blur, a press
    /// outside): trees' `onRename`.
    pub fn commit_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(edit) = self.edit.take() else { return };
        self.inline.end(edit.token);
        let name = edit.input.read(cx).value().to_string();
        let commit = self.entry.borrow_mut().model.commit_rename(&name);
        window.focus(&self.focus, cx);
        cx.notify();
        let Some(commit) = commit else { return };
        let parent_rel = commit.source.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let parent_abs = if parent_rel.is_empty() { self.root().to_string() } else { self.to_abs(parent_rel) };
        let new_name = commit.destination.rsplit('/').next().unwrap_or(&commit.destination).to_string();
        if commit.was_placeholder {
            self.create_entry(&parent_abs, &new_name, commit.is_dir, cx);
        } else {
            self.rename_entry(&self.to_abs(&commit.source), &new_name, cx);
        }
    }

    pub fn cancel_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(edit) = self.edit.take() {
            self.inline.end(edit.token);
            self.entry.borrow_mut().model.cancel_rename();
            window.focus(&self.focus, cx);
            cx.notify();
        }
    }

    /// `handleCreate`.
    fn create_entry(&self, parent_abs: &str, name: &str, is_dir: bool, cx: &mut Context<Self>) {
        let name = if is_dir { name.to_string() } else { with_default_markdown_extension(name) };
        let full = join(parent_abs, &name);
        if self.files.metadata().contains(&full) {
            log::error!("Cannot create: \"{full}\" already exists");
            return;
        }
        let handle = self.files.file(&full);
        let tabs = self.tabs.clone();
        let task = async move {
            if is_dir {
                if let Err(err) = handle.create_directory().await {
                    log::error!("Failed to create directory {full}: {err:#}");
                }
            } else {
                match handle.create("").await {
                    Ok(()) if notefig_editors::is_text_file(&full) => {
                        // The create gesture grants the new document the
                        // hand-off.
                        tabs.open(&full, OpenTabOptions { handoff: true, ..Default::default() });
                    }
                    Ok(()) => {}
                    Err(err) => log::error!("Failed to create file {full}: {err:#}"),
                }
            }
        };
        cx.core().executor().spawn(Box::pin(task));
    }

    /// `handleRenameFile`: always in place; open files go through the
    /// close-and-reopen rename so the tab follows.
    fn rename_entry(&self, old_abs: &str, new_name: &str, cx: &mut Context<Self>) {
        let new_abs = join(&dirname(old_abs), new_name);
        self.move_entry(old_abs, &new_abs, cx);
    }

    fn move_entry(&self, from: &str, to: &str, cx: &mut Context<Self>) {
        if from == to {
            return;
        }
        if self.files.metadata().contains(to) && from.to_lowercase() != to.to_lowercase() {
            log::error!("Cannot rename: \"{to}\" already exists");
            return;
        }
        let handle = self.files.file(from);
        let target = to.to_string();
        let fut = if self.open_tabs(cx).iter().any(|t| t == from) {
            let h = handle.clone();
            let t2 = target.clone();
            self.tabs.rename_open_file(from, to, move || h.rename(&t2))
        } else {
            handle.rename(&target)
        };
        let (from, to) = (from.to_string(), to.to_string());
        cx.core().executor().spawn(Box::pin(async move {
            if let Err(err) = fut.await {
                log::error!("Failed to rename {from} to {to}: {err:#}");
            }
        }));
    }

    /// The confirmation, then `handleDeleteFile`: open tabs under the path
    /// close, the entry goes to the trash.
    pub fn confirm_delete(&mut self, rel: &str, window: &mut Window, cx: &mut Context<Self>) {
        if is_protected_tree_path(rel) {
            return;
        }
        let abs = self.to_abs(rel);
        let is_dir = self.entry.borrow().model.is_dir(rel);
        let name = basename(&abs).to_string();
        let files = self.files.clone();
        let tabs = self.tabs.clone();
        let layout = cx.core().use_::<LayoutModule>();
        let executor = cx.core().executor();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let (files, tabs, layout, executor, abs) = (files.clone(), tabs.clone(), layout.clone(), executor.clone(), abs.clone());
            alert
                .title(format!("Delete \"{name}\"?"))
                .description(if is_dir {
                    "This will permanently delete the folder and all its contents. This action cannot be undone."
                } else {
                    "This will permanently delete the file. This action cannot be undone."
                })
                .show_cancel(true)
                .cancel_text("Cancel")
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, _, _| {
                    for tab in layout.open_tab_ids() {
                        if tab == abs || relative_tree_path(&abs, &tab).is_some() {
                            tabs.close(&tab);
                        }
                    }
                    let delete = files.file(&abs).delete();
                    let path = abs.clone();
                    executor.spawn(Box::pin(async move {
                        if let Err(err) = delete.await {
                            log::error!("Failed to delete {path}: {err:#}");
                        }
                    }));
                    true
                })
        });
    }

    fn scroll_to(&self, rel: &str) {
        if let Some(ix) = self.entry.borrow().model.index_of(rel) {
            self.scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
        }
    }

    /// Reveal a file (the active tab) in the tree: expand to it, select and
    /// scroll it into view.
    pub fn reveal(&mut self, abs: &str, cx: &mut Context<Self>) {
        let Some(rel) = self.to_rel(abs) else { return };
        let ix = {
            let mut entry = self.entry.borrow_mut();
            let ix = entry.model.reveal(&rel);
            entry.model.select_only(&rel);
            ix
        };
        if let Some(ix) = ix {
            self.scroll.scroll_to_item(ix, ScrollStrategy::Center);
        }
        cx.notify();
    }

    /// Drop `dragged` (tree paths) into `target_dir` (tree path, `""` root).
    fn drop_rows(&mut self, dragged: &DraggedTreeRows, target_dir: &str, cx: &mut Context<Self>) {
        self.drop_target = None;
        if dragged.workspace != self.root() {
            return;
        }
        let blocked = dragged.paths.iter().any(|p| !can_move(p, |q| self.contains_open_tab(q, cx)));
        if blocked {
            return;
        }
        for path in &dragged.paths {
            if let Some(dest) = drop_destination(path, target_dir) {
                self.move_entry(&self.to_abs(path), &self.to_abs(&dest), cx);
            }
        }
        cx.notify();
    }

    /// Files dropped from Finder: copied into the folder under the pointer.
    fn drop_external(&mut self, paths: &ExternalPaths, target_dir: &str, cx: &mut Context<Self>) {
        self.drop_target = None;
        let dest_dir = if target_dir.is_empty() { self.root().to_string() } else { self.to_abs(target_dir) };
        let fs = self.ws_fs(cx);
        let files = self.files.clone();
        for src in paths.paths() {
            let Some(name) = src.file_name().and_then(|n| n.to_str()) else { continue };
            if src.is_dir() {
                continue;
            }
            let to = join(&dest_dir, name);
            let copy = fs.copy_file(&src.to_string_lossy(), &to);
            let files = files.clone();
            cx.core().executor().spawn(Box::pin(async move {
                match copy.await {
                    Ok(()) => files.record_disk_changes(vec![to], vec![]).await,
                    Err(err) => log::error!("Failed to copy into {to}: {err}"),
                }
            }));
        }
        cx.notify();
    }

    fn ws_fs(&self, cx: &App) -> Rc<dyn notefig_platform::FileSystem> {
        cx.core().service::<notefig_platform::PlatformService>().fs.clone()
    }

    fn row_drop_dir(&self, row: &TreeRow) -> String {
        if row.is_dir { row.path.clone() } else { row.path.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default() }
    }

    // -- actions -------------------------------------------------------------

    fn focused_row(&self) -> Option<TreeRow> {
        let entry = self.entry.borrow();
        let f = entry.model.focused()?.to_string();
        entry.model.rows().iter().find(|r| r.path == f).cloned()
    }

    fn register_actions(&self, el: gpui::Stateful<gpui::Div>, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        el.on_action(cx.listener(|this, _: &SelectPrev, _, cx| this.update_model(cx, |m| m.move_focus(-1, false))))
            .on_action(cx.listener(|this, _: &SelectNext, _, cx| this.update_model(cx, |m| m.move_focus(1, false))))
            .on_action(cx.listener(|this, _: &ExtendPrev, _, cx| this.update_model(cx, |m| m.move_focus(-1, true))))
            .on_action(cx.listener(|this, _: &ExtendNext, _, cx| this.update_model(cx, |m| m.move_focus(1, true))))
            .on_action(cx.listener(|this, _: &SelectFirst, _, cx| this.update_model(cx, |m| m.focus_edge(false))))
            .on_action(cx.listener(|this, _: &SelectLast, _, cx| this.update_model(cx, |m| m.focus_edge(true))))
            .on_action(cx.listener(|this, _: &ExpandOrDescend, _, cx| this.update_model(cx, |m| m.focus_right())))
            .on_action(cx.listener(|this, _: &CollapseOrAscend, _, cx| this.update_model(cx, |m| m.focus_left())))
            .on_action(cx.listener(|this, _: &OpenFocused, _, cx| {
                // Enter in the inline name field is the field's: it commits
                // the name, it does not open the row.
                if this.edit.is_some() {
                    return;
                }
                if let Some(row) = this.focused_row() {
                    if row.is_dir {
                        this.update_model(cx, |m| m.toggle(&row.path));
                    } else {
                        this.open_file(&row.path, None);
                    }
                }
            }))
            .on_action(cx.listener(|this, _: &RenameFocused, window, cx| {
                if let Some(row) = this.focused_row() {
                    this.start_rename(&row.path, window, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &DeleteFocused, window, cx| {
                if let Some(row) = this.focused_row() {
                    this.confirm_delete(&row.path, window, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &NewFile, window, cx| this.start_create("", false, window, cx)))
            .on_action(cx.listener(|this, _: &NewFolder, window, cx| this.start_create("", true, window, cx)))
            .on_action(cx.listener(|this, _: &NewScratchpad, _, cx| this.new_scratchpad(cx)))
            .on_action(cx.listener(|this, _: &RevealActiveFile, _, cx| {
                if let Some(active) = this.tabs.active_tab_id() {
                    this.reveal(&active, cx);
                }
            }))
    }

    /// "New Scratchpad": instant and nameless.
    pub fn new_scratchpad(&self, cx: &mut Context<Self>) {
        if let Ok(pads) = self.ws.get::<ScratchpadsModule>() {
            cx.core().executor().spawn(pads.create_and_open());
        }
    }

    // -- rendering -----------------------------------------------------------

    /// `FileControls`: the creation actions at the start, the sort menu at
    /// the end, in a `ToolBar` (`h-9 px-2 gap-1`).
    fn render_controls(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        let sort = url_sort(cx);
        let sort_icon = sort_icon_name(sort);
        let muted = t.muted_foreground;
        // `[&_svg]:size-3.5`, `text-muted-foreground`. (`IconButton::new`'s
        // svg carries no colour of its own, so it is built here.)
        let button = move |id: &'static str, name: &'static str, label: &'static str| {
            IconButton::with_content(id, icon(name).size(sp(3.5)).text_color(muted).into_any_element())
                .size(sp(7.), sp(7.))
                .tooltip(label)
        };
        let weak = cx.entity().downgrade();
        let w1 = weak.clone();
        let w2 = weak.clone();
        let w3 = weak.clone();
        div()
            .flex_none()
            .flex()
            .h(sp(9.))
            .items_center()
            .justify_between()
            .gap(sp(1.))
            .px(sp(2.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(sp(0.5))
                    .child(button("new-scratchpad", "hash", "New Scratchpad").on_click(move |_, _, cx| {
                        let _ = w1.update(cx, |this, cx| this.new_scratchpad(cx));
                    }))
                    .child(button("new-file", "file-plus", "New File").on_click(move |_, window, cx| {
                        let _ = w2.update(cx, |this, cx| this.start_create("", false, window, cx));
                    }))
                    .child(button("new-folder", "folder-plus", "New Folder").on_click(move |_, window, cx| {
                        let _ = w3.update(cx, |this, cx| this.start_create("", true, window, cx));
                    })),
            )
            .child(
                div()
                    .relative()
                    .child(
                        IconButton::with_content("sort", icon(sort_icon).size(sp(4.)).text_color(muted).into_any_element())
                            .size(sp(7.), sp(7.))
                            .pressed(self.sort_menu)
                            .tooltip("Sort files")
                            .on_click({
                                let weak = weak.clone();
                                move |_, _, cx| {
                                    let _ = weak.update(cx, |this, cx| {
                                        this.sort_menu = !this.sort_menu;
                                        cx.notify();
                                    });
                                }
                            }),
                    )
                    .when(self.sort_menu, |el| {
                        let item = |order: SortOrder, label: &'static str| {
                            let weak = weak.clone();
                            div()
                                .id(SharedString::from(format!("sort-{}", order.key())))
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(sp(3.))
                                .px(sp(2.))
                                .py(sp(1.5))
                                .rounded(t.radius_sm)
                                .text_size(t.text_sm)
                                .text_color(t.popover_foreground)
                                .cursor_pointer()
                                .when(sort == order, |d| d.bg(t.accent))
                                .hover(|d| d.bg(t.accent))
                                .child(label)
                                .child(icon(sort_icon_name(order)).size(sp(4.)).text_color(t.muted_foreground))
                                .on_click(move |_, _, cx| {
                                    set_url_sort(order, cx);
                                    let _ = weak.update(cx, |this, cx| {
                                        this.sort_menu = false;
                                        cx.notify();
                                    });
                                })
                        };
                        let weak = weak.clone();
                        el.child(deferred(
                            anchored().anchor(gpui::Anchor::TopRight).offset(point(px(0.), sp(8.))).child(
                                div()
                                    .id("sort-menu")
                                    .occlude()
                                    .min_w(rem(8.))
                                    .p(sp(1.))
                                    .rounded(t.radius_md)
                                    .border_1()
                                    .border_color(t.border)
                                    .bg(t.popover)
                                    .shadow_md()
                                    .on_mouse_down_out(move |_, _, cx| {
                                        let _ = weak.update(cx, |this, cx| {
                                            this.sort_menu = false;
                                            cx.notify();
                                        });
                                    })
                                    .child(item(SortOrder::NameAsc, "Name (A-Z)"))
                                    .child(item(SortOrder::NameDesc, "Name (Z-A)"))
                                    .child(item(SortOrder::DateModified, "Date modified")),
                            ),
                        ))
                    }),
            )
    }

    fn render_row(&mut self, ix: usize, row: TreeRow, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx).clone();
        let row_h = rem(ROW_HEIGHT_REM);
        let lane = rem(LANE_REM);
        let indent = rem(LANE_REM + GAP_REM);
        let pad = rem(ROW_PAD_REM);
        let is_scratchpads = row.path == SCRATCHPADS_REL_PATH;
        let is_app_dir = row.path == notefig_tree_model::APP_DIR_NAME;
        let movable = can_move(&row.path, |p| self.contains_open_tab(p, cx));
        let drop_dir = self.row_drop_dir(&row);
        let drop_highlight = row.is_dir && self.drop_target.as_deref() == Some(row.path.as_str());
        let fg = t.foreground;

        // The lane: chevron for folders, the type glyph for files, the
        // tinted `#` for the scratchpads row.
        let lead: AnyElement = if is_scratchpads {
            scratchpads_mark(lane, t.dark, cx).into_any_element()
        } else if row.is_dir {
            gpui::img(glyph("file-tree-icon-chevron", t.muted_foreground, !row.expanded, cx)).size(lane * 0.85).flex_none().into_any_element()
        } else {
            file_type_icon(&row.path, lane, t.muted_foreground, cx).into_any_element()
        };
        let label: SharedString = if is_scratchpads { "scratchpads".into() } else { row.label.clone().into() };
        let content: AnyElement = match (&self.edit, row.renaming) {
            (Some(edit), true) => div().flex_1().min_w_0().text_size(t.text_sm).child(Input::new(&edit.input).small().text_size(t.text_sm)).into_any_element(),
            _ => div()
                .flex_1()
                .min_w_0()
                .truncate()
                .when(is_app_dir, |d| d.opacity(0.65).italic())
                .child(label.clone())
                .into_any_element(),
        };

        // Indent guides: one rule per ancestor level, through its lane.
        let guides = (0..row.depth).map(|level| {
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left(pad + indent * level as f32 + lane / 2.)
                .w(px(1.))
                .bg(t.border)
        });

        let hover_path = row.path.clone();
        let is_dir = row.is_dir;
        let click_row = row.clone();
        let menu_row = row.clone();
        let weak = cx.entity().downgrade();
        let drag_paths = {
            let entry = self.entry.borrow();
            let sel = entry.model.selected_paths();
            if sel.contains(&row.path) { sel } else { vec![row.path.clone()] }
        };
        let workspace = self.root().to_string();
        let can_rename = movable;
        let selected = row.selected;
        // Keyboard focus away from the selection gets trees' focus ring.
        let focused = row.focused && !row.selected && self.focus.is_focused(window);

        div()
            .id(("tree-row", ix))
            .relative()
            .w_full()
            .flex()
            .items_center()
            .h(row_h)
            .pl(pad + indent * row.depth as f32)
            .pr(pad)
            .gap(rem(GAP_REM))
            .rounded(t.radius_md)
            .text_size(t.text_sm)
            .text_color(fg)
            .cursor_pointer()
            .when(selected, |d| d.bg(t.accent))
            .when(!selected, |d| d.hover(|s| s.bg(t.accent_hover)))
            .when(focused, |d| d.border_1().border_color(t.ring.opacity(0.5)))
            .when(drop_highlight, |d| d.bg(t.accent).border_1().border_color(t.ring))
            .children(guides)
            .child(lead)
            .child(content)
            .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                if this.edit.is_some() && !click_row.renaming {
                    this.commit_edit(window, cx);
                }
                if !click_row.renaming {
                    this.on_row_click(&click_row, event, window, cx);
                }
            }))
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                if *hovered {
                    this.on_row_hover(&hover_path, is_dir, cx);
                }
            }))
            .when(movable && !row.renaming, |d| {
                let label = label.clone();
                d.on_drag(DraggedTreeRows { workspace, paths: drag_paths, label: label.clone() }, move |_, _, _, cx| {
                    cx.new(|_| DragPreview(label.clone()))
                })
            })
            .on_drop(cx.listener({
                let dir = drop_dir.clone();
                move |this, dragged: &DraggedTreeRows, _, cx| {
                    this.drop_rows(dragged, &dir, cx);
                    cx.stop_propagation();
                }
            }))
            .on_drop(cx.listener({
                let dir = drop_dir;
                move |this, paths: &ExternalPaths, _, cx| {
                    this.drop_external(paths, &dir, cx);
                    cx.stop_propagation();
                }
            }))
            .context_menu(move |menu, _, _| {
                let w = weak.clone();
                let row = menu_row.clone();
                let mut menu = menu;
                let entry = |label: &'static str, icon_name: &'static str, f: Rc<dyn Fn(&mut FileTreePanel, &TreeRow, &mut Window, &mut Context<FileTreePanel>)>| {
                    let w = w.clone();
                    let row = row.clone();
                    PopupMenuItem::new(label).icon(Icon::empty().path(format!("icons/{icon_name}.svg"))).on_click(move |_, window, cx| {
                        let _ = w.update(cx, |this, cx| f(this, &row, window, cx));
                    })
                };
                if !row.is_dir {
                    menu = menu.item(entry("Open in New Tab", "arrow-up-right", Rc::new(|this, row, _, _| {
                        this.open_file(&row.path, Some(OpenFileIntent::NewTab))
                    })));
                }
                if row.is_dir {
                    menu = menu
                        .item(entry("New File", "file-plus", Rc::new(|this, row, window, cx| this.start_create(&row.path, false, window, cx))))
                        .item(entry("New Folder", "folder-plus", Rc::new(|this, row, window, cx| this.start_create(&row.path, true, window, cx))));
                }
                if !is_protected_tree_path(&row.path) {
                    menu = menu
                        .item(entry("Rename", "pencil", Rc::new(|this, row, window, cx| this.start_rename(&row.path, window, cx))).disabled(!can_rename))
                        .separator()
                        .item(entry("Delete", "trash", Rc::new(|this, row, window, cx| this.confirm_delete(&row.path, window, cx))));
                }
                menu
            })
            .into_any_element()
    }
}

fn sort_icon_name(order: SortOrder) -> &'static str {
    match order {
        SortOrder::NameAsc => "arrow-down-a-z",
        SortOrder::NameDesc => "arrow-up-z-a",
        SortOrder::DateModified => "calendar-arrow-down",
    }
}

impl Render for FileTreePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync(window, cx);
        let count = self.entry.borrow().model.visible_count();
        let t = tokens(cx).clone();
        let root = div()
            .id("file-tree")
            .key_context("FileTree")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .min_h_0()
            .text_color(t.foreground)
            // A press outside the tree ends the inline entry
            // (`tree-inline-edit`), so the press lands where it was aimed.
            .on_mouse_down_out(cx.listener(|this, _, window, cx| {
                if this.edit.is_some() {
                    this.commit_edit(window, cx);
                }
            }))
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if this.edit.is_some() && event.keystroke.key == "escape" {
                    this.cancel_edit(window, cx);
                    cx.stop_propagation();
                }
            }));
        let root = self.register_actions(root, cx);
        root.child(self.render_controls(cx)).child(
            div()
                .id("file-tree-rows")
                .flex_1()
                .min_h_0()
                .px(sp(2.))
                .when(self.drop_target.as_deref() == Some(""), |d| d.bg(t.ring.opacity(0.06)))
                // The drop target follows the pointer: the folder of the row
                // under it, the root over empty space, nothing outside.
                .on_drag_move(cx.listener(|this, e: &DragMoveEvent<DraggedTreeRows>, _, cx| {
                    let pos = e.event.position;
                    let next = if e.bounds.contains(&pos) {
                        let offset = this.scroll.0.borrow().base_handle.offset().y;
                        let ix = ((pos.y - e.bounds.origin.y - offset) / rem(ROW_HEIGHT_REM)).floor();
                        let entry = this.entry.borrow();
                        let row = (ix >= 0.).then(|| entry.model.rows().get(ix as usize).cloned()).flatten();
                        let dir = row.map(|r| this.row_drop_dir(&r)).unwrap_or_default();
                        // A target that takes none of the dragged rows (a
                        // folder into itself, a no-op move) is no target.
                        let dragged = e.drag(cx);
                        dragged.paths.iter().any(|p| drop_destination(p, &dir).is_some()).then_some(dir)
                    } else {
                        None
                    };
                    if this.drop_target != next {
                        this.drop_target = next;
                        cx.notify();
                    }
                }))
                .on_drop(cx.listener(|this, dragged: &DraggedTreeRows, _, cx| this.drop_rows(dragged, "", cx)))
                .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| this.drop_external(paths, "", cx)))
                .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| window.focus(&this.focus, cx)))
                .child(
                    uniform_list(
                        "file-tree-list",
                        count,
                        cx.processor(|this, range: std::ops::Range<usize>, window, cx| {
                            let rows: Vec<TreeRow> = this.entry.borrow().model.rows()[range.clone()].to_vec();
                            rows.into_iter().zip(range).map(|(row, ix)| this.render_row(ix, row, window, cx)).collect::<Vec<_>>()
                        }),
                    )
                    .size_full()
                    .track_scroll(&self.scroll),
                ),
        )
    }
}
