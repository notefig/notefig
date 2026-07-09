/**
 * The write path for blob answers. Always ID-addressed string surgery via
 * patchBlobInMarkdown — never a whole-document re-serialization — and always
 * through `writeWorkspaceTextFile`, the same file-sync write helper every
 * other agent-shaped write uses (ACP fs/write_text_file, history_restore):
 * an open editor picks the patched content up through the normal
 * watcher → content-change → DocumentSync adoption pipeline, no second
 * write path needed.
 *
 * Once the patch lands, the authoring task (if still around) gets a plain
 * follow-up prompt carrying the answer as text — not a tracked "interaction"
 * the agent service has to hold state for. The agent's turn that authored
 * the blob already finished; this is just a new turn on the same session.
 */
import { patchBlobInMarkdown } from "@metrists/shared/blobs";
import { agents } from "@/agent/agents";
import { findBlobAuthorTask } from "@/agent/agent-service";
import { readWorkspaceTextFile, writeWorkspaceTextFile } from "@/utils/file-sync";
import { createMarkdownCodec } from "../markdown-codec";
import { getMarkdownEditor } from "../editor-store";

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
  // still around — no interaction row, no continuation-queue bookkeeping,
  // just enough context for the agent to act on the answer.
  const authoredBy = findBlobAuthorTask(blobId);
  if (authoredBy) {
    const answer =
      typeof patch.answer === "string" ? patch.answer : JSON.stringify(patch);
    agents.task(authoredBy.taskId).prompt(
      `The user answered the "${authoredBy.blobType}" block (id ${blobId}) in ${authoredBy.path}: ${answer}`,
    );
  }

  return { ok: true };
}
