/**
 * File Sync Utilities
 *
 * Handles synchronization between file system events and TanStack DB collections.
 * This is the bridge between the file watcher (Rust) and our reactive collections (TypeScript).
 *
 * Key responsibilities:
 * - Process metadata changes (creates/deletes/renames) for ALL files
 * - Process content changes ONLY for loaded files (files with content in collection)
 * - Handle conflicts between in-memory and file system changes
 * - Update collections reactively to trigger UI updates
 *
 * Event flow:
 * File System → notify (Rust) → Debouncer (100ms) → Batched Events →
 * TauriAdapter → workspace.tsx event handlers → file-sync functions → Collections → UI
 */

import type {
  MetadataChangeEvent,
  ContentChangeEvent,
} from "@/adapters/platform-adapter.interface";
import { getOrCreateWorkspaceCollections } from "./collections";
import { platformAdapter } from "@/adapters";

/**
 * Handle metadata change events from the file system
 *
 * Processes ALL metadata changes (creates/deletes/renames) for ALL files in the workspace.
 * Updates the metadata collection, which triggers UI updates via reactive queries.
 *
 * @param event - Batched metadata change event from file watcher
 * @param workspaceId - The workspace identifier (typically basePath)
 */
export async function handleMetadataFileSystemChange(
  event: MetadataChangeEvent,
  workspaceId: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  console.log(
    `[file-sync] Processing ${event.changes.length} metadata changes for workspace ${workspaceId}`,
  );

  for (const change of event.changes) {
    try {
      switch (change.type) {
        case "created": {
          // File or directory was created on disk
          console.log(`[file-sync] Created: ${change.path}`);

          // Get metadata from file system
          const metadataResult = await platformAdapter.getMetadata([
            change.path,
          ]);

          if (metadataResult.succeeded.length > 0) {
            const metadata = metadataResult.succeeded[0];

            // Check if already exists in collection (avoid duplicate inserts)
            const existing = collections.metadata.get(change.path);
            if (!existing) {
              // Insert into metadata collection using writeInsert (bypasses mutation handlers)
              collections.metadata.utils.writeInsert({
                path: change.path,
                relativePath: change.path.startsWith(workspaceId)
                  ? change.path.slice(workspaceId.length + 1)
                  : undefined,
                type: metadata.type,
                modified: metadata.modifiedAt,
                size: metadata.size,
                contentHash: "", // Will be computed when content is loaded
              });
            } else {
              console.log(
                `[file-sync] Skipping create for ${change.path} - already exists`,
              );
            }
          }
          break;
        }

        case "deleted": {
          // File or directory was deleted on disk
          console.log(`[file-sync] Deleted: ${change.path}`);

          // Remove from metadata collection using writeDelete (bypasses mutation handlers)
          const existing = collections.metadata.get(change.path);
          if (existing) {
            collections.metadata.utils.writeDelete(change.path);
          }

          // Also remove from content collection if loaded
          const content = collections.content.get(change.path);
          if (content) {
            collections.content.utils.writeDelete(change.path);
          }

          // If it's a directory, remove all children
          // Note: We can't easily query all items from a collection synchronously
          // The file watcher should emit individual delete events for each child
          // So we rely on those events rather than manually finding children
          if (change.isDirectory) {
            console.log(
              `[file-sync] Directory deleted: ${change.path} - child deletes should be in separate events`,
            );
          }
          break;
        }

        case "renamed": {
          // File or directory was renamed/moved on disk
          console.log(
            `[file-sync] Renamed: ${change.oldPath} → ${change.path}`,
          );

          if (!change.oldPath) {
            console.error("[file-sync] Rename event missing oldPath:", change);
            break;
          }

          // Get the old item
          const oldMetadata = collections.metadata.get(change.oldPath);
          if (!oldMetadata) {
            console.warn(
              `[file-sync] Cannot find old path ${change.oldPath} for rename`,
            );
            break;
          }

          // Get updated metadata from file system
          const metadataResult = await platformAdapter.getMetadata([
            change.path,
          ]);

          if (metadataResult.succeeded.length > 0) {
            const metadata = metadataResult.succeeded[0];

            // Delete old entry
            collections.metadata.utils.writeDelete(change.oldPath);

            // Insert new entry with updated path
            collections.metadata.utils.writeInsert({
              path: change.path,
              relativePath: change.path.startsWith(workspaceId)
                ? change.path.slice(workspaceId.length + 1)
                : undefined,
              type: metadata.type,
              modified: metadata.modifiedAt,
              size: metadata.size,
              contentHash: oldMetadata.contentHash, // Preserve hash
            });

            // If content was loaded, update content collection too
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

          // If it's a directory rename, update all children
          // Note: The file watcher emits all child renames in the same batched event
          // So we rely on those individual rename events rather than finding children ourselves
          if (change.isDirectory) {
            console.log(
              `[file-sync] Directory renamed: ${change.oldPath} → ${change.path} - child renames should be in same batch`,
            );
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
}

/**
 * Handle content change events from the file system
 *
 * Processes content changes ONLY for files that have content loaded in the collection.
 * Simply updates the DB collection - React will handle editor updates via props.
 *
 * @param event - Batched content change event from file watcher
 * @param workspaceId - The workspace identifier (typically basePath)
 */
export async function handleContentFileSystemChange(
  event: ContentChangeEvent,
  workspaceId: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  console.log(
    `[file-sync] Processing ${event.changes.length} content changes for workspace ${workspaceId}`,
  );

  for (const change of event.changes) {
    try {
      const existingContent = collections.content.get(change.path);

      if (!existingContent) {
        console.log(
          `[file-sync] Skipping content change for ${change.path} - not loaded`,
        );
        continue;
      }

      // Update DB collection (source of truth)
      // React will handle updating the editor via props
      collections.content.utils.writeUpdate({
        path: change.path,
        content: change.content,
        contentHash: change.contentHash,
      });

      console.log(`[file-sync] Updated content for ${change.path}`);
    } catch (error) {
      console.error(
        `[file-sync] Error processing content change for ${change.path}:`,
        error,
      );
    }
  }
}
