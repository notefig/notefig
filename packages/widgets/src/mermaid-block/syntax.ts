/**
 * The mermaid block: a fenced code block in the language `mermaid`, its body
 * a Mermaid diagram:
 *
 *     ```mermaid
 *     flowchart LR
 *       Draft --> Review --> Merged
 *     ```
 *
 * Everywhere markdown is read it stays a code block — another app shows its
 * source, or draws it — and the app's surfaces draw it as the diagram, with
 * Pele (./element.tsx). Pure: the markdown worker and the agent's
 * instructions read it too.
 */

export const MERMAID_LANGUAGE = "mermaid";

/** The element that draws one (./element.tsx). */
export const MERMAID_BLOCK_TAG = "notefig-mermaid-block";

/** Whether a fence's info string makes it a mermaid block: its language,
 *  with nothing after it (```mermaid diff is a diff of a diagram). */
export function isMermaidInfo(info: string): boolean {
  const words = info.trim().split(/\s+/);
  return words[0] === MERMAID_LANGUAGE && words.length === 1;
}

/** The translation keys the card resolves; the app asserts it defines them
 *  (see ../prompt/i18n-keys.ts for why). */
export const MERMAID_BLOCK_I18N_KEYS = ["mermaidBlockEdit"] as const;

/** When and how an agent draws one; its MCP instructions carry this. */
export const MERMAID_GUIDE =
  "When a structure or flow is easier to see than to read (a process, a state " +
  "machine, calls between parts in sequence, an architecture, a timeline, a " +
  "hierarchy), draw it as a Mermaid diagram, in chat or in a document: a fenced " +
  "code block in the language `mermaid` (```mermaid). Notefig draws it as the " +
  "diagram. Keep it small (about 15 nodes at most), label the edges, and leave " +
  "out `style`, `classDef` and colours so it follows the theme. Use one where it " +
  "shows something the text doesn't, not for a list or a single step. " +
  "Answering a prompt widget, put the diagram in the document, not in " +
  "`widget_respond`: the widget is too small for one. Its response then says " +
  "where the diagram is.";
