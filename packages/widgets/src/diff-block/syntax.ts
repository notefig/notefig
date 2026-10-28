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

/** Whether a fence's info string marks it a diff: `diff` among the words
 *  after the language (```diff alone is the unified-diff language). */
export function isDiffInfo(info: string): boolean {
  return info.trim().split(/\s+/).slice(1).includes(ATTRIBUTE);
}

/** The info string's words after the language for a block's `diff` attr. */
export function diffInfo(diff: boolean): string {
  return diff ? ` ${ATTRIBUTE}` : "";
}

/** How an agent writes one; its MCP instructions carry this. */
export const DIFF_BLOCK_GUIDE =
  "To show a change to code or text (one you propose, or a before and after), " +
  "write a diff block, in chat, in a widget response or in a document: a fenced " +
  "code block whose info string is the language followed by `diff` (```ts diff), " +
  "holding a unified diff of one file as `git diff` prints it: the `---` and `+++` " +
  "lines naming the file (`--- /dev/null` for a new one), then `@@ -start,count " +
  "+start,count @@` hunks of context, `-` and `+` lines. Notefig draws it as a " +
  "diff with the file's name. Use one block per file, keep to the lines around " +
  "the change, and prefer it to two separate code blocks or a plain ```diff block.";
