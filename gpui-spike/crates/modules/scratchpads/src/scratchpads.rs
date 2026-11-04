//! One workspace's scratchpads: `core.workspace(ws).get::<ScratchpadsModule>()`.

use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_files::WorkspaceFiles;
use notefig_files::paths::{basename, dirname, join};
use notefig_platform::{EntryType, FileSystem, FsErrorKind, ReadDirectoryOptions};

use crate::names::*;

/// What a workspace's scratchpads are built from (`ScratchpadsDeps`).
pub struct ScratchpadsDeps {
    pub workspace_path: String,
    /// Where a new scratchpad is created, and the rows entry records.
    pub files: WorkspaceFiles,
    /// Entry works on plain disk truth, never on rows.
    pub fs: Rc<dyn FileSystem>,
    /// The "scratchpad on startup" setting: off means entry lands nowhere.
    pub lands_on_startup: Rc<dyn Fn() -> LocalBoxFuture<'static, bool>>,
    /// Open a fresh scratchpad as the user's gesture's tab.
    pub open_tab: Rc<dyn Fn(&str)>,
}

pub struct WorkspaceScratchpads {
    deps: ScratchpadsDeps,
    dir: String,
}

pub fn create_workspace_scratchpads(deps: ScratchpadsDeps) -> WorkspaceScratchpads {
    let dir = scratchpads_dir_path(&deps.workspace_path);
    WorkspaceScratchpads { deps, dir }
}

impl WorkspaceScratchpads {
    pub fn dir(&self) -> &str {
        &self.dir
    }

    /// The workspace's files this instance writes through.
    pub fn files(&self) -> &WorkspaceFiles {
        &self.deps.files
    }

    /// A file squatting on a path we need as a directory disables the
    /// feature.
    fn dir_is_blocked(&self) -> bool {
        [self.dir.clone(), dirname(&self.dir)]
            .iter()
            .any(|p| self.deps.files.metadata().get(p).is_some_and(|r| r.kind == EntryType::File))
    }

    /// "New File": a fresh generated-name scratchpad; resolves to its path.
    pub fn create(&self) -> LocalBoxFuture<'static, anyhow::Result<String>> {
        if self.dir_is_blocked() {
            return futures::future::ready(Err(anyhow::anyhow!("a file occupies the scratchpads directory path"))).boxed_local();
        }
        let names: Vec<String> = self
            .deps
            .files
            .metadata()
            .rows()
            .iter()
            .filter(|r| is_scratchpad_file(r.relative_path.as_deref(), !r.is_dir()))
            .map(|r| basename(&r.path).to_string())
            .collect();
        let path = join(&self.dir, &random_scratchpad_basename(&names));
        let handle = self.deps.files.file(&path);
        async move {
            handle.create("").await?;
            Ok(path)
        }
        .boxed_local()
    }

    /// The "New File" action: create one and open it as a tab.
    pub fn create_and_open(&self) -> LocalBoxFuture<'static, ()> {
        let create = self.create();
        let open = self.deps.open_tab.clone();
        async move {
            match create.await {
                Ok(path) => open(&path),
                Err(err) => log::error!("Failed to create a new file: {err:#}"),
            }
        }
        .boxed_local()
    }

    /// What entering the workspace lands on: sweep abandoned empty
    /// scratchpads (never one in `keep`), then the most recent survivor or
    /// a fresh one, or nothing with "scratchpad on startup" off. Never
    /// fails; resolves once the swept and created rows are recorded.
    pub fn enter(&self, keep: Vec<String>) -> LocalBoxFuture<'static, Option<String>> {
        let (fs, dir, lands) = (self.deps.fs.clone(), self.dir.clone(), self.deps.lands_on_startup.clone());
        let files = self.deps.files.clone();
        async move {
            let deleted = sweep_on_disk(&fs, &dir, keep).await;
            let (scratchpad, created) = if lands().await { resolve_on_disk(&fs, &dir).await } else { (None, Vec::new()) };
            files.record_disk_changes(created, deleted).await;
            scratchpad
        }
        .boxed_local()
    }

    /// The entry sweep alone, for an entry with nothing to land on.
    pub fn sweep(&self, keep: Vec<String>) -> LocalBoxFuture<'static, ()> {
        let (fs, dir) = (self.deps.fs.clone(), self.dir.clone());
        let files = self.deps.files.clone();
        async move {
            let deleted = sweep_on_disk(&fs, &dir, keep).await;
            files.record_disk_changes(Vec::new(), deleted).await;
        }
        .boxed_local()
    }
}

async fn list_on_disk(fs: &Rc<dyn FileSystem>, dir: &str) -> notefig_platform::FsResult<Vec<notefig_platform::DirectoryEntry>> {
    fs.read_directory(
        dir,
        ReadDirectoryOptions { recursive: false, include_files: true, include_directories: false, include_hidden: false, ignore: None },
    )
    .await
}

/// Whitespace-only scratchpads (prompt markers aside) not in `keep` are
/// deleted, whatever their name: the folder is app territory. Resolves to
/// the deleted paths.
async fn sweep_on_disk(fs: &Rc<dyn FileSystem>, dir: &str, keep: Vec<String>) -> Vec<String> {
    let Ok(entries) = list_on_disk(fs, dir).await else { return Vec::new() };
    let candidates: Vec<String> = entries.into_iter().map(|e| e.path).filter(|p| !keep.contains(p)).collect();
    if candidates.is_empty() {
        return Vec::new();
    }
    let empties: Vec<String> = fs
        .read_files(candidates)
        .await
        .succeeded
        .into_iter()
        .filter(|(_, c)| strip_prompt_markers(c).trim().is_empty())
        .map(|(p, _)| p)
        .collect();
    if empties.is_empty() {
        return Vec::new();
    }
    fs.delete_files(empties).await.succeeded
}

/// The most recently modified scratchpad on disk, else a freshly created
/// one (returned as created). `None` bails (the folder path is unusable).
async fn resolve_on_disk(fs: &Rc<dyn FileSystem>, dir: &str) -> (Option<String>, Vec<String>) {
    let paths: Vec<String> = match list_on_disk(fs, dir).await {
        Ok(entries) => entries.into_iter().map(|e| e.path).collect(),
        Err(err) if err.kind == FsErrorKind::NotFound => Vec::new(),
        Err(err) => {
            log::warn!("[scratchpads] cannot use the folder: {err}");
            return (None, Vec::new());
        }
    };
    if paths.is_empty() {
        let fresh = join(dir, &random_scratchpad_basename(&[]));
        let result = fs.create_files(vec![fresh.clone()]).await;
        if let Some(f) = result.failed.first() {
            log::warn!("[scratchpads] create failed: {f}");
            return (None, Vec::new());
        }
        return (Some(fresh.clone()), vec![fresh]);
    }
    let stats = fs.metadata(paths.clone()).await.succeeded;
    let candidates: Vec<(String, Option<u64>)> = paths
        .into_iter()
        .map(|p| {
            let m = stats.iter().find(|s| s.path == p).map(|s| s.modified_ms);
            (p, m)
        })
        .collect();
    (Some(pick_most_recent_scratchpad(&candidates)), Vec::new())
}
