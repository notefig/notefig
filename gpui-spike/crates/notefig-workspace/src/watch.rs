//! File watcher: `notify` on the workspace root, a small debounce, ignore
//! filtering, own-write echo suppression by content hash, and rename pairing.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::Result;
use notify::{RecursiveMode, Watcher as _};

use crate::rules;
use crate::workspace::{Workspace, content_hash};

/// Files larger than this are reported without reading them.
const HASH_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsEvent {
    /// A file or folder was created or its content changed. `hash` is the
    /// new content hash for UTF-8 text files.
    Upserted {
        rel: String,
        is_dir: bool,
        hash: Option<String>,
    },
    Removed {
        rel: String,
    },
    Renamed {
        from: String,
        to: String,
    },
}

impl FsEvent {
    pub fn paths(&self) -> Vec<&str> {
        match self {
            FsEvent::Upserted { rel, .. } | FsEvent::Removed { rel } => vec![rel],
            FsEvent::Renamed { from, to } => vec![from, to],
        }
    }
}

/// Keeps the OS watcher alive. Dropping it stops watching.
pub struct WatchHandle {
    pub events: async_channel::Receiver<Vec<FsEvent>>,
    _watcher: notify::RecommendedWatcher,
}

impl Workspace {
    /// Start watching. Events arrive in batches after `debounce` of quiet.
    pub fn watch(&self, debounce: Duration) -> Result<WatchHandle> {
        let (raw_tx, raw_rx) = mpsc::channel::<PathBuf>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                for path in event.paths {
                    let _ = raw_tx.send(path);
                }
            }
        })?;
        watcher.watch(self.root(), RecursiveMode::Recursive)?;
        let (tx, rx) = async_channel::unbounded();
        let ws = self.clone();
        std::thread::Builder::new()
            .name("notefig-watch".into())
            .spawn(move || run(ws, raw_rx, tx, debounce))?;
        Ok(WatchHandle {
            events: rx,
            _watcher: watcher,
        })
    }
}

fn run(
    ws: Workspace,
    raw: mpsc::Receiver<PathBuf>,
    tx: async_channel::Sender<Vec<FsEvent>>,
    debounce: Duration,
) {
    loop {
        // Block for the first path of a batch.
        let Ok(first) = raw.recv() else { return };
        let mut paths = BTreeSet::new();
        paths.insert(first);
        let started = Instant::now();
        loop {
            match raw.recv_timeout(debounce) {
                Ok(p) => {
                    paths.insert(p);
                    if started.elapsed() > debounce * 10 {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let batch = process(&ws, paths.into_iter());
        if !batch.is_empty() && tx.send_blocking(batch).is_err() {
            return;
        }
    }
}

/// Turn raw changed paths into events. Public for tests and for a manual
/// catch-up pass.
pub fn process(ws: &Workspace, paths: impl Iterator<Item = PathBuf>) -> Vec<FsEvent> {
    let mut rels = BTreeSet::new();
    for path in paths {
        if let Some(rel) = ws.rel_of_loose(&path) {
            if !rel.is_empty() && !rules::is_ignored_rel(&rel) {
                rels.insert(rel);
            }
        }
    }
    let mut upserts = Vec::new();
    let mut removed: Vec<(String, Option<String>)> = Vec::new();
    for rel in rels {
        let Ok(abs) = ws.abs(&rel) else { continue };
        match std::fs::metadata(&abs) {
            Ok(meta) if meta.is_dir() => upserts.push((rel, true, None)),
            Ok(meta) => {
                let hash = if meta.len() <= HASH_LIMIT {
                    std::fs::read(&abs)
                        .ok()
                        .and_then(|b| String::from_utf8(b).ok())
                        .map(|t| content_hash(&t))
                } else {
                    None
                };
                // Our own write echoing back, or a touch without change.
                if hash.is_some() && hash == ws.known_hash(&rel) {
                    continue;
                }
                upserts.push((rel, false, hash));
            }
            Err(_) => {
                let known = ws.known_hash(&rel);
                removed.push((rel, known));
            }
        }
    }

    let mut events = Vec::new();
    // Pair removed files with created files of the same content.
    let mut used = vec![false; upserts.len()];
    let mut unpaired_removed = Vec::new();
    for (rel, known) in removed {
        let pair = known.as_ref().and_then(|h| {
            upserts
                .iter()
                .enumerate()
                .position(|(i, (_, is_dir, hash))| !used[i] && !is_dir && hash.as_ref() == Some(h))
        });
        if let Some(i) = pair {
            used[i] = true;
            let to = upserts[i].0.clone();
            // Carry the known hash over so later echoes are suppressed.
            if let Some(h) = known {
                ws.remember(&to, &h);
            }
            ws.known.lock().unwrap().hashes.remove(&rel);
            events.push(FsEvent::Renamed { from: rel, to });
        } else {
            unpaired_removed.push(rel);
        }
    }
    // A single removed path plus a single new folder: a folder rename.
    let new_dirs: Vec<usize> = (0..upserts.len())
        .filter(|&i| !used[i] && upserts[i].1)
        .collect();
    if unpaired_removed.len() == 1 && new_dirs.len() == 1 {
        let from = unpaired_removed.pop().unwrap();
        let i = new_dirs[0];
        used[i] = true;
        let to = upserts[i].0.clone();
        {
            let mut known = ws.known.lock().unwrap();
            let moved: Vec<(String, String)> = known
                .hashes
                .iter()
                .filter(|(k, _)| k.starts_with(&format!("{from}/")))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            for (k, v) in moved {
                known.hashes.remove(&k);
                known.hashes.insert(format!("{to}{}", &k[from.len()..]), v);
            }
        }
        events.push(FsEvent::Renamed { from, to });
    }
    for rel in unpaired_removed {
        events.push(FsEvent::Removed { rel });
    }
    for (i, (rel, is_dir, hash)) in upserts.into_iter().enumerate() {
        if !used[i] {
            events.push(FsEvent::Upserted { rel, is_dir, hash });
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    #[test]
    fn own_write_is_suppressed() {
        let (_d, ws) = ws();
        ws.write("a.md", "one").unwrap();
        let ev = process(&ws, [ws.root().join("a.md")].into_iter());
        assert!(ev.is_empty(), "{ev:?}");
        std::fs::write(ws.root().join("a.md"), "two").unwrap();
        let ev = process(&ws, [ws.root().join("a.md")].into_iter());
        assert_eq!(
            ev,
            vec![FsEvent::Upserted {
                rel: "a.md".into(),
                is_dir: false,
                hash: Some(content_hash("two"))
            }]
        );
    }

    #[test]
    fn rename_is_paired_and_ignored_dropped() {
        let (_d, ws) = ws();
        ws.write("a.md", "same").unwrap();
        std::fs::rename(ws.root().join("a.md"), ws.root().join("b.md")).unwrap();
        let ev = process(
            &ws,
            [
                ws.root().join("a.md"),
                ws.root().join("b.md"),
                ws.root().join(".git/index"),
            ]
            .into_iter(),
        );
        assert_eq!(
            ev,
            vec![FsEvent::Renamed {
                from: "a.md".into(),
                to: "b.md".into()
            }]
        );
        std::fs::remove_file(ws.root().join("b.md")).unwrap();
        let ev = process(&ws, [ws.root().join("b.md")].into_iter());
        assert_eq!(ev, vec![FsEvent::Removed { rel: "b.md".into() }]);
    }

    #[test]
    fn live_watcher_reports_external_write() {
        let (_d, ws) = ws();
        ws.write("a.md", "one").unwrap();
        let handle = ws.watch(Duration::from_millis(50)).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        // Drain any startup noise (FSEvents can replay recent history).
        while handle.events.try_recv().is_ok() {}
        ws.write("a.md", "own").unwrap();
        std::fs::write(ws.root().join("b.md"), "external").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            if let Ok(batch) = handle.events.try_recv() {
                seen.extend(batch);
                if seen.iter().any(|e| e.paths().contains(&"b.md")) {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(seen.iter().any(|e| e.paths().contains(&"b.md")), "{seen:?}");
        assert!(!seen.iter().any(|e| e.paths().contains(&"a.md")), "{seen:?}");
    }
}
