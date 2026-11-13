use crate::walkdir_utils::is_hidden_path;
use notify::{
    event::{CreateKind, ModifyKind, RemoveKind, RenameMode},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::fs;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MetadataChange {
    #[serde(rename = "type")]
    pub change_type: String, // "created" | "deleted" | "renamed"
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub is_directory: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MetadataChangeEvent {
    /// The watch that produced this event — the frontend routes by it, so
    /// one workspace's events never reach another's handlers (MET-177).
    pub watch_id: String,
    pub changes: Vec<MetadataChange>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContentChange {
    pub path: String,
    pub content: String,
    pub content_hash: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContentChangeEvent {
    /// See MetadataChangeEvent::watch_id.
    pub watch_id: String,
    pub changes: Vec<ContentChange>,
}

struct AppWrite {
    path: PathBuf,
    content_hash: String,
    timestamp: Instant,
}

struct WatcherState {
    debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
    watched_paths: Vec<PathBuf>,
}

type WatcherMap = Arc<Mutex<HashMap<String, WatcherState>>>;

/// Per-watch config, keyed by watch_id: the roots the watch was armed for
/// (the event pipeline scopes every emitted change to them — MET-177) plus
/// the app-side ignore rules (metadata watches only; content watches carry
/// empty lists). Roots are the watched workspace paths: directory-name
/// checks apply only to components *inside* a root, so a workspace living
/// under e.g. ~/Documents/build/ is not swallowed by its own prefix.
#[derive(Clone, Default)]
struct WatchConfig {
    /// Both the raw registered spelling and its canonicalized form: macOS
    /// FSEvents delivers symlink-resolved paths (/tmp → /private/tmp), so
    /// matching only the raw root would silently drop every event for a
    /// workspace under a symlinked prefix.
    roots: Vec<PathBuf>,
    directories: Vec<String>,
    extensions: Vec<String>,
}

/// Raw + canonicalized spellings of each path, deduped.
fn root_spellings(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for path in paths {
        if !roots.contains(path) {
            roots.push(path.clone());
        }
        if let Ok(canonical) = std::fs::canonicalize(path) {
            if !roots.contains(&canonical) {
                roots.push(canonical);
            }
        }
    }
    roots
}

lazy_static::lazy_static! {
    static ref WATCHERS: WatcherMap = Arc::new(Mutex::new(HashMap::new()));
    static ref APP_WRITES: Arc<Mutex<Vec<AppWrite>>> = Arc::new(Mutex::new(Vec::new()));
    static ref WATCH_CONFIGS: Arc<Mutex<HashMap<String, WatchConfig>>> =
        Arc::new(Mutex::new(HashMap::new()));
}

/// Component-wise containment (strip_prefix never matches sibling
/// prefixes: /ws-backup is not under /ws). A content watch's "roots" are
/// its watched files, which strip_prefix also matches exactly.
fn is_under_roots(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.strip_prefix(root).is_ok())
}

/// Whether THIS watch's ignore config filters this path — scoped per
/// watch, so one workspace's rules never swallow another's paths
/// (MET-177). Content watches register no config and get no config-based
/// filtering. Lists arrive lowercased from the frontend (utils/ignore.ts).
fn is_ignored_by_watch_config(path: &Path, watch_id: &str) -> bool {
    let configs = WATCH_CONFIGS.lock().unwrap();
    if let Some(config) = configs.get(watch_id) {
        for root in &config.roots {
            if let Ok(relative) = path.strip_prefix(root) {
                let ignored_component = relative.components().any(|component| {
                    if let std::path::Component::Normal(os_str) = component {
                        if let Some(name) = os_str.to_str() {
                            return config.directories.iter().any(|d| *d == name.to_lowercase());
                        }
                    }
                    false
                });
                if ignored_component {
                    return true;
                }
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if config.extensions.iter().any(|e| *e == ext_lower) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

pub fn register_app_write(path: String, content_hash: String) {
    let mut writes = APP_WRITES.lock().unwrap();

    writes.push(AppWrite {
        path: PathBuf::from(path),
        content_hash,
        timestamp: Instant::now(),
    });

    writes.retain(|w| w.timestamp.elapsed().as_secs() < 5);
}

/// Whether this (path, hash) pair matches a recent app write.
///
/// Deliberately a membership test with TTL expiry, NOT consume-once: the
/// recursive metadata watcher and the per-file content watcher both run
/// `process_events` for the same save (one atomic write emits
/// `Modify(Name(Any))` into both pipelines), so a single registration must
/// answer every pipeline that observes it. Consume-once let the second
/// pipeline leak the echo to the frontend on virtually every save.
fn is_recent_app_write(path: &Path, content_hash: &str) -> bool {
    let mut writes = APP_WRITES.lock().unwrap();
    writes.retain(|w| w.timestamp.elapsed().as_secs() < 5);
    writes
        .iter()
        .any(|w| w.path == path && w.content_hash == content_hash)
}

/// Check if a path should be filtered (hidden files, temp files, etc.)
/// `is_hidden_path` exempts the app dir (walkdir_utils::APP_DIR_NAME) and
/// its visible children (scratchpads, the project's config), so their
/// events flow while every other
/// app-internal path (`.notefig/.git`, …) stays filtered.
fn should_filter_path(path: &Path, watch_id: &str) -> bool {
    if is_hidden_path(path) {
        return true;
    }

    // Filter temp files (like .tmp files created during atomic writes)
    if let Some(extension) = path.extension() {
        if extension == "tmp" {
            return true;
        }
    }

    is_ignored_by_watch_config(path, watch_id)
}

/// Compute content hash using MD5 (simple and deterministic)
pub fn compute_content_hash(content: &str) -> String {
    let digest = md5::compute(content.as_bytes());
    format!("{:x}", digest)
}

/// Collect all file paths in a directory recursively
fn collect_directory_paths(
    dir_path: PathBuf,
    watch_id: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<(PathBuf, bool)>> + Send>> {
    Box::pin(async move {
        let mut results = Vec::new();

        if let Ok(mut entries) = fs::read_dir(&dir_path).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();

                if should_filter_path(&path, &watch_id) {
                    continue;
                }

                let is_directory = path.is_dir();
                results.push((path.clone(), is_directory));

                if is_directory {
                    let sub_results = collect_directory_paths(path, watch_id.clone()).await;
                    results.extend(sub_results);
                }
            }
        }

        results
    })
}

/// Emit "created" for a path — and, when it is a directory, for everything
/// inside it (a moved-in tree only produces one event for its root).
async fn push_created(
    metadata_changes: &mut Vec<MetadataChange>,
    path: PathBuf,
    is_dir: bool,
    watch_id: &str,
) {
    metadata_changes.push(MetadataChange {
        change_type: "created".to_string(),
        path: path.to_string_lossy().to_string(),
        old_path: None,
        is_directory: is_dir,
    });
    if is_dir {
        for (child_path, child_is_dir) in collect_directory_paths(path, watch_id.to_string()).await
        {
            metadata_changes.push(MetadataChange {
                change_type: "created".to_string(),
                path: child_path.to_string_lossy().to_string(),
                old_path: None,
                is_directory: child_is_dir,
            });
        }
    }
}

/// Emit "deleted" for a path. Children are not enumerated: for a directory
/// the OS emits per-child remove events on recursive deletes, and no frontend
/// consumer reads `is_directory` on deletes anyway.
fn push_deleted(metadata_changes: &mut Vec<MetadataChange>, path: PathBuf, is_dir: bool) {
    metadata_changes.push(MetadataChange {
        change_type: "deleted".to_string(),
        path: path.to_string_lossy().to_string(),
        old_path: None,
        is_directory: is_dir,
    });
}

/// Read `path` and, if the content changed and isn't a recent echo of our
/// own write, emit a ContentChange. Shared by every "this path was modified"
/// arm, including the same-path-replace fallback below.
async fn push_content_change_if_new(content_changes: &mut Vec<ContentChange>, path: &Path) {
    if let Ok(content) = fs::read_to_string(path).await {
        let hash = compute_content_hash(&content);
        if !is_recent_app_write(path, &hash) {
            content_changes.push(ContentChange {
                path: path.to_string_lossy().to_string(),
                content,
                content_hash: hash,
            });
        }
    }
}

/// Handle a Remove-shaped event for `path` — but re-check the filesystem
/// first (MET-158): Windows' `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` — what
/// `atomic_write`'s rename-over-an-existing-file does on EVERY save —  is
/// reported by `ReadDirectoryChangesW` as a Remove notification for the
/// destination followed by a Create, rather than a clean rename, because the
/// underlying file identity changes even though the path doesn't (a
/// well-documented Windows quirk hit by other file watchers, e.g. chokidar
/// and VS Code, for this exact replace-in-place pattern). Trusting every
/// Remove event closed the tab on virtually every save on Windows once B6
/// stopped silently dropping generic Remove events. `process_events` runs
/// after the fs operation that triggered the notification already
/// completed, so if `path` still exists the "delete" was this artifact —
/// treat it as a content update instead of a real delete.
///
/// One further check: existence alone isn't enough — if the path was
/// genuinely removed and something ELSE got created at the same path before
/// this event was processed (e.g. a directory deleted and a file created in
/// its place), the entity's TYPE flips even though the path doesn't. That's
/// not the replace-artifact this function exists to suppress: the old
/// entity's metadata (and, for a directory, its children) really is stale
/// and needs clearing. Re-derive the current type and only treat same-type
/// survivors as a benign replace; a type mismatch still emits "deleted".
async fn push_removed_or_modified(
    metadata_changes: &mut Vec<MetadataChange>,
    content_changes: &mut Vec<ContentChange>,
    path: PathBuf,
    is_dir: bool,
) {
    if path.exists() && path.is_dir() == is_dir {
        if !is_dir {
            push_content_change_if_new(content_changes, &path).await;
        }
        return;
    }
    push_deleted(metadata_changes, path, is_dir);
}

/// Process file system events and emit to frontend
async fn process_events<R: tauri::Runtime>(
    events: Vec<Event>,
    app_handle: &AppHandle<R>,
    watch_id: &str,
) {
    // Unknown id means the watch was stopped while these events were in
    // flight — nothing wants them.
    let Some(roots) = WATCH_CONFIGS
        .lock()
        .unwrap()
        .get(watch_id)
        .map(|config| config.roots.clone())
    else {
        return;
    };
    let mut metadata_changes = Vec::new();
    let mut content_changes = Vec::new();

    for event in events {
        match event.kind {
            EventKind::Create(CreateKind::File) => {
                for path in event.paths {
                    if should_filter_path(&path, watch_id) || !is_under_roots(&path, &roots) {
                        continue;
                    }
                    push_created(&mut metadata_changes, path, false, watch_id).await;
                }
            }
            EventKind::Create(CreateKind::Folder) => {
                for path in event.paths {
                    if should_filter_path(&path, watch_id) || !is_under_roots(&path, &roots) {
                        continue;
                    }
                    push_created(&mut metadata_changes, path, true, watch_id).await;
                }
            }
            // Windows: the ReadDirectoryChangesW backend only ever emits
            // CreateKind::Any (notify 6.1.1 windows.rs) — without this arm
            // external creates never reach the frontend and the tree goes
            // stale (MET-157 B6). The kind is unknown, so probe the fs.
            EventKind::Create(CreateKind::Any | CreateKind::Other) => {
                for path in event.paths {
                    if should_filter_path(&path, watch_id) || !is_under_roots(&path, &roots) {
                        continue;
                    }
                    let is_dir = path.is_dir();
                    push_created(&mut metadata_changes, path, is_dir, watch_id).await;
                }
            }

            EventKind::Remove(RemoveKind::File) => {
                for path in event.paths {
                    if should_filter_path(&path, watch_id) || !is_under_roots(&path, &roots) {
                        continue;
                    }
                    push_removed_or_modified(
                        &mut metadata_changes,
                        &mut content_changes,
                        path,
                        false,
                    )
                    .await;
                }
            }
            EventKind::Remove(RemoveKind::Folder) => {
                for path in event.paths {
                    if should_filter_path(&path, watch_id) || !is_under_roots(&path, &roots) {
                        continue;
                    }
                    push_removed_or_modified(
                        &mut metadata_changes,
                        &mut content_changes,
                        path,
                        true,
                    )
                    .await;
                }
            }
            // Windows counterpart of Create(Any) above: only RemoveKind::Any
            // is ever emitted. is_dir is irrelevant here since a still-alive
            // path routes through the content-change branch (files only).
            EventKind::Remove(RemoveKind::Any | RemoveKind::Other) => {
                for path in event.paths {
                    if should_filter_path(&path, watch_id) || !is_under_roots(&path, &roots) {
                        continue;
                    }
                    push_removed_or_modified(
                        &mut metadata_changes,
                        &mut content_changes,
                        path,
                        false,
                    )
                    .await;
                }
            }

            // Handle Data(_), Any, and Other - macOS FSEvents often emits Any for atomic writes
            // (like those from Chrome's File System Access API)
            EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Modify(ModifyKind::Other) => {
                for path in event.paths {
                    if should_filter_path(&path, watch_id) || !is_under_roots(&path, &roots) {
                        continue;
                    }

                    if path.is_file() {
                        push_content_change_if_new(&mut content_changes, &path).await;
                    }
                }
            }

            // RENAME events with Name(Any) - Chrome's File System Access API uses atomic writes
            // which emit Name(Any) with a single path when the temp file is renamed to the target
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)) => {
                for path in event.paths {
                    if should_filter_path(&path, watch_id) || !is_under_roots(&path, &roots) {
                        continue;
                    }

                    if path.is_file() && !path.to_string_lossy().ends_with(".crswap") {
                        push_content_change_if_new(&mut content_changes, &path).await;
                    }
                }
            }

            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                if event.paths.len() == 2 {
                    let old_path = &event.paths[0];
                    let new_path = &event.paths[1];

                    // A filtered source is not tracked state leaving the
                    // tree — most commonly an atomic-save temp file renamed
                    // over its target (the content arms carry that save).
                    if should_filter_path(old_path, watch_id) {
                        continue;
                    }

                    // Scope the rename to this watch's roots and filters,
                    // judged per endpoint: a destination that leaves the
                    // tree — or lands somewhere hidden/ignored (Finder
                    // trash, .git/, an ignored dist/) — is, from this
                    // watch's perspective, a delete of the source; a source
                    // arriving from outside is a create; fully outside is
                    // not this watch's business.
                    let old_in = is_under_roots(old_path, &roots);
                    let new_in = is_under_roots(new_path, &roots);
                    if !old_in && !new_in {
                        continue;
                    }
                    let new_ok = new_in && !should_filter_path(new_path, watch_id);
                    if old_in && !new_ok {
                        push_deleted(&mut metadata_changes, old_path.clone(), new_path.is_dir());
                        continue;
                    }
                    if !old_in {
                        push_created(
                            &mut metadata_changes,
                            new_path.clone(),
                            new_path.is_dir(),
                            watch_id,
                        )
                        .await;
                        continue;
                    }

                    let is_directory = new_path.is_dir();

                    if is_directory {
                        let dir_contents =
                            collect_directory_paths(new_path.clone(), watch_id.to_string()).await;

                        metadata_changes.push(MetadataChange {
                            change_type: "renamed".to_string(),
                            path: new_path.to_string_lossy().to_string(),
                            old_path: Some(old_path.to_string_lossy().to_string()),
                            is_directory: true,
                        });

                        let old_path_str = old_path.to_string_lossy();
                        let new_path_str = new_path.to_string_lossy();

                        for (child_new_path, is_dir) in dir_contents {
                            let child_new_str = child_new_path.to_string_lossy();

                            if let Some(suffix) = child_new_str.strip_prefix(new_path_str.as_ref())
                            {
                                let child_old_path = format!("{}{}", old_path_str, suffix);

                                metadata_changes.push(MetadataChange {
                                    change_type: "renamed".to_string(),
                                    path: child_new_str.to_string(),
                                    old_path: Some(child_old_path),
                                    is_directory: is_dir,
                                });
                            }
                        }
                    } else {
                        metadata_changes.push(MetadataChange {
                            change_type: "renamed".to_string(),
                            path: new_path.to_string_lossy().to_string(),
                            old_path: Some(old_path.to_string_lossy().to_string()),
                            is_directory: false,
                        });
                    }
                }
            }

            // Windows renames arrive as separate From/To events with no
            // tracker cookie; the debouncer's file-ID fallback merges most
            // pairs into Both within the 100ms window, but unpaired halves
            // (rename out of / into the watched tree, or a missed pairing)
            // fall through to here. Model them as delete + create — the
            // frontend already treats an unknown-oldPath rename as a create.
            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                for path in event.paths {
                    if should_filter_path(&path, watch_id) || !is_under_roots(&path, &roots) {
                        continue;
                    }
                    push_removed_or_modified(
                        &mut metadata_changes,
                        &mut content_changes,
                        path,
                        false,
                    )
                    .await;
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                for path in event.paths {
                    if should_filter_path(&path, watch_id) || !is_under_roots(&path, &roots) {
                        continue;
                    }
                    let is_dir = path.is_dir();
                    push_created(&mut metadata_changes, path, is_dir, watch_id).await;
                }
            }

            _ => {}
        }
    }

    if !metadata_changes.is_empty() {
        let event = MetadataChangeEvent {
            watch_id: watch_id.to_string(),
            changes: metadata_changes,
        };
        let _ = app_handle.emit("fs-metadata-changed", event);
    }

    if !content_changes.is_empty() {
        let event = ContentChangeEvent {
            watch_id: watch_id.to_string(),
            changes: content_changes,
        };
        let _ = app_handle.emit("fs-content-changed", event);
    }
}

/// Start watching directories for metadata changes only (creates, deletes, renames)
/// Uses RecursiveMode::Recursive to watch entire directory trees
#[tauri::command]
pub async fn start_watching_metadata<R: tauri::Runtime>(
    paths: Vec<String>,
    watch_id: String,
    ignore_directories: Option<Vec<String>>,
    ignore_extensions: Option<Vec<String>>,
    app_handle: AppHandle<R>,
) -> Result<(), String> {
    let app_handle_clone = app_handle.clone();
    let watch_id_for_events = watch_id.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| {
            let app_handle = app_handle_clone.clone();
            let watch_id = watch_id_for_events.clone();

            match result {
                Ok(events) => {
                    tauri::async_runtime::spawn(async move {
                        let notify_events: Vec<Event> =
                            events.into_iter().map(|e| e.event).collect();
                        process_events(notify_events, &app_handle, &watch_id).await;
                    });
                }
                Err(errors) => {
                    eprintln!("File watcher errors: {:?}", errors);
                }
            }
        },
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();

    for path in &path_bufs {
        debouncer
            .watcher()
            .watch(path, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch path {}: {}", path.display(), e))?;
    }

    WATCH_CONFIGS.lock().unwrap().insert(
        watch_id.clone(),
        WatchConfig {
            roots: root_spellings(&path_bufs),
            directories: ignore_directories.unwrap_or_default(),
            extensions: ignore_extensions.unwrap_or_default(),
        },
    );

    let mut watchers = WATCHERS.lock().unwrap();
    watchers.insert(
        watch_id,
        WatcherState {
            debouncer,
            watched_paths: path_bufs,
        },
    );

    Ok(())
}

/// Start or update watching individual files for content changes
/// Only watches the specific files provided, not recursively
/// Automatically reconciles: adds new files, removes files no longer in the list
#[tauri::command]
pub async fn start_watching_content<R: tauri::Runtime>(
    paths: Vec<String>,
    watch_id: String,
    app_handle: AppHandle<R>,
) -> Result<(), String> {
    let mut watchers = WATCHERS.lock().unwrap();
    let new_paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();

    if let Some(state) = watchers.get_mut(&watch_id) {
        // Reconcile: which paths to add and which to remove
        let old_paths_set: std::collections::HashSet<_> = state.watched_paths.iter().collect();
        let new_paths_set: std::collections::HashSet<_> = new_paths.iter().collect();

        for old_path in &state.watched_paths {
            if !new_paths_set.contains(old_path) {
                let _ = state.debouncer.watcher().unwatch(old_path);
            }
        }

        for new_path in &new_paths {
            if !old_paths_set.contains(new_path) {
                state
                    .debouncer
                    .watcher()
                    .watch(new_path, RecursiveMode::NonRecursive)
                    .map_err(|e| format!("Failed to watch path {}: {}", new_path.display(), e))?;
            }
        }

        state.watched_paths = new_paths.clone();
        WATCH_CONFIGS.lock().unwrap().insert(
            watch_id,
            WatchConfig {
                roots: root_spellings(&new_paths),
                ..Default::default()
            },
        );
    } else {
        let app_handle_clone = app_handle.clone();
        let watch_id_for_events = watch_id.clone();

        let mut debouncer = new_debouncer(
            Duration::from_millis(100),
            None,
            move |result: DebounceEventResult| {
                let app_handle = app_handle_clone.clone();
                let watch_id = watch_id_for_events.clone();

                match result {
                    Ok(events) => {
                        tauri::async_runtime::spawn(async move {
                            let notify_events: Vec<Event> =
                                events.into_iter().map(|e| e.event).collect();
                            process_events(notify_events, &app_handle, &watch_id).await;
                        });
                    }
                    Err(errors) => {
                        eprintln!("File watcher errors: {:?}", errors);
                    }
                }
            },
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        for path in &new_paths {
            debouncer
                .watcher()
                .watch(path, RecursiveMode::NonRecursive)
                .map_err(|e| format!("Failed to watch path {}: {}", path.display(), e))?;
        }

        WATCH_CONFIGS.lock().unwrap().insert(
            watch_id.clone(),
            WatchConfig {
                roots: root_spellings(&new_paths),
                ..Default::default()
            },
        );
        watchers.insert(
            watch_id,
            WatcherState {
                debouncer,
                watched_paths: new_paths,
            },
        );
    }

    Ok(())
}

/// Stop watching (works for both metadata and content watchers)
#[tauri::command]
pub async fn stop_watching(watch_id: String) -> Result<(), String> {
    WATCH_CONFIGS.lock().unwrap().remove(&watch_id);
    let mut watchers = WATCHERS.lock().unwrap();

    if watchers.remove(&watch_id).is_some() {
        Ok(())
    } else {
        Err(format!("No watcher found with id: {}", watch_id))
    }
}

/// Event-kind mapping tests for `process_events` (MET-157 B6). Synthetic
/// `notify::Event`s stand in for the backends so the match arms are exercised
/// deterministically on every platform — in particular the `Any`-kind and
/// `From`/`To` shapes that are the ONLY thing the Windows
/// `ReadDirectoryChangesW` backend emits (real-watcher end-to-end coverage
/// lives in the shim e2e suite, which runs the actual backend per OS).
#[cfg(test)]
mod event_kind_tests {
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Listener;

    static TEST_WATCH_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// A unique id per call so parallel tests never race the global
    /// WATCH_CONFIGS entries they register.
    fn unique_watch_id(prefix: &str) -> String {
        let n = TEST_WATCH_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("{prefix}-{n}")
    }

    /// Registers a config for the watch id for the duration of one
    /// process_events run (the pipeline drops everything for an unknown id).
    fn with_watch_config<T>(watch_id: &str, config: WatchConfig, run: impl FnOnce() -> T) -> T {
        WATCH_CONFIGS
            .lock()
            .unwrap()
            .insert(watch_id.to_string(), config);
        let out = run();
        WATCH_CONFIGS.lock().unwrap().remove(watch_id);
        out
    }

    /// Runs `process_events` on a mock app under the given watch id and
    /// roots, returning the captured fs-metadata-changed payloads' (type,
    /// path, is_directory) rows and asserting every payload carries the id.
    fn metadata_changes_for_watch(
        events: Vec<Event>,
        watch_id: &str,
        roots: Vec<PathBuf>,
    ) -> Vec<(String, String, bool)> {
        metadata_changes_for_config(
            events,
            watch_id,
            WatchConfig {
                roots,
                ..Default::default()
            },
        )
    }

    fn metadata_changes_for_config(
        events: Vec<Event>,
        watch_id: &str,
        config: WatchConfig,
    ) -> Vec<(String, String, bool)> {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("failed to build mock app");
        let captured: Arc<Mutex<Vec<MetadataChange>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = captured.clone();
        let expected_id = watch_id.to_string();
        app.listen("fs-metadata-changed", move |event| {
            let parsed: MetadataChangeEvent =
                serde_json::from_str(event.payload()).expect("payload should deserialize");
            assert_eq!(
                parsed.watch_id, expected_id,
                "payload must carry its watch id"
            );
            sink.lock().unwrap().extend(parsed.changes);
        });

        with_watch_config(watch_id, config, || {
            tauri::async_runtime::block_on(process_events(events, app.handle(), watch_id));
        });

        let rows = captured.lock().unwrap();
        rows.iter()
            .map(|c| (c.change_type.clone(), c.path.clone(), c.is_directory))
            .collect()
    }

    /// Generic harness: roots wide open (the platform temp dir holds every
    /// path these tests synthesize), scoping-specific tests pass real roots.
    fn metadata_changes_for(events: Vec<Event>) -> Vec<(String, String, bool)> {
        metadata_changes_for_watch(
            events,
            &unique_watch_id("metadata-test"),
            vec![std::env::temp_dir()],
        )
    }

    fn event(kind: EventKind, paths: Vec<PathBuf>) -> Event {
        let mut e = Event::new(kind);
        e.paths = paths;
        e
    }

    #[test]
    fn create_any_probes_file_vs_directory() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-b6")
            .tempdir()
            .unwrap();
        let file = dir.path().join("note.md");
        std::fs::write(&file, "x").unwrap();
        let subdir = dir.path().join("sub");
        std::fs::create_dir(&subdir).unwrap();
        std::fs::write(subdir.join("child.md"), "y").unwrap();

        let changes = metadata_changes_for(vec![
            event(EventKind::Create(CreateKind::Any), vec![file.clone()]),
            event(EventKind::Create(CreateKind::Any), vec![subdir.clone()]),
        ]);

        let file_str = file.to_string_lossy().to_string();
        let subdir_str = subdir.to_string_lossy().to_string();
        assert!(changes.contains(&("created".into(), file_str, false)));
        assert!(changes.contains(&("created".into(), subdir_str, true)));
        // A directory create enumerates its children.
        assert!(changes
            .iter()
            .any(|(t, p, d)| t == "created" && p.ends_with("child.md") && !d));
    }

    #[test]
    fn remove_any_emits_deleted() {
        // Path deliberately nonexistent: on Windows a removed path can't be
        // probed, and the arm must not require it to exist.
        let gone = std::env::temp_dir().join("notefig-test-gone-b6.md");
        let changes = metadata_changes_for(vec![event(
            EventKind::Remove(RemoveKind::Any),
            vec![gone.clone()],
        )]);

        assert_eq!(
            changes,
            vec![("deleted".into(), gone.to_string_lossy().to_string(), false)]
        );
    }

    #[test]
    fn unpaired_rename_from_and_to_become_delete_and_create() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-b6")
            .tempdir()
            .unwrap();
        let target = dir.path().join("renamed.md");
        std::fs::write(&target, "x").unwrap();
        let source = dir.path().join("original.md"); // already gone

        let changes = metadata_changes_for(vec![
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                vec![source.clone()],
            ),
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                vec![target.clone()],
            ),
        ]);

        assert!(changes.contains(&(
            "deleted".into(),
            source.to_string_lossy().to_string(),
            false
        )));
        assert!(changes.contains(&(
            "created".into(),
            target.to_string_lossy().to_string(),
            false
        )));
    }

    #[test]
    fn typed_create_and_remove_kinds_still_map() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-b6")
            .tempdir()
            .unwrap();
        let file = dir.path().join("typed.md");
        std::fs::write(&file, "x").unwrap();
        let gone_dir = dir.path().join("typed-subdir"); // never created

        let changes = metadata_changes_for(vec![
            event(EventKind::Create(CreateKind::File), vec![file.clone()]),
            event(
                EventKind::Remove(RemoveKind::Folder),
                vec![gone_dir.clone()],
            ),
        ]);

        assert!(changes.contains(&("created".into(), file.to_string_lossy().to_string(), false)));
        assert!(changes.contains(&(
            "deleted".into(),
            gone_dir.to_string_lossy().to_string(),
            true
        )));
    }

    /// MET-135: the app dir is not hidden, so scratchpad events flow — but
    /// every other child of it, other hidden paths, and atomic-write temp
    /// files stay filtered. No per-watch configuration involved.
    #[test]
    fn app_dir_events_pass_filter_hidden_children_stay_filtered() {
        let app_dir = PathBuf::from("/ws/.notefig");
        let id = "metadata-/ws";
        assert!(!should_filter_path(
            &app_dir.join("scratchpads/untitled.md"),
            id
        ));
        assert!(should_filter_path(&app_dir.join(".git/HEAD"), id));
        assert!(should_filter_path(
            &app_dir.join("agent/opencode-1.json"),
            id
        ));
        assert!(should_filter_path(&app_dir.join("tasks.json"), id));
        assert!(should_filter_path(Path::new("/ws/.git/HEAD"), id));
        assert!(should_filter_path(
            &app_dir.join("scratchpads/untitled.md.tmp"),
            id
        ));
    }

    /// MET-158: Windows' MoveFileExW(MOVEFILE_REPLACE_EXISTING) — every
    /// atomic_write save — is reported by ReadDirectoryChangesW as a Remove
    /// for the destination, not a clean rename. Before this fix, that
    /// deleted the row and closed the tab on virtually every keystroke.
    #[test]
    fn remove_of_a_path_that_still_exists_is_not_a_delete() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-b6")
            .tempdir()
            .unwrap();
        let file = dir.path().join("still-here.md");
        std::fs::write(&file, "new content after replace").unwrap();

        let changes = metadata_changes_for(vec![event(
            EventKind::Remove(RemoveKind::Any),
            vec![file.clone()],
        )]);

        assert!(
            !changes.iter().any(|(t, _, _)| t == "deleted"),
            "a still-existing path must never be reported deleted: {changes:?}"
        );
    }

    /// Same guard, but proves the surviving path is treated as a genuine
    /// content update rather than silently dropped.
    #[test]
    fn remove_of_a_path_that_still_exists_emits_a_content_change() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-b6")
            .tempdir()
            .unwrap();
        let file = dir.path().join("replaced.md");
        std::fs::write(&file, "the new content").unwrap();

        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("failed to build mock app");
        let captured: Arc<Mutex<Vec<ContentChange>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = captured.clone();
        app.listen("fs-content-changed", move |event| {
            let parsed: ContentChangeEvent =
                serde_json::from_str(event.payload()).expect("payload should deserialize");
            sink.lock().unwrap().extend(parsed.changes);
        });

        let id = unique_watch_id("metadata-content-test");
        let config = WatchConfig {
            roots: vec![dir.path().to_path_buf()],
            ..Default::default()
        };
        with_watch_config(&id, config, || {
            tauri::async_runtime::block_on(process_events(
                vec![event(
                    EventKind::Remove(RemoveKind::Any),
                    vec![file.clone()],
                )],
                app.handle(),
                &id,
            ));
        });

        let rows = captured.lock().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, file.to_string_lossy().to_string());
        assert_eq!(rows[0].content, "the new content");
    }

    /// A path surviving isn't enough on its own: if a directory was removed
    /// and a FILE got created at that exact path before this event was
    /// processed, the entity's type flipped — the old directory's metadata
    /// (and children) really is stale and must still be cleaned up.
    #[test]
    fn remove_of_a_path_whose_type_changed_is_still_a_delete() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-b6")
            .tempdir()
            .unwrap();
        let path = dir.path().join("was-a-dir-now-a-file");
        std::fs::write(&path, "now a file").unwrap();

        // Claimed is_dir=true (as a real Remove(Folder) event would carry),
        // but the path now resolves to a file.
        let changes = metadata_changes_for(vec![event(
            EventKind::Remove(RemoveKind::Folder),
            vec![path.clone()],
        )]);

        assert_eq!(
            changes,
            vec![("deleted".into(), path.to_string_lossy().to_string(), true)]
        );
    }

    /// One workspace's ignore rules must not swallow another watch's paths
    /// (MET-177): the config is consulted per producing watch only.
    #[test]
    fn ignore_rules_are_scoped_to_their_own_watch() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-iso")
            .tempdir()
            .unwrap();
        let dist = dir.path().join("dist");
        std::fs::create_dir(&dist).unwrap();
        let artifact = dist.join("bundle.md");
        std::fs::write(&artifact, "x").unwrap();

        // Watch A (some other workspace's watch) ignores dist/ under this
        // very root; watch B watches the same root with no ignores.
        let config_a = || WatchConfig {
            roots: vec![dir.path().to_path_buf()],
            directories: vec!["dist".to_string()],
            extensions: vec![],
        };

        let created = || {
            vec![event(
                EventKind::Create(CreateKind::File),
                vec![artifact.clone()],
            )]
        };

        // B's pipeline: A's rules must not apply.
        let for_b =
            metadata_changes_for_watch(created(), "metadata-iso-b", vec![dir.path().to_path_buf()]);
        assert!(
            for_b
                .iter()
                .any(|(t, p, _)| t == "created" && p.ends_with("bundle.md")),
            "another watch's ignore rules must not swallow this watch's event",
        );

        // A's own pipeline: its rules do apply.
        let for_a = metadata_changes_for_config(created(), "metadata-iso-a", config_a());
        assert!(
            for_a.is_empty(),
            "the owning watch's ignore rules still filter"
        );
    }

    /// MET-177: the event pipeline scopes every change to its own watch's
    /// roots — an event for a path outside them (sibling-prefix included)
    /// never reaches the frontend.
    #[test]
    fn events_outside_the_watch_roots_are_dropped() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-roots")
            .tempdir()
            .unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir(&root).unwrap();
        let sibling = dir.path().join("ws-backup");
        std::fs::create_dir(&sibling).unwrap();
        let stray = sibling.join("stray.md");
        std::fs::write(&stray, "x").unwrap();

        let changes = metadata_changes_for_watch(
            vec![event(EventKind::Create(CreateKind::File), vec![stray])],
            &unique_watch_id("metadata-roots"),
            vec![root],
        );
        assert!(
            changes.is_empty(),
            "sibling-prefix path leaked: {changes:?}"
        );
    }

    /// A rename whose destination leaves the watched tree is, from this
    /// watch's perspective, a delete of the source.
    #[test]
    fn rename_out_of_the_watch_roots_becomes_a_delete() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-roots")
            .tempdir()
            .unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir(&root).unwrap();
        let outside = dir.path().join("elsewhere.md");
        std::fs::write(&outside, "x").unwrap();
        let source = root.join("was-here.md");

        let changes = metadata_changes_for_watch(
            vec![event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                vec![source.clone(), outside],
            )],
            &unique_watch_id("metadata-roots"),
            vec![root],
        );
        assert_eq!(
            changes,
            vec![(
                "deleted".into(),
                source.to_string_lossy().to_string(),
                false
            )]
        );
    }

    /// A rename whose destination is hidden or ignored (Finder trash,
    /// .git/, an ignored build dir) is a delete of the source — previously
    /// the joint filter guard dropped the whole event and the source row
    /// went stale.
    #[test]
    fn rename_into_hidden_space_becomes_a_delete() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-roots")
            .tempdir()
            .unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir(&root).unwrap();
        let trash = root.join(".trash");
        std::fs::create_dir(&trash).unwrap();
        let target = trash.join("note.md");
        std::fs::write(&target, "x").unwrap();
        let source = root.join("note.md");

        let changes = metadata_changes_for_watch(
            vec![event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                vec![source.clone(), target],
            )],
            &unique_watch_id("metadata-roots"),
            vec![root],
        );
        assert_eq!(
            changes,
            vec![(
                "deleted".into(),
                source.to_string_lossy().to_string(),
                false
            )]
        );
    }

    /// A rename arriving from outside the watched tree is a create at the
    /// destination.
    #[test]
    fn rename_into_the_watch_roots_becomes_a_create() {
        let dir = tempfile::Builder::new()
            .prefix("notefig-roots")
            .tempdir()
            .unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir(&root).unwrap();
        let target = root.join("arrived.md");
        std::fs::write(&target, "x").unwrap();
        let source = dir.path().join("elsewhere.md");

        let changes = metadata_changes_for_watch(
            vec![event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                vec![source, target.clone()],
            )],
            &unique_watch_id("metadata-roots"),
            vec![root],
        );
        assert_eq!(
            changes,
            vec![(
                "created".into(),
                target.to_string_lossy().to_string(),
                false
            )]
        );
    }
}
