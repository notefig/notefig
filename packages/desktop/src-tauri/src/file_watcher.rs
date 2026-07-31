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
pub struct MetadataChangeEvent {
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
pub struct ContentChangeEvent {
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

lazy_static::lazy_static! {
    static ref WATCHERS: WatcherMap = Arc::new(Mutex::new(HashMap::new()));
    static ref APP_WRITES: Arc<Mutex<Vec<AppWrite>>> = Arc::new(Mutex::new(Vec::new()));
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
fn should_filter_path(path: &Path) -> bool {
    if is_hidden_path(path) {
        return true;
    }

    // Filter temp files (like .tmp files created during atomic writes)
    if let Some(extension) = path.extension() {
        if extension == "tmp" {
            return true;
        }
    }

    false
}

/// Compute content hash using MD5 (simple and deterministic)
pub fn compute_content_hash(content: &str) -> String {
    let digest = md5::compute(content.as_bytes());
    format!("{:x}", digest)
}

/// Collect all file paths in a directory recursively
fn collect_directory_paths(
    dir_path: PathBuf,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<(PathBuf, bool)>> + Send>> {
    Box::pin(async move {
        let mut results = Vec::new();

        if let Ok(mut entries) = fs::read_dir(&dir_path).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();

                if should_filter_path(&path) {
                    continue;
                }

                let is_directory = path.is_dir();
                results.push((path.clone(), is_directory));

                if is_directory {
                    let sub_results = collect_directory_paths(path).await;
                    results.extend(sub_results);
                }
            }
        }

        results
    })
}

/// Process file system events and emit to frontend
async fn process_events<R: tauri::Runtime>(events: Vec<Event>, app_handle: &AppHandle<R>) {
    let mut metadata_changes = Vec::new();
    let mut content_changes = Vec::new();

    for event in events {
        match event.kind {
            EventKind::Create(CreateKind::File) => {
                for path in event.paths {
                    if should_filter_path(&path) {
                        continue;
                    }

                    metadata_changes.push(MetadataChange {
                        change_type: "created".to_string(),
                        path: path.to_string_lossy().to_string(),
                        old_path: None,
                        is_directory: false,
                    });
                }
            }
            EventKind::Create(CreateKind::Folder) => {
                for path in event.paths {
                    if should_filter_path(&path) {
                        continue;
                    }

                    let dir_contents = collect_directory_paths(path.clone()).await;

                    metadata_changes.push(MetadataChange {
                        change_type: "created".to_string(),
                        path: path.to_string_lossy().to_string(),
                        old_path: None,
                        is_directory: true,
                    });

                    for (child_path, is_dir) in dir_contents {
                        metadata_changes.push(MetadataChange {
                            change_type: "created".to_string(),
                            path: child_path.to_string_lossy().to_string(),
                            old_path: None,
                            is_directory: is_dir,
                        });
                    }
                }
            }

            EventKind::Remove(RemoveKind::File) => {
                for path in event.paths {
                    if should_filter_path(&path) {
                        continue;
                    }

                    metadata_changes.push(MetadataChange {
                        change_type: "deleted".to_string(),
                        path: path.to_string_lossy().to_string(),
                        old_path: None,
                        is_directory: false,
                    });
                }
            }
            EventKind::Remove(RemoveKind::Folder) => {
                for path in event.paths {
                    if should_filter_path(&path) {
                        continue;
                    }

                    // For directory deletion, we only emit the directory itself
                    // The frontend should handle cascade deletion of children
                    metadata_changes.push(MetadataChange {
                        change_type: "deleted".to_string(),
                        path: path.to_string_lossy().to_string(),
                        old_path: None,
                        is_directory: true,
                    });
                }
            }

            // Handle Data(_), Any, and Other - macOS FSEvents often emits Any for atomic writes
            // (like those from Chrome's File System Access API)
            EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Modify(ModifyKind::Other) => {
                for path in event.paths {
                    if should_filter_path(&path) {
                        continue;
                    }

                    if path.is_file() {
                        if let Ok(content) = fs::read_to_string(&path).await {
                            let hash = compute_content_hash(&content);

                            if !is_recent_app_write(&path, &hash) {
                                content_changes.push(ContentChange {
                                    path: path.to_string_lossy().to_string(),
                                    content,
                                    content_hash: hash,
                                });
                            }
                        }
                    }
                }
            }

            // RENAME events with Name(Any) - Chrome's File System Access API uses atomic writes
            // which emit Name(Any) with a single path when the temp file is renamed to the target
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)) => {
                for path in event.paths {
                    if should_filter_path(&path) {
                        continue;
                    }

                    if path.is_file() && !path.to_string_lossy().ends_with(".crswap") {
                        if let Ok(content) = fs::read_to_string(&path).await {
                            let hash = compute_content_hash(&content);

                            if !is_recent_app_write(&path, &hash) {
                                content_changes.push(ContentChange {
                                    path: path.to_string_lossy().to_string(),
                                    content,
                                    content_hash: hash,
                                });
                            }
                        }
                    }
                }
            }

            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                if event.paths.len() == 2 {
                    let old_path = &event.paths[0];
                    let new_path = &event.paths[1];

                    if should_filter_path(old_path) || should_filter_path(new_path) {
                        continue;
                    }

                    let is_directory = new_path.is_dir();

                    if is_directory {
                        let dir_contents = collect_directory_paths(new_path.clone()).await;

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

            _ => {}
        }
    }

    if !metadata_changes.is_empty() {
        let event = MetadataChangeEvent {
            changes: metadata_changes,
        };
        let _ = app_handle.emit("fs-metadata-changed", event);
    }

    if !content_changes.is_empty() {
        let event = ContentChangeEvent {
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
    app_handle: AppHandle<R>,
) -> Result<(), String> {
    let app_handle_clone = app_handle.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| {
            let app_handle = app_handle_clone.clone();

            match result {
                Ok(events) => {
                    tauri::async_runtime::spawn(async move {
                        let notify_events: Vec<Event> =
                            events.into_iter().map(|e| e.event).collect();
                        process_events(notify_events, &app_handle).await;
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

        state.watched_paths = new_paths;
    } else {
        let app_handle_clone = app_handle.clone();

        let mut debouncer = new_debouncer(
            Duration::from_millis(100),
            None,
            move |result: DebounceEventResult| {
                let app_handle = app_handle_clone.clone();

                match result {
                    Ok(events) => {
                        tauri::async_runtime::spawn(async move {
                            let notify_events: Vec<Event> =
                                events.into_iter().map(|e| e.event).collect();
                            process_events(notify_events, &app_handle).await;
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
    let mut watchers = WATCHERS.lock().unwrap();

    if watchers.remove(&watch_id).is_some() {
        Ok(())
    } else {
        Err(format!("No watcher found with id: {}", watch_id))
    }
}
