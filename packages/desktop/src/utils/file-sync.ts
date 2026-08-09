import { useEffect } from "react";
import type {
  MetadataChangeEvent,
  ContentChangeEvent,
} from "@/adapters/platform-adapter.interface";
import { FsError } from "@/adapters/platform-adapter.interface";
import { getOrCreateWorkspaceCollections } from "@/entities/files";
import { queryClient } from "@/entities/query-client";
import {
  invalidateDerivedState,
  isRecentSelfWrite,
  recordSelfWrite,
} from "./file-write-effects";
import {
  projectSettingsPath,
  projectSettingsQueryKey,
} from "./project-settings";
import { IGNORE_RULES, isIgnoredPath } from "./ignore";
import { calculateContentHash } from "./hash";
import { getDocumentSync } from "./markdown-conversion";
// Conscious utils → components import (direct-imports-over-injection house
// rule). This edge participates in a long pre-existing cycle back through
// the editor/blob component graph → agent-service → acp-client → file-sync
// (suppressed at acp-client's import; safe — all edges are function-body
// references). Breaking it for real means relocating the editor registry to
// a leaf module rather than adding a registration seam.
import { getMarkdownEditor } from "@/components/editor/editor-store";
import { platformAdapter } from "@/adapters";

/**
 * The app-layer choke point for the "workspace paths are absolute"
 * invariant: a relative path here would reach the OS resolved against the
 * process CWD (src-tauri/ under `cargo tauri dev` — agent-supplied
 * workspace-relative paths once wrote into the app's own source tree and
 * restarted the dev app on every write). Callers with agent-supplied paths
 * resolve them first (resolveWorkspacePath in utils/fs); this throws into
 * the standard FsError boundary if anyone forgets.
 */
function assertAbsoluteWorkspacePath(path: string): void {
  if (!path.startsWith("/")) {
    throw new FsError(
      "invalid_path",
      path,
      `workspace file paths must be absolute, got "${path}" (resolve agent paths with resolveWorkspacePath first)`,
    );
  }
}
/**
 * The single path every desktop-mediated agent write takes (ACP
 * fs/write_text_file, author_blob, history_restore, blob answers; web mode
 * advertises fs:false so writes there are native and only adopted via the
 * watcher).
 *
 * This is the *adopting* write primitive. The watcher echo of this write is
 * self-write-suppressed (`recordSelfWrite` + `handleContentFileSystemChange`'s
 * skip), so the watcher → content-change → DocumentSync pipeline never fires
 * for it — correct for a normal editor autosave, where the editor already
 * holds what was written, but wrong for any agent-shaped write to a document
 * open in an editor. So after the disk write, this function pushes the
 * content into the live editor itself, driving the same
 * `DocumentSync.prepareAdoption`/`commitAdoption` API `useEditorFileSync`
 * uses for external changes — directly and synchronously, not via a watcher
 * round-trip that was never going to arrive. `prepareAdoption` returning
 * null (a local edit mid-autosave-debounce) keeps last-writer-wins: the
 * user's edit wins, exactly like any external change arriving mid-edit.
 *
 * Per-path write serialization across parallel tasks is deliberately not
 * implemented here (dropped along with AgentWriteGate) — two tasks writing
 * the same path race like any two independent writeFiles calls. If
 * concurrent same-file interleaving becomes a real problem, serialization
 * returns as an internal detail of this function, not as a separate class.
 */
export async function writeWorkspaceTextFile(
  path: string,
  content: string,
): Promise<void> {
  assertAbsoluteWorkspacePath(path);
  recordSelfWrite(path, calculateContentHash(content));
  const result = await platformAdapter.fs.writeFiles([{ path, content }]);
  const failure = result.failed[0];
  if (failure) {
    throw new FsError(failure.type, failure.path, failure.message);
  }

  const editor = getMarkdownEditor(path);
  if (editor && !editor.isDestroyed) {
    const sync = getDocumentSync(path);
    const doc = await sync.prepareAdoption(content);
    if (doc && !editor.isDestroyed) {
      editor.commands.setContent(doc, { emitUpdate: false });
      sync.commitAdoption(content, calculateContentHash(content));
    }
  }
}

export async function readWorkspaceTextFile(
  path: string,
  options?: { line?: number; limit?: number },
): Promise<string> {
  assertAbsoluteWorkspacePath(path);
  const result = await platformAdapter.fs.readFiles([path]);
  const failure = result.failed[0];
  if (failure) {
    throw new FsError(failure.type, failure.path, failure.message);
  }
  const content = result.succeeded[0].content;
  if (!options?.line && !options?.limit) return content;
  // ACP lines are 1-based.
  const lines = content.split("\n");
  const start = Math.max(0, (options.line ?? 1) - 1);
  const end = options.limit ? start + options.limit : lines.length;
  return lines.slice(start, end).join("\n");
}

function invalidateProjectSettingsIfChanged(
  changedPaths: string[],
  workspaceId: string,
): void {
  if (changedPaths.includes(projectSettingsPath(workspaceId))) {
    queryClient.invalidateQueries({
      queryKey: projectSettingsQueryKey(workspaceId),
    });
  }
}

type WorkspaceCollections = ReturnType<typeof getOrCreateWorkspaceCollections>;
type MetadataChange = MetadataChangeEvent["changes"][number];

function relativeToWorkspace(
  path: string,
  workspaceId: string,
): string | undefined {
  return path.startsWith(workspaceId)
    ? path.slice(workspaceId.length + 1)
    : undefined;
}

async function applyMetadataCreated(
  collections: WorkspaceCollections,
  workspaceId: string,
  change: MetadataChange,
): Promise<void> {
  // Authoritative backstop for ignore rules: the platform watchers filter
  // too (cheaply, Rust-side), but browser adapters and event races can
  // still surface ignored paths — nothing ignored may enter the collection.
  if (isIgnoredPath(change.path, workspaceId)) return;

  const metadataResult = await platformAdapter.fs.getMetadata([change.path]);
  const metadata = metadataResult.succeeded[0];
  if (!metadata || collections.metadata.get(change.path)) return;

  collections.metadata.utils.writeInsert({
    path: change.path,
    relativePath: relativeToWorkspace(change.path, workspaceId),
    type: metadata.type,
    modified: metadata.modifiedAt,
    size: metadata.size,
    contentHash: "",
  });
}

function applyMetadataDeleted(
  collections: WorkspaceCollections,
  change: MetadataChange,
): void {
  if (collections.metadata.get(change.path)) {
    collections.metadata.utils.writeDelete(change.path);
  }
  if (collections.content.get(change.path)) {
    collections.content.utils.writeDelete(change.path);
  }
}

async function applyMetadataRenamed(
  collections: WorkspaceCollections,
  workspaceId: string,
  change: MetadataChange,
): Promise<void> {
  if (!change.oldPath) {
    console.error("[file-sync] Rename event missing oldPath:", change);
    return;
  }

  // Renamed INTO ignored space: the file leaves the tracked tree.
  if (isIgnoredPath(change.path, workspaceId)) {
    applyMetadataDeleted(collections, { ...change, path: change.oldPath });
    return;
  }

  const oldMetadata = collections.metadata.get(change.oldPath);
  if (!oldMetadata) {
    // Renamed OUT of untracked space (ignored dir, or a path we never held
    // a row for): surfaces as a fresh create at the new path.
    await applyMetadataCreated(collections, workspaceId, change);
    return;
  }

  const metadataResult = await platformAdapter.fs.getMetadata([change.path]);
  const metadata = metadataResult.succeeded[0];
  if (!metadata) return;

  collections.metadata.utils.writeDelete(change.oldPath);
  collections.metadata.utils.writeInsert({
    path: change.path,
    relativePath: relativeToWorkspace(change.path, workspaceId),
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

export async function handleMetadataFileSystemChange(
  event: MetadataChangeEvent,
  workspaceId: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  for (const change of event.changes) {
    try {
      if (change.type === "created") {
        await applyMetadataCreated(collections, workspaceId, change);
      } else if (change.type === "deleted") {
        applyMetadataDeleted(collections, change);
      } else if (change.type === "renamed") {
        await applyMetadataRenamed(collections, workspaceId, change);
      }
    } catch (error) {
      console.error(
        `[file-sync] Error processing metadata change for ${change.path}:`,
        error,
      );
    }
  }

  invalidateProjectSettingsIfChanged(
    event.changes.map((c) => c.path),
    workspaceId,
  );
  invalidateDerivedState(workspaceId);
}

export async function handleContentFileSystemChange(
  event: ContentChangeEvent,
  workspaceId: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  for (const change of event.changes) {
    try {
      // An echo of this app's own save must never be treated as external:
      // its payload can be stale relative to the editor by the time it
      // arrives, and writing it into the collection would make the
      // adoption path replace new content with old.
      if (isRecentSelfWrite(change.path, change.contentHash)) {
        continue;
      }

      const existingContent = collections.content.get(change.path);

      // Skip if file isn't loaded in memory, or content hasn't actually changed
      if (
        !existingContent ||
        existingContent.contentHash === change.contentHash
      ) {
        continue;
      }

      collections.content.utils.writeUpdate({
        path: change.path,
        content: change.content,
        contentHash: change.contentHash,
      });

      // Keep metadata contentHash in sync so the editor sees the change
      const existingMetadata = collections.metadata.get(change.path);
      if (
        existingMetadata &&
        existingMetadata.contentHash !== change.contentHash
      ) {
        collections.metadata.utils.writeUpdate({
          ...existingMetadata,
          contentHash: change.contentHash,
        });
      }
    } catch (error) {
      console.error(
        `[file-sync] Error processing content change for ${change.path}:`,
        error,
      );
    }
  }

  invalidateProjectSettingsIfChanged(
    event.changes.map((c) => c.path),
    workspaceId,
  );
  invalidateDerivedState(workspaceId);
}

/**
 * File-system watcher lifecycle for a workspace: watches the whole tree for
 * metadata changes and the open files for content changes, routing events
 * into the change handlers above. Re-arms when the open-file set changes.
 */
export function useFileWatchers(
  workspacePath: string,
  openFilePaths: string[],
): void {
  useEffect(() => {
    const metadataWatchId = `metadata-${workspacePath}`;
    const contentWatchId = `content-${workspacePath}`;
    let eventCleanup: (() => void) | undefined;
    let isActive = true;

    const setupWatchers = async () => {
      try {
        eventCleanup = platformAdapter.fs.onFsEvent((event) => {
          if (!isActive) return;
          if (event.type === "fs-metadata-changed") {
            handleMetadataFileSystemChange(event.payload, workspacePath);
          } else {
            handleContentFileSystemChange(event.payload, workspacePath);
          }
        });

        await platformAdapter.fs.startWatchingMetadata(
          [workspacePath],
          metadataWatchId,
          { ignore: IGNORE_RULES },
        );

        if (openFilePaths.length > 0) {
          await platformAdapter.fs.startWatchingContent(
            openFilePaths,
            contentWatchId,
          );
        }
      } catch (error) {
        console.error("Failed to setup watchers:", error);
      }
    };

    setupWatchers();

    return () => {
      isActive = false;
      eventCleanup?.();
      platformAdapter.fs.stopWatching(metadataWatchId);
      if (openFilePaths.length > 0) {
        platformAdapter.fs.stopWatching(contentWatchId);
      }
    };
    // Join: re-arm only when the actual set of open paths changes, not on
    // every render's fresh array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, openFilePaths.join(",")]);
}
