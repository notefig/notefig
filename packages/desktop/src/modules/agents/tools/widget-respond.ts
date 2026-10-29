import type { AgentTool } from "@notefig/agent";
import {
  WIDGET_RESPOND_TOOL_NAME,
  WIDGET_RESPONSE_KINDS,
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
 * that entry. The transcript is the record; readers derive.
 *
 * The kinds it offers are WIDGET_RESPONSE_KINDS, listed into the
 * description from there, so a kind added for the widget is a kind the
 * agent hears about. A question needs no routing of its own: the user's
 * answer is the widget's next prompt on the same session.
 *
 * This module stays a leaf (shared types only): the widget reads the same
 * schema from @notefig/shared/agent, and pulling anything from the
 * editor/component layer in here would open a cycle.
 */
export const widgetRespond: AgentTool<WidgetResponse, { recorded: true }> = {
  name: WIDGET_RESPOND_TOOL_NAME,
  title: "agentToolWidgetRespond",
  description:
    `Deliver your response to the in-document widget the prompt came from, ` +
    `once, as the turn's last step. Pick its \`kind\`: ` +
    `${describeResponseKinds()}. An optional short \`title\` becomes the ` +
    `widget's heading. The widget renders inline, so keep \`markdown\` to a ` +
    `few sentences or a short list, and never restate what you wrote into ` +
    `the document. Never put a diff block in it: write the diff into the ` +
    `document, and say here where it is.`,
  input: WidgetRespondInputSchema,
  async execute() {
    return { ok: true, value: { recorded: true } };
  },
};

/** Every response kind and when to use it. */
function describeResponseKinds(): string {
  return Object.entries(WIDGET_RESPONSE_KINDS)
    .map(([kind, { use }]) => `"${kind}" — ${use}`)
    .join("; ");
}
