/**
 * The diff block: a fenced code block that shows a change. Its info string
 * names the language as any fence does, then marks it a diff with `diff`;
 * its body is a unified diff of one file, as `git diff` prints it — the
 * format `@pierre/diffs` reads, so it is handed over as it is:
 *
 *     ```ts diff
 *     --- a/src/greet.ts
 *     +++ b/src/greet.ts
 *     @@ -1,1 +1,1 @@
 *     -const greeting = "hi";
 *     +const greeting = "hello";
 *     ```
 *
 * Everywhere markdown is read it stays an ordinary code block in its
 * language — another app shows its source — and the app's surfaces draw it
 * as a diff (./element.ts). Pure: the markdown worker and the agent's
 * instructions read it too.
 */

const ATTRIBUTE = "diff";

/** Where rendered HTML marks a fence a diff: on its `<code>`, as markdown-it
 *  puts a fence's attrs (./markdown.ts), or on the editor's `<pre>`. */
export const DIFF_DATA_ATTRIBUTE = "data-diff";

/** The element that draws one (./element.ts). */
export const DIFF_BLOCK_TAG = "notefig-diff-block";

/** On the element: its card starts closed, Pierre's diff made once opened. */
export const COLLAPSED_ATTRIBUTE = "data-collapsed";

/** Whether a fence's info string marks it a diff: `diff` among the words
 *  after the language (```diff alone is the unified-diff language). */
export function isDiffInfo(info: string): boolean {
  return info.trim().split(/\s+/).slice(1).includes(ATTRIBUTE);
}

/** The info string's words after the language for a block's `diff` attr. */
export function diffInfo(diff: boolean): string {
  return diff ? ` ${ATTRIBUTE}` : "";
}

/** The translation keys the card resolves; the app asserts it defines them
 *  (see ../prompt/i18n-keys.ts for why). */
export const DIFF_BLOCK_I18N_KEYS = ["diffBlockEdit", "diffBlockShow", "diffBlockHide"] as const;

/** How an agent writes one; its MCP instructions carry this. */
export const DIFF_BLOCK_GUIDE =
  "Show a change to code or text as a diff block: a fence whose info string is " +
  "the language then `diff` (```ts diff), holding one file's unified diff as " +
  "`git diff` prints it: `---`/`+++` naming the file (`--- /dev/null` for a new " +
  "one), then `@@ -start,count +start,count @@` hunks numbered from the file's " +
  "real lines (read it first). One block per file, only the lines around the " +
  "change; prefer it to a before and an after block.";
