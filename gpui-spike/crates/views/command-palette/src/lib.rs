//! The command palette: a port of `components/editor/command-palette.tsx`.
//!
//! - [`init`] binds ⌘K (toggle, as TS), ⌘P (open, TS's quick switcher) and
//!   ⌘⇧P (open; the GPUI convention, not in TS).
//! - [`toggle`]`(window, cx)` / [`open`] / [`close`].
//! - Commands are the TS list ([`commands::commands`]), filtered and ranked
//!   by cmdk's `command-score` over the label and its localized keywords;
//!   each runs a GPUI action by name that its owner registers.
//! - Quick results: fuzzy file matches from every open workspace (the
//!   active one wins ties) ranked as `useFileSearch`, rendered after every
//!   command group. Selecting one opens it through
//!   [`set_open_file_handler`] (the shell routes it to the tabs module), or
//!   the `workspace::OpenFile` action with `{ "path": … }`.
//! - [`set_active_workspace`]: which workspace the palette acts on (the TS
//!   `workspacePath` prop); defaults to the first open one.
//!
//! The TS palette has no recent-documents list (that is the everything
//! panel's), so neither does this one.

pub mod commands;
pub mod score;

use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, FocusHandle, Focusable,
    FontWeight, InteractiveElement, IntoElement, KeyBinding, ParentElement, Render,
    ScrollHandle, StatefulInteractiveElement, Styled, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::WindowExt as _;
use gpui_kit::component::input::{self, Input, InputEvent, InputState};
use notefig_i18n::{t, t_args, t_list};
use notefig_ui::{CoreExt, icon, rem, sp, tokens};
use notefig_view_settings::hotkeys::format_for_display;

use commands::{Command, GROUP_ORDER};
use score::{FileResult, command_score};

gpui_kit::actions!(
    command_palette,
    [
        /// ⌘K: open or close the palette.
        Toggle,
        /// ⌘P / ⌘⇧P: open it.
        Open,
    ]
);

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-k", Toggle, None),
        KeyBinding::new("cmd-p", Open, None),
        KeyBinding::new("cmd-shift-p", Open, None),
    ]);
    cx.on_action(|_: &Toggle, cx| with_window(cx, toggle));
    cx.on_action(|_: &Open, cx| with_window(cx, open));
}

/// App-level action handlers run while the window dispatching them is
/// borrowed, so the window work is deferred until that dispatch ends.
fn with_window(cx: &mut App, f: impl FnOnce(&mut Window, &mut App) + 'static) {
    cx.defer(move |cx| {
        if let Some(w) = cx.active_window().or_else(|| cx.windows().first().copied()) {
            let _ = w.update(cx, |_, window, cx| f(window, cx));
        }
    });
}

type OpenFile = Rc<dyn Fn(&str, &mut Window, &mut App)>;

#[derive(Default)]
struct PaletteGlobal {
    open: std::collections::HashMap<gpui::WindowId, gpui::WeakEntity<Palette>>,
    active_workspace: Option<String>,
    open_file: Option<OpenFile>,
}
impl gpui::Global for PaletteGlobal {}

/// The workspace the palette acts on (TS `workspacePath`).
pub fn set_active_workspace(cx: &mut App, path: Option<String>) {
    cx.default_global::<PaletteGlobal>().active_workspace = path;
}

/// How a quick result opens (TS `tabs.open(path, { intent: "replace" })`).
pub fn set_open_file_handler(cx: &mut App, f: impl Fn(&str, &mut Window, &mut App) + 'static) {
    cx.default_global::<PaletteGlobal>().open_file = Some(Rc::new(f));
}

pub fn is_open(window: &Window, cx: &App) -> bool {
    cx.try_global::<PaletteGlobal>()
        .and_then(|g| g.open.get(&window.window_handle().window_id()))
        .is_some_and(|p| p.upgrade().is_some())
}

pub fn toggle(window: &mut Window, cx: &mut App) {
    if is_open(window, cx) { close(window, cx) } else { open(window, cx) }
}

pub fn close(window: &mut Window, cx: &mut App) {
    if is_open(window, cx) {
        cx.default_global::<PaletteGlobal>().open.remove(&window.window_handle().window_id());
        window.close_dialog(cx);
    }
}

pub fn open(window: &mut Window, cx: &mut App) {
    if is_open(window, cx) {
        return;
    }
    let palette = cx.new(|cx| Palette::new(window, cx));
    let id = window.window_handle().window_id();
    cx.default_global::<PaletteGlobal>().open.insert(id, palette.downgrade());
    let view = palette.clone();
    window.open_dialog(cx, move |dialog, window, cx| {
        let t = tokens(cx);
        let h = view.read(cx).estimated_height(cx);
        let vh = window.viewport_size().height;
        dialog
            .w(rem(32.))
            .margin_top(((vh - h) / 2.).max(px(16.)))
            .p_0()
            .gap_0()
            .bg(t.card)
            .close_button(false)
            .on_close(move |_, _, cx| {
                cx.default_global::<PaletteGlobal>().open.remove(&id);
            })
            .child(view.clone())
    });
    palette.update(cx, |p, cx| p.input.update(cx, |i, cx| i.focus(window, cx)));
}

/// One selectable row.
#[derive(Clone)]
enum Row {
    Command(Command),
    File(FileResult),
}

pub struct Palette {
    input: Entity<InputState>,
    focus: FocusHandle,
    workspace: Option<String>,
    commands: Vec<Command>,
    file_search: Rc<notefig_files::file_search::FileSearch>,
    _files_sub: notefig_core::Subscription,
    selected: usize,
    scroll: ScrollHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for Palette {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Palette {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let core = cx.core();
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(t("typeCommand")));
        let subs = vec![cx.subscribe(&input, |this, _, e: &InputEvent, cx| match e {
            InputEvent::Change => {
                this.selected = 0;
                this.scroll.scroll_to_item(0);
                cx.notify();
            }
            InputEvent::PressEnter { .. } => {}
            _ => {}
        })];
        let workspaces = core.workspaces().list();
        let workspace = cx
            .try_global::<PaletteGlobal>()
            .and_then(|g| g.active_workspace.clone())
            .or_else(|| core.try_use::<notefig_workspaces::WorkspacesModule>().and_then(|w| w.focused()))
            .or_else(|| workspaces.first().map(|w| w.path.clone()));
        let feedback = core.try_use::<notefig_feedback::FeedbackModule>().is_some_and(|f| f.available());
        // `useFileSearch`: the files module's rows of every open workspace,
        // re-ranked when they change.
        let file_search = Rc::new(notefig_files::file_search::FileSearch::new());
        let files_sub = notefig_files::file_search::subscribe_searched_workspaces(&core, {
            let (tx, rx) = async_channel::bounded::<()>(1);
            cx.spawn(async move |this, cx| {
                while rx.recv().await.is_ok() {
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            })
            .detach();
            move || {
                let _ = tx.try_send(());
            }
        });
        Self {
            input,
            focus: cx.focus_handle(),
            workspace,
            commands: commands::commands(feedback),
            file_search,
            _files_sub: files_sub,
            selected: 0,
            scroll: ScrollHandle::new(),
            _subs: subs,
        }
    }

    pub fn query(&self, cx: &App) -> String {
        self.input.read(cx).value().to_string()
    }

    /// The groups to show: `(group, rows)` in [`GROUP_ORDER`], each group's
    /// commands ranked by score (stable), then the file results.
    fn groups(&self, cx: &App) -> Vec<(&'static str, Vec<Row>)> {
        let query = self.query(cx);
        let search = query.trim();
        let mut out = Vec::new();
        for group in GROUP_ORDER {
            if *group == "navigation" {
                let files = self.files(search, cx);
                if !files.is_empty() {
                    out.push((*group, files.into_iter().map(Row::File).collect()));
                }
                continue;
            }
            let mut scored: Vec<(f64, &Command)> = self
                .commands
                .iter()
                .filter(|c| c.group == *group)
                .map(|c| {
                    let score = if search.is_empty() { 1. } else { command_score(&t(c.label_key), search, &t_list(c.keyword_key)) };
                    (score, c)
                })
                .filter(|(s, _)| *s > 0.)
                .collect();
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            if !scored.is_empty() {
                out.push((*group, scored.into_iter().map(|(_, c)| Row::Command(c.clone())).collect()));
            }
        }
        out
    }

    /// Input row plus the list (`max-h` 450px), for centering the dialog.
    pub fn estimated_height(&self, cx: &App) -> gpui::Pixels {
        let groups = self.groups(cx);
        let rows: usize = groups.iter().map(|(_, r)| r.len()).sum();
        let list = if rows == 0 {
            sp(6.) * 2. + tokens(cx).text_sm * 1.5
        } else {
            (sp(1.) + tokens(cx).text_sm * 1.5 + sp(3.)) * rows as f32 + (tokens(cx).text_xs * 1.5 + sp(3.)) * groups.len() as f32
        };
        sp(12.) + list.min(px(450.)) + px(2.)
    }

    fn rows(&self, cx: &App) -> Vec<Row> {
        self.groups(cx).into_iter().flat_map(|(_, r)| r).collect()
    }

    fn run(&mut self, row: Row, window: &mut Window, cx: &mut Context<Self>) {
        close(window, cx);
        match row {
            Row::Command(c) => {
                if c.id == "toggle-fullscreen" {
                    window.toggle_fullscreen();
                    return;
                }
                let action = c.actions.iter().find_map(|name| cx.build_action(name, None).ok());
                match action {
                    Some(action) => window.defer(cx, move |window, cx| window.dispatch_action(action, cx)),
                    None => log::warn!("palette: no action registered for {}", c.id),
                }
            }
            Row::File(f) => {
                let handler = cx.try_global::<PaletteGlobal>().and_then(|g| g.open_file.clone());
                let path = f.path.clone();
                window.defer(cx, move |window, cx| match handler {
                    Some(h) => h(&path, window, cx),
                    None => {
                        if let Ok(action) = cx.build_action("workspace::OpenFile", Some(serde_json::json!({ "path": path }))) {
                            window.dispatch_action(action, cx);
                        }
                    }
                });
            }
        }
    }

    fn on_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let n = self.rows(cx).len();
        match key {
            "down" if n > 0 => {
                self.selected = (self.selected + 1) % n;
                self.scroll.scroll_to_item(self.selected);
            }
            "up" if n > 0 => {
                self.selected = (self.selected + n - 1) % n;
                self.scroll.scroll_to_item(self.selected);
            }
            "enter" => {
                if let Some(row) = self.rows(cx).get(self.selected).cloned() {
                    self.run(row, window, cx);
                }
            }
            "escape" => close(window, cx),
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn item(&self, ix: usize, row: &Row, dim: bool, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let selected = ix == self.selected;
        let r = row.clone();
        let base = div()
            .id(ElementId::Name(format!("palette-row-{ix}").into()))
            .flex()
            .items_center()
            .gap(sp(2.))
            .px(sp(2.))
            .py(sp(1.5))
            .rounded(tk.radius_sm)
            .text_size(tk.text_sm)
            .cursor_pointer()
            .when(selected, |d| d.bg(tk.accent).text_color(tk.accent_foreground))
            .when(dim && !selected, |d| d.opacity(0.6))
            .on_mouse_move(cx.listener(move |this, _, _, cx| {
                if this.selected != ix {
                    this.selected = ix;
                    cx.notify();
                }
            }))
            .on_click(cx.listener(move |this, _, window, cx| this.run(r.clone(), window, cx)));
        match row {
            Row::Command(c) => base
                .child(icon(c.icon).size(rem(1.)).text_color(tk.muted_foreground))
                .child(div().flex_1().child(t(c.label_key)))
                .when_some(c.shortcut, |d, s| {
                    let shown = if s.contains("Mod") || s.contains('+') { format_for_display(s) } else { s.to_string() };
                    d.child(div().ml_auto().text_size(tk.text_xs).text_color(tk.muted_foreground).child(spaced(&shown)))
                })
                .into_any_element(),
            Row::File(f) => {
                let folder = f.relative_path.rfind('/').map(|i| f.relative_path[..i].to_string()).unwrap_or_default();
                let show_ws = self.files_from_elsewhere(cx);
                let ws_name = f.workspace_path.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
                let icon = notefig_view_file_tree::file_type_icon(&f.path, rem(1.), tk.muted_foreground, cx);
                base.child(icon)
                    .child(div().flex_none().max_w(px(280.)).truncate().child(f.title.clone()))
                    .when(!folder.is_empty(), |d| {
                        // Truncated from the start (TS `dir="rtl"`), so the
                        // folders nearest the file stay in view.
                        d.child(
                            div()
                                .ml_auto()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_size(tk.text_xs)
                                .text_color(tk.muted_foreground)
                                .child(truncate_start(&folder, 44)),
                        )
                    })
                    .when(show_ws, |d| {
                        d.child(
                            div()
                                .when(folder.is_empty(), |d| d.ml_auto())
                                .flex_none()
                                .truncate()
                                .text_size(tk.text_xs)
                                .text_color(tk.muted_foreground.opacity(0.7))
                                .child(ws_name),
                        )
                    })
                    .into_any_element()
            }
        }
    }

    fn files_from_elsewhere(&self, cx: &App) -> bool {
        let query = self.query(cx);
        self.files(query.trim(), cx).iter().any(|f| Some(f.workspace_path.as_str()) != self.workspace.as_deref())
    }

    /// `useFileSearch(query, { filter: canOpenFile, preferWorkspace })`.
    fn files(&self, query: &str, cx: &App) -> Vec<FileResult> {
        if query.is_empty() {
            return Vec::new();
        }
        let workspaces = notefig_files::file_search::searched_workspaces(&cx.core());
        let options = notefig_files::file_score::FileSearchOptions {
            limit: None,
            filter: Some(Rc::new(notefig_editors::can_open_file)),
            match_all_when_empty: false,
        };
        self.file_search
            .search(&workspaces, query, &options, self.workspace.as_deref())
            .into_iter()
            .map(|r| FileResult {
                path: r.result.path,
                relative_path: r.result.relative_path,
                title: r.result.title,
                workspace_path: r.workspace_path,
                score: r.result.score,
            })
            .collect()
    }
}

/// `…` and the last `max` characters.
fn truncate_start(text: &str, max: usize) -> String {
    let n = text.chars().count();
    if n <= max {
        return text.to_string();
    }
    format!("…{}", text.chars().skip(n - max + 1).collect::<String>())
}

/// `CommandShortcut`'s `tracking-widest`, approximated with hair spaces.
fn spaced(s: &str) -> String {
    let chars: Vec<String> = s.chars().map(|c| c.to_string()).collect();
    chars.join("\u{200A}")
}

impl Render for Palette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tk = tokens(cx).clone();
        let groups = self.groups(cx);
        let query = self.query(cx);
        let total: usize = groups.iter().map(|(_, r)| r.len()).sum();
        if self.selected >= total {
            self.selected = 0;
        }
        let dim = total > 0;
        let mut children: Vec<AnyElement> = Vec::new();
        let mut ix = 0;
        for (gi, (group, rows)) in groups.iter().enumerate() {
            if gi > 0 {
                children.push(div().h(px(1.)).bg(tk.border).into_any_element());
            }
            let heading = if *group == "navigation" {
                t_args("quickResultsFor", &[("query", query.trim())])
            } else {
                t(group)
            };
            let mut items = vec![
                div()
                    .px(sp(2.))
                    .py(sp(1.5))
                    .text_size(tk.text_xs)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(tk.muted_foreground)
                    .child(heading)
                    .into_any_element(),
            ];
            for row in rows {
                items.push(self.item(ix, row, dim, cx));
                ix += 1;
            }
            children.push(div().px(sp(2.)).pb(sp(1.)).children(items).into_any_element());
        }
        div()
            .id("command-palette")
            .key_context("CommandPalette")
            .track_focus(&self.focus)
            // The input binds these keys to its own actions; take them first.
            .capture_action(cx.listener(|this, _: &input::MoveDown, w, cx| this.on_key("down", w, cx)))
            .capture_action(cx.listener(|this, _: &input::MoveUp, w, cx| this.on_key("up", w, cx)))
            .capture_action(cx.listener(|this, _: &input::Enter, w, cx| this.on_key("enter", w, cx)))
            .capture_action(cx.listener(|this, _: &input::Escape, w, cx| this.on_key("escape", w, cx)))
            .flex()
            .flex_col()
            .w_full()
            .line_height(rem(1.25))
            .text_color(tk.popover_foreground)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(sp(2.))
                    .h(sp(12.))
                    .px(sp(3.))
                    .border_b_1()
                    .border_color(tk.border)
                    .child(icon("search").size(rem(1.25)).text_color(tk.muted_foreground).opacity(0.8))
                    .child(div().flex_1().min_w_0().child(Input::new(&self.input).appearance(false).text_size(tk.text_sm)))
                    .child(
                        div()
                            .id("palette-close")
                            .p(sp(1.))
                            .rounded(px(4.))
                            .cursor_pointer()
                            .hover(|s| s.bg(tk.accent))
                            .child(icon("x").size(rem(1.)).text_color(tk.muted_foreground))
                            .on_click(|_, window, cx| close(window, cx)),
                    ),
            )
            .child(
                div()
                    .id("palette-list")
                    .max_h(px(450.))
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .py(sp(1.))
                    .children(children)
                    .when(total == 0, |d| {
                        d.child(div().py(sp(6.)).text_center().text_size(tk.text_sm).child(t("noResults")))
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_every_ts_command_with_a_label_and_keywords() {
        let all = commands::commands(true);
        assert_eq!(all.len(), 16);
        for c in &all {
            assert!(notefig_i18n::has_key(c.label_key), "{}", c.label_key);
            assert!(!t_list(c.keyword_key).is_empty(), "{}", c.keyword_key);
        }
        assert_eq!(commands::commands(false).len(), 15, "Send Feedback only with a support URL");
    }

}
