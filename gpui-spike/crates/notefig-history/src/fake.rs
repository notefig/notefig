//! An in-memory [`HistoryRepo`] for app/UI tests: a worktree of text files
//! and a linear list of snapshot commits. No staging area: every change is
//! "unstaged" until a checkpoint commits it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::{
    ChangeKind, Checkpoint, DEFAULT_BRANCH, FileChange, HistoryError, HistoryErrorCode, HistoryRepo, RepoStatus,
    Result, Signature,
};

type Tree = BTreeMap<String, String>;

#[derive(Debug, Clone)]
struct FakeCommit {
    oid: String,
    parent: Option<usize>,
    message: String,
    author: Signature,
    time: i64,
    tree: Tree,
}

#[derive(Debug, Default)]
struct FakeState {
    initialized: bool,
    files: Tree,
    commits: Vec<FakeCommit>,
    head: Option<usize>,
    clock: i64,
    next_error: Option<HistoryError>,
}

pub struct FakeHistoryRepo {
    workspace: PathBuf,
    state: Mutex<FakeState>,
}

impl FakeHistoryRepo {
    /// An uninitialized fake (status fails with `RepoNotFound`).
    pub fn new(workspace: impl Into<PathBuf>) -> Self {
        Self { workspace: workspace.into(), state: Mutex::new(FakeState { clock: 1_700_000_000, ..Default::default() }) }
    }

    /// An initialized, empty fake.
    pub fn initialized(workspace: impl Into<PathBuf>) -> Self {
        let repo = Self::new(workspace);
        repo.state().initialized = true;
        repo
    }

    fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn write_file(&self, path: &str, content: &str) {
        self.state().files.insert(path.to_string(), content.to_string());
    }
    pub fn remove_file(&self, path: &str) {
        self.state().files.remove(path);
    }
    pub fn file(&self, path: &str) -> Option<String> {
        self.state().files.get(path).cloned()
    }
    /// Make the next fallible call fail with `error`.
    pub fn fail_next(&self, error: HistoryError) {
        self.state().next_error = Some(error);
    }

    fn take_error(state: &mut FakeState) -> Result<()> {
        match state.next_error.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn ready(state: &mut FakeState) -> Result<()> {
        Self::take_error(state)?;
        if !state.initialized {
            return Err(HistoryError::not_found("Could not find HEAD."));
        }
        Ok(())
    }

    fn head_tree(state: &FakeState) -> Tree {
        state.head.map(|i| state.commits[i].tree.clone()).unwrap_or_default()
    }

    fn find(state: &FakeState, rev: &str) -> Result<usize> {
        if rev == "HEAD" || rev == DEFAULT_BRANCH {
            return state.head.ok_or_else(|| HistoryError::not_found(format!("Could not find {rev}.")));
        }
        let matches: Vec<usize> = (0..state.commits.len()).filter(|&i| state.commits[i].oid.starts_with(rev)).collect();
        match matches.as_slice() {
            [one] if rev.len() >= 4 => Ok(*one),
            _ => Err(HistoryError::not_found(format!("Could not find {rev}."))),
        }
    }

    fn commit(state: &mut FakeState, tree: Tree, message: &str, author: &Signature) -> String {
        state.clock += 1;
        let seed = format!("{}{}{:?}{}", state.commits.len(), message, tree, state.clock);
        let mut hash: u64 = 0xcbf29ce484222325;
        for byte in seed.bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
        }
        let oid = format!("{hash:016x}{:024x}", state.commits.len());
        state.commits.push(FakeCommit {
            oid: oid.clone(),
            parent: state.head,
            message: format!("{message}\n"),
            author: author.clone(),
            time: state.clock,
            tree,
        });
        state.head = Some(state.commits.len() - 1);
        oid
    }
}

impl HistoryRepo for FakeHistoryRepo {
    fn workspace_path(&self) -> &Path {
        &self.workspace
    }

    fn is_initialized(&self) -> bool {
        self.state().initialized
    }

    fn ensure_init(&self) -> Result<()> {
        let mut state = self.state();
        Self::take_error(&mut state)?;
        state.initialized = true;
        Ok(())
    }

    fn status(&self) -> Result<RepoStatus> {
        let mut state = self.state();
        Self::ready(&mut state)?;
        let head = Self::head_tree(&state);
        let mut status = RepoStatus { current_branch: DEFAULT_BRANCH.into(), ..Default::default() };
        for (path, content) in &head {
            match state.files.get(path) {
                None => status.unstaged.push(FileChange { path: path.clone(), kind: ChangeKind::Deleted }),
                Some(now) if now != content => {
                    status.unstaged.push(FileChange { path: path.clone(), kind: ChangeKind::Modified })
                }
                _ => {}
            }
        }
        status.untracked = state.files.keys().filter(|p| !head.contains_key(*p)).cloned().collect();
        Ok(status)
    }

    fn log(&self, depth: Option<usize>, path: Option<&str>) -> Result<Vec<Checkpoint>> {
        let mut state = self.state();
        Self::ready(&mut state)?;
        let mut out = Vec::new();
        let mut cursor = state.head;
        while let Some(i) = cursor {
            if out.len() >= depth.unwrap_or(usize::MAX) {
                break;
            }
            let commit = &state.commits[i];
            let keep = match path {
                None => true,
                Some(path) => {
                    let parent = commit.parent.and_then(|p| state.commits[p].tree.get(path));
                    commit.tree.get(path) != parent
                }
            };
            if keep {
                out.push(Checkpoint {
                    oid: commit.oid.clone(),
                    message: commit.message.clone(),
                    author_name: commit.author.name.clone(),
                    author_email: commit.author.email.clone(),
                    author_time: commit.time,
                    committer_time: commit.time,
                });
            }
            cursor = commit.parent;
        }
        Ok(out)
    }

    fn checkpoint(&self, message: &str, author: &Signature) -> Result<Option<String>> {
        if message.trim().is_empty() {
            return Err(HistoryError::invalid("Commit message cannot be empty."));
        }
        let mut state = self.state();
        Self::ready(&mut state)?;
        if state.head.is_some_and(|_| Self::head_tree(&state) == state.files)
            || (state.head.is_none() && state.files.is_empty())
        {
            return Ok(None);
        }
        let tree = state.files.clone();
        Ok(Some(Self::commit(&mut state, tree, message, author)))
    }

    fn revert_commit(&self, oid: &str, message: Option<&str>, author: &Signature) -> Result<Option<String>> {
        let mut state = self.state();
        Self::ready(&mut state)?;
        let target = Self::find(&state, oid)?;
        let parent = state.commits[target]
            .parent
            .ok_or_else(|| HistoryError::invalid("Cannot revert the initial commit."))?;
        let parent_tree = state.commits[parent].tree.clone();
        let commit_tree = state.commits[target].tree.clone();
        let mut next = Self::head_tree(&state);
        let paths: BTreeSet<&String> = parent_tree.keys().chain(commit_tree.keys()).collect();
        let mut changed = Vec::new();
        for path in paths {
            let (p, c, h) = (parent_tree.get(path), commit_tree.get(path), next.get(path));
            if p == c {
                continue;
            }
            if h.is_some() && h != c && h != p {
                return Err(HistoryError::new(HistoryErrorCode::MergeRequired, "Revert would conflict with current changes."));
            }
            changed.push((path.clone(), p.cloned(), h.is_some()));
        }
        for (path, parent_content, in_head) in &changed {
            match parent_content {
                None if *in_head => {
                    next.remove(path);
                    state.files.remove(path);
                }
                None => {}
                Some(content) => {
                    next.insert(path.clone(), content.clone());
                    state.files.insert(path.clone(), content.clone());
                }
            }
        }
        if next == Self::head_tree(&state) {
            return Ok(None);
        }
        let default_message = format!("Revert {}", &oid[..oid.len().min(7)]);
        Ok(Some(Self::commit(&mut state, next, message.unwrap_or(&default_message), author)))
    }

    fn abort_revert(&self) -> Result<()> {
        let mut state = self.state();
        Self::ready(&mut state)?;
        let head = Self::head_tree(&state);
        for (path, content) in head {
            state.files.insert(path, content);
        }
        Ok(())
    }

    fn read_text(&self, rev: &str, path: &str) -> Result<String> {
        let mut state = self.state();
        Self::ready(&mut state)?;
        let i = Self::find(&state, rev)?;
        state.commits[i].tree.get(path).cloned().ok_or_else(|| {
            HistoryError::not_found(format!("Could not find file or directory found at \"{rev}:{path}\"."))
        })
    }
}
