/**
 * Keeping a workspace's file rows in step with disk: the metadata and
 * content watchers and the handlers that apply what they report. Each
 * workspace's files instance (entities/files.ts) starts its watchers here,
 * handing over itself and the fs — nothing here holds state of its own or
 * imports the platform.
 */
import type {
  ContentChangeEvent,
  FileSystemSurface,
  MetadataChangeEvent,
} from "@/adapters/platform-adapter.interface";
import type { WorkspaceFiles } from "@/entities/files";
import { IGNORE_RULES, isIgnoredPath } from "./ignore";
import { relativeTreePath } from "./path";
import { PORTAL_ID } from "./portal-id";
import { getDocumentSync } from "./markdown-conversion";
import { emitAppEvent } from "./app-events";

/**
 * Watch-id construction, in one place for both kinds.
 *
 * The id is the key the platform's watcher registry is stored under, and on
 * the Tauri side that registry is process-global while events are broadcast
 * to every webview — so the id has to name the portal as well as the
 * workspace, or two windows on one workspace share (and clobber) one entry.
 * Nothing parses these; they are compared for equality on both sides.
 */
export function metadataWatchIdFor(workspacePath: string): string {
  return `metadata-${PORTAL_ID}-${workspacePath}`;
}

export function contentWatchIdFor(workspacePath: string): string {
  return `content-${PORTAL_ID}-${workspacePath}`;
}

type MetadataChange = MetadataChangeEvent["changes"][number];
type Fs = Pick<FileSystemSurface, "getMetadata" | "readFiles">;

async function applyMetadataCreated(
  files: WorkspaceFiles,
  fs: Fs,
  change: MetadataChange,
): Promise<void> {
  const { workspacePath, collections } = files;
  // Authoritative backstop for ignore rules: the platform watchers filter
  // too (cheaply, Rust-side), but browser adapters and event races can
  // still surface ignored paths — nothing ignored may enter the collection.
  if (isIgnoredPath(change.path, workspacePath)) return;

  const metadataResult = await fs.getMetadata([change.path]);
  const metadata = metadataResult.succeeded[0];
  if (!metadata || collections.metadata.get(change.path)) return;

  collections.metadata.utils.writeInsert({
    path: change.path,
    relativePath: relativeTreePath(workspacePath, change.path),
    type: metadata.type,
    modified: metadata.modifiedAt,
    size: metadata.size,
    contentHash: "",
  });
}

function applyMetadataDeleted(
  files: WorkspaceFiles,
  change: MetadataChange,
): void {
  const { collections } = files;
  if (collections.metadata.get(change.path)) {
    collections.metadata.utils.writeDelete(change.path);
  }
  if (collections.content.get(change.path)) {
    collections.content.utils.writeDelete(change.path);
  }
}

async function applyMetadataRenamed(
  files: WorkspaceFiles,
  fs: Fs,
  change: MetadataChange,
): Promise<void> {
  const { workspacePath, collections } = files;
  if (!change.oldPath) {
    console.error("[file-sync] Rename event missing oldPath:", change);
    return;
  }

  // Renamed INTO ignored space: the file leaves the tracked tree.
  if (isIgnoredPath(change.path, workspacePath)) {
    applyMetadataDeleted(files, { ...change, path: change.oldPath });
    return;
  }

  const oldMetadata = collections.metadata.get(change.oldPath);
  if (!oldMetadata) {
    // Renamed OUT of untracked space (ignored dir, or a path we never held
    // a row for): surfaces as a fresh create at the new path.
    await applyMetadataCreated(files, fs, change);
    return;
  }

  const metadataResult = await fs.getMetadata([change.path]);
  const metadata = metadataResult.succeeded[0];
  if (!metadata) return;

  collections.metadata.utils.writeDelete(change.oldPath);
  collections.metadata.utils.writeInsert({
    path: change.path,
    relativePath: relativeTreePath(workspacePath, change.path),
    type: metadata.type,
    modified: metadata.modifiedAt,
    size: metadata.size,
    contentHash: oldMetadata.contentHash,
  });

  const oldContent = collections.content.get(change.oldPath);
  if (oldContent) {
    collections.content.utils.writeDelete(change.oldPath);
    collections.content.utils.writeInsert({
      path: change.path,
      content: oldContent.content,
      contentHash: oldContent.contentHash,
    });
  }
}

/** What changed, for whoever derives state from these paths (project
 *  settings), after any change the watcher reports. */
function announceChanged(files: WorkspaceFiles, paths: string[]): void {
  emitAppEvent("files:changed", {
    workspacePath: files.workspacePath,
    paths,
  });
  files.invalidateDerived();
}

export async function handleMetadataFileSystemChange(
  files: WorkspaceFiles,
  fs: Fs,
  event: MetadataChangeEvent,
): Promise<void> {
  for (const change of event.changes) {
    try {
      if (change.type === "created") {
        await applyMetadataCreated(files, fs, change);
      } else if (change.type === "deleted") {
        applyMetadataDeleted(files, change);
      } else if (change.type === "renamed") {
        await applyMetadataRenamed(files, fs, change);
      }
    } catch (error) {
      console.error(
        `[file-sync] Error processing metadata change for ${change.path}:`,
        error,
      );
    }
  }

  announceChanged(
    files,
    event.changes.map((c) => c.path),
  );
}

export async function handleContentFileSystemChange(
  files: WorkspaceFiles,
  fs: Fs,
  event: ContentChangeEvent,
): Promise<void> {
  for (const change of event.changes) {
    try {
      // Skip files not loaded in memory (only open files have content rows).
      const existingContent = files.collections.content.get(change.path);
      if (!existingContent) continue;

      // Nothing new claimed: an event whose payload matches the row (the
      // common echo of this app's own save) is a no-op, decided by hash
      // compare alone — no I/O on the autosave hot path.
      if (existingContent.contentHash === change.contentHash) continue;

      // A save in flight owns this path. A read here can capture the
      // pre-rename bytes of that very save — and the save's own echo is
      // natively consumed, so nothing would correct a row regressed from
      // such a read. Defer: the save's completion updates the row itself,
      // and last-writer-wins already governs external changes that land
      // mid-edit (the editor guards drop them the same way).
      if (getDocumentSync(change.path).isDirty()) continue;

      // Beyond that, a change event is a TRIGGER, not a source. Its payload
      // was read at emit time and can already be stale by delivery (the
      // read can race the app's next write; delivery crosses IPC) — writing
      // it into the row would regress the row to a disk state that no
      // longer exists, and a remounting editor seeds from the row. So
      // re-read and sync the row to what disk holds NOW: stale observations
      // converge to a no-op, while genuine external changes — including a
      // revert to bytes this app once wrote (`git checkout --`/`git
      // revert`) — land as themselves and flow on to the editor's adoption
      // path. Cost: one read of one open file, only when an event claims
      // the file differs from the row.
      const result = await fs.readFiles([change.path]);
      const read = result.succeeded[0];
      if (!read) continue; // deleted/unreadable — the metadata pipeline handles it
      files.updateLoadedContent(change.path, read.content);
    } catch (error) {
      console.error(
        `[file-sync] Error processing content change for ${change.path}:`,
        error,
      );
    }
  }

  announceChanged(
    files,
    event.changes.map((c) => c.path),
  );
}

export interface MetadataWatcher {
  stop: () => void;
  /** Re-arms the OS watch if the last start attempt failed (the workspace
   *  was unreadable at open; access restored later). No-op otherwise. */
  ensureStarted: () => void;
}

/**
 * Workspace-lifetime metadata watching (MET-177): runs from open to close,
 * so a backgrounded workspace keeps ingesting external changes. Content
 * watching follows the rendered tabs instead (`startContentWatcher`).
 */
export function startMetadataWatcher(
  files: WorkspaceFiles,
  fs: FileSystemSurface,
): MetadataWatcher {
  const { workspacePath } = files;
  const metadataWatchId = metadataWatchIdFor(workspacePath);
  let isActive = true;
  let startFailed = false;

  const eventCleanup = fs.onFsEvent((event) => {
    if (!isActive) return;
    // Route by watch id, not by event kind: with several workspaces open,
    // every listener sees every event, and this recursive watch's pipeline
    // emits BOTH kinds — an external modify of a file that is not open in
    // a tab arrives as a content change only, and still has to drive the
    // git/search/project-settings invalidation in the content handler.
    if (event.payload.watchId !== metadataWatchId) return;
    if (event.type === "fs-metadata-changed") {
      void handleMetadataFileSystemChange(files, fs, event.payload);
    } else {
      void handleContentFileSystemChange(files, fs, event.payload);
    }
  });
  const arm = () => {
    startFailed = false;
    fs.startWatchingMetadata([workspacePath], metadataWatchId, {
      ignore: IGNORE_RULES,
    })
      .then(() => {
        // The start is not awaited by the caller, so a close can land while
        // it is still in flight. Without this the watcher registers *after*
        // stop() already tried to remove it: the JS handle is gone, nothing
        // can ever stop it again, and it keeps walking the tree for the life
        // of the process (on the browser adapter, a full recursive stat
        // sweep every 5s). Re-issuing the stop is idempotent.
        if (!isActive) {
          void fs.stopWatching(metadataWatchId).catch(() => {});
        }
      })
      .catch((error) => {
        startFailed = true;
        console.error("Failed to start metadata watcher:", error);
      });
  };
  arm();

  return {
    stop: () => {
      isActive = false;
      eventCleanup();
      void fs.stopWatching(metadataWatchId).catch(() => {
        // Already stopped (or never started, if startup failed) — fine.
      });
    },
    ensureStarted: () => {
      if (isActive && startFailed) arm();
    },
  };
}

/** The content watch of one workspace's open file tabs. */
export interface ContentWatcher {
  /** The watched paths, joined — the identity a re-sync compares against. */
  pathsKey: string;
  /** Re-issue the watch with a new path set under the same watch id: both
   *  backends reconcile the delta on a live id, so this never tears the
   *  registration or its listener down. */
  setPaths: (paths: string[]) => void;
  stop: () => void;
}

export function startContentWatcher(
  files: WorkspaceFiles,
  fs: FileSystemSurface,
  openFilePaths: string[],
): ContentWatcher {
  const contentWatchId = contentWatchIdFor(files.workspacePath);
  let isActive = true;
  const eventCleanup = fs.onFsEvent((event) => {
    if (!isActive) return;
    // Same watch-id routing as the metadata side: this watch's pipeline
    // also emits both kinds (a delete/rename of an open file surfaces as a
    // metadata change).
    if (event.payload.watchId !== contentWatchId) return;
    if (event.type === "fs-content-changed") {
      void handleContentFileSystemChange(files, fs, event.payload);
    } else {
      void handleMetadataFileSystemChange(files, fs, event.payload);
    }
  });
  // One serialized command lane per watch id. Starts and the final stop
  // are separate host commands with no ordering guarantee between them
  // (Tauri spawns each invoke as its own task), so a fast tab change could
  // otherwise land an older path set after a newer one, or a stop before
  // the start it was meant to undo — leaving a registration nobody holds.
  // Chaining them makes the last call issued the last to take effect.
  let lane: Promise<unknown> | null = null;
  const enqueue = (command: () => Promise<unknown>) => {
    lane = lane ? lane.then(command, command) : command();
    lane = lane.catch((error) => {
      console.error("Content watcher command failed:", error);
    });
  };
  const watcher: ContentWatcher = {
    pathsKey: "",
    setPaths: (paths) => {
      if (!isActive) return;
      watcher.pathsKey = paths.join(",");
      enqueue(() => fs.startWatchingContent(paths, contentWatchId));
    },
    stop: () => {
      isActive = false;
      eventCleanup();
      // Unconditional stop: cheaper to swallow the "no watcher" rejection
      // than to keep the stop condition mirroring the start condition.
      enqueue(() => fs.stopWatching(contentWatchId).catch(() => {}));
    },
  };
  watcher.setPaths(openFilePaths);
  return watcher;
}
