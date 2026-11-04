//! A workspace's checkpoint timeline: a port of
//! `packages/desktop/src/modules/git/`.
//!
//! Everything git-derived, as rows (`git.ts`'s one collection):
//! - [`GitRepoRow`] (one): branch, ahead/behind, initialized, and
//!   errors-as-data — a failed status or log lands on this row instead of
//!   failing, so the panel's state derives from rows;
//! - [`GitFileRow`] (one per changed path, absolute);
//! - [`GitCheckpointRow`] (one per commit).
//!
//! Every row derives from the app's history repo (`<ws>/.notefig/.git`,
//! through the history module), never from a `.git` the user keeps in the
//! same workspace.
//!
//! **No git worker.** TS runs isomorphic-git in a worker
//! (`modules/git-worker`), so the status walk and packfile parsing stay off
//! the main thread. Here the repo is gix, which is blocking, and every
//! call runs through core's `Executor::blocking` (`WorkspaceHistory::run`);
//! `git-worker` therefore has no crate.
//!
//! **No query client.** TS keeps the rows in a TanStack query collection.
//! Here [`WorkspaceGit`] keeps them itself: `subscribe` + getters (the
//! `useSyncExternalStore` shape), `refetch` and `invalidate` as the query's,
//! and the save race (`git-save-race.test.ts`) closed by a fetch generation:
//! only the newest fetch's rows land, and a save cancels the fetches in
//! flight before it commits, as `cancelQueries` does.
//!
//! `"git:stale"` is `notefig_files::GitStale`: files declares it, and it
//! and history announce it (git needs history, so it can't be git's).

mod git;

pub use git::{
    COMMIT_AUTHOR_EMAIL, COMMIT_AUTHOR_NAME, GitCheckpointRow, GitDeps, GitFileRow, GitRepoRow,
    GitRow, GitSummary, SyncState, WorkspaceGit, create_workspace_git, derive_sync_state,
    fetch_git_rows,
};

use std::rc::Rc;

use notefig_core::{Module, ModuleContext, ModuleRef, WorkspacePart};
use notefig_files::GitStale;
use notefig_history_module::HistoryModule;

/// `gitModule`.
pub struct GitModule;

impl Module for GitModule {
    const NAME: &'static str = "git";
    type Api = ();
    type Workspace = WorkspaceGit;

    fn register(_: &ModuleContext) {}

    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(
            WorkspacePart::new(|ctx, _| {
                let git = create_workspace_git(GitDeps {
                    workspace_path: ctx.workspace().path.clone(),
                    history: ctx.use_workspace::<HistoryModule>(),
                });
                let own_key = ctx.workspace().key.clone();
                let module_ctx: ModuleContext = (**ctx).clone();
                let weak = git.downgrade();
                let sub = ctx.hooks().on::<GitStale, _>(move |event| {
                    if module_ctx.workspace_handle(&event.workspace_path).key() == own_key
                        && let Some(git) = WorkspaceGit::upgrade(&weak)
                    {
                        git.invalidate();
                    }
                });
                git.keep(sub);
                Ok(git)
            })
            .needs(vec![ModuleRef::of::<HistoryModule>()])
            .dispose(|git: Rc<WorkspaceGit>, _, _| {
                git.dispose();
                Box::pin(async { Ok(()) })
            }),
        )
    }
}

#[cfg(test)]
mod tests;
