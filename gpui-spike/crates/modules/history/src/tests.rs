//! Port of `modules/history/history.test.ts`. The repo is handed in, as
//! core hands it: a counting fake for the instance's own logic, a real
//! gix repo in a temp dir for the module's turn checkpoints.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use notefig_core::testing::TestExecutor;
use notefig_core::{Core, CreateCoreOptions, Hooks, ModuleRef};
use notefig_history::{
    Checkpoint, FakeHistoryRepo, HistoryError, HistoryErrorCode, HistoryRepo, RepoStatus, Signature,
};

use notefig_agents::agent_events::{AgentTurnCompleted, AgentTurnCompletedEvent as TurnCompletedEvent};

use notefig_files::GitStale;

use crate::{
    HistoryDeps, HistoryModule, WorkspaceHistory, create_workspace_history, history_git_dir,
};

const WS: &str = "/workspace";

/// A fake repo that counts `ensure_init` calls.
struct Counting {
    fake: FakeHistoryRepo,
    inits: AtomicUsize,
}

impl HistoryRepo for Counting {
    fn workspace_path(&self) -> &Path {
        self.fake.workspace_path()
    }
    fn is_initialized(&self) -> bool {
        self.fake.is_initialized()
    }
    fn ensure_init(&self) -> notefig_history::Result<()> {
        self.inits.fetch_add(1, Ordering::SeqCst);
        self.fake.ensure_init()
    }
    fn status(&self) -> notefig_history::Result<RepoStatus> {
        self.fake.status()
    }
    fn log(&self, depth: Option<usize>, path: Option<&str>) -> notefig_history::Result<Vec<Checkpoint>> {
        self.fake.log(depth, path)
    }
    fn checkpoint(&self, message: &str, author: &Signature) -> notefig_history::Result<Option<String>> {
        self.fake.checkpoint(message, author)
    }
    fn revert_commit(&self, oid: &str, message: Option<&str>, author: &Signature) -> notefig_history::Result<Option<String>> {
        self.fake.revert_commit(oid, message, author)
    }
    fn abort_revert(&self) -> notefig_history::Result<()> {
        self.fake.abort_revert()
    }
    fn read_text(&self, rev: &str, path: &str) -> notefig_history::Result<String> {
        self.fake.read_text(rev, path)
    }
}

fn setup() -> (Rc<TestExecutor>, Arc<Counting>, Hooks, WorkspaceHistory) {
    let exec = TestExecutor::new();
    let repo = Arc::new(Counting { fake: FakeHistoryRepo::new(WS), inits: AtomicUsize::new(0) });
    let hooks = Hooks::new(exec.clone(), Rc::new(|err, at| panic!("{at}: {err:#}")));
    let history = create_workspace_history(HistoryDeps {
        workspace_path: WS.into(),
        repo: repo.clone(),
        executor: exec.clone(),
        hooks: hooks.clone(),
    });
    (exec, repo, hooks, history)
}

#[test]
fn resolves_the_gitdir_to_notefig_git() {
    assert_eq!(history_git_dir("/workspace/"), Path::new("/workspace/.notefig/.git"));
}

#[test]
fn binds_its_service_to_the_history_repo_once() {
    let (_, repo, _, history) = setup();
    let a = history.service().unwrap();
    let b = history.service().unwrap();
    assert!(Arc::ptr_eq(&a, &b));
    assert!(Arc::ptr_eq(&a, &(repo as Arc<dyn HistoryRepo>)));
}

#[test]
fn ready_initializes_the_repo() {
    let (exec, repo, _, history) = setup();
    assert!(!history.service().unwrap().is_initialized());
    exec.block_on(history.ready()).unwrap();
    assert!(repo.is_initialized());
}

#[test]
fn initializes_once_for_calls_in_flight_together_and_again_for_a_later_one() {
    let (exec, repo, _, history) = setup();
    let (a, b) = (history.ready(), history.ready());
    exec.block_on(async move {
        a.await.unwrap();
        b.await.unwrap();
    });
    assert_eq!(repo.inits.load(Ordering::SeqCst), 1);
    exec.block_on(history.ready()).unwrap();
    assert_eq!(repo.inits.load(Ordering::SeqCst), 2);
}

#[test]
fn dispose_drops_the_service() {
    let (_, _, _, history) = setup();
    history.service().unwrap();
    history.dispose();
    let err = history.service().err().unwrap();
    assert!(err.message.contains("closed"), "{}", err.message);
}

#[test]
fn a_ready_still_initializing_when_the_workspace_closes_recreates_nothing() {
    let (exec, _, _, history) = setup();
    let pending = history.ready();
    history.dispose();
    let err = exec.block_on(pending).err().unwrap();
    assert!(err.message.contains("closed"));
}

#[test]
fn a_checkpoint_announces_git_stale_and_surfaces_errors() {
    let (exec, repo, hooks, history) = setup();
    let heard = Rc::new(RefCell::new(Vec::new()));
    let h = heard.clone();
    let _sub = hooks.on::<GitStale, _>(move |e| h.borrow_mut().push(e.workspace_path.clone()));
    repo.fake.write_file("a.md", "x");
    let oid = exec.block_on(history.checkpoint("one", Signature::panel())).unwrap();
    assert!(oid.is_some());
    assert_eq!(*heard.borrow(), vec![WS.to_string()]);

    repo.fake.fail_next(HistoryError::new(HistoryErrorCode::LockUnavailable, "busy"));
    repo.fake.write_file("a.md", "y");
    // ensure_init takes the injected failure.
    let err = exec.block_on(history.checkpoint("two", Signature::panel())).err().unwrap();
    assert_eq!(err.code, HistoryErrorCode::LockUnavailable);
    assert_eq!(heard.borrow().len(), 1);
}

#[test]
fn reads_a_file_at_a_checkpoint() {
    let (exec, repo, _, history) = setup();
    repo.fake.write_file("a.md", "first");
    let oid = exec.block_on(history.checkpoint("one", Signature::panel())).unwrap().unwrap();
    repo.fake.write_file("a.md", "second");
    assert_eq!(exec.block_on(history.read(&oid, "a.md")).unwrap(), "first");
}

fn turn(workspace_path: &str, prompt: &str) -> TurnCompletedEvent {
    TurnCompletedEvent {
        task_id: "t".into(),
        turn_id: "u".into(),
        workspace_path: workspace_path.into(),
        prompt: prompt.into(),
        harness_id: "claude-code".into(),
    }
}

#[test]
fn history_module_checkpoints_each_completed_agent_turn_in_its_own_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().to_string_lossy().into_owned();
    std::fs::write(dir.path().join("note.md"), "hello").unwrap();

    let exec = TestExecutor::new();
    let core = Core::new(CreateCoreOptions::new(exec.clone()).modules(vec![ModuleRef::of::<HistoryModule>()])).unwrap();
    core.boot();
    exec.block_on(core.workspace(&ws).open()).unwrap();
    let history = core.workspace(&ws).get::<HistoryModule>().unwrap();

    let stale = Rc::new(RefCell::new(0));
    let s = stale.clone();
    let _sub = core.hooks().on::<GitStale, _>(move |_| *s.borrow_mut() += 1);

    core.hooks().emit::<AgentTurnCompleted>(turn("/elsewhere", "not here"));
    core.hooks().emit::<AgentTurnCompleted>(turn(&ws, &"x".repeat(80)));
    exec.run_until_parked();

    let log = history.service().unwrap().log(None, None).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].message.trim_end(), format!("{}…", "x".repeat(69)));
    assert_eq!(log[0].author_name, "claude-code");
    assert_eq!(log[0].author_email, "agent@notefig.local");
    assert_eq!(*stale.borrow(), 1);

    // Closed: the listener is gone with the instance.
    exec.block_on(core.workspace(&ws).close());
    core.hooks().emit::<AgentTurnCompleted>(turn(&ws, "after close"));
    exec.run_until_parked();
    assert_eq!(*stale.borrow(), 1);
    exec.block_on(core.dispose());
}

// ─── the agent tools (`modules/agents/tools/__tests__/history-*.test.ts`) ───

mod tools {
    use super::*;
    use notefig_agent::services::AppToolCall;
    use notefig_agents::HistoryService;
    use notefig_platform::fake::FakePlatform;

    use crate::tools::HistoryTools;

    fn service(history: WorkspaceHistory, fake: &FakePlatform) -> HistoryTools {
        let history = Rc::new(history);
        HistoryTools {
            history: Rc::new(move |ws| if ws == WS { Ok(history.clone()) } else { Err(format!("no history for {ws}")) }),
            write: {
                let fs = fake.platform.fs.clone();
                Rc::new(move |path: &str, content: String| {
                    let fut = fs.write_files(vec![(path.to_string(), content)]);
                    Box::pin(async move {
                        let mut out = fut.await;
                        out.failed.pop().map_or(Ok(()), |e| Err(e.to_string()))
                    })
                })
            },
        }
    }

    #[test]
    fn log_diff_checkpoint_and_restore_answer_as_the_ts_tools() {
        let (exec, repo, hooks, history) = setup();
        let fake = FakePlatform::new();
        let stale = Rc::new(RefCell::new(0));
        let s = stale.clone();
        let _sub = hooks.on::<GitStale, _>(move |_| *s.borrow_mut() += 1);
        let tools = service(history, &fake);

        repo.fake.write_file("a.md", "one");
        let first = exec.block_on(tools.call(WS, AppToolCall::HistoryCheckpoint { message: "first".into() })).unwrap();
        let first = first["oid"].as_str().unwrap().to_string();
        assert_eq!(*stale.borrow(), 1, "an agent checkpoint marks git stale");
        repo.fake.write_file("a.md", "two");
        exec.block_on(tools.call(WS, AppToolCall::HistoryCheckpoint { message: "second".into() })).unwrap();

        let log = exec.block_on(tools.call(WS, AppToolCall::HistoryLog { path: None })).unwrap();
        let log = log.as_array().unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0]["message"], "second");
        assert_eq!(log[1]["author"], "agent");

        let diff = exec
            .block_on(tools.call(WS, AppToolCall::HistoryDiff {
                path: "/workspace/a.md".into(),
                relative: "a.md".into(),
                from: first.clone(),
                to: "HEAD".into(),
            }))
            .unwrap();
        assert_eq!(diff["fromContent"], "one");
        assert_eq!(diff["toContent"], "two");

        let restored = exec.block_on(tools.call(WS, AppToolCall::HistoryRestore {
            path: "/workspace/a.md".into(),
            relative: "a.md".into(),
            checkpoint: first,
        }));
        assert_eq!(restored, Ok(serde_json::Value::Null));
        let read = exec.block_on(fake.platform.fs.read_files(vec!["/workspace/a.md".into()]));
        assert_eq!(read.succeeded[0].1, "one");
    }

    #[test]
    fn a_closed_workspace_answers_with_error_text() {
        let (exec, _, _, history) = setup();
        let fake = FakePlatform::new();
        let tools = service(history, &fake);
        let err = exec.block_on(tools.call("/other", AppToolCall::HistoryLog { path: None })).unwrap_err();
        assert!(err.contains("/other"));
    }
}
