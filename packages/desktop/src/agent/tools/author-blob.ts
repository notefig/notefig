import { z } from "zod";
import type { AgentTool } from "@metrists/shared/agent";
import { BlobEnvelopeSchema, findBlobs, serializeBlobBlock } from "@metrists/shared/blobs";
import { getAllBlobTypes, getBlobType } from "@/components/editor/blobs/blob-registry";
import { readWorkspaceTextFile, writeWorkspaceTextFile } from "@/utils/file-sync";

const InputSchema = z.object({
  path: z.string().min(1),
  type: z.string().min(1),
  /** Must be unique within the document; regex mirrors BlobEnvelopeSchema's. */
  id: z.string().regex(/^[a-z]+_[a-z0-9]{4,}$/),
  payload: z.record(z.unknown()).optional(),
});

function knownTypeNames(): string {
  return getAllBlobTypes()
    .map((t) => t.type)
    .join(", ");
}

/**
 * Authors an interactive block (question, approval, …) into a document —
 * the one place a blob gets created. This used to be "any fence the agent
 * happens to write gets detected on save"; now it's an ordinary tool call
 * like any other, so the existing tool-fence dispatch in agent-service.ts
 * already records it as a `tool_call` transcript entry with this call's
 * `rawInput` (path/type/id) verbatim — that's what `findBlobAuthorTask`
 * reads later to route the user's eventual answer back to this task. No
 * separate blob-tracking state needed.
 */
export const authorBlob: AgentTool<z.infer<typeof InputSchema>, { blobId: string }> = {
  name: "author_blob",
  description:
    `Author an interactive block into a document (e.g. a question for the user). ` +
    `Known types: ${knownTypeNames()}. Give a unique \`id\` matching ^[a-z]+_[a-z0-9]{4,}$ ` +
    `(e.g. "question_8f2a"). The block is appended to the document; the user answers it ` +
    `whenever they get to it, and you'll receive a follow-up prompt with their answer then — ` +
    `don't re-ask or wait synchronously.`,
  input: InputSchema,
  async execute(_ctx, input) {
    const blobType = getBlobType(input.type);
    if (!blobType) {
      return {
        ok: false,
        error: `unknown blob type "${input.type}". Known types: ${knownTypeNames()}`,
      };
    }

    const typedPayload = blobType.schema.safeParse(input.payload ?? {});
    if (!typedPayload.success) {
      return {
        ok: false,
        error: `invalid payload for "${input.type}": ${typedPayload.error.message}`,
      };
    }

    const envelope = BlobEnvelopeSchema.safeParse({
      id: input.id,
      status: "pending",
      createdBy: "agent",
      ...typedPayload.data,
    });
    if (!envelope.success) {
      return { ok: false, error: `invalid block: ${envelope.error.message}` };
    }

    let content: string;
    try {
      content = await readWorkspaceTextFile(input.path);
    } catch {
      content = "";
    }
    if (findBlobs(content).some((loc) => loc.blob.envelope.id === input.id)) {
      return {
        ok: false,
        error: `a block with id "${input.id}" already exists in ${input.path}`,
      };
    }

    const fence = serializeBlobBlock({
      type: input.type,
      envelope: envelope.data,
      payload: envelope.data,
      rawYaml: "",
    });
    const separator = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    await writeWorkspaceTextFile(input.path, `${content}${separator}${fence}`);

    return { ok: true, value: { blobId: input.id } };
  },
};
