import { z } from "zod";
import type { AgentTool } from "@notefig/agent";
import { resolveWorkspacePath } from "@/utils/fs";
import { resolveDocument } from "../widget-context-resource";

const InputSchema = z.object({
  path: z.string().min(1),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

/**
 * Read a document slice by ProseMirror position range — the same coordinate
 * space as the widget-context resource's `position.pos` and `selectedRange`,
 * by construction (both address the doc `resolveDocument` returns). That
 * parity is the tool's whole point: an agent holding a prompt's
 * `selectedRange` widens its window by handing the same numbers (padded as
 * it likes) straight back, no unit conversion, no line math.
 */
export const documentReadRange: AgentTool<
  z.infer<typeof InputSchema>,
  { content: string; from: number; to: number; docSize: number }
> = {
  name: "document_read_range",
  title: "agentToolDocumentReadRange",
  description:
    "Read a workspace document's content between two ProseMirror positions `from` and `to` — " +
    "the SAME coordinate space as the widget-context resource's `selectedRange` and `position`. " +
    "Use it to re-read a prompt's referenced passage or a wider window around it: pass the " +
    "range from `selectedRange` as-is, or pad it outward for more surrounding context. " +
    "Positions are clamped to the document; the result echoes the effective range and the " +
    "document's total size so you can page further.",
  input: InputSchema,
  async execute(ctx, input) {
    const resolved = resolveWorkspacePath(ctx.workspacePath, input.path);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    try {
      const doc = await resolveDocument(
        ctx.services.documents,
        resolved.absolute,
      );
      const docSize = doc.content.size;
      const from = Math.max(0, Math.min(input.from, docSize));
      const to = Math.max(from, Math.min(input.to, docSize));
      return {
        ok: true,
        value: { content: doc.textBetween(from, to, "\n"), from, to, docSize },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
