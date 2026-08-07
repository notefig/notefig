import { z } from "zod";
import type { AgentTool } from "@notefig/shared/agent";

/**
 * Shared between the tool and the widget-side reader
 * (`deriveWidgetResponse` in prompt-blob-state.ts), so the two can never
 * drift: the widget parses the transcript entry's `rawInput` with this
 * exact schema. Flat strings only — deliberately no nested objects, so
 * harness-side argument mangling (the OpenCode stringified-payload quirk
 * mcp-server.ts repairs) can't corrupt what the widget reads.
 */
export const WidgetRespondInputSchema = z.object({
  kind: z.enum(["answer", "issue"]),
  markdown: z.string().min(1),
  title: z.string().optional(),
});

export type WidgetResponse = z.infer<typeof WidgetRespondInputSchema>;

/**
 * Deliver the agent's final response to the in-document prompt widget the
 * prompt came from (MET-92). `execute` is validate-and-acknowledge ONLY:
 * the record of this call is the `tool_call` transcript entry the service
 * already writes for every tool call — stamped with the running turnId and
 * carrying `rawInput` verbatim — and the widget derives the response from
 * that entry. Same no-separate-tracking-state design `author_blob`
 * documents for blob-answer routing (findBlobAuthorTask): the transcript
 * is the record; readers derive.
 *
 * Unlike author_blob this module stays a leaf (zod + shared types only) —
 * prompt-blob-state.ts imports the schema above, so pulling anything from
 * the editor/component layer here would open a cycle.
 */
export const widgetRespond: AgentTool<WidgetResponse, { recorded: true }> = {
  name: "widget_respond",
  title: "agentToolWidgetRespond",
  description:
    `Deliver your final answer (kind: "answer") or flag a problem/blocker ` +
    `(kind: "issue") to the in-document widget the prompt came from. Call this ` +
    `once, at the end of the turn, with your complete response in \`markdown\` ` +
    `(an optional short \`title\` becomes the widget's heading). Call it even ` +
    `when the request needed no edits or tool actions — a prose-only answer to ` +
    `a widget prompt is still delivered through this tool, not as chat text. ` +
    `Only for prompts that carried a widget-context resource_link or an ` +
    `empty-document widget framing — never for chat conversations.`,
  input: WidgetRespondInputSchema,
  async execute() {
    return { ok: true, value: { recorded: true } };
  },
};
