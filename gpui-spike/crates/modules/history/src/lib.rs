//! The per-workspace document-history repo: a port of
//! `packages/desktop/src/modules/history/`.
//!
//! A second, app-owned git repo layered over the same worktree as the
//! user's files, gitdir `<workspace>/.notefig/.git` (the repo itself is
//! `notefig-history`'s [`GixHistoryRepo`](notefig_history::GixHistoryRepo)).
//! It never touches the user's own `.git`, beyond hiding `.notefig/` in its
//! `info/exclude`.
//!
//! Each open workspace's repo is this module's workspace instance
//! (`core.workspace(ws).get::<HistoryModule>()`), built by
//! [`create_workspace_history`] from what core hands it and freed when the
//! workspace closes. It also owns one policy: a checkpoint after every
//! completed agent turn in its workspace.
//!
//! Where this diverges from TS, and why:
//! - **No git worker.** TS runs isomorphic-git in a Web Worker
//!   (`modules/git-worker`) and serves its fs back over a host channel.
//!   Here gix is native and blocking, so every repo call runs through
//!   core's `Executor::blocking`, off the main thread; `git-worker` has no
//!   crate.
//! - **The repo does its own disk I/O.** gix reads and writes the gitdir
//!   and worktree itself, so the excludes (`HISTORY_EXCLUDE_LINES`, and
//!   `.notefig/` in the user's repo) are written by
//!   `HistoryRepo::ensure_init`, not through the platform fs. A web build
//!   would hand [`HistoryDeps::repo`] a repo over its own storage.
//! - **`git:stale` is declared by files** (`notefig_files::GitStale`), not
//!   by git as in TS: git needs history, so history cannot name a hook git
//!   declares (crates can't cycle), and files announces it too. History's
//!   checkpoints emit that one declaration.

mod history;
mod tools;

pub use tools::HistoryToolsModule;
pub use history::{HistoryDeps, WorkspaceHistory, create_workspace_history, history_git_dir};

use std::rc::Rc;
use std::sync::Arc;

use notefig_agents::agent_events::AgentTurnCompleted;
use notefig_core::{Module, ModuleContext, WorkspacePart};
use notefig_history::{GixHistoryRepo, Signature};

/// `historyModule`. The history repo lives as long as its workspace is
/// open: closing the workspace drops the repo. Agents need it, so their
/// tasks are disposed first — cancelling a turn can still checkpoint here.
pub struct HistoryModule;

impl Module for HistoryModule {
    const NAME: &'static str = "history";
    type Api = ();
    type Workspace = WorkspaceHistory;

    fn register(_: &ModuleContext) {}

    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(
            WorkspacePart::new(|ctx, _| {
                let path = history::normalize(&ctx.workspace().path);
                let history = create_workspace_history(HistoryDeps {
                    repo: Arc::new(GixHistoryRepo::new(&path)),
                    workspace_path: path,
                    executor: ctx.executor(),
                    hooks: ctx.hooks().clone(),
                });
                // One checkpoint per completed agent turn here, best-effort:
                // history is a convenience, never a turn's failure.
                let own_key = ctx.workspace().key.clone();
                let module_ctx: ModuleContext = (**ctx).clone();
                let weak = history.downgrade();
                let sub = ctx.hooks().on::<AgentTurnCompleted, _>(move |turn| {
                    if module_ctx.workspace_handle(&turn.workspace_path).key() != own_key {
                        return;
                    }
                    let Some(history) = WorkspaceHistory::upgrade(&weak) else { return };
                    let checkpoint = history.checkpoint(
                        &notefig_history::checkpoint_message(&turn.prompt),
                        Signature::harness(&turn.harness_id),
                    );
                    module_ctx.executor().spawn(Box::pin(async move {
                        if let Err(err) = checkpoint.await {
                            log::warn!("[history] turn checkpoint failed: {err}");
                        }
                    }));
                });
                history.keep(sub);
                Ok(history)
            })
            .dispose(|history: Rc<WorkspaceHistory>, _, _| {
                history.dispose();
                Box::pin(async { Ok(()) })
            }),
        )
    }
}

#[cfg(test)]
mod tests;
