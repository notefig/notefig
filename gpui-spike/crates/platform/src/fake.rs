//! An in-memory platform for module tests, like the TS app's fakes over an
//! in-memory db. Files live in a map; [`FakeFs::external_write`] and
//! friends simulate changes made outside the app, which reach watchers.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::{Listeners, Subscription};

use crate::db::Db;
use crate::fs::*;
use crate::ui::{AppStatus, PlatformEvent, PlatformUi, TextPromptOptions};
use crate::Platform;

fn ready<T: 'static>(v: T) -> LocalBoxFuture<'static, T> {
    futures::future::ready(v).boxed_local()
}

fn parent(path: &str) -> Option<&str> {
    let trimmed = path.trim_end_matches('/');
    trimmed.rfind('/').map(|i| if i == 0 { "/" } else { &trimmed[..i] })
}

fn is_under(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches('/');
    path.len() > dir.len() && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'/'
}

struct Watch {
    id: String,
    roots: Vec<String>,
    content: BTreeSet<String>,
    listener: Rc<dyn Fn(&FsChangeEvent)>,
}

#[derive(Default)]
struct FsState {
    files: BTreeMap<String, Vec<u8>>,
    dirs: BTreeSet<String>,
    watches: Vec<(u64, Watch)>,
    next_watch: u64,
    trash: Vec<String>,
    writes: Vec<String>,
}

#[derive(Clone, Default)]
pub struct FakeFs {
    state: Rc<RefCell<FsState>>,
}

impl FakeFs {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed a file (and its parent folders) without notifying anyone.
    pub fn seed(&self, path: &str, content: &str) {
        let mut s = self.state.borrow_mut();
        let mut p = parent(path);
        while let Some(dir) = p {
            if dir == "/" {
                break;
            }
            s.dirs.insert(dir.to_string());
            p = parent(dir);
        }
        s.files.insert(path.to_string(), content.as_bytes().to_vec());
    }

    pub fn seed_dir(&self, path: &str) {
        self.seed(&format!("{path}/.keep"), "");
        self.state.borrow_mut().files.remove(&format!("{path}/.keep"));
    }

    pub fn read(&self, path: &str) -> Option<String> {
        self.state
            .borrow()
            .files
            .get(path)
            .map(|b| String::from_utf8_lossy(b).into_owned())
    }

    pub fn is_dir(&self, path: &str) -> bool {
        self.state.borrow().dirs.contains(path)
    }

    /// Paths moved to the trash, in order.
    pub fn trashed(&self) -> Vec<String> {
        self.state.borrow().trash.clone()
    }

    /// Paths written through the platform, in order.
    pub fn writes(&self) -> Vec<String> {
        self.state.borrow().writes.clone()
    }

    /// Someone else wrote `path`: watchers see the change.
    pub fn external_write(&self, path: &str, content: &str) {
        let existed = self.state.borrow().files.contains_key(path);
        self.seed(path, content);
        if !existed {
            self.emit_metadata(vec![MetadataChange {
                kind: MetadataChangeKind::Created,
                path: path.into(),
                is_directory: false,
            }]);
        }
        self.emit_content(path, content);
    }

    /// Someone else deleted `path` (a file or a folder).
    pub fn external_delete(&self, path: &str) {
        let is_dir = {
            let mut s = self.state.borrow_mut();
            let is_dir = s.dirs.remove(path);
            s.files.retain(|p, _| p != path && !is_under(p, path));
            s.dirs.retain(|p| !is_under(p, path));
            is_dir
        };
        self.emit_metadata(vec![MetadataChange {
            kind: MetadataChangeKind::Deleted,
            path: path.into(),
            is_directory: is_dir,
        }]);
    }

    /// Someone else renamed `from` to `to`.
    pub fn external_rename(&self, from: &str, to: &str) {
        let is_dir = self.state.borrow().dirs.contains(from);
        self.move_in_place(from, to);
        self.emit_metadata(vec![MetadataChange {
            kind: MetadataChangeKind::Renamed { old_path: from.into() },
            path: to.into(),
            is_directory: is_dir,
        }]);
    }

    fn watchers_for(&self, path: &str) -> Vec<(String, Rc<dyn Fn(&FsChangeEvent)>, bool)> {
        self.state
            .borrow()
            .watches
            .iter()
            .filter(|(_, w)| w.roots.iter().any(|r| is_under(path, r) || r == path))
            .map(|(_, w)| (w.id.clone(), w.listener.clone(), w.content.contains(path)))
            .collect()
    }

    fn emit_metadata(&self, changes: Vec<MetadataChange>) {
        let Some(first) = changes.first() else { return };
        for (id, listener, _) in self.watchers_for(&first.path) {
            listener(&FsChangeEvent::Metadata {
                watch_id: id,
                changes: changes.clone(),
            });
        }
    }

    fn emit_content(&self, path: &str, content: &str) {
        for (id, listener, wants_content) in self.watchers_for(path) {
            if wants_content {
                listener(&FsChangeEvent::Content {
                    watch_id: id,
                    changes: vec![ContentChange {
                        path: path.into(),
                        content: content.into(),
                        content_hash: content_hash(content),
                    }],
                });
            }
        }
    }

    fn move_in_place(&self, from: &str, to: &str) {
        let mut s = self.state.borrow_mut();
        let moved: Vec<(String, Vec<u8>)> = s
            .files
            .iter()
            .filter(|(p, _)| *p == from || is_under(p, from))
            .map(|(p, c)| (p.clone(), c.clone()))
            .collect();
        for (p, c) in moved {
            s.files.remove(&p);
            s.files.insert(format!("{to}{}", &p[from.len()..]), c);
        }
        let dirs: Vec<String> = s
            .dirs
            .iter()
            .filter(|p| *p == from || is_under(p, from))
            .cloned()
            .collect();
        for d in dirs {
            s.dirs.remove(&d);
            s.dirs.insert(format!("{to}{}", &d[from.len()..]));
        }
    }

    fn kind_of(&self, path: &str) -> Option<EntryType> {
        let s = self.state.borrow();
        if s.files.contains_key(path) {
            Some(EntryType::File)
        } else if s.dirs.contains(path) || s.files.keys().any(|p| is_under(p, path)) {
            Some(EntryType::Directory)
        } else {
            None
        }
    }
}

/// Hidden by position, as the native walk decides (`walkdir_utils.rs`):
/// dot-named, except the app dir `.notefig`, of whose children only
/// `scratchpads` shows.
fn hidden_child(parent: Option<&str>, name: &str) -> bool {
    if parent == Some(".notefig") {
        return name != "scratchpads";
    }
    name.starts_with('.') && name.len() > 1 && name != ".notefig"
}

/// Whether any component of `rel` (relative to `root`) is hidden.
fn hidden_rel(root: &str, rel: &str) -> bool {
    let mut parent = root.trim_end_matches('/').rsplit('/').next().filter(|s| !s.is_empty());
    for part in rel.split('/') {
        if hidden_child(parent, part) {
            return true;
        }
        parent = Some(part);
    }
    false
}

impl FileSystem for FakeFs {
    fn read_directory(&self, path: &str, options: ReadDirectoryOptions) -> LocalBoxFuture<'static, FsResult<Vec<DirectoryEntry>>> {
        if self.kind_of(path) != Some(EntryType::Directory) {
            return ready(Err(FsError::new(FsErrorKind::NotFound, path)));
        }
        let s = self.state.borrow();
        let root = path.trim_end_matches('/');
        let ignored = |rel: &str| -> bool {
            let parts: Vec<&str> = rel.split('/').collect();
            if !options.include_hidden && hidden_rel(root, rel) {
                return true;
            }
            if let Some(ignore) = &options.ignore {
                if parts[..parts.len() - 1].iter().chain(std::iter::once(parts.last().unwrap()))
                    .any(|p| ignore.directories.iter().any(|d| d == p))
                {
                    return true;
                }
            }
            false
        };
        let mut out = Vec::new();
        let mut seen_dirs: BTreeSet<String> = BTreeSet::new();
        let mut add_dir = |dir: &str, out: &mut Vec<DirectoryEntry>| {
            if seen_dirs.insert(dir.to_string()) && options.include_directories {
                out.push(DirectoryEntry { path: dir.to_string(), kind: EntryType::Directory });
            }
        };
        let candidates: Vec<(String, bool)> = s
            .dirs
            .iter()
            .map(|d| (d.clone(), true))
            .chain(s.files.keys().map(|f| (f.clone(), false)))
            .filter(|(p, _)| is_under(p, root))
            .collect();
        for (p, is_dir) in candidates {
            let rel = &p[root.len() + 1..];
            if ignored(rel) {
                continue;
            }
            let depth = rel.matches('/').count();
            if !options.recursive && depth > 0 {
                // The first segment is a direct child folder.
                let first = rel.split('/').next().unwrap();
                add_dir(&format!("{root}/{first}"), &mut out);
                continue;
            }
            if options.recursive {
                // Implied parent folders.
                let mut acc = root.to_string();
                for seg in rel.split('/').take(depth) {
                    acc = format!("{acc}/{seg}");
                    add_dir(&acc, &mut out);
                }
            }
            if is_dir {
                add_dir(&p, &mut out);
            } else if options.include_files {
                if let Some(ignore) = &options.ignore
                    && ignore.extensions.iter().any(|e| p.ends_with(&format!(".{}", e.trim_start_matches('.'))))
                {
                    continue;
                }
                out.push(DirectoryEntry { path: p.clone(), kind: EntryType::File });
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        ready(Ok(out))
    }

    fn create_directories(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<String>> {
        let mut result = BatchResult::default();
        for p in paths {
            self.seed_dir(&p);
            result.succeeded.push(p);
        }
        ready(result)
    }

    fn delete_directories(&self, paths: Vec<String>, _recursive: bool) -> LocalBoxFuture<'static, BatchResult<String>> {
        let mut result = BatchResult::default();
        for p in paths {
            if self.kind_of(&p) != Some(EntryType::Directory) {
                result.failed.push(FsError::new(FsErrorKind::NotFound, &p));
                continue;
            }
            {
                let mut s = self.state.borrow_mut();
                s.dirs.retain(|d| d != &p && !is_under(d, &p));
                s.files.retain(|f, _| !is_under(f, &p));
                s.trash.push(p.clone());
            }
            result.succeeded.push(p);
        }
        ready(result)
    }

    fn move_directory(&self, from: &str, to: &str) -> LocalBoxFuture<'static, FsResult<()>> {
        if self.kind_of(from) != Some(EntryType::Directory) {
            return ready(Err(FsError::new(FsErrorKind::NotFound, from)));
        }
        if self.kind_of(to).is_some() {
            return ready(Err(FsError::new(FsErrorKind::AlreadyExists, to)));
        }
        self.move_in_place(from, to);
        ready(Ok(()))
    }

    fn read_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<(String, String)>> {
        let mut result = BatchResult::default();
        for p in paths {
            match self.read(&p) {
                Some(c) => result.succeeded.push((p, c)),
                None => result.failed.push(FsError::new(FsErrorKind::NotFound, &p)),
            }
        }
        ready(result)
    }

    fn read_binary_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<(String, Vec<u8>)>> {
        let mut result = BatchResult::default();
        for p in paths {
            match self.state.borrow().files.get(&p) {
                Some(c) => result.succeeded.push((p, c.clone())),
                None => result.failed.push(FsError::new(FsErrorKind::NotFound, &p)),
            }
        }
        ready(result)
    }

    fn write_files(&self, files: Vec<(String, String)>) -> LocalBoxFuture<'static, BatchResult<String>> {
        let mut result = BatchResult::default();
        for (p, c) in files {
            self.seed(&p, &c);
            self.state.borrow_mut().writes.push(p.clone());
            result.succeeded.push(p);
        }
        ready(result)
    }

    fn write_binary_files(&self, files: Vec<(String, Vec<u8>)>) -> LocalBoxFuture<'static, BatchResult<String>> {
        let mut result = BatchResult::default();
        for (p, c) in files {
            self.seed(&p, "");
            let mut s = self.state.borrow_mut();
            s.files.insert(p.clone(), c);
            s.writes.push(p.clone());
            result.succeeded.push(p);
        }
        ready(result)
    }

    fn create_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<String>> {
        let mut result = BatchResult::default();
        for p in paths {
            if self.kind_of(&p).is_some() {
                result.failed.push(FsError::new(FsErrorKind::AlreadyExists, &p));
            } else {
                self.seed(&p, "");
                result.succeeded.push(p);
            }
        }
        ready(result)
    }

    fn delete_files(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<String>> {
        let mut result = BatchResult::default();
        for p in paths {
            let removed = self.state.borrow_mut().files.remove(&p).is_some();
            if removed {
                self.state.borrow_mut().trash.push(p.clone());
                result.succeeded.push(p);
            } else {
                result.failed.push(FsError::new(FsErrorKind::NotFound, &p));
            }
        }
        ready(result)
    }

    fn move_file(&self, from: &str, to: &str) -> LocalBoxFuture<'static, FsResult<()>> {
        if self.kind_of(from) != Some(EntryType::File) {
            return ready(Err(FsError::new(FsErrorKind::NotFound, from)));
        }
        if self.kind_of(to).is_some() {
            return ready(Err(FsError::new(FsErrorKind::AlreadyExists, to)));
        }
        let content = self.state.borrow_mut().files.remove(from).unwrap();
        self.seed(to, "");
        self.state.borrow_mut().files.insert(to.into(), content);
        ready(Ok(()))
    }

    fn copy_file(&self, from: &str, to: &str) -> LocalBoxFuture<'static, FsResult<()>> {
        let Some(content) = self.state.borrow().files.get(from).cloned() else {
            return ready(Err(FsError::new(FsErrorKind::NotFound, from)));
        };
        self.seed(to, "");
        self.state.borrow_mut().files.insert(to.into(), content);
        ready(Ok(()))
    }

    fn exists(&self, paths: Vec<String>) -> LocalBoxFuture<'static, Vec<(String, Option<EntryType>)>> {
        ready(paths.into_iter().map(|p| { let k = self.kind_of(&p); (p, k) }).collect())
    }

    fn metadata(&self, paths: Vec<String>) -> LocalBoxFuture<'static, BatchResult<FileMetadata>> {
        let mut result = BatchResult::default();
        for p in paths {
            match self.kind_of(&p) {
                Some(kind) => {
                    let size = self.state.borrow().files.get(&p).map(|c| c.len() as u64).unwrap_or(0);
                    result.succeeded.push(FileMetadata { path: p, kind, size, modified_ms: 0, created_ms: 0 });
                }
                None => result.failed.push(FsError::new(FsErrorKind::NotFound, &p)),
            }
        }
        ready(result)
    }

    fn watch(
        &self,
        paths: Vec<String>,
        watch_id: &str,
        _ignore: Option<IgnoreRules>,
        listener: Rc<dyn Fn(&FsChangeEvent)>,
    ) -> LocalBoxFuture<'static, FsResult<Subscription>> {
        let id = {
            let mut s = self.state.borrow_mut();
            s.next_watch += 1;
            let id = s.next_watch;
            s.watches.push((
                id,
                Watch { id: watch_id.into(), roots: paths, content: BTreeSet::new(), listener },
            ));
            id
        };
        let weak = Rc::downgrade(&self.state);
        ready(Ok(Subscription::new(move || {
            if let Some(state) = weak.upgrade() {
                state.borrow_mut().watches.retain(|(i, _)| *i != id);
            }
        })))
    }

    /// Replaces the watch's set, as the native watch does.
    fn watch_content(&self, watch_id: &str, paths: Vec<String>) {
        for (_, w) in self.state.borrow_mut().watches.iter_mut() {
            if w.id == watch_id {
                w.content = paths.iter().cloned().collect();
            }
        }
    }

    fn search_content(
        &self,
        directory: &str,
        options: SearchOptions,
        mut on_match: Box<dyn FnMut(SearchMatch)>,
    ) -> LocalBoxFuture<'static, FsResult<()>> {
        let files: Vec<(String, String)> = self
            .state
            .borrow()
            .files
            .iter()
            .filter(|(p, _)| is_under(p, directory))
            .map(|(p, c)| (p.clone(), String::from_utf8_lossy(c).into_owned()))
            .collect();
        let needle = if options.case_sensitive { options.query.clone() } else { options.query.to_lowercase() };
        let mut count = 0;
        for (path, content) in files {
            let mut occurrence = 0;
            for (i, line) in content.lines().enumerate() {
                let hay = if options.case_sensitive { line.to_string() } else { line.to_lowercase() };
                let mut from = 0;
                while let Some(at) = hay[from..].find(&needle) {
                    if needle.is_empty() {
                        break;
                    }
                    let start = from + at;
                    on_match(SearchMatch {
                        file_path: path.clone(),
                        match_text: line[start..start + needle.len()].to_string(),
                        line_text: line.to_string(),
                        line: i as u32 + 1,
                        occurrence,
                    });
                    occurrence += 1;
                    count += 1;
                    if options.max_results.is_some_and(|m| count >= m) {
                        return ready(Ok(()));
                    }
                    from = start + needle.len();
                }
            }
        }
        ready(Ok(()))
    }

    fn resolve_asset(&self, relative: &str, workspace: &str) -> String {
        format!("{}/{}", workspace.trim_end_matches('/'), relative)
    }
}

#[derive(Default)]
pub struct FakeDb {
    collections: RefCell<HashMap<String, BTreeMap<String, serde_json::Value>>>,
}

impl FakeDb {
    pub fn snapshot(&self, collection: &str) -> BTreeMap<String, serde_json::Value> {
        self.collections.borrow().get(collection).cloned().unwrap_or_default()
    }
}

impl Db for FakeDb {
    fn load(&self, collection: &str) -> LocalBoxFuture<'static, anyhow::Result<Vec<(String, serde_json::Value)>>> {
        ready(Ok(self.snapshot(collection).into_iter().collect()))
    }
    fn put(&self, collection: &str, key: &str, value: serde_json::Value) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        self.collections.borrow_mut().entry(collection.into()).or_default().insert(key.into(), value);
        ready(Ok(()))
    }
    fn delete(&self, collection: &str, key: &str) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        if let Some(c) = self.collections.borrow_mut().get_mut(collection) {
            c.remove(key);
        }
        ready(Ok(()))
    }
    fn clear(&self, collection: &str) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        self.collections.borrow_mut().remove(collection);
        ready(Ok(()))
    }
}

#[derive(Default)]
pub struct FakeUi {
    /// What `pick_directory` answers next.
    pub next_directory: RefCell<Option<String>>,
    /// What `prompt_text` answers next.
    pub next_text: RefCell<Option<String>>,
    pub opened: RefCell<Vec<String>>,
    pub statuses: RefCell<Vec<AppStatus>>,
    listeners: Listeners<PlatformEvent>,
}

impl FakeUi {
    pub fn emit(&self, event: PlatformEvent) {
        self.listeners.notify(&event);
    }
}

impl PlatformUi for FakeUi {
    fn pick_directory(&self, _title: &str) -> LocalBoxFuture<'static, Option<String>> {
        ready(self.next_directory.borrow_mut().take())
    }
    fn prompt_text(&self, _options: TextPromptOptions) -> LocalBoxFuture<'static, Option<String>> {
        ready(self.next_text.borrow_mut().take())
    }
    fn open_external(&self, url: &str) {
        self.opened.borrow_mut().push(url.into());
    }
    fn reveal_in_file_manager(&self, path: &str) {
        self.opened.borrow_mut().push(format!("reveal:{path}"));
    }
    fn toggle_fullscreen(&self) {}
    fn publish_app_status(&self, status: AppStatus) {
        self.statuses.borrow_mut().push(status);
    }
    fn subscribe(&self, listener: Box<dyn Fn(&PlatformEvent)>) -> Subscription {
        self.listeners.subscribe(move |e| listener(e))
    }
}

/// A whole fake platform, plus typed handles to its parts.
pub struct FakePlatform {
    pub platform: Rc<Platform>,
    pub fs: FakeFs,
    pub db: Rc<FakeDb>,
    pub ui: Rc<FakeUi>,
}

impl FakePlatform {
    pub fn new() -> Self {
        let fs = FakeFs::new();
        let db = Rc::new(FakeDb::default());
        let ui = Rc::new(FakeUi::default());
        let platform = Rc::new(Platform {
            fs: Rc::new(fs.clone()),
            db: db.clone(),
            ui: ui.clone(),
            updates: Rc::new(crate::updates::NoopUpdater),
            app_data_dir: "/app-data".into(),
        });
        Self { platform, fs, db, ui }
    }
}

impl Default for FakePlatform {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;

    #[test]
    fn lists_seeded_files_with_implied_folders() {
        let fs = FakeFs::new();
        fs.seed("/ws/a.md", "a");
        fs.seed("/ws/docs/b.md", "b");
        fs.seed("/ws/.notefig/x.md", "x");
        fs.seed("/ws/.git/HEAD", "x");
        fs.seed("/ws/.notefig/scratchpads/s.md", "s");
        let all = block_on(fs.read_directory("/ws", ReadDirectoryOptions::all_recursive())).unwrap();
        let paths: Vec<_> = all.iter().map(|e| e.path.as_str()).collect();
        // Hidden by position: the app dir and its scratchpads show.
        assert_eq!(
            paths,
            vec!["/ws/.notefig", "/ws/.notefig/scratchpads", "/ws/.notefig/scratchpads/s.md", "/ws/a.md", "/ws/docs", "/ws/docs/b.md"]
        );
        let top = block_on(fs.read_directory(
            "/ws",
            ReadDirectoryOptions { include_files: true, include_directories: true, include_hidden: true, ..Default::default() },
        ))
        .unwrap();
        let paths: Vec<_> = top.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["/ws/.git", "/ws/.notefig", "/ws/a.md", "/ws/docs"]);
    }

    #[test]
    fn db_loads_a_numeric_range() {
        let db = FakeDb::default();
        for (key, hour) in [("a", 1), ("b", 2), ("c", 3)] {
            block_on(db.put("usage-buckets", key, serde_json::json!({ "hour": hour }))).unwrap();
        }
        block_on(db.put("usage-buckets", "x", serde_json::json!({ "other": 2 }))).unwrap();
        let rows = block_on(db.load_range("usage-buckets", "hour", 2.0, 4.0)).unwrap();
        assert_eq!(rows.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), vec!["b", "c"]);
    }

    #[test]
    fn external_changes_reach_watchers() {
        let fs = FakeFs::new();
        fs.seed("/ws/a.md", "a");
        let seen: Rc<RefCell<Vec<FsChangeEvent>>> = Rc::default();
        let sink = seen.clone();
        let sub = block_on(fs.watch(vec!["/ws".into()], "w", None, Rc::new(move |e| sink.borrow_mut().push(e.clone())))).unwrap();
        fs.watch_content("w", vec!["/ws/a.md".into()]);
        fs.external_write("/ws/a.md", "changed");
        fs.external_write("/ws/new.md", "new");
        assert_eq!(seen.borrow().len(), 2);
        drop(sub);
        fs.external_delete("/ws/new.md");
        assert_eq!(seen.borrow().len(), 2);
    }
}
