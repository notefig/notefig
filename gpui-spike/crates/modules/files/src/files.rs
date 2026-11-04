//! Files entity: each open workspace's files, as the files module's
//! workspace instance (`core.workspace(ws).get::<FilesModule>()`). A port
//! of `modules/files/files.ts`.
//!
//! Everything a workspace's files need is handed to
//! [`create_workspace_files`]; nothing here reaches the OS. The instance
//! owns its rows, its watcher, the listing walk (with its 30 s refetch)
//! and the debounced invalidation every write shares.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow, bail};
use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_core::{Executor, ExecutorExt, Hooks, Subscription};
use notefig_platform::{
    EntryType, FileSystem, FsChangeEvent, FsErrorKind, ReadDirectoryOptions, content_hash,
};

use crate::collections::{ContentCollection, FileContent, FileMetadata, MetadataCollection};
use crate::ignore::ignore_rules;
use crate::paths::{dirname, from_tree_path, relative_tree_path};
use crate::{FilesChanged, FilesChangedEvent, GitStale, SearchStale, WorkspaceEvent, sync};

pub(crate) const METADATA_REFETCH_INTERVAL: Duration = Duration::from_secs(30);
/// How long a walked listing counts as current: returning to a workspace
/// re-walks only an older one.
pub const LISTING_FRESH: Duration = Duration::from_secs(10);
const INVALIDATE_DEBOUNCE: Duration = Duration::from_millis(500);
const WALK_RETRIES: u32 = 3;

type Done = Shared<LocalBoxFuture<'static, ()>>;

/// What a workspace's files are built from (`FilesDeps`).
pub struct FilesDeps {
    pub workspace_path: String,
    pub fs: Rc<dyn FileSystem>,
    /// Where `files:changed` and `git:stale` are announced.
    pub hooks: Hooks,
    pub executor: Rc<dyn Executor>,
}

/// Metadata and loaded content joined (`FileEntry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub relative_path: Option<String>,
    pub kind: EntryType,
    pub modified_ms: Option<u64>,
    pub size: Option<u64>,
    pub content_hash: String,
    pub content: Rc<str>,
    pub error: Option<String>,
}

/// A file row shaped for open tabs (`OpenFileRow`): metadata joined with
/// content, which loads on demand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenFileRow {
    pub metadata: Rc<FileMetadata>,
    pub content: Rc<str>,
    pub content_hash: String,
    pub is_content_loaded: bool,
    pub content_error: Option<String>,
}

pub(crate) struct Inner {
    pub(crate) workspace_path: String,
    pub(crate) fs: Rc<dyn FileSystem>,
    hooks: Hooks,
    executor: Rc<dyn Executor>,
    pub(crate) metadata: MetadataCollection,
    pub(crate) content: ContentCollection,
    /// Directories whose children have been stat'd: the walk re-stats them.
    hydrated_dirs: RefCell<HashSet<String>>,
    hydration_in_flight: RefCell<HashMap<String, Done>>,
    walk: RefCell<Option<Done>>,
    invalidation: Cell<u64>,
    watcher: RefCell<Option<Subscription>>,
    watch_failed: Cell<bool>,
    content_paths: RefCell<Vec<String>>,
    /// Whether a save is in flight for a path (the documents module's
    /// `getDocumentSync(path).isDirty()`), set by that module.
    dirty_check: RefCell<Option<Rc<dyn Fn(&str) -> bool>>>,
    disposed: Cell<bool>,
    _interval: RefCell<Option<Subscription>>,
}

/// One open workspace's files — `core.workspace(ws).get::<FilesModule>()`.
/// Cheap to clone.
#[derive(Clone)]
pub struct WorkspaceFiles {
    pub(crate) inner: Rc<Inner>,
}

/// One path in a workspace (`FileHandle`).
#[derive(Clone)]
pub struct FileHandle {
    files: WorkspaceFiles,
    path: String,
}

/// Build a workspace's files: starts the listing walk, its refetch interval
/// and the metadata watch at once.
pub fn create_workspace_files(deps: FilesDeps) -> WorkspaceFiles {
    let inner = Rc::new(Inner {
        workspace_path: deps.workspace_path,
        fs: deps.fs,
        hooks: deps.hooks,
        executor: deps.executor,
        metadata: MetadataCollection::default(),
        content: ContentCollection::default(),
        hydrated_dirs: RefCell::default(),
        hydration_in_flight: RefCell::default(),
        walk: RefCell::default(),
        invalidation: Cell::new(0),
        watcher: RefCell::default(),
        watch_failed: Cell::new(false),
        content_paths: RefCell::default(),
        dirty_check: RefCell::default(),
        disposed: Cell::new(false),
        _interval: RefCell::default(),
    });
    let files = WorkspaceFiles { inner };
    // Watched from open to close, so a backgrounded workspace keeps taking
    // in external changes (MET-177).
    files.arm_watcher();
    // The listing walk starts with the workspace, not with the first reader.
    let _ = files.refresh();
    files.start_interval();
    files
}

impl WorkspaceFiles {
    pub fn workspace_path(&self) -> &str {
        &self.inner.workspace_path
    }

    /// The listing's rows.
    pub fn metadata(&self) -> &MetadataCollection {
        &self.inner.metadata
    }

    /// The loaded files.
    pub fn content(&self) -> &ContentCollection {
        &self.inner.content
    }

    /// Called whenever either row set changes.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        let listener = Rc::new(listener);
        let l = listener.clone();
        Subscription::join(vec![
            self.inner.metadata.subscribe(move || l()),
            self.inner.content.subscribe(move || listener()),
        ])
    }

    pub fn file(&self, path: &str) -> FileHandle {
        FileHandle { files: self.clone(), path: path.to_string() }
    }

    /// Absolute path of a tree-domain relative path.
    pub fn absolute(&self, rel: &str) -> String {
        from_tree_path(&self.inner.workspace_path, rel)
    }

    /// The workspace-relative path of an absolute one, if inside.
    pub fn relative(&self, path: &str) -> Option<String> {
        relative_tree_path(&self.inner.workspace_path, path)
    }

    // -- walking -----------------------------------------------------------

    /// Re-walk the listing; resolves once a walk has landed (joins one in
    /// flight).
    pub fn refresh(&self) -> LocalBoxFuture<'static, ()> {
        if let Some(walk) = self.inner.walk.borrow().clone() {
            return walk.boxed_local();
        }
        self.start_walk()
    }

    /// Re-walk unless a walk is in flight or landed within `max_age`: for
    /// catching watcher gaps on a return without a walk on every switch.
    pub fn catch_up(&self, max_age: Duration) -> LocalBoxFuture<'static, ()> {
        let state = self.inner.metadata.fetch_state();
        if state.fetching || state.updated_at.is_some_and(|at| at.elapsed() < max_age) {
            return futures::future::ready(()).boxed_local();
        }
        self.refresh()
    }

    /// Re-walk after out-of-band disk changes: resolves once a walk that
    /// STARTED after this call has landed.
    pub fn refetch_metadata(&self) -> LocalBoxFuture<'static, ()> {
        let this = self.clone();
        let running = self.inner.walk.borrow().clone();
        async move {
            if let Some(walk) = running {
                walk.await;
            }
            this.refresh().await;
        }
        .boxed_local()
    }

    fn start_walk(&self) -> LocalBoxFuture<'static, ()> {
        let weak = Rc::downgrade(&self.inner);
        let executor = self.inner.executor.clone();
        self.inner.metadata.set_fetch(|f| f.fetching = true);
        let done: Done = async move {
            let mut attempt = 0;
            loop {
                let Some(inner) = weak.upgrade() else { return };
                if inner.disposed.get() {
                    return;
                }
                let result = walk(&inner).await;
                if inner.disposed.get() {
                    return;
                }
                match result {
                    Ok(rows) => {
                        inner.metadata.reconcile(rows);
                        inner.metadata.set_fetch(|f| {
                            f.fetching = false;
                            f.error = None;
                            f.updated_at = Some(Instant::now());
                        });
                        break;
                    }
                    Err(err) => {
                        // Access errors can't be retried away: fail fast so
                        // the recovery UI shows at once.
                        attempt += 1;
                        if err.is_workspace_access_error() || err.kind == FsErrorKind::NotFound || attempt >= WALK_RETRIES {
                            log::error!("[files] listing walk of {} failed: {err}", inner.workspace_path);
                            inner.metadata.set_fetch(|f| {
                                f.fetching = false;
                                f.error = Some(err);
                            });
                            break;
                        }
                        drop(inner);
                        executor.timer(Duration::from_millis(1000 << (attempt - 1))).await;
                    }
                }
            }
            if let Some(inner) = weak.upgrade() {
                inner.metadata.mark_ready();
                inner.walk.borrow_mut().take();
            }
        }
        .boxed_local()
        .shared();
        *self.inner.walk.borrow_mut() = Some(done.clone());
        // Run it even if nobody awaits.
        let driver = done.clone();
        self.inner.executor.spawn_local(driver);
        done.boxed_local()
    }

    fn start_interval(&self) {
        let weak = Rc::downgrade(&self.inner);
        let executor = self.inner.executor.clone();
        let alive = Rc::new(Cell::new(true));
        let live = alive.clone();
        self.inner.executor.spawn_local(async move {
            loop {
                executor.timer(METADATA_REFETCH_INTERVAL).await;
                if !live.get() {
                    return;
                }
                let Some(inner) = weak.upgrade() else { return };
                if inner.disposed.get() {
                    return;
                }
                let state = inner.metadata.fetch_state();
                // Stale only: a walk that landed within the interval holds.
                if !state.fetching && state.updated_at.is_none_or(|at| at.elapsed() >= LISTING_FRESH) {
                    let _ = WorkspaceFiles { inner }.refresh();
                }
            }
        });
        *self.inner._interval.borrow_mut() = Some(Subscription::new(move || alive.set(false)));
    }

    // -- rows for disk changes this app made -------------------------------

    /// The rows for disk changes this app made behind the rows' back (the
    /// entry-time scratchpad sweep and landing), without a re-walk. A walk
    /// in flight lands first and the rows are written on top. A created
    /// file brings its missing ancestor directories, as a walk would.
    pub fn record_disk_changes(&self, created: Vec<String>, deleted: Vec<String>) -> LocalBoxFuture<'static, ()> {
        let inner = self.inner.clone();
        let running = self.inner.walk.borrow().clone();
        async move {
            if let Some(walk) = running {
                walk.await;
            }
            let ws = inner.workspace_path.clone();
            let mut missing: Vec<String> = Vec::new();
            for path in &created {
                let mut at = path.clone();
                while at != ws && !inner.metadata.contains(&at) && !missing.contains(&at) {
                    if relative_tree_path(&ws, &at).is_none() {
                        break;
                    }
                    missing.push(at.clone());
                    let parent = dirname(&at);
                    if parent == at {
                        break;
                    }
                    at = parent;
                }
            }
            let stats = if missing.is_empty() { Vec::new() } else { inner.fs.metadata(missing).await.succeeded };
            inner.metadata.write_batch(|| {
                for path in &deleted {
                    if inner.metadata.contains(path) {
                        inner.metadata.write_delete(path);
                    }
                }
                for stat in &stats {
                    if inner.metadata.contains(&stat.path) {
                        continue;
                    }
                    inner.metadata.write_upsert(FileMetadata {
                        path: stat.path.clone(),
                        relative_path: relative_tree_path(&ws, &stat.path),
                        kind: stat.kind,
                        modified_ms: Some(stat.modified_ms),
                        size: Some(stat.size),
                        content_hash: String::new(),
                        error: None,
                    });
                }
            });
            for path in &deleted {
                inner.content.write_delete(path);
            }
        }
        .boxed_local()
    }

    /// Stat the direct children of these directories and write their
    /// modified/size — one stat batch for all. A hydrated directory is
    /// skipped (the walk re-stats its children); calls per directory
    /// coalesce.
    pub fn hydrate_directory_stats(&self, dirs: Vec<String>) -> LocalBoxFuture<'static, ()> {
        let mut waits: Vec<Done> = Vec::new();
        let mut pending: Vec<String> = Vec::new();
        {
            let hydrated = self.inner.hydrated_dirs.borrow();
            let in_flight = self.inner.hydration_in_flight.borrow();
            let mut seen = HashSet::new();
            for dir in dirs {
                if !seen.insert(dir.clone()) || hydrated.contains(&dir) {
                    continue;
                }
                match in_flight.get(&dir) {
                    Some(f) => waits.push(f.clone()),
                    None => pending.push(dir),
                }
            }
        }
        if !pending.is_empty() {
            let inner = self.inner.clone();
            let dirs = pending.clone();
            let batch: Done = async move {
                stat_children(&inner, &dirs).await;
                let mut in_flight = inner.hydration_in_flight.borrow_mut();
                for d in &dirs {
                    in_flight.remove(d);
                }
            }
            .boxed_local()
            .shared();
            let mut in_flight = self.inner.hydration_in_flight.borrow_mut();
            for d in pending {
                in_flight.insert(d, batch.clone());
            }
            waits.push(batch);
        }
        async move {
            futures::future::join_all(waits).await;
        }
        .boxed_local()
    }

    // -- content -----------------------------------------------------------

    /// Bring a loaded file's rows (content, and metadata's hash) to
    /// `content`: for writes that bypass this instance (an agent's adopting
    /// write) and for the watcher after it verified a change. No-op for a
    /// path with no content row.
    pub fn update_loaded_content(&self, path: &str, content: &str) {
        let Some(existing) = self.inner.content.get(path) else { return };
        let hash = content_hash(content);
        if existing.content_hash == hash {
            return;
        }
        self.inner.content.write_upsert(FileContent {
            path: path.to_string(),
            content: Rc::from(content),
            content_hash: hash.clone(),
            error: None,
        });
        if let Some(meta) = self.inner.metadata.get(path)
            && meta.content_hash != hash
        {
            self.inner.metadata.write_upsert(FileMetadata { content_hash: hash, ..(*meta).clone() });
        }
    }

    /// Load these files' content if not loaded or loading (the on-demand
    /// sync a live query on `path` triggers in TS). Resolves when read.
    pub fn load_content(&self, paths: Vec<String>) -> LocalBoxFuture<'static, ()> {
        let claimed = self.inner.content.claim(&paths);
        if claimed.is_empty() {
            return futures::future::ready(()).boxed_local();
        }
        let this = self.clone();
        async move {
            let result = this.inner.fs.read_files(claimed.clone()).await;
            let mut rows: Vec<FileContent> = result
                .succeeded
                .into_iter()
                .map(|(path, content)| FileContent {
                    content_hash: content_hash(&content),
                    content: Rc::from(content),
                    path,
                    error: None,
                })
                .collect();
            // A not_found read is disk truth the listing has not caught up
            // with: re-walk, and fabricate no row (a delete racing a
            // recreate would otherwise leave a poisoned error row).
            if result.failed.iter().any(|f| f.kind == FsErrorKind::NotFound) {
                let _ = this.refetch_metadata();
            }
            for failure in result.failed {
                log::warn!("Failed to read file {}: {}", failure.path, failure.message);
                if failure.kind == FsErrorKind::NotFound {
                    continue;
                }
                rows.push(FileContent {
                    content_hash: content_hash(&failure.path),
                    path: failure.path,
                    content: Rc::from(""),
                    error: Some(failure.message),
                });
            }
            this.inner.content.finish_loading(&claimed, rows);
        }
        .boxed_local()
    }

    /// Metadata ⋈ content for a set of open files (`useOpenFileRows`).
    /// Rows appear as soon as metadata is in; content follows on demand —
    /// asking starts the load.
    pub fn open_file_rows(&self, paths: &[String]) -> Vec<OpenFileRow> {
        let missing: Vec<String> = paths
            .iter()
            .filter(|p| self.inner.metadata.contains(p) && !self.inner.content.contains(p))
            .cloned()
            .collect();
        if !missing.is_empty() {
            self.inner.executor.spawn_local(self.load_content(missing));
        }
        paths
            .iter()
            .filter_map(|p| {
                let metadata = self.inner.metadata.get(p)?;
                let content = self.inner.content.get(p);
                Some(OpenFileRow {
                    metadata,
                    content: content.as_ref().map(|c| c.content.clone()).unwrap_or_else(|| Rc::from("")),
                    content_hash: content.as_ref().map(|c| c.content_hash.clone()).unwrap_or_default(),
                    is_content_loaded: content.is_some(),
                    content_error: content.and_then(|c| c.error.clone()),
                })
            })
            .collect()
    }

    // -- derived state -----------------------------------------------------

    /// Search results and git rows go stale (debounced): a write the
    /// watcher suppresses, or a change it reported.
    pub fn invalidate_derived(&self) {
        let generation = self.inner.invalidation.get() + 1;
        self.inner.invalidation.set(generation);
        let weak = Rc::downgrade(&self.inner);
        let timer = self.inner.executor.timer(INVALIDATE_DEBOUNCE);
        self.inner.executor.spawn_local(async move {
            timer.await;
            let Some(inner) = weak.upgrade() else { return };
            if inner.disposed.get() || inner.invalidation.get() != generation {
                return;
            }
            let ws = WorkspaceEvent { workspace_path: inner.workspace_path.clone() };
            inner.hooks.emit::<SearchStale>(ws.clone());
            inner.hooks.emit::<GitStale>(ws);
        });
    }

    /// The watcher reported these paths changed and their rows are
    /// updated: announce `files:changed`, then derived state goes stale.
    pub fn changed(&self, paths: Vec<String>) {
        self.inner.hooks.emit::<FilesChanged>(FilesChangedEvent {
            workspace_path: self.inner.workspace_path.clone(),
            paths,
        });
        self.invalidate_derived();
    }

    // -- watching ----------------------------------------------------------

    pub(crate) fn watch_id(&self) -> String {
        format!("metadata-{}", self.inner.workspace_path)
    }

    fn arm_watcher(&self) {
        self.inner.watch_failed.set(false);
        let weak = Rc::downgrade(&self.inner);
        let listener: Rc<dyn Fn(&FsChangeEvent)> = Rc::new({
            let weak = weak.clone();
            move |event: &FsChangeEvent| {
                let Some(inner) = weak.upgrade() else { return };
                if inner.disposed.get() {
                    return;
                }
                let files = WorkspaceFiles { inner };
                let executor = files.inner.executor.clone();
                executor.spawn_local(sync::handle_event(files, event.clone()));
            }
        });
        let start = self.inner.fs.watch(
            vec![self.inner.workspace_path.clone()],
            &self.watch_id(),
            Some(ignore_rules()),
            listener,
        );
        let id = self.watch_id();
        self.inner.executor.spawn_local(async move {
            let result = start.await;
            let Some(inner) = weak.upgrade() else { return };
            match result {
                // A close can land while the start is in flight: the
                // subscription then just drops.
                Ok(sub) if !inner.disposed.get() => {
                    let paths = inner.content_paths.borrow().clone();
                    if !paths.is_empty() {
                        inner.fs.watch_content(&id, paths);
                    }
                    *inner.watcher.borrow_mut() = Some(sub);
                }
                Ok(_) => {}
                Err(err) => {
                    inner.watch_failed.set(true);
                    log::error!("Failed to start metadata watcher: {err}");
                }
            }
        });
    }

    /// Give a watch whose start failed another chance (the folder was
    /// unreadable when it opened). No-op otherwise.
    pub fn ensure_watching(&self) {
        if !self.inner.disposed.get() && self.inner.watch_failed.get() {
            self.arm_watcher();
        }
    }

    /// Watch the content of these open files (replacing the previous set).
    pub fn watch_content(&self, paths: Vec<String>) {
        if *self.inner.content_paths.borrow() == paths {
            return;
        }
        *self.inner.content_paths.borrow_mut() = paths.clone();
        if self.inner.watcher.borrow().is_some() {
            self.inner.fs.watch_content(&self.watch_id(), paths);
        }
    }

    /// Whether the watch is running (for tests and diagnostics).
    pub fn is_watching(&self) -> bool {
        self.inner.watcher.borrow().is_some()
    }

    /// The documents module tells files which paths have a save in flight:
    /// a content event for one is deferred to the save
    /// (`getDocumentSync(path).isDirty()` in TS).
    pub fn set_dirty_check(&self, check: impl Fn(&str) -> bool + 'static) {
        *self.inner.dirty_check.borrow_mut() = Some(Rc::new(check));
    }

    pub(crate) fn is_dirty(&self, path: &str) -> bool {
        let check = self.inner.dirty_check.borrow().clone();
        check.is_some_and(|c| c(path))
    }

    /// Drop and re-seed the rows (recovery after fs access is restored).
    pub fn reload(&self) {
        self.inner.hydrated_dirs.borrow_mut().clear();
        self.inner.metadata.clear();
        self.inner.content.clear();
        let _ = self.refresh();
    }

    /// Stop the watcher, the interval and pending invalidation; drop rows.
    pub fn dispose(&self) {
        self.inner.disposed.set(true);
        self.inner.watcher.borrow_mut().take();
        self.inner._interval.borrow_mut().take();
        self.inner.invalidation.set(self.inner.invalidation.get() + 1);
        self.inner.walk.borrow_mut().take();
        self.inner.metadata.clear();
        self.inner.content.clear();
    }

    // -- mutations ----------------------------------------------------------

    fn prune_hydrated(&self, path: &str) {
        self.inner
            .hydrated_dirs
            .borrow_mut()
            .retain(|d| d != path && relative_tree_path(path, d).is_none_or(|r| r.is_empty()));
    }

    async fn restat(&self, path: &str) -> Option<notefig_platform::FileMetadata> {
        self.inner.fs.metadata(vec![path.to_string()]).await.succeeded.into_iter().next()
    }

    async fn write(&self, path: String, content: String, hash: Option<String>) -> anyhow::Result<()> {
        let hash = hash.unwrap_or_else(|| content_hash(&content));
        let previous = self.inner.content.get(&path);
        self.inner.content.write_upsert(FileContent {
            path: path.clone(),
            content: Rc::from(content.as_str()),
            content_hash: hash.clone(),
            error: None,
        });
        let result = self.inner.fs.write_files(vec![(path.clone(), content)]).await;
        if let Some(failure) = result.failed.first() {
            self.inner.content.restore(&path, previous);
            bail!("Failed to write files: {}", failure.message);
        }
        // After the write landed: reading before would capture the
        // pre-write mtime and make date-sorted views flap.
        if let Some(stat) = self.restat(&path).await
            && let Some(meta) = self.inner.metadata.get(&path)
        {
            self.inner.metadata.write_upsert(FileMetadata {
                modified_ms: Some(stat.modified_ms),
                size: Some(stat.size),
                content_hash: hash,
                ..(*meta).clone()
            });
        }
        // The watcher suppresses our own writes, so derived state is
        // invalidated here.
        self.invalidate_derived();
        Ok(())
    }

    async fn create_file(&self, path: String, content: String) -> anyhow::Result<()> {
        self.inner.metadata.write_upsert(FileMetadata {
            path: path.clone(),
            relative_path: self.relative(&path),
            kind: EntryType::File,
            modified_ms: None,
            size: Some(0),
            content_hash: String::new(),
            error: None,
        });
        let result = self.inner.fs.create_files(vec![path.clone()]).await;
        if let Some(failure) = result.failed.first() {
            self.inner.metadata.write_delete(&path);
            bail!("Failed to create files: {}", failure.message);
        }
        // A fresh file must not inherit a content row from a previous life
        // of this path (an error row left by a read that raced its delete).
        self.inner.content.write_delete(&path);
        if !content.is_empty() {
            self.write(path.clone(), content, None).await?;
        }
        if let Some(stat) = self.restat(&path).await
            && let Some(meta) = self.inner.metadata.get(&path)
        {
            self.inner.metadata.write_upsert(FileMetadata {
                modified_ms: Some(stat.modified_ms),
                size: Some(stat.size),
                ..(*meta).clone()
            });
        }
        Ok(())
    }

    async fn create_directory(&self, path: String) -> anyhow::Result<()> {
        self.inner.metadata.write_upsert(FileMetadata {
            path: path.clone(),
            relative_path: self.relative(&path),
            kind: EntryType::Directory,
            modified_ms: None,
            size: None,
            content_hash: String::new(),
            error: None,
        });
        let result = self.inner.fs.create_directories(vec![path.clone()]).await;
        if let Some(failure) = result.failed.first() {
            self.inner.metadata.write_delete(&path);
            bail!("Failed to create directories: {}", failure.message);
        }
        if let Some(stat) = self.restat(&path).await
            && let Some(meta) = self.inner.metadata.get(&path)
        {
            self.inner.metadata.write_upsert(FileMetadata {
                modified_ms: Some(stat.modified_ms),
                size: Some(stat.size),
                ..(*meta).clone()
            });
        }
        Ok(())
    }

    /// Rows under `path` (not `path` itself).
    fn descendants(&self, path: &str) -> Vec<Rc<FileMetadata>> {
        self.inner
            .metadata
            .rows()
            .into_iter()
            .filter(|row| relative_tree_path(path, &row.path).is_some_and(|r| !r.is_empty()))
            .collect()
    }

    async fn remove(&self, path: String) -> anyhow::Result<()> {
        let entry = self.inner.metadata.get(&path);
        let is_dir = entry.as_ref().is_some_and(|e| e.is_dir());
        let removed_children = if is_dir { self.descendants(&path) } else { Vec::new() };
        let previous_content = self.inner.content.get(&path);
        self.inner.metadata.write_batch(|| {
            for child in &removed_children {
                self.inner.metadata.write_delete(&child.path);
            }
            self.inner.metadata.write_delete(&path);
        });
        for child in &removed_children {
            self.inner.content.write_delete(&child.path);
        }
        self.inner.content.write_delete(&path);
        self.prune_hydrated(&path);

        let failed = if is_dir {
            self.inner.fs.delete_directories(vec![path.clone()], true).await.failed
        } else {
            self.inner.fs.delete_files(vec![path.clone()]).await.failed
        };
        if let Some(failure) = failed.first() {
            // Roll back: the entry is still on disk.
            if let Some(entry) = entry {
                let mut rows: Vec<FileMetadata> = removed_children.iter().map(|r| (**r).clone()).collect();
                rows.push((*entry).clone());
                self.inner.metadata.write_upsert_many(rows);
            }
            if previous_content.is_some() {
                self.inner.content.restore(&path, previous_content);
            }
            bail!("Failed to delete {path}: {}", failure.message);
        }
        Ok(())
    }

    async fn rename(&self, old: String, new: String) -> anyhow::Result<()> {
        if old == new {
            return Ok(());
        }
        let entry = self
            .inner
            .metadata
            .get(&old)
            .ok_or_else(|| anyhow!("Cannot rename: no metadata entry found for {old}"))?;
        // A case-only rename on a case-insensitive disk is not a collision.
        if self.inner.metadata.contains(&new) && old.to_lowercase() != new.to_lowercase() {
            bail!("Cannot rename: a file or directory already exists at {new}");
        }
        let moved = if entry.is_dir() {
            self.inner.fs.move_directory(&old, &new).await
        } else {
            self.inner.fs.move_file(&old, &new).await
        };
        moved.with_context(|| format!("Failed to rename {old} to {new}"))?;

        let ws = self.inner.workspace_path.clone();
        let children = if entry.is_dir() { self.descendants(&old) } else { Vec::new() };
        let mut content_moves = Vec::new();
        self.inner.metadata.write_batch(|| {
            for child in &children {
                let rel = relative_tree_path(&old, &child.path).unwrap_or_default();
                let new_child = from_tree_path(&new, &rel);
                self.inner.metadata.write_delete(&child.path);
                self.inner.metadata.write_upsert(FileMetadata {
                    path: new_child.clone(),
                    relative_path: relative_tree_path(&ws, &new_child),
                    ..(**child).clone()
                });
                content_moves.push((child.path.clone(), new_child));
            }
            self.inner.metadata.write_delete(&old);
            self.inner.metadata.write_upsert(FileMetadata {
                path: new.clone(),
                relative_path: relative_tree_path(&ws, &new),
                ..(*entry).clone()
            });
        });
        content_moves.push((old.clone(), new.clone()));
        for (from, to) in content_moves {
            if let Some(row) = self.inner.content.get(&from) {
                self.inner.content.write_delete(&from);
                self.inner.content.write_upsert(FileContent { path: to, ..(*row).clone() });
            }
        }
        // Hydration keys on paths; the renamed subtree re-hydrates when the
        // tree shows it again.
        self.prune_hydrated(&old);
        Ok(())
    }

    fn entry(&self, path: &str) -> Option<FileEntry> {
        let meta = self.inner.metadata.get(path)?;
        let content = self.inner.content.get(path);
        Some(FileEntry {
            path: meta.path.clone(),
            relative_path: meta.relative_path.clone(),
            kind: meta.kind,
            modified_ms: meta.modified_ms,
            size: meta.size,
            // Content and its hash come from the same row.
            content_hash: content
                .as_ref()
                .map(|c| c.content_hash.clone())
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| meta.content_hash.clone()),
            content: content.map(|c| c.content.clone()).unwrap_or_else(|| Rc::from("")),
            error: meta.error.clone(),
        })
    }
}

impl FileHandle {
    pub fn workspace_path(&self) -> &str {
        self.files.workspace_path()
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn exists(&self) -> bool {
        self.files.inner.metadata.contains(&self.path)
    }

    pub fn metadata(&self) -> Option<Rc<FileMetadata>> {
        self.files.inner.metadata.get(&self.path)
    }

    /// Cached content (`None` until loaded). NOT for write paths: anything
    /// that patches-then-saves must read fresh from disk, or it risks
    /// clobbering a newer version.
    pub fn content(&self) -> Option<Rc<str>> {
        self.files.inner.content.get(&self.path).map(|c| c.content.clone())
    }

    /// Create it as a file (empty unless `content` is non-empty). Resolves
    /// once it is on disk, so opening it right after cannot race the write.
    pub fn create(&self, content: &str) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let (files, path, content) = (self.files.clone(), self.path.clone(), content.to_string());
        async move { files.create_file(path, content).await }.boxed_local()
    }

    pub fn create_directory(&self) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let (files, path) = (self.files.clone(), self.path.clone());
        async move { files.create_directory(path).await }.boxed_local()
    }

    /// Replace its content on disk; resolves once written. `hash`: the
    /// content's, when the caller has it already.
    pub fn write(&self, content: &str, hash: Option<String>) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let (files, path, content) = (self.files.clone(), self.path.clone(), content.to_string());
        async move { files.write(path, content, hash).await }.boxed_local()
    }

    /// Move it (file or directory) to `new_path` in the same workspace.
    pub fn rename(&self, new_path: &str) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let (files, old, new) = (self.files.clone(), self.path.clone(), new_path.to_string());
        async move { files.rename(old, new).await }.boxed_local()
    }

    /// Delete it (to the trash); a directory goes with everything under it.
    pub fn delete(&self) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let (files, path) = (self.files.clone(), self.path.clone());
        async move { files.remove(path).await }.boxed_local()
    }

    /// Metadata and loaded content joined; `None` if there is no entry.
    pub fn entry(&self) -> Option<FileEntry> {
        self.files.entry(&self.path)
    }

    /// Load its content ahead of use (hover prefetch).
    pub fn prefetch(&self) -> LocalBoxFuture<'static, ()> {
        self.files.load_content(vec![self.path.clone()])
    }
}

/// One walk of the listing: directories first, children of hydrated
/// directories re-stat'd. A row the walk sees unchanged keeps its identity.
async fn walk(inner: &Rc<Inner>) -> Result<Vec<Rc<FileMetadata>>, notefig_platform::FsError> {
    inner.metadata.begin_walk();
    let listing = inner
        .fs
        .read_directory(
            &inner.workspace_path,
            ReadDirectoryOptions {
                recursive: true,
                include_files: true,
                include_directories: true,
                include_hidden: false,
                ignore: Some(ignore_rules()),
            },
        )
        .await?;
    let (dirs, files): (Vec<_>, Vec<_>) = listing.into_iter().partition(|e| e.kind == EntryType::Directory);
    let entries: Vec<_> = dirs.into_iter().chain(files).collect();

    let mut stats: HashMap<String, (u64, u64)> = HashMap::new();
    let to_stat: Vec<String> = {
        let hydrated = inner.hydrated_dirs.borrow();
        if hydrated.is_empty() {
            Vec::new()
        } else {
            entries.iter().filter(|e| hydrated.contains(&dirname(&e.path))).map(|e| e.path.clone()).collect()
        }
    };
    if !to_stat.is_empty() {
        for m in inner.fs.metadata(to_stat).await.succeeded {
            stats.insert(m.path, (m.modified_ms, m.size));
        }
    }
    let ws = &inner.workspace_path;
    Ok(entries
        .into_iter()
        .map(|e| {
            let stat = stats.get(&e.path).copied();
            match inner.metadata.synced(&e.path) {
                Some(prev) if prev.kind == e.kind && stat.is_none() => prev,
                Some(prev) => Rc::new(FileMetadata {
                    kind: e.kind,
                    modified_ms: stat.map(|s| s.0).or(prev.modified_ms),
                    size: stat.map(|s| s.1).or(prev.size),
                    ..(*prev).clone()
                }),
                None => Rc::new(FileMetadata {
                    relative_path: relative_tree_path(ws, &e.path),
                    path: e.path,
                    kind: e.kind,
                    modified_ms: stat.map(|s| s.0),
                    size: stat.map(|s| s.1),
                    content_hash: String::new(),
                    error: None,
                }),
            }
        })
        .collect())
}

/// One stat batch and one write for every child of `dirs`.
async fn stat_children(inner: &Rc<Inner>, dirs: &[String]) {
    // Before the first walk lands there are no rows: leave the directories
    // unhydrated, so the next request does them.
    if !inner.metadata.is_ready() {
        return;
    }
    let wanted: HashSet<&String> = dirs.iter().collect();
    let children: Vec<String> = inner
        .metadata
        .rows()
        .into_iter()
        .filter(|row| {
            let parent = dirname(&row.path);
            parent != row.path && wanted.contains(&parent)
        })
        .map(|row| row.path.clone())
        .collect();
    if !children.is_empty() {
        let result = inner.fs.metadata(children).await;
        let updates: Vec<FileMetadata> = result
            .succeeded
            .iter()
            .filter_map(|m| {
                let row = inner.metadata.get(&m.path)?;
                Some(FileMetadata { modified_ms: Some(m.modified_ms), size: Some(m.size), ..(*row).clone() })
            })
            .collect();
        if !updates.is_empty() {
            inner.metadata.write_upsert_many(updates);
        }
        // Some stats failed: the next request retries.
        if !result.failed.is_empty() {
            return;
        }
    }
    inner.hydrated_dirs.borrow_mut().extend(dirs.iter().cloned());
}

#[cfg(test)]
impl WorkspaceFiles {
    pub(crate) fn inner_hooks(&self) -> &Hooks {
        &self.inner.hooks
    }
}
