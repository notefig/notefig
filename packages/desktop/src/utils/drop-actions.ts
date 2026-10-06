/**
 * Reusable drop behaviors for drag-protocol drop zones. Elements declare
 * zones with `dropZoneProps({ accepts, onDrop })` and call these from their
 * compact onDrop callbacks; everything here is plain functions — the
 * registry lives in drag-protocol.tsx.
 */

import type { PayloadOfKind } from "@/utils/drag-protocol";
import type { WorkspaceFiles } from "@/entities/files";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import type { EditorsApi } from "@/entities/editors";
import { getFileName } from "@/utils/fs";
import { path as pathutil } from "@/utils/path";

/**
 * Move a dragged item into a folder:
 * - an editor image node moves its asset file and rewrites the source
 *   document's image src to keep the reference valid
 * - a file-tree entry moves into the folder (tree-internal move)
 * Errors are logged, matching the sidebar's fs-operation idiom.
 */
/** What a move needs: the files of the workspace an item came from (its
 *  `workspaceRoot`), and the fs for an untracked asset. */
export interface DropDeps {
  filesOf(workspaceRoot: string): WorkspaceFiles;
  fs: Pick<FileSystemSurface, "copyFile" | "moveFile">;
  /** Which files are open (never moved from under their tabs), and the
   *  live document an image asset's reference is rewritten in. */
  editors: Pick<EditorsApi, "paths" | "markdownEditor">;
}

export function moveIntoFolder(
  deps: DropDeps,
  payload: PayloadOfKind<"image-asset" | "file">,
  folderPath: string,
): void {
  void moveIntoFolderAsync(deps, payload, folderPath).catch(
    (error: unknown) => {
      console.error(
        `Failed to move ${payload.kind} into ${folderPath}:`,
        error,
      );
    },
  );
}

async function moveIntoFolderAsync(
  deps: DropDeps,
  payload: PayloadOfKind<"image-asset" | "file">,
  folderPath: string,
): Promise<void> {
  if (payload.kind === "image-asset") {
    await moveImageAsset(deps, payload, folderPath);
    return;
  }

  const newPath = pathutil.join(folderPath, getFileName(payload.path));
  if (payload.path === newPath) return;

  if (payload.fileType === "directory") {
    // Containment goes through the bound path flavor, never a hand-built
    // prefix: `startsWith(path + "/")` is false for every descendant on
    // win32 (backslash separators) and mis-sliced sibling prefixes like
    // "/ws-backup" on posix — the two failures path.ts was written to end.
    // `contains` is true for the root itself, so it covers both guards.
    // A directory can't move into itself or its own descendants.
    if (pathutil.contains(payload.path, folderPath)) return;
    // Open tabs are keyed by path; moving them out from under the layout
    // would orphan the tab (rename is disabled for open files for the same
    // reason — see FileTreeContextMenu disableRename).
    if (deps.editors.paths().some((p) => pathutil.contains(payload.path, p))) {
      console.warn(`Not moving ${payload.path}: contains open files`);
      return;
    }
  } else if (deps.editors.paths().includes(payload.path)) {
    console.warn(`Not moving ${payload.path}: file is open`);
    return;
  }

  await deps.filesOf(payload.workspaceRoot).file(payload.path).rename(newPath);
}

async function moveImageAsset(
  { filesOf, fs, editors }: DropDeps,
  payload: PayloadOfKind<"image-asset">,
  folderPath: string,
): Promise<void> {
  const files = filesOf(payload.workspaceRoot);
  const newPath = pathutil.join(folderPath, getFileName(payload.absolutePath));
  if (newPath === payload.absolutePath) return;

  // Image srcs are file-relative (how the editor resolves them), so the
  // rewritten reference must be relative to the source document's directory.
  const newSrc = relativeSrcFrom(
    pathutil.dirname(payload.sourceFilePath),
    newPath,
  );

  const editor = editors.markdownEditor(payload.sourceFilePath);
  if (!editor) {
    // Without the live document we can't rewrite the reference, so copy
    // instead of move — the original path keeps working.
    const result = await fs.copyFile(payload.absolutePath, newPath);
    if (!result.ok) throw result.error;
    await files.refresh();
    return;
  }

  const asset = files.file(payload.absolutePath);
  if (asset.exists()) {
    await asset.rename(newPath);
  } else {
    // Asset exists on disk but isn't tracked in collections yet.
    const result = await fs.moveFile(payload.absolutePath, newPath);
    if (!result.ok) throw result.error;
    await files.refresh();
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

/**
 * Tree-domain path of `toPath` relative to `fromDir`, climbing with `../`
 * segments when the target isn't a descendant (pathutil.relative is
 * descendant-only by design). Falls back to the raw path when the two share
 * no common root.
 */
function relativeSrcFrom(fromDir: string, toPath: string): string {
  let base = fromDir;
  let ups = "";
  for (;;) {
    const rel = pathutil.relative(base, toPath);
    if (rel !== undefined && rel !== "") return ups + pathutil.toTreePath(rel);
    const parent = pathutil.dirname(base);
    if (parent === base) return toPath;
    base = parent;
    ups += "../";
  }
}
