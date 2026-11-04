//! Notefig view features through a real window: slash trigger, node views,
//! focus guard, shortcuts, link-on-paste, external merges, gutter, search,
//! placeholder.

use std::{cell::RefCell, rc::Rc};

use gpui::{
    AppContext as _, ClipboardItem, Context, Entity, FocusHandle, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, Styled as _, TestAppContext, VisualTestContext,
    Window, div, px,
};

use crate::{
    BlockEditor, BlockEditorEvent, BlockEditorState, BlockKind, BlockPosition, BlockSelection,
    EditOrigin, PromptWidget, RoundId, WidgetPlacement,
};

struct Root(Entity<BlockEditorState>);

impl Render for Root {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(600.))
            .h(px(4000.))
            .child(BlockEditor::new(&self.0).px(px(48.)))
    }
}

const M: &str = if cfg!(target_os = "macos") {
    "cmd"
} else {
    "ctrl"
};

fn open<'a>(
    cx: &'a mut TestAppContext,
    source: &str,
) -> (Entity<BlockEditorState>, &'a mut VisualTestContext) {
    cx.update(crate::init_for_tests);
    let source = source.to_string();
    let (root, cx) = cx.add_window_view(move |window, cx| {
        Root(cx.new(|cx| BlockEditorState::new(window, cx).with_source(&source)))
    });
    let editor = root.read_with(cx, |root, _| root.0.clone());
    cx.update(|window, cx| {
        let focus = editor.read(cx).focus_handle.clone();
        window.focus(&focus, cx);
    });
    draw(cx);
    (editor, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
}

fn source(editor: &Entity<BlockEditorState>, cx: &VisualTestContext) -> String {
    editor.read_with(cx, |e, _| e.source())
}

fn keys(cx: &mut VisualTestContext, keys: &str) {
    cx.simulate_keystrokes(&keys.replace("M-", &format!("{M}-")));
    draw(cx);
}

fn events(
    editor: &Entity<BlockEditorState>,
    cx: &mut VisualTestContext,
) -> Rc<RefCell<Vec<BlockEditorEvent>>> {
    let log = Rc::new(RefCell::new(Vec::new()));
    let sink = log.clone();
    cx.update(|_, cx| {
        cx.subscribe(editor, move |_, event: &BlockEditorEvent, _| {
            sink.borrow_mut().push(event.clone())
        })
        .detach()
    });
    log
}

fn caret_end(editor: &Entity<BlockEditorState>, cx: &mut VisualTestContext, leaf: usize) {
    editor.update(cx, |e, cx| {
        let l = e.model().document().leaves().nth(leaf).unwrap();
        let pos = BlockPosition::new(l.id(), l.text().map(str::len).unwrap_or(1));
        e.set_selection(BlockSelection::caret(pos), cx).unwrap();
    });
}

#[gpui::test]
fn slash_triggers_and_the_app_inserts_a_node_view(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "# Doc\n\n");
    let log = events(&editor, cx);
    let rendered = Rc::new(RefCell::new(Vec::<String>::new()));
    let draft_focus: Rc<RefCell<Option<FocusHandle>>> = Rc::default();
    {
        let rendered = rendered.clone();
        let draft_focus = draft_focus.clone();
        editor.update(cx, |e, cx| {
            e.set_node_view_renderer(
                move |ctx, _, cx| {
                    rendered.borrow_mut().push(ctx.widget.id.to_string());
                    let focus = draft_focus
                        .borrow_mut()
                        .get_or_insert_with(|| cx.focus_handle())
                        .clone();
                    div()
                        .h(px(80.))
                        .w_full()
                        .track_focus(&focus)
                        .child(format!("widget {}", ctx.widget.id))
                        .into_any_element()
                },
                cx,
            )
        });
    }
    // The empty trailing paragraph is the second leaf.
    caret_end(&editor, cx, 1);
    cx.simulate_input("/");
    draw(cx);
    let trigger = log.borrow().iter().find_map(|e| match e {
        BlockEditorEvent::SlashTrigger { block, .. } => Some(*block),
        _ => None,
    });
    let block = trigger.expect("slash trigger");
    // The app answers by inserting a widget in place of the `/` paragraph.
    let widget = editor
        .update(cx, |e, cx| {
            e.insert_prompt_widget(
                PromptWidget::new("blob_t", None),
                WidgetPlacement::Replace(block),
                cx,
            )
        })
        .unwrap();
    draw(cx);
    assert!(rendered.borrow().iter().any(|id| id == "blob_t"));
    let bounds = editor.read_with(cx, |e, _| e.node_view_bounds());
    assert_eq!(bounds.len(), 1);
    assert_eq!(bounds[0].0, widget);
    assert!(bounds[0].1.size.height >= px(80.));
    // The unbound widget is not in the file.
    assert_eq!(source(&editor, cx), "# Doc\n\n");

    // Focus the widget's own input: editor keys must not edit the document.
    let focus = draft_focus.borrow().clone().unwrap();
    cx.update(|window, cx| window.focus(&focus, cx));
    keys(cx, "backspace backspace M-b");
    assert_eq!(source(&editor, cx), "# Doc\n\n");
    assert_eq!(editor.read_with(cx, |e, _| e.model().prompt_widgets().len()), 1);
    // A click inside the node view does not move the editor's caret.
    let caret = editor.read_with(cx, |e, _| e.model().caret());
    let center = bounds[0].1.center();
    cx.simulate_click(center, gpui::Modifiers::none());
    draw(cx);
    assert_eq!(editor.read_with(cx, |e, _| e.model().caret()), caret);
}

#[gpui::test]
fn slash_in_a_blockquote_types_normally(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "> a\n");
    let log = events(&editor, cx);
    caret_end(&editor, cx, 0);
    keys(cx, "backspace");
    cx.simulate_input("/");
    draw(cx);
    assert!(
        !log
            .borrow()
            .iter()
            .any(|e| matches!(e, BlockEditorEvent::SlashTrigger { .. }))
    );
    assert_eq!(source(&editor, cx), "> /\n");
}

#[gpui::test]
fn notefig_shortcuts(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "word");
    keys(cx, "M-a M-u");
    assert_eq!(source(&editor, cx), "<u>word</u>");
    keys(cx, "M-u M-shift-h");
    assert_eq!(source(&editor, cx), "<mark>word</mark>");
    keys(cx, "M-shift-h M-alt-2");
    assert_eq!(source(&editor, cx), "## word");
    keys(cx, "M-alt-2");
    assert_eq!(source(&editor, cx), "word");
    keys(cx, "M-shift-b");
    assert_eq!(source(&editor, cx), "> word");
    keys(cx, "M-shift-b M-shift-8");
    assert_eq!(source(&editor, cx), "- word");
    keys(cx, "M-shift-8 M-alt-c");
    assert_eq!(
        editor.read_with(cx, |e, _| e.model().block_kind_at_caret()),
        Some(BlockKind::CodeBlock)
    );
}

#[gpui::test]
fn subscript_toggle_wraps_the_selection(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "H2O");
    editor.update(cx, |e, cx| {
        let id = e.model().document().leaves().next().unwrap().id();
        e.set_selection(
            BlockSelection::Text {
                anchor: BlockPosition::new(id, 1),
                head: BlockPosition::new(id, 2),
            },
            cx,
        )
        .unwrap();
    });
    keys(cx, "M-,");
    assert_eq!(source(&editor, cx), "H<sub>2</sub>O");
    keys(cx, "M-,");
    assert_eq!(source(&editor, cx), "H2O");
}

#[gpui::test]
fn pasting_a_url_over_a_selection_links_it(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "see docs");
    editor.update(cx, |e, cx| {
        let id = e.model().document().leaves().next().unwrap().id();
        e.set_selection(
            BlockSelection::Text {
                anchor: BlockPosition::new(id, 4),
                head: BlockPosition::new(id, 8),
            },
            cx,
        )
        .unwrap();
    });
    cx.write_to_clipboard(ClipboardItem::new_string("https://notefig.com/docs".into()));
    keys(cx, "M-v");
    assert_eq!(source(&editor, cx), "see [docs](https://notefig.com/docs)");
}

#[gpui::test]
fn external_merge_emits_its_origin_and_undoes(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "# T\n\nold text\n");
    let log = events(&editor, cx);
    let summary = editor
        .update(cx, |e, cx| {
            e.apply_external_source("# T\n\nnew text\n", EditOrigin::External, cx)
        })
        .unwrap();
    assert!(summary.changed);
    draw(cx);
    assert!(log.borrow().iter().any(|e| matches!(
        e,
        BlockEditorEvent::Changed {
            origin: EditOrigin::External,
            ..
        }
    )));
    assert_eq!(source(&editor, cx), "# T\n\nnew text\n");
    keys(cx, "M-z");
    assert_eq!(source(&editor, cx), "# T\n\nold text\n");
    assert!(log.borrow().iter().any(|e| matches!(
        e,
        BlockEditorEvent::Changed {
            origin: EditOrigin::Undo,
            ..
        }
    )));
}

#[gpui::test]
fn gutter_bars_mark_agent_changes(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "alpha\n\nbeta\n\ngamma\n");
    let round = RoundId(1);
    editor.update(cx, |e, cx| {
        e.track_changes(round);
        e.set_change_gutter(Some((round, gpui::red())), cx);
        let new = "alpha\n\nbeta (edited by agent)\n\ngamma\n";
        e.apply_external_source(new, EditOrigin::Agent { round: Some(round) }, cx)
            .unwrap();
    });
    draw(cx);
    let bars = editor.read_with(cx, |e, _| e.change_gutter_bars());
    assert_eq!(bars.len(), 1);
    let beta = editor.read_with(cx, |e, _| e.model().document().leaves().nth(1).unwrap().id());
    assert_eq!(bars[0].0, beta);
}

#[gpui::test]
fn search_highlights_and_selects_matches(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "one fish two fish\n\n```ts diff\n-a\n+b\n```\n");
    let count = editor.update(cx, |e, cx| e.set_search("fish", false, cx));
    assert_eq!(count, 2);
    draw(cx);
    let backgrounds = editor.read_with(cx, |e, _| e.notefig_backgrounds());
    // Two search hits and two diff lines.
    assert_eq!(backgrounds.len(), 4);
    assert!(editor.update(cx, |e, cx| e.select_search_match(1, cx)));
    let selection = editor.read_with(cx, |e, _| e.model().selection().clone());
    assert!(matches!(selection, BlockSelection::Text { anchor, head } if anchor.offset == 13 && head.offset == 17));
}

#[gpui::test]
fn placeholder_shows_in_an_empty_document(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "");
    draw(cx);
    let placeholder = editor.read_with(cx, |e, _| e.placeholder_origin(false));
    assert!(placeholder.is_some());
    editor.update(cx, |e, cx| e.set_placeholder(None, cx));
    assert!(editor.read_with(cx, |e, _| e.placeholder_origin(false)).is_none());
}

#[gpui::test]
fn frontmatter_set_through_the_entity_is_undoable(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "---\na: 1\n---\n\nbody\n");
    assert_eq!(editor.read_with(cx, |e, _| e.frontmatter().map(str::to_string)), Some("a: 1".into()));
    editor
        .update(cx, |e, cx| e.set_frontmatter(Some("a: 2"), cx))
        .unwrap();
    assert_eq!(source(&editor, cx), "---\na: 2\n---\n\nbody\n");
    keys(cx, "M-z");
    assert_eq!(source(&editor, cx), "---\na: 1\n---\n\nbody\n");
}

#[gpui::test]
fn double_equals_input_rule_highlights(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "");
    cx.simulate_input("a ==hi==");
    draw(cx);
    assert_eq!(source(&editor, cx), "a <mark>hi</mark>");
}

#[gpui::test]
fn caret_moves_around_a_widget(cx: &mut TestAppContext) {
    let (editor, cx) = open(
        cx,
        "a\n\n<!-- notefig:prompt id=\"blob_w\" task=\"t\" -->\n\nb\n",
    );
    editor.update(cx, |e, cx| {
        e.set_node_view_renderer(
            |_, _, _| div().h(px(60.)).child("card").into_any_element(),
            cx,
        )
    });
    draw(cx);
    let (a, w, b) = editor.read_with(cx, |e, _| {
        let ids: Vec<_> = e.model().document().leaves().map(|l| l.id()).collect();
        (ids[0], ids[1], ids[2])
    });
    caret_end(&editor, cx, 0);
    keys(cx, "right");
    assert_eq!(editor.read_with(cx, |e, _| e.model().caret().map(|c| c.block)), Some(w));
    keys(cx, "right right");
    assert_eq!(
        editor.read_with(cx, |e, _| e.model().caret()),
        Some(BlockPosition::new(b, 0))
    );
    // Vertical motion passes over the widget.
    caret_end(&editor, cx, 0);
    keys(cx, "down");
    assert_eq!(editor.read_with(cx, |e, _| e.model().caret().map(|c| c.block)), Some(b));
    keys(cx, "up");
    assert_eq!(editor.read_with(cx, |e, _| e.model().caret().map(|c| c.block)), Some(a));
    // Backspace at the start of the paragraph below selects the widget;
    // the next Backspace deletes it, and undo brings it back.
    editor.update(cx, |e, cx| {
        e.set_selection(BlockSelection::caret(BlockPosition::new(b, 0)), cx)
            .unwrap()
    });
    keys(cx, "backspace");
    assert_eq!(editor.read_with(cx, |e, _| e.model().prompt_widgets().len()), 1);
    assert_eq!(
        editor.read_with(cx, |e, _| e.model().selection().clone()),
        BlockSelection::Blocks { anchor: w, head: w }
    );
    keys(cx, "backspace");
    assert_eq!(editor.read_with(cx, |e, _| e.model().prompt_widgets().len()), 0);
    keys(cx, "M-z");
    assert_eq!(editor.read_with(cx, |e, _| e.model().prompt_widgets().len()), 1);
}

#[gpui::test]
fn change_navigator_steps_and_wraps(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "a\n\nb\n\nc\n");
    let round = RoundId(5);
    editor.update(cx, |e, cx| {
        e.track_changes(round);
        e.apply_external_source("a!\n\nb\n\nc!\n", EditOrigin::Agent { round: Some(round) }, cx)
            .unwrap();
    });
    draw(cx);
    assert_eq!(editor.read_with(cx, |e, _| e.change_count(round)), 2);
    assert_eq!(editor.update(cx, |e, cx| e.step_change(round, true, cx)), Some(0));
    assert_eq!(editor.update(cx, |e, cx| e.step_change(round, true, cx)), Some(1));
    assert_eq!(editor.update(cx, |e, cx| e.step_change(round, true, cx)), Some(0));
    assert_eq!(editor.update(cx, |e, cx| e.step_change(round, false, cx)), Some(1));
    let caret = editor.read_with(cx, |e, _| e.model().caret().unwrap());
    let c = editor.read_with(cx, |e, _| e.model().document().leaves().nth(2).unwrap().id());
    assert_eq!(caret, BlockPosition::new(c, 1));
    draw(cx);
    assert_eq!(editor.read_with(cx, |e, _| e.change_gutter_bars().len()), 2);
}

#[gpui::test]
fn a_final_code_block_gets_a_landing_paragraph(cx: &mut TestAppContext) {
    let source = "# T\n\n```rs\nfn x() {}\n```\n";
    let (editor, cx) = open(cx, source);
    let kinds: Vec<BlockKind> = editor.read_with(cx, |e, _| {
        e.model().document().leaves().map(|l| l.kind()).collect()
    });
    assert_eq!(kinds.last(), Some(&BlockKind::Paragraph));
    assert_eq!(source_of(&editor, cx), source, "the landing paragraph writes nothing");
    // Typing in it makes it real.
    caret_end(&editor, cx, kinds.len() - 1);
    cx.simulate_input("after");
    draw(cx);
    assert_eq!(source_of(&editor, cx), "# T\n\n```rs\nfn x() {}\n```\n\nafter\n");
    // Deleting the trailing paragraph's text and the paragraph brings the
    // landing paragraph back after the code block.
    keys(cx, "M-z");
    assert_eq!(source_of(&editor, cx), source);
    // An external merge keeps the landing paragraph out of the diff.
    let new = "# T2\n\n```rs\nfn x() {}\n```\n";
    let summary = editor
        .update(cx, |e, cx| e.apply_external_source(new, EditOrigin::External, cx))
        .unwrap();
    assert_eq!(summary.removed, 0);
    assert_eq!(source_of(&editor, cx), new);
}

fn source_of(editor: &Entity<BlockEditorState>, cx: &VisualTestContext) -> String {
    source(editor, cx)
}

#[gpui::test]
fn diff_fences_render_as_cards_until_edited(cx: &mut TestAppContext) {
    let src = "intro\n\n```ts diff\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n+c\n```\n\nouter\n";
    let (editor, cx) = open(cx, src);
    let summary = crate::diff_summary(Some("ts"), "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n+c");
    assert_eq!((summary.file.as_deref(), summary.added, summary.removed), (Some("src/x.ts"), 2, 1));
    let code = editor.read_with(cx, |e, _| e.model().document().leaves().nth(1).unwrap().id());
    let bounds = editor.read_with(cx, |e, _| e.node_view_bounds());
    let card = bounds.iter().find(|(b, _)| *b == code).map(|(_, b)| *b).expect("card");
    // Clicking the card enters edit mode: the caret is in the source and the
    // card gives way to the code block.
    cx.simulate_click(card.center(), gpui::Modifiers::none());
    draw(cx);
    assert_eq!(editor.read_with(cx, |e, _| e.model().caret().map(|c| c.block)), Some(code));
    assert!(editor.read_with(cx, |e, _| e.node_view_bounds().iter().all(|(b, _)| *b != code)));
    assert_eq!(source(&editor, cx), src);
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("notefig-editor-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[gpui::test]
fn images_paste_and_drop_into_the_assets_folder(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "text\n");
    let dir = temp_dir("assets");
    let assets = dir.join("assets");
    let target = crate::ImageAssetTarget {
        dir: assets.clone(),
        src_prefix: "assets/".into(),
    };
    editor.update(cx, |e, _| {
        let target = target.clone();
        e.set_image_asset_target(Some(move || Some(target.clone())))
    });
    caret_end(&editor, cx, 0);
    let image = gpui::Image::from_bytes(gpui::ImageFormat::Png, vec![1, 2, 3]);
    cx.write_to_clipboard(ClipboardItem::new_image(&image));
    keys(cx, "M-v");
    assert_eq!(source(&editor, cx), "text![](assets/pasted-image.png)\n");
    assert_eq!(std::fs::read(assets.join("pasted-image.png")).unwrap(), vec![1, 2, 3]);
    // Drop an OS file with spaces and parentheses in its name, twice.
    let file = dir.join("My Shot (1).png");
    std::fs::write(&file, [9u8]).unwrap();
    let log = events(&editor, cx);
    editor.update(cx, |e, cx| {
        e.drop_paths(&[file.clone(), file.clone(), dir.join("notes.txt")], None, cx)
    });
    let src = source(&editor, cx);
    assert!(src.contains("![](assets/My-Shot-1.png)![](assets/My-Shot-1-1.png)"), "{src}");
    assert!(log.borrow().iter().any(|e| matches!(e, BlockEditorEvent::FilesDropped { paths } if paths.len() == 1)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[gpui::test]
fn any_top_level_block_drags_by_its_handle(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "first\n\nsecond\n\nthird\n");
    let bounds = editor.read_with(cx, |e, _| e.top_level_bounds());
    let (first, third) = (bounds[0].2, bounds[2].2);
    let handle = gpui::point(first.left() - px(14.), first.center().y);
    cx.simulate_mouse_move(handle, None, gpui::Modifiers::none());
    cx.simulate_mouse_down(handle, gpui::MouseButton::Left, gpui::Modifiers::none());
    let below = gpui::point(third.left() + px(4.), third.bottom() - px(1.));
    cx.simulate_mouse_move(below, Some(gpui::MouseButton::Left), gpui::Modifiers::none());
    cx.simulate_mouse_up(below, gpui::MouseButton::Left, gpui::Modifiers::none());
    draw(cx);
    assert_eq!(source(&editor, cx), "second\n\nthird\n\nfirst\n");
    keys(cx, "M-z");
    assert_eq!(source(&editor, cx), "first\n\nsecond\n\nthird\n");
}

#[gpui::test]
fn properties_panel_edits_the_frontmatter(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "---\ntitle: A\n# note\n---\n\nbody\n");
    cx.update(|window, cx| editor.update(cx, |e, cx| e.open_properties(window, cx)));
    draw(cx);
    assert!(editor.read_with(cx, |e, _| e.is_properties_open()));
    // Edit the value through the row's input, add a row, apply.
    cx.update(|window, cx| {
        editor.update(cx, |e, cx| {
            let panel = e.notefig.properties.as_ref().unwrap();
            let value = panel.rows_for_test()[0].1.clone();
            value.update(cx, |i, cx| i.set_value("B", window, cx));
        })
    });
    cx.update(|window, cx| editor.update(cx, |e, cx| e.close_properties(true, window, cx)));
    assert_eq!(source(&editor, cx), "---\ntitle: B\n# note\n---\n\nbody\n");
    keys(cx, "M-z");
    assert_eq!(source(&editor, cx), "---\ntitle: A\n# note\n---\n\nbody\n");
}

#[gpui::test]
fn language_picker_sets_the_caret_blocks_language(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "```ts diff\n-a\n+b\n```\n\nx\n");
    editor.update(cx, |e, cx| {
        let id = e.model().document().leaves().next().unwrap().id();
        e.set_selection(BlockSelection::caret(BlockPosition::new(id, 0)), cx).unwrap();
    });
    draw(cx);
    draw(cx);
    let overlays = editor.read_with(cx, |e, _| e.notefig.overlay_bounds.borrow().clone());
    assert_eq!(overlays.len(), 1, "the language button shows");
    cx.simulate_click(overlays[0].center(), gpui::Modifiers::none());
    draw(cx);
    assert!(editor.read_with(cx, |e, _| e.notefig.language_picker.is_some()));
    editor.update(cx, |e, cx| e.set_code_language(Some("rust"), cx));
    assert_eq!(source(&editor, cx), "```rust diff\n-a\n+b\n```\n\nx\n");
}

#[gpui::test]
fn async_load_shows_a_prefix_then_the_whole_document(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "");
    let log = events(&editor, cx);
    let doc = crate::tests::perf::large_document();
    let task = editor.update(cx, |e, cx| e.set_source_async(doc.clone(), cx));
    let (loading, prefix_len, readonly) =
        editor.read_with(cx, |e, _| (e.is_loading(), e.model().source().len(), e.is_readonly()));
    assert!(loading && readonly);
    // Only the head is in the model, but `source()` already reports the
    // whole file, so reads mid-load never see a truncated document.
    assert!(prefix_len > 0 && prefix_len < doc.len() / 4, "{prefix_len}");
    assert!(doc.starts_with(&editor.read_with(cx, |e, _| e.model().source())));
    assert_eq!(source(&editor, cx), doc);
    cx.background_executor.run_until_parked();
    drop(task);
    draw(cx);
    assert!(!editor.read_with(cx, |e, _| e.is_loading()));
    assert!(!editor.read_with(cx, |e, _| e.is_readonly()));
    assert_eq!(source(&editor, cx), doc);
    assert!(log.borrow().iter().any(|e| matches!(e, BlockEditorEvent::Loaded)));
}

#[gpui::test]
fn a_merge_mid_async_load_supersedes_the_pending_parse(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "");
    let doc = crate::tests::perf::large_document();
    let newer = format!("{doc}\nappended by an agent\n");
    let _task = editor.update(cx, |e, cx| e.set_source_async(doc.clone(), cx));
    editor
        .update(cx, |e, cx| e.apply_external_source(&newer, EditOrigin::External, cx))
        .unwrap();
    assert_eq!(source(&editor, cx), newer);
    cx.background_executor.run_until_parked();
    draw(cx);
    assert!(!editor.read_with(cx, |e, _| e.is_loading()));
    assert_eq!(source(&editor, cx), newer, "the stale parse must not win");
}

#[gpui::test]
fn slash_over_a_selection_summons_a_widget_on_it(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "alpha beta\n\nnext\n");
    let log = events(&editor, cx);
    editor.update(cx, |e, cx| {
        let l = e.model().document().leaves().next().unwrap().id();
        e.set_selection(
            BlockSelection::Text {
                anchor: BlockPosition::new(l, 6),
                head: BlockPosition::new(l, 10),
            },
            cx,
        )
        .unwrap();
    });
    cx.simulate_input("/");
    draw(cx);
    let summoned = log.borrow().iter().find_map(|e| match e {
        BlockEditorEvent::SelectionSummoned { block, reference, .. } => Some((*block, reference.clone())),
        _ => None,
    });
    let (block, reference) = summoned.expect("selection summon");
    assert_eq!(reference.text.as_ref(), "beta");
    // The `/` was consumed; the referenced text stays.
    assert_eq!(source(&editor, cx), "alpha beta\n\nnext\n");
    assert_eq!(editor.read_with(cx, |e, _| e.model().caret().map(|c| c.block)), Some(block));
}

#[gpui::test]
fn slash_over_a_selection_types_when_the_trigger_is_off(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "alpha beta\n");
    editor.update(cx, |e, cx| {
        e.set_slash_trigger(false);
        let l = e.model().document().leaves().next().unwrap().id();
        e.set_selection(
            BlockSelection::Text { anchor: BlockPosition::new(l, 0), head: BlockPosition::new(l, 5) },
            cx,
        )
        .unwrap();
    });
    cx.simulate_input("/");
    draw(cx);
    assert_eq!(source(&editor, cx), "/ beta\n");
}

#[gpui::test]
fn a_guarded_widget_survives_select_all_delete(cx: &mut TestAppContext) {
    let (editor, cx) = open(cx, "text\n");
    let log = events(&editor, cx);
    let w = editor
        .update(cx, |e, cx| {
            let t = e.model().document().leaves().next().unwrap().id();
            e.set_widget_removal_guard(Some(Rc::new(|_: &PromptWidget| true)));
            e.insert_prompt_widget(
                PromptWidget::new("blob_g", Some("task_g".into())),
                WidgetPlacement::After(t),
                cx,
            )
        })
        .unwrap();
    keys(cx, "M-a backspace");
    assert_eq!(editor.read_with(cx, |e, _| e.model().find_prompt_widget("blob_g")), Some(w));
    assert!(log.borrow().iter().any(|e| matches!(
        e,
        BlockEditorEvent::WidgetRemovalRefused { block, .. } if *block == w
    )));
}

struct RailRoot(Entity<BlockEditorState>, Rc<RefCell<Vec<String>>>);

impl Render for RailRoot {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let jumped = self.1.clone();
        div()
            .relative()
            .w(px(600.))
            .h(px(800.))
            .child(BlockEditor::new(&self.0).px(px(48.)))
            .child(
                crate::MinimapRail::new(
                    &self.0,
                    Rc::new(|w: &PromptWidget, _: &gpui::App| crate::MinimapDot {
                        title: w.id.clone(),
                        state: crate::MinimapDotState {
                            breathe: true,
                            ping: true,
                            hollow: true,
                            pulse: true,
                            ..Default::default()
                        },
                    }),
                )
                .on_jump(Rc::new(move |_, _, w, _, _| jumped.borrow_mut().push(w.id.to_string()))),
            )
    }
}

#[gpui::test]
fn the_minimap_rail_jumps_to_a_widget(cx: &mut TestAppContext) {
    cx.update(crate::init_for_tests);
    let jumped: Rc<RefCell<Vec<String>>> = Rc::default();
    let sink = jumped.clone();
    let (root, cx) = cx.add_window_view(move |window, cx| {
        let editor = cx.new(|cx| BlockEditorState::new(window, cx).with_source("a\n\nb\n"));
        RailRoot(editor, sink)
    });
    let editor = root.read_with(cx, |r, _| r.0.clone());
    draw(cx);
    editor
        .update(cx, |e, cx| {
            let a = e.model().document().leaves().next().unwrap().id();
            e.insert_prompt_widget(PromptWidget::new("blob_m", None), WidgetPlacement::After(a), cx)
        })
        .unwrap();
    draw(cx);
    let entries = editor.read_with(cx, |e, _| e.minimap_entries());
    assert_eq!(entries.len(), 1);
    // The rail sits at the top right: right 0.5rem, top 1.5rem, 7rem tall.
    let rem = cx.update(|window, _| window.rem_size());
    let x = px(600.) - rem * 0.5 - px(6. * rem.as_f32() / 16.);
    let y = rem * 1.5 + rem * 7. * entries[0].ratio;
    cx.simulate_click(gpui::point(x, y), gpui::Modifiers::none());
    draw(cx);
    assert_eq!(*jumped.borrow(), vec!["blob_m".to_string()]);
}
