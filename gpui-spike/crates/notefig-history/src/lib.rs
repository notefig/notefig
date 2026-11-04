//! Notefig's document history: a hidden, app-owned git repo per workspace
//! (gitdir `<ws>/.notefig/.git`, worktree = the workspace) used as a
//! checkpoint timeline. It never reads, stages or commits to the user's own
//! `<ws>/.git`; the one thing it writes there is the line `.notefig/` in
//! `<ws>/.git/info/exclude`.
//!
//! - [`HistoryRepo`] is the seam the app talks to (one per workspace,
//!   `Send + Sync`, blocking: run it on a background executor).
//! - [`GixHistoryRepo`] is the real implementation (pure-Rust `gix`), in the
//!   same on-disk format isomorphic-git wrote, so existing users' repos open.
//! - [`FakeHistoryRepo`] is an in-memory stand-in for UI/app tests.
//! - [`tools`] holds the MCP tool semantics (`history_log`, `history_diff`,
//!   `history_checkpoint`, `history_restore`) returning the same JSON/text
//!   the TS tools return.

mod error;
mod exclude;
mod fake;
mod gix_repo;
pub mod tools;

use std::path::{Path, PathBuf};

pub use error::{HistoryError, HistoryErrorCode, Result};
pub use exclude::ensure_exclude_lines;
pub use fake::FakeHistoryRepo;
pub use gix_repo::GixHistoryRepo;

/// The app's own directory inside a workspace.
pub const APP_DIR_NAME: &str = ".notefig";
/// Scratchpads live here and, alone of the app dir, are versioned.
pub const SCRATCHPADS_REL_PATH: &str = ".notefig/scratchpads";
/// The history repo's default branch.
pub const DEFAULT_BRANCH: &str = "main";

/// The history repo's own `info/exclude` lines (`HISTORY_EXCLUDE_LINES` in
/// history.ts): everything under the app dir except the scratchpads, plus
/// the user's gitdir. `dir/*` + `!dir/child` is the one idiom that
/// re-includes inside an otherwise-excluded directory.
pub const HISTORY_EXCLUDE_LINES: [&str; 3] = [".notefig/*", "!.notefig/scratchpads", ".git/"];
/// The line hiding the app dir from the user's own repo.
pub const USER_REPO_EXCLUDE_LINE: &str = ".notefig/";

/// The gitdir of a workspace's history repo.
pub fn history_git_dir(workspace: &Path) -> PathBuf {
    workspace.join(APP_DIR_NAME).join(".git")
}

/// A commit identity (time is always "now" when committing).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signature {
    pub name: String,
    pub email: String,
}

impl Signature {
    pub fn new(name: impl Into<String>, email: impl Into<String>) -> Self {
        Self { name: name.into(), email: email.into() }
    }
    /// The checkpoint panel's identity (`COMMIT_AUTHOR` in git.ts).
    pub fn panel() -> Self {
        Self::new("Notefig", "git@notefig.com")
    }
    /// A turn checkpoint's identity: the harness id.
    pub fn harness(harness_id: &str) -> Self {
        Self::new(harness_id, "agent@notefig.local")
    }
    /// The `history_checkpoint` tool's identity.
    pub fn agent_tool() -> Self {
        Self::new("agent", "agent@notefig.local")
    }
}

/// A turn checkpoint's message from the prompt that led to it
/// (`checkpointMessage` in history.ts): at most 72 chars.
pub fn checkpoint_message(prompt: &str) -> String {
    if prompt.chars().count() > 72 {
        let head: String = prompt.chars().take(69).collect();
        format!("{head}…")
    } else {
        prompt.to_string()
    }
}

/// How a file differs between two sides (isomorphic-git's `GitFileChange`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FileChange {
    /// Repo-relative, `/`-separated.
    pub path: String,
    #[serde(rename = "type")]
    pub kind: ChangeKind,
}

/// The history repo's status (`RepoStatus` in types.ts). Paths are
/// repo-relative and `/`-separated, sorted.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    /// Branch name, or `"HEAD"` when detached.
    pub current_branch: String,
    /// Index differs from HEAD.
    pub staged: Vec<FileChange>,
    /// Worktree differs from the index.
    pub unstaged: Vec<FileChange>,
    /// Not in HEAD nor the index, and not ignored.
    pub untracked: Vec<String>,
    /// isomorphic-git's "stage differs from both HEAD and worktree" (its
    /// status 3), which the TS service reports as conflicts. Kept for parity;
    /// the history repo never has real merge conflicts.
    pub conflicts: Vec<String>,
}

impl RepoStatus {
    /// Anything a checkpoint would commit (the panel's `hasChanges`).
    pub fn has_changes(&self) -> bool {
        !self.staged.is_empty() || !self.unstaged.is_empty() || !self.untracked.is_empty()
    }
}

/// One commit of the history (newest first in [`HistoryRepo::log`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    /// Full 40-hex oid.
    pub oid: String,
    /// Full raw commit message.
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time, seconds since the epoch.
    pub author_time: i64,
    /// Committer time, seconds since the epoch.
    pub committer_time: i64,
}

impl Checkpoint {
    /// The 7-char short hash the panel shows.
    pub fn hash(&self) -> &str {
        &self.oid[..self.oid.len().min(7)]
    }
    /// The panel row's label: first line of the message, or "Commit".
    pub fn summary(&self) -> &str {
        let first = self.message.lines().next().unwrap_or("").trim();
        if first.is_empty() { "Commit" } else { first }
    }
}

/// A document's content at two checkpoints (`history_diff`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileVersions {
    pub from_content: String,
    pub to_content: String,
}

/// One workspace's history repo. Blocking; implementations serialize their
/// own writes. Paths are workspace-relative and `/`-separated.
pub trait HistoryRepo: Send + Sync {
    /// The workspace (the repo's worktree).
    fn workspace_path(&self) -> &Path;

    /// Whether the gitdir has its `HEAD` and `config` (the panel's
    /// `initialized`; `status` fails with `RepoNotFound` otherwise).
    fn is_initialized(&self) -> bool;

    /// Create or repair the repo (control files, default branch `main`), make
    /// sure its `info/exclude` has [`HISTORY_EXCLUDE_LINES`], and, if the
    /// workspace has its own `.git/` dir, that its `info/exclude` hides
    /// `.notefig/`. Idempotent; this is `history.ready()`.
    fn ensure_init(&self) -> Result<()>;

    /// Changed files. `RepoNotFound` when not initialized.
    fn status(&self) -> Result<RepoStatus>;

    /// Commits reachable from HEAD, newest first. `path` keeps only commits
    /// whose blob at `path` differs from their first parent's; `depth` caps
    /// the result after filtering. Unborn HEAD → empty.
    fn log(&self, depth: Option<usize>, path: Option<&str>) -> Result<Vec<Checkpoint>>;

    /// Stage everything dirty (adds, modifications, deletions) and commit.
    /// `None` when there was nothing to commit. Does not initialize the repo.
    fn checkpoint(&self, message: &str, author: &Signature) -> Result<Option<String>>;

    /// `git revert <oid>` with a whole-file conflict rule: for every path the
    /// commit changed, HEAD's blob must equal the commit's or its parent's,
    /// else `MergeRequired` (nothing touched). Restores parent content in
    /// the worktree + index and commits `message` (default
    /// `Revert <hash7>`). `None` when the revert changes nothing.
    fn revert_commit(&self, oid: &str, message: Option<&str>, author: &Signature) -> Result<Option<String>>;

    /// Force the whole worktree (tracked files) and index back to HEAD,
    /// discarding uncommitted changes. Untracked files are kept.
    fn abort_revert(&self) -> Result<()>;

    /// A file's text at a revision (oid, short oid, `HEAD`, branch...), UTF-8
    /// lossy.
    fn read_text(&self, rev: &str, path: &str) -> Result<String>;

    /// The panel's "Restore commit" (`WorkspaceGit.revertTo`): WIP-commit
    /// local changes first so nothing is lost, then revert `oid`.
    fn revert_to(&self, oid: &str, author: &Signature) -> Result<Option<String>> {
        let hash = &oid[..oid.len().min(7)];
        if self.status()?.has_changes() {
            self.checkpoint(&format!("WIP before revert {hash}"), author)?;
        }
        self.revert_commit(oid, Some(&format!("Revert {hash}")), author)
    }

    /// Both sides of a file for `history_diff`.
    fn file_versions(&self, path: &str, from: &str, to: &str) -> Result<FileVersions> {
        Ok(FileVersions { from_content: self.read_text(from, path)?, to_content: self.read_text(to, path)? })
    }
}
