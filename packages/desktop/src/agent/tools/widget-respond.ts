import type { AgentTool } from "@notefig/agent";
import {
  WIDGET_RESPOND_TOOL_NAME,
  WidgetRespondInputSchema,
  type WidgetResponse,
} from "@notefig/shared/agent";

// The schema and the tool name live in @notefig/shared/agent: @notefig/widgets
// reads them to derive the widget's done face from the transcript, and neither
// package owns the other. Re-exported here so the tool's own call sites keep
// their existing import.
export { WidgetRespondInputSchema, type WidgetResponse };

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
 * Unlike author_blob this module stays a leaf (shared types only): the
 * widget reads the same schema from @notefig/shared/agent, and pulling
 * anything from the editor/component layer in here would open a cycle.
 */
export const widgetRespond: AgentTool<WidgetResponse, { recorded: true }> = {
  name: WIDGET_RESPOND_TOOL_NAME,
  title: "agentToolWidgetRespond",
  description:
    `Deliver your final answer (kind: "answer") or flag a problem/blocker ` +
    `(kind: "issue") to the in-document widget the prompt came from. Call this ` +
    `once, at the end of the turn, with your response in \`markdown\` ` +
    `(an optional short \`title\` becomes the widget's heading). The widget ` +
    `renders inline in the document, so keep \`markdown\` to a few sentences ` +
    `or a short bullet list — never restate content you wrote into the ` +
    `document; run long only when the answer itself demands it. Call it even ` +
    `when the request needed no edits or tool actions — a prose-only answer to ` +
    `a widget prompt is still delivered through this tool, not as chat text. ` +
    `Only for prompts that carried a widget-context resource_link or an ` +
    `empty-document widget framing — never for chat conversations.`,
  input: WidgetRespondInputSchema,
  async execute() {
    return { ok: true, value: { recorded: true } };
  },
};
