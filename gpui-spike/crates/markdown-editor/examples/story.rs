//! A small app around the block editor: a toolbar, the editor, and a live
//! Markdown preview. Run it with `cargo run --example story`.
//!
//! Notefig features shown: source-preserving save (the preview is the exact
//! file: only edited blocks change), frontmatter, prompt widgets rendered by
//! an app node view (type `/` in an empty paragraph), a simulated agent write
//! merged as one undoable transaction with change-gutter bars, diff fences,
//! `<u>`/`<mark>`/`<sub>`/`<sup>`, task lists, search highlights.

use gpui_kit::component::StyledExt as _;
use gpui_kit::component::{
    button::Button,
    h_flex,
    input::{Input, InputState},
    v_flex,
};
use gpui_kit::{
    App, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled, Subscription, Window, div, rems,
};
use markdown_editor::{
    BlockEditor, BlockEditorEvent, BlockEditorState, BlockKind, EditOrigin, EditorCommand,
    MarkKind, NodeViewCtx, PromptWidget, RoundId, TableEdit, WidgetPlacement,
};
use std::{cell::RefCell, collections::HashMap, rc::Rc};

/// The Notefig sample: real-world fixtures (frontmatter, widgets, diffs).
const NOTEFIG_SAMPLE: &str = concat!(
    include_str!("../tests/fixtures/notefig/01-meeting-notes.md"),
    "\n",
    include_str!("../tests/fixtures/notefig/02-widgets-and-diffs.md"),
);

/// The round the simulated agent writes under.
const AGENT_ROUND: RoundId = RoundId(1);

type WidgetInputs = Rc<RefCell<HashMap<SharedString, Entity<InputState>>>>;

/// The app side of a prompt widget: a card with its own draft input, Send
/// (binds a task and simulates the agent's write) and Dismiss.
fn prompt_node_view(
    inputs: WidgetInputs,
    focus_next: Rc<RefCell<Option<SharedString>>>,
) -> impl Fn(&NodeViewCtx, &mut Window, &mut App) -> gpui_kit::AnyElement + 'static {
    move |ctx, window, cx| {
        let id = ctx.widget.id.clone();
        let input = inputs
            .borrow_mut()
            .entry(id.clone())
            .or_insert_with(|| {
                cx.new(|cx| InputState::new(window, cx).placeholder("Ask the agent… (Enter = Send)"))
            })
            .clone();
        if focus_next.borrow().as_ref() == Some(&id) {
            focus_next.borrow_mut().take();
            let focus = input.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
        }
        let theme = gpui_kit::base::Theme::global(cx);
        let bound = ctx.widget.task.clone();
        let (editor, block, widget) = (ctx.editor.clone(), ctx.block, ctx.widget.clone());
        let send_input = input.clone();
        let (dismiss_editor, dismiss_block) = (ctx.editor.clone(), ctx.block);
        v_flex()
            .w_full()
            .gap_2()
            .p_3()
            .rounded_lg()
            .border_1()
            .border_color(if ctx.selected {
                theme.tokens.colors.ring
            } else {
                theme.tokens.colors.border
            })
            .bg(theme.tokens.colors.muted)
            .child(
                h_flex()
                    .gap_2()
                    .text_xs()
                    .text_color(theme.tokens.colors.muted_foreground)
                    .child(format!("✦ AI prompt · {id}"))
                    .child(match &bound {
                        Some(task) => format!("bound to {task}"),
                        None => "unbound (not in the file)".to_string(),
                    }),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(div().flex_1().child(Input::new(&input)))
                    .child(Button::new(SharedString::from(format!("send-{id}"))).label("Send").on_click(
                        move |_, window, cx| {
                            let prompt = send_input.read(cx).value().to_string();
                            let Some(editor) = editor.upgrade() else { return };
                            editor.update(cx, |e, cx| {
                                let task = format!("task_{}", block.as_u64());
                                let _ = e.set_prompt_widget(
                                    block,
                                    PromptWidget {
                                        task: Some(task.into()),
                                        ..widget.clone()
                                    },
                                    cx,
                                );
                                // The "agent" answers by editing the file.
                                simulate_agent_write(e, &prompt, cx);
                            });
                            send_input.update(cx, |i, cx| i.set_value("", window, cx));
                        },
                    ))
                    .child(Button::new(SharedString::from(format!("dismiss-{id}"))).label("✕").on_click(
                        move |_, window, cx| {
                            let Some(editor) = dismiss_editor.upgrade() else { return };
                            editor.update(cx, |e, cx| {
                                let _ = e.remove_prompt_widget(dismiss_block, None, cx);
                                e.focus(window, cx);
                            });
                        },
                    )),
            )
            .into_any_element()
    }
}

/// A stand-in agent: rewrites the file text (appends a line to the first
/// paragraph and adds a section) and hands it back as an `Agent` write, so
/// it merges as one undoable step and shows gutter bars.
fn simulate_agent_write(e: &mut BlockEditorState, prompt: &str, cx: &mut gpui_kit::Context<BlockEditorState>) {
    let source = e.source();
    let prompt = if prompt.trim().is_empty() { "(no prompt)" } else { prompt.trim() };
    let mut new = source.clone();
    if let Some(ix) = new.find("\n\n") {
        new.insert_str(ix, " *(agent touched this)*");
    }
    new.push_str(&format!("\n## Agent answer\n\nYou asked: {prompt}\n"));
    e.track_changes(AGENT_ROUND);
    e.set_change_gutter(Some((AGENT_ROUND, gpui::hsla(0.75, 0.6, 0.6, 0.9))), cx);
    let _ = e.apply_external_source(&new, EditOrigin::Agent { round: Some(AGENT_ROUND) }, cx);
}

/// A titled, full-width section.
fn section(title: impl Into<SharedString>) -> gpui_kit::Div {
    v_flex()
        .w_full()
        .gap_1()
        .child(div().text_sm().font_semibold().child(title.into()))
}

const SAMPLE: &str = "# Block editor\n\nType here. **Bold** with Ctrl/Cmd-B, *italic* with Ctrl/Cmd-I, `code` with Ctrl/Cmd-E (or type `code`, **bold**, *italic*, ~~strike~~).\n\n## Lists\n\n- Bullet one\n- Bullet two\n  - Nested (Tab / Shift-Tab)\n\n1. First\n2. Second\n\nUndo with Ctrl/Cmd-Z, redo with Ctrl/Cmd-Shift-Z. Drag or Shift-arrows to select across blocks.\n\n```rust\nfn main() {\n    println!(\"code blocks: type ``` then Enter\");\n}\n```\n\n| Feature | Status |\n| --- | --- |\n| Tables | click a cell to edit, Tab to move |\n| Lists | Enter on an empty item exits |";

/// A generated document of 1000+ blocks for the perf note.
pub fn long_document(blocks: usize) -> String {
    let mut doc = String::new();
    for i in 0..blocks {
        match i % 4 {
            0 => doc.push_str(&format!("## Section {i}\n\n")),
            1 => doc.push_str(&format!("- Item {i} with **bold** and `code`\n\n")),
            2 => doc.push_str(&format!("1. Ordered {i}\n\n")),
            _ => doc.push_str(&format!(
                "Paragraph {i} with *italic* text that is long enough to wrap onto a second line in a narrow panel.\n\n"
            )),
        }
    }
    doc
}

pub struct BlockEditorStory {
    editor: Entity<BlockEditorState>,
    /// The editor's scroll container; the editor keeps the caret in view.
    scroll: ScrollHandle,
    status: SharedString,
    revision: u64,
    /// Markdown preview, refreshed on `Changed` only (never per frame).
    markdown: SharedString,
    /// The link popover (Cmd/Ctrl+K, D14): open while `Some`.
    link_input: Entity<InputState>,
    link_open: bool,
    /// A Cmd/Ctrl+K request not yet shown (needs a window to fill the input).
    pending_link: Option<SharedString>,
    /// The url under the mouse, shown as the link hover.
    hovered_url: Option<SharedString>,
    /// The search box (highlights matches as you type).
    search_input: Entity<InputState>,
    /// The widget whose input should take focus once it is rendered.
    focus_next: Rc<RefCell<Option<SharedString>>>,
    _subscriptions: Vec<Subscription>,
}

impl BlockEditorStory {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let scroll = ScrollHandle::new();
        let editor = cx.new(|cx| {
            // STORY_MD=path loads that file instead of the sample (manual QA).
            let source = std::env::var("STORY_MD")
                .ok()
                .and_then(|path| std::fs::read_to_string(path).ok())
                .unwrap_or_else(|| NOTEFIG_SAMPLE.to_string());
            let mut state = BlockEditorState::new(window, cx).with_source(&source);
            state.set_scroll_handle(scroll.clone());
            state
        });
        let inputs: WidgetInputs = Rc::default();
        let focus_next: Rc<RefCell<Option<SharedString>>> = Rc::default();
        editor.update(cx, |e, cx| {
            e.set_node_view_renderer(prompt_node_view(inputs, focus_next.clone()), cx);
            // Pasted/dropped images go to a temp assets folder in the story.
            let assets = std::env::temp_dir().join("notefig-story-assets");
            e.set_image_asset_target(Some(move || {
                Some(markdown_editor::ImageAssetTarget {
                    dir: assets.clone(),
                    src_prefix: format!("{}/", assets.display()),
                })
            }));
            // Relative images resolve against the fixtures folder.
            e.set_image_base_dir(
                Some(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/notefig")),
                cx,
            );
        });
        let subscription = cx.subscribe(&editor, |this, editor, event: &BlockEditorEvent, cx| {
            // The status follows every caret move, not only edits, so it
            // never shows the previous action's caret.
            match event {
                BlockEditorEvent::Changed { revision, .. } => {
                    this.revision = *revision;
                    this.refresh_markdown(cx);
                }
                BlockEditorEvent::SelectionChanged => {}
                BlockEditorEvent::EditLinkRequested { url } => {
                    this.pending_link = Some(url.clone().unwrap_or_default());
                    cx.notify();
                    return;
                }
                BlockEditorEvent::LinkHovered { url } => {
                    this.hovered_url = url.clone();
                    cx.notify();
                    return;
                }
                BlockEditorEvent::SlashTrigger { block, .. } => {
                    // The app's answer to `/`: a widget in place of the `/`.
                    let id = markdown_editor::new_prompt_widget_id();
                    let block = *block;
                    let _ = editor.update(cx, |e, cx| {
                        e.insert_prompt_widget(
                            PromptWidget::new(id.clone(), None),
                            WidgetPlacement::Replace(block),
                            cx,
                        )
                    });
                    *this.focus_next.borrow_mut() = Some(id);
                    this.refresh_markdown(cx);
                    cx.notify();
                    return;
                }
                BlockEditorEvent::LinkClicked { url } => {
                    // The host decides what to do; the story only reports it.
                    this.status = format!("link clicked: {url}").into();
                    cx.notify();
                    return;
                }
                _ => return,
            }
            let kind = editor.read(cx).block_kind_at_caret();
            this.status = format!("revision {}, caret in {kind:?}", this.revision).into();
            cx.notify();
        });
        let link_input = cx.new(|cx| InputState::new(window, cx).placeholder("https://…"));
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search…"));
        let search_subscription = cx.subscribe(
            &search_input,
            |this, input, _: &gpui_kit::component::input::InputEvent, cx| {
                let query = input.read(cx).value().to_string();
                let count = this.editor.update(cx, |e, cx| e.set_search(&query, false, cx));
                this.status = format!("{count} matches for {query:?}").into();
                cx.notify();
            },
        );
        let mut this = Self {
            link_input,
            link_open: false,
            pending_link: None,
            hovered_url: None,
            editor,
            scroll,
            // Never empty, so the toolbar row keeps its height and the
            // editor does not jump when the first status arrives.
            status: "revision 0".into(),
            revision: 0,
            markdown: "".into(),
            search_input,
            focus_next,
            _subscriptions: vec![subscription, search_subscription],
        };
        this.refresh_markdown(cx);
        this
    }

    fn refresh_markdown(&mut self, cx: &App) {
        let source = self.editor.read(cx).source();
        self.markdown = source.chars().take(2000).collect::<String>().into();
    }

    fn load(&mut self, source: &str, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| {
            let _ = e.set_source(source, cx);
        });
        self.refresh_markdown(cx);
        cx.notify();
    }

    fn close_link(&mut self, url: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(url) = url {
            self.editor.update(cx, |e, cx| {
                e.set_link(Some(&url).filter(|u| !u.is_empty()).map(|u| u.as_str()), cx)
            });
        }
        self.link_open = false;
        self.editor.update(cx, |e, cx| e.focus(window, cx));
        cx.notify();
    }

    fn command_button(
        id: &'static str,
        label: &'static str,
        command: EditorCommand,
        cx: &mut Context<Self>,
    ) -> Button {
        Button::new(id)
            .label(label)
            .on_click(cx.listener(move |this, _, window, cx| {
                let command = command.clone();
                this.editor.update(cx, |e, cx| {
                    let _ = e.run(command, cx);
                    e.focus(window, cx);
                });
            }))
    }
}

impl Render for BlockEditorStory {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(url) = self.pending_link.take() {
            self.link_input
                .update(cx, |input, cx| input.set_value(url, window, cx));
            self.link_open = true;
            let focus = self.link_input.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
        }
        let link_bar =
            self.link_open.then(|| {
                h_flex()
                    .gap_2()
                    .child(div().text_sm().child("Link"))
                    .child(div().w(rems(20.)).child(Input::new(&self.link_input)))
                    .child(
                        Button::new("link-apply")
                            .label("Apply")
                            .on_click(cx.listener(|this, _, window, cx| {
                                let url = this.link_input.read(cx).value().to_string();
                                this.close_link(Some(url), window, cx);
                            })),
                    )
                    .child(
                        Button::new("link-remove")
                            .label("Remove")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.close_link(Some(String::new()), window, cx)
                            })),
                    )
                    .child(Button::new("link-cancel").label("Cancel").on_click(
                        cx.listener(|this, _, window, cx| this.close_link(None, window, cx)),
                    ))
            });
        let hover = self
            .hovered_url
            .clone()
            .map(|url| format!("{url}  (Ctrl/Cmd-click to follow)"))
            .unwrap_or_default();
        v_flex()
            .size_full()
            .p_4()
            .gap_3()
            .child(
                h_flex()
                    .gap_2()
                    .flex_wrap()
                    .child(Self::command_button(
                        "bold",
                        "B",
                        EditorCommand::ToggleMark(MarkKind::Bold),
                        cx,
                    ))
                    .child(Self::command_button(
                        "italic",
                        "I",
                        EditorCommand::ToggleMark(MarkKind::Italic),
                        cx,
                    ))
                    .child(Self::command_button(
                        "strike",
                        "S",
                        EditorCommand::ToggleMark(MarkKind::Strikethrough),
                        cx,
                    ))
                    .child(Self::command_button(
                        "inline-code",
                        "`code`",
                        EditorCommand::ToggleMark(MarkKind::Code),
                        cx,
                    ))
                    .child(Self::command_button(
                        "p",
                        "Text",
                        EditorCommand::SetBlockKind(BlockKind::Paragraph),
                        cx,
                    ))
                    .child(Self::command_button(
                        "h1",
                        "H1",
                        EditorCommand::SetBlockKind(BlockKind::Heading { level: 1 }),
                        cx,
                    ))
                    .child(Self::command_button(
                        "h2",
                        "H2",
                        EditorCommand::SetBlockKind(BlockKind::Heading { level: 2 }),
                        cx,
                    ))
                    .child(Self::command_button(
                        "h3",
                        "H3",
                        EditorCommand::SetBlockKind(BlockKind::Heading { level: 3 }),
                        cx,
                    ))
                    .child(Self::command_button(
                        "ul",
                        "Bullets",
                        EditorCommand::ToggleList { ordered: false },
                        cx,
                    ))
                    .child(Self::command_button(
                        "ol",
                        "Numbered",
                        EditorCommand::ToggleList { ordered: true },
                        cx,
                    ))
                    .child(Self::command_button(
                        "task",
                        "Task",
                        EditorCommand::ToggleTask,
                        cx,
                    ))
                    .child(Button::new("link").label("Link").on_click(cx.listener(
                        |this, _, _, cx| {
                            this.editor.update(cx, |e, cx| e.request_link_edit(cx));
                        },
                    )))
                    .child(Self::command_button(
                        "code",
                        "Code",
                        EditorCommand::SetCodeBlock { lang: None },
                        cx,
                    ))
                    .child(Self::command_button(
                        "table",
                        "Table",
                        EditorCommand::InsertTable { rows: 3, cols: 3 },
                        cx,
                    ))
                    .child(Self::command_button(
                        "row+",
                        "+Row",
                        EditorCommand::EditTable(TableEdit::AddRowBelow),
                        cx,
                    ))
                    .child(Self::command_button(
                        "row-",
                        "-Row",
                        EditorCommand::EditTable(TableEdit::RemoveRow),
                        cx,
                    ))
                    .child(Self::command_button(
                        "col+",
                        "+Col",
                        EditorCommand::EditTable(TableEdit::AddColumnRight),
                        cx,
                    ))
                    .child(Self::command_button(
                        "col-",
                        "-Col",
                        EditorCommand::EditTable(TableEdit::RemoveColumn),
                        cx,
                    ))
                    .child(Self::command_button(
                        "underline",
                        "U",
                        EditorCommand::ToggleMark(MarkKind::Underline),
                        cx,
                    ))
                    .child(Self::command_button(
                        "highlight",
                        "Mark",
                        EditorCommand::ToggleMark(MarkKind::Highlight),
                        cx,
                    ))
                    .child(
                        Button::new("notefig-sample")
                            .label("Notefig sample")
                            .on_click(cx.listener(|this, _, _, cx| this.load(NOTEFIG_SAMPLE, cx))),
                    )
                    .child(Button::new("agent-write").label("Simulate agent write").on_click(
                        cx.listener(|this, _, _, cx| {
                            this.editor
                                .update(cx, |e, cx| simulate_agent_write(e, "story button", cx));
                        }),
                    ))
                    .child(Button::new("properties").label("Properties").on_click(
                        cx.listener(|this, _, window, cx| {
                            this.editor.update(cx, |e, cx| e.open_properties(window, cx));
                        }),
                    ))
                    .child(Button::new("next-change").label("Next change").on_click(
                        cx.listener(|this, _, _, cx| {
                            this.editor.update(cx, |e, cx| {
                                e.step_change(AGENT_ROUND, true, cx);
                            });
                        }),
                    ))
                    .child(Button::new("frontmatter").label("Frontmatter +reviewed").on_click(
                        cx.listener(|this, _, _, cx| {
                            this.editor.update(cx, |e, cx| {
                                let yaml = e.frontmatter().unwrap_or("").to_string();
                                let yaml = if yaml.is_empty() {
                                    "reviewed: true".to_string()
                                } else {
                                    format!("{yaml}\nreviewed: true")
                                };
                                let _ = e.set_frontmatter(Some(&yaml), cx);
                            });
                        }),
                    ))
                    .child(div().w(rems(10.)).child(Input::new(&self.search_input)))
                    .child(
                        Button::new("sample")
                            .label("Sample")
                            .on_click(cx.listener(|this, _, _, cx| this.load(SAMPLE, cx))),
                    )
                    .child(Button::new("long").label("Load 1200 blocks").on_click(
                        cx.listener(|this, _, _, cx| this.load(&long_document(1200), cx)),
                    ))
                    .child(div().text_sm().child(self.status.clone())),
            )
            .children(link_bar)
            .child(div().h(rems(1.25)).text_xs().child(hover))
            .child(
                section("Editor").child(
                    div()
                        .id("block-editor-scroll")
                        .w_full()
                        .h(rems(28.))
                        .overflow_y_scroll()
                        // Scroll containment: wheel events over this pane
                        // must not also scroll the story/gallery.
                        .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                        .track_scroll(&self.scroll)
                        .child(BlockEditor::new(&self.editor).min_h_full().p_2()),
                ),
            )
            .child(
                section("Markdown").child(
                    div()
                        .id("block-editor-markdown")
                        .flex_1()
                        .w_full()
                        .max_h(rems(28.))
                        .overflow_y_scroll()
                        .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                        .text_xs()
                        .whitespace_normal()
                        .child(self.markdown.clone()),
                ),
            )
    }
}

fn main() {
    gpui_kit::application()
        .with_assets(gpui_kit::assets::AllAssets)
        .run(|cx| {
            gpui_kit::init(cx);
            markdown_editor::init(cx);
            gpui_kit::open_window(gpui_kit::WindowOptions::default(), cx, |window, cx| {
                cx.new(|cx| BlockEditorStory::new(window, cx))
            })
            .expect("failed to open window");
            cx.activate(true);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use markdown_editor::{BlockPosition, BlockSelection};

    fn open<'a>(
        cx: &'a mut TestAppContext,
        source: &str,
    ) -> (Entity<BlockEditorStory>, &'a mut gpui::VisualTestContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            markdown_editor::init(cx);
        });
        let source = source.to_string();
        let (story, cx) = cx.add_window_view(move |window, cx| {
            let mut story = BlockEditorStory::new(window, cx);
            story.load(&source, cx);
            story
        });
        let (story, cx) = (story, cx);
        story.update_in(cx, |story, window, cx| {
            story.editor.update(cx, |e, cx| e.focus(window, cx))
        });
        cx.run_until_parked();
        (story, cx)
    }

    fn caret_in_leaf(
        story: &Entity<BlockEditorStory>,
        cx: &mut gpui::VisualTestContext,
        leaf: usize,
        offset: usize,
    ) {
        story.update(cx, |story, cx| {
            story.editor.update(cx, |e, cx| {
                let id = e.model().document().leaves().nth(leaf).unwrap().id();
                e.set_selection(BlockSelection::caret(BlockPosition::new(id, offset)), cx)
                    .unwrap();
            })
        });
    }

    fn settle(cx: &mut gpui::VisualTestContext) {
        cx.run_until_parked();
        cx.update(|window, cx| {
            let _ = window.draw(cx);
        });
    }

    #[gpui::test]
    fn cmd_k_opens_the_link_bar_filled_with_the_url_and_apply_sets_it(cx: &mut TestAppContext) {
        let (story, cx) = open(cx, "see [site](https://a.example) end");
        caret_in_leaf(&story, cx, 0, 5);
        cx.simulate_keystrokes(if cfg!(target_os = "macos") {
            "cmd-k"
        } else {
            "ctrl-k"
        });
        settle(cx);
        story.read_with(cx, |story, cx| {
            assert!(story.link_open, "the bar opens");
            assert_eq!(
                story.link_input.read(cx).value().as_ref(),
                "https://a.example"
            );
        });
        story.update_in(cx, |story, window, cx| {
            story.close_link(Some("https://b.example".into()), window, cx)
        });
        settle(cx);
        story.read_with(cx, |story, cx| {
            assert!(!story.link_open, "the bar closes");
            assert!(
                story
                    .editor
                    .read(cx)
                    .source()
                    .contains("(https://b.example)")
            );
        });
    }

    #[gpui::test]
    fn cmd_k_without_a_link_opens_an_empty_bar_and_cancel_keeps_the_text(cx: &mut TestAppContext) {
        let (story, cx) = open(cx, "plain");
        caret_in_leaf(&story, cx, 0, 2);
        cx.simulate_keystrokes(if cfg!(target_os = "macos") {
            "cmd-k"
        } else {
            "ctrl-k"
        });
        settle(cx);
        story.read_with(cx, |story, cx| {
            assert!(story.link_open);
            assert_eq!(story.link_input.read(cx).value().as_ref(), "");
        });
        story.update_in(cx, |story, window, cx| story.close_link(None, window, cx));
        settle(cx);
        story.read_with(cx, |story, cx| {
            assert!(!story.link_open);
            assert_eq!(story.editor.read(cx).source(), "plain");
        });
    }

    #[gpui::test]
    fn task_command_toggles_a_task_item_and_the_preview_follows(cx: &mut TestAppContext) {
        let (story, cx) = open(cx, "item");
        caret_in_leaf(&story, cx, 0, 2);
        // The toolbar's Task button runs this command.
        story.update(cx, |story, cx| {
            story.editor.update(cx, |e, cx| {
                e.run(EditorCommand::ToggleTask, cx).unwrap();
            })
        });
        settle(cx);
        story.read_with(cx, |story, cx| {
            assert_eq!(story.editor.read(cx).source(), "- [ ] item");
            assert!(story.markdown.contains("- [ ] item"), "{}", story.markdown);
        });
        story.update(cx, |story, cx| {
            story.editor.update(cx, |e, cx| {
                e.run(EditorCommand::ToggleTask, cx).unwrap();
            })
        });
        settle(cx);
        story.read_with(cx, |story, cx| {
            assert_eq!(story.editor.read(cx).source(), "- item");
        });
    }

    #[gpui::test]
    fn normal_text_shortcut_and_text_button_leave_a_heading(cx: &mut TestAppContext) {
        let (story, cx) = open(cx, "# Title\n\nbody");
        caret_in_leaf(&story, cx, 0, 2);
        // The same init order an outside consumer uses: the binding works.
        cx.simulate_keystrokes(if cfg!(target_os = "macos") {
            "cmd-alt-0"
        } else {
            "ctrl-alt-0"
        });
        settle(cx);
        story.read_with(cx, |story, cx| {
            assert_eq!(story.editor.read(cx).source(), "Title\n\nbody");
            assert!(!story.markdown.contains("# Title"), "{}", story.markdown);
        });
        // Backspace at the start of a heading does the same.
        story.update(cx, |story, cx| {
            story.editor.update(cx, |e, cx| {
                e.run(
                    EditorCommand::SetBlockKind(BlockKind::Heading { level: 2 }),
                    cx,
                )
                .unwrap();
            })
        });
        caret_in_leaf(&story, cx, 0, 0);
        cx.simulate_keystrokes("backspace");
        settle(cx);
        story.read_with(cx, |story, cx| {
            assert_eq!(story.editor.read(cx).source(), "Title\n\nbody");
        });
    }

    #[gpui::test]
    fn table_grip_on_hover_opens_a_menu_whose_items_edit_the_table(cx: &mut TestAppContext) {
        use gpui::EntityInputHandler as _;
        let (story, cx) = open(cx, "| a | b |\n| --- | --- |\n| 1 | 2 |");
        settle(cx);
        caret_in_leaf(&story, cx, 3, 0); // "2"
        settle(cx);
        let editor = story.read_with(cx, |story, _| story.editor.clone());
        let cell = cx.update(|window, cx| {
            editor.update(cx, |e, cx| {
                e.bounds_for_range(0..0, Default::default(), window, cx)
                    .unwrap()
            })
        });
        let over = gpui::point(cell.left() + gpui::px(2.), cell.center().y);
        cx.simulate_mouse_move(over, None, Default::default());
        settle(cx);
        let grips = editor.read_with(cx, |e, _| e.table_grips_at(over));
        assert_eq!(grips.len(), 2, "{grips:?}");
        let (_, line, grip) = grips[0];
        assert_eq!(line, markdown_editor::TableLine::Column(1));
        cx.simulate_mouse_move(grip.center(), None, Default::default());
        cx.simulate_click(grip.center(), Default::default());
        settle(cx);
        let at = editor
            .read_with(cx, |e, _| e.table_menu_anchor())
            .expect("the menu opened");
        // The first entry, "Insert column left", through a real click.
        let first = gpui::point(at.x + gpui::px(40.), at.y + gpui::px(14.));
        cx.simulate_mouse_move(first, None, Default::default());
        cx.simulate_click(first, Default::default());
        settle(cx);
        story.read_with(cx, |story, cx| {
            assert_eq!(
                story.editor.read(cx).source(),
                "| a |  | b |\n| --- | --- | --- |\n| 1 |  | 2 |"
            );
            assert!(!story.editor.read(cx).table_menu_open());
            assert!(
                story.markdown.contains("| a |  | b |"),
                "{}",
                story.markdown
            );
        });
    }

    #[gpui::test]
    fn link_hover_and_click_events_reach_the_story(cx: &mut TestAppContext) {
        let (story, cx) = open(cx, "see [site](https://a.example)");
        story.update(cx, |story, cx| {
            story.editor.update(cx, |_, cx| {
                cx.emit(BlockEditorEvent::LinkHovered {
                    url: Some("https://a.example".into()),
                });
                cx.emit(BlockEditorEvent::LinkClicked {
                    url: "https://a.example".into(),
                });
            })
        });
        settle(cx);
        story.read_with(cx, |story, _| {
            assert_eq!(story.hovered_url.as_deref(), Some("https://a.example"));
            assert_eq!(story.status.as_ref(), "link clicked: https://a.example");
        });
    }
}
