//! Notefig additions: source-preserving round trip over real-world
//! fixtures, frontmatter, prompt widgets, Notefig syntax, external merge,
//! PM positions, change tracking and agent inserts.

use super::*;
use crate::kind::BlockKindData;
use crate::{MAX_REFERENCE_CHARS, Property, apply_properties, dot_title, parse_properties, spread_ratios};

const FIXTURES: &[(&str, &str)] = &[
    (
        "01-meeting-notes.md",
        include_str!("../../tests/fixtures/notefig/01-meeting-notes.md"),
    ),
    (
        "02-widgets-and-diffs.md",
        include_str!("../../tests/fixtures/notefig/02-widgets-and-diffs.md"),
    ),
    (
        "03-crlf.md",
        include_str!("../../tests/fixtures/notefig/03-crlf.md"),
    ),
    (
        "04-agent-fixture-readme.md",
        include_str!("../../tests/fixtures/notefig/04-agent-fixture-readme.md"),
    ),
    (
        "05-messy.md",
        include_str!("../../tests/fixtures/notefig/05-messy.md"),
    ),
    (
        "06-no-newline.md",
        include_str!("../../tests/fixtures/notefig/06-no-newline.md"),
    ),
    (
        "07-scratchpad.md",
        include_str!("../../tests/fixtures/notefig/07-scratchpad.md"),
    ),
    ("upstream test.md", include_str!("../../tests/fixtures/test.md")),
];

fn leaf_with_text(m: &BlockEditorModel, text: &str) -> BlockId {
    m.document()
        .leaves()
        .find(|l| l.text() == Some(text))
        .unwrap_or_else(|| panic!("no leaf {text:?}"))
        .id()
}

fn caret_at_end_of(m: &mut BlockEditorModel, id: BlockId) {
    let len = m.document().block(id).unwrap().text().map(str::len).unwrap_or(1);
    m.set_selection(BlockSelection::caret(BlockPosition::new(id, len)))
        .unwrap();
}

// ---- source preservation ---------------------------------------------------

#[test]
fn fixtures_open_and_save_unchanged() {
    for (name, source) in FIXTURES {
        let m = model(source);
        assert_invariants(&m);
        assert_eq!(&m.source(), source, "{name} was rewritten on open+save");
    }
}

#[test]
fn round_trip_cases_from_the_ts_suite_are_identities() {
    // Canonical and non-canonical inputs from markdown-roundtrip.test.ts:
    // all of them are now identities while untouched.
    for source in [
        "* a\n* b",
        "+ a\n+ b",
        "_em_ and __strong__",
        "Setext\n======",
        "a  \nb",
        "3. c\n4. d",
        "text ![i](x.png) more",
        "---\n---\n\nbody",
        "---\na: 1\n---\nno blank line after the fence",
        "<!-- a note -->\n\ntext",
        "<div>unknown</div>",
        "| a |\n|---|\n| 1 |",
        "[ref link][r]\n\n[r]: https://x",
        "footnote[^1]\n\n[^1]: body",
        "a &nbsp; b",
        "trailing spaces   ",
        "- [ ]",
        "```\n\n```",
        "\n\n\nleading blank lines",
        "two blank lines at the end\n\n\n",
    ] {
        assert_eq!(model(source).source(), source, "{source:?}");
    }
}

#[test]
fn editing_one_block_rewrites_only_that_block() {
    let source = FIXTURES[0].1;
    let mut m = model(source);
    let heading = leaf_with_text(&m, "Agenda");
    caret_at_end_of(&mut m, heading);
    m.insert_text("X", EditOrigin::Typing).unwrap();
    assert_eq!(m.source(), source.replacen("## Agenda\n", "## AgendaX\n", 1));
    // Undo brings the original bytes back.
    m.undo();
    assert_eq!(m.source(), source);
}

#[test]
fn edited_blocks_use_the_canonical_form() {
    let mut m = model("* a\n* b\n\n_x_\n");
    let x = leaf_with_text(&m, "x");
    caret_at_end_of(&mut m, x);
    m.insert_text("y", EditOrigin::Typing).unwrap();
    // The list is untouched (stars stay); the edited paragraph keeps the
    // file's `_` emphasis.
    assert_eq!(m.source(), "* a\n* b\n\n_xy_\n");
}

#[test]
fn new_blocks_are_separated_by_a_blank_line_and_keep_the_final_newline() {
    let mut m = model("# T\n\npara\n");
    m.select_end().unwrap();
    m.split_block().unwrap();
    m.insert_text("new", EditOrigin::Typing).unwrap();
    assert_eq!(m.source(), "# T\n\npara\n\nnew\n");
}

#[test]
fn edited_hard_break_is_written_as_backslash_newline() {
    let mut m = model("a  \nb\n");
    let leaf = m.document().leaves().next().unwrap().id();
    caret_at_end_of(&mut m, leaf);
    m.insert_text("c", EditOrigin::Typing).unwrap();
    assert_eq!(m.source(), "a\\\nbc\n");
}

#[test]
fn empty_task_item_is_a_task_and_writes_without_trailing_space() {
    let mut m = model("- [ ]\n- [x]\n");
    let kinds: Vec<_> = m
        .document()
        .root()
        .children()
        .next()
        .unwrap()
        .children()
        .map(|item| item.kind())
        .collect();
    assert_eq!(
        kinds,
        vec![
            BlockKind::ListItem { checked: Some(false) },
            BlockKind::ListItem { checked: Some(true) }
        ]
    );
    // Touch the list so it is written canonically.
    caret_in(&mut m, 0, 0);
    m.insert_text("a", EditOrigin::Typing).unwrap();
    m.undo();
    m.break_coalescing();
    caret_in(&mut m, 1, 0);
    m.insert_text("b", EditOrigin::Typing).unwrap();
    assert_eq!(m.source(), "- [ ]\n- [x] b\n");
}

// ---- frontmatter ----------------------------------------------------------

#[test]
fn frontmatter_is_an_atom_with_get_and_set() {
    let source = FIXTURES[0].1;
    let mut m = model(source);
    let yaml = m.frontmatter().unwrap().to_string();
    assert!(yaml.starts_with("title: Weekly sync\n"));
    assert!(yaml.ends_with("# a comment the properties popover must keep"));
    // The first leaf is the heading, not YAML.
    assert_eq!(
        m.document().leaves().next().unwrap().kind(),
        BlockKind::Heading { level: 1 }
    );
    assert!(m.set_frontmatter(Some("title: Renamed\n")).unwrap());
    assert!(m.source().starts_with("---\ntitle: Renamed\n---\n\n# Weekly sync"));
    m.undo();
    assert_eq!(m.source(), source);
    // Removing it.
    m.set_frontmatter(None).unwrap();
    assert!(m.source().starts_with("# Weekly sync"));
    // Adding one to a document without.
    let mut m = model("body\n");
    assert_eq!(m.frontmatter(), None);
    m.set_frontmatter(Some("a: 1")).unwrap();
    assert_eq!(m.source(), "---\na: 1\n---\n\nbody\n");
}

#[test]
fn frontmatter_split_rules() {
    // Unclosed opening fence: a rule, not frontmatter.
    assert_eq!(model("---\nnot closed\n").frontmatter(), None);
    // A `---` pair later in the document is not frontmatter.
    assert_eq!(model("text\n\n---\na\n---\n").frontmatter(), None);
    // CRLF fences.
    let m = model("---\r\na: 1\r\n---\r\n\r\nbody");
    assert_eq!(m.frontmatter(), Some("a: 1"));
    assert_eq!(m.source(), "---\r\na: 1\r\n---\r\n\r\nbody");
}

// ---- Notefig syntax ---------------------------------------------------------

#[test]
fn prompt_markers_parse_to_widgets() {
    let m = model(FIXTURES[1].1);
    let widgets = m.prompt_widgets();
    assert_eq!(widgets.len(), 2);
    assert_eq!(widgets[0].1.id, "blob_lx2k9a7f3");
    assert_eq!(widgets[0].1.task.as_deref(), Some("task_abc123"));
    assert_eq!(m.find_prompt_widget("blob_second"), Some(widgets[1].0));
    // Positional form, and an invalid marker stays an HTML atom.
    assert_eq!(
        PromptWidget::parse_marker("<!-- notefig:prompt blob_a task_b -->"),
        Some(PromptWidget::new("blob_a", Some("task_b".into())))
    );
    assert_eq!(PromptWidget::parse_marker("<!-- notefig:prompting x -->"), None);
    assert_eq!(model("<!-- notefig:prompt id=\"bad id!\" -->").prompt_widgets().len(), 0);
}

#[test]
fn a_repeated_widget_id_is_dropped() {
    let m = model(
        "<!-- notefig:prompt id=\"blob_a\" task=\"t\" -->\n\nx\n\n<!-- notefig:prompt id=\"blob_a\" task=\"t\" -->\n",
    );
    assert_eq!(m.prompt_widgets().len(), 1);
}

#[test]
fn widget_insert_bind_and_remove() {
    let mut m = model("# Doc\n\n");
    // The `/` paragraph the slash trigger leaves behind.
    m.select_end().unwrap();
    m.insert_text("/", EditOrigin::Typing).unwrap();
    let slash = m.caret().unwrap().block;
    let widget = PromptWidget::new("blob_new", None);
    let block = m
        .insert_prompt_widget(widget.clone(), WidgetPlacement::Replace(slash))
        .unwrap();
    assert_eq!(m.caret().unwrap().block, block);
    // Unbound: nothing on disk, and no blank-line churn.
    assert_eq!(m.source(), "# Doc\n\n");
    // Bound: the marker is written.
    m.set_prompt_widget(
        block,
        PromptWidget {
            task: Some("task_1".into()),
            ..widget.clone()
        },
    )
    .unwrap();
    assert_eq!(
        m.source(),
        "# Doc\n\n<!-- notefig:prompt id=\"blob_new\" task=\"task_1\" -->"
    );
    assert_eq!(m.find_prompt_widget("blob_new"), Some(block));
    // Esc on a summoned widget reverts it to `/`.
    m.remove_prompt_widget(block, Some("/")).unwrap();
    assert_eq!(m.prompt_widgets().len(), 0);
    assert!(m.source().starts_with("# Doc\n\n/"));
    m.undo();
    assert_eq!(m.find_prompt_widget("blob_new"), Some(block));
}

#[test]
fn sub_and_sup_are_atoms_that_round_trip() {
    let mut m = model("H<sub>2</sub>O and x<sup>*2*</sup>\n");
    let leaf = m.document().leaves().next().unwrap();
    let text = leaf.text().unwrap().to_string();
    assert_eq!(text.matches(crate::inline::ATOM_CHAR).count(), 2, "{text:?}");
    let id = leaf.id();
    caret_at_end_of(&mut m, id);
    m.insert_text("!", EditOrigin::Typing).unwrap();
    assert_eq!(m.source(), "H<sub>2</sub>O and x<sup>*2*</sup>!\n");
}

#[test]
fn mentions_insert_as_atoms_written_as_paths() {
    let mut m = model("see\n");
    let id = m.document().leaves().next().unwrap().id();
    caret_at_end_of(&mut m, id);
    m.insert_text(" ", EditOrigin::Typing).unwrap();
    m.insert_mention("notes/plan.md").unwrap();
    assert_eq!(m.source(), "see @notes/plan.md \n");
}

#[test]
fn diff_fences_are_recognised() {
    assert!(is_diff_fence(Some("ts"), Some("diff")));
    assert!(!is_diff_fence(Some("diff"), None));
    let m = model(FIXTURES[1].1);
    let diff_blocks = m
        .document()
        .leaves()
        .filter(|l| {
            matches!(
                m.doc().kind(l.id()),
                Some(BlockKindData::CodeBlock { lang, meta })
                    if is_diff_fence(lang.as_deref(), meta.as_deref())
            )
        })
        .count();
    assert_eq!(diff_blocks, 1);
}

// ---- external merge ---------------------------------------------------------

#[test]
fn merging_identical_source_changes_nothing() {
    let source = FIXTURES[0].1;
    let mut m = model(source);
    let revision = m.revision();
    let summary = m.apply_external_source(source, EditOrigin::External).unwrap();
    assert!(!summary.changed);
    assert_eq!(m.revision(), revision);
    assert!(!m.can_undo());
}

#[test]
fn merge_keeps_ids_edits_in_place_and_is_one_undo_step() {
    let old = "# Title\n\nfirst para\n\nsecond para\n\n- a\n- b\n";
    let new = "# Title\n\nfirst para, edited\n\nsecond para\n\n- a\n- b\n- c\n\nnew tail\n";
    let mut m = model(old);
    let ids_before: Vec<BlockId> = m.document().root().children().map(|b| b.id()).collect();
    let second = leaf_with_text(&m, "second para");
    m.set_selection(BlockSelection::caret(BlockPosition::new(second, 3)))
        .unwrap();
    let summary = m.apply_external_source(new, EditOrigin::External).unwrap();
    assert!(summary.changed);
    assert_eq!(m.source(), new, "the merged document writes the new bytes");
    let ids_after: Vec<BlockId> = m.document().root().children().map(|b| b.id()).collect();
    // Heading, both paragraphs keep their ids (one edited in place).
    assert_eq!(&ids_after[..3], &ids_before[..3]);
    // The caret stayed in its unchanged block.
    assert_eq!(m.caret(), Some(BlockPosition::new(second, 3)));
    // One undo step restores the old document and bytes.
    assert!(m.undo());
    assert_eq!(m.source(), old);
    assert!(!m.can_undo());
    assert!(m.redo());
    assert_eq!(m.source(), new);
}

#[test]
fn merge_maps_the_caret_through_an_in_place_edit() {
    let mut m = model("hello world\n");
    let id = m.document().leaves().next().unwrap().id();
    m.set_selection(BlockSelection::caret(BlockPosition::new(id, 8)))
        .unwrap();
    m.apply_external_source("hello brave world\n", EditOrigin::External)
        .unwrap();
    assert_eq!(m.caret(), Some(BlockPosition::new(id, 14)));
}

#[test]
fn merge_keeps_widgets_the_new_text_dropped() {
    let old = "intro\n\n<!-- notefig:prompt id=\"blob_a\" task=\"task_a\" -->\n\noutro\n";
    let mut m = model(old);
    let widget = m.find_prompt_widget("blob_a").unwrap();
    // An agent rewrites the file without the marker.
    let summary = m
        .apply_external_source("intro rewritten\n\noutro\n", EditOrigin::External)
        .unwrap();
    assert_eq!(summary.reinserted_widgets, 1);
    assert_eq!(m.find_prompt_widget("blob_a"), Some(widget));
    assert_eq!(
        m.source(),
        "intro rewritten\n\n<!-- notefig:prompt id=\"blob_a\" task=\"task_a\" -->\n\noutro\n"
    );
    // An unbound widget (never in the file) also survives, silently.
    let mut m = model("a\n\nb\n");
    let b = leaf_with_text(&m, "b");
    m.insert_prompt_widget(
        PromptWidget::new("blob_u", None),
        WidgetPlacement::After(b),
    )
    .unwrap();
    let summary = m
        .apply_external_source("a\n\nb changed\n", EditOrigin::External)
        .unwrap();
    assert_eq!(summary.reinserted_widgets, 0);
    assert!(m.find_prompt_widget("blob_u").is_some());
    assert_eq!(m.source(), "a\n\nb changed\n");
}

#[test]
fn merge_handles_frontmatter_and_structural_changes() {
    let mut m = model("---\na: 1\n---\n\n# T\n\n> q\n");
    let new = "---\na: 2\n---\n\n# T\n\n1. one\n2. two\n\n```rs\nfn x() {}\n```\n";
    m.apply_external_source(new, EditOrigin::External).unwrap();
    assert_eq!(m.frontmatter(), Some("a: 2"));
    assert_eq!(m.source(), new);
    assert_invariants(&m);
    m.undo();
    assert_eq!(m.source(), "---\na: 1\n---\n\n# T\n\n> q\n");
}

#[test]
fn merge_of_every_fixture_pair_is_exact() {
    for (_, a) in FIXTURES {
        for (_, b) in FIXTURES {
            let mut m = model(a);
            m.apply_external_source(b, EditOrigin::External).unwrap();
            // Widgets that b drops are kept, so compare only when b keeps them.
            if m.prompt_widgets().len() == model(b).prompt_widgets().len() {
                assert_eq!(&m.source(), b);
            }
            assert_invariants(&m);
            m.undo();
            assert_invariants(&m);
        }
    }
}

// ---- PM positions -------------------------------------------------------------

#[test]
fn pm_positions_follow_prosemirror_arithmetic() {
    // doc(heading("H"), paragraph("para")): heading 0..3, paragraph 3..9.
    let m = model("# H\n\npara");
    assert_eq!(m.pm_size(), 9);
    let para = leaf_with_text(&m, "para");
    assert_eq!(m.pm_from_position(BlockPosition::new(para, 0)), Some(4));
    assert_eq!(m.position_from_pm(6), Some(BlockPosition::new(para, 2)));
    assert_eq!(m.pm_text_between(0, 9, "\n\n", None), "H\n\npara");
    assert_eq!(m.pm_text_between(5, 7, "\n", None), "ar");
    // bulletList > listItem > paragraph > "a": 7.
    assert_eq!(model("- a").pm_size(), 7);
    // UTF-16: an emoji counts 2.
    let m = model("😀x");
    assert_eq!(m.pm_size(), 5);
    let id = m.document().leaves().next().unwrap().id();
    assert_eq!(m.pm_from_position(BlockPosition::new(id, 4)), Some(3));
    // Frontmatter is a 1-size leaf at 0.
    assert_eq!(model("---\na: 1\n---\n\nx").pm_size(), 4);
    // Table cells hold a paragraph: table(row(cell(p("a")))) etc.
    assert_eq!(model("| a |\n|---|\n| b |").pm_size(), 2 + 2 * (2 + 5));
    assert!(m.outline().is_empty());
    let m = model("# A\n\ntext\n\n## B\n\nmore");
    let outline = m.outline();
    assert_eq!(
        outline.iter().map(|h| (h.level, h.text.as_str(), h.pos)).collect::<Vec<_>>(),
        vec![(1, "A", 0), (2, "B", 9)]
    );
    assert_eq!(m.nearest_preceding_heading(8).map(|h| h.text), Some("A".into()));
    assert_eq!(m.nearest_preceding_heading(12).map(|h| h.text), Some("B".into()));
    let range = m.document_read_range(0, 1000);
    assert_eq!(range.content, "A\ntext\nB\nmore");
    assert_eq!((range.from, range.to, range.doc_size), (0, 18, 18));
    assert_eq!(m.window_around_pos(6, 4), "text");
}

// ---- change tracking and agent inserts --------------------------------------

#[test]
fn agent_edits_are_tracked_and_mapped() {
    let round = RoundId(7);
    let mut m = model("# T\n\nalpha\n\nbeta\n");
    m.track_changes(round);
    let alpha = leaf_with_text(&m, "alpha");
    let beta = leaf_with_text(&m, "beta");
    // The agent writes " gamma" after "beta".
    let at = m.pm_from_position(BlockPosition::new(beta, 4)).unwrap();
    m.insert_at(at, " gamma", EditOrigin::Agent { round: Some(round) })
        .unwrap();
    assert_eq!(m.source(), "# T\n\nalpha\n\nbeta gamma\n");
    assert_eq!(
        m.tracked_changes(round),
        vec![TrackedChange {
            round,
            block: beta,
            range: 4..10
        }]
    );
    assert_eq!(m.changed_blocks(round), vec![beta]);
    // The user types before the change: the span moves.
    m.set_selection(BlockSelection::caret(BlockPosition::new(beta, 0)))
        .unwrap();
    m.insert_text(">> ", EditOrigin::Typing).unwrap();
    assert_eq!(m.tracked_changes(round)[0].range, 7..13);
    // User edits elsewhere are not tracked.
    caret_at_end_of(&mut m, alpha);
    m.insert_text("!", EditOrigin::Typing).unwrap();
    assert_eq!(m.tracked_changes(round).len(), 1);
    // An external merge tagged with the round is tracked too.
    let source = m.source();
    let new = source.replace("alpha!", "alpha! (agent)");
    m.apply_external_source(&new, EditOrigin::Agent { round: Some(round) })
        .unwrap();
    assert_eq!(m.changed_blocks(round), vec![alpha, beta]);
    m.untrack_changes(round);
    assert!(m.tracked_changes(round).is_empty());
}

#[test]
fn replace_range_keeps_the_user_selection() {
    let mut m = model("one two three\n");
    let id = m.document().leaves().next().unwrap().id();
    m.set_selection(BlockSelection::caret(BlockPosition::new(id, 13)))
        .unwrap();
    // Replace "two" (PM 5..8) with "2".
    m.replace_range(5, 8, "2", EditOrigin::Agent { round: None })
        .unwrap();
    assert_eq!(m.source(), "one 2 three\n");
    assert_eq!(m.caret(), Some(BlockPosition::new(id, 11)));
    // Multi-line text is parsed as blocks.
    let end = m.pm_size();
    m.insert_at(end, "\n\n## Added\n\n- x\n", EditOrigin::Agent { round: None })
        .unwrap();
    assert!(m.source().contains("## Added"), "{}", m.source());
}

#[test]
fn search_finds_matches_in_leaves() {
    let m = model("Alpha beta\n\n- alpha\n\n```\nALPHA\n```\n");
    assert_eq!(m.find_all("alpha", false).len(), 3);
    assert_eq!(m.find_all("alpha", true).len(), 1);
}

// ---- large documents ---------------------------------------------------------------

fn large_doc(lines: usize) -> String {
    let mut out = String::from("---\ntitle: large\n---\n\n");
    let mut n = 0;
    let mut i = 0;
    while n < lines {
        match i % 7 {
            0 => out.push_str(&format!("## Section {i}\n\n")),
            1 => out.push_str("A paragraph with *some* **marks** and `code` that goes on for a while.\n\n"),
            2 => out.push_str("- item one\n- item two\n  - nested\n\n"),
            3 => out.push_str("| a | b |\n|---|---|\n| 1 | 2 |\n\n"),
            4 => out.push_str(&format!("<!-- notefig:prompt id=\"blob_{i}\" task=\"task_{i}\" -->\n\n")),
            5 => out.push_str("```rs\nfn main() {}\n```\n\n"),
            _ => out.push_str("> quoted text\n\n"),
        }
        n += 3;
        i += 1;
    }
    out
}

#[test]
fn large_document_round_trips_and_merges() {
    let source = large_doc(8000);
    let start = std::time::Instant::now();
    let mut m = model(&source);
    let parsed = start.elapsed();
    let start = std::time::Instant::now();
    assert_eq!(m.source(), source);
    let saved = start.elapsed();
    let new = source.replacen("## Section 700\n", "## Section 700 (agent)\n", 1);
    let start = std::time::Instant::now();
    let summary = m.apply_external_source(&new, EditOrigin::External).unwrap();
    let merged = start.elapsed();
    assert_eq!(summary.edited, 1);
    assert_eq!(m.source(), new);
    eprintln!(
        "8k lines ({} bytes): parse {parsed:?}, save {saved:?}, merge {merged:?}",
        source.len()
    );
}

// ---- round 2: recursive merge ------------------------------------------------

#[test]
fn merge_edits_inside_lists_quotes_and_tables_in_place() {
    let old = "- one\n- two\n  - deep\n- three\n\n> quoted\n> text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    let new = "- one\n- two (agent)\n  - deep\n  - deeper\n- three\n\n> quoted\n> text, edited\n\n| a | b |\n|---|---|\n| 1 | 20 |\n";
    let mut m = model(old);
    let two = leaf_with_text(&m, "two");
    let deep = leaf_with_text(&m, "deep");
    let cell = leaf_with_text(&m, "2");
    m.set_selection(BlockSelection::caret(BlockPosition::new(two, 2)))
        .unwrap();
    let round = RoundId(3);
    m.track_changes(round);
    let summary = m
        .apply_external_source(new, EditOrigin::Agent { round: Some(round) })
        .unwrap();
    assert_eq!(m.source(), new);
    assert_eq!(summary.removed, 0, "{summary:?}");
    // Ids inside the containers survive; the caret stays in its item.
    assert_eq!(m.document().block(two).unwrap().text(), Some("two (agent)"));
    assert_eq!(m.document().block(deep).unwrap().text(), Some("deep"));
    assert_eq!(m.document().block(cell).unwrap().text(), Some("20"));
    assert_eq!(m.caret(), Some(BlockPosition::new(two, 2)));
    // Tracking sees the in-place spans, not whole blocks.
    let changes = m.tracked_changes(round);
    assert!(changes.iter().any(|c| c.block == two && c.range == (3..11)), "{changes:?}");
    m.undo();
    assert_eq!(m.source(), old);
}

#[test]
fn merge_keeps_widgets_inside_lists() {
    let mut m = model("- a\n- b\n");
    let b = leaf_with_text(&m, "b");
    let w = m
        .insert_prompt_widget(
            PromptWidget::new("blob_l", Some("task_l".into())),
            WidgetPlacement::After(b),
        )
        .unwrap();
    let written = m.source();
    assert!(written.contains("notefig:prompt"), "{written}");
    // The agent rewrites the list without the marker.
    let summary = m
        .apply_external_source("- a\n- b changed\n", EditOrigin::External)
        .unwrap();
    assert_eq!(summary.reinserted_widgets, 1);
    assert_eq!(m.find_prompt_widget("blob_l"), Some(w));
    assert_invariants(&m);
}

// ---- round 2: deletions, joins, navigator ---------------------------------------

#[test]
fn deletions_leave_markers_and_joins_keep_spans() {
    let round = RoundId(9);
    let mut m = model("alpha beta\n\ngone\n\nlast\n");
    m.track_changes(round);
    let alpha = leaf_with_text(&m, "alpha beta");
    let last = leaf_with_text(&m, "last");
    // The agent deletes " beta" and the whole "gone" paragraph.
    let summary = m
        .apply_external_source("alpha\n\nlast\n", EditOrigin::Agent { round: Some(round) })
        .unwrap();
    assert_eq!(summary.removed, 1);
    let changes = m.tracked_changes(round);
    assert!(changes.contains(&TrackedChange { round, block: alpha, range: 5..5 }), "{changes:?}");
    assert!(changes.contains(&TrackedChange { round, block: last, range: 0..0 }), "{changes:?}");
    // The agent appends to "last"; then the user joins "last" into "alpha"
    // with Backspace: the span moves with the text.
    m.apply_external_source("alpha\n\nlast word\n", EditOrigin::Agent { round: Some(round) })
        .unwrap();
    assert!(m.tracked_changes(round).iter().any(|c| c.block == last && c.range == (4..9)));
    m.set_selection(BlockSelection::caret(BlockPosition::new(last, 0))).unwrap();
    m.delete(false).unwrap();
    assert_eq!(m.source(), "alphalast word\n");
    assert!(
        m.tracked_changes(round).iter().any(|c| c.block == alpha && c.range == (9..14)),
        "{:?}",
        m.tracked_changes(round)
    );
}

#[test]
fn change_stops_are_one_per_block_in_order() {
    let round = RoundId(2);
    let mut m = model("a\n\nb\n\nc\n");
    m.track_changes(round);
    m.apply_external_source("a1\n\nb\n\nc1\n", EditOrigin::Agent { round: Some(round) })
        .unwrap();
    let stops = m.change_stops(round);
    assert_eq!(stops.len(), 2);
    assert_eq!(stops[0].1, BlockPosition::new(leaf_with_text(&m, "a1"), 1));
    assert_eq!(stops[1].1, BlockPosition::new(leaf_with_text(&m, "c1"), 1));
}

#[test]
fn properties_parse_and_apply_keep_untouched_yaml() {
    let yaml = "title: Weekly sync\n# keep this comment\ntags:\n  - a\n  - b\ndate: 2026-10-30";
    let props = parse_properties(yaml);
    assert_eq!(
        props.iter().map(|p| (p.key.as_str(), p.value.as_str())).collect::<Vec<_>>(),
        vec![("title", "Weekly sync"), ("date", "2026-10-30")]
    );
    let mut edited = props.clone();
    edited[0].value = "Renamed".into();
    edited.remove(1);
    edited.push(Property { key: "status".into(), value: "draft".into(), line: None });
    assert_eq!(
        apply_properties(yaml, &edited),
        "title: Renamed\n# keep this comment\ntags:\n  - a\n  - b\nstatus: draft"
    );
    assert_eq!(apply_properties(yaml, &props), yaml);
}

#[test]
fn edited_lists_keep_the_files_markers() {
    let mut m = model("* a\n* b\n\n1) one\n2) two\n");
    let b = leaf_with_text(&m, "b");
    caret_at_end_of(&mut m, b);
    m.insert_text("!", EditOrigin::Typing).unwrap();
    let two = leaf_with_text(&m, "two");
    caret_at_end_of(&mut m, two);
    m.insert_text("!", EditOrigin::Typing).unwrap();
    assert_eq!(m.source(), "* a\n* b!\n\n1) one\n2) two!\n");
    // A new list in a file that uses `+` gets `+`.
    let mut m = model("+ x\n\npara\n");
    let para = leaf_with_text(&m, "para");
    m.set_selection(BlockSelection::caret(BlockPosition::new(para, 0))).unwrap();
    m.run(EditorCommand::ToggleList { ordered: false }).unwrap();
    assert!(m.source().contains("+ para"), "{}", m.source());
}

// ---- round 3: incremental merge ------------------------------------------------

fn canonical(m: &BlockEditorModel) -> String {
    crate::source_map::serialize_canonical(m.doc())
}

#[test]
fn incremental_merge_matches_a_full_reparse() {
    let base = crate::tests::perf::large_document();
    let mut rng = 0x1234_5678u64;
    let mut next = move |n: usize| {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        (rng % n as u64) as usize
    };
    let mut m = model(&base);
    let mut text = base.clone();
    let mut fast = 0;
    for round in 0..40 {
        // Edit a random line: replace a word, insert a line, delete a line,
        // add a list item or a heading.
        let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
        let at = next(lines.len());
        match round % 5 {
            0 => lines[at] = lines[at].replacen("the", "THE", 1),
            1 => lines.insert(at, format!("Inserted line {round}.")),
            2 => {
                lines.remove(at);
            }
            3 => lines.insert(at, format!("- agent item {round}")),
            _ => lines.insert(at, format!("\n## Agent heading {round}\n")),
        }
        text = lines.join("\n") + "\n";
        let summary = m.apply_external_source(&text, EditOrigin::External).unwrap();
        fast += usize::from(summary.incremental);
        let got = m.source();
        if got != text {
            let at = got.bytes().zip(text.bytes()).take_while(|(a, b)| a == b).count();
            let lo = at.saturating_sub(200);
            panic!(
                "round {round} (incremental {}): got\n{:?}\nwant\n{:?}",
                summary.incremental,
                &got[lo..(at + 200).min(got.len())],
                &text[lo..(at + 200).min(text.len())]
            );
        }
        assert_eq!(canonical(&m), canonical(&model(&text)), "round {round}: structure");
        assert_invariants(&m);
    }
    assert!(fast >= 20, "incremental path used {fast}/40 times");
}

#[test]
fn incremental_merge_of_a_removed_blank_line() {
    let mut m = model("a\n\nb\n\n## H\n\npara\n\nc\n\nd\n");
    let new = "a\n\nb\n\n## H\npara\n\nc\n\nd\n";
    let s = m.apply_external_source(new, EditOrigin::External).unwrap();
    assert_eq!(m.source(), new, "{s:?}");
}

#[test]
fn streaming_appends_merge_incrementally() {
    let mut text = crate::tests::perf::large_document();
    let mut m = model(&text);
    text.push_str("\n## Streaming\n\n");
    for i in 0..5 {
        text.push_str(&format!("word{i} "));
        let summary = m.apply_external_source(&text, EditOrigin::External).unwrap();
        assert!(summary.incremental, "append {i}");
        assert_eq!(m.source(), text);
    }
    let (a, b) = (canonical(&m), canonical(&model(&text)));
    if a != b {
        panic!("tails:\n{:?}\n{:?}", &a[a.len() - 80..], &b[b.len().saturating_sub(80)..]);
    }
}

#[test]
fn pm_positions_split_paragraphs_at_images_like_tiptap() {
    // TipTap: p("text") image p("more") = 6 + 1 + 6.
    let m = model("text ![i](x.png) more");
    assert_eq!(m.pm_size(), 13);
    let id = m.document().leaves().next().unwrap().id();
    assert_eq!(m.pm_from_position(BlockPosition::new(id, 0)), Some(1));
    assert_eq!(m.pm_from_position(BlockPosition::new(id, 5)), Some(6), "before the image");
    assert_eq!(m.pm_from_position(BlockPosition::new(id, 9)), Some(8), "start of `more`");
    assert_eq!(m.position_from_pm(8), Some(BlockPosition::new(id, 9)));
    assert_eq!(m.position_from_pm(6), Some(BlockPosition::new(id, 5)));
    assert_eq!(m.pm_text_between(0, 13, "\n", Some("[img]")), "text\n[img]\nmore");
    assert_eq!(m.document_read_range(0, 100).content, "text\nmore");
    // An image alone is just the image; a heading after it starts at 1.
    assert_eq!(model("![i](x.png)\n\n# H").pm_size(), 1 + 3);
}

#[test]
fn edited_tables_and_emphasis_follow_the_files_style() {
    let src = "| Owner | Task | Due |\n|:------|:----:|----:|\n| Ana   | spec | Fri |\n| Bo    | impl | Mon |\n";
    let mut m = model(src);
    let ana = leaf_with_text(&m, "Ana");
    caret_at_end_of(&mut m, ana);
    m.insert_text("stasia", EditOrigin::Typing).unwrap();
    assert_eq!(
        m.source(),
        "| Owner     | Task | Due |\n| :-------- | :--: | --: |\n| Anastasia | spec | Fri |\n| Bo        | impl | Mon |\n"
    );
    // Unpadded tables keep their delimiter row when alignments are unchanged.
    let mut m = model("|a|b|\n|:-|-:|\n|1|2|\n");
    let one = leaf_with_text(&m, "1");
    caret_at_end_of(&mut m, one);
    m.insert_text("0", EditOrigin::Typing).unwrap();
    assert_eq!(m.source(), "|a|b|\n|:-|-:|\n|10|2|\n");
    // Emphasis: a file that writes `_x_` / `__x__` gets them for new marks,
    // but never inside a word.
    let mut m = model("_a_ and __b__ here\n\nplain word\n");
    select(&mut m, 1, 0..5);
    m.run(EditorCommand::ToggleMark(MarkKind::Italic)).unwrap();
    select(&mut m, 1, 6..10);
    m.run(EditorCommand::ToggleMark(MarkKind::Bold)).unwrap();
    assert_eq!(m.source(), "_a_ and __b__ here\n\n_plain_ __word__\n");
    let mut m = model("_a_ here\n\nplainword\n");
    select(&mut m, 1, 0..5);
    m.run(EditorCommand::ToggleMark(MarkKind::Italic)).unwrap();
    assert_eq!(m.source(), "_a_ here\n\n*plain*word\n");
}

// ---- widget hooks: selection summon, removal guard, minimap ----------------

fn select_in(m: &mut BlockEditorModel, from: (BlockId, usize), to: (BlockId, usize)) {
    m.set_selection(BlockSelection::Text {
        anchor: BlockPosition::new(from.0, from.1),
        head: BlockPosition::new(to.0, to.1),
    })
    .unwrap();
}

#[test]
fn selection_reference_reads_the_selected_text() {
    let mut m = model("alpha beta\n\ngamma\n");
    let a = leaf_with_text(&m, "alpha beta");
    let g = leaf_with_text(&m, "gamma");
    assert_eq!(m.selection_reference(), None, "a caret refers to nothing");
    select_in(&mut m, (a, 6), (g, 3));
    let r = m.selection_reference().unwrap();
    assert_eq!(r.text.as_ref(), "beta\ngam");
    assert_eq!((r.from.block, r.from.offset, r.to.block, r.to.offset), (a, 6, g, 3));
    // Backwards selections read the same.
    select_in(&mut m, (g, 3), (a, 6));
    assert_eq!(m.selection_reference().unwrap().text.as_ref(), "beta\ngam");
    // Blank text refers to nothing.
    let mut m = model("a   b\n");
    let l = leaf_with_text(&m, "a   b");
    select_in(&mut m, (l, 1), (l, 4));
    assert_eq!(m.selection_reference(), None);
}

#[test]
fn selection_reference_is_clamped() {
    let long = "x".repeat(MAX_REFERENCE_CHARS + 50);
    let mut m = model(&format!("{long}\n"));
    let l = leaf_with_text(&m, &long);
    select_in(&mut m, (l, 0), (l, long.len()));
    assert_eq!(m.selection_reference().unwrap().text.chars().count(), MAX_REFERENCE_CHARS);
}

#[test]
fn selection_summon_inserts_after_the_block_and_keeps_the_text() {
    let mut m = model("# Doc\n\nalpha beta\n\nafter\n");
    let a = leaf_with_text(&m, "alpha beta");
    select_in(&mut m, (a, 0), (a, 5));
    let block = m.summon_on_selection("blob_s").unwrap().unwrap();
    let widget = m.prompt_widget(block).unwrap();
    assert_eq!(m.widget_reference(block).unwrap().text.as_ref(), "alpha");
    assert_eq!(widget.task, None);
    // Right after the paragraph; the referenced text is untouched and the
    // unbound widget writes nothing.
    let root = m.doc().children(m.doc().root).to_vec();
    let ix = root.iter().position(|b| *b == a).unwrap();
    assert_eq!(root[ix + 1], block);
    assert_eq!(m.source(), "# Doc\n\nalpha beta\n\nafter\n");
    assert_eq!(m.caret().unwrap().block, block);
    // One undo step removes it.
    m.undo();
    assert_eq!(m.prompt_widgets().len(), 0);
    // The reference is never written, even once bound.
    m.redo();
    let block = m.find_prompt_widget("blob_s").unwrap();
    let bound = PromptWidget { task: Some("task_s".into()), ..m.prompt_widget(block).unwrap() };
    m.set_prompt_widget(block, bound).unwrap();
    assert!(m.source().contains("<!-- notefig:prompt id=\"blob_s\" task=\"task_s\" -->"));
    assert_eq!(m.widget_reference(block).unwrap().text.as_ref(), "alpha");
}

#[test]
fn selection_summon_lands_inside_the_list_item() {
    let mut m = model("- one\n- two\n- three\n");
    let two = leaf_with_text(&m, "two");
    select_in(&mut m, (two, 0), (two, 3));
    let block = m.summon_on_selection("blob_li").unwrap().unwrap();
    let path = m.doc().path(block);
    // root > list > item(two) > widget
    assert_eq!(path.len(), 4, "{path:?}");
    assert_eq!(m.doc().path(two)[2], path[2]);
    // A task item refuses it: the widget goes after the whole list.
    let mut m = model("- [ ] todo\n- [ ] next\n");
    let todo = leaf_with_text(&m, "todo");
    select_in(&mut m, (todo, 0), (todo, 4));
    let block = m.summon_on_selection("blob_t").unwrap().unwrap();
    assert_eq!(m.doc().path(block).len(), 2);
    assert_invariants(&m);
}

#[test]
fn removal_guard_puts_a_running_widget_back() {
    let mut m = model("before\n\nafter\n");
    let before = leaf_with_text(&m, "before");
    let w = m
        .insert_prompt_widget(PromptWidget::new("blob_run", Some("task_r".into())), WidgetPlacement::After(before))
        .unwrap();
    let after = leaf_with_text(&m, "after");
    m.set_widget_removal_guard(Some(std::rc::Rc::new(|w: &PromptWidget| w.id == "blob_run")));
    // A range delete over the widget: the text goes, the widget stays.
    select_in(&mut m, (before, 2), (after, 2));
    m.delete(false).unwrap();
    assert_eq!(m.find_prompt_widget("blob_run"), Some(w));
    assert!(!m.source().contains("before"), "{}", m.source());
    assert!(m.source().contains("notefig:prompt"), "{}", m.source());
    let refused = m.take_refused_removals();
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].0, w);
    assert!(m.take_refused_removals().is_empty());
    assert_invariants(&m);
    // The host's own removal is never vetoed.
    m.remove_prompt_widget(w, None).unwrap();
    assert_eq!(m.prompt_widgets().len(), 0);
    assert!(m.take_refused_removals().is_empty());
}

#[test]
fn removal_guard_covers_undo_and_external_rewrites() {
    let mut m = model("text\n");
    let t = leaf_with_text(&m, "text");
    let w = m
        .insert_prompt_widget(PromptWidget::new("blob_u2", Some("task_u".into())), WidgetPlacement::After(t))
        .unwrap();
    m.set_widget_removal_guard(Some(std::rc::Rc::new(|_: &PromptWidget| true)));
    // Undoing the insert would drop it: it is put back.
    m.undo();
    assert_eq!(m.find_prompt_widget("blob_u2"), Some(w));
    assert_eq!(m.take_refused_removals().len(), 1);
    assert_invariants(&m);
    // With the guard off, a select-all delete removes it.
    m.set_widget_removal_guard(None);
    m.run(EditorCommand::SelectAll).unwrap();
    m.delete(false).unwrap();
    assert_eq!(m.prompt_widgets().len(), 0);
}

#[test]
fn minimap_spreads_and_clamps() {
    assert_eq!(spread_ratios(&[0.5]), vec![0.5]);
    let out = spread_ratios(&[0.5, 0.5, 0.5]);
    assert!(out.windows(2).all(|w| w[1] - w[0] >= 0.069), "{out:?}");
    let out = spread_ratios(&[0.99, 0.99]);
    assert!(out[1] <= 0.99 && out[0] < out[1], "{out:?}");
    assert_eq!(dot_title("short"), "short");
    let long = "y".repeat(60);
    assert_eq!(dot_title(&long), format!("{}…", "y".repeat(48)));
}

#[test]
fn minimap_entries_follow_document_order() {
    let mut m = model("a\n\nb\n\nc\n\nd\n");
    assert!(m.minimap_entries().is_empty());
    let a = leaf_with_text(&m, "a");
    let c = leaf_with_text(&m, "c");
    let first = m.insert_prompt_widget(PromptWidget::new("blob_1", None), WidgetPlacement::After(a)).unwrap();
    let second = m.insert_prompt_widget(PromptWidget::new("blob_2", None), WidgetPlacement::After(c)).unwrap();
    let entries = m.minimap_entries();
    assert_eq!(entries.iter().map(|e| e.block).collect::<Vec<_>>(), vec![first, second]);
    assert!(entries[0].ratio < entries[1].ratio);
    assert!(entries.iter().all(|e| (0.01..=0.99).contains(&e.ratio)));
    assert_eq!(entries[1].widget.id.as_ref(), "blob_2");
}
