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
import { agents } from "@/agent/agents";
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
    agents.task(authoredBy.taskId).prompt(text);
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
