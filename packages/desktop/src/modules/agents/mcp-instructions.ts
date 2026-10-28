import { toolRegistry } from "./tools";
import { WIDGET_RESPONSE_KINDS } from "@notefig/shared/agent";
import { DIFF_BLOCK_GUIDE } from "@notefig/widgets/diff-block/syntax";

/**
 * MCP's `tools/list` schema is enough for the model to call a tool
 * correctly, but not enough to make it *reach* for one — a real session
 * defaulted to native Read/cat/Write for workspace files, only using the
 * MCP tools once told to directly. This steering
 * text rides MCP's own channel for exactly that purpose —
 * `initialize.instructions` — instead of a prompt preamble: the server
 * describes itself, so only sessions that actually have the server hear
 * about its tools (the old first-turn preamble was sent unconditionally,
 * telling `mcpRegistration: "none"` harnesses and failed-registration
 * tasks about tools that didn't exist). Injected into the protocol layer
 * via `McpHandlerDeps.instructions` — the copy describes desktop-owned
 * tools, so it lives here, next to them.
 */
export function serverInstructions(): string {
  const names = toolRegistry.map((tool) => tool.name).join(", ");
  return (
    `This server exposes the Notefig writing app's native tools (${names}); ` +
    `you are running as an agent inside that app. Notefig registers it for ` +
    `this session only, so it isn't in any config file and needs no checking. ` +
    `Three things are PRIMARY; the rest are for when a task calls for them. ` +
    `(1) The widget-context resource: a prompt sent from an in-document widget ` +
    `carries a \`resource_link\` whose URI starts with ` +
    `\`notefig://widget-context\`. Call \`resources/read\` on it as your ` +
    `FIRST action, before any document or file read. Its payload (title, ` +
    `heading outline, text around the prompt, the selection, the other open ` +
    `files) is sized to be enough for most requests: treat it as your default ` +
    `context. A widget prompt that OPENS with a blockquote (\`> …\` lines) ` +
    `quotes the passage the user had selected: that passage is what the ` +
    `prompt is about. Pass the payload's \`selectedRange\` \`from\`/\`to\` ` +
    `(padded outward if you like) to \`document_read_range\` to read it, or ` +
    `more around it, as it is now. ` +
    `(2) \`widget_respond\`: when a prompt carries that resource_link, you ` +
    `MUST deliver your final response by calling \`widget_respond\` with the ` +
    `kind that fits (${Object.keys(WIDGET_RESPONSE_KINDS).join(", ")}), even ` +
    `when the turn needed no tool actions: plain assistant text is progress ` +
    `notes, never the deliverable. When a prompt has no such link (it came ` +
    `from the chat panel), do NOT call \`widget_respond\`; answer in chat. ` +
    `A prompt from either surface may also carry \`file://\` resource_links, ` +
    `files the user referenced with @: don't \`resources/read\` those, read ` +
    `each one with \`workspace_read_document\` before acting. ` +
    `(3) \`workspace_read_document\`, for when the widget context doesn't ` +
    `cover the request (another section named in the outline, say). Do NOT ` +
    `read the entire document by default; read part of it with ` +
    `\`line\`/\`limit\`. ` +
    `Prefer these tools over generic file or shell tools for this ` +
    `workspace's documents: they see live editor state (unsaved edits, open ` +
    `tabs) and document history. A request about "this section" or "this ` +
    `doc" expects you to edit the document, not to describe the edit, unless ` +
    `the user is asking a question, or the request could mean different ` +
    `things and the document doesn't settle which: then ask with a choice ` +
    `before editing. ` +
    DIFF_BLOCK_GUIDE
  );
}
