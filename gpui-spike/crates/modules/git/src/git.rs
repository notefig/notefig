use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::{MAIN_SEPARATOR_STR, Path};
use std::rc::{Rc, Weak};

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::{Listeners, Subscription};
use notefig_history::{HistoryError, HistoryErrorCode, HistoryRepo, RepoStatus, Signature};
use notefig_history_module::WorkspaceHistory;
use notefig_platform::{FsError, FsErrorKind};

/// The checkpoint panel's identity (`COMMIT_AUTHOR`).
pub const COMMIT_AUTHOR_NAME: &str = "Notefig";
pub const COMMIT_AUTHOR_EMAIL: &str = "git@notefig.com";

// Measured in TS on a packed monorepo: the log is the per-refetch cost
// while the panel realistically shows a screenful.
const CHECKPOINT_LOG_DEPTH: usize = 25;

/// The one repo row. Errors are data (`SerializedGitError`): a
/// [`HistoryError`] already is one, code and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepoRow {
    pub branch: String,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// false ⇔ status failed with `RepoNotFound`.
    pub initialized: bool,
    pub status_error: Option<HistoryError>,
    pub log_error: Option<HistoryError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitFileRow {
    /// `file:<absolute path>`.
    pub id: String,
    /// Absolute, native.
    pub path: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCheckpointRow {
    /// `cp:<oid>`.
    pub id: String,
    pub oid: String,
    pub hash: String,
    /// The message's first line, or "Commit".
    pub message: String,
    /// Committer time, epoch ms.
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitRow {
    Repo(GitRepoRow),
    File(GitFileRow),
    Checkpoint(GitCheckpointRow),
}

/// The repo row plus a change flag (`useGitSummary`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitSummary {
    pub initialized: bool,
    pub branch: String,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub status_error: Option<HistoryError>,
    pub log_error: Option<HistoryError>,
    /// Any staged/unstaged/untracked/conflicted file.
    pub has_changes: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncState {
    Uncommitted,
    Unsynced,
    Synced,
}

pub fn derive_sync_state(summary: Option<&GitSummary>) -> SyncState {
    let Some(summary) = summary else { return SyncState::Synced };
    if summary.has_changes {
        SyncState::Uncommitted
    } else if summary.ahead.unwrap_or(0) > 0 {
        SyncState::Unsynced
    } else {
        SyncState::Synced
    }
}

/// Status results are repo-relative and `/`-separated; absolutes land in
/// native spelling.
fn to_absolute(workspace_path: &str, relative: &str) -> String {
    if Path::new(relative).is_absolute() {
        return relative.to_string();
    }
    let native = relative.replace('/', MAIN_SEPARATOR_STR);
    Path::new(workspace_path).join(native).to_string_lossy().into_owned()
}

fn file_rows_from_status(workspace_path: &str, status: &RepoStatus) -> Vec<GitFileRow> {
    // Insertion-ordered by first sighting, as the TS Map.
    let mut order: Vec<String> = Vec::new();
    let mut rows: BTreeMap<String, GitFileRow> = BTreeMap::new();
    let mut mark = |relative: &str, flag: fn(&mut GitFileRow)| {
        let path = to_absolute(workspace_path, relative);
        let row = rows.entry(path.clone()).or_insert_with(|| {
            order.push(path.clone());
            GitFileRow {
                id: format!("file:{path}"),
                path: path.clone(),
                staged: false,
                unstaged: false,
                untracked: false,
                conflicted: false,
            }
        });
        flag(row);
    };
    for change in &status.staged {
        mark(&change.path, |r| r.staged = true);
    }
    for change in &status.unstaged {
        mark(&change.path, |r| r.unstaged = true);
    }
    for path in &status.untracked {
        mark(path, |r| r.untracked = true);
    }
    for path in &status.conflicts {
        mark(path, |r| r.conflicted = true);
    }
    order.into_iter().filter_map(|p| rows.remove(&p)).collect()
}

/// When a repo call failed: whether the workspace folder itself is gone or
/// unreadable — the one failure that is not git's (`isWorkspaceAccessError`).
/// The repo already reads this disk, so the check stays with it.
fn workspace_access_error(repo: &dyn HistoryRepo) -> Option<FsError> {
    let path = repo.workspace_path();
    let shown = path.to_string_lossy().into_owned();
    match std::fs::read_dir(path) {
        Ok(_) => None,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Some(FsError::new(FsErrorKind::HandleMissing, shown)),
        Err(err) => Some(FsError::from_io(&err, shown)).filter(FsError::is_workspace_access_error),
    }
}

/// Status + log in one pass, as rows (the collection's `queryFn`).
/// Blocking. Every git failure is data on the repo row; only a
/// workspace-access error escapes, for the workspace's error screen.
pub fn fetch_git_rows(repo: &dyn HistoryRepo, workspace_path: &str) -> Result<Vec<GitRow>, FsError> {
    let mut rows = Vec::new();
    let (status, status_error) = match repo.status() {
        Ok(status) => (Some(status), None),
        Err(err) => {
            if let Some(access) = workspace_access_error(repo) {
                return Err(access);
            }
            (None, Some(err))
        }
    };
    let uninitialized = status_error.as_ref().is_some_and(|e| e.code == HistoryErrorCode::RepoNotFound);

    let mut log_error = None;
    if !uninitialized {
        match repo.log(Some(CHECKPOINT_LOG_DEPTH), None) {
            Ok(entries) => {
                for entry in entries {
                    rows.push(GitRow::Checkpoint(GitCheckpointRow {
                        id: format!("cp:{}", entry.oid),
                        hash: entry.hash().to_string(),
                        message: match entry.message.split('\n').next() {
                            Some(line) if !line.is_empty() => line.to_string(),
                            _ => "Commit".to_string(),
                        },
                        timestamp: entry.committer_time * 1000,
                        oid: entry.oid,
                    }));
                }
            }
            Err(err) => {
                if let Some(access) = workspace_access_error(repo) {
                    return Err(access);
                }
                log_error = Some(err)
            }
        }
    }

    if let Some(status) = &status {
        rows.extend(file_rows_from_status(workspace_path, status).into_iter().map(GitRow::File));
    }

    rows.push(GitRow::Repo(GitRepoRow {
        branch: status.as_ref().map(|s| s.current_branch.clone()).unwrap_or_default(),
        // The history repo has no remote: never ahead or behind.
        ahead: None,
        behind: None,
        initialized: !uninitialized,
        status_error,
        log_error,
    }));
    Ok(rows)
}

/// What a workspace's git timeline is built from.
pub struct GitDeps {
    pub workspace_path: String,
    /// The workspace's history repo (`core.workspace(ws).get::<HistoryModule>()`).
    pub history: Rc<WorkspaceHistory>,
}

pub(crate) struct Inner {
    workspace_path: String,
    history: Rc<WorkspaceHistory>,
    rows: RefCell<Option<Rc<Vec<GitRow>>>>,
    /// Fetches running.
    in_flight: Cell<usize>,
    /// The newest fetch's generation; a fetch whose own is older is dropped
    /// when it lands. A cancel bumps it with no fetch of its own.
    generation: Cell<u64>,
    /// Someone reads the rows (preloaded or subscribed): an invalidation
    /// refetches, as an observed query's does.
    active: Cell<bool>,
    stale: Cell<bool>,
    disposed: Cell<bool>,
    /// The last fetch's workspace-access failure (the TS query error that
    /// reaches `WorkspaceErrorBoundary`); cleared by a fetch that lands.
    access_error: RefCell<Option<FsError>>,
    /// When the rows last landed, epoch ms (the query's `dataUpdatedAt`).
    updated_at: Cell<Option<i64>>,
    changed: Listeners<()>,
    kept: RefCell<Vec<Subscription>>,
}

/// One workspace's checkpoint timeline: its rows, and the actions on them —
/// `core.workspace(ws).get::<GitModule>()`.
#[derive(Clone)]
pub struct WorkspaceGit {
    inner: Rc<Inner>,
}

pub fn create_workspace_git(deps: GitDeps) -> WorkspaceGit {
    WorkspaceGit {
        inner: Rc::new(Inner {
            workspace_path: deps.workspace_path.trim_end_matches(['/', '\\']).to_string(),
            history: deps.history,
            rows: RefCell::new(None),
            in_flight: Cell::new(0),
            generation: Cell::new(0),
            active: Cell::new(false),
            stale: Cell::new(false),
            disposed: Cell::new(false),
            access_error: RefCell::new(None),
            updated_at: Cell::new(None),
            changed: Listeners::new(),
            kept: RefCell::default(),
        }),
    }
}

impl WorkspaceGit {
    pub fn workspace_path(&self) -> &str {
        &self.inner.workspace_path
    }

    /// Every row, once the first fetch has landed.
    pub fn rows(&self) -> Option<Rc<Vec<GitRow>>> {
        self.inner.rows.borrow().clone()
    }

    /// `useGitSummary`: `None` until the first fetch lands.
    pub fn summary(&self) -> Option<GitSummary> {
        let rows = self.rows()?;
        let repo = rows.iter().find_map(|r| match r {
            GitRow::Repo(repo) => Some(repo),
            _ => None,
        })?;
        Some(GitSummary {
            initialized: repo.initialized,
            branch: repo.branch.clone(),
            ahead: repo.ahead,
            behind: repo.behind,
            status_error: repo.status_error.clone(),
            log_error: repo.log_error.clone(),
            has_changes: rows.iter().any(|r| matches!(r, GitRow::File(_))),
        })
    }

    /// `useGitCheckpoints`: newest first.
    pub fn checkpoints(&self) -> Vec<GitCheckpointRow> {
        let mut out: Vec<GitCheckpointRow> = self
            .rows()
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| match r {
                        GitRow::Checkpoint(cp) => Some(cp.clone()),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        out
    }

    /// The workspace folder is gone or unreadable: what TS's error boundary
    /// shows instead of the panel.
    pub fn access_error(&self) -> Option<FsError> {
        self.inner.access_error.borrow().clone()
    }

    /// When the rows last landed (epoch ms), `None` before the first
    /// fetch: the debug panel's `gitStatus.updatedAt`.
    pub fn updated_at(&self) -> Option<i64> {
        self.inner.updated_at.get()
    }

    /// `useGitFetching`: a fetch is in flight (the panel's anti-flicker gate).
    pub fn is_fetching(&self) -> bool {
        self.inner.in_flight.get() > 0
    }

    /// Called when rows land and when a fetch starts or ends. Subscribing
    /// starts the rows' sync, as a live query does.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        let sub = self.inner.changed.subscribe(move |_| listener());
        if !self.inner.active.replace(true) && self.rows().is_none() && !self.is_fetching() {
            self.spawn_refetch();
        }
        sub
    }

    /// Load the rows once (or again, if stale); `collection.preload()`.
    pub fn preload(&self) -> LocalBoxFuture<'static, ()> {
        self.inner.active.set(true);
        if self.rows().is_none() || self.inner.stale.get() {
            self.refetch()
        } else {
            futures::future::ready(()).boxed_local()
        }
    }

    /// Refetch status and checkpoints in one pass.
    pub fn refetch(&self) -> LocalBoxFuture<'static, ()> {
        let inner = self.inner.clone();
        if inner.disposed.get() {
            return futures::future::ready(()).boxed_local();
        }
        let generation = inner.generation.get() + 1;
        inner.generation.set(generation);
        inner.in_flight.set(inner.in_flight.get() + 1);
        inner.changed.emit();
        let workspace_path = inner.workspace_path.clone();
        let fetch = inner.history.run(move |repo| Ok(fetch_git_rows(repo, &workspace_path)));
        async move {
            let rows = fetch.await;
            inner.in_flight.set(inner.in_flight.get() - 1);
            match rows {
                Ok(Ok(rows)) if generation == inner.generation.get() && !inner.disposed.get() => {
                    *inner.rows.borrow_mut() = Some(Rc::new(rows));
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).ok();
                    inner.updated_at.set(now);
                    inner.access_error.borrow_mut().take();
                    inner.stale.set(false);
                }
                Ok(Err(access)) if generation == inner.generation.get() && !inner.disposed.get() => {
                    *inner.access_error.borrow_mut() = Some(access);
                }
                Ok(_) => {}
                // The history closed under us: nothing to show.
                Err(err) => log::debug!("[git] fetch skipped: {err}"),
            }
            inner.changed.emit();
        }
        .boxed_local()
    }

    fn spawn_refetch(&self) {
        let fetch = self.refetch();
        self.inner.history.executor().spawn(fetch);
    }

    /// Mark the rows stale, for a change git cannot see (a file written by
    /// the app, a commit into the hidden gitdir). Refetches if anyone reads
    /// them; otherwise the next read does.
    pub fn invalidate(&self) {
        self.inner.stale.set(true);
        if self.inner.active.get() && !self.inner.disposed.get() {
            self.spawn_refetch();
        }
    }

    /// Drop whatever fetches are in flight (`cancelQueries`).
    fn cancel(&self) {
        let inner = &self.inner;
        inner.generation.set(inner.generation.get() + 1);
    }

    /// Commit everything dirty; the new oid, or `None` if nothing changed.
    pub fn save_checkpoint(&self, description: Option<&str>) -> LocalBoxFuture<'static, Result<Option<String>, HistoryError>> {
        // Cancel any in-flight fetch so a stale pre-commit response can't
        // land after the commit's own refetch.
        self.cancel();
        let message = description
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .unwrap_or("Commit")
            .to_string();
        let commit = self.inner.history.run(move |repo| repo.checkpoint(&message, &author()));
        let this = self.clone();
        async move {
            let result = commit.await;
            // Refetch even on failure — a partial add may have changed status.
            this.refetch().await;
            result
        }
        .boxed_local()
    }

    /// Revert to a checkpoint, committing local changes first (a WIP
    /// commit) so nothing is lost.
    pub fn revert_to(&self, oid: &str, hash: &str) -> LocalBoxFuture<'static, Result<(), HistoryError>> {
        let (oid, hash) = (oid.to_string(), hash.to_string());
        let revert = self.inner.history.run(move |repo| {
            let status = repo.status()?;
            if status.has_changes() {
                repo.checkpoint(&format!("WIP before revert {hash}"), &author())?;
            }
            repo.revert_commit(&oid, Some(&format!("Revert {hash}")), &author())
        });
        let this = self.clone();
        async move {
            let result = revert.await;
            this.refetch().await;
            result.map(|_| ())
        }
        .boxed_local()
    }

    pub fn abort_revert(&self) -> LocalBoxFuture<'static, Result<(), HistoryError>> {
        let abort = self.inner.history.run(|repo| repo.abort_revert());
        let this = self.clone();
        async move {
            abort.await?;
            this.refetch().await;
            Ok(())
        }
        .boxed_local()
    }

    /// Create the history repo, then load its rows.
    pub fn initialize(&self) -> LocalBoxFuture<'static, Result<(), HistoryError>> {
        let ready = self.inner.history.ready();
        let this = self.clone();
        async move {
            ready.await?;
            this.refetch().await;
            Ok(())
        }
        .boxed_local()
    }

    /// Drop the cached rows, so a reopen fetches afresh rather than
    /// replaying stale data or a stale error. Core calls it on close.
    pub fn dispose(&self) {
        let inner = &self.inner;
        inner.disposed.set(true);
        inner.generation.set(inner.generation.get() + 1);
        inner.rows.borrow_mut().take();
        inner.kept.borrow_mut().clear();
    }

    pub(crate) fn keep(&self, sub: Subscription) {
        self.inner.kept.borrow_mut().push(sub);
    }

    pub(crate) fn downgrade(&self) -> Weak<Inner> {
        Rc::downgrade(&self.inner)
    }

    pub(crate) fn upgrade(weak: &Weak<Inner>) -> Option<Self> {
        weak.upgrade().map(|inner| Self { inner })
    }
}

fn author() -> Signature {
    Signature::new(COMMIT_AUTHOR_NAME, COMMIT_AUTHOR_EMAIL)
}
