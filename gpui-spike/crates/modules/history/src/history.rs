use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::sync::Arc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_core::{Executor, ExecutorExt, Hooks, Subscription};
use notefig_history::{HistoryError, HistoryErrorCode, HistoryRepo, Signature};

use notefig_files::{GitStale, WorkspaceEvent as GitStaleEvent};

/// `<workspace>/.notefig/.git` (`historyGitDir`).
pub fn history_git_dir(workspace_path: &str) -> PathBuf {
    notefig_history::history_git_dir(Path::new(&normalize(workspace_path)))
}

/// A workspace path without trailing separators (`pathutil.normalize`).
pub(crate) fn normalize(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() { path.to_string() } else { trimmed.to_string() }
}

/// What a workspace's history repo is built from.
pub struct HistoryDeps {
    pub workspace_path: String,
    /// The repo itself: `GixHistoryRepo` in the app, a fake or a temp-dir
    /// repo in tests. (TS: the git worker's service for the gitdir.)
    pub repo: Arc<dyn HistoryRepo>,
    /// Where blocking repo calls run (`Executor::blocking`).
    pub executor: Rc<dyn Executor>,
    /// Where a checkpoint announces `git:stale`: the commit lands in the
    /// hidden gitdir, which no watcher sees.
    pub hooks: Hooks,
}

type Init = Shared<LocalBoxFuture<'static, Result<(), HistoryError>>>;

pub(crate) struct Inner {
    workspace_path: String,
    repo: RefCell<Option<Arc<dyn HistoryRepo>>>,
    initializing: RefCell<Option<Init>>,
    disposed: Cell<bool>,
    executor: Rc<dyn Executor>,
    hooks: Hooks,
    /// What the module keeps alive with the instance (the turn listener).
    kept: RefCell<Vec<Subscription>>,
}

/// One workspace's history repo — `core.workspace(ws).get::<HistoryModule>()`.
#[derive(Clone)]
pub struct WorkspaceHistory {
    inner: Rc<Inner>,
}

pub fn create_workspace_history(deps: HistoryDeps) -> WorkspaceHistory {
    WorkspaceHistory {
        inner: Rc::new(Inner {
            workspace_path: normalize(&deps.workspace_path),
            repo: RefCell::new(Some(deps.repo)),
            initializing: RefCell::new(None),
            disposed: Cell::new(false),
            executor: deps.executor,
            hooks: deps.hooks,
            kept: RefCell::default(),
        }),
    }
}

fn closed(workspace_path: &str) -> HistoryError {
    HistoryError::new(
        HistoryErrorCode::Unknown,
        format!("The history of '{workspace_path}' is closed"),
    )
}

impl WorkspaceHistory {
    pub fn workspace_path(&self) -> &str {
        &self.inner.workspace_path
    }

    /// The repo as it is: not created if it does not exist yet (its status
    /// then fails with `RepoNotFound`, which is how "uninitialized" reads).
    /// Blocking: call it through [`Self::executor`]'s `blocking`.
    pub fn service(&self) -> Result<Arc<dyn HistoryRepo>, HistoryError> {
        if self.inner.disposed.get() {
            return Err(closed(&self.inner.workspace_path));
        }
        self.inner
            .repo
            .borrow()
            .clone()
            .ok_or_else(|| closed(&self.inner.workspace_path))
    }

    /// Where the repo's blocking calls run.
    pub fn executor(&self) -> Rc<dyn Executor> {
        self.inner.executor.clone()
    }

    /// Run one blocking call on the repo as it is, off the main thread.
    pub fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&dyn HistoryRepo) -> Result<T, HistoryError> + Send + 'static,
    ) -> LocalBoxFuture<'static, Result<T, HistoryError>> {
        let repo = match self.service() {
            Ok(repo) => repo,
            Err(err) => return futures::future::ready(Err(err)).boxed_local(),
        };
        self.inner.executor.blocking(move || work(&*repo))
    }

    /// The repo, initialized on first use (control files, both excludes).
    /// Calls while one is running join it; a later call runs it again, so a
    /// user repo created after history exists gets its exclude next time.
    pub fn ready(&self) -> LocalBoxFuture<'static, Result<Arc<dyn HistoryRepo>, HistoryError>> {
        let init = {
            let mut slot = self.inner.initializing.borrow_mut();
            match slot.as_ref() {
                Some(init) => init.clone(),
                None => {
                    let init = self.run(|repo| repo.ensure_init()).boxed_local().shared();
                    *slot = Some(init.clone());
                    init
                }
            }
        };
        let this = self.clone();
        async move {
            let result = init.clone().await;
            // Only the run that started it clears the slot (`finally`).
            {
                let mut slot = this.inner.initializing.borrow_mut();
                if slot.as_ref().is_some_and(|s| s.ptr_eq(&init)) {
                    *slot = None;
                }
            }
            result?;
            this.service()
        }
        .boxed_local()
    }

    /// A file's text at a checkpoint (`relative_path` from the root).
    pub fn read(&self, rev: &str, relative_path: &str) -> LocalBoxFuture<'static, Result<String, HistoryError>> {
        let ready = self.ready();
        let executor = self.inner.executor.clone();
        let (rev, path) = (rev.to_string(), relative_path.to_string());
        async move {
            let repo = ready.await?;
            executor.blocking(move || repo.read_text(&rev, &path)).await
        }
        .boxed_local()
    }

    /// Commit everything dirty; the new oid, or `None` if nothing changed.
    /// Announces `git:stale` either way.
    pub fn checkpoint(&self, message: &str, author: Signature) -> LocalBoxFuture<'static, Result<Option<String>, HistoryError>> {
        let ready = self.ready();
        let executor = self.inner.executor.clone();
        let hooks = self.inner.hooks.clone();
        let workspace_path = self.inner.workspace_path.clone();
        let message = message.to_string();
        async move {
            let repo = ready.await?;
            let oid = executor.blocking(move || repo.checkpoint(&message, &author)).await?;
            hooks.emit::<GitStale>(GitStaleEvent { workspace_path });
            Ok(oid)
        }
        .boxed_local()
    }

    /// Drop the repo. The history is closed for good: later calls (and a
    /// `ready` still waiting) fail rather than recreate a repo nothing
    /// would dispose.
    pub fn dispose(&self) {
        self.inner.disposed.set(true);
        self.inner.repo.borrow_mut().take();
        self.inner.initializing.borrow_mut().take();
        self.inner.kept.borrow_mut().clear();
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
