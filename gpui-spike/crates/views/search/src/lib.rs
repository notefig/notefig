//! The sidebar's Search tab: a port of `components/editor/search-panel.tsx`
//! and `hooks/use-search.ts`.
//!
//! [`SearchPanel::new`]`(ws, window, cx)` is the contract the shell
//! composes. Typing searches the workspace (debounced 300 ms) through the
//! platform's `fs.search_content` with the app's ignore rules, as
//! `useSearch` does; matches stream in grouped by file. The case toggle,
//! the file filter (`*.md`), clear, collapse per file and the result count
//! follow TS. Clicking a match emits [`SearchPanelEvent::OpenMatch`]; the
//! app routes it to `tabs.reveal(path, match, { intent })` as TS's
//! `handleMatchClick` does (⌘-click opens a new tab). The search
//! re-runs when the workspace's files change (`files:changed`, where TS
//! invalidates the `search-content` query).
//!
//! [`SearchPanel::focus_input`] is `SearchPanelHandle.focusInput` (⌘⇧F, and
//! "search in this folder" with a file pattern).

pub mod results;

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use notefig_core::WorkspaceHandle;
use notefig_i18n::{t, t_args, t_count};
use notefig_platform::{PlatformService, SearchMatch, SearchOptions};
use notefig_ui::{CoreExt, IconButton, icon, rem, sp, tokens};

pub use results::{file_name, group_by_file, project_name, segments};

/// `useSearch`'s debounce.
pub const SEARCH_DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Debug, Clone)]
pub enum SearchPanelEvent {
    /// Open `file_path` at the match. `new_tab` when ⌘ was held
    /// (`intent: "new-tab"`), else `"replace"`.
    OpenMatch { m: SearchMatch, new_tab: bool },
}

pub struct SearchPanel {
    ws: WorkspaceHandle,
    focus: FocusHandle,
    query: Entity<InputState>,
    file_pattern: Entity<InputState>,
    case_sensitive: bool,
    show_filters: bool,
    collapsed: HashSet<String>,
    results: Rc<RefCell<Vec<SearchMatch>>>,
    /// The query the results are for.
    searched: String,
    searching: bool,
    error: Option<SharedString>,
    task: Option<Task<()>>,
    _subs: Vec<Subscription>,
    _files_changed: Option<notefig_core::Subscription>,
}

impl EventEmitter<SearchPanelEvent> for SearchPanel {}

impl Focusable for SearchPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl SearchPanel {
    pub fn new(ws: WorkspaceHandle, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = project_name(ws.path());
        let query = cx.new(|cx| InputState::new(window, cx).placeholder(t_args("searchIn", &[("workspace", &name)])));
        let file_pattern = cx.new(|cx| InputState::new(window, cx).placeholder(t("fileFilterPlaceholder")));
        let subs = vec![
            cx.subscribe(&query, |this, _, e: &InputEvent, cx| {
                if matches!(e, InputEvent::Change) {
                    this.schedule(cx);
                }
            }),
            cx.subscribe(&file_pattern, |this, _, e: &InputEvent, cx| {
                if matches!(e, InputEvent::Change) {
                    this.schedule(cx);
                }
            }),
        ];
        // Revalidate on file changes in this workspace.
        let (tx, rx) = async_channel::bounded::<()>(1);
        let path = ws.path().to_string();
        let files_changed = cx.core().hooks().on::<notefig_files::FilesChanged, _>(move |e| {
            if e.workspace_path == path {
                let _ = tx.try_send(());
            }
        });
        cx.spawn(async move |this, cx| {
            while rx.recv().await.is_ok() {
                if this.update(cx, |this, cx| this.rerun(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            ws,
            focus: cx.focus_handle(),
            query,
            file_pattern,
            case_sensitive: false,
            show_filters: false,
            collapsed: HashSet::new(),
            results: Rc::default(),
            searched: String::new(),
            searching: false,
            error: None,
            task: None,
            _subs: subs,
            _files_changed: Some(files_changed),
        }
    }

    /// Search again with the same inputs (files changed under it).
    fn rerun(&mut self, cx: &mut Context<Self>) {
        if !self.query(cx).trim().is_empty() {
            self.schedule(cx);
        }
    }

    pub fn query(&self, cx: &App) -> String {
        self.query.read(cx).value().to_string()
    }

    /// Matches so far (`resultCount`) and the files they are in.
    pub fn counts(&self) -> (usize, usize) {
        let results = self.results.borrow();
        let files: HashSet<&str> = results.iter().map(|m| m.file_path.as_str()).collect();
        (results.len(), files.len())
    }

    pub fn is_searching(&self) -> bool {
        self.searching
    }

    /// `focusInput`: focus and select the query; set the file filter (a
    /// folder search) or clear it (a global search).
    pub fn focus_input(&mut self, file_pattern: Option<&str>, initial_query: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(q) = initial_query {
            self.query.update(cx, |s, cx| s.set_value(q.to_string(), window, cx));
        }
        match file_pattern.filter(|p| !p.is_empty()) {
            Some(p) => {
                self.file_pattern.update(cx, |s, cx| s.set_value(p.to_string(), window, cx));
                self.show_filters = true;
            }
            None => {
                self.file_pattern.update(cx, |s, cx| s.set_value("", window, cx));
                self.show_filters = false;
            }
        }
        self.query.update(cx, |s, cx| {
            s.focus(window, cx);
            s.select_all(window, cx);
        });
        self.schedule(cx);
    }

    fn set_case(&mut self, on: bool, cx: &mut Context<Self>) {
        self.case_sensitive = on;
        self.schedule(cx);
    }

    /// Re-run the search after the debounce, cancelling one in flight.
    fn schedule(&mut self, cx: &mut Context<Self>) {
        self.task = None;
        let query = self.query(cx).trim().to_string();
        if query.is_empty() {
            self.results.borrow_mut().clear();
            self.searched.clear();
            self.searching = false;
            self.error = None;
            cx.notify();
            return;
        }
        let pattern = self.file_pattern.read(cx).value().trim().to_string();
        let options = SearchOptions {
            query: query.clone(),
            use_regex: false,
            case_sensitive: self.case_sensitive,
            file_pattern: (!pattern.is_empty()).then_some(pattern),
            ignore: Some(results::ignore_rules()),
            ..Default::default()
        };
        let platform = cx.core().service::<PlatformService>();
        let dir = self.ws.path().to_string();
        self.task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SEARCH_DEBOUNCE).await;
            let found: Rc<RefCell<Vec<SearchMatch>>> = Rc::default();
            let (tx, rx) = async_channel::unbounded::<()>();
            let sink = found.clone();
            let search = platform.fs.search_content(
                &dir,
                options,
                Box::new(move |m| {
                    sink.borrow_mut().push(m);
                    let _ = tx.try_send(());
                }),
            );
            let _ = this.update(cx, |this, cx| {
                this.searching = true;
                cx.notify();
            });
            // Keep the previous results until the first new batch (TS keeps
            // `placeholderData`), then stream.
            let pump = {
                let found = found.clone();
                let this = this.clone();
                let mut cx = cx.clone();
                async move {
                    while rx.recv().await.is_ok() {
                        while rx.try_recv().is_ok() {}
                        let snapshot = found.borrow().clone();
                        if this
                            .update(&mut cx, |this, cx| {
                                *this.results.borrow_mut() = snapshot;
                                cx.notify();
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            };
            let result = futures::future::join(search, pump).await.0;
            let _ = this.update(cx, |this, cx| {
                *this.results.borrow_mut() = found.borrow().clone();
                this.searched = query;
                this.searching = false;
                this.error = result.err().map(|e| SharedString::from(e.to_string()));
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn toggle_collapsed(&mut self, path: String, cx: &mut Context<Self>) {
        if !self.collapsed.remove(&path) {
            self.collapsed.insert(path);
        }
        cx.notify();
    }

    fn result_row(&self, ix: usize, m: &SearchMatch, query: &str, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx);
        let segs = segments(&m.line_text, query, self.case_sensitive);
        let highlight = gpui::HighlightStyle {
            background_color: Some(tk.highlight.opacity(0.7)),
            color: Some(tk.foreground),
            ..Default::default()
        };
        let mut ranges = Vec::new();
        let mut at = 0;
        for (text, hl) in &segs {
            if *hl {
                ranges.push((at..at + text.len(), highlight));
            }
            at += text.len();
        }
        let line = gpui::StyledText::new(m.line_text.clone()).with_highlights(ranges);
        let m = m.clone();
        div()
            .id(ElementId::Name(format!("search-match-{}-{}-{ix}", m.file_path, m.line).into()))
            .flex()
            .items_center()
            .w_full()
            .pl(sp(7.))
            .pr(sp(2.))
            .py(sp(0.5))
            .text_size(tk.text_sm)
            .cursor_pointer()
            .hover(|s| s.bg(tk.accent.opacity(0.5)))
            .child(div().min_w_0().truncate().child(line))
            .on_click(cx.listener(move |_, e: &gpui::ClickEvent, _, cx| {
                let new_tab = e.modifiers().platform || e.modifiers().control;
                cx.emit(SearchPanelEvent::OpenMatch { m: m.clone(), new_tab });
            }))
            .into_any_element()
    }
}

impl Render for SearchPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tk = tokens(cx).clone();
        let query = self.query(cx);
        let has_query = !query.trim().is_empty();
        let groups = group_by_file(&self.results.borrow());
        let (result_count, file_count) = self.counts();
        let case = self.case_sensitive;
        let input = div()
            .flex()
            .h(sp(6.))
            .min_w_0()
            .flex_1()
            .items_center()
            .gap(sp(1.5))
            .rounded(tk.radius_md)
            .border_1()
            .border_color(tk.input)
            .bg(tk.background)
            .px(sp(2.))
            .text_size(tk.text_xs)
            .child(icon("search").size(sp(3.5)).text_color(tk.muted_foreground))
            .child(div().flex_1().min_w_0().child(Input::new(&self.query).appearance(false).text_size(tk.text_xs)))
            .child(
                div()
                    .id("search-case")
                    .flex_none()
                    .p(sp(0.5))
                    .rounded(px(4.))
                    .cursor_pointer()
                    .when(case, |d| d.bg(tk.accent).text_color(tk.accent_foreground))
                    .when(!case, |d| d.text_color(tk.muted_foreground).hover(|s| s.text_color(tk.foreground)))
                    .child(icon("case-sensitive").size(rem(1.)).text_color(if case { tk.accent_foreground } else { tk.muted_foreground }))
                    .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new(t("matchCase")).build(window, cx))
                    .on_click(cx.listener(move |this, _, _, cx| this.set_case(!case, cx))),
            )
            .when(!query.is_empty(), |d| {
                d.child(
                    div()
                        .id("search-clear")
                        .flex_none()
                        .p(sp(0.5))
                        .rounded(px(4.))
                        .cursor_pointer()
                        .text_color(tk.muted_foreground)
                        .hover(|s| s.text_color(tk.foreground))
                        .child(icon("x").size(sp(3.5)).text_color(tk.muted_foreground))
                        .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new(t("clearSearch")).build(window, cx))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.query.update(cx, |s, cx| s.set_value("", window, cx));
                            this.schedule(cx);
                        })),
                )
            });
        let filters = self.show_filters;
        let toolbar = div()
            .flex_none()
            .child(
                div()
                    .flex()
                    .h(sp(9.))
                    .items_center()
                    .gap(sp(1.))
                    .px(sp(2.))
                    .child(input)
                    .child(
                        IconButton::with_content(
                            "search-filters",
                            icon("sliders-horizontal")
                                .size(rem(1.))
                                .text_color(if filters { tk.accent_foreground } else { tk.muted_foreground })
                                .into_any_element(),
                        )
                        .size(sp(7.), sp(7.))
                            .pressed(filters)
                            .tooltip(t("toggleFilters"))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.show_filters = !filters;
                                if filters {
                                    this.file_pattern.update(cx, |s, cx| s.set_value("", window, cx));
                                    this.schedule(cx);
                                }
                                cx.notify();
                            })),
                    ),
            )
            .when(filters, |d| {
                d.child(
                    div().px(sp(2.)).pb(sp(1.5)).child(
                        div()
                            .h(sp(6.))
                            .flex()
                            .items_center()
                            .rounded(tk.radius_md)
                            .border_1()
                            .border_color(tk.input)
                            .bg(tk.background)
                            .px(sp(2.))
                            .child(Input::new(&self.file_pattern).appearance(false).text_size(tk.text_xs)),
                    ),
                )
            });
        let status = has_query.then(|| {
            let text = if self.searching {
                format!("{}...", t("searching"))
            } else {
                format!("{} {}", t_count("searchResultCount", result_count as i64), t_count("searchFileCount", file_count as i64))
            };
            div().flex().items_center().px(sp(2.)).py(sp(1.)).text_size(tk.text_xs).text_color(tk.muted_foreground).child(text)
        });
        let mut rows: Vec<AnyElement> = Vec::new();
        let highlight_query = if self.searched.is_empty() { query.clone() } else { self.searched.clone() };
        for (path, matches) in &groups {
            let collapsed = self.collapsed.contains(path);
            let p = path.clone();
            rows.push(
                div()
                    .id(ElementId::Name(format!("search-file-{path}").into()))
                    .flex()
                    .items_center()
                    .w_full()
                    .gap(sp(1.))
                    .px(sp(2.))
                    .py(sp(1.))
                    .text_size(tk.text_sm)
                    .cursor_pointer()
                    .hover(|s| s.bg(tk.accent.opacity(0.5)))
                    .child(icon(if collapsed { "chevron-right" } else { "chevron-down" }).size(sp(3.5)).text_color(tk.muted_foreground))
                    .child(div().flex_1().min_w_0().truncate().child(file_name(path).to_string()))
                    .child(div().flex_none().text_size(tk.text_xs).text_color(tk.muted_foreground).child(matches.len().to_string()))
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle_collapsed(p.clone(), cx)))
                    .into_any_element(),
            );
            if !collapsed {
                for (ix, m) in matches.iter().enumerate() {
                    rows.push(self.result_row(ix, m, &highlight_query, cx));
                }
            }
        }
        let empty = !self.searching && has_query && result_count == 0 && self.error.is_none() && !self.searched.is_empty();
        div()
            .id("search-panel")
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .size_full()
            .line_height(rem(1.25))
            .text_color(tk.foreground)
            .child(toolbar)
            .children(status)
            .when_some(self.error.clone(), |d, e| d.child(div().px(sp(2.)).py(sp(1.)).text_size(tk.text_xs).text_color(tk.destructive).child(e)))
            .child(
                div()
                    .id("search-results")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(rows)
                    .when(empty, |d| {
                        d.child(div().px(sp(2.)).py(sp(4.)).text_size(tk.text_sm).text_color(tk.muted_foreground).text_center().child(t("noResultsFound")))
                    }),
            )
    }
}

gpui_kit::actions!(search_panel, [
    /// ⌘⇧F: focus the Search tab's input (the shell shows the tab).
    FocusSearch
]);

pub fn init(cx: &mut App) {
    // ⌘⇧F belongs to the shell (it switches the sidebar to Search, then
    // calls `focus_input`); nothing is bound here.
    let _ = cx;
}
