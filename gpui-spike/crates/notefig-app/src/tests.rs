//! Core-flow tests over the real window tree (headless gpui test platform).
//! The OS file watcher is off; tests feed `handle_fs_events` the batches the
//! watcher would produce (the watcher itself is tested in notefig-workspace).

use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui::{AppContext as _, Entity, TestAppContext, VisualTestContext};
use notefig_workspace::{FsEvent, StateStore, content_hash, scratchpads};

use crate::AppState;
use crate::document::{DocKind, Document};
use crate::layout::{OpenMode, Tab};
use crate::root::NotefigRoot;
use crate::workspace_view::WorkspaceView;

pub(crate) struct Fixture {
    pub(crate) _dir: tempfile::TempDir,
    pub(crate) ws_path: PathBuf,
    pub(crate) state_path: PathBuf,
}

pub(crate) fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let ws_path = dir.path().join("ws");
    std::fs::create_dir_all(ws_path.join("notes/deep")).unwrap();
    std::fs::write(ws_path.join("a.md"), "# Alpha\n\nFirst note.\n").unwrap();
    std::fs::write(ws_path.join("b.md"), "# Beta\n").unwrap();
    std::fs::write(ws_path.join("notes/c.md"), "- [ ] task\n").unwrap();
    std::fs::write(ws_path.join("notes/deep/d.md"), "deep\n").unwrap();
    std::fs::write(ws_path.join("config.json"), "{\"a\": 1}\n").unwrap();
    let state_path = dir.path().join("state").join("state.json");
    Fixture {
        ws_path: std::fs::canonicalize(&ws_path).unwrap(),
        state_path,
        _dir: dir,
    }
}

pub(crate) fn init(cx: &mut TestAppContext, state_path: &Path) {
    let store = StateStore::load(state_path.to_path_buf());
    cx.update(|cx| {
        crate::init(store, cx);
        AppState::global(cx).update(cx, |s, _| s.watch_files = false);
    });
}

/// Open the main window (inside gpui-kit's Root, like the app) on `path`.
pub(crate) fn open(
    cx: &mut TestAppContext,
    path: Option<PathBuf>,
) -> (Entity<NotefigRoot>, &mut VisualTestContext) {
    let slot = std::rc::Rc::new(std::cell::RefCell::new(None));
    let out = slot.clone();
    let (_, vcx) = cx.add_window_view(move |window, cx| {
        let root = cx.new(|cx| NotefigRoot::new(path, window, cx));
        *out.borrow_mut() = Some(root.clone());
        gpui_kit::base::Root::new(root, window, cx)
    });
    let root = slot.borrow_mut().take().unwrap();
    vcx.run_until_parked();
    (root, vcx)
}

pub(crate) fn workspace(root: &Entity<NotefigRoot>, cx: &mut VisualTestContext) -> Entity<WorkspaceView> {
    root.read_with(cx, |r, _| r.workspace.clone().expect("a workspace is open"))
}

pub(crate) fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

pub(crate) fn open_file(
    ws: &Entity<WorkspaceView>,
    rel: &str,
    cx: &mut VisualTestContext,
) -> Entity<Document> {
    cx.update(|window, cx| ws.update(cx, |ws, cx| ws.open_file(rel, OpenMode::Pinned, window, cx)));
    draw(cx);
    ws.read_with(cx, |ws, _| ws.doc(rel).cloned().expect("document is open"))
}

pub(crate) fn md_source(doc: &Entity<Document>, cx: &mut VisualTestContext) -> String {
    doc.read_with(cx, |doc, cx| match &doc.kind {
        DocKind::Markdown { editor, .. } => editor.read(cx).source(),
        _ => panic!("not markdown"),
    })
}

pub(crate) fn active(ws: &Entity<WorkspaceView>, cx: &mut VisualTestContext) -> Option<Tab> {
    ws.read_with(cx, |ws, _| ws.layout.active_tab().cloned())
}

/// Open tabs other than scratchpads (entering a workspace lands on one).
pub(crate) fn user_tabs(ws: &Entity<WorkspaceView>, cx: &mut VisualTestContext) -> Vec<Tab> {
    ws.read_with(cx, |ws, _| ws.layout.all_tabs())
        .into_iter()
        .filter(|t| !t.rel().is_some_and(scratchpads::is_scratchpad))
        .collect()
}

fn fs_events(ws: &Entity<WorkspaceView>, batch: Vec<FsEvent>, cx: &mut VisualTestContext) {
    cx.update(|window, cx| ws.update(cx, |ws, cx| ws.handle_fs_events(batch, window, cx)));
    draw(cx);
}

#[gpui::test]
fn opens_workspace_and_file_in_tab(cx: &mut TestAppContext) {
    let f = fixture();
    init(cx, &f.state_path);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    // Entering with nothing open lands on a fresh scratchpad.
    let landing = active(&ws, cx).and_then(|t| t.rel().map(String::from)).unwrap();
    assert!(scratchpads::is_scratchpad(&landing), "{landing}");
    assert!(f.ws_path.join(&landing).exists());
    let rows: Vec<String> =
        ws.read_with(cx, |ws, _| ws.tree_model.rows().iter().map(|r| r.rel.clone()).collect());
    assert_eq!(rows, vec![".notefig", "notes", "a.md", "b.md", "config.json"]);

    let doc = open_file(&ws, "a.md", cx);
    assert!(md_source(&doc, cx).contains("First note."));
    assert_eq!(active(&ws, cx), Some(Tab::file("a.md")));

    // A non-markdown text file opens in the code editor.
    let json = open_file(&ws, "config.json", cx);
    assert!(json.read_with(cx, |d, _| matches!(d.kind, DocKind::Code { .. })));
    assert_eq!(json.read_with(cx, |d, cx| d.text(cx)).as_deref(), Some("{\"a\": 1}\n"));

    let recent = cx.update(|_, cx| AppState::global(cx).read(cx).data().recent.clone());
    assert_eq!(recent[0].path, f.ws_path);

    // The theme toggle persists an explicit preference.
    cx.dispatch_action(crate::actions::ToggleTheme);
    draw(cx);
    let theme = cx.update(|_, cx| AppState::global(cx).read(cx).theme());
    assert_ne!(theme, notefig_workspace::ThemePreference::System);
}

#[gpui::test]
fn preview_tabs_and_reveal(cx: &mut TestAppContext) {
    let f = fixture();
    init(cx, &f.state_path);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    cx.update(|window, cx| {
        ws.update(cx, |ws, cx| {
            ws.open_file("a.md", OpenMode::Preview, window, cx);
            ws.open_file("b.md", OpenMode::Preview, window, cx);
        })
    });
    draw(cx);
    assert_eq!(user_tabs(&ws, cx), vec![Tab::file("b.md")]);
    cx.update(|_, cx| ws.update(cx, |ws, cx| ws.reveal("notes/deep/d.md", cx)));
    let rows: Vec<String> =
        ws.read_with(cx, |ws, _| ws.tree_model.rows().iter().map(|r| r.rel.clone()).collect());
    assert!(rows.contains(&"notes/deep/d.md".to_string()), "{rows:?}");
}

#[gpui::test]
fn edit_autosaves_to_disk(cx: &mut TestAppContext) {
    let f = fixture();
    init(cx, &f.state_path);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let doc = open_file(&ws, "b.md", cx);
    cx.update(|window, cx| Document::focus_editor(&doc, window, cx));
    draw(cx);
    cx.simulate_input("Hi ");
    draw(cx);
    assert!(md_source(&doc, cx).contains("Hi "), "{}", md_source(&doc, cx));
    assert!(doc.read_with(cx, |d, _| d.is_dirty()));
    // Nothing is written before the debounce.
    assert_eq!(std::fs::read_to_string(f.ws_path.join("b.md")).unwrap(), "# Beta\n");
    cx.executor().advance_clock(Duration::from_millis(600));
    draw(cx);
    let disk = std::fs::read_to_string(f.ws_path.join("b.md")).unwrap();
    assert_eq!(disk, md_source(&doc, cx));
    assert!(disk.contains("Hi "));
    assert!(!doc.read_with(cx, |d, _| d.is_dirty()));
}

#[gpui::test]
fn save_now_quick_open_and_command_palette(cx: &mut TestAppContext) {
    let f = fixture();
    init(cx, &f.state_path);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let doc = open_file(&ws, "a.md", cx);
    cx.update(|window, cx| Document::focus_editor(&doc, window, cx));
    cx.simulate_input("Z");
    cx.simulate_keystrokes("cmd-s");
    draw(cx);
    assert!(std::fs::read_to_string(f.ws_path.join("a.md")).unwrap().contains('Z'));

    // Cmd+P, type, Enter opens the match.
    cx.simulate_keystrokes("cmd-p");
    draw(cx);
    let palette = ws.read_with(cx, |ws, _| ws.palette().cloned()).expect("palette open");
    cx.simulate_input("deep");
    draw(cx);
    assert_eq!(
        palette.read_with(cx, |p, _| p.match_labels()),
        vec!["notes/deep/d.md".to_string()]
    );
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert!(ws.read_with(cx, |ws, _| ws.palette().is_none()));
    assert_eq!(active(&ws, cx), Some(Tab::file("notes/deep/d.md")));

    // Cmd+Shift+P runs a command.
    cx.simulate_keystrokes("cmd-shift-p");
    draw(cx);
    cx.simulate_input("split right");
    draw(cx);
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert_eq!(ws.read_with(cx, |ws, _| ws.layout.panes().len()), 2);

    // Escape dismisses.
    cx.simulate_keystrokes("cmd-p");
    draw(cx);
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(ws.read_with(cx, |ws, _| ws.palette().is_none()));
}

#[gpui::test]
fn external_write_reloads_editor(cx: &mut TestAppContext) {
    let f = fixture();
    init(cx, &f.state_path);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let doc = open_file(&ws, "a.md", cx);
    let new = "# Alpha\n\nChanged by an agent.\n";
    std::fs::write(f.ws_path.join("a.md"), new).unwrap();
    fs_events(
        &ws,
        vec![FsEvent::Upserted {
            rel: "a.md".into(),
            is_dir: false,
            hash: Some(content_hash(new)),
        }],
        cx,
    );
    assert!(md_source(&doc, cx).contains("Changed by an agent."));
    // The reload is not an edit: nothing is written back.
    assert!(!doc.read_with(cx, |d, _| d.is_dirty()));
    cx.executor().advance_clock(Duration::from_secs(1));
    draw(cx);
    assert_eq!(std::fs::read_to_string(f.ws_path.join("a.md")).unwrap(), new);
}

#[gpui::test]
fn rename_and_delete_update_tabs(cx: &mut TestAppContext) {
    let f = fixture();
    init(cx, &f.state_path);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let doc = open_file(&ws, "notes/c.md", cx);
    open_file(&ws, "a.md", cx);

    // Inline rename of the folder holding an open file.
    cx.update(|window, cx| ws.update(cx, |ws, cx| ws.start_rename("notes".into(), window, cx)));
    draw(cx);
    cx.simulate_input("journal");
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert!(f.ws_path.join("journal/c.md").exists());
    assert!(ws.read_with(cx, |ws, _| ws.layout.contains(&Tab::file("journal/c.md"))));
    assert_eq!(doc.read_with(cx, |d, _| d.rel().to_string()), "journal/c.md");

    // A rename on disk (watcher event) follows too.
    std::fs::rename(f.ws_path.join("a.md"), f.ws_path.join("alpha.md")).unwrap();
    fs_events(
        &ws,
        vec![FsEvent::Renamed {
            from: "a.md".into(),
            to: "alpha.md".into(),
        }],
        cx,
    );
    assert_eq!(active(&ws, cx), Some(Tab::file("alpha.md")));

    // Deleting on disk closes the tab.
    std::fs::remove_file(f.ws_path.join("alpha.md")).unwrap();
    fs_events(&ws, vec![FsEvent::Removed { rel: "alpha.md".into() }], cx);
    assert_eq!(user_tabs(&ws, cx), vec![Tab::file("journal/c.md")]);
}

#[gpui::test]
fn new_note_and_inline_create(cx: &mut TestAppContext) {
    let f = fixture();
    init(cx, &f.state_path);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let landing = active(&ws, cx);
    cx.simulate_keystrokes("cmd-n");
    draw(cx);
    let note = active(&ws, cx).and_then(|t| t.rel().map(String::from)).unwrap();
    assert!(scratchpads::is_scratchpad(&note), "{note}");
    assert_ne!(Some(Tab::file(note.clone())), landing);
    assert!(f.ws_path.join(&note).exists());
    // The scratchpads folder itself cannot be renamed.
    cx.update(|window, cx| {
        ws.update(cx, |ws, cx| ws.start_rename(".notefig/scratchpads".into(), window, cx))
    });
    cx.simulate_input("x");
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert!(f.ws_path.join(".notefig/scratchpads").is_dir());

    cx.update(|window, cx| {
        ws.update(cx, |ws, cx| ws.start_create("notes".into(), false, window, cx))
    });
    draw(cx);
    cx.simulate_input("idea");
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert!(f.ws_path.join("notes/idea.md").exists());
    assert_eq!(active(&ws, cx), Some(Tab::file("notes/idea.md")));
}

#[gpui::test]
fn split_layout_is_restored(cx: &mut TestAppContext) {
    let f = fixture();
    init(cx, &f.state_path);
    let saved = {
        let (root, vcx) = open(cx, Some(f.ws_path.clone()));
        let ws = workspace(&root, vcx);
        open_file(&ws, "a.md", vcx);
        vcx.simulate_keystrokes("cmd-\\");
        draw(vcx);
        open_file(&ws, "b.md", vcx);
        vcx.update(|_, cx| ws.update(cx, |ws, cx| ws.reveal("notes/c.md", cx)));
        draw(vcx);
        ws.read_with(vcx, |ws, _| ws.layout.clone())
    };
    assert_eq!(saved.panes().len(), 2);
    cx.update(|cx| AppState::global(cx).update(cx, |s, _| s.flush()));

    // A fresh app on the same state file restores the last workspace.
    let mut cx2 = TestAppContext::single();
    init(&mut cx2, &f.state_path);
    let (root2, vcx2) = open(&mut cx2, None);
    let ws2 = workspace(&root2, vcx2);
    assert_eq!(ws2.read_with(vcx2, |ws, _| ws.layout.clone()), saved);
    assert!(ws2.read_with(vcx2, |ws, _| ws.doc("b.md").is_some() && ws.doc("a.md").is_some()));
    assert!(ws2.read_with(vcx2, |ws, _| ws.tree_model.expanded.contains("notes")));
}

#[gpui::test]
fn search_streams_results_and_opens_match(cx: &mut TestAppContext) {
    let f = fixture();
    std::fs::write(f.ws_path.join("b.md"), "# Beta\n\nA task for later, another task.\n").unwrap();
    init(cx, &f.state_path);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    cx.simulate_keystrokes("cmd-shift-f");
    draw(cx);
    assert_eq!(
        ws.read_with(cx, |ws, _| ws.sidebar_view),
        crate::workspace_view::SidebarView::Search
    );
    let search = cx.update(|window, cx| ws.update(cx, |ws, cx| ws.search_view(window, cx)));
    cx.simulate_input("task");
    draw(cx);
    // Debounced: nothing yet.
    assert_eq!(search.read_with(cx, |s, _| s.match_count()), 0);
    cx.executor().advance_clock(crate::search_view::SEARCH_DEBOUNCE * 2);
    draw(cx);
    let files: Vec<String> =
        search.read_with(cx, |s, _| s.results.iter().map(|(rel, _)| rel.clone()).collect());
    assert_eq!(files, vec!["b.md".to_string(), "notes/c.md".to_string()]);
    assert_eq!(search.read_with(cx, |s, _| s.match_count()), 3);

    // Opening the second match in b.md selects that occurrence.
    let m = search.read_with(cx, |s, _| s.results[0].1[1].clone());
    search.update(cx, |_, cx| cx.emit(crate::search_view::SearchEvent::OpenMatch(m)));
    draw(cx);
    assert_eq!(user_tabs(&ws, cx), vec![Tab::file("b.md")]);
    let doc = ws.read_with(cx, |ws, _| ws.doc("b.md").cloned().unwrap());
    let selected = doc.read_with(cx, |d, cx| match &d.kind {
        DocKind::Markdown { editor, .. } => {
            let state = editor.read(cx);
            match state.selection() {
                markdown_editor::BlockSelection::Text { anchor, head } => {
                    let text = state.model().document().block(anchor.block).and_then(|b| b.text()).unwrap_or("");
                    text[anchor.offset..head.offset].to_string() + &format!("@{}", anchor.offset)
                }
                _ => String::new(),
            }
        }
        _ => String::new(),
    });
    assert_eq!(selected, format!("task@{}", "A task for later, another ".len()));

    // Case-sensitive toggle reruns the search.
    search.update(cx, |s, cx| {
        s.case_sensitive = true;
        s.schedule(Duration::ZERO, cx);
    });
    draw(cx);
    assert_eq!(search.read_with(cx, |s, _| s.match_count()), 3);
}

#[gpui::test]
fn unsaved_edits_win_over_external_change(cx: &mut TestAppContext) {
    let f = fixture();
    init(cx, &f.state_path);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let doc = open_file(&ws, "b.md", cx);
    cx.update(|window, cx| Document::focus_editor(&doc, window, cx));
    cx.simulate_input("Mine ");
    draw(cx);
    // An external write lands while the autosave debounce is pending.
    let external = "# Beta\n\nTheirs.\n";
    std::fs::write(f.ws_path.join("b.md"), external).unwrap();
    fs_events(
        &ws,
        vec![FsEvent::Upserted {
            rel: "b.md".into(),
            is_dir: false,
            hash: Some(content_hash(external)),
        }],
        cx,
    );
    assert!(md_source(&doc, cx).contains("Mine "));
    assert!(!md_source(&doc, cx).contains("Theirs."));
    cx.executor().advance_clock(Duration::from_millis(600));
    draw(cx);
    // The user's save overwrote the external change (TS DocumentSync rule).
    let disk = std::fs::read_to_string(f.ws_path.join("b.md")).unwrap();
    assert!(disk.contains("Mine "), "{disk}");
    assert!(!doc.read_with(cx, |d, _| d.is_dirty()));

    // With no unsaved edits, the next external change is adopted.
    let later = "# Beta\n\nLater.\n";
    std::fs::write(f.ws_path.join("b.md"), later).unwrap();
    fs_events(
        &ws,
        vec![FsEvent::Upserted {
            rel: "b.md".into(),
            is_dir: false,
            hash: Some(content_hash(later)),
        }],
        cx,
    );
    assert!(md_source(&doc, cx).contains("Later."));
}

#[gpui::test]
fn notefig_theme_and_saved_window_bounds(cx: &mut TestAppContext) {
    let f = fixture();
    init(cx, &f.state_path);
    cx.update(|cx| {
        let theme = gpui_kit::component::Theme::global(cx);
        assert_eq!(theme.light_theme.name.as_ref(), crate::theme::LIGHT);
        assert_eq!(theme.dark_theme.name.as_ref(), crate::theme::DARK);
        AppState::global(cx).update(cx, |s, cx| {
            s.update_data(cx, |d| {
                d.window = Some(notefig_workspace::WindowBoundsState {
                    x: 10.,
                    y: 20.,
                    width: 1000.,
                    height: 700.,
                    maximized: false,
                    fullscreen: false,
                })
            })
        });
        match crate::window_options(cx).window_bounds {
            Some(gpui::WindowBounds::Windowed(b)) => {
                assert_eq!(f32::from(b.size.width), 1000.);
                assert_eq!(f32::from(b.origin.y), 20.);
            }
            other => panic!("{other:?}"),
        }
    });
    let (_root, cx) = open(cx, Some(f.ws_path.clone()));
    let name = cx.update(|_, cx| gpui_kit::component::Theme::global(cx).theme_name().to_string());
    assert!(name.starts_with("Notefig"), "{name}");
}

#[gpui::test]
fn history_panel_initialize_save_restore(cx: &mut TestAppContext) {
    use crate::history::PanelState;
    let f = fixture();
    init(cx, &f.state_path);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let history = ws.read_with(cx, |ws, _| ws.history.clone());
    draw(cx);
    assert_eq!(history.read_with(cx, |h, _| h.state()), PanelState::Uninitialized);
    history.update(cx, |h, cx| h.initialize(cx));
    draw(cx);
    assert_eq!(history.read_with(cx, |h, _| h.state()), PanelState::Empty);
    assert!(history.read_with(cx, |h, _| h.has_changes()));
    history.update(cx, |h, cx| h.save("first".into(), cx));
    draw(cx);
    assert_eq!(history.read_with(cx, |h, _| h.state()), PanelState::Ready);
    std::fs::write(f.ws_path.join("a.md"), "# Changed\n").unwrap();
    history.update(cx, |h, cx| h.turn_checkpoint("Fix the intro".into(), "claude-code".into(), cx));
    draw(cx);
    let log = history.read_with(cx, |h, _| h.checkpoints().to_vec());
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].summary(), "Fix the intro");
    assert!(log[0].author_name.contains("claude-code"), "{}", log[0].author_name);
    // A later commit, then Restore (revert) the agent's turn: a.md comes back.
    std::fs::write(f.ws_path.join("b.md"), "# Beta 2\n").unwrap();
    history.update(cx, |h, cx| h.save(String::new(), cx));
    draw(cx);
    let turn = log[0].oid.clone();
    history.update(cx, |h, cx| h.restore(turn, cx));
    draw(cx);
    assert_eq!(std::fs::read_to_string(f.ws_path.join("a.md")).unwrap(), "# Alpha\n\nFirst note.\n");
    // The user's own .git is untouched (none was created).
    assert!(!f.ws_path.join(".git").exists());
}
