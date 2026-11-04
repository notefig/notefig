//! The watcher (`file_watcher.rs`): `notify` on the roots, a short debounce,
//! hidden/ignore filtering scoped to this watch, own-write echo
//! suppression by content hash, and rename pairing.
//!
//! Raw events are folded per path over a debounce window, then each path
//! is judged against the disk as it is now. FSEvents rarely pairs a rename
//! (it reports both ends as separate `Name(Any)` events), so a vanished
//! file and an appeared file with the same content in one batch are paired
//! as a rename by hash, as the first spike's watcher did.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notefig_platform::{
    ContentChange, FsChangeEvent, FsError, FsErrorKind, FsResult, MetadataChange, MetadataChangeKind,
    content_hash,
};
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher as _};

use crate::fs::Shared;
use crate::rules::{Rules, has_hidden_component};

/// Files larger than this are reported without reading them.
const HASH_LIMIT: u64 = 8 * 1024 * 1024;

/// What [`Shared::register_app_write`] records for a folder this app made.
pub(crate) const DIR_MARK: &str = "<dir>";

pub(crate) struct WatchConfig {
    pub roots: Vec<String>,
    pub watch_id: String,
    pub rules: Rules,
    pub shared: Arc<Shared>,
    pub debounce: Duration,
}

enum Raw {
    Path(PathBuf, Flags),
    Pair(PathBuf, PathBuf),
}

#[derive(Default, Clone, Copy, Debug)]
struct Flags {
    created: bool,
    removed: bool,
    modified: bool,
    renamed: bool,
}

impl Flags {
    fn merge(&mut self, o: Flags) {
        self.created |= o.created;
        self.removed |= o.removed;
        self.modified |= o.modified;
        self.renamed |= o.renamed;
    }
}

/// A root as the caller spelled it, and as the OS reports it.
struct Root {
    given: PathBuf,
    canonical: PathBuf,
}

pub(crate) struct Judge {
    roots: Vec<Root>,
    rules: Rules,
    shared: Arc<Shared>,
}

impl Judge {
    fn new(config: &WatchConfig) -> Self {
        let roots = config
            .roots
            .iter()
            .map(|r| {
                let given = PathBuf::from(r);
                let canonical = std::fs::canonicalize(&given).unwrap_or_else(|_| given.clone());
                Root { given, canonical }
            })
            .collect();
        Self { roots, rules: config.rules.clone(), shared: config.shared.clone() }
    }

    /// The path in the caller's spelling, if it is under a root and not
    /// hidden, ignored, or a temp file.
    fn accept(&self, path: &Path) -> Option<PathBuf> {
        let (given, rel) = self.roots.iter().find_map(|root| {
            for base in [&root.canonical, &root.given] {
                if let Ok(rel) = path.strip_prefix(base) {
                    return Some((root.given.clone(), rel.to_path_buf()));
                }
            }
            None
        })?;
        if rel.as_os_str().is_empty() || has_hidden_component(&rel) || self.rules.is_ignored_rel(&rel) {
            return None;
        }
        if rel.extension().is_some_and(|e| e == "tmp") || rel.to_string_lossy().ends_with(".crswap") {
            return None;
        }
        Some(given.join(rel))
    }

    /// The file's content and hash, unless too large or not text.
    fn read(&self, path: &Path) -> Option<(String, String)> {
        let meta = std::fs::metadata(path).ok()?;
        if !meta.is_file() || meta.len() > HASH_LIMIT {
            return None;
        }
        let text = String::from_utf8(std::fs::read(path).ok()?).ok()?;
        let hash = content_hash(&text);
        Some((text, hash))
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    /// A directory's accepted descendants, for a renamed directory.
    fn descendants(&self, dir: &Path) -> Vec<(PathBuf, bool)> {
        let mut out = Vec::new();
        for entry in ignore::WalkBuilder::new(dir).standard_filters(false).build().flatten() {
            if entry.depth() == 0 {
                continue;
            }
            if let Some(p) = self.accept(entry.path()) {
                out.push((p, entry.file_type().is_some_and(|t| t.is_dir())));
            }
        }
        out
    }

    fn renamed(&mut self, meta: &mut Vec<MetadataChange>, from: &Path, to: &Path, is_dir: bool) {
        meta.push(MetadataChange {
            kind: MetadataChangeKind::Renamed { old_path: Self::s(from) },
            path: Self::s(to),
            is_directory: is_dir,
        });
        if let Some(h) = self.shared.forget(from) {
            self.shared.remember(to, &h);
        }
        if is_dir {
            for (child, child_dir) in self.descendants(to) {
                let suffix = child.strip_prefix(to).unwrap_or(&child);
                let old = from.join(suffix);
                if let Some(h) = self.shared.forget(&old) {
                    self.shared.remember(&child, &h);
                }
                meta.push(MetadataChange {
                    kind: MetadataChangeKind::Renamed { old_path: Self::s(&old) },
                    path: Self::s(&child),
                    is_directory: child_dir,
                });
            }
        }
    }

    /// Turn one debounced batch into events.
    fn judge(&mut self, paths: BTreeMap<PathBuf, Flags>, pairs: Vec<(PathBuf, PathBuf)>, watch_id: &str) -> Vec<FsChangeEvent> {
        let mut meta = Vec::new();
        let mut content = Vec::new();

        // Paired renames (`Name(Both)`), judged per end as the Tauri watch does.
        for (from, to) in pairs {
            let (a, b) = (self.accept(&from), self.accept(&to));
            match (a, b) {
                (None, None) => {}
                (Some(old), None) => meta.push(MetadataChange {
                    kind: MetadataChangeKind::Deleted,
                    path: Self::s(&old),
                    is_directory: to.is_dir(),
                }),
                (None, Some(new)) => meta.push(MetadataChange {
                    kind: MetadataChangeKind::Created,
                    path: Self::s(&new),
                    is_directory: new.is_dir(),
                }),
                (Some(old), Some(new)) => {
                    let is_dir = new.is_dir();
                    self.renamed(&mut meta, &old, &new, is_dir);
                }
            }
        }

        let mut gone: Vec<PathBuf> = Vec::new();
        let mut appeared: Vec<(PathBuf, bool, Option<(String, String)>)> = Vec::new();
        for (raw, flags) in paths {
            let Some(path) = self.accept(&raw) else { continue };
            match std::fs::symlink_metadata(&path) {
                Err(_) => gone.push(path),
                Ok(m) if m.is_dir() => {
                    if flags.created || flags.renamed {
                        appeared.push((path, true, None));
                    }
                }
                Ok(_) => {
                    let read = self.read(&path);
                    if flags.created || flags.renamed {
                        appeared.push((path, false, read));
                    } else if let Some((text, hash)) = read {
                        self.content_change(&mut content, path, text, hash);
                    }
                }
            }
        }

        // Pair a vanished file with an appeared one of the same content.
        let mut used = vec![false; appeared.len()];
        let mut unpaired = Vec::new();
        for old in gone {
            let known = self.shared.known(&old);
            let pair = known.as_ref().and_then(|h| {
                appeared.iter().enumerate().position(|(i, (_, dir, read))| {
                    !used[i] && !dir && read.as_ref().is_some_and(|(_, rh)| rh == h)
                })
            });
            match pair {
                Some(i) => {
                    used[i] = true;
                    let new = appeared[i].0.clone();
                    self.renamed(&mut meta, &old, &new, false);
                }
                None => unpaired.push(old),
            }
        }
        // One vanished path and one new folder: a folder rename.
        let new_dirs: Vec<usize> = (0..appeared.len()).filter(|&i| !used[i] && appeared[i].1).collect();
        if unpaired.len() == 1 && new_dirs.len() == 1 {
            let old = unpaired.pop().unwrap();
            let i = new_dirs[0];
            used[i] = true;
            let new = appeared[i].0.clone();
            self.renamed(&mut meta, &old, &new, true);
        }
        for old in unpaired {
            self.shared.forget(&old);
            meta.push(MetadataChange { kind: MetadataChangeKind::Deleted, path: Self::s(&old), is_directory: false });
        }
        for (i, (path, is_dir, read)) in appeared.into_iter().enumerate() {
            if used[i] {
                continue;
            }
            // This app made it (a create, a save's rename into place): the
            // caller already has its row.
            let own_hash = if is_dir { DIR_MARK.to_string() } else { read.as_ref().map(|(_, h)| h.clone()).unwrap_or_default() };
            if self.shared.is_recent_app_write(&path, &own_hash) {
                if let Some((_, hash)) = read {
                    self.shared.remember(&path, &hash);
                }
                continue;
            }
            meta.push(MetadataChange { kind: MetadataChangeKind::Created, path: Self::s(&path), is_directory: is_dir });
            // A file replaced in place (an atomic save) arrives as a create
            // of a path that may already be tracked: its content counts too.
            if let Some((text, hash)) = read {
                self.content_change(&mut content, path, text, hash);
            }
        }

        let mut events = Vec::new();
        if !meta.is_empty() {
            events.push(FsChangeEvent::Metadata { watch_id: watch_id.to_string(), changes: meta });
        }
        if !content.is_empty() {
            events.push(FsChangeEvent::Content { watch_id: watch_id.to_string(), changes: content });
        }
        events
    }

    fn content_change(&mut self, out: &mut Vec<ContentChange>, path: PathBuf, text: String, hash: String) {
        let own = self.shared.is_recent_app_write(&path, &hash);
        let unchanged = self.shared.known(&path).as_deref() == Some(hash.as_str());
        self.shared.remember(&path, &hash);
        // Our own write echoing back, or a touch without change.
        if own || unchanged {
            return;
        }
        out.push(ContentChange { path: Self::s(&path), content: text, content_hash: hash });
    }
}

fn flags_of(kind: &EventKind) -> Option<Flags> {
    let mut f = Flags::default();
    match kind {
        EventKind::Access(_) => return None,
        EventKind::Modify(ModifyKind::Metadata(_)) => return None,
        EventKind::Create(_) => f.created = true,
        EventKind::Remove(_) => f.removed = true,
        EventKind::Modify(ModifyKind::Name(_)) => f.renamed = true,
        EventKind::Modify(_) | EventKind::Any | EventKind::Other => f.modified = true,
    }
    Some(f)
}

/// Start watching. Returns the OS watcher (dropping it stops the watch) and
/// the debounced event batches.
pub(crate) fn start(config: WatchConfig) -> FsResult<(notify::RecommendedWatcher, async_channel::Receiver<FsChangeEvent>)> {
    let (raw_tx, raw_rx) = mpsc::channel::<Raw>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = event.kind
            && event.paths.len() == 2
        {
            let _ = raw_tx.send(Raw::Pair(event.paths[0].clone(), event.paths[1].clone()));
            return;
        }
        let Some(flags) = flags_of(&event.kind) else { return };
        for path in event.paths {
            let _ = raw_tx.send(Raw::Path(path, flags));
        }
    })
    .map_err(|e| FsError { kind: FsErrorKind::IoError, path: config.roots.join(", "), message: e.to_string() })?;
    for root in &config.roots {
        watcher.watch(Path::new(root), RecursiveMode::Recursive).map_err(|e| {
            let kind = match e.kind {
                notify::ErrorKind::PathNotFound => FsErrorKind::NotFound,
                _ => FsErrorKind::IoError,
            };
            FsError { kind, path: root.clone(), message: e.to_string() }
        })?;
    }
    let (tx, rx) = async_channel::unbounded();
    let debounce = config.debounce;
    let watch_id = config.watch_id.clone();
    let mut judge = Judge::new(&config);
    std::thread::Builder::new()
        .name(format!("notefig-watch {watch_id}"))
        .spawn(move || {
            loop {
                let Ok(first) = raw_rx.recv() else { return };
                let mut paths: BTreeMap<PathBuf, Flags> = BTreeMap::new();
                let mut pairs = Vec::new();
                let mut push = |raw: Raw| match raw {
                    Raw::Path(p, f) => paths.entry(p).or_default().merge(f),
                    Raw::Pair(a, b) => pairs.push((a, b)),
                };
                push(first);
                let started = Instant::now();
                loop {
                    match raw_rx.recv_timeout(debounce) {
                        Ok(raw) => {
                            push(raw);
                            if started.elapsed() > debounce * 10 {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                for event in judge.judge(paths, pairs, &watch_id) {
                    if tx.send_blocking(event).is_err() {
                        return;
                    }
                }
            }
        })
        .map_err(|e| FsError { kind: FsErrorKind::IoError, path: String::new(), message: e.to_string() })?;
    Ok((watcher, rx))
}

#[cfg(test)]
pub(crate) fn judge_for_test(roots: Vec<String>, rules: Rules, shared: Arc<Shared>) -> impl FnMut(Vec<(PathBuf, &str)>) -> Vec<FsChangeEvent> {
    let mut judge = Judge::new(&WatchConfig { roots, watch_id: "w".into(), rules, shared, debounce: Duration::ZERO });
    move |raw| {
        let mut paths: BTreeMap<PathBuf, Flags> = BTreeMap::new();
        for (p, k) in raw {
            let f = match k {
                "create" => Flags { created: true, ..Default::default() },
                "remove" => Flags { removed: true, ..Default::default() },
                "rename" => Flags { renamed: true, ..Default::default() },
                _ => Flags { modified: true, ..Default::default() },
            };
            paths.entry(p).or_default().merge(f);
        }
        judge.judge(paths, Vec::new(), "w")
    }
}
