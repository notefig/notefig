/**
 * The desktop's `EditorContextPort` (MET-193).
 *
 * This is the boundary that keeps ProseMirror out of `@notefig/core`. Every
 * import below — the editor store, the markdown codec, the adoption
 * transform — is a module the core must never see, and the port's
 * markdown-in/markdown-out signatures are what make that enforceable rather
 * than aspirational.
 *
 * Only the write half is implemented here so far. The read projections
 * (`openFiles`, `documentContext`, `readRange`, `blobTypes`) still answer
 * from `detachedEditorContext` because their real implementations live in
 * `agent/widget-context-resource.ts`, which reaches the editor store
 * directly and moves in a later cut. Spreading the detached defaults is
 * deliberate: it keeps the object honest about what it can actually do,
 * instead of claiming `attached: true` and returning nulls.
 */
import {
  detachedEditorContext,
  type EditorContextPort,
} from "@notefig/core";
import { getMarkdownEditor } from "@/components/editor/editor-store";
import { adoptExternalContent } from "@/components/editor/adopt-external-content";
import { getEditorMarkdown } from "@/components/editor/use-editor-file-sync";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { calculateContentHash } from "@/utils/hash";

export const desktopEditorContext: EditorContextPort = {
  ...detachedEditorContext,

  async adoptWrite(absolutePath, content, persist) {
    const editor = getMarkdownEditor(absolutePath);
    if (!editor || editor.isDestroyed) return;

    const sync = getDocumentSync(absolutePath);
    const doc = await sync.prepareAdoption(content);
    // `prepareAdoption` declines while the sync is busy — another adoption
    // is mid-flight and will carry newer content. Nothing to do.
    if (!doc || editor.isDestroyed) return;

    const adoption = adoptExternalContent(editor, doc);
    if (adoption.reinsertedWidgets === 0) {
      sync.commitAdoption(content, calculateContentHash(content));
      return;
    }

    // Re-asserted widget markers exist only in the editor at this point, so
    // the file has to be repaired to match. `persist` is the caller's
    // tracked write: awaiting it keeps the repair inside that write, and
    // committing only afterwards means a failed repair leaves the sync
    // state honest rather than claiming disk holds content it does not.
    const repaired = getEditorMarkdown(editor);
    await persist(repaired);
    sync.commitAdoption(repaired, calculateContentHash(repaired));
  },
};
