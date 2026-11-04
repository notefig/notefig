//! `FileSystemSurface` on the real disk: the Tauri adapter's fs commands
//! (`fs_ops.rs`, `walkdir_utils.rs`) in-process. Every call runs its disk
//! work on the executor's blocking pool and resolves on the main thread.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::{Executor, ExecutorExt, Subscription};
use notefig_platform::{
    BatchResult, DirectoryEntry, EntryType, FileMetadata, FileSystem, FsChangeEvent, FsError,
    FsErrorKind, FsResult, IgnoreRules, ReadDirectoryOptions, SearchMatch, SearchOptions,
    content_hash,
};

use crate::rules::{Rules, is_hidden_child};
use crate::{search, watch};

/// How long a write this app made counts as its own when its watcher echo
/// arrives (`register_app_write`'s TTL).
const APP_WRITE_TTL: Duration = Duration::from_secs(5);

/// State shared with the watcher threads.
#[derive(Default)]
pub(crate) struct Shared {
    /// (path, content hash, when): the echo suppression list. A membership
    /// test with expiry, not consume-once: one save can surface in more
    /// than one event (`file_watcher.rs`).
    app_writes: Mutex<Vec<(PathBuf, String, Instant)>>,
    /// The last content hash this process read, wrote or saw per file:
    /// what pairs a vanished file with its new name in a watcher batch.
    known: Mutex<HashMap<PathBuf, String>>,
}

impl Shared {
    pub(crate) fn register_app_write(&self, path: &Path, hash: &str) {
        let mut writes = self.app_writes.lock().unwrap();
        writes.retain(|(_, _, at)| at.elapsed() < APP_WRITE_TTL);
        writes.push((path.to_path_buf(), hash.to_string(), Instant::now()));
    }

    pub(crate) fn remember(&self, path: &Path, hash: &str) {
        self.known.lock().unwrap().insert(path.to_path_buf(), hash.to_string());
    }

    pub(crate) fn known(&self, path: &Path) -> Option<String> {
        self.known.lock().unwrap().get(path).cloned()
    }

    pub(crate) fn forget(&self, path: &Path) -> Option<String> {
        self.known.lock().unwrap().remove(path)
    }

    pub(crate) fn is_recent_app_write(&self, path: &Path, hash: &str) -> bool {
        let mut writes = self.app_writes.lock().unwrap();
        writes.retain(|(_, _, at)| at.elapsed() < APP_WRITE_TTL);
        writes.iter().any(|(p, h, _)| p == path && h == hash)
    }
}

/// The desktop file system. Cheap to share as `Rc<dyn FileSystem>`.
pub struct NativeFs {
    executor: Rc<dyn Executor>,
    shared: Arc<Shared>,
    /// Running watches by id: the files each wants content reported for.
    content: Rc<RefCell<HashMap<String, Arc<Mutex<Vec<PathBuf>>>>>>,
    debounce: Duration,
}

impl NativeFs {
    pub fn new(executor: Rc<dyn Executor>) -> Self {
        Self {
            executor,
            shared: Arc::default(),
            content: Rc::default(),
            debounce: Duration::from_millis(100),
        }
    }

    fn run<T: Send + 'static>(&self, work: impl FnOnce() -> T + Send + 'static) -> LocalBoxFuture<'static, T> {
        self.executor.blocking(work)
    }

    fn batch<T: Send + 'static>(
        &self,
        paths: Vec<String>,
        op: impl Fn(&str) -> FsResult<T> + Send + 'static,
    ) -> LocalBoxFuture<'static, BatchResult<T>> {
        self.run(move || {
            let mut out = BatchResult::default();
            for path in paths {
                match op(&path) {
                    Ok(v) => out.succeeded.push(v),
                    Err(e) => out.failed.push(e),
                }
            }
            out
        })
    }
}

fn io_err(err: std::io::Error, path: &str) -> FsError {
    FsError::from_io(&err, path)
}

fn ms(time: std::io::Result<std::time::SystemTime>) -> u64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn kind_of(meta: &std::fs::Metadata) -> EntryType {
    if meta.is_dir() { EntryType::Directory } else { EntryType::File }
}

/// Write via a temp file and a rename, so a reader never sees half a file.
/// The temp name ends in `.tmp`, which the watcher drops.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(".{name}.notefig-{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

/// To the OS trash; removal where there is none (or `NOTEFIG_NO_TRASH`).
/// On macOS through NSFileManager: the Finder route needs Automation
/// permission and can hang.
fn trash_or_remove(path: &Path, recursive: bool) -> std::io::Result<()> {
    let trashed = if std::env::var_os("NOTEFIG_NO_TRASH").is_some() {
        Err("trash disabled".to_string())
    } else {
        #[cfg(target_os = "macos")]
        {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            let mut ctx = trash::TrashContext::default();
            ctx.set_delete_method(DeleteMethod::NsFileManager);
            ctx.delete(path).map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "macos"))]
        {
            trash::delete(path).map_err(|e| e.to_string())
        }
    };
    match trashed {
        Ok(()) => Ok(()),
        Err(reason) => {
            log::debug!("trash failed for {}: {reason}; removing", path.display());
            if path.is_dir() {
                if recursive { std::fs::remove_dir_all(path) } else { std::fs::remove_dir(path) }
            } else {
                std::fs::remove_file(path)
            }
        }
    }
}

fn move_entry(from: &str, to: &str, want_dir: bool) -> FsResult<()> {
    let (a, b) = (Path::new(from), Path::new(to));
    let meta = std::fs::symlink_metadata(a).map_err(|e| io_err(e, from))?;
    if meta.is_dir() != want_dir {
        let kind = if want_dir { FsErrorKind::IsFile } else { FsErrorKind::IsDirectory };
        return Err(FsError::new(kind, from));
    }
    // A case-only rename on a case-insensitive disk sees its own target.
    let case_only = from.to_lowercase() == to.to_lowercase() && from != to;
    if b.exists() && !case_only {
        return Err(FsError::new(FsErrorKind::AlreadyExists, to));
    }
    if let Some(parent) = b.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_err(e, to))?;
    }
    std::fs::rename(a, b).map_err(|e| io_err(e, from))
}

/// The walk `read_directory` does (`walk_directory`): hidden entries by
/// position unless asked for, ignored directories pruned, ignored
/// extensions dropped. Symlinks are followed, as the Tauri walk does.
pub(crate) fn walk(root: &Path, options: &ReadDirectoryOptions) -> FsResult<Vec<DirectoryEntry>> {
    let root_str = root.to_string_lossy().to_string();
    let meta = std::fs::metadata(root).map_err(|e| io_err(e, &root_str))?;
    if !meta.is_dir() {
        return Err(FsError::new(FsErrorKind::IsFile, root_str));
    }
    let rules = Rules::new(options.ignore.as_ref());
    let include_hidden = options.include_hidden;
    let filter_rules = rules.clone();
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .standard_filters(false)
        .follow_links(true)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let Some(name) = entry.file_name().to_str() else { return false };
            if !include_hidden {
                let parent = entry.path().parent().and_then(|p| p.file_name()).and_then(|n| n.to_str());
                if is_hidden_child(parent, name) {
                    return false;
                }
            }
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            if is_dir { !filter_rules.is_ignored_directory(name) } else { !filter_rules.has_ignored_extension(name) }
        });
    if !options.recursive {
        builder.max_depth(Some(1));
    }
    let mut out = Vec::new();
    for item in builder.build() {
        let entry = match item {
            Ok(e) => e,
            Err(err) => {
                log::debug!("walk {}: {err}", root.display());
                continue;
            }
        };
        if entry.depth() == 0 {
            continue;
        }
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        if (is_dir && options.include_directories) || (!is_dir && options.include_files) {
            out.push(DirectoryEntry {
                path: entry.path().to_string_lossy().to_string(),
                kind: if is_dir { EntryType::Directory } else { EntryType::File },
            });
        }
    }
    Ok(out)
}

impl FileSystem for NativeFs {
    fn read_directory(&self, path: &str, options: ReadDirectoryOptions) -> LocalBoxFuture<'static, FsResult<Vec<DirectoryEntry>>> {
        let root = PathBuf::from(path);
        self.run(move || walk(&root, &options))
    }

    fn create_directories(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<String>> {
        let shared = self.shared.clone();
        self.batch(paths, move |p| {
            shared.register_app_write(Path::new(p), watch::DIR_MARK);
            std::fs::create_dir_all(p).map_err(|e| io_err(e, p))?;
            Ok(p.to_string())
        })
    }

    fn delete_directories(&self, paths: Vec<String>, recursive: bool) -> LocalBoxFuture<'static, BatchResult<String>> {
        self.batch(paths, move |p| {
            let path = Path::new(p);
            if !path.is_dir() {
                let kind = if path.exists() { FsErrorKind::IsFile } else { FsErrorKind::NotFound };
                return Err(FsError::new(kind, p));
            }
            trash_or_remove(path, recursive).map_err(|e| io_err(e, p))?;
            Ok(p.to_string())
        })
    }

    fn move_directory(&self, from: &str, to: &str) -> LocalBoxFuture<'static, FsResult<()>> {
        let (from, to) = (from.to_string(), to.to_string());
        self.run(move || move_entry(&from, &to, true))
    }

    fn read_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<(String, String)>> {
        let shared = self.shared.clone();
        self.batch(paths, move |p| {
            let bytes = std::fs::read(p).map_err(|e| io_err(e, p))?;
            let text = String::from_utf8(bytes).map_err(|_| FsError {
                kind: FsErrorKind::Unknown,
                path: p.to_string(),
                message: format!("not UTF-8 text: {p}"),
            })?;
            shared.remember(Path::new(p), &content_hash(&text));
            Ok((p.to_string(), text))
        })
    }

    fn read_binary_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<(String, Vec<u8>)>> {
        self.batch(paths, |p| Ok((p.to_string(), std::fs::read(p).map_err(|e| io_err(e, p))?)))
    }

    fn write_files(&self, files: Vec<(String, String)>) -> LocalBoxFuture<'static, BatchResult<String>> {
        let shared = self.shared.clone();
        self.run(move || {
            let mut out = BatchResult::default();
            for (path, content) in files {
                // Registered first: the echo can arrive before the rename returns.
                let hash = content_hash(&content);
                shared.register_app_write(Path::new(&path), &hash);
                shared.remember(Path::new(&path), &hash);
                match write_atomic(Path::new(&path), content.as_bytes()) {
                    Ok(()) => out.succeeded.push(path),
                    Err(e) => out.failed.push(io_err(e, &path)),
                }
            }
            out
        })
    }

    fn write_binary_files(&self, files: Vec<(String, Vec<u8>)>) -> LocalBoxFuture<'static, BatchResult<String>> {
        self.run(move || {
            let mut out = BatchResult::default();
            for (path, bytes) in files {
                match write_atomic(Path::new(&path), &bytes) {
                    Ok(()) => out.succeeded.push(path),
                    Err(e) => out.failed.push(io_err(e, &path)),
                }
            }
            out
        })
    }

    fn create_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<String>> {
        let shared = self.shared.clone();
        self.batch(paths, move |p| {
            let path = Path::new(p);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| io_err(e, p))?;
            }
            shared.register_app_write(path, &content_hash(""));
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|e| io_err(e, p))?;
            Ok(p.to_string())
        })
    }

    fn delete_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<String>> {
        self.batch(paths, |p| {
            let path = Path::new(p);
            match std::fs::symlink_metadata(path) {
                Ok(m) if m.is_dir() => return Err(FsError::new(FsErrorKind::IsDirectory, p)),
                Ok(_) => {}
                Err(e) => return Err(io_err(e, p)),
            }
            trash_or_remove(path, false).map_err(|e| io_err(e, p))?;
            Ok(p.to_string())
        })
    }

    fn move_file(&self, from: &str, to: &str) -> LocalBoxFuture<'static, FsResult<()>> {
        let (from, to) = (from.to_string(), to.to_string());
        self.run(move || move_entry(&from, &to, false))
    }

    fn copy_file(&self, from: &str, to: &str) -> LocalBoxFuture<'static, FsResult<()>> {
        let (from, to) = (from.to_string(), to.to_string());
        self.run(move || {
            if let Some(parent) = Path::new(&to).parent() {
                std::fs::create_dir_all(parent).map_err(|e| io_err(e, &to))?;
            }
            std::fs::copy(&from, &to).map(|_| ()).map_err(|e| io_err(e, &from))
        })
    }

    fn exists(&self, paths: Vec<String>) -> LocalBoxFuture<'static, Vec<(String, Option<EntryType>)>> {
        self.run(move || {
            paths
                .into_iter()
                .map(|p| {
                    let kind = std::fs::metadata(&p).ok().map(|m| kind_of(&m));
                    (p, kind)
                })
                .collect()
        })
    }

    fn metadata(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<FileMetadata>> {
        self.batch(paths, |p| {
            let m = std::fs::metadata(p).map_err(|e| io_err(e, p))?;
            Ok(FileMetadata {
                path: p.to_string(),
                kind: kind_of(&m),
                size: m.len(),
                modified_ms: ms(m.modified()),
                created_ms: ms(m.created()),
            })
        })
    }

    fn watch(
        &self,
        paths: Vec<String>,
        watch_id: &str,
        ignore: Option<IgnoreRules>,
        listener: Rc<dyn Fn(&FsChangeEvent)>,
    ) -> LocalBoxFuture<'static, FsResult<Subscription>> {
        let content_paths: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
        let config = watch::WatchConfig {
            roots: paths,
            watch_id: watch_id.to_string(),
            rules: Rules::new(ignore.as_ref()),
            shared: self.shared.clone(),
            debounce: self.debounce,
        };
        let started = self.run(move || watch::start(config));
        let executor = self.executor.clone();
        let registry = self.content.clone();
        let id = watch_id.to_string();
        async move {
            let (watcher, events) = started.await?;
            registry.borrow_mut().insert(id.clone(), content_paths);
            let alive = Rc::new(std::cell::Cell::new(true));
            let live = alive.clone();
            executor.spawn_local(async move {
                while let Ok(event) = events.recv().await {
                    if !live.get() {
                        break;
                    }
                    listener(&event);
                }
            });
            Ok(Subscription::new(move || {
                alive.set(false);
                registry.borrow_mut().remove(&id);
                // Stops the OS watch; the batching thread ends with it.
                drop(watcher);
            }))
        }
        .boxed_local()
    }

    /// Native divergence: like the Tauri recursive metadata watch, a native
    /// watch reports content changes for every file modified under its
    /// roots (git, search and project settings go stale off them), so this
    /// only records which files the caller has open.
    fn watch_content(&self, watch_id: &str, paths: Vec<String>) {
        if let Some(set) = self.content.borrow().get(watch_id) {
            *set.lock().unwrap() = paths.into_iter().map(PathBuf::from).collect();
        }
    }

    fn search_content(
        &self,
        directory: &str,
        options: SearchOptions,
        mut on_match: Box<dyn FnMut(SearchMatch)>,
    ) -> LocalBoxFuture<'static, FsResult<()>> {
        let (tx, rx) = async_channel::unbounded::<SearchMatch>();
        let dir = PathBuf::from(directory);
        let done = self.run(move || search::search(&dir, &options, |m| tx.send_blocking(m).is_ok()));
        async move {
            while let Ok(m) = rx.recv().await {
                on_match(m);
            }
            done.await
        }
        .boxed_local()
    }

    fn resolve_asset(&self, relative: &str, workspace: &str) -> String {
        let rel = Path::new(relative);
        if rel.is_absolute() {
            return relative.to_string();
        }
        Path::new(workspace).join(rel).to_string_lossy().to_string()
    }
}
