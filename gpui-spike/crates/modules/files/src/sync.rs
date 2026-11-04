//! Keeping a workspace's rows in step with disk: the handlers that apply
//! what its watch reports (`file-sync.ts`).



use notefig_platform::{ContentChange, FsChangeEvent, MetadataChange, MetadataChangeKind};

use crate::collections::{FileContent, FileMetadata};
use crate::files::WorkspaceFiles;
use crate::ignore::is_ignored_path;
use crate::paths::relative_tree_path;

pub(crate) async fn handle_event(files: WorkspaceFiles, event: FsChangeEvent) {
    match event {
        // Routed by watch id: one watch per workspace, so another
        // workspace's events never arrive here; a mismatched id is dropped.
        FsChangeEvent::Metadata { watch_id, changes } if watch_id == files.watch_id() => {
            handle_metadata(&files, changes).await
        }
        FsChangeEvent::Content { watch_id, changes } if watch_id == files.watch_id() => {
            handle_content(&files, changes).await
        }
        _ => {}
    }
}

async fn created(files: &WorkspaceFiles, change: &MetadataChange) {
    let ws = files.workspace_path().to_string();
    // Authoritative backstop for ignore rules: nothing ignored may enter.
    if is_ignored_path(&change.path, Some(&ws)) {
        return;
    }
    let stat = files.inner.fs.metadata(vec![change.path.clone()]).await.succeeded.into_iter().next();
    let Some(stat) = stat else { return };
    if files.inner.metadata.contains(&change.path) {
        return;
    }
    files.inner.metadata.write_upsert(FileMetadata {
        path: change.path.clone(),
        relative_path: relative_tree_path(&ws, &change.path),
        kind: stat.kind,
        modified_ms: Some(stat.modified_ms),
        size: Some(stat.size),
        content_hash: String::new(),
        error: None,
    });
}

/// Divergence: a deleted directory also drops its descendants' rows. The
/// Tauri watch reports each child of an `rm -r`, but a folder moved to the
/// trash arrives as one event, which the TS app leaves to the next walk.
fn deleted(files: &WorkspaceFiles, path: &str) {
    let meta = &files.inner.metadata;
    let is_dir = meta.get(path).is_some_and(|r| r.is_dir());
    let children: Vec<String> = if is_dir {
        meta.rows()
            .into_iter()
            .filter(|r| relative_tree_path(path, &r.path).is_some_and(|rel| !rel.is_empty()))
            .map(|r| r.path.clone())
            .collect()
    } else {
        Vec::new()
    };
    meta.write_batch(|| {
        for c in &children {
            meta.write_delete(c);
        }
        if meta.contains(path) {
            meta.write_delete(path);
        }
    });
    for c in children.iter().map(String::as_str).chain([path]) {
        files.inner.content.write_delete(c);
    }
}

async fn renamed(files: &WorkspaceFiles, change: &MetadataChange, old_path: &str) {
    let ws = files.workspace_path().to_string();
    // Renamed INTO ignored space: the file leaves the tracked tree.
    if is_ignored_path(&change.path, Some(&ws)) {
        deleted(files, old_path);
        return;
    }
    let Some(old) = files.inner.metadata.get(old_path) else {
        // Renamed OUT of untracked space: a fresh create at the new path.
        created(files, change).await;
        return;
    };
    let stat = files.inner.fs.metadata(vec![change.path.clone()]).await.succeeded.into_iter().next();
    let Some(stat) = stat else { return };
    files.inner.metadata.write_batch(|| {
        files.inner.metadata.write_delete(old_path);
        files.inner.metadata.write_upsert(FileMetadata {
            path: change.path.clone(),
            relative_path: relative_tree_path(&ws, &change.path),
            kind: stat.kind,
            modified_ms: Some(stat.modified_ms),
            size: Some(stat.size),
            content_hash: old.content_hash.clone(),
            error: None,
        });
    });
    if let Some(content) = files.inner.content.get(old_path) {
        files.inner.content.write_delete(old_path);
        files.inner.content.write_upsert(FileContent { path: change.path.clone(), ..(*content).clone() });
    }
}

pub(crate) async fn handle_metadata(files: &WorkspaceFiles, changes: Vec<MetadataChange>) {
    for change in &changes {
        match &change.kind {
            MetadataChangeKind::Created => created(files, change).await,
            MetadataChangeKind::Deleted => deleted(files, &change.path),
            MetadataChangeKind::Renamed { old_path } => renamed(files, change, old_path).await,
        }
    }
    files.changed(changes.into_iter().map(|c| c.path).collect());
}

pub(crate) async fn handle_content(files: &WorkspaceFiles, changes: Vec<ContentChange>) {
    for change in &changes {
        // Only open files have content rows.
        let Some(existing) = files.inner.content.get(&change.path) else { continue };
        // The echo of this app's own save: decided by hash alone.
        if existing.content_hash == change.content_hash {
            continue;
        }
        // A save in flight owns this path: its completion updates the row.
        if files.is_dirty(&change.path) {
            continue;
        }
        // A change event is a TRIGGER, not a source: its payload can be
        // stale by delivery, so re-read and sync the row to disk now.
        let read = files.inner.fs.read_files(vec![change.path.clone()]).await.succeeded.into_iter().next();
        let Some((_, content)) = read else { continue };
        files.update_loaded_content(&change.path, &content);
    }
    files.changed(changes.into_iter().map(|c| c.path).collect());
}
