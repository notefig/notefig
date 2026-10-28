/**
 * The diff block: a fenced code block that shows a change. Its fence names
 * the code as `diff:<path>` or `diff:<language>`, and its body is the code
 * before the change, a line of exactly `=======`, then the code after:
 *
 *     ```diff:src/greet.ts
 *     const greeting = "hi";
 *     =======
 *     const greeting = "hello";
 *     ```
 *
 * Everywhere markdown is read it stays an ordinary code block — the editor
 * keeps it as one, its language "diff:src/greet.ts"; another app shows its
 * source — and the app's surfaces draw it as a diff (./view.ts). Pure: the
 * markdown worker and the agent's instructions read it too.
 */

const PREFIX = "diff:";
const SEPARATOR = "=======";

export interface DiffBlock {
  /** The file the change is to, shown above it; its language is inferred
   *  from the name. */
  path: string | null;
  /** The language, when the fence names one instead of a path. */
  language: string | null;
  before: string;
  after: string;
}

/** Whether a code block's language makes it a diff block. */
export function isDiffLanguage(language: string | null | undefined): language is string {
  return !!language?.startsWith(PREFIX);
}

/** What a diff block's fence names: a path has a `.` or a `/` in it. */
export function diffTarget(language: string): Pick<DiffBlock, "path" | "language"> {
  const target = language.slice(PREFIX.length);
  if (!target) return { path: null, language: null };
  return /[./]/.test(target) ? { path: target, language: null } : { path: null, language: target };
}

/** A diff block's two sides, or null when its body has no separator: it is
 *  then shown as the code it is, not as a guess at a change. */
export function parseDiffBlock(language: string | null | undefined, text: string): DiffBlock | null {
  if (!isDiffLanguage(language)) return null;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trimEnd() === SEPARATOR);
  if (at === -1) return null;
  // Both sides end in a newline, so a last line that is the same on both
  // reads as unchanged rather than as a missing newline at end of file.
  const side = (part: string[]) => (part.length ? `${part.join("\n")}\n` : "");
  return {
    ...diffTarget(language),
    before: side(lines.slice(0, at)),
    after: side(lines.slice(at + 1)),
  };
}

/** How an agent writes one; its MCP instructions carry this. */
export const DIFF_BLOCK_GUIDE =
  "To show a change to code or text (one you propose, or a before and after), " +
  "write a diff block, in chat, in a widget response or in a document: a fenced " +
  "code block whose info string is `diff:` and the file's path (```diff:src/app.ts) " +
  "or a language (```diff:python), holding the lines before the change, a line " +
  `of exactly \`${SEPARATOR}\`, then the same lines after it. Notefig draws it as ` +
  "a diff. Keep to the lines around the change; leave the side before " +
  `\`${SEPARATOR}\` empty for new code. Prefer it to two separate code blocks or ` +
  "a hand-written `diff` block.";
