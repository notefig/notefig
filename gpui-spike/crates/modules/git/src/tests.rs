//! Port of `modules/git/git.test.ts` and `git-save-race.test.ts`. The
//! history repo is a scripted one handed in the way core hands it (the TS
//! tests' `vi.fn` service), or a real gix repo in a temp dir for the module.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::testing::TestExecutor;
use notefig_core::{Core, CreateCoreOptions, Executor, Hooks, ModuleRef};
use notefig_history::{
    ChangeKind, Checkpoint, FileChange, HistoryError, HistoryErrorCode, HistoryRepo, RepoStatus, Signature,
};
use notefig_files::{GitStale, WorkspaceEvent as GitStaleEvent};
use notefig_history_module::{HistoryDeps, HistoryModule, create_workspace_history};

use crate::{GitDeps, GitModule, GitRow, SyncState, WorkspaceGit, create_workspace_git, derive_sync_state, fetch_git_rows};

const WS: &str = "/tmp/ws-git-entity-test";

type Script<T> = Mutex<Box<dyn FnMut(&Scripted) -> notefig_history::Result<T> + Send>>;

/// The TS tests' mocked service: each call runs what the test scripted.
struct Scripted {
    status: Mutex<notefig_history::Result<RepoStatus>>,
    log: Mutex<notefig_history::Result<Vec<Checkpoint>>>,
    commit: Script<Option<String>>,
    status_calls: Mutex<usize>,
    log_calls: Mutex<usize>,
    commits: Mutex<Vec<(String, Signature)>>,
    path: PathBuf,
}

impl Scripted {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            status: Mutex::new(Ok(status(&[], &[]))),
            log: Mutex::new(Ok(vec![])),
            commit: Mutex::new(Box::new(|_| Ok(None))),
            status_calls: Mutex::new(0),
            log_calls: Mutex::new(0),
            commits: Mutex::new(vec![]),
            path: std::env::temp_dir(),
        })
    }
    fn set_status(&self, s: notefig_history::Result<RepoStatus>) {
        *self.status.lock().unwrap() = s;
    }
    fn set_log(&self, l: notefig_history::Result<Vec<Checkpoint>>) {
        *self.log.lock().unwrap() = l;
    }
    fn on_commit(&self, f: impl FnMut(&Scripted) -> notefig_history::Result<Option<String>> + Send + 'static) {
        *self.commit.lock().unwrap() = Box::new(f);
    }
}

impl HistoryRepo for Scripted {
    fn workspace_path(&self) -> &Path {
        &self.path
    }
    fn is_initialized(&self) -> bool {
        true
    }
    fn ensure_init(&self) -> notefig_history::Result<()> {
        Ok(())
    }
    fn status(&self) -> notefig_history::Result<RepoStatus> {
        *self.status_calls.lock().unwrap() += 1;
        self.status.lock().unwrap().clone()
    }
    fn log(&self, _: Option<usize>, _: Option<&str>) -> notefig_history::Result<Vec<Checkpoint>> {
        *self.log_calls.lock().unwrap() += 1;
        self.log.lock().unwrap().clone()
    }
    fn checkpoint(&self, message: &str, author: &Signature) -> notefig_history::Result<Option<String>> {
        self.commits.lock().unwrap().push((message.to_string(), author.clone()));
        let mut commit = self.commit.lock().unwrap();
        commit(self)
    }
    fn revert_commit(&self, _: &str, _: Option<&str>, _: &Signature) -> notefig_history::Result<Option<String>> {
        Ok(None)
    }
    fn abort_revert(&self) -> notefig_history::Result<()> {
        Ok(())
    }
    fn read_text(&self, _: &str, _: &str) -> notefig_history::Result<String> {
        Ok(String::new())
    }
}

fn status(staged: &[&str], untracked: &[&str]) -> RepoStatus {
    RepoStatus {
        current_branch: "main".into(),
        staged: staged.iter().map(|p| FileChange { path: p.to_string(), kind: ChangeKind::Modified }).collect(),
        untracked: untracked.iter().map(|p| p.to_string()).collect(),
        ..Default::default()
    }
}

fn commit(oid: &str, message: &str, committer_time: i64) -> Checkpoint {
    Checkpoint {
        oid: oid.into(),
        message: message.into(),
        author_name: "a".into(),
        author_email: "a@x".into(),
        author_time: committer_time,
        committer_time,
    }
}

fn workspace_git(exec: Rc<dyn Executor>, repo: Arc<Scripted>) -> WorkspaceGit {
    let hooks = Hooks::new(exec.clone(), Rc::new(|err, at| panic!("{at}: {err:#}")));
    let history = create_workspace_history(HistoryDeps {
        workspace_path: WS.into(),
        repo,
        executor: exec,
        hooks,
    });
    create_workspace_git(GitDeps { workspace_path: WS.into(), history: Rc::new(history) })
}

fn repo_row(rows: &[GitRow]) -> &crate::GitRepoRow {
    rows.iter()
        .find_map(|r| match r {
            GitRow::Repo(r) => Some(r),
            _ => None,
        })
        .expect("a repo row")
}

// ─── fetchGitRows ───────────────────────────────────────────────────────────

#[test]
fn flattens_status_and_log_into_repo_file_and_checkpoint_rows() {
    let repo = Scripted::new();
    let mut s = status(&["a.md"], &["b.md"]);
    s.unstaged = vec![FileChange { path: "a.md".into(), kind: ChangeKind::Modified }];
    repo.set_status(Ok(s));
    repo.set_log(Ok(vec![commit("abc1234def", "First line\nBody", 1_000)]));

    let rows = fetch_git_rows(&*repo, WS).unwrap();

    let repo_row = repo_row(&rows);
    assert!(repo_row.initialized);
    assert_eq!(repo_row.branch, "main");
    assert!(repo_row.status_error.is_none());

    let files: Vec<_> = rows.iter().filter_map(|r| if let GitRow::File(f) = r { Some(f) } else { None }).collect();
    assert_eq!(files.len(), 2);
    let a = files.iter().find(|f| f.path == format!("{WS}/a.md")).unwrap();
    assert!(a.staged && a.unstaged && !a.untracked);
    let b = files.iter().find(|f| f.path == format!("{WS}/b.md")).unwrap();
    assert!(b.untracked && !b.staged);

    let cps: Vec<_> = rows.iter().filter_map(|r| if let GitRow::Checkpoint(c) = r { Some(c) } else { None }).collect();
    assert_eq!(cps.len(), 1);
    assert_eq!(cps[0].id, "cp:abc1234def");
    assert_eq!(cps[0].hash, "abc1234");
    assert_eq!(cps[0].message, "First line");
    assert_eq!(cps[0].timestamp, 1_000_000);
}

#[test]
fn repo_not_found_becomes_an_uninitialized_repo_row_and_skips_log() {
    let repo = Scripted::new();
    repo.set_status(Err(HistoryError::new(HistoryErrorCode::RepoNotFound, "no repo here")));

    let rows = fetch_git_rows(&*repo, WS).unwrap();

    let row = repo_row(&rows);
    assert!(!row.initialized);
    assert_eq!(row.status_error, Some(HistoryError::new(HistoryErrorCode::RepoNotFound, "no repo here")));
    assert_eq!(*repo.log_calls.lock().unwrap(), 0);
    assert!(!rows.iter().any(|r| matches!(r, GitRow::Checkpoint(_))));
}

#[test]
fn failures_land_as_errors_as_data() {
    let repo = Scripted::new();
    repo.set_status(Err(HistoryError::new(HistoryErrorCode::Unknown, "exploded")));
    repo.set_log(Err(HistoryError::new(HistoryErrorCode::LockUnavailable, "busy")));

    let rows = fetch_git_rows(&*repo, WS).unwrap();

    let row = repo_row(&rows);
    assert_eq!(row.status_error, Some(HistoryError::new(HistoryErrorCode::Unknown, "exploded")));
    assert_eq!(row.log_error, Some(HistoryError::new(HistoryErrorCode::LockUnavailable, "busy")));
}

#[test]
fn workspace_access_errors_escape_for_the_error_screen() {
    let repo = Scripted::new();
    repo.set_status(Err(HistoryError::new(HistoryErrorCode::Io, "gone")));
    let lost = Arc::new(Scripted {
        path: PathBuf::from("/nonexistent/notefig-git-test-workspace"),
        ..Arc::try_unwrap(repo).ok().unwrap()
    });
    let err = fetch_git_rows(&*lost, WS).unwrap_err();
    assert!(err.is_workspace_access_error(), "{err:?}");

    let exec = TestExecutor::new();
    let git = workspace_git(exec.clone(), lost);
    exec.block_on(git.preload());
    assert!(git.access_error().is_some());
    assert!(git.rows().is_none());
    assert_eq!(git.updated_at(), None, "no rows landed");
}

/// The debug panel's `gitStatus.updatedAt` (the query's `dataUpdatedAt`).
#[test]
fn stamps_when_the_rows_land() {
    let exec = TestExecutor::new();
    let git = workspace_git(exec.clone(), Scripted::new());
    assert_eq!(git.updated_at(), None);
    exec.block_on(git.preload());
    assert!(git.updated_at().is_some_and(|at| at > 0));
}

// ─── saveCheckpoint ─────────────────────────────────────────────────────────

#[test]
fn save_commits_and_the_refetched_rows_include_the_new_checkpoint() {
    let exec = TestExecutor::new();
    let repo = Scripted::new();
    repo.on_commit(|repo| {
        repo.set_log(Ok(vec![commit("feedbeef00", "did things", 2_000)]));
        Ok(Some("feedbeef00".into()))
    });
    let git = workspace_git(exec.clone(), repo.clone());
    exec.block_on(git.preload());

    let oid = exec.block_on(git.save_checkpoint(Some("did things"))).unwrap();

    assert_eq!(oid.as_deref(), Some("feedbeef00"));
    let commits = repo.commits.lock().unwrap().clone();
    assert_eq!(commits, vec![("did things".to_string(), Signature::new("Notefig", "git@notefig.com"))]);
    let cps = git.checkpoints();
    assert_eq!(cps[0].id, "cp:feedbeef00");
    assert_eq!(cps[0].hash, "feedbee");
    assert_eq!(cps[0].message, "did things");
}

#[test]
fn save_fails_when_the_commit_fails_leaving_no_checkpoint_behind() {
    let exec = TestExecutor::new();
    let repo = Scripted::new();
    repo.on_commit(|_| Err(HistoryError::new(HistoryErrorCode::LockUnavailable, "busy")));
    let git = workspace_git(exec.clone(), repo);

    let err = exec.block_on(git.save_checkpoint(Some("nope"))).unwrap_err();
    assert!(err.message.contains("busy"));
    assert!(git.checkpoints().iter().all(|c| c.message != "nope"));
}

#[test]
fn save_returns_none_when_there_is_nothing_to_commit() {
    let exec = TestExecutor::new();
    let git = workspace_git(exec.clone(), Scripted::new());
    assert_eq!(exec.block_on(git.save_checkpoint(Some("empty"))).unwrap(), None);
}

#[test]
fn an_empty_description_commits_as_commit() {
    let exec = TestExecutor::new();
    let repo = Scripted::new();
    let git = workspace_git(exec.clone(), repo.clone());
    exec.block_on(git.save_checkpoint(Some("   "))).unwrap();
    assert_eq!(repo.commits.lock().unwrap()[0].0, "Commit");
}

// ─── git-save-race.test.ts ──────────────────────────────────────────────────

/// Blocking work runs at once (it reads the repo as it is now), but its
/// result lands after the next scripted delay — a slow fetch.
struct Delayed {
    exec: Rc<TestExecutor>,
    delays: std::cell::RefCell<VecDeque<Duration>>,
}

impl Executor for Delayed {
    fn spawn(&self, future: LocalBoxFuture<'static, ()>) {
        self.exec.spawn(future)
    }
    fn timer(&self, duration: Duration) -> LocalBoxFuture<'static, ()> {
        self.exec.timer(duration)
    }
    fn run_blocking(
        &self,
        work: Box<dyn FnOnce() -> Box<dyn std::any::Any + Send> + Send>,
    ) -> LocalBoxFuture<'static, Box<dyn std::any::Any + Send>> {
        let value = work();
        let delay = self.delays.borrow_mut().pop_front().unwrap_or_default();
        self.exec.timer(delay).map(move |_| value).boxed_local()
    }
}

#[test]
fn leaves_no_stale_rows_after_a_save_with_a_racing_invalidation() {
    let exec = TestExecutor::new();
    let delayed = Rc::new(Delayed { exec: exec.clone(), delays: Default::default() });
    let repo = Scripted::new();
    repo.set_status(Ok(status(&["a.md"], &[])));
    repo.set_log(Ok(vec![commit("8ec4833aa", "Commit", 1_700)]));
    let git = workspace_git(delayed.clone(), repo.clone());
    exec.spawn(git.preload());
    exec.advance(Duration::ZERO);
    assert_eq!(git.checkpoints().len(), 1);

    repo.on_commit(|repo| {
        repo.set_log(Ok(vec![commit("025f78bbb", "Commit", 1_800), commit("8ec4833aa", "Commit", 1_700)]));
        repo.set_status(Ok(status(&[], &[])));
        Ok(Some("025f78bbb".into()))
    });
    // A watcher-driven invalidation reads pre-commit state and lands late;
    // the commit and its refetch land first.
    delayed.delays.borrow_mut().extend([Duration::from_millis(50), Duration::from_millis(10), Duration::from_millis(10)]);
    git.invalidate();
    let save = git.save_checkpoint(None);
    let oid = Rc::new(std::cell::RefCell::new(None));
    let o = oid.clone();
    exec.spawn(async move { *o.borrow_mut() = Some(save.await) }.boxed_local());
    exec.advance(Duration::from_millis(100));

    assert_eq!(oid.borrow().clone().unwrap().unwrap().as_deref(), Some("025f78bbb"));
    let mut ids: Vec<_> = git.checkpoints().into_iter().map(|c| c.id).collect();
    ids.sort();
    assert_eq!(ids, vec!["cp:025f78bbb", "cp:8ec4833aa"]);
    assert!(!git.summary().unwrap().has_changes, "the stale pre-commit status did not land");
    assert!(!git.is_fetching());
}

// ─── lifetime and module ────────────────────────────────────────────────────

#[test]
fn dispose_drops_the_cached_rows() {
    let exec = TestExecutor::new();
    let git = workspace_git(exec.clone(), Scripted::new());
    exec.block_on(git.preload());
    assert!(git.rows().is_some());
    git.dispose();
    assert!(git.rows().is_none());
}

#[test]
fn derives_the_sync_state() {
    let exec = TestExecutor::new();
    let repo = Scripted::new();
    let git = workspace_git(exec.clone(), repo.clone());
    assert_eq!(derive_sync_state(git.summary().as_ref()), SyncState::Synced);
    repo.set_status(Ok(status(&[], &["new.md"])));
    exec.block_on(git.preload());
    assert_eq!(derive_sync_state(git.summary().as_ref()), SyncState::Uncommitted);
}

#[test]
fn git_module_refetches_when_its_own_workspace_is_announced_stale_until_it_closes() {
    let dir = tempfile_dir();
    let ws = dir.to_string_lossy().into_owned();
    let exec = TestExecutor::new();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .modules(vec![ModuleRef::of::<HistoryModule>(), ModuleRef::of::<GitModule>()]),
    )
    .unwrap();
    core.boot();
    exec.block_on(core.workspace(&ws).open()).unwrap();
    let git = core.workspace(&ws).get::<GitModule>().unwrap();
    exec.block_on(git.initialize()).unwrap();
    // A reader starts the rows' sync, as a live query does.
    exec.block_on(git.preload());
    assert!(git.summary().unwrap().initialized);
    assert!(!git.summary().unwrap().has_changes);

    std::fs::write(dir.join("new.md"), "hi").unwrap();
    core.hooks().emit::<GitStale>(GitStaleEvent { workspace_path: "/somewhere-else".into() });
    assert!(!git.is_fetching());

    core.hooks().emit::<GitStale>(GitStaleEvent { workspace_path: ws.clone() });
    assert!(git.is_fetching());
    exec.run_until_parked();
    assert!(git.summary().unwrap().has_changes);

    // Save through the panel's action, as a real commit.
    let oid = exec.block_on(git.save_checkpoint(Some("first"))).unwrap();
    assert!(oid.is_some());
    assert_eq!(git.checkpoints()[0].message, "first");

    exec.block_on(core.workspace(&ws).close());
    core.hooks().emit::<GitStale>(GitStaleEvent { workspace_path: ws.clone() });
    assert!(!git.is_fetching());
    exec.block_on(core.dispose());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A fresh dir under `$TMPDIR` (no tempfile dependency for one test).
fn tempfile_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("notefig-git-test-{}-{:?}", std::process::id(), std::thread::current().id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}
