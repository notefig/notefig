/**
 * Focuses (opening if necessary) the document containing a blob and scrolls
 * its rendered widget into view. Blobs have no natural line/column position
 * (unlike file locations elsewhere in the app), so the editor targets the
 * `data-blob-id` attribute BlobNodeView already sets on its wrapper.
 */
import { appCore } from "@/core/current";

export function jumpToBlob(path: string, blobId: string): void {
  void appCore().editors.reveal(
    path,
    { blockId: blobId },
    { intent: "new-tab", moveIfOpen: true },
  );
}
