/**
 * The write path for blob answers. Always ID-addressed string surgery via
 * patchBlobInMarkdown — never a whole-document re-serialization — and always
 * through the normal save machinery so undo/autosave/hashes stay coherent:
 * DocumentSync.pushUpdate when the file is open in an editor, direct
 * platformAdapter.writeFiles otherwise.
 */

export type AnswerBlobResult =
  | { ok: true }
  | {
      /** Blob was deleted or rewritten since parse; widget should re-sync. */
      ok: false;
      reason: "not_found" | "conflict";
    };

export async function answerBlob(
  _filePath: string,
  _blobId: string,
  _patch: Record<string, unknown>,
): Promise<AnswerBlobResult> {
  // TODO(phase 2):
  // 1. Authoritative markdown: editor doc via editor-store if open, else disk.
  // 2. patchBlobInMarkdown(markdown, blobId, {...patch from type.onAnswer}).
  // 3. Write via DocumentSync.pushUpdate / platformAdapter.writeFiles.
  // 4. Route to the AUTHORING task (blob→task attribution recorded at fence
  //    detection) via a notifyBlobAnswered command keyed on authoringTaskId.
  throw new Error("not implemented: answerBlob");
}
