import type {
  MetadataChangeEvent,
  ContentChangeEvent,
} from "@/adapters/platform-adapter.interface";
import { getOrCreateWorkspaceCollections } from "./collections";
import { platformAdapter } from "@/adapters";

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
}

export async function handleContentFileSystemChange(
  event: ContentChangeEvent,
  workspaceId: string,
): Promise<void> {
  const collections = getOrCreateWorkspaceCollections(workspaceId);

  for (const change of event.changes) {
    try {
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
}
