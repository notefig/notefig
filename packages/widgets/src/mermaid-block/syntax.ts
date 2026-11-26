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
  "Draw what is easier seen than read as a ```mermaid diagram: `flowchart` for " +
  "a process or decision, `sequenceDiagram` for calls between parts, " +
  "`stateDiagram-v2` for states, `erDiagram` or `classDiagram` for a model, " +
  "`gantt` or `timeline` for a schedule, `mindmap` for a breakdown, " +
  "`quadrantChart` for a trade-off, `pie` or `xychart-beta` for numbers. At " +
  "most ~15 nodes, labelled edges, no `style`/`classDef` colours (it follows " +
  "the theme); never for a list or a single step.";
