import { z } from "zod";

/**
 * The `widget_respond` payload — the agent's final answer to an in-document
 * prompt widget (MET-92).
 *
 * It lives in shared because two packages read it and neither owns the
 * other: the tool that declares it (`agent/tools/widget-respond.ts` in the
 * desktop app) and the widget that derives its done face from the
 * transcript entry's `rawInput` (`deriveWidgetResponse` in
 * @notefig/widgets). One definition is what keeps the writer and the reader
 * from drifting.
 *
 * Flat strings only — deliberately no nested objects, so harness-side
 * argument mangling (the OpenCode stringified-payload quirk mcp-server.ts
 * repairs) can't corrupt what the widget reads.
 */
export const WidgetRespondInputSchema = z.object({
  kind: z.enum(["answer", "issue"]),
  markdown: z.string().min(1),
  title: z.string().optional(),
  /**
   * Response options (MET-250): short labels the user can send back as their
   * next prompt — the way an agent asks the user to decide something, since
   * the old question-block tool is gone. Optional; most answers carry none.
   * Strings, like everything above, so the widget can render them as buttons
   * without trusting any nested structure the harness may have mangled.
   * Labels are trimmed, and a label that trims to nothing is rejected — the
   * widget renders each label verbatim and sends it verbatim, so a blank one
   * would render as an empty button that silently sent nothing.
   */
  options: z.array(z.string().trim().min(1)).min(1).optional(),
});

export type WidgetResponse = z.infer<typeof WidgetRespondInputSchema>;

/**
 * The tool's name as it reaches the widget. ACP's ToolCallUpdate has no
 * tool-name field — identity travels in `title`, which harnesses mint from
 * the MCP tool name and the service normalizes (normalizeMcpToolName strips
 * the `mcp__notefig__` / `metrists_` prefixes) — so transcript entries carry
 * this plain string. Shared so the widget can match on it without importing
 * the tool.
 */
export const WIDGET_RESPOND_TOOL_NAME = "widget_respond";
