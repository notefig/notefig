//! Port of `modules/editors/editors.test.ts`, plus the registry's mount
//! waits and the editor-type gate.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, ready};
use notefig_core::ExecutorExt;
use notefig_core::testing::TestExecutor;

use crate::*;

struct Fake {
    went: Rc<Cell<u32>>,
}

impl EditorInstance for Fake {
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
        self.went.set(self.went.get() + 1);
        ready(true).boxed_local()
    }
    fn selected_text(&self) -> Option<String> {
        None
    }
}

fn target() -> EditorTarget {
    EditorTarget::Block { block_id: "b1".into() }
}

#[test]
fn context_does_not_count_a_sibling_prefixed_workspace() {
    let exec = TestExecutor::new();
    let editors = create_editors(exec);
    let tabs = vec!["/ws/a.md".to_string(), "/ws-backup/x.md".to_string()];
    let c = workspace_editor_context(&editors, &tabs, Some("/ws-backup/x.md"), "/ws");
    assert_eq!(c.open_files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["/ws/a.md"]);
    assert_eq!(c.active_file, None);
}

#[test]
fn context_scopes_to_the_workspace_and_reports_its_active_file() {
    let exec = TestExecutor::new();
    let editors = create_editors(exec);
    editors.set_dirty_source(Rc::new(|_| false));
    let tabs = vec!["/ws/a.md".to_string(), "/other/b.md".to_string()];
    let c = workspace_editor_context(&editors, &tabs, Some("/ws/a.md"), "/ws");
    assert_eq!(c.active_file.as_deref(), Some("/ws/a.md"));
    assert_eq!(c.open_files, [OpenFileContext { path: "/ws/a.md".into(), dirty: false, active: true }]);
}

#[test]
fn go_to_waits_for_the_mount_then_runs() {
    let exec = TestExecutor::new();
    let editors = create_editors(exec.clone());
    let went = Rc::new(Cell::new(0));
    let done = Rc::new(Cell::new(None));
    let d = done.clone();
    let fut = editors.go_to("/ws/a.md", target());
    exec.spawn_local(async move { d.set(Some(fut.await)) });
    exec.run_until_parked();
    assert_eq!(done.get(), None, "nothing mounted yet");
    editors.register("/ws/a.md", Rc::new(Fake { went: went.clone() }));
    editors.mark_mounted("/ws/a.md");
    exec.run_until_parked();
    assert_eq!(done.get(), Some(true));
    assert_eq!(went.get(), 1);
}

#[test]
fn go_to_gives_up_after_the_mount_wait() {
    let exec = TestExecutor::new();
    let editors = create_editors(exec.clone());
    let done = Rc::new(Cell::new(None));
    let d = done.clone();
    let fut = editors.go_to("/ws/a.md", target());
    exec.spawn_local(async move { d.set(Some(fut.await)) });
    exec.advance(MOUNT_WAIT + Duration::from_millis(1));
    assert_eq!(done.get(), Some(false));
}

#[test]
fn unregister_unmounts_and_handles_follow_the_registry() {
    let exec = TestExecutor::new();
    let editors = create_editors(exec);
    let handle = editors.get("/ws/a.md");
    assert!(!handle.is_mounted());
    editors.register("/ws/a.md", Rc::new(Fake { went: Rc::default() }));
    editors.mark_mounted("/ws/a.md");
    assert!(handle.is_mounted() && editors.is_mounted("/ws/a.md"));
    assert!(editors.markdown_editor("/ws/a.md").is_some());
    editors.unregister("/ws/a.md");
    assert!(!handle.is_mounted() && !editors.is_mounted("/ws/a.md"));
}

#[test]
fn editor_type_gate() {
    assert_eq!(editor_type("/a/README.md"), EditorType::Markdown);
    assert_eq!(editor_type("/a/x.rs"), EditorType::Code);
    assert_eq!(editor_type("/a/x.PNG"), EditorType::Image);
    assert!(can_open_file("/a/Makefile"));
    assert!(!can_open_file("/a/x.pdf"));
    assert!(can_open_file("/a.d/LICENSE"), "a dotted folder is not an extension");
}
