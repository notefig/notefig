import type { AgentTool } from "./tool-types";

/**
 * Renders the guidance preamble describing the tool registry, in the exact
 * `metrists:tool` fence format the Stage 0 spike validated against a real
 * adapter (see docs/architecture/spikes/v2-tool-fence-spike.md — 6/6
 * well-formed fences, the ask-then-continue loop held up over 3-tool
 * chains). Keep this text in sync with that spike's tested preamble; drift
 * here is drift from the only evidence we have that the format works.
 */
export function renderToolGuidance(
  tools: readonly Pick<AgentTool<unknown, unknown>, "name" | "description">[],
): string {
  const toolList = tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");

  return `You have access to app-native tools, invoked ONLY via a fenced code block in your reply, using this exact format:

\`\`\`metrists:tool
name: <tool_name>
input:
  <yaml-object matching the tool's input schema>
\`\`\`

Available tools:
${toolList}

Rules:
- Emit AT MOST ONE tool fence per reply. After emitting a tool fence, stop.
- Wait for the tool result, which will arrive as a follow-up user message starting with "Tool result:".
- When you have enough information, answer in plain prose with no fence.
- Never invent tool names outside the list above.`;
}
