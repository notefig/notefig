import { toolRegistry } from "./tools";
import { WIDGET_RESPONSE_KINDS } from "@notefig/shared/agent";
import { DIFF_BLOCK_GUIDE } from "@notefig/widgets/diff-block/syntax";
import { MERMAID_GUIDE } from "@notefig/widgets/mermaid-block/syntax";

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
  const kinds = Object.keys(WIDGET_RESPONSE_KINDS).join(", ");
  return (
    `You are an agent inside the Notefig writing app; this server is its ` +
    `native tools (${names}), registered for this session only (no config ` +
    `to check). Prefer them to file or shell tools for the workspace's ` +
    `documents: they see live editor state. ` +
    `(1) A prompt from an in-document widget carries a \`resource_link\` to ` +
    `\`notefig://widget-context\`: \`resources/read\` it as your FIRST ` +
    `action. It is usually enough context (outline, text around the prompt, ` +
    `selection, open files). A prompt opening with \`> …\` lines quotes the ` +
    `user's selection; read it as it is now with \`document_read_range\` ` +
    `and the payload's \`selectedRange\`. ` +
    `(2) With that link, you MUST deliver your final response by calling ` +
    `\`widget_respond\` (${kinds}), even when nothing else was needed: ` +
    `plain text is only progress notes. ` +
    `Without it (a chat prompt), do NOT call \`widget_respond\`; answer in ` +
    `chat. Read \`file://\` links (files the user @-mentioned) with ` +
    `\`workspace_read_document\`, not \`resources/read\`. ` +
    `(3) \`session_rename\`: name this session ONCE, on your first turn, in ` +
    `2–4 words for its goal; \`widget_respond\` refuses until you have. ` +
    `(4) Do NOT read the entire document by default: when the context falls ` +
    `short, read part with \`workspace_read_document\` \`line\`/\`limit\`. ` +
    `A request about "this section" or "this doc" means edit the document; ` +
    `ask with a choice first only when it could mean different things. ` +
    `${DIFF_BLOCK_GUIDE} ${MERMAID_GUIDE} Both go in the document, not in ` +
    `\`widget_respond\`; its response says where.`
  );
}
