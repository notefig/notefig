//! Port of `modules/documents/documents.test.ts`, over the fake platform and
//! a fake live editor (the TS test builds a real Tiptap editor; the
//! adoption merge itself is the markdown editor crate's, tested there),
//! plus the save pipeline's own cases (`DocumentSync`).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, ready};
use notefig_core::ExecutorExt;
use notefig_core::testing::TestExecutor;
use notefig_editors::{Adoption, AdoptionSource, EditorInstance, EditorTarget, EditorType, create_editors};
use notefig_platform::fake::FakePlatform;

use crate::*;

/// A live markdown editor holding `text`.
struct FakeEditor {
    text: RefCell<String>,
    adoptions: Cell<u32>,
}

impl EditorInstance for FakeEditor {
    fn editor_type(&self) -> EditorType {
        EditorType::Markdown
    }
    fn focus(&self, _: bool) -> bool {
        true
    }
    fn dispose(&self) {}
    fn is_focusable(&self) -> bool {
        true
    }
    fn go_to(&self, _: EditorTarget) -> LocalBoxFuture<'static, bool> {
        ready(false).boxed_local()
    }
    fn selected_text(&self) -> Option<String> {
        None
    }
    fn markdown(&self) -> Option<String> {
        Some(self.text.borrow().clone())
    }
    fn adopt(&self, content: String, _: AdoptionSource) -> LocalBoxFuture<'static, Option<Adoption>> {
        *self.text.borrow_mut() = content;
        self.adoptions.set(self.adoptions.get() + 1);
        ready(Some(Adoption::default())).boxed_local()
    }
}

struct Rows(RefCell<Vec<(String, String)>>);
impl LoadedContent for Rows {
    fn update_loaded_content(&self, path: &str, content: &str) {
        self.0.borrow_mut().push((path.into(), content.into()));
    }
}

struct Setup {
    exec: Rc<TestExecutor>,
    fake: FakePlatform,
    editors: Rc<notefig_editors::EditorsApi>,
    docs: DocumentsApi,
    rows: Rc<Rows>,
}

fn setup() -> Setup {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let editors = Rc::new(create_editors(exec.clone()));
    let rows = Rc::new(Rows(RefCell::default()));
    let r = rows.clone();
    let docs = create_documents(DocumentsDeps {
        fs: fake.platform.fs.clone(),
        open_files: Rc::new(move || vec![r.clone() as Rc<dyn LoadedContent>]),
        editors: editors.clone(),
        attribute: None,
        executor: exec.clone(),
    });
    Setup { exec, fake, editors, docs, rows }
}

fn open_editor(s: &Setup, path: &str, text: &str) -> Rc<FakeEditor> {
    s.fake.fs.seed(path, text);
    let e = Rc::new(FakeEditor { text: RefCell::new(text.into()), adoptions: Cell::new(0) });
    s.editors.register(path, e.clone());
    s.docs.sync(path).ensure_baseline(text, None);
    e
}

#[test]
fn write_brings_the_loaded_row_forward() {
    let s = setup();
    s.exec.block_on(s.docs.write("/ws/a.md", "new")).unwrap();
    assert_eq!(s.fake.fs.read("/ws/a.md").as_deref(), Some("new"));
    assert_eq!(*s.rows.0.borrow(), [("/ws/a.md".to_string(), "new".to_string())]);
}

#[test]
fn write_refuses_a_relative_path() {
    let s = setup();
    let err = s.exec.block_on(s.docs.write("ws/a.md", "x")).unwrap_err();
    assert_eq!(err.kind, notefig_platform::FsErrorKind::InvalidPath);
}

#[test]
fn write_pushes_content_into_a_live_editor() {
    let s = setup();
    let editor = open_editor(&s, "/ws/open.md", "# Doc\n\nOld body.\n");
    s.exec.block_on(s.docs.write("/ws/open.md", "# Doc\n\nNew body.\n")).unwrap();
    assert!(editor.text.borrow().contains("New body."));
    assert!(!s.docs.sync("/ws/open.md").is_dirty());
}

#[test]
fn write_skips_adoption_while_a_local_edit_is_pending() {
    let s = setup();
    let editor = open_editor(&s, "/ws/open.md", "# Doc\n\nUser draft.\n");
    let e = editor.clone();
    s.docs.sync("/ws/open.md").edited(Rc::new(move || e.text.borrow().clone()));
    s.exec.block_on(s.docs.write("/ws/open.md", "# Doc\n\nAgent overwrite.\n")).unwrap();
    assert!(editor.text.borrow().contains("User draft."), "the user's edit wins");
    // ...and its save then overwrites the agent's bytes.
    s.exec.advance(AUTOSAVE_DEBOUNCE);
    assert!(s.fake.fs.read("/ws/open.md").unwrap().contains("User draft."));
}

#[test]
fn read_slices_with_1_based_line_and_limit_and_fails_with_fs_error() {
    let s = setup();
    s.fake.fs.seed("/ws/a.md", "line1\nline2\nline3\n");
    let range = ReadRange { line: Some(2), limit: Some(1) };
    assert_eq!(s.exec.block_on(s.docs.read("/ws/a.md", range)).unwrap(), "line2");
    assert!(s.exec.block_on(s.docs.read("/ws/missing.md", ReadRange::default())).is_err());
}

#[test]
fn redirects_a_write_that_overlaps_a_move() {
    let s = setup();
    let mv = s.docs.begin_move("/ws/a.md").unwrap();
    let done = Rc::new(Cell::new(false));
    let d = done.clone();
    let write = s.docs.write("/ws/a.md", "moved content");
    s.exec.spawn_local(async move {
        write.await.unwrap();
        d.set(true);
    });
    s.exec.run_until_parked();
    assert!(s.fake.fs.writes().is_empty(), "waits for the move");
    mv.settle("/ws/b.md");
    s.exec.run_until_parked();
    assert!(done.get());
    assert_eq!(s.fake.fs.read("/ws/b.md").as_deref(), Some("moved content"));
    assert!(s.fake.fs.read("/ws/a.md").is_none());
}

#[test]
fn a_failed_move_lands_writes_on_the_original_and_refuses_a_second_move() {
    let s = setup();
    let mv = s.docs.begin_move("/ws/a.md").unwrap();
    assert!(s.docs.begin_move("/ws/a.md").is_err());
    let write = s.docs.write("/ws/a.md", "kept");
    mv.settle("/ws/a.md");
    s.exec.block_on(write).unwrap();
    assert_eq!(s.fake.fs.read("/ws/a.md").as_deref(), Some("kept"));
    s.docs.begin_move("/ws/a.md").unwrap().settle("/ws/a.md");
}

#[test]
fn serializes_same_path_writes_and_settles_after_them() {
    let s = setup();
    let first = s.docs.write("/ws/a.md", "one");
    let second = s.docs.write("/ws/a.md", "two");
    let settled = Rc::new(Cell::new(false));
    let st = settled.clone();
    let when = s.docs.when_writes_settled("/ws/a.md");
    s.exec.spawn_local(async move {
        when.await;
        st.set(true);
    });
    s.exec.spawn_local(async move {
        let _ = second.await;
    });
    s.exec.spawn_local(async move {
        let _ = first.await;
    });
    s.exec.run_until_parked();
    assert!(settled.get());
    assert_eq!(s.fake.fs.writes(), ["/ws/a.md", "/ws/a.md"]);
    assert_eq!(s.fake.fs.read("/ws/a.md").as_deref(), Some("two"));
}

#[test]
fn autosave_debounces_typing_into_one_write() {
    let s = setup();
    let text = Rc::new(RefCell::new(String::from("a")));
    let sync = s.docs.sync("/ws/a.md");
    for c in ["ab", "abc", "abcd"] {
        *text.borrow_mut() = c.into();
        let t = text.clone();
        sync.edited(Rc::new(move || t.borrow().clone()));
        s.exec.advance(Duration::from_millis(100));
    }
    assert!(sync.has_unsaved_edits() && s.docs.any_unsaved());
    assert!(s.fake.fs.writes().is_empty());
    s.exec.advance(AUTOSAVE_DEBOUNCE);
    assert_eq!(s.fake.fs.writes(), ["/ws/a.md"]);
    assert_eq!(s.fake.fs.read("/ws/a.md").as_deref(), Some("abcd"));
    assert!(!sync.has_unsaved_edits());
}

#[test]
fn flush_pushes_the_debounce_window_and_when_clean_waits_for_the_write() {
    let s = setup();
    let sync = s.docs.sync("/ws/a.md");
    sync.edited(Rc::new(|| "typed".into()));
    let clean = Rc::new(Cell::new(false));
    s.docs.flush("/ws/a.md");
    let c = clean.clone();
    let when = s.docs.when_clean("/ws/a.md");
    s.exec.spawn_local(async move {
        when.await;
        c.set(true);
    });
    s.exec.run_until_parked();
    assert!(clean.get());
    assert_eq!(s.fake.fs.read("/ws/a.md").as_deref(), Some("typed"));
}

#[test]
fn needs_adoption_ignores_hash_churn_and_trailing_whitespace() {
    let s = setup();
    let sync = s.docs.sync("/ws/a.md");
    assert!(!sync.needs_adoption("h1", "x"), "no baseline yet");
    sync.ensure_baseline("text\n", Some("h0"));
    assert!(!sync.needs_adoption("h0", "other"));
    assert!(!sync.needs_adoption("h2", "text"));
    assert!(sync.needs_adoption("h3", "changed"));
}

#[test]
fn adopt_external_replaces_an_idle_editor_once() {
    let s = setup();
    let editor = open_editor(&s, "/ws/a.md", "old\n");
    assert!(s.exec.block_on(s.docs.adopt_external("/ws/a.md", "theirs\n")));
    assert_eq!(*editor.text.borrow(), "theirs\n");
    assert!(!s.exec.block_on(s.docs.adopt_external("/ws/a.md", "theirs\n")), "already adopted");
    assert_eq!(editor.adoptions.get(), 1);
}

#[test]
fn editors_report_dirty_through_documents() {
    let s = setup();
    let handle = s.editors.get("/ws/a.md");
    assert!(!handle.is_dirty());
    s.docs.sync("/ws/a.md").push_update(Rc::new(|| "x".into()));
    // The fake fs resolves synchronously once polled: dirty until then.
    assert!(handle.is_dirty());
    s.exec.run_until_parked();
    assert!(!handle.is_dirty());
}

#[test]
fn an_attributed_write_tells_the_editor_its_round() {
    let s = setup();
    struct Seen(RefCell<Option<String>>);
    impl EditorInstance for Seen {
        fn editor_type(&self) -> EditorType {
            EditorType::Markdown
        }
        fn focus(&self, _: bool) -> bool {
            true
        }
        fn dispose(&self) {}
        fn is_focusable(&self) -> bool {
            true
        }
        fn go_to(&self, _: EditorTarget) -> LocalBoxFuture<'static, bool> {
            ready(false).boxed_local()
        }
        fn selected_text(&self) -> Option<String> {
            None
        }
        fn adopt(&self, _: String, source: AdoptionSource) -> LocalBoxFuture<'static, Option<Adoption>> {
            *self.0.borrow_mut() = source.attribute.and_then(|a| a(&source.path, &source.content_hash));
            ready(Some(Adoption::default())).boxed_local()
        }
    }
    let seen = Rc::new(Seen(RefCell::new(None)));
    s.fake.fs.seed("/ws/a.md", "old");
    s.editors.register("/ws/a.md", seen.clone());
    s.docs.sync("/ws/a.md").ensure_baseline("old", None);
    s.docs.set_attribute(Rc::new(|_, _| Some("turn-1".into())));
    s.exec.block_on(s.docs.write("/ws/a.md", "new")).unwrap();
    assert_eq!(seen.0.borrow().as_deref(), Some("turn-1"));
}
