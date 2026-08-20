import { z } from "zod";
import { toJsonSchema, type AgentTool } from "@notefig/agent";
import { BlobEnvelopeSchema, findBlobs, serializeBlobBlock } from "@notefig/shared/blobs";
import { getAllBlobTypes, getBlobType } from "@/components/editor/blobs/blob-registry";
import { readWorkspaceTextFile, writeWorkspaceTextFile } from "@/utils/file-sync";
import { resolveWorkspacePath } from "@/utils/fs";

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
  title: "agentToolAuthorBlob",
  // A getter, not a plain property: this module sits inside the
  // tools/index ↔ blob-registry ↔ *.blob.tsx import cycle, and
  // getAllBlobTypes() is only safe to call after every module in the cycle
  // has finished evaluating. Deferring to first access (tools/list time)
  // makes the description independent of module-eval order.
  get description() {
    return (
      `Author an interactive block into a document (e.g. a question for the user). ` +
      `Known types: ${knownTypeNames()}. Give a unique \`id\` matching ^[a-z]+_[a-z0-9]{4,}$ ` +
      `(e.g. "question_8f2a"). The block is appended to the document; the user answers it ` +
      `whenever they get to it, and you'll receive a follow-up prompt with their answer then — ` +
      `don't re-ask or wait synchronously.`
    );
  },
  input: InputSchema,
  /**
   * `author_blob`'s input is `{ path, type, id, payload }` where `payload`'s
   * shape depends on `type` — the exact envelope/payload split that caused
   * the seven-guess fence failure (docs/architecture/agent-harness-v2.md,
   * "Findings"). The generic `zodToJsonSchema(input)` only sees
   * `payload: z.record(z.unknown())`, which is no more informative than the
   * old prose description. Render it explicitly instead, `anyOf` over every
   * registered blob type's real payload schema, regenerated per call so blob
   * registration timing is a non-issue (same cycle caveat as `description`).
   */
  inputJsonSchema(): unknown {
    const blobTypes = getAllBlobTypes();
    const payloadSchemas = blobTypes.map((blobType) =>
      toJsonSchema(blobType.schema),
    );
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative document path.",
        },
        type: {
          type: "string",
          enum: blobTypes.map((t) => t.type),
          description: "Which registered blob type to author.",
        },
        id: {
          type: "string",
          pattern: "^[a-z]+_[a-z0-9]{4,}$",
          description: 'Unique block id, e.g. "question_8f2a".',
        },
        payload: {
          description:
            "Shape depends on `type` — matches the corresponding entry below.",
          anyOf: payloadSchemas,
        },
      },
      required: ["path", "type", "id"],
    };
  },
  async execute(ctx, input) {
    // Agents send workspace-relative paths; an unresolved one would land
    // relative to the process CWD (src-tauri/ in dev — see resolveWorkspacePath).
    const resolved = resolveWorkspacePath(ctx.workspacePath, input.path);
    if (!resolved.ok) return { ok: false, error: resolved.error };

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
      content = await readWorkspaceTextFile(resolved.absolute);
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
    await writeWorkspaceTextFile(resolved.absolute, `${content}${separator}${fence}`);

    return { ok: true, value: { blobId: input.id } };
  },
};
