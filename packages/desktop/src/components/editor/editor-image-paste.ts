/**
 * Image drop/paste handling for the markdown editor: intercepts OS file
 * drops and clipboard images, copies them into `<workspaceRoot>/assets/`
 * via the platform adapter, and inserts image nodes with workspace-relative
 * srcs (which is what serializes into the markdown).
 */

import type { EditorView } from "@tiptap/pm/view";
import { platformAdapter } from "@/adapters";

/** Sanitize a filename for use in markdown image paths.
 * Spaces become hyphens, parentheses are removed — both break many markdown
 * parsers when used inside `![](...)` paths. */
export function normalizeImageName(name: string): string {
  return name.replace(/\s+/g, "-").replace(/[()]/g, "");
}

/**
 * Find a name under `<workspaceRoot>/assets/` that doesn't collide with an
 * existing file, suffixing `-1`, `-2`, … before the extension. Overwriting
 * would silently swap the image in every document referencing the old path.
 */
export async function dedupeAssetName(
  workspaceRoot: string,
  name: string,
): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";

  let candidate = name;
  for (let i = 1; ; i++) {
    const result = await platformAdapter.exists([
      `${workspaceRoot}/assets/${candidate}`,
    ]);
    if (!result[0]?.exists) return candidate;
    candidate = `${stem}-${i}${ext}`;
  }
}

async function writeAssetAndInsert(
  view: EditorView,
  workspaceRoot: string,
  name: string,
  file: File,
  insertPos: number,
): Promise<void> {
  const destPath = `${workspaceRoot}/assets/${name}`;
  const data = new Uint8Array(await file.arrayBuffer());

  await platformAdapter.writeBinaryFiles([{ path: destPath, data }]);

  view.dispatch(
    view.state.tr.insert(
      insertPos,
      view.state.schema.nodes.image.create({ src: `assets/${name}` }),
    ),
  );
}

/**
 * editorProps.handleDrop for OS image-file drops. Internal node moves
 * (`moved`) and non-file drops fall through to ProseMirror.
 */
export function createImageDropHandler(workspaceRoot: string) {
  return function handleDrop(
    view: EditorView,
    event: DragEvent,
    _slice: unknown,
    moved: boolean,
  ): boolean {
    if (moved || !event.dataTransfer?.files.length) return false;

    const imageFiles: File[] = [];
    for (let i = 0; i < event.dataTransfer.files.length; i++) {
      if (event.dataTransfer.files[i].type.startsWith("image/")) {
        imageFiles.push(event.dataTransfer.files[i]);
      }
    }
    if (imageFiles.length === 0) return false;

    event.preventDefault();

    const pos = view.posAtCoords({
      left: event.clientX,
      top: event.clientY,
    });
    const insertPos = pos?.pos ?? view.state.selection.from;

    (async () => {
      for (const file of imageFiles) {
        try {
          const normalized = await dedupeAssetName(
            workspaceRoot,
            normalizeImageName(file.name),
          );
          await writeAssetAndInsert(
            view,
            workspaceRoot,
            normalized,
            file,
            insertPos,
          );
        } catch (err) {
          console.error("[handleDrop] Failed:", err);
        }
      }
    })();

    return true;
  };
}

/** editorProps.handlePaste for clipboard images (e.g. screenshots). */
export function createImagePasteHandler(workspaceRoot: string) {
  return function handlePaste(
    view: EditorView,
    event: ClipboardEvent,
  ): boolean {
    const items = event.clipboardData?.items;
    if (!items) return false;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        (async () => {
          try {
            const extension = item.type.split("/")[1] || "png";
            const name = await dedupeAssetName(
              workspaceRoot,
              `pasted-${Date.now()}.${extension}`,
            );
            await writeAssetAndInsert(
              view,
              workspaceRoot,
              name,
              file,
              view.state.selection.from,
            );
          } catch (err) {
            console.error("[handlePaste] Failed:", err);
          }
        })();
        return true;
      }
    }
    return false;
  };
}
