/**
 * Reusable drop behaviors for drag-protocol drop zones. Elements declare
 * zones with `dropZoneProps({ accepts, onDrop })` and call these from their
 * compact onDrop callbacks; everything here is plain functions — the
 * registry lives in drag-protocol.tsx.
 */

import type { PayloadOfKind } from "@/utils/drag-protocol";
import {
  file,
  refreshDirectoryMetadata,
  renameFileOrDirectory,
} from "@/entities/files";
import {
  getAllEditorPaths,
  getMarkdownEditor,
} from "@/components/editor/editor-store";
import { platformAdapter } from "@/adapters";
import { getFileName } from "@/utils/fs";

/**
 * Move a dragged item into a folder:
 * - an editor image node moves its asset file and rewrites the source
 *   document's image src to keep the reference valid
 * - a file-tree entry moves into the folder (tree-internal move)
 * Errors are logged, matching the sidebar's fs-operation idiom.
 */
export function moveIntoFolder(
  payload: PayloadOfKind<"image-asset" | "file">,
  folderPath: string,
): void {
  void moveIntoFolderAsync(payload, folderPath).catch((error: unknown) => {
    console.error(`Failed to move ${payload.kind} into ${folderPath}:`, error);
  });
}

async function moveIntoFolderAsync(
  payload: PayloadOfKind<"image-asset" | "file">,
  folderPath: string,
): Promise<void> {
  if (payload.kind === "image-asset") {
    await moveImageAsset(payload, folderPath);
    return;
  }

  const newPath = `${folderPath}/${getFileName(payload.path)}`;
  if (payload.path === newPath) return;

  if (payload.fileType === "directory") {
    const prefix = payload.path.endsWith("/")
      ? payload.path
      : payload.path + "/";
    // A directory can't move into itself or its own descendants.
    if (folderPath === payload.path || folderPath.startsWith(prefix)) return;
    // Open tabs are keyed by path; moving them out from under the layout
    // would orphan the tab (rename is disabled for open files for the same
    // reason — see FileTreeContextMenu disableRename).
    if (
      getAllEditorPaths().some(
        (p) => p === payload.path || p.startsWith(prefix),
      )
    ) {
      console.warn(`Not moving ${payload.path}: contains open files`);
      return;
    }
  } else if (getAllEditorPaths().includes(payload.path)) {
    console.warn(`Not moving ${payload.path}: file is open`);
    return;
  }

  await renameFileOrDirectory(payload.workspaceRoot, payload.path, newPath);
}

async function moveImageAsset(
  payload: PayloadOfKind<"image-asset">,
  folderPath: string,
): Promise<void> {
  const newPath = `${folderPath}/${getFileName(payload.absolutePath)}`;
  if (newPath === payload.absolutePath) return;

  const newSrc = newPath.startsWith(payload.workspaceRoot + "/")
    ? newPath.slice(payload.workspaceRoot.length + 1)
    : newPath;

  const editor = getMarkdownEditor(payload.sourceFilePath);
  if (!editor) {
    // Without the live document we can't rewrite the reference, so copy
    // instead of move — the original path keeps working.
    const result = await platformAdapter.fs.copyFile(
      payload.absolutePath,
      newPath,
    );
    if (!result.ok) throw result.error;
    await refreshDirectoryMetadata(payload.workspaceRoot);
    return;
  }

  if (file(payload.workspaceRoot, payload.absolutePath).exists()) {
    await renameFileOrDirectory(
      payload.workspaceRoot,
      payload.absolutePath,
      newPath,
    );
  } else {
    // Asset exists on disk but isn't tracked in collections yet.
    const result = await platformAdapter.fs.moveFile(
      payload.absolutePath,
      newPath,
    );
    if (!result.ok) throw result.error;
    await refreshDirectoryMetadata(payload.workspaceRoot);
  }

  // Rewrite every image node referencing the old src in the source doc.
  const { state } = editor;
  let tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (node.type.name === "image" && node.attrs.src === payload.src) {
      tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: newSrc });
    }
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}
