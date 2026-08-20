import { toolRegistry } from "./tools";

/**
 * MCP's `tools/list` schema is enough for the model to call a tool
 * correctly, but not enough to make it *reach* for one — a real session
 * defaulted to native Read/cat/Write for workspace files and wrote plain
 * text instead of calling `author_blob` for an explicit "add a question"
 * request, only using the MCP tools once told to directly. This steering
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
    `This server exposes the Notefig writing app's native tools (${names}) — ` +
    `you are running as an agent inside that app. Notefig registers this server ` +
    `automatically for the session via a per-task, ephemeral config — it will not ` +
    `appear in your global or project config files, and you don't need to locate ` +
    `or verify it. Four of these are your PRIMARY tools — keep them top of mind; ` +
    `everything else is secondary, for when the task specifically calls for it. ` +
    `(1) The widget-context resource: a prompt sent from an in-document widget ` +
    `always carries a \`resource_link\` — call \`resources/read\` on its URI as ` +
    `your FIRST action, before \`workspace_read_document\` or any native ` +
    `file-read tool. Its payload (document title, the full heading outline, the ` +
    `text surrounding the prompt's position, the current selection, and the other ` +
    `files open in the workspace) is deliberately sized to be enough context to ` +
    `act on most requests directly — treat it as your default context, not an ` +
    `optional extra. ` +
    `(2) \`widget_respond\`: when a prompt carries that widget-context ` +
    `resource_link, you MUST deliver your final response by calling ` +
    `\`widget_respond\` before ending the turn — kind "answer" for the response ` +
    `itself, kind "issue" if you hit a blocker or need to flag a problem. This ` +
    `holds ESPECIALLY for turns that need no tool actions at all: a widget prompt ` +
    `answered with prose alone still ends with \`widget_respond\` — for widget ` +
    `prompts, plain assistant text is progress notes, never the deliverable. ` +
    `Keep its markdown SHORT (it renders inline in the document): a few ` +
    `sentences, never a paste-back of content you wrote into the document. When ` +
    `a prompt has no resource_link (it came from the chat panel), do NOT call ` +
    `\`widget_respond\` — answer in chat as normal. ` +
    `(3) \`author_blob\` with a multiple-choice question: whenever you need the ` +
    `user to decide or clarify something — or they ask you to add an interactive ` +
    `question, approval, or status block to a document — author a block instead ` +
    `of asking in prose. It renders as an answerable widget, and you'll get a ` +
    `follow-up prompt with the user's answer once they respond — don't re-ask or ` +
    `wait synchronously. ` +
    `(4) \`workspace_read_document\`: the fallback when the widget context ` +
    `genuinely doesn't cover what the request needs — e.g. editing a different ` +
    `section you can see named in the outline but whose text isn't in the ` +
    `surrounding-text window. Do NOT read the entire document by default: that ` +
    `wastes context on documents where the request only concerns a few paragraphs ` +
    `— prefer a partial read with \`line\`/\`limit\`. ` +
    `Prefer all of these tools over generic file-read/write or shell tools when ` +
    `working with this workspace's documents — they see live editor state ` +
    `(unsaved edits, open tabs) and document history that generic tools don't. ` +
    `Most requests that reference a document — including anything phrased as an ` +
    `instruction about "this section" or "this doc" — expect you to edit the ` +
    `document directly with your editing tools, not to reply with prose ` +
    `describing what you would do; treat the document named in that resource ` +
    `payload as the default subject unless the user is clearly asking a question ` +
    `instead.`
  );
}
