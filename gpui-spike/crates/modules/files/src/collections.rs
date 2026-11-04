//! A workspace's two row sets (`files.ts`, `metadata-collection.ts`):
//!
//! 1. [`MetadataCollection`] — every entry's type, size, modified, hash;
//!    NOT content. Synced from the listing walk, so the tree shows at once.
//! 2. [`ContentCollection`] — path + content only, loaded on demand for the
//!    paths something asks for (an open tab).
//!
//! The TS app holds these in TanStack DB collections over TanStack Query.
//! Here they are plain maps behind `RefCell`, with the same write rules:
//! a walk diffs its listing against the synced rows once, and a direct
//! write touches only its rows. Readers subscribe and read synchronously.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Instant;

use notefig_core::{Listeners, Subscription};
use notefig_platform::{EntryType, FsError};

/// One entry of the listing. Excludes content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMetadata {
    /// Absolute native path: the key.
    pub path: String,
    /// Relative to the workspace, `/`-separated; `None` for a loose file.
    pub relative_path: Option<String>,
    pub kind: EntryType,
    /// Milliseconds since the epoch, once stat'd (stats hydrate lazily).
    pub modified_ms: Option<u64>,
    pub size: Option<u64>,
    /// `""` until a write or read sets it.
    pub content_hash: String,
    pub error: Option<String>,
}

impl FileMetadata {
    pub fn is_dir(&self) -> bool {
        self.kind == EntryType::Directory
    }
}

/// A loaded file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileContent {
    pub path: String,
    pub content: Rc<str>,
    pub content_hash: String,
    /// Set when the read failed: `content` is NOT the file's content, so
    /// an editor must never mount from (or save over) this row.
    pub error: Option<String>,
}

pub(crate) enum Write {
    Upsert(Rc<FileMetadata>),
    Delete(String),
}

impl Write {
    fn key(&self) -> &str {
        match self {
            Write::Upsert(row) => &row.path,
            Write::Delete(path) => path,
        }
    }
}

/// Where the listing walk stands (the TS query's fetch state).
#[derive(Debug, Clone, Default)]
pub struct FetchState {
    pub fetching: bool,
    /// The last walk's failure, typed so the shell can recognize a lost
    /// folder (`FsError::is_workspace_access_error`).
    pub error: Option<FsError>,
    pub updated_at: Option<Instant>,
}

#[derive(Default)]
struct MetaState {
    rows: HashMap<String, Rc<FileMetadata>>,
    /// The paths the last landed walk listed: a walk only drops rows an
    /// earlier walk listed, so a row written for a path no walk sees (an
    /// ignored one) stays.
    listed: HashSet<String>,
    /// Rows written directly since the running walk started: its listing
    /// may predate them, so it neither drops nor overwrites them.
    written_during_walk: HashSet<String>,
    batch: Option<Vec<Write>>,
    ready: bool,
    fetch: FetchState,
}

/// The metadata rows of one workspace.
#[derive(Default)]
pub struct MetadataCollection {
    state: RefCell<MetaState>,
    version: Cell<u64>,
    changed: Listeners<()>,
}

impl MetadataCollection {
    pub fn get(&self, path: &str) -> Option<Rc<FileMetadata>> {
        self.state.borrow().rows.get(path).cloned()
    }

    pub fn contains(&self, path: &str) -> bool {
        self.state.borrow().rows.contains_key(path)
    }

    /// Every row, in no particular order.
    pub fn rows(&self) -> Vec<Rc<FileMetadata>> {
        self.state.borrow().rows.values().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.state.borrow().rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The first walk landed (or failed): rows are what disk had.
    pub fn is_ready(&self) -> bool {
        self.state.borrow().ready
    }

    /// Bumps on every change: a cache key for derived state.
    pub fn version(&self) -> u64 {
        self.version.get()
    }

    pub fn fetch_state(&self) -> FetchState {
        self.state.borrow().fetch.clone()
    }

    pub fn is_fetching(&self) -> bool {
        self.state.borrow().fetch.fetching
    }

    /// Called after every change to the rows or the fetch state.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }

    fn notify(&self) {
        self.version.set(self.version.get() + 1);
        self.changed.emit();
    }

    pub(crate) fn set_fetch(&self, update: impl FnOnce(&mut FetchState)) {
        update(&mut self.state.borrow_mut().fetch);
        self.notify();
    }

    pub(crate) fn mark_ready(&self) {
        let was = std::mem::replace(&mut self.state.borrow_mut().ready, true);
        if !was {
            self.notify();
        }
    }

    fn apply(&self, writes: Vec<Write>) {
        if writes.is_empty() {
            return;
        }
        {
            let mut state = self.state.borrow_mut();
            for write in writes {
                match write {
                    Write::Upsert(row) => {
                        state.rows.insert(row.path.clone(), row);
                    }
                    Write::Delete(path) => {
                        state.rows.remove(&path);
                    }
                }
            }
        }
        self.notify();
    }

    fn direct(&self, writes: Vec<Write>) {
        let pending = {
            let mut state = self.state.borrow_mut();
            for w in &writes {
                let key = w.key().to_string();
                state.written_during_walk.insert(key);
            }
            match state.batch.as_mut() {
                Some(batch) => {
                    batch.extend(writes);
                    None
                }
                None => Some(writes),
            }
        };
        if let Some(writes) = pending {
            self.apply(writes);
        }
    }

    pub(crate) fn write_upsert(&self, row: FileMetadata) {
        self.direct(vec![Write::Upsert(Rc::new(row))]);
    }

    pub(crate) fn write_upsert_many(&self, rows: Vec<FileMetadata>) {
        self.direct(rows.into_iter().map(|r| Write::Upsert(Rc::new(r))).collect());
    }

    pub(crate) fn write_delete(&self, path: &str) {
        self.direct(vec![Write::Delete(path.to_string())]);
    }

    /// The writes made in `f`, applied as one change.
    pub(crate) fn write_batch(&self, f: impl FnOnce()) {
        {
            let mut state = self.state.borrow_mut();
            assert!(state.batch.is_none(), "write_batch calls do not nest");
            state.batch = Some(Vec::new());
        }
        f();
        let writes = self.state.borrow_mut().batch.take().unwrap_or_default();
        self.apply(writes);
    }

    pub(crate) fn begin_walk(&self) {
        self.state.borrow_mut().written_during_walk.clear();
    }

    /// The previous row, for a walk merging its listing.
    pub(crate) fn synced(&self, path: &str) -> Option<Rc<FileMetadata>> {
        self.get(path)
    }

    /// A landed walk: its listing is disk truth, except for rows written
    /// since it started.
    pub(crate) fn reconcile(&self, rows: Vec<Rc<FileMetadata>>) {
        let writes = {
            let mut state = self.state.borrow_mut();
            let mut seen = HashSet::with_capacity(rows.len());
            let mut writes = Vec::new();
            for row in rows {
                seen.insert(row.path.clone());
                if state.written_during_walk.contains(&row.path) {
                    continue;
                }
                if state.rows.get(&row.path).is_some_and(|r| Rc::ptr_eq(r, &row)) {
                    continue;
                }
                writes.push(Write::Upsert(row));
            }
            let listed = std::mem::take(&mut state.listed);
            for path in listed {
                if seen.contains(&path) {
                    continue;
                }
                // Written since this walk started, so its absence may be
                // stale: keep it listed and let the next walk decide.
                if state.written_during_walk.contains(&path) {
                    seen.insert(path);
                } else if state.rows.contains_key(&path) {
                    writes.push(Write::Delete(path));
                }
            }
            state.listed = seen;
            writes
        };
        self.apply(writes);
    }

    pub(crate) fn clear(&self) {
        {
            let mut state = self.state.borrow_mut();
            state.rows.clear();
            state.listed.clear();
            state.written_during_walk.clear();
            state.ready = false;
            state.fetch = FetchState::default();
        }
        self.notify();
    }
}

/// The loaded files of one workspace.
#[derive(Default)]
pub struct ContentCollection {
    rows: RefCell<HashMap<String, Rc<FileContent>>>,
    /// Paths with a read in flight.
    loading: RefCell<HashSet<String>>,
    version: Cell<u64>,
    changed: Listeners<()>,
}

impl ContentCollection {
    pub fn get(&self, path: &str) -> Option<Rc<FileContent>> {
        self.rows.borrow().get(path).cloned()
    }

    pub fn contains(&self, path: &str) -> bool {
        self.rows.borrow().contains_key(path)
    }

    pub fn is_loading(&self, path: &str) -> bool {
        self.loading.borrow().contains(path)
    }

    /// Whether any on-demand load is in flight (`useContentFetching`).
    pub fn is_fetching(&self) -> bool {
        !self.loading.borrow().is_empty()
    }

    pub fn version(&self) -> u64 {
        self.version.get()
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }

    fn notify(&self) {
        self.version.set(self.version.get() + 1);
        self.changed.emit();
    }

    pub(crate) fn write_upsert(&self, row: FileContent) {
        self.rows.borrow_mut().insert(row.path.clone(), Rc::new(row));
        self.notify();
    }

    pub(crate) fn write_delete(&self, path: &str) {
        if self.rows.borrow_mut().remove(path).is_some() {
            self.notify();
        }
    }

    pub(crate) fn restore(&self, path: &str, previous: Option<Rc<FileContent>>) {
        match previous {
            Some(row) => {
                self.rows.borrow_mut().insert(path.to_string(), row);
            }
            None => {
                self.rows.borrow_mut().remove(path);
            }
        }
        self.notify();
    }

    /// Mark paths as loading; returns those not already loaded or loading.
    pub(crate) fn claim(&self, paths: &[String]) -> Vec<String> {
        let rows = self.rows.borrow();
        let mut loading = self.loading.borrow_mut();
        let claimed: Vec<String> = paths
            .iter()
            .filter(|p| !rows.contains_key(*p) && !loading.contains(*p))
            .cloned()
            .collect();
        loading.extend(claimed.iter().cloned());
        claimed
    }

    pub(crate) fn finish_loading(&self, paths: &[String], rows: Vec<FileContent>) {
        {
            let mut loading = self.loading.borrow_mut();
            for p in paths {
                loading.remove(p);
            }
            let mut map = self.rows.borrow_mut();
            for row in rows {
                // A write that landed while we read wins.
                map.entry(row.path.clone()).or_insert_with(|| Rc::new(row));
            }
        }
        self.notify();
    }

    pub(crate) fn clear(&self) {
        self.rows.borrow_mut().clear();
        self.loading.borrow_mut().clear();
        self.notify();
    }
}
