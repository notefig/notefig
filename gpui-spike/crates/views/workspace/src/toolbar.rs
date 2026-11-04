//! `TiptapToolbar` (tiptap-toolbar.tsx, tiptap-toolbar-buttons.tsx): the
//! fixed formatting toolbar over a document — headings, marks, lists,
//! quote and code, table, link — with each button pressed while its format
//! is active at the caret, and the properties (frontmatter) button pinned to
//! the far end. Buttons never take focus from the editor.

use gpui::{
    AnyElement, Context, Entity, InteractiveElement as _, IntoElement, ParentElement, Render, StatefulInteractiveElement as _, Styled,
    WeakEntity, Window, div, prelude::FluentBuilder as _,
};
use markdown_editor::{BlockEditorState, BlockKind, EditorCommand, MarkKind, MarkState};
use notefig_ui::{IconButton, sp, tokens};

use crate::editor_host::EditorHost;

pub struct Toolbar {
    editor: Entity<BlockEditorState>,
    /// Inside a right-to-left file tab the toolbar runs right to left.
    rtl: bool,
    host: WeakEntity<EditorHost>,
    _sub: gpui::Subscription,
}

impl Toolbar {
    pub fn new(editor: Entity<BlockEditorState>, host: WeakEntity<EditorHost>, _: &mut Window, cx: &mut Context<Self>) -> Self {
        // Re-render on every editor change: the pressed states follow the caret.
        let sub = cx.observe(&editor, |_, _, cx| cx.notify());
        Self { editor, rtl: false, host, _sub: sub }
    }
}

/// What a button does.
#[derive(Clone, Copy)]
enum Op {
    Heading(u8),
    Mark(MarkKind),
    List { ordered: bool },
    Quote,
    Code,
    Table,
    Link,
    Properties,
}

fn run(editor: &Entity<BlockEditorState>, host: &WeakEntity<EditorHost>, op: Op, window: &mut Window, cx: &mut gpui::App) {
    match op {
        Op::Link => {
            let url = editor.read(cx).link_at_caret();
            let _ = host.update(cx, |h, cx| h.edit_link(url, window, cx));
            return;
        }
        Op::Properties => {
            editor.update(cx, |s, cx| {
                if s.is_properties_open() {
                    s.close_properties(true, window, cx);
                } else {
                    s.open_properties(window, cx);
                }
            });
            return;
        }
        _ => {}
    }
    editor.update(cx, |s, cx| {
        let at = s.block_kind_at_caret();
        let command = match op {
            Op::Heading(level) => {
                if at == Some(BlockKind::Heading { level }) {
                    EditorCommand::SetBlockKind(BlockKind::Paragraph)
                } else {
                    EditorCommand::SetBlockKind(BlockKind::Heading { level })
                }
            }
            Op::Mark(kind) => EditorCommand::ToggleMark(kind),
            Op::List { ordered } => EditorCommand::ToggleList { ordered },
            Op::Quote => EditorCommand::ToggleBlockquote,
            Op::Code => {
                if at == Some(BlockKind::CodeBlock) {
                    EditorCommand::SetBlockKind(BlockKind::Paragraph)
                } else {
                    EditorCommand::SetCodeBlock { lang: None }
                }
            }
            // `insertTable({ rows: 3, cols: 3, withHeaderRow: true })`.
            Op::Table => EditorCommand::InsertTable { rows: 3, cols: 3 },
            Op::Link | Op::Properties => unreachable!(),
        };
        let _ = s.run(command, cx);
        s.focus(window, cx);
    });
}

impl Toolbar {
    pub(crate) fn set_rtl(&mut self, rtl: bool, cx: &mut Context<Self>) {
        self.rtl = rtl;
        cx.notify();
    }
}

impl Render for Toolbar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let state = self.editor.read(cx);
        let at = state.block_kind_at_caret();
        let ancestors = state.caret_ancestor_kinds();
        let model = state.model();
        let mark = |k| model.mark_state(k) == MarkState::On;
        let in_list = |ordered: bool| ancestors.iter().find(|k| matches!(k, BlockKind::List { .. })) == Some(&BlockKind::List { ordered });
        let link = state.link_at_caret().is_some();
        let properties = state.is_properties_open() || state.frontmatter().is_some();

        let editor = self.editor.clone();
        let host = self.host.clone();
        let button = |id: &'static str, icon: &str, tooltip: &'static str, pressed: bool, op: Op| -> AnyElement {
            let (e, h) = (editor.clone(), host.clone());
            IconButton::new(id, icon).icon_size(sp(4.))
                .size(sp(8.), sp(8.))
                .pressed(pressed)
                .tooltip(tooltip)
                .on_click(move |_, window, cx| run(&e, &h, op, window, cx))
                .into_any_element()
        };
        let sep = || div().flex_none().w(gpui::px(1.)).h(sp(6.)).mx(sp(1.)).bg(t.border).into_any_element();
        let icon_size = sp(4.);
        let _ = icon_size;
        // `FixedToolbar` (`overflow-x-auto justify-between`): the buttons and
        // the properties button scroll as one row, so in a narrow pane the
        // properties button goes off the end with the rest.
        div()
            .id("toolbar")
            .flex_none()
            .w_full()
            .overflow_x_scroll()
            .p(sp(1.))
            .child(
                div()
                    .flex()
                    .min_w_full()
                    .items_center()
                    .justify_between()
                    .gap(sp(1.))
                    .when(self.rtl, |d| d.flex_row_reverse())
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .items_center()
                            .gap(sp(1.))
                            .when(self.rtl, |d| d.flex_row_reverse())
                            .child(button("tb-h1", "heading-1", "Heading 1", at == Some(BlockKind::Heading { level: 1 }), Op::Heading(1)))
                            .child(button("tb-h2", "heading-2", "Heading 2", at == Some(BlockKind::Heading { level: 2 }), Op::Heading(2)))
                            .child(button("tb-h3", "heading-3", "Heading 3", at == Some(BlockKind::Heading { level: 3 }), Op::Heading(3)))
                            .child(sep())
                            .child(button("tb-bold", "bold", "Bold", mark(MarkKind::Bold), Op::Mark(MarkKind::Bold)))
                            .child(button("tb-italic", "italic", "Italic", mark(MarkKind::Italic), Op::Mark(MarkKind::Italic)))
                            .child(button("tb-underline", "underline", "Underline", mark(MarkKind::Underline), Op::Mark(MarkKind::Underline)))
                            .child(button("tb-strike", "strikethrough", "Strikethrough", mark(MarkKind::Strikethrough), Op::Mark(MarkKind::Strikethrough)))
                            .child(sep())
                            .child(button("tb-bullets", "list", "Bullet List", in_list(false), Op::List { ordered: false }))
                            .child(button("tb-ordered", "list-ordered", "Numbered List", in_list(true), Op::List { ordered: true }))
                            .child(sep())
                            .child(button("tb-quote", "quote", "Blockquote", ancestors.contains(&BlockKind::Blockquote), Op::Quote))
                            .child(button("tb-code", "code", "Code Block", at == Some(BlockKind::CodeBlock), Op::Code))
                            .child(sep())
                            .child(button("tb-table", "table", "Insert Table", ancestors.contains(&BlockKind::Table), Op::Table))
                            .child(sep())
                            .child(button("tb-link", "link", "Link", link, Op::Link)),
                    )
                    .child(button("tb-properties", "square-library", "Properties", properties, Op::Properties)),
            )
    }
}
