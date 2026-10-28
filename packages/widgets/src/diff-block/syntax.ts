/**
 * The diff block: a fenced code block that shows a change. Its info string
 * names the language as any fence does, then marks it a diff, `diff` or
 * `diff=<the file's path>`; its body is the code before the change, a line
 * of exactly `=======`, then the code after:
 *
 *     ```ts diff=src/greet.ts
 *     const greeting = "hi";
 *     =======
 *     const greeting = "hello";
 *     ```
 *
 * Everywhere markdown is read it stays an ordinary code block in its
 * language — another app shows (and highlights) its source — and the app's
 * surfaces draw it as a diff (./element.ts). Pure: the markdown worker and
 * the agent's instructions read it too.
 */

const ATTRIBUTE = "diff";
const SEPARATOR = "=======";

/** Where rendered HTML keeps a fence's diff: on its `<code>`, as markdown-it
 *  puts a fence's attrs (./markdown.ts), or on the editor's `<pre>`. */
export const DIFF_DATA_ATTRIBUTE = "data-diff";

/** The element that draws one (./element.ts). */
export const DIFF_BLOCK_TAG = "notefig-diff-block";

/** A diff block's two sides. Both end in a newline, so a last line that is
 *  the same on both reads as unchanged, not as a newline at end of file. */
export interface DiffSides {
  before: string;
  after: string;
}

/**
 * What a fence's info string says of a diff: null when it isn't one, ""
 * when it is a diff of no named file, else that file's path. The first word
 * is the language (```diff alone is the unified-diff language, not this).
 */
export function diffOfInfo(info: string): string | null {
  for (const word of info.trim().split(/\s+/).slice(1)) {
    if (word === ATTRIBUTE) return "";
    if (word.startsWith(`${ATTRIBUTE}=`)) return word.slice(ATTRIBUTE.length + 1);
  }
  return null;
}

/** The info string's words after the language for a block's `diff` attr. */
export function diffInfo(diff: string | null): string {
  if (diff === null) return "";
  return diff ? ` ${ATTRIBUTE}=${diff}` : ` ${ATTRIBUTE}`;
}

/** A diff block's sides, or null when its body has no separator: it is
 *  then shown as the code it is, not as a guess at a change. */
export function parseDiffSides(text: string): DiffSides | null {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trimEnd() === SEPARATOR);
  if (at === -1) return null;
  const side = (part: string[]) => (part.length ? `${part.join("\n")}\n` : "");
  return { before: side(lines.slice(0, at)), after: side(lines.slice(at + 1)) };
}

/** How an agent writes one; its MCP instructions carry this. */
export const DIFF_BLOCK_GUIDE =
  "To show a change to code or text (one you propose, or a before and after), " +
  "write a diff block, in chat, in a widget response or in a document: a fenced " +
  "code block whose info string is the language followed by `diff=` and the " +
  "file's path (```ts diff=src/app.ts), or by `diff` alone (```python diff), " +
  "holding the lines before the change, a line of exactly " +
  `\`${SEPARATOR}\`, then the same lines after it. Notefig draws it as a diff. ` +
  "Keep to the lines around the change; leave the side before " +
  `\`${SEPARATOR}\` empty for new code. Prefer it to two separate code blocks or ` +
  "a hand-written `diff` block.";
