//! The real [`HistoryRepo`]: gix over the hidden gitdir.
//!
//! gix is used for what it does well (object database, refs, rev-parse,
//! index file encoding with real lock files); the porcelain the TS service
//! got from isomorphic-git (status matrix, add-all, checkout of paths,
//! single-commit revert) is small and hand-written here, over a
//! path → entry map of the index. The worktree walk honours the
//! workspace's `.gitignore`s plus this gitdir's `info/exclude` (never the
//! user's `.git/info/exclude`, never global excludes), and always skips
//! directories named `.git`, like git.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use gix::ObjectId;
use gix::bstr::ByteSlice as _;
use gix::index::entry::{Flags, Mode, Stat};
use gix::objs::tree::EntryKind;

use crate::{
    ChangeKind, Checkpoint, DEFAULT_BRANCH, FileChange, HISTORY_EXCLUDE_LINES, HistoryError, HistoryErrorCode,
    HistoryRepo, RepoStatus, Result, Signature, USER_REPO_EXCLUDE_LINE, ensure_exclude_lines, history_git_dir,
};

const HASH: gix::hash::Kind = gix::hash::Kind::Sha1;

/// gix/io error → [`HistoryError`] with context.
trait Ctx<T> {
    fn ctx(self, what: &str) -> Result<T>;
}
impl<T, E: std::fmt::Display> Ctx<T> for std::result::Result<T, E> {
    fn ctx(self, what: &str) -> Result<T> {
        self.map_err(|e| HistoryError::git(what, e))
    }
}

/// Write `bytes` to `path` via a same-directory temp file + rename, so a
/// concurrent reader (an editor's watcher, system git) never sees a torn file.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let tmp = dir.join(format!(".{name}.tmp-{}-{nanos}", std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[derive(Debug, Clone)]
struct IndexEntry {
    oid: ObjectId,
    stat: Stat,
    mode: Mode,
}

/// Stage-0 index entries by `/`-separated path.
type IndexMap = BTreeMap<String, IndexEntry>;
/// A tree flattened to its files: path → (blob oid, mode).
type TreeFiles = BTreeMap<String, (ObjectId, EntryKind)>;

/// Everything one status pass computed, reused by the writers.
struct Snapshot {
    head: Option<ObjectId>,
    index: IndexMap,
    status: RepoStatus,
}

/// A workspace's history repo on disk, through gix.
pub struct GixHistoryRepo {
    workspace: PathBuf,
    git_dir: PathBuf,
    /// Serializes this process's writers (checkpoint, revert, abort, init);
    /// other processes are kept out by git's own lock files.
    write_lock: Mutex<()>,
}

impl GixHistoryRepo {
    /// The history repo of `workspace` (gitdir `<ws>/.notefig/.git`).
    pub fn new(workspace: impl Into<PathBuf>) -> Self {
        let workspace = workspace.into();
        let git_dir = history_git_dir(&workspace);
        Self::with_git_dir(workspace, git_dir)
    }

    /// Any gitdir over `workspace` as worktree (tests use `<ws>/.git`).
    pub fn with_git_dir(workspace: impl Into<PathBuf>, git_dir: impl Into<PathBuf>) -> Self {
        Self { workspace: workspace.into(), git_dir: git_dir.into(), write_lock: Mutex::new(()) }
    }

    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.write_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn open(&self) -> Result<gix::Repository> {
        if !self.is_initialized() {
            return Err(HistoryError::not_found(format!(
                "Could not find HEAD in the history repo at '{}'",
                self.git_dir.display()
            )));
        }
        // Isolated: only the repo's own config, no system/global config or
        // environment — the history repo must not change with the user's git
        // setup. `open_path_as_is`: the gitdir is the path we were given.
        let options = gix::open::Options::isolated().open_path_as_is(true);
        gix::open_opts(&self.git_dir, options).ctx("Failed to open the history repo")
    }

    fn abs(&self, rel: &str) -> PathBuf {
        let mut path = self.workspace.clone();
        for part in rel.split('/').filter(|p| !p.is_empty()) {
            path.push(part);
        }
        path
    }

    fn index_path(&self) -> PathBuf {
        self.git_dir.join("index")
    }

    fn current_branch(&self) -> String {
        match std::fs::read_to_string(self.git_dir.join("HEAD")) {
            Ok(text) => match text.trim().strip_prefix("ref: ") {
                Some(target) => target.strip_prefix("refs/heads/").unwrap_or(target).to_string(),
                None => "HEAD".to_string(),
            },
            Err(_) => "HEAD".to_string(),
        }
    }

    fn read_index(&self) -> Result<IndexMap> {
        let file = gix::index::File::at_or_default(self.index_path(), HASH, false, Default::default())
            .ctx("Failed to read the history index")?;
        let mut map = IndexMap::new();
        for entry in file.entries() {
            if entry.stage_raw() != 0 {
                continue;
            }
            let path = entry.path(&file).to_str_lossy().into_owned();
            map.insert(path, IndexEntry { oid: entry.id, stat: entry.stat, mode: entry.mode });
        }
        Ok(map)
    }

    /// Rewrite the index from `map` (no extensions: the tree cache would be
    /// stale). Takes `index.lock` like git; contention → `LockUnavailable`.
    fn write_index(&self, map: &IndexMap) -> Result<()> {
        let mut state = gix::index::State::new(HASH);
        for (path, entry) in map {
            state.dangerously_push_entry(entry.stat, entry.oid, Flags::empty(), entry.mode, path.as_bytes().as_bstr());
        }
        state.sort_entries();
        let mut file = gix::index::File::from_state(state, self.index_path());
        file.write(Default::default()).map_err(|e| {
            let mut error = HistoryError::git("Failed to write the history index", e);
            if self.index_path().with_extension("lock").exists() {
                error.code = HistoryErrorCode::LockUnavailable;
            }
            error
        })
    }

    fn index_mtime(&self) -> Option<SystemTime> {
        std::fs::metadata(self.index_path()).and_then(|m| m.modified()).ok()
    }

    /// The worktree file's blob oid, or `None` if it's missing or not a
    /// regular file. Trusts the index's oid when size and mtime match and
    /// the entry isn't racy (modified in the same second the index was
    /// written or later).
    fn worktree_oid(&self, rel: &str, indexed: Option<&IndexEntry>, index_mtime: Option<SystemTime>) -> Result<Option<ObjectId>> {
        let path = self.abs(rel);
        let Ok(meta) = gix::index::fs::Metadata::from_path_no_follow(&path) else {
            return Ok(None);
        };
        if !meta.is_file() {
            return Ok(None);
        }
        if let (Some(entry), Ok(stat)) = (indexed, Stat::from_fs(&meta)) {
            let index_secs = index_mtime
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as u32)
                .unwrap_or(0);
            if stat.size == entry.stat.size
                && stat.mtime.secs == entry.stat.mtime.secs
                && stat.mtime.nsecs == entry.stat.mtime.nsecs
                && entry.stat.mtime.secs < index_secs
            {
                return Ok(Some(entry.oid));
            }
        }
        let data = std::fs::read(&path).map_err(|e| HistoryError::io(format!("Failed to read '{rel}'"), e))?;
        Ok(Some(gix::objs::compute_hash(HASH, gix::objs::Kind::Blob, &data).ctx("Failed to hash a file")?))
    }

    fn head_id(repo: &gix::Repository) -> Result<Option<ObjectId>> {
        let head = repo.head().ctx("Failed to read HEAD")?;
        Ok(head.id().map(|id| id.detach()))
    }

    fn tree_files(repo: &gix::Repository, commit: ObjectId) -> Result<TreeFiles> {
        let commit = repo.find_commit(commit).ctx("Failed to read a commit")?;
        let tree = commit.tree().ctx("Failed to read a commit's tree")?;
        let records = tree.traverse().breadthfirst.files().ctx("Failed to walk a tree")?;
        Ok(records
            .into_iter()
            .filter(|r| !r.mode.is_tree() && !r.mode.is_commit())
            .map(|r| (r.filepath.to_str_lossy().into_owned(), (r.oid, r.mode.kind())))
            .collect())
    }

    /// Files under the workspace that git would list as untracked candidates:
    /// not ignored by a `.gitignore` or this gitdir's `info/exclude`, no
    /// `.git` dirs, no symlinks.
    fn walk_worktree(&self) -> Vec<String> {
        let mut excludes = ignore::gitignore::GitignoreBuilder::new(&self.workspace);
        let exclude_file = self.git_dir.join("info").join("exclude");
        if exclude_file.is_file() {
            let _ = excludes.add(&exclude_file);
        }
        let excludes = excludes.build().unwrap_or_else(|_| ignore::gitignore::Gitignore::empty());
        let root = self.workspace.clone();
        let walker = ignore::WalkBuilder::new(&self.workspace)
            .standard_filters(false)
            .hidden(false)
            .git_ignore(true)
            .require_git(false)
            .follow_links(false)
            .filter_entry(move |entry| {
                if entry.file_name() == ".git" {
                    return false;
                }
                let Ok(rel) = entry.path().strip_prefix(&root) else { return true };
                if rel.as_os_str().is_empty() {
                    return true;
                }
                let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
                !excludes.matched(rel, is_dir).is_ignore()
            })
            .build();
        let mut files = Vec::new();
        for entry in walker.flatten() {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if let Ok(rel) = entry.path().strip_prefix(&self.workspace) {
                let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                files.push(parts.join("/"));
            }
        }
        files
    }

    /// isomorphic-git's status matrix, classified the way the TS service
    /// does (`IsomorphicGitService.status`).
    fn snapshot(&self, repo: &gix::Repository) -> Result<Snapshot> {
        let head = Self::head_id(repo)?;
        let head_files = match head {
            Some(id) => Self::tree_files(repo, id)?,
            None => TreeFiles::new(),
        };
        let index = self.read_index()?;
        let index_mtime = self.index_mtime();
        let mut status = RepoStatus { current_branch: self.current_branch(), ..Default::default() };

        let tracked: BTreeSet<&String> = head_files.keys().chain(index.keys()).collect();
        for path in &tracked {
            let h = head_files.get(*path).map(|(oid, _)| *oid);
            let s = index.get(*path).map(|e| e.oid);
            let w = self.worktree_oid(path, index.get(*path), index_mtime)?;
            let head_code = u8::from(h.is_some());
            let work_code = match w {
                None => 0,
                Some(w) if Some(w) == h => 1,
                Some(_) => 2,
            };
            let stage_code = match s {
                None => 0,
                Some(s) if Some(s) == h => 1,
                Some(s) if Some(s) == w => 2,
                Some(_) => 3,
            };
            if stage_code != head_code {
                let kind = if head_code == 0 {
                    ChangeKind::Added
                } else if stage_code == 0 {
                    ChangeKind::Deleted
                } else {
                    ChangeKind::Modified
                };
                status.staged.push(FileChange { path: (*path).clone(), kind });
            }
            if work_code != stage_code {
                let kind = if stage_code == 0 {
                    ChangeKind::Added
                } else if work_code == 0 {
                    ChangeKind::Deleted
                } else {
                    ChangeKind::Modified
                };
                status.unstaged.push(FileChange { path: (*path).clone(), kind });
            }
            if stage_code == 3 {
                status.conflicts.push((*path).clone());
            }
        }
        let mut untracked: Vec<String> =
            self.walk_worktree().into_iter().filter(|p| !tracked.contains(&p)).collect();
        untracked.sort();
        status.untracked = untracked;
        Ok(Snapshot { head, index, status })
    }

    fn entry_for(&self, rel: &str, oid: ObjectId, mode: Mode) -> Result<IndexEntry> {
        let meta = gix::index::fs::Metadata::from_path_no_follow(&self.abs(rel))
            .map_err(|e| HistoryError::io(format!("Failed to stat '{rel}'"), e))?;
        let stat = Stat::from_fs(&meta).unwrap_or_default();
        Ok(IndexEntry { oid, stat, mode })
    }

    /// Hash `rel` into the object database and stage it.
    fn add_path(&self, repo: &gix::Repository, index: &mut IndexMap, rel: &str) -> Result<()> {
        let path = self.abs(rel);
        let data = std::fs::read(&path).map_err(|e| HistoryError::io(format!("Failed to read '{rel}'"), e))?;
        let oid = repo.write_blob(&data).ctx("Failed to write a blob")?.detach();
        let executable = gix::index::fs::Metadata::from_path_no_follow(&path).is_ok_and(|m| m.is_executable());
        let mode = if executable { Mode::FILE_EXECUTABLE } else { Mode::FILE };
        let entry = self.entry_for(rel, oid, mode)?;
        index.insert(rel.to_string(), entry);
        Ok(())
    }

    /// Write a blob's bytes to the worktree at `rel`.
    fn checkout_blob(&self, repo: &gix::Repository, rel: &str, oid: ObjectId) -> Result<()> {
        let blob = repo.find_blob(oid).ctx("Failed to read a blob")?;
        let path = self.abs(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| HistoryError::io(format!("Failed to create '{rel}'"), e))?;
        }
        if path.is_dir() {
            return Err(HistoryError::new(HistoryErrorCode::Io, format!("'{rel}' is a directory in the worktree")));
        }
        write_atomic(&path, &blob.data).map_err(|e| HistoryError::io(format!("Failed to write '{rel}'"), e))
    }

    fn remove_worktree_file(&self, rel: &str) -> Result<()> {
        match std::fs::remove_file(self.abs(rel)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(HistoryError::io(format!("Failed to delete '{rel}'"), e)),
        }
    }

    fn write_tree(repo: &gix::Repository, index: &IndexMap) -> Result<ObjectId> {
        let mut editor = repo.edit_tree(ObjectId::empty_tree(HASH)).ctx("Failed to start a tree")?;
        for (path, entry) in index {
            let kind = match entry.mode {
                Mode::FILE_EXECUTABLE => EntryKind::BlobExecutable,
                Mode::SYMLINK => EntryKind::Link,
                Mode::COMMIT => EntryKind::Commit,
                _ => EntryKind::Blob,
            };
            editor.upsert(path.as_str(), kind, entry.oid).ctx("Failed to add a tree entry")?;
        }
        Ok(editor.write().ctx("Failed to write a tree")?.detach())
    }

    fn commit_tree(
        repo: &gix::Repository,
        tree: ObjectId,
        parent: Option<ObjectId>,
        message: &str,
        author: &Signature,
    ) -> Result<String> {
        let signature = gix::actor::Signature {
            name: author.name.as_str().into(),
            email: author.email.as_str().into(),
            time: gix::date::Time::now_local_or_utc(),
        };
        let mut buf = gix::date::parse::TimeBuf::default();
        let sig = signature.to_ref(&mut buf);
        let message = if message.ends_with('\n') { message.to_string() } else { format!("{message}\n") };
        let id = repo.commit_as(sig, sig, "HEAD", message, tree, parent).ctx("Failed to commit")?;
        Ok(id.to_string())
    }

    fn head_tree(repo: &gix::Repository, head: Option<ObjectId>) -> Result<Option<ObjectId>> {
        match head {
            Some(id) => Ok(Some(
                repo.find_commit(id).ctx("Failed to read HEAD")?.tree_id().ctx("Failed to read HEAD's tree")?.detach(),
            )),
            None => Ok(None),
        }
    }

    fn resolve_commit(repo: &gix::Repository, rev: &str) -> Result<ObjectId> {
        let id = repo
            .rev_parse_single(rev)
            .map_err(|_| HistoryError::not_found(format!("Could not find {rev}.")))?;
        let commit = id
            .object()
            .ctx("Failed to read an object")?
            .peel_to_commit()
            .map_err(|_| HistoryError::invalid(format!("{rev} is not a commit")))?;
        Ok(commit.id)
    }

    fn validate_message(message: &str) -> Result<()> {
        if message.trim().is_empty() {
            return Err(HistoryError::invalid("Commit message cannot be empty."));
        }
        Ok(())
    }

    fn blob_at(repo: &gix::Repository, commit: ObjectId, path: &str) -> Result<Option<ObjectId>> {
        let tree = repo.find_commit(commit).ctx("Failed to read a commit")?.tree().ctx("Failed to read a tree")?;
        let entry = tree.lookup_entry_by_path(Path::new(path)).ctx("Failed to look up a path")?;
        Ok(entry.filter(|e| !e.mode().is_tree()).map(|e| e.object_id()))
    }

    fn checkpoint_of(commit: &gix::Commit<'_>) -> Result<Checkpoint> {
        let message = commit.message_raw().ctx("Failed to read a commit message")?.to_str_lossy().into_owned();
        let author = commit.author().ctx("Failed to read a commit author")?;
        let committer = commit.committer().ctx("Failed to read a committer")?;
        Ok(Checkpoint {
            oid: commit.id.to_string(),
            message,
            author_name: author.name.to_str_lossy().into_owned(),
            author_email: author.email.to_str_lossy().into_owned(),
            author_time: author.time().map(|t| t.seconds).unwrap_or(0),
            committer_time: committer.time().map(|t| t.seconds).unwrap_or(0),
        })
    }
}

impl HistoryRepo for GixHistoryRepo {
    fn workspace_path(&self) -> &Path {
        &self.workspace
    }

    fn is_initialized(&self) -> bool {
        self.git_dir.join("HEAD").is_file() && self.git_dir.join("config").is_file()
    }

    fn ensure_init(&self) -> Result<()> {
        let _guard = self.lock();
        let g = &self.git_dir;
        for dir in ["", "info", "hooks", "objects", "objects/info", "objects/pack", "refs", "refs/heads", "refs/tags"] {
            let path = if dir.is_empty() { g.clone() } else { g.join(dir) };
            std::fs::create_dir_all(&path)
                .map_err(|e| HistoryError::io(format!("Failed to create '{}'", path.display()), e))?;
        }
        let control: [(&str, String); 4] = [
            ("HEAD", format!("ref: refs/heads/{DEFAULT_BRANCH}\n")),
            ("config", "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\n".into()),
            ("description", "Unnamed repository; edit this file 'description' to name the repository.\n".into()),
            (
                "info/exclude",
                "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n".into(),
            ),
        ];
        for (name, content) in control {
            let path = g.join(name);
            if !path.exists() {
                write_atomic(&path, content.as_bytes())
                    .map_err(|e| HistoryError::io(format!("Failed to write '{}'", path.display()), e))?;
            }
        }
        ensure_exclude_lines(g, &HISTORY_EXCLUDE_LINES)?;
        // Hide the app dir from the user's own repo (best effort, like TS:
        // a failure here never blocks history).
        let user_git = self.workspace.join(".git");
        if user_git.is_dir() && user_git != *g {
            let _ = ensure_exclude_lines(&user_git, &[USER_REPO_EXCLUDE_LINE]);
        }
        Ok(())
    }

    fn status(&self) -> Result<RepoStatus> {
        let repo = self.open()?;
        Ok(self.snapshot(&repo)?.status)
    }

    fn log(&self, depth: Option<usize>, path: Option<&str>) -> Result<Vec<Checkpoint>> {
        let repo = self.open()?;
        let Some(head) = Self::head_id(&repo)? else { return Ok(Vec::new()) };
        let limit = depth.unwrap_or(usize::MAX);
        let mut out = Vec::new();
        let walk = repo.rev_walk([head]).all().ctx("Failed to walk history")?;
        for info in walk {
            if out.len() >= limit {
                break;
            }
            let info = info.ctx("Failed to walk history")?;
            let commit = info.object().ctx("Failed to read a commit")?;
            if let Some(path) = path {
                let here = Self::blob_at(&repo, commit.id, path)?;
                let parent = match commit.parent_ids().next() {
                    Some(parent) => Self::blob_at(&repo, parent.detach(), path)?,
                    None => None,
                };
                if here == parent {
                    continue;
                }
            }
            out.push(Self::checkpoint_of(&commit)?);
        }
        Ok(out)
    }

    fn checkpoint(&self, message: &str, author: &Signature) -> Result<Option<String>> {
        Self::validate_message(message)?;
        let _guard = self.lock();
        let repo = self.open()?;
        let snap = self.snapshot(&repo)?;
        if !snap.status.has_changes() {
            return Ok(None);
        }
        let mut index = snap.index;
        let to_add = snap
            .status
            .untracked
            .iter()
            .chain(snap.status.unstaged.iter().filter(|c| c.kind != ChangeKind::Deleted).map(|c| &c.path));
        for path in to_add {
            self.add_path(&repo, &mut index, path)?;
        }
        for change in snap.status.unstaged.iter().filter(|c| c.kind == ChangeKind::Deleted) {
            index.remove(&change.path);
        }
        self.write_index(&index)?;
        let tree = Self::write_tree(&repo, &index)?;
        if Self::head_tree(&repo, snap.head)? == Some(tree) || (snap.head.is_none() && index.is_empty()) {
            return Ok(None);
        }
        Self::commit_tree(&repo, tree, snap.head, message, author).map(Some)
    }

    fn revert_commit(&self, oid: &str, message: Option<&str>, author: &Signature) -> Result<Option<String>> {
        let _guard = self.lock();
        let repo = self.open()?;
        let target = Self::resolve_commit(&repo, oid)?;
        let parent = repo
            .find_commit(target)
            .ctx("Failed to read a commit")?
            .parent_ids()
            .next()
            .map(|id| id.detach())
            .ok_or_else(|| HistoryError::invalid("Cannot revert the initial commit."))?;
        let head = Self::head_id(&repo)?.ok_or_else(|| HistoryError::not_found("Could not find HEAD."))?;
        let parent_files = Self::tree_files(&repo, parent)?;
        let commit_files = Self::tree_files(&repo, target)?;
        let head_files = Self::tree_files(&repo, head)?;

        struct Change {
            path: String,
            parent: Option<(ObjectId, EntryKind)>,
            head: Option<ObjectId>,
        }
        let paths: BTreeSet<&String> = parent_files.keys().chain(commit_files.keys()).collect();
        let mut changes = Vec::new();
        for path in paths {
            let p = parent_files.get(path).copied();
            let c = commit_files.get(path).map(|(oid, _)| *oid);
            if p.map(|(oid, _)| oid) == c {
                continue;
            }
            let h = head_files.get(path).map(|(oid, _)| *oid);
            // Whole-file rule: HEAD must still hold the commit's or the
            // parent's version of every path the commit touched.
            if h.is_some() && h != c && h != p.map(|(oid, _)| oid) {
                return Err(HistoryError::new(
                    HistoryErrorCode::MergeRequired,
                    "Revert would conflict with current changes.",
                ));
            }
            changes.push(Change { path: path.clone(), parent: p, head: h });
        }
        if changes.is_empty() {
            return Ok(None);
        }
        let mut index = self.read_index()?;
        for change in &changes {
            match change.parent {
                // The commit added it: delete it (TS left the file on disk,
                // so the next checkpoint re-added it; git deletes it).
                None => {
                    if change.head.is_none() {
                        continue;
                    }
                    index.remove(&change.path);
                    self.remove_worktree_file(&change.path)?;
                }
                Some((blob, kind)) => {
                    self.checkout_blob(&repo, &change.path, blob)?;
                    let mode = if kind == EntryKind::BlobExecutable { Mode::FILE_EXECUTABLE } else { Mode::FILE };
                    let entry = self.entry_for(&change.path, blob, mode)?;
                    index.insert(change.path.clone(), entry);
                }
            }
        }
        self.write_index(&index)?;
        let tree = Self::write_tree(&repo, &index)?;
        if Self::head_tree(&repo, Some(head))? == Some(tree) {
            return Ok(None);
        }
        let default_message = format!("Revert {}", &oid[..oid.len().min(7)]);
        Self::commit_tree(&repo, tree, Some(head), message.unwrap_or(&default_message), author).map(Some)
    }

    fn abort_revert(&self) -> Result<()> {
        let _guard = self.lock();
        let repo = self.open()?;
        let head = Self::head_id(&repo)?.ok_or_else(|| HistoryError::not_found("Could not find HEAD."))?;
        let head_files = Self::tree_files(&repo, head)?;
        let old_index = self.read_index()?;
        let index_mtime = self.index_mtime();
        for path in old_index.keys().filter(|p| !head_files.contains_key(*p)) {
            self.remove_worktree_file(path)?;
        }
        let mut index = IndexMap::new();
        for (path, (oid, kind)) in &head_files {
            let current = self.worktree_oid(path, old_index.get(path), index_mtime)?;
            if current != Some(*oid) {
                self.checkout_blob(&repo, path, *oid)?;
            }
            let mode = match kind {
                EntryKind::BlobExecutable => Mode::FILE_EXECUTABLE,
                EntryKind::Link => Mode::SYMLINK,
                _ => Mode::FILE,
            };
            index.insert(path.clone(), self.entry_for(path, *oid, mode)?);
        }
        self.write_index(&index)
    }

    fn read_text(&self, rev: &str, path: &str) -> Result<String> {
        let repo = self.open()?;
        let missing = || HistoryError::not_found(format!("Could not find file or directory found at \"{rev}:{path}\"."));
        let id = repo.rev_parse_single(rev).map_err(|_| HistoryError::not_found(format!("Could not find {rev}.")))?;
        let tree = id
            .object()
            .ctx("Failed to read an object")?
            .peel_to_tree()
            .map_err(|_| HistoryError::invalid(format!("{rev} is not a commit or tree")))?;
        let entry = tree.lookup_entry_by_path(Path::new(path)).ctx("Failed to look up a path")?.ok_or_else(missing)?;
        if entry.mode().is_tree() {
            return Err(missing());
        }
        let blob = entry.object().ctx("Failed to read a blob")?;
        Ok(String::from_utf8_lossy(&blob.data).into_owned())
    }
}
