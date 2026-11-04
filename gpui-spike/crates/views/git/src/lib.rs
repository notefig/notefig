//! The sidebar's Git tab: a port of
//! `packages/desktop/src/components/editor/git/checkpoint-panel.tsx`.
//!
//! [`GitPanel`] reads the workspace's `notefig_git::WorkspaceGit` (the
//! `useGitSummary` / `useGitCheckpoints` / `useGitFetching` hooks become
//! its getters plus `notefig_ui::observe`) and runs the panel's actions
//! through it: commit (quick, or with a description), initialize or repair
//! the history, retry, restore a checkpoint (with the WIP commit first),
//! and abort a conflicting revert.
//!
//! As in TS, the panel shows no per-file diffs, branch name or grouping:
//! `checkpoint-panel.tsx` has none (the branch is always `main` of the
//! hidden history repo; the chip shows the sync state instead).

mod panel;
mod state;

pub use panel::GitPanel;

/// The panel has no actions or key bindings of its own.
pub fn init(_cx: &mut gpui::App) {}
