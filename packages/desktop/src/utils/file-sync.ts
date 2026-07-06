import type {
  MetadataChangeEvent,
  ContentChangeEvent,
} from "@/adapters/platform-adapter.interface";
import { getOrCreateWorkspaceCollections, queryClient } from "./collections";
import { gitQueryKeys } from "./git-service-store";
import {
  projectSettingsPath,
  projectSettingsQueryKey,
} from "./project-settings";
import { platformAdapter } from "@/adapters";

const INVALIDATE_DEBOUNCE_MS = 500;
const invalidationTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Frontend-side suppression of the app's own write echoes.
 *
 * The platform watchers try to suppress app writes (registerAppWrite in the
 * adapters / APP_WRITES in src-tauri), but their consume-one-registration
 * model has a structural hole under rapid saves: an fs event handler reads
 * the file at handling time, so the event from write N can consume write
 * N+1's registration, and write N+1's own event then comes through as an
 * "external" change. By the time it crosses IPC the editor is further
 * ahead, and adopting it replaces new content with old.
 *
 * So the frontend keeps its own ledger: every content hash this app wrote
 * recently. Matching is a membership test — deliberately NOT consume-once,
 * since several events can legitimately observe the same disk state.
 */
const SELF_WRITE_TTL_MS = 30_000;
const MAX_SELF_WRITES_PER_PATH = 100;
const recentSelfWrites = new Map<string, { hash: string; at: number }[]>();

export function recordSelfWrite(path: string, contentHash: string): void {
  const now = Date.now();
  const entries = (recentSelfWrites.get(path) ?? []).filter(
    (entry) => now - entry.at < SELF_WRITE_TTL_MS,
  );
  entries.push({ hash: contentHash, at: now });
  recentSelfWrites.set(path, entries.slice(-MAX_SELF_WRITES_PER_PATH));
}

export function isRecentSelfWrite(path: string, contentHash: string): boolean {
  const now = Date.now();
  return (recentSelfWrites.get(path) ?? []).some(
    (entry) => entry.hash === contentHash && now - entry.at < SELF_WRITE_TTL_MS,
  );
}

/**
 * Single invalidation channel for all filesystem-derived query state
 * (search results, git status/checkpoints). Debounced per workspace so
 * bursts of watcher events collapse into one invalidation.
 *
 * Called from the fs-event handlers below and from in-app writes
 * (whose watcher echoes are self-suppressed).
 */
export function invalidateDerivedState(workspaceId: string): void {
  const pending = invalidationTimers.get(workspaceId);
  if (pending) clearTimeout(pending);

  invalidationTimers.set(
    workspaceId,
    setTimeout(() => {
      invalidationTimers.delete(workspaceId);
      const keys = gitQueryKeys(workspaceId);
      queryClient.invalidateQueries({
        queryKey: ["search-content", workspaceId],
      });
      queryClient.invalidateQueries({ queryKey: keys.status });
      queryClient.invalidateQueries({ queryKey: keys.checkpoints });
    }, INVALIDATE_DEBOUNCE_MS),
  );
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

export async function handleMetadataFileSystemChange(
  event: MetadataChangeEvent,
  workspaceId: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  for (const change of event.changes) {
    try {
      switch (change.type) {
        case "created": {
          const metadataResult = await platformAdapter.getMetadata([
            change.path,
          ]);

          if (metadataResult.succeeded.length > 0) {
            const metadata = metadataResult.succeeded[0];
            const existing = collections.metadata.get(change.path);

            if (!existing) {
              collections.metadata.utils.writeInsert({
                path: change.path,
                relativePath: change.path.startsWith(workspaceId)
                  ? change.path.slice(workspaceId.length + 1)
                  : undefined,
                type: metadata.type,
                modified: metadata.modifiedAt,
                size: metadata.size,
                contentHash: "",
              });
            }
          }
          break;
        }

        case "deleted": {
          const existing = collections.metadata.get(change.path);
          if (existing) {
            collections.metadata.utils.writeDelete(change.path);
          }

          const content = collections.content.get(change.path);
          if (content) {
            collections.content.utils.writeDelete(change.path);
          }
          break;
        }

        case "renamed": {
          if (!change.oldPath) {
            console.error("[file-sync] Rename event missing oldPath:", change);
            break;
          }

          const oldMetadata = collections.metadata.get(change.oldPath);
          if (!oldMetadata) {
            break;
          }

          const metadataResult = await platformAdapter.getMetadata([
            change.path,
          ]);

          if (metadataResult.succeeded.length > 0) {
            const metadata = metadataResult.succeeded[0];

            collections.metadata.utils.writeDelete(change.oldPath);
            collections.metadata.utils.writeInsert({
              path: change.path,
              relativePath: change.path.startsWith(workspaceId)
                ? change.path.slice(workspaceId.length + 1)
                : undefined,
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
          break;
        }
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
