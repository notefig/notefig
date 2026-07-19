// Pre-existing tangle: editor-store's editor kit renders blob node views,
// which call back into these actions (directly and via file-sync's write
// adoption). Untangling means relocating the editor registry to a leaf
// module (see file-sync's editor-store import comment); new cycles
// elsewhere still gate.
// fallow-ignore-file circular-dependency
/**
 * The write path for blob answers. Always ID-addressed string surgery via
 * patchBlobInMarkdown — never a whole-document re-serialization — and always
 * through `writeWorkspaceTextFile`, the adopting write primitive every other
 * agent-shaped write uses (ACP fs/write_text_file, author_blob,
 * history_restore): it writes to disk and pushes the content into any open
 * editor itself (see file-sync.ts).
 *
 * Once the patch lands, the authoring task (if still around) gets a plain
 * follow-up prompt carrying the answer as text — not a tracked "interaction"
 * the agent service has to hold state for. The agent's turn that authored
 * the blob already finished; this is just a new turn on the same session.
 */
import { findBlobs, patchBlobInMarkdown } from "@metrists/shared/blobs";
import { toast } from "sonner";
import { agents } from "@/agent/agents";
import i18n from "@/utils/intl";
import { findBlobAuthorTask } from "@/agent/agent-service";
import { readWorkspaceTextFile, writeWorkspaceTextFile } from "@/utils/file-sync";
import { createMarkdownCodec } from "../markdown-codec";
import { getMarkdownEditor } from "../editor-store";
import { getBlobType } from "./blob-registry";

export type AnswerBlobResult =
  | { ok: true }
  | {
      /** Blob was deleted or rewritten since parse; widget should re-sync. */
      ok: false;
      reason: "not_found" | "conflict";
    };

/**
 * Thrown from a widget's `answer` closure so widgets can catch a typed
 * reason (`useBlobAnswer` does). Lives here, not in blob-node-view.tsx: a
 * component module must export only components or Vite's react-refresh
 * downgrades every edit to it (and its importers) to a full reload.
 */
export class BlobAnswerError extends Error {
  constructor(readonly reason: Extract<AnswerBlobResult, { ok: false }>["reason"]) {
    super(reason);
    this.name = "BlobAnswerError";
  }
}

const codec = createMarkdownCodec();

async function readAuthoritativeMarkdown(filePath: string): Promise<string> {
  const editor = getMarkdownEditor(filePath);
  if (editor) return codec.serialize(editor.getJSON());
  return readWorkspaceTextFile(filePath);
}

export async function answerBlob(
  filePath: string,
  blobId: string,
  patch: Record<string, unknown>,
): Promise<AnswerBlobResult> {
  const markdown = await readAuthoritativeMarkdown(filePath);
  const patched = patchBlobInMarkdown(markdown, blobId, patch);
  if (!patched.ok) {
    return {
      ok: false,
      reason: patched.error.type === "not_found" ? "not_found" : "conflict",
    };
  }

  await writeWorkspaceTextFile(filePath, patched.value);

  // Address a fresh prompt at the task that authored this blob, if it's
  // still around — no interaction row, no continuation-queue bookkeeping.
  // The type's own formatter decides what the text says (directive: replace
  // the answered block with resolved content); enqueue is infallible and
  // lossless, so fire-and-forget is safe.
  const authoredBy = findBlobAuthorTask(blobId);
  if (authoredBy) {
    const envelope = findBlobs(markdown).find(
      (loc) => loc.blob.envelope.id === blobId,
    )?.blob.envelope;
    const formatter = getBlobType(authoredBy.blobType)?.formatAnswerPrompt;
    const text =
      formatter && envelope
        ? formatter({ blobId, path: filePath, envelope, patch })
        : defaultAnswerPrompt(authoredBy.blobType, blobId, filePath, patch);
    // Restored sessions revive transparently inside prompt(); a dead task
    // (deleted, or revival landed "unavailable") resolves the handle as
    // not-started — surface that instead of silently dropping the follow-up.
    void agents
      .task(authoredBy.taskId)
      .prompt(text)
      .completed.then((outcome) => {
        if (
          outcome.status === "error" &&
          outcome.error === "agent task is not started"
        ) {
          toast(i18n.t("agentBlobAnswerOrphaned"));
        }
      });
  } else {
    // Author unknown — after a restart the routing entry only comes back
    // once the authoring session is revived (accepted MET-54 limitation).
    // The answer itself is already saved in the document.
    toast(i18n.t("agentBlobAnswerOrphaned"));
  }

  return { ok: true };
}

/** Generic informational fallback for types without `formatAnswerPrompt`. */
function defaultAnswerPrompt(
  blobType: string,
  blobId: string,
  path: string,
  patch: Record<string, unknown>,
): string {
  const answer =
    typeof patch.answer === "string" ? patch.answer : JSON.stringify(patch);
  return `The user answered the "${blobType}" block (id ${blobId}) in ${path}: ${answer}`;
}
