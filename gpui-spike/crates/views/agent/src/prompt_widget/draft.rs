//! The widget's mini composer: a port of `prompt/composer/*`
//! (`prompt-editor.tsx`, `mention-suggestion.ts`, `mention-menu.tsx`,
//! `draft-text.ts`). A one-line rich field: `@` opens the suggestion —
//! directives first (`model:`, `skill:`), then workspace files — and a pick
//! becomes a mention chip, written as `@path` in the draft text.
//!
//! Deviation: in TS the draft is document content (the widget node's
//! `promptDraft` child), so the caret in a prompt is an ordinary document
//! selection. The Rust editor's widget is an atom node with a node view, so
//! the draft is its own small editor (`BlockEditorState`, Enter submits),
//! kept by the widget view; the document never holds the draft.
//!
//! The search and the directive registry are the chat composer's
//! (`crate::composer`), shared as in TS.

use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement, IntoElement, MouseButton, ParentElement, Render, SharedString, Styled, Subscription,
    Window, div, prelude::FluentBuilder as _,
};
use markdown_editor::{BlockEditor, BlockEditorEvent, BlockEditorState, SubmitPolicy};
use notefig_ui::{CoreExt as _, icon, sp, tokens};

use crate::composer::{DirectiveRow, MentionFile, MentionRow, SUGGESTION_LIMIT, search_directives, sources_for};
use crate::style::{self, PopoverSide};

/// What the field tells the widget.
pub enum DraftEvent {
    /// Enter with no suggestion open.
    Submit,
    /// The text changed (emptiness, live drafts).
    Changed,
    Focus,
    Blur,
}

struct MentionMenu {
    rows: Vec<MentionRow>,
    selected: usize,
    /// Bytes of `@query` before the caret.
    token_len: usize,
}

pub struct DraftField {
    pub editor: Entity<BlockEditorState>,
    workspace_path: String,
    /// The session (and its harness) directives resolve against.
    target: Option<(String, String)>,
    menu: Option<MentionMenu>,
    text_size: gpui::Pixels,
    applying: bool,
    _subs: Vec<Subscription>,
}

impl EventEmitter<DraftEvent> for DraftField {}

impl Focusable for DraftField {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.editor.focus_handle(cx)
    }
}

impl DraftField {
    pub fn new(workspace_path: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| {
            let mut state = BlockEditorState::new(window, cx).with_submit_policy(SubmitPolicy::Enter);
            state.set_slash_trigger(false);
            state
        });
        let subs = vec![cx.subscribe_in(&editor, window, Self::on_editor_event)];
        Self {
            editor,
            workspace_path,
            target: None,
            menu: None,
            text_size: tokens(cx).text_sm,
            applying: false,
            _subs: subs,
        }
    }

    /// The session prompts go to, and its harness (directive sources).
    pub fn set_target(&mut self, task_id: Option<String>, harness_id: String) {
        self.target = Some((task_id.unwrap_or_default(), harness_id));
    }

    pub fn set_placeholder(&mut self, text: String, cx: &mut Context<Self>) {
        let text: SharedString = text.into();
        self.editor.update(cx, |e, cx| e.set_placeholder(Some(text), cx));
    }

    pub fn set_text_size(&mut self, size: gpui::Pixels, cx: &mut Context<Self>) {
        if self.text_size != size {
            self.text_size = size;
            cx.notify();
        }
    }

    pub fn set_editable(&mut self, editable: bool, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| e.set_readonly(!editable, cx));
    }

    /// The draft as sent: mentions as `@path`.
    pub fn text(&self, cx: &App) -> String {
        self.editor.read(cx).source().trim_end_matches('\n').to_string()
    }

    pub fn is_empty(&self, cx: &App) -> bool {
        self.text(cx).trim().is_empty()
    }

    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.applying = true;
        self.editor.update(cx, |e, cx| {
            let _ = e.set_source(text, cx);
            let _ = e.select_end(cx);
        });
        self.applying = false;
        self.menu = None;
        cx.emit(DraftEvent::Changed);
        cx.notify();
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.editor.update(cx, |e, cx| e.focus(window, cx));
    }

    pub fn is_focused(&self, window: &Window, cx: &App) -> bool {
        self.editor.focus_handle(cx).contains_focused(window, cx)
    }

    /// Whether the suggestion list is open with rows (it takes ↑/↓/Enter/Esc).
    pub fn menu_open(&self) -> bool {
        self.menu.as_ref().is_some_and(|m| !m.rows.is_empty())
    }

    /// A key the suggestion list takes: true when consumed.
    pub fn menu_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(menu) = self.menu.as_mut().filter(|m| !m.rows.is_empty()) else { return false };
        match key {
            "up" => menu.selected = (menu.selected + menu.rows.len() - 1) % menu.rows.len(),
            "down" => menu.selected = (menu.selected + 1) % menu.rows.len(),
            "tab" | "enter" => {
                self.accept(window, cx);
                return true;
            }
            "escape" => self.menu = None,
            _ => return false,
        }
        cx.notify();
        true
    }

    fn on_editor_event(&mut self, _: &Entity<BlockEditorState>, event: &BlockEditorEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            BlockEditorEvent::SubmitRequested => {
                if self.menu_open() {
                    self.accept(window, cx);
                } else {
                    cx.emit(DraftEvent::Submit);
                }
            }
            BlockEditorEvent::Changed { .. } => {
                self.refresh_menu(cx);
                if !self.applying {
                    cx.emit(DraftEvent::Changed);
                }
                cx.notify();
            }
            BlockEditorEvent::SelectionChanged => self.refresh_menu(cx),
            BlockEditorEvent::Focus => cx.emit(DraftEvent::Focus),
            BlockEditorEvent::Blur => {
                self.menu = None;
                cx.emit(DraftEvent::Blur);
                cx.notify();
            }
            _ => {}
        }
    }

    /// The `@query` right before the caret.
    fn current_query(&self, cx: &App) -> Option<String> {
        let prefix = self.editor.read(cx).caret_prefix()?.to_string();
        let at = prefix.rfind('@')?;
        let before_ok = at == 0 || prefix[..at].ends_with(char::is_whitespace);
        let query = &prefix[at + 1..];
        (before_ok && !query.contains(char::is_whitespace)).then(|| query.to_string())
    }

    fn refresh_menu(&mut self, cx: &mut Context<Self>) {
        let Some(query) = self.current_query(cx) else {
            if self.menu.take().is_some() {
                cx.notify();
            }
            return;
        };
        let rows = self.search(&query, cx);
        let selected = self.menu.as_ref().map(|m| m.selected).unwrap_or(0).min(rows.len().saturating_sub(1));
        self.menu = Some(MentionMenu { rows, selected, token_len: query.len() + 1 });
        cx.notify();
    }

    /// `hostMentionSearch`: directives first, then files.
    fn search(&self, query: &str, cx: &App) -> Vec<MentionRow> {
        let (task, harness) = self.target.clone().unwrap_or_default();
        let sources = sources_for(cx, &task, &harness);
        let mut rows: Vec<MentionRow> = search_directives(&sources, query).into_iter().map(MentionRow::Directive).collect();
        let core = cx.core();
        if core.try_use::<notefig_files::FilesModule>().is_some()
            && let Ok(files) = core.workspace(&self.workspace_path).get::<notefig_files::FilesModule>()
        {
            let meta = files.metadata().rows();
            let options = notefig_files::file_score::FileSearchOptions {
                limit: Some(SUGGESTION_LIMIT),
                filter: Some(Rc::new(notefig_editors::can_open_file)),
                match_all_when_empty: true,
            };
            let ranked = notefig_files::file_score::rank_file_rows(
                meta.iter().filter(|m| !m.is_dir()).map(|m| notefig_files::file_score::RankRow {
                    path: &m.path,
                    relative_path: m.relative_path.as_deref(),
                    search_key: None,
                }),
                query,
                &options,
            );
            rows.extend(ranked.into_iter().map(|r| MentionRow::File(MentionFile { path: r.path, relative_path: r.relative_path })));
        }
        rows
    }

    /// Insert the picked row: a chip for a file or a directive value; a
    /// namespace row types `@ns:` so its members list next.
    fn accept(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(menu) = self.menu.take() else { return };
        let Some(row) = menu.rows.get(menu.selected).cloned() else { return };
        self.pick(row, menu.token_len, window, cx);
    }

    fn pick(&mut self, row: MentionRow, token_len: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| {
            let Ok(mut range) = e.capture_suffix(token_len) else { return };
            match &row {
                MentionRow::Directive(DirectiveRow { namespace, value: None, .. }) => {
                    let _ = e.replace_captured(&mut range, &format!("@{namespace}:"), cx);
                }
                MentionRow::Directive(DirectiveRow { namespace, value: Some(v), .. }) => {
                    let _ = e.replace_captured(&mut range, "", cx);
                    let _ = e.insert_mention(&format!("{namespace}:{v}"), cx);
                }
                MentionRow::File(file) => {
                    let _ = e.replace_captured(&mut range, "", cx);
                    let _ = e.insert_mention(&file.relative_path, cx);
                }
            }
        });
        self.focus(window, cx);
        cx.notify();
    }

    /// `SuggestionList`: `max-h-56 min-w-36 max-w-72 rounded-md border
    /// bg-popover p-0.5 shadow-md`, rows `px-1.5 py-0.5 text-xs gap-1`.
    fn render_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.menu.as_ref().filter(|m| !m.rows.is_empty())?;
        let tk = tokens(cx).clone();
        let mut list = style::popover_frame(cx)
            .flex()
            .flex_col()
            .max_h(sp(56.))
            .min_w(sp(36.))
            .max_w(sp(72.))
            .p(sp(0.5))
            .overflow_hidden();
        for (ix, row) in menu.rows.iter().enumerate() {
            let (context, name, detail, glyph) = match row {
                MentionRow::File(f) => {
                    let title = f.relative_path.rsplit('/').next().unwrap_or(&f.relative_path).to_string();
                    let dir = f.relative_path.strip_suffix(&title).unwrap_or("").to_string();
                    let dirs: Vec<&str> = dir.trim_end_matches('/').split('/').filter(|d| !d.is_empty()).collect();
                    let context = match dirs.len() {
                        0 => None,
                        1 | 2 => Some(format!("{}/", dirs.join("/"))),
                        n => Some(format!("{}/…/{}/", dirs[0], dirs[n - 1])),
                    };
                    (context, title, None, "file-text")
                }
                MentionRow::Directive(d) => match &d.value {
                    None => (None, d.label.clone(), None, "at-sign"),
                    Some(_) => (Some(format!("{}: ", d.namespace)), d.label.clone(), d.description.clone(), "at-sign"),
                },
            };
            let token_len = menu.token_len;
            let picked = row.clone();
            list = list.child(
                div()
                    .id(ElementId::Name(format!("prompt-mention-{ix}").into()))
                    .flex()
                    .items_center()
                    .gap(sp(1.))
                    .rounded(tk.radius_sm)
                    .px(sp(1.5))
                    .py(sp(0.5))
                    .text_size(tk.text_xs)
                    .cursor_pointer()
                    .when(ix == menu.selected, |d| d.bg(tk.accent).text_color(tk.accent_foreground))
                    .child(icon(glyph).size(sp(3.5)).text_color(tk.muted_foreground))
                    .child(
                        div()
                            .flex()
                            .min_w_0()
                            .items_baseline()
                            .when_some(context, |d, c| d.child(div().text_color(tk.muted_foreground).child(c)))
                            .child(div().flex_none().child(name))
                            .when_some(detail, |d, c| d.child(div().ml(sp(1.5)).min_w_0().truncate().text_color(tk.muted_foreground).child(c))),
                    )
                    .on_mouse_down(MouseButton::Left, cx.listener(move |this, _, window, cx| {
                        this.menu = None;
                        this.pick(picked.clone(), token_len, window, cx);
                    })),
            );
        }
        Some(style::anchored_popover(PopoverSide::BelowStart, list))
    }
}

impl Render for DraftField {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let menu = self.render_menu(cx);
        div()
            .relative()
            .w_full()
            .text_size(self.text_size)
            .child(BlockEditor::new(&self.editor).w_full())
            .children(menu)
    }
}
