//! Perf harness against the app's SLO scenarios (packages/desktop/tests/perf):
//! the same 8,000-line `large.md` (a byte-exact port of `largeDocument()`),
//! measured through a real window in `TestAppContext`.
//!
//! Run: `cargo test -p gpui-kit-markdown-editor --lib perf_ -- --ignored --nocapture`
//! (add `--config 'profile.dev.package.gpui-kit-markdown-editor.opt-level=1'`
//! to build the editor itself at opt-level 1 like its dependencies).

use std::time::{Duration, Instant};

use gpui::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, ScrollHandle, StatefulInteractiveElement as _, Styled as _, TestAppContext,
    VisualTestContext, Window, div, point, px,
};

use crate::{BlockEditor, BlockEditorState, BlockPosition, BlockSelection, EditOrigin};

/// mulberry32, as `rng()` in fixture.ts (same output for the same seed).
struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

const WORDS: &str = "the of and to in is that for it as with was on be at by this had not are \
but from or have an they which one you were all we her she there would \
their will when who him been has more if no out so said what up its about \
into than them can only other new some could time these two may then do \
first any my now such like our over man me even most made after also did \
many before must through back years where much your way well down should \
because each just those people how too little state good very make world \
still own see men work long get here between both life being under never";

fn sentence(rand: &mut Rng, min: usize, max: usize) -> String {
    let words: Vec<&str> = WORDS.split(' ').collect();
    let n = min + (rand.next() * (max - min) as f64).floor() as usize;
    let mut out: Vec<String> = (0..n)
        .map(|_| words[(rand.next() * words.len() as f64).floor() as usize].to_string())
        .collect();
    let first = out[0].clone();
    out[0] = first[..1].to_uppercase() + &first[1..];
    format!("{}.", out.join(" "))
}

fn paragraph(rand: &mut Rng) -> String {
    let n = 2 + (rand.next() * 4.).floor() as usize;
    (0..n).map(|_| sentence(rand, 6, 18)).collect::<Vec<_>>().join(" ")
}

fn table(rand: &mut Rng, rows: usize) -> Vec<String> {
    let header: Vec<String> = (0..5).map(|c| format!("Column {}", c + 1)).collect();
    let mut out = vec![format!("| {} |", header.join(" | ")), format!("|{}", " --- |".repeat(5))];
    for _ in 0..rows {
        let cells: Vec<String> = (0..5).map(|_| sentence(rand, 1, 4)).collect();
        out.push(format!("| {} |", cells.join(" | ")));
    }
    out
}

/// `largeDocument()` from fixture.ts: 8,000 lines, tables, six widgets.
pub(crate) fn large_document() -> String {
    const LINES: usize = 8000;
    const WIDGETS: usize = 6;
    let mut rand = Rng(8000);
    let mut lines: Vec<String> = vec!["# Large document".into(), "".into()];
    let widget_every = LINES / WIDGETS;
    let (mut widgets, mut section) = (0, 0);
    while lines.len() < LINES {
        section += 1;
        lines.push(format!("## Section {section}"));
        lines.push(String::new());
        if widgets < WIDGETS && lines.len() >= widgets * widget_every + 40 {
            lines.push(format!(
                "<!-- notefig:prompt id=\"blob_perf{widgets}\" task=\"task_perf{widgets}\" -->"
            ));
            lines.push(String::new());
            widgets += 1;
        }
        lines.push(paragraph(&mut rand));
        lines.push(String::new());
        lines.push(paragraph(&mut rand));
        lines.push(String::new());
        if section % 6 == 0 {
            lines.extend(table(&mut rand, 12));
            lines.push(String::new());
        }
        if section % 4 == 0 {
            for _ in 0..5 {
                lines.push(format!("- {}", sentence(&mut rand, 3, 10)));
            }
            lines.push(String::new());
        }
        if section % 7 == 0 {
            for l in ["```ts", "const value = compute(input);", "return value;", "```", ""] {
                lines.push(l.into());
            }
        }
    }
    lines.truncate(LINES);
    lines.join("\n") + "\n"
}

struct Scrolled(Entity<BlockEditorState>, ScrollHandle);

impl Render for Scrolled {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("scroll")
            .w(px(800.))
            .h(px(900.))
            .overflow_y_scroll()
            .track_scroll(&self.1)
            .child(BlockEditor::new(&self.0).px(px(48.)))
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
}

struct Stats(Vec<Duration>);
impl Stats {
    fn p(&self, q: f64) -> Duration {
        let mut v = self.0.clone();
        v.sort();
        v[((v.len() as f64 - 1.) * q).round() as usize]
    }
    fn line(&self, name: &str) -> String {
        format!(
            "{name:<34} p50 {:>8.2?}  p95 {:>8.2?}  max {:>8.2?}  (n={})",
            self.p(0.5),
            self.p(0.95),
            self.p(1.0),
            self.0.len()
        )
    }
}

fn sample(n: usize, mut f: impl FnMut() -> Duration) -> Stats {
    Stats((0..n).map(|_| f()).collect())
}

#[gpui::test]
#[ignore = "perf harness; run with --ignored --nocapture"]
fn perf_large_document_slos(cx: &mut TestAppContext) {
    cx.update(crate::init_for_tests);
    let source = large_document();
    assert_eq!(source.lines().count(), 8000);
    let handle = ScrollHandle::new();
    let scroll = handle.clone();
    let open_start = Instant::now();
    let (root, cx) = cx.add_window_view(move |window, cx| {
        let editor = cx.new(|cx| {
            let mut state = BlockEditorState::new(window, cx);
            state.set_source(&source, cx).unwrap();
            state.set_scroll_handle(scroll.clone());
            state.notefig.perf_no_a11y = true;
            state
        });
        Scrolled(editor, scroll)
    });
    let editor = root.read_with(cx, |r, _| r.0.clone());
    let parsed = open_start.elapsed();
    cx.update(|window, cx| {
        let focus = editor.read(cx).focus_handle.clone();
        window.focus(&focus, cx);
    });
    draw(cx);
    draw(cx);
    let open = open_start.elapsed();
    let mut report = vec![format!(
        "open 8k-line doc: model {parsed:.2?}, first frames {:.2?}, total {open:.2?}",
        open - parsed
    )];

    // Caret in a paragraph in the middle of the document.
    let mid = editor.read_with(cx, |e, _| {
        let leaves: Vec<_> = e.model().document().leaves().map(|l| (l.id(), l.kind())).collect();
        leaves
            .iter()
            .skip(leaves.len() / 2)
            .find(|(_, k)| *k == crate::BlockKind::Paragraph)
            .map(|(id, _)| *id)
            .unwrap()
    });
    editor.update(cx, |e, cx| {
        e.set_selection(BlockSelection::caret(BlockPosition::new(mid, 10)), cx)
            .unwrap()
    });
    draw(cx);
    draw(cx);

    let caret = sample(60, || {
        let t = Instant::now();
        cx.simulate_keystrokes("right");
        draw(cx);
        t.elapsed()
    });
    report.push(caret.line("caret-move (right + frame)"));
    let vertical = sample(30, || {
        let t = Instant::now();
        cx.simulate_keystrokes("down");
        draw(cx);
        let d = t.elapsed();
        cx.simulate_keystrokes("up");
        draw(cx);
        d
    });
    report.push(vertical.line("caret-move (down + frame)"));
    let typing = sample(60, || {
        let t = Instant::now();
        cx.simulate_input("x");
        draw(cx);
        t.elapsed()
    });
    report.push(typing.line("input (type char + frame)"));
    let delete = sample(60, || {
        let t = Instant::now();
        cx.simulate_keystrokes("backspace");
        draw(cx);
        t.elapsed()
    });
    report.push(delete.line("input-delete (backspace + frame)"));
    let m = if cfg!(target_os = "macos") { "cmd" } else { "ctrl" };
    let select_all = sample(10, || {
        let t = Instant::now();
        cx.simulate_keystrokes(&format!("{m}-a"));
        draw(cx);
        let d = t.elapsed();
        editor.update(cx, |e, cx| {
            e.set_selection(BlockSelection::caret(BlockPosition::new(mid, 10)), cx)
                .unwrap()
        });
        draw(cx);
        d
    });
    report.push(select_all.line("select-all (+ frame)"));
    let out_of_all = sample(10, || {
        cx.simulate_keystrokes(&format!("{m}-a"));
        draw(cx);
        let t = Instant::now();
        cx.simulate_keystrokes("left");
        draw(cx);
        t.elapsed()
    });
    report.push(out_of_all.line("select-all-caret-move (+ frame)"));
    // Scrolling: move the scroll offset a viewport at a time and draw.
    let mut y = px(0.);
    let scroll = sample(40, || {
        y -= px(450.);
        handle.set_offset(point(px(0.), y));
        let t = Instant::now();
        cx.update(|window, cx| {
            window.refresh();
            let _ = window.draw(cx);
        });
        t.elapsed()
    });
    report.push(scroll.line("scroll frame (450px step)"));
    // Steady frame with nothing changed.
    let steady = sample(20, || {
        let t = Instant::now();
        cx.update(|window, cx| {
            window.refresh();
            let _ = window.draw(cx);
        });
        t.elapsed()
    });
    report.push(steady.line("steady frame (refresh)"));

    // Agent writes: one-line change, and a streaming append.
    let base = editor.read_with(cx, |e, _| e.source());
    let merge = sample(10, || {
        let current = editor.read_with(cx, |e, _| e.source());
        let next = if current == base {
            base.replacen("## Section 400\n", "## Section 400 (agent)\n", 1)
        } else {
            base.clone()
        };
        let t = Instant::now();
        editor.update(cx, |e, cx| {
            e.apply_external_source(&next, EditOrigin::Agent { round: None }, cx)
                .unwrap()
        });
        let d = t.elapsed();
        draw(cx);
        d
    });
    report.push(merge.line("merge one-line agent edit (model)"));
    let mut text = editor.read_with(cx, |e, _| e.source());
    text.push_str("\n## Streaming\n\n");
    let stream = sample(20, || {
        text.push_str("word ");
        let t = Instant::now();
        editor.update(cx, |e, cx| {
            e.apply_external_source(&text, EditOrigin::Agent { round: None }, cx)
                .unwrap()
        });
        draw(cx);
        t.elapsed()
    });
    report.push(stream.line("merge streaming append (+ frame)"));
    let save = sample(10, || {
        editor.update(cx, |e, cx| {
            e.set_selection(BlockSelection::caret(BlockPosition::new(mid, 10)), cx)
                .unwrap()
        });
        cx.simulate_input("y");
        let t = Instant::now();
        let _ = editor.read_with(cx, |e, _| e.source());
        t.elapsed()
    });
    report.push(save.line("source() after an edit (autosave)"));
    // Async open: time until the first frame shows the prefix, and until
    // the whole document is in (the background parse runs on the test
    // executor here, so the second number is the parse cost, not latency).
    let doc = large_document();
    let t = Instant::now();
    let task = editor.update(cx, |e, cx| e.set_source_async(doc.clone(), cx));
    // Draw without running the background executor (the parse).
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    let first_paint = t.elapsed();
    cx.background_executor.run_until_parked();
    task.detach();
    draw(cx);
    let loaded = t.elapsed();
    report.push(format!(
        "open async: first frame {first_paint:.2?}, whole document in {loaded:.2?}"
    ));

    eprintln!(
        "\n=== perf ({} build of the editor, deps opt-level 1, test platform) ===\n{}\n",
        if cfg!(debug_assertions) { "debug" } else { "release" },
        report.join("\n")
    );
}

#[test]
fn large_document_port_matches_the_fixture_shape() {
    let doc = large_document();
    assert_eq!(doc.lines().count(), 8000);
    assert_eq!(doc.matches("notefig:prompt").count(), 6);
    assert!(doc.starts_with("# Large document\n\n## Section 1\n\n"));
}

#[test]
#[ignore = "perf harness"]
fn perf_open_phases() {
    use gpui_kit::base::text::{MarkdownExtensions, editor_host::parse_markdown};
    use std::sync::Arc;
    let source = large_document();
    let ext = Arc::new(crate::import::preserve_source_extensions(MarkdownExtensions::default()));
    let t = Instant::now();
    let parsed = parse_markdown(&source, ext.clone()).unwrap();
    let md = t.elapsed();
    let t = Instant::now();
    let doc = crate::import::parse_document(&source, ext.clone()).unwrap();
    let all = t.elapsed();
    let t = Instant::now();
    let _ = crate::source_map::serialize_preserving(&doc);
    let save = t.elapsed();
    eprintln!(
        "\n=== open phases: {} bytes, {} top-level nodes: parse_markdown {md:.2?}, parse_document total {all:.2?}, save {save:.2?}\n",
        source.len(),
        parsed.len()
    );
}

/// Long typing loop for sampling with a profiler (`sample <pid>`).
#[gpui::test]
#[ignore = "profiling loop"]
fn perf_profile_typing(cx: &mut TestAppContext) {
    cx.update(crate::init_for_tests);
    let source = large_document();
    let handle = ScrollHandle::new();
    let scroll = handle.clone();
    let (root, cx) = cx.add_window_view(move |window, cx| {
        let editor = cx.new(|cx| {
            let mut state = BlockEditorState::new(window, cx);
            state.set_source(&source, cx).unwrap();
            state.set_scroll_handle(scroll.clone());
            state
        });
        Scrolled(editor, scroll)
    });
    let editor = root.read_with(cx, |r, _| r.0.clone());
    cx.update(|window, cx| {
        let focus = editor.read(cx).focus_handle.clone();
        window.focus(&focus, cx);
    });
    draw(cx);
    let mid = editor.read_with(cx, |e, _| {
        let leaves: Vec<_> = e.model().document().leaves().map(|l| (l.id(), l.kind())).collect();
        leaves.iter().skip(leaves.len() / 2).find(|(_, k)| *k == crate::BlockKind::Paragraph).map(|(id, _)| *id).unwrap()
    });
    editor.update(cx, |e, cx| e.set_selection(BlockSelection::caret(BlockPosition::new(mid, 10)), cx).unwrap());
    draw(cx);
    let mode = std::env::var("PROFILE_MODE").unwrap_or_default();
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(20) {
        if mode == "frame" {
            cx.update(|window, cx| {
                window.refresh();
                let _ = window.draw(cx);
            });
        } else {
            cx.simulate_input("x");
            draw(cx);
            cx.simulate_keystrokes("backspace");
            draw(cx);
        }
    }
}
